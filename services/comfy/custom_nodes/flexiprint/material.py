"""Material versions of a clipart — the image work behind FP Material (presets with `params.art`).

The model turns the flat clipart into a photo-cutout of the physical product (clear acrylic plate, a hanging
hole, a cord…). What makes it clean and dependable:

  * The artwork goes in on a canvas padded on every side (`PAD`), so the plate and a cord fit around it.
  * Where a detail goes (a hole, a ring, a flower) is in the detail's own words, read by the prompt writer from
    the description and the editor's reference photos (marks the editor drew on them included) — no fixed
    position service: the products are too varied for one.
  * The model draws on BLACK; the same picture is then turned WHITE (background swap only). The pair gives the
    true transparency of clear materials (difference matting) — no milky plate, white edge highlights kept.
  * The printed artwork keeps its own pixels ("print"), or the model's surface inside its outline ("surface").
  * Solid coloured pixels outside the artwork are the model's own copy of the art drawn a little off: a ghost.
    A pass with a ghost (or a bad fit) is thrown away and drawn again.
  * A detail made as an extra version ("có dây") is an edit of the base picture; only what it changed off the
    plate (joined to the top edge, or in blobs big enough to be a thing) is taken, so the plate and every detail
    of the base stay exactly where they were.
  * A product with a fixed shape (a round ornament, trousers — "theo khuôn"): the clipart comes in already cut to
    the product's khuôn (`frame_cut`, holes included) and the piece keeps exactly that outline (`shaped`): the
    model only gives it the material, every clipart of the khuôn ends up the same size.

Pure numpy / PIL; the model calls are passed in.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Awaitable, Callable

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

PAD = 0.22
# Reject a pass above these (see suppress_ghost / align / excess_plate): the next one is usually clean.
MAX_GHOST = 0.01
MAX_EXCESS = 0.03
MAX_ALIGN_ERR = 26.0
DEFAULT_MODEL = "cpa:gpt-image-2.5"
# lib/materials.ts MAX_MATERIAL_SPECS
MAX_SPECS = 12

REFS_NOTE = (
    "The other images are reference photos of the finished product: match how their material looks (clarity, thickness, edge, "
    "finish) and how their details look (size, shape, material, colour) exactly. Never copy their artwork, background, scene or the "
    "outline / shape of their piece: the outline always follows THIS artwork, as described. Dots, circles, arrows, boxes or "
    "handwriting drawn over a reference photo are the editor's notes about where / what a detail is — never draw them."
)
FRAME_PRINT = (
    "Turn image 1 into a product photo-cutout of this artwork made as the physical product described below. "
    "Keep the printed artwork exactly as in image 1 — every shape, colour, line, letter and face, same size and same position in the frame."
)
FRAME_SURFACE = (
    "Turn image 1 into a product photo-cutout of this artwork made as the physical product described below. The material "
    "covers the artwork's own surface, but every shape, line, face and letter stays exactly where it is — same size and same position in the frame."
)
FRAME_SHAPED = (
    "Turn image 1 into a product photo-cutout of this piece made as the physical product described below. Image 1 is "
    "already cut to the product's exact outline: keep that outline exactly — same shape, size and position, every hole "
    "or cut-out stays open and where it is, nothing added past the edge. The material covers the piece's whole surface "
    "(finish, gloss, light on it), but every shape, colour, line, letter and face of the artwork stays exactly where it is."
)
BLACK_BG = "Solid pure black (#000000) background, nothing else in the picture."
REQUIRED = "Product details — every one of these MUST be clearly visible in this picture:\n{what}"
# Only the version's own new part is named, never the "always" details it attaches to (a cord "through the hole"
# made the model leave the hole out: "do NOT add … the hanging hole").
NOT_YET = (
    "Added later in a separate step, so NOT in this picture: {what}. Leave out only that loose part itself — every "
    "required detail above is still drawn."
)
ADD_ONE = (
    "Add ONLY this to image 1: {what} Change nothing else — the material, every detail already there, the printed artwork and the black "
    "background stay exactly as they are, same size and position."
)
TO_WHITE = (
    "Replace ONLY the solid black background with solid pure white (#FFFFFF). Keep everything else exactly identical, pixel for pixel — "
    "the artwork, the material and its edge highlights, every detail: same position, size, colours and light. "
    "Where the material is see-through, the white now shows through it."
)


@dataclass
class Spec:
    text: str
    mode: str  # always | version
    label: str


@dataclass
class Pass:
    """One accepted picture of the product (padded frame, aligned): black + white originals and the RGBA result."""

    black: np.ndarray
    rgba: np.ndarray
    report: dict = field(default_factory=dict)


Call = Callable[[str, list[bytes]], Awaitable[np.ndarray]]


def nano_model(model: str) -> str:
    """The model a material / locked edit is drawn with: the team's pick (the app always sends it). Nano Banana keeps
    the artwork in place best; with gpt-image the passes are aligned back (align) and the art is locked (lock_art)."""
    m = (model or "").strip()
    if not m:
        return DEFAULT_MODEL
    if m.startswith(("fal:", "cpa:")):
        return m
    return f"fal:{m}" if "nano-banana" in m else DEFAULT_MODEL


def parse_specs(raw: object) -> list[Spec]:
    out: list[Spec] = []
    for x in raw if isinstance(raw, list) else []:
        if not isinstance(x, dict) or not str(x.get("text") or "").strip():
            continue
        mode = "version" if x.get("mode") == "version" else "always"
        out.append(
            Spec(
                text=str(x["text"]).strip(),
                mode=mode,
                label=(str(x.get("label") or "").strip() or "bản thêm") if mode == "version" else "",
            )
        )
    return out[:MAX_SPECS]


# ---------------------------------------------------------------- frame


def frame_cut(src: np.ndarray, cut: dict) -> np.ndarray:
    """The clipart cut to a khuôn vật liệu (lib/material-frame.ts frameCut): a w × h canvas, the clipart in its
    box (turned about its centre), kept only inside the outline and outside the cuts. 4× supersampled edges."""
    W, H = int(cut["w"]), int(cut["h"])
    art = cut["art"]
    aw, ah = max(1, round(float(art["w"]))), max(1, round(float(art["h"])))
    pic = Image.fromarray(src).resize((aw, ah), Image.LANCZOS)
    rot = float(art.get("rotation") or 0)
    if rot:
        pic = pic.rotate(-rot, resample=Image.BICUBIC, expand=True)
    cx, cy = float(art["x"]) + float(art["w"]) / 2, float(art["y"]) + float(art["h"]) / 2
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    # A plain paste on the empty canvas copies the pixels as they are (and clips what falls off it).
    canvas.paste(pic, (round(cx - pic.width / 2), round(cy - pic.height / 2)))
    k = 4
    mask = Image.new("L", (W * k, H * k), 0)
    d = ImageDraw.Draw(mask)
    d.polygon([(x * k, y * k) for x, y in cut["clip"]], fill=255)
    for hole in cut.get("cuts") or []:
        d.polygon([(x * k, y * k) for x, y in hole], fill=0)
    mask = mask.resize((W, H), Image.LANCZOS)
    out = np.asarray(canvas).copy()
    out[..., 3] = (out[..., 3].astype(np.uint16) * np.asarray(mask, np.uint16) // 255).astype(np.uint8)
    return out


def pad_canvas(src: np.ndarray) -> tuple[np.ndarray, int]:
    h, w = src.shape[:2]
    p = round(max(w, h) * PAD)
    out = np.zeros((h + 2 * p, w + 2 * p, 4), np.uint8)
    out[p : p + h, p : p + w] = src
    return out, p


def on(a: np.ndarray, rgb: tuple[int, int, int]) -> np.ndarray:
    al = a[..., 3:4].astype(np.float32) / 255
    out = a[..., :3].astype(np.float32) * al + np.array(rgb, np.float32) * (1 - al)
    return out.round().astype(np.uint8)


# ---------------------------------------------------------------- alignment


def _resize(a: np.ndarray, w: int, h: int) -> np.ndarray:
    return np.asarray(Image.fromarray(a).resize((w, h), Image.LANCZOS), dtype=np.uint8)


def align(ref_rgb: np.ndarray, mask: np.ndarray, out_rgb: np.ndarray, fill: tuple[int, int, int] = (0, 0, 0)) -> tuple[np.ndarray, float]:
    """Fit a model picture onto the padded frame by matching the pixels under `mask` (coarse-to-fine scale +
    shift on a small copy). Whatever the model added around the art can't pull the fit off. Returns (fitted, error)."""
    H, W = ref_rgb.shape[:2]
    out_rgb = _resize(out_rgb, W, H)
    S = 192
    k = S / max(W, H)
    sw, sh = round(W * k), round(H * k)
    r = np.asarray(Image.fromarray(ref_rgb).resize((sw, sh), Image.BILINEAR), dtype=np.float32)
    m = np.asarray(Image.fromarray(mask).resize((sw, sh), Image.BILINEAR)) > 128
    small = Image.fromarray(out_rgb).resize((sw, sh), Image.BILINEAR)
    if not m.any():
        return out_rgb, 0.0

    def affine(s: float, dx: float, dy: float, w: int, h: int) -> tuple[float, ...]:
        return (1 / s, 0, (w / 2) * (1 - 1 / s) - dx / s, 0, 1 / s, (h / 2) * (1 - 1 / s) - dy / s)

    def err(s: float, dx: float, dy: float) -> float:
        o = np.asarray(small.transform((sw, sh), Image.AFFINE, affine(s, dx, dy, sw, sh), Image.BILINEAR, fillcolor=fill), dtype=np.float32)
        return float(np.abs(o[m] - r[m]).mean())

    best = (err(1, 0, 0), 1.0, 0.0, 0.0)
    if best[0] > 8:
        for s in np.arange(0.7, 1.31, 0.03):
            for dy in range(-16, 17, 4):
                for dx in range(-16, 17, 4):
                    e = err(s, dx, dy)
                    if e < best[0]:
                        best = (e, float(s), float(dx), float(dy))
    _, s0, x0, y0 = best
    for s in np.arange(s0 - 0.03, s0 + 0.031, 0.01):
        for dy in np.arange(y0 - 3, y0 + 3.1, 1):
            for dx in np.arange(x0 - 3, x0 + 3.1, 1):
                e = err(float(s), float(dx), float(dy))
                if e < best[0]:
                    best = (e, float(s), float(dx), float(dy))
    e, s, dx, dy = best
    full = np.asarray(Image.fromarray(out_rgb).transform((W, H), Image.AFFINE, affine(s, dx / k, dy / k, W, H), Image.BICUBIC, fillcolor=fill), dtype=np.uint8)
    return full, round(e, 2)


# ---------------------------------------------------------------- matte


def diff_matte(black: np.ndarray, white: np.ndarray) -> np.ndarray:
    """True transparency from the same picture on black and on white: alpha = 1 − (W − B), colour = B / alpha."""
    b = black.astype(np.float32) / 255
    w = white.astype(np.float32) / 255
    a = np.clip(1 - (w - b).mean(axis=2), 0, 1)
    a = np.clip((a - 0.04) / 0.96, 0, 1)  # the backdrop is never perfectly flat
    c = np.where(a[..., None] > 1e-3, b / np.maximum(a[..., None], 1e-3), 0)
    return np.dstack([(np.clip(c, 0, 1) * 255).round(), (a * 255).round()]).astype(np.uint8)


def _grow(mask_small: np.ndarray, seed_small: np.ndarray) -> np.ndarray:
    cur = seed_small & mask_small
    while True:
        nxt = (np.asarray(Image.fromarray((cur * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(3))) > 0) & mask_small
        if (nxt == cur).all():
            return cur
        cur = nxt


def _small(mask: np.ndarray, k: int = 4) -> np.ndarray:
    H, W = mask.shape
    return np.asarray(Image.fromarray((mask * 255).astype(np.uint8)).resize((max(1, W // k), max(1, H // k)), Image.BILINEAR)) > 40


def _big(mask_small: np.ndarray, W: int, H: int) -> np.ndarray:
    return np.asarray(Image.fromarray((mask_small * 255).astype(np.uint8)).resize((W, H), Image.BILINEAR)) > 0


def keep_joined(rgba: np.ndarray, art_alpha: np.ndarray) -> np.ndarray:
    """Drop specks not joined to the piece (grown from the art inside the visible pixels)."""
    H, W = art_alpha.shape
    vis = _small(rgba[..., 3] > 12)
    seed = _small(art_alpha > 128)
    keep = _big(_grow(vis | seed, seed), W, H)
    keep = np.asarray(Image.fromarray((keep * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(5))) > 0
    out = rgba.copy()
    out[..., 3] = np.where(keep, out[..., 3], 0)
    return out


def suppress_ghost(matte: np.ndarray, art_alpha: np.ndarray, allow: np.ndarray | None = None) -> tuple[np.ndarray, float]:
    """Outside the art the material is colourless (clear plate, edge highlights): solid coloured pixels there are
    the model's own copy of the art drawn off — drop them. `allow`: where colour is legitimate (a cord, a flower).
    Returns the cleaned matte and the ghost's share of the art's area (a pass above MAX_GHOST is redrawn)."""
    near = np.asarray(Image.fromarray(art_alpha).filter(ImageFilter.MaxFilter(9))) > 128
    rgb = matte[..., :3].astype(np.float32)
    sat = (rgb.max(axis=2) - rgb.min(axis=2)) / 255
    ghost = (~near) & (matte[..., 3] > 70) & (sat > 0.22)
    if allow is not None:
        ghost &= ~allow
    ghost = (np.asarray(Image.fromarray((ghost * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(5))) > 0) & ~near
    out = matte.copy()
    out[..., 3] = np.where(ghost, 0, out[..., 3])
    return out, round(float(ghost.sum() / max(1, (art_alpha > 128).sum())), 4)


def excess_plate(rgba: np.ndarray, art_alpha: np.ndarray) -> float:
    """Material far from the artwork — the model drew a plate of its own shape (copied from a reference photo:
    a rectangle) instead of following the outline. Share of the art's area lying beyond a margin of ~5% of the
    art's size. A pass above MAX_EXCESS is redrawn."""
    H, W = art_alpha.shape
    k = 4
    small = lambda m: np.asarray(Image.fromarray((m * 255).astype(np.uint8)).resize((max(1, W // k), max(1, H // k)), Image.BILINEAR)) > 60  # noqa: E731
    art = small(art_alpha > 128)
    ys, xs = np.nonzero(art)
    if not len(xs):
        return 0.0
    margin = max(3, round(max(xs.max() - xs.min(), ys.max() - ys.min()) * 0.05)) | 1
    near = np.asarray(Image.fromarray((art * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(margin * 2 + 1))) > 0
    far = small(rgba[..., 3] > 40) & ~near
    return round(float(far.sum() / max(1, art.sum())), 4)


HOLE_WORD = re.compile(r"\bholes?\b|\beyelets?\b|\bgrommets?\b", re.I)
# A punched hole's share of the frame: real ones are ~0.07–0.09% at 1474 px; specks in a clear plate stay far below.
MIN_HOLE = 0.0002


def _outside(transparent: np.ndarray) -> np.ndarray:
    """Transparent pixels reachable from the frame's border (flood fill from a 1 px transparent frame)."""
    H, W = transparent.shape
    im = Image.new("L", (W + 2, H + 2), 255)
    im.paste(Image.fromarray(np.where(transparent, 255, 0).astype(np.uint8)), (1, 1))
    ImageDraw.floodfill(im, (0, 0), 128)
    return np.asarray(im)[1:-1, 1:-1] == 128


def has_hole(rgba: np.ndarray, art_alpha: np.ndarray) -> bool:
    """A see-through hole punched in the plate: transparent pixels enclosed by material, outside the artwork's own
    silhouette (its own gaps — a window, the space between a helmet and a collar — don't count)."""
    clear = rgba[..., 3] < 20
    enclosed = clear & ~_outside(clear)
    art_filled = ~_outside(art_alpha < 128)
    art_filled = np.asarray(Image.fromarray((art_filled * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(7))) > 0
    hole = Image.fromarray(((enclosed & ~art_filled) * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(5)).filter(ImageFilter.MaxFilter(5))
    hole = hole.point(lambda v: 255 if v > 0 else 0)
    min_area = MIN_HOLE * hole.width * hole.height
    # One blob at a time: a hole is round and compact (a circle fills ~79% of its box); a sliver the model left
    # between the plate and art cut off at the frame edge is not.
    while True:
        arr = np.asarray(hole)
        ys, xs = np.nonzero(arr == 255)
        if not len(xs):
            return False
        ImageDraw.floodfill(hole, (int(xs[0]), int(ys[0])), 100)
        by, bx = np.nonzero(np.asarray(hole) == 100)
        h, w = int(np.ptp(by)) + 1, int(np.ptp(bx)) + 1
        if len(bx) >= min_area and max(h, w) <= 1.8 * min(h, w) and len(bx) >= 0.5 * h * w:
            return True
        hole.paste(0, mask=Image.fromarray(((np.asarray(hole) == 100) * 255).astype(np.uint8)))


def lock_art(matte: np.ndarray, art: np.ndarray, surface: np.ndarray | None = None) -> np.ndarray:
    """The printed art: its own pixels ("print"), or the model's material surface inside its outline (`surface`).
    Alpha never drops below the art's — the artwork is never cut."""
    a = art[..., 3:4].astype(np.float32) / 255
    inside = (surface if surface is not None else art[..., :3]).astype(np.float32)
    rgb = inside * a + matte[..., :3].astype(np.float32) * (1 - a)
    return np.dstack([rgb.round().astype(np.uint8), np.maximum(art[..., 3], matte[..., 3])])


def merge_version(base: np.ndarray, version: np.ndarray, art_alpha: np.ndarray) -> np.ndarray:
    """Only what the added detail changed comes from `version`: differences off the plate, joined to the top
    edge (a cord leaves the picture there) or big enough to be a thing of their own — and, from there, on into
    the clear plate close by (a cord threaded through the hole lies over the tab in front and shows through it
    behind). Two passes of a clear plate differ a little all along its rim — away from the detail that stays the
    base's. The printed artwork is never taken."""
    a = on(base, (128, 128, 128)).astype(np.int16)
    b = on(version, (128, 128, 128)).astype(np.int16)
    delta = np.abs(a - b).max(axis=2)
    H, W = delta.shape
    plate = (base[..., 3] >= 60) & (art_alpha < 128)
    # On the plate a stronger change is needed: the rim of two clear passes differs a little everywhere.
    on_plate = _small((delta > 45) & plate)
    diff = (delta > 30) & (base[..., 3] < 60) & (art_alpha < 128)
    joined = _small(np.asarray(Image.fromarray((diff * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(7))) > 0)
    top = np.zeros((H, W), bool)
    top[:8] = True
    seed = _small(top)
    # A detail away from the edge (a flower on the plate): a blob big enough to be one.
    lab = _grow(joined, seed)
    rest = joined & ~lab
    if rest.any():
        art_area = max(1, int((_small(art_alpha > 128)).sum()))
        cur = rest.copy()
        blobs = np.zeros_like(rest)
        while cur.any():
            ys, xs = np.nonzero(cur)
            one = np.zeros_like(cur)
            one[ys[0], xs[0]] = True
            one = _grow(cur, one)
            if one.sum() > art_area * 0.003:
                blobs |= one
            cur &= ~one
        lab |= blobs
    if lab.any() and on_plate.any():
        # The detail continues over the plate only near where it already is (≈6% of the width).
        r = max(1, round(lab.shape[1] * 0.06))
        near = np.asarray(Image.fromarray((lab * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(2 * r + 1))) > 0
        lab = _grow(lab | (on_plate & near), lab)
        diff |= (delta > 45) & plate
    keep = _big(lab, W, H) & diff
    m = Image.fromarray((keep * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(1.2))
    mk = np.asarray(m, dtype=np.float32)[..., None] / 255
    return (version.astype(np.float32) * mk + base.astype(np.float32) * (1 - mk)).round().astype(np.uint8)


# ---------------------------------------------------------------- the passes


async def draw_pair(call: Call, prompt: str, first: np.ndarray, refs: list[bytes], ref_frame: np.ndarray, mask: np.ndarray, png) -> tuple[np.ndarray, np.ndarray, float]:
    """Model on black → the same on white → both fitted to the padded frame. (black, white, fit error)."""
    blk_raw = await call(prompt, [png(first), *refs])
    blk, e = align(ref_frame, mask, blk_raw)
    wht_raw = await call(TO_WHITE, [png(blk_raw)])
    visible = (blk.max(axis=2) > 40).astype(np.uint8) * 255
    wht, _ = align(blk, visible, wht_raw, (255, 255, 255))
    return blk, wht, e


async def render(
    call: Call,
    src: np.ndarray,
    material: str,
    specs: list[Spec],
    art_mode: str,
    refs: list[bytes],
    extra: str,
    png,
    attempts: int = 3,
    shaped: bool = False,
) -> tuple[list[tuple[str, np.ndarray]], int, list[str]]:
    """One clipart → [(version label, RGBA on the padded canvas)], base first ("" label). Returns the padding (px)
    and report lines. `shaped`: `src` is cut to a khuôn — the piece keeps exactly its outline (alpha) and holes."""
    art, p = pad_canvas(src)
    art_alpha = art[..., 3]
    always = [s for s in specs if s.mode == "always"]
    versions = [s for s in specs if s.mode == "version"]
    # A punched hole is the detail the model most often forgets: a pass without one is drawn again.
    # Theo khuôn the hole is already cut in the piece.
    want_hole = not shaped and any(HOLE_WORD.search(s.text) for s in always)
    first = on(art, (0, 0, 0))
    lines = [FRAME_SHAPED if shaped else FRAME_SURFACE if art_mode == "surface" else FRAME_PRINT, material.strip()]
    if always:
        lines.append(REQUIRED.format(what="\n".join(f"- {s.text}" for s in always)))
    if versions:
        lines.append(NOT_YET.format(what="; ".join(s.text.rstrip(".") for s in versions)))
    if extra.strip():
        lines.append(extra.strip())
    lines.append(BLACK_BG)
    if refs:
        lines.append(REFS_NOTE)
    prompt = "\n".join(x for x in lines if x)
    ref_frame = on(art, (0, 0, 0))
    report: list[str] = []

    best: tuple[float, Pass] | None = None
    for i in range(attempts):
        blk, wht, e = await draw_pair(call, prompt, first, refs, ref_frame, art_alpha, png)
        matte, ghost = suppress_ghost(keep_joined(diff_matte(blk, wht), art_alpha), art_alpha)
        rgba = lock_art(matte, art, blk if art_mode == "surface" or shaped else None)
        if shaped:
            # The khuôn's outline, exactly: nothing past it, its holes open.
            rgba[..., 3] = art_alpha
        excess = 0.0 if shaped else excess_plate(rgba, art_alpha)
        hole_ok = not want_hole or has_hole(rgba, art_alpha)
        score = ghost * 1000 + excess * 300 + max(0.0, e - MAX_ALIGN_ERR) + (0 if hole_ok else 50)
        report.append(
            f"bản gốc lượt {i + 1}: lệch {e:.1f}, bóng ma {ghost * 100:.2f}%, tấm thừa {excess * 100:.1f}%"
            + ("" if hole_ok else ", THIẾU LỖ")
        )
        if best is None or score < best[0]:
            best = (score, Pass(blk, rgba))
        if ghost <= MAX_GHOST and excess <= MAX_EXCESS and e <= MAX_ALIGN_ERR and hole_ok:
            break
    assert best is not None
    base = best[1]
    out: list[tuple[str, np.ndarray]] = [("", base.rgba)]

    fit_mask = ((art_alpha > 128) | (base.rgba[..., 3] > 128)).astype(np.uint8) * 255
    for s in versions:
        # The added detail may be coloured anywhere (a cord, a flower): only the merge decides what is taken.
        allow = np.ones(art_alpha.shape, bool)
        add = ADD_ONE.format(what=s.text.strip())
        edit_from = base.black
        if refs:
            add += "\n" + REFS_NOTE
        chosen: tuple[float, np.ndarray] | None = None
        for i in range(max(1, attempts - 1)):
            vb, vw, e = await draw_pair(call, add, edit_from, refs, base.black, fit_mask, png)
            matte, ghost = suppress_ghost(keep_joined(diff_matte(vb, vw), art_alpha), art_alpha, allow)
            full = lock_art(matte, art, vb if art_mode == "surface" or shaped else None)
            merged = merge_version(base.rgba, full, art_alpha)
            report.append(f"bản “{s.label}” lượt {i + 1}: lệch {e:.1f}, bóng ma {ghost * 100:.2f}%")
            score = ghost * 1000 + max(0.0, e - MAX_ALIGN_ERR)
            if chosen is None or score < chosen[0]:
                chosen = (score, merged)
            if ghost <= MAX_GHOST and e <= MAX_ALIGN_ERR:
                break
        assert chosen is not None
        out.append((s.label, chosen[1]))
    return out, p, report
