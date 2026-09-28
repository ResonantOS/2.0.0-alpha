// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

/* Pre-paint theme + color restore, runs synchronously before first paint.
 *
 * This must be a file: MV3's default extension-page CSP (script-src 'self',
 * not extendable in MV3) refuses inline <script> in extension pages.
 *
 * Restores everything the user can tune (all in localStorage, written by
 * sidepanel.js):
 *   augmentor-theme        'light' (dark is the default — no attribute)
 *   augmentor-neut-hue     0..360  tint of the neutral surfaces
 *   augmentor-neut-bright  -15..15 lightness offset, both themes
 *   augmentor-accent-hue   0..360  accent color (panel + browser overlay)
 *   augmentor-accent-bright -15..15 accent lightness offset
 *
 * theme-tokens.js (loaded first in sidepanel.html) provides the math and
 * applies the values as inline custom properties on <html>, overriding the
 * stylesheet defaults (which remain the no-JS fallback).
 */
try {
  const root = document.documentElement
  const ls = localStorage
  if (ls.getItem('augmentor-theme') === 'light') root.dataset.theme = 'light'
  const T = globalThis.__dshAugTheme
  if (T) {
    const num = (k, d) => {
      let raw
      try {
        raw = ls.getItem(k)
      } catch {
        raw = null
      }
      // guard raw first: Number(null) is 0, which would mean red
      if (raw == null) return d
      const v = Number(raw)
      return Number.isFinite(v) ? v : d
    }
    T.applyPanelTheme(
      root,
      root.dataset.theme === 'light' ? 'light' : 'dark',
      num('augmentor-neut-hue', T.DEFAULTS.neutHue),
      num('augmentor-neut-bright', T.DEFAULTS.neutBright),
      num('augmentor-accent-hue', T.DEFAULTS.accentHue),
      num('augmentor-accent-bright', T.DEFAULTS.accentBright),
    )
  }
} catch (e) {
  /* storage unavailable: fall through to the default dark palette */
}
