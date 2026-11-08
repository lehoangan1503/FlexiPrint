/**
 * Where a layer's pictures really have pixels (2026-11-08). A clipart file is often a full-canvas frame (as big as
 * the artwork) with the part somewhere inside it — its layer box then reaches the canvas edges although every visible
 * pixel sits well inside the safe zone. The safe-zone warning must look at the ink, not at the frame.
 *
 * Pure: the picture reader is passed in (components/editor/use-layer-ink = canvas, server/print-render = sharp). The layer's ink = the union of every
 * option it can show, each placed like the compositor draws it (contain-fit + item transform + rendition pad).
 */

import type { CtAsset, CtBounds, CtRegion, CtRegionItem } from "../types";
import { itemPlacement, shapeBounds } from "./geometry";
import { normalizeRegion, regionChoices } from "./design";

/** A picture's natural size and its visible box as shares of it (0..1); box null = nothing visible. */
export interface CtImageInk {
  width: number;
  height: number;
  box: CtBounds | null;
}

/** Reads one picture's ink (browser: canvas, server: sharp); null = unreadable. */
export type CtInkReader = (url: string) => Promise<CtImageInk | null>;

/** Below this alpha a pixel is not ink (soft shadows, stray specks) — same as the option tiles. */
export const INK_ALPHA_MIN = 24;

/** The visible box (shares 0..1) of a w×h alpha / RGBA raster; null = empty. */
export function inkBoxOfPixels(data: Uint8Array | Uint8ClampedArray, w: number, h: number, channels: number, alphaAt: number): CtBounds | null {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * channels + alphaAt] < INK_ALPHA_MIN) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  if (x1 < 0) return null;
  return { x: x0 / w, y: y0 / h, w: (x1 - x0 + 1) / w, h: (y1 - y0 + 1) / h };
}

function union(a: CtBounds | null, b: CtBounds): CtBounds {
  if (!a) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function intersect(a: CtBounds, b: CtBounds): CtBounds | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/**
 * The canvas box of a layer's visible pixels over all its options.
 * undefined = not an image layer / a picture could not be read (use the frame); null = nothing visible at all.
 */
export async function regionInkBounds(region: CtRegion, items: CtRegionItem[], assets: CtAsset[], read: CtInkReader): Promise<CtBounds | null | undefined> {
  if (region.kind !== "image") return undefined;
  const r = normalizeRegion(region);
  const frame = shapeBounds(r.shape);
  // A fill (pattern / cover) paints its whole outline.
  if (r.config.fill) return frame;
  const choices = regionChoices(r, items, assets);
  if (!choices.length) return undefined;
  const inks = await Promise.all(choices.map((c) => read(c.asset.url)));
  let out: CtBounds | null = null;
  for (let i = 0; i < choices.length; i++) {
    const ink = inks[i];
    if (!ink) return undefined;
    if (!ink.box) continue;
    const pad = choices[i].asset.meta?.pad;
    const kx = 1 + 2 * (pad?.x ?? 0);
    const ky = 1 + 2 * (pad?.y ?? 0);
    const p = itemPlacement(frame, ink.width / kx, ink.height / ky, choices[i].item.transform, "contain");
    const dw = p.w * kx;
    const dh = p.h * ky;
    // The ink box in the drawn picture, around its centre, then turned with it.
    const lx = -dw / 2 + ink.box.x * dw;
    const ly = -dh / 2 + ink.box.y * dh;
    const corners = [
      [lx, ly],
      [lx + ink.box.w * dw, ly],
      [lx, ly + ink.box.h * dh],
      [lx + ink.box.w * dw, ly + ink.box.h * dh],
    ];
    const a = (p.rotation * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const xs = corners.map(([x, y]) => p.cx + x * cos - y * sin);
    const ys = corners.map(([x, y]) => p.cy + x * sin + y * cos);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    out = union(out, { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 });
  }
  if (!out) return null;
  return r.config.clip ? intersect(out, frame) : out;
}
