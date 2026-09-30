"""FP_CONTEXT — the FlexiPrint context that flows along a graph.

A graph is read top-down as layers of context, each adding to the prompt the
model finally gets:

    style pack   how everything in the set is drawn        (ct_presets style_pack)
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


class Style(TypedDict):
    id: str
    name: str
    prompt: str


class Category(TypedDict):
    id: str
    name: str
    usage: str
    mode: str
    spec: str
    rules: dict


class Context(TypedDict):
    style: Style | None
    category: Category | None
    notes: list[str]


def empty() -> Context:
    return {"style": None, "category": None, "notes": []}


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
    r.setdefault("canvas", {"w": 1024, "h": 1024})
    r.setdefault("fill", 0.85)
    r.setdefault("anchor", "center")
    r.setdefault("background", "cutout")
    r.setdefault("lockSilhouette", True)
    return r


def rules_sentence(ctx: Context, role: str) -> str:
    """The category rules, phrased for an image model."""
    r = rules(ctx)
    fill = round(float(r["fill"]) * 100)
    base = "resting on the bottom edge" if r["anchor"] == "bottom" else "centred"
    if role == "main":
        framing = f"Show the whole object, {base}, filling about {fill}% of the frame, straight-on front view."
    else:
        framing = f"One single isolated element, {base}, filling about {fill}% of the frame, front view, no other objects, no scenery."
    return (
        f"{framing} No text, no watermark, no drop shadow, no floor. "
        "Flat, solid pure white (#FFFFFF) background. Crisp clean edges, print quality, high detail."
    )


def compose(ctx: Context, instruction: str, *, role: str = "element", include_rules: bool = True) -> str:
    parts: list[str] = []
    style = ctx.get("style")
    if style and style.get("prompt"):
        parts.append(f"Style: {style['prompt'].strip()}")
    cat = ctx.get("category")
    if cat and cat.get("spec"):
        parts.append(f"Kind of object ({cat['name']}): {cat['spec'].strip()}")
    for n in ctx.get("notes") or []:
        if n.strip():
            parts.append(n.strip())
    if instruction.strip():
        parts.append(instruction.strip())
    if include_rules:
        parts.append(rules_sentence(ctx, role))
    return "\n".join(parts)


def describe(ctx: Context) -> str:
    """Human summary for the node / bottom panel."""
    lines = []
    s = ctx.get("style")
    lines.append(f"Style pack: {s['name']}" if s else "Style pack: (không)")
    c = ctx.get("category")
    if c:
        r = rules(ctx)
        lines.append(
            f"Danh mục: {c['name']} — {'main' if c['usage'] == 'main' else 'element'}, "
            f"{'bộ biến thể' if c['mode'] == 'variant_set' else 'bộ gốc'}; canvas {r['canvas']['w']}×{r['canvas']['h']}, "
            f"fill {round(float(r['fill']) * 100)}%, neo {r['anchor']}, nền {r['background']}, "
            f"{'khoá silhouette' if r['lockSilhouette'] else 'không khoá silhouette'}"
        )
    else:
        lines.append("Danh mục: (chưa chọn)")
    for n in ctx.get("notes") or []:
        lines.append(f"Ghi chú: {n}")
    return "\n".join(lines)
