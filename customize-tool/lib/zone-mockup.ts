/**
 * Product photos that repaint named zones (types CtZoneMockup) — clothes, where a flat print file cannot simply be
 * laid on the photo: each zone's outline on the photo is filled with the pattern the customer picked for that zone
 * of the khuôn in, then the photo's own light and folds are multiplied back (its luminance against the zone's median),
 * so the trousers keep their creases. Patterns forgive the small stretch a curved surface has; pictures placed at
 * one spot of a garment would need a warp mesh (not here). Browser only; the storefront bundle imports it.
 */

import type { CtRegion, CtRenderAsset, CtSelection, CtShape, CtZoneMockup } from "../types";
import { loadImage } from "./compositor";
import { shapeBounds } from "./geometry";

export interface CtZoneFill {
  /** khuôn in zone id. */
  zone: string;
  url: string;
  mode: "tile" | "cover";
}

/** What each zone shows for a selection: the fill layers bound to a zone and the picture chosen in them. */
export function zoneFills(regions: CtRegion[], assets: CtRenderAsset[], selection: CtSelection): CtZoneFill[] {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const out: CtZoneFill[] = [];
  for (const r of [...regions].sort((a, b) => a.sort_order - b.sort_order)) {
    const fill = r.config?.fill;
    const sel = selection[r.id];
    if (!fill?.zone || r.kind !== "image" || sel?.kind !== "image" || !sel.assetId) continue;
    const asset = byId.get(sel.assetId);
    if (asset) out.push({ zone: fill.zone, url: asset.url, mode: fill.mode });
  }
  return out;
}

function trace(ctx: CanvasRenderingContext2D, s: CtShape, k: number): void {
  ctx.beginPath();
  if (s.type === "rect") ctx.rect(s.x * k, s.y * k, s.w * k, s.h * k);
  else if (s.type === "ellipse") ctx.ellipse(s.cx * k, s.cy * k, s.rx * k, s.ry * k, 0, 0, Math.PI * 2);
  else {
    s.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x * k, p.y * k) : ctx.lineTo(p.x * k, p.y * k)));
    ctx.closePath();
  }
}

/** The photo with every filled zone repainted; long side ≤ maxSide. */
export async function renderZoneMockup(m: CtZoneMockup, fills: CtZoneFill[], maxSide: number): Promise<HTMLCanvasElement> {
  const k = Math.min(1, maxSide / Math.max(m.width, m.height));
  const W = Math.max(1, Math.round(m.width * k));
  const H = Math.max(1, Math.round(m.height * k));
  const out = document.createElement("canvas");
  out.width = W;
  out.height = H;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  if (!ctx) return out;
  const photo = await loadImage(m.url);
  ctx.drawImage(photo, 0, 0, W, H);
  const original = ctx.getImageData(0, 0, W, H);

  for (const f of fills) {
    const shape = m.zones[f.zone];
    if (!shape) continue;
    const img = await loadImage(f.url).catch(() => null);
    if (!img) continue;
    const b = shapeBounds(shape);
    const x0 = Math.max(0, Math.floor(b.x * k));
    const y0 = Math.max(0, Math.floor(b.y * k));
    const x1 = Math.min(W, Math.ceil((b.x + b.w) * k));
    const y1 = Math.min(H, Math.ceil((b.y + b.h) * k));
    if (x1 <= x0 || y1 <= y0) continue;

    // The pattern inside the zone (on its own canvas, to read it back with the zone's mask).
    const layer = document.createElement("canvas");
    layer.width = W;
    layer.height = H;
    const lc = layer.getContext("2d", { willReadFrequently: true });
    if (!lc) continue;
    lc.save();
    trace(lc, shape, k);
    lc.clip();
    const iw = img.naturalWidth || 1;
    const ih = img.naturalHeight || 1;
    if (f.mode === "cover") {
      const s = Math.max((x1 - x0) / iw, (y1 - y0) / ih);
      lc.drawImage(img, x0 + (x1 - x0 - iw * s) / 2, y0 + (y1 - y0 - ih * s) / 2, iw * s, ih * s);
    } else {
      const tw = Math.max(4, m.tile * k);
      const th = (tw * ih) / iw;
      for (let y = y0; y < y1; y += th) for (let x = x0; x < x1; x += tw) lc.drawImage(img, x, y, tw, th);
    }
    lc.restore();

    // Shading: the photo's luminance in the zone against its median, multiplied over the pattern.
    const pat = lc.getImageData(x0, y0, x1 - x0, y1 - y0);
    const lum: number[] = [];
    const L = (i: number) => 0.299 * original.data[i] + 0.587 * original.data[i + 1] + 0.114 * original.data[i + 2];
    for (let y = y0; y < y1; y += 3)
      for (let x = x0; x < x1; x += 3) {
        const p = ((y - y0) * (x1 - x0) + (x - x0)) * 4;
        if (pat.data[p + 3] > 200) lum.push(L((y * W + x) * 4));
      }
    if (!lum.length) continue;
    lum.sort((a, b) => a - b);
    const med = Math.max(1, lum[Math.floor(lum.length / 2)]);
    const amount = m.shading;
    const res = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const p = ((y - y0) * (x1 - x0) + (x - x0)) * 4;
        const a = pat.data[p + 3] / 255;
        if (a <= 0) continue;
        const shade = Math.min(1.35, L((y * W + x) * 4) / med);
        const s = 1 - amount + amount * shade;
        for (let c = 0; c < 3; c++) res.data[p + c] = Math.round(res.data[p + c] * (1 - a) + Math.min(255, pat.data[p + c] * s) * a);
      }
    ctx.putImageData(res, x0, y0);
  }
  return out;
}
