// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

/* Augmentor — shared color math (classic script, no DOM at top level).
 *
 * One source of truth for the user-tunable palette:
 *   - the side panel's neutral surface tokens (bg / layers / scrollbars),
 *     tinted by a neutral hue plus a brightness offset that stays usable
 *     in both light and dark mode (same offset, different base lightness);
 *   - the accent color (panel brand + the browser-control overlay);
 *   - the frost veil's full color palette derived from the accent hue.
 *
 * Consumers:
 *   - sidepanel.html: <script src="theme-tokens.js"> before theme-boot.js
 *     (which applies the tokens pre-paint) and sidepanel.js (live updates);
 *   - sw.js: static import (module service worker) for the veil accent hue
 *     and the click-pulse colors;
 *   - veil.js: the SINGLE SOURCE for the veil palette — theme-tokens.js is
 *     injected before veil.js at every site (sw.js injectFiles order,
 *     lab/veil-preview.html script order) and veil.js reads
 *     globalThis.__dshAugTheme.veilPalette; with it missing the veil skips.
 */
(() => {
  'use strict'

  /* Defaults: the shipped look. The neutral hue 222 is the subtle cool
   * tint of the current grays; the accent hue 222 is DeepSeek blue.
   * Both brightnesses default to 0 (no offset). */
  const DEFAULTS = { neutHue: 222, neutBright: 0, accentHue: 222, accentBright: 0 }

  function hslToRgb(h, s, l) {
    // F6 (audit): normalize the hue FIRST. Role offsets can push a low user
    // accent hue negative (snowFar −11.5 at hue 5 → −6.5); without this the
    // branch chain below mis-classified the sector and x went negative.
    h = ((h % 360) + 360) % 360
    s = Math.max(0, Math.min(100, s)) / 100
    l = Math.max(0, Math.min(100, l)) / 100
    const c = (1 - Math.abs(2 * l - 1)) * s
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
    const m = l - c / 2
    let r, g, b
    if (h < 60) [r, g, b] = [c, x, 0]
    else if (h < 120) [r, g, b] = [x, c, 0]
    else if (h < 180) [r, g, b] = [0, c, x]
    else if (h < 240) [r, g, b] = [0, x, c]
    else if (h < 300) [r, g, b] = [x, 0, c]
    else [r, g, b] = [c, 0, x]
    const q = (v) => Math.round((v + m) * 255)
    return [q(r), q(g), q(b)]
  }

  const rgbStr = (c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`
  const rgbaStr = (c, a) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`

  /**
   * Label color for text sitting ON TOP of the given sRGB accent surface:
   * #fff while white holds a >= 3:1 WCAG contrast ratio against it (the
   * shipped look — white on the brand blue), then #000 once the accent is
   * brightened past pastel and white would strand. (Below 3:1, black is
   * always strictly better, so no second comparison is needed.)
   */
  function contrastOn(rgb) {
    const lin = (v) => {
      const c = v / 255
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }
    const L = 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2])
    return 1.05 / (L + 0.05) >= 3.0 ? '#fff' : '#000'
  }

  /**
   * Final lightness for an accent color given the accent brightness.
   *   bright >= 0 : +bright lightness points (additive, clamped 0..100)
   *   bright <  0 : dim toward FULL BLACK — at the slider minimum (−15) the
   *                 color reaches lightness 0 (pure black). Multiplicative,
   *                 so the roles' relative spacing is preserved on the way
   *                 down (a uniform fade-to-black, not a collapse).
   * The veil palette additionally headroom-scales the POSITIVE offset (see
   * veilPalette) so its brightest role can't white-out; that scaling happens
   * before this helper is called. Single source — veil.js reads this
   * (globalThis.__dshAugTheme), it no longer carries a copy.
   */
  function accentLight(l, bright) {
    if (bright >= 0) return Math.max(0, Math.min(100, l + bright))
    const t = 1 + bright / 15
    return Math.max(0, l * t)
  }

  /* Neutral surface bases per theme, for
   *   [--bg, --layer1, --layer2, --layer3, --sb-thumb, --sb-thumb-hover]:
   *   dark  lightness of the current GUI dark palette (bg 8.6% … sb-hover 33.5%)
   *   light lightness of the current GUI light palette (bg 100% … sb-hover 83.1%)
   * The user's brightness offset (lightness points, clamped 2..98) applies
   * to every level in BOTH themes, so one control is usable everywhere.
   * Per-level saturation: high enough that a chosen hue reads on the
   * surfaces (8% in dark, 20%+ on the light layers) while the default
   * hue 222 still reproduces the shipped near-neutral grays. */
  const NEUTRALS = {
    dark: { sat: [8, 8, 8, 8, 8, 8], lum: [8.6, 13.9, 17.6, 21.4, 23.7, 33.5] },
    light: { sat: [22, 22, 21.5, 20, 8, 8], lum: [100, 96.5, 94.5, 92.2, 89.8, 83.1] },
  }
  const NEUTRAL_KEYS = ['--bg', '--layer1', '--layer2', '--layer3', '--sb-thumb', '--sb-thumb-hover']

  /** CSS properties the panel theme rebinds; everything else (borders,
   * text, semantics) stays on the stylesheet's fixed tokens. */
  function panelTheme(theme, neutHue, neutBright, accentHue, accentBright) {
    const n = theme === 'light' ? NEUTRALS.light : NEUTRALS.dark
    const hue = Number.isFinite(neutHue) ? neutHue : DEFAULTS.neutHue
    // Headroom-scaled brightness: the raw offset (-15..15) is scaled down
    // when it would push levels into the 2..100 clamp, because independent
    // clamping collapses the layer spacing (e.g. light at +15 turned all
    // surfaces white; dark at -15 pinned the bottom three levels). After
    // scaling the extremes land exactly on the boundary and every level
    // keeps its designed lightness delta. Consequence: in light mode the
    // top levels are already at 100, so the + side has no headroom and
    // gracefully no-ops (white cannot be brighter); the - side works fully
    // in both themes. Default (offset 0) is unscaled — shipped values exact.
    let off = Number.isFinite(neutBright) ? neutBright : 0
    if (off !== 0) {
      // min/max, not index 0/last: the dark levels ascend while the light
      // levels descend, and it is the extreme that hits the clamp first
      const headroom =
        off > 0 ? 100 - Math.max(...n.lum) : Math.min(...n.lum) - 2
      const scale = headroom / 15
      if (scale < 1) off *= scale
    }
    const out = {}
    NEUTRAL_KEYS.forEach((k, i) => {
      const l = Math.max(2, Math.min(100, n.lum[i] + off))
      out[k] = rgbStr(hslToRgb(hue, n.sat[i], l))
    })
    // Accent: bright in dark, deeper in light (white-on-accent buttons);
    // the small per-theme hue offset matches the shipped brand in both.
    // accentBright shifts the brand lightness (plain clamp is fine on the
    // + side: one mid-range color, no layer spacing to preserve; the − side
    // fades multiplicatively to full black via accentLight).
    const a = theme === 'light' ? [-1.3, 77, 57.8] : [0.9, 99, 66.7]
    const ab = Number.isFinite(accentBright) ? accentBright : 0
    const brandRgb = hslToRgb(
      (Number.isFinite(accentHue) ? accentHue : DEFAULTS.accentHue) + a[0],
      a[1],
      accentLight(a[2], ab),
    )
    out['--brand'] = rgbStr(brandRgb)
    // Label color that stays readable on a brand-filled surface (Send button,
    // active theme-segment) as the accent is brightened past pastel.
    out['--on-brand'] = contrastOn(brandRgb)
    // Faint accent wash — the user-message bubble (see sidepanel.html).
    out['--brand-soft'] = rgbaStr(brandRgb, 0.16)
    return out
  }

  function applyPanelTheme(rootEl, theme, neutHue, neutBright, accentHue, accentBright) {
    for (const [k, v] of Object.entries(panelTheme(theme, neutHue, neutBright, accentHue, accentBright)))
      rootEl.style.setProperty(k, v)
  }

  /**
   * The frost veil palette from the accent hue: [hueOffset, sat, light]
   * triples (hue = accentHue + offset). The offsets reproduce the original
   * green material (accent hue 142) — the palette's internal hue spread
   * (a cyan-leaning mid, warm white ice, …) is what gives it depth, and it
   * follows the accent coherently (e.g. a red accent gets orange mids).
   *
   * Single source — the panel preview chip and veil.js both consume
   * globalThis.__dshAugTheme (this file).
   */
  function veilPaletteSpec() {
    return {
      deep: [0.5, 72.7, 4.3], // fog base (darkest)
      mid: [-2, 88.2, 26.7], // body of the sheet
      mid2: [6.5, 85.5, 27.1], // drift-brightened body
      ice: [-8, 72.9, 88.4], // specular / sheen / rim
      vein: [5, 84, 49], // crystal veins
      edge: [-2.5, 71.7, 36.1], // dense border band
      dot: [0, 70.6, 45.3], // pill dot / click pulse
      dotDone: [0, 69.2, 58], // "done ✓" dot
      label: [2.5, 54.8, 93.9], // pill label
      pillBg1: [8, 25, 3.1], // pill gradient top
      pillBg2: [8, 27.3, 4.3], // pill gradient bottom
      fog2: [16, 64.4, 51.6], // lighter CSS-fog blob
      snowNear: [18, 34.5, 66.5], // snow, depth band near
      snowFar: [-11.5, 63.6, 91.4], // snow, depth band far
      glyphNear: [-10, 62.5, 3.1], // glyph field, dark
      glyphFar: [-4, 55.9, 11.6], // glyph field, lit
    }
  }

  /**
   * @param {number} h accent hue (142 = the original green)
   * @param {number} [bright] accent brightness for every palette role
   *   (-15..15). The + side is headroom-scaled like the neutral brightness:
   *   the roles span lightness 3.1..93.9, so unscaled +15 would white-out
   *   the extremes; after scaling every role keeps its designed delta.
   *   The − side fades multiplicatively to FULL BLACK (accentLight): at the
   *   slider minimum (−15) every role reaches lightness 0, intermediate
   *   steps keep the roles' relative spacing.
   */
  function veilPalette(h, bright) {
    const hue = Number.isFinite(h) ? h : 142 // 142 = the original green
    const spec = veilPaletteSpec()
    const lights = Object.values(spec).map((t) => t[2])
    let off = Number.isFinite(bright) ? bright : 0
    if (off > 0) {
      const headroom = 100 - Math.max(...lights)
      const scale = headroom / 15
      if (scale < 1) off *= scale
    }
    const out = { hue }
    for (const [k, [dh, s, l]] of Object.entries(spec))
      out[k] = hslToRgb(hue + dh, s, accentLight(l, off))
    return out
  }

  globalThis.__dshAugTheme = {
    DEFAULTS,
    hslToRgb,
    rgbStr,
    rgbaStr,
    contrastOn,
    accentLight,
    NEUTRALS,
    panelTheme,
    applyPanelTheme,
    veilPaletteSpec,
    veilPalette,
  }
})()
