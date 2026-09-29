"""
material-render — production files + server-side product renders for printed
products (acrylic plates, ceramic ornaments, metal, wood). OpenCV, no AI.

    POST /print-pack  multipart: file (flat design PNG, transparent, main-asset size)
                                 main  (optional PNG — the blank, for shape "main")
                                 params (JSON, see material.Params; + preset from lib/materials.ts)
                      → application/zip: print.png, white.png (acrylic), cut.svg, preview.png, meta.json
    POST /render      multipart: file, main?, scene? (background photo), params (+ "scene" placement, "maxSide")
                      → PNG of the finished product (on the scene when given)
    GET  /health

The design is resampled to params.dpi at params.widthMm, so the cut path and
print files are at true size. Upscaling a small design does not add detail —
publish main assets at print resolution (e.g. 5.5 in @ 300 dpi = 1650 px).

Env:
    MATERIAL_TOKEN      if set, callers must send `Authorization: Bearer <token>`
    MATERIAL_MAX_BYTES  upload cap per file (40 MB)
    MATERIAL_MAX_SIDE   longest print side in px (12000)
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import time
import zipfile

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import Response
from PIL import Image, UnidentifiedImageError

from material import Params, cut_svg, outline_paths_mm, perimeter_mm, place_on_scene, render, white_layer

TOKEN = os.getenv("MATERIAL_TOKEN", "")
MAX_BYTES = int(os.getenv("MATERIAL_MAX_BYTES", str(40 * 1024 * 1024)))
MAX_SIDE = int(os.getenv("MATERIAL_MAX_SIDE", "12000"))

log = logging.getLogger("material-render")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")

app = FastAPI(title="material-render")


def read_rgba(data: bytes, what: str) -> np.ndarray:
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except (UnidentifiedImageError, OSError) as e:
        raise HTTPException(400, f"{what}: not a readable PNG/JPEG/WebP image") from e
    return np.asarray(img.convert("RGBA")).copy()


def png(arr: np.ndarray, dpi: int | None = None) -> bytes:
    buf = io.BytesIO()
    kw = {"dpi": (dpi, dpi)} if dpi else {}
    Image.fromarray(arr).save(buf, format="PNG", compress_level=6, **kw)
    return buf.getvalue()


def resize(arr: np.ndarray, w: int, h: int) -> np.ndarray:
    if arr.shape[1] == w and arr.shape[0] == h:
        return arr
    interp = cv2.INTER_AREA if w < arr.shape[1] else cv2.INTER_LANCZOS4
    return cv2.resize(arr, (w, h), interpolation=interp)


def parse_params(raw: str) -> tuple[Params, dict]:
    try:
        d = json.loads(raw or "{}")
    except json.JSONDecodeError as e:
        raise HTTPException(400, "params must be JSON") from e
    if not isinstance(d, dict):
        raise HTTPException(400, "params must be a JSON object")
    return Params.from_dict(d), d


async def read_upload(f: UploadFile | None, what: str) -> bytes | None:
    if f is None:
        return None
    data = await f.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(413, f"{what} too large (max {MAX_BYTES // (1024 * 1024)} MB)")
    return data or None


def check_token(authorization: str | None) -> None:
    if TOKEN and authorization != f"Bearer {TOKEN}":
        raise HTTPException(401, "Unauthorized")


def build_pack(design_b: bytes, main_b: bytes | None, p: Params) -> bytes:
    design = read_rgba(design_b, "file")
    main = read_rgba(main_b, "main") if main_b else None
    h0, w0 = design.shape[:2]
    # True size: widthMm at dpi.
    w = int(round(p.width_mm / 25.4 * p.dpi))
    h = int(round(w * h0 / w0))
    if max(w, h) > MAX_SIDE:
        raise HTTPException(400, f"Print too large: {w}×{h}px (max side {MAX_SIDE}); lower dpi or widthMm")
    design = resize(design, w, h)
    if main is not None:
        main = resize(main, w, h)

    r = render(design, main, p)
    H, W = r.mask.shape
    mm = r.px_per_mm
    paths = outline_paths_mm(r.mask, mm)

    # Crop everything to the plate's bounding box (+1 mm) so files carry no empty shadow padding.
    ys, xs = np.nonzero(r.mask >= 0.5)
    if len(xs):
        m = int(round(mm))
        x0, x1 = max(0, int(xs.min()) - m), min(W, int(xs.max()) + m + 1)
        y0, y1 = max(0, int(ys.min()) - m), min(H, int(ys.max()) + m + 1)
    else:
        x0, y0, x1, y1 = 0, 0, W, H
    ox, oy = x0 / mm, y0 / mm
    paths = [pth - np.array([ox, oy]) for pth in paths]
    cw_mm, ch_mm = (x1 - x0) / mm, (y1 - y0) / mm

    white = white_layer(r, p)
    area = float((r.mask >= 0.5).sum()) / (mm * mm)
    meta = {
        "material": p.material,
        "shape": p.shape,
        "dpi": p.dpi,
        "pxPerMm": mm,
        "printPx": [x1 - x0, y1 - y0],
        "sizeMm": [round(cw_mm, 2), round(ch_mm, 2)],
        "plateAreaMm2": round(area, 1),
        "cutLengthMm": round(perimeter_mm(paths), 1),
        "cutPaths": len(paths),
        "files": ["print.png", "cut.svg", "preview.png", "meta.json"] + (["white.png"] if white is not None else []),
        "sourcePx": [w0, h0],
        "upscaled": w > w0,
        "warnings": [],
    }
    if p.shape == "contour" and len(paths) > 1:
        meta["warnings"].append(f"Plate is {len(paths)} separate pieces — raise borderMm or move the parts closer so they connect")
    if w > w0 * 1.5:
        meta["warnings"].append(f"Design upscaled {w / w0:.1f}× to reach {p.dpi} dpi — upload larger assets for a sharp print")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("print.png", png(r.art[y0:y1, x0:x1], p.dpi))
        if white is not None:
            z.writestr("white.png", png(white[y0:y1, x0:x1], p.dpi))
        z.writestr("cut.svg", cut_svg(paths, cw_mm, ch_mm))
        z.writestr("preview.png", png(r.preview))
        z.writestr("meta.json", json.dumps(meta, indent=2))
    return buf.getvalue()


def build_render(design_b: bytes, main_b: bytes | None, scene_b: bytes | None, p: Params, raw: dict) -> bytes:
    design = read_rgba(design_b, "file")
    main = read_rgba(main_b, "main") if main_b else None
    max_side = int(raw.get("maxSide", 1600) or 1600)
    scene = read_rgba(scene_b, "scene") if scene_b else None
    h0, w0 = design.shape[:2]
    if scene is not None:
        k0 = min(1.0, max_side / max(scene.shape[:2]))
        scene = resize(scene, int(scene.shape[1] * k0), int(scene.shape[0] * k0))
        placement = raw.get("scene") or {}
        k = min(1.0, float(placement.get("width", 0.7)) * scene.shape[1] / w0)
    else:
        k = min(1.0, max_side / max(w0, h0))
    w, h = max(1, int(w0 * k)), max(1, int(h0 * k))
    design = resize(design, w, h)
    if main is not None:
        main = resize(main, w, h)
    # mm are relative to the (scaled) main width, so scaling keeps proportions.
    r = render(design, main, p)
    if scene is not None:
        return png(place_on_scene(r, w, h, scene, raw.get("scene") or {}))
    return png(r.preview)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/print-pack")
async def print_pack(
    file: UploadFile = File(...),
    main: UploadFile | None = File(None),
    params: str = Form("{}"),
    authorization: str | None = Header(None),
) -> Response:
    check_token(authorization)
    p, _ = parse_params(params)
    design_b = await read_upload(file, "file")
    if not design_b:
        raise HTTPException(400, "file is empty")
    main_b = await read_upload(main, "main")
    started = time.perf_counter()
    body = await asyncio.to_thread(build_pack, design_b, main_b, p)
    log.info("print-pack %s %.0fmm@%ddpi → %d KB in %.2fs", p.material, p.width_mm, p.dpi, len(body) // 1024, time.perf_counter() - started)
    return Response(body, media_type="application/zip", headers={"Content-Disposition": 'attachment; filename="print-pack.zip"'})


@app.post("/render")
async def render_endpoint(
    file: UploadFile = File(...),
    main: UploadFile | None = File(None),
    scene: UploadFile | None = File(None),
    params: str = Form("{}"),
    authorization: str | None = Header(None),
) -> Response:
    check_token(authorization)
    p, raw = parse_params(params)
    design_b = await read_upload(file, "file")
    if not design_b:
        raise HTTPException(400, "file is empty")
    main_b = await read_upload(main, "main")
    scene_b = await read_upload(scene, "scene")
    started = time.perf_counter()
    body = await asyncio.to_thread(build_render, design_b, main_b, scene_b, p, raw)
    elapsed = time.perf_counter() - started
    log.info("render %s → %d KB in %.2fs", p.material, len(body) // 1024, elapsed)
    return Response(body, media_type="image/png", headers={"X-Elapsed-Ms": str(round(elapsed * 1000))})
