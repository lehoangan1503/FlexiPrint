"""
bg-remover — background-removal microservice.

Wraps rembg (https://github.com/danielgatis/rembg) behind one HTTP endpoint so
any app can cut a subject out of a photo without a paid API. The default model
is BiRefNet (MIT licence): a segmentation network, so the photo's own pixels
are kept — only an alpha channel is added.

    POST /remove   multipart `file` (PNG/JPEG/WebP) → image/png with alpha
                   query: model, decontaminate (default on), post_process (default on)
    GET  /health   → {"status", "model", "loaded"}

Env:
    BG_MODEL        default model (birefnet-general). Do NOT use bria-rmbg
                    commercially: its licence is non-commercial.
    BG_MODELS       comma list of models a caller may pick (default: BG_MODEL only)
    BG_TOKEN        if set, callers must send `Authorization: Bearer <token>`
    BG_MAX_BYTES    upload cap (15 MB)
    BG_MAX_SIDE     photos are downscaled to this long side first (2048)
    BG_CONCURRENCY  inferences at once (1) — each BiRefNet run holds ~2-3 GB
    BG_PROVIDERS    onnxruntime providers, comma list (default: CPU)
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, File, Header, HTTPException, Query, UploadFile
from fastapi.responses import JSONResponse, Response
from PIL import Image, ImageOps, UnidentifiedImageError
from rembg import new_session, remove
from rembg.sessions.base import BaseSession

MODEL = os.getenv("BG_MODEL", "birefnet-general")
MODELS = {m.strip() for m in os.getenv("BG_MODELS", MODEL).split(",") if m.strip()} | {MODEL}
TOKEN = os.getenv("BG_TOKEN", "")
MAX_BYTES = int(os.getenv("BG_MAX_BYTES", str(15 * 1024 * 1024)))
MAX_SIDE = int(os.getenv("BG_MAX_SIDE", "2048"))
CONCURRENCY = max(1, int(os.getenv("BG_CONCURRENCY", "1")))
# CoreML on Apple Silicon compiles BiRefNet slowly and falls back op by op; CPU is the predictable default.
PROVIDERS = [p.strip() for p in os.getenv("BG_PROVIDERS", "CPUExecutionProvider").split(",") if p.strip()]

log = logging.getLogger("bg-remover")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")

sessions: dict[str, BaseSession] = {}
gate = asyncio.Semaphore(CONCURRENCY)


def session_for(model: str) -> BaseSession:
    """Load a model once per process (first load downloads it to ~/.rembg/models)."""
    s = sessions.get(model)
    if s is None:
        started = time.perf_counter()
        s = new_session(model, providers=PROVIDERS)
        sessions[model] = s
        log.info("loaded %s in %.1fs", model, time.perf_counter() - started)
    return s


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    # Load the default model before accepting traffic, so the first customer doesn't wait on a 1 GB download.
    await asyncio.to_thread(session_for, MODEL)
    yield


app = FastAPI(title="bg-remover", lifespan=lifespan)


def cut_out(data: bytes, model: str, decontaminate: bool, post_process: bool) -> bytes:
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except (UnidentifiedImageError, OSError) as e:
        raise HTTPException(400, "Not a readable PNG/JPEG/WebP image") from e
    # Phone photos carry their rotation in EXIF; the model must see them upright.
    img = ImageOps.exif_transpose(img).convert("RGB")
    if max(img.size) > MAX_SIDE:
        img.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)
    out = remove(img, session=session_for(model), post_process_mask=post_process, decontaminate=decontaminate)
    if not isinstance(out, Image.Image):
        raise HTTPException(500, "Unexpected rembg output")
    buf = io.BytesIO()
    out.save(buf, format="PNG", compress_level=6)
    return buf.getvalue()


@app.get("/health")
async def health() -> dict[str, object]:
    return {"status": "ok", "model": MODEL, "loaded": sorted(sessions)}


@app.post("/remove")
async def remove_background(
    file: UploadFile = File(...),
    model: str = Query(MODEL),
    decontaminate: bool = Query(True, description="Pull backdrop colour out of semi-transparent edge pixels (fur, hair)"),
    post_process: bool = Query(True, description="Smooth the mask and drop speckles"),
    authorization: str | None = Header(None),
) -> Response:
    if TOKEN and authorization != f"Bearer {TOKEN}":
        raise HTTPException(401, "Unauthorized")
    if model not in MODELS:
        raise HTTPException(400, f"Model not enabled; allowed: {', '.join(sorted(MODELS))}")
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(413, f"File too large (max {MAX_BYTES // (1024 * 1024)} MB)")

    started = time.perf_counter()
    async with gate:
        waited = time.perf_counter() - started
        png = await asyncio.to_thread(cut_out, data, model, decontaminate, post_process)
    elapsed = time.perf_counter() - started
    log.info("removed bg: %d KB in, %d KB out, %.2fs (%.2fs queued), %s", len(data) // 1024, len(png) // 1024, elapsed, waited, model)
    return Response(png, media_type="image/png", headers={"X-Model": model, "X-Elapsed-Ms": str(round(elapsed * 1000))})


@app.exception_handler(Exception)
async def unhandled(_, exc: Exception) -> JSONResponse:
    log.exception("remove failed")
    return JSONResponse({"error": str(exc) or exc.__class__.__name__}, status_code=500)
