"""FlexiPrint internal API client (customize-tool/server/studio.ts).

Env:
  FP_API_URL      e.g. http://app:3000/api/customize-tool (docker) or http://127.0.0.1:3000/api/customize-tool
  FP_COMFY_TOKEN  shared bearer token (CT_COMFY_TOKEN on the app side)
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

import aiohttp

UA = "FlexiPrint-Studio/1.0"
_cache: dict[str, tuple[float, Any]] = {}
CACHE_S = 20.0


class FlexiPrintError(RuntimeError):
    pass


def _base() -> str:
    base = os.environ.get("FP_API_URL", "").rstrip("/")
    if not base:
        raise FlexiPrintError("FP_API_URL chưa cấu hình")
    return base


def _headers() -> dict[str, str]:
    token = os.environ.get("FP_COMFY_TOKEN", "")
    if not token:
        raise FlexiPrintError("FP_COMFY_TOKEN chưa cấu hình")
    return {"Authorization": f"Bearer {token}", "User-Agent": UA}


async def get(path: str, params: dict[str, str] | None = None, cached: bool = True) -> Any:
    key = path + json.dumps(params or {}, sort_keys=True)
    hit = _cache.get(key)
    if cached and hit and time.time() - hit[0] < CACHE_S:
        return hit[1]
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as s:
        async with s.get(f"{_base()}/internal/{path}", params=params or {}, headers=_headers()) as r:
            body = await r.json(content_type=None)
            if r.status >= 400:
                raise FlexiPrintError(f"FlexiPrint {r.status}: {body.get('error') if isinstance(body, dict) else body}")
    _cache[key] = (time.time(), body)
    return body


async def post_form(path: str, fields: dict[str, str], file_bytes: bytes, filename: str = "image.png") -> Any:
    form = aiohttp.FormData()
    for k, v in fields.items():
        if v is not None and v != "":
            form.add_field(k, v)
    form.add_field("file", file_bytes, filename=filename, content_type="image/png")
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=120)) as s:
        async with s.post(f"{_base()}/internal/{path}", data=form, headers=_headers()) as r:
            body = await r.json(content_type=None)
            if r.status >= 400:
                raise FlexiPrintError(f"FlexiPrint {r.status}: {body.get('error') if isinstance(body, dict) else body}")
    _cache.clear()
    return body


async def download(url: str) -> bytes:
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=60)) as s:
        async with s.get(url, headers={"User-Agent": UA}) as r:
            if r.status >= 400:
                raise FlexiPrintError(f"Không tải được ảnh ({r.status}): {url}")
            return await r.read()


# ---------------------------------------------------------------- lookups

async def categories() -> list[dict]:
    return (await get("categories"))["categories"]


async def presets(kind: str | None = None) -> list[dict]:
    return (await get("presets", {"kind": kind} if kind else None))["presets"]


async def cliparts(category: str | None = None) -> list[dict]:
    return (await get("cliparts", {"category": category} if category else None))["cliparts"]


async def clipart(clipart_id: str) -> dict:
    return (await get(f"cliparts/{clipart_id}", cached=False))["clipart"]


async def products() -> list[dict]:
    return (await get("products"))["products"]
