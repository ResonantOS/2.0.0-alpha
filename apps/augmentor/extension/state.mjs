// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

/**
 * Augmentor — shared service-worker state (extension/state.mjs).
 *
 * F1 (audit): sw.js was a 1400-line monolith; the split keeps ONE mutable
 * state object in a module so every other module (port, worktab, overlay,
 * actions, panel-api) reads and writes the same instance — ESM modules are
 * singletons per SW instance, which is exactly the semantics the old
 * top-level lets had. No module may keep a private copy of any of these.
 *
 * F5 (audit): the pending request table is now the canonical Pending class
 * from wire.mjs (byte-identical in extension/wire.mjs; asserted by sw-e2e)
 * instead of an ad-hoc Map + setTimeout per request.
 */
import { Pending } from './wire.mjs'

export const HOST = 'com.deepseek.dsh.augmentor'

// The model the sidecar runs on: a {provider, model} pair from the DSH app's
// catalog (the bridge serves it from $DSH_HOME/settings.yaml, so the picker
// offers exactly what the DSH app offers). The choice is remembered in
// chrome.storage.local so an SW restart (idle expiry, browser restart)
// resumes the last selection.
export const MODEL_STORAGE_KEY = 'augmentor-model-selection'

// The SW's chat identity doubles as the DSH session id (M2): session.create
// accepts any non-empty id, so live downlink events (which carry the DSH
// session id) route straight into this chat's filter. The id is remembered in
// chrome.storage so an SW restart (idle expiry, browser restart) resumes the
// same conversation; "new chat" mints a fresh one.
export const SESSION_STORAGE_KEY = 'augmentor-session-id'

export const state = {
  phase: 'disconnected', // disconnected | connecting | ready | error
  error: null,
  retryCount: 0, // consecutive failed attempts (backoff ladder; reset on ready)
  running: false,
  port: null,
  // F5 (audit): canonical pending table (wire.mjs Pending). id -> promise;
  // timeouts and the disconnect dropAll go through it.
  pending: new Pending(),
  // The DSH app's model catalog (the bridge's `augmentor/models` result) and
  // the selected {provider, model} the runtime runs on (null until the first
  // handshake). The panel's picker renders from both.
  catalog: null,
  selection: null,
  // The DSH model picker's curation (the dsh-model-picker-augmented plugin's
  // settings section): pinned is the user's ordered "provider/model" key
  // list, hidden the keys the user hid in DSH. Rides with the catalog so the
  // panel's picker renders the same Pinned top section as the DSH app.
  catalogCuration: { pinned: [], hidden: [] },
  // The DSH app's home directory (host.describe) — the working directory for
  // the session we create on first prompt.
  homeDir: null,
  // M3 chat lifecycle (from the plugin's handshake, folded into initialize):
  // the dedicated chat directory every new session is created in (Save can
  // attach such a session to its workspace), the agent preset new sessions
  // are created with (the Augmentor persona), the running DSH app's base URL
  // (Open-in-DSH button), and the sessions already saved there (badge).
  chatCwd: null,
  agentPreset: null,
  endpoint: null,
  saved: new Set(),
  // Session entries the panel renders (events + port/prompt/handshake/status).
  // Big on purpose: a fresh panel load replays this as the whole chat, so it
  // must hold a full working session (~2 entries per streamed chunk).
  log: [],
  // Wire frames are diagnostics only (the bridge traces the full wire to
  // trace/); keep a small tail for SW-side debugging.
  wirelog: [],
  lastResponseAt: null,
  // ---- session identity (was top-level lets in sw.js; mutated by the port
  // handshake and the panel message handlers, hence in shared state) ----
  sessionId: `augmentor-${crypto.randomUUID().slice(0, 8)}`,
  // Our DSH session exists on the server (verified on reconnect; set after
  // session.create).
  sessionReady: false,
  // The DSH session the panel is currently viewing (M1): its events stream
  // to the panel as direct pushes and NEVER enter state.log.
  panelViewSession: null,
  // ---- work tab + veil/turn flags (was top-level lets; see the modules
  // that own each) ----
  workTabId: null,
  // True from prompt-accept to turn/end. While a turn runs, browser actions
  // must NOT arm the idle fade — or the veil would flicker off between steps.
  turnActive: false,
  // True while the veil is (expected to be) on screen. Gates the turn-end
  // "Done ✓": a text-only turn never raised the veil.
  overlayVisible: false,
  // The tab the veil is on / the status line it was last told to show (the
  // early re-show after a navigation needs it so the fresh document gets the
  // right label).
  overlayTabId: null,
  overlayText: '',
}

export function log(kind, data) {
  const entry = { t: Date.now(), kind, ...data }
  if (kind === 'wire') {
    state.wirelog.push(entry)
    if (state.wirelog.length > 500) state.wirelog.splice(0, state.wirelog.length - 500)
  } else {
    state.log.push(entry)
    if (state.log.length > 20000) state.log.splice(0, state.log.length - 20000)
  }
  return entry
}

// Push the newest log entry with the state: the panel renders it directly
// instead of a full 'log' round-trip per event (the GUI's per-chunk
// publish path). Entry-less broadcasts ask the panel for a full resync.
export function broadcast(entry = null) {
  chrome.runtime
    .sendMessage({ type: 'evt', running: state.running, phase: state.phase, error: state.error, entry })
    .catch(() => {})
}

// Remembered model selection: the SW restarts constantly (idle expiry,
// browser restart), and the last pick must survive them.
export function loadStoredSelection() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(MODEL_STORAGE_KEY, (items) => {
        const sel = items?.[MODEL_STORAGE_KEY]
        resolve(sel && typeof sel.provider === 'string' && typeof sel.model === 'string' ? sel : null)
      })
    } catch {
      resolve(null)
    }
  })
}
export function saveSelection(sel) {
  if (sel === null) return
  try {
    chrome.storage.local.set({ [MODEL_STORAGE_KEY]: sel }, () => void chrome.runtime.lastError)
  } catch {
    /* storage unavailable: the selection lives in this SW instance only */
  }
}
export function loadStoredSessionId() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(SESSION_STORAGE_KEY, (items) => {
        const id = items?.[SESSION_STORAGE_KEY]
        resolve(typeof id === 'string' && id ? id : null)
      })
    } catch {
      resolve(null)
    }
  })
}
export function saveSessionId(id) {
  try {
    chrome.storage.local.set({ [SESSION_STORAGE_KEY]: id }, () => void chrome.runtime.lastError)
  } catch {
    /* storage unavailable: the session id lives in this SW instance only */
  }
}
export function clearStoredSessionId() {
  try {
    chrome.storage.local.remove(SESSION_STORAGE_KEY, () => void chrome.runtime.lastError)
  } catch {
    /* storage unavailable */
  }
}
