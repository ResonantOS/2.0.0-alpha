// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

/**
 * Augmentor — work-tab resolution + content-script injection (extension/worktab.mjs).
 *
 * F1 (audit): extracted from the sw.js monolith. Owns "which tab is the
 * agent acting on" (re-resolved at every turn start, sticky within the
 * turn) and the two executeScript entry points (file injection + func
 * injection). Everything here is chrome.tabs/scripting only — no port, no
 * overlay, so nothing above it in the import graph reaches back.
 */
import { state } from './state.mjs'

// ------------------------------------------------------- browser actions
// The tab the agent acts on: re-resolved at the start of every user turn to
// the tab the user is actually looking at (the active tab of the last-focused
// window), then sticky within the turn so a navigate → snapshot → click
// sequence stays on one tab even if the user flips tabs mid-turn. A new tab
// page / blank tab counts as "the user's tab": there is no content to read
// there yet, but navigate can turn it into a real page. Never an extension
// page (the panel's tab, when opened in a window, is active there), and
// never the user's DSH session tab (the web GUI the agent is talking
// through): navigate opens a dedicated tab instead of navigating it away.
const SELF_ORIGIN = 'chrome-extension://' + chrome.runtime.id + '/'
function isWorkTab(t) {
  const u = t?.url ?? ''
  if (!t?.id || u === '') return false
  if (u.startsWith(SELF_ORIGIN)) return false // the extension's own pages
  return !/^chrome(-search)?:|^about:|^devtools:/i.test(u)
}
// A new tab page or blank tab: where the user just opened a tab. Not
// scriptable yet, but navigable — the work tab until something loads in it.
function isEmptyTab(t) {
  const u = t?.url ?? ''
  return u === 'about:blank' || /^chrome:\/\/newtab/i.test(u) || /^about:newtab/i.test(u)
}
// ------------------------------------------------- the user's DSH session
// A tab on the origin of the running DSH web app hosts the user's OWN DSH
// session — the very session the agent is talking through. Navigating such a
// tab away would drop the user's session, so the agent never works on it:
// navigate opens a dedicated tab instead (actions.mjs's catch is the
// new-tab path), and the read actions fail with a directive error. The
// pipe reports the app's base URL in the initialize handshake
// (state.endpoint, set before phase 'ready', hence known for every browser
// action). localhost and 127.0.0.1 name the same loopback server, so both
// spellings count as the same origin.
function dshOrigin() {
  const base = state.endpoint
  if (typeof base !== 'string' || !base) return null
  let u
  try {
    u = new URL(base)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  const normHost = (h) => (h.toLowerCase() === 'localhost' ? '127.0.0.1' : h.toLowerCase())
  const defPort = u.protocol === 'https:' ? '443' : '80'
  return { protocol: u.protocol, host: normHost(u.hostname), port: u.port || defPort }
}
export function isDshTab(t) {
  const base = dshOrigin()
  if (!base) return false
  const u = t?.url ?? ''
  if (!u) return false
  let x
  try {
    x = new URL(u)
  } catch {
    return false
  }
  const normHost = (h) => (h.toLowerCase() === 'localhost' ? '127.0.0.1' : h.toLowerCase())
  const defPort = x.protocol === 'https:' ? '443' : '80'
  return (
    x.protocol === base.protocol &&
    normHost(x.hostname) === base.host &&
    (x.port || defPort) === base.port
  )
}
// The window the user is looking at (last focused). From the service
// worker, a `currentWindow: true` tab query already resolves against the
// last-focused window; windows.getLastFocused is the backup (needs the
// "windows" permission). Returns null when neither works.
export async function focusedWindowId() {
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (t?.windowId != null) return t.windowId
  } catch { /* no active tab in the focused window */ }
  try {
    return (await chrome.windows.getLastFocused()).id
  } catch {
    return null
  }
}
// Real activation recency: chrome.tabs.Tab has no lastAccessed property,
// so the SW tracks tab activations itself. Used only when the active tab
// is not workable — never for the primary "tab the user is looking at"
// resolution.
const recentActive = new Map() // tabId -> Date.now() of last activation
chrome.tabs.onActivated.addListener(({ tabId }) => {
  recentActive.set(tabId, Date.now())
  if (recentActive.size > 100) {
    let oldestId = null
    let oldestT = Infinity
    for (const [id, t] of recentActive) {
      if (t < oldestT) {
        oldestId = id
        oldestT = t
      }
    }
    if (oldestId != null) recentActive.delete(oldestId)
  }
})
chrome.tabs.onRemoved.addListener((tabId) => {
  recentActive.delete(tabId)
})

export async function workTab() {
  if (state.workTabId != null) {
    try {
      const t = await chrome.tabs.get(state.workTabId)
      // A sticky tab the user navigated onto the DSH GUI is the user's
      // session again: drop the stickiness and re-resolve.
      if (!isDshTab(t) && (isWorkTab(t) || isEmptyTab(t))) return t
    } catch { /* tab closed */ }
    state.workTabId = null
  }
  // 1) The tab the user is looking at right now: the active tab of the
  //    last-focused window — including a new tab page (workable via
  //    navigate, no content to read until then). Never rely on
  //    Tab.lastFocusedWindow (absent in some Chromium builds).
  let active = null
  try {
    ;[active] = await chrome.tabs.query({ active: true, currentWindow: true })
  } catch { /* fall through to the window-derived lookup */ }
  if (!active) {
    const wid = await focusedWindowId()
    const tabs = await chrome.tabs.query({})
    active =
      (wid != null ? tabs.find((t) => t.active && t.windowId === wid) : undefined) ??
      tabs.find((t) => t.active) ??
      null
  }
  if (active && (isWorkTab(active) || isEmptyTab(active))) {
    // The user's own DSH session is on screen. Throw — do NOT fall through
    // to the recency fallback (that would quietly hijack another tab the
    // user is not looking at): navigate's catch is the new-tab path, and
    // the read actions surface a directive error instead.
    if (isDshTab(active)) {
      state.workTabId = null
      throw new Error(
        'the tab the user is on is their DSH session — the agent works in a dedicated tab; call browser_navigate to open a URL',
      )
    }
    state.workTabId = active.id
    return active
  }
  // 2) The active tab is a non-workable page (chrome://internal,
  //    extension page, …): fall back to the most recently activated
  //    usable tab (tracked via onActivated) — never the first tab in the
  //    list, which is where the old session-long stickiness landed.
  const tabs = await chrome.tabs.query({})
  // DSH session tabs are never fallback candidates (see dshOrigin above).
  const usable = tabs.filter((t) => isWorkTab(t) && !isDshTab(t))
  if (!usable.length) throw new Error('no usable browser tab')
  const byRecency = [...usable].sort((a, b) => (recentActive.get(b.id) ?? 0) - (recentActive.get(a.id) ?? 0))
  const pick = byRecency[0]
  state.workTabId = pick.id
  return pick
}
// Read/click/type actions need a real page: fail with an actionable error
// when the work tab is still a new tab page / blank tab.
export async function readableWorkTab() {
  const tab = await workTab()
  if (!isWorkTab(tab)) {
    throw new Error(
      'the tab you are on is a new tab page — nothing to read there yet; use navigate to open a URL in it first',
    )
  }
  return tab
}

export function inject(tabId, func, args = []) {
  return chrome.scripting
    .executeScript({ target: { tabId }, func, args })
    .then((results) => results[0]?.result)
}

export function injectFiles(tabId, files) {
  return chrome.scripting
    .executeScript({ target: { tabId }, files })
    .then(() => true)
}

// Wait until tabId has navigated to (a document with) expectedUrl: resolve
// the first onUpdated 'complete' after the call, or immediately when the tab
// is already complete, or after timeoutMs (navigate reports the expected
// URL in that case).
const loadListeners = new Map()
export function waitForLoad(tabId, expectedUrl, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish({ url: expectedUrl, title: null }), timeoutMs)
    const listener = (id, info) => {
      if (id !== tabId || info.status !== 'complete') return
      finish(info)
    }
    function finish(info) {
      clearTimeout(timer)
      loadListeners.delete(tabId)
      chrome.tabs.onUpdated.removeListener(listener)
      resolve({ url: info?.url ?? expectedUrl, title: info?.title ?? null })
    }
    loadListeners.set(tabId, listener)
    chrome.tabs.onUpdated.addListener(listener)
    // Already complete?
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === 'complete') finish({ url: t.url, title: t.title })
    }).catch(() => {})
  })
}
