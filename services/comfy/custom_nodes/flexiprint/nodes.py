"""FlexiPrint nodes (ComfyUI V3 API).

The graph an editor builds reads like the product:

    FP Style Pack ─┐
    FP Category ───┴─► FP Origin Generate ─► FP Cutout ─► FP Save to Library (origin)
                                                   │
    FP Load Clipart ─► FP Variant Set ─────────────┴─► FP Save to Library (set member)
                   └─► FP Material ────────────────────► FP Save to Library (rendition)
    FP Load Artwork ─► FP Material ─► FP Mockup Scene ─► FP Save Mockup
    (tổ hợp pictures) ─► FP Mockup Enhance ─► FP Save Mockup

Rules:
  - "origin" = a new original clipart (a steamer, each car model, each hobby
    icon): one line of FP Origin Generate = one origin of the category.
  - "set member" = another colour / style of ONE origin: same silhouette, same
    size (recolour, or AI edit with the origin's alpha re-applied).
  - "rendition" = the AI material version of a clipart (acrylic, glitter),
    silhouette-locked, shown on the storefront instead of the flat art.
"""

from __future__ import annotations

import json
import os

import folder_paths
import numpy as np
import torch
from comfy_api.latest import io, ui

from . import context as fpc
from . import fp_api, imaging, providers
from . import material as fpmat

FpContext = io.Custom("FP_CONTEXT")

CATEGORY_NODE = "FlexiPrint"


def _remote(kind: str) -> io.RemoteOptions:
    return io.RemoteOptions(route=f"flexi/options/{kind}", refresh_button=True, control_after_refresh="first")


def _model_input(default: str | None = None) -> io.Combo.Input:
    return io.Combo.Input("model", options=providers.MODELS, default=default or providers.MODELS[0])


def _seed_input() -> io.Int.Input:
    return io.Int.Input("seed", default=0, min=0, max=2**31 - 1, control_after_generate=True, tooltip="Đổi seed = tạo lại (API không nhận seed, chỉ để bỏ cache)")


def _preview(rgbas: list[np.ndarray], cls) -> dict:
    """Preview on a light grey so transparent areas read as background."""
    shown = []
    for x in rgbas:
        a = x[..., 3:4].astype(np.float32) / 255.0
        rgb = x[..., :3].astype(np.float32) * a + 236.0 * (1 - a)
        shown.append(torch.from_numpy(rgb / 255.0))
    h = max(s.shape[0] for s in shown)
    w = max(s.shape[1] for s in shown)
    shown = [s if s.shape[0] == h and s.shape[1] == w else torch.nn.functional.pad(s.permute(2, 0, 1), (0, w - s.shape[1], 0, h - s.shape[0]), value=0.92).permute(1, 2, 0) for s in shown]
    return ui.PreviewImage(torch.stack(shown), cls=cls).as_dict()


def _ui(cls, rgbas: list[np.ndarray] | None = None, text: str = "") -> dict:
    out = _preview(rgbas, cls) if rgbas else {}
    if text:
        out["text"] = [text]
    return out


async def _style(style_id: str | None) -> fpc.Style | None:
    if not style_id:
        return None
    for p in await fp_api.presets("style_pack"):
        if p["id"] == style_id:
            refs = [str(u) for u in ((p.get("params") or {}).get("refs") or []) if isinstance(u, str)]
            return {"id": p["id"], "name": p["name"], "prompt": p["prompt"], "refs": refs}
    return None


_REF_CACHE: dict[str, bytes] = {}


async def _context_refs(ctx: fpc.Context | None, limit: int = 4) -> list[bytes]:
    """The look references a context carries — its category's and its style pack's saved photos — as PNGs for
    the image model (the lesson of the material work: the model must SEE the references, a prompt written from
    them is not enough). The category's come first: they show THIS set (angle, proportions, parts) while a style
    pack is shared, so its photos may show another category's objects — they only fill the places left.
    Downloaded once per process."""
    style = (ctx or {}).get("style") or {}
    cat = (ctx or {}).get("category") or {}
    urls = [*((cat.get("rules") or {}).get("refs") or []), *(style.get("refs") or [])]
    out: list[bytes] = []
    for url in dict.fromkeys(u for u in urls if isinstance(u, str)):
        if len(out) >= limit:
            break
        if url not in _REF_CACHE:
            try:
                _REF_CACHE[url] = _ref_png(await fp_api.download(url))
            except Exception as e:  # a missing photo must not block a run
                print(f"[FlexiPrint] ảnh mẫu lỗi {url}: {e}")
                continue
        out.append(_REF_CACHE[url])
    return out


async def _category(category_id: str | None) -> fpc.Category | None:
    if not category_id:
        return None
    for c in await fp_api.categories():
        if c["id"] == category_id:
            return {"id": c["id"], "name": c["name"], "usage": c["usage"], "mode": c["mode"], "spec": c.get("spec", ""), "rules": c.get("rules", {})}
    raise fp_api.FlexiPrintError("Danh mục không còn tồn tại — bấm refresh")


async def _preset(kind: str, preset_id: str | None) -> dict | None:
    if not preset_id:
        return None
    for p in await fp_api.presets(kind):
        if p["id"] == preset_id:
            return p
    raise fp_api.FlexiPrintError(f"Preset {kind} không còn tồn tại — bấm refresh")


async def _db_fingerprint(*kinds: str) -> str:
    """The library rows a node reads, serialized: ComfyUI re-runs the node (and
    everything after it) as soon as a category / preset is edited, instead of
    serving its cached output with the old spec / style."""
    rows = [await (fp_api.categories() if k == "categories" else fp_api.presets(k)) for k in kinds]
    return json.dumps(rows, sort_keys=True, ensure_ascii=False)


def _lines(text: str) -> list[str]:
    return [l.strip() for l in (text or "").splitlines() if l.strip() and not l.strip().startswith("#")]


def _split_named(line: str) -> tuple[str, str]:
    """'green: mint green body' → ('green', 'mint green body'); a bare line is both."""
    if ":" in line:
        name, _, rest = line.partition(":")
        return name.strip(), rest.strip() or name.strip()
    return line[:60], line


def _input_images(names: list, limit: int = 4) -> list[bytes]:
    """Images from ComfyUI's input folder ("flexiprint/<name>.png", uploaded by the app), as PNG on white."""
    root = os.path.realpath(folder_paths.get_input_directory())
    out: list[bytes] = []
    for name in names[:limit]:
        path = os.path.realpath(os.path.join(root, str(name)))
        if not path.startswith(root + os.sep) or not os.path.isfile(path):
            raise ValueError(f"Ảnh tham chiếu không tồn tại: {name}")
        with open(path, "rb") as f:
            out.append(imaging.rgba_on_white_png(imaging.bytes_to_rgba(f.read())))
    return out


def _line_refs(raw: str, count: int) -> list[list[bytes]]:
    """line_refs JSON ([["flexiprint/a.png"], [], …]) → per subject line, the images from ComfyUI's input folder."""
    out: list[list[bytes]] = [[] for _ in range(count)]
    try:
        items = json.loads(raw) if (raw or "").strip() else []
    except json.JSONDecodeError as e:
        raise ValueError("line_refs không phải JSON") from e
    for i, names in enumerate(items[:count] if isinstance(items, list) else []):
        out[i] = _input_images(names if isinstance(names, list) else [])
    return out


def _to_png(x: np.ndarray) -> bytes:
    return imaging.rgba_to_png(x)


# =====================================================================
# Context
# =====================================================================


class FPStylePack(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="FP_StylePack",
            display_name="FP Style Pack",
            category=f"{CATEGORY_NODE}/Ngữ cảnh",
            description="Cách vẽ chung của cả bộ clipart (ct_presets style_pack). Ghép đầu tiên vào prompt.",
            inputs=[
                io.Combo.Input("style_pack", options=[], remote=_remote("style_pack")),
                io.String.Input("extra", multiline=True, default="", tooltip="Bổ sung / ghi đè style cho graph này"),
                FpContext.Input("context", optional=True),
            ],
            outputs=[FpContext.Output(display_name="context")],
        )

    @classmethod
    def validate_inputs(cls, **kwargs) -> bool:
        return True

    @classmethod
    async def fingerprint_inputs(cls, **kwargs) -> str:
        return await _db_fingerprint("style_pack")

    @classmethod
    async def execute(cls, style_pack: str, extra: str = "", context: fpc.Context | None = None) -> io.NodeOutput:
        ctx = fpc.extend(context)
        style = await _style(fpc.option_id(style_pack))
        if extra.strip():
            style = {"id": style["id"] if style else "", "name": (style["name"] if style else "custom"), "prompt": ((style["prompt"] + "\n") if style else "") + extra.strip()}
        ctx["style"] = style
        return io.NodeOutput(ctx, ui=_ui(cls, text=fpc.describe(ctx)))


FOLLOW_CATEGORY = "theo danh mục"


async def _material(material_id: str | None) -> fpc.Style | None:
    if not material_id:
        return None
    for p in await fp_api.presets("material"):
        if p["id"] == material_id:
            return {"id": p["id"], "name": p["name"], "prompt": p["prompt"]}
    return None


class FPMaterialLook(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="FP_MaterialLook",
            display_name="FP Material Look (vật liệu ngay khi tạo)",
            category=f"{CATEGORY_NODE}/Ngữ cảnh",
            description=(
                "Vật liệu (acrylic, glitter, gỗ…) ghép thẳng vào prompt tạo clipart — 1 lượt AI ra clipart hoàn thiện, khỏi chạy FP Material sau. "
                "'(không)' = clipart phẳng, bỏ cả vật liệu mặc định của danh mục."
            ),
            inputs=[
                io.Combo.Input("material", options=[], remote=_remote("material")),
                io.String.Input("extra", multiline=True, default="", tooltip="Bổ sung / chỉnh vật liệu cho lượt này"),
                FpContext.Input("context", optional=True),
            ],
            outputs=[FpContext.Output(display_name="context")],
        )

    @classmethod
    def validate_inputs(cls, **kwargs) -> bool:
        return True

    @classmethod
    async def fingerprint_inputs(cls, **kwargs) -> str:
        return await _db_fingerprint("material")

    @classmethod
    async def execute(cls, material: str, extra: str = "", context: fpc.Context | None = None) -> io.NodeOutput:
        ctx = fpc.extend(context)
        if material == FOLLOW_CATEGORY:
            # FP Category resolves the default material and appends the extra to it.
            ctx["material_extra"] = extra.strip()
            return io.NodeOutput(ctx, ui=_ui(cls, text=f"Vật liệu: theo danh mục{' + ' + extra.strip() if extra.strip() else ''}"))
        mat = await _material(fpc.option_id(material))
        if extra.strip():
            mat = {"id": mat["id"] if mat else "", "name": mat["name"] if mat else "custom", "prompt": ((mat["prompt"] + "\n") if mat else "") + extra.strip()}
        ctx["material"] = mat if mat else False
        return io.NodeOutput(ctx, ui=_ui(cls, text=fpc.describe(ctx)))


class FPCategory(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="FP_Category",
            display_name="FP Category",
            category=f"{CATEGORY_NODE}/Ngữ cảnh",
            description="Danh mục clipart: spec chung + rule (canvas, fill, neo, nền, khoá silhouette). Quyết định clipart lưu vào đâu và dùng làm main hay element.",
            inputs=[
                io.Combo.Input("category", options=[], remote=_remote("categories")),
                FpContext.Input("context", optional=True),
            ],
            outputs=[FpContext.Output(display_name="context")],
        )

    @classmethod
    def validate_inputs(cls, **kwargs) -> bool:
        return True

    @classmethod
    async def fingerprint_inputs(cls, **kwargs) -> str:
        return await _db_fingerprint("categories", "style_pack", "material")

    @classmethod
    async def execute(cls, category: str, context: fpc.Context | None = None) -> io.NodeOutput:
        ctx = fpc.extend(context)
        ctx["category"] = await _category(fpc.option_id(category))
        # The category's default style pack applies unless the graph set one.
        if ctx["category"] and not ctx.get("style"):
            ctx["style"] = await _style(ctx["category"]["rules"].get("stylePackId"))
        # Origins are drawn flat: the category's materials are rendered afterwards (FP Material, one rendition
        # each — recipes.py). Only "theo danh mục" + extra notes from FP Material Look still bake a look in.
        if ctx["category"] and ctx.get("material") is None:
            extra = (ctx.get("material_extra") or "").strip()
            ctx["material"] = {"id": "", "name": "custom", "prompt": extra} if extra else None
        return io.NodeOutput(ctx, ui=_ui(cls, text=fpc.describe(ctx)))


class FPContextNote(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="FP_ContextNote",
            display_name="FP Context Note",
            category=f"{CATEGORY_NODE}/Ngữ cảnh",
            description="Thêm 1 đoạn ngữ cảnh (dịp lễ, đối tượng khách, chất liệu…) vào mọi prompt phía sau.",
            inputs=[FpContext.Input("context"), io.String.Input("note", multiline=True, default="")],
            outputs=[FpContext.Output(display_name="context")],
        )

    @classmethod
    def execute(cls, context: fpc.Context, note: str) -> io.NodeOutput:
        ctx = fpc.extend(context)
        if note.strip():
            ctx["notes"].append(note.strip())
        return io.NodeOutput(ctx, ui=_ui(cls, text=fpc.describe(ctx)))


class FPRules(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="FP_Rules",
            display_name="FP Rules (ghi đè rule)",
            category=f"{CATEGORY_NODE}/Ngữ cảnh",
            description="Ghi đè rule của danh mục cho graph này: canvas, fill, neo. 0 / 'theo danh mục' = giữ rule danh mục.",
            inputs=[
                FpContext.Input("context"),
                io.Int.Input("canvas_w", default=0, min=0, max=4096, tooltip="0 = theo danh mục"),
                io.Int.Input("canvas_h", default=0, min=0, max=4096, tooltip="0 = theo danh mục"),
                io.Float.Input("fill", default=0.0, min=0.0, max=1.0, step=0.01, tooltip="0 = theo danh mục"),
                io.Combo.Input("anchor", options=["theo danh mục", "center", "bottom"], default="theo danh mục"),
            ],
            outputs=[FpContext.Output(display_name="context")],
        )

    @classmethod
    def execute(cls, context: fpc.Context, canvas_w: int, canvas_h: int, fill: float, anchor: str) -> io.NodeOutput:
        ctx = fpc.extend(context)
        over = dict(ctx.get("rules") or {})
        base = fpc.rules(ctx)["canvas"]
        if canvas_w or canvas_h:
            over["canvas"] = {"w": canvas_w or int(base["w"]), "h": canvas_h or int(base["h"])}
        if fill > 0:
            over["fill"] = fill
        if anchor in ("center", "bottom"):
            over["anchor"] = anchor
        ctx["rules"] = over
        return io.NodeOutput(ctx, ui=_ui(cls, text=fpc.describe(ctx)))


# =====================================================================
# Generate
# =====================================================================


class FPOriginGenerate(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="FP_OriginGenerate",
            display_name="FP Origin Generate (clipart gốc)",
            category=f"{CATEGORY_NODE}/Tạo",
            description="Mỗi dòng = 1 clipart GỐC cùng chủng loại (vd. 6 mẫu xe, 40 món hobby). 'name: mô tả' để đặt tên. Nối chuỗi tham chiếu giúp cả bộ cùng góc nhìn / tỉ lệ / nét.",
            inputs=[
                FpContext.Input("context"),
                io.String.Input("subjects", multiline=True, default="steamer: an open bamboo dumpling steamer with its lid tilted open"),
                _model_input(),
                io.Boolean.Input("chain_reference", default=True, tooltip="Dùng clipart đầu tiên làm tham chiếu cho các dòng sau (đồng bộ bộ)"),
                _seed_input(),
                io.Image.Input("reference", optional=True, tooltip="Ảnh tham chiếu style / góc nhìn"),
                io.String.Input(
                    "line_refs",
                    default="",
                    optional=True,
                    tooltip="JSON: mỗi dòng subject 1 danh sách ảnh trong thư mục input (ảnh chụp đúng vật cần vẽ). App's AI dialog điền.",
                ),
            ],
            outputs=[
                io.Image.Output(display_name="images"),
                io.Mask.Output(display_name="masks"),
                io.String.Output(display_name="names"),
                io.String.Output(display_name="prompts"),
            ],
        )

    @classmethod
    async def execute(cls, context, subjects: str, model: str, chain_reference: bool, seed: int, reference=None, line_refs: str = "") -> io.NodeOutput:
        lines = _lines(subjects)
        if not lines:
            raise ValueError("Nhập ít nhất 1 dòng subject")
        role = "main" if (context.get("category") or {}).get("usage") == "main" else "element"
        refs: list[bytes] = []
        if reference is not None:
            refs = [imaging.rgba_on_white_png(x) for x in imaging.tensors_to_rgba(reference[:2], None)]
        # The style pack's / category's saved photos: the look of the set, seen by the model.
        refs += await _context_refs(context, limit=max(0, 4 - len(refs)))
        objects = _line_refs(line_refs, len(lines))
        names, prompts, outs = [], [], []
        # Background rule: a transparent PNG straight from the model when it can make one (FP Cutout keeps it),
        # otherwise white and cut out with BiRefNet.
        # A full-bleed category (fixed-shape product) keeps its background: never transparent, never cut out.
        transparent = providers.supports_transparency(model) and not fpc.full_bleed(context)

        async def one(i: int, style_refs: list[bytes]) -> tuple[str, str, np.ndarray]:
            name, subject = _split_named(lines[i])
            obj = objects[i]
            instruction = f"Subject: {subject}."
            if obj:
                n = "The first image shows" if len(obj) == 1 else f"The first {len(obj)} images show"
                instruction += (
                    f" {n} WHICH object to draw — a content reference only. Keep what makes it recognisable "
                    "(type, model, colour scheme, livery, signature parts). Do NOT copy the photo's camera angle, perspective, "
                    "proportions, realism, lighting or background: redraw it from scratch as the kind of object and in the style "
                    "described above, from the set's viewing angle."
                )
            if style_refs:
                instruction += (
                    f" {'The remaining' if obj else 'The'} reference image(s) show the look of the set: "
                    "match their drawing style, line weight, viewing angle, lighting and scale (not their subject)."
                )
            prompt = fpc.compose(context, instruction, role=role, transparent=transparent)
            data, used = await providers.run(model, prompt, [*obj, *style_refs], transparent=transparent)
            return name, f"[{used}]\n{prompt}", imaging.bytes_to_rgba(data)

        if chain_reference and len(lines) > 1:
            first = await one(0, refs)
            chained = refs + [imaging.rgba_on_white_png(first[2])]
            rest = await providers.gather_limited([one(i, chained) for i in range(1, len(lines))])
            results = [first, *rest]
        else:
            results = await providers.gather_limited([one(i, refs) for i in range(len(lines))])
        for name, prompt, rgba in results:
            names.append(name)
            prompts.append(prompt)
            outs.append(rgba)
        image, mask = imaging.rgba_to_tensors(outs)
        return io.NodeOutput(image, mask, json.dumps(names, ensure_ascii=False), json.dumps(prompts, ensure_ascii=False), ui=_ui(cls, outs, prompts[0]))


class FPRefine(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="FP_Refine",
            display_name="FP Refine (sửa clipart đã tạo)",
            category=f"{CATEGORY_NODE}/Tạo",
            description=(
                "Sửa 1 clipart đã tạo theo yêu cầu: chỉ đổi đúng phần được nêu, giữ nguyên mọi thứ khác (style, màu, góc nhìn, tỉ lệ). "
                "Ảnh tham chiếu (tuỳ chọn) chỉ dùng cho phần cần đổi, vd. kiểu mũ bảo hiểm."
            ),
            inputs=[
                io.Image.Input("image"),
                io.String.Input("instruction", multiline=True, default="Make the helmet twice as big."),
                _model_input(),
                _seed_input(),
                io.Mask.Input("mask", optional=True),
                FpContext.Input("context", optional=True),
                io.String.Input("refs", default="", optional=True, tooltip="JSON list ảnh trong thư mục input (vd. ảnh mũ bảo hiểm mẫu). App's AI dialog điền."),
                io.String.Input("keep", multiline=True, default="", optional=True, tooltip="Những gì phải giữ y hệt (AI phân tích liệt kê — mọi thứ yêu cầu sửa không nhắc tới)."),
                io.Image.Input("match", optional=True, tooltip="Clipart đầu tiên của lượt đã sửa xong: phần được sửa phải giống hệt (cùng kiểu, cỡ, hướng) — cả bộ đồng nhất."),
                io.String.Input("own", multiline=True, default="", optional=True, tooltip="Sửa RIÊNG cho clipart này (ngoài lệnh chung cho cả bộ)."),
                io.String.Input("spec", multiline=True, default="", optional=True, tooltip="Mô tả riêng của clipart này (model, màu, chi tiết nhận diện) — phải giữ."),
            ],
            outputs=[io.Image.Output(display_name="image"), io.String.Output(display_name="prompt")],
        )

    @classmethod
    async def execute(
        cls, image, instruction: str, model: str, seed: int, mask=None, context=None, refs: str = "", keep: str = "", match=None, own: str = "", spec: str = ""
    ) -> io.NodeOutput:
        if not instruction.strip() and not own.strip():
            raise ValueError("Nhập yêu cầu sửa")
        src = imaging.tensors_to_rgba(image[:1], mask[:1] if mask is not None else None)[0]
        extra = _input_images(json.loads(refs) if refs.strip() else [])
        n = len(extra)
        done = [imaging.rgba_on_white_png(x) for x in imaging.tensors_to_rgba(match[:1], None)] if match is not None else []
        # A set is edited clipart by clipart, so the SAME words go to every one: the shared change is a target
        # state (what every clipart ends up with — one already there just keeps it), the clipart's own fixes
        # come apart from it, and the category spec rides along as the set's rules, so each edit lands on the
        # same rule instead of the model's own reading of the change.
        ctx = context or fpc.empty()
        set_rules = str((ctx.get("category") or {}).get("spec") or "").strip()
        style = ctx.get("style")
        style_text = str(style.get("prompt") or "").strip() if isinstance(style, dict) else ""
        # A material picked for this edit (FP Material Look); otherwise the clipart stays flat — its material
        # versions are rendered again from the edited clipart (recipes.py refine).
        mat = ctx.get("material")
        if mat is None:
            extra_mat = str(ctx.get("material_extra") or "").strip()
            mat = {"id": "", "name": "custom", "prompt": extra_mat} if extra_mat else None
        mat_text = str(mat.get("prompt") or "").strip() if isinstance(mat, dict) else ""
        notes = [x for x in ((context or {}).get("notes") or []) if isinstance(x, str) and not x.startswith("This clipart:")]
        this = spec.strip() or next((x[len("This clipart:") :].strip() for x in ((context or {}).get("notes") or []) if isinstance(x, str) and x.startswith("This clipart:")), "")
        prompt = (
            "Edit the FIRST image — one clipart of a consistent set — and output the edited clipart.\n"
            + (
                f"REQUIRED CHANGES for every clipart of the set (the end state this image must have — must be clearly visible, do not be subtle; "
                f"where this image already matches, keep that part exactly): {instruction.strip()}\n"
                if instruction.strip()
                else ""
            )
            + (f"REQUIRED CHANGES for THIS clipart only: {own.strip()}\n" if own.strip() else "")
            + (
                f"Images 2–{n + 1} are the reference for the changed part: copy its shape, design, proportions, spacing and its size relative to the object "
                "exactly, redrawn in the first image's drawing style. Ignore their background, lighting, decorations and photo look. "
                "A reference may be another clipart of this same set that is already right: take ONLY the changed part from it "
                "(its exact design, size relative to the object, spacing and placement) — never its vehicle, colours, livery or other details.\n"
                if n
                else ""
            )
            + (
                f"Image {n + 2} is another clipart of this same set, already edited with exactly these changes: the changed parts must "
                "match it exactly — same design, same size relative to the object, same spacing, orientation and placement — so the whole set is consistent. "
                "Take nothing else from it (not its vehicle, colours or details).\n"
                if done
                else ""
            )
            + (f"SET RULES (every clipart of the set follows them; after the edit this image must match them): {set_rules}\n" if set_rules else "")
            + (f"DRAWING STYLE of the set (keep it; anything redrawn follows it): {style_text}\n" if style_text else "")
            + (
                "MATERIAL / FINISH — the clipart is this finished physical product (keep it, or apply it where the image does not show it yet; "
                f"only the material, surface, highlights and edge — never the framing or background): {mat_text}\n"
                if mat_text
                else ""
            )
            + "".join(f"Set note: {x}\n" for x in notes)
            + (f"THIS CLIPART (its own identity, keep it): {this}\n" if this else "")
            + (
                f"MUST STAY EXACTLY THE SAME (not part of the changes): {keep.strip()}\n"
                if keep.strip()
                else "Everything the changes don't touch stays as it is: the object's identity, colours, drawing style, line work, face and viewing angle.\n"
            )
            + (
                "Same full-bleed framing as image 1: the artwork fills the whole frame edge to edge with its background scene. No text, no watermark."
                if fpc.full_bleed(ctx)
                else "Whole object visible, centred. Flat, solid pure white (#FFFFFF) background — any gap or opening the changes call for is that same pure white. "
                "No text, no watermark, no drop shadow."
            )
        )
        data, used = await providers.edit(model, prompt, imaging.rgba_on_white_png(src), [*extra, *done])
        out = imaging.bytes_to_rgba(data)
        img, _ = imaging.rgba_to_tensors([out])
        full = f"[{used}]\n{prompt}"
        return io.NodeOutput(img, json.dumps([full], ensure_ascii=False), ui=_ui(cls, [out], full))


class FPCutout(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="FP_Cutout",
            display_name="FP Cutout + Normalize",
            category=f"{CATEGORY_NODE}/Xử lý",
            description="Tách nền rồi chuẩn hoá theo rule danh mục: cắt sát, co vào fill% của canvas, neo giữa/đáy — cả bộ cùng kích thước, thay nhau được trong 1 vùng.",
            inputs=[
                io.Image.Input("images"),
                io.Combo.Input(
                    "method",
                    options=["theo danh mục", "white key (nhanh, miễn phí)", "birefnet (fal)", "giữ alpha"],
                    default="theo danh mục",
                    tooltip="theo danh mục: giữ alpha khi model trả nền trong suốt, còn lại tách nền birefnet",
                ),
                io.Boolean.Input("normalize", default=True),
                io.Mask.Input("masks", optional=True),
                FpContext.Input("context", optional=True),
            ],
            outputs=[io.Image.Output(display_name="images"), io.Mask.Output(display_name="masks")],
        )

    @classmethod
    async def execute(cls, images, method: str, normalize: bool, masks=None, context=None) -> io.NodeOutput:
        if method == "theo danh mục" and fpc.full_bleed(context):
            # Fixed-shape product: the picture is full-bleed (background included) — cover the canvas, no cut-out.
            r = fpc.rules(context)
            w, h = int(r["canvas"]["w"]), int(r["canvas"]["h"])
            rgbas = [_cover(x, w, h) for x in imaging.tensors_to_rgba(images, None)]
            image, mask = imaging.rgba_to_tensors(rgbas)
            return io.NodeOutput(image, mask, ui=_ui(cls, rgbas))
        if method == "theo danh mục":
            # Every category: the model's own transparency when it gave one, else BiRefNet — per image.
            rgbas = imaging.tensors_to_rgba(images, masks)
            todo = [i for i, x in enumerate(rgbas) if not imaging.has_transparency(x)]
            cut = await providers.gather_limited([providers.cutout(imaging.rgba_on_white_png(rgbas[i])) for i in todo])
            for i, c in zip(todo, cut):
                rgbas[i] = imaging.bytes_to_rgba(c)
        else:
            rgbas = imaging.tensors_to_rgba(images, masks if method.startswith("giữ") else None)
        if method.startswith("birefnet"):
            cut = await providers.gather_limited([providers.cutout(imaging.rgba_on_white_png(x)) for x in rgbas])
            rgbas = [imaging.bytes_to_rgba(c) for c in cut]
        elif method.startswith("white"):
            rgbas = [imaging.white_key(x) for x in rgbas]
        if normalize:
            r = fpc.rules(context or fpc.empty())
            rgbas = [imaging.normalize(x, int(r["canvas"]["w"]), int(r["canvas"]["h"]), float(r["fill"]), r["anchor"]) for x in rgbas]
        image, mask = imaging.rgba_to_tensors(rgbas)
        return io.NodeOutput(image, mask, ui=_ui(cls, rgbas))


class FPVariantSet(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="FP_VariantSet",
            display_name="FP Variant Set (bộ biến thể)",
            category=f"{CATEGORY_NODE}/Tạo",
            description=(
                "1 clipart gốc → nhiều màu / style, GIỮ NGUYÊN silhouette + kích thước. Mỗi dòng 'tên: thay đổi' (vd. 'green: #8fd9a8' hoặc "
                "'rainbow: rainbow holographic glitter body'). recolor = đổi màu tất định (miễn phí, chuẩn 100%); ai_edit_locked = AI sửa rồi ép lại alpha gốc."
            ),
            inputs=[
                io.Image.Input("origin"),
                io.Mask.Input("origin_mask"),
                io.String.Input("variants", multiline=True, default="pink: #f7a8d8\nmint: #8fd9b8\nsky: #8cc8f2\nrainbow: rainbow holographic glitter body"),
                io.Combo.Input("method", options=["auto", "recolor", "ai_edit_locked", "ai_edit"], default="auto", tooltip="auto: có mã màu/tên màu → recolor, còn lại → ai_edit_locked"),
                _model_input(),
                _seed_input(),
                FpContext.Input("context", optional=True),
                io.String.Input(
                    "line_refs",
                    default="",
                    optional=True,
                    tooltip="JSON: mỗi dòng biến thể 1 danh sách ảnh trong thư mục input (ảnh mẫu kiểu muốn có — glitter, hoạ tiết…). App's AI dialog điền.",
                ),
            ],
            outputs=[
                io.Image.Output(display_name="images"),
                io.Mask.Output(display_name="masks"),
                io.String.Output(display_name="names"),
                io.String.Output(display_name="report"),
            ],
        )

    @classmethod
    async def execute(cls, origin, origin_mask, variants: str, method: str, model: str, seed: int, context=None, line_refs: str = "") -> io.NodeOutput:
        src = imaging.tensors_to_rgba(origin[:1], origin_mask[:1])[0]
        ctx = context or fpc.empty()
        lines = _lines(variants)
        if not lines:
            raise ValueError("Nhập ít nhất 1 dòng biến thể")
        src_png = imaging.rgba_on_white_png(src)
        pics = _line_refs(line_refs, len(lines))

        async def one(i: int, line: str) -> tuple[str, np.ndarray, str]:
            name, change = _split_named(line)
            color = imaging.parse_color(change)
            how = method
            if how == "auto":
                how = "recolor" if color and len(change.split()) <= 3 else "ai_edit_locked"
            if how == "recolor":
                if not color:
                    raise ValueError(f"'{line}': recolor cần mã màu (#rrggbb) hoặc tên màu CSS")
                return name, imaging.recolor(src, color), f"{name}: recolor {change}"
            instruction = (
                "The FIRST image is the exact clipart to change. Keep EXACTLY the same silhouette, outline, size, position, face, "
                f"line work, shading style and framing — it must replace the original pixel-for-pixel. Change only: {change}."
            )
            if pics[i]:
                instruction += (
                    " The other image(s) show the look this change should have (material, pattern, colour, finish): copy only that look "
                    "onto the clipart — never their shape, subject, background or scene."
                )
            prompt = fpc.compose(ctx, instruction, role="element", include_rules=False) + (
                "\nSame full-bleed background scene, edge to edge, as the first image." if fpc.full_bleed(ctx) else "\nPure white (#FFFFFF) background."
            )
            # A locked edit must keep the clipart where it is: align_to + lock_silhouette pull any model's result back.
            use = fpmat.nano_model(model) if how == "ai_edit_locked" else model
            data, used = await providers.edit(use, prompt, src_png, pics[i])
            aligned = imaging.align_to(src, imaging.bytes_to_rgba(data))
            score = imaging.iou(src[..., 3], aligned[..., 3])
            result = imaging.lock_silhouette(aligned, src[..., 3]) if how == "ai_edit_locked" else aligned
            return name, result, f"{name}: {how} [{used}], silhouette IoU {score:.3f}"

        results = await providers.gather_limited([one(i, l) for i, l in enumerate(lines)])
        names = [r[0] for r in results]
        outs = [r[1] for r in results]
        report = "\n".join(r[2] for r in results)
        image, mask = imaging.rgba_to_tensors(outs)
        return io.NodeOutput(image, mask, json.dumps(names, ensure_ascii=False), report, ui=_ui(cls, outs, report))


class FPAdjust(io.ComfyNode):
    """Free edits — pixels only, no AI: recolour the body colour, mirror. What the app's "Sửa nhanh · miễn phí" runs."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="FP_Adjust",
            display_name="FP Adjust (đổi màu / lật — miễn phí)",
            category=f"{CATEGORY_NODE}/Xử lý",
            description="Sửa không cần AI: đổi màu thân (recolor từng pixel, giữ nét / đổ bóng / silhouette 100%), lật ngang. Đổi góc nhìn, tư thế, chi tiết → cần AI (FP Refine).",
            inputs=[
                io.Image.Input("image"),
                io.Mask.Input("mask", optional=True),
                io.String.Input("recolor", default="", tooltip="#rrggbb hoặc tên màu CSS; trống = giữ màu"),
                io.Boolean.Input("flip", default=False, tooltip="Lật ngang (gương)"),
            ],
            outputs=[io.Image.Output(display_name="image"), io.Mask.Output(display_name="mask"), io.String.Output(display_name="report")],
        )

    @classmethod
    async def execute(cls, image, recolor: str = "", flip: bool = False, mask=None) -> io.NodeOutput:
        rgba = imaging.tensors_to_rgba(image[:1], mask[:1] if mask is not None else None)[0]
        done: list[str] = []
        if recolor.strip():
            color = imaging.parse_color(recolor)
            if not color:
                raise ValueError(f"'{recolor}': cần mã màu (#rrggbb) hoặc tên màu CSS")
            rgba = imaging.recolor(rgba, color)
            done.append(f"recolor {recolor.strip()}")
        if flip:
            rgba = np.ascontiguousarray(rgba[:, ::-1])
            done.append("lật ngang")
        if not done:
            raise ValueError("Chọn màu mới hoặc lật ngang")
        img, msk = imaging.rgba_to_tensors([rgba])
        report = "FP Adjust (miễn phí, không AI): " + ", ".join(done)
        return io.NodeOutput(img, msk, report, ui=_ui(cls, [rgba], report))


class FPMaterial(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="FP_Material",
            display_name="FP Material (vật liệu AI)",
            category=f"{CATEGORY_NODE}/Tạo",
            description=(
                "Render clipart hoặc artwork đã ghép thành vật liệu thật (acrylic, glitter, gỗ…) theo preset: "
                "nano-banana vẽ trên nền đen → đổi nền trắng → tách độ trong thật; hình in giữ nguyên pixel gốc, vật liệu / lỗ / dây "
                "nằm quanh hình trên canvas nới rộng; mỗi đặc tả “tạo thêm phiên bản” ra 1 bản nữa cùng vị trí. Bóng ma / lệch → tự vẽ lại. "
                "Preset chưa có “Hình in” chạy như “giữ hình in”; lock / edge_px không còn dùng."
            ),
            inputs=[
                io.Image.Input("images"),
                io.Combo.Input("material", options=[], remote=_remote("material")),
                io.Combo.Input("lock", options=["theo preset", "khoá", "không khoá"], default="theo preset"),
                io.Int.Input("edge_px", default=0, min=0, max=60, tooltip="Nở alpha thêm N px (viền acrylic trong suốt quanh hình)"),
                io.String.Input("extra", multiline=True, default=""),
                _model_input(),
                _seed_input(),
                io.Mask.Input("masks", optional=True),
                FpContext.Input("context", optional=True),
                io.String.Input("names", default="", optional=True, tooltip="Tên từng ảnh (JSON list / mỗi dòng 1 tên) — mỗi phiên bản thêm “ · <tên bản>”"),
                io.String.Input("parent_ids", default="", optional=True, tooltip="Id clipart của từng ảnh (JSON list) — nhân theo số phiên bản, nối vào FP Save to Library"),
                io.String.Input(
                    "draft",
                    default="",
                    optional=True,
                    tooltip="Chạy thử prompt chưa lưu (JSON {material_prompt?, details?, product_refs?}) — thay prompt preset / chi tiết / ảnh thành phẩm của danh mục; ảnh lưu tên “· thử”",
                ),
                io.String.Input(
                    "frame",
                    default="",
                    optional=True,
                    tooltip="Vật liệu theo khuôn (JSON {productId, regionId, box}): ảnh vào đã cắt theo khuôn (FP Frame Clipart) — giữ y nguyên viền + lỗ; ghi vào meta.frame",
                ),
                io.Combo.Input(
                    "canvas",
                    options=["nới rộng (vật liệu quanh hình)", "giữ khung ảnh"],
                    default="nới rộng (vật liệu quanh hình)",
                    optional=True,
                    tooltip="Preset mới: giữ khung ảnh = cắt phần nới đi (artwork tổ hợp cho mockup)",
                ),
            ],
            outputs=[
                io.Image.Output(display_name="images"),
                io.Mask.Output(display_name="masks"),
                io.String.Output(display_name="report"),
                io.String.Output(display_name="metas", tooltip="JSON list meta từng ảnh (phiên bản, phần nới) → FP Save to Library metas"),
                io.String.Output(display_name="names", tooltip="JSON list tên từng ảnh → FP Save to Library names"),
                io.String.Output(display_name="parent_ids", tooltip="JSON list id clipart từng ảnh → FP Save to Library parent_id"),
            ],
        )

    @classmethod
    def validate_inputs(cls, **kwargs) -> bool:
        return True

    @classmethod
    async def fingerprint_inputs(cls, **kwargs) -> str:
        # The clipart's category gives the product's details (rules.details / productRefs).
        return await _db_fingerprint("material", "categories")

    @classmethod
    async def execute(
        cls,
        images,
        material: str,
        lock: str,
        edge_px: int,
        extra: str,
        model: str,
        seed: int,
        masks=None,
        context=None,
        names: str = "",
        parent_ids: str = "",
        draft: str = "",
        canvas: str = "nới rộng (vật liệu quanh hình)",
        frame: str = "",
    ) -> io.NodeOutput:
        preset = await _preset("material", fpc.option_id(material))
        if not preset:
            raise ValueError("Chọn preset vật liệu")
        params = preset.get("params") or {}
        # A material saved before "Hình in" existed has no `art`: the dialog shows it as "print", so it is drawn that
        # way. (The old one-shot path made 1 image per clipart, no padding, no versions; `lock` / `edge_px` stay
        # only so saved workflows still load.)
        if params.get("art") not in ("print", "surface"):
            preset = {**preset, "params": {**params, "art": "print"}}
        over = json.loads(draft) if draft.strip() else {}
        if not isinstance(over, dict):
            raise ValueError("draft: cần JSON object")
        shape = json.loads(frame) if frame.strip() else None
        if shape is not None and not isinstance(shape, dict):
            raise ValueError("frame: cần JSON object")
        return await cls._v2(images, preset, extra, model, masks, context, names, parent_ids, keep_frame=canvas == "giữ khung ảnh", draft=over, frame=shape)

    @classmethod
    async def _v2(
        cls,
        images,
        preset: dict,
        extra: str,
        model: str,
        masks,
        context,
        names: str,
        parent_ids: str,
        keep_frame: bool,
        draft: dict | None = None,
        frame: dict | None = None,
    ) -> io.NodeOutput:
        """Presets with `params.art` (material.py): base version + one per "version" detail, on a padded canvas.

        The material (preset) is reusable: only its look. The product's details (hole, cord, clip…) and the photos
        of the finished product are the clipart's category's (rules.details / productRefs). A material's old
        params.specs are never used: on another kind of product they would be wrong (migration 009 moved them)."""
        params = preset.get("params") or {}
        srcs = imaging.tensors_to_rgba(images, masks)
        cat_rules = ((context or {}).get("category") or {}).get("rules") or {}
        # A draft (prompts proposed, not saved) replaces what it carries.
        draft = draft or {}
        if "details" in draft or "product_refs" in draft:
            cat_rules = {**cat_rules, **({"details": draft["details"]} if "details" in draft else {}), **({"productRefs": draft["product_refs"]} if "product_refs" in draft else {})}
        specs = fpmat.parse_specs(cat_rules.get("details"))
        # The team's model (sent with every run) wins over one saved on the preset.
        use = fpmat.nano_model(str(model or params.get("model") or ""))
        refs: list[bytes] = []
        # Product photos first (they show the details), then the material's own; the model takes 6 at most.
        ref_urls = list(dict.fromkeys([*(cat_rules.get("productRefs") or []), *(params.get("refs") or [])]))[:6]
        for url in ref_urls:
            try:
                refs.append(_ref_png(await fp_api.download(str(url))))
            except Exception as e:  # a missing reference photo must not block the material
                print(f"[FP Material] ảnh mẫu lỗi {url}: {e}")
        material_text = (draft.get("material_prompt") or preset["prompt"]).strip()
        if context and context.get("style"):
            material_text += f"\nThe artwork is drawn in this style (keep it): {context['style']['prompt']}"
        used: set[str] = set()

        async def call(prompt: str, imgs: list[bytes]) -> np.ndarray:
            # The team's model, then the fallbacks (providers.fallbacks) when it is down / out of credit.
            chain = providers.fallbacks(use)
            last: Exception | None = None
            for m in chain:
                try:
                    data = await providers.generate(m, prompt, imgs)
                    used.add(m)
                    return imaging.bytes_to_rgba(data)[..., :3].copy()
                except providers.ProviderError as e:
                    last = e
            raise last or providers.ProviderError("Không model nào vẽ được vật liệu")

        async def one(src: np.ndarray):
            return await fpmat.render(call, src, material_text, specs, params["art"], refs, extra, _rgb_png, shaped=frame is not None)

        results = await providers.gather_limited([one(s) for s in srcs], limit=2)
        name_list, parent_list = _parse_list(names), _parse_list(parent_ids)
        outs: list[np.ndarray] = []
        metas: list[dict] = []
        out_names: list[str] = []
        out_parents: list[str] = []
        lines: list[str] = []
        for i, (versions, p, report) in enumerate(results):
            h, w = srcs[i].shape[:2]
            base_name = name_list[i] if i < len(name_list) else preset["name"]
            parent = parent_list[i] if i < len(parent_list) else (parent_list[0] if parent_list else "")
            for label, rgba in versions:
                meta: dict[str, object] = {}
                if keep_frame:
                    rgba = rgba[p : p + h, p : p + w].copy()
                else:
                    meta["pad"] = {"x": round(p / w, 5), "y": round(p / h, 5)}
                if label:
                    meta["materialVersion"] = label
                if frame is not None:
                    meta["frame"] = frame
                if draft:
                    meta["draft"] = True
                outs.append(rgba)
                metas.append(meta)
                out_names.append(f"{base_name} · {label}" if label else base_name)
                if draft:
                    out_names[-1] += " · thử"
                out_parents.append(parent)
            lines.append(f"#{i + 1}: " + "; ".join(report))
        report = f"{preset['name']} [{', '.join(sorted(used))}]\n" + "\n".join(lines)
        image, mask = imaging.rgba_to_tensors(outs)
        return io.NodeOutput(image, mask, report, json.dumps(metas), json.dumps(out_names), json.dumps(out_parents), ui=_ui(cls, outs, report))


def _cover(rgba: np.ndarray, w: int, h: int) -> np.ndarray:
    """Opaque, scaled to cover w × h and centre-cropped (a full-bleed clipart on the category canvas)."""
    from PIL import Image

    im = Image.fromarray(rgba).convert("RGB")
    k = max(w / im.width, h / im.height)
    im = im.resize((max(w, round(im.width * k)), max(h, round(im.height * k))), Image.LANCZOS)
    x, y = (im.width - w) // 2, (im.height - h) // 2
    out = np.asarray(im.crop((x, y, x + w, y + h)))
    return np.dstack([out, np.full((h, w), 255, np.uint8)])


def _rgb_png(a: np.ndarray) -> bytes:
    from io import BytesIO

    from PIL import Image

    b = BytesIO()
    Image.fromarray(a).save(b, "PNG")
    return b.getvalue()


def _ref_png(data: bytes, max_side: int = 1024) -> bytes:
    """A preset's reference photo as a PNG the models accept (jpg / webp / avif in, longest side ≤ max_side)."""
    from io import BytesIO

    from PIL import Image

    im = Image.open(BytesIO(data)).convert("RGB")
    im.thumbnail((max_side, max_side))
    b = BytesIO()
    im.save(b, "PNG")
    return b.getvalue()


class FPMockupScene(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="FP_MockupScene",
            display_name="FP Mockup Scene",
            category=f"{CATEGORY_NODE}/Tạo",
            description="Artwork (đã ghép, có thể đã qua FP Material) → ảnh lifestyle marketing theo preset scene. Không dùng làm file in.",
            inputs=[
                io.Image.Input("image"),
                io.Combo.Input("scene", options=[], remote=_remote("scene")),
                io.String.Input("extra", multiline=True, default=""),
                _model_input(),
                _seed_input(),
                io.Mask.Input("mask", optional=True),
            ],
            outputs=[io.Image.Output(display_name="image")],
        )

    @classmethod
    def validate_inputs(cls, **kwargs) -> bool:
        return True

    @classmethod
    async def fingerprint_inputs(cls, **kwargs) -> str:
        return await _db_fingerprint("scene")

    @classmethod
    async def execute(cls, image, scene: str, extra: str, model: str, seed: int, mask=None) -> io.NodeOutput:
        preset = await _preset("scene", fpc.option_id(scene))
        if not preset:
            raise ValueError("Chọn preset scene")
        src = imaging.tensors_to_rgba(image[:1], mask[:1] if mask is not None else None)[0]
        prompt = preset["prompt"].strip() + (f"\n{extra.strip()}" if extra.strip() else "")
        data, used = await providers.edit(model or preset.get("params", {}).get("model") or fpmat.DEFAULT_MODEL, prompt, imaging.rgba_on_white_png(src))
        out = imaging.bytes_to_rgba(data)
        img, _ = imaging.rgba_to_tensors([out])
        return io.NodeOutput(img, ui=_ui(cls, [out], f"[{used}]\n{prompt}"))


ENHANCE_BASE = (
    "Image 1 is a product mockup (tổ hợp #{n}) assembled by hand: product renders, photos and text pasted onto a "
    "background. Re-render image 1 as a finished, high-end, photorealistic product photo: natural light and shadows "
    "where the products touch or hang, realistic material, reflections and depth, clean edges, sharp detail. "
    "Keep the composition, framing and camera angle, and keep every product exactly as it is in image 1 — position, "
    "size, silhouette, colours, printed artwork, faces and every letter of text. Do not add, remove or rearrange objects or text."
)


class FPMockupEnhance(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="FP_MockupEnhance",
            display_name="FP Mockup Enhance",
            category=f"{CATEGORY_NODE}/Tạo",
            description=(
                "Tổ hợp làm tay (editor) → ảnh mockup hoàn thiện, giữ nguyên bố cục và sản phẩm. Ảnh 1 = tổ hợp cần làm; "
                "các ảnh sau = tổ hợp khác của bộ, đánh số như trong editor (#2…), để prompt nhắc tới."
            ),
            inputs=[
                io.String.Input("refs", default="", tooltip="JSON list tên ảnh trong input/ (POST /flexi/refs), ảnh đầu = tổ hợp cần làm"),
                io.String.Input("numbers", default="", tooltip="JSON list số thứ tự của từng ảnh trong bộ (#n)"),
                io.String.Input("prompt", multiline=True, default="", tooltip="Yêu cầu chung cho cả bộ"),
                io.String.Input("own", multiline=True, default="", tooltip="Yêu cầu riêng của tổ hợp này"),
                _model_input(),
                _seed_input(),
            ],
            outputs=[io.Image.Output(display_name="image")],
        )

    @classmethod
    async def execute(cls, refs: str, numbers: str, prompt: str, own: str, model: str, seed: int) -> io.NodeOutput:
        names = _parse_list(refs)
        if not names:
            raise ValueError("Cần ảnh tổ hợp (refs)")
        try:
            nums = [int(n) for n in _parse_list(numbers)]
        except ValueError:
            nums = []
        nums = nums + list(range(len(nums) + 1, len(names) + 1))
        images = _input_images(names, limit=6)
        text = ENHANCE_BASE.format(n=nums[0])
        if len(images) > 1:
            listed = ", ".join(f"image {i + 1} = #{nums[i]}" for i in range(1, len(images)))
            text += (
                f"\nThe other images are other mockups of the same set ({listed}): reference only, for a consistent look "
                "across the set — never copy their products into image 1. When the instructions name #n they mean that image."
            )
        if prompt.strip():
            text += f"\nInstructions for the whole set: {prompt.strip()}"
        if own.strip():
            text += f"\nInstructions for #{nums[0]}: {own.strip()}"
        data, used = await providers.run(model, text, images)
        out = imaging.bytes_to_rgba(data)
        img, _ = imaging.rgba_to_tensors([out])
        return io.NodeOutput(img, ui=_ui(cls, [out], f"[{used}]\n{text}"))


# =====================================================================
# Library I/O
# =====================================================================


class FPLoadClipart(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="FP_LoadClipart",
            display_name="FP Load Clipart",
            category=f"{CATEGORY_NODE}/Thư viện",
            description="Lấy 1 clipart trong thư viện (kèm ngữ cảnh danh mục của nó). Sidebar FlexiPrint: bấm ảnh để thêm node này.",
            inputs=[io.Combo.Input("clipart", options=[], remote=_remote("cliparts"))],
            outputs=[io.Image.Output(display_name="image"), io.Mask.Output(display_name="mask"), io.String.Output(display_name="clipart_id"), FpContext.Output(display_name="context")],
        )

    @classmethod
    def validate_inputs(cls, **kwargs) -> bool:
        return True

    @classmethod
    async def fingerprint_inputs(cls, clipart: str = "", **kwargs) -> str:
        return clipart + await _db_fingerprint("categories", "style_pack")

    @classmethod
    async def execute(cls, clipart: str) -> io.NodeOutput:
        cid = fpc.option_id(clipart)
        if not cid:
            raise ValueError("Chọn clipart")
        a = await fp_api.clipart(cid)
        rgba = imaging.bytes_to_rgba(await fp_api.download(a["url"]))
        ctx = fpc.empty()
        if a.get("category_id"):
            ctx["category"] = await _category(a["category_id"])
            ctx["style"] = await _style(ctx["category"]["rules"].get("stylePackId")) if ctx["category"] else None
        if a.get("spec"):
            ctx["notes"].append(f"This clipart: {a['spec']}")
        image, mask = imaging.rgba_to_tensors([rgba])
        return io.NodeOutput(image, mask, a["id"], ctx, ui=_ui(cls, [rgba], f"{a['name']} ({a['role']}, {a['width']}×{a['height']})\n{fpc.describe(ctx)}"))


class FPFrameClipart(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="FP_FrameClipart",
            display_name="FP Frame Clipart (cắt theo khuôn)",
            category=f"{CATEGORY_NODE}/Thư viện",
            description=(
                "Cắt clipart theo khuôn vật liệu của 1 sản phẩm (custom layer “Khuôn vật liệu” + vùng cắt bỏ): ảnh ra đúng khung "
                "khuôn, mọi clipart cùng khuôn ra cùng kích thước — đưa vào FP Material (input frame) để vật liệu giữ y nguyên viền."
            ),
            inputs=[
                io.Image.Input("image"),
                io.Mask.Input("mask", optional=True),
                io.String.Input("cut", multiline=True, default="", tooltip="JSON {w, h, art: {x, y, w, h, rotation}, clip: [[x, y]…], cuts: [[[x, y]…]…]} (lib/material-frame.ts frameCut)"),
            ],
            outputs=[io.Image.Output(display_name="image"), io.Mask.Output(display_name="mask")],
        )

    @classmethod
    def validate_inputs(cls, **kwargs) -> bool:
        return True

    @classmethod
    async def execute(cls, image, cut: str, mask=None) -> io.NodeOutput:
        spec = json.loads(cut) if cut.strip() else None
        if not isinstance(spec, dict) or not spec.get("clip"):
            raise ValueError("cut: cần JSON khuôn (w, h, art, clip)")
        out = [fpmat.frame_cut(src, spec) for src in imaging.tensors_to_rgba(image, mask)]
        img, msk = imaging.rgba_to_tensors(out)
        return io.NodeOutput(img, msk, ui=_ui(cls, out, f"khuôn {spec['w']}×{spec['h']}, {len(spec.get('cuts') or [])} vùng cắt"))


class FPLoadArtwork(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="FP_LoadArtwork",
            display_name="FP Load Artwork",
            category=f"{CATEGORY_NODE}/Thư viện",
            description="Artwork đã ghép từ clipart (tab 'Tổ hợp & Mockup' trong editor → Lưu tổ hợp).",
            inputs=[io.Combo.Input("artwork", options=[], remote=_remote("artworks"))],
            outputs=[io.Image.Output(display_name="image"), io.Mask.Output(display_name="mask"), io.String.Output(display_name="product_id")],
        )

    @classmethod
    def validate_inputs(cls, **kwargs) -> bool:
        return True

    @classmethod
    async def execute(cls, artwork: str) -> io.NodeOutput:
        aid = fpc.option_id(artwork)
        for p in await fp_api.products():
            for c in p["composites"]:
                if c["id"] == aid:
                    rgba = imaging.bytes_to_rgba(await fp_api.download(c["url"]))
                    image, mask = imaging.rgba_to_tensors([rgba])
                    return io.NodeOutput(image, mask, p["id"], ui=_ui(cls, [rgba], f"{p['name']} / {c['name']}"))
        raise ValueError("Artwork không còn tồn tại — bấm refresh")


def _workflow(cls) -> dict | None:
    info = cls.hidden.extra_pnginfo or {}
    return info.get("workflow") if isinstance(info, dict) else None


class FPSaveToLibrary(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="FP_SaveToLibrary",
            display_name="FP Save to Library",
            category=f"{CATEGORY_NODE}/Thư viện",
            description=(
                "Lưu vào thư viện FlexiPrint. origin = clipart gốc mới trong danh mục (context); set_member = biến thể của parent_id; "
                "rendition = bản vật liệu của parent_id (mỗi ảnh 1 parent nếu truyền danh sách id)."
            ),
            inputs=[
                io.Image.Input("images"),
                io.Combo.Input("kind", options=["origin", "set_member", "rendition"], default="origin"),
                io.String.Input("names", default="", tooltip="JSON list hoặc mỗi dòng 1 tên (nối từ output names)"),
                io.String.Input("parent_id", default="", tooltip="set_member / rendition: id clipart gốc (nối từ FP Load Clipart), hoặc JSON list id"),
                io.String.Input("tags", default="", tooltip="phẩy"),
                io.String.Input("prompts", default="", tooltip="JSON list prompt (nối từ output prompts) — lưu vào lịch sử"),
                io.Mask.Input("masks", optional=True),
                io.String.Input(
                    "specs",
                    default="",
                    optional=True,
                    tooltip="JSON list: mô tả riêng của từng clipart (model, màu, chi tiết nhận diện) — lưu vào spec, lần sửa sau dùng lại",
                ),
                io.String.Input("derived_from", default="", optional=True, tooltip="Bản sửa của clipart nào (id, nối clipart_id từ FP Load Clipart) — app dùng để thay bản cũ trong sản phẩm"),
                io.String.Input("material", default="", optional=True, tooltip="rendition: id preset vật liệu đã dùng — để render lại đúng vật liệu khi clipart được sửa"),
                io.String.Input(
                    "metas",
                    default="",
                    optional=True,
                    tooltip="JSON list: meta thêm cho từng ảnh (vd. {\"variant\": {\"text\": \"#8fd9c4\", \"mode\": \"recolor\"}} — biến thể làm từ gốc thế nào, để tạo lại khi gốc được sửa)",
                ),
                FpContext.Input("context", optional=True),
            ],
            outputs=[io.String.Output(display_name="clipart_ids")],
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo],
            is_output_node=True,
        )

    @classmethod
    async def execute(cls, images, kind: str, names: str, parent_id: str, tags: str, prompts: str, masks=None, context=None, specs: str = "", derived_from: str = "", material: str = "", metas: str = "") -> io.NodeOutput:
        rgbas = imaging.tensors_to_rgba(images, masks)
        name_list = _parse_list(names)
        spec_list = _parse_list(specs)
        parents = _parse_list(parent_id)
        prompt_list = _parse_list(prompts)
        # One id for every image, or a JSON list: image i is the fix / remake of derived[i].
        derived = _parse_list(derived_from)
        try:
            extra_metas = json.loads(metas) if metas.strip() else []
        except json.JSONDecodeError:
            extra_metas = []
        if not isinstance(extra_metas, list):
            extra_metas = []
        cat = (context or {}).get("category")
        if kind == "origin" and not cat:
            raise ValueError("origin cần context có FP Category (để biết lưu vào danh mục nào)")
        if kind != "origin" and not parents:
            raise ValueError(f"{kind} cần parent_id (nối clipart_id từ FP Load Clipart hoặc FP Save to Library)")
        workflow = json.dumps(_workflow(cls)) if _workflow(cls) else ""
        ids, lines = [], []
        for i, x in enumerate(rgbas):
            name = name_list[i] if i < len(name_list) else f"{(cat or {}).get('name', 'clipart')} {i + 1}"
            fields = {
                "name": name,
                "tags": json.dumps([t.strip() for t in tags.split(",") if t.strip()]),
                "prompt": prompt_list[i] if i < len(prompt_list) else "",
                "resolved_prompt": prompt_list[i] if i < len(prompt_list) else "",
                "workflow": workflow,
                "model": "comfy",
            }
            if i < len(spec_list) and spec_list[i].strip():
                fields["spec"] = spec_list[i].strip()
            meta: dict[str, object] = {}
            if i < len(extra_metas) and isinstance(extra_metas[i], dict):
                meta.update(extra_metas[i])
            src = derived[i] if i < len(derived) else derived[0] if len(derived) == 1 else ""
            if src.strip():
                meta["derivedFrom"] = src.strip()
            if material.strip():
                meta["material"] = material.strip()
            if meta:
                fields["meta"] = json.dumps(meta)
            if kind == "origin":
                fields["category_id"] = cat["id"]
            else:
                fields["parent_id"] = parents[i] if i < len(parents) else parents[0]
                if kind == "rendition":
                    fields["rendition"] = "1"
            res = await fp_api.post_form("cliparts", fields, _to_png(x), f"{name}.png")
            c = res["clipart"]
            ids.append(c["id"])
            lines.append(f"✓ {c['name']} → {c['role']} {c['width']}×{c['height']} · {c['id']}")
        out = json.dumps(ids) if len(ids) > 1 else (ids[0] if ids else "")
        # fp_ids: what the app's AI dialog reads back from /history (routes.py run status).
        return io.NodeOutput(out, ui={**_ui(cls, rgbas, "\n".join(lines)), "fp_ids": ids})


def _parse_list(value: str) -> list[str]:
    v = (value or "").strip()
    if not v:
        return []
    if v.startswith("["):
        try:
            return [str(x) for x in json.loads(v)]
        except json.JSONDecodeError:
            pass
    return [l.strip() for l in v.splitlines() if l.strip()]


class FPSaveMockup(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="FP_SaveMockup",
            display_name="FP Save Mockup",
            category=f"{CATEGORY_NODE}/Thư viện",
            description=(
                "Lưu ảnh vào sản phẩm: mockup, hoặc — khi có parent_id (artwork của sản phẩm) — bản vật liệu AI của artwork đó "
                "(tab 'Tổ hợp' của editor dùng nó thay cho bản ghép)."
            ),
            inputs=[
                io.Image.Input("image"),
                io.String.Input("product_id", default=""),
                io.String.Input("name", default="Studio mockup"),
                io.String.Input("parent_id", default="", optional=True),
                io.String.Input("material", default="", optional=True),
            ],
            outputs=[],
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo],
            is_output_node=True,
        )

    @classmethod
    async def execute(cls, image, product_id: str, name: str, parent_id: str = "", material: str = "") -> io.NodeOutput:
        pid = fpc.option_id(product_id)
        if not pid:
            raise ValueError("Cần product_id (nối từ FP Load Artwork)")
        rgbas = imaging.tensors_to_rgba(image, None)
        lines, ids = [], []
        for i, x in enumerate(rgbas):
            wf = _workflow(cls)
            res = await fp_api.post_form(
                "mockups",
                {
                    "product_id": pid,
                    "name": name if len(rgbas) == 1 else f"{name} {i + 1}",
                    "workflow": json.dumps(wf) if wf else "",
                    "parent_id": fpc.option_id(parent_id) or "",
                    "material": fpc.option_id(material) or "",
                },
                _to_png(x),
            )
            ids.append(res["asset"]["id"])
            lines.append(f"✓ {'vật liệu artwork' if parent_id else 'mockup'} {res['asset']['id']}")
        return io.NodeOutput(ui={**_ui(cls, rgbas, "\n".join(lines)), "fp_ids": ids})


NODES: list[type[io.ComfyNode]] = [
    FPStylePack,
    FPMaterialLook,
    FPCategory,
    FPContextNote,
    FPRules,
    FPOriginGenerate,
    FPRefine,
    FPAdjust,
    FPCutout,
    FPVariantSet,
    FPMaterial,
    FPMockupScene,
    FPMockupEnhance,
    FPLoadClipart,
    FPFrameClipart,
    FPLoadArtwork,
    FPSaveToLibrary,
    FPSaveMockup,
]
