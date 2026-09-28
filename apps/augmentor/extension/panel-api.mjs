// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

/**
 * Augmentor — the side panel's message API (extension/panel-api.mjs).
 *
 * F1 (audit): extracted from the sw.js monolith. Everything the panel
 * (sidepanel.js) can ask for: connect/status, prompt, stop, log, models
 * (+ models-refresh), model switch, newchat, save/unsave, session
 * list/history/view/rename, settings describe/mutate, the fence probe, and
 * shutdown. sw.js registers this as the runtime.onMessage listener.
 */
import {
  state,
  log,
  broadcast,
  saveSessionId,
  clearStoredSessionId,
  saveSelection,
} from './state.mjs'
import {
  ensurePort,
  request,
  requireReady,
  sessionHistoryOk,
} from './port.mjs'
import { overlayFade } from './overlay.mjs'

// The DSH picker's curation rides every catalog reply: the panel's picker
// shows the same Pinned top section as the DSH app (empty lists when the
// settings namespace is absent — no Pinned section, plain list).
const curationOf = (c) => ({
  pinned: Array.isArray(c?.pinned) ? c.pinned : [],
  hidden: Array.isArray(c?.hidden) ? c.hidden : [],
})

export function handlePanelMessage(msg, sender, sendResponse) {
  // S5 (audit): accept messages only from this extension's own pages.
  // chrome.runtime.onMessage is unreachable from other extensions or the
  // web, but the panel renders content from OTHER DSH sessions — a hostile
  // link rendered there (see the chat-render S4 sanitize) could otherwise
  // find a script context with sendMessage access. Defense in depth: verify
  // the sender is one of our own chrome-extension:// pages.
  if (!sender || sender.id !== chrome.runtime.id) return
  if (!sender.url || !sender.url.startsWith('chrome-extension://' + chrome.runtime.id)) return
  if (msg?.type === 'promptSettings') {
    const endpoint = state.endpoint || 'http://127.0.0.1:3080'
    chrome.tabs.create({url: endpoint.replace(/\/+$/, '') + '/'})
      .then(() => sendResponse({ok:true})).catch(error => sendResponse({ok:false,error:error.message}))
    return true
  }
  if (msg?.type === 'prompts') {
    ensurePort()
    request('augmentor/prompts', msg.request ?? {action:'list'})
      .then(sendResponse).catch(error=>sendResponse({ok:false,error:error.message}))
    return true
  }
  if (msg?.type === 'connect') {
    ensurePort()
    sendResponse({
      phase: state.phase,
      error: state.error,
      running: state.running,
      sessionId: state.sessionId,
      model: state.selection,
      models: state.catalog,
      ...curationOf(state.catalogCuration),
      // M3: chat-lifecycle state for the panel (Open-in-DSH + Save badge).
      endpoint: state.endpoint,
      chatCwd: state.chatCwd,
      saved: [...state.saved],
    })
    return
  }
  if (msg?.type === 'save' || msg?.type === 'unsave') {
    // M3: one-tap Save / Unsave. The pipe forwards to the plugin, which
    // attaches (or detaches) THIS chat's DSH session to the workspace over
    // the dedicated chat dir. The saved set is refreshed from the plugin
    // (authoritative) so the badge never lies.
    const saving = msg.type === 'save'
    if (state.phase !== 'ready' || !state.sessionReady) {
      sendResponse({ ok: false, error: saving ? 'this chat is not on the server yet — send a message first' : 'not connected' })
      return
    }
    ;(async () => {
      try {
        const res = await request(saving ? 'augmentor/save' : 'augmentor/unsave', { sessionId: state.sessionId })
        if (!res?.ok) throw new Error(res?.error ?? (saving ? 'save failed' : 'unsave failed'))
        try {
          const st = await request('augmentor/state', {})
          state.saved = new Set(st?.saved ?? [])
        } catch {
          // state refresh failed: fall back to the optimistic view
          if (saving) state.saved.add(state.sessionId)
          else state.saved.delete(state.sessionId)
        }
        sendResponse({ ok: true, saved: state.saved.has(state.sessionId), sessionId: state.sessionId, savedSet: [...state.saved] })
      } catch (e) {
        sendResponse({ ok: false, error: e.message })
      }
    })()
    return true // async
  }
  if (msg?.type === 'prompt') {
    // 0.1.24: new user turn → the agent acts on the tab the user is looking
    // at NOW. This clear existed in v0.1.8 ("Tab awareness") and was dropped
    // by the M1 refactor, so the agent kept operating on a stale tab after
    // the user switched. Safe to clear here: the handler rejects while a
    // turn is running, so mid-turn stickiness is never broken.
    state.workTabId = null
    // M2: the DSH app IS the runtime — our chat is a real DSH session,
    // created lazily on the first prompt (id = SESSION_ID, so live downlink
    // events route into this chat) and remembered in storage. The agent acts
    // on the tab the user is looking at NOW; mid-turn the work tab stays
    // sticky so a navigate → snapshot → click sequence never hops tabs under
    // the model's feet. The veil is NOT shown here: it appears when the
    // agent's FIRST browser action lands and is removed at turn end, so a
    // text-only turn never marks the user's tab "under AI control".
    if (state.phase !== 'ready') {
      sendResponse({ ok: false, error: state.error ?? `not ready (phase: ${state.phase})` })
      return
    }
    if (state.running) {
      sendResponse({ ok: false, error: 'finish the current turn before sending' })
      return
    }
    const text = String(msg.text ?? '').trim()
    if (!text) {
      sendResponse({ ok: false, error: 'empty prompt' })
      return
    }
    ;(async () => {
      try {
        if (!state.sessionReady) {
          // Verify the remembered session once per SW instance; on the first
          // prompt (or after a "new chat") create the real DSH session.
          const exists = await sessionHistoryOk(state.sessionId)
          if (exists !== true) {
            if (exists === false) clearStoredSessionId()
            state.sessionId = `augmentor-${crypto.randomUUID().slice(0, 8)}`
            saveSessionId(state.sessionId)
            // M3: create the session IN the plugin's dedicated chat dir —
            // workspace attachSession validates the header cwd against the
            // workspace path, so a chat is saveable only if it was created
            // here. Fall back to the app home when the plugin is not up.
            const cwd = state.chatCwd ?? state.homeDir
            await request('session.create', {
              sessionId: state.sessionId,
              ...(cwd ? { cwd } : {}),
              // The Augmentor persona (browser-control identity + the
              // browser_* tool contract); absent when the plugin did not
              // publish one, in which case the app default applies.
              ...(state.agentPreset ? { agentPreset: state.agentPreset } : {}),
            })
            broadcast(log('handshake', { event: 'session-created', sessionId: state.sessionId }))
          }
          state.sessionReady = true
          if (state.selection) {
            // A fresh session starts on the app's default model; point it at
            // the remembered selection before the first turn.
            try {
              await request('session.selectModel', {
                sessionId: state.sessionId,
                provider: state.selection.provider,
                model: state.selection.model,
              })
            } catch {
              /* the turn below surfaces a model error if it matters */
            }
          }
        }
        const res = await request('session.prompt', {
          sessionId: state.sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        })
        if (res?.accepted === true) {
          // The turn is live: the veil, once raised by the agent's FIRST
          // browser action, must HOLD across every step (the LLM thinks
          // between calls — 20–40 s — and the per-action idle fade would
          // flicker the effect off mid-task). Cleared on turn/end, which
          // also shows "Done ✓" and fades. Only set on a real accept: a
          // rejected prompt starts no turn and must not hold a veil.
          state.turnActive = true
        }
        sendResponse({ ok: true, accepted: res?.accepted === true, sessionId: state.sessionId })
      } catch (e) {
        sendResponse({ ok: false, error: e.message })
      }
    })()
    return true // async
  }
  if (msg?.type === 'stop') {
    // M2: abort the live turn (session.cancel). The turn settles with
    // turn/end (aborted) and the agent goes idle, so the panel's Stop swaps
    // back to Send and a new prompt resumes the same session.
    if (state.phase !== 'ready') {
      sendResponse({ ok: false, error: state.error ?? `not ready (phase: ${state.phase})` })
      return
    }
    if (!state.sessionReady) {
      sendResponse({ ok: true, accepted: false })
      return
    }
    request('session.cancel', { sessionId: state.sessionId })
      .then((res) => sendResponse({ ok: true, accepted: res?.accepted === true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }))
    return true // async
  }
  if (msg?.type === 'log') {
    // Full history by default (fresh panel load replays the whole chat); a
    // sinceSeq from a panel that already rendered up to that seq trims the
    // payload to genuinely new events, so the 2 s poll stays tiny.
    const since = Number.isFinite(msg.sinceSeq) ? msg.sinceSeq : -1
    const entries =
      since < 0 ? state.log : state.log.filter((e) => e.kind === 'event' && e.event?.seq > since)
    sendResponse({
      log: entries,
      phase: state.phase,
      error: state.error,
      running: state.running,
      model: state.selection,
      models: state.catalog,
      ...curationOf(state.catalogCuration),
      // M3: the 2 s poll keeps the panel's Save badge + Open-in-DSH button
      // current without any dedicated round trip.
      sessionId: state.sessionId,
      endpoint: state.endpoint,
      chatCwd: state.chatCwd,
      saved: [...state.saved],
    })
    return
  }
  if (msg?.type === 'models') {
    // The picker's catalog + selection. Answered from memory when the
    // handshake already fetched it; otherwise a fresh bridge call (the panel
    // may open before the handshake lands, and the bridge serves the catalog
    // before the runtime is up, so the call is safe in 'connecting' too).
    const respond = (groups, error, curation) =>
      sendResponse({ ok: groups !== null, groups, selection: state.selection, error: error ?? null, ...curationOf(curation) })
    if (state.catalog) return respond(state.catalog, null, state.catalogCuration)
    if (!state.port) {
      sendResponse({ ok: false, groups: null, selection: state.selection, error: state.error ?? `not ready (phase: ${state.phase})`, ...curationOf(state.catalogCuration) })
      return
    }
    request('augmentor/models')
      .then((catalog) => {
        state.catalog = Array.isArray(catalog?.groups) ? catalog.groups : []
        state.catalogCuration = curationOf(catalog)
        respond(state.catalog, catalog?.error ?? null, state.catalogCuration)
      })
      .catch((e) => sendResponse({ ok: false, groups: null, selection: state.selection, error: e.message, ...curationOf(state.catalogCuration) }))
    return true // async
  }
  if (msg?.type === 'models-refresh') {
    // The picker's Refresh button: always re-ask the bridge instead of
    // serving the handshake's memory copy — the user may have added models
    // to $DSH_HOME/settings.yaml since. The bridge reads the DSH app live on
    // every call (pipe.mjs 'augmentor/models'), so no restart is involved.
    // If the current selection fell out of the catalog, fall back to the
    // catalog default — the same rule the connect handshake applies.
    if (!state.port) {
      sendResponse({ ok: false, groups: null, selection: state.selection, error: state.error ?? `not ready (phase: ${state.phase})` })
      return
    }
    request('augmentor/models')
      .then((catalog) => {
        const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
        const inCatalog = (sel) =>
          !!sel &&
          groups.some((g) => g.provider === sel.provider && g.models.some((m) => m.model === sel.model))
        if (!inCatalog(state.selection) && catalog?.default) state.selection = { ...catalog.default }
        state.catalog = groups
        state.catalogCuration = curationOf(catalog)
        sendResponse({ ok: true, groups, selection: state.selection, error: catalog?.error ?? null, ...curationOf(state.catalogCuration) })
      })
      .catch((e) => sendResponse({ ok: false, groups: null, selection: state.selection, error: e.message, ...curationOf(state.catalogCuration) }))
    return true // async
  }
  if (msg?.type === 'model') {
    // Model switch (the panel's picker). M2: the DSH app IS the runtime, so
    // the switch lands on our live session (session.selectModel); while no
    // session exists yet it is remembered and applied at create (first
    // prompt). Switches only land while the turn is idle.
    if (state.phase !== 'ready') {
      sendResponse({ ok: false, error: state.error ?? `not ready (phase: ${state.phase})` })
      return
    }
    if (state.running) {
      sendResponse({ ok: false, error: 'finish the current turn before switching models' })
      return
    }
    const provider = msg.provider
    const model = msg.model
    const known =
      state.catalog?.some((g) => g.provider === provider && g.models.some((m) => m.model === model)) ?? false
    if (!known) {
      sendResponse({ ok: false, error: `unknown model: ${provider}/${model}` })
      return
    }
    if (state.selection && state.selection.provider === provider && state.selection.model === model) {
      sendResponse({ ok: true, changed: false, model: state.selection })
      return
    }
    const previous = state.selection
    state.selection = { provider, model }
    saveSelection(state.selection)
    const apply = state.sessionReady
      ? request('session.selectModel', { sessionId: state.sessionId, provider, model })
      : Promise.resolve({ selected: { provider, model } })
    apply
      .then(() => {
        broadcast(log('handshake', { event: 'model-switch', provider, model }))
        sendResponse({ ok: true, changed: true, model: state.selection })
      })
      .catch(async (e) => {
        // Best effort: point the runtime back at the previous selection so
        // the old conversation keeps working (a failed selectModel does not
        // kill the DSH app — no error state needed, just report it).
        if (previous && state.sessionReady) {
          try {
            await request('session.selectModel', {
              sessionId: state.sessionId,
              provider: previous.provider,
              model: previous.model,
            })
          } catch {
            /* the rollback failed too: the next turn surfaces it */
          }
        }
        state.selection = previous
        saveSelection(previous)
        broadcast(log('handshake', { event: 'model-switch-rolled-back', provider: previous?.provider, model: previous?.model }))
        sendResponse({ ok: false, error: e.message })
      })
    return true // async
  }
  if (msg?.type === 'newchat') {
    state.sessionId = `augmentor-${crypto.randomUUID().slice(0, 8)}`
    saveSessionId(state.sessionId)
    state.sessionReady = false // the stored id was never a DSH session (yet)
    state.panelViewSession = null
    state.running = false
    state.log = []
    state.wirelog = []
    // The old session's turn/end is now filtered out (new SESSION_ID), so a
    // veil left up by it would linger — take it down now.
    state.turnActive = false
    if (state.overlayVisible) overlayFade(state.overlayTabId)
    broadcast(log('newchat', { sessionId: state.sessionId }))
    sendResponse({ ok: true, sessionId: state.sessionId })
    return
  }
  if (msg?.type === 'shutdown') {
    request('shutdown', undefined)
      .then(() => {
        log('handshake', { event: 'shutdown-sent' })
      })
      .catch((e) => log('handshake', { event: 'shutdown-failed', error: e.message }))
    sendResponse({ ok: true })
    return
  }
  if (msg?.type === 'session/list') {
    // M1: the DSH app's own sessions, straight from the live app through the
    // pipe (POST /api/session.list). Rows carry no title in the base payload;
    // projections.values.title is present when the app named the session.
    // 0.1.18: not-ready no longer means "return the stale error" — the click
    // itself forces a reconnect (requireReady), so a stale SW self-heals
    // instead of surfacing "Error when communicating with the native
    // messaging host." from a previous generation.
    requireReady().then((ok) => {
      if (!ok) {
        sendResponse({ ok: false, error: state.error ?? `not ready (phase: ${state.phase})` })
        return
      }
      request('session.list', {})
        .then((res) => sendResponse({ ok: true, items: res?.items ?? [], total: res?.total }))
        .catch((e) => sendResponse({ ok: false, error: e.message }))
    })
    return true // async
  }
  if (msg?.type === 'session/history') {
    // M1: one DSH session's event history for the panel's live-event
    // renderer (the vocabularies match: user/message, assistant/message,
    // tool/call, …). The panel resets its seq baseline before applying.
    requireReady().then((ok) => {
      if (!ok) {
        sendResponse({ ok: false, error: state.error ?? `not ready (phase: ${state.phase})` })
        return
      }
      const sessionId = String(msg.sessionId ?? '')
      if (!sessionId) {
        sendResponse({ ok: false, error: 'missing sessionId' })
        return
      }
      request('session.history', { sessionId, maxMessages: 500 })
        .then((res) => sendResponse({ ok: true, events: res?.events ?? [], hasMore: res?.hasMore ?? false }))
        .catch((e) => sendResponse({ ok: false, error: e.message }))
    })
    return true // async
  }
  if (msg?.type === 'session/view') {
    // M1: arm/disarm the panel-view live tail (see onSessionEvent).
    state.panelViewSession = msg.sessionId ? String(msg.sessionId) : null
    sendResponse({ ok: true })
    return
  }
  if (msg?.type === 'session/rename') {
    // M3 (0.1.16): rename the live Augmentor chat (double-clicked header
    // title). DSH pins a user-set title — auto-titling never overwrites it —
    // and the host pushes the session/title event back through the pipe,
    // which chat-render re-asserts in the header.
    if (state.phase !== 'ready') {
      sendResponse({ ok: false, error: state.error ?? `not ready (phase: ${state.phase})` })
      return
    }
    const sessionId = String(msg.sessionId ?? '')
    const title = String(msg.title ?? '').trim()
    if (!sessionId || !title) {
      sendResponse({ ok: false, error: 'missing sessionId or title' })
      return
    }
    request('session.rename', { sessionId, title })
      .then((res) => sendResponse({ ok: true, sessionId: res?.sessionId ?? sessionId, title: res?.title ?? title }))
      .catch((e) => sendResponse({ ok: false, error: e.message }))
    return true // async
  }
  if (msg?.type === 'settings/describe') {
    // 0.1.17: the panel reads the permission preset (the "Full access" seat)
    // through the stock DSH settings API — same route the DSH GUI's own
    // settings row uses.
    requireReady().then((ok) => {
      if (!ok) {
        sendResponse({ ok: false, error: state.error ?? `not ready (phase: ${state.phase})` })
        return
      }
      request('settings.describe', msg.ns ? { ns: msg.ns } : {})
        .then((res) => sendResponse({ ok: true, value: res ?? null }))
        .catch((e) => sendResponse({ ok: false, error: e.message }))
    })
    return true // async
  }
  if (msg?.type === 'settings/mutate') {
    // 0.1.17: the user switches the permission preset (auto vs manual
    // approval). Applies to subsequently created sessions, per DSH's own
    // settings-store contract.
    requireReady().then((ok) => {
      if (!ok) {
        sendResponse({ ok: false, error: state.error ?? `not ready (phase: ${state.phase})` })
        return
      }
      const ns = String(msg.ns ?? '')
      const ops = Array.isArray(msg.ops) ? msg.ops : []
      if (!ns || ops.length === 0) {
        sendResponse({ ok: false, error: 'missing ns or ops' })
        return
      }
      request('settings.mutate', {
        ns,
        ops,
        ...(msg.expectedRevision !== undefined ? { expectedRevision: msg.expectedRevision } : {}),
      })
        .then((res) => sendResponse({ ok: true, value: res ?? null }))
        .catch((e) => sendResponse({ ok: false, error: e.message }))
    })
    return true // async
  }
  // ── 0.1.30 (Phase 1): the Updates popover ─────────────────────────────────
  // The panel owns the UI; the work splits pipe-side (updates/check,
  // updates/download — registry + GitHub + in-place extraction) and
  // plugin-side (augmentor/update-plugin + /update-status — the profile's
  // `dsh plugin add` spawn, fire-and-poll). The SW is a thin relay: it adds
  // the LOADED extension version (chrome.runtime manifest — the one actually
  // running in the browser, which can lag the files on disk after a
  // download) and nothing else.
  if (msg?.type === 'updates/check') {
    requireReady().then((ok) => {
      if (!ok) {
        sendResponse({ ok: false, error: state.error ?? `not ready (phase: ${state.phase})` })
        return
      }
      request('updates/check', { extension: chrome.runtime.getManifest().version })
        .then((res) => sendResponse({ ok: true, value: res ?? null }))
        .catch((e) => sendResponse({ ok: false, error: e.message }))
    })
    return true // async
  }
  if (msg?.type === 'updates/plugin') {
    // Fire-and-poll start: returns the initial job state immediately.
    requireReady().then((ok) => {
      if (!ok) {
        sendResponse({ ok: false, error: state.error ?? `not ready (phase: ${state.phase})` })
        return
      }
      const version = String(msg.version ?? '')
      if (!/^\d+\.\d+\.\d+$/.test(version)) {
        sendResponse({ ok: false, error: `invalid version: ${JSON.stringify(msg.version)}` })
        return
      }
      request('augmentor/update-plugin', { version })
        .then((res) => sendResponse({ ok: true, value: res ?? null }))
        .catch((e) => sendResponse({ ok: false, error: e.message }))
    })
    return true // async
  }
  if (msg?.type === 'updates/plugin-status') {
    requireReady().then((ok) => {
      if (!ok) {
        sendResponse({ ok: false, error: state.error ?? `not ready (phase: ${state.phase})` })
        return
      }
      request('augmentor/update-status', {})
        .then((res) => sendResponse({ ok: true, value: res ?? null }))
        .catch((e) => sendResponse({ ok: false, error: e.message }))
    })
    return true // async
  }
  if (msg?.type === 'updates/download') {
    // The pipe re-validates both the version and the exact canonical asset
    // URL (the panel may render hostile session content — the URL policy
    // stays pipe-side); this relay only checks the pair is present.
    requireReady().then((ok) => {
      if (!ok) {
        sendResponse({ ok: false, error: state.error ?? `not ready (phase: ${state.phase})` })
        return
      }
      const version = String(msg.version ?? '')
      const url = String(msg.url ?? '')
      if (!/^\d+\.\d+\.\d+$/.test(version) || !url.startsWith('https://github.com/')) {
        sendResponse({ ok: false, error: 'invalid update target' })
        return
      }
      request('updates/download', { version, url })
        .then((res) => sendResponse({ ok: true, value: res ?? null }))
        .catch((e) => sendResponse({ ok: false, error: e.message }))
    })
    return true // async
  }
  if (msg?.type === 'fence/probe') {
    // M1 evidence (C1): fetch from THIS origin (chrome-extension://…) — the
    // trust fence judges the request by Origin + sec-fetch-site metadata, so
    // a service-worker fetch is exactly what the fence sees. Three paths:
    // /api/augmentor (plugin exact route — expected 200, fence is
    // api-proxy-scoped and exact routes dispatch before the prefix table),
    // / (static control — network path), and a POST to a stock method route
    // (/api/session.list — expected 403 forbidden: the fence refusal this
    // probe exists to document). Results are persisted by the pipe to
    // trace/fence-probe.json.
    // F8 (audit): probe the endpoint the pipe actually reports (a
    // non-default DSH port would break the old hardcoded 3080 silently).
    const base = (state.endpoint || 'http://127.0.0.1:3080').replace(/\/+$/, '')
    Promise.all([
      fetch(`${base}/api/augmentor`).then(
        (r) => ({ route: '/api/augmentor', status: r.status }),
        (e) => ({ route: '/api/augmentor', status: `network: ${e.message}` }),
      ),
      fetch(`${base}/`).then(
        (r) => ({ route: '/', status: r.status }),
        (e) => ({ route: '/', status: `network: ${e.message}` }),
      ),
      fetch(`${base}/api/session.list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'augmentor-fence-probe', method: 'session.list', payload: {} }),
      }).then(
        (r) => ({ route: '/api/session.list', status: r.status }),
        (e) => ({ route: '/api/session.list', status: `network: ${e.message}` }),
      ),
    ])
      .then(async ([api, root, fenced]) => {
        const out = { at: new Date().toISOString(), origin: self.location.origin, api, root, fenced }
        try {
          await request('trace/fence-probe', out)
        } catch {
          /* persistence is best-effort; the panel still shows the result */
        }
        sendResponse({ ok: true, probe: out })
      })
      .catch((e) => sendResponse({ ok: false, error: e.message }))
    return true // async
  }
}
