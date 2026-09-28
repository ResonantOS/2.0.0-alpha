#!/usr/bin/env node

// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

// M1 E2E pre-flight (headless): run the REAL extension service worker (sw.js,
// via vm) against the REAL pipe (spawned exactly as Chrome does: host-manifest
// path + origin argv + 4-byte-LE stdio frames), driving the panel's M1 message
// flow: connect -> session/list -> session/history -> fence/probe.
//
// Not emulated: sw.js, pipe.mjs, DSH /api, the live server, the real token.
// Emulated: the chrome.* shim (connectNative bridged to the spawned pipe) and
// Chrome's fetch metadata — Node fetch carries no Origin/sec-fetch-site, so the
// fence probe's 'fenced' row here will NOT 403 (it reaches the RPC bridge:
// 415/200-ish); the 403-fence verdict is established by the header-exact
// headless probe (trace/fence-probe-headless.json) and by the real Chrome SW
// (which attaches the browser markers).
//
// Run: node test/sw-e2e.mjs
// Env: NMH_MANIFEST (host manifest path; default
//      ~/.config/chromium/NativeMessagingHosts/com.deepseek.dsh.augmentor.json),
//      TARGET_SESSION (session id for the history step; default: first listed),
//      DSH_BASE_URL (inherited by the pipe; default http://127.0.0.1:3080).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const AUG = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const EXT = path.join(AUG, 'extension')
const MANIFEST =
  process.env.NMH_MANIFEST ??
  path.join(os.homedir(), '.config/chromium/NativeMessagingHosts/com.deepseek.dsh.augmentor.json')
const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
const EXT_ID = m.allowed_origins?.[0]?.match(/chrome-extension:\/\/([^/]+)/)?.[1]
if (!EXT_ID) {
  console.error('E2E FAIL: cannot derive extension id from', MANIFEST)
  process.exit(1)
}
const fail = (msg) => { console.error('E2E FAIL:', msg); process.exit(1) }

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

// ---------- chrome shim ----------
const storage = new Map()
const fakePort = {
  onMessage: { addListener: (fn) => portListeners.onMessage.push(fn) },
  onDisconnect: { addListener: (fn) => portListeners.onDisconnect.push(fn) },
  postMessage: (o) => pipeSend(o),
  disconnect: () => { try { pipe.kill() } catch {} },
}
const runtimeListeners = []
const chrome = {
  runtime: {
    id: EXT_ID,
    lastError: undefined,
    connectNative: (host) => { process.stderr.write(`[shim] connectNative(${host})\n`); return fakePort },
    onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
    sendMessage: () => Promise.resolve(),
  },
  sidePanel: { setPanelBehavior: () => {}, setOptions: () => {} },
  storage: {
    local: {
      get: (_keys, cb) => cb({}),
      set: (obj, cb) => { for (const [k, v] of Object.entries(obj)) storage.set(k, v); cb && cb() },
    },
    onChanged: { addListener: () => {} },
  },
  tabs: {
    query: (_q, cb) => cb([]),
    get: (_id, cb) => cb(undefined),
    create: (_p, cb) => cb({ id: 999 }),
    update: (id, _p, cb) => cb && cb({ id }),
    onActivated: { addListener: () => {} },
    onRemoved: { addListener: () => {} },
    onUpdated: { addListener: () => {}, removeListener: () => {} },
    Tab: {},
  },
  windows: { getLastFocused: (_w, cb) => cb({ id: 1 }) },
  scripting: { executeScript: (_i, cb) => cb && cb([]) },
}

// ---------- SW context (F1: sw.js is now a MODULE entry) ----------
// The old harness ran the classic sw.js in a vm sandbox; a module service
// worker (manifest "type": "module") has static imports, which
// vm.runInContext cannot execute. Node's own ESM loader plays Chrome's
// module-SW role: define the chrome shim + the SW-only globals, then
// dynamic-import sw.js — one module instance, exactly like Chrome
// evaluates the import graph once on SW boot.
// F5: before that, assert the extension's wire.mjs is the BYTE-IDENTICAL
// copy of the repo-root file (the sw-e2e boot check the split relies on —
// the three runtimes must speak the same dialect).
if (!fs.readFileSync(path.join(EXT, 'wire.mjs')).equals(fs.readFileSync(path.join(AUG, 'wire.mjs')))) {
  fail('extension/wire.mjs diverged from the repo-root wire.mjs (copy the root file, never edit the copy)')
}
globalThis.chrome = chrome
globalThis.self = { location: { origin: `chrome-extension://${EXT_ID}` } }
await import(pathToFileURL(path.join(EXT, 'sw.js')).href)
process.stderr.write(`[harness] sw.js loaded; runtime listeners: ${runtimeListeners.length}\n`)
if (runtimeListeners.length === 0) fail('no runtime.onMessage listener registered by sw.js')
const swHandler = runtimeListeners[runtimeListeners.length - 1]

// Drive the panel: send(msg) -> response (async sendResponse supported).
// The sender mirrors what real Chrome passes for the extension's OWN pages
// (id + chrome-extension:// url) — sw.js now validates the sender (audit S5),
// so the shim must be Chrome-faithful or every message is (correctly) dropped.
const panelSender = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/sidepanel.html`, tab: { id: 1 } }
function send(msg) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    const ok = swHandler(msg, panelSender, done)
    if (ok === true) setTimeout(() => done(undefined), 30000)
    else done(undefined)
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- M1 flow ----------
// 1. connect (handshake: augmentor/models -> initialize)
let r = await send({ type: 'connect' })
process.stderr.write(`[harness] connect -> phase=${r?.phase}\n`)
let phase = null
for (let i = 0; i < 40; i++) {
  await sleep(500)
  const log = await send({ type: 'log', sinceSeq: -1 })
  phase = log?.phase
  if (phase === 'ready' || phase === 'error') break
}
process.stderr.write(`[harness] phase after handshake: ${phase}\n`)
if (phase !== 'ready') fail(`handshake did not reach ready (phase=${phase})`)

// 2. session/list
r = await send({ type: 'session/list' })
if (!r?.ok) fail('session/list failed: ' + JSON.stringify(r))
const items = r.items
process.stderr.write(`[harness] session/list ok: ${items.length} sessions\n`)
const target =
  process.env.TARGET_SESSION
    ? items.find((s) => s.sessionId === process.env.TARGET_SESSION)
    : items[0]
if (!target) fail('target session not listed')

// 3. session/history (the 1 MiB-critical frame)
r = await send({ type: 'session/history', sessionId: target.sessionId })
if (!r?.ok) fail('session/history failed: ' + JSON.stringify(r).slice(0, 300))
const histCount = r.events.length
const types = {}
for (const h of r.events) { const t = h.event?.type ?? '??'; types[t] = (types[t] ?? 0) + 1 }
const hasChunk = (types['assistant/chunk'] ?? 0) > 0
const hasFinal = (types['assistant/message'] ?? 0) > 0
const hasUser = (types['user/message'] ?? 0) > 0
process.stderr.write(
  `[harness] session/history ok: ${histCount} events, hasChunk=${hasChunk} hasFinalMsg=${hasFinal} hasUser=${hasUser}\n`,
)
if (hasChunk) fail('assistant/chunk present in shaped history (shaping broken)')
if (!hasFinal) fail('no assistant/message events — conversation would render empty')
if (maxFrame >= 1024 * 1024) fail(`a pipe->ext frame hit ${maxFrame} bytes (>= 1 MiB wire limit)`)

// 4. fence/probe (SW plumbing + persistence; 403 semantics verified separately)
r = await send({ type: 'fence/probe' })
if (!r?.ok) fail('fence/probe failed: ' + JSON.stringify(r).slice(0, 300))
const p = r.probe
process.stderr.write(
  `[harness] fence/probe ok: api=${p.api?.status} root=${p.root?.status} fenced=${p.fenced?.status} ` +
    '(node-fetch carries no Origin marker; Chrome does -> 403 per headless probe)\n',
)
const probeFile = path.join(AUG, 'trace/fence-probe.json')
const persisted = fs.existsSync(probeFile)
process.stderr.write(`[harness] fence-probe.json persisted by pipe: ${persisted}\n`)

console.log(JSON.stringify({
  phase,
  sessions: items.length,
  target: target.sessionId,
  historyEvents: histCount,
  maxPipeFrameBytes: maxFrame,
  under1MiB: maxFrame < 1024 * 1024,
  chunksStripped: !hasChunk,
  finalMessages: hasFinal,
  userMessages: hasUser,
  probe: { api: p.api?.status, root: p.root?.status, fenced: p.fenced?.status },
  probePersisted: persisted,
}, null, 1))
console.error('E2E: OK')
try { pipe.kill() } catch {}
process.exit(0)
