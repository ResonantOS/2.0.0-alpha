// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

/**
 * Augmentor — the "AI control" veil: show/fade/early-retry + the human
 * status line (extension/overlay.mjs).
 *
 * F1 (audit): extracted from the sw.js monolith. Owns the frost veil's
 * lifecycle on the work tab — the WebGL sheet + status pill that says
 * "this page is under AI control" (veil.js, injected per action, idempotent)
 * — and the plain-language status text per browser action.
 *
 * F1 (audit): theme-tokens.js is now a STATIC module import (the SW is a
 * module worker; importScripts is unavailable) instead of a top-level
 * importScripts in sw.js. It still runs before anything here touches
 * globalThis.__dshAugTheme: module imports evaluate in import order.
 */
import './theme-tokens.js'
import { state } from './state.mjs'
import { inject, injectFiles } from './worktab.mjs'

// The "this page is under AI control" indicator: the FROST VEIL — a
// WebGL frost sheet (a domain-warped heightfield lit like thin ice:
// diffuse + moving specular + fresnel rim + cavity/self shadow + crystal
// micro-facets) with a 3D parallax snowfall in front and a plain-language
// status pill at the bottom-center — plus per-action feedback (the
// clicked/typed element pulses and ripples). veil.js is re-injected on
// every action (idempotent; only the first run builds anything) and
// exposes window.__dshAugVeil in the page's isolated world; the small
// func below just calls its show()/fade() API. All of it is
// content-script DOM (page CSP does not apply) and pointer-events:none,
// so it can never block the agent's own clicks or the user's.
// Non-injectable pages (new tab page, chrome://) simply show nothing —
// every call is best-effort and silent.
const OVERLAY_ID = '__dshAugOverlay'
const OVERLAY_FADE_MS = 4000 // after an action OUTSIDE a turn (direct relay)
const OVERLAY_DONE_MS = 2500 // after "Done" at turn end

// Accent hue (0..360) chosen in the side panel's color popover: it themes
// the veil (passed to show()) and the click/type pulse. The panel mirrors
// its localStorage settings into chrome.storage.local because the SW is a
// separate context that cannot read the page's localStorage.
let accentHue = globalThis.__dshAugTheme.DEFAULTS.accentHue
let accentBright = globalThis.__dshAugTheme.DEFAULTS.accentBright
function syncAccent() {
  chrome.storage.local
    .get(['augmentor-accent-hue', 'augmentor-accent-bright'])
    .then((s) => {
      s = s || {}
      const h = Number(s['augmentor-accent-hue'])
      if (Number.isFinite(h) && h >= 0 && h < 360) accentHue = h
      const b = Number(s['augmentor-accent-bright'])
      if (Number.isFinite(b) && b >= -15 && b <= 15) accentBright = b
    })
    .catch(() => {})
}
// Guarded at every call site: without the "storage" permission
// (or in a context where the API is absent) chrome.storage is UNDEFINED
// and the property read throws synchronously — an unguarded top-level
// throw here would kill the SW before it registers its message listener,
// and the panel could never connect. Accent color must never take the
// agent down with it.
try {
  syncAccent()
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes['augmentor-accent-hue'] || changes['augmentor-accent-bright']))
      syncAccent()
  })
} catch { /* storage API unavailable: keep the default accent */ }

// "rgba(r, g, b" prefix of the accent pulse color (the veil's dot color),
// computed from the live accent hue at each action.
export function pulseRgba() {
  const c = globalThis.__dshAugTheme.veilPalette(accentHue, accentBright).dot
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}`
}

let overlayTimer = null

export function overlayShow(tabId, text, done = false) {
  if (tabId == null) return
  clearTimeout(overlayTimer)
  state.overlayTabId = tabId
  state.overlayVisible = true
  state.overlayText = String(text)
  // F6 (audit): theme-tokens.js first — veil.js now reads the single-source
  // palette from globalThis.__dshAugTheme and skips cleanly if it is absent.
  injectFiles(tabId, ['theme-tokens.js', 'veil.js'])
    .then(() =>
      inject(
        tabId,
        (text, done, hue, bright) =>
          window.__dshAugVeil ? window.__dshAugVeil.show(text, done, hue, bright) : 'no-veil',
        [String(text), done, accentHue, accentBright],
      ),
    )
    .catch(() => {})
  if (done || !state.turnActive) {
    overlayTimer = setTimeout(() => overlayFade(tabId), done ? OVERLAY_DONE_MS : OVERLAY_FADE_MS)
  } else {
    clearTimeout(overlayTimer)
  }
}

export function overlayFade(tabId) {
  if (tabId == null) return
  state.overlayVisible = false
  inject(
    tabId,
    (id) => {
      if (window.__dshAugVeil) return window.__dshAugVeil.fade()
      // veil.js never got in (older page state) — plain CSS fade.
      const root = document.getElementById(id)
      if (!root) return 'absent'
      root.style.transition = 'opacity 0.6s'
      root.style.opacity = '0'
      setTimeout(() => root.remove(), 700)
      return 'fading'
    },
    [OVERLAY_ID],
  ).catch(() => {})
}

// A navigation of the work tab destroys the document — and the veil with
// it. Re-raise the veil as soon as the NEW document is loading, instead of
// waiting for full page load: while a turn runs, the effect must hold
// across page changes. At 'loading' the document may not be committed yet
// (script injection fails), so retry briefly; the navigate handler's own
// show-after-load stays as the backstop.
let earlyShowTries = 0
function earlyShowRetry(tabId) {
  if (!state.turnActive || !state.overlayVisible || tabId !== state.overlayTabId) return
  if (earlyShowTries > 10) return
  earlyShowTries++
  injectFiles(tabId, ['theme-tokens.js', 'veil.js'])
    .then(() =>
      inject(
        tabId,
        (text, hue, bright) =>
          window.__dshAugVeil ? window.__dshAugVeil.show(text, false, hue, bright) : 'no-veil',
        [state.overlayText, accentHue, accentBright],
      ),
    )
    .catch(() => setTimeout(() => earlyShowRetry(tabId), 200))
}
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && tabId === state.overlayTabId && state.turnActive && state.overlayVisible) {
    earlyShowTries = 0
    earlyShowRetry(tabId)
  }
})

// Human status line for the badge, per browser action. Deliberately plain
// language — no selectors, no CSS — the badge is for the human, the model
// gets the real result. `phase`/`result` let the label flip from present
// ("Clicking…") to past tense with the element's human name ("Clicked on
// Sign in") once the action completes.
export function overlayTextFor(action, params, phase, result) {
  const host = (u) => {
    try {
      return new URL(u).host
    } catch {
      return String(u ?? '').slice(0, 40)
    }
  }
  const name = (r) => {
    const t = String(r?.name ?? '').replace(/\s+/g, ' ').trim()
    if (!t) return 'the element'
    return t.length > 32 ? t.slice(0, 32) + '…' : t
  }
  switch (action) {
    case 'tabs_list':
      return 'Checking open tabs…'
    case 'navigate':
      return phase === 'after' ? `Opened ${host(params?.url)}` : `Opening ${host(params?.url)}…`
    case 'snapshot':
      return 'Analysing the page…'
    case 'click':
      return phase === 'after' ? `Clicked on ${name(result)}` : 'Clicking…'
    case 'type':
      return phase === 'after' ? `Typed into ${name(result)}` : 'Typing…'
    default:
      return 'Thinking…'
  }
}
