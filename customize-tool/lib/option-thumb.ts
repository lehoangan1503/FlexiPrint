/**
 * An option's thumbnail, big and centred (asked 2026-10-10): a layer's option is a full-canvas file with the part
 * somewhere in it (a dress at the bottom left, a glass up high) — shown as it is, the part is a speck in the tile.
 * Here the picture is cropped to its own visible pixels (alpha) with a little margin, so the tile shows the part
 * filling it, centred. Only the tile: the asset, its box on the canvas and the print are untouched.
 *
 * Browser only (canvas), shared by the editor (OptionThumb) and the storefront's option tiles. One crop per url,
 * cached; a picture whose pixels cannot be read (no CORS) keeps its own url.
 */

const TILE = 256;
/** Margin around the part, as a share of its larger side. */
const MARGIN = 0.08;
/** Below this alpha a pixel is not part of the picture (soft shadows, stray specks). */
const ALPHA_MIN = 24;

const cache = new Map<string, Promise<string>>();

function load(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`ảnh ${url}`));
    img.src = url;
  });
}

/** The visible box of `img` in its own px (read on a small copy), or null when it is empty / unreadable. */
function alphaBox(img: HTMLImageElement): { x: number; y: number; w: number; h: number } | null {
  const k = Math.min(1, 512 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * k));
  const h = Math.max(1, Math.round(img.naturalHeight * k));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] < ALPHA_MIN) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  if (x1 < 0) return null;
  return { x: x0 / k, y: y0 / k, w: (x1 - x0 + 1) / k, h: (y1 - y0 + 1) / k };
}

async function crop(url: string): Promise<string> {
  try {
    const img = await load(url);
    const b = alphaBox(img);
    if (!b) return url;
    const side = Math.max(b.w, b.h) * (1 + 2 * MARGIN);
    const c = document.createElement("canvas");
    c.width = TILE;
    c.height = TILE;
    const ctx = c.getContext("2d");
    if (!ctx) return url;
    ctx.imageSmoothingQuality = "high";
    const k = TILE / side;
    ctx.drawImage(img, b.x, b.y, b.w, b.h, (TILE - b.w * k) / 2, (TILE - b.h * k) / 2, b.w * k, b.h * k);
    return c.toDataURL("image/png");
  } catch {
    // Unreadable (tainted canvas, failed load): the picture as it is.
    return url;
  }
}

/** The centred, cropped tile picture of `url` (a data url), or `url` itself when it cannot be read. */
export function optionThumb(url: string): Promise<string> {
  let p = cache.get(url);
  if (!p) {
    p = crop(url);
    cache.set(url, p);
  }
  return p;
}
