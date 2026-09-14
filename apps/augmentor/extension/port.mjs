// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

/**
 * Augmentor — the native messaging port to the pipe (extension/port.mjs).
 *
 * F1 (audit): extracted from the sw.js monolith. Owns the port lifecycle
 * (connect / handshake / backoff reconnect), the request/response table,
 * the server→client browser/execute dispatch, and session event routing.
 * An open port keeps the SW alive, so the side panel may close while the
 * agent works.
 *
 * F5 (audit): the pending table is the canonical Pending class from
 * wire.mjs (see state.mjs) — request() adds with a 20 s timeout, fail()
 * drops everything with the disconnect error, and the reply path settles
 * by id. The wire vocabulary is the shared one (see wire.mjs header).
 */
import {
  state,
  log,
  broadcast,
  loadStoredSelection,
  saveSelection,
  loadStoredSessionId,
  saveSessionId,
  clearStoredSessionId,
  HOST,
} from './state.mjs'
import { encode as wireEncode, genId } from './wire.mjs'
import { handleBrowserAction } from './actions.mjs'
import { overlayShow } from './overlay.mjs'

function summarize(obj) {
  try {
    const s = JSON.stringify(obj)
    return s.length > 400 ? s.slice(0, 400) + '…' : obj
  } catch {
    return String(obj)
  }
}
function summarizeParams(p) {
  if (!p) return p
  if (Array.isArray(p)) return `[${p.length} blocks]`
  return p
}

// F5: client-request ids from the canonical factory (same `c1, c2, …`
// sequence the old state.reqSeq counter produced).
const nextClientId = genId('c')
let heartbeatTimer = null

// Does the DSH session exist on the server? session.history is the cheapest
// probe: an unknown session answers `session "<id>" not found`, a network
// failure rejects before any answer. true = exists, false = gone, null =
// could not tell (proceed and let the next call surface it).
export async function sessionHistoryOk(sessionId) {
  try {
    const res = await request('session.history', { sessionId, maxMessages: 1 })
    return res !== undefined && Array.isArray(res.events)
  } catch (e) {
    return /not found/i.test(String(e?.message ?? e)) ? false : null
  }
}

export function ensurePort() {
  if (state.port || state.phase === 'connecting') return
  state.phase = 'connecting'
  state.error = null
  broadcast(log('port', { event: 'connect', host: HOST }))
  let port
  try {
    port = chrome.runtime.connectNative(HOST)
  } catch (e) {
    fail(String(e))
    return
  }
  state.port = port
  clearInterval(heartbeatTimer)
  heartbeatTimer = setInterval(() => {
    if (state.port !== port) return
    try { port.postMessage({ method: 'augmentor/heartbeat' }) } catch { fail('native host heartbeat failed') }
  }, 15000)

  port.onMessage.addListener((msg) => {
    if (state.port !== port) return // ignore a superseded connection
    // Request/response for the client requests we sent (initialize, prompt).
    if (msg.id !== undefined && msg.method === undefined) {
      log('wire', { dir: 'ext<-bridge', msg: summarize(msg) })
      // F5: settle through the canonical pending table (unknown ids are a
      // no-op there, which matches the old delete-without-waiter path).
      const ok = state.pending.settle(
        msg.id,
        msg.error ? undefined : msg.result,
        msg.error ? new Error(msg.error.message ?? JSON.stringify(msg.error)) : undefined,
      )
      if (!ok && !msg.error) log('wire', { dir: 'ext<-bridge', msg: summarize(msg), note: 'stale-reply' })
      return
    }
    // Server->client request: a browser action from the runtime.
    if (msg.id !== undefined && msg.method === 'browser/execute') {
      log('wire', { dir: 'bridge->ext', msg: { id: msg.id, method: msg.method, params: msg.params } })
      handleBrowserAction(msg.id, msg.params).then(
        (result) => {
          if (state.port !== port) return
          log('wire', { dir: 'ext->bridge', msg: { id: msg.id, result } })
          post({ id: msg.id, result })
        },
        (e) => {
          if (state.port !== port) return
          log('wire', { dir: 'ext->bridge', msg: { id: msg.id, error: String(e) } })
          post({ id: msg.id, error: { message: String(e?.message ?? e) } })
        },
      )
      return
    }
    // Notifications: session.event / session.status / subagent.*
    if (msg.method === 'session.event') {
      onSessionEvent(msg.params)
      return
    }
    if (msg.method === 'session.status') {
      if (msg.params?.sessionId !== state.sessionId) return
      state.running = msg.params?.status === 'running'
      broadcast(log('status', { sessionId: msg.params?.sessionId, status: msg.params?.status }))
      return
    }
    log('wire', { dir: 'ext<-bridge', msg: summarize(msg) })
    log('wire', { dir: 'ext<-bridge', msg: summarize(msg), note: 'unhandled' })
  })

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message
    if (state.port !== port) return
    log('port', { event: 'disconnect', error: err ?? null })
    fail(err ?? 'native host disconnected')
  })

  // Handshake: the bridge serves the model catalog before the runtime is
  // needed, so fetch it first, pick the model (the remembered selection when
  // it is still in the catalog, else the catalog's default — the DSH app's
  // first-configured model), and only then initialize the runtime with it.
  ;(async () => {
    const stored = await loadStoredSelection()
    try {
      const catalog = await request('augmentor/models')
      const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
      const inCatalog = (sel) =>
        sel !== null &&
        groups.some((g) => g.provider === sel.provider && g.models.some((m) => m.model === sel.model))
      const sel = inCatalog(stored) ? stored : catalog?.default
      if (!sel || !groups.length) {
        throw new Error(catalog?.error ?? 'no models available (check $DSH_HOME/settings.yaml)')
      }
      state.catalog = groups
      // The DSH picker's curation rides the same bridge result (empty lists
      // when the settings namespace is absent — the picker then shows no
      // Pinned section).
      state.catalogCuration = {
        pinned: Array.isArray(catalog?.pinned) ? catalog.pinned : [],
        hidden: Array.isArray(catalog?.hidden) ? catalog.hidden : [],
      }
      state.selection = sel
      saveSelection(sel)
      const result = await request('initialize', {
        cwd: 'chrome-extension://augmentor',
        provider: sel.provider,
        model: sel.model,
      })
      state.homeDir = result?.serverInfo?.home ?? null
      // M3: the plugin's chat-lifecycle state rides in serverInfo.augmentor;
      // the pipe's endpoint (serverInfo.endpoint) feeds Open-in-DSH.
      state.chatCwd = result?.serverInfo?.augmentor?.chatCwd ?? null
      state.agentPreset = result?.serverInfo?.augmentor?.agentPreset ?? null
      state.endpoint = result?.serverInfo?.endpoint ?? null
      state.saved = new Set(result?.serverInfo?.augmentor?.saved ?? [])
      // M2: resume the conversation across the SW restart — if the DSH
      // session we stored still exists on the server, replay its events into
      // the log so a fresh panel re-renders the chat on load; if it is gone,
      // forget it (the next prompt creates a new session).
      const remembered = await loadStoredSessionId()
      if (remembered) {
        const exists = await sessionHistoryOk(remembered)
        if (exists === true) {
          state.sessionId = remembered
          saveSessionId(remembered)
          state.sessionReady = true
          const full = await request('session.history', { sessionId: remembered, maxMessages: 500 })
          for (const h of full?.events ?? []) log('event', { sessionId: remembered, event: h.event })
          broadcast(log('handshake', { event: 'session-resumed', sessionId: remembered, events: full?.events?.length ?? 0 }))
        } else if (exists === false) {
          clearStoredSessionId()
        } else {
          // Unreachable at boot: keep the remembered id as the candidate —
          // the first prompt re-verifies it before creating anything.
          state.sessionId = remembered
        }
      }
      if (state.port !== port) return
      state.retryCount = 0
      state.phase = 'ready'
      broadcast(log('handshake', { serverInfo: result.serverInfo, provider: sel.provider, model: sel.model }))
    } catch (e) {
      if (state.port === port) fail(`initialize failed: ${e.message}`)
    }
  })()
}

// Drop to the error state. There is NO Connect button for the user to press —
// the panel shows "reconnecting…" and a backoff retry below re-runs the whole
// handshake (fresh port, fresh selection check) until the server is back.
let reconnectTimer = null

function scheduleReconnect(message) {
  if (reconnectTimer) return // a retry is already armed
  state.retryCount += 1
  // 1s, 2s, 4s, 8s, 16s, then 30s steady — a dead DSH must not spin the
  // native host, but a recovered one must be picked up without user action.
  const delay = Math.min(30000, 1000 * 2 ** Math.min(state.retryCount - 1, 4))
  state.error = `${message} — retrying in ${delay / 1000}s`
  broadcast()
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    ensurePort()
  }, delay)
}

export function fail(message) {
  state.phase = 'error'
  state.error = message
  const oldPort = state.port
  state.port = null
  clearInterval(heartbeatTimer)
  heartbeatTimer = null
  try { oldPort?.disconnect() } catch { /* already disconnected */ }
  // F5: one drop for every in-flight request (the old code rejected each
  // waiter with its own Error; same observable effect).
  state.pending.dropAll(new Error(message))
  broadcast()
  scheduleReconnect(message)
}

export function post(msg) {
  try {
    // F5: frames leave through the shared wire codec (pipe + plugin speak
    // the same dialect; wireEncode is JSON here, but the codec is the seam).
    state.port?.postMessage(JSON.parse(wireEncode(msg)))
  } catch (e) {
    log('port', { event: 'post-failed', error: String(e) })
  }
}

export function request(method, params) {
  if (!state.port) return Promise.reject(new Error('not connected'))
  const id = nextClientId()
  log('wire', { dir: 'ext->bridge', msg: { id, method, params: summarizeParams(params) } })
  post({ id, method, params })
  // 0.1.18: 20s, not 60s — a lost response (dead port, dropped frame)
  // should fail the UI fast enough that the panel's retry can recover it.
  // F5: the timeout now lives in the canonical Pending table.
  return state.pending.add(id, { timeoutMs: 20000 })
}

// 0.1.18: self-heal for user-initiated reads. The old path returned a stale
// state.error the moment phase !== 'ready' — and the armed backoff retry could
// be up to 30s away, or lost entirely to an SW idle-kill (which drops
// setTimeout). A click that finds the SW not-ready now FORCES a fresh attempt
// immediately (reset the backoff, clear any armed timer, fresh connectNative)
// and waits briefly for the handshake, so the user's click lands on a live
// port instead of a stale "native messaging host" error string. Returns true
// when phase is 'ready' on return; false means "still not ready" (the caller
// reports state.error, and the normal backoff continues in the background).
export async function requireReady(timeoutMs = 3500) {
  if (state.phase === 'ready') return true
  if (state.phase !== 'connecting') {
    // 'error' or 'initial': force a fresh attempt NOW, bypassing the backoff.
    state.retryCount = 0
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    state.error = null
    ensurePort()
  }
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (state.phase === 'ready') return true
    if (state.phase === 'error') break // fail() re-armed the background backoff
    await new Promise((r) => setTimeout(r, 150))
  }
  return state.phase === 'ready'
}

// One session.event from the runtime. Only the current session is surfaced:
// after "new chat" the runtime may still stream tail events for the
// previous session.
export function onSessionEvent(params) {
  if (state.panelViewSession && params?.sessionId === state.panelViewSession && state.panelViewSession !== state.sessionId) {
    broadcast({ type: 'evt', entry: { kind: 'event', sessionId: params.sessionId, event: params.event } })
    return
  }
  if (params?.sessionId !== state.sessionId) return
  const ev = params?.event
  // 0.1.24: a new user turn has started — from ANY source (panel, DSH app
  // UI, CLI), not just the panel's prompt handler: re-resolve the work tab
  // to the tab the user is looking at right now (the browser-actions
  // docstring above is the contract: re-resolve at every turn start, sticky
  // within the turn). Mid-turn this never fires: a new turn only starts
  // after the previous one ends.
  if (ev?.type === 'turn/start') {
    state.workTabId = null
  }
  // Turn ended: the agent gives back control — "Done", then fade. But only
  // if the veil is actually up: it follows real browser use, so a text-only
  // turn (no browser action) never showed it and must not get a phantom
  // "Done ✓" on the user's tab.
  if (ev?.type === 'turn/end') {
    state.turnActive = false
    if (state.overlayVisible) {
      // A user Stop aborts the turn — label it as such, not "Done".
      const reason = ev?.data?.reason
      const stopped = reason?.kind === 'aborted' && reason?.reason?.kind === 'user'
      overlayShow(state.overlayTabId, stopped ? 'Stopped' : 'Done ✓', true)
    }
  }
  // Full envelope: the panel renders from it and the seq is its dedupe key.
  broadcast(log('event', { sessionId: params?.sessionId, event: ev }))
}
