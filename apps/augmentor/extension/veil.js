// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

/**
 * Augmentor — the "frost veil" (extension/veil.js).
 *
 * The visual indicator that this page is under agent control. A WebGL
 * frost sheet: a slowly flowing, domain-warped heightfield (iq-style
 * fbm-of-fbm-of-fbm) lit like a thin sheet of ice seen slightly from
 * above — Lambert diffuse, a tight moving specular (the "glint"), a
 * broader sheen, a fresnel rim, cavity darkening in the crevices and a
 * directional self-shadow along the light — over crystal micro-facets
 * that shimmer as the light rakes. A parallax snowfall of point-sprite
 * flakes in a depth band drifts in front. Pointer movement tilts the
 * view and the light, so the surface reads as 3D material you can see
 * through: the page behind stays sharp and readable (NO backdrop blur —
 * the see-through quality is low center alpha only), while an even band
 * of denser, fuller-green ice condenses around the borders.
 *
 * Lifecycle: the frost CONDENSES in over ~1.5s when the agent takes
 * control (edges first, center last), breathes for the whole turn, and
 * MELTS away when the turn is done.
 *
 * Injected by sw.js: `executeScript({ files: ['veil.js'] })` on every
 * action (idempotent — only the first run builds anything), followed by
 * a small func that calls the API. Also loaded directly by
 * lab/veil-preview.html for visual iteration (plain page script).
 *
 * DOM contract (kept from the CSS-fog era, asserted by
 * lab-overlay-verify.py):
 *   root #__dshAugOverlay, children [veil, pill, style]
 *   veil = children[0]; its INLINE opacity is the show/hide switch
 *   pill children [dot, label]; dot animates __dshAugPulse
 *
 * Fallbacks: no WebGL (or prefers-reduced-motion) -> the old layered
 * CSS fog, same keyframes, same green.
 *
 * Everything is pointer-events:none; the canvas is a reduced-resolution
 * backing store upscaled by CSS (the fog is soft anyway) and the loop
 * auto-drops quality if frames run slow.
 */
(() => {
  'use strict'
  if (window.__dshAugVeil) return window.__dshAugVeil

  const OVERLAY_ID = '__dshAugOverlay'
  const SNOW_COUNT = 200
  const REVEAL_MS = 1500
  const MELT_MS = 900
  const FADE_MS = 700
  const TIER_SCALE = [0.55, 0.80] // canvas backing-store scale (css px); high enough that the upscale stays smooth

  // Variation (test hook, set before load). The extension default is the
  // glyph field — the wave rendered as small, translucent digits and symbols
  // modulated by the same 3D ice field. Set '__dshAugVariation' to 'frost'
  // to get the approved frost sheet back.
  const VARIATION = window.__dshAugVariation === 'frost' ? 'frost' : 'glyphs'
  const GLYPH_CELL = 6 // glyph cell size in screen px (scaled to canvas px in the shader)
  // ASCII-only glyph set (32 chars = 8x4 atlas): renders identically on
  // every platform, no missing-glyph boxes.
  const GLYPH_SET = '0123456789ABCDEF' + '+-*/<>=&|#%$!:' + '.,'

  // ------------------------------------------------------- accent palette
  // The whole effect used to be hardcoded green. It is now driven by ONE
  // hue — the user's accent color from the side panel (sw.js passes it to
  // show(); lab/veil-preview.html passes it too; with no hue the original
  // green (142) stays for A/B parity).
  //
  // F6 (audit): the palette math (hslToRgb / accentLight / the per-role
  // VEIL_SPEC / veilPalette) used to live here as a compact copy of
  // theme-tokens.js, kept in sync by hand. It is now the SINGLE SOURCE:
  // theme-tokens.js, injected BEFORE this file at every site (sw.js
  // injectFiles order, lab/veil-preview.html script order). Without it a
  // mis-colored veil is worse than no veil — the veil skips cleanly.
  const theme = globalThis.__dshAugTheme
  if (!theme) return
  const { veilPalette } = theme
  const rgba = (rgb, a) => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`
  const rgb = (rgb) => `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`

  const S = {
    root: null,
    veil: null,
    pill: null,
    dot: null,
    label: null,
    fadeTimer: null,
    // WebGL
    mode: 'none', // none | webgl | fallback
    tier: 1,
    canvas: null,
    gl: null,
    frost: null, // {prog, u:{}, a:{}}
    snow: null,
    quadBuf: null,
    snowBuf: null,
    atlas: null,
    raf: 0,
    t0: 0,
    lastT: 0,
    acc: 0,
    frames: 0,
    total: 0,
    fps: 0,
    slow: 0,
    shadowOn: true,
    // timeline
    reveal: 1,
    revealStart: 0,
    melting: false,
    melt: 0,
    meltStart: 0,
    // pointer (target / smoothed), -1..1
    tx: 0,
    ty: 0,
    px: 0,
    py: 0,
    // accent (see veilPalette): 142 = the original green until show()
    // passes the user's accent hue + brightness from the side panel
    accentHue: 142,
    accentBright: 0,
    pal: veilPalette(142, 0),
    fogDivs: [], // fallback-fog layers, re-tinted by setAccent
  }

  const clamp = (v) => Math.max(-1, Math.min(1, v))
  const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3)
  const easeInQuad = (x) => x * x

  // DOM bridge: content-script globals live in the isolated world, so the
  // main world (lab probes, the extension UI) reads live state from the
  // root element's dataset instead.
  function publishState() {
    if (S.root)
      S.root.dataset.veil = JSON.stringify({
        m: S.mode,
        f: Math.round(S.fps),
        t: S.total,
        v: VARIATION,
        a: S.accentHue,
        b: S.accentBright,
      })
  }

  // --------------------------------------------------------- glyph atlas
  // 8x4 grid of 64px cells, drawn with the page's monospace stack.
  function buildGlyphAtlas(gl) {
    const c = document.createElement('canvas')
    c.width = 512
    c.height = 256
    const x = c.getContext('2d')
    x.clearRect(0, 0, c.width, c.height)
    x.fillStyle = '#fff'
    x.font = 'bold 50px monospace'
    x.textAlign = 'center'
    x.textBaseline = 'middle'
    for (let i = 0; i < GLYPH_SET.length; i++)
      x.fillText(GLYPH_SET[i], (i % 8) * 64 + 32, Math.floor(i / 8) * 64 + 34)
    const t = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    // LINEAR min (no mipmaps): the glyphs minify ~7x, and mipmap levels
    // would blur the small strokes into mush — the base level keeps them
    // sharp enough to read.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }

  // ------------------------------------------------------------- DOM
  // The fallback keyframes are the v0.1.6 fog verbatim — the fallback must
  // be indistinguishable from the pre-WebGL effect.
  const KEYFRAMES =
    '@keyframes __dshAugPulse{0%,100%{opacity:0.35;transform:scale(0.8)}' +
    '50%{opacity:1;transform:scale(1.15)}}' +
    '@keyframes __dshAugFog{from{filter:brightness(0.8)}to{filter:brightness(1.25)}}' +
    '@keyframes __dshAugFogA{' +
    '0%{transform:translate(-3%,-2%) rotate(0deg) scale(1)}' +
    '50%{transform:translate(2.5%,3%) rotate(4deg) scale(1.06)}' +
    '100%{transform:translate(-1.5%,1%) rotate(-3deg) scale(1.02)}}' +
    '@keyframes __dshAugFogB{' +
    '0%{transform:translate(2%,-2.5%) rotate(0deg) scale(1.03)}' +
    '50%{transform:translate(-3%,2%) rotate(-4deg) scale(1)}' +
    '100%{transform:translate(1.5%,-1%) rotate(3deg) scale(1.05)}}'

  function ensure() {
    if (S.root) return
    const root = document.createElement('div')
    root.id = OVERLAY_ID
    root.style.cssText =
      'all:initial; position:fixed; inset:0; z-index:2147483647; pointer-events:none;'
    const veil = document.createElement('div')
    veil.style.cssText = 'position:fixed; inset:0; opacity:0; transition:opacity 0.5s ease;'
    const pill = document.createElement('div')
    pill.style.cssText =
      'position:absolute; left:50%; bottom:20px; transform:translateX(-50%); ' +
      'display:flex; align-items:center; gap:9px; padding:10px 20px; ' +
      `background:linear-gradient(180deg, ${rgba(S.pal.pillBg1, 0.94)}, ${rgba(S.pal.pillBg2, 0.94)}); ` +
      `border:1px solid ${rgba(S.pal.dotDone, 0.28)}; border-radius:999px; ` +
      `box-shadow:0 4px 24px rgba(0,0,0,0.55), 0 0 0 1px ${rgba(S.pal.dot, 0.18)}, 0 0 18px ${rgba(S.pal.dot, 0.25)}; ` +
      'opacity:0; transition:opacity 0.3s;'
    const dot = document.createElement('span')
    dot.style.cssText =
      `width:9px; height:9px; border-radius:50%; background:${rgb(S.pal.dot)}; flex:0 0 auto; ` +
      'animation:__dshAugPulse 1.2s ease-in-out infinite;'
    const label = document.createElement('span')
    label.style.cssText =
      `font:500 14px/1 system-ui,-apple-system,sans-serif; color:${rgb(S.pal.label)}; white-space:nowrap; letter-spacing:0.2px;`
    pill.append(dot, label)
    const st = document.createElement('style')
    st.textContent = KEYFRAMES
    root.append(veil, pill, st)
    ;(document.body ?? document.documentElement).append(root)
    S.root = root
    S.veil = veil
    S.pill = pill
    S.dot = dot
    S.label = label
    window.addEventListener('pointermove', onPointer, { passive: true })
  }

  function onPointer(e) {
    S.tx = clamp((e.clientX / innerWidth) * 2 - 1)
    S.ty = clamp((e.clientY / innerHeight) * 2 - 1)
  }

  // ---------------------------------------------- fallback CSS fog
  // The pre-WebGL look (v0.1.6): static edge vignette + two drifting
  // blob layers. Used when WebGL is unavailable or reduced motion is
  // requested (then only the static vignette).
  function buildFog(animated) {
    if (S.canvas) {
      S.canvas.remove()
      S.canvas = null
    }
    S.fogDivs = []
    const pal = S.pal
    const f0 = document.createElement('div')
    f0.style.cssText =
      'position:absolute; inset:0; ' +
      `background:radial-gradient(50% 50% at 50% 50%, ${rgba(pal.dot, 0)} 0%, ` +
      `${rgba(pal.dot, 0)} 30%, ${rgba(pal.dot, 0.1)} 52%, ${rgba(pal.dot, 0.3)} 74%, ` +
      `${rgba(pal.dot, 0.55)} 100%);`
    S.veil.append(f0)
    S.fogDivs.push(f0)
    if (!animated) {
      S.veil.style.animation = ''
      S.mode = 'fallback'
      publishState()
      return
    }
    const f1 = document.createElement('div')
    f1.style.cssText =
      'position:absolute; inset:-20%; ' +
      'background:' +
      `radial-gradient(34% 30% at 18% 22%, ${rgba(pal.dot, 0.35)} 0%, ${rgba(pal.dot, 0)} 70%),` +
      `radial-gradient(40% 36% at 84% 76%, ${rgba(pal.fog2, 0.3)} 0%, ${rgba(pal.fog2, 0)} 72%),` +
      `radial-gradient(30% 28% at 78% 18%, ${rgba(pal.dotDone, 0.22)} 0%, ${rgba(pal.dotDone, 0)} 70%); ` +
      'animation:__dshAugFogA 24s ease-in-out infinite alternate;'
    const f2 = document.createElement('div')
    f2.style.cssText =
      'position:absolute; inset:-20%; ' +
      'background:' +
      `radial-gradient(36% 32% at 22% 78%, ${rgba(pal.dot, 0.3)} 0%, ${rgba(pal.dot, 0)} 70%),` +
      `radial-gradient(32% 30% at 82% 28%, ${rgba(pal.fog2, 0.26)} 0%, ${rgba(pal.fog2, 0)} 70%),` +
      `radial-gradient(38% 34% at 50% 52%, ${rgba(pal.dot, 0.18)} 0%, ${rgba(pal.dot, 0)} 75%); ` +
      'animation:__dshAugFogB 31s ease-in-out infinite alternate;'
    S.veil.append(f1, f2)
    S.fogDivs.push(f1, f2)
    S.veil.style.animation = '__dshAugFog 4s ease-in-out infinite alternate'
    S.mode = 'fallback'
    publishState()
  }

  // ---------------------------------------------------------- accent color
  // The accent hue + a lightness offset re-tint the whole effect: the
  // status pill, the CSS-fog fallback, and (once GL is up) the
  // frost/snow shader uniforms. Called from show() with the values the SW
  // passed — safe to call with the values that are already active
  // (re-uploads uniforms, harmless).
  function uploadAccentUniforms() {
    const gl = S.gl
    if (!gl) return
    const set3 = (loc, c) => {
      if (loc) gl.uniform3f(loc, c[0] / 255, c[1] / 255, c[2] / 255)
    }
    const p = S.pal
    // Bind each program before touching ITS uniforms: uniform3f is a silent
    // no-op for locations that don't belong to the bound program, and
    // frame() leaves the snow program bound between calls. (frame() re-binds
    // both programs on its next tick, so the extra bind is harmless.)
    if (S.frost) {
      gl.useProgram(S.frost.prog)
      const u = S.frost.u
      set3(u.uDeep, p.deep)
      set3(u.uMid, p.mid)
      set3(u.uMid2, p.mid2)
      set3(u.uIce, p.ice)
      set3(u.uVein, p.vein)
      set3(u.uEdge, p.edge)
      set3(u.uGlyphNear, p.glyphNear)
      set3(u.uGlyphFar, p.glyphFar)
    }
    if (S.snow) {
      gl.useProgram(S.snow.prog)
      set3(S.snow.u.uSnowNear, p.snowNear)
      set3(S.snow.u.uSnowFar, p.snowFar)
    }
  }

  function setAccent(h, b) {
    if (!Number.isFinite(h)) h = 142
    h = ((h % 360) + 360) % 360
    b = Number.isFinite(b) ? b : 0
    const changed = h !== S.accentHue || b !== S.accentBright
    S.accentHue = h
    S.accentBright = b
    if (changed || !S.pal) S.pal = veilPalette(h, b)
    const p = S.pal
    if (S.pill) {
      S.pill.style.background = `linear-gradient(180deg, ${rgba(p.pillBg1, 0.94)}, ${rgba(p.pillBg2, 0.94)})`
      S.pill.style.border = `1px solid ${rgba(p.dotDone, 0.28)}`
      S.pill.style.boxShadow = `0 4px 24px rgba(0,0,0,0.55), 0 0 0 1px ${rgba(p.dot, 0.18)}, 0 0 18px ${rgba(p.dot, 0.25)}`
      S.label.style.color = rgb(p.label)
    }
    // The dot color is owned by show() (it flips done/active per state).
    if (S.fogDivs.length) {
      const [f0, f1, f2] = S.fogDivs
      f0.style.background =
        `radial-gradient(50% 50% at 50% 50%, ${rgba(p.dot, 0)} 0%, ${rgba(p.dot, 0)} 30%, ` +
        `${rgba(p.dot, 0.1)} 52%, ${rgba(p.dot, 0.3)} 74%, ${rgba(p.dot, 0.55)} 100%)`
      if (f1)
        f1.style.background =
          `radial-gradient(34% 30% at 18% 22%, ${rgba(p.dot, 0.35)} 0%, ${rgba(p.dot, 0)} 70%),` +
          `radial-gradient(40% 36% at 84% 76%, ${rgba(p.fog2, 0.3)} 0%, ${rgba(p.fog2, 0)} 72%),` +
          `radial-gradient(30% 28% at 78% 18%, ${rgba(p.dotDone, 0.22)} 0%, ${rgba(p.dotDone, 0)} 70%)`
      if (f2)
        f2.style.background =
          `radial-gradient(36% 32% at 22% 78%, ${rgba(p.dot, 0.3)} 0%, ${rgba(p.dot, 0)} 70%),` +
          `radial-gradient(32% 30% at 82% 28%, ${rgba(p.fog2, 0.26)} 0%, ${rgba(p.fog2, 0)} 70%),` +
          `radial-gradient(38% 34% at 50% 52%, ${rgba(p.dot, 0.18)} 0%, ${rgba(p.dot, 0)} 75%)`
    }
    uploadAccentUniforms()
    if (changed) publishState()
  }

  // ------------------------------------------------------------- GL
  const FROST_VS = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`

  const FROST_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2  uRes;
uniform float uTime;
uniform float uReveal;
uniform float uMelt;
uniform vec2  uPointer;
uniform float uShadow;
uniform sampler2D uAtlas; // glyph variation: 8x4 white glyphs on transparent
uniform float uGlyphMode; // 0 = frost sheet (default), 1 = characters
uniform vec2  uCell;      // glyph cell size, screen px
// Accent palette (setAccent from the user's accent hue; see veilPalette).
// uMid2/uVein/etc. keep the original green palette's hue spread relative
// to the accent — at hue 142 they are the original greens.
uniform vec3  uDeep;
uniform vec3  uMid;
uniform vec3  uMid2;
uniform vec3  uIce;
uniform vec3  uVein;
uniform vec3  uEdge;
uniform vec3  uGlyphNear;
uniform vec3  uGlyphFar;

vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }

// Cheap per-column / per-cell hashes for the glyph variation.
float hash1(float n) { return fract(sin(n * 127.1) * 43758.5453123); }
float hash21(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453123); }

float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                      -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x  = 2.0 * fract(p * C.www) - 1.0;
  vec3 h  = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * snoise(p);
    p = p * 2.02 + vec2(13.1, 7.7);
    a *= 0.5;
  }
  return s;
}

// One heightfield sample: large slow flow (warped fbm) + a finer, faster
// ripple. q/r are the domain-warp fields, evaluated once per pixel and
// reused for the neighbor taps (they are smooth, so the derivative is
// still organic).
float heightAt(vec2 p, vec2 q, vec2 r, float t) {
  float f = fbm(p * 0.62 + 2.6 * r);
  float g = snoise(p * 2.1 + vec2(t * 1.4, -t * 1.1) + 3.0 * q);
  return 0.72 * f + 0.56 * g;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0) * 3.0;
  p += uPointer * 0.03; // the sheet leans toward the pointer
  p.y += uMelt * 0.8;   // melt: the pattern sinks away
  float t = uTime * 0.055;

  vec2 q = vec2(
    snoise(p * 0.55 + vec2(  t * 0.9, -t * 0.6)),
    snoise(p * 0.55 + vec2(-t * 0.7,  t * 1.1))
  );
  vec2 r = vec2(
    snoise(p * 0.55 + 3.0 * q + vec2(1.7, 9.2) +  t * 0.5),
    snoise(p * 0.55 + 3.0 * q + vec2(8.3, 2.8) - t * 0.4)
  );

  float h  = heightAt(p, q, r, t);
  float e  = 0.02;
  float hL = heightAt(p - vec2(e, 0.0), q, r, t);
  float hR = heightAt(p + vec2(e, 0.0), q, r, t);
  float hD = heightAt(p - vec2(0.0, e), q, r, t);
  float hU = heightAt(p + vec2(0.0, e), q, r, t);

  // Crystal micro-facets: fine shimmer on the normal (kept below the
  // backing-store Nyquist so the upscale never reads as pixel noise).
  float m1 = snoise(p * 11.0 + vec2(t * 2.2, -t * 1.7));
  float m2 = snoise(p * 11.0 + vec2(7.3, 1.9) - t * 1.3);
  vec3 n = normalize(vec3(
    (hL - hR) * 55.0 + m1 * 0.5,
    (hD - hU) * 55.0 + m2 * 0.5,
    1.0
  ));

  // View tilts with the pointer; the light rakes across as you move.
  vec3 v = normalize(vec3(-uPointer.x * 0.45, -uPointer.y * 0.45, 1.0));
  vec3 l = normalize(vec3(-0.62 + uPointer.x * 0.55, 0.55 + uPointer.y * 0.50, 0.62));
  float ndl  = max(dot(n, l), 0.0);
  vec3 hv    = normalize(l + v);
  float ndhv = max(dot(n, hv), 0.0);
  // Broad, soft glints instead of tight hot spots (tight ones alias at
  // the reduced backing-store resolution and read as pixelation).
  float spec  = pow(ndhv, 80.0);
  float sheen = pow(ndhv, 22.0) * 0.12;
  float fres  = pow(1.0 - max(dot(n, v), 0.0), 3.5);

  // Shadows: cavity darkening by height + self-shadow sampled up-light.
  float cav  = 0.45 + 0.55 * smoothstep(-0.6, 0.8, h);
  float shad = 1.0;
  if (uShadow > 0.5) {
    float hL2 = heightAt(p + l.xy * 0.16, q, r, t);
    shad = clamp(0.55 + (h - hL2) * 1.7, 0.22, 1.0);
  }

  vec3 deep = uDeep;
  vec3 mid  = uMid;
  vec3 ice  = uIce;
  float drift = 0.5 + 0.5 * sin(uTime * 0.06);
  vec3 tint = mix(mid, uMid2, 0.35 + 0.35 * drift);

  // Mid-green base so the sheet reads as tinted glass; the lit side
  // brightens on top instead of popping from near-black.
  vec3 col = mix(deep, tint * 0.80, 0.30);
  col = mix(col, tint * (1.0 + 0.5 * drift), ndl * cav * shad);
  col += ice * spec * 0.55;
  col += ice * sheen * ndl;
  col += tint * fres * 0.5;

  // Glowing veins: thin bands where the flow field crests — light
  // refracting through thick ice.
  float vein = smoothstep(0.42, 0.50, h) * (1.0 - smoothstep(0.50, 0.64, h));
  col += uVein * vein * (0.2 + 0.8 * ndl) * 0.30;

  // A slow sweep of light, like something moving under the ice.
  float sweep = 0.5 + 0.5 * sin(uv.x * 2.6 + uv.y * 1.4 - uTime * 0.10);
  col += tint * smoothstep(0.80, 0.99, sweep) * (0.25 + 0.75 * fres) * 0.35;

  col *= 1.0 - 0.6 * uMelt;

  // Border/center split: box distance gives an even band all the way
  // around (edge midpoints and corners alike). The middle stays a thin,
  // mostly see-through film so the page behind stays readable; the band
  // condenses denser and goes a fuller, greener ice.
  float dBox  = max(abs(uv.x - 0.5) * 2.0, abs(uv.y - 0.5) * 2.0);
  float edge  = smoothstep(0.70, 0.97, dBox);
  col = mix(col, uEdge, edge * 0.60);
  float lit   = ndl * cav * shad;
  // Center: a thin film — enough alpha that the 3D material reads, but the
  // page behind stays readable (no blur to lean on). Border: dense.
  float a = 0.07 + 0.60 * edge + lit * 0.10;
  a += spec * 0.45 + vein * 0.12;
  a = min(a, 0.96);

  // ---- Glyph variation -------------------------------------------
  // The wave is a field of falling characters instead of a continuous
  // surface: the same heightfield (lit/cav/shad) modulates glyph
  // brightness so the ice's motion ripples through the digits, and a
  // per-column falling pulse (bright head, decaying tail) adds the rain
  // read. Cells re-scramble out of phase. Borders stay dense and green,
  // the center a sparse, dim scatter — the page behind stays readable.
  if (uGlyphMode > 0.5) {
    vec2 f = gl_FragCoord.xy / (uCell * (uRes.x / 1280.0));
    vec2 id = floor(f);
    vec2 guv = fract(f);
    float cseed = hash21(id);
    float bucket = floor(uTime * 1.6 + cseed * 19.0); // ~1 change per 0.6 s per cell
    float gi = mod(hash21(id + vec2(bucket * 7.13, bucket * 3.71)), 32.0);
    vec2 auv = vec2(
      (mod(gi, 8.0) + 0.055 + guv.x * 0.89) / 8.0,
      1.0 - (floor(gi / 8.0) + 0.055 + guv.y * 0.89) / 4.0
    );
    float glyph = texture2D(uAtlas, auv).a;
    // Per-column fall: random start, random speed, bright head + tail.
    float colSpd = 0.10 + 0.24 * hash1(id.x * 1.71);
    float d = fract((1.0 - uv.y) - fract(hash1(id.x * 3.17) + uTime * colSpd));
    float pulse = exp(-d * 10.0);
    // The wave is the surface brightness itself — characters light up in
    // the same bands the ice does, plus the falling pulse.
    float field = clamp(0.70 * lit + 0.30 * pulse, 0.0, 1.0);
    float b = 0.12 + 0.88 * field;
    // Dark etched characters, small and translucent: the only thing that
    // reads against the bright fluid band is dark-on-bright, and they're
    // light enough that the fluid stays as present as the frost. They lift
    // slightly at the crests so the wave still pulses through them.
    vec3 gcol = mix(uGlyphNear, uGlyphFar, b);
    // Dense at the border, sparse in the center.
    float on = step(0.55 - 0.55 * edge, hash21(id * 2.71 + 5.7));
    float aG = on * glyph * (0.25 + 0.40 * edge) * (0.35 + 0.45 * b);
    // Over the fluid, which stays fully present (no wall).
    float aT = aG + a * (1.0 - aG);
    col = (gcol * aG + col * a * (1.0 - aG)) / max(aT, 0.001);
    a = aT;
  }

  // Condensation: borders first, center last.
  float thr = 1.0 - 1.15 * uReveal;
  a *= smoothstep(thr - 0.30, thr + 0.15, edge);
  a *= 1.0 - uMelt * uMelt;
  gl_FragColor = vec4(col, a);
}
`

  const SNOW_VS = `
precision mediump float;
attribute float aSeed;
uniform vec2  uRes;
uniform float uTime;
uniform vec2  uPointer;
uniform float uReveal;
uniform float uMelt;
varying float vDepth;

float hash(float n) { return fract(sin(n) * 43758.5453123); }

void main() {
  float d  = hash(aSeed * 13.7);
  float s1 = hash(aSeed * 71.3);
  float s2 = hash(aSeed * 33.9);
  float speed = 0.05 + 0.16 * d;                 // near flakes fall faster
  float phase = fract(s2 - uTime * speed);
  float sway  = sin(uTime * (0.5 + 1.1 * d) + aSeed * 41.0) * (0.004 + 0.014 * d);
  float wind  = sin(uTime * 0.21 + s1 * 6.2831) * 0.012;
  float x = fract(s1 + sway + wind + uPointer.x * (0.004 + 0.022 * d));
  float y = 1.0 - phase;
  gl_Position = vec4(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = (2.0 + 13.0 * d * d) * (uRes.y / 800.0) * (0.55 + 0.45 * uReveal) * (1.0 - uMelt);
  vDepth = d * (1.0 - uMelt);
}
`

  const SNOW_FS = `
precision mediump float;
varying float vDepth;
uniform vec3  uSnowNear;
uniform vec3  uSnowFar;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  float body = smoothstep(1.0, 0.15, d);
  float core = smoothstep(0.55, 0.0, d);
  float a = body * (0.12 + 0.30 * vDepth) + core * (0.18 + 0.30 * vDepth);
  vec3 col = mix(uSnowNear, uSnowFar, vDepth);
  gl_FragColor = vec4(col, a);
}
`

  function compile(gl, type, src) {
    const s = gl.createShader(type)
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed')
    return s
  }

  function link(gl, vs, fs, attrs) {
    const p = gl.createProgram()
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs))
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs))
    attrs.forEach((a, i) => gl.bindAttribLocation(p, i, a))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(p) || 'program link failed')
    return p
  }

  function uniforms(gl, p, names) {
    const u = {}
    for (const n of names) u[n] = gl.getUniformLocation(p, n)
    return u
  }

  function resize() {
    if (!S.canvas) return
    const scale = TIER_SCALE[S.tier]
    S.canvas.width = Math.max(2, Math.round(innerWidth * scale))
    S.canvas.height = Math.max(2, Math.round(innerHeight * scale))
  }

  function initGL() {
    // Fallbacks: ?mode=fog (test hook in the lab preview) forces the CSS
    // fog so the old effect can be A/B-metrics'ed against the WebGL one —
    // the full animated v0.1.6 fog; prefers-reduced-motion gets the static
    // vignette (no drifting smoke).
    if (window.__dshAugForceFog || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) {
      buildFog(!!window.__dshAugForceFog)
      if (!S.raf) S.raf = requestAnimationFrame(tickFallback)
      setAccent(S.accentHue, S.accentBright) // re-tint the fog to the active accent
      return
    }
    try {
      const c = document.createElement('canvas')
      c.style.cssText = 'position:absolute; inset:0; width:100%; height:100%;'
      S.veil.append(c)
      S.canvas = c
      const opts = { alpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' }
      const gl =
        (typeof WebGLRenderingContext !== 'undefined' && c.getContext('webgl', opts)) ||
        c.getContext('experimental-webgl', opts)
      if (!gl) throw new Error('no webgl context')
      S.gl = gl

      const fp = link(gl, FROST_VS, FROST_FS, ['aPos'])
      S.frost = {
        prog: fp,
        u: uniforms(gl, fp, [
          'uRes', 'uTime', 'uReveal', 'uMelt', 'uPointer', 'uShadow',
          'uAtlas', 'uGlyphMode', 'uCell',
          'uDeep', 'uMid', 'uMid2', 'uIce', 'uVein', 'uEdge', 'uGlyphNear', 'uGlyphFar',
        ]),
      }
      // Uniform setters below apply to the CURRENT program — bind it first,
      // or they are silent no-ops and uGlyphMode would stay 0 (glyphs off).
      gl.useProgram(fp)
      // Glyph variation: bake the character atlas once (white on
      // transparent; the fragment shader reads the alpha channel).
      if (VARIATION === 'glyphs') {
        S.atlas = buildGlyphAtlas(gl)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, S.atlas)
        gl.uniform1i(S.frost.u.uAtlas, 0)
      }
      gl.uniform1f(S.frost.u.uGlyphMode, VARIATION === 'glyphs' ? 1.0 : 0.0)
      gl.uniform2f(S.frost.u.uCell, GLYPH_CELL, GLYPH_CELL)
      const sp = link(gl, SNOW_VS, SNOW_FS, ['aSeed'])
      S.snow = {
        prog: sp,
        u: uniforms(gl, sp, ['uRes', 'uTime', 'uPointer', 'uReveal', 'uMelt', 'uSnowNear', 'uSnowFar']),
      }

      S.quadBuf = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, S.quadBuf)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
      const seeds = new Float32Array(SNOW_COUNT)
      for (let i = 0; i < SNOW_COUNT; i++) seeds[i] = i / SNOW_COUNT
      S.snowBuf = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, S.snowBuf)
      gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW)

      // No backdrop blur: the page behind must stay fully readable — the
      // see-through quality comes from the low center alpha only.
      S.mode = 'webgl'
      publishState()
      S.t0 = performance.now()
      S.lastT = S.t0
      window.addEventListener('resize', resize)
      resize()
      setAccent(S.accentHue, S.accentBright) // upload the palette uniforms into the new GL
      if (!S.raf) S.raf = requestAnimationFrame(frame)
    } catch (err) {
      console.warn('veil: webgl unavailable, using css fog fallback', err)
      buildFog(true)
      if (!S.raf) S.raf = requestAnimationFrame(tickFallback)
      setAccent(S.accentHue, S.accentBright) // re-tint the fallback fog
    }
  }

  function tickFallback(now) {
    if (!S.root || !S.veil.isConnected) { S.raf = 0; return }
    S.raf = requestAnimationFrame(tickFallback)
    const dt = Math.min(0.1, (now - S.lastT) / 1000)
    S.lastT = now
    if (!S.melting) S.reveal = S.revealStart ? easeOutCubic(Math.min(1, (now - S.revealStart) / REVEAL_MS)) : 1
    if (S.melting) {
      S.melt = easeInQuad(Math.min(1, (now - S.meltStart) / MELT_MS))
      if (S.melt >= 1 && S.veil.style.opacity !== '0') S.veil.style.opacity = '0'
    }
  }

  // ---------------------------------------------------------- loop
  function frame(now) {
    if (!S.root || !S.canvas || !S.canvas.isConnected) {
      S.raf = 0
      return
    }
    S.raf = requestAnimationFrame(frame)
    const dt = Math.min(0.1, (now - S.lastT) / 1000)
    S.lastT = now
    S.acc += dt
    S.frames++
    S.total++
    if (S.acc >= 1.0) {
      S.fps = S.frames / S.acc
      S.acc = 0
      S.frames = 0
      publishState()
    }
    // Timeline
    if (!S.melting)
      S.reveal = S.revealStart ? easeOutCubic(Math.min(1, (now - S.revealStart) / REVEAL_MS)) : 1
    if (S.melting) {
      S.melt = easeInQuad(Math.min(1, (now - S.meltStart) / MELT_MS))
      if (S.melt >= 1 && S.veil.style.opacity !== '0') S.veil.style.opacity = '0'
    }
    // Pointer smoothing (critical damping-ish)
    const k = Math.min(1, dt * 4.0)
    S.px += (S.tx - S.px) * k
    S.py += (S.ty - S.py) * k
    // Adaptive quality: drop to the low tier after a few slow seconds.
    if (S.tier === 1 && S.fps > 0 && S.fps < 34) {
      if (++S.slow >= 3) {
        S.tier = 0
        S.shadowOn = false
        resize()
      }
    } else S.slow = 0

    const gl = S.gl
    const t = (now - S.t0) / 1000
    gl.viewport(0, 0, S.canvas.width, S.canvas.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    // Frost sheet
    gl.useProgram(S.frost.prog)
    gl.uniform2f(S.frost.u.uRes, S.canvas.width, S.canvas.height)
    gl.uniform1f(S.frost.u.uTime, t)
    gl.uniform1f(S.frost.u.uReveal, S.reveal)
    gl.uniform1f(S.frost.u.uMelt, S.melt)
    gl.uniform2f(S.frost.u.uPointer, S.px, S.py)
    gl.uniform1f(S.frost.u.uShadow, S.shadowOn ? 1 : 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, S.quadBuf)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    // Snowfall
    gl.useProgram(S.snow.prog)
    gl.uniform2f(S.snow.u.uRes, S.canvas.width, S.canvas.height)
    gl.uniform1f(S.snow.u.uTime, t)
    gl.uniform2f(S.snow.u.uPointer, S.px, S.py)
    gl.uniform1f(S.snow.u.uReveal, S.reveal)
    gl.uniform1f(S.snow.u.uMelt, S.melt)
    gl.bindBuffer(gl.ARRAY_BUFFER, S.snowBuf)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 0, 0)
    gl.drawArrays(gl.POINTS, 0, SNOW_COUNT)
  }

  // ---------------------------------------------------------- api
  // `accentHue` (0..360) + `accentBright` (−15..15), both from the
  // user's side-panel accent settings, re-tint the whole effect. Omitted
  // / non-finite keeps the original green (142, 0), which the lab uses for
  // A/B parity against the pre-accent effect.
  function show(text, done, accentHue, accentBright) {
    // A veil already fully up (revealed, not melting, not fading) is
    // updated in place: the label/dot refresh, but the field keeps flowing
    // and the condensation is not replayed. The SW calls show() on every
    // action of a turn — without this guard the effect would dissolve and
    // re-condense on each one instead of holding for the whole turn.
    const wasUp = !!(
      S.root && S.root.isConnected && !S.melting &&
      S.reveal >= 1 && S.root.style.opacity !== '0'
    )
    ensure()
    if (S.mode === 'none') initGL()
    setAccent(accentHue, accentBright)
    clearTimeout(S.fadeTimer)
    S.root.style.opacity = '1'
    S.pill.style.opacity = '1'
    const now = performance.now()
    const p = S.pal
    S.dot.style.background = rgb(done ? p.dotDone : p.dot)
    S.dot.style.animation = done ? 'none' : '__dshAugPulse 1.2s ease-in-out infinite'
    S.label.textContent = done ? 'Augmentor — done ✓' : `Augmentor — ${String(text)}`
    S.veil.style.opacity = '1'
    if (done) {
      if (!S.melting) {
        S.melting = true
        S.meltStart = now
      }
    } else if (!wasUp) {
      // First show on this document, or resuming after "Done"/a fade:
      S.melting = false
      S.melt = 0
      S.revealStart = now
      S.reveal = 0
      S.t0 = now // restart the field's clock with the condensation
    }
    if (!S.raf) {
      S.lastT = now
      S.raf = requestAnimationFrame(S.mode === 'fallback' ? tickFallback : frame)
    }
    return 'shown'
  }

  function fade() {
    if (!S.root) return 'absent'
    const root = S.root
    root.style.transition = 'opacity 0.6s ease'
    root.style.opacity = '0'
    S.fadeTimer = setTimeout(() => {
      if (root.isConnected) root.remove()
      S.root = null
      S.veil = null
      S.mode = 'none'
      S.canvas = null
      S.gl = null
      S.atlas = null
      S.fogDivs = []
      S.raf = 0
      S.melting = false
      S.melt = 0
    }, FADE_MS)
    return 'fading'
  }

  window.__dshAugVeil = {
    show,
    fade,
    pointer(x, y) {
      S.tx = clamp(x)
      S.ty = clamp(y)
    },
    debug() {
      return {
        mode: S.mode,
        var: VARIATION,
        accent: S.accentHue,
        accentBright: S.accentBright,
        tier: S.tier,
        fps: Math.round(S.fps),
        total: S.total,
        frames: S.frames,
        reveal: +S.reveal.toFixed(2),
        melt: +S.melt.toFixed(2),
        pointer: [+S.px.toFixed(2), +S.py.toFixed(2)],
      }
    },
  }
  return window.__dshAugVeil
})()
