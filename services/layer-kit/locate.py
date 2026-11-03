"""
Where a small piece sits in a finished picture (2026-11-04, import of hand-off folders whose layers are small cut
pieces placed per version — the gingerbread train: 8 characters of 328×418, each seat of each version its own spot).

The finished print shows the piece scaled and often partly hidden (a mug in front of a character). Each scale is tried
with masked template matching on the piece's opaque pixels (colour edges, robust to the hidden part being a different
colour), the best spots are then scored by how many of the piece's opaque pixels match the picture there ("seen") —
a hidden lower half still leaves the upper half matching.

Returns every spot found (several seats can show the same piece), best first, as the piece's whole box (its
transparent margin included) in the picture's coordinates after `region` (the print inside a bigger sheet).
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np


@dataclass
class Spot:
    x: float
    y: float
    w: float
    h: float
    scale: float
    match: float
    seen: float
    # The same over the piece's upper half (what stays in sight when something lower stands in front).
    seen_top: float


def _bgr_alpha(rgba: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    if rgba.ndim == 2:
        rgba = cv2.cvtColor(rgba, cv2.COLOR_GRAY2BGRA)
    if rgba.shape[2] == 3:
        a = np.full(rgba.shape[:2], 255, np.uint8)
        return rgba, a
    return rgba[:, :, :3], rgba[:, :, 3]


def _seen(ref: np.ndarray, ref_a: np.ndarray, piece: np.ndarray, piece_a: np.ndarray, x: int, y: int, top: float = 1.0) -> float:
    """Share of the piece's opaque pixels (its upper `top` part) that match the picture at (x, y) — colour within a
    tolerance."""
    if top < 1.0:
        cut = max(1, int(piece.shape[0] * top))
        piece, piece_a = piece[:cut], piece_a[:cut]
    H, W = ref.shape[:2]
    h, w = piece.shape[:2]
    x0, y0, x1, y1 = max(0, x), max(0, y), min(W, x + w), min(H, y + h)
    if x1 <= x0 or y1 <= y0:
        return 0.0
    p = piece[y0 - y : y1 - y, x0 - x : x1 - x].astype(np.int16)
    pa = piece_a[y0 - y : y1 - y, x0 - x : x1 - x] > 200
    r = ref[y0:y1, x0:x1].astype(np.int16)
    ra = ref_a[y0:y1, x0:x1] > 200
    total = int((piece_a > 200).sum())
    if not total:
        return 0.0
    close = (np.abs(p - r).max(axis=2) < 22) & pa & ra
    return float(close.sum()) / total


def locate(ref_rgba: np.ndarray, piece_rgba: np.ndarray, region: tuple[int, int, int, int] | None = None,
           scale_min: float = 0.2, scale_max: float = 1.6, max_spots: int = 12, min_seen: float = 0.3) -> list[Spot]:
    if region:
        rx, ry, rw, rh = region
        ref_rgba = ref_rgba[ry : ry + rh, rx : rx + rw]
    ref, ref_a = _bgr_alpha(ref_rgba)
    piece, piece_a = _bgr_alpha(piece_rgba)
    # Transparent where the picture is transparent: compare on a neutral grey, never on black.
    ref_g = ref.copy()
    ref_g[ref_a < 128] = 128
    H, W = ref.shape[:2]
    ph, pw = piece.shape[:2]

    # Coarse pass on a half-size picture.
    k = 0.5 if max(H, W) > 700 else 1.0
    small = cv2.resize(ref_g, None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
    cands: list[tuple[float, float, int, int]] = []  # (score, scale, x, y) at full size
    s = scale_min
    while s <= scale_max + 1e-9:
        tw, th = int(round(pw * s * k)), int(round(ph * s * k))
        if 12 <= tw <= small.shape[1] and 12 <= th <= small.shape[0]:
            t = cv2.resize(piece, (tw, th), interpolation=cv2.INTER_AREA)
            m = cv2.resize(piece_a, (tw, th), interpolation=cv2.INTER_AREA)
            m = (m > 200).astype(np.uint8)
            if m.sum() > 50:
                res = cv2.matchTemplate(small, t, cv2.TM_SQDIFF, mask=m)
                res = res / float(m.sum())  # mean squared difference per opaque pixel (3 channels)
                res[~np.isfinite(res)] = 1e12
                # A few best per scale, apart from each other.
                r = res.copy()
                for _ in range(max_spots):
                    _, _, loc, _ = cv2.minMaxLoc(r)
                    v = float(r[loc[1], loc[0]])
                    if v >= 1e11:
                        break
                    cands.append((v, s, int(loc[0] / k), int(loc[1] / k)))
                    cv2.rectangle(r, (loc[0] - tw // 2, loc[1] - th // 2), (loc[0] + tw // 2, loc[1] + th // 2), 1e12, -1)
        s += 0.02 if s < 0.6 else 0.03

    # Refine the best candidates at full size: ±3 % scale, ±6 px, scored by the share of the piece seen.
    cands.sort(key=lambda c: c[0])
    spots: list[Spot] = []
    for v, s, cx, cy in cands[: max_spots * 8]:
        best = (-1.0, s, cx, cy)
        for ds in (-0.02, -0.015, -0.01, -0.005, 0.0, 0.005, 0.01, 0.015, 0.02):
            sc = s + ds
            tw, th = int(round(pw * sc)), int(round(ph * sc))
            if tw < 8 or th < 8:
                continue
            t = cv2.resize(piece, (tw, th), interpolation=cv2.INTER_AREA)
            ta = cv2.resize(piece_a, (tw, th), interpolation=cv2.INTER_AREA)
            m = (ta > 200).astype(np.uint8)
            x0, y0 = max(0, cx - 8), max(0, cy - 8)
            x1, y1 = min(W, cx + tw + 8), min(H, cy + th + 8)
            win = ref_g[y0:y1, x0:x1]
            if win.shape[0] < th or win.shape[1] < tw:
                continue
            res = cv2.matchTemplate(win, t, cv2.TM_SQDIFF, mask=m)
            res[~np.isfinite(res)] = 1e18
            _, _, loc, _ = cv2.minMaxLoc(res)
            x, y = x0 + loc[0], y0 + loc[1]
            seen = _seen(ref, ref_a, t, ta, x, y) + _seen(ref, ref_a, t, ta, x, y, 0.5)
            if seen > best[0]:
                best = (seen, sc, x, y)
        _, sc, x, y = best
        tw, th = int(round(pw * sc)), int(round(ph * sc))
        t = cv2.resize(piece, (tw, th), interpolation=cv2.INTER_AREA)
        ta = cv2.resize(piece_a, (tw, th), interpolation=cv2.INTER_AREA)
        seen = _seen(ref, ref_a, t, ta, x, y)
        seen_top = _seen(ref, ref_a, t, ta, x, y, 0.5)
        if max(seen, seen_top) < min_seen:
            continue
        w, h = pw * sc, ph * sc
        # The same spot found twice (two scales, two candidates): kept once.
        if any(abs(sp.x - x) < w * 0.3 and abs(sp.y - y) < h * 0.3 for sp in spots):
            continue
        spots.append(Spot(x=float(x), y=float(y), w=round(w, 1), h=round(h, 1), scale=round(sc, 3), match=round(float(v), 1), seen=round(seen, 3), seen_top=round(seen_top, 3)))
        if len(spots) >= max_spots:
            break
    spots.sort(key=lambda sp: -max(sp.seen, sp.seen_top))
    return spots


@dataclass
class DiffBox:
    x: int
    y: int
    w: int
    h: int
    # Its pixels that differ (how much ink: a name vs a stray speck).
    pixels: int


def diff_boxes(a_rgba: np.ndarray, b_rgba: np.ndarray, region: tuple[int, int, int, int] | None = None,
               tol: int = 40, join: int = 12, min_pixels: int = 30) -> list[DiffBox]:
    """
    Where two versions of the same picture differ — the print with names minus the print without: each name's box.
    Differing pixels closer than `join` px are one box (the letters of a word, the words of a line).
    """
    if region:
        rx, ry, rw, rh = region
        a_rgba = a_rgba[ry : ry + rh, rx : rx + rw]
        b_rgba = b_rgba[ry : ry + rh, rx : rx + rw]
    if a_rgba.shape[:2] != b_rgba.shape[:2]:
        raise ValueError(f"sizes differ: {a_rgba.shape[1]}x{a_rgba.shape[0]} vs {b_rgba.shape[1]}x{b_rgba.shape[0]}")
    # No transparency at all (saved as RGB, or read as RGBA with alpha 255 everywhere) = flattened on a colour.
    a_flat = a_rgba.ndim == 3 and (a_rgba.shape[2] == 3 or int(a_rgba[:, :, 3].min()) == 255)
    b_flat = b_rgba.ndim == 3 and (b_rgba.shape[2] == 3 or int(b_rgba[:, :, 3].min()) == 255)
    a, aa = _bgr_alpha(a_rgba)
    b, ba = _bgr_alpha(b_rgba)
    a = a.astype(np.float32)
    b = b.astype(np.float32)
    # One of them flattened on a colour (a print saved without transparency): the other goes on that colour too.
    bg = a[0, 0] if a_flat and not b_flat else b[0, 0] if b_flat and not a_flat else np.array([128, 128, 128], np.float32)
    a = a * (aa[..., None] / 255.0) + bg * (1 - aa[..., None] / 255.0)
    b = b * (ba[..., None] / 255.0) + bg * (1 - ba[..., None] / 255.0)
    diff = (np.abs(a - b).max(axis=2) > tol).astype(np.uint8)
    joined = cv2.dilate(diff, np.ones((join, join), np.uint8)) if join > 1 else diff
    n, labels, stats, _ = cv2.connectedComponentsWithStats(joined, connectivity=8)
    out: list[DiffBox] = []
    for i in range(1, n):
        mask = (labels == i) & (diff > 0)
        px = int(mask.sum())
        if px < min_pixels:
            continue
        ys, xs = np.nonzero(mask)
        out.append(DiffBox(x=int(xs.min()), y=int(ys.min()), w=int(xs.max() - xs.min() + 1), h=int(ys.max() - ys.min() + 1), pixels=px))
    out.sort(key=lambda d: (d.y // 40, d.x))
    return out
