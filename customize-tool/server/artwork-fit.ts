/**
 * An artwork's canvas made exactly its base's khuôn in (2026-11-12, asked: "vùng artwork edit sẽ đúng rộng bằng khuôn
 * in mà không có thừa 2 đầu trên dưới"): an artwork whose canvas has another shape shows the khuôn contain-fitted with
 * bare strips around it (the orange line = the khuôn's edge), and its print file is the canvas, not the khuôn's px.
 *
 *   POST products/:id/fit-base → { changed, width, height }
 *
 * The version's canvas (a blank "Khung" picture) gets the base's print area px (its own file swapped, same asset id —
 * every version, layout and layer still points at it); every layer, version frame and layout override moves with the
 * khuôn: where the khuôn lay on the old canvas becomes the whole new one. A canvas that is a real picture is refused.
 */

import sharp from "sharp";
import { NextResponse } from "next/server";
import { CT_TABLES } from "../config";
import type { CtAsset, CtMainFrame, CtMainLayout, CtProductConfig, CtRegion, CtRegionItem } from "../types";
import { normalizeProductConfig, normalizeRegion } from "../lib/design";
import { baseCanvas, DEFAULT_PLACEMENT, sheetPlace } from "../lib/base-fit";
import { moveShapeBy } from "../lib/assembly";
import { fetchImage } from "./char/files";
import { loadBaseProduct } from "./base-products";
import { loadTemplate } from "./artwork-link";
import { jsonError, ownedProduct, saveDesign } from "./handlers";
import { ctStoragePath, ctUpload } from "./storage";
import type { CtSession } from "./supabase";

/** True when the picture has no visible pixel (a version's blank canvas). */
async function isBlank(url: string): Promise<boolean> {
  const stats = await sharp(await fetchImage(url)).ensureAlpha().stats();
  const a = stats.channels[stats.channels.length - 1];
  return !!a && a.max <= 2;
}

export async function fitArtworkToBase(s: CtSession, productId: string): Promise<NextResponse> {
  const product = await ownedProduct(s, productId);
  if (!product) return jsonError("Không có quyền sửa artwork này", 403);
  if (product.kind === "product") return jsonError("Sản phẩm lấy khung từ artwork — sửa ở artwork", 400);
  if (!product.base_product_id || !product.main_asset_id) return jsonError("Artwork chưa chọn product base", 400);
  const base = await loadBaseProduct(s.supabase, product.base_product_id);
  if (!base) return jsonError("Không tìm thấy product base", 404);
  const template = await loadTemplate(s.supabase, base.config.templateId);
  const target = baseCanvas(base, template);
  const { data: main } = await s.supabase.from(CT_TABLES.assets).select("*").eq("id", product.main_asset_id).maybeSingle<CtAsset>();
  if (!main) return jsonError("Không tìm thấy khung artwork", 404);
  if (main.width === target.width && main.height === target.height) return NextResponse.json({ changed: false, width: main.width, height: main.height });
  if (!(await isBlank(main.url))) return jsonError("Khung artwork là ảnh thật (không phải khung trống) — không tự đổi được", 400);

  // Where the khuôn lies on the old canvas → the whole new canvas.
  const sheet = template ? { width: template.spec.width, height: template.spec.height } : target;
  const place = sheetPlace({ width: main.width, height: main.height }, sheet, DEFAULT_PLACEMENT);
  const k = target.width / place.w;
  const dx = -place.x * k;
  const dy = -place.y * k;
  const frame = (f: CtMainFrame): CtMainFrame => ({ ...f, x: f.x * k + dx, y: f.y * k + dy, w: f.w * k, h: f.h * k });

  const { data: rows } = await s.supabase.from(CT_TABLES.regions).select("*").eq("product_id", productId).order("sort_order").returns<CtRegion[]>();
  const regions = (rows ?? []).map(normalizeRegion).map((r): CtRegion => {
    const config = { ...r.config };
    if (r.kind === "text") config.text = { ...config.text, fontSize: Math.round(config.text.fontSize * k * 10) / 10 };
    if (config.fill) config.fill = { ...config.fill, tile: Math.round(config.fill.tile * k) };
    if (config.cuts) config.cuts = config.cuts.map((c) => moveShapeBy(c, k, dx, dy));
    return { ...r, shape: moveShapeBy(r.shape, k, dx, dy), config };
  });
  const ids = regions.map((r) => r.id);
  const { data: items } = ids.length ? await s.supabase.from(CT_TABLES.items).select("*").in("region_id", ids).returns<CtRegionItem[]>() : { data: [] as CtRegionItem[] };
  const config: CtProductConfig = normalizeProductConfig(product.config);
  const layouts: Record<string, CtMainLayout> = {};
  for (const [id, l] of Object.entries(config.layouts)) {
    layouts[id] = {
      ...l,
      ...(l.frame ? { frame: frame(l.frame) } : {}),
      regions: Object.fromEntries(Object.entries(l.regions).map(([rid, o]) => [rid, o.shape ? { ...o, shape: moveShapeBy(o.shape, k, dx, dy) } : o])),
    };
  }

  // The blank canvas at the khuôn's px, in the same asset (every reference to it stays).
  const png = await sharp({ create: { width: target.width, height: target.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const path = ctStoragePath(s.user.id, productId, "main", "image/png");
  const url = await ctUpload(path, png, "image/png");
  const saved = await saveDesign(s, productId, { regions, items: items ?? [], config: { ...config, layouts } });
  if (!saved.ok) return saved;
  const { error } = await s.supabase
    .from(CT_TABLES.assets)
    .update({ url, storage_path: path, width: target.width, height: target.height, name: `Khung ${target.width}×${target.height}` })
    .eq("id", main.id);
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ changed: true, width: target.width, height: target.height });
}
