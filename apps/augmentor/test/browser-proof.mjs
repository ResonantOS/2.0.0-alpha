// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function connectCdp(url) {
  const ws = new WebSocket(url)
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
  })
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
  return {
    close: () => ws.close(),
    call: (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++seq
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 25000)
      pending.set(id, reply => { clearTimeout(timeout); reply.error ? reject(new Error(reply.error.message)) : resolve(reply.result) })
      ws.send(JSON.stringify({ id, method, params }))
    }),
  }
}

export async function browserProof({ base, cdpPort, extId, token, liveModel, ok, authCookie, handshake, modelPicker = false }) {
  const cdpBase = `http://127.0.0.1:${cdpPort}`
  const api = async (method, args) => {
    const response = await fetch(`${base}/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: authCookie },
      body: JSON.stringify({ type: 'client-request', rpcId: 'browser-proof', method, payload: { args } }),
    })
    const body = await response.json()
    assert.equal(body.result?.ok, true, `${method}: ${JSON.stringify(body.result?.error)}`)
    return body.result.value
  }
  assert.equal((await fetch(`${base}/api/session/modelCatalog`, { method: 'POST' })).status, 401)
  for (const headers of [{}, { 'x-augmentor-token': 'wrong' }, { 'x-augmentor-token': token, origin: base }, { 'x-augmentor-token': token, host: 'example.com' }]) {
    const status = await new Promise((resolve, reject) => {
      const req = httpRequest(`${base}/api/augmentor/auth`, { method: 'POST', headers }, res => { res.resume(); resolve(res.statusCode) })
      req.on('error', reject); req.end()
    })
    assert.equal(status, 403, `auth must refuse headers: ${Object.keys(headers).join(', ')}`)
  }
  ok('authentication boundary', 'unauthenticated API, wrong token, browser Origin and foreign Host refused')
  const sid = `proof-create-${Date.now()}`
  await api('session/create', { request: { sessionId: sid, cwd: handshake.chatCwd, agentPreset: 'augmentor' } })
  await api('session/rename', { request: { sessionId: sid, title: 'Augmentor compatibility proof' } })
  assert((await api('session/list', { _request: {} })).items.some(row => row.sessionId === sid))
  ok('fresh-user chat creation', 'shipped preset loads; create, rename and list succeed')

  if (modelPicker) {
    const appTarget = await (await fetch(`${cdpBase}/json/new?about:blank`, { method: 'PUT' })).json()
    const app = await connectCdp(appTarget.webSocketDebuggerUrl)
    const evaluate = async expression => {
      const result = await app.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
      return result.result?.value
    }
    const waitFor = async expression => {
      for (let i = 0; i < 60; i++) { if (await evaluate(expression)) return; await sleep(250) }
      throw new Error(`Model Picker UI did not become ready: ${expression}; page: ${(await evaluate('document.body.innerText')).slice(0, 1800)}`)
    }
    try {
      const cookie = authCookie.split(';')[0]
      const split = cookie.indexOf('=')
      await app.call('Network.setCookie', { name: cookie.slice(0, split), value: cookie.slice(split + 1), url: base, httpOnly: true, sameSite: 'Lax' })
      await app.call('Page.navigate', { url: base })
      await waitFor('!!document.querySelector("button[aria-label=Settings]")')
      assert.equal(await evaluate('document.body.textContent.includes("Failed to load plugins")'), false)
      await evaluate('document.querySelector("button[aria-label=Settings]").click()')
      await waitFor('[...document.querySelectorAll("button")].some(b => b.textContent.trim() === "Model Picker Augmented")')
      await evaluate('[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Model Picker Augmented").click()')
      await waitFor('document.querySelectorAll(".msp-card").length > 0')
      ok('Model Picker in real DSH UI', 'GUI loads without plugin errors; model settings catalog renders')
    } finally {
      app.close()
      await fetch(`${cdpBase}/json/close/${appTarget.id}`)
    }
  }

  const target = await (await fetch(`${cdpBase}/json/new?${encodeURIComponent(`chrome-extension://${extId}/sidepanel.html`)}`, { method: 'PUT' })).json()
  const panel = await connectCdp(target.webSocketDebuggerUrl)
  let pageServer
  const ev = async expression => {
    const result = await panel.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result?.value
  }
  const send = message => ev(`chrome.runtime.sendMessage(${JSON.stringify(message)})`)
  try {
    let status
    for (let i = 0; i < 60; i++) {
      status = await send({ type: 'connect' }).catch(() => null)
      if (status?.phase === 'ready' && await ev('!!document.querySelector("#send") && !document.querySelector("#send").disabled')) break
      await sleep(500)
    }
    assert.equal(status?.phase, 'ready', JSON.stringify(status))
    assert((await send({ type: 'models' })).groups.length > 0)
    const settings = await send({ type: 'settings/describe' })
    const permission = settings.value.namespaces.find(item => item.ns === 'permission')
    assert.equal((await send({ type: 'settings/mutate', ns: 'permission', expectedRevision: permission.revision,
      ops: [{ op: 'set', path: ['defaultPreset'], value: permission.value.defaultPreset ?? 'workspace-write' }] })).ok, true)
    ok('real Chromium side panel', 'Send enabled and live model catalog loaded')
    if (!liveModel) return

    pageServer = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end('<!doctype html><title>Augmentor compatibility proof</title><button id="go" onclick="document.querySelector(\'#status\').textContent=\'CLICKED\'">Press me</button><input id="box"><div id="status">initial</div>')
    })
    await new Promise(resolve => pageServer.listen(0, '127.0.0.1', resolve))
    const fixtureUrl = `http://127.0.0.1:${pageServer.address().port}/`
    const prompt = `Use only the browser tools for this test. First call browser_tabs_list. Then browser_navigate to ${fixtureUrl}. Use browser_click with selector #go, then browser_type with selector #box and text AUGMENTOR_OK. Use browser_snapshot to verify the page. Reply with exactly: CLICKED AUGMENTOR_OK. Do not use bash, files, or other tools.`
    await ev(`document.querySelector('#input').value=${JSON.stringify(prompt)}; document.querySelector('#input').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#send').click()`)
    let completed = false, text = '', sessionId
    for (let i = 0; i < 180; i++) {
      await sleep(1000)
      status = await send({ type: 'connect' })
      sessionId = status.sessionId
      text = await ev('document.querySelector("#log").innerText')
      if (!status.running && await ev('!!document.querySelector("#log .err")')) throw new Error(`Live turn failed: ${text.slice(-1000)}`)
      if (!status.running && await ev('!!document.querySelector("#log .assistant .md") && document.querySelector("#log").innerText.includes("CLICKED AUGMENTOR_OK")')) { completed = true; break }
    }
    assert(completed, `Live browser task did not finish: ${text.slice(-1500)}`)
    const history = await send({ type: 'session/history', sessionId })
    assert.equal(history.ok, true, `history: ${history.error}`)
    const events = history.events.map(row => row.event)
    const toolNames = new Set(events.filter(event => event.type === 'tool/call').map(event => event.data.name))
    for (const name of ['browser_tabs_list', 'browser_navigate', 'browser_click', 'browser_type', 'browser_snapshot']) assert(toolNames.has(name), `model never called ${name}`)
    assert(!events.some(event => event.type === 'turn/end' && event.data.reason?.kind === 'error'), 'model turn ended with an error')
    assert.equal((await (await fetch(`${base}/api/augmentor`)).json()).pipes, 1, 'superseded native hosts must disconnect')
    const targets = await (await fetch(`${cdpBase}/json`)).json()
    const worked = targets.find(row => row.url === fixtureUrl)
    assert(worked, 'browser_navigate did not reach the test page')
    const page = await connectCdp(worked.webSocketDebuggerUrl)
    try {
      const result = await page.call('Runtime.evaluate', { expression: '({status:document.querySelector("#status").textContent,text:document.querySelector("#box").value})', returnByValue: true })
      assert.deepEqual(result.result.value, { status: 'CLICKED', text: 'AUGMENTOR_OK' })
    } finally { page.close() }
    for (const type of ['save', 'unsave']) {
      const result = await send({ type })
      assert.equal(result.ok, true, `${type}: ${JSON.stringify(result)}`)
    }
    ok('live model through real side panel', `all five tools, page DOM, reply, history and Save/Unsave verified (${sessionId})`)
    const admitted = await send({ type: 'prompt', text: 'Use browser_tabs_list to list the open browser tabs.' })
    assert.equal(admitted.accepted, true, JSON.stringify(admitted))
    const stopped = await send({ type: 'stop' })
    assert.equal(stopped.ok, true, JSON.stringify(stopped))
    for (let i = 0; i < 50 && (await send({ type: 'connect' })).running; i++) await sleep(100)
    assert.equal((await send({ type: 'connect' })).running, false)
    ok('Stop', 'a second admitted model turn cancels and the panel returns to idle')
  } finally { panel.close(); pageServer?.closeAllConnections(); pageServer?.close() }
}
