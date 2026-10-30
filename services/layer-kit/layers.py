"""
Pixel-registered layer set of a v2 bộ nhân vật (flexiprint://guide/layer-rules), rebuilt 2026-10-14 ("xoá mọi logic
chắp vá"): the paper doll and the parts drawn on it, cut by DIFFERENCE — pixel lock.

gpt-image draws the paper doll (every part the customer changes taken off) and then every option of every part ON that
doll, in place, on a transparent background. Every option picture is registered onto the doll (affine + smoothed local
flow, ≤ 0.5 px). Then:

  body file    = the doll, pixel for pixel
  option file  = the option picture's pixels where it differs from the doll (its colour, or new figure past the doll's
                 outline) — nothing else, so stacked on the doll it IS the option picture there, and the doll's own
                 pixels are never touched (what the AI re-drew a little elsewhere is dropped)
  hair (wraps) = back: the whole hair of its picture · front: that same hair where it lies on the doll's figure
                 (its outline included)
  colours      = the option file recoloured where it has the part's own hue (an outline, a button, skin keep theirs)

Nothing is segmented, guessed or grown: the regions are exactly what the AI drew anew. A region the editor finds wrong
is fixed by hand (the region / file editor) or by drawing that 3b picture again.

  1. matte  the master's own cut-out at print size (the editor can erase specks: erase_at)
  2. plan   every option registered onto the doll and upscaled; each option's region = what it changed (part_region)
  3. cut    the files (cut)
"""

from __future__ import annotations

from collections.abc import Callable
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


def on_white(col: np.ndarray, a: np.ndarray) -> np.ndarray:
    return col * a[..., None] + (1 - a[..., None])


def _fill(col: np.ndarray, w: np.ndarray, sigmas: tuple[float, ...] = (1.5, 3, 6, 12, 24)) -> np.ndarray:
    """Colours of the weighted pixels spread to their neighbours (normalized convolution, finest scale first) — the
    colour under a cut-out's transparent edge before the print upscale (no dark rim)."""
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


def magenta(rgb: np.ndarray) -> np.ndarray:
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    return (r > 0.7) & (b > 0.7) & (g < 0.35) & (np.abs(r - b) < 0.3)


def region_zone(mask_pic: np.ndarray) -> np.ndarray:
    return clean(magenta(mask_pic), close_r=6).astype(np.float32)


def polygon_of(mask: np.ndarray, eps: float = 1.5) -> list[list[float]]:
    m = (mask * 255).astype(np.uint8)
    cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not cs:
        return []
    c = max(cs, key=cv2.contourArea)
    c = cv2.approxPolyDP(c, eps, True)
    return [[float(p[0][0]), float(p[0][1])] for p in c]


# ---- 1. matte: specks the editor marks --------------------------------------------------------------------

def ink_of(rgb: np.ndarray, bg: np.ndarray) -> np.ndarray:
    """The least alpha that explains each pixel as some colour laid over the backdrop (colour-to-alpha): 0 = backdrop."""
    lo = np.clip((bg - rgb) / np.maximum(bg, 1e-3), 0, 1)
    # Nothing is drawn lighter than white paper: on a near-white backdrop (254 from gpt-image, its grain 253–255) a
    # pixel above the paper is grain, not paint — dividing by 1 − bg (1/255) made every 255 pixel "full ink" and the
    # paper a field of specks (found 2026-10-10: the outside fell apart, gaps were never cut).
    hi = np.clip((rgb - bg) / np.maximum(1 - bg, 1e-3), 0, 1) * (1 - bg > 0.1)
    return np.maximum(lo, hi).max(2)


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


# ---- registration: every edit back onto the master's pixels ------------------------------------------------

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
    # Coarse to fine: the two rounds at half size, then one short round at full size from there — the same warp in a
    # fraction of the time (full size × 2 rounds × 200 iterations was ~12 s on a laptop, a minute on the 2-core VPS,
    # for every option of a 60-option set, 2026-10-18).
    half = lambda a: cv2.resize(a, (a.shape[1] // 2, a.shape[0] // 2), interpolation=cv2.INTER_AREA)
    warp = np.float32([[1, 0, dx / 2], [0, 1, dy / 2]])
    for (r1, r2), rounds, crit in (
        ((half(g1), half(g2)), 2, (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6)),
        ((g1, g2), 1, (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 40, 1e-6)),
    ):
        if r1 is g1:
            warp = warp.copy()
            warp[:, 2] *= 2
        b1, b2 = cv2.GaussianBlur(r1, (0, 0), 1.0), cv2.GaussianBlur(r2, (0, 0), 1.0)
        for _ in range(rounds):
            moved = cv2.warpAffine(r2, warp, r1.shape[::-1], flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)
            same = cv2.erode((np.abs(moved - r1) < 18).astype(np.uint8), np.ones((5, 5), np.uint8))
            _, warp = cv2.findTransformECC(b1, b2, warp, cv2.MOTION_AFFINE, crit, same, 5)
    return warp


def _sane(warp: np.ndarray, dx: float, dy: float) -> np.ndarray:
    """An in-place edit is the same canvas: a few px and a fraction of a percent at most. An ECC that wandered off
    (a picture mostly flat backdrop, or one that changed a lot — the key-mode paper doll: scale 0.6, 119 px) is
    dropped for the plain shift."""
    if abs(warp[0, 2] - dx) < 15 and abs(warp[1, 2] - dy) < 15 and np.all(np.abs(warp[:, :2] - np.eye(2)) < 0.02):
        return warp
    return np.float32([[1, 0, dx], [0, 1, dy]])


def _local(ref: np.ndarray, img: np.ndarray, sigma: float = 24) -> tuple[np.ndarray, float]:
    """What is left after the affine: gpt-image re-draws each character and moves it a fraction of a pixel on its own.
    Dense flow, kept only where the pixels did not change, smoothed (σ 24 px) so it can only move whole regions — it
    never reshapes an edit's new content, which takes the flow of the pixels around it."""
    fx, fy = _local_flow(ref, img, sigma)
    h, wd = img.shape[:2]
    xs, ys = np.meshgrid(np.arange(wd, dtype=np.float32), np.arange(h, dtype=np.float32))
    out = cv2.remap(img, xs + fx, ys + fy, cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REPLICATE)
    return np.clip(out, 0, 1), float(np.hypot(fx, fy).max())


def _local_flow(ref: np.ndarray, img: np.ndarray, sigma: float = 24, exclude: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    g1 = _gray(ref).clip(0, 255).astype(np.uint8)
    g2 = _gray(img).clip(0, 255).astype(np.uint8)
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_ULTRAFAST)
    dis.setFinestScale(0)
    f = dis.calc(g1, g2, None)
    # Trusted where the picture, moved by the flow, matches the reference there (textured pixels): an unchanged part the
    # AI shifted by a few px (a pair of legs moved 3–4 px while a cardigan was added, 2026-10-14) is moved back; a part
    # that changed does not match and takes the flow of what is around it.
    h, w = g1.shape
    xs, ys = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    back = cv2.remap(g2.astype(np.float32), xs + f[..., 0], ys + f[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    same = (np.abs(g1.astype(np.float32) - back) < 14) & (np.abs(cv2.Laplacian(g1, cv2.CV_32F)) > 4) & (np.hypot(f[..., 0], f[..., 1]) < 8)
    if exclude is not None:
        same &= ~exclude
    w = same.astype(np.float32)
    k = lambda a: cv2.GaussianBlur(a, (0, 0), sigma)
    den = k(w)
    conf = np.clip(den / 0.02, 0, 1)
    fx = k(f[..., 0] * w) / (den + 1e-6) * conf
    fy = k(f[..., 1] * w) / (den + 1e-6) * conf
    return fx.astype(np.float32), fy.astype(np.float32)


def register(ref: np.ndarray, img: np.ndarray) -> tuple[np.ndarray, dict]:
    """Put an in-place edit back on its source's pixels. Image models move what they keep: nano-banana by one uniform
    0.5–1 px, gpt-image by a slight scale per axis plus a fraction of a pixel per character. Measured on the unchanged
    pixels and undone: translation → affine → smoothed local flow. Nothing is re-drawn. residual = the 90th percentile
    of the local shifts left (px), max = the worst tile."""
    before = align(ref, img)
    t0 = tile_shifts(ref, img)
    out = img
    try:
        warp = _sane(_affine(ref, img, before["dx"], before["dy"]), before["dx"], before["dy"])
        out = np.clip(cv2.warpAffine(img, warp, (img.shape[1], img.shape[0]), flags=cv2.INTER_LANCZOS4 | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE), 0, 1)
    except cv2.error:
        m = np.float32([[1, 0, -before["dx"]], [0, 1, -before["dy"]]])
        out = np.clip(cv2.warpAffine(img, m, (img.shape[1], img.shape[0]), flags=cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REPLICATE), 0, 1)
    out, moved = _local(ref, out)
    t1 = tile_shifts(ref, out)
    p90 = lambda t: round(float(np.percentile(t, 90)), 3) if len(t) else 0.0
    return out, {**before, "before": p90(t0), "residual": p90(t1), "max": round(float(t1.max()), 3) if len(t1) else 0.0, "local": round(moved, 2)}


def _premul_warp(rgba: np.ndarray, fn) -> np.ndarray:
    """Move an RGBA picture without dragging transparent (or magenta) colours into the edge: colours premultiplied."""
    a = rgba[..., 3:4]
    moved = fn(np.dstack([rgba[..., :3] * a, a]))
    out_a = np.clip(moved[..., 3:4], 0, 1)
    col = np.where(out_a > 1e-4, moved[..., :3] / np.maximum(out_a, 1e-4), 0)
    return np.dstack([np.clip(col, 0, 1), out_a]).astype(np.float32)


def affine_of(ref: np.ndarray, rgba: np.ndarray) -> np.ndarray:
    """The affine `register_rgba` measures (to measure it once for two calls)."""
    rgb = on_white(rgba[..., :3], rgba[..., 3])
    before = align(ref, rgb)
    try:
        return _sane(_affine(ref, rgb, before["dx"], before["dy"]), before["dx"], before["dy"])
    except cv2.error:
        return np.float32([[1, 0, before["dx"]], [0, 1, before["dy"]]])


def register_rgba(ref: np.ndarray, rgba: np.ndarray, exclude: np.ndarray | None = None, local: bool = True, warp: np.ndarray | None = None) -> tuple[np.ndarray, dict]:
    """`register` for a picture with its own alpha: measured on its colours over white, the same affine + local flow
    applied to colours and alpha. `exclude`: pixels the local flow must not learn from (what the picture drew anew);
    `local` False: the affine alone; `warp`: the affine already measured (affine_of)."""
    rgb = on_white(rgba[..., :3], rgba[..., 3])
    before = align(ref, rgb)
    t0 = tile_shifts(ref, rgb)
    h, w = rgb.shape[:2]
    if warp is None:
        warp = affine_of(ref, rgba)
    aff = lambda x: cv2.warpAffine(x, warp, (w, h), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    rgba1 = _premul_warp(rgba, aff)
    rgb1 = on_white(rgba1[..., :3], rgba1[..., 3])
    if not local:
        t1 = tile_shifts(ref, rgb1)
        p90 = lambda t: round(float(np.percentile(t, 90)), 3) if len(t) else 0.0
        return rgba1, {**before, "before": p90(t0), "residual": p90(t1), "max": round(float(t1.max()), 3) if len(t1) else 0.0, "local": 0.0}
    fx, fy = _local_flow(ref, rgb1, exclude=exclude)
    xs, ys = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    rgba2 = _premul_warp(rgba1, lambda x: cv2.remap(x, xs + fx, ys + fy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0))
    t1 = tile_shifts(ref, on_white(rgba2[..., :3], rgba2[..., 3]))
    p90 = lambda t: round(float(np.percentile(t, 90)), 3) if len(t) else 0.0
    return rgba2, {**before, "before": p90(t0), "residual": p90(t1), "max": round(float(t1.max()), 3) if len(t1) else 0.0, "local": round(float(np.hypot(fx, fy).max()), 2)}


# ---- 2. plan: what an option drew anew on the doll -------------------------------------------------------------

# Lab ΔE above which a pixel counts as re-coloured (gpt-image keeps an unchanged area within ~3–6, its new part is
# far beyond it).
CHANGED_DE = 12.0


# A pixel whose HUE (Lab a·b, lightness left out: the AI shades the underwear darker along a jacket's opening) is this
# close to the doll's underwear colour is the doll showing, never the part (chroma key). The key is a strong magenta:
# lilac, plum, fuchsia, red, skin are all > 50 from it. A teal key failed (2026-10-14): an emerald dress was 10–16 from
# it, the teal shading along a cardigan 3–12 — no threshold told them apart.
KEY_AB = 25.0


def territory(doll_a: np.ndarray, subject: int, count: int) -> np.ndarray | None:
    """The pixels closer to figure `subject` (left → right) of the doll than to any other: where a part of that subject
    can be. None when the doll's figures cannot be told apart (they touch)."""
    if count < 2:
        return None
    lab, n = ndi.label(doll_a > 0.5)
    if n < count:
        return columns(doll_a, subject, count)
    sizes = ndi.sum(np.ones_like(doll_a), lab, range(1, n + 1))
    figs = sorted(np.argsort(sizes)[::-1][:count] + 1, key=lambda i: float(np.where(lab == i)[1].mean()))
    if subject >= count:
        return None
    # Each figure a real share of them (two touching figures + a speck are not three): else by columns.
    if min(sizes[i - 1] for i in figs) < 0.25 * sizes.sum() / count:
        return columns(doll_a, subject, count)
    dists = [cv2.distanceTransform((lab != i).astype(np.uint8), cv2.DIST_L2, 5) for i in figs]
    return np.argmin(np.stack(dists), axis=0) == subject


def columns(doll_a: np.ndarray, subject: int, count: int) -> np.ndarray | None:
    """Figures that touch (shoulder to shoulder): each one's side is the band of columns between the deepest dips of
    the figures' top outline (the shoulders / necks between two heads), left → right. None when the heads cannot be told apart."""
    H, W = doll_a.shape
    solid = doll_a > 0.5
    has = solid.any(axis=0)
    if not has.any():
        return None
    top = np.where(has, solid.argmax(axis=0), H).astype(np.float32)
    top = cv2.GaussianBlur(top.reshape(1, -1), (0, 0), max(2.0, W / 300)).ravel()
    xs = np.where(has)[0]
    x0, x1 = int(xs.min()), int(xs.max())
    # The heads: the `count` highest points of the outline with a real dip (a neck, a shoulder) between any two —
    # two points on one wide head have none.
    dip = 0.03 * H
    order = np.argsort(top[x0:x1 + 1], kind="stable") + x0
    heads: list[int] = []
    for x in order:
        x = int(x)
        if all(top[min(x, h):max(x, h) + 1].max() - max(top[x], top[h]) >= dip for h in heads):
            heads.append(x)
        if len(heads) == count:
            break
    if len(heads) < count:
        return None
    heads.sort()
    # Between two heads: the lowest point of the outline (the deepest dip).
    cuts = [int(np.argmax(top[a:b + 1])) + a for a, b in zip(heads, heads[1:])]
    lo = 0 if subject == 0 else cuts[subject - 1]
    hi = W if subject == count - 1 else cuts[subject]
    out = np.zeros((H, W), bool)
    out[:, lo:hi] = True
    return out


def new_pixels(doll: np.ndarray, opt: np.ndarray, key: str | None, fine: bool) -> tuple[np.ndarray, np.ndarray]:
    """What an option picture drew anew on the doll, before it is given to anyone: (region, keyed). See part_region."""
    H, W = doll.shape[:2]
    s = max(H, W) / 1024
    da, oa = doll[..., 3], opt[..., 3]
    lab_o = to_lab(on_white(opt[..., :3], oa))
    de = np.linalg.norm(lab_o - to_lab(on_white(doll[..., :3], da)), axis=2)
    keyed = np.linalg.norm(lab_o[..., 1:] - to_lab(hex_rgb(key)[None, None])[0, 0][1:], axis=2) < KEY_AB if key else np.zeros(de.shape, bool)
    near_doll = cv2.dilate((da > 0.5).astype(np.uint8), kernel(max(2, round(2 * s)))).astype(bool)
    # New figure away from the doll's own outline (along it the outline only moved a little).
    grown = ((oa - da) > 0.3) & ~near_doll
    changed = (de > CHANGED_DE) & (oa > 0.5) & ~grown & ~keyed
    # Fine features (eyes, brows, a mouth on a blank face — 2026-10-19) are thin lines: no opening, small pieces kept.
    if not fine:
        changed = cv2.morphologyEx(changed.astype(np.uint8), cv2.MORPH_OPEN, kernel(max(1, round(1.5 * s)))).astype(bool)
    m = cv2.morphologyEx((changed | grown).astype(np.uint8), cv2.MORPH_CLOSE, kernel(max(2, round(3 * s)))).astype(bool) & (oa > 0.02)
    return m, keyed


# How much further (Lab ΔE) from a subject's own colour than from the nearest subject's a pixel may be and still be
# taken by it first (shared_lands): blonde next to blonde is decided by distance, white curls never take black hair.
OWN_COLOUR_DE = 12.0


def flood(lab: np.ndarray, inside: np.ndarray) -> None:
    """Labels (>0) grown into the unlabelled pixels of `inside`, one px a step (in place): each pixel to the label that
    reaches it first through `inside`."""
    for _ in range(4 * max(lab.shape)):
        grown = ndi.grey_dilation(lab, size=3)
        add = (lab == 0) & inside & (grown > 0)
        if not add.any():
            break
        lab[add] = grown[add]


def split_figures(figure: np.ndarray, count: int) -> np.ndarray | None:
    """The doll's figures (bool mask) as labels 1..count left → right, each its own outline: figures that touch (an ear
    against a neighbour's, shoulders) are thinned until they come apart, then grown back inside the figure — the line
    between two runs along where they touch, not down a column. None when they never come apart."""
    for e in range(0, max(figure.shape) // 8):
        thin = cv2.erode(figure.astype(np.uint8), kernel(e)).astype(bool) if e else figure
        lab, n = ndi.label(thin)
        if n < count:
            continue
        sizes = ndi.sum(thin, lab, range(1, n + 1))
        order = np.argsort(sizes)[::-1]
        if sizes[order[count - 1]] < 0.25 * sizes[order[:count]].mean():
            continue
        keep = sorted(order[:count] + 1, key=lambda i: float(np.where(lab == i)[1].mean()))
        out = np.zeros(figure.shape, np.int32)
        for k, i in enumerate(keep):
            out[lab == i] = k + 1
        flood(out, figure)
        return out
    return None


def shared_lands(doll: np.ndarray, opt: np.ndarray, key: str | None, count: int, fine: bool, doll_a: np.ndarray) -> list[np.ndarray] | None:
    """Whose each pixel is on a picture of a set with several subjects (a group: every grandchild's hair in one; or one
    subject's picture where the AI re-drew a neighbour's hair too).
    Asked 2026-10-20 ("nhân vật như được cắt thẳng xuống", "vẫn còn thừa phần của nhân vật khác"): the doll's sides
    (territory — straight columns when the figures touch) cut a girl's waves where they passed the line and gave her
    file the grandma's curls on her side of it. Here the new pixels go to the subject they are joined to: flooded through
    them from what each subject drew over its own doll figure, the first to reach a pixel owns
    it — hair over a neighbour's shoulder stays with its head, a neighbour's curls go with theirs; where two parts meet,
    the line runs along the contact. A piece joined to nobody keeps the doll's side (territory)."""
    if count < 2:
        return None
    H, W = doll.shape[:2]
    # `doll` is what the picture is compared with (the doll, or the picture it is cut against); the sides are the doll's.
    sides = [territory(doll_a, k, count) for k in range(count)]
    if any(t is None for t in sides):
        return None
    m, _ = new_pixels(doll, opt, key, fine)
    # On a quarter grid (a flood step per px; a whole lock is a few hundred).
    f = 4
    w, h = max(1, W // f), max(1, H // f)
    small = lambda x: cv2.resize(x.astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST).astype(bool)
    ms = small(m)
    # What a subject drew over its own doll figure (the figures told apart by their outlines, not by columns) is its
    # own — except next to another figure, where a neighbour's lock may hang over it; that, and what lies past the
    # figures, goes to whoever reaches it first.
    figs = split_figures(small(doll_a > 0.5), count)
    if figs is None:
        return None
    r = max(2, round(0.025 * max(w, h)))
    lab = np.zeros((h, w), np.int32)
    for k in range(count):
        mine = figs == k + 1
        others = cv2.dilate(((figs > 0) & ~mine).astype(np.uint8), kernel(r)).astype(bool)
        lab[mine & ~others & ms] = k + 1
    # First each subject only into what is the colour of its own part (the grandma's white curls do not take the black
    # lock touching them, 2026-10-20), then the rest by distance.
    col = cv2.resize(to_lab(on_white(opt[..., :3], opt[..., 3])), (w, h), interpolation=cv2.INTER_AREA)
    means = [col[lab == k + 1].mean(axis=0) if (lab == k + 1).any() else None for k in range(count)]
    dist = np.stack([np.linalg.norm(col - mu, axis=2) if mu is not None else np.full((h, w), np.inf, np.float32) for mu in means])
    best = dist.min(axis=0)
    for _ in range(4 * max(w, h)):
        moved = False
        for k in range(count):
            if means[k] is None:
                continue
            add = cv2.dilate((lab == k + 1).astype(np.uint8), kernel(1)).astype(bool) & (lab == 0) & ms & (dist[k] <= best + OWN_COLOUR_DE)
            if add.any():
                lab[add] = k + 1
                moved = True
        if not moved:
            break
    flood(lab, ms)
    # Back to the canvas with smooth lines between two subjects (a nearest-neighbour resize left 4 px steps along where
    # two hats touch): each label's share interpolated, the biggest one wins.
    big = np.argmax(np.stack([cv2.resize((lab == k).astype(np.float32), (W, H), interpolation=cv2.INTER_LINEAR) for k in range(count + 1)]), axis=0)
    return [(big == k + 1) | ((big == 0) & t) for k, t in enumerate(sides)]


def part_region(doll: np.ndarray, opt: np.ndarray, key: str | None = None, own: np.ndarray | None = None, fine: bool = False, spread: bool = False) -> tuple[np.ndarray, dict]:
    """The pixels an option picture (registered onto the doll, both RGBA on one canvas) drew anew: a clearly different
    colour where both are figure, or figure where the doll has none (hair past the head, a skirt past the legs).
    The re-drawn outlines (a 1–2 px line where a contour moved a fraction of a pixel) and specks are not the part;
    changes on another subject (`own`: this subject's territory) or far from the part's main piece neither; nor
    anything in the doll's underwear colour `key` (the AI
    re-draws the underwear a little where a jacket opens — a line along its edge, 2026-10-14).
    → (region, {px, lost}): `lost` = doll figure the picture took away (an arm moved, a hand erased) — a layer can only
    add, so that picture must be drawn again."""
    H, W = doll.shape[:2]
    s = max(H, W) / 1024
    da, oa = doll[..., 3], opt[..., 3]
    m, keyed = new_pixels(doll, opt, key, fine)
    if own is not None:
        m &= own
    # A part is one subject's and lies together: its biggest piece and what is near it (the two fronts of an open jacket,
    # a bun and its locks, a glass and the fingers round it). Changes elsewhere are the AI re-drawing a little — the other
    # woman's legs re-drawn while a glass was put in this one's hand came along as dark dots (2026-10-14).
    lab, n = ndi.label(m)
    if n:
        sizes = ndi.sum(m, lab, range(1, n + 1))
        main = lab == int(np.argmax(sizes)) + 1
        dist = cv2.distanceTransform((~main).astype(np.uint8), cv2.DIST_L2, 5)
        near = ndi.minimum(dist, lab, range(1, n + 1))
        # A part in pieces far apart (an outfit = a hat above the face + a sweater below it — on a big figure a whole
        # face apart, 2026-10-19) keeps every real piece on its own side.
        reach = (0.6 if spread else 0.05 if fine else 0.08) * max(H, W)
        if fine:
            # A face's features are as far apart as the face is big: a character drawn alone fills its canvas (a pose
            # set, 2026-10-21 — one eye of each expression was left out at a twentieth of the canvas).
            fig = (da > 0.5) if own is None else ((da > 0.5) & own)
            ys, xs = np.nonzero(fig)
            if len(xs):
                reach = max(reach, 0.12 * max(int(xs.max() - xs.min()), int(ys.max() - ys.min())))
        real = [i for i in range(n) if sizes[i] >= (30 if fine else 300) * s * s]
        keep = [i + 1 for i in real if near[i] <= reach]
        # A face's features lie apart (two eyes, two brows, a mouth): each near the one before it, not all near the
        # biggest — the open eye of a wink was the biggest, the winking one and a brow were left out (2026-10-20).
        while fine:
            dist = cv2.distanceTransform((~np.isin(lab, keep)).astype(np.uint8), cv2.DIST_L2, 5)
            near = ndi.minimum(dist, lab, range(1, n + 1))
            more = [i + 1 for i in real if i + 1 not in keep and near[i] <= reach]
            if not more:
                break
            keep += more
        m = np.isin(lab, keep)
    # A small hole inside the part where it happens to match the doll (a highlight on a white collar) is the part's.
    inv = ~m
    lab, n = ndi.label(inv)
    if n:
        sizes = ndi.sum(inv, lab, range(1, n + 1))
        border = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]])).tolist())
        holes = [i + 1 for i, v in enumerate(sizes) if v <= 1500 * s * s and (i + 1) not in border]
        if holes:
            m |= np.isin(lab, holes)
    # The part's own drawn outline round it: one px more (never past the picture's own alpha).
    m = cv2.dilate(m.astype(np.uint8), kernel(1)).astype(bool) & (oa > 0.02) & ~keyed
    lost = clean((da - oa) > 0.5, open_r=1, close_r=1, min_px=round(150 * s * s))
    return m, {"px": int(m.sum()), "lost": int(lost.sum())}


def register_option(doll: np.ndarray, rgba: np.ndarray, key: str | None, own: np.ndarray | None) -> tuple[np.ndarray, dict]:
    """An option picture onto the doll. The local flow learns ONLY from the doll pixels it kept: its solid new areas
    (found on the affine-registered picture) are left out — learnt from re-drawn fingers round a new glass, the flow
    bent the glass (2026-10-15). Thin difference bands (an outline the AI shifted a few px — a pair of legs) stay in, so
    the flow moves them back."""
    white = on_white(doll[..., :3], doll[..., 3])
    s = max(doll.shape[:2]) / 1024
    warp = affine_of(white, rgba)
    reg0, _ = register_rgba(white, rgba, local=False, warp=warp)
    rough, _ = part_region(doll, reg0, key, own)
    solid = cv2.morphologyEx(rough.astype(np.uint8), cv2.MORPH_OPEN, kernel(max(4, round(6 * s))))
    exclude = cv2.dilate(solid, kernel(max(6, round(10 * s)))).astype(bool)
    return register_rgba(white, rgba, exclude=exclude, warp=warp)


# ---- 3. cut: the files ---------------------------------------------------------------------------------------

def recolor(colour: np.ndarray, alpha: np.ndarray, target_hex: str | None, tint: float = 0.15) -> np.ndarray:
    """The part in another colour: where the file has the part's own hue (its median), the lightness keeps its shading
    around the target's and the hue moves to the target; an outline, a button, a bit of skin (another hue) keep theirs."""
    if not target_hex:
        return colour
    sel = alpha > 0.5
    if sel.sum() < 10:
        return colour
    lab = to_lab(colour)
    ab = lab[..., 1:]
    ab0 = np.median(ab[sel], axis=0)
    dist = np.linalg.norm(ab - ab0, axis=2)
    w = np.clip(1 - (dist - 18) / 12, 0, 1)
    own = sel & (dist < 18)
    lm = float(lab[..., 0][own].mean()) if own.sum() >= 10 else float(lab[..., 0][sel].mean())
    tl = to_lab(hex_rgb(target_hex)[None, None])[0, 0]
    out = lab.copy()
    out[..., 0] = np.clip(tl[0] + (lab[..., 0] - lm) * (0.85 if tl[0] < 30 else 1.0), 0, 100)
    out[..., 1:] = tl[1:] + (ab - ab0) * tint
    return colour * (1 - w[..., None]) + from_lab(out) * w[..., None]


def unit(x: np.ndarray) -> np.ndarray:
    """0..1 floats of a picture kept as 8-bit (cut inputs are, 2026-10-19: 60+ float pictures took 11 GB)."""
    return x.astype(np.float32) / 255 if x.dtype == np.uint8 else x


@dataclass
class Option:
    name: str
    col: np.ndarray | None = None       # the option picture's colours (registered onto the doll, print size; float or 8-bit)
    alpha: np.ndarray | None = None     # … its alpha
    region: np.ndarray | None = None    # what it drew anew (part_region), maybe fixed by hand


@dataclass
class Slot:
    key: str
    label: str
    mode: str                                # shape | texture: each option its own picture · color: one picture, recoloured
    options: list[Option] = field(default_factory=list)
    colors: list[tuple[str, str]] = field(default_factory=list)   # (name, hex): shape colours (the first = as drawn)
    hexes: list[str | None] = field(default_factory=list)         # color mode: each option's hex (the first = as drawn)
    wraps: bool = False                      # back (the whole part) + front (where it lies on the doll's figure)
    figure: np.ndarray | None = None         # wraps: the figure the front lies on (8-bit alpha, full canvas); None = the doll
    ref_piece: str | None = None             # the option (piece key) whose picture it is cut against; None = the doll
    cut_colour: bool = False                 # drawn in a cut colour that stands out from what it lies on (white hair
                                             # under a white fur brim drawn blue): every colour is a recolour of it


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
    png: str                # the file, encoded as it is made (encode below): 200+ full-crop RGBA arrays took GBs
    bbox: list[int]
    piece: str = ""
    plate: str = ""         # key of its colours over the whole canvas (cut()["plates"])


def stack_check(ref: np.ndarray, ref_a: np.ndarray, pic: np.ndarray, pic_a: np.ndarray, a: np.ndarray, aa: float) -> tuple[bool, str]:
    """Does the file over what it was cut against give its 3b picture back (pixel lock: doll + file = that picture)?
    Asked 2026-10-30: the hair files had a step of skin colour on the forehead and torn curls the 3b picture did not
    have. Near the part: `holes` = the picture's figure the stack leaves transparent; the colour error (ΔE) of the stack
    against the picture, mean and 99th percentile."""
    near = cv2.dilate((a > 0.5).astype(np.uint8), kernel(max(4, round(16 * aa)))).astype(bool)
    ys, xs = np.nonzero(near)
    if not len(ys):
        return True, ""
    c = (slice(ys.min(), ys.max() + 1), slice(xs.min(), xs.max() + 1))
    A, Pa, Ra = a[c][..., None], pic_a[c], ref_a[c]
    comp_a = A[..., 0] + (1 - A[..., 0]) * Ra
    comp = (pic[c] * A + ref[c] * Ra[..., None] * (1 - A)) / np.maximum(comp_a[..., None], 1e-4)
    nr = near[c]
    holes = int(((Pa > 0.5) & (comp_a < 0.5) & nr).sum())
    m = nr & (Pa > 0.9) & (comp_a > 0.9)
    if not m.any():
        return True, ""
    d = np.linalg.norm(to_lab(np.clip(comp, 0, 1)) - to_lab(np.clip(pic[c], 0, 1)), axis=2)[m]
    mean, p99 = float(d.mean()), float(np.percentile(d, 99))
    ok = holes <= 300 * aa * aa and p99 <= 20
    detail = f"ghép lại lệch ảnh 3b: màu TB {mean:.1f} · tệ (p99) {p99:.1f} ΔE · lỗ {holes:,} px"
    if not ok:
        detail += " — mép cắt bẩn (bậc màu / rách): sửa tay file hoặc vẽ lại ảnh 3b"
    return ok, detail


def cut(body: np.ndarray, body_a: np.ndarray, slots: list[Slot], zones: list[Zone], encode: Callable[[np.ndarray], tuple[str, list[int]]], encode_plate: Callable[[np.ndarray], str]) -> dict:
    """The layer files. body / body_a: the doll × the body region. Every part file = its region × its own picture's
    alpha, in its own picture's colours (recoloured for another colour). Cropped by ONE common rectangle, 8-bit.
    encode: an RGBA file → (PNG, bbox); encode_plate: RGBA colours + the picture's alpha → PNG — each done at once, nothing big is kept."""
    H, W = body.shape[:2]
    checks: list[dict] = []

    alphas: dict[str, np.ndarray] = {}
    for s in slots:
        for i, o in enumerate(s.options):
            if o.region is None or o.alpha is None or o.col is None:
                continue
            a = np.clip(unit(o.region), 0, 1) * np.clip(unit(o.alpha), 0, 1)
            if (a > 0.5).sum() < 300:
                checks.append({"name": f"{s.label}: {o.name}", "ok": False, "detail": "Vùng trống — AI không vẽ gì khác búp bê (vẽ lại ảnh 3b này).", "piece": f"{s.key}#{i}"})
                continue
            alphas[f"{s.key}#{i}"] = a.astype(np.float16)

    zone_out = []
    for z in zones:
        m = clean(np.clip(unit(z.region), 0, 1) > 0.5, close_r=6)
        if m.sum() < 500:
            checks.append({"name": f"Vùng ảnh {z.id}", "ok": False, "detail": "Vùng ảnh khách trống — tô lại.", "piece": f"zone:{z.id}"})
            continue
        zone_out.append({"id": z.id, "mask": m})

    union = body_a > 0.01
    for a in alphas.values():
        union |= a > 0.01
    for z in zone_out:
        union |= z["mask"]
    # The options another is cut against (hair under the hats of an outfit picture): kept for the "Ghép = 3b" check,
    # which stacks the real files (body + that option's file + this one), not the picture it was drawn on.
    hosts = {s.ref_piece: alphas[s.ref_piece].copy() for s in slots if s.ref_piece and s.ref_piece in alphas}
    host_cols = {f"{s.key}#{i}": o.col for s in slots for i, o in enumerate(s.options) if f"{s.key}#{i}" in hosts}
    ys, xs = np.where(union)
    pad = 48
    x0, y0 = max(0, int(xs.min()) - pad), max(0, int(ys.min()) - pad)
    x1, y1 = min(W, int(xs.max()) + pad + 1), min(H, int(ys.max()) + pad + 1)
    c = (slice(y0, y1), slice(x0, x1))
    # Where the hair lies in front: over the doll's figure INCLUDING its drawn outline — times the doll's own soft alpha,
    # the outline of the bald head showed half through the hair (a grey arc across the bangs, 2026-10-15).
    aa = max(1.0, max(H, W) / 1024)
    fig = soft((body_a[c] > 0.02), grow=max(2, round(2 * aa)), blur=0.8 * aa)

    files: list[Out] = []
    views: list[Out] = []
    plates: dict[str, str] = {}
    figs: dict[str, np.ndarray] = {}

    def fig_of(s: Slot) -> np.ndarray:
        """The figure a wrapping part's front lies on when it is not the doll (hair over an outfit picture's sweaters)."""
        if s.key not in figs:
            fa = np.clip(unit(s.figure), 0, 1)
            if fa.shape != (H, W):
                fa = cv2.resize(fa, (W, H), interpolation=cv2.INTER_LINEAR)
            figs[s.key] = soft((fa[c] > 0.02) | (body_a[c] > 0.02), grow=max(2, round(2 * aa)), blur=0.8 * aa)
        return figs[s.key]

    def plate_of(col: np.ndarray, pa: np.ndarray) -> str:
        name = f"p{len(plates)}"
        plates[name] = encode_plate((np.clip(np.dstack([col, pa]), 0, 1) * 255).round().astype(np.uint8))
        return name

    def px(col: np.ndarray, a: np.ndarray) -> tuple[str, list[int]]:
        out = (np.clip(np.dstack([col, a]), 0, 1) * 255).round().astype(np.uint8)
        out[out[..., 3] == 0] = 0
        return encode(out)

    backs: list[dict] = []
    parts: list[dict] = []
    fronts: list[dict] = []
    for s in slots:
        made = False
        for i, o in enumerate(s.options):
            piece = f"{s.key}#{i}"
            if piece not in alphas:
                continue
            made = True
            a = alphas.pop(piece)[c].astype(np.float32)
            col0 = unit(o.col[c])
            pa = np.clip(unit(o.alpha[c]), 0, 1)
            ref_c, ref_a = body[c], np.clip(body_a[c], 0, 1)
            if s.ref_piece in hosts:
                ha = hosts[s.ref_piece][c].astype(np.float32)
                ra = ha + ref_a * (1 - ha)
                ref_c = (unit(host_cols[s.ref_piece][c]) * ha[..., None] + ref_c * (ref_a * (1 - ha))[..., None]) / np.maximum(ra[..., None], 1e-4)
                ref_a = ra
            ok, detail = stack_check(ref_c, ref_a, col0, pa, a, aa)
            if detail:
                checks.append({"name": f"Ghép = 3b: {s.label}: {o.name}", "ok": ok, "detail": detail, "piece": piece})
            if s.mode == "color":
                # One drawing, one file per colour option.
                for k, (name, hex_) in enumerate(zip([x.name for x in s.options], s.hexes)):
                    col = col0 if k == 0 and not s.cut_colour else recolor(col0, a, hex_)
                    files.append(Out(s.key, s.label, name, "", *px(col, a), piece, plate_of(col, pa)))
                break
            for k, (cname, hex_) in enumerate(s.colors or [("", None)]):
                col = col0 if k == 0 and not s.cut_colour else recolor(col0, a, hex_)
                plate = plate_of(col, pa)
                if s.wraps:
                    whole = px(col, a)
                    files.append(Out(f"{s.key}:back", f"{s.label} — lớp sau", o.name, cname, *whole, piece, plate))
                    views.append(Out(f"{s.key}:back", s.label, o.name, cname, *whole, piece, plate))
                    files.append(Out(f"{s.key}:front", f"{s.label} — lớp trước", o.name, cname, *px(col, a * (fig_of(s) if s.figure is not None else fig)), piece, plate))
                else:
                    files.append(Out(s.key, s.label, o.name, cname, *px(col, a), piece, plate))
        if not made:
            continue
        if s.wraps:
            backs.append({"key": f"{s.key}:back", "label": f"{s.label} — lớp sau", "follows": f"{s.key}:front"})
            fronts.append({"key": f"{s.key}:front", "label": f"{s.label} — lớp trước", "follows": None})
        else:
            parts.append({"key": s.key, "label": s.label, "follows": None})
    files.append(Out("body", "Thân", "Body", "", *px(body[c], body_a[c]), "body", plate_of(body[c], body_a[c])))
    order = backs + [{"key": "body", "label": "Thân", "follows": None}] + parts + fronts
    checks.append({"name": "Cắt theo phần khác búp bê", "ok": True, "detail": f"{len(files)} file — mỗi file là đúng pixel ảnh 3b của nó, thân là búp bê nguyên vẹn"})
    h, w = y1 - y0, x1 - x0
    return {
        "width": w,
        "height": h,
        "crop": {"x": x0, "y": y0, "w": w, "h": h},
        "master": {"w": W, "h": H},
        "order": order,
        "files": files,
        "views": views,
        "plates": plates,
        "zones": [{"id": z["id"], "polygon": polygon_of(z["mask"][c].astype(np.float32))} for z in zone_out],
        "checks": checks,
        "diff": np.zeros((h, w, 4), np.uint8),
    }
