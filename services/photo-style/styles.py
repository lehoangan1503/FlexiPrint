"""
Photo → art-style filters, classical image processing only (OpenCV + NumPy,
no neural network, no model download). Deterministic, ~0.1–1.5 s per photo.

Design goal: the result must still look like the customer's photo — same
eyes, markings, fur — with an art treatment ON TOP, not a mushy abstraction.
So every style is built from three layers:

  colour   a lightly abstracted version of the photo (edge-preserving, never
           a big blur or a hard palette cut), with the photo's own
           high-frequency detail added back
  ink      XDoG line art (Winnemöller et al. 2012, "XDoG: an eXtended
           difference-of-Gaussians compendium") — clean, connected strokes
           instead of the speckle an adaptive threshold gives
  medium   the paint itself (oil: canvas and impasto); oil pulls chroma
           back to the photo's own colours (`_keep_colour`).
           watercolor_ink is its own painted pipeline, see its docstring.

The silhouette outline for cut-out photos (the black line around the pet) is
drawn by app.py from the alpha channel, see `outline()` below.

Every filter takes and returns an RGB uint8 array. Sizes scale with the image
(`_unit`), so a 600 px and a 1600 px photo get the same look.
"""

from __future__ import annotations

from typing import Callable

import cv2
import numpy as np

Image = np.ndarray


# ---------------------------------------------------------------------------
# Building blocks
# ---------------------------------------------------------------------------


def _unit(img: Image) -> float:
    """1.0 at a 1000 px long side."""
    return max(img.shape[:2]) / 1000.0


def _odd(n: float, minimum: int = 3) -> int:
    k = max(minimum, int(round(n)))
    return k if k % 2 else k + 1


def _f(img: Image) -> np.ndarray:
    return img.astype(np.float32) / 255.0


def _u8(x: np.ndarray) -> Image:
    return np.clip(x * 255.0 + 0.5, 0, 255).astype(np.uint8)


def _noise(shape: tuple[int, ...], sigma: float, seed: int) -> np.ndarray:
    """Seeded smooth noise normalised to [0,1], HxW."""
    h, w = shape[:2]
    n = np.random.default_rng(seed).normal(0.0, 1.0, (h, w)).astype(np.float32)
    n = cv2.GaussianBlur(n, (0, 0), sigma)
    return (n - n.min()) / max(1e-6, float(n.max() - n.min()))


def _detail(img: Image, sigma: float) -> np.ndarray:
    """High-frequency layer of the photo (fur, whiskers, iris texture), float, zero-mean."""
    f = _f(img)
    return f - cv2.GaussianBlur(f, (0, 0), sigma)


def xdog(img: Image, sigma: float, k: float = 1.6, tau: float = 0.985, eps: float = -0.004, phi: float = 120.0) -> np.ndarray:
    """
    XDoG line art: 1 = paper, →0 = ink. A soft threshold (tanh) on a sharpened
    difference-of-Gaussians gives smooth, connected, anti-aliased strokes.
    Pre-smoothed with a bilateral filter so fur texture doesn't turn into hatching.
    """
    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    gray = cv2.bilateralFilter(gray, d=_odd(2.5 * sigma, 5), sigmaColor=25, sigmaSpace=2.5 * sigma)
    g = gray.astype(np.float32) / 255.0
    d = cv2.GaussianBlur(g, (0, 0), sigma) - tau * cv2.GaussianBlur(g, (0, 0), sigma * k)
    return np.where(d >= eps, 1.0, 1.0 + np.tanh(phi * (d - eps))).astype(np.float32).clip(0, 1)


def _clean_lines(lines: np.ndarray, u: float, min_area: float) -> np.ndarray:
    """Drop tiny ink islands (noise) while keeping every real stroke."""
    ink = (lines < 0.5).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)
    small = np.zeros(n, dtype=bool)
    small[1:] = stats[1:, cv2.CC_STAT_AREA] < int(min_area * u * u) + 4
    out = lines.copy()
    out[small[labels]] = 1.0
    return out


def _keep_colour(out: np.ndarray, img: Image, amount: float, sigma: float) -> np.ndarray:
    """
    Pull the result's chroma back to the photo's own colours (Lab a/b of a
    lightly blurred original), keeping the result's lightness. This is what
    stops a style from drifting the fur orange-to-brown or the eyes grey.
    """
    ref = cv2.cvtColor(cv2.GaussianBlur(_f(img), (0, 0), sigma), cv2.COLOR_RGB2LAB)
    lab = cv2.cvtColor(np.clip(out, 0, 1).astype(np.float32), cv2.COLOR_RGB2LAB)
    lab[..., 1:] = lab[..., 1:] * (1.0 - amount) + ref[..., 1:] * amount
    return np.clip(cv2.cvtColor(lab, cv2.COLOR_LAB2RGB), 0, 1)


def _brighten(x: np.ndarray, gamma: float, lift: float) -> np.ndarray:
    """Open up mid-tones (gamma < 1) and lift the black point — printed art reads brighter than a photo."""
    return lift + np.power(np.clip(x, 0, 1), gamma) * (1.0 - lift)


# ---------------------------------------------------------------------------
# Styles — every one keeps the photo's own colours and ends brighter than it.
# ---------------------------------------------------------------------------


def oil(img: Image, mask: np.ndarray | None = None) -> Image:
    u = _unit(img)
    bgr = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    painted = cv2.cvtColor(cv2.xphoto.oilPainting(bgr, max(2, int(round(3 * u))), 1), cv2.COLOR_BGR2RGB)
    # Brush strokes carry the colour; most of the photo's detail rides on top so it stays true to the original.
    colour = np.clip(_f(painted) + 0.8 * _detail(img, 1.5 * u + 0.8), 0, 1)
    colour = _keep_colour(colour, img, 0.8, 2.0 * u + 0.5)
    colour = _brighten(colour, 0.82, 0.03)
    # Canvas weave lit from the top-left.
    weave = _noise(img.shape, 1.0, 11)
    emboss = cv2.filter2D(weave, -1, np.array([[-1, -1, 0], [-1, 0, 1], [0, 1, 1]], np.float32))
    colour = colour * (1.0 + np.clip(emboss, -1, 1)[..., None] * 0.035)
    # Impasto: stroke edges catch light.
    gray = cv2.cvtColor(painted, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
    relief = cv2.filter2D(gray, -1, np.array([[-1, -0.5, 0], [-0.5, 0, 0.5], [0, 0.5, 1]], np.float32))
    return _u8(colour + np.clip(relief, -0.12, 0.12)[..., None] * 0.2)


# ---------------------------------------------------------------------------
# Watercolor + Ink — a separate painted pipeline (not a filter over the photo)
# ---------------------------------------------------------------------------



def _smoothstep(x: np.ndarray, a: float, b: float) -> np.ndarray:
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def _stroke_field(gray: np.ndarray, sigma: float) -> tuple[np.ndarray, np.ndarray]:
    """Unit vectors along the local structure (fur direction), from the smoothed structure tensor."""
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    jxx = cv2.GaussianBlur(gx * gx, (0, 0), sigma)
    jyy = cv2.GaussianBlur(gy * gy, (0, 0), sigma)
    jxy = cv2.GaussianBlur(gx * gy, (0, 0), sigma)
    theta = 0.5 * np.arctan2(2 * jxy, jxx - jyy)  # gradient direction; strokes run across it
    return -np.sin(theta), np.cos(theta)


def _smear(x: np.ndarray, vx: np.ndarray, vy: np.ndarray, length: float, steps: int) -> np.ndarray:
    """Line-integral smear along the stroke field: turns blobs into brush strokes that follow the fur."""
    h, w = x.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    acc = x.astype(np.float32).copy()
    for sign in (1.0, -1.0):
        px, py = xx.copy(), yy.copy()
        for _ in range(steps):
            ix = np.clip(px, 0, w - 1).astype(np.int32)
            iy = np.clip(py, 0, h - 1).astype(np.int32)
            px += sign * vx[iy, ix] * (length / steps)
            py += sign * vy[iy, ix] * (length / steps)
            acc += cv2.remap(x, px, py, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    return acc / (2 * steps + 1)


def _lab(x: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(np.clip(x, 0, 1).astype(np.float32), cv2.COLOR_RGB2LAB)


def _rgb(lab: np.ndarray) -> np.ndarray:
    return np.clip(cv2.cvtColor(lab.astype(np.float32), cv2.COLOR_LAB2RGB), 0, 1)


def _stretch(x: np.ndarray) -> np.ndarray:
    return (x - x.min()) / max(1e-6, float(x.max() - x.min()))


def _detail_l(img: Image, sigma: float) -> np.ndarray:
    """Luminance-only high-pass (fur texture), float, zero-mean."""
    g = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
    return g - cv2.GaussianBlur(g, (0, 0), sigma)


_INK = np.array([0x22, 0x1e, 0x1c], np.float32) / 255.0
_PAPER = np.array([254, 252, 248], np.float32) / 255.0


def _masked_blur(x: np.ndarray, m: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian blur of x using only pixels where m is set (the subject), so the backdrop doesn't bleed in."""
    num = cv2.GaussianBlur(x * m, (0, 0), sigma)
    den = cv2.GaussianBlur(m, (0, 0), sigma)
    return num / np.maximum(den, 1e-4)


def watercolor_ink(img: Image, mask: np.ndarray | None = None) -> Image:
    """
    The store's watercolour pet portrait (their result is a generative-AI
    redraw; this matches its measurable rules with image processing):

      markings, not lighting   paint value = lightness relative to the
               large-scale shading (stripes) + a little absolute darkness,
               smeared along the fur, median-cleaned (no camouflage islands)
      4 glazes rank-equalised to the store's split — paper 27 %, peach 30 %,
               light orange 20 %, stripe 21 % — in LCh relative to the coat:
               lighter tones yellower, strokes warmer (store: H 89 → 65;
               ginger stripe ≈ L71 C50). A dark coat gets a dark ramp.
      features eyes / nose / mouth in the photo's own colours: features
               differ in hue ANGLE from the coat or are dark AND neutral
               (a brown coat shadow is neither); eyes are grown from the
               pupil blob into a convex hull; the nose is found by position
               below the eyes (its pink is only ~18° off a ginger coat)
      ink      only where a portrait artist puts it: thin outline, bold eye
               rims, XDoG inside features, and long straight whiskers / ear
               hairs (inpainted out of the photo, redrawn as hairlines).
               Never inside the fur.

    The subject stays fully opaque. Works at >= 1024 px and returns at that
    size (app.render resizes the alpha to match).
    """
    s = max(1.0, 1024.0 / max(img.shape[:2]))
    if s > 1:
        img = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC)
    h, w = img.shape[:2]
    u = _unit(img)
    alpha = np.ones((h, w), np.float32) if mask is None else cv2.resize(mask.astype(np.float32), (w, h), interpolation=cv2.INTER_LINEAR)
    subject = alpha > 0.5
    if not subject.any():
        subject[:] = True
    sm = subject.astype(np.float32)

    # Whiskers / ear hairs → painted out, redrawn as hairlines.
    ridge = cv2.morphologyEx(cv2.cvtColor(img, cv2.COLOR_RGB2GRAY), cv2.MORPH_TOPHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (_odd(7 * u),) * 2))
    n, cc, stats, _ = cv2.connectedComponentsWithStats(((ridge > 12) & (alpha > 0.05)).astype(np.uint8), connectivity=8)
    span = np.maximum(stats[:, cv2.CC_STAT_WIDTH], stats[:, cv2.CC_STAT_HEIGHT])
    thin = (span > 24 * u) & (stats[:, cv2.CC_STAT_AREA] < span * 5.0 * u)
    thin[0] = False
    cand = thin[cc].astype(np.uint8)
    # Keep only long, fairly straight hairs: a skeleton much longer than its span is fur texture, not a whisker.
    skel = cv2.ximgproc.thinning(cand * 255) > 0
    k2, cc2, st2, _ = cv2.connectedComponentsWithStats(skel.astype(np.uint8), connectivity=8)
    sp2 = np.hypot(st2[:, cv2.CC_STAT_WIDTH], st2[:, cv2.CC_STAT_HEIGHT])
    good = (sp2 > 26 * u) & (st2[:, cv2.CC_STAT_AREA] < 1.6 * sp2)
    good[0] = False
    keep = np.zeros(n, bool)
    keep[np.unique(cc[skel & good[cc2]])] = True
    keep[0] = False
    wmask = (keep[cc] & thin[cc]).astype(np.uint8)
    if wmask.any():
        img = cv2.inpaint(img, cv2.dilate(wmask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (_odd(3 * u),) * 2)), 3 * u, cv2.INPAINT_TELEA)
    hair = cv2.ximgproc.thinning(wmask * 255) > 0
    whisker = np.clip(cv2.GaussianBlur(hair.astype(np.float32), (0, 0), 0.45 * u + 0.2) * 2.2, 0, 1)

    base = cv2.edgePreservingFilter(img, flags=cv2.RECURS_FILTER, sigma_s=20 * u, sigma_r=0.2)
    det = cv2.edgePreservingFilter(img, flags=cv2.RECURS_FILTER, sigma_s=10 * u, sigma_r=0.1)
    lab_b = _lab(_f(base))
    lab_d = _lab(_f(det))
    Lb = lab_b[..., 0] / 100.0
    Ld = lab_d[..., 0] / 100.0

    # Features (eyes / nose / mouth).
    ab = lab_d[..., 1:]
    coat = np.median(lab_b[..., 1:][subject], axis=0)
    # Features differ from the coat in HUE (green/blue eyes, pink nose) or are very dark (pupils, mouth).
    # Paler or richer fur of the coat's own hue (white muzzle, inner ear, a strong stripe) is paint, not a feature.
    cdir = coat / max(1e-3, float(np.hypot(*coat)))
    along = ab @ cdir
    perp = np.hypot(*np.moveaxis(ab - along[..., None] * cdir, 2, 0))
    chroma = np.hypot(ab[..., 0], ab[..., 1])
    # Hue ANGLE from the coat (not a/b distance, which grows with saturation): nose ~30°, eyes more, a
    # red-brown shadow in ginger fur only ~13°.
    dhue = np.degrees(np.abs(np.angle(np.exp(1j * (np.arctan2(ab[..., 1], ab[..., 0]) - np.arctan2(coat[1], coat[0]))))))
    feat = np.maximum(_smoothstep(dhue, 20, 30) * _smoothstep(chroma, 8, 16), _smoothstep(-lab_d[..., 0], -30, -16) * (1 - _smoothstep(chroma, 16, 28)))  # dark AND neutral: pupil, nose leather, mouth — not a brown coat shadow
    feat = (feat * subject).astype(np.float32)
    feat = cv2.morphologyEx(feat, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (_odd(5 * u),) * 2))
    fb = cv2.morphologyEx((feat > 0.4).astype(np.uint8), cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (_odd(25 * u),) * 2))
    feat = np.maximum(feat, fb.astype(np.float32) * subject)
    # Eyes: seeded by the dark pupil/eye blobs, grown into the surrounding iris (whose colour can be close to
    # the coat's), then the convex hull = the eye shape. Its colour comes from the photo and the store rims it in ink.
    n_, lab_, st_, _ = cv2.connectedComponentsWithStats(fb * subject.astype(np.uint8))
    eyes = np.zeros((h, w), np.uint8)
    coat_like = (along > 0.6 * float(np.hypot(*coat))) & (perp < 12)  # orange fur next to the eye
    coat_L = float(np.median(lab_d[..., 0][subject]))
    irisish = (((perp > 7) | (lab_d[..., 0] < min(50.0, coat_L - 20))) & ~coat_like).astype(np.uint8)
    subj_area = float(subject.sum())
    for i in range(1, n_):
        bw, bh, area = st_[i, cv2.CC_STAT_WIDTH], st_[i, cv2.CC_STAT_HEIGHT], st_[i, cv2.CC_STAT_AREA]
        if not (area > 700 * u * u and area < 0.02 * subj_area and 0.4 < bw / bh < 2.5 and lab_d[..., 0][lab_ == i].mean() < 40):
            continue
        seed = (lab_ == i).astype(np.uint8)
        grow = cv2.dilate(seed, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (_odd(0.7 * max(bw, bh)),) * 2)) & irisish
        grow = cv2.morphologyEx(grow | seed, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (_odd(5 * u),) * 2))
        k_, gl_, gs_, _ = cv2.connectedComponentsWithStats(grow)
        j = int(np.argmax(gs_[1:, cv2.CC_STAT_AREA])) + 1 if k_ > 1 else 0
        if j:
            pts = cv2.findNonZero((gl_ == j).astype(np.uint8))
            hull = cv2.convexHull(pts)
            if cv2.contourArea(hull) < 5 * area:  # an eye, not a leak into dark fur
                cv2.fillConvexPoly(eyes, hull, 1)
    feat = np.maximum(feat, cv2.GaussianBlur(eyes.astype(np.float32), (0, 0), 1.0 * u))
    # Nose: its pink is only ~18° off a ginger coat (a red-brown shadow is ~14°), so colour alone can't tell them
    # apart — position can. With two eyes found, look below and between them with a looser hue test.
    k3, _, _, cen = cv2.connectedComponentsWithStats(eyes)
    if k3 == 3:
        (x1, y1), (x2, y2) = cen[1], cen[2]
        d = float(np.hypot(x2 - x1, y2 - y1))
        yy, xx = np.mgrid[0:h, 0:w]
        zone = (((xx - (x1 + x2) / 2) / (0.35 * d)) ** 2 + ((yy - ((y1 + y2) / 2 + 0.8 * d)) / (0.45 * d)) ** 2) < 1
        nose = (zone & (dhue > 12) & (chroma > 15)).astype(np.uint8)
        nose = cv2.morphologyEx(nose, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (_odd(5 * u),) * 2))
        feat = np.maximum(feat, cv2.GaussianBlur(nose.astype(np.float32), (0, 0), 1.5 * u))
    feat = cv2.GaussianBlur(cv2.dilate(feat, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (_odd(5 * u),) * 2)), (0, 0), 2.5 * u)
    feat = np.clip(feat * 1.6, 0, 1)

    # Paint value: markings (lightness relative to the large-scale shading) + absolute darkness,
    # smeared along the fur so shapes become strokes.
    shade = _masked_blur(Lb, sm, 16 * u)
    rel = Lb - shade
    spread = float(np.std(rel[subject])) + 1e-3
    p5, p95 = np.percentile(Lb[subject], [5, 95])
    rank = np.clip((p95 - Lb) / max(1e-3, p95 - p5), 0, 1)
    v = 0.75 * np.clip(-rel / (2.5 * spread), -0.5, 1) + 0.25 * rank
    white = _smoothstep(Ld, 0.72, 0.86) * (1 - _smoothstep(chroma, 12, 22))
    v = v - 0.8 * white
    vx, vy = _stroke_field(cv2.cvtColor(_f(base), cv2.COLOR_RGB2GRAY), 5 * u)
    grain = _stretch(_smear(_noise((h, w), 1.2 * u, 21), vx, vy, 14 * u, 5))
    v = _smear(cv2.GaussianBlur(v.astype(np.float32), (0, 0), 2.5 * u), vx, vy, 20 * u, 7)
    v = cv2.GaussianBlur(v + 0.04 * (grain - 0.5), (0, 0), 1.2 * u)
    # Rank-equalise inside the subject → the store's even 4-tone split (27 / 30 / 18 / 21 % from light to dark).
    ref = np.sort(v[subject])
    r = np.searchsorted(ref, v).astype(np.float32) / max(1, ref.size)
    # Median on the rank removes small islands (the camouflage look) and keeps the glaze edges.
    r = cv2.medianBlur((r * 255).astype(np.uint8), _odd(11 * u)).astype(np.float32) / 255.0
    w1, w2, w3 = (_smoothstep(r, c - 0.06, c + 0.06) for c in (0.27, 0.57, 0.77))
    # Drop pigment specks in the darkest glaze: a painter lays strokes, not dots.
    bl = (w3 > 0.5).astype(np.uint8)
    _, cc_, st_, _ = cv2.connectedComponentsWithStats(bl, connectivity=8)
    small = st_[:, cv2.CC_STAT_AREA] < 80 * u * u
    small[0] = False
    w3 = np.where(small[cc_], w3 * 0.3, w3)
    w1, w2, w3 = (cv2.GaussianBlur(x, (0, 0), 0.8 * u) for x in (w1, w2, w3))

    # Tone ramp in LCh, relative to the coat: lighter tones cooler/yellower, strokes warmer (store: H 89 → 65).
    cb = np.hypot(lab_b[..., 1], lab_b[..., 2])
    cc = float(np.clip(np.percentile(cb[subject], 60), 0, 48))
    coat_h = float(np.arctan2(coat[1], coat[0]))
    med = float(np.median(Lb[subject]))
    dark = float(np.clip((0.62 - med) / 0.4, 0, 1))  # 0 = light/ginger coat, 1 = black coat
    ramp = [  # (L light-coat, L dark-coat, chroma × cc, hue offset °)
        (95, 72, 0.15, 18),
        (88, 56, 0.45, 9),
        (82, 42, 0.75, 3),
        (71, 28, 1.10, -6),
    ]
    near_coat = (1 - _smoothstep(np.linalg.norm(lab_b[..., 1:] - coat, axis=2), 22, 40))[..., None]
    own = lab_b[..., 1:]
    tones = []
    for Ll, Lk, cm, dh in ramp:
        hh = coat_h + np.radians(dh)
        ab_t = np.array([np.cos(hh), np.sin(hh)], np.float32) * cc * cm
        own_c = np.maximum(np.hypot(own[..., 0], own[..., 1]), 1e-3)[..., None]
        own_t = own / own_c * np.minimum(own_c, cc * cm + 6)
        ab_px = near_coat * ab_t + (1 - near_coat) * own_t
        # Inside each glaze the wash still varies with the paint value (not a flat fill).
        L = (Ll + (Lk - Ll) * dark) - 7 * (r - 0.5)
        tones.append(_rgb(np.dstack([L, ab_px[..., 0], ab_px[..., 1]])))
    col = tones[0]
    for t_, wt in zip(tones[1:], (w1, w2, w3)):
        col = col * (1 - wt[..., None]) + t_ * wt[..., None]
    # Wet edge: each glaze pools a little darker at its border.
    edge = sum(np.clip(x - cv2.erode(x, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (_odd(4 * u),) * 2)), 0, 1) for x in (w1, w2, w3))
    col = col * (1 - 0.06 * cv2.GaussianBlur(edge, (0, 0), 0.7 * u))[..., None]
    col = col * (0.98 + 0.04 * grain)[..., None]
    col = np.clip(col + (0.12 * _detail_l(img, 2.0 * u))[..., None], 0, 1)
    col = col * (1 - (white * (1 - w2))[..., None] * 0.7) + _PAPER * (white * (1 - w2))[..., None] * 0.7

    # Features: crisp and a little richer.
    fl = lab_d.copy()
    fl[..., 1:] *= 1.45
    fl[..., 0] = np.where(fl[..., 0] > 22, np.minimum(96, fl[..., 0] + 20 * _smoothstep(fl[..., 0], 22, 42) * (1 - _smoothstep(fl[..., 0], 70, 90))), fl[..., 0])
    col = col * (1 - feat[..., None]) + _rgb(fl) * feat[..., None]

    # Ink only where a portrait artist puts it.
    core = cv2.dilate((feat > 0.3).astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (_odd(9 * u),) * 2)).astype(np.float32)
    lines = _clean_lines(xdog(det, 0.9 * u + 0.5, tau=0.98, eps=-0.004, phi=110), u, 20)
    ink = (1.0 - lines) * cv2.GaussianBlur(core, (0, 0), 2 * u) * 0.95
    if mask is not None:
        m = (cv2.GaussianBlur(alpha, (0, 0), 2.0 * u) > 0.5).astype(np.uint8)
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (_odd(7 * u),) * 2))
        d_in = cv2.distanceTransform(m, cv2.DIST_L2, 5)
        width = (0.8 + 0.7 * _noise((h, w), 30 * u, 5)) * u
        e = np.clip(width + 0.6 - np.abs(d_in - 1.4 * u), 0, 1) * m
        ink = np.maximum(ink, e * (0.55 + 0.45 * _smoothstep(_noise((h, w), 14 * u, 9), 0.2, 0.35)) * 0.95)
    ink = np.maximum(ink, whisker * 0.9)
    if eyes.any():
        d_out = cv2.distanceTransform(1 - eyes, cv2.DIST_L2, 5)
        d_inn = cv2.distanceTransform(eyes, cv2.DIST_L2, 5)
        sd = np.where(eyes > 0, -d_inn, d_out)
        ink = np.maximum(ink, np.clip(2.2 * u + 0.6 - np.abs(sd - 0.3 * u), 0, 1) * 0.95)
    ink = np.clip(ink, 0, 1)[..., None]
    col = col * (1 - ink) + _INK * ink

    paper_tex = 0.6 * _noise((h, w), 18 * u, 31) + 0.4 * _noise((h, w), 0.7, 33) - 0.5
    col = col * (1 + 0.03 * paper_tex * (1 - feat))[..., None]
    return _u8(col)


# (rgb, subject mask in [0,1] or None when the photo has no transparency) -> rgb
STYLES: dict[str, Callable[[Image, np.ndarray | None], Image]] = {
    "oil": oil,
    "watercolor_ink": watercolor_ink,
}

# Silhouette outline around a cut-out subject: (width as ‰ of the long side, RGB colour). None = no outline.
# Width is relative so the line survives the zone scaling the photo down on the product.
OUTLINES: dict[str, tuple[float, tuple[int, int, int]] | None] = {
    "oil": None,
    "watercolor_ink": None,  # draws its own thin, broken contour
}


def outline(rgb: Image, alpha: np.ndarray, width: float, color: tuple[int, int, int]) -> tuple[Image, np.ndarray]:
    """
    Brush-ink contour around the subject, like a hand-drawn portrait: it
    follows the body's shape (thin protrusions such as whiskers are opened
    away first, so they aren't each wrapped in a blob), its thickness swells
    and thins along the way like a real stroke, and it sits mostly outside the
    silhouette so the fur edge stays visible. Where the photo frame crops the
    body the browser fades the subject (lib/photo-process.ts fadeCroppedEdges),
    and the stroke tapers out with it.
    """
    long_side = max(rgb.shape[:2])
    w = max(2.5, width / 1000.0 * long_side)
    mask = (alpha > 128).astype(np.uint8)
    r = _odd(3 * w, 3)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (r, r)))
    mask = (cv2.GaussianBlur(mask.astype(np.float32), (0, 0), 0.8 * w) > 0.5).astype(np.uint8)
    outside = cv2.distanceTransform(1 - mask, cv2.DIST_L2, 5)
    inside = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
    signed = np.where(mask > 0, -inside, outside)  # <0 inside, >0 outside
    # Stroke thickness varies smoothly along the contour (0.55×..1.35×).
    swell = 0.55 + 0.8 * _noise(rgb.shape, 0.06 * long_side, 17)
    half = w * swell / 2.0
    centre = 0.25 * w  # a little outside the edge
    line = np.clip(half + 0.7 - np.abs(signed - centre), 0.0, 1.0)
    out = rgb.astype(np.float32) * (1 - line[..., None]) + np.array(color, np.float32) * line[..., None]
    new_alpha = np.maximum(alpha.astype(np.float32), line * 255.0)
    return out.astype(np.uint8), new_alpha.astype(np.uint8)
