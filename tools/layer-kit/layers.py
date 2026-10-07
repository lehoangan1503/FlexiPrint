"""
Build a pixel-registered layer set from one AI master (flexiprint://guide/layer-rules).

  base       bald.png          the master body (every other file is an in-place edit of it)
  masks      mk_<part>.png     the part painted magenta in place → which pixels are the part
  hair       <style>.png       the base with that hairstyle added in place → hair = what changed
  cut/       bg-remover output of base + each hairstyle (alpha + clean edge colours)

Every layer is cut from the SAME canvas and every option of a slot comes from the same pixels; clothes colours
are recolours of the base's own pixels (identical alpha), hair = back (whole hair, under the body) + front (the
hair lying over the body, on top). All files are cropped by ONE common rectangle (a sub-canvas fixed once).
"""
import json, os
import numpy as np, cv2
from PIL import Image
from scipy import ndimage as ndi

OUT = "out"
os.makedirs(OUT, exist_ok=True)

def rgba(p): return np.asarray(Image.open(p).convert("RGBA")).astype(np.float32) / 255.0
def rgb(p): return np.asarray(Image.open(p).convert("RGB")).astype(np.float32) / 255.0

def cut_of(white_png, cut_png):
    """bg-remover returns a downscaled picture: take only its alpha, scaled back onto the master canvas (uniform
    scale of the same canvas — no shift), and the colours from the full-size picture, un-mixed from the white."""
    src = rgb(white_png)
    h, w = src.shape[:2]
    a = np.asarray(Image.open(cut_png).convert("RGBA").getchannel("A").resize((w, h), Image.BICUBIC)).astype(np.float32) / 255
    a = np.clip(a, 0, 1)
    safe = np.maximum(a, 0.05)[..., None]
    col = np.clip((src - (1 - a[..., None])) / safe, 0, 1)
    col = np.where(a[..., None] > 0.05, col, src)
    return np.dstack([col, a])

base_cut = cut_of("bald.png", "cut/bald.png")
A_B = base_cut[..., 3]
base_rgb_white = rgb("bald.png")
H, W = A_B.shape

def clean(mask, open_r=2, close_r=4, min_px=1500):
    k = lambda r: cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
    m = cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_OPEN, k(open_r))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k(close_r))
    lab, n = ndi.label(m)
    if n:
        sizes = ndi.sum(m, lab, range(1, n + 1))
        keep = np.isin(lab, [i + 1 for i, s in enumerate(sizes) if s >= min_px])
        m = keep.astype(np.uint8)
    return m.astype(bool)

def soft(mask, grow=1, blur=1.2):
    m = mask.astype(np.uint8)
    if grow: m = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * grow + 1,) * 2))
    return np.clip(cv2.GaussianBlur(m.astype(np.float32), (0, 0), blur), 0, 1)

def to_lab(c): return cv2.cvtColor(c.astype(np.float32), cv2.COLOR_RGB2LAB)
def from_lab(l): return np.clip(cv2.cvtColor(l.astype(np.float32), cv2.COLOR_LAB2RGB), 0, 1)

def recolor(colour, alpha, target_hex, spread=1.0, tint=0.4):
    """Keep the part's own shading (L around its mean) and move its colour to the target. Same alpha → same pixels."""
    if target_hex is None: return colour
    t = np.array([int(target_hex[i:i + 2], 16) for i in (1, 3, 5)], np.float32)[None, None] / 255
    tl = to_lab(t)[0, 0]
    lab = to_lab(colour)
    sel = alpha > 0.5
    lm, am, bm = (lab[..., i][sel].mean() for i in range(3))
    out = lab.copy()
    out[..., 0] = np.clip(tl[0] + (lab[..., 0] - lm) * spread, 0, 100)
    out[..., 1] = tl[1] + (lab[..., 1] - am) * tint
    out[..., 2] = tl[2] + (lab[..., 2] - bm) * tint
    return from_lab(out)

def magenta(p):
    c = rgb(p)
    return (c[..., 0] > 0.7) & (c[..., 2] > 0.7) & (c[..., 1] < 0.35) & (np.abs(c[..., 0] - c[..., 2]) < 0.3)

layers = {}          # file name → RGBA float
slots = {}           # slot → [file names]

# ---- body: the base itself -------------------------------------------------------------------------------
layers["body.png"] = base_cut.copy()
slots["body"] = ["body.png"]

# ---- clothes: masks from the magenta edits, pixels + alpha from the base -----------------------------------
base_lab = to_lab(base_cut[..., :3])
CLOTHES = {
    "sweater": [("blue", None), ("red", "#b5332e"), ("mustard", "#d6a12f"), ("green", "#4d7a49"), ("pink", "#e79bb2"), ("cream", "#ece2cf"), ("black", "#2c2c30")],
    "pants": [("denim", None), ("black", "#27272b"), ("light-blue", "#93b5d8"), ("olive", "#6a6a3c")],
    "shoes": [("white", None), ("black", "#2a2a2c"), ("pink", "#eaa2b6"), ("green", "#6f905a")],
}
# Skin never belongs to clothes: warm hue + not dark. Hands / ankles next to a part stay the body's.
L_, a_, b_ = base_lab[..., 0], base_lab[..., 1], base_lab[..., 2]
skin = (a_ > 6) & (b_ > 8) & (L_ > 35)
cores = {part: clean(magenta(f"mk_{part}.png")) for part in CLOTHES}
for part, colours in CLOTHES.items():
    core = cores[part]
    others = np.zeros_like(core)
    for q, c in cores.items():
        if q != part: others |= c
    # The AI mask may sit a pixel or two off: grow it to take the part's own outline, never skin or another part.
    grown = cv2.dilate(core.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))).astype(bool)
    part_mask = grown & ~skin & ~others & (A_B > 0.02)
    part_mask = clean(part_mask, open_r=1, close_r=2, min_px=500)
    alpha = soft(part_mask, grow=2, blur=0.7) * A_B          # covers the body's own anti-aliased edge
    slots[part] = []
    for name, hexc in colours:
        col = recolor(base_cut[..., :3], alpha, hexc, spread=0.85 if hexc in ("#27272b", "#2c2c30", "#2a2a2c") else 1.0)
        f = f"{part}_{name}.png"
        layers[f] = np.dstack([col, alpha])
        slots[part].append(f)

# ---- hair: what each in-place hairstyle edit added to the base ----------------------------------------------
STYLES = [("long", "master_fal.png", "cut/master_fal.png"), ("bun", "hair_bun.png", "cut/hair_bun.png"),
          ("bob", "hair_bob.png", "cut/hair_bob.png"), ("braid", "hair_braid.png", "cut/hair_braid.png")]
HAIR_COLOURS = [("auburn", None), ("black", "#2b231f"), ("blonde", "#d8b26a"), ("brown", "#5b3b26")]
slots["hair_front"] = []; slots["hair_back"] = []
body_cover = soft(A_B > 0.5, grow=2, blur=1.0)
report = {}
for style, src, cut in STYLES:
    e_white, e_cut = rgb(src), cut_of(src, cut)
    diff = np.abs(e_white - base_rgb_white).max(2)
    changed = (diff > 0.12) & (e_cut[..., 3] > 0.3)
    # Hair colour reference: changed pixels outside the body (surely hair). Only hair-coloured changes are hair —
    # a shadow the braid casts on the sweater, a blush the edit touched, stay the body's.
    e_lab = to_lab(e_cut[..., :3])
    ref = changed & (A_B < 0.05)
    ha, hb = np.median(e_lab[..., 1][ref]), np.median(e_lab[..., 2][ref])
    hairlike = np.hypot(e_lab[..., 1] - ha, e_lab[..., 2] - hb) < 26
    hair = clean(changed & hairlike, open_r=2, close_r=5, min_px=3000)
    a_hair = np.minimum(soft(hair, grow=1, blur=1.2), e_cut[..., 3])
    # Hair lying over the body → on top. The front reaches 2 px past the body's edge: there it repeats the back
    # layer's own pixels, so no seam where the two meet.
    a_front = a_hair * body_cover
    for cname, hexc in HAIR_COLOURS:
        col = recolor(e_cut[..., :3], a_hair, hexc, spread=0.9, tint=0.12)
        fb, ff = f"hair_back_{cname}_{style}.png", f"hair_front_{cname}_{style}.png"
        layers[fb] = np.dstack([col, a_hair]); layers[ff] = np.dstack([col, a_front])
        slots["hair_back"].append(fb); slots["hair_front"].append(ff)
    # Check: back + body + front must rebuild the AI picture of that hairstyle.
    def over(dst, src):
        a = src[..., 3:4]; out = dst.copy()
        out[..., :3] = src[..., :3] * a + dst[..., :3] * (1 - a); out[..., 3:] = a + dst[..., 3:] * (1 - a); return out
    canvas = np.zeros((H, W, 4), np.float32)
    canvas = over(over(over(canvas, layers[f"hair_back_auburn_{style}.png"]), layers["body.png"]), layers[f"hair_front_auburn_{style}.png"])
    vis = e_cut[..., 3] > 0.9
    report[style] = {
        "rebuild_mean_diff_255": round(float(np.abs(canvas[..., :3] - e_cut[..., :3])[vis].mean() * 255), 2),
        "front_px": int((a_front > 0.5).sum()), "back_px": int((a_hair > 0.5).sum()),
        "front_in_back": round(float(((a_front > 0.5) & (a_hair > 0.5)).sum() / max(1, (a_front > 0.5).sum())), 4),
    }

# ---- one common crop for every file (a sub-canvas fixed once) ----------------------------------------------
union = np.zeros((H, W), bool)
for v in layers.values(): union |= v[..., 3] > 0.01
ys, xs = np.where(union)
M = 48
x0, y0 = max(0, xs.min() - M), max(0, ys.min() - M)
x1, y1 = min(W, xs.max() + M + 1), min(H, ys.max() + M + 1)
for f, v in layers.items():
    px = (np.clip(v[y0:y1, x0:x1], 0, 1) * 255).round().astype(np.uint8)
    px[px[..., 3] == 0] = 0                       # no colour under full transparency: tiny files, same picture
    Image.fromarray(px, "RGBA").save(os.path.join(OUT, f), optimize=True)

manifest = {"master": {"w": W, "h": H}, "crop": {"x": int(x0), "y": int(y0), "w": int(x1 - x0), "h": int(y1 - y0)},
            "order": ["hair_back", "body", "pants", "sweater", "shoes", "hair_front"],
            "slots": slots, "hair": {"styles": [s for s, *_ in STYLES], "colours": [c for c, _ in HAIR_COLOURS]},
            "check": report}
json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"), indent=1)
print(json.dumps({"crop": manifest["crop"], "check": report, "files": len(layers)}, indent=1))
