"""HTTP routes the ComfyUI frontend calls (same origin as the studio page):

  GET /flexi/options/<kind>   JSON string list for remote dropdowns
                              (style_pack | material | scene | categories | cliparts | artworks)
  GET /flexi/library          { categories, cliparts } for the FlexiPrint sidebar
  GET /flexi/products         products + their saved artworks (composites)

They proxy the FlexiPrint internal API server-side, so the browser never sees
the internal token.
"""

from __future__ import annotations

from aiohttp import web
from server import PromptServer

from . import context as fpc
from . import fp_api

routes = PromptServer.instance.routes


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
