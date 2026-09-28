#!/usr/bin/env python3

# Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
# Copyright © 2026 Manolo Remiddi
# SPDX-License-Identifier: MIT
# License: MIT — see LICENSE at the repository root.

"""Overlay verification driver (lab). Drives cdp.mjs / dsh-browser.mjs and
asserts DOM + pixel state. Usage: python3 lab-overlay-verify.py <stage>
stages:
  snap      relay snapshot -> DOM asserts + pixel shot
            (mode-branch: webgl asserts canvas + live frame counter,
             fallback asserts the 3-layer CSS fog + drift)
  click     relay click h1 -> pulse/ripple asserts + pixel shot
  nav       relay navigate wikipedia -> label/veil asserts + pixel shot
  fade      wait 5s -> overlay gone
  noblock   elementFromPoint over the pill returns page content
  textturn  regression: a text-only turn (no browser use) must raise the
            veil NOWHERE — not at prompt time, not a "done ✓" at the end
"""
import json
import os
import subprocess
import sys
import time

BASE = os.path.dirname(os.path.abspath(__file__))
WORK, PANEL = "68C944C1DB226792EEE7A7FCADBBB990", "62D5B457710ACBC5B19232547102B025"
CDP = ["env", "CDP_PORT=9224", "node", "cdp.mjs"]

FAILS = []


def run(*args, timeout=120):
    r = subprocess.run(list(args), cwd=BASE, capture_output=True, text=True, timeout=timeout)
    return r


def cdp(*args):
    r = run(*CDP, *args)
    if r.returncode != 0:
        raise RuntimeError(f"cdp {' '.join(args[:2])} failed: {r.stderr.strip()}")
    return r.stdout.strip()


def ev(target, expr):
    out = cdp("eval", target, expr)
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return out


def relay(action_obj, timeout=60):
    r = run("node", "dsh-browser.mjs", json.dumps(action_obj), timeout=timeout)
    return json.loads(r.stdout.strip() or "{}")


def shot(out):
    cdp("shot", WORK, out)


def check(name, cond, extra=""):
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  ({extra})" if extra else ""))
    if not cond:
        FAILS.append(name)


def hsl_to_rgb(h, s, l):
    """Mirror of the JS hslToRgb in veil.js / theme-tokens.js
    (Math.round(v) for v >= 0 is int(v + 0.5))."""
    h = ((h % 360) + 360) % 360
    s, l = s / 100, l / 100
    c = (1 - abs(2 * l - 1)) * s
    hp = h / 60
    x = c * (1 - abs((hp % 2) - 1))
    if hp < 1:
        r, g, b = c, x, 0
    elif hp < 2:
        r, g, b = x, c, 0
    elif hp < 3:
        r, g, b = 0, c, x
    elif hp < 4:
        r, g, b = 0, x, c
    elif hp < 5:
        r, g, b = x, 0, c
    else:
        r, g, b = c, 0, x
    m = l - c / 2
    return [int((r + m) * 255 + 0.5), int((g + m) * 255 + 0.5), int((b + m) * 255 + 0.5)]


def accent_dot(hue):
    """The veil's status-dot color for an accent hue: the VEIL_SPEC 'dot'
    role (offset 0, s 70.6, l 45.3) — see veilPalette in veil.js /
    theme-tokens.js."""
    return hsl_to_rgb(hue, 70.6, 45.3)


def overlay_state():
    """Probe the overlay from the page's MAIN world. The veil's JS lives in
    the content-script isolated world, so live state (mode, fps, frame
    counter, accent hue) is bridged through root.dataset.veil by veil.js
    itself. children[0] is the visual layer: a <canvas> in webgl mode, 3
    fog divs in the CSS-fallback mode; children[1] is the pill."""
    return ev(WORK, """(() => {
      const root = document.getElementById('__dshAugOverlay')
      if (!root) return { present: false }
      const [veil, pill] = root.children
      const [dot, label] = pill.children
      const pr = pill.getBoundingClientRect()
      let vs = null
      try { vs = JSON.parse(root.dataset.veil || 'null') } catch (e) {}
      return {
        present: true,
        label: label.textContent,
        pillOpacity: getComputedStyle(pill).opacity,
        fogOpacity: getComputedStyle(veil).opacity,
        veilMode: vs ? vs.m : null,
        fps: vs ? vs.f : null,
        total: vs ? vs.t : null,
        accentHue: vs ? vs.a : null,
        veilChildren: [...veil.children].map(c => c.tagName.toLowerCase()),
        fogLayers: veil.children.length,
        fogBg: veil.children[0] ? getComputedStyle(veil.children[0]).backgroundImage.slice(0, 30) : '',
        fogAAnim: veil.children[1] ? getComputedStyle(veil.children[1]).animationName : null,
        fogBAnim: veil.children[2] ? getComputedStyle(veil.children[2]).animationName : null,
        fogATransform: veil.children[1] ? getComputedStyle(veil.children[1]).transform : null,
        fogAnim: getComputedStyle(veil).animationName,
        dotColor: getComputedStyle(dot).backgroundColor,
        dotAnim: getComputedStyle(dot).animationName,
        pillBottomCentered: Math.abs((pr.left + pr.width / 2) - innerWidth / 2) < 12
          && Math.abs((innerHeight - pr.bottom) - 20) < 12,
        rootDisplay: getComputedStyle(root).display,
      }
    })()""")


def tinted(r, g, b):
    """Hue-agnostic accent test: the veil tints pixels toward the user's
    accent (any hue), so the signature is saturation, not a green channel:
    the channel spread must be clearly non-neutral. (The pre-accent
    signature was g-r > 40 and g-b > 30.)"""
    mx = max(r, g, b)
    md = sorted((r, g, b))[1]
    mn = min(r, g, b)
    return (mx - mn) > 35 and (mx - md) > 15


def fog_pixel_present(png):
    """Veil/fog: accent tint dense at the borders. Works for the WebGL
    frost rim as for the legacy fog gradient, in ANY accent hue."""
    from PIL import Image
    im = Image.open(png).convert("RGB")
    w, h = im.size
    px = im.load()
    hits = 0
    # left edge column 0..3, full height
    for y in range(0, h, 4):
        for x in range(0, 4):
            r, g, b = px[x, y]
            if tinted(r, g, b):
                hits += 1
    return hits, (w, h)


def pill_bottom_dark_pixels(png):
    """Bottom-center pill: dark rounded box at the bottom of the viewport."""
    from PIL import Image
    im = Image.open(png).convert("RGB")
    w, h = im.size
    px = im.load()
    dark = 0
    for x in range(int(w / 2 - 160), int(w / 2 + 160), 3):
        for y in range(h - 80, h - 8, 3):
            r, g, b = px[x, y]
            if r < 60 and g < 60 and b < 80:
                dark += 1
    return dark, (w, h)


def center_vs_edge_green(png):
    """Fog shape: center should be far less accent-tinted than the borders
    (see-through middle, dense veil at the edges). Hue-agnostic."""
    from PIL import Image
    im = Image.open(png).convert("RGB")
    w, h = im.size
    px = im.load()

    def greenish(r, g, b):
        return tinted(r, g, b)

    center = 0
    for x in range(int(w / 2 - 160), int(w / 2 + 160), 3):
        for y in range(int(h / 2 - 45), int(h / 2 + 45), 3):
            r, g, b = px[x, y]
            if greenish(r, g, b):
                center += 1
    edge = 0
    for y in range(0, h, 4):
        for x in range(0, 4):
            r, g, b = px[x, y]
            if greenish(r, g, b):
                edge += 1
    return center, edge, (w, h)


stage = sys.argv[1]

if stage == "snap":
    res = relay({"action": "snapshot"})
    check("relay ok", res.get("ok") is True)
    txt = res.get("text", "")
    check("snapshot text clean (no badge leak)", "Augmentor" not in txt and "Analysing" not in txt)
    check("snapshot has page text", "Example Domain" in txt)
    time.sleep(1.0)  # let the pill/veil fade-in transitions finish before the shot
    shot("/tmp/ov-snap.png")
    st = overlay_state()
    print("   overlay:", json.dumps(st))
    check("overlay present", st.get("present") is True)
    check("label = 'Augmentor — Analysing the page…'", st.get("label") == "Augmentor — Analysing the page…")
    check("pill visible", st.get("pillOpacity") == "1")
    check("pill at bottom-center of viewport", st.get("pillBottomCentered") is True)
    check("veil visible", st.get("fogOpacity") == "1")
    hue = st.get("accentHue")
    check("accent hue published", isinstance(hue, (int, float)), str(hue))
    if isinstance(hue, (int, float)):
        exp = accent_dot(hue)
        check(
            "dot matches the user's accent palette",
            st.get("dotColor") == f"rgb({exp[0]}, {exp[1]}, {exp[2]})",
            f"got {st.get('dotColor')} expected rgb({exp[0]}, {exp[1]}, {exp[2]}) for hue {hue}",
        )
    check("dot pulse animation running", st.get("dotAnim") == "__dshAugPulse", str(st.get("dotAnim")))
    mode = st.get("veilMode")
    if mode == "webgl":
        check("veil layer is a WebGL canvas", "canvas" in (st.get("veilChildren") or []), str(st.get("veilChildren")))
        # liveness: the frost loop advances the frame counter (bridged via dataset)
        t1 = st.get("total")
        time.sleep(1.3)
        t2 = overlay_state().get("total")
        check("frost loop alive (frame counter advancing)", t1 is not None and t2 is not None and t2 > t1,
              f"total {t1} -> {t2}")
    elif mode == "fallback":
        check("fog has 3 layers (vignette + 2 smoke)", st.get("fogLayers") == 3, str(st.get("fogLayers")))
        check("vignette is radial gradient", "radial-gradient" in (st.get("fogBg") or ""), str(st.get("fogBg")))
        check("smoke layer A drifting", st.get("fogAAnim") == "__dshAugFogA", str(st.get("fogAAnim")))
        check("smoke layer B drifting", st.get("fogBAnim") == "__dshAugFogB", str(st.get("fogBAnim")))
        check("fog breathing animation running", st.get("fogAnim") == "__dshAugFog", str(st.get("fogAnim")))
        # smoke is actually moving: sample layer A's transform 1.5 s apart
        tr1 = st.get("fogATransform")
        time.sleep(1.5)
        tr2 = overlay_state().get("fogATransform")
        check("smoke layer A is moving (transform changes)", tr1 != tr2, f"{tr1} -> {tr2}")
    else:
        check("veil mode is webgl or fallback", False, f"mode={mode} children={st.get('veilChildren')}")
    dark, size = pill_bottom_dark_pixels("/tmp/ov-snap.png")
    check("pill pixels at bottom-center", dark > 30, f"darkpx={dark} size={size}")
    hits, _ = fog_pixel_present("/tmp/ov-snap.png")
    check("accent-tinted veil pixels on left edge", hits > 20, f"tintedpx={hits}")
    cgreen, egreen, _ = center_vs_edge_green("/tmp/ov-snap.png")
    check("center see-through vs dense borders", egreen > 50 and cgreen < max(10, egreen // 3),
          f"center={cgreen} edge={egreen}")

elif stage == "click":
    st = overlay_state()
    # make sure overlay is up (snap stage's 4s fade may have passed)
    if not st.get("present"):
        relay({"action": "snapshot"})
    t0 = time.time()
    res = relay({"action": "click", "selector": "h1"})
    dt = time.time() - t0
    check("relay ok", res.get("ok") is True, f"{dt:.1f}s")
    check("clicked h1", res.get("tag") == "h1", json.dumps(res))
    # DOM: ripple div present? h1 boxShadow mid-animation?
    ripple = ev(WORK, """(() => {
      const els = [...document.querySelectorAll('body > div')]
      const r = els.filter(d => d.style.position === 'fixed'
        && d.style.zIndex === '2147483647' && d.id !== '__dshAugOverlay')
      return { ripples: r.length, h1shadow: getComputedStyle(document.querySelector('h1')).boxShadow.slice(0, 120) }
    })()""")
    print("   ripple state:", json.dumps(ripple))
    check("ripple div present", ripple["ripples"] >= 1, json.dumps(ripple))
    hue = overlay_state().get("accentHue")  # fresh: st predates the click
    if isinstance(hue, (int, float)):
        c = accent_dot(hue)
        check(
            "h1 boxShadow animated in the accent color",
            f"rgba({c[0]}, {c[1]}, {c[2]}" in ripple["h1shadow"],
            ripple["h1shadow"],
        )
    else:
        check("h1 boxShadow animated in the accent color", False, "accent hue not published")
    time.sleep(0.5)  # let the after-action label update land
    st = overlay_state()
    check("label = 'Augmentor — Clicked on Example Domain'", st.get("label") == "Augmentor — Clicked on Example Domain", str(st.get("label")))
    shot("/tmp/ov-click.png")

elif stage == "nav":
    res = relay({"action": "navigate", "url": "https://www.wikipedia.org/"})
    check("relay ok", res.get("ok") is True, json.dumps(res)[:160])
    check("navigated to wikipedia", "wikipedia" in (res.get("url") or ""))
    # wait a beat for the re-injection to settle
    time.sleep(1.5)
    st = overlay_state()
    print("   overlay:", json.dumps(st))
    check("overlay re-injected on new page", st.get("present") is True)
    check("label = 'Augmentor — Opened www.wikipedia.org'", st.get("label") == "Augmentor — Opened www.wikipedia.org", str(st.get("label")))
    shot("/tmp/ov-nav.png")
    hits, _ = fog_pixel_present("/tmp/ov-nav.png")
    check("accent-tinted veil pixels on wikipedia", hits > 20, f"tintedpx={hits}")

elif stage == "fade":
    # Re-show, confirm visible, then confirm the 4s idle fade removes it.
    relay({"action": "snapshot"})
    time.sleep(0.5)
    st0 = overlay_state()
    check("overlay re-shown", st0.get("present") is True and st0.get("pillOpacity") == "1")
    time.sleep(5.5)
    st = overlay_state()
    print("   overlay after 5.5s:", json.dumps(st))
    check("overlay faded away (removed)", st.get("present") is False)

elif stage == "noblock":
    # ensure overlay is visible
    relay({"action": "snapshot"})
    time.sleep(0.3)
    res = ev(WORK, """(() => {
      const root = document.getElementById('__dshAugOverlay')
      if (!root) return { err: 'no overlay' }
      const pill = root.children[1]
      const r = pill.getBoundingClientRect()
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      const inOverlay = !!(el && (el === root || root.contains(el)))
      return { inOverlay, under: el ? (el.tagName + '.' + (el.className || '').toString().slice(0, 40)) : null }
    })()""")
    print("   noblock:", json.dumps(res))
    check("clicks pass through the pill", res.get("inOverlay") is False, json.dumps(res))

elif stage == "turn":
    # Full model turn through the panel; record every badge transition.
    prompt = sys.argv[2] if len(sys.argv) > 2 else (
        "Click the Wikipedia search box, type 'DeepSeek' into it, "
        "then tell me what text is now in the search box."
    )
    ev(PANEL, f"""(() => {{
      const i = document.querySelector('#input')
      i.value = {json.dumps(prompt)}
      i.dispatchEvent(new Event('input', {{ bubbles: true }}))
      document.querySelector('#send').click()
      return 'sent'
    }})()""")
    seen = []
    last = None
    done_at = None
    first_label_at = None
    absent_midturn = 0
    deadline = time.time() + 180
    while time.time() < deadline:
        time.sleep(1)
        st = overlay_state()
        label = st.get("label") if st.get("present") else None
        if label:
            if first_label_at is None:
                first_label_at = time.time()
            if label != last:
                seen.append((round(time.time() - deadline + 180, 1), label, st.get("dotColor"), st.get("fogOpacity")))
                last = label
                print(f"   t+{180 - (deadline - time.time()):4.1f}s  {label}  dot={st.get('dotColor')} fog={st.get('fogOpacity')}")
        elif first_label_at is not None and done_at is None:
            absent_midturn += 1  # overlay vanished while the turn was still running
        if label == "Augmentor — done ✓" and done_at is None:
            done_at = time.time()
            shot("/tmp/ov-turn-done.png")
        if done_at and time.time() - done_at > 4.5:
            break
    print("   transitions:", len(seen), " mid-turn absences:", absent_midturn)
    joined = " | ".join(l for _, l, _, _ in seen)
    check("turn reached done ✓", done_at is not None, joined)
    check("overlay persisted through the whole turn (no mid-turn fade)", absent_midturn == 0,
          f"absences={absent_midturn}")
    # The veil follows the agent's actions (no more "Thinking…" at prompt
    # time): at least one live action state must have been visible.
    check("saw a live action state (Analysing/Opening/Clicking/Typing/Inspecting) during the turn",
          any(any(k in l for k in ("Analysing", "Opening", "Clicking", "Typing", "Inspecting")) for _, l, _, _ in seen), joined)
    if "click" in prompt.lower():
        check("saw Clicking/Clicked on", any("Clicking" in l or "Clicked on" in l for _, l, _, _ in seen), joined)
    check("saw Typing/Typed into", any("Typing" in l or "Typed into" in l for _, l, _, _ in seen), joined)
    if done_at:
        st_done = overlay_state()
        time.sleep(4.5)
        st_after = overlay_state()
        check("faded after done", st_after.get("present") is False, json.dumps(st_after))
        chat = ev(PANEL, "document.querySelector('#log')?.innerText?.slice(-400)")
        print("   chat tail:", (chat or "")[-250:])
        check("model answered about the search box", "DeepSeek" in (chat or ""))

elif stage == "textturn":
    # Regression for the false trigger: a turn that never uses the browser
    # (e.g. "correct this text I wrote") must raise the veil NOWHERE — not
    # "Thinking…" at prompt time, not a phantom "done ✓" at the end.
    prompt = sys.argv[2] if len(sys.argv) > 2 else (
        "Do not use any tools. Correct the grammar of this sentence and reply "
        "with the corrected sentence only: 'i has been wrote this sentsense with bad grammer'"
    )
    # Clean slate: a veil left by an earlier stage fades on its own — wait for it.
    for _ in range(16):
        if not overlay_state().get("present"):
            break
        time.sleep(0.5)
    st0 = overlay_state()
    check("clean slate (no overlay before the turn)", st0.get("present") is False, json.dumps(st0))
    log_before = ev(PANEL, "document.querySelector('#log')?.innerText?.length || 0")
    ev(PANEL, f"""(() => {{
      const i = document.querySelector('#input')
      i.value = {json.dumps(prompt)}
      i.dispatchEvent(new Event('input', {{ bubbles: true }}))
      document.querySelector('#send').click()
      return 'sent'
    }})()""")
    # End = send re-enabled AND a new answer in the log (the 'running' flag
    # lags the prompt by one status event; a 5s floor skips that window).
    start = time.time()
    sightings = []
    ended = False
    deadline = start + 180
    while time.time() < deadline:
        time.sleep(0.5)
        st = overlay_state()
        if st.get("present"):
            sightings.append(st.get("label"))
        send_enabled = ev(PANEL, "document.querySelector('#send')?.disabled === false")
        log_now = ev(PANEL, "document.querySelector('#log')?.innerText?.length || 0")
        if send_enabled and log_now > log_before and time.time() - start > 5:
            ended = True
            break
    check("text-only turn completed", ended)
    # Give a late phantom "done ✓" a chance to appear, then confirm nothing is up.
    time.sleep(6)
    late = overlay_state()
    print("   veil sightings:", sightings or "none", "  late:", json.dumps(late))
    check("veil never appeared during a text-only turn", not sightings, str(sightings[:5]))
    check("no phantom 'done ✓' after the turn", late.get("present") is False, json.dumps(late))
    log_after = ev(PANEL, "document.querySelector('#log')?.innerText?.length || 0")
    check("model actually answered (log grew)", log_after > log_before, f"{log_before} -> {log_after}")
else:
    print("unknown stage", stage)
    sys.exit(2)

print("STAGE-DONE", "FAILS=" + str(len(FAILS)) if FAILS else "STAGE-DONE all-pass")
sys.exit(1 if FAILS else 0)
