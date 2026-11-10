/**
 * The colour a clipart "is" (asked 2026-11-10: a helmet option shown to customers as a square of the helmet's
 * colour, not the helmet). Browser only (canvas).
 *
 * The picture is read small; transparent pixels are skipped; the rest go into a coarse colour histogram where each
 * pixel weighs by how colourful it is — so the red shell of a helmet wins over its white goggles, grey outline and
 * brown strap. A picture with no real colour (white, black, grey cliparts) falls back to its most common shade.
 */

const SIZE = 64;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Không đọc được ảnh ${url}`));
    img.src = url;
  });
}

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

interface Bin {
  weight: number;
  r: number;
  g: number;
  b: number;
  n: number;
}

/** "#rrggbb" of the clipart at `url`. */
export async function dominantColor(url: string): Promise<string> {
  const img = await loadImage(url);
  const k = Math.min(1, SIZE / Math.max(img.naturalWidth, img.naturalHeight, 1));
  const w = Math.max(1, Math.round(img.naturalWidth * k));
  const h = Math.max(1, Math.round(img.naturalHeight * k));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D không khả dụng");
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;

  const colourful = new Map<number, Bin>();
  const plain = new Map<number, Bin>();
  const add = (map: Map<number, Bin>, key: number, weight: number, r: number, g: number, b: number) => {
    const bin = map.get(key) ?? { weight: 0, r: 0, g: 0, b: 0, n: 0 };
    bin.weight += weight;
    bin.r += r;
    bin.g += g;
    bin.b += b;
    bin.n += 1;
    map.set(key, bin);
  };
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 160) continue;
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    // 8 levels per channel: shades of one colour share a bin.
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    add(plain, key, 1, r, g, b);
    // Colourful and not too dark: the paint, not the outline or the shadow.
    if (sat > 0.25 && max > 60) add(colourful, key, sat * sat, r, g, b);
  }
  const best = (map: Map<number, Bin>) => [...map.values()].sort((a, c) => c.weight - a.weight)[0];
  const total = [...plain.values()].reduce((s, x) => s + x.n, 0);
  const paint = best(colourful);
  const bin = paint && paint.n >= total * 0.04 ? paint : best(plain);
  if (!bin) return "#cccccc";
  return hex(bin.r / bin.n, bin.g / bin.n, bin.b / bin.n);
}
