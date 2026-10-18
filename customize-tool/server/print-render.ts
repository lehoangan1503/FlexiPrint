/**
 * A server-side picture of a product on a khuôn in — sharp, no browser:
 *   guides  for the @flexiprint agent to look at what it laid out (MCP render_artwork): over the artwork the cut line
 *           (green), the safe zone (dashed green), the parts cut out (red), the names of the zones, and a red box
 *           round every main element outside the safe zone; a customer photo zone is a labelled placeholder
 *   print   the print file as the storefront makes it (MCP make_product_mockups): the sheet, transparent, cut to the
 *           khuôn, nothing drawn over
 * Text is drawn with its real font, letter by letter like lib/compositor (server/print-text.ts); a rotated picture is
 * approximated. The customer's print file is still made by lib/compositor at add-to-cart.
 */

import { inChunks } from "./in-chunks";
import sharp, { type OverlayOptions } from "sharp";
import { CT_TABLES } from "../config";
import type { CtAsset, CtProduct, CtRegion, CtRegionItem, CtSelection, CtShape } from "../types";
import type { CtPrintSpec } from "../types/print";
import { activeRegions, defaultRegionSelection, normalizeProductConfig, normalizeRegion, resolveLinked, selectedMainId, textMode } from "../lib/design";
import { onVersion } from "../lib/layout";
import { loadFont, textSvg } from "./print-text";
import { itemPlacement, shapeBounds, shapeToSvgPath, translateShape } from "../lib/geometry";
import { boundsInSafe, safeShapes } from "../lib/print-template";
import type { PrintDb } from "./print-products";

export interface ArtworkBundle {
  product: CtProduct;
  regions: CtRegion[];
  items: CtRegionItem[];
  assets: CtAsset[];
  spec: CtPrintSpec | null;
}

export async function loadArtwork(db: PrintDb, productId: string): Promise<ArtworkBundle | null> {
  const { data: product } = await db.from(CT_TABLES.products).select("*").eq("id", productId).maybeSingle<CtProduct>();
  if (!product) return null;
  const { data: regions } = await db.from(CT_TABLES.regions).select("*").eq("product_id", productId).order("sort_order").returns<CtRegion[]>();
  const ids = (regions ?? []).map((r) => r.id);
  const items = (await inChunks(ids, (x) => db.from(CT_TABLES.items).select("*").in("region_id", x).returns<CtRegionItem[]>())).sort((a, b) => a.sort_order - b.sort_order);
  const assetIds = [...new Set([...(items ?? []).map((i) => i.asset_id), ...(product.main_asset_id ? [product.main_asset_id] : [])])];
  const subs = await inChunks(assetIds, (x) => db.from(CT_TABLES.assets).select("*").in("id", x).returns<CtAsset[]>());
  const variants = await inChunks(assetIds, (x) => db.from(CT_TABLES.assets).select("*").in("parent_id", x).returns<CtAsset[]>());
  // Every main version (a boy / a girl, 1–5 people — each has its own layers).
  const { data: mains } = await db.from(CT_TABLES.assets).select("*").eq("product_id", productId).eq("role", "main").returns<CtAsset[]>();
  const config = normalizeProductConfig(product.config);
  const all = new Map([...(subs ?? []), ...(variants ?? []), ...(mains ?? [])].map((a) => [a.id, a]));
  return { product, regions: (regions ?? []).map(normalizeRegion), items: items ?? [], assets: [...all.values()], spec: config.print?.spec ?? null };
}

/** Where every main element (placed picture, text, photo) sits, and whether it is inside the safe zone. */
export function safeReport(b: ArtworkBundle): Array<{ layer: string; kind: string; box: { x: number; y: number; w: number; h: number }; inSafe: boolean }> {
  if (!b.spec) return [];
  return b.regions
    .filter((r) => !r.config.materialFrame && !r.config.fill && !r.config.printOnly)
    .map((r) => {
      const box = shapeBounds(r.shape);
      return { layer: r.name, kind: r.kind, box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) }, inSafe: boundsInSafe(b.spec as CtPrintSpec, box) };
    });
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function fetchBuffer(url: string): Promise<Buffer | null> {
  const res = await fetch(url).catch(() => null);
  if (!res?.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

function maskSvg(w: number, h: number, shape: CtShape): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><path d="${shapeToSvgPath(shape)}" fill="#fff"/></svg>`);
}

/** The artwork (default options, or `selection`) at long side ≤ maxSide, with the khuôn in drawn over it ("guides"),
 * or as the print file ("print": transparent, cut to the khuôn's outline, nothing over it). */
export async function renderArtwork(b: ArtworkBundle, selection: CtSelection = {}, maxSide = 1400, mode: "guides" | "print" = "guides"): Promise<Buffer> {
  const main = b.assets.find((a) => a.id === b.product.main_asset_id);
  const W = b.spec?.width ?? main?.width ?? 1000;
  const H = b.spec?.height ?? main?.height ?? 1000;
  const byId = new Map(b.assets.map((a) => [a.id, a]));
  const layers: OverlayOptions[] = [];
  const svgs: string[] = [];

  const guides = mode === "guides";
  // The version shown (selection[CT_MAIN_KEY], else the product's main): only its own layers are drawn.
  const mainId = b.product.main_asset_id ? selectedMainId(selection, b.assets, b.product.main_asset_id) : null;
  b = { ...b, regions: b.regions.filter((r) => onVersion(r, mainId)) };
  // Every layer's choice (the defaults where none is given), linked layers (a back half of hair) following theirs.
  const picked: CtSelection = {};
  for (const r of b.regions) picked[r.id] = selection[r.id] ?? defaultRegionSelection(r, b.items, b.assets);
  const chosen = resolveLinked(b.regions, b.items, b.assets, picked);
  // A child layer only while its parent shows its option (a boy's hair while "Grandchild 1" is "Boy").
  for (const r of activeRegions([...b.regions].sort((x, y) => x.sort_order - y.sort_order), chosen)) {
    if (r.config.materialFrame) continue;
    const sel = chosen[r.id];
    const bounds = shapeBounds(r.shape);
    if (r.kind === "image" && sel.kind === "image" && sel.assetId) {
      const asset = byId.get(sel.assetId);
      const buf = asset ? await fetchBuffer(asset.url) : null;
      if (!asset || !buf) continue;
      if (r.config.fill) {
        const bw = Math.max(1, Math.round(bounds.w));
        const bh = Math.max(1, Math.round(bounds.h));
        let pic: Buffer;
        if (r.config.fill.mode === "cover") {
          pic = await sharp(buf).resize(bw, bh, { fit: "cover" }).png().toBuffer();
        } else {
          const tw = Math.max(4, Math.round(r.config.fill.tile));
          const tile = await sharp(buf).resize({ width: tw }).png().toBuffer();
          const th = (await sharp(tile).metadata()).height ?? tw;
          const tiles: OverlayOptions[] = [];
          // A tile past the layer's edge is cut there (sharp refuses an overlay bigger than its canvas).
          for (let y = 0; y < bh; y += th)
            for (let x = 0; x < bw; x += tw) {
              const w = Math.min(tw, bw - x);
              const hh = Math.min(th, bh - y);
              tiles.push({ input: w < tw || hh < th ? await sharp(tile).extract({ left: 0, top: 0, width: w, height: hh }).png().toBuffer() : tile, left: x, top: y });
            }
          pic = await sharp({ create: { width: bw, height: bh, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(tiles).png().toBuffer();
        }
        const shifted = translateShape(r.shape, -bounds.x, -bounds.y);
        pic = await sharp(pic).composite([{ input: maskSvg(bw, bh, shifted), blend: "dest-in" }]).png().toBuffer();
        layers.push({ input: pic, left: Math.round(bounds.x), top: Math.round(bounds.y) });
        continue;
      }
      const item = b.items.find((i) => i.region_id === r.id && (i.asset_id === asset.id || i.asset_id === asset.parent_id));
      const p = itemPlacement(bounds, asset.width, asset.height, item?.transform ?? { offsetX: 0, offsetY: 0, scale: 1, rotation: 0 }, "contain");
      let pic = await sharp(buf).resize(Math.max(1, Math.round(p.w)), Math.max(1, Math.round(p.h)), { fit: "fill" }).png().toBuffer();
      if (p.rotation) pic = await sharp(pic).rotate(p.rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
      const m = await sharp(pic).metadata();
      layers.push({ input: pic, left: Math.round(p.cx - (m.width ?? p.w) / 2), top: Math.round(p.cy - (m.height ?? p.h) / 2) });
    } else if (r.kind === "text") {
      const t = r.config.text;
      const raw = sel.kind === "text" && sel.text ? sel.text : t.defaultText;
      const font = await loadFont(t.fontFamily, t.fontWeight);
      if (font) {
        svgs.push(textSvg(font, raw, t, bounds));
        if (guides && textMode(r) === "input") svgs.push(`<rect x="${bounds.x}" y="${bounds.y}" width="${bounds.w}" height="${bounds.h}" fill="none" stroke="#0ea5e9" stroke-width="2" stroke-dasharray="8 6"/>`);
        continue;
      }
      const text = t.uppercase ? raw.toUpperCase() : raw;
      const size = Math.min(t.fontSize, bounds.h * 0.9);
      const x = t.align === "left" ? bounds.x : t.align === "right" ? bounds.x + bounds.w : bounds.x + bounds.w / 2;
      const anchor = t.align === "left" ? "start" : t.align === "right" ? "end" : "middle";
      const fit = text.length * size * 0.55 > bounds.w ? ` textLength="${bounds.w}" lengthAdjust="spacingAndGlyphs"` : "";
      svgs.push(
        `<text x="${x}" y="${bounds.y + bounds.h / 2}" font-family="${esc(t.fontFamily)}, serif" font-weight="${t.fontWeight}" font-size="${size}" fill="${esc(t.color)}" text-anchor="${anchor}" dominant-baseline="middle"${fit}${t.strokeWidth ? ` stroke="${esc(t.strokeColor)}" stroke-width="${t.strokeWidth}"` : ""}>${esc(text)}</text>`,
      );
      if (textMode(r) === "input") svgs.push(`<rect x="${bounds.x}" y="${bounds.y}" width="${bounds.w}" height="${bounds.h}" fill="none" stroke="#0ea5e9" stroke-width="2" stroke-dasharray="8 6"/>`);
    } else if (r.kind === "photo" && sel.kind === "photo" && (sel.url || r.config.photo.sampleUrl)) {
      // The customer's photo (a rendered one), else the zone's sample: fitted in the zone like the editor does.
      const buf = await fetchBuffer(sel.url ?? r.config.photo.sampleUrl!);
      if (!buf) continue;
      const m0 = await sharp(buf).metadata();
      const p = itemPlacement(bounds, m0.width ?? 1, m0.height ?? 1, sel.transform, r.config.photo.fit);
      let pic = await sharp(buf).resize(Math.max(1, Math.round(p.w)), Math.max(1, Math.round(p.h)), { fit: "fill" }).png().toBuffer();
      const left = Math.round(p.cx - p.w / 2);
      const top = Math.round(p.cy - p.h / 2);
      if (r.config.clip) pic = await sharp(pic).composite([{ input: maskSvg(Math.round(p.w), Math.round(p.h), translateShape(r.shape, -left, -top)), blend: "dest-in" }]).png().toBuffer();
      layers.push({ input: pic, left, top });
    } else if (r.kind === "photo" && guides) {
      svgs.push(
        `<path d="${shapeToSvgPath(r.shape)}" fill="#bae6fd" fill-opacity="0.6" stroke="#0284c7" stroke-width="3"/><text x="${bounds.x + bounds.w / 2}" y="${bounds.y + bounds.h / 2}" font-family="sans-serif" font-size="${Math.max(16, bounds.w / 10)}" fill="#075985" text-anchor="middle" dominant-baseline="middle">ẢNH KHÁCH</text>`,
      );
    }
  }

  // The khuôn in over the artwork.
  if (b.spec && guides) {
    const sw = Math.max(2, Math.min(W, H) / 300);
    if (b.spec.outline) svgs.push(`<path d="${shapeToSvgPath(b.spec.outline)}" fill="none" stroke="#15803d" stroke-width="${sw}"/>`);
    for (const s of safeShapes(b.spec)) svgs.push(`<path d="${shapeToSvgPath(s)}" fill="none" stroke="#16a34a" stroke-width="${sw}" stroke-dasharray="${sw * 6} ${sw * 4}"/>`);
    for (const s of b.spec.cuts) svgs.push(`<path d="${shapeToSvgPath(s)}" fill="#ffffff" fill-opacity="0.6" stroke="#dc2626" stroke-width="${sw}"/>`);
    for (const z of b.spec.zones) {
      const zb = shapeBounds(z.shape);
      svgs.push(`<path d="${shapeToSvgPath(z.shape)}" fill="none" stroke="#6366f1" stroke-width="${sw * 0.6}" stroke-dasharray="${sw * 2} ${sw * 2}"/><text x="${zb.x + zb.w / 2}" y="${zb.y + 24}" font-family="sans-serif" font-size="${Math.max(18, W / 60)}" fill="#4338ca" text-anchor="middle">${esc(z.name)} (${esc(z.id)})</text>`);
    }
    for (const rep of safeReport(b).filter((x) => !x.inSafe))
      svgs.push(`<rect x="${rep.box.x}" y="${rep.box.y}" width="${rep.box.w}" height="${rep.box.h}" fill="none" stroke="#dc2626" stroke-width="${sw * 1.5}"/>`);
  }
  if (svgs.length) layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${svgs.join("")}</svg>`), left: 0, top: 0 });

  if (!guides && b.spec?.outline) layers.push({ input: maskSvg(W, H, b.spec.outline), blend: "dest-in", left: 0, top: 0 });
  // The print has the piece's holes (the hanging hole) cut out, like the storefront's print file.
  if (!guides) for (const c of b.spec?.cuts ?? []) layers.push({ input: maskSvg(W, H, c), blend: "dest-out", left: 0, top: 0 });
  const canvas = sharp({ create: { width: W, height: H, channels: 4, background: guides ? { r: 236, g: 236, b: 236, alpha: 1 } : { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(layers);
  const full = await canvas.png().toBuffer();
  const k = Math.min(1, maxSide / Math.max(W, H));
  return sharp(full).resize(Math.round(W * k), Math.round(H * k)).png().toBuffer();
}
