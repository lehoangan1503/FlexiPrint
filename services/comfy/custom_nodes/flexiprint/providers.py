"""Image model backends for the FlexiPrint nodes. No local models — everything
is an HTTP call, so ComfyUI runs on a CPU-only box.

  cpa:<model>   OpenAI-compatible images API (CPA_BASE_URL, CPA_API_KEY)
                POST /images/generations  {model, prompt}
                POST /images/edits        {model, prompt, images: [{image_url: data-uri}]}   (JSON, not multipart)
                → {data: [{b64_json}]}
  fal:<model>   fal.ai sync endpoints (FAL_KEY), e.g. fal-ai/nano-banana/edit
"""

from __future__ import annotations

import asyncio
import base64
import os

import aiohttp

UA = "FlexiPrint-Studio/1.0"

# Shown in every model dropdown, first = default.
MODELS = [
    "cpa:gpt-image-2",
    "cpa:gpt-image-2.5",
    "cpa:gpt-image-1.5",
    "cpa:grok-imagine-image-quality",
    "fal:fal-ai/nano-banana-2/edit",
    "fal:fal-ai/nano-banana/edit",
    "fal:fal-ai/bytedance/seedream/v4.5/edit",
]


class ProviderError(RuntimeError):
    pass


def _data_uri(png: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(png).decode()


async def _cpa(path: str, body: dict) -> bytes:
    base = (os.environ.get("CPA_BASE_URL") or "https://cpa.next.lc/v1").rstrip("/")
    key = os.environ.get("CPA_API_KEY", "")
    if not key:
        raise ProviderError("CPA_API_KEY chưa cấu hình")
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": UA}
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=300)) as s:
        async with s.post(f"{base}{path}", json=body, headers=headers) as r:
            text = await r.text()
            if r.status >= 400:
                raise ProviderError(f"cpa {r.status}: {text[:300]}")
    import json

    data = json.loads(text).get("data") or []
    if not data or not data[0].get("b64_json"):
        raise ProviderError("cpa không trả ảnh")
    return base64.b64decode(data[0]["b64_json"])


async def _fal(model: str, body: dict) -> bytes:
    key = os.environ.get("FAL_KEY", "")
    if not key:
        raise ProviderError("FAL_KEY chưa cấu hình")
    headers = {"Authorization": f"Key {key}", "Content-Type": "application/json", "User-Agent": UA}
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=300)) as s:
        async with s.post(f"https://fal.run/{model}", json=body, headers=headers) as r:
            js = await r.json(content_type=None)
            if r.status >= 400:
                raise ProviderError(f"fal {r.status}: {str(js.get('detail', js))[:300]}")
        out = (js.get("images") or [js.get("image")])[0] if (js.get("images") or js.get("image")) else None
        if not out or not out.get("url"):
            raise ProviderError("fal không trả ảnh")
        url = out["url"]
        if url.startswith("data:"):
            return base64.b64decode(url.split(",", 1)[1])
        async with s.get(url) as f:
            if f.status >= 400:
                raise ProviderError(f"fal output {f.status}")
            return await f.read()


def fallbacks(model: str) -> list[str]:
    """The model first, then FP_FALLBACK_MODELS (comma list) — cpa pools hit usage limits."""
    raw = os.environ.get("FP_FALLBACK_MODELS", "cpa:grok-imagine-image-quality,fal:fal-ai/nano-banana-2/edit")
    chain = [model] + [m.strip() for m in raw.split(",") if m.strip()]
    return list(dict.fromkeys(chain))


def _retryable(e: ProviderError) -> bool:
    msg = str(e)
    return any(f" {c}:" in msg for c in ("429", "500", "502", "503", "504")) or "chưa cấu hình" in msg or "không trả ảnh" in msg


async def run(model: str, prompt: str, references: list[bytes] | None = None) -> tuple[bytes, str]:
    """generate() with the fallback chain. Returns (image, model actually used)."""
    last: ProviderError | None = None
    for m in fallbacks(model):
        try:
            return await generate(m, prompt, references), m
        except ProviderError as e:
            last = e
            if not _retryable(e):
                raise
    raise last or ProviderError("Không model nào chạy được")


async def generate(model: str, prompt: str, references: list[bytes] | None = None) -> bytes:
    """Text (+ optional reference images) → one image (PNG/JPEG bytes)."""
    refs = references or []
    backend, _, name = model.partition(":")
    if backend == "cpa":
        if refs:
            return await _cpa("/images/edits", {"model": name, "prompt": prompt, "images": [{"image_url": _data_uri(r)} for r in refs[:8]]})
        return await _cpa("/images/generations", {"model": name, "prompt": prompt})
    if backend == "fal":
        if not refs:
            # Edit endpoints need an image; their text-to-image siblings drop the /edit suffix.
            name = name.removesuffix("/edit")
            return await _fal(name, {"prompt": prompt, "num_images": 1, "output_format": "png"})
        return await _fal(name, {"prompt": prompt, "image_urls": [_data_uri(r) for r in refs[:8]], "num_images": 1, "output_format": "png"})
    raise ProviderError(f"Model không hỗ trợ: {model}")


async def edit(model: str, prompt: str, image: bytes, extra_refs: list[bytes] | None = None) -> tuple[bytes, str]:
    """Edit `image` (first reference) following `prompt`. Returns (image, model used)."""
    return await run(model, prompt, [image, *(extra_refs or [])])


async def cutout(image: bytes) -> bytes:
    """Subject cut-out (RGBA PNG) — fal BiRefNet."""
    return await _fal(
        "fal-ai/birefnet/v2",
        {"image_url": _data_uri(image), "model": "General Use (Heavy)", "operating_resolution": "1024x1024", "output_format": "png", "refine_foreground": True},
    )


async def gather_limited(coros: list, limit: int = 3) -> list:
    """Run provider calls concurrently, a few at a time (rate limits, RAM)."""
    sem = asyncio.Semaphore(limit)

    async def run(c):
        async with sem:
            return await c

    return await asyncio.gather(*(run(c) for c in coros))
