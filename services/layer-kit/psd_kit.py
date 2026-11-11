"""
Fulfiller PSDs (2026-11-12, Merchize): read a print template (khuôn in) and a mockup (phôi) by their layer names.

Merchize keeps one PSD template per product. Sizes / shapes are stacked in it ON PURPOSE as named layers (one print
file for every size, the factory cuts per size). Families seen over the whole catalog (912 products):

    guide > gray (+ safe zone, note, full size)   gray = the print area, safe zone = dashed safe lines
    guide > safe zone group of named shapes       one shape per variant (Heart / Circle … Ceramic Ornament)
    "Cut-out Shape" + "Printed Design"            cut to the design's own outline — no fixed khuôn
    anything else                                 not read (the team makes the khuôn by hand)

A mockup PSD holds scenes (groups, the unused ones hidden). In a scene: the blank product as a pixel layer, a
"Design" smart object the size of the template sheet (masked to the product's shape), shading layers above it
(Multiply / Screen / Linear Dodge). The scene is rendered twice with the design replaced by flat white and flat black:
everything above the design is affine in the design's colour, so

    phôi     = the white render (the blank product with its own shading)
    overlay  = alpha a = 1 − (white − black), colour = black / a     →  design·(1 − a) + overlay·a  = Photoshop's result

and the design goes flat into the smart object's box (its transform's bounds). Usable only when the smart object is
upright (not rotated / flipped), the size of the sheet and one placement for the scene; warps are approximated by the
box.
"""

from __future__ import annotations

import base64
import io
import logging
import os
import re
import tempfile
import threading
import warnings

import cv2
import numpy as np
import requests
from PIL import Image

warnings.filterwarnings("ignore")
logging.getLogger("psd_tools").setLevel(logging.ERROR)

from psd_tools import PSDImage  # noqa: E402
from psd_tools.api.layers import PixelLayer  # noqa: E402
from psd_tools.constants import Tag  # noqa: E402

log = logging.getLogger("layer-kit.psd")
Image.MAX_IMAGE_PIXELS = None
MAX_BYTES = 900 * 1024 * 1024
READ_SIDE = 3000
# One PSD at a time: a 370 MB mockup or a 12 000 px template takes a few GB while it is composited.
psd_lock = threading.Lock()


def download(url: str) -> str:
    fd, path = tempfile.mkstemp(suffix=".psd")
    size = 0
    try:
        with requests.get(url, stream=True, timeout=(30, 300), headers={"User-Agent": "flexi2-layer-kit"}) as r:
            r.raise_for_status()
            with os.fdopen(fd, "wb") as f:
                for chunk in r.iter_content(1 << 20):
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise ValueError("PSD quá lớn (> 900 MB)")
                    f.write(chunk)
        with open(path, "rb") as f:
            if f.read(4) != b"8BPS":
                raise ValueError("Không phải file PSD")
        return path
    except Exception:
        os.unlink(path)
        raise


def b64png(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=False, compress_level=6)
    return base64.b64encode(buf.getvalue()).decode()


def b64jpg(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=92)
    return base64.b64encode(buf.getvalue()).decode()


def name_of(layer) -> str:
    return (layer.name or "").strip()


def on_sheet(layer, W: int, H: int) -> np.ndarray:
    """The layer's own pixels (RGBA) placed on the sheet."""
    img = layer.topil() if not layer.is_group() else None
    if img is None:
        img = layer.composite()
    out = np.zeros((H, W, 4), np.uint8)
    if img is None:
        return out
    arr = np.asarray(img.convert("RGBA"))
    x0, y0 = layer.bbox[0], layer.bbox[1]
    xs, ys = max(0, x0), max(0, y0)
    xe, ye = min(W, x0 + arr.shape[1]), min(H, y0 + arr.shape[0])
    if xe > xs and ye > ys:
        out[ys:ye, xs:xe] = arr[ys - y0 : ye - y0, xs - x0 : xe - x0]
    return out


# ---------------------------------------------------------------- khuôn


def safe_shapes(lines: np.ndarray, W: int, H: int) -> list[dict]:
    """Dashed safe lines (0/1, sheet px) → the areas they close in: rect / ellipse / polygon, sheet px. The big areas
    only (≥ 15 % of the biggest): a shirt's back, front halves and sleeves, not its cuffs or a hanging hole."""
    k = min(1.0, READ_SIDE / max(W, H))
    w, h = max(1, round(W * k)), max(1, round(H * k))
    small = cv2.resize(lines.astype(np.uint8) * 255, (w, h), interpolation=cv2.INTER_AREA) > 20
    r = max(3, round(max(w, h) / 150))
    dil = cv2.dilate(small.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1)))
    # The free cells' groups; those touching the sheet's border are outside, the rest are closed in by the lines.
    n, lab, stats, _ = cv2.connectedComponentsWithStats((dil == 0).astype(np.uint8), 4)
    edge = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]])).tolist())
    areas = [(i, stats[i, cv2.CC_STAT_AREA]) for i in range(1, n) if i not in edge and stats[i, cv2.CC_STAT_AREA] >= 0.002 * w * h]
    if not areas:
        return []
    big = max(a for _, a in areas)
    out = []
    grow = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
    for i, a in areas:
        if a < 0.15 * big:
            continue
        m = cv2.dilate((lab == i).astype(np.uint8), grow)  # back out to the dashed line's middle
        cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        if not cs:
            continue
        c = max(cs, key=cv2.contourArea)
        x, y, bw, bh = cv2.boundingRect(c)
        area = cv2.contourArea(c)
        s = 1 / k
        if area > 0.95 * bw * bh:
            out.append({"type": "rect", "x": round(x * s, 1), "y": round(y * s, 1), "w": round(bw * s, 1), "h": round(bh * s, 1), "radius": 0})
            continue
        ell = np.zeros_like(m)
        cv2.ellipse(ell, (x + bw // 2, y + bh // 2), (bw // 2, bh // 2), 0, 0, 360, 1, -1)
        inter = np.logical_and(ell, m).sum()
        union = np.logical_or(ell, m).sum()
        if union and inter / union > 0.97:
            out.append({"type": "ellipse", "cx": round((x + bw / 2) * s, 1), "cy": round((y + bh / 2) * s, 1), "rx": round(bw / 2 * s, 1), "ry": round(bh / 2 * s, 1)})
            continue
        poly = cv2.approxPolyDP(c, max(1.0, 0.002 * cv2.arcLength(c, True)), True)[:, 0, :]
        if len(poly) >= 3:
            out.append({"type": "polygon", "points": [{"x": round(float(px) * s, 1), "y": round(float(py) * s, 1)} for px, py in poly]})
    return out


def big_lines(on: np.ndarray) -> np.ndarray:
    """Only line work that spans a good part of the sheet (dashes joined): drops text, legend icons, a hole's ring."""
    H, W = on.shape
    k = min(1.0, READ_SIDE / max(W, H))
    w, h = max(1, round(W * k)), max(1, round(H * k))
    small = cv2.resize(on.astype(np.uint8) * 255, (w, h), interpolation=cv2.INTER_AREA) > 20
    r = max(3, round(max(w, h) / 150))
    joined = cv2.dilate(small.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1)))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(joined, 8)
    keep = np.zeros(n, bool)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_WIDTH] >= 0.25 * w and stats[i, cv2.CC_STAT_HEIGHT] >= 0.25 * h:
            keep[i] = True
    big = cv2.resize(keep[lab].astype(np.uint8), (W, H), interpolation=cv2.INTER_NEAREST).astype(bool)
    return on & big


def guide_of(mask: np.ndarray, lines_rgba: np.ndarray | None) -> Image.Image:
    """The khuôn drawn for the editor: the print area's edge (dark) + the safe lines in their own colour."""
    H, W = mask.shape
    g = np.zeros((H, W, 4), np.uint8)
    t = max(2, round(max(W, H) / 1500))
    edge = mask & ~cv2.erode(mask.astype(np.uint8), np.ones((2 * t + 1, 2 * t + 1), np.uint8)).astype(bool)
    g[edge] = (70, 70, 80, 255)
    if lines_rgba is not None:
        on = lines_rgba[..., 3] > 40
        g[on, :3] = lines_rgba[on, :3]
        g[on, 3] = 255
    return Image.fromarray(g, "RGBA")


def classify(psd) -> tuple[str, dict]:
    layers = list(psd.descendants())
    names = [name_of(l).lower() for l in layers]
    if any(re.search(r"cut-?out shape|^cut design|design c[aắ]t|hình cắt|^cut-design", n) for n in names):
        return "cut", {}
    gray = next((l for l in layers if not l.is_group() and re.fullmatch(r"gr[ae]y", name_of(l), re.I)), None)
    safe = next((l for l in layers if re.fullmatch(r"safe ?zone", name_of(l), re.I)), None)
    if gray is not None:
        return "gray", {"gray": gray, "safe": safe}
    if safe is not None and safe.is_group():
        shapes = [c for c in safe if not re.fullmatch(r"bg|background|layer \d+|color fill.*", name_of(c), re.I)]
        if len(shapes) >= 2:
            return "shapes", {"shapes": shapes}
    return "manual", {}


def read_template(path: str) -> dict:
    psd = PSDImage.open(path)
    W, H = psd.width, psd.height
    family, parts = classify(psd)
    out: dict = {"family": family, "width": W, "height": H, "faces": []}
    if family == "gray":
        g = on_sheet(parts["gray"], W, H)
        mask = g[..., 3] > 20
        lines = on_sheet(parts["safe"], W, H) if parts["safe"] is not None else None
        safe = safe_shapes(lines[..., 3] > 40, W, H) if lines is not None else []
        m = Image.fromarray(np.where(mask, 255, 0).astype(np.uint8), "L")
        out["faces"].append({"name": "Mặt in", "mask": b64png(m), "guide": b64png(guide_of(mask, lines)), "safe": safe})
    elif family == "shapes":
        for layer in parts["shapes"]:
            px = on_sheet(layer, W, H)
            mask = px[..., 3] > 20
            if mask.mean() < 0.01:
                continue
            rgb = px[..., :3].astype(np.int16)
            sat = (rgb.max(axis=2) - rgb.min(axis=2)) > 60  # coloured dashes (green / red), not the grey fill
            sat = big_lines(sat & mask)  # the legend's text and icons are drawn into the same picture
            lines = np.zeros_like(px)
            lines[sat & mask] = px[sat & mask]
            safe = safe_shapes(sat & mask, W, H)
            m = Image.fromarray(np.where(mask, 255, 0).astype(np.uint8), "L")
            out["faces"].append({"name": name_of(layer), "mask": b64png(m), "guide": b64png(guide_of(mask, lines)), "safe": safe})
    return out


# ---------------------------------------------------------------- mockup


def _so_desc(layer):
    for key in (Tag.SMART_OBJECT_LAYER_DATA1, Tag.SMART_OBJECT_LAYER_DATA2, Tag.PLACED_LAYER1, Tag.PLACED_LAYER2):
        if key in layer.tagged_blocks:
            b = layer.tagged_blocks.get_data(key)
            return getattr(b, "data", b)
    return None


def _so_geom(layer) -> dict:
    d = _so_desc(layer)
    tr = [float(x) for x in d[b"Trnf"]]
    wp = d[b"warp"][b"warpStyle"]
    warp = str(getattr(wp, "enum", wp)).strip("b'")
    size = None
    try:
        sz = d[b"Sz  "]
        size = (float(sz[b"Wdth"]), float(sz[b"Hght"]))
    except Exception:
        pass
    xs, ys = tr[0::2], tr[1::2]
    upright = abs(tr[1] - tr[3]) < 2 and abs(tr[2] - tr[4]) < 2 and abs(tr[5] - tr[7]) < 2 and abs(tr[0] - tr[6]) < 2 and tr[0] < tr[2] and tr[1] < tr[5]
    return {"box": (min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)), "warp": warp, "upright": upright, "size": size}


def _has_so(layer) -> bool:
    return layer.kind == "smartobject" or (layer.is_group() and any(x.kind == "smartobject" for x in layer.descendants()))


def _ancestors(psd, layer) -> list:
    out, p = [], layer.parent
    while p is not None and p is not psd:
        out.append(p)
        p = p.parent
    return out


def _render(psd, chain, sos, fill: int) -> np.ndarray:
    keep = {id(a) for a in chain}
    undo = []
    for parent in [psd] + list(reversed(chain)):
        for c in parent:
            if id(c) in keep:
                if not c.visible:
                    undo.append((c, c.visible))
                    c.visible = True
            elif c.visible and _has_so(c) and not (chain and parent is chain[0]):
                undo.append((c, c.visible))
                c.visible = False
    placed = []
    for so in sos:
        im = so.composite()
        a = np.asarray(im.convert("RGBA"))[..., 3] if im is not None else np.zeros((1, 1), np.uint8)
        flat = Image.fromarray(np.dstack([np.full(a.shape, fill, np.uint8)] * 3 + [a]), "RGBA")
        parent = so.parent
        idx = list(parent).index(so)
        lay = PixelLayer.frompil(flat, parent, name="__flexi2_fill", top=so.bbox[1], left=so.bbox[0])
        if lay in parent:
            parent.remove(lay)
        parent.insert(idx, lay)
        so.visible = False
        placed.append((parent, lay, so))
    try:
        img = psd.composite(force=True).convert("RGB")
    finally:
        for parent, lay, so in placed:
            parent.remove(lay)
            so.visible = True
        for c, v in reversed(undo):
            c.visible = v
    return np.asarray(img).astype(np.float32) / 255.0


def read_mockup(path: str, sheet: tuple[int, int] | None) -> dict:
    psd = PSDImage.open(path)
    scenes: dict = {}
    for layer in psd.descendants():
        if layer.kind != "smartobject" or not layer.visible:
            continue
        if re.search(r"background|\bbg\b|change your", name_of(layer), re.I):
            continue
        try:
            geo = _so_geom(layer)
        except Exception:
            continue
        anc = _ancestors(psd, layer)
        key = tuple(id(a) for a in anc)
        scenes.setdefault(key, (anc, []))[1].append((layer, geo))
    if not scenes:
        return {"error": "Mockup không có smart object thiết kế"}

    def fits(g):
        if not sheet or not g["size"]:
            return True
        return abs(g["size"][0] / g["size"][1] - sheet[0] / sheet[1]) < 0.02

    def one_place(lst):
        b0 = lst[0][1]["box"]
        return all(max(abs(a - b) for a, b in zip(g["box"], b0)) < 0.01 * max(b0[2], b0[3]) for _, g in lst)

    def ok(item):
        _, lst = item
        return all(g["upright"] and fits(g) for _, g in lst) and one_place(lst)

    def score(item):
        anc, lst = item
        geo = lst[-1][1]
        return (ok(item), geo["warp"] == "warpNone", all(a.visible for a in anc), len(lst) == 1, geo["box"][2] * geo["box"][3])

    ranked = sorted(scenes.values(), key=score, reverse=True)
    info = [" / ".join(a.name for a in reversed(anc)) or "(gốc)" for anc, _ in ranked]
    if not ok(ranked[0]):
        return {"error": "Không có cảnh mockup đặt thẳng đúng khổ khuôn (thiết kế bị xoay / chia mảnh)", "scenes": info}
    anc, lst = ranked[0]
    sos = [l for l, _ in lst]
    geo = lst[-1][1]
    white = _render(psd, anc, sos, 255)
    black = _render(psd, anc, sos, 0)
    span = np.clip(white - black, 0, 1)
    a = 1.0 - span.mean(axis=2)
    colour = np.where(a[..., None] > 1e-3, np.clip(black / np.maximum(a[..., None], 1e-3), 0, 1), 0)
    overlay = Image.fromarray(np.dstack([colour * 255, a[..., None] * 255]).astype(np.uint8), "RGBA")
    phoi = Image.fromarray((white * 255).astype(np.uint8), "RGB")
    x, y, w, h = geo["box"]
    return {
        "width": psd.width,
        "height": psd.height,
        "scene": " / ".join(a.name for a in reversed(anc)) or "(gốc)",
        "warp": geo["warp"],
        "box": {"x": round(x, 1), "y": round(y, 1), "w": round(w, 1), "h": round(h, 1)},
        "phoi": b64jpg(phoi),
        "overlay": b64png(overlay),
        "scenes": info,
    }
