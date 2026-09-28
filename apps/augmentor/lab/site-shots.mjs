#!/usr/bin/env node

// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

/**
 * Website screenshots (website/assets/shot-*.png) — real Chromium, real
 * extension, one REAL turn against the live DSH deployment.
 *
 * The marketing site's hero + "In action" images must show the UI the user
 * gets today, so this drives the actual side panel (not a mock):
 *   1. fresh profile + --load-extension + the host manifest (m3-e2e pattern;
 *      the user's browser is never touched),
 *   2. open the side panel + an https://augmentatism.com/ tab (the tab the
 *      user is "looking at" — it is activated),
 *   3. send one prompt: "Extract the most important points from
 *      https://augmentatism.com/",
 *   4. capture shot-veil.png  — mid-turn: the frost veil + status pill on
 *      the augmentatism.com tab,
 *   5. capture shot-panel.png — after the turn: the settled conversation
 *      (420x800, the site's .shot-panel aspect ratio),
 *   6. archive the probe session (sweep's end state).
 *
 * Run: node lab/site-shots.mjs
 * Env: SSHOTS_PORT (9227), SSHOTS_PROFILE (/tmp/chrome-shots-profile),
 *      DSH_BASE (http://127.0.0.1:3080).
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const AUG = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const EXT = path.join(AUG, 'extension')
const OUT = path.join(AUG, 'website', 'assets')
const WebSocket = require(path.join(AUG, 'plugin/node_modules/ws'))

const PORT = Number(process.env.SSHOTS_PORT ?? 9227)
const PROFILE = process.env.SSHOTS_PROFILE ?? '/tmp/chrome-shots-profile'
const BASE = process.env.DSH_BASE ?? 'http://127.0.0.1:3080'
const CHATDIR = path.join(os.homedir(), 'Augmentor')
// needle-in-the-haystack: 7 principles buried in a 3.5k-word manifesto —
// slow to find by hand, one snapshot for the agent; the "two sentences max"
// keeps prompt + answer on one 420x800 panel page.
const PROMPT = 'Count the principles of the Social Contract on this page. Which one is called the "ethical floor"? Two sentences max.'
const fail = (m) => { console.error('SHOTS FAIL:', m); try { chromium?.kill() } catch {} ; process.exit(1) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- DSH /api client (same envelope the pipe uses) ----------
const rpc = (method, payload) =>
  fetch(`${BASE}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `shots-${Math.random().toString(36).slice(2)}`, method, payload }),
  }).then((r) => r.json()).then((b) => {
    if (!b?.result?.ok) throw new Error(method + ': ' + JSON.stringify(b?.result?.error ?? b))
    return b.result.value
  })

// ---------- fresh profile + host manifest (never touch the user's) ----------
fs.rmSync(PROFILE, { recursive: true, force: true })
const nmh = path.join(PROFILE, 'NativeMessagingHosts')
fs.mkdirSync(nmh, { recursive: true })
fs.copyFileSync(
  path.join(os.homedir(), '.config/chromium/NativeMessagingHosts/com.deepseek.dsh.augmentor.json'),
  path.join(nmh, 'com.deepseek.dsh.augmentor.json'),
)

// ---------- launch real Chromium ----------
const logs = fs.openSync('/tmp/chrome-shots.log', 'w')
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
process.stderr.write(`[shots] chromium pid ${chromium.pid}\n`)

const jfetch = async (p, opts) => (await fetch(`http://127.0.0.1:${PORT}${p}`, opts)).json()
let ver = null
for (let i = 0; i < 60; i++) { await sleep(500); try { ver = await jfetch('/json/version'); break } catch {} }
if (!ver) fail('CDP endpoint never came up')
process.stderr.write(`[shots] CDP: ${ver.Browser}\n`)

const m = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/chromium/NativeMessagingHosts/com.deepseek.dsh.augmentor.json'), 'utf8'))
const EXT_ID = m.allowed_origins[0].match(/chrome-extension:\/\/([^/]+)/)[1]

// ---------- browser WS ----------
const bws = new WebSocket(ver.webSocketDebuggerUrl)
let bseq = 0
const bpend = new Map()
bws.on('message', (d) => { const r = JSON.parse(d); if (r.id && bpend.has(r.id)) { bpend.get(r.id)(r); bpend.delete(r.id) } })
const bcall = (method, params = {}) => new Promise((res, rej) => {
  const id = ++bseq; bpend.set(id, (r) => (r.error ? rej(new Error(method + ': ' + r.error.message)) : res(r.result)))
  bws.send(JSON.stringify({ id, method, params }))
})
await new Promise((res, rej) => { bws.once('open', res); bws.once('error', rej) })

// the user is looking at augmentatism.com; the panel is open alongside
await bcall('Target.createTarget', { url: 'https://augmentatism.com/' })
await bcall('Target.createTarget', { url: `chrome-extension://${EXT_ID}/sidepanel.html` })
let page = null, web = null
for (let i = 0; i < 30; i++) {
  await sleep(500)
  const list = await jfetch('/json')
  page = list.find((t) => t.type === 'page' && t.url.includes('sidepanel'))
  web = list.find((t) => t.type === 'page' && t.url.includes('augmentatism.com'))
  if (page && web) break
}
if (!page || !web) fail('sidepanel or augmentatism.com target not found')
await bcall('Target.activateTarget', { targetId: web.id }) // the work tab
process.stderr.write('[shots] targets: sidepanel + augmentatism.com (activated)\n')

// ---------- page WS helper ----------
const attach = async (t) => {
  const w = new WebSocket(t.webSocketDebuggerUrl)
  let seq = 0
  const pend = new Map()
  w.on('message', (d) => { const r = JSON.parse(d); if (r.id && pend.has(r.id)) { pend.get(r.id)(r); pend.delete(r.id) } })
  const call = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq; pend.set(id, (r) => (r.error ? rej(new Error(method + ': ' + r.error.message)) : res(r.result)))
    w.send(JSON.stringify({ id, method, params }))
  })
  await new Promise((res, rej) => { w.once('open', res); w.once('error', rej) })
  await call('Runtime.enable')
  await call('Page.enable')
  const ev = (expression) =>
    call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      .then((r) => {
        if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? '').slice(0, 300))
        return r.result?.value
      })
  const shot = async (file, wdt, hgt) => {
    await call('Emulation.setDeviceMetricsOverride', { width: wdt, height: hgt, deviceScaleFactor: 2, mobile: false })
    const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    fs.writeFileSync(path.join(OUT, file), Buffer.from(data, 'base64'))
    process.stderr.write(`[shots] wrote assets/${file} (${wdt}x${hgt} @2x)\n`)
  }
  return { w, call, ev, shot }
}

const P = await attach(page)   // side panel
const W = await attach(web)    // augmentatism.com (the tab the agent drives)

for (let i = 0; i < 40; i++) {
  const rs = await P.ev('document.readyState').catch(() => 'loading')
  if (rs === 'complete') break
  await sleep(500)
}
if (!await P.ev('!!document.getElementById("title")')) fail('sidepanel DOM not ready')

// ---------- 1. Auto-connect (real SW + NMH pipe + live server) ----------
let ready = false
for (let i = 0; i < 90; i++) {
  await sleep(500)
  ready = await P.ev('!document.getElementById("send").disabled').catch(() => false)
  if (ready) break
}
if (!ready) fail('never connected (send stayed disabled)')
process.stderr.write('[shots] connected (real SW + pipe + live server)\n')

// ---------- 2. Send the prompt ----------
const augmSessions = () =>
  rpc('session.list', {}).then((v) => (v.items ?? []).filter((s) => s.cwd === CHATDIR).map((s) => s.sessionId))
const before = new Set(await augmSessions())
await P.ev(`(function(){ const i = document.getElementById('input'); i.value = ${JSON.stringify(PROMPT)}; document.getElementById('send').click(); return true })()`)
process.stderr.write(`[shots] prompt sent: ${JSON.stringify(PROMPT)}\n`)

// ---------- 3. Veil shot: mid-turn, frost + pill on the driven tab ----------
let veil = false
for (let i = 0; i < 120; i++) {
  await sleep(500)
  veil = await W.ev(`!!(document.getElementById('__dshAugOverlay') && document.getElementById('__dshAugOverlay').querySelector('canvas'))`).catch(() => false)
  if (veil) break
}
if (!veil) fail('veil never appeared on the augmentatism.com tab')
await sleep(2500) // let the condense transition + pill settle
await W.shot('shot-veil.png', 1280, 800)
process.stderr.write('[shots] VEIL: captured mid-turn frost + status pill\n')

// ---------- 4. Panel shot: settled conversation ----------
// needle reply: should name the count (seven/7) AND "Anti-Capture" as the
// ethical floor, in ~two sentences.
let reply = ''
for (let i = 0; i < 180; i++) {
  await sleep(1000)
  reply = (await P.ev('[...document.querySelectorAll("#log .msg.assistant .md")].map((n) => n.textContent || "").join("\\n")').catch(() => '')) || ''
  if (/(seven|7\b)/i.test(reply) && /anti.?capture/i.test(reply) && reply.length >= 40) break
}
if (!/(seven|7\b)/i.test(reply) || !/anti.?capture/i.test(reply) || reply.length < 40) fail('assistant reply looks wrong', reply.slice(0, 300))
let settled = false
for (let i = 0; i < 60; i++) { await sleep(1000); if (await P.ev('!document.getElementById("send").hidden').catch(() => false)) { settled = true; break } }
await sleep(800) // last paint, caret settled
await P.shot('shot-panel.png', 420, 800)
process.stderr.write(`[shots] PANEL: captured settled chat (settled=${settled}, reply ${reply.length} chars)\n`)
process.stderr.write(`[shots] reply head: ${JSON.stringify(reply.slice(0, 400))}\n`)

// ---------- 5. Cleanup: archive the probe session ----------
const after = new Set(await augmSessions())
const newIds = [...after].filter((id) => !before.has(id))
if (newIds.length !== 1) fail(`expected exactly one new ${CHATDIR} session, got ${JSON.stringify(newIds)}`)
await rpc('workspace.archiveSession', { sessionId: newIds[0] })
const archived = (await rpc('workspace.list', {})).archivedSessionIds ?? []
if (!archived.includes(newIds[0])) fail('probe not archived', archived)
process.stderr.write(`[shots] cleanup: ${newIds[0]} archived\n`)

process.stderr.write('SHOTS: OK — website/assets/shot-veil.png + shot-panel.png are the real UI\n')
bws.close(); P.w.close(); W.w.close()
chromium.kill()
process.exit(0)
