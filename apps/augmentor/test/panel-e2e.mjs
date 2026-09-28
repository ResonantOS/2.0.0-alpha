// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

// M1 exit proof, headless: REAL sidepanel.js + chat-render.js (ES modules in
// jsdom) + REAL sw.js (module realm via vm.SourceTextModule — F1: sw.js is a
// module service worker) + REAL pipe (host-manifest spawn) + live DSH server.
//
// Repo home: augmentor/test/panel-e2e.mjs — deps: `cd test && npm i`
// (jsdom + marked; test/package.json). The panel code under test is the
// unmodified extension module graph; the SW is the unmodified sw.js.
// Emulated: only the chrome.* surfaces (connectNative bridged to the spawned
// pipe; SW<->panel messages bridged; one shared storage.local Map).
// Flow: wait for the SW's auto-connect (top-level ensurePort; no button) ->
// wait 'connected' -> click #sessions -> click Probe (asserts pipe persisted)
// -> model picker (3b): Pinned top section (from the DSH model-picker
// settings, when pins exist) + live search filtering + a row-click model
// switch with restore of the original selection -> send a unique marker
// prompt -> assert the user bubble + assistant prose rendered into #log ->
// reopen the session from the popover and assert the history replay ->
// archive the probe session.
import { spawn, spawnSync } from 'node:child_process'
import vm from 'node:vm'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const markedNpm = (await import('marked')).marked

const AUG = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const EXT = path.join(AUG, 'extension')
const MANIFEST =
  process.env.NMH_MANIFEST ??
  path.join(os.homedir(), '.config/chromium/NativeMessagingHosts/com.deepseek.dsh.augmentor.json')
const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
const EXT_ID = m.allowed_origins?.[0]?.match(/chrome-extension:\/\/([^/]+)/)?.[1]
const fail = (msg) => { console.error('RENDER FAIL:', msg); process.exit(1) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// F1: the SW is loaded below with vm.SourceTextModule, which requires
// --experimental-vm-modules. Re-exec self once when the flag is absent —
// the flagged child is the real run (env is inherited).
if (!process.execArgv.includes('--experimental-vm-modules')) {
  const r = spawnSync(
    process.execPath,
    ['--experimental-vm-modules', process.argv[1], ...process.argv.slice(2)],
    { stdio: 'inherit' },
  )
  process.exit(r.status ?? 1)
}

// ---------- pipe (spawned as Chrome would) ----------
const pipe = spawn(m.path, [`chrome-extension://${EXT_ID}/`], { stdio: ['pipe', 'pipe', 'pipe'] })
let pipeBuf = Buffer.alloc(0)
let maxFrame = 0
const portListeners = { onMessage: [], onDisconnect: [] }
function pipeSend(obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8')
  const h = Buffer.alloc(4); h.writeUInt32LE(b.length)
  pipe.stdin.write(Buffer.concat([h, b]))
}
pipe.stdout.on('data', (d) => {
  pipeBuf = Buffer.concat([pipeBuf, d])
  while (pipeBuf.length >= 4) {
    const len = pipeBuf.readUInt32LE(0)
    if (pipeBuf.length < 4 + len) return
    const msg = JSON.parse(pipeBuf.subarray(4, 4 + len).toString('utf8'))
    pipeBuf = pipeBuf.subarray(4 + len)
    maxFrame = Math.max(maxFrame, 4 + len)
    for (const fn of portListeners.onMessage) fn(msg)
  }
})
pipe.stderr.on('data', (d) => {
  const s = d.toString()
  if (/starting|shaped|ready|error|ERROR|closed|exited/.test(s)) process.stderr.write('[pipe] ' + s)
})
pipe.on('exit', (c) => process.stderr.write(`[pipe] exited ${c}\n`))

// ---------- shared storage (Chrome storage.local is one store) ----------
const storage = new Map()
const storageShim = {
  local: {
    get: (_k, cb) => cb({}),
    set: (obj, cb) => { for (const [k, v] of Object.entries(obj)) storage.set(k, v); cb && cb() },
  },
  onChanged: { addListener: () => {} },
}

// ---------- SW (real sw.js in a vm) ----------
const swRuntimeListeners = []
let panelEvtListener = null
const swChrome = {
  runtime: {
    id: EXT_ID,
    lastError: undefined,
    connectNative: (host) => { process.stderr.write(`[shim] connectNative(${host})\n`); return fakePort },
    onMessage: { addListener: (fn) => swRuntimeListeners.push(fn) },
    // SW -> panel: in Chrome this reaches the panel's runtime.onMessage
    sendMessage: (msg) => { panelEvtListener?.(msg, {}); return Promise.resolve() },
  },
  sidePanel: { setPanelBehavior: () => {}, setOptions: () => {} },
  storage: storageShim,
  tabs: {
    query: (_q, cb) => cb([]), get: (_i, cb) => cb(undefined), create: (_p, cb) => cb({ id: 999 }),
    update: (id, _p, cb) => cb && cb({ id }),
    onActivated: { addListener: () => {} }, onRemoved: { addListener: () => {} },
    onUpdated: { addListener: () => {}, removeListener: () => {} }, Tab: {},
  },
  windows: { getLastFocused: (_w, cb) => cb({ id: 1 }) },
  scripting: { executeScript: (_i, cb) => cb && cb([]) },
}
const fakePort = {
  onMessage: { addListener: (fn) => portListeners.onMessage.push(fn) },
  onDisconnect: { addListener: (fn) => portListeners.onDisconnect.push(fn) },
  postMessage: (o) => pipeSend(o),
  disconnect: () => { try { pipe.kill() } catch {} },
}
// F1: sw.js is a module entry (manifest "type": "module") — static imports
// that vm.runInContext (classic script) cannot execute. vm.SourceTextModule
// loads the real module graph in its OWN context: exactly what Chrome does
// for a module service worker (a separate realm with its own chrome object
// — the panel below keeps its own, so the two never cross).
const swSandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  crypto, URL, TextEncoder, TextDecoder, fetch,
  chrome: swChrome,
  self: { location: { origin: `chrome-extension://${EXT_ID}` } },
}
const swCtx = vm.createContext(swSandbox)
const swModules = new Map() // file URL -> SourceTextModule
const swLinkPromises = new Map() // file URL -> the link() Promise
function loadSwModule(file) {
  const url = pathToFileURL(file).href
  if (swModules.has(url)) return swModules.get(url)
  const mod = new vm.SourceTextModule(fs.readFileSync(file, 'utf8'), {
    identifier: `sw:${path.basename(file)}`,
    context: swCtx,
  })
  swModules.set(url, mod)
  const base = path.dirname(file)
  // link() RETURNS A PROMISE (resolves when the module graph reaches
  // `linked`); the linker callback itself must return Module objects
  // synchronously — the recursion below does exactly that.
  swLinkPromises.set(url, mod.link((specifier) => {
    // The SW graph is all relative files (./port.mjs, …); a bare specifier
    // would be a regression the harness must not paper over.
    if (!specifier.startsWith('.')) throw new Error('unexpected bare specifier in extension SW: ' + specifier)
    return loadSwModule(path.join(base, specifier))
  }))
  return mod
}
const swEntry = loadSwModule(path.join(EXT, 'sw.js'))
await swLinkPromises.get(pathToFileURL(path.join(EXT, 'sw.js')).href)
await swEntry.evaluate()
if (swRuntimeListeners.length === 0) fail('sw.js registered no runtime.onMessage listener')
const swHandler = swRuntimeListeners[swRuntimeListeners.length - 1]
// panel -> SW: exactly what chrome.runtime.sendMessage does in Chrome.
// The sender mirrors real Chrome for the extension's OWN pages (id +
// chrome-extension:// url) — sw.js validates the sender (audit S5), so the
// shim must be Chrome-faithful or every message is (correctly) dropped.
const panelSender = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/sidepanel.html`, tab: { id: 1 } }
function swDispatch(msg) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    const ok = swHandler(msg, panelSender, done)
    if (ok === true) setTimeout(() => done(undefined), 30000)
    else done(undefined)
  })
}

// ---------- panel (real sidepanel.js in jsdom) ----------
const dom = new JSDOM(fs.readFileSync(path.join(EXT, 'sidepanel.html'), 'utf8'), {
  // jsdom's localStorage rejects the chrome-extension: scheme (opaque origin);
  // the scheme is irrelevant to the code under test
  url: 'http://localhost/sidepanel.html',
  pretendToBeVisual: true,
  runScripts: 'outside-only',
})
const { window } = dom
const panelListeners = []
const panelChrome = {
  runtime: {
    id: EXT_ID,
    lastError: undefined,
    sendMessage: (msg) => swDispatch(msg),
    onMessage: { addListener: (fn) => panelListeners.push(fn) },
  },
  storage: storageShim,
}
// theme-tokens.js (classic IIFE -> globalThis.__dshAugTheme), as in the HTML
// (vm.runInThisContext — Node 24.19's V8 chokes on the `(0, eval)(...)`
// source pattern; see proposal §10 V8 note)
vm.runInThisContext(fs.readFileSync(path.join(EXT, 'theme-tokens.js'), 'utf8'))
globalThis.window = window
globalThis.document = window.document
globalThis.MutationObserver = window.MutationObserver
globalThis.localStorage = window.localStorage
globalThis.location = window.location
globalThis.requestAnimationFrame = window.requestAnimationFrame?.bind(window) ?? ((cb) => setTimeout(cb, 16))
globalThis.cancelAnimationFrame = window.cancelAnimationFrame?.bind(window) ?? clearTimeout
globalThis.chrome = panelChrome
window.marked = markedNpm // chat-render.js: window.marked.parse(...)
window.dispatchEvent(new window.Event('DOMContentLoaded'))
await import(path.join(EXT, 'sidepanel.js'))
// route SW broadcasts to the panel's 'evt' listener
for (const fn of panelListeners) panelEvtListener = fn
process.stderr.write(`[harness] panel imported; listeners: panel=${panelListeners.length} sw=${swRuntimeListeners.length}\n`)

const doc = window.document
// 0.1.17: the header's "connected" status text was removed (the panel is
// auto-connected; no persistent readout). Readiness is observed through the
// send button, which updateChrome enables only when phase === 'ready'.
const sendReady = () => !doc.getElementById('send').disabled

// ---------- 1. Auto-connect (the real sw.js connects at SW boot) ----------
let waited = 0
while (!sendReady() && waited < 30000) {
  await sleep(250); waited += 250
}
if (!sendReady()) fail('panel never reached ready (send button stayed disabled)')
process.stderr.write(`[harness] panel ready: send enabled (after ${waited}ms)\n`)

// ---------- 2. Sessions popover ----------
await doc.getElementById('sessions').click()
waited = 0
let rows = doc.querySelectorAll('.sp-row')
while (rows.length === 0 && waited < 15000) {
  if (doc.querySelector('.sp-strip.err')) fail('session list error: ' + doc.querySelector('.sp-strip.err').textContent)
  await sleep(250); waited += 250
  rows = doc.querySelectorAll('.sp-row')
}
if (!rows.length) fail('no session rows rendered')
process.stderr.write(`[harness] sessions popover: ${rows.length} rows\n`)

// ---------- 3. Probe (before opening a session; strip lives in the popover) ----------
const probeFile = path.join(AUG, 'trace/fence-probe.json')
const before = fs.existsSync(probeFile) ? fs.statSync(probeFile).mtimeMs : 0
const probeBtn = [...doc.querySelectorAll('.sp-strip button')].find((b) => b.textContent === 'Probe')
if (!probeBtn) fail('Probe button not in popover')
await probeBtn.click()
waited = 0
while (waited < 15000) {
  await sleep(250); waited += 250
  if (fs.existsSync(probeFile) && fs.statSync(probeFile).mtimeMs > before) break
}
if (!fs.existsSync(probeFile) || fs.statSync(probeFile).mtimeMs <= before) fail('probe did not persist a fresh fence-probe.json')
const probeData = JSON.parse(fs.readFileSync(probeFile, 'utf8'))
process.stderr.write(`[harness] probe persisted: api=${probeData.api?.status} root=${probeData.root?.status} fenced=${probeData.fenced?.status} origin=${probeData.origin}\n`)

// ---------- 3b. Model picker: search + Pinned top section ----------
// Parity with the user's DSH model picker plugin (dsh-model-picker-augmented):
// the bridge now reads that plugin's settings section (pinned order + hidden
// keys) alongside the catalog, and the panel renders a Pinned section on top
// plus a live row search. The expected row set below is computed from the SW
// own 'models' reply — the exact data the panel renders (pipe → SW → panel,
// all real). Runs before the first prompt (section 4), so a row click
// switches locally only (no session exists yet — the choice is remembered
// for the first prompt), and the original selection is restored before the
// probe prompt so section 4's model is unchanged.
const modelBtnEl = doc.getElementById('model')
const modelPopEl = doc.getElementById('modelpop')
const searchInput = doc.getElementById('modelpop-search-input')
const searchClearBtn = doc.getElementById('modelpop-search-clear')
if (!searchInput || !searchClearBtn) fail('picker search markup missing')
await modelBtnEl.click()
let pickRows = doc.querySelectorAll('#modelpop .mp-row')
waited = 0
while (pickRows.length === 0 && waited < 15000) {
  const errStrip = doc.querySelector('#modelpop .mp-strip.err')
  if (errStrip) fail('picker error strip: ' + errStrip.textContent)
  await sleep(250); waited += 250
  pickRows = doc.querySelectorAll('#modelpop .mp-row')
}
if (!pickRows.length) fail('picker rendered no rows')
const catalog = await swDispatch({ type: 'models' })
if (!catalog?.ok || !Array.isArray(catalog.groups)) fail('SW models reply malformed')
const catalogPinned = catalog.pinned ?? []
const catalogHidden = new Set(catalog.hidden ?? [])
// Expected visible rows for a query — mirrors the panel's render logic
// (the DSH plugin's buildRows rules): pinned first (in catalog, not hidden,
// user order, removed from their groups), then the groups (pinned removed,
// search-empty groups gone); a row matches when the query is a substring of
// the model name, the model id, or the provider name (case-insensitive).
// Two key formats: settings/pins are stored "provider/model" (wire format),
// while a picker row's title is "provider / model" (the DOM convention m2
// depends on) — expected values below use the title format for DOM compare.
const byKeyAll = new Map()
for (const g of catalog.groups) for (const m of g.models) byKeyAll.set(g.provider + '/' + m.model, true)
const expectedPinKeys = catalogPinned.filter((k) => byKeyAll.has(k) && !catalogHidden.has(k))
const pinTitleOf = (k) => k.replace('/', ' / ')
const expectedKeys = (q) => {
  const byKey = new Map()
  for (const g of catalog.groups) for (const m of g.models) byKey.set(g.provider + '/' + m.model, { g, m })
  const pinned = []
  const pinnedSet = new Set()
  for (const key of catalogPinned) {
    const e = byKey.get(key)
    if (e && !catalogHidden.has(key)) { pinned.push(e); pinnedSet.add(key) }
  }
  // Same normalization as the panel: trim + lowercase the query once.
  const qn = q.trim().toLowerCase()
  const match = (g, m) =>
    qn === '' || m.name.toLowerCase().includes(qn) || m.model.toLowerCase().includes(qn) || g.name.toLowerCase().includes(qn)
  const pinnedVisible = pinned.filter(({ g, m }) => match(g, m))
  const groups = catalog.groups
    .map((g) => ({ ...g, models: g.models.filter((m) => !pinnedSet.has(g.provider + '/' + m.model) && match(g, m)) }))
    .filter((g) => g.models.length > 0)
  // pinnedVisible holds {g, m} pairs; the group arrays hold model entries
  // addressed by their group's provider. Title format (matches r.title).
  return [
    ...pinnedVisible.map(({ g, m }) => g.provider + ' / ' + m.model),
    ...groups.flatMap((g) => g.models.map((m) => g.provider + ' / ' + m.model)),
  ]
}
const domKeys = () => [...doc.querySelectorAll('#modelpop .mp-row')].map((r) => r.title)
const sameKeys = (a, b) => a.length === b.length && a.every((k, i) => k === b[i])
const fullKeys = expectedKeys('')
if (!sameKeys(domKeys(), fullKeys)) fail('picker full list does not match the SW catalog (order incl. pinned section)')
// Pinned section: present iff the DSH picker has pins that survive
// (in catalog, not hidden) — in the user's order, deduped from groups.
const pinHeader = doc.querySelector('#modelpop .mp-group.pin')
if (expectedPinKeys.length > 0) {
  if (!pinHeader) fail('Pinned section missing although the DSH picker has pins')
  if (pinHeader.textContent.trim() !== 'Pinned') fail('Pinned header label: ' + pinHeader.textContent)
  const actualPinKeys = [...doc.querySelectorAll('#modelpop .mp-row')].slice(0, expectedPinKeys.length).map((r) => r.title)
  if (!sameKeys(actualPinKeys, expectedPinKeys.map(pinTitleOf))) fail('pinned rows have wrong keys or order')
  if (new Set(domKeys()).size !== domKeys().length) fail('a model row appears twice (pinned + group)')
} else if (pinHeader) {
  fail('Pinned section rendered although the DSH picker has no pins')
}
// Search: a query that actually filters (the first row's model id — unique
// in the catalog; other rows can still contain it in name/provider).
let query = domKeys()[0].split(' / ').slice(1).join(' / ')
if (expectedKeys(query).length === domKeys().length) query = catalog.groups[0].name
const searchExpected = expectedKeys(query)
if (searchExpected.length === domKeys().length) fail('no filtering query found (catalog too small?)')
searchInput.value = query
searchInput.dispatchEvent(new window.Event('input', { bubbles: true }))
if (searchClearBtn.hidden) fail('clear button not shown with an active query')
if (!sameKeys(domKeys(), searchExpected)) fail(`search "${query}": rows do not match expected (${domKeys().length} vs ${searchExpected.length})`)
// A query nothing matches: rows vanish, the no-match strip appears.
searchInput.value = 'zzqzx-404-none'
searchInput.dispatchEvent(new window.Event('input', { bubbles: true }))
if (doc.querySelector('#modelpop .mp-row')) fail('no-match query still renders rows')
if (!/No models match/.test(doc.querySelector('#modelpop .mp-strip')?.textContent ?? '')) fail('no-match strip missing')
// Escape inside the field clears the query (DSH parity) and keeps the
// popover open; the full list comes back.
searchInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
if (searchInput.value !== '' || !searchClearBtn.hidden) fail('Escape did not clear the search query')
if (modelPopEl.hidden) fail('Escape cleared the query but also closed the popover')
if (!sameKeys(domKeys(), fullKeys)) fail('full list not restored after Escape')
// The clear button resets too.
searchInput.value = query
searchInput.dispatchEvent(new window.Event('input', { bubbles: true }))
searchClearBtn.click()
if (searchInput.value !== '' || !searchClearBtn.hidden) fail('clear button did not reset the query')
if (!sameKeys(domKeys(), fullKeys)) fail('full list not restored after clear button')
// Row click: prefer an unselected PINNED row (proves the Pinned section is
// fully wired); the switch is local-only before the first prompt.
const allPickRows = [...doc.querySelectorAll('#modelpop .mp-row')]
const pickCandidate =
  allPickRows.slice(0, expectedPinKeys.length).find((r) => !r.classList.contains('selected')) ??
  allPickRows.find((r) => !r.classList.contains('selected'))
if (!pickCandidate) fail('no unselected picker row to switch to')
const pickName = pickCandidate.querySelector('.mp-name').textContent
const pickFromPin = allPickRows.indexOf(pickCandidate) < expectedPinKeys.length
await pickCandidate.click()
// The label updates synchronously; a failed switch would leave a
// 'send failed' entry in #log (ui.sendFail).
if (doc.getElementById('model-label').textContent !== pickName) fail(`model label did not switch to ${pickName}`)
waited = 0
let switchErr = ''
while (waited < 5000) {
  await sleep(250); waited += 250
  switchErr = [...doc.querySelectorAll('#log .toolresult.err')].map((n) => n.textContent).join(' ')
  if (switchErr.includes('send failed')) break
}
if (switchErr.includes('send failed')) fail('model switch failed: ' + switchErr)
// Restore the original selection before the probe prompt: section 4 must
// run on the same model the panel started with (best effort — the original
// row is still in the catalog; matched by provider/model key, not by label
// text, so a display-name collision cannot restore the wrong model; the
// click closes the popover).
const originalKey = catalog.selection ? `${catalog.selection.provider} / ${catalog.selection.model}` : null
await modelBtnEl.click()
waited = 0
let restoreRow = null
while (waited < 5000) {
  await sleep(250); waited += 250
  restoreRow = originalKey
    ? [...doc.querySelectorAll('#modelpop .mp-row')].find((r) => r.title === originalKey) ?? null
    : null
  if (restoreRow || doc.querySelector('#modelpop .mp-strip.err')) break
}
if (restoreRow) {
  await restoreRow.click()
} else {
  process.stderr.write('[harness] picker: original model not found for restore (best effort)\n')
}
process.stderr.write(`[harness] picker: ${fullKeys.length} rows, ${expectedPinKeys.length} pinned, search "${query}" -> ${searchExpected.length} rows, switched to ${pickName} (from pinned: ${pickFromPin}), restored: ${!!restoreRow}\n`)

// ---------- 4. Send a unique marker prompt; assert the conversation renders ----------
// Drift-free target: the old version pinned a hardcoded live session, and once
// that session fell outside the popover's 20-row window the row matcher picked
// the WRONG row and asserted text from a session that was never opened. Now
// the test creates its own session with a unique marker (same pattern as
// m3-e2e), so the render assertion can only be true for the conversation this
// run actually sent.
const rpc = (method, payload) =>
  fetch('http://127.0.0.1:3080/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'rt-1', method, payload }),
  }).then((r) => r.json()).then((b) => {
    if (!b?.result?.ok) throw new Error(method + ': ' + JSON.stringify(b?.result?.error))
    return b.result.value
  })
const MARKER = 'PANEL_E2E_OK_' + Math.random().toString(36).slice(2, 10)
const PROMPT = `${MARKER} — reply with exactly one line: OK`
const idsBefore = new Set((await rpc('session.list', {})).items.map((s) => s.sessionId))
doc.getElementById('input').value = PROMPT
await doc.getElementById('send').click()
process.stderr.write(`[harness] prompt sent: ${JSON.stringify(MARKER)}\n`)
// The user bubble paints immediately; the assistant reply proves the full
// downlink path, including the md() render of assistant text.
waited = 0
let logText = ''
while (waited < 120000) {
  await sleep(500); waited += 500
  logText = doc.getElementById('log')?.textContent ?? ''
  const prose = [...doc.querySelectorAll('#log .msg.assistant .md')].map((n) => n.textContent || '').join('')
  if (logText.includes(MARKER) && prose.trim()) break
}
const renderedUser = logText.includes(MARKER)
// Assistant prose, re-read at the end (not just the loop's break moment):
// the conversation is "visibly rendered" iff the user bubble AND non-empty
// assistant prose are in #log. (The old 200-char log floor was a proxy that
// depended on how chatty the model was — a model that obeys "reply with
// exactly one line: OK" produces ~2 chars of prose and a 62-char log, which
// is a fully rendered conversation, not a failure.)
const renderedProse = [...doc.querySelectorAll('#log .msg.assistant .md')]
  .map((n) => n.textContent || '')
  .join('')
  .trim()
const assistantBubbles = doc.querySelectorAll('#log .assistant').length
const userBubbles = doc.querySelectorAll('#log .user').length
const titleText = doc.getElementById('title')?.textContent
process.stderr.write(
  `[harness] log: ${logText.length} chars, user=${userBubbles} assistant=${assistantBubbles} title="${titleText}" userTextRendered=${renderedUser}\n`,
)

// ---------- 4b. Reopen the session from the popover (row click -> history replay) ----------
// The list captured in step 2 predates the new session: close and reopen.
// The row is identified by SESSION ID, not title: the DSH app rewrites
// session titles asynchronously after the turn (observed: the marker title
// "PANEL_E2E_OK_… — reply with exa…" gets replaced by "OK", the assistant's
// first line) — a title match races that re-title and drifts between runs.
// The id diff is the same drift-free target cleanup (4c) already uses.
let SID = null
waited = 0
while (!SID && waited < 15000) {
  await sleep(500); waited += 500
  const now = new Set((await rpc('session.list', {})).items.map((s) => s.sessionId))
  const fresh = [...now].filter((id) => !idsBefore.has(id))
  if (fresh.length === 1) SID = fresh[0]
}
if (!SID) fail('new session did not appear in session.list after the turn')
await doc.getElementById('sessions').click() // close
await sleep(300)
await doc.getElementById('sessions').click() // reopen, fresh list
let targetRow = null
waited = 0
while (!targetRow && waited < 10000) {
  await sleep(250); waited += 250
  targetRow = [...doc.querySelectorAll('.sp-row')].find((r) => r.dataset.sessionId === SID) ?? null
}
if (!targetRow) fail('new session row (by session id) not in reopened popover')
await targetRow.click()
process.stderr.write(`[harness] clicked row: title="${targetRow.querySelector('.sp-title')?.textContent}"\n`)
let replayText = ''
waited = 0
while (waited < 30000) {
  await sleep(500); waited += 500
  replayText = [...doc.querySelectorAll('#log .msg.assistant .md')].map((n) => n.textContent || '').join('\n')
  if (replayText.trim()) break
}
if (!replayText.trim()) fail('history replay rendered no assistant prose')
process.stderr.write(`[harness] history replay: ${replayText.trim().length} chars of assistant prose\n`)

// ---------- 4c. Cleanup: archive the probe session (the sweep's end state) ----------
// SID was pinned in 4b (the id diff already asserted exactly one new
// session); archive it directly.
await rpc('workspace.archiveSession', { sessionId: SID })
const archived = (await rpc('workspace.list', {})).archivedSessionIds ?? []
if (!archived.includes(SID)) fail('probe session not archived', archived)
process.stderr.write(`[harness] cleanup: ${SID} archived\n`)

const out = {
  status: sendReady() ? 'ready' : 'not-ready',
  sessionRows: rows.length,
  probe: { api: probeData.api?.status, root: probeData.root?.status, fenced: probeData.fenced?.status, persisted: true },
  picker: {
    rows: fullKeys.length,
    pinned: expectedPinKeys,
    search: { query, matched: searchExpected.length },
    switch: { to: pickName, fromPinned: pickFromPin, restored: !!restoreRow },
  },
  marker: MARKER,
  session: { id: SID, archived: true },
  rendered: {
    logChars: logText.length,
    userBubbles,
    assistantBubbles,
    title: titleText,
    userTextRendered: renderedUser,
    assistantProseChars: renderedProse.length,
    historyReplayChars: replayText.trim().length,
  },
  maxPipeFrameBytes: maxFrame,
  under1MiB: maxFrame < 1024 * 1024,
}
console.log(JSON.stringify(out, null, 1))
if (!renderedUser || !renderedProse) fail(`conversation not visibly rendered (logChars=${logText.length}, userTextRendered=${renderedUser}, proseChars=${renderedProse.length})`)
console.error('RENDER: OK — a DSH conversation is visible in the (headless) Augmentor panel')
try { pipe.kill() } catch {}
process.exit(0)
