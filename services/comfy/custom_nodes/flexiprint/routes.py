"""HTTP routes the ComfyUI frontend calls (same origin as the studio page):

  GET /flexi/options/<kind>   JSON string list for remote dropdowns
                              (style_pack | material | scene | categories | cliparts | artworks)
  GET /flexi/library          { categories, cliparts } for the FlexiPrint sidebar
  GET /flexi/products         products + their saved artworks (composites)

They proxy the FlexiPrint internal API server-side, so the browser never sees
the internal token.

The app's AI dialog (customize-tool/server/studio.ts) drives the same nodes
through recipes (recipes.py), Bearer FP_COMFY_TOKEN:

  GET  /flexi/models          { models } — first = default
  POST /flexi/run             { recipe, params } → { run_id }   queued like a studio run
  GET  /flexi/run/<id>        { status: queued|running|done|error, position?, node?, ids, error? }
  POST /flexi/refs            multipart file → { name }   a reference photo, saved as PNG in
                              input/flexiprint/ (recipe origin: subjects[].refs)
  POST /flexi/draft           { recipe, params } → { draft_id } the graph, parked for the studio
  GET  /flexi/draft/<id>      API prompt (no token: the id is the secret; the studio opens it
                              via ?fp_draft= and loads it with app.loadApiJson)
"""

from __future__ import annotations

import hmac
import json
import os
import time
import uuid

import aiohttp
from aiohttp import web
from server import PromptServer

import folder_paths

from . import context as fpc
from . import fp_api, imaging, providers, recipes

server = PromptServer.instance
routes = server.routes

# Browsers send every cookie of the app's domain to /comfy/ (and of localhost to
# :8188 in dev): the Supabase session alone can pass aiohttp's 8190-byte header
# limit ("Got more than 8190 bytes when reading"). The app is built but not yet
# started when custom nodes load, so its request handler still takes this.
server.app._handler_args = {**(server.app._handler_args or {}), "max_line_size": 65536, "max_field_size": 65536}


def _category_paths(categories: list[dict]) -> dict[str, str]:
    by_id = {c["id"]: c for c in categories}

    def path(c: dict, depth: int = 0) -> str:
        parent = by_id.get(c.get("parent_id") or "")
        return f"{path(parent, depth + 1)} / {c['name']}" if parent and depth < 8 else c["name"]

    return {c["id"]: path(c) for c in categories}


async def options(kind: str) -> list[str]:
    if kind in ("style_pack", "material", "scene"):
        items = [fpc.option_label(p["name"], p["id"]) for p in await fp_api.presets(kind)]
        return [fpc.NONE_OPTION, *items] if kind == "style_pack" else items
    if kind == "categories":
        cats = await fp_api.categories()
        paths = _category_paths(cats)
        return sorted(fpc.option_label(f"{paths[c['id']]} [{'main' if c['usage'] == 'main' else 'element'}]", c["id"]) for c in cats)
    if kind == "cliparts":
        cats = await fp_api.categories()
        paths = _category_paths(cats)
        items = await fp_api.cliparts()
        by_id = {a["id"]: a for a in items}
        out = []
        for a in items:
            parent = by_id.get(a.get("parent_id") or "")
            prefix = paths.get(a.get("category_id") or "", "Chưa phân loại")
            label = f"{prefix} / {parent['name']} / {a['name']}" if parent else f"{prefix} / {a['name']}"
            if a["role"] == "rendition":
                label += " (vật liệu)"
            out.append(fpc.option_label(label, a["id"]))
        return sorted(out)
    if kind == "artworks":
        out = []
        for p in await fp_api.products():
            for c in p["composites"]:
                out.append(fpc.option_label(f"{p['name']} / {c['name']}", c["id"]))
        return out
    raise web.HTTPNotFound()


def _error(e: Exception) -> web.Response:
    return web.json_response({"error": str(e)}, status=502)


@routes.get("/flexi/options/{kind}")
async def get_options(request: web.Request) -> web.Response:
    try:
        return web.json_response(await options(request.match_info["kind"]))
    except web.HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 — surface to the widget
        return _error(e)


@routes.get("/flexi/library")
async def get_library(request: web.Request) -> web.Response:
    try:
        category = request.query.get("category") or None
        return web.json_response({"categories": await fp_api.categories(), "cliparts": await fp_api.cliparts(category)})
    except Exception as e:  # noqa: BLE001
        return _error(e)


@routes.get("/flexi/products")
async def get_products(request: web.Request) -> web.Response:
    try:
        return web.json_response({"products": await fp_api.products()})
    except Exception as e:  # noqa: BLE001
        return _error(e)


# ---------------------------------------------------------------- recipes (app AI dialog)

DRAFT_TTL_S = 6 * 3600
_drafts: dict[str, tuple[float, dict]] = {}


def _authorized(request: web.Request) -> bool:
    token = os.environ.get("FP_COMFY_TOKEN", "")
    got = request.headers.get("Authorization", "")
    return bool(token) and hmac.compare_digest(got, f"Bearer {token}")


async def _recipe_body(request: web.Request) -> tuple[str, dict, dict]:
    try:
        body = await request.json()
    except json.JSONDecodeError as e:
        raise recipes.RecipeError("Body không phải JSON") from e
    recipe = str(body.get("recipe", ""))
    params = body.get("params") or {}
    return recipe, params, recipes.build(recipe, params)


@routes.get("/flexi/models")
async def get_models(request: web.Request) -> web.Response:
    return web.json_response({"models": providers.MODELS})


@routes.post("/flexi/run")
async def post_run(request: web.Request) -> web.Response:
    if not _authorized(request):
        return web.json_response({"error": "Unauthorized"}, status=401)
    try:
        recipe, params, prompt = await _recipe_body(request)
    except recipes.RecipeError as e:
        return web.json_response({"error": str(e)}, status=400)
    # Through ComfyUI's own /prompt so validation, queueing and history are the stock ones.
    # extra_pnginfo.workflow is what FP Save logs as "the graph that ran".
    payload = {"prompt": prompt, "extra_data": {"extra_pnginfo": {"workflow": {"fp_recipe": recipe, "params": params, "prompt": prompt}}}}
    port = getattr(server, "port", None) or 8188
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as s:
        async with s.post(f"http://127.0.0.1:{port}/prompt", json=payload) as r:
            res = await r.json(content_type=None)
            if r.status >= 400:
                err = res.get("error") if isinstance(res, dict) else res
                msg = err.get("message") if isinstance(err, dict) else str(err)
                details = [e.get("message", "") for n in (res.get("node_errors") or {}).values() for e in n.get("errors", [])] if isinstance(res, dict) else []
                return web.json_response({"error": "; ".join([msg or "Graph không hợp lệ", *details])}, status=400)
    return web.json_response({"run_id": res["prompt_id"]})


def _history_error(entry: dict) -> str:
    for kind, data in (entry.get("status") or {}).get("messages") or []:
        if kind == "execution_error":
            return f"{data.get('node_type', '')}: {data.get('exception_message', '')}".strip(": ")
        if kind == "execution_interrupted":
            return "Đã dừng"
    return "Chạy thất bại"


@routes.get("/flexi/run/{run_id}")
async def get_run(request: web.Request) -> web.Response:
    if not _authorized(request):
        return web.json_response({"error": "Unauthorized"}, status=401)
    run_id = request.match_info["run_id"]
    entry = server.prompt_queue.get_history(prompt_id=run_id).get(run_id)
    if entry:
        ids = [i for out in (entry.get("outputs") or {}).values() for i in (out.get("fp_ids") or [])]
        status = entry.get("status") or {}
        if status.get("status_str") == "error":
            return web.json_response({"status": "error", "ids": ids, "error": _history_error(entry)})
        return web.json_response({"status": "done", "ids": ids})
    running, pending = server.prompt_queue.get_current_queue_volatile()
    mine = next((item for item in running if item[1] == run_id), None)
    if mine:
        node = None
        if getattr(server, "last_prompt_id", None) == run_id and server.last_node_id is not None:
            node = (mine[2].get(str(server.last_node_id)) or {}).get("class_type")
        return web.json_response({"status": "running", "node": node, "ids": []})
    order = sorted(pending, key=lambda item: item[0])
    for i, item in enumerate(order):
        if item[1] == run_id:
            return web.json_response({"status": "queued", "position": i + 1 + len(running), "ids": []})
    return web.json_response({"status": "error", "ids": [], "error": "Không tìm thấy lượt chạy (ComfyUI đã khởi động lại?)"})


@routes.post("/flexi/draft")
async def post_draft(request: web.Request) -> web.Response:
    if not _authorized(request):
        return web.json_response({"error": "Unauthorized"}, status=401)
    try:
        _, _, prompt = await _recipe_body(request)
    except recipes.RecipeError as e:
        return web.json_response({"error": str(e)}, status=400)
    now = time.time()
    for k in [k for k, (t, _) in _drafts.items() if now - t > DRAFT_TTL_S]:
        del _drafts[k]
    draft_id = str(uuid.uuid4())
    _drafts[draft_id] = (now, prompt)
    return web.json_response({"draft_id": draft_id})


@routes.get("/flexi/draft/{draft_id}")
async def get_draft(request: web.Request) -> web.Response:
    hit = _drafts.get(request.match_info["draft_id"])
    if not hit:
        return web.json_response({"error": "Bản nháp đã hết hạn — mở lại từ app"}, status=404)
    return web.json_response(hit[1])


REF_MAX_SIDE = 1536


@routes.post("/flexi/refs")
async def post_ref(request: web.Request) -> web.Response:
    if not _authorized(request):
        return web.json_response({"error": "Unauthorized"}, status=401)
    form = await request.post()
    f = form.get("file")
    if f is None or not hasattr(f, "file"):
        return web.json_response({"error": "Thiếu file"}, status=400)
    try:
        rgba = imaging.bytes_to_rgba(f.file.read())
    except Exception:  # noqa: BLE001 — not an image
        return web.json_response({"error": "File không phải ảnh"}, status=400)
    h, w = rgba.shape[:2]
    k = min(1.0, REF_MAX_SIDE / max(h, w))
    if k < 1:
        rgba = imaging.resize_to(rgba, max(1, round(w * k)), max(1, round(h * k)))
    folder = os.path.join(folder_paths.get_input_directory(), "flexiprint")
    os.makedirs(folder, exist_ok=True)
    name = f"{uuid.uuid4().hex}.png"
    with open(os.path.join(folder, name), "wb") as out:
        out.write(imaging.rgba_to_png(rgba))
    return web.json_response({"name": f"flexiprint/{name}"})
