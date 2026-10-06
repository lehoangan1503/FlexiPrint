/**
 * Customer photo → rendered photo, in the browser. Shared by the editor's
 * "try a photo" box and the storefront photo dialog, so both show the same
 * result:
 *
 *   1. shrink to PROCESS_MAX_PX (phone photos are 12 MP; models want ~1K) —
 *      Face styles keep the photo as uploaded (up to FACE_PROCESS_MAX_PX, the
 *      storefront's own upload size): the face is a small part of it, and the
 *      cut comes back at the photo's resolution to stay sharp in its frame
 *   2. server (only when needed): AI restyle and/or subject cut-out
 *   3. key out a flat white backdrop if the server says one is left
 *   4. cut-out → fade the subject out where the photo frame crops it, so it
 *      melts into the product art instead of ending in a straight line
 *   5. cut-out → trim to the subject, so the zone's fit is driven by it
 *   6. "pixel" → local pixel-art filter
 */

import type { CtPhotoStyleRef } from "../types";
import { canvasToBlob } from "./compositor";
import { removeBackgroundFrom, trimTransparent } from "./image-tools";
import { needsServer, styleEngine, styleFamily, styleFilter, type CtPhotoFilter } from "./photo-styles";

const isFaceStyle = (style: CtPhotoStyleRef) => styleFamily(style) === "face";

const PROCESS_MAX_PX = 1600;
/** Face styles: the whole upload (storefront PHOTO_MAX_PX) — the face is cut at full resolution, never scaled down. */
const FACE_PROCESS_MAX_PX = 3000;

export interface PhotoProcessRequest {
  source: Blob;
  style: CtPhotoStyleRef;
  cutout: boolean;
  /** With cutout: soften where the photo frame crops the subject (CtPhotoConfig.fadeCrop). */
  fadeCrop?: boolean;
  /** POST endpoint of the server step (public/photo/:id or products/:id/photo). */
  endpoint: string;
  /** Extra multipart fields (the storefront sends its region id). */
  fields?: Record<string, string>;
  signal?: AbortSignal;
}

async function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toCanvas(img: HTMLImageElement | HTMLCanvasElement, maxPx = Infinity): HTMLCanvasElement {
  const w = img instanceof HTMLImageElement ? img.naturalWidth : img.width;
  const h = img instanceof HTMLImageElement ? img.naturalHeight : img.height;
  const k = Math.min(1, maxPx / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D unavailable");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function hasAlpha(c: HTMLCanvasElement): boolean {
  const d = c.getContext("2d", { willReadFrequently: true })?.getImageData(0, 0, c.width, c.height).data;
  if (!d) return false;
  for (let i = 3; i < d.length; i += 16) if (d[i] < 250) return true;
  return false;
}

/** Downscale big phone photos (keeps PNG transparency). */
export async function shrinkImage(file: Blob, maxPx: number): Promise<Blob> {
  const img = await blobToImage(file);
  const k = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
  if (k === 1 && file.size < 8 * 1024 * 1024) return file;
  const c = toCanvas(img, maxPx);
  return canvasToBlob(c, file.type === "image/png" ? "image/png" : "image/jpeg", 0.92);
}

async function serverStep(req: PhotoProcessRequest, input: Blob): Promise<HTMLCanvasElement> {
  const body = new FormData();
  body.append("file", input, input.type === "image/png" ? "photo.png" : "photo.jpg");
  body.append("style", req.style);
  body.append("cutout", req.cutout ? "1" : "0");
  for (const [k, v] of Object.entries(req.fields ?? {})) body.append(k, v);
  const res = await fetch(req.endpoint, { method: "POST", body, mode: "cors", signal: req.signal });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(json.error ?? `HTTP ${res.status}`);
  }
  const backdrop = res.headers.get("X-Ct-Backdrop");
  const canvas = toCanvas(await blobToImage(await res.blob()));
  return backdrop === "white" ? removeBackgroundFrom(canvas, { tolerance: 26, feather: 2 }) : canvas;
}

export async function processPhoto(req: PhotoProcessRequest): Promise<Blob> {
  const input = await shrinkImage(req.source, isFaceStyle(req.style) ? FACE_PROCESS_MAX_PX : PROCESS_MAX_PX);
  let canvas = needsServer(req.style, req.cutout) ? await serverStep(req, input) : toCanvas(await blobToImage(input));
  // Face styles end at the jaw on purpose (services/face-detect): no fade into a body that isn't there.
  if (req.cutout && req.fadeCrop && !isFaceStyle(req.style)) canvas = fadeCroppedEdges(canvas);
  if (req.cutout) canvas = trimTransparent(canvas, 2);
  if (styleEngine(req.style) === "local") canvas = pixelArt(canvas, { cells: 170, colors: 64 });
  const filter = styleFilter(req.style);
  if (filter) canvas = colorFilter(canvas, filter);
  return hasAlpha(canvas) ? canvasToBlob(canvas, "image/png") : canvasToBlob(canvas, "image/jpeg", 0.92);
}

/** A colour filter on a processed photo (alpha kept): the Face filters all start from one "Real face" cut. */
export async function filterBlob(blob: Blob, filter: CtPhotoFilter): Promise<Blob> {
  const canvas = colorFilter(toCanvas(await blobToImage(blob)), filter);
  return hasAlpha(canvas) ? canvasToBlob(canvas, "image/png") : canvasToBlob(canvas, "image/jpeg", 0.92);
}

// ---------------------------------------------------------------------------
// Colour filters (Face styles)
// ---------------------------------------------------------------------------

/**
 * Per-pixel, alpha kept. Done by hand rather than with ctx.filter, which
 * Safari's canvas ignores.
 */
export function colorFilter(src: HTMLCanvasElement, filter: CtPhotoFilter): HTMLCanvasElement {
  const ctx = src.getContext("2d", { willReadFrequently: true });
  if (!ctx) return src;
  const img = ctx.getImageData(0, 0, src.width, src.height);
  const d = img.data;
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    if (filter === "bw") {
      // A touch of contrast so it reads as a print, not a washed-out grey.
      const v = clamp((y - 128) * 1.1 + 128);
      d[i] = v;
      d[i + 1] = v;
      d[i + 2] = v;
    } else if (filter === "sepia") {
      d[i] = clamp(0.393 * r + 0.769 * g + 0.189 * b);
      d[i + 1] = clamp(0.349 * r + 0.686 * g + 0.168 * b);
      d[i + 2] = clamp(0.272 * r + 0.534 * g + 0.131 * b);
    } else if (filter === "warm") {
      // Golden-hour: lift reds, a little green, pull blue down.
      d[i] = clamp(r * 1.08 + 12);
      d[i + 1] = clamp(g * 1.02 + 4);
      d[i + 2] = clamp(b * 0.86);
    } else {
      // Vivid: +35% saturation around the luma, +8% contrast.
      const sat = (c: number) => clamp(((y + (c - y) * 1.35) - 128) * 1.08 + 128);
      d[i] = sat(r);
      d[i + 1] = sat(g);
      d[i + 2] = sat(b);
    }
  }
  ctx.putImageData(img, 0, 0);
  return src;
}

// ---------------------------------------------------------------------------
// Cropped-edge fade
// ---------------------------------------------------------------------------

/**
 * A cut-out whose body runs off the photo (the usual pet portrait: chest cut
 * by the bottom of the frame) would end in a ruler-straight line. Fade it out
 * toward every photo edge the subject actually touches, over ~12% of the
 * image. The reach wanders slowly and is broken up by bristle-width streaks
 * running into the edge, so it ends like the tail of a brush stroke rather
 * than a straight gradient. Edges the subject doesn't touch are left alone, so ears
 * near the top are never faded.
 */
export function fadeCroppedEdges(src: HTMLCanvasElement): HTMLCanvasElement {
  const w = src.width;
  const h = src.height;
  const ctx = src.getContext("2d", { willReadFrequently: true });
  if (!ctx || w < 8 || h < 8) return src;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const alphaAt = (x: number, y: number) => d[(y * w + x) * 4 + 3];

  let top = 0;
  let bottom = 0;
  let left = 0;
  let right = 0;
  for (let x = 0; x < w; x++) {
    if (alphaAt(x, 0) > 128) top++;
    if (alphaAt(x, h - 1) > 128) bottom++;
  }
  for (let y = 0; y < h; y++) {
    if (alphaAt(0, y) > 128) left++;
    if (alphaAt(w - 1, y) > 128) right++;
  }
  // A few stray pixels (a whisker tip) don't count as a crop.
  const cropped = { top: top > w * 0.04, bottom: bottom > w * 0.04, left: left > h * 0.04, right: right > h * 0.04 };
  if (!cropped.top && !cropped.bottom && !cropped.left && !cropped.right) return src;

  const size = Math.min(w, h);
  const reach = Math.max(10, size * 0.12);
  // Smooth, deterministic wobble of the reach along an edge (0.7..1.3).
  const wobble = (t: number, seed: number) => {
    const u = (t / size) * Math.PI * 2;
    return 1 + 0.18 * Math.sin(u * 2.3 + seed) + 0.12 * Math.sin(u * 5.7 + seed * 1.7);
  };
  // Deterministic value noise along an edge: brush-width clumps (~2% of the image) plus finer bristles.
  const bristle = Math.max(3, size * 0.02);
  const hash = (i: number, seed: number) => {
    const v = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
    return v - Math.floor(v);
  };
  const octave = (t: number, seed: number) => {
    const p = t / bristle;
    const i = Math.floor(p);
    const f = p - i;
    const a = hash(i, seed);
    return a + (hash(i + 1, seed) - a) * f * f * (3 - 2 * f);
  };
  const streaks = (t: number, seed: number) => 0.65 * octave(t, seed) + 0.35 * octave(t * 2.9, seed + 7);
  const ease = (e: number) => (e >= 1 ? 1 : e <= 0 ? 0 : e * e * (3 - 2 * e));
  const rowTop = new Float32Array(w);
  const rowBottom = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    rowTop[x] = reach * wobble(x, 1.3) * (0.8 + 0.4 * streaks(x, 1.3));
    rowBottom[x] = reach * wobble(x, 4.1) * (0.8 + 0.4 * streaks(x, 4.1));
  }
  const colLeft = new Float32Array(h);
  const colRight = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    colLeft[y] = reach * wobble(y, 2.2) * (0.8 + 0.4 * streaks(y, 2.2));
    colRight[y] = reach * wobble(y, 5.9) * (0.8 + 0.4 * streaks(y, 5.9));
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4 + 3;
      if (d[i] === 0) continue;
      let f = 1;
      if (cropped.top) f = Math.min(f, ease(y / rowTop[x]));
      if (cropped.bottom) f = Math.min(f, ease((h - 1 - y) / rowBottom[x]));
      if (cropped.left) f = Math.min(f, ease(x / colLeft[y]));
      if (cropped.right) f = Math.min(f, ease((w - 1 - x) / colRight[y]));
      if (f < 1) d[i] = Math.round(d[i] * f);
    }
  }
  ctx.putImageData(img, 0, 0);
  return src;
}

// ---------------------------------------------------------------------------
// Pixel art
// ---------------------------------------------------------------------------

export interface PixelArtOptions {
  /** Cells along the long side. */
  cells: number;
  /** Palette size (k-means over the downsampled cells). */
  colors: number;
}

/**
 * Downsample to a cell grid, reduce to a small palette, harden alpha, then
 * upscale with nearest-neighbour. No outline around the silhouette.
 */
export function pixelArt(src: HTMLCanvasElement, opts: PixelArtOptions): HTMLCanvasElement {
  const k = opts.cells / Math.max(src.width, src.height);
  const gw = Math.max(1, Math.round(src.width * k));
  const gh = Math.max(1, Math.round(src.height * k));
  const small = document.createElement("canvas");
  small.width = gw;
  small.height = gh;
  const sctx = small.getContext("2d", { willReadFrequently: true });
  if (!sctx) return src;
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(src, 0, 0, gw, gh);
  const img = sctx.getImageData(0, 0, gw, gh);
  const d = img.data;
  const n = gw * gh;
  sharpenCells(d, gw, gh, 0.6);

  // Pixel art has no half-transparent pixels: soft alpha (a faded crop, fur
  // edges) becomes an ordered 4x4 Bayer dither, the classic sprite fade.
  const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const solid = new Uint8Array(n);
  const firm = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    const a = d[p * 4 + 3];
    const x = p % gw;
    const y = (p - x) / gw;
    // Dither only across the middle of the alpha range: a faded crop gets a short
    // checkerboard band, while faint fringes (whiskers, fur halo) simply drop out.
    const threshold = 0.35 + 0.4 * ((bayer[(y % 4) * 4 + (x % 4)] + 0.5) / 16);
    solid[p] = a / 255 > threshold ? 1 : 0;
    firm[p] = a >= 200 ? 1 : 0;
  }
  // A pixel can't be half transparent, so a faded cell would show its full (darker)
  // colour; tint it toward paper-white by how faded it was, keeping the fade's lightness.
  for (let p = 0; p < n; p++) {
    const fade = 1 - d[p * 4 + 3] / 255;
    if (!solid[p] || fade <= 0) continue;
    const k = fade * 0.75;
    for (let c = 0; c < 3; c++) d[p * 4 + c] = Math.round(d[p * 4 + c] * (1 - k) + 255 * k);
  }
  // Drop lone cells (fewer than 2 solid neighbours): specks, not sprite pixels.
  const lone: number[] = [];
  for (let p = 0; p < n; p++) {
    if (!solid[p] || firm[p]) continue;
    const x = p % gw;
    let c = 0;
    if (x > 0 && solid[p - 1]) c++;
    if (x < gw - 1 && solid[p + 1]) c++;
    if (p >= gw && solid[p - gw]) c++;
    if (p + gw < n && solid[p + gw]) c++;
    if (c < 2) lone.push(p);
  }
  for (const p of lone) solid[p] = 0;

  // Palette from the photo's own colours, brightened a touch like the other art styles.
  // (k-means centres are averages, so they come out muddier than the photo — lift and re-saturate.)
  const lift = (v: number) => 0.04 + Math.pow(Math.min(1, Math.max(0, v)), 0.78) * 0.96;
  const palette = kMeans(d, solid, opts.colors).map((c): Rgb => {
    const r = c[0] / 255;
    const g = c[1] / 255;
    const b = c[2] / 255;
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    const sat = (v: number) => lift(l + (v - l) * 1.2);
    return [Math.round(sat(r) * 255), Math.round(sat(g) * 255), Math.round(sat(b) * 255)];
  });
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (!solid[p]) {
      d[i + 3] = 0;
      continue;
    }
    const c = nearest(palette, d[i], d[i + 1], d[i + 2]);
    d[i] = c[0];
    d[i + 1] = c[1];
    d[i + 2] = c[2];
    d[i + 3] = 255;
  }

  sctx.putImageData(img, 0, 0);

  const scale = Math.max(1, Math.round(1024 / Math.max(gw, gh)));
  const out = document.createElement("canvas");
  out.width = gw * scale;
  out.height = gh * scale;
  const octx = out.getContext("2d");
  if (!octx) return src;
  octx.imageSmoothingEnabled = false;
  octx.drawImage(small, 0, 0, out.width, out.height);
  return out;
}

type Rgb = [number, number, number];

/**
 * Unsharp mask on the cell grid. Averaging a photo down to ~170 cells melts
 * pupils, stripes and whiskers into their surroundings; pushing each cell
 * away from its neighbourhood mean brings that contrast back. The blur is
 * alpha-weighted so transparent (black) pixels don't darken the silhouette.
 */
function sharpenCells(d: Uint8ClampedArray, w: number, h: number, amount: number): void {
  const src = new Float32Array(d);
  const kernel = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (src[i + 3] === 0) continue;
      let r = 0;
      let g = 0;
      let b = 0;
      let wsum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const j = (yy * w + xx) * 4;
          const k = kernel[(dy + 1) * 3 + dx + 1] * (src[j + 3] / 255);
          r += src[j] * k;
          g += src[j + 1] * k;
          b += src[j + 2] * k;
          wsum += k;
        }
      }
      if (wsum <= 0) continue;
      d[i] = src[i] + amount * (src[i] - r / wsum);
      d[i + 1] = src[i + 1] + amount * (src[i + 1] - g / wsum);
      d[i + 2] = src[i + 2] + amount * (src[i + 2] - b / wsum);
    }
  }
}

function nearest(palette: Rgb[], r: number, g: number, b: number): Rgb {
  let best = palette[0];
  let bestD = Infinity;
  for (const c of palette) {
    const dd = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
    if (dd < bestD) {
      bestD = dd;
      best = c;
    }
  }
  return best;
}

function kMeans(d: Uint8ClampedArray, solid: Uint8Array, k: number): Rgb[] {
  const pts: Rgb[] = [];
  for (let p = 0; p < solid.length; p++) if (solid[p]) pts.push([d[p * 4], d[p * 4 + 1], d[p * 4 + 2]]);
  if (pts.length === 0) return [[0, 0, 0]];
  // Deterministic seeds spread over the brightness range, so the same photo always pixelates the same.
  const sorted = [...pts].sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
  const count = Math.min(k, pts.length);
  let centers: Rgb[] = Array.from({ length: count }, (_, i) => [...sorted[Math.floor(((i + 0.5) / count) * sorted.length)]] as Rgb);
  for (let iter = 0; iter < 8; iter++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (const q of pts) {
      let bi = 0;
      let bd = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const dd = (centers[c][0] - q[0]) ** 2 + (centers[c][1] - q[1]) ** 2 + (centers[c][2] - q[2]) ** 2;
        if (dd < bd) {
          bd = dd;
          bi = c;
        }
      }
      const s = sums[bi];
      s[0] += q[0];
      s[1] += q[1];
      s[2] += q[2];
      s[3]++;
    }
    centers = centers.map((c, i) => (sums[i][3] ? [sums[i][0] / sums[i][3], sums[i][1] / sums[i][3], sums[i][2] / sums[i][3]] : c));
  }
  return centers.map((c) => [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])]);
}
