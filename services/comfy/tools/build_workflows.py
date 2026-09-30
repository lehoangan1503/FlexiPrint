"""Build the FlexiPrint workflow templates (custom_nodes/flexiprint/example_workflows/*.json)
in ComfyUI's UI format from a compact spec, using a running ComfyUI's /object_info
for input order / widget types — so widgets_values always line up with the nodes.

  python tools/build_workflows.py [http://127.0.0.1:8188]
"""

from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8188"
OUT = Path(__file__).resolve().parent.parent / "custom_nodes" / "flexiprint" / "example_workflows"
SOCKET_TYPES = {"IMAGE", "MASK", "FP_CONTEXT", "LATENT", "MODEL", "CLIP", "VAE", "CONDITIONING"}

info = json.load(urllib.request.urlopen(f"{BASE}/object_info"))


def widget_names(node_type: str) -> list[tuple[str, dict, str]]:
    d = info[node_type]
    out = []
    for section in ("required", "optional"):
        for name in d.get("input_order", {}).get(section, []):
            spec = d["input"][section][name]
            typ = spec[0] if isinstance(spec[0], str) else "COMBO"
            if typ not in SOCKET_TYPES:
                out.append((name, spec[1] if len(spec) > 1 else {}, typ))
    return out


def socket_inputs(node_type: str) -> list[tuple[str, str]]:
    d = info[node_type]
    out = []
    for section in ("required", "optional"):
        for name in d.get("input_order", {}).get(section, []):
            typ = d["input"][section][name][0]
            if isinstance(typ, str) and typ in SOCKET_TYPES:
                out.append((name, typ))
    return out


class Graph:
    def __init__(self) -> None:
        self.nodes: list[dict] = []
        self.links: list[list] = []
        self.groups: list[dict] = []

    def node(self, node_type: str, pos: tuple[int, int], values: dict | None = None, size: tuple[int, int] = (340, 220), title: str | None = None) -> dict:
        values = values or {}
        nid = len(self.nodes) + 1
        if node_type == "MarkdownNote":
            n = {"id": nid, "type": "MarkdownNote", "pos": list(pos), "size": list(size), "flags": {}, "order": nid - 1, "mode": 0, "inputs": [], "outputs": [], "properties": {}, "widgets_values": [values.get("text", "")], "color": "#432", "bgcolor": "#653"}
            self.nodes.append(n)
            return n
        d = info[node_type]
        widgets = []
        inputs = [{"name": name, "type": typ, "link": None} for name, typ in socket_inputs(node_type)]
        for name, opts, typ in widget_names(node_type):
            v = values.get(name, opts.get("default", "" if typ in ("STRING", "COMBO") else 0))
            widgets.append(v)
            if opts.get("control_after_generate"):
                widgets.append("fixed")
            if opts.get("remote"):
                # Remote combos carry two more widgets in the saved order: "Auto-refresh after generation" + the refresh button.
                widgets.extend([False, "refresh"])
            inputs.append({"name": name, "type": typ, "link": None, "widget": {"name": name}})
        outputs = [{"name": nm, "type": t, "links": [], "slot_index": i} for i, (t, nm) in enumerate(zip(d["output"], d["output_name"]))]
        n = {
            "id": nid,
            "type": node_type,
            "pos": list(pos),
            "size": list(size),
            "flags": {},
            "order": nid - 1,
            "mode": 0,
            "inputs": inputs,
            "outputs": outputs,
            "properties": {"Node name for S&R": node_type},
            "widgets_values": widgets,
        }
        if title:
            n["title"] = title
        self.nodes.append(n)
        return n

    def link(self, src: dict, out_name: str, dst: dict, in_name: str) -> None:
        lid = len(self.links) + 1
        o = next(i for i, x in enumerate(src["outputs"]) if x["name"] == out_name)
        i = next(i for i, x in enumerate(dst["inputs"]) if x["name"] == in_name)
        typ = src["outputs"][o]["type"]
        src["outputs"][o]["links"].append(lid)
        dst["inputs"][i]["link"] = lid
        self.links.append([lid, src["id"], o, dst["id"], i, typ])

    def group(self, title: str, x: int, y: int, w: int, h: int, color: str) -> None:
        self.groups.append({"title": title, "bounding": [x, y, w, h], "color": color, "font_size": 22, "flags": {}})

    def dump(self, name: str) -> None:
        wf = {
            "last_node_id": len(self.nodes),
            "last_link_id": len(self.links),
            "nodes": self.nodes,
            "links": self.links,
            "groups": self.groups,
            "config": {},
            "extra": {"ds": {"scale": 0.8, "offset": [40, 60]}},
            "version": 0.4,
        }
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / f"{name}.json").write_text(json.dumps(wf, ensure_ascii=False, indent=1))
        print("wrote", name)


CTX, GEN, SAVE, NOTE = "#335", "#353", "#533", "#444"

# ------------------------------------------------------------------ 01 origin set
g = Graph()
g.node("MarkdownNote", (20, 20), {"text": (
    "## Bộ clipart GỐC (origin set)\n"
    "Mỗi dòng ở **Origin Generate** = 1 clipart gốc cùng chủng loại (vd. các mẫu xe, các kiểu xửng/giỏ). Dùng `tên: mô tả`.\n\n"
    "1. **Category** chọn danh mục → spec + rule (canvas, fill, neo) ghép vào prompt; clipart lưu vào đúng danh mục.\n"
    "2. **Style Pack** (tuỳ chọn) → cả bộ cùng nét vẽ. `chain_reference` = dùng clipart đầu làm tham chiếu cho các dòng sau.\n"
    "3. **Cutout + Normalize** → tách nền, co về cùng canvas/fill → thay nhau được trong 1 vùng.\n"
    "4. **Save to Library** (origin).\n\nXem prompt thật ở tab **Ngữ cảnh** (bottom panel) khi chọn node.")}, size=(420, 330))
sp = g.node("FP_StylePack", (480, 40), size=(320, 180))
cat = g.node("FP_Category", (480, 260), size=(320, 110))
gen = g.node("FP_OriginGenerate", (840, 40), {"subjects": "sedan: a compact four-door sedan car, side view\npickup: a pickup truck, side view\nsuv: a boxy SUV, side view", "chain_reference": True}, size=(380, 330))
cut = g.node("FP_Cutout", (1260, 40), size=(320, 260))
save = g.node("FP_SaveToLibrary", (1620, 40), {"kind": "origin", "tags": ""}, size=(340, 360))
g.link(sp, "context", cat, "context")
g.link(cat, "context", gen, "context")
g.link(gen, "images", cut, "images")
g.link(cat, "context", cut, "context")
g.link(cut, "images", save, "images")
g.link(cut, "masks", save, "masks")
g.link(gen, "names", save, "names")
g.link(gen, "prompts", save, "prompts")
g.link(cat, "context", save, "context")
g.group("1 · Ngữ cảnh", 460, -10, 360, 400, CTX)
g.group("2 · Tạo + chuẩn hoá", 820, -10, 780, 400, GEN)
g.group("3 · Lưu thư viện", 1600, -10, 380, 430, SAVE)
g.dump("01-origin-set")

# ------------------------------------------------------------------ 02 variant set
g = Graph()
g.node("MarkdownNote", (20, 20), {"text": (
    "## Bộ BIẾN THỂ (variant set)\n1 clipart gốc → nhiều màu / style, **giữ nguyên silhouette + kích thước**.\n\n"
    "- `tên: #hex` hoặc tên màu → **recolor** (tất định, miễn phí, chuẩn 100%).\n"
    "- `tên: mô tả` → **ai_edit_locked**: AI sửa rồi ép lại alpha gốc (báo IoU).\n\n"
    "Load Clipart → mang theo danh mục + style pack của clipart. Save: `set_member`, parent_id nối từ Load Clipart.")}, size=(420, 280))
load = g.node("FP_LoadClipart", (480, 40), size=(340, 330))
var = g.node("FP_VariantSet", (860, 40), {"variants": "white: #f4f1ea\nyellow: #f6d77a\npink: #f7a8d8\ncoral: #f4978e\ngreen: #a8e6a1\nmint: #8fd9c4\nsky: #8cc8f2\nlavender: #c3a6f0\ncharcoal: #5b5b66\nrainbow: rainbow holographic pastel gradient body"}, size=(380, 380))
save = g.node("FP_SaveToLibrary", (1280, 40), {"kind": "set_member"}, size=(340, 360))
g.link(load, "image", var, "origin")
g.link(load, "mask", var, "origin_mask")
g.link(load, "context", var, "context")
g.link(var, "images", save, "images")
g.link(var, "masks", save, "masks")
g.link(var, "names", save, "names")
g.link(load, "clipart_id", save, "parent_id")
g.link(load, "context", save, "context")
g.group("Clipart gốc", 460, -10, 380, 400, CTX)
g.group("Biến thể", 840, -10, 420, 450, GEN)
g.group("Lưu (set_member)", 1260, -10, 380, 430, SAVE)
g.dump("02-variant-set")

# ------------------------------------------------------------------ 03 element pack
g = Graph()
g.node("MarkdownNote", (20, 20), {"text": (
    "## Bộ ELEMENT đồng bộ (hobby, nón, kính, phụ kiện…)\nGiống 01 nhưng danh mục usage = element: mỗi dòng 1 món, cùng style pack để cả bộ nhìn như 1 bộ sưu tập.\n\n"
    "**Context Note** thêm ngữ cảnh chung (dịp lễ, đối tượng khách…).")}, size=(420, 220))
sp = g.node("FP_StylePack", (480, 40), size=(320, 180))
cat = g.node("FP_Category", (480, 260), size=(320, 110))
note = g.node("FP_ContextNote", (480, 410), {"note": "Accessory icons that sit on top of a cute dumpling character; bold, readable at small size."}, size=(320, 160))
gen = g.node("FP_OriginGenerate", (840, 40), {"subjects": "book: an open storybook\ngamepad: a black game controller\nyarn: a ball of pastel yarn with knitting needles\npalette: a painter's palette with brushes\nbasketball: a basketball\ncoffee: a latte cup on a saucer\nguitar: an acoustic guitar\nboba: a bubble tea cup", "chain_reference": True}, size=(380, 380))
cut = g.node("FP_Cutout", (1260, 40), size=(320, 260))
save = g.node("FP_SaveToLibrary", (1620, 40), {"kind": "origin", "tags": "hobby"}, size=(340, 360))
g.link(sp, "context", cat, "context")
g.link(cat, "context", note, "context")
g.link(note, "context", gen, "context")
g.link(gen, "images", cut, "images")
g.link(note, "context", cut, "context")
g.link(cut, "images", save, "images")
g.link(cut, "masks", save, "masks")
g.link(gen, "names", save, "names")
g.link(gen, "prompts", save, "prompts")
g.link(note, "context", save, "context")
g.group("Ngữ cảnh", 460, -10, 360, 600, CTX)
g.group("Tạo", 820, -10, 780, 450, GEN)
g.group("Lưu", 1600, -10, 380, 430, SAVE)
g.dump("03-element-pack")

# ------------------------------------------------------------------ 04 clipart material
g = Graph()
g.node("MarkdownNote", (20, 20), {"text": (
    "## Vật liệu cho 1 clipart (rendition)\nPreset vật liệu (acrylic, glitter, gỗ…) → AI render lại, **resize đúng W×H gốc + ép alpha gốc** (khoá silhouette).\n"
    "`edge_px` nở viền (viền acrylic trong). Lưu `rendition` → storefront hiện bản này khi sản phẩm bật *Hiển thị: bản vật liệu AI*; file in vẫn dùng bản phẳng.")}, size=(420, 240))
load = g.node("FP_LoadClipart", (480, 40), size=(340, 330))
mat = g.node("FP_Material", (860, 40), size=(360, 420))
save = g.node("FP_SaveToLibrary", (1260, 40), {"kind": "rendition"}, size=(340, 360))
g.link(load, "image", mat, "images")
g.link(load, "mask", mat, "masks")
g.link(load, "context", mat, "context")
g.link(mat, "images", save, "images")
g.link(mat, "masks", save, "masks")
g.link(load, "clipart_id", save, "parent_id")
g.link(load, "context", save, "context")
g.group("Clipart", 460, -10, 380, 400, CTX)
g.group("Vật liệu", 840, -10, 400, 490, GEN)
g.group("Lưu (rendition)", 1240, -10, 380, 430, SAVE)
g.dump("04-clipart-material")

# ------------------------------------------------------------------ 05 artwork mockup
g = Graph()
g.node("MarkdownNote", (20, 20), {"text": (
    "## Artwork → vật liệu → mockup marketing\nArtwork = tổ hợp đã ghép từ clipart (editor: tab *Tổ hợp & Mockup* → Lưu tổ hợp).\n\n"
    "1. **Material** (acrylic, edge_px ~12 cho viền trong) giữ nguyên kích thước + silhouette.\n"
    "2. **Mockup Scene** đặt lên bối cảnh (cây thông…).\n3. **Save Mockup** → tab Mockup của sản phẩm. Chỉ dùng làm ảnh marketing, không phải file in.")}, size=(420, 260))
load = g.node("FP_LoadArtwork", (480, 40), size=(340, 300))
mat = g.node("FP_Material", (860, 40), {"edge_px": 12}, size=(360, 420))
scene = g.node("FP_MockupScene", (1260, 40), size=(360, 380))
save = g.node("FP_SaveMockup", (1660, 40), size=(320, 300))
g.link(load, "image", mat, "images")
g.link(load, "mask", mat, "masks")
g.link(mat, "images", scene, "image")
g.link(mat, "masks", scene, "mask")
g.link(scene, "image", save, "image")
g.link(load, "product_id", save, "product_id")
g.group("Artwork", 460, -10, 380, 370, CTX)
g.group("Vật liệu + scene", 840, -10, 800, 490, GEN)
g.group("Lưu mockup", 1640, -10, 360, 370, SAVE)
g.dump("05-artwork-mockup")
