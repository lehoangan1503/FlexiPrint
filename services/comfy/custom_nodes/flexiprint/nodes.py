"""FlexiPrint nodes (ComfyUI V3 API).

The graph an editor builds reads like the product:

    FP Style Pack ─┐
    FP Category ───┴─► FP Origin Generate ─► FP Cutout ─► FP Save to Library (origin)
                                                   │
    FP Load Clipart ─► FP Variant Set ─────────────┴─► FP Save to Library (set member)
                   └─► FP Material ────────────────────► FP Save to Library (rendition)
    FP Load Artwork ─► FP Material ─► FP Mockup Scene ─► FP Save Mockup

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

import numpy as np
import torch
from comfy_api.latest import io, ui

from . import context as fpc
from . import fp_api, imaging, providers

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
            return {"id": p["id"], "name": p["name"], "prompt": p["prompt"]}
    return None


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


def _lines(text: str) -> list[str]:
    return [l.strip() for l in (text or "").splitlines() if l.strip() and not l.strip().startswith("#")]


def _split_named(line: str) -> tuple[str, str]:
    """'green: mint green body' → ('green', 'mint green body'); a bare line is both."""
    if ":" in line:
        name, _, rest = line.partition(":")
        return name.strip(), rest.strip() or name.strip()
    return line[:60], line


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
    async def execute(cls, style_pack: str, extra: str = "", context: fpc.Context | None = None) -> io.NodeOutput:
        ctx = fpc.extend(context)
        style = await _style(fpc.option_id(style_pack))
        if extra.strip():
            style = {"id": style["id"] if style else "", "name": (style["name"] if style else "custom"), "prompt": ((style["prompt"] + "\n") if style else "") + extra.strip()}
        ctx["style"] = style
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
    async def execute(cls, category: str, context: fpc.Context | None = None) -> io.NodeOutput:
        ctx = fpc.extend(context)
        ctx["category"] = await _category(fpc.option_id(category))
        # The category's default style pack applies unless the graph set one.
        if ctx["category"] and not ctx.get("style"):
            ctx["style"] = await _style(ctx["category"]["rules"].get("stylePackId"))
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
            ],
            outputs=[
                io.Image.Output(display_name="images"),
                io.Mask.Output(display_name="masks"),
                io.String.Output(display_name="names"),
                io.String.Output(display_name="prompts"),
            ],
        )

    @classmethod
    async def execute(cls, context, subjects: str, model: str, chain_reference: bool, seed: int, reference=None) -> io.NodeOutput:
        lines = _lines(subjects)
        if not lines:
            raise ValueError("Nhập ít nhất 1 dòng subject")
        role = "main" if (context.get("category") or {}).get("usage") == "main" else "element"
        refs: list[bytes] = []
        if reference is not None:
            refs = [imaging.rgba_on_white_png(x) for x in imaging.tensors_to_rgba(reference[:2], None)]
        names, prompts, outs = [], [], []

        async def one(line: str, extra_refs: list[bytes]) -> tuple[str, str, np.ndarray]:
            name, subject = _split_named(line)
            instruction = f"Subject: {subject}."
            if extra_refs:
                instruction += " Match the reference image(s): same drawing style, line weight, viewing angle, lighting and scale."
            prompt = fpc.compose(context, instruction, role=role)
            data, used = await providers.run(model, prompt, extra_refs)
            return name, f"[{used}]\n{prompt}", imaging.bytes_to_rgba(data)

        if chain_reference and len(lines) > 1:
            first = await one(lines[0], refs)
            chained = refs + [imaging.rgba_on_white_png(first[2])]
            rest = await providers.gather_limited([one(l, chained) for l in lines[1:]])
            results = [first, *rest]
        else:
            results = await providers.gather_limited([one(l, refs) for l in lines])
        for name, prompt, rgba in results:
            names.append(name)
            prompts.append(prompt)
            outs.append(rgba)
        image, mask = imaging.rgba_to_tensors(outs)
        return io.NodeOutput(image, mask, json.dumps(names, ensure_ascii=False), json.dumps(prompts, ensure_ascii=False), ui=_ui(cls, outs, prompts[0]))


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
                io.Combo.Input("method", options=["white key (nhanh, miễn phí)", "birefnet (fal)", "giữ alpha"], default="white key (nhanh, miễn phí)"),
                io.Boolean.Input("normalize", default=True),
                io.Mask.Input("masks", optional=True),
                FpContext.Input("context", optional=True),
            ],
            outputs=[io.Image.Output(display_name="images"), io.Mask.Output(display_name="masks")],
        )

    @classmethod
    async def execute(cls, images, method: str, normalize: bool, masks=None, context=None) -> io.NodeOutput:
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
            ],
            outputs=[
                io.Image.Output(display_name="images"),
                io.Mask.Output(display_name="masks"),
                io.String.Output(display_name="names"),
                io.String.Output(display_name="report"),
            ],
        )

    @classmethod
    async def execute(cls, origin, origin_mask, variants: str, method: str, model: str, seed: int, context=None) -> io.NodeOutput:
        src = imaging.tensors_to_rgba(origin[:1], origin_mask[:1])[0]
        ctx = context or fpc.empty()
        lines = _lines(variants)
        if not lines:
            raise ValueError("Nhập ít nhất 1 dòng biến thể")
        src_png = imaging.rgba_on_white_png(src)

        async def one(line: str) -> tuple[str, np.ndarray, str]:
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
            prompt = fpc.compose(ctx, instruction, role="element", include_rules=False) + "\nPure white (#FFFFFF) background."
            data, used = await providers.edit(model, prompt, src_png)
            aligned = imaging.align_to(src, imaging.bytes_to_rgba(data))
            score = imaging.iou(src[..., 3], aligned[..., 3])
            result = imaging.lock_silhouette(aligned, src[..., 3]) if how == "ai_edit_locked" else aligned
            return name, result, f"{name}: {how} [{used}], silhouette IoU {score:.3f}"

        results = await providers.gather_limited([one(l) for l in lines])
        names = [r[0] for r in results]
        outs = [r[1] for r in results]
        report = "\n".join(r[2] for r in results)
        image, mask = imaging.rgba_to_tensors(outs)
        return io.NodeOutput(image, mask, json.dumps(names, ensure_ascii=False), report, ui=_ui(cls, outs, report))


class FPMaterial(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="FP_Material",
            display_name="FP Material (vật liệu AI)",
            category=f"{CATEGORY_NODE}/Tạo",
            description=(
                "Render clipart hoặc artwork đã ghép thành vật liệu thật (acrylic, glitter, gỗ…) theo preset — giữ chi tiết + kích thước: "
                "resize về đúng W×H gốc, khoá silhouette thì ép lại alpha gốc (edge_px nở thêm cho viền acrylic)."
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
            ],
            outputs=[io.Image.Output(display_name="images"), io.Mask.Output(display_name="masks"), io.String.Output(display_name="report")],
        )

    @classmethod
    def validate_inputs(cls, **kwargs) -> bool:
        return True

    @classmethod
    async def execute(cls, images, material: str, lock: str, edge_px: int, extra: str, model: str, seed: int, masks=None, context=None) -> io.NodeOutput:
        preset = await _preset("material", fpc.option_id(material))
        if not preset:
            raise ValueError("Chọn preset vật liệu")
        locked = bool(preset.get("params", {}).get("lockSilhouette")) if lock == "theo preset" else lock == "khoá"
        srcs = imaging.tensors_to_rgba(images, masks)
        prompt = preset["prompt"].strip() + (f"\n{extra.strip()}" if extra.strip() else "")
        if context and context.get("style"):
            prompt += f"\nThe artwork is drawn in this style (keep it): {context['style']['prompt']}"

        async def one(src: np.ndarray) -> tuple[np.ndarray, str]:
            data, used = await providers.edit(preset.get("params", {}).get("model") or model, prompt, imaging.rgba_on_white_png(src))
            out = imaging.bytes_to_rgba(data)
            h, w = src.shape[:2]
            has_alpha = imaging.has_transparency(src)
            if not has_alpha:
                # A full artwork (no transparency): same size, nothing to lock.
                return imaging.resize_to(out, w, h), f"{w}×{h} [{used}]"
            aligned = imaging.align_to(src, out)
            score = imaging.iou(src[..., 3], aligned[..., 3])
            result = imaging.lock_silhouette(aligned, src[..., 3], edge_px) if locked else aligned
            return result, f"{w}×{h} [{used}], IoU {score:.3f}{', khoá silhouette' if locked else ''}"

        results = await providers.gather_limited([one(s) for s in srcs])
        outs = [r[0] for r in results]
        report = f"{preset['name']}: " + " | ".join(r[1] for r in results)
        image, mask = imaging.rgba_to_tensors(outs)
        return io.NodeOutput(image, mask, report, ui=_ui(cls, outs, report + "\n\n" + prompt))


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
    async def execute(cls, image, scene: str, extra: str, model: str, seed: int, mask=None) -> io.NodeOutput:
        preset = await _preset("scene", fpc.option_id(scene))
        if not preset:
            raise ValueError("Chọn preset scene")
        src = imaging.tensors_to_rgba(image[:1], mask[:1] if mask is not None else None)[0]
        prompt = preset["prompt"].strip() + (f"\n{extra.strip()}" if extra.strip() else "")
        data, used = await providers.edit(preset.get("params", {}).get("model") or model, prompt, imaging.rgba_on_white_png(src))
        out = imaging.bytes_to_rgba(data)
        img, _ = imaging.rgba_to_tensors([out])
        return io.NodeOutput(img, ui=_ui(cls, [out], f"[{used}]\n{prompt}"))


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
                FpContext.Input("context", optional=True),
            ],
            outputs=[io.String.Output(display_name="clipart_ids")],
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo],
            is_output_node=True,
        )

    @classmethod
    async def execute(cls, images, kind: str, names: str, parent_id: str, tags: str, prompts: str, masks=None, context=None) -> io.NodeOutput:
        rgbas = imaging.tensors_to_rgba(images, masks)
        name_list = _parse_list(names)
        parents = _parse_list(parent_id)
        prompt_list = _parse_list(prompts)
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
        return io.NodeOutput(out, ui=_ui(cls, rgbas, "\n".join(lines)))


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
            description="Lưu ảnh mockup vào sản phẩm (tab 'Tổ hợp & Mockup' của editor).",
            inputs=[io.Image.Input("image"), io.String.Input("product_id", default=""), io.String.Input("name", default="Studio mockup")],
            outputs=[],
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo],
            is_output_node=True,
        )

    @classmethod
    async def execute(cls, image, product_id: str, name: str) -> io.NodeOutput:
        pid = fpc.option_id(product_id)
        if not pid:
            raise ValueError("Cần product_id (nối từ FP Load Artwork)")
        rgbas = imaging.tensors_to_rgba(image, None)
        lines = []
        for i, x in enumerate(rgbas):
            wf = _workflow(cls)
            res = await fp_api.post_form(
                "mockups", {"product_id": pid, "name": name if len(rgbas) == 1 else f"{name} {i + 1}", "workflow": json.dumps(wf) if wf else ""}, _to_png(x)
            )
            lines.append(f"✓ mockup {res['asset']['id']}")
        return io.NodeOutput(ui=_ui(cls, rgbas, "\n".join(lines)))


NODES: list[type[io.ComfyNode]] = [
    FPStylePack,
    FPCategory,
    FPContextNote,
    FPOriginGenerate,
    FPCutout,
    FPVariantSet,
    FPMaterial,
    FPMockupScene,
    FPLoadClipart,
    FPLoadArtwork,
    FPSaveToLibrary,
    FPSaveMockup,
]
