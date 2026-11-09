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
import { keyOutBackdrop, opaqueBox, type RemoveBackgroundOptions } from "./pixel-ops";

export type { RemoveBackgroundOptions };

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
  keyOutBackdrop(imageData.data, w, h, opts);
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

export function trimTransparent(src: HTMLCanvasElement, padding = 4): HTMLCanvasElement {
  const ctx = src.getContext("2d", { willReadFrequently: true });
  if (!ctx) return src;
  const box = opaqueBox(ctx.getImageData(0, 0, src.width, src.height).data, src.width, src.height, padding);
  if (!box) return src;
  const { x: minX, y: minY } = box;
  const out = document.createElement("canvas");
  out.width = box.w;
  out.height = box.h;
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
