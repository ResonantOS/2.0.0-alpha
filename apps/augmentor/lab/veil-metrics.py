#!/usr/bin/env python3

# Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
# Copyright © 2026 Manolo Remiddi
# SPDX-License-Identifier: MIT
# License: MIT — see LICENSE at the repository root.

"""Quantitative surrogate for visual judgment of the frost veil.

Compares screenshots (with veil, without veil / old fog) on the axes the
brief cares about:

  see-through      luminance correlation of the center region vs the bare page
  3D / relief      luminance std + laplacian (texture) energy in the center
  highlights       count + centroid of near-white glints (specular/snow)
  shadows          count of near-black pixels in the center (cavity shadow)
  green family     g-r and g-b deltas (green must lead, not white/blue)
  edge density     edges must read denser/greener than the center (vignette)
  fluid motion     mean abs diff between two frames, full vs 1/8 low-freq
  parallax         glint-centroid displacement between two pointer positions

Usage:
  python3 veil-metrics.py shot.png [--ref bare.png] [--label name]
  python3 veil-metrics.py a.png b.png            # motion/parallax between frames
  python3 veil-metrics.py a.png b.png --ref c.png
"""
import argparse
import json
import sys

import numpy as np
from PIL import Image


def load(path):
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)


def region(img, x0, x1, y0, y1):
    h, w, _ = img.shape
    return img[int(h * y0): int(h * y1), int(w * x0): int(w * x1)]


def lum(r):
    return 0.2126 * r[..., 0] + 0.7152 * r[..., 1] + 0.0722 * r[..., 2]


def lap_var(r):
    l = lum(r)
    lap = l[2:, 1:-1] + l[:-2, 1:-1] + l[1:-1, 2:] + l[1:-1, :-2] - 4 * l[1:-1, 1:-1]
    return float(lap.var())


def analyze(img, label):
    h, w, _ = img.shape
    center = region(img, 0.35, 0.65, 0.30, 0.70)
    edges = np.concatenate(
        [
            region(img, 0.0, 0.04, 0.0, 1.0).reshape(-1, 3),
            region(img, 0.96, 1.0, 0.0, 1.0).reshape(-1, 3),
            region(img, 0.0, 1.0, 0.0, 0.04).reshape(-1, 3),
            region(img, 0.0, 1.0, 0.96, 1.0).reshape(-1, 3),
        ],
        axis=0,
    )
    cl, el = lum(center), lum(edges)
    glints = cl > 232
    dark = cl < 60
    cx, cy = (
        float(np.where(glints)[1].mean()),
        float(np.where(glints)[0].mean()),
    ) if glints.any() else (None, None)
    out = {
        "label": label,
        "size": [w, h],
        "center_mean_rgb": [round(v, 1) for v in center.reshape(-1, 3).mean(0)],
        "center_lum": round(float(cl.mean()), 1),
        "center_relief": round(float(cl.std()), 2),
        "center_texture": round(lap_var(center), 1),
        "center_glints": int(glints.sum()),
        "center_dark": int(dark.sum()),
        "glint_centroid": [round(cx, 1), round(cy, 1)] if cx is not None else None,
        "center_gr": round(float(center[..., 1].mean() - center[..., 0].mean()), 1),
        "center_gb": round(float(center[..., 1].mean() - center[..., 2].mean()), 1),
        "edge_mean_rgb": [round(v, 1) for v in edges.mean(0)],
        "edge_lum": round(float(el.mean()), 1),
        "edge_gr": round(float(edges[:, 1].mean() - edges[:, 0].mean()), 1),
        "edge_gb": round(float(edges[:, 1].mean() - edges[:, 2].mean()), 1),
        "edge_density": round(float(el.mean() / max(cl.mean(), 1e-3)), 3),
    }
    return out


def ref_check(img, ref):
    a = lum(region(img, 0.35, 0.65, 0.30, 0.70))
    b = lum(region(ref, 0.35, 0.65, 0.30, 0.70))
    corr = float(np.corrcoef(a.ravel(), b.ravel())[0, 1])
    d = a - b
    # Veil-added high-frequency content (relief + micro-facets + glints),
    # isolated from the page's own texture.
    lap = d[2:, 1:-1] + d[:-2, 1:-1] + d[1:-1, 2:] + d[1:-1, :-2] - 4 * d[1:-1, 1:-1]
    new_bright = (a > 235) & (b < 210)
    new_dark = (a < 100) & (b > 140)
    nbc = (float(np.where(new_bright)[1].mean()), float(np.where(new_bright)[0].mean())) if new_bright.any() else (None, None)
    out = analyze(img, "ref")
    out["see_through_corr"] = round(corr, 4)
    out["center_shift"] = round(float(a.mean() - b.mean()), 1)
    out["veil_mod_depth"] = round(float(d.std()), 2)
    out["veil_added_texture"] = round(float(lap.var()), 1)
    out["veil_new_bright_px"] = int(new_bright.sum())
    out["veil_new_dark_px"] = int(new_dark.sum())
    out["veil_new_bright_centroid"] = [round(nbc[0], 1), round(nbc[1], 1)] if nbc[0] is not None else None
    return out


def diff(a, b, label):
    ca = region(a, 0.35, 0.65, 0.30, 0.70)
    cb = region(b, 0.35, 0.65, 0.30, 0.70)
    da = ca[::8, ::8]
    db = cb[::8, ::8]
    la, lb = lum(a), lum(b)
    gla, glb = la > 232, lb > 232
    ca_c = (float(np.where(gla)[1].mean()), float(np.where(gla)[0].mean())) if gla.any() else None
    cb_c = (float(np.where(glb)[1].mean()), float(np.where(glb)[0].mean())) if glb.any() else None
    disp = None
    if ca_c and cb_c:
        disp = round(float(np.hypot(ca_c[0] - cb_c[0], ca_c[1] - cb_c[1])), 1)
    return {
        "label": label,
        "mad_center": round(float(np.abs(ca - cb).mean()), 2),
        "mad_lowfreq": round(float(np.abs(da - db).mean()), 2),
        "mad_full": round(float(np.abs(la - lb).mean()), 2),
        "glint_centroid_displacement": disp,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("imgs", nargs="+")
    ap.add_argument("--ref", help="bare-page screenshot for the see-through correlation")
    ap.add_argument("--label", default=None)
    args = ap.parse_args()
    imgs = [load(p) for p in args.imgs]
    results = []
    if len(imgs) == 1:
        if args.ref:
            results.append(ref_check(imgs[0], load(args.ref)))
        else:
            results.append(analyze(imgs[0], args.label or args.imgs[0]))
    else:
        for a, b in zip(imgs[:-1], imgs[1:]):
            results.append(diff(a, b, "diff"))
        if args.ref:
            results.append(ref_check(imgs[0], load(args.ref)))
    def _py(o):
        if isinstance(o, np.generic):
            return o.item()
        return o
    print(json.dumps(results, indent=2, default=_py))


if __name__ == "__main__":
    main()
