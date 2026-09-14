// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

// M2 browser-half acceptance in REAL Chrome (headless=new, CDP-driven).
//
// Proves the FIVE browser tools round-trip with the veil, end to end, on a
// FRESH dsh boot (this is the boot the user's server will have after its next
// restart — the running 3080 instance carries the pre-DSL-fix plugin module
// whose browser_tabs_list registration throws, so the tools must be proven
// here, not there):
//
//   1. ISOLATED `dsh web` instance: throwaway DSH_HOME (symlinked profiles /
//      settings / llm catalog / storages, FRESH empty sessions dir) + an
//      overlay patch mounting this plugin from source with an EXPLICIT
//      action-channel token (same overlay shape as plugin/tests/boot/run.sh).
//   2. REAL Chromium: fresh user-data-dir, --load-extension (same extension
//      dir as the user's install), a TEST native-host manifest whose wrapper
//      script points the pipe at the isolated server (DSH_AUGMENTOR_URL) with
//      the overlay token (DSH_AUGMENTOR_WS_TOKEN).
//   3. A LOCAL TEST PAGE on 127.0.0.1: a button (#go), an input (#box) and
//      two read-back divs (#status, #echo) — all state is innerText-readable
//      so browser_snapshot can verify it.
//   4. The sidepanel drives a real prompt turn on the app's default model
//      (whatever the symlinked settings.yaml selects — today the local Qwen
//      server) that must call, in order:
//        browser_tabs_list -> browser_navigate -> browser_click ->
//        browser_type -> browser_snapshot
//      (the full M2 tool set — a model that cannot SEE the tools cannot call
//      them, so passing tool calls prove the fresh-boot registry is visible).
//
// Asserts (all must hold):
//   - panel reaches send-ready (send button enabled — 0.1.17 contract)
//   - the turn calls ALL FIVE tools, in that order (session.history of the
//     created augmentor-* session on the isolated server)
//   - the test page DOM reflects the actions: #status 'CLICKED', #box value
//     'hi M2', #echo 'hi M2' (read via CDP on the tab the extension worked in)
//   - the frost veil (__#dshAugOverlay or documentElement.dataset.veil) was
//     OBSERVED in the worked tab during the turn
//   - the assistant reply reports STATUS=CLICKED and the typed text
//
// Repo home: augmentor/test/tools-e2e.mjs (uses plugin/node_modules/ws).
// Env: E2E_PORT (CDP, default 9224), E2E_PROFILE (default /tmp/chrome-tools-profile).
// The isolated dsh instance, page server and pipe are all killed on exit.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const AUG = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const EXT = path.join(AUG, 'extension')
const REAL_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const NODE_BIN = process.execPath
const WebSocket = require(path.join(AUG, 'plugin/node_modules/ws'))

const PORT = Number(process.env.E2E_PORT ?? 9224)
const PROFILE = process.env.E2E_PROFILE ?? '/tmp/chrome-tools-profile'
const TOKEN = `tools-e2e-token-${Date.now().toString(16)}`
const fail = (m) => { console.error('TOOLS-E2E FAIL:', m); cleanup(); process.exit(1) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- free port helper ----------
const freePort = () => new Promise((res) => {
  const s = http.createServer().listen(0, '127.0.0.1', () => { res(s.address().port); s.close() })
})

// ---------- 1. isolated DSH_HOME + overlay patch ----------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'augmentor-tools-e2e-'))
const ISO_HOME = path.join(TMP, 'home')
fs.mkdirSync(path.join(ISO_HOME, 'sessions'), { recursive: true })
// .credentials.yaml is the web Models-page key store (llm-deepseek is only the
// attachments dir) — without it the isolated server cannot resolve the API key
for (const p of ['profiles', 'settings.yaml', '.anonymous-user-id', '.credentials.yaml', 'llm-deepseek', 'storages', '.agent-presets', 'attachments']) {
  const src = path.join(REAL_HOME, p)
  if (fs.existsSync(src)) fs.symlinkSync(src, path.join(ISO_HOME, p))
}
// No cordis.patch.yml on purpose: the user's home patch already inserts
// dsh-augmentor; a second same-id insert row fails loud at boot.

const PLUGIN_ENTRY = path.join(AUG, 'plugin/src/index.ts')
const OVERLAY = path.join(TMP, 'overlay.yml')
fs.writeFileSync(OVERLAY, [
  '- insert:',
  '  - id: dsh-augmentor',
  `    name: '${PLUGIN_ENTRY}'`,
  '    config:',
  "      apiPath: '/api/augmentor'",
  `      wsToken: '${TOKEN}'`,
  '',
].join('\n'))

// ---------- 2. launch the isolated dsh web instance ----------
let DSH_PORT = 0
let dsh = null
const dshLog = fs.openSync(path.join(TMP, 'dsh.log'), 'w')
process.stderr.write(`[tools] booting isolated dsh web (overlay token, fresh DSH_HOME ${ISO_HOME})\n`)

// ---------- 3. local test page server ----------
const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Augmentor tools test page</title></head>
<body>
<h1>M2 tools test</h1>
<button id="go">Press me</button>
<input id="box" placeholder="type here">
<div id="status">initial</div>
<div id="echo"></div>
<script>
document.getElementById('go').addEventListener('click', () => {
  document.getElementById('status').textContent = 'CLICKED';
});
document.getElementById('box').addEventListener('input', () => {
  document.getElementById('echo').textContent = document.getElementById('box').value;
});
</script>
</body></html>`
let pageServer = null
let PAGE_PORT = 0
async function startPageServer() {
  PAGE_PORT = await freePort()
  pageServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGE_HTML)
  }).listen(PAGE_PORT, '127.0.0.1')
}

// ---------- 4. fresh Chromium profile + TEST native-host manifest ----------
fs.rmSync(PROFILE, { recursive: true, force: true })
const nmh = path.join(PROFILE, 'NativeMessagingHosts')
fs.mkdirSync(nmh, { recursive: true })
const realManifest = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/chromium/NativeMessagingHosts/com.deepseek.dsh.augmentor.json'), 'utf8'))
const WRAPPER = path.join(TMP, 'pipe-test-host.sh')
fs.writeFileSync(WRAPPER, [
  '#!/bin/sh',
  `echo $$ > '${TMP}/pipe.pid'`,
  `export DSH_AUGMENTOR_URL='http://127.0.0.1:PORT_PLACEHOLDER'`,
  `export DSH_AUGMENTOR_WS_TOKEN='${TOKEN}'`,
  `exec ${JSON.stringify(NODE_BIN)} ${JSON.stringify(path.join(AUG, 'pipe.mjs'))}`,
  '',
].join('\n'))
fs.chmodSync(WRAPPER, 0o755)
// Chromium only discovers manifests named <host-name>.json — the extension matters.
fs.writeFileSync(path.join(nmh, realManifest.name + '.json'), JSON.stringify({
  name: realManifest.name,
  description: 'Augmentor pipe (tools-e2e, points at isolated server)',
  path: WRAPPER,
  type: 'stdio',
  allowed_origins: realManifest.allowed_origins,
}, null, 1))
const EXT_ID = realManifest.allowed_origins[0].match(/chrome-extension:\/\/([^/]+)/)[1]

let chromium = null
const chromeLog = fs.openSync(path.join(TMP, 'chrome.log'), 'w')

const PIDS = []
let CLEANUP_RAN = false
function reapByMarker(marker) {
  // SIGTERM can leave orphaned renderers holding the profile lock; reap any
  // process whose cmdline carries the marker (exact user-data-dir / profile).
  try {
    for (const p of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
      if (Number(p) === process.pid) continue
      try {
        const cmd = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8')
        if (cmd.includes(marker)) process.kill(Number(p), 'SIGKILL')
      } catch {}
    }
  } catch {}
}
function cleanup() {
  if (CLEANUP_RAN) return
  CLEANUP_RAN = true
  for (const p of [chromium, dsh]) { try { p?.kill() } catch {} }
  try { if (pageServer) pageServer.close() } catch {}
  try {
    const pf = path.join(TMP, 'pipe.pid')
    if (fs.existsSync(pf)) process.kill(Number(fs.readFileSync(pf, 'utf8').trim()), 'SIGTERM')
  } catch {}
  reapByMarker(`user-data-dir=${PROFILE}`)
  if (!CLEAN_PASS) {
    // keep evidence for post-mortem on failure
    try {
      const dbg = '/tmp/tools-e2e-debug'
      fs.rmSync(dbg, { recursive: true, force: true })
      fs.cpSync(TMP, dbg, { recursive: true })
      console.error(`[tools] failure evidence kept at ${dbg}`)
    } catch {}
  } else {
    try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
  }
}
let CLEAN_PASS = false
process.on('exit', cleanup)

// ---------- LLM credentials for the isolated instance ----------
// The isolated server symlinks settings.yaml, but the live deployment
// resolves its model keys from the shell env that launched `dsh web` (the
// credentials file only holds the web-Models-page keys). Without the same
// keys the default-model turn dies with MISSING_CREDENTIAL before any tool
// runs. Harvest key-shaped vars from this env and from the live dsh
// process's environ (same user) — names are logged, values never are.
function harvestCredEnv() {
  const isKey = (k) => /(^DASH_[A-Z0-9_]*KEY$|_API_KEY$)/.test(k)
  const out = {}
  for (const [k, v] of Object.entries(process.env)) if (v && isKey(k)) out[k] = v
  try {
    for (const pid of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
      if (Number(pid) === process.pid) continue
      try {
        if (!/dsh( |\0)(--profile web|web)/.test(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'))) continue
        for (const line of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
          const eq = line.indexOf('=')
          if (eq < 0) continue
          const k = line.slice(0, eq), v = line.slice(eq + 1)
          if (v && isKey(k) && out[k] === undefined) out[k] = v
        }
        break // first live dsh web is the deployment's source of truth
      } catch { /* not readable: skip */ }
    }
  } catch { /* no /proc: own env only */ }
  return out
}
const CRED_ENV = harvestCredEnv()
process.stderr.write(`[tools] LLM credential env: ${Object.keys(CRED_ENV).join(', ') || '(none — the default-model turn will fail with MISSING_CREDENTIAL)'}\n`)

// ---------- main ----------
async function main() {
  DSH_PORT = await freePort()
  dsh = spawn('dsh', ['--profile', 'web', '--patch', OVERLAY, '--port', String(DSH_PORT), '--no-open'], {
    env: { ...process.env, DSH_HOME: ISO_HOME, ...CRED_ENV },
    stdio: ['ignore', dshLog, dshLog],
  })
  PIDS.push(dsh.pid)
  await startPageServer()
  // bake the resolved port into the wrapper (written before dsh booted)
  fs.writeFileSync(WRAPPER, fs.readFileSync(WRAPPER, 'utf8').replace('PORT_PLACEHOLDER', String(DSH_PORT)))

  // wait for the isolated server's augmentor handshake (200)
  let ready = false
  for (let i = 0; i < 90; i++) {
    await sleep(1000)
    try {
      const r = await fetch(`http://127.0.0.1:${DSH_PORT}/api/augmentor`)
      if (r.status === 200) { ready = true; break }
    } catch {}
    if (!dsh?.killed && dsh.exitCode !== null) {
      fs.closeSync(dshLog)
      fail('isolated dsh exited early:\n' + fs.readFileSync(path.join(TMP, 'dsh.log'), 'utf8').slice(-2500))
    }
  }
  if (!ready) fail('isolated dsh never served /api/augmentor')
  const hs = await (await fetch(`http://127.0.0.1:${DSH_PORT}/api/augmentor`)).json()
  process.stderr.write(`[tools] isolated dsh ready on :${DSH_PORT} (v${hs.version}, tokenSource=${hs.wsTokenSource}, pipes=${hs.pipes})\n`)
  if (hs.wsTokenSource !== 'config') fail(`expected token from config, got ${hs.wsTokenSource}`)

  // launch real Chromium
  chromium = spawn('/usr/lib/chromium/chromium', [
    '--headless=new',
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    `--load-extension=${EXT}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions-except=' + EXT,
    'about:blank',
  ], { stdio: ['ignore', chromeLog, chromeLog] })
  PIDS.push(chromium.pid)

  const jfetch = async (p, opts) => (await fetch(`http://127.0.0.1:${PORT}${p}`, opts)).json()
  let ver = null
  for (let i = 0; i < 60; i++) { await sleep(500); try { ver = await jfetch('/json/version'); break } catch {} }
  if (!ver) fail('CDP endpoint never came up')
  process.stderr.write(`[tools] CDP: ${ver.Browser}\n`)

  // ---------- sidepanel target ----------
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

  // ---------- page WS ----------
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
  process.stderr.write('[tools] sidepanel DOM ready\n')

  // ---------- auto-connect (real SW + pipe -> isolated server, token-gated) ----------
  // There is no Connect button since 0.1.16: the SW connects on boot (and
  // retries on backoff), so readiness must arrive unaided. 0.1.17: the header
  // status text is gone — readiness is the send button's enabled state.
  let panelReady = false
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    panelReady = await ev('!document.getElementById("send").disabled').catch(() => false)
    if (panelReady) break
  }
  if (!panelReady) fail('never connected (send stayed disabled)')
  process.stderr.write('[tools] connected (real SW + pipe + isolated token-gated server)\n')

  // ---------- the prompt turn: all five browser tools, in order ----------
  const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/page.html`
  const PROMPT = `Use the browser tools to work on a local test page, in this exact order:
1. browser_tabs_list (note how many tabs you see)
2. browser_navigate to ${PAGE_URL}
3. browser_click with selector '#go'
4. browser_type with selector '#box' and text 'hi M2'
5. browser_snapshot
Then reply with exactly one line in this format:
TABS=<count> STATUS=<text of the #status element> ECHO=<text of the #echo element>`
  await ev(`(function(){ const i = document.getElementById('input'); i.value = ${JSON.stringify(PROMPT)}; document.getElementById('send').click(); return true })()`)
  process.stderr.write(`[tools] prompt sent (5-tool turn, target page ${PAGE_URL})\n`)

  // ---------- parallel: watch the worked tab (veil + DOM state) via CDP ----------
  const PAGE_PROBE = `(() => {
    const ov = document.getElementById('__dshAugOverlay')
    const ds = document.documentElement.dataset.veil || null
    const st = document.getElementById('status')?.textContent ?? ''
    const echo = document.getElementById('echo')?.textContent ?? ''
    const box = document.getElementById('box')?.value ?? ''
    return JSON.stringify({ veil: !!(ov || ds), status: st, echo, box })
  })()`
  let pageWs = null
  let pseq2 = 0
  const ppend2 = new Map()
  let veilSeen = false
  let lastState = null
  async function openPageTarget(target) {
    pageWs = new WebSocket(target.webSocketDebuggerUrl)
    pageWs.on('message', (d) => { const r = JSON.parse(d); if (r.id && ppend2.has(r.id)) { ppend2.get(r.id)(r); ppend2.delete(r.id) } })
    await new Promise((res, rej) => { pageWs.once('open', res); pageWs.once('error', rej) })
    await pcall2('Runtime.enable')
  }
  const pcall2 = (method, params = {}) => new Promise((res, rej) => {
    const id = ++pseq2; ppend2.set(id, (r) => (r.error ? rej(new Error(method + ': ' + r.error.message)) : res(r.result)))
    pageWs.send(JSON.stringify({ id, method, params }))
  })
  const watch = (async () => {
    while (true) {
      await sleep(250)
      try {
        const list = await jfetch('/json')
        const t = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl && x.url.includes(`127.0.0.1:${PAGE_PORT}`))
        if (!t) continue
        if (!pageWs) await openPageTarget(t)
        const r = await pcall2('Runtime.evaluate', { expression: PAGE_PROBE, returnByValue: true })
        const s = JSON.parse(String(r?.result?.value ?? '{}'))
        if (s.veil) veilSeen = true
        if (s.status || s.echo || s.box) lastState = s
      } catch { /* tab mid-navigation */ }
    }
  })()

  // ---------- wait for the assistant reply (transient-network retry) ----------
  // A turn that dies on a transient network/model error before any tool ran
  // is safe to resend — the page actions are idempotent and the session
  // already exists.
  const logText = () => ev('document.getElementById("log").textContent') ?? ''
  // The final answer must carry the reported tab count — the model's reasoning
  // quotes the instructed format as 'TABS=<count> …' (angle brackets, no digit),
  // which this rejects; a real answer is 'TABS=3 STATUS=… ECHO=…'.
  const REPLY_LINE = (t) => String(t).split('\n').find((l) => /TABS=\d+\s+STATUS=/.test(l)) ?? null
  const errList = () => ev('[...document.querySelectorAll("#log .toolresult.err")].map(e=>e.textContent)') ?? []
  const TRANSIENT = /deepseek|fetch failed|network|timeout|ECONN|ENOTFOUND/i
  const MAX_PROMPT_ATTEMPTS = 3
  const t0 = Date.now()
  let reply = null
  let lastErr = ''
  let attempts = 1
  let handledErrCount = 0
  while (Date.now() - t0 < 420000) {
    await sleep(2000)
    const t = await logText()
    const errs = await errList()
    const err = errs.join(' | ')
    if (err) lastErr = err
    if (err.includes('MISSING_CREDENTIAL')) break // setup issue, not transient — see the credential-env log line
    if (REPLY_LINE(t)) { reply = t; break }
    if (errs.length > handledErrCount && TRANSIENT.test(err) && attempts < MAX_PROMPT_ATTEMPTS) {
      handledErrCount = errs.length
      attempts++
      process.stderr.write(`[tools] transient error in turn (${err.slice(0, 90)}…) — resending prompt (attempt ${attempts}/${MAX_PROMPT_ATTEMPTS})\n`)
      await ev(`(function(){ const i = document.getElementById('input'); i.value = ${JSON.stringify(PROMPT)}; document.getElementById('send').click(); return true })()`)
      continue
    }
  }
  if (!reply) fail(`no assistant reply reporting the page state (error strip: ${lastErr || 'none'})`)
  process.stderr.write(`[tools] reply rendered: ${(await logText()).length} chars in #log\n`)

  // let the veil settle + the page state land one last sample
  await sleep(2500)
  try {
    const list = await jfetch('/json')
    const t = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl && x.url.includes(`127.0.0.1:${PAGE_PORT}`))
    if (t && pageWs) {
      const r = await pcall2('Runtime.evaluate', { expression: PAGE_PROBE, returnByValue: true })
      lastState = JSON.parse(String(r?.result?.value ?? '{}'))
      if (lastState.veil) veilSeen = true
    }
  } catch {}
  watch.catch(() => {})
  try { pageWs?.close() } catch {}

  // ---------- session history: all five tools, in order ----------
  const rpc = (method, payload) =>
    fetch(`http://127.0.0.1:${DSH_PORT}/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'tools-1', method, payload }),
    }).then((r) => r.json()).then((b) => {
      if (!b?.result?.ok) throw new Error(method + ': ' + JSON.stringify(b?.result?.error))
      return b.result.value
    })
  const listV = await rpc('session.list', {})
  const augm = listV.items.filter((s) => String(s.sessionId).startsWith('augmentor-'))
  if (!augm.length) fail('no augmentor-* session in the isolated server — the turn never ran')
  const sid = augm[0].sessionId
  const hist = await rpc('session.history', { sessionId: sid, maxMessages: 200 })
  const histJson = JSON.stringify(hist)
  // Order is judged on the actual tool/call events in sequence order — tool
  // names also appear in the request/context schema block, where indexOf
  // would see the registration order, not the call order.
  const histEvents = (Array.isArray(hist?.events) ? hist.events : [])
    .map((h) => h?.event ?? h)
    .filter((e) => e && typeof e === 'object')
  const callSeq = histEvents
    .filter((e) => e.type === 'tool/call')
    .map((e) => e.data?.name ?? e.data?.toolName ?? '?')
  const TOOL_ORDER = ['browser_tabs_list', 'browser_navigate', 'browser_click', 'browser_type', 'browser_snapshot']
  const firstIdx = TOOL_ORDER.map((n) => callSeq.indexOf(n))
  TOOL_ORDER.forEach((n, k) => {
    if (firstIdx[k] < 0) fail(`tool ${n} never called — tool/call sequence was: ${JSON.stringify(callSeq)}`)
  })
  const inOrder = firstIdx.every((v, i) => i === 0 || v > firstIdx[i - 1])
  process.stderr.write(`[tools] session ${sid}: history ${histJson.length} chars; tool/call sequence ${JSON.stringify(callSeq)}; inOrder=${inOrder}\n`)
  if (!inOrder) fail(`tool calls not in the instructed order — sequence: ${JSON.stringify(callSeq)}`)

  // ---------- assertions on the page DOM ----------
  if (!lastState?.status || lastState.status !== 'CLICKED') fail(`#status expected 'CLICKED', got ${JSON.stringify(lastState?.status)} (state=${JSON.stringify(lastState)})`)
  if (lastState.box !== 'hi M2') fail(`#box value expected 'hi M2', got ${JSON.stringify(lastState.box)}`)
  if (lastState.echo !== 'hi M2') fail(`#echo expected 'hi M2', got ${JSON.stringify(lastState.echo)}`)
  process.stderr.write(`[tools] page DOM verified: ${JSON.stringify(lastState)} (veilSeen=${veilSeen})\n`)
  if (!veilSeen) fail('the frost veil was never observed in the worked tab')

  // ---------- reply content ----------
  const line = REPLY_LINE(reply) ?? ''
  if (!/STATUS=CLICKED/.test(line)) fail(`reply line does not report STATUS=CLICKED: ${JSON.stringify(line)}`)
  if (!line.includes('hi M2')) fail(`reply line does not report the typed text: ${JSON.stringify(line)}`)
  process.stderr.write(`[tools] reply line: ${JSON.stringify(line.trim())}\n`)

  // ---------- evidence ----------
  console.log(JSON.stringify({
    isolatedServer: { port: DSH_PORT, version: hs.version, wsTokenSource: hs.wsTokenSource },
    page: { url: PAGE_URL, state: lastState, veilSeen },
    session: { id: sid, historyChars: histJson.length, toolsInOrder: TOOL_ORDER, inOrder },
    reply: { line: line.trim(), logChars: (await logText()).length },
  }, null, 1))
  console.error('TOOLS-E2E: OK — all five browser tools round-tripped with the veil on a fresh dsh boot')
  CLEAN_PASS = true
  bws.close(); pws.close()
  process.exit(0)
}

main().catch((e) => fail(e?.stack ?? String(e)))
