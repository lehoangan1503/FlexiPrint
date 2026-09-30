"""Pixel helpers: ComfyUI tensors ↔ PIL, white keying, trimming/normalising to
a category's rules, silhouette lock + IoU, deterministic recolouring.

ComfyUI conventions: IMAGE = float32 [B,H,W,3] 0..1, MASK = float32 [B,H,W]
0..1 where 1 = subject (we keep the "opacity" polarity everywhere).
"""

from __future__ import annotations

import io
import re

import numpy as np
import torch
from PIL import Image, ImageColor, ImageFilter

# ---------------------------------------------------------------- conversions


def pil_to_rgba(img: Image.Image) -> np.ndarray:
    return np.asarray(img.convert("RGBA"), dtype=np.uint8)


def bytes_to_rgba(data: bytes) -> np.ndarray:
    return pil_to_rgba(Image.open(io.BytesIO(data)))


def rgba_to_png(rgba: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, "PNG", optimize=True)
    return buf.getvalue()


def rgba_on_white_png(rgba: np.ndarray) -> bytes:
    """Flatten onto pure white — what image models see as input."""
    a = rgba[..., 3:4].astype(np.float32) / 255.0
    rgb = rgba[..., :3].astype(np.float32) * a + 255.0 * (1 - a)
    buf = io.BytesIO()
    Image.fromarray(rgb.clip(0, 255).astype(np.uint8), "RGB").save(buf, "PNG")
    return buf.getvalue()


def rgba_to_tensors(items: list[np.ndarray]) -> tuple[torch.Tensor, torch.Tensor]:
    """List of RGBA arrays → (IMAGE, MASK) batches. Mismatched sizes are padded to the largest (transparent)."""
    h = max(x.shape[0] for x in items)
    w = max(x.shape[1] for x in items)
    imgs, masks = [], []
    for x in items:
        if x.shape[0] != h or x.shape[1] != w:
            pad = np.zeros((h, w, 4), dtype=np.uint8)
            pad[..., :3] = 255  # white, so a later white key treats padding as background
            oy, ox = (h - x.shape[0]) // 2, (w - x.shape[1]) // 2
            pad[oy : oy + x.shape[0], ox : ox + x.shape[1]] = x
            x = pad
        imgs.append(torch.from_numpy(x[..., :3].astype(np.float32) / 255.0))
        masks.append(torch.from_numpy(x[..., 3].astype(np.float32) / 255.0))
    return torch.stack(imgs), torch.stack(masks)


def tensors_to_rgba(image: torch.Tensor, mask: torch.Tensor | None) -> list[np.ndarray]:
    """(IMAGE, MASK?) batch → RGBA arrays. No mask = fully opaque."""
    out = []
    for i in range(image.shape[0]):
        rgb = (image[i].cpu().numpy().clip(0, 1) * 255).round().astype(np.uint8)
        if mask is not None and mask.shape[0] > 0:
            m = mask[min(i, mask.shape[0] - 1)].cpu().numpy()
            if m.shape != rgb.shape[:2]:
                m = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).resize((rgb.shape[1], rgb.shape[0]), Image.BILINEAR), dtype=np.float32) / 255.0
            a = (m.clip(0, 1) * 255).round().astype(np.uint8)
        else:
            a = np.full(rgb.shape[:2], 255, dtype=np.uint8)
        out.append(np.dstack([rgb, a]))
    return out


# ---------------------------------------------------------------- background


def white_key(rgba: np.ndarray, tolerance: int = 18) -> np.ndarray:
    """Make the near-white background connected to the border transparent."""
    from scipy import ndimage

    rgb = rgba[..., :3].astype(np.int16)
    near = (255 - rgb).max(axis=2) <= tolerance
    labels, _ = ndimage.label(near)
    border = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    bg = np.isin(labels, border[border > 0])
    alpha = rgba[..., 3].copy()
    alpha[bg] = 0
    # Soften the cut edge a little.
    a = Image.fromarray(alpha).filter(ImageFilter.GaussianBlur(0.6))
    out = rgba.copy()
    out[..., 3] = np.minimum(np.asarray(a), rgba[..., 3])
    return out


def has_transparency(rgba: np.ndarray) -> bool:
    return bool((rgba[..., 3] < 250).mean() > 0.01)


# ---------------------------------------------------------------- geometry


def trim(rgba: np.ndarray, threshold: int = 8) -> np.ndarray:
    ys, xs = np.nonzero(rgba[..., 3] > threshold)
    if len(ys) == 0:
        return rgba
    return rgba[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]


def normalize(rgba: np.ndarray, canvas_w: int, canvas_h: int, fill: float, anchor: str) -> np.ndarray:
    """Trim to the subject, contain-fit it into fill × canvas, place by anchor."""
    sub = trim(rgba)
    sh, sw = sub.shape[:2]
    box_w, box_h = canvas_w * fill, canvas_h * fill
    k = min(box_w / sw, box_h / sh)
    nw, nh = max(1, round(sw * k)), max(1, round(sh * k))
    img = Image.fromarray(sub, "RGBA").resize((nw, nh), Image.LANCZOS)
    out = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    x = (canvas_w - nw) // 2
    y = canvas_h - nh - round((canvas_h - box_h) / 2) if anchor == "bottom" else (canvas_h - nh) // 2
    out.paste(img, (x, y), img)
    return np.asarray(out, dtype=np.uint8)


def resize_to(rgba: np.ndarray, w: int, h: int) -> np.ndarray:
    if rgba.shape[1] == w and rgba.shape[0] == h:
        return rgba
    return np.asarray(Image.fromarray(rgba, "RGBA").resize((w, h), Image.LANCZOS), dtype=np.uint8)


def dilate_alpha(alpha: np.ndarray, px: int) -> np.ndarray:
    if px <= 0:
        return alpha
    return np.asarray(Image.fromarray(alpha).filter(ImageFilter.MaxFilter(px * 2 + 1)), dtype=np.uint8)


def bbox(alpha: np.ndarray, threshold: int = 8) -> tuple[int, int, int, int] | None:
    ys, xs = np.nonzero(alpha > threshold)
    if len(ys) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def align_to(source: np.ndarray, rendered: np.ndarray) -> np.ndarray:
    """Put an AI result back onto the source's frame.

    Models reframe freely (grok returns a 1024² square with the subject moved,
    gpt-image keeps the frame): key the result's white backdrop, crop it to its
    subject and fit that box onto the source's subject box. Pixels the result
    leaves empty inside the source outline fall back to the source's colours.
    """
    h, w = source.shape[:2]
    keyed = white_key(rendered) if not has_transparency(rendered) else rendered
    sb, rb = bbox(source[..., 3]), bbox(keyed[..., 3])
    if not sb or not rb:
        return resize_to(rendered, w, h)
    x0, y0, x1, y1 = sb
    crop = keyed[rb[1] : rb[3], rb[0] : rb[2]]
    fitted = np.asarray(Image.fromarray(crop, "RGBA").resize((x1 - x0, y1 - y0), Image.LANCZOS), dtype=np.uint8)
    out = np.zeros((h, w, 4), dtype=np.uint8)
    out[y0:y1, x0:x1] = fitted
    a = out[..., 3:4].astype(np.float32) / 255.0
    rgb = out[..., :3].astype(np.float32) * a + source[..., :3].astype(np.float32) * (1 - a)
    result = np.dstack([rgb.round().clip(0, 255).astype(np.uint8), out[..., 3]])
    return result


def lock_silhouette(rendered: np.ndarray, source_alpha: np.ndarray, edge_px: int = 0) -> np.ndarray:
    """Resize the AI output to the source size and give it the source's alpha (optionally grown by edge_px)."""
    h, w = source_alpha.shape
    out = resize_to(rendered, w, h).copy()
    out[..., 3] = dilate_alpha(source_alpha, edge_px)
    return out


def iou(a: np.ndarray, b: np.ndarray, threshold: int = 128) -> float:
    """Silhouette overlap of two alpha channels (resized to a's size)."""
    if a.shape != b.shape:
        b = np.asarray(Image.fromarray(b).resize((a.shape[1], a.shape[0]), Image.BILINEAR), dtype=np.uint8)
    ma, mb = a >= threshold, b >= threshold
    union = np.logical_or(ma, mb).sum()
    return float(np.logical_and(ma, mb).sum() / union) if union else 1.0


# ---------------------------------------------------------------- recolour

_HEX = re.compile(r"#[0-9a-fA-F]{3,8}\b")


def parse_color(text: str) -> tuple[int, int, int] | None:
    """First colour in a variant line: '#7fd6a3', 'mint green' → css name lookup on each word pair / word."""
    m = _HEX.search(text)
    if m:
        try:
            return ImageColor.getrgb(m.group(0))[:3]
        except ValueError:
            pass
    words = re.findall(r"[a-zA-Z]+", text.lower())
    for n in (2, 1):
        for i in range(len(words) - n + 1):
            name = "".join(words[i : i + n])
            try:
                return ImageColor.getrgb(name)[:3]
            except ValueError:
                continue
    return None


def _rgb_to_hsv(rgb: np.ndarray) -> np.ndarray:
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx, mn = rgb.max(-1), rgb.min(-1)
    d = mx - mn
    h = np.zeros_like(mx)
    nz = d > 1e-6
    rm = nz & (mx == r)
    gm = nz & (mx == g) & ~rm
    bm = nz & ~rm & ~gm
    h[rm] = ((g - b)[rm] / d[rm]) % 6
    h[gm] = (b - r)[gm] / d[gm] + 2
    h[bm] = (r - g)[bm] / d[bm] + 4
    h = h / 6.0
    s = np.where(mx > 1e-6, d / np.maximum(mx, 1e-6), 0)
    return np.stack([h, s, mx], -1)


def _hsv_to_rgb(hsv: np.ndarray) -> np.ndarray:
    h, s, v = hsv[..., 0] * 6, hsv[..., 1], hsv[..., 2]
    i = np.floor(h).astype(int) % 6
    f = h - np.floor(h)
    p, q, t = v * (1 - s), v * (1 - s * f), v * (1 - s * (1 - f))
    out = np.zeros(hsv.shape, dtype=np.float32)
    for k, (a, b, c) in enumerate(((v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q))):
        m = i == k
        out[..., 0][m], out[..., 1][m], out[..., 2][m] = a[m], b[m], c[m]
    return out


def recolor(rgba: np.ndarray, target: tuple[int, int, int], protect_dark: float = 0.45, protect_gray: float = 0.08) -> np.ndarray:
    """Shift the dominant body colour to `target`, keeping shading and line work.

    Dark pixels (outlines, eyes) and near-neutral highlights stay; everything
    else takes the target hue and a saturation blended toward the target's.
    Same pixels, same alpha → the silhouette is identical by construction.
    """
    rgb = rgba[..., :3].astype(np.float32) / 255.0
    hsv = _rgb_to_hsv(rgb)
    t = _rgb_to_hsv(np.array([[list(target)]], dtype=np.float32) / 255.0)[0, 0]
    body = (hsv[..., 2] > protect_dark) & (rgba[..., 3] > 0)
    # Pale / neutral sources (a white bun) have no hue to shift: tint them by luminance instead.
    src_sat = float(np.median(hsv[..., 1][body])) if body.any() else 0.0
    out = hsv.copy()
    if src_sat < protect_gray * 2:
        lum = hsv[..., 2]
        tint = np.array(target, dtype=np.float32) / 255.0
        tinted = rgb * 0 + tint * (0.35 + 0.65 * lum[..., None])
        mixed = np.where(body[..., None], np.clip(tinted * 0.75 + rgb * 0.25 * lum[..., None], 0, 1), rgb)
        res = mixed
    else:
        out[..., 0] = np.where(body, t[0], hsv[..., 0])
        out[..., 1] = np.where(body, np.clip(hsv[..., 1] * 0.4 + t[1] * 0.6, 0, 1), hsv[..., 1])
        res = _hsv_to_rgb(out)
    result = rgba.copy()
    result[..., :3] = (res.clip(0, 1) * 255).round().astype(np.uint8)
    return result
