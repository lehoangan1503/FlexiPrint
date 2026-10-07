"""FP_CONTEXT — the FlexiPrint context that flows along a graph.

A graph is read top-down as layers of context, each adding to the prompt the
model finally gets:

    style pack   how everything in the set is drawn        (ct_presets style_pack)
    material     what the finished clipart is made of      (ct_presets material, optional: only
                 when a graph bakes one in — origins are drawn flat and the
                 category's materials rendered afterwards, one rendition each)
    category     what kind of thing it is + its RULES       (ct_clipart_categories spec + rules)
    notes        extra context from FP Context Note nodes
    node         the node's own instruction (subject line, variant line, material…)

`compose()` builds the final prompt; every AI node shows it on the node and in
the "Ngữ cảnh" bottom panel, so an editor sees exactly what the model received.
"""

from __future__ import annotations

import copy
import re
from typing import TypedDict

UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
NONE_OPTION = "(không)"


class Style(TypedDict, total=False):
    id: str
    name: str
    prompt: str
    # Reference photos of the look (public urls): the image model gets them, not only the prompt writer.
    refs: list[str]


class Category(TypedDict):
    id: str
    name: str
    usage: str
    mode: str
    spec: str
    rules: dict


class Context(TypedDict, total=False):
    style: Style | None
    # None = not decided (the category's default material applies); False = explicitly flat.
    material: Style | None | bool
    # FP Material Look "theo danh mục" + extra text: appended to the category's default material.
    material_extra: str
    category: Category | None
    notes: list[str]
    # FP Rules: per-graph overrides of the category rules (canvas, fill, anchor).
    rules: dict


def empty() -> Context:
    return {"style": None, "material": None, "category": None, "notes": [], "rules": {}}


def extend(ctx: Context | None) -> Context:
    return copy.deepcopy(ctx) if ctx else empty()


def option_id(value: str) -> str | None:
    """Dropdown values look like 'Name · <uuid>'; the uuid is what counts."""
    m = UUID.search(value or "")
    return m.group(0) if m else None


def option_label(name: str, id_: str, prefix: str = "") -> str:
    return f"{prefix}{name} · {id_}"


def rules(ctx: Context) -> dict:
    cat = ctx.get("category")
    r = dict(cat["rules"]) if cat else {}
    r.update(ctx.get("rules") or {})
    r.setdefault("canvas", {"w": 1024, "h": 1024})
    r.setdefault("fill", 0.85)
    r.setdefault("anchor", "center")
    r.setdefault("background", "auto")
    r.setdefault("lockSilhouette", True)
    r.setdefault("shape", "alpha")
    return r


def full_bleed(ctx: Context | None) -> bool:
    """A category of fixed-shape products (rules.shape "frame": a round ornament, trousers): its cliparts are flat
    full-bleed pictures, background included — the product's khuôn vật liệu cuts the shape from them later."""
    return rules(ctx or empty()).get("shape") == "frame"


FULL_BLEED = (
    "A full-bleed flat artwork filling the whole frame edge to edge: the subject with its own background scene behind it "
    "(never a blank, white or transparent background), no outline, border, frame or cut-out shape — the product's shape is "
    "cut from it later, so keep the subject and anything important well inside, away from the edges"
)


def rules_sentence(ctx: Context, role: str, transparent: bool = False) -> str:
    """The category rules, phrased for an image model. `transparent`: the model is asked for an alpha background."""
    r = rules(ctx)
    fill = round(float(r["fill"]) * 100)
    base = "resting on the bottom edge" if r["anchor"] == "bottom" else "centred"
    # The viewing angle belongs to the category spec / style pack; the rule only asks for one shared angle.
    view = "use the viewing angle described above, the same for every clipart of the set (front view if none is given)"
    if r.get("shape") == "frame":
        return f"{FULL_BLEED}; {view}. No text, no watermark. Print quality."
    if role == "main":
        framing = f"Show the whole object, {base}, filling about {fill}% of the frame; {view}."
    else:
        framing = f"One single isolated element, {base}, filling about {fill}% of the frame; {view}; no other objects, no scenery."
    background = (
        "Transparent background (alpha) — nothing behind the object; if transparency is not possible, a flat, solid pure white (#FFFFFF) background."
        if transparent
        else "Flat, solid pure white (#FFFFFF) background."
    )
    return f"{framing} No text, no watermark, no drop shadow, no floor. {background} Crisp clean edges, print quality."


def compose(ctx: Context, instruction: str, *, role: str = "element", include_rules: bool = True, transparent: bool = False) -> str:
    parts: list[str] = []
    style = ctx.get("style")
    if style and style.get("prompt"):
        parts.append(f"Style: {style['prompt'].strip()}")
    mat = ctx.get("material")
    if isinstance(mat, dict) and mat.get("prompt"):
        # Material presets are written for FP Material (editing an existing artwork): only their
        # material / surface / edge description applies here — not "keep this artwork", view or background.
        parts.append(
            "Material / finish — draw the clipart directly as this finished physical product. Take ONLY the material, surface, "
            "highlights and edge from the following text; there is no input artwork to keep, and the viewing angle, framing and "
            f"background come from the rest of this prompt: {mat['prompt'].strip()}"
        )
    cat = ctx.get("category")
    if cat and cat.get("spec"):
        parts.append(f"Kind of object ({cat['name']}): {cat['spec'].strip()}")
    for n in ctx.get("notes") or []:
        if n.strip():
            parts.append(n.strip())
    if instruction.strip():
        parts.append(instruction.strip())
    if include_rules:
        parts.append(rules_sentence(ctx, role, transparent))
    return "\n".join(parts)


def describe(ctx: Context) -> str:
    """Human summary for the node / bottom panel."""
    lines = []
    s = ctx.get("style")
    lines.append(f"Style pack: {s['name']}" if s else "Style pack: (không)")
    m = ctx.get("material")
    lines.append(f"Vật liệu: {m['name']}" if isinstance(m, dict) else "Vật liệu: (không — clipart phẳng)")
    c = ctx.get("category")
    if c:
        r = rules(ctx)
        lines.append(
            f"Danh mục: {c['name']} — {'main' if c['usage'] == 'main' else 'element'}, "
            f"{'bộ biến thể' if c['mode'] == 'variant_set' else 'bộ gốc'}; canvas {r['canvas']['w']}×{r['canvas']['h']}, "
            f"fill {round(float(r['fill']) * 100)}%, neo {r['anchor']}, nền trong suốt nếu model trả được, không thì tách nền, "
            f"{'khoá silhouette' if r['lockSilhouette'] else 'không khoá silhouette'}"
        )
    else:
        lines.append("Danh mục: (chưa chọn)")
    for n in ctx.get("notes") or []:
        lines.append(f"Ghi chú: {n}")
    return "\n".join(lines)
