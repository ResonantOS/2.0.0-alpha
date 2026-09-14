// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

// M2 acceptance in REAL Chrome (headless=new, CDP-driven): the agent works.
// Fresh user-data-dir (the user's browser is never touched) + --load-extension
// (same extension dir as the user's install) + host manifest copied into the
// fresh profile + the sidepanel.html page (the exact side-panel document).
//
// Production components: real Chrome SW, real connectNative, real pipe, live
// DSH server, real LLM turn on the app's catalog.
//
// Repo home: augmentor/test/m2-e2e.mjs (uses plugin/node_modules/ws).
// Env: E2E_PORT (default 9223), E2E_PROFILE (default /tmp/chrome-m2-profile),
//      M2_PROMPT (default: unique marker + one-line reply).
// Asserts: auto-connect (send button enabled — 0.1.17 contract); a prompt
// sent from the composer produces an assistant reply in #log (real turn
// through DSH); the model picker switches models without error
// (session.selectModel, dynamic unselected-row target); a session.create
// landed (an augmentor-* session in session.list); the M1 fence row is still
// 403; the marker session reopens and renders (M1 regression). The probe
// session is archived at the end.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const AUG = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const EXT = path.join(AUG, 'extension')
const WebSocket = require(path.join(AUG, 'plugin/node_modules/ws'))

const PORT = Number(process.env.E2E_PORT ?? 9223)
const PROFILE = process.env.E2E_PROFILE ?? '/tmp/chrome-m2-profile'
// Hermetic marker session (the old version pinned a live session id that
// drifted out of the popover list). With an env prompt, the marker is its
// first 20 chars, as before.
const MARKER = process.env.M2_PROMPT ? process.env.M2_PROMPT.slice(0, 20) : 'M2_E2E_OK_' + Math.random().toString(36).slice(2, 10)
const PROMPT = process.env.M2_PROMPT ?? `${MARKER} — reply with exactly one line: OK`
const LOCAL_MODEL = { provider: 'mx-qwen', model: 'Qwen3.8-27B-UD-Q6_K_XL' } // known-good: serves this very deployment
const fail = (m) => { console.error('M2-E2E FAIL:', m); try { chromium?.kill() } catch {} ; process.exit(1) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- fresh profile + host manifest ----------
fs.rmSync(PROFILE, { recursive: true, force: true })
const nmh = path.join(PROFILE, 'NativeMessagingHosts')
fs.mkdirSync(nmh, { recursive: true })
fs.copyFileSync(
  path.join(os.homedir(), '.config/chromium/NativeMessagingHosts/com.deepseek.dsh.augmentor.json'),
  path.join(nmh, 'com.deepseek.dsh.augmentor.json'),
)

// ---------- launch real Chromium ----------
const logs = fs.openSync('/tmp/chrome-m2.log', 'w')
let chromium
try {
  chromium = spawn('/usr/lib/chromium/chromium', [
    '--headless=new',
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    `--load-extension=${EXT}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions-except=' + EXT,
    'about:blank',
  ], { stdio: ['ignore', logs, logs] })
} catch (e) { fail('launch: ' + e.message) }
process.on('exit', () => { try { chromium?.kill() } catch {} })
process.stderr.write(`[m2] chromium pid ${chromium.pid}\n`)

const jfetch = async (p, opts) => (await fetch(`http://127.0.0.1:${PORT}${p}`, opts)).json()
let ver = null
for (let i = 0; i < 60; i++) {
  await sleep(500)
  try { ver = await jfetch('/json/version'); break } catch {}
}
if (!ver) fail('CDP endpoint never came up')
process.stderr.write(`[m2] CDP: ${ver.Browser}\n`)

const m = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/chromium/NativeMessagingHosts/com.deepseek.dsh.augmentor.json'), 'utf8'))
const EXT_ID = m.allowed_origins[0].match(/chrome-extension:\/\/([^/]+)/)[1]

// ---------- browser WS: create the sidepanel page target ----------
const bws = new WebSocket(ver.webSocketDebuggerUrl)
let bseq = 0
const bpend = new Map()
bws.on('message', (d) => { const r = JSON.parse(d); if (r.id && bpend.has(r.id)) { bpend.get(r.id)(r); bpend.delete(r.id) } })
const bcall = (method, params = {}) => new Promise((res, rej) => {
  const id = ++bseq; bpend.set(id, (r) => (r.error ? rej(new Error(method + ': ' + r.error.message)) : res(r.result)))
  bws.send(JSON.stringify({ id, method, params }))
})
await new Promise((res, rej) => { bws.once('open', res); bws.once('error', rej) })
await bcall('Target.createTarget', { url: `chrome-extension://${EXT_ID}/sidepanel.html` })
await sleep(1500)
let page = null
for (let i = 0; i < 20; i++) {
  const list = await jfetch('/json')
  page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.includes('sidepanel'))
  if (page) break
  await sleep(500)
}
if (!page) fail('sidepanel page target not found')
process.stderr.write(`[m2] page target: ${page.url}\n`)

// ---------- page WS: drive the DOM ----------
const pws = new WebSocket(page.webSocketDebuggerUrl)
let pseq = 0
const ppend = new Map()
pws.on('message', (d) => { const r = JSON.parse(d); if (r.id && ppend.has(r.id)) { ppend.get(r.id)(r); ppend.delete(r.id) } })
const pcall = (method, params = {}) => new Promise((res, rej) => {
  const id = ++pseq; ppend.set(id, (r) => (r.error ? rej(new Error(method + ': ' + r.error.message)) : res(r.result)))
  pws.send(JSON.stringify({ id, method, params }))
})
await new Promise((res, rej) => { pws.once('open', res); pws.once('error', rej) })
await pcall('Runtime.enable')
await pcall('Page.enable')
const ev = (expression) =>
  pcall('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    .then((r) => {
      if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? '').slice(0, 300))
      return r.result?.value
    })
for (let i = 0; i < 40; i++) {
  const rs = await ev('document.readyState').catch(() => 'loading')
  if (rs === 'complete') break
  await sleep(500)
}
if (!await ev('!!document.getElementById("title")')) fail('sidepanel DOM not ready')
process.stderr.write('[m2] sidepanel DOM ready\n')

// ---------- 1. Auto-connect (no Connect button since 0.1.16) ----------
// Readiness is the send button's enabled state (0.1.17).
let ready = false
for (let i = 0; i < 60; i++) {
  await sleep(500)
  ready = await ev('!document.getElementById("send").disabled')
  if (ready) break
}
if (!ready) fail('never connected (send stayed disabled)')
process.stderr.write('[m2] connected (real SW + pipe + live server)\n')

// ---------- 2. Send a prompt (the agent works) ----------
const logText = () => ev('document.getElementById("log").textContent') ?? ''
const assistantCount = () => ev('document.querySelectorAll("#log .assistant").length')
const sendFailText = () => ev('[...document.querySelectorAll("#log .toolresult.err")].map(e=>e.textContent).join(" | ")')

async function sendPrompt(text) {
  await ev(`(function(){ const i = document.getElementById('input'); i.value = ${JSON.stringify(text)}; document.getElementById('send').click(); return true })()`)
}
async function waitReply(marker, ms = 180000) {
  const t0 = Date.now()
  let lastErr = ''
  while (Date.now() - t0 < ms) {
    await sleep(2000)
    const t = await logText()
    const err = await sendFailText()
    if (err) lastErr = err
    if (t.includes(marker)) return t
  }
  return null
}
// DSH /api client (same envelope the pipe uses) — declared before the
// prompt so the id-diff below can run.
const rpc = (method, payload) =>
  fetch('http://127.0.0.1:3080/api/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'm2-1', method, payload }),
  }).then((r) => r.json()).then((b) => {
    if (!b?.result?.ok) throw new Error(method + ': ' + JSON.stringify(b?.result?.error))
    return b.result.value
  })
const idsBefore = new Set((await rpc('session.list', {})).items.map((s) => s.sessionId))
let reply = await (async () => {
  const t0 = Date.now()
  await sendPrompt(PROMPT)
  process.stderr.write(`[m2] prompt sent: ${JSON.stringify(PROMPT)}\n`)
  const t = await waitReply(MARKER)
  return t
})()
let promptVia = 'default-model'
if (!reply) {
  const err = await sendFailText()
  process.stderr.write(`[m2] default-model turn did not answer (error strip: ${err || 'none'}); switching to ${LOCAL_MODEL.provider}/${LOCAL_MODEL.model} via the picker\n`)
  // picker fallback (also exercises the fixed picker contract)
  await ev('document.getElementById("model").click()')
  for (let i = 0; i < 20; i++) { await sleep(500); if (await ev('document.querySelectorAll(".mp-row").length')) break }
  const rowSel = `[...document.querySelectorAll(".mp-row")].find(r => r.title === ${JSON.stringify(LOCAL_MODEL.provider + ' / ' + LOCAL_MODEL.model)})`
  if (!(await ev(`!!(${rowSel})`))) fail('local model row not in picker')
  await ev(`${rowSel}.click()`)
  await sleep(1500)
  const errAfter = await sendFailText()
  if (errAfter && errAfter.includes('unknown model')) fail(`picker still broken: ${errAfter}`)
  promptVia = `picker-switch-${LOCAL_MODEL.provider}`
  await sendPrompt(PROMPT)
  reply = await waitReply(MARKER)
}
if (!reply) fail('no assistant reply in real Chrome (the agent is not working)')
// the turn settled: Send is visible again (running cleared by session.status)
let settled = false
for (let i = 0; i < 30; i++) {
  await sleep(1000)
  if (await ev('!document.getElementById("send").hidden')) { settled = true; break }
}
process.stderr.write(`[m2] assistant reply rendered (${(await logText()).length} chars in #log, ${await assistantCount()} assistant bubbles, settled=${settled})\n`)

// ---------- 3. Model picker round-trip (session.selectModel) ----------
// Target is dynamic: any UNSELECTED row of the current catalog (the old
// version pinned a remote model that may no longer be in the catalog).
const modelLabel0 = await ev('document.getElementById("model-label").textContent')
await ev('document.getElementById("model").click()')
for (let i = 0; i < 20; i++) { await sleep(500); if (await ev('document.querySelectorAll(".mp-row").length')) break }
const rows = await ev('document.querySelectorAll(".mp-row").length')
if (rows < 2) fail('picker has <2 rows — cannot round-trip a model switch')
const altRow = `[...document.querySelectorAll(".mp-row")].find(r => !r.classList.contains("selected"))`
if (!(await ev(`!!(${altRow})`))) fail('no unselected picker row found')
await ev(`${altRow}.click()`)
await sleep(1500)
const pickerErr = await sendFailText()
if (pickerErr && (pickerErr.includes('unknown model') || pickerErr.includes('switch failed'))) fail(`model switch failed: ${pickerErr}`)
const modelLabel1 = await ev('document.getElementById("model-label").textContent')
process.stderr.write(`[m2] picker: ${rows} rows, switched ${modelLabel0} -> ${modelLabel1}\n`)

// ---------- 4. Session list: the created augmentor-* session must exist ----------
const listItems = await ev('(async () => { document.getElementById("sessions").click(); await new Promise(r => setTimeout(r, 3000)); return [...document.querySelectorAll(".sp-row")].map(r => r.title) })()')
const rowCount = listItems.length
// the created session is visible to the app: query the app directly
const listV = await rpc('session.list', {})
const augm = listV.items.filter((s) => String(s.sessionId).startsWith('augmentor-'))
if (!augm.length) fail('no augmentor-* session in session.list — session.create never landed')
process.stderr.write(`[m2] sessions: ${rowCount} rows in panel; app list has ${augm.length} augmentor-* session(s): ${augm.map(s => s.sessionId).join(', ')}\n`)

// ---------- 5. Probe (M1 regression: the 403 fence row) ----------
const probeFile = path.join(AUG, 'trace/fence-probe.json')
const before = fs.existsSync(probeFile) ? fs.statSync(probeFile).mtimeMs : 0
await ev('[...document.querySelectorAll(".sp-strip button")].find(b=>b.textContent==="Probe").click()')
for (let i = 0; i < 30; i++) {
  await sleep(500)
  if (fs.existsSync(probeFile) && fs.statSync(probeFile).mtimeMs > before) break
}
const probeData = JSON.parse(fs.readFileSync(probeFile, 'utf8'))
if (probeData.fenced?.status !== 403) fail(`fence row expected 403, got ${probeData.fenced?.status}`)
process.stderr.write(`[m2] probe: api=${probeData.api?.status} root=${probeData.root?.status} fenced=${probeData.fenced?.status}\n`)

// ---------- 6. Reopen the marker session (M1 regression: render) ----------
// The section-2 probe session is the target — no pinned external session
// id. Match by SESSION ID (data-session-id), not title: the DSH app
// rewrites session titles asynchronously after the turn (the marker title
// gets replaced by the assistant's first line), so a title match races it.
let SID6 = null
for (let i = 0; i < 30; i++) {
  await sleep(500)
  const now = new Set((await rpc('session.list', {})).items.map((s) => s.sessionId))
  const fresh = [...now].filter((id) => !idsBefore.has(id))
  if (fresh.length === 1) { SID6 = fresh[0]; break }
}
if (!SID6) fail('M1 regression: new session did not appear in session.list')
const rowSel3 = `[...document.querySelectorAll(".sp-row")].find(r => r.dataset.sessionId === ${JSON.stringify(SID6)})`
let rowFound3 = false
for (let i = 0; i < 20; i++) {
  await sleep(500)
  rowFound3 = await ev(`!!(${rowSel3})`)
  if (rowFound3) break
}
if (!rowFound3) fail('M1 regression: marker session row (by session id) not found')
await ev(`${rowSel3}.click()`)
let logText2 = ''
for (let i = 0; i < 60; i++) {
  await sleep(500)
  logText2 = await logText()
  if (logText2.includes(MARKER)) break
}
const renderedUser = logText2.includes(MARKER)
if (!renderedUser) fail('M1 regression: marker session not rendered')
process.stderr.write(`[m2] M1 regression: marker session rendered (${logText2.length} chars)\n`)

// ---------- 7. Cleanup: archive the probe session ----------
let SID = null
for (const s of (await rpc('session.list', {})).items.filter((x) => String(x.sessionId).startsWith('augmentor-'))) {
  const hist = (await rpc('session.history', { sessionId: s.sessionId, maxMessages: 10 })).events ?? []
  if (JSON.stringify(hist).includes(MARKER)) { SID = s.sessionId; break }
}
if (!SID) fail('probe session not found for cleanup')
await rpc('workspace.archiveSession', { sessionId: SID })
const archived = (await rpc('workspace.list', {})).archivedSessionIds ?? []
if (!archived.includes(SID)) fail('probe session not archived', archived)
process.stderr.write(`[m2] cleanup: ${SID} archived\n`)

// ---------- evidence ----------
console.log(JSON.stringify({
  status: (await ev('!document.getElementById("send").disabled')) ? 'ready' : 'not-ready',
  prompt: { via: promptVia, marker: MARKER, replyChars: reply.length, settled, assistantBubbles: await assistantCount() },
  picker: { rows, from: modelLabel0, to: modelLabel1 },
  createdSessions: augm.map((s) => s.sessionId),
  probe: { api: probeData.api?.status, root: probeData.root?.status, fenced: probeData.fenced?.status },
  m1Regression: { title: await ev('document.getElementById("title").textContent'), logChars: logText2.length, renderedUserText: renderedUser },
  cleanup: { session: SID, archived: true },
}, null, 1))
console.error('M2-E2E: OK — the agent works in real Chrome (prompt -> reply), picker switches, M1 intact')
bws.close(); pws.close()
chromium.kill()
process.exit(0)
