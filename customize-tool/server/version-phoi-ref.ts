/**
 * The AI phôi's reference made on the server (2026-11-08): what components/editor/version-phoi-dialog.tsx draws in
 * the browser, so an import (server/char/import.ts) and the MCP (make_version_phoi) can start the AI with nobody in the
 * editor. Same picture:
 *
 *   1024² = the base's background (cover) · a rough clear plate along the WHOLE version (default picks included) ·
 *           the version's FIXED parts printed on it (lib/design isStaticLayer) — picks / texts are laid on live
 *   mask  = where the AI's photo is kept (the piece + a margin, a strip above it for the tab + cord)
 *
 * Raw RGBA arrays (no canvas on the server); the plate only has to be rough — the AI redraws it.
 */

import sharp from "sharp";
import type { CtBaseProduct, CtSelection, CtVersionPhoi } from "../types";
import { CT_MAIN_KEY } from "../types";
import { isStaticLayer, normalizeProductConfig } from "../lib/design";
import { withBase } from "../lib/base-fit";
import { loadArtwork, renderArtwork, type ArtworkBundle } from "./print-render";
import type { PrintDb } from "./print-products";

const SIDE = 1024;

export interface CtPhoiReference {
  ref: Buffer;
  mask: Buffer;
  box: CtVersionPhoi["box"];
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Không tải được ảnh ${url} (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** A w×h alpha mask (0..255) grown by about `r` px: gaussian blur, then a low threshold. */
async function grow(alpha: Buffer, w: number, h: number, r: number): Promise<Buffer> {
  if (r < 0.5) return alpha;
  // sharp may hand a one-channel raster back in more channels: read its info and take the first one.
  const { data, info } = await sharp(alpha, { raw: { width: w, height: h, channels: 1 } })
    .blur(Math.max(0.3, r / 1.9))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const c = info.channels;
  const out = Buffer.alloc(w * h);
  for (let i = 0; i < out.length; i++) out[i] = data[i * c] > 8 ? 255 : 0;
  return out;
}

/** An RGBA layer of one colour whose alpha is `mask` × `opacity`. */
function tint(mask: Buffer, w: number, h: number, rgb: [number, number, number], opacity: number): Buffer {
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = rgb[0];
    out[i * 4 + 1] = rgb[1];
    out[i * 4 + 2] = rgb[2];
    out[i * 4 + 3] = Math.round(mask[i] * opacity);
  }
  return out;
}

const rawPng = (data: Buffer, w: number, h: number, channels: 1 | 4) => sharp(data, { raw: { width: w, height: h, channels } }).png().toBuffer();

/** The design's alpha (bw × bh) padded by `pad` on every side. */
function padAlpha(rgba: Buffer, bw: number, bh: number, pad: number): { alpha: Buffer; w: number; h: number } {
  const w = bw + 2 * pad;
  const h = bh + 2 * pad;
  const alpha = Buffer.alloc(w * h);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) alpha[(y + pad) * w + x + pad] = rgba[(y * bw + x) * 4 + 3];
  return { alpha, w, h };
}

/** Top-centre of the printed pixels (alpha > 8) in the design's px, null = empty. */
function topCentre(rgba: Buffer, w: number, h: number): { cx: number; top: number } | null {
  let x0 = w;
  let x1 = -1;
  let top = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (rgba[(y * w + x) * 4 + 3] > 8) {
        if (top < 0) top = y;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
      }
  return x1 < 0 ? null : { cx: (x0 + x1) / 2, top };
}

/** The reference + mask of one version of an artwork on a cut-to-shape base. */
export async function phoiReference(db: PrintDb, artworkId: string, base: CtBaseProduct, mainId: string): Promise<CtPhoiReference> {
  const loaded = await loadArtwork(db, artworkId);
  if (!loaded) throw new Error("Không tìm thấy artwork");
  // The design only: an artwork carries no khuôn (the base's), so nothing is cut to one here.
  const bundle: ArtworkBundle = { ...loaded, spec: null };
  const version = bundle.assets.find((a) => a.id === mainId);
  const main = bundle.assets.find((a) => a.id === bundle.product.main_asset_id) ?? version;
  if (!version || !main) throw new Error("Không tìm thấy version");
  const config = normalizeProductConfig(bundle.product.config);
  const fit = withBase({ productId: artworkId, config, regions: bundle.regions, main: { width: main.width, height: main.height } }, base, null);
  const scene = fit.config.scene;
  if (!scene.url) throw new Error(`Base ${base.name} chưa có ảnh nền xem trước`);

  // Cover the AI's square with the photo, centred; the canvas box goes with it.
  const k = SIDE / Math.min(scene.width, scene.height);
  const ox = (SIDE - scene.width * k) / 2;
  const oy = (SIDE - scene.height * k) / 2;
  const box = { x: ox + scene.box.x * k, y: oy + scene.box.y * k, w: scene.box.w * k, h: scene.box.h * k };
  const bw = Math.max(1, Math.round(box.w));
  const bh = Math.max(1, Math.round(box.h));
  const bx = Math.round(box.x);
  const by = Math.round(box.y);

  const selection: CtSelection = { [CT_MAIN_KEY]: { kind: "main", assetId: mainId } };
  const side = Math.max(main.width, main.height);
  const fixedBundle: ArtworkBundle = { ...bundle, regions: bundle.regions.filter((r) => isStaticLayer(r, bundle.items, bundle.assets)) };
  const [wholePng, fixedPng] = await Promise.all([renderArtwork(bundle, selection, side, "print"), renderArtwork(fixedBundle, selection, side, "print")]);
  const at = (png: Buffer) => sharp(png).resize(bw, bh, { fit: "fill" }).ensureAlpha().raw().toBuffer();
  const [whole, fixed] = await Promise.all([at(wholePng), at(fixedPng)]);

  const bg = await sharp(await fetchBuffer(scene.url))
    .resize(Math.round(scene.width * k), Math.round(scene.height * k), { fit: "fill" })
    .extract({ left: Math.max(0, Math.round(-ox)), top: Math.max(0, Math.round(-oy)), width: SIDE, height: SIDE })
    .removeAlpha()
    .png()
    .toBuffer()
    .catch(async () => sharp(await fetchBuffer(scene.url!)).resize(SIDE, SIDE, { fit: "cover" }).removeAlpha().png().toBuffer());

  // The plate: `border` px past the print, frosted, a bright cut edge, a soft shadow down-right.
  const border = Math.max(1, (scene.plate?.border ?? 0.025) * box.w);
  const pad = Math.ceil(border * 2 + 8);
  const padded = padAlpha(whole, bw, bh, pad);
  const rimW = Math.max(1.5, border * 0.22);
  const [plate, inner] = await Promise.all([grow(padded.alpha, padded.w, padded.h, border), grow(padded.alpha, padded.w, padded.h, Math.max(0, border - rimW))]);
  const rim = Buffer.alloc(plate.length);
  for (let i = 0; i < rim.length; i++) rim[i] = plate[i] > inner[i] ? 255 : 0;
  const shadow = await sharp(tint(plate, padded.w, padded.h, [0, 0, 0], 0.35), { raw: { width: padded.w, height: padded.h, channels: 4 } })
    .blur(Math.max(2, border * 0.8))
    .png()
    .toBuffer();
  const left = bx - pad;
  const top = by - pad;
  const clip = async (png: Buffer, l: number, t: number) => {
    // sharp refuses an overlay that reaches past the canvas: cut it to the square first.
    const m = await sharp(png).metadata();
    const w = m.width ?? 0;
    const h = m.height ?? 0;
    const x0 = Math.max(0, -l);
    const y0 = Math.max(0, -t);
    const x1 = Math.min(w, SIDE - l);
    const y1 = Math.min(h, SIDE - t);
    if (x1 <= x0 || y1 <= y0) return null;
    const input = x0 || y0 || x1 < w || y1 < h ? await sharp(png).extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }).png().toBuffer() : png;
    return { input, left: l + x0, top: t + y0 };
  };
  const layers = (
    await Promise.all([
      clip(shadow, left + Math.round(border * 0.35), top + Math.round(border * 0.6)),
      rawPng(tint(plate, padded.w, padded.h, [255, 255, 255], 0.2), padded.w, padded.h, 4).then((p) => clip(p, left, top)),
      rawPng(tint(rim, padded.w, padded.h, [255, 255, 255], 0.8), padded.w, padded.h, 4).then((p) => clip(p, left, top)),
      rawPng(fixed, bw, bh, 4).then((p) => clip(p, bx, by)),
    ])
  ).filter((x): x is { input: Buffer; left: number; top: number } => !!x);
  const ref = await sharp(bg).composite(layers).png().toBuffer();

  // The mask: the piece with room for its edge and shadow, and a strip above its top centre for the tab + cord.
  const r = border + box.w * 0.06;
  const mpad = Math.ceil(r * 2 + 8);
  const mp = padAlpha(whole, bw, bh, mpad);
  const piece = await grow(mp.alpha, mp.w, mp.h, r);
  const layersM: Array<{ input: Buffer; left: number; top: number }> = [];
  const pieceM = await clip(await rawPng(tint(piece, mp.w, mp.h, [255, 255, 255], 1), mp.w, mp.h, 4), bx - mpad, by - mpad);
  if (pieceM) layersM.push(pieceM);
  const tc = topCentre(whole, bw, bh);
  if (tc) {
    const sw = Math.round(Math.max(40, box.w * 0.14));
    const cx = Math.round(bx + tc.cx);
    const stripH = Math.max(1, Math.min(SIDE, Math.round(by + tc.top + r)));
    const strip = await sharp({ create: { width: sw, height: stripH, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer();
    const s = await clip(strip, cx - Math.round(sw / 2), 0);
    if (s) layersM.push(s);
  }
  const mask = await sharp({ create: { width: SIDE, height: SIDE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } })
    .composite(layersM)
    .removeAlpha()
    .png()
    .toBuffer();
  return { ref, mask, box };
}

/**
 * A version's phôi from a photo the import folder brought (its preview background, "nen-preview"): the version's FIXED
 * parts printed flat on it at `box` (the canvas on the photo) — exactly how the folder's own preview shows it, no AI.
 */
export async function phoiOnBackground(db: PrintDb, artworkId: string, mainId: string, background: Buffer, box: CtVersionPhoi["box"]): Promise<Buffer> {
  const loaded = await loadArtwork(db, artworkId);
  if (!loaded) throw new Error("Không tìm thấy artwork");
  const bundle: ArtworkBundle = { ...loaded, spec: null, regions: loaded.regions.filter((r) => isStaticLayer(r, loaded.items, loaded.assets)) };
  const main = bundle.assets.find((a) => a.id === bundle.product.main_asset_id);
  const side = Math.max(main?.width ?? 1000, main?.height ?? 1000);
  const bw = Math.max(1, Math.round(box.w));
  const bh = Math.max(1, Math.round(box.h));
  const bg = sharp(background).removeAlpha();
  const meta = await sharp(background).metadata();
  if (!bundle.regions.length) return bg.png().toBuffer();
  const fixed = await sharp(await renderArtwork(bundle, { [CT_MAIN_KEY]: { kind: "main", assetId: mainId } }, side, "print"))
    .resize(bw, bh, { fit: "fill" })
    .png()
    .toBuffer();
  const W = meta.width ?? bw;
  const H = meta.height ?? bh;
  const l = Math.round(box.x);
  const t = Math.round(box.y);
  // Cut to the photo (sharp refuses an overlay past its canvas).
  const x0 = Math.max(0, -l);
  const y0 = Math.max(0, -t);
  const x1 = Math.min(bw, W - l);
  const y1 = Math.min(bh, H - t);
  if (x1 <= x0 || y1 <= y0) return bg.png().toBuffer();
  const input = await sharp(fixed).extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }).png().toBuffer();
  return bg.composite([{ input, left: l + x0, top: t + y0 }]).png().toBuffer();
}
