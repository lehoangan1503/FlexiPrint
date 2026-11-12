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
import { activeRegions, defaultRegionSelection, normalizeProductConfig, normalizeRegion, resolveLinked, selectedMainId, selectedMainImageId, textColorFromOption, textMode } from "../lib/design";
import { mainFrameFor, onVersion } from "../lib/layout";
import { renditionFrameBox } from "../lib/material-frame";
import { loadFont, textSvg } from "./print-text";
import { itemPlacement, photoFrameBox, resolvePhotoFrame, shapeBounds, shapeToSvgPath, textBand, translateShape } from "../lib/geometry";
import { boundsInSafe, safeShapes } from "../lib/print-template";
import { inkBoxOfPixels, regionInkBounds, type CtImageInk } from "../lib/ink-bounds";
import { withBase } from "../lib/base-fit";
import { loadBaseProduct } from "./base-products";
import { loadTemplate } from "./artwork-link";
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
  const config = normalizeProductConfig(product.config);
  // A product made from an artwork draws the artwork's versions (server/artwork-link.ts).
  const owners = [productId, ...(config.artworkLink ? [config.artworkLink.artworkId] : [])];
  const { data: mains } = await db.from(CT_TABLES.assets).select("*").in("product_id", owners).eq("role", "main").returns<CtAsset[]>();
  const all = new Map([...(subs ?? []), ...(variants ?? []), ...(mains ?? [])].map((a) => [a.id, a]));
  const normalized = (regions ?? []).map(normalizeRegion);
  let spec = config.print?.spec ?? null;
  // An artwork made for a base (2026-11-08) has no khuôn of its own: it is checked / drawn on its base's — the khuôn's
  // safe zone, outline and holes laid on its canvas like the editor's "Xem trên base" (lib/base-fit withBase).
  if (!spec && product.kind !== "product" && product.base_product_id) {
    const base = await loadBaseProduct(db, product.base_product_id);
    const main = all.get(product.main_asset_id ?? "");
    if (base && main) {
      const fit = withBase({ productId, config, regions: normalized, main: { width: main.width, height: main.height } }, base, await loadTemplate(db, base.config.templateId));
      spec = fit.config.print?.spec ?? null;
    }
  }
  return { product, regions: normalized, items: items ?? [], assets: [...all.values()], spec };
}

const inkCache = new Map<string, Promise<CtImageInk | null>>();

/** A picture's ink read with sharp on a ≤ 512 px copy (cached per url for the process). */
function serverInk(url: string): Promise<CtImageInk | null> {
  let p = inkCache.get(url);
  if (!p) {
    p = (async () => {
      const buf = await fetchBuffer(url);
      if (!buf) return null;
      try {
        const meta = await sharp(buf).metadata();
        if (!meta.width || !meta.height) return null;
        const { data, info } = await sharp(buf).ensureAlpha().resize(512, 512, { fit: "inside", withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true });
        return { width: meta.width, height: meta.height, box: inkBoxOfPixels(data, info.width, info.height, info.channels, info.channels - 1) };
      } catch {
        return null;
      }
    })();
    inkCache.set(url, p);
    if (inkCache.size > 2000) inkCache.delete(inkCache.keys().next().value as string);
  }
  return p;
}

/**
 * Where every main element (placed picture, text, photo) sits, and whether it is inside the safe zone. A picture
 * layer is judged by its visible pixels over all options (lib/ink-bounds), not by its frame: a full-canvas clipart
 * file with the part in the middle is inside (2026-11-08). `box` = the frame, `ink` = the visible pixels.
 */
export async function safeReport(b: ArtworkBundle): Promise<Array<{ layer: string; kind: string; box: { x: number; y: number; w: number; h: number }; ink?: { x: number; y: number; w: number; h: number } | null; inSafe: boolean }>> {
  if (!b.spec) return [];
  const spec = b.spec;
  const round = (x: { x: number; y: number; w: number; h: number }) => ({ x: Math.round(x.x), y: Math.round(x.y), w: Math.round(x.w), h: Math.round(x.h) });
  return Promise.all(
    b.regions
      .filter((r) => !r.config.materialFrame && !r.config.fill && !r.config.printOnly && !r.config.previewOnly)
      .map(async (r) => {
        const box = shapeBounds(r.shape);
        const ink = await regionInkBounds(r, b.items, b.assets, serverInk);
        const inSafe = ink === null ? true : boundsInSafe(spec, ink ?? box);
        return { layer: r.name, kind: r.kind, box: round(box), ...(ink !== undefined ? { ink: ink && round(ink) } : {}), inSafe };
      }),
  );
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
/**
 * The version's own picture (the main asset: an imported design's vehicle / scene) where lib/compositor draws it — its
 * frame on the artboard, its rendition's padding around — as one overlay; null = none to draw.
 */
async function mainPictureLayer(b: ArtworkBundle, selection: CtSelection, W: number, H: number): Promise<OverlayOptions | null> {
  const mainAssetId = b.product.main_asset_id;
  if (!mainAssetId) return null;
  const mainId = selectedMainId(selection, b.assets, mainAssetId);
  const shown = b.assets.find((a) => a.id === selectedMainImageId(selection, b.assets, mainAssetId)) ?? b.assets.find((a) => a.id === mainId);
  if (!shown?.url) return null;
  const buf = await fetchBuffer(shown.url);
  if (!buf) return null;
  const meta = shown.meta as { frame?: { regionId: string; box: { x: number; y: number; w: number; h: number } }; pad?: { x: number; y: number } } | null;
  const f = meta?.frame
    ? { ...renditionFrameBox(b.regions, meta.frame), rotation: 0 }
    : mainFrameFor(normalizeProductConfig(b.product.config).layouts, mainId, W, H);
  const px = (meta?.pad?.x ?? 0) * f.w;
  const py = (meta?.pad?.y ?? 0) * f.h;
  let pic = await sharp(buf).resize(Math.max(1, Math.round(f.w + 2 * px)), Math.max(1, Math.round(f.h + 2 * py)), { fit: "fill" }).png().toBuffer();
  if (Math.abs(f.rotation) > 0.05) pic = await sharp(pic).rotate(f.rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const m = await sharp(pic).metadata();
  const left = Math.round(f.x + f.w / 2 - (m.width ?? 0) / 2);
  const top = Math.round(f.y + f.h / 2 - (m.height ?? 0) / 2);
  // sharp refuses an overlay past the canvas: cut it to the artboard.
  const x0 = Math.max(0, -left);
  const y0 = Math.max(0, -top);
  const x1 = Math.min(m.width ?? 0, W - left);
  const y1 = Math.min(m.height ?? 0, H - top);
  if (x1 <= x0 || y1 <= y0) return null;
  const input = await sharp(pic).extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }).png().toBuffer();
  return { input, left: left + x0, top: top + y0 };
}

/**
 * `opts.withMain`: also draw the version's own picture between the layers below and above it, like the storefront
 * (the AI phôi references, server/version-phoi-ref.ts). Off by default: the other callers keep drawing layers only.
 */
export async function renderArtwork(b: ArtworkBundle, selection: CtSelection = {}, maxSide = 1400, mode: "guides" | "print" = "guides", opts: { withMain?: boolean } = {}): Promise<Buffer> {
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
  const ordered = activeRegions([...b.regions].sort((x, y) => x.sort_order - y.sort_order), chosen);
  // With the version's picture: every layer below it first, then it, then the layers above (lib/compositor's order).
  const run = opts.withMain ? [...ordered.filter((r) => !r.config.aboveMain), ...ordered.filter((r) => r.config.aboveMain)] : ordered;
  let mainLayer = opts.withMain ? await mainPictureLayer(b, selection, W, H) : null;
  for (const r of run) {
    if (mainLayer && r.config.aboveMain) {
      layers.push(mainLayer);
      mainLayer = null;
    }
    if (r.config.materialFrame) continue;
    // The print file never has a preview-only layer (a blank scene, a sample text the photo shows).
    if (!guides && r.config.previewOnly) continue;
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
      const left = Math.round(p.cx - (m.width ?? p.w) / 2);
      const top = Math.round(p.cy - (m.height ?? p.h) / 2);
      layers.push({ input: pic, left, top });
    } else if (r.kind === "text") {
      // A text whose colour follows another layer's option (a red "1st Christmas" → red name).
      const t = textColorFromOption(r, chosen).config.text;
      const raw = sel.kind === "text" && sel.text ? sel.text : t.defaultText;
      const font = await loadFont(t.fontFamily, t.fontWeight, t.fontUrl);
      if (font) {
        // A zone drawn along a slanted band (or turned in the editor) writes along it, like lib/compositor.
        const band = textBand(r.shape);
        const box = { x: band.cx - band.w / 2, y: band.cy - band.h / 2, w: band.w, h: band.h };
        svgs.push(band.rotation ? `<g transform="rotate(${band.rotation} ${band.cx} ${band.cy})">${textSvg(font, raw, t, box)}</g>` : textSvg(font, raw, t, bounds));
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
      // In the zone's child frame (auto: fitted to this photo — a face hole's head fit), like lib/compositor.ts.
      const f = photoFrameBox(bounds, resolvePhotoFrame(r.config.photo, r.shape, { width: m0.width ?? 1, height: m0.height ?? 1 }));
      const inner = { x: -f.w / 2 + f.margin, y: -f.h / 2 + f.margin, w: Math.max(1, f.w - 2 * f.margin), h: Math.max(1, f.h - 2 * f.margin) };
      const p0 = itemPlacement(inner, m0.width ?? 1, m0.height ?? 1, sel.transform, r.config.photo.fit);
      const fr = (f.rotation * Math.PI) / 180;
      const p = { cx: f.cx + p0.cx * Math.cos(fr) - p0.cy * Math.sin(fr), cy: f.cy + p0.cx * Math.sin(fr) + p0.cy * Math.cos(fr), w: p0.w, h: p0.h, rotation: f.rotation + p0.rotation };
      let pic = await sharp(buf).resize(Math.max(1, Math.round(p.w)), Math.max(1, Math.round(p.h)), { fit: "fill" }).png().toBuffer();
      if (Math.abs(p.rotation) > 0.05) pic = await sharp(pic).rotate(p.rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
      const pm = await sharp(pic).metadata();
      const pw = pm.width ?? Math.round(p.w);
      const ph = pm.height ?? Math.round(p.h);
      const left = Math.round(p.cx - pw / 2);
      const top = Math.round(p.cy - ph / 2);
      if (r.config.clip) pic = await sharp(pic).composite([{ input: maskSvg(pw, ph, translateShape(r.shape, -left, -top)), blend: "dest-in" }]).png().toBuffer();
      layers.push({ input: pic, left, top });
    } else if (r.kind === "photo" && guides) {
      svgs.push(
        `<path d="${shapeToSvgPath(r.shape)}" fill="#bae6fd" fill-opacity="0.6" stroke="#0284c7" stroke-width="3"/><text x="${bounds.x + bounds.w / 2}" y="${bounds.y + bounds.h / 2}" font-family="sans-serif" font-size="${Math.max(16, bounds.w / 10)}" fill="#075985" text-anchor="middle" dominant-baseline="middle">ẢNH KHÁCH</text>`,
      );
    }
  }

  if (mainLayer) layers.push(mainLayer);
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
    for (const rep of (await safeReport(b)).filter((x) => !x.inSafe))
      svgs.push(`<rect x="${(rep.ink ?? rep.box).x}" y="${(rep.ink ?? rep.box).y}" width="${(rep.ink ?? rep.box).w}" height="${(rep.ink ?? rep.box).h}" fill="none" stroke="#dc2626" stroke-width="${sw * 1.5}"/>`);
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
