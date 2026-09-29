"""
photo-style — turn a photo into an art style with classical image processing
(OpenCV, see styles.py). No AI model, no API key, no GPU.

    POST /stylize   multipart `file` (PNG/JPEG/WebP) + form/query `style`
                    → PNG when the input has transparency, else JPEG
    GET  /styles    → {"styles": [...]}
    GET  /health    → {"status": "ok"}

A transparent (cut-out) input keeps its alpha: transparent pixels are filled
with the subject's own colours (bleed), filtered, the alpha is put back, and
most styles draw an ink outline around the silhouette (styles.OUTLINES).

Env:
    STYLE_TOKEN      if set, callers must send `Authorization: Bearer <token>`
    STYLE_MAX_BYTES  upload cap (15 MB)
    STYLE_MAX_SIDE   photos are downscaled to this long side first (1600)
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
import time

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.responses import Response
from PIL import Image, ImageOps, UnidentifiedImageError

from styles import OUTLINES, STYLES, outline

TOKEN = os.getenv("STYLE_TOKEN", "")
MAX_BYTES = int(os.getenv("STYLE_MAX_BYTES", str(15 * 1024 * 1024)))
MAX_SIDE = int(os.getenv("STYLE_MAX_SIDE", "1600"))

log = logging.getLogger("photo-style")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")

app = FastAPI(title="photo-style")


def bleed(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """
    Fill transparent pixels with the subject's own colours smeared outward
    (normalised blur, coarse to fine). Neighbourhood filters then see a
    continuation of the subject at its edge instead of white or leftover
    backdrop pixels, so no halo survives when the original alpha goes back on.
    """
    a = alpha.astype(np.float32)[..., None] / 255.0
    src = rgb.astype(np.float32)
    fill = np.zeros_like(src)
    covered = np.zeros_like(a)
    for sigma in (64, 24, 8, 3):
        num = cv2.GaussianBlur(src * a, (0, 0), sigma)
        den = cv2.GaussianBlur(a[..., 0], (0, 0), sigma)[..., None]
        layer = num / np.maximum(den, 1e-4)
        weight = np.clip(den * 4.0, 0.0, 1.0)  # finer levels win where they have data
        fill = fill * (1.0 - weight) + layer * weight
        covered = np.maximum(covered, weight)
    fill = fill * covered + 255.0 * (1.0 - covered)  # far from any subject: white
    return np.clip(src * a + fill * (1.0 - a), 0, 255).astype(np.uint8)


def render(data: bytes, style: str) -> tuple[bytes, str]:
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except (UnidentifiedImageError, OSError) as e:
        raise HTTPException(400, "Not a readable PNG/JPEG/WebP image") from e
    img = ImageOps.exif_transpose(img)
    if max(img.size) > MAX_SIDE:
        img.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)

    rgba = np.asarray(img.convert("RGBA"))
    alpha = rgba[..., 3]
    has_alpha = bool((alpha < 250).any())
    rgb = rgba[..., :3]
    if has_alpha:
        rgb = bleed(rgb, alpha)

    out = STYLES[style](np.ascontiguousarray(rgb), alpha.astype(np.float32) / 255.0 if has_alpha else None)
    if out.shape[:2] != alpha.shape:
        # Some styles work (and return) at a higher resolution than the upload.
        alpha = cv2.resize(alpha, (out.shape[1], out.shape[0]), interpolation=cv2.INTER_LINEAR)
    line = OUTLINES.get(style)
    if has_alpha and line:
        out, alpha = outline(out, alpha, *line)

    buf = io.BytesIO()
    if has_alpha:
        Image.fromarray(np.dstack([out, alpha])).save(buf, format="PNG", compress_level=6)
        return buf.getvalue(), "image/png"
    Image.fromarray(out).save(buf, format="JPEG", quality=92)
    return buf.getvalue(), "image/jpeg"


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/styles")
async def styles() -> dict[str, list[str]]:
    return {"styles": sorted(STYLES)}


@app.post("/stylize")
async def stylize(
    file: UploadFile = File(...),
    style: str | None = Form(None),
    style_q: str | None = Query(None, alias="style"),
    authorization: str | None = Header(None),
) -> Response:
    if TOKEN and authorization != f"Bearer {TOKEN}":
        raise HTTPException(401, "Unauthorized")
    chosen = style or style_q or ""
    if chosen not in STYLES:
        raise HTTPException(400, f"Unknown style '{chosen}'; available: {', '.join(sorted(STYLES))}")
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(413, f"File too large (max {MAX_BYTES // (1024 * 1024)} MB)")
    started = time.perf_counter()
    body, mime = await asyncio.to_thread(render, data, chosen)
    elapsed = time.perf_counter() - started
    log.info("%s: %d KB → %d KB in %.2fs", chosen, len(data) // 1024, len(body) // 1024, elapsed)
    return Response(body, media_type=mime, headers={"X-Style": chosen, "X-Elapsed-Ms": str(round(elapsed * 1000))})
