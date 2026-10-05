/**
 * Shared by the AI dialog's refine panel and the quick-fix dialog: reference images, the default edit
 * model, and the "is this just a colour change?" check (a colour needs no AI — ComfyUI recolours for free).
 */

/** Drag type of a clipart card dragged onto a reference drop zone. */
export const REF_DRAG = "application/x-flexiprint-ref";
export const MAX_REFS = 4;

/** Default edit model: Nano Banana (1) keeps the rest of the clipart steadier than v2 and follows the reference photos. */
export const REFINE_MODEL = "fal:fal-ai/nano-banana/edit";

/** Colour words (Vietnamese + English) → a print-friendly hex. Longer names first so "xanh lá" wins over "xanh". */
const COLOURS: Array<[string, string]> = [
  ["xanh lá cây", "#43a047"],
  ["xanh lá", "#43a047"],
  ["xanh dương", "#1e88e5"],
  ["xanh biển", "#1e88e5"],
  ["xanh da trời", "#64b5f6"],
  ["xanh ngọc", "#26c6b0"],
  ["xanh navy", "#1a237e"],
  ["xanh mint", "#8fd9c4"],
  ["vàng gold", "#d4af37"],
  ["vàng kim", "#d4af37"],
  ["light blue", "#64b5f6"],
  ["dark blue", "#1a237e"],
  ["navy", "#1a237e"],
  ["mint", "#8fd9c4"],
  ["teal", "#26a69a"],
  ["green", "#43a047"],
  ["blue", "#1e88e5"],
  ["sky", "#8cc8f2"],
  ["red", "#e53935"],
  ["orange", "#fb8c00"],
  ["yellow", "#fdd835"],
  ["gold", "#d4af37"],
  ["purple", "#8e24aa"],
  ["violet", "#8e24aa"],
  ["lavender", "#c3a6f0"],
  ["pink", "#f48fb1"],
  ["coral", "#f4978e"],
  ["brown", "#795548"],
  ["beige", "#e8d8b9"],
  ["black", "#212121"],
  ["white", "#fafafa"],
  ["grey", "#9e9e9e"],
  ["gray", "#9e9e9e"],
  ["silver", "#c0c0c0"],
  ["đỏ", "#e53935"],
  ["cam", "#fb8c00"],
  ["vàng", "#fdd835"],
  ["tím", "#8e24aa"],
  ["hồng", "#f48fb1"],
  ["nâu", "#795548"],
  ["đen", "#212121"],
  ["trắng", "#fafafa"],
  ["xám", "#9e9e9e"],
  ["bạc", "#c0c0c0"],
  ["be", "#e8d8b9"],
  ["xanh", "#1e88e5"],
];

/** Words that only frame a colour request ("đổi sang màu xanh lá", "make it red"). */
const FILLER = new Set([
  "đổi", "doi", "sang", "thành", "thanh", "màu", "mau", "lại", "cho", "nó", "này", "ảnh", "hình", "toàn", "bộ", "thân",
  "change", "to", "make", "it", "color", "colour", "recolor", "recolour", "the", "into", "body", "a", "an",
]);

/**
 * The colour when `text` asks for nothing but a colour ("đổi màu xanh lá", "#ff8800", "make it pink"), else
 * null — anything more (a shape, a part, "hơn", a second colour) needs the AI edit.
 */
export function colourOnly(text: string): string | null {
  const t = text.trim().toLowerCase();
  if (!t || t.length > 60) return null;
  const hex = /#(?:[0-9a-f]{3}|[0-9a-f]{6})\b/.exec(t);
  let rest = t;
  let colour: string | null = null;
  if (hex) {
    colour = hex[0];
    rest = rest.replace(hex[0], " ");
  } else {
    for (const [name, value] of COLOURS) {
      const re = new RegExp(`(^|[^\\p{L}])${name}(?=$|[^\\p{L}])`, "u");
      if (re.test(rest)) {
        colour = value;
        rest = rest.replace(re, "$1 ");
        break;
      }
    }
  }
  if (!colour) return null;
  const left = rest.split(/[^\p{L}\p{N}]+/u).filter((w) => w && !FILLER.has(w));
  return left.length === 0 ? colour : null;
}

/** One-click colours for a free recolour (the studio variant template's standard palette). */
export const QUICK_PALETTE: Array<{ name: string; hex: string }> = [
  { name: "white", hex: "#f4f1ea" },
  { name: "yellow", hex: "#f6d77a" },
  { name: "pink", hex: "#f7a8d8" },
  { name: "coral", hex: "#f4978e" },
  { name: "red", hex: "#e53935" },
  { name: "green", hex: "#a8e6a1" },
  { name: "mint", hex: "#8fd9c4" },
  { name: "sky", hex: "#8cc8f2" },
  { name: "blue", hex: "#1e88e5" },
  { name: "lavender", hex: "#c3a6f0" },
  { name: "charcoal", hex: "#5b5b66" },
];

/**
 * A clipart for the refine analysis: on white, ≤768 px, with its number in a black badge top-left — the
 * same number the dialog shows on its card, so "hình 1" means the same image to the editor and the AI.
 */
export async function numberedImage(url: string, n: number): Promise<Blob> {
  const raw = await fetch(url).then((r) => r.blob());
  const bmp = await createImageBitmap(raw);
  const k = Math.min(1, 768 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bmp.width * k));
  c.height = Math.max(1, Math.round(bmp.height * k));
  const g = c.getContext("2d");
  if (!g) throw new Error("Canvas không khả dụng");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const r = Math.round(Math.min(c.width, c.height) * 0.07);
  g.fillStyle = "#000";
  g.beginPath();
  g.arc(r + 8, r + 8, r, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#fff";
  g.font = `bold ${Math.round(r * 1.2)}px sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(`#${n}`, r + 8, r + 9);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("Không đọc được ảnh"))), "image/jpeg", 0.9));
}
