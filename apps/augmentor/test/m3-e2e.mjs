// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

// M3 slice-1 acceptance in REAL Chrome (headless=new, CDP-driven): the panel's
// Save button works end to end against the LIVE DSH server and the real
// registry — the boot test proves the wire on a fresh copy; this proves the
// panel + SW + pipe chain on the user's actual deployment.
//
// Fresh user-data-dir (the user's browser is never touched) + --load-extension
// (same extension dir) + host manifest + the sidepanel.html page. The
// extension spawns its own NMH pipe (the plugin admits many pipes).
//
// Flow: connect -> assert the M3 buttons exist -> send one prompt (the live
// default model is the local Qwen — no CloudFront) -> identify the new
// ~/Augmentor session -> tap #save (badge flips, workspace.list shows the
// attach) -> tap again (badge clears, detach) -> #openindsh (new target at
// the app endpoint) -> cleanup: archive the probe session (the 14-day sweep's
// end state, immediate).
//
// Repo home: augmentor/test/m3-e2e.mjs (uses plugin/node_modules/ws).
// Env: E2E_PORT (default 9226), E2E_PROFILE (default /tmp/chrome-m3-profile),
//      DSH_BASE (default http://127.0.0.1:3080), M3_PROMPT.
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

const PORT = Number(process.env.E2E_PORT ?? 9226)
const PROFILE = process.env.E2E_PROFILE ?? '/tmp/chrome-m3-profile'
const BASE = process.env.DSH_BASE ?? 'http://127.0.0.1:3080'
const CHATDIR = path.join(os.homedir(), 'Augmentor')
const PROMPT = process.env.M3_PROMPT ?? 'Reply with exactly one line: M3 OK'
const MARKER = 'M3 OK'
const fail = (m) => { console.error('M3-E2E FAIL:', m); try { chromium?.kill() } catch {} ; process.exit(1) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- DSH /api client (same envelope the pipe uses) ----------
const rpc = (method, payload) =>
  fetch(`${BASE}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `m3e2e-${Math.random().toString(36).slice(2)}`, method, payload }),
  }).then((r) => r.json()).then((b) => {
    if (!b?.result?.ok) throw new Error(method + ': ' + JSON.stringify(b?.result?.error ?? b))
    return b.result.value
  })

// ---------- fresh profile + host manifest ----------
fs.rmSync(PROFILE, { recursive: true, force: true })
const nmh = path.join(PROFILE, 'NativeMessagingHosts')
fs.mkdirSync(nmh, { recursive: true })
fs.copyFileSync(
  path.join(os.homedir(), '.config/chromium/NativeMessagingHosts/com.deepseek.dsh.augmentor.json'),
  path.join(nmh, 'com.deepseek.dsh.augmentor.json'),
)

// ---------- launch real Chromium ----------
const logs = fs.openSync('/tmp/chrome-m3.log', 'w')
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
process.stderr.write(`[m3] chromium pid ${chromium.pid}\n`)

const jfetch = async (p, opts) => (await fetch(`http://127.0.0.1:${PORT}${p}`, opts)).json()
let ver = null
for (let i = 0; i < 60; i++) { await sleep(500); try { ver = await jfetch('/json/version'); break } catch {} }
if (!ver) fail('CDP endpoint never came up')
process.stderr.write(`[m3] CDP: ${ver.Browser}\n`)

const m = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/chromium/NativeMessagingHosts/com.deepseek.dsh.augmentor.json'), 'utf8'))
const EXT_ID = m.allowed_origins[0].match(/chrome-extension:\/\/([^/]+)/)[1]

// ---------- browser WS: sidepanel target ----------
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
process.stderr.write(`[m3] page target: ${page.url}\n`)

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
process.stderr.write('[m3] sidepanel DOM ready\n')

// ---------- 1. Auto-connect (real SW + NMH pipe + live server) ----------
// There is no Connect button: the SW connects on boot (top-level ensurePort)
// and retries on a backoff after any failure. The page load's first message
// wakes the SW, so ready must arrive unaided. 0.1.17: the header's
// "connected" text is gone — readiness is the send button's enabled state.
let ready = false
for (let i = 0; i < 60; i++) {
  await sleep(500)
  ready = await ev('!document.getElementById("send").disabled').catch(() => false)
  if (ready) break
}
if (!ready) fail('never connected (send stayed disabled)')
process.stderr.write('[m3] connected (real SW + pipe + live server)\n')

// ---------- 2. The M3 buttons exist (new panel shipped) ----------
if (!await ev('!!document.getElementById("save")')) fail('#save button missing — stale panel?')
if (!await ev('!!document.getElementById("openindsh")')) fail('#openindsh button missing — stale panel?')
process.stderr.write('[m3] M3 buttons present (#save, #openindsh)\n')

// ---------- 3. Snapshot ~/Augmentor sessions, then send one prompt ----------
const augmSessions = () =>
  rpc('session.list', {}).then((v) => (v.items ?? []).filter((s) => s.cwd === CHATDIR).map((s) => s.sessionId))
const before = new Set(await augmSessions())
await ev(`(function(){ const i = document.getElementById('input'); i.value = ${JSON.stringify(PROMPT)}; document.getElementById('send').click(); return true })()`)
process.stderr.write(`[m3] prompt sent: ${JSON.stringify(PROMPT)}\n`)
let reply = null
for (let i = 0; i < 90; i++) {
  await sleep(2000)
  const t = (await ev('document.getElementById("log").textContent')) ?? ''
  if (t.includes(MARKER)) { reply = t; break }
}
if (!reply) fail('no assistant reply in real Chrome (agent broken?)')
// turn settled (Send visible again)
let settled = false
for (let i = 0; i < 30; i++) { await sleep(1000); if (await ev('!document.getElementById("send").hidden')) { settled = true; break } }
process.stderr.write(`[m3] reply rendered (${reply.length} chars, settled=${settled})\n`)

// ---------- 4. The SW created the session IN ~/Augmentor (cwd pinning) ----------
const after = new Set(await augmSessions())
const newIds = [...after].filter((id) => !before.has(id))
if (newIds.length !== 1) fail(`expected exactly one new ${CHATDIR} session, got ${JSON.stringify(newIds)} (before=${[...before]})`)
const SID = newIds[0]
process.stderr.write(`[m3] new session ${SID} in ${CHATDIR} (cwd pinning)\n`)

// ---------- 4b. The session runs on the Augmentor persona preset ----------
// The SW passes agentPreset from the plugin handshake; the header is what
// every prompt in this chat actually gets (the browser-control identity).
{
  const { zstdDecompressSync } = await import('node:zlib')
  const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions')
  let presetHeader = null
  for (const dir of fs.readdirSync(sessionsRoot)) {
    const f = path.join(sessionsRoot, dir, SID, 'session.jsonl.zstd')
    if (fs.existsSync(f)) { presetHeader = zstdDecompressSync(fs.readFileSync(f)).toString('utf8').split('\n')[0]; break }
  }
  if (!presetHeader || !presetHeader.includes('"agentPreset":"augmentor"')) fail(`session header lacks the Augmentor preset: ${presetHeader}`)
  process.stderr.write('[m3] session header carries agentPreset augmentor (persona wired)\n')
}

// ---------- 5. Tap #save -> badge + workspace attach ----------
// Icon-only badge: state = .saved class (the star FILLS) + tooltip.
const saveState = () => ev('(() => ({ cls: document.getElementById("save").className, title: document.getElementById("save").title }))()')
const isSaved = (s) => String(s?.cls).split(/\s+/).includes('saved')
if (isSaved(await saveState())) fail('badge should start unsaved', await saveState())
await ev('document.getElementById("save").click()')
let savedUi = null
for (let i = 0; i < 20; i++) { await sleep(500); savedUi = await saveState(); if (isSaved(savedUi)) break }
if (!isSaved(savedUi) || !String(savedUi?.title).includes('unsave')) fail('save badge did not flip', savedUi)
let row = ((await rpc('workspace.list', {})).items ?? []).find((w) => w.path === CHATDIR)
if (!row || row.title !== 'Augmentor Chat') fail('workspace row', row)
if (!(row.sessionIds ?? []).includes(SID)) fail('session not attached after panel Save', row)
process.stderr.write('[m3] SAVE: badge flipped + workspace.list shows the attach (real registry)\n')

// ---------- 6. Tap again -> unsave (detach, workspace survives) ----------
await ev('document.getElementById("save").click()')
let unsavedUi = null
for (let i = 0; i < 20; i++) { await sleep(500); unsavedUi = await saveState(); if (!isSaved(unsavedUi)) break }
if (isSaved(unsavedUi)) fail('unsave badge did not clear', unsavedUi)
row = ((await rpc('workspace.list', {})).items ?? []).find((w) => w.path === CHATDIR)
if (!row) fail('workspace vanished after unsave', row)
if ((row.sessionIds ?? []).includes(SID)) fail('session still attached after unsave', row)
process.stderr.write('[m3] UNSAVE: badge cleared + detach confirmed (workspace survives)\n')

// ---------- 6b. Click #sessions -> Browse renders the DSH session list ----------
// 0.1.20: the user's exact action that used to dead-end with "Error when
// communicating with the native messaging host." — assert real rows render
// and no error strip appears (this also exercises the panel's one-shot
// auto-retry if the SW is momentarily not ready).
await ev('document.getElementById("sessions").click()')
let browse = null
for (let i = 0; i < 24; i++) {
  await sleep(500)
  browse = await ev('(() => { const pop = document.getElementById("sessionspop"); if (pop.hidden) return null; const err = pop.querySelector(".sp-strip.err"); const strips = [...pop.querySelectorAll(".sp-strip:not(.err)")].map((s) => s.textContent); return { err: err ? err.textContent : null, rows: pop.querySelectorAll(".sp-row").length, footers: strips } })()')
  if (browse && browse.err === null && browse.rows > 0) break
  if (browse && browse.err) break
}
process.stderr.write(`[m3] BROWSE STATE: ${JSON.stringify(browse)}\n`)
// Direct SW round-trip (callback form exposes chrome.runtime.lastError):
// tells us whether the SW answers at all, and with what.
const direct = await ev('new Promise((res) => { try { chrome.runtime.sendMessage({ type: "session/list" }, (r) => { const e = chrome.runtime.lastError; res({ r, lastError: e ? e.message : null }) }) } catch (e) { res({ threw: e.message }) } })')
process.stderr.write(`[m3] DIRECT SW ROUND-TRIP: ${JSON.stringify(direct).slice(0, 600)}\n`)
if (!browse) fail('browse popover did not open')
if (browse.err) fail('browse surfaced an error strip (native host?)', browse)
if (browse.rows < 1) fail('browse rendered no rows', browse)
// 0.1.22 contract: the pipe caps the list at the latest 20 rows.
if (browse.rows > 20) fail('browse exceeded the 20-row cap', browse)
if (browse.footers.some((f) => /^Latest \d+ of \d+ sessions$/.test(f))) {
  process.stderr.write(`[m3] BROWSE: cap footer present (${browse.footers.join(' | ')})\n`)
}
process.stderr.write(`[m3] BROWSE: popover rendered ${browse.rows} session rows, no error strip\n`)
// 0.1.23: reopen the CURRENT session through the history path and assert the
// assistant's PROSE renders (the pipe strips assistant/chunk, so the final
// assistant/message must paint the text — the failure was "thinking + tool
// rows only, no output").
await ev('(() => { const r = document.querySelector("#sessionspop .sp-row"); if (r) r.click() })()')
let replayText = ''
for (let i = 0; i < 24; i++) {
  await sleep(500)
  replayText = await ev('[...document.querySelectorAll("#log .msg.assistant .md")].map((n) => n.textContent || "").join("\\n")')
  if (replayText.includes('M3 OK')) break
}
if (!replayText.includes('M3 OK')) fail('history replay rendered no assistant prose (thinking/tool rows only?)', { replayText: replayText.slice(0, 400) })
process.stderr.write(`[m3] BROWSE: history replay rendered assistant prose (${replayText.trim().length} chars incl. "M3 OK")\n`)
await ev('(() => { const pop = document.getElementById("sessionspop"); if (!pop.hidden) document.getElementById("sessions").click() })()') // close if still open

// ---------- 7. #openindsh -> new target at the app endpoint (Option A) ----------
const targetsBefore = new Set((await jfetch('/json')).map((t) => t.url))
await ev('document.getElementById("openindsh").click()')
let opened = null
for (let i = 0; i < 20; i++) {
  await sleep(500)
  opened = (await jfetch('/json')).find((t) => !targetsBefore.has(t.url) && t.url.startsWith(BASE.replace(/\/$/, '') + '/'))
  if (opened) break
}
if (!opened) fail('#openindsh did not open the app endpoint', [...targetsBefore])
process.stderr.write(`[m3] OPEN-IN-DSH: new target ${opened.url}\n`)

// ---------- 8. Cleanup: archive the probe (the sweep's end state) ----------
await rpc('workspace.archiveSession', { sessionId: SID })
const archived = (await rpc('workspace.list', {})).archivedSessionIds ?? []
if (!archived.includes(SID)) fail('probe not archived', archived)
process.stderr.write(`[m3] cleanup: ${SID} archived (end state = swept chat)\n`)

// ---------- 9. Brand link: the site, one click away ----------
const siteHref = await ev('(() => { const a = document.getElementById("site"); return a ? a.href : null })()')
if (siteHref !== 'https://augmentoragent.com/') fail('brand link missing or wrong href', siteHref)
process.stderr.write(`[m3] SITE: brand link ${siteHref}\n`)

// ---------- evidence ----------
console.log(JSON.stringify({
  status: 'connected',
  buttons: { save: (await saveState()).title, openindsh: await ev('!!document.getElementById("openindsh")') },
  site: await ev('(() => { const a = document.getElementById("site"); return a ? a.href : null })()') || null,
  prompt: { marker: MARKER, replyChars: reply.length, settled },
  session: { id: SID, cwd: CHATDIR },
  save: { badge: 'filled accent star (saved)', attachedInWorkspaceList: true },
  unsave: { badge: 'star outline (unsaved)', detachedInWorkspaceList: true },
  browse: { rows: browse.rows, error: browse.err ?? null },
  openInDsh: opened.url,
  cleanup: { archived: true },
}, null, 1))
console.error('M3-E2E: OK — panel Browse/Save/Unsave/Open-in-DSH works in real Chrome against the live deployment')
bws.close(); pws.close()
chromium.kill()
process.exit(0)
