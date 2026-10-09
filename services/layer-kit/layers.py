"""
Pixel-registered layer set from ONE master and its in-place edits (flexiprint://guide/layer-rules).

Three steps, each reviewed (and fixed by hand) on the page before the next:
  1. matte   the master without its backdrop (matte_white) — the editor fixes the alpha
  2. plan    the region of every layer on its picture (regions_*) — the editor fixes the regions
  3. cut     the files: region × the picture's subject alpha, recolours, back / front of wrapping parts (cut)

Inputs (all the same canvas once resized to the master — every edit is an in-place edit):
  master   the working master (approved master, upscaled)
  base     the master with every "shape" part removed (bald heads, no hats…); = master when there is none
  per slot:
    color    mask   magenta edit of the BASE → which pixels are the part; options = hex → recolour base pixels
    texture  mask   (same); options[0] = base pixels, options[i] = the texture edit's pixels inside the mask
    shape    part   magenta edit of the MASTER (only to split the master's parts between shape slots)
             options[0] = master − base (inside the part mask), options[i] = edit − base; colours = recolours;
             wraps → back (whole part, under the body) + front (the part lying over the body, on top)
  photo zones: magenta edit of the base → polygon (the customer photo is clipped to it)

Every file is cropped by ONE common rectangle; transparent pixels carry no colour.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np
from scipy import ndimage as ndi


# ---- small image helpers ---------------------------------------------------------------------------------

def to_lab(c: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(c.astype(np.float32), cv2.COLOR_RGB2LAB)


def from_lab(lab: np.ndarray) -> np.ndarray:
    return np.clip(cv2.cvtColor(lab.astype(np.float32), cv2.COLOR_LAB2RGB), 0, 1)


def kernel(r: int) -> np.ndarray:
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))


def clean(mask: np.ndarray, open_r: int = 2, close_r: int = 4, min_px: int = 600) -> np.ndarray:
    m = mask.astype(np.uint8)
    if open_r:
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, kernel(open_r))
    if close_r:
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, kernel(close_r))
    lab, n = ndi.label(m)
    if n:
        sizes = ndi.sum(m, lab, range(1, n + 1))
        m = np.isin(lab, [i + 1 for i, s in enumerate(sizes) if s >= min_px]).astype(np.uint8)
    return m.astype(bool)


def soft(mask: np.ndarray, grow: int = 1, blur: float = 1.2) -> np.ndarray:
    m = mask.astype(np.uint8)
    if grow:
        m = cv2.dilate(m, kernel(grow))
    return np.clip(cv2.GaussianBlur(m.astype(np.float32), (0, 0), blur), 0, 1)


def hex_rgb(h: str) -> np.ndarray:
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], np.float32) / 255


def recolor(colour: np.ndarray, alpha: np.ndarray, target_hex: str | None, tint: float = 0.4, spread: float = 1.0) -> np.ndarray:
    """Keep the part's own shading (L around its mean), move its colour to the target. Same alpha → same pixels."""
    if not target_hex:
        return colour
    tl = to_lab(hex_rgb(target_hex)[None, None])[0, 0]
    lab = to_lab(colour)
    sel = alpha > 0.5
    if sel.sum() < 10:
        return colour
    lm, am, bm = (lab[..., i][sel].mean() for i in range(3))
    # Dark targets: less spread, or the shadows go to pure black.
    if spread == 1.0 and tl[0] < 30:
        spread = 0.85
    out = lab.copy()
    out[..., 0] = np.clip(tl[0] + (lab[..., 0] - lm) * spread, 0, 100)
    out[..., 1] = tl[1] + (lab[..., 1] - am) * tint
    out[..., 2] = tl[2] + (lab[..., 2] - bm) * tint
    return from_lab(out)


def magenta(rgb: np.ndarray) -> np.ndarray:
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    return (r > 0.7) & (b > 0.7) & (g < 0.35) & (np.abs(r - b) < 0.3)


def _fill(col: np.ndarray, w: np.ndarray, sigmas: tuple[float, ...] = (1.5, 3, 6, 12, 24)) -> np.ndarray:
    """Colours of the weighted pixels spread to their neighbours (normalized convolution, finest scale first)."""
    out = np.zeros_like(col)
    have = np.zeros(w.shape, np.float32)
    for s in sigmas:
        den = cv2.GaussianBlur(w, (0, 0), s)
        num = np.dstack([cv2.GaussianBlur(col[..., i] * w, (0, 0), s) for i in range(3)])
        est = num / (den[..., None] + 1e-6)
        take = np.clip(den / 0.05, 0, 1) * (1 - have)
        out += est * take[..., None]
        have = np.clip(have + take, 0, 1)
    return out


def background_of(rgb: np.ndarray) -> tuple[np.ndarray, float]:
    """The flat backdrop the master is drawn on (never exactly #FFFFFF from an image model) and its noise."""
    b = max(4, min(rgb.shape[:2]) // 100)
    border = np.concatenate([rgb[:b].reshape(-1, 3), rgb[-b:].reshape(-1, 3), rgb[:, :b].reshape(-1, 3), rgb[:, -b:].reshape(-1, 3)])
    bg = np.median(border, 0)
    noise = float(np.percentile(np.abs(border - bg).max(1), 99))
    return bg.astype(np.float32), max(0.012, min(noise, 0.06))


def ink_of(rgb: np.ndarray, bg: np.ndarray) -> np.ndarray:
    """The least alpha that explains each pixel as some colour laid over the backdrop (colour-to-alpha): 0 = backdrop."""
    lo = np.clip((bg - rgb) / np.maximum(bg, 1e-3), 0, 1)
    hi = np.clip((rgb - bg) / np.maximum(1 - bg, 1e-3), 0, 1)
    return np.maximum(lo, hi).max(2)


def backdrop_of(native: np.ndarray, coarse: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Where the paper shows, decided on the picture as the image model drew it (before the upscale, whose paper is
    no longer flat). Paper is 254–255 there; even white hair is cream, ≥ ~8 levels darker. The segmentation
    (`coarse`, BiRefNet) only votes on the ambiguous bits — it never draws the edge.
      - outside: paper connected to the picture's border;
      - gaps: enclosed paper (between curls, under an arm). One is cut when BiRefNet calls it backdrop and it is near
        the outside or walled only by light paint, or when it sits within a few px of the outside and is walled
        only by light paint (a light strand). A pure-white highlight, teeth, the inside of a glass stay: deeper, or
        walled by a dark outline;
      - tinted paper: near-white pixels (grain, a paper tint in a tight gap) reached from either, where BiRefNet
        calls it backdrop.
    → (outside, gaps, tinted) masks at the native size."""
    H, W = native.shape[:2]
    bg, noise = background_of(native)
    ink = ink_of(native, bg)
    eight = np.ones((3, 3))
    lab, n = ndi.label(ink <= noise + 0.004, structure=eight)
    border = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    border = border[border > 0]
    outside = np.isin(lab, border)
    gaps = np.zeros_like(outside)
    if n:
        idx = np.arange(1, n + 1)
        near = ndi.minimum(cv2.distanceTransform((~outside).astype(np.uint8), cv2.DIST_L2, 5), lab, idx)
        seg = ndi.mean(coarse, lab, idx)
        # walled only by light paint = still connected to the border through pixels lighter than an outline
        lw, _ = ndi.label(ink <= 0.36, structure=eight)
        lb = np.unique(np.concatenate([lw[0], lw[-1], lw[:, 0], lw[:, -1]]))
        light = ndi.maximum(np.isin(lw, lb[lb > 0]), lab, idx) > 0
        fringe = max(6, round(max(H, W) * 0.025))
        tight = max(4, round(max(H, W) * 0.006))
        cut = ~np.isin(idx, border) & (((seg < 0.5) & ((near <= fringe) | light)) | ((near <= tight) & light))
        gaps = np.isin(lab, idx[cut])
    back = outside | gaps
    tinted = ndi.binary_propagation(back, mask=((ink <= 0.04) & (coarse < 0.5)) | ((ink <= 0.07) & (coarse < 0.1))) & ~back
    return outside, gaps, tinted


def matte_white(native: np.ndarray, white: np.ndarray, coarse: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Alpha + un-mixed colours of a picture on a known flat backdrop, at the size of `white` (the print upscale of
    `native`, or `native` itself). Where the paper is comes from backdrop_of; the edge is solved from the pixels:
      - paper → 0; everything more than a few px from the paper → 1 (white paint inside the art stays opaque);
      - edge: colour-to-alpha (watercolour = paint over paper), raised to a·F + (1−a)·backdrop where F, the colour of
        the solid pixels next to it, is known — never on pixels within the paper's grain (upscale noise would turn
        into faint dots of the neighbour's colour);
      - strand tips past the segmentation are kept: anything drawn that is not paper has alpha;
      - then the colour is un-mixed (no white or grey halo)."""
    Hn, Wn = native.shape[:2]
    h, w = white.shape[:2]
    k = w / Wn
    outside_n, gaps_n, tinted_n = backdrop_of(native, coarse)

    def to_size(m: np.ndarray) -> np.ndarray:
        return cv2.resize(m.astype(np.float32), (w, h), interpolation=cv2.INTER_LINEAR) > 0.5 if (h, w) != (Hn, Wn) else m

    outside, gaps, tinted = to_size(outside_n), to_size(gaps_n), to_size(tinted_n)
    back = outside | gaps
    outside_seg = to_size(coarse < 0.5)
    bg, noise = background_of(white)
    ink = ink_of(white, bg)

    # Edge band: a few px around the paper outside, 1 px around gaps and tinted paper (their walls are often a light
    # strand that must stay opaque).
    band = cv2.dilate(outside.astype(np.uint8), kernel(max(2, round(3 * k)))).astype(bool)
    band |= cv2.dilate((gaps | tinted).astype(np.uint8), kernel(max(1, round(k)))).astype(bool)
    solid = ~band & ~tinted
    F = _fill(white, (solid & (ink > 0.05)).astype(np.float32))

    # Paper grain beside the art is ≤ ~16/255: below that there is nothing drawn where BiRefNet says backdrop.
    floor = np.where(outside_seg, max(noise, 0.065), noise)
    a_c2a = np.clip((ink - floor) / (1 - floor), 0, 1)
    d = F - bg[None, None]
    den = (d * d).sum(2)
    a_solve = np.clip(((white - bg[None, None]) * d).sum(2) / (den + 1e-6), 0, 1)
    a_edge = np.where((den > 0.004) & (a_c2a > 0) & ~tinted, np.maximum(a_c2a, a_solve), a_c2a)
    alpha = np.where(solid, 1.0, a_edge).astype(np.float32)
    alpha[cv2.erode(back.astype(np.uint8), kernel(1)).astype(bool)] = 0
    # Specks and faint grain: islands left in the backdrop that are tiny or never more than faint.
    isl, m = ndi.label(alpha > 0.02)
    if m:
        idx = np.arange(1, m + 1)
        drop = (ndi.sum(np.ones_like(alpha), isl, idx) < 12 * k * k) | (ndi.maximum(alpha, isl, idx) < 0.12)
        alpha[np.isin(isl, idx[drop])] = 0

    # Colours: un-mixed from the backdrop where the edge is thin; the neighbours' colour where it is almost gone.
    safe = np.maximum(alpha, 1e-3)[..., None]
    unmixed = np.clip((white - (1 - alpha[..., None]) * bg[None, None]) / safe, 0, 1)
    t = np.clip((alpha - 0.15) / 0.5, 0, 1)[..., None]
    col = np.where((~solid)[..., None], unmixed * t + F * (1 - t), white)
    col = np.where(alpha[..., None] > 0, col, 1.0)
    return alpha, np.clip(col, 0, 1).astype(np.float32)


def cut_of(native: np.ndarray, white: np.ndarray, coarse: np.ndarray) -> np.ndarray:
    """RGBA of a picture on its white backdrop at the size of `white` (`native` or its print upscale): the paper is
    found on `native`, the segmentation alpha (any size — a uniform scale of the same canvas) only votes."""
    h, w = native.shape[:2]
    c = cv2.resize(coarse, (w, h), interpolation=cv2.INTER_LINEAR) if coarse.shape != (h, w) else coarse
    a, col = matte_white(native, white, np.clip(c, 0, 1))
    return np.dstack([col, a])


def erase_at(white: np.ndarray, alpha: np.ndarray, points: list[tuple[float, float]]) -> tuple[np.ndarray, list[int]]:
    """Backdrop left over at the points the editor marked ("Sửa nền": a click on each bit that is not clean), on the
    matte at print size (`white` = its colours on white, `alpha` = its alpha now). Around each point, within a
    small radius only:
      - a stray bit (an island of alpha that does not reach past the radius) goes whole;
      - otherwise the paper there: from the lightest pixel next to the point, the pixels connected to it that are
        about as light (≤ its ink + 5 %, ≤ 12 %) go; a 2 px rim around them keeps only what is drawn
        (colour-to-alpha), so no white edge is left.
    → (alpha, pixels removed per point)."""
    H, W = alpha.shape
    out = alpha.copy()
    R = max(24, round(max(H, W) * 0.02))
    seed_r = max(3, R // 8)
    clear = out <= 0.02
    bg = np.median(white[clear], 0) if clear.sum() > 100 else np.ones(3, np.float32)
    eight = np.ones((3, 3))
    removed: list[int] = []
    for px, py in points:
        x, y = int(round(px)), int(round(py))
        if not (0 <= x < W and 0 <= y < H):
            removed.append(0)
            continue
        x0, y0, x1, y1 = max(0, x - R), max(0, y - R), min(W, x + R + 1), min(H, y + R + 1)
        a = out[y0:y1, x0:x1]
        cx, cy = x - x0, y - y0
        yy, xx = np.mgrid[y0:y1, x0:x1]
        disc = (xx - x) ** 2 + (yy - y) ** 2 <= R * R
        near = (xx - x) ** 2 + (yy - y) ** 2 <= seed_r * seed_r
        # A stray bit: the island under (or next to) the click, wholly inside the radius.
        isl, _ = ndi.label(a > 0.02, structure=eight)
        ids = np.unique(isl[near & (isl > 0)])
        stray = [i for i in ids if not (isl == i)[~disc].any()]
        if stray:
            gone = np.isin(isl, stray)
        else:
            ink = ink_of(white[y0:y1, x0:x1], bg)
            cand = near & (a > 0.02)
            if not cand.any():
                removed.append(0)
                continue
            lightest = np.where(cand, ink, 9).argmin()
            s = float(ink.flat[lightest])
            if s > 0.2:  # nothing light next to the click: drawn pixels, leave them
                removed.append(0)
                continue
            t = min(0.12, s + 0.05)
            lab, _ = ndi.label((ink <= t) & disc, structure=eight)
            gone = lab == lab.flat[lightest]
            rim = cv2.dilate(gone.astype(np.uint8), kernel(2)).astype(bool) & ~gone & disc
            a[rim] = np.minimum(a[rim], np.clip((ink[rim] - t) / (1 - t), 0, 1))
        n = int((gone & (a > 0.02)).sum())
        a[gone] = 0
        removed.append(n)
    return out, removed


def align(ref: np.ndarray, img: np.ndarray) -> dict:
    """How far an in-place edit moved the unchanged pixels (layer-rules: ≤ 0.5 px)."""
    g1 = cv2.cvtColor((ref * 255).astype(np.float32), cv2.COLOR_RGB2GRAY)
    g2 = cv2.cvtColor((img * 255).astype(np.float32), cv2.COLOR_RGB2GRAY)
    win = cv2.createHanningWindow(g1.shape[::-1], cv2.CV_32F)
    (dx, dy), _ = cv2.phaseCorrelate(g1, g2, win)
    d = np.abs(ref - img).mean(2) * 255
    return {"dx": round(float(dx), 3), "dy": round(float(dy), 3), "unchanged": round(float((d < 12).mean()), 4)}


def _gray(x: np.ndarray) -> np.ndarray:
    return cv2.cvtColor((x * 255).astype(np.float32), cv2.COLOR_RGB2GRAY)


def tile_shifts(ref: np.ndarray, img: np.ndarray, t: int = 192) -> np.ndarray:
    """Local shift (px) of every textured, unchanged tile — how well the edit sits on the source, region by region."""
    g1, g2 = _gray(ref), _gray(img)
    h, w = g1.shape
    win = cv2.createHanningWindow((t, t), cv2.CV_32F)
    out = []
    for y in range(0, h - t + 1, t // 2):
        for x in range(0, w - t + 1, t // 2):
            a, b = g1[y:y + t, x:x + t], g2[y:y + t, x:x + t]
            if a.std() < 20 or np.abs(a - b).mean() > 25:
                continue
            (dx, dy), resp = cv2.phaseCorrelate(a, b, win)
            if resp > 0.2:
                out.append(float(np.hypot(dx, dy)))
    return np.array(out, np.float32)


def _affine(ref: np.ndarray, img: np.ndarray, dx: float, dy: float) -> np.ndarray:
    """ECC affine (scale + shear + shift) on the unchanged pixels. gpt-image maps its input with a slightly different
    scale per axis (≈ 0.2 %, 2 px across the picture) — a translation alone leaves that."""
    g1, g2 = _gray(ref), _gray(img)
    warp = np.float32([[1, 0, dx], [0, 1, dy]])
    crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6)
    b1, b2 = cv2.GaussianBlur(g1, (0, 0), 1.0), cv2.GaussianBlur(g2, (0, 0), 1.0)
    for _ in range(2):
        moved = cv2.warpAffine(g2, warp, g1.shape[::-1], flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)
        same = cv2.erode((np.abs(moved - g1) < 18).astype(np.uint8), np.ones((5, 5), np.uint8))
        _, warp = cv2.findTransformECC(b1, b2, warp, cv2.MOTION_AFFINE, crit, same, 5)
    return warp


def _local(ref: np.ndarray, img: np.ndarray, sigma: float = 24) -> tuple[np.ndarray, float]:
    """What is left after the affine: gpt-image re-draws each character and moves it a fraction of a pixel on its own.
    Dense flow, kept only where the pixels did not change, smoothed (σ 24 px) so it can only move whole regions — it
    never reshapes an edit's new content, which takes the flow of the pixels around it."""
    g1 = _gray(ref).clip(0, 255).astype(np.uint8)
    g2 = _gray(img).clip(0, 255).astype(np.uint8)
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_ULTRAFAST)
    dis.setFinestScale(0)
    f = dis.calc(g1, g2, None)
    same = (np.abs(g1.astype(np.float32) - g2) < 14) & (np.abs(cv2.Laplacian(g1, cv2.CV_32F)) > 4) & (np.hypot(f[..., 0], f[..., 1]) < 2.5)
    w = same.astype(np.float32)
    k = lambda a: cv2.GaussianBlur(a, (0, 0), sigma)
    den = k(w)
    conf = np.clip(den / 0.02, 0, 1)
    fx = k(f[..., 0] * w) / (den + 1e-6) * conf
    fy = k(f[..., 1] * w) / (den + 1e-6) * conf
    h, wd = g1.shape
    xs, ys = np.meshgrid(np.arange(wd, dtype=np.float32), np.arange(h, dtype=np.float32))
    out = cv2.remap(img, xs + fx, ys + fy, cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REPLICATE)
    return np.clip(out, 0, 1), float(np.hypot(fx, fy).max())


def register(ref: np.ndarray, img: np.ndarray) -> tuple[np.ndarray, dict]:
    """Put an in-place edit back on its source's pixels. Image models move what they keep: nano-banana by one uniform
    0.5–1 px, gpt-image by a slight scale per axis plus a fraction of a pixel per character. Measured on the unchanged
    pixels and undone: translation → affine → smoothed local flow. Nothing is re-drawn. residual = the 90th percentile
    of the local shifts left (px), max = the worst tile."""
    before = align(ref, img)
    t0 = tile_shifts(ref, img)
    out = img
    try:
        warp = _affine(ref, img, before["dx"], before["dy"])
        out = np.clip(cv2.warpAffine(img, warp, (img.shape[1], img.shape[0]), flags=cv2.INTER_LANCZOS4 | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE), 0, 1)
    except cv2.error:
        m = np.float32([[1, 0, -before["dx"]], [0, 1, -before["dy"]]])
        out = np.clip(cv2.warpAffine(img, m, (img.shape[1], img.shape[0]), flags=cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REPLICATE), 0, 1)
    out, moved = _local(ref, out)
    t1 = tile_shifts(ref, out)
    p90 = lambda t: round(float(np.percentile(t, 90)), 3) if len(t) else 0.0
    return out, {**before, "before": p90(t0), "residual": p90(t1), "max": round(float(t1.max()), 3) if len(t1) else 0.0, "local": round(moved, 2)}


def polygon_of(mask: np.ndarray, eps: float = 1.5) -> list[list[float]]:
    m = (mask * 255).astype(np.uint8)
    cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not cs:
        return []
    c = max(cs, key=cv2.contourArea)
    c = cv2.approxPolyDP(c, eps, True)
    return [[float(p[0][0]), float(p[0][1])] for p in c]


# ---- 2. plan: where every layer is --------------------------------------------------------------------------
# A region says WHICH part of a picture a layer is (soft 0–1, generous is fine); the picture's subject alpha says
# where the picture has anything at all. A file = region × subject alpha, so a region never brings back backdrop
# and the edge always comes from the matte.

def keep_of(img: np.ndarray, ref: np.ndarray, thr: float = 0.08) -> np.ndarray:
    """Where an in-place edit left its reference as it was (soft 0–1). There the reference's subject alpha — the
    master's, fixed by hand — holds for the edit too; elsewhere the edit's own matte."""
    changed = clean(np.abs(img - ref).max(2) > thr, open_r=1, close_r=3, min_px=30)
    changed = cv2.dilate(changed.astype(np.uint8), kernel(6)).astype(bool)
    return cv2.GaussianBlur((~changed).astype(np.float32), (0, 0), 2.0)


def mix(keep: np.ndarray, parent: np.ndarray, own: np.ndarray) -> np.ndarray:
    k = keep if parent.ndim == 2 else keep[..., None]
    return parent * k + own * (1 - k)


def on_white(col: np.ndarray, a: np.ndarray) -> np.ndarray:
    return col * a[..., None] + (1 - a[..., None])


def regions_colour(base: np.ndarray, base_a: np.ndarray, masks: dict[str, tuple[str, np.ndarray]]) -> tuple[dict[str, np.ndarray], list[dict]]:
    """Colour / texture parts on the base: the magenta core the AI painted, grown a little to take the part's own
    outline, never skin or another part. masks = {slot key: (label, registered magenta picture)}."""
    lab = to_lab(base)
    L_, a_, b_ = lab[..., 0], lab[..., 1], lab[..., 2]
    skin = (a_ > 6) & (b_ > 8) & (L_ > 35)
    cores = {k: clean(magenta(m)) for k, (_, m) in masks.items()}
    out: dict[str, np.ndarray] = {}
    checks: list[dict] = []
    for key, (label, _) in masks.items():
        core = cores[key]
        if core.sum() < 300:
            checks.append({"name": f"Vùng {label}", "ok": False, "detail": "AI không tô được phần này — tô vùng bằng tay hoặc làm lại bản tô.", "piece": key})
            out[key] = np.zeros(core.shape, np.float32)
            continue
        others = np.zeros_like(core)
        for k, c in cores.items():
            if k != key:
                others |= c
        grown = cv2.dilate(core.astype(np.uint8), kernel(3)).astype(bool)
        ref = core & (base_a > 0.5)
        near = np.zeros_like(core)
        if ref.sum() > 100:
            med = np.array([np.median(lab[..., i][ref]) for i in range(3)], np.float32)
            de = np.sqrt(((lab - med) ** 2).sum(2))
            near = cv2.dilate(core.astype(np.uint8), kernel(10)).astype(bool) & (de < 10)
        part = clean(((core & ~others) | (grown & ~skin & ~others) | (near & ~others)) & (base_a > 0.02), open_r=1, close_r=2, min_px=200)
        part = fill_small_holes(part, 2500)
        kept = float(part.sum()) / max(1.0, float(core.sum()))
        checks.append({"name": f"Vùng {label}", "ok": kept > 0.8, "detail": f"{int(part.sum()):,} px ({kept * 100:.0f}% phần AI tô)", "piece": key})
        out[key] = soft(part, grow=2, blur=0.7)
    return out, checks


def fill_small_holes(m: np.ndarray, max_px: int) -> np.ndarray:
    """Holes inside the region smaller than max_px are filled (a pixel threshold leaves pin-holes in flat fills).
    A big hole (a face ringed by hair) stays: it is not part of the region."""
    inv = ~m
    lab, n = ndi.label(inv)
    if not n:
        return m
    sizes = ndi.sum(inv, lab, range(1, n + 1))
    outer = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]])).tolist())
    fill = [i + 1 for i, s in enumerate(sizes) if s <= max_px and (i + 1) not in outer]
    return m | np.isin(lab, fill) if fill else m


def tidy(part: np.ndarray, allow: np.ndarray, sigma: float, close_r: int = 7, max_hole: int = 2500) -> np.ndarray:
    """A thresholded region made clean: small holes filled, narrow gaps closed, the edge smoothed (blur + re-threshold).
    What closing / smoothing ADDS is limited to `allow` (pixels that really belong to the part); what the region
    already had is kept, except for the smoothing's own rounding of its edge."""
    m = part.astype(bool)
    if not m.any():
        return m
    m = fill_small_holes(m, max_hole)
    closed = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_CLOSE, kernel(close_r)).astype(bool)
    m = m | (closed & allow)
    if sigma > 0:
        m = (cv2.GaussianBlur(m.astype(np.float32), (0, 0), sigma) > 0.5) & (m | allow)
    return m


def region_shape(white: np.ndarray, cut_a: np.ndarray, base: np.ndarray, base_a: np.ndarray, region: np.ndarray | None, hairlike: bool) -> np.ndarray:
    """A shape option's part: what differs from the base (inside `region` when the master's parts are split
    between slots). Hair: only the hair's own colours; on the body only pixels that look more like the part than
    like the base there (bangs over a forehead yes, a re-drawn ear or outline no)."""
    diff = np.abs(white - base).max(2)
    changed = (diff > 0.12) & (cut_a > 0.3)
    # Where closing / smoothing may ADD pixels: inside the picture's subject, and on the body only where the picture
    # really differs from the base (a looser test than `changed`) — never plain skin.
    allow = (cut_a > 0.3) & ((base_a < 0.5) | (diff > 0.04))
    if region is not None:
        changed &= region
        allow &= region
    if hairlike:
        lab = to_lab(white)
        base_lab = to_lab(base)
        ref = changed & (base_a < 0.05)
        if ref.sum() > 400:
            ha, hb = np.median(lab[..., 1][ref]), np.median(lab[..., 2][ref])
            hl = np.median(lab[..., 0][ref])
            hair_hue = np.hypot(lab[..., 1] - ha, lab[..., 2] - hb) < 26
            d_part = np.sqrt(((lab[..., 0] - hl) * 0.5) ** 2 + (lab[..., 1] - ha) ** 2 + (lab[..., 2] - hb) ** 2)
            d_base = np.sqrt(((lab[..., 0] - base_lab[..., 0]) * 0.5) ** 2 + (lab[..., 1] - base_lab[..., 1]) ** 2 + (lab[..., 2] - base_lab[..., 2]) ** 2)
            hair_like = hair_hue & ((base_a < 0.5) | (d_part < d_base))
            changed &= hair_like
            allow &= hair_like  # smoothing may not pull skin into a hair file (recolouring would tint it)
    part = clean(changed, open_r=2, close_r=5, min_px=1500)
    # Pixel-threshold leftovers: pin-holes, notched edges. Hair keeps its strands (light smoothing only).
    part = clean(tidy(part, allow, sigma=1.0 if hairlike else 2.2), open_r=0, close_r=0, min_px=1500)
    return soft(part, grow=1, blur=1.2)


def claim_orphans(regions: list[np.ndarray], subject_a: np.ndarray, base_a: np.ndarray, max_d: float) -> list[np.ndarray]:
    """Pixels a picture has outside the base's silhouette belong to a part the base removed (hair, a hat). Those
    no region took (fringe strands, a dark outline) go to the nearest region within max_d px — else they would be
    in no file at all (a hole when the layers are stacked)."""
    if not regions:
        return regions
    taken = np.zeros(subject_a.shape, bool)
    for r in regions:
        taken |= r > 0.5
    orphan = (subject_a > 0.3) & (base_a < 0.5) & ~taken
    if not orphan.any():
        return regions
    dists = [cv2.distanceTransform((~(r > 0.5)).astype(np.uint8), cv2.DIST_L2, 5) for r in regions]
    d = np.stack(dists)
    near = d.argmin(0)
    near_d = d.min(0)
    ok = orphan & (near_d <= max_d)
    # Loose bits: a dot floating off the figure (AI noise) is not a part of any region. Only pieces that touch a
    # region (≤ 3 px) or are sizeable (≥ 400 px: a strand, a curl) are taken.
    lab_o, n_o = ndi.label(ok)
    if n_o:
        sizes = ndi.sum(ok, lab_o, range(1, n_o + 1))
        touch = ndi.minimum(near_d, lab_o, range(1, n_o + 1))
        drop = [i + 1 for i in range(n_o) if sizes[i] < 400 and touch[i] > 3]
        if drop:
            ok &= ~np.isin(lab_o, drop)
    out = []
    for i, r in enumerate(regions):
        add = ok & (near == i)
        out.append(np.maximum(r, soft(add, grow=1, blur=0.8)) if add.any() else r)
    return out


def region_zone(mask_pic: np.ndarray) -> np.ndarray:
    return clean(magenta(mask_pic), close_r=6).astype(np.float32)


def region_body(base_a: np.ndarray) -> np.ndarray:
    """The body file = the whole base: its region covers the subject with room (the editor erases from it)."""
    return cv2.dilate((base_a > 0.02).astype(np.uint8), kernel(8)).astype(np.float32)


# ---- 3. cut: the files ---------------------------------------------------------------------------------------

@dataclass
class Option:
    name: str
    hex: str | None = None
    col: np.ndarray | None = None       # shape / texture: the option's colours (None = the base's)
    alpha: np.ndarray | None = None     # shape: the option picture's subject alpha
    region: np.ndarray | None = None    # shape: the option's region


@dataclass
class Slot:
    key: str
    label: str
    mode: str                                # color | texture | shape
    region: np.ndarray | None = None         # color / texture: the part on the base
    options: list[Option] = field(default_factory=list)
    colors: list[Option] = field(default_factory=list)
    wraps: bool = False


@dataclass
class Zone:
    id: str
    region: np.ndarray


@dataclass
class Out:
    slot: str
    label: str
    option: str
    color: str
    rgba: np.ndarray
    piece: str = ""


def over(dst: np.ndarray, src: np.ndarray) -> np.ndarray:
    a = src[..., 3:4]
    out = dst.copy()
    out[..., :3] = src[..., :3] * a + dst[..., :3] * (1 - a)
    out[..., 3:] = a + dst[..., 3:] * (1 - a)
    return out


def drop_specks(a: np.ndarray, min_px: int = 40) -> tuple[np.ndarray, int]:
    """Islands smaller than min_px are dust: removed. Returns the alpha and how many small islands remain (< 0.05 %
    of the canvas — worth a look: a stray bit of another part, or a strand tip)."""
    lab, n = ndi.label(a > 0.02)
    if not n:
        return a, 0
    sizes = ndi.sum(np.ones_like(a), lab, range(1, n + 1))
    dust = [i + 1 for i, s in enumerate(sizes) if s < min_px]
    if dust:
        a = np.where(np.isin(lab, dust), 0, a).astype(np.float32)
    small = int(sum(1 for s in sizes if min_px <= s < a.size * 0.0005))
    return a, small


def cut(master: np.ndarray, master_a: np.ndarray, base: np.ndarray, base_a: np.ndarray, body_region: np.ndarray, slots: list[Slot], zones: list[Zone]) -> dict:
    """The layer files from the reviewed regions. base / base_a: the base's colours + subject alpha (the master's
    where the base kept it). Every file is region × its picture's alpha; colours un-mixed already (matte_white)."""
    H, W = master.shape[:2]
    A_B = base_a * np.clip(body_region, 0, 1)
    checks: list[dict] = []
    files: list[Out] = []
    backs: list[dict] = []
    tops: list[dict] = []
    middle: list[dict] = []
    body_cover = soft(A_B > 0.5, grow=2, blur=1.0)

    for s in slots:
        if s.mode not in ("color", "texture") or s.region is None:
            continue
        alpha = np.clip(s.region, 0, 1) * A_B
        if (alpha > 0.5).sum() < 200:
            checks.append({"name": f"{s.label}", "ok": False, "detail": "Vùng trống — tô lại vùng ở bước phác thảo.", "piece": s.key})
            continue
        for i, o in enumerate(s.options):
            if s.mode == "color":
                col = recolor(base, alpha, o.hex if i > 0 else None)
            else:
                col = base if (i == 0 or o.col is None) else np.clip(o.col, 0, 1)
            files.append(Out(s.key, s.label, o.name, "", np.dstack([col, alpha]), s.key))
        middle.append({"key": s.key, "label": s.label, "follows": None})

    first_parts: list[tuple[np.ndarray, np.ndarray]] = []
    for s in slots:
        if s.mode != "shape":
            continue
        made = 0
        for i, o in enumerate(s.options):
            if o.region is None or o.col is None or o.alpha is None:
                continue
            piece = f"{s.key}#{i}"
            a_part = np.clip(o.region, 0, 1) * o.alpha
            if (a_part > 0.5).sum() < 300:
                checks.append({"name": f"{s.label}: {o.name}", "ok": False, "detail": "Vùng trống — tô lại vùng ở bước phác thảo.", "piece": piece})
                continue
            made += 1
            a_front = a_part * body_cover if s.wraps else a_part
            for c in s.colors or [Option("", None)]:
                first_colour = s.colors[0] if s.colors else None
                col = recolor(o.col, a_part, c.hex, tint=0.12, spread=0.9) if c.hex and c is not first_colour else o.col
                if s.wraps:
                    files.append(Out(f"{s.key}:back", f"{s.label} — lớp sau", o.name, c.name, np.dstack([col, a_part]), piece))
                    files.append(Out(f"{s.key}:front", f"{s.label} — lớp trước", o.name, c.name, np.dstack([col, a_front]), piece))
                else:
                    files.append(Out(s.key, s.label, o.name, c.name, np.dstack([col, a_part]), piece))
            if i == 0:
                first_parts.append((np.dstack([o.col, a_part]), np.dstack([o.col, a_front])))
        if not made:
            continue
        if s.wraps:
            backs.append({"key": f"{s.key}:back", "label": f"{s.label} — lớp sau", "follows": f"{s.key}:front"})
            tops.append({"key": f"{s.key}:front", "label": f"{s.label} — lớp trước", "follows": None})
        else:
            tops.append({"key": s.key, "label": s.label, "follows": None})

    B = np.dstack([base, A_B])
    files.append(Out("body", "Thân", "Body", "", B.copy(), "body"))
    order = backs + [{"key": "body", "label": "Thân", "follows": None}] + middle + tops

    # Dust off every file; small islands left are counted (a stray bit of another part?).
    stray: dict[str, int] = {}
    for f in files:
        a, small = drop_specks(f.rgba[..., 3])
        f.rgba[..., 3] = a
        if small:
            stray[f.piece] = max(stray.get(f.piece, 0), small)
    labels = {f.piece: f"{f.label}: {f.option}" if f.piece != "body" else "Thân" for f in files}
    for piece, n in stray.items():
        checks.append({"name": f"Mảnh rời — {labels.get(piece, piece)}", "ok": n <= 6, "detail": f"{n} mảnh nhỏ tách rời", "piece": piece})

    # Rebuild: back parts + body + front parts = the master (the default choice of every slot).
    canvas = np.zeros((H, W, 4), np.float32)
    for back, _ in first_parts:
        canvas = over(canvas, back)
    canvas = over(canvas, B)
    for _, front in first_parts:
        canvas = over(canvas, front)
    vis = master_a > 0.9
    d = float(np.abs(canvas[..., :3] - master[..., :3])[vis].mean() * 255) if vis.any() else 0.0
    checks.append({"name": "Ráp lại = master", "ok": d < 12, "detail": f"lệch màu trung bình {d:.1f}/255"})
    holes = (master_a > 0.5) & (canvas[..., 3] < 0.5)
    extra = (master_a < 0.2) & (canvas[..., 3] > 0.5)
    off = (np.abs(canvas[..., :3] - master[..., :3]).max(2) > 0.25) & (master_a > 0.9) & (canvas[..., 3] > 0.9)
    n_holes, n_extra, n_off = int(clean(holes, 1, 1, 30).sum()), int(clean(extra, 1, 1, 30).sum()), int(clean(off, 1, 1, 30).sum())
    checks.append({"name": "Lỗ hổng (master có, ráp lại thiếu)", "ok": n_holes < 400, "detail": f"{n_holes:,} px — vùng đỏ"})
    checks.append({"name": "Thừa (ráp lại có, master là nền)", "ok": n_extra < 400, "detail": f"{n_extra:,} px — vùng xanh"})
    checks.append({"name": "Khác màu rõ so với master", "ok": n_off < 2000, "detail": f"{n_off:,} px — vùng vàng"})
    diff = np.zeros((H, W, 4), np.float32)
    for m, rgb in ((clean(off, 1, 1, 30), (1, 0.8, 0)), (clean(extra, 1, 1, 30), (0, 0.6, 1)), (clean(holes, 1, 1, 30), (1, 0, 0))):
        m = cv2.dilate(m.astype(np.uint8), kernel(2)).astype(bool)
        diff[m] = (*rgb, 0.85)

    zone_out = []
    for z in zones:
        m = clean(np.clip(z.region, 0, 1) > 0.5, close_r=6)
        if m.sum() < 500:
            checks.append({"name": f"Vùng ảnh {z.id}", "ok": False, "detail": "Vùng ảnh khách trống — tô lại ở bước phác thảo.", "piece": f"zone:{z.id}"})
            continue
        zone_out.append({"id": z.id, "mask": m.astype(np.float32)})

    # One common crop for every file.
    union = np.zeros((H, W), bool)
    for f in files:
        union |= f.rgba[..., 3] > 0.01
    for z in zone_out:
        union |= z["mask"] > 0
    ys, xs = np.where(union)
    pad = 48
    x0, y0 = max(0, int(xs.min()) - pad), max(0, int(ys.min()) - pad)
    x1, y1 = min(W, int(xs.max()) + pad + 1), min(H, int(ys.max()) + pad + 1)
    for f in files:
        px = (np.clip(f.rgba[y0:y1, x0:x1], 0, 1) * 255).round().astype(np.uint8)
        px[px[..., 3] == 0] = 0
        f.rgba = px
    return {
        "width": x1 - x0,
        "height": y1 - y0,
        "crop": {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0},
        "master": {"w": W, "h": H},
        "order": order,
        "files": files,
        "zones": [{"id": z["id"], "polygon": polygon_of(z["mask"][y0:y1, x0:x1])} for z in zone_out],
        "checks": checks,
        "diff": (np.clip(diff[y0:y1, x0:x1], 0, 1) * 255).round().astype(np.uint8),
    }
