/**
 * Browser-side image clean-up for AI outputs.
 *
 * Most image models (Gemini included) cannot emit an alpha channel, so sub
 * objects are generated on a flat backdrop and cut out here:
 *
 *   removeBackground  flood-fills from the image border, so only backdrop
 *                     CONNECTED to the edge goes transparent — white eyes or
 *                     highlights inside the object survive, unlike a global
 *                     colour key.
 *   trimTransparent   crops to the opaque content, so a sub object's contain
 *                     fit inside its region is driven by the object, not by
 *                     empty margin.
 */

import { loadImage } from "./compositor";

export interface RemoveBackgroundOptions {
  /** 0–255 per-channel distance from the sampled backdrop colour. */
  tolerance: number;
  /** Width (px) of the soft edge ramp. */
  feather: number;
}

function sampleBackdrop(data: Uint8ClampedArray, w: number, h: number): [number, number, number] {
  // Median of the four corners' 4x4 blocks — robust to one stray corner.
  const samples: Array<[number, number, number]> = [];
  const corners: Array<[number, number]> = [
    [0, 0],
    [w - 4, 0],
    [0, h - 4],
    [w - 4, h - 4],
  ];
  for (const [cx, cy] of corners) {
    for (let y = Math.max(0, cy); y < Math.min(h, cy + 4); y++) {
      for (let x = Math.max(0, cx); x < Math.min(w, cx + 4); x++) {
        const i = (y * w + x) * 4;
        samples.push([data[i], data[i + 1], data[i + 2]]);
      }
    }
  }
  const median = (k: 0 | 1 | 2) => {
    const v = samples.map((s) => s[k]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)] ?? 255;
  };
  return [median(0), median(1), median(2)];
}

export async function removeBackground(url: string, opts: RemoveBackgroundOptions): Promise<HTMLCanvasElement> {
  return removeBackgroundFrom(await loadImage(url), opts);
}

/** Same as removeBackground, for an image already in memory (a decoded blob, a canvas). */
export function removeBackgroundFrom(img: HTMLImageElement | HTMLCanvasElement, opts: RemoveBackgroundOptions): HTMLCanvasElement {
  const w = img instanceof HTMLImageElement ? img.naturalWidth : img.width;
  const h = img instanceof HTMLImageElement ? img.naturalHeight : img.height;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D không khả dụng");
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, w, h);
  const d = imageData.data;
  const [br, bg, bb] = sampleBackdrop(d, w, h);

  const dist = (i: number) => Math.max(Math.abs(d[i] - br), Math.abs(d[i + 1] - bg), Math.abs(d[i + 2] - bb));

  // BFS from every border pixel that matches the backdrop.
  const visited = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  const push = (p: number) => {
    if (visited[p]) return;
    if (dist(p * 4) > opts.tolerance) return;
    visited[p] = 1;
    queue[tail++] = p;
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (head < tail) {
    const p = queue[head++];
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w);
    if (y < h - 1) push(p + w);
  }

  // Hard cut, then a distance-based feather on the boundary.
  for (let p = 0; p < w * h; p++) if (visited[p]) d[p * 4 + 3] = 0;

  const feather = Math.max(0, Math.round(opts.feather));
  if (feather > 0) {
    // Distance (in px, chessboard metric) from each kept pixel to the cut, capped at feather.
    const far = feather + 1;
    const distMap = new Uint8Array(w * h).fill(far);
    for (let p = 0; p < w * h; p++) if (visited[p]) distMap[p] = 0;
    for (let pass = 0; pass < feather; pass++) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const p = y * w + x;
          if (distMap[p] <= pass) continue;
          const n =
            (x > 0 && distMap[p - 1] === pass) ||
            (x < w - 1 && distMap[p + 1] === pass) ||
            (y > 0 && distMap[p - w] === pass) ||
            (y < h - 1 && distMap[p + w] === pass);
          if (n) distMap[p] = pass + 1;
        }
      }
    }
    for (let p = 0; p < w * h; p++) {
      const k = distMap[p];
      if (k === 0 || k === far) continue;
      // Pixels near the cut that still look like backdrop fade more.
      const closeness = 1 - Math.min(1, dist(p * 4) / Math.max(1, opts.tolerance * 2));
      const alpha = (k / (feather + 1)) * (1 - closeness * 0.6);
      d[p * 4 + 3] = Math.round(d[p * 4 + 3] * Math.min(1, alpha + 0.15));
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

export function trimTransparent(src: HTMLCanvasElement, padding = 4): HTMLCanvasElement {
  const ctx = src.getContext("2d", { willReadFrequently: true });
  if (!ctx) return src;
  const { width: w, height: h } = src;
  const d = ctx.getImageData(0, 0, w, h).data;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return src;
  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = Math.min(w - 1, maxX + padding);
  maxY = Math.min(h - 1, maxY + padding);
  const out = document.createElement("canvas");
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext("2d")?.drawImage(src, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

export async function trimUrl(url: string, padding = 4): Promise<HTMLCanvasElement> {
  const img = await loadImage(url);
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext("2d")?.drawImage(img, 0, 0);
  return trimTransparent(c, padding);
}
