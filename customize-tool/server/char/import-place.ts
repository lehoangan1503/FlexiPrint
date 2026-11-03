/**
 * A small piece of an imported folder put in its place on a whole canvas (asked 2026-11-04: the gingerbread train's
 * 8 characters are 328×418 pieces, each seat of each version places them at its own spot and size). The build stores
 * the placed canvas, so every clipart stays whole-canvas and pixel-registered like the rest of the set.
 */

import sharp from "sharp";
import type { CtCharImportBox } from "../../types";

/** `png` stretched to the box, turned about its centre, on a transparent W × H canvas (what falls outside is cut). */
export async function placePiece(png: Buffer, box: CtCharImportBox, W: number, H: number): Promise<Buffer> {
  const w = Math.max(1, Math.round(box.w));
  const h = Math.max(1, Math.round(box.h));
  let pic = await sharp(png).ensureAlpha().resize(w, h, { fit: "fill", kernel: "lanczos3" }).png().toBuffer();
  let left = Math.round(box.x);
  let top = Math.round(box.y);
  if (box.angle) {
    pic = await sharp(pic).rotate(box.angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    const m = await sharp(pic).metadata();
    left = Math.round(box.x + box.w / 2 - (m.width ?? w) / 2);
    top = Math.round(box.y + box.h / 2 - (m.height ?? h) / 2);
  }
  const m = await sharp(pic).metadata();
  const pw = m.width ?? w;
  const ph = m.height ?? h;
  // sharp composites only inside the base: the part of the piece on the canvas is cut out first.
  const x0 = Math.max(0, left);
  const y0 = Math.max(0, top);
  const x1 = Math.min(W, left + pw);
  const y1 = Math.min(H, top + ph);
  const canvas = sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
  if (x1 <= x0 || y1 <= y0) return canvas.png().toBuffer();
  const part = await sharp(pic).extract({ left: x0 - left, top: y0 - top, width: x1 - x0, height: y1 - y0 }).png().toBuffer();
  return canvas.composite([{ input: part, left: x0, top: y0 }]).png().toBuffer();
}
