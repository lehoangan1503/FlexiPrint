"""Recipes — the four standard FlexiPrint jobs as ComfyUI graphs (API format).

The app's AI dialog doesn't draw graphs: it sends a recipe + a few params and
this module expands them into the same FP nodes the studio templates use, so a
dialog run, a studio run and an agent run share one engine.

    origin    category (+ style pack, material look, note, rule overrides) + subjects, each
              optionally with photos of the object (refs)
              → FP Origin Generate → FP Cutout → FP Save (origin)
              → per material_ids: FP Material → FP Save (rendition of each new origin)
              One subject = one original clipart, drawn flat; every material of the
              category adds one material version of it. Main or element comes from
              the category's usage.
    refine    cliparts already made + what to change (+ photos of the changed
              part) → per clipart FP Load → FP Refine → FP Cutout → FP Save
              (origin, same category, same name). One shared change for the
              whole set (a target state) + each clipart's own fixes and own
              description (saved as its spec); the category spec goes along as
              the set's rules. The first edited clipart (one without own fixes
              when there is one) is passed to the others as "match" so the set
              stays consistent. The app swaps the new ones into the products
              using the old ones, then deletes the old ones, if asked.
    adjust    free fixes (recolour / mirror, no AI) → FP Adjust → FP Save in place; a material
              version gets the same fix
    variant   one origin → a set of colours / styles, silhouette kept
              → FP Variant Set → FP Save (set_member)
              mode "recolor" (#hex / colour name) = pixel recolour, no AI, free;
              mode "ai" = AI edit with the origin's alpha re-applied.
              Each member keeps its line (meta.variant), so a fixed origin can remake
              its members the same way (lines with "replaces" = the member remade).
    material  cliparts (an origin and optionally its set) → material preset
              → FP Material → FP Save (rendition), one chain per clipart
    mockup    product artwork → (material) → scene → FP Save Mockup
    mockup_enhance
              hand-made tổ hợp pictures (editor Tổ hợp, uploaded as refs) + one prompt for
              all + one per picture → per picture FP Mockup Enhance (the other pictures
              ride along as numbered references, "#2") → FP Save Mockup

`build()` validates and returns the API prompt; routes.py queues it
(/flexi/run) or parks it for the studio to open (/flexi/draft).
"""

from __future__ import annotations

import json
import random
import re
from typing import Literal, TypedDict

from . import providers

# ComfyUI input folder path of an uploaded reference: "flexiprint/<name>.png".
# The app's subject text for a clipart drawn only from photos (ai-dialog FROM_PHOTO): not a description.
FROM_PHOTO = "the object shown in the reference photo"

REF_NAME = re.compile(r"^flexiprint/[\w.\- ]{1,120}$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)

Recipe = Literal["origin", "refine", "adjust", "variant", "material", "mockup", "artwork_material", "mockup_enhance"]
RECIPES: tuple[str, ...] = ("origin", "refine", "adjust", "variant", "material", "mockup", "artwork_material", "mockup_enhance")

CUTOUT = {"category": "theo danh mục", "white": "white key (nhanh, miễn phí)", "birefnet": "birefnet (fal)", "keep": "giữ alpha"}
VARIANT_METHOD = ("auto", "recolor", "ai_edit_locked", "ai_edit")
LOCK = {"preset": "theo preset", "on": "khoá", "off": "không khoá"}


class RecipeError(ValueError):
    pass


class NamedLine(TypedDict):
    name: str
    text: str


class RulesOverride(TypedDict, total=False):
    canvas_w: int
    canvas_h: int
    fill: float
    anchor: Literal["center", "bottom"]


class MaterialTarget(TypedDict):
    clipart_id: str
    name: str


ApiNode = dict  # {"class_type": str, "inputs": {...}} — ComfyUI's own shape
ApiPrompt = dict[str, ApiNode]


# ---------------------------------------------------------------- validation


def _uuid(v: object, what: str) -> str:
    if not isinstance(v, str) or not UUID.match(v):
        raise RecipeError(f"{what} không hợp lệ")
    return v


def _opt_uuid(v: object, what: str) -> str | None:
    return None if v in (None, "") else _uuid(v, what)


def _text(v: object, limit: int = 4000) -> str:
    return (v if isinstance(v, str) else "").strip()[:limit]


def _model(v: object) -> str:
    return v if isinstance(v, str) and v in providers.MODELS else providers.MODELS[0]


def _int(v: object, lo: int, hi: int, fallback: int) -> int:
    try:
        return max(lo, min(hi, int(v)))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback


def _name(v: object, fallback: str) -> str:
    # FP nodes split "name: text" on the first colon, so a name never carries one.
    n = re.sub(r"[:\n\r]+", " ", _text(v, 60)).strip()
    return n or fallback


def _lines(items: object, what: str, limit: int = 60) -> list[NamedLine]:
    if not isinstance(items, list):
        raise RecipeError(f"{what}: cần danh sách")
    out: list[NamedLine] = []
    for it in items[:limit]:
        if not isinstance(it, dict):
            continue
        text = re.sub(r"[\n\r]+", " ", _text(it.get("text"), 1000))
        if not text:
            continue
        out.append({"name": _name(it.get("name"), " ".join(text.split()[:4])), "text": text})
    if not out:
        raise RecipeError(f"{what}: nhập ít nhất 1 dòng")
    return out


def _joined(lines: list[NamedLine]) -> str:
    return "\n".join(f"{l['name']}: {l['text']}" for l in lines)


def _seed() -> int:
    # A fresh seed per run: the FP nodes are cached on their inputs, so an identical
    # re-run would otherwise return (and save) nothing new.
    return random.randint(1, 2**31 - 1)


# ---------------------------------------------------------------- builder


class _Graph:
    def __init__(self) -> None:
        self.nodes: ApiPrompt = {}

    def add(self, class_type: str, inputs: dict, title: str | None = None) -> str:
        nid = str(len(self.nodes) + 1)
        node: ApiNode = {"class_type": class_type, "inputs": inputs}
        if title:
            node["_meta"] = {"title": title}
        self.nodes[nid] = node
        return nid


def _out(nid: str, index: int) -> list:
    return [nid, index]


def _material_ids(v: object) -> list[str]:
    return list(dict.fromkeys(_uuid(x, "Vật liệu") for x in (v if isinstance(v, list) else [])[:8] if x))


def _renditions(g: _Graph, images: list, masks: list, parents: list, names, context: list, materials: list[str], model: str) -> None:
    """Material versions per preset of the cliparts just saved (`parents` = FP Save's clipart_ids) — the same as
    the Vật liệu tab, chained onto the same run. FP Material hands on one name / parent / meta per image it makes
    (a preset with "version" details makes several per clipart)."""
    for material in materials:
        mat = g.add(
            "FP_Material",
            {
                "images": images,
                "material": material,
                "lock": LOCK["preset"],
                "edge_px": 0,
                "extra": "",
                "model": model,
                "seed": _seed(),
                "masks": masks,
                "context": context,
                "names": names,
                "parent_ids": parents,
            },
        )
        _save_renditions(g, mat, context, material)


def _save_renditions(g: _Graph, mat: str, context: list | None, material: str) -> None:
    g.add(
        "FP_SaveToLibrary",
        {
            "images": _out(mat, 0),
            "kind": "rendition",
            "names": _out(mat, 4),
            "parent_id": _out(mat, 5),
            "metas": _out(mat, 3),
            "tags": "",
            "prompts": "",
            "masks": _out(mat, 1),
            **({"context": context} if context else {}),
            "material": material,
        },
    )


def _origin(p: dict) -> ApiPrompt:
    g = _Graph()
    category = _uuid(p.get("category_id"), "Danh mục")
    style = _opt_uuid(p.get("style_pack_id"), "Style pack")
    ctx: list | None = None
    if style:
        ctx = _out(g.add("FP_StylePack", {"style_pack": style, "extra": ""}), 0)
    # material_id: omitted / null = the category's default material, "none" = flat, uuid = that preset.
    raw_material = p.get("material_id")
    material_extra = _text(p.get("material_extra"), 1000)
    if raw_material == "none" or raw_material or material_extra:
        if raw_material in (None, ""):
            pick = "theo danh mục"  # extra notes on top of the category's default
        elif raw_material == "none":
            pick = ""
        else:
            pick = _uuid(raw_material, "Vật liệu")
        mat_inputs: dict = {"material": pick, "extra": material_extra}
        if ctx:
            mat_inputs["context"] = ctx
        ctx = _out(g.add("FP_MaterialLook", mat_inputs), 0)
    cat_inputs: dict = {"category": category}
    if ctx:
        cat_inputs["context"] = ctx
    ctx = _out(g.add("FP_Category", cat_inputs), 0)
    note = _text(p.get("note"))
    if note:
        ctx = _out(g.add("FP_ContextNote", {"context": ctx, "note": note}), 0)
    rules: RulesOverride = p.get("rules") or {}
    if isinstance(rules, dict) and any(rules.get(k) for k in ("canvas_w", "canvas_h", "fill", "anchor")):
        fill = rules.get("fill") or 0
        ctx = _out(
            g.add(
                "FP_Rules",
                {
                    "context": ctx,
                    "canvas_w": _int(rules.get("canvas_w"), 0, 4096, 0),
                    "canvas_h": _int(rules.get("canvas_h"), 0, 4096, 0),
                    "fill": max(0.0, min(1.0, float(fill))) if isinstance(fill, (int, float)) else 0.0,
                    "anchor": rules.get("anchor") if rules.get("anchor") in ("center", "bottom") else "theo danh mục",
                },
            ),
            0,
        )
    raw = [it for it in (p.get("subjects") or [])[:40] if isinstance(it, dict) and _text(it.get("text"), 1000)] if isinstance(p.get("subjects"), list) else []
    subjects = _lines(raw, "Clipart", limit=40)
    # Photos of the object itself, per line (uploaded to ComfyUI's input folder by the app).
    line_refs = [[r for r in (it.get("refs") or [])[:4] if isinstance(r, str) and REF_NAME.match(r)] for it in raw]
    gen = g.add(
        "FP_OriginGenerate",
        {
            "context": ctx,
            "subjects": _joined(subjects),
            "model": _model(p.get("model")),
            "chain_reference": bool(p.get("chain_reference", True)),
            "seed": _seed(),
            "line_refs": json.dumps(line_refs) if any(line_refs) else "",
        },
    )
    cut = g.add(
        "FP_Cutout",
        {"images": _out(gen, 0), "method": CUTOUT.get(str(p.get("cutout")), CUTOUT["category"]), "normalize": True, "masks": _out(gen, 1), "context": ctx},
    )
    tags = ", ".join(t for t in (_text(x, 40) for x in (p.get("tags") or []) if isinstance(x, str)) if t)
    # Each clipart keeps its own description as its spec: a later refine edits it with it (what this one is).
    specs = ["" if s["text"] == FROM_PHOTO else s["text"] for s in subjects]
    save = g.add(
        "FP_SaveToLibrary",
        {
            "images": _out(cut, 0),
            "kind": "origin",
            "names": _out(gen, 2),
            "parent_id": "",
            "tags": tags,
            "prompts": _out(gen, 3),
            "masks": _out(cut, 1),
            "context": ctx,
            "specs": json.dumps(specs, ensure_ascii=False),
        },
    )
    _renditions(g, _out(cut, 0), _out(cut, 1), _out(save, 0), _out(gen, 2), ctx, _material_ids(p.get("material_ids")), _model(p.get("model")))
    return g.nodes


def _refine(p: dict) -> ApiPrompt:
    g = _Graph()
    targets = [t for t in (p.get("targets") or [])[:12] if isinstance(t, dict)] if isinstance(p.get("targets"), list) else []
    if not targets:
        raise RecipeError("Chọn ít nhất 1 clipart để sửa")
    flat = lambda v, n=2000: re.sub(r"[\n\r]+", " ", _text(v, n))  # noqa: E731
    instruction = flat(p.get("instruction"))
    if not instruction and not any(flat(t.get("edit")) for t in targets):
        raise RecipeError("Nhập yêu cầu sửa")
    refs = [r for r in (p.get("refs") or [])[:4] if isinstance(r, str) and REF_NAME.match(r)] if isinstance(p.get("refs"), list) else []
    keep = flat(p.get("keep"))
    model = _model(p.get("model"))
    cutout = CUTOUT.get(str(p.get("cutout")), CUTOUT["category"])
    # material_id: omitted / null = each clipart's category default, "none" = flat, uuid = that preset (+ material_extra).
    raw_material = p.get("material_id")
    material_extra = _text(p.get("material_extra"), 1000)
    pick_material: str | None = None
    if raw_material == "none":
        pick_material = ""
    elif raw_material:
        pick_material = _uuid(raw_material, "Vật liệu")
    elif material_extra:
        pick_material = "theo danh mục"
    # The template ("match") is edited first and shown to the rest: one helmet, one size, one gap. A clipart
    # with fixes of its own would hand those to the others too, so the first one without any leads.
    order = sorted(range(len(targets)), key=lambda i: bool(flat(targets[i].get("edit"))))
    first: str | None = None
    for i in order:
        t = targets[i]
        load = g.add("FP_LoadClipart", {"clipart": _uuid(t.get("clipart_id"), "Clipart")})
        ctx = _out(load, 3)
        if pick_material is not None:
            ctx = _out(g.add("FP_MaterialLook", {"material": pick_material, "extra": material_extra, "context": ctx}), 0)
        spec = flat(t.get("spec"), 1500)
        # A set member (variant / colour version) is saved back as a member of the same origin, not as a new origin.
        parent = _opt_uuid(t.get("parent_id"), "Clipart gốc")
        inputs: dict = {
            "image": _out(load, 0),
            "instruction": instruction,
            "model": model,
            "seed": _seed(),
            "mask": _out(load, 1),
            "context": ctx,
            "refs": json.dumps(refs) if refs else "",
            "keep": keep,
            "own": flat(t.get("edit")),
            "spec": spec,
        }
        if first and p.get("consistent", True):
            inputs["match"] = _out(first, 0)
        ref = g.add("FP_Refine", inputs)
        first = first or ref
        cut = g.add("FP_Cutout", {"images": _out(ref, 0), "method": cutout, "normalize": True, "context": _out(load, 3)})
        save = g.add(
            "FP_SaveToLibrary",
            {
                "images": _out(cut, 0),
                "kind": "set_member" if parent else "origin",
                "names": _name(t.get("name"), "clipart"),
                "parent_id": parent or "",
                "tags": "",
                "prompts": _out(ref, 1),
                "masks": _out(cut, 1),
                "context": _out(load, 3),
                "specs": json.dumps([spec], ensure_ascii=False) if spec else "",
                "derived_from": _out(load, 2),
            },
        )
        # Its material versions, made again from the edited clipart (the old ones go with the old clipart).
        _renditions(g, _out(cut, 0), _out(cut, 1), _out(save, 0), _name(t.get("name"), "clipart"), _out(load, 3), _material_ids(t.get("materials")), model)
    return g.nodes


def _adjust(p: dict) -> ApiPrompt:
    """Free fixes (FP Adjust: recolour / mirror, no AI) of cliparts, each saved back in its place like a refine.

    A target's material versions (renditions) get the same pixel fix, saved as the new clipart's
    renditions (same presets) — the old ones go with the old clipart, and no AI re-render is needed."""
    g = _Graph()
    targets = [t for t in (p.get("targets") or [])[:24] if isinstance(t, dict)] if isinstance(p.get("targets"), list) else []
    if not targets:
        raise RecipeError("Chọn ít nhất 1 clipart")
    recolor = _text(p.get("recolor"), 40)
    if recolor and not re.match(r"^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$|^[a-zA-Z ]{3,30}$", recolor):
        raise RecipeError("Màu: #rrggbb hoặc tên màu")
    flip = bool(p.get("flip"))
    if not recolor and not flip:
        raise RecipeError("Chọn màu mới hoặc lật ngang")
    for t in targets:
        load = g.add("FP_LoadClipart", {"clipart": _uuid(t.get("clipart_id"), "Clipart")})
        adj = g.add("FP_Adjust", {"image": _out(load, 0), "mask": _out(load, 1), "recolor": recolor, "flip": flip})
        parent = _opt_uuid(t.get("parent_id"), "Clipart gốc")
        spec = re.sub(r"[\n\r]+", " ", _text(t.get("spec"), 1500))
        # A recoloured member is that colour of its origin from now on (a fixed origin remakes it so).
        metas = [{"variant": {"text": recolor, "mode": "recolor"}}] if parent and recolor else []
        save = g.add(
            "FP_SaveToLibrary",
            {
                "images": _out(adj, 0),
                "kind": "set_member" if parent else "origin",
                "names": _name(t.get("name"), "clipart"),
                "parent_id": parent or "",
                "tags": "",
                "prompts": _out(adj, 2),
                "masks": _out(adj, 1),
                "context": _out(load, 3),
                "specs": json.dumps([spec], ensure_ascii=False) if spec else "",
                "derived_from": _out(load, 2),
                "metas": json.dumps(metas, ensure_ascii=False) if metas else "",
            },
        )
        # Its material versions (one per material): "renditions" [{id, name, material}], or the older single fields.
        versions = [r for r in (t.get("renditions") or [])[:8] if isinstance(r, dict)] if isinstance(t.get("renditions"), list) else []
        if not versions and t.get("rendition_id"):
            versions = [{"id": t.get("rendition_id"), "name": t.get("rendition_name"), "material": t.get("material")}]
        for v in versions:
            rload = g.add("FP_LoadClipart", {"clipart": _uuid(v.get("id"), "Bản vật liệu")})
            radj = g.add("FP_Adjust", {"image": _out(rload, 0), "mask": _out(rload, 1), "recolor": recolor, "flip": flip})
            material = _opt_uuid(v.get("material"), "Vật liệu") or ""
            g.add(
                "FP_SaveToLibrary",
                {
                    "images": _out(radj, 0),
                    "kind": "rendition",
                    "names": _name(v.get("name"), "vật liệu"),
                    "parent_id": _out(save, 0),
                    "tags": "",
                    "prompts": "",
                    "masks": _out(radj, 1),
                    "context": _out(rload, 3),
                    "material": material,
                },
            )
    return g.nodes


def _variant(p: dict) -> ApiPrompt:
    """Lines with mode "recolor" (a colour, no AI) and "ai" (AI edit, silhouette locked) run as two
    FP Variant Set nodes; lines without a mode follow `method`."""
    g = _Graph()
    # Several origins (clipart_ids) get the same lines; older callers send clipart_id only.
    ids = p.get("clipart_ids") if isinstance(p.get("clipart_ids"), list) and p.get("clipart_ids") else [p.get("clipart_id")]
    origins = list(dict.fromkeys(_uuid(i, "Clipart") for i in ids[:40]))
    raw = p.get("variants") if isinstance(p.get("variants"), list) else []
    method = p.get("method") if p.get("method") in VARIANT_METHOD else "auto"
    ai_method = "ai_edit" if p.get("lock_silhouette") is False else "ai_edit_locked"
    groups: dict[str, list] = {}
    for it in raw:
        mode = it.get("mode") if isinstance(it, dict) else None
        key = "recolor" if mode == "recolor" else ai_method if mode == "ai" else method
        groups.setdefault(key, []).append(it)
    if not groups:
        raise RecipeError("Biến thể: nhập ít nhất 1 dòng")
    model = _model(p.get("model"))
    for clipart in origins:
        _variant_lines(g, g.add("FP_LoadClipart", {"clipart": clipart}), groups, model)
    return g.nodes


def _variant_lines(g: _Graph, load: str, groups: dict[str, list], model: str) -> None:
    """One origin: an FP Variant Set + FP Save per group of lines."""
    for how, items in groups.items():
        # The same lines _lines keeps, in order: FP Variant Set returns one image per line.
        kept = [it for it in items[:60] if isinstance(it, dict) and re.sub(r"[\n\r]+", " ", _text(it.get("text"), 1000))]
        lines = _lines(items, "Biến thể")
        # How each member was made from its origin: a fixed origin remakes its members the same way.
        metas = [
            {"variant": {"text": l["text"], **({"mode": it.get("mode")} if it.get("mode") in ("recolor", "ai") else {})}}
            for l, it in zip(lines, kept)
        ]
        # A remake (the origin was fixed) names the member it replaces.
        replaces = [r if isinstance(r := it.get("replaces"), str) and UUID.match(r) else "" for it in kept]
        # AI lines: photos of the look they ask for go to the image model with the clipart.
        line_refs = [[r for r in (it.get("refs") or [])[:3] if isinstance(r, str) and REF_NAME.match(r)] for it in kept]
        var = g.add(
            "FP_VariantSet",
            {
                "origin": _out(load, 0),
                "origin_mask": _out(load, 1),
                "variants": _joined(lines),
                "method": how,
                "model": model,
                "seed": _seed(),
                "context": _out(load, 3),
                **({"line_refs": json.dumps(line_refs)} if any(line_refs) else {}),
            },
        )
        g.add(
            "FP_SaveToLibrary",
            {
                "images": _out(var, 0),
                "kind": "set_member",
                "names": _out(var, 2),
                "parent_id": _out(load, 2),
                "tags": "",
                "prompts": "",
                "masks": _out(var, 1),
                "context": _out(load, 3),
                "metas": json.dumps(metas, ensure_ascii=False),
                "derived_from": json.dumps(replaces) if any(replaces) else "",
            },
        )


def _material(p: dict) -> ApiPrompt:
    g = _Graph()
    material = _uuid(p.get("material_id"), "Vật liệu")
    targets = p.get("targets")
    if not isinstance(targets, list) or not targets:
        raise RecipeError("Chọn ít nhất 1 clipart")
    lock = LOCK.get(str(p.get("lock")), LOCK["preset"])
    edge = _int(p.get("edge_px"), 0, 60, 0)
    extra = _text(p.get("extra"))
    model = _model(p.get("model"))
    for t in targets[:40]:
        if not isinstance(t, dict):
            continue
        load = g.add("FP_LoadClipart", {"clipart": _uuid(t.get("clipart_id"), "Clipart")})
        mat = g.add(
            "FP_Material",
            {
                "images": _out(load, 0),
                "material": material,
                "lock": lock,
                "edge_px": edge,
                "extra": extra,
                "model": model,
                "seed": _seed(),
                "masks": _out(load, 1),
                "context": _out(load, 3),
                "names": _name(t.get("name"), "vật liệu"),
                "parent_ids": _out(load, 2),
            },
        )
        _save_renditions(g, mat, _out(load, 3), material)
    return g.nodes


def _mockup(p: dict) -> ApiPrompt:
    g = _Graph()
    load = g.add("FP_LoadArtwork", {"artwork": _uuid(p.get("artwork_id"), "Artwork")})
    model = _model(p.get("model"))
    image, mask = _out(load, 0), _out(load, 1)
    material = _opt_uuid(p.get("material_id"), "Vật liệu")
    if material:
        mat = g.add(
            "FP_Material",
            {
                "images": image,
                "material": material,
                "lock": LOCK["preset"],
                "edge_px": _int(p.get("edge_px"), 0, 60, 12),
                "extra": "",
                "model": model,
                "seed": _seed(),
                "masks": mask,
                "canvas": "giữ khung ảnh",
            },
        )
        image, mask = _out(mat, 0), _out(mat, 1)
    scene = g.add(
        "FP_MockupScene",
        {"image": image, "scene": _uuid(p.get("scene_id"), "Bối cảnh"), "extra": _text(p.get("extra")), "model": model, "seed": _seed(), "mask": mask},
    )
    g.add("FP_SaveMockup", {"image": _out(scene, 0), "product_id": _out(load, 2), "name": _name(p.get("name"), "AI mockup")})
    return g.nodes


def _artwork_material(p: dict) -> ApiPrompt:
    """A saved artwork (editor Tổ hợp) → its AI material version, saved on the product as the artwork's
    rendition. For designs whose custom parts reach outside the main clipart: the material then follows the
    whole outline instead of only the main's."""
    g = _Graph()
    load = g.add("FP_LoadArtwork", {"artwork": _uuid(p.get("artwork_id"), "Artwork")})
    material = _uuid(p.get("material_id"), "Vật liệu")
    mat = g.add(
        "FP_Material",
        {
            "images": _out(load, 0),
            "material": material,
            "lock": LOCK["on"],
            "edge_px": _int(p.get("edge_px"), 0, 60, 0),
            "extra": _text(p.get("extra")),
            "model": _model(p.get("model")),
            "seed": _seed(),
            "masks": _out(load, 1),
            "canvas": "giữ khung ảnh",
        },
    )
    g.add(
        "FP_SaveMockup",
        {
            "image": _out(mat, 0),
            "product_id": _out(load, 2),
            "name": _name(p.get("name"), "artwork vật liệu"),
            "parent_id": _uuid(p.get("artwork_id"), "Artwork"),
            "material": material,
        },
    )
    return g.nodes


ENHANCE_MAX_REFS = 6


def _mockup_enhance(p: dict) -> ApiPrompt:
    """Tổ hợp pictures → photoreal remakes, saved on the product as mockups. Each item is
    edited from its own picture; the other pictures of the set go along as references,
    numbered as in the editor so a prompt can say "light like #2"."""
    g = _Graph()
    product = _uuid(p.get("product_id"), "Sản phẩm")
    model = _model(p.get("model"))
    shared = _text(p.get("prompt"))
    refs: dict[int, str] = {}
    for r in (p.get("refs") or [])[:12] if isinstance(p.get("refs"), list) else []:
        if isinstance(r, dict) and isinstance(r.get("ref"), str) and REF_NAME.match(r["ref"]):
            refs[_int(r.get("number"), 1, 999, 0)] = r["ref"]
    items = [it for it in (p.get("items") or [])[:12] if isinstance(it, dict)] if isinstance(p.get("items"), list) else []
    if not items:
        raise RecipeError("Chọn ít nhất 1 tổ hợp")
    for it in items:
        ref = it.get("ref")
        if not isinstance(ref, str) or not REF_NAME.match(ref):
            raise RecipeError("Ảnh tổ hợp không hợp lệ")
        number = _int(it.get("number"), 1, 999, 1)
        others = [(n, r) for n, r in sorted(refs.items()) if n != number][: ENHANCE_MAX_REFS - 1]
        enh = g.add(
            "FP_MockupEnhance",
            {
                "refs": json.dumps([ref] + [r for _, r in others]),
                "numbers": json.dumps([number] + [n for n, _ in others]),
                "prompt": shared,
                "own": _text(it.get("prompt")),
                "model": model,
                "seed": _seed(),
            },
            title=f"Tổ hợp #{number}",
        )
        g.add("FP_SaveMockup", {"image": _out(enh, 0), "product_id": product, "name": _name(it.get("name"), f"Tổ hợp #{number} · AI")})
    return g.nodes


def build(recipe: str, params: dict) -> ApiPrompt:
    if not isinstance(params, dict):
        raise RecipeError("params phải là object")
    if recipe == "origin":
        return _origin(params)
    if recipe == "refine":
        return _refine(params)
    if recipe == "adjust":
        return _adjust(params)
    if recipe == "variant":
        return _variant(params)
    if recipe == "material":
        return _material(params)
    if recipe == "mockup":
        return _mockup(params)
    if recipe == "artwork_material":
        return _artwork_material(params)
    if recipe == "mockup_enhance":
        return _mockup_enhance(params)
    raise RecipeError(f"Recipe không hỗ trợ: {recipe}")
