"""
Material rendering + production files for printed products (acrylic plates,
ceramic ornaments…). Pure numpy / OpenCV, no model.

The browser renders the live preview itself (customize-tool/lib/material-render.ts);
this module does the same outline maths at PRINT resolution and writes what the
factory needs:

    print.png   the artwork at the requested dpi, on the plate's canvas
    white.png   white-ink underlayer (black = print white) — acrylic only
    cut.svg     laser cut path in millimetres (the plate outline)
    preview.png the rendered product (same layer stack as the browser)
    meta.json   sizes, area, perimeter — useful for pricing / nesting

Rendering knobs (face colour, edge colours, bevel, finish…) come from the
caller as a `preset` dict — the catalog lives in customize-tool/lib/materials.ts
so there is exactly one list of materials.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import cv2
import numpy as np


# ---------------------------------------------------------------------------
# parameters
# ---------------------------------------------------------------------------


@dataclass
class Preset:
    face: str | None = "#ffffff"
    face_opacity: float = 1.0
    edge: tuple[str, str] = ("#f4f6f8", "#b9c1c9")
    bevel: float = 0.7
    pillow: float = 0.0
    finish: str = "gloss"  # gloss | sheen | grain | none
    print_tint: str | None = None

    @staticmethod
    def from_dict(d: dict | None) -> "Preset":
        d = d or {}
        edge = d.get("edge") or ("#f4f6f8", "#b9c1c9")
        return Preset(
            face=d.get("face", "#ffffff"),
            face_opacity=float(d.get("faceOpacity", 1.0)),
            edge=(str(edge[0]), str(edge[1])),
            bevel=float(d.get("bevel", 0.7)),
            pillow=float(d.get("pillow", 0.0)),
            finish=str(d.get("finish", "gloss")),
            print_tint=d.get("printTint"),
        )


@dataclass
class Params:
    material: str = "acrylic_white"
    shape: str = "contour"  # contour | main
    width_mm: float = 140.0
    border_mm: float = 2.5
    thickness_mm: float = 3.0
    shadow: float = 0.5
    gloss: float = 0.35
    dpi: int = 300
    preset: Preset = field(default_factory=Preset)

    @staticmethod
    def from_dict(d: dict) -> "Params":
        def f(key: str, default: float, lo: float, hi: float) -> float:
            try:
                v = float(d.get(key, default))
            except (TypeError, ValueError):
                v = default
            return min(hi, max(lo, v))

        shape = d.get("shape", "contour")
        return Params(
            material=str(d.get("material", "acrylic_white")),
            shape=shape if shape in ("contour", "main") else "contour",
            width_mm=f("widthMm", 140, 5, 2000),
            border_mm=f("borderMm", 2.5, 0, 50),
            thickness_mm=f("thicknessMm", 3, 0, 30),
            shadow=f("shadow", 0.5, 0, 1),
            gloss=f("gloss", 0.35, 0, 1),
            dpi=int(f("dpi", 300, 72, 1200)),
            preset=Preset.from_dict(d.get("preset")),
        )


def hex_rgb(h: str) -> np.ndarray:
    h = h.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    h = (h + "000000")[:6]
    return np.array([int(h[i : i + 2], 16) for i in (0, 2, 4)], np.float32) / 255.0


# ---------------------------------------------------------------------------
# outline
# ---------------------------------------------------------------------------


def fill_holes(binary: np.ndarray) -> np.ndarray:
    """Every background pixel not connected to the image border becomes plate."""
    h, w = binary.shape
    work = np.zeros((h + 2, w + 2), np.uint8)
    work[1:-1, 1:-1] = binary
    # The 1-px clear frame connects every border background pixel to (0, 0).
    cv2.floodFill(work, None, (0, 0), 2)
    return (work[1:-1, 1:-1] != 2).astype(np.uint8)


def contour_mask(alpha: np.ndarray, border_px: float) -> np.ndarray:
    """
    Plate outline of a contour-cut product (float 0..1, antialiased):
    alpha grown by `border_px`, holes filled, then closed (grow + shrink by s)
    so notches between letters become one smooth, cuttable curve.
    Same maths as contourMask() in lib/material-render.ts.
    """
    fg = (alpha >= 40).astype(np.uint8)
    r = max(0.0, border_px)
    s = max(1.5, r * 0.9)
    # Distance from every pixel to the nearest design pixel.
    dist_out = cv2.distanceTransform(1 - fg, cv2.DIST_L2, 5)
    plate = (dist_out <= r + s).astype(np.uint8)
    plate = fill_holes(plate)
    dist_in = cv2.distanceTransform(plate, cv2.DIST_L2, 5)
    return np.clip(dist_in - s + 0.5, 0.0, 1.0).astype(np.float32)


def outline_paths_mm(mask: np.ndarray, px_per_mm: float, tolerance_mm: float = 0.05) -> list[np.ndarray]:
    """External contours of the plate, simplified, in millimetres."""
    binary = (mask >= 0.5).astype(np.uint8)
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    out: list[np.ndarray] = []
    for c in contours:
        if cv2.contourArea(c) < (px_per_mm * 1.0) ** 2:  # specks under 1 mm²
            continue
        approx = cv2.approxPolyDP(c, tolerance_mm * px_per_mm, True)
        out.append(approx.reshape(-1, 2).astype(np.float64) / px_per_mm)
    return out


def cut_svg(paths: list[np.ndarray], width_mm: float, height_mm: float) -> str:
    """Hairline red stroke = cut, the convention most laser drivers read."""
    d = []
    for p in paths:
        pts = " L".join(f"{x:.3f},{y:.3f}" for x, y in p)
        d.append(f"M{pts} Z")
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width_mm:.3f}mm" height="{height_mm:.3f}mm" '
        f'viewBox="0 0 {width_mm:.3f} {height_mm:.3f}">\n'
        f'  <path d="{" ".join(d)}" fill="none" stroke="#ff0000" stroke-width="0.01"/>\n'
        "</svg>\n"
    )


def perimeter_mm(paths: list[np.ndarray]) -> float:
    total = 0.0
    for p in paths:
        closed = np.vstack([p, p[:1]])
        total += float(np.sum(np.linalg.norm(np.diff(closed, axis=0), axis=1)))
    return total


# ---------------------------------------------------------------------------
# compositing helpers (premultiplied RGBA float32)
# ---------------------------------------------------------------------------


def premul(rgba8: np.ndarray) -> np.ndarray:
    f = rgba8.astype(np.float32) / 255.0
    f[..., :3] *= f[..., 3:4]
    return f


def unpremul8(p: np.ndarray) -> np.ndarray:
    a = p[..., 3:4]
    rgb = np.where(a > 1e-5, p[..., :3] / np.maximum(a, 1e-5), 0)
    return (np.clip(np.dstack([rgb, a]), 0, 1) * 255 + 0.5).astype(np.uint8)


def over(dst: np.ndarray, src: np.ndarray, opacity: float = 1.0) -> None:
    s = src * opacity
    dst *= 1.0 - s[..., 3:4]
    dst += s


def solid(mask: np.ndarray, rgb: np.ndarray, alpha: float = 1.0) -> np.ndarray:
    a = mask[..., None] * alpha
    return np.dstack([rgb[None, None, :] * a, a]).astype(np.float32)


def shift(img: np.ndarray, dx: float, dy: float) -> np.ndarray:
    m = np.float32([[1, 0, dx], [0, 1, dy]])
    return cv2.warpAffine(img, m, (img.shape[1], img.shape[0]), flags=cv2.INTER_LINEAR, borderValue=0)


def blur(img: np.ndarray, sigma: float) -> np.ndarray:
    return cv2.GaussianBlur(img, (0, 0), sigma) if sigma > 0.3 else img


# ---------------------------------------------------------------------------
# render
# ---------------------------------------------------------------------------


@dataclass
class Rendered:
    preview: np.ndarray  # RGBA uint8, padded
    mask: np.ndarray  # plate 0..1, same size
    art: np.ndarray  # design RGBA uint8 on the padded canvas
    pad: int
    px_per_mm: float


def render(design: np.ndarray, main: np.ndarray | None, p: Params) -> Rendered:
    """design / main: RGBA uint8 at the SAME pixel size (the main asset's), already at output resolution."""
    h, w = design.shape[:2]
    mm = w / p.width_mm
    border = p.border_mm * mm if p.shape == "contour" else 0.0
    depth = p.thickness_mm * mm * 0.6
    shadow_sigma = max(1.0, min(w, h) * 0.0125) * (0.4 + p.shadow)
    drop = depth + shadow_sigma * 0.9
    pad = int(math.ceil(border + depth + shadow_sigma * 3.2 + drop + 4))
    H, W = h + 2 * pad, w + 2 * pad

    art = np.zeros((H, W, 4), np.uint8)
    art[pad : pad + h, pad : pad + w] = design

    if p.shape == "main" and main is not None:
        mask = np.zeros((H, W), np.float32)
        mask[pad : pad + h, pad : pad + w] = main[..., 3].astype(np.float32) / 255.0
    else:
        mask = contour_mask(art[..., 3], border)

    pr = p.preset
    out = np.zeros((H, W, 4), np.float32)

    # 1. drop shadow
    if p.shadow > 0:
        sh = blur(shift(mask, drop * 0.35, drop), shadow_sigma)
        over(out, solid(sh, np.zeros(3, np.float32)), min(1.0, 0.65 * p.shadow))

    # 2. plate edge (thickness)
    if depth >= 0.75:
        # Stack the mask towards the bottom-right, nearer copies over farther ones; one
        # accumulated layer instead of a full RGBA composite per step (print sizes are big).
        steps = min(16, max(2, math.ceil(depth / 1.5)))
        top, bottom = hex_rgb(pr.edge[0]), hex_rgb(pr.edge[1])
        acc_a = np.zeros((H, W), np.float32)
        acc_rgb = np.zeros((H, W, 3), np.float32)
        for i in range(steps, 0, -1):
            t = i / steps
            m = shift(mask, depth * t * 0.35, depth * t)
            colour = top + (bottom - top) * t
            keep = 1.0 - m
            acc_a *= keep
            acc_a += m
            acc_rgb *= keep[..., None]
            acc_rgb += m[..., None] * colour[None, None, :]
        over(out, np.dstack([acc_rgb, acc_a]))

    # 3. face
    if pr.face and p.shape == "contour":
        over(out, solid(mask, hex_rgb(pr.face)), pr.face_opacity)

    # 4. print
    print_p = premul(art)
    if pr.print_tint:
        print_p[..., :3] *= hex_rgb(pr.print_tint)[None, None, :]
    if p.shape == "main":
        print_p *= mask[..., None]
    over(out, print_p)

    # 5–7. lighting, clipped to the plate
    light = np.zeros((H, W, 4), np.float32)
    min_side = min(w, h)
    if pr.pillow > 0:
        inv = blur(shift(1.0 - mask, min_side * 0.006, min_side * 0.01), min_side * 0.025)
        over(light, solid(inv, np.zeros(3, np.float32)), pr.pillow)
    if pr.bevel > 0:
        bw = max(1.0, 0.35 * mm)
        lit = np.clip(mask - shift(mask, bw, bw), 0, 1)
        dark = np.clip(mask - shift(mask, -bw, -bw), 0, 1)
        over(light, solid(blur(lit, bw * 0.3), np.ones(3, np.float32)), pr.bevel)
        over(light, solid(blur(dark, bw * 0.3), np.zeros(3, np.float32)), pr.bevel * 0.35)

    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    g = p.gloss
    if g > 0 and pr.finish == "gloss":
        cx, cy, rad = pad + w * 0.3, pad + h * 0.22, max(w, h) * 0.55
        d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / rad
        a = np.interp(d, [0, 0.5, 1], [0.5 * g, 0.14 * g, 0]).astype(np.float32)
        # diagonal streak
        t = ((xx - pad) / max(1, w) + (yy - pad) / max(1, h)) / 2
        a += np.interp(t, [0.18, 0.24, 0.3], [0, 0.32 * g, 0]).astype(np.float32)
        over(light, solid(np.clip(a, 0, 1), np.ones(3, np.float32)))
    elif g > 0 and pr.finish == "sheen":
        t = ((xx - pad) / max(1, w) * 0.8 + (yy - pad) / max(1, h) * 0.2) * 7
        wave = (np.cos(t * math.pi) + 1) / 2
        over(light, solid(wave * 0.3 * g, np.ones(3, np.float32)))
        over(light, solid((1 - wave) * 0.12 * g, np.zeros(3, np.float32)))
    elif pr.finish == "grain":
        rng = np.random.default_rng(7)
        noise = rng.normal(0, 1, (max(1, H // 6), W)).astype(np.float32)
        noise = cv2.resize(cv2.GaussianBlur(noise, (0, 0), 6, 0.6), (W, H))
        over(light, solid(np.clip(noise * 0.08 * (0.1 + g), 0, 1), np.array([0.47, 0.31, 0.16], np.float32)))

    light *= mask[..., None]
    over(out, light)
    return Rendered(preview=unpremul8(out), mask=mask, art=art, pad=pad, px_per_mm=mm)


def place_on_scene(product: Rendered, design_w: int, design_h: int, scene: np.ndarray, placement: dict) -> np.ndarray:
    """Composite the rendered product onto a scene photo (placement in scene fractions, like the browser)."""
    SH, SW = scene.shape[:2]
    k = float(placement.get("width", 0.7)) * SW / max(1, design_w)
    rot = float(placement.get("rotation", 0))
    cx, cy = float(placement.get("x", 0.5)) * SW, float(placement.get("y", 0.5)) * SH
    # product centre (design centre) → scene point, scaled + rotated
    m = cv2.getRotationMatrix2D((product.pad + design_w / 2, product.pad + design_h / 2), -rot, k)
    m[0, 2] += cx - (product.pad + design_w / 2)
    m[1, 2] += cy - (product.pad + design_h / 2)
    warped = cv2.warpAffine(premul(product.preview), m, (SW, SH), flags=cv2.INTER_AREA if k < 1 else cv2.INTER_CUBIC, borderValue=0)
    base = premul(scene if scene.shape[2] == 4 else np.dstack([scene, np.full(scene.shape[:2], 255, np.uint8)]))
    over(base, warped)
    return unpremul8(base)


def white_layer(r: Rendered, p: Params) -> np.ndarray | None:
    """
    White-ink underlayer (0 = white ink, 255 = none — how RIPs usually take a spot mask as greyscale).
      acrylic_white  the whole plate is backed white
      acrylic_clear  only under the artwork, choked 1 px so no white peeks out
    Opaque blanks (ceramic, metal, wood) need none.
    """
    if p.material == "acrylic_white":
        cover = r.mask >= 0.5
    elif p.material == "acrylic_clear":
        cover = cv2.erode((r.art[..., 3] >= 128).astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    else:
        return None
    return np.where(cover, 0, 255).astype(np.uint8)
