/**
 * Layers picked in a product saved as a bộ clipart of their own (asked 2026-11-04: "chọn các layer chứa các clipart
 * đó xuất nó thành 1 bộ" — the boy with every hair / outfit of his pose, to sit him by a tree instead of his grandma).
 *
 *   POST char/extract   CtExtractSetBody → CtExtractSetResult
 *
 * The clipart are never re-cut or moved one by one (flexiprint-layer-rules): the new bộ's product is a blank canvas of
 * the SAME size as the version they came from, holding copies of the layers at the same place, so every option stays
 * pixel-registered with the others. Dropped into another product it lands like any bộ (lib/char-set-layers.ts) and is
 * moved / scaled as a whole.
 *
 * Only what another product can reference comes along — library clipart (product_id null) and text / photo zones —
 * the same rule as a bộ dropped into a product; a layer showing the product's own pictures is left out and counted.
 */

import { NextResponse } from "next/server";
import sharp from "sharp";
import { CT_TABLES } from "../../config";
import type { CtAsset, CtCharProject, CtExtractSetBody, CtExtractSetResult, CtProduct, CtRegion, CtRegionItem } from "../../types";
import { defaultCharBrief } from "../../lib/char-brief";
import { defaultProductConfig, normalizeRegion } from "../../lib/design";
import { cloneLayers } from "../../lib/layout";
import * as h from "../handlers";
import type { CtSession } from "../supabase";
import { saveCharFile } from "./files";
import { jsonError, projectRow } from "./projects";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SIDE = 12000;
const MAX_LAYERS = 2000;

async function body<T>(res: NextResponse): Promise<T> {
  const out = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
  return out;
}

function parse(raw: unknown): CtExtractSetBody | string {
  if (!raw || typeof raw !== "object") return "Body không hợp lệ";
  const b = raw as Partial<CtExtractSetBody>;
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 200) : "";
  if (!name) return "Đặt tên bộ";
  if (typeof b.productId !== "string" || !UUID.test(b.productId)) return "productId không hợp lệ";
  const width = Math.round(Number(b.width));
  const height = Math.round(Number(b.height));
  if (!(width > 0 && height > 0 && width <= MAX_SIDE && height <= MAX_SIDE)) return "Khung không hợp lệ";
  if (!Array.isArray(b.regions) || !b.regions.length) return "Chưa chọn layer nào";
  if (b.regions.length > MAX_LAYERS) return "Quá nhiều layer";
  const items = Array.isArray(b.items) ? b.items : [];
  const preview = typeof b.preview === "string" ? b.preview : "";
  return { name, productId: b.productId, width, height, regions: b.regions, items, preview };
}

/** POST char/extract */
export async function extractCharSet(s: CtSession, raw: unknown): Promise<NextResponse> {
  const b = parse(raw);
  if (typeof b === "string") return jsonError(b, 400);
  const { data: source } = await s.supabase.from(CT_TABLES.products).select("id, name").eq("id", b.productId).maybeSingle<Pick<CtProduct, "id" | "name">>();
  if (!source) return jsonError("Không tìm thấy sản phẩm", 404);

  // ---- what can come along ----
  const regions = b.regions.map((r) => normalizeRegion(r as CtRegion));
  const assetIds = [...new Set(b.items.map((i) => i.asset_id))];
  const { data: assetRows } = assetIds.length
    ? await s.supabase.from(CT_TABLES.assets).select("id, product_id").in("id", assetIds).returns<Array<Pick<CtAsset, "id" | "product_id">>>()
    : { data: [] as Array<Pick<CtAsset, "id" | "product_id">> };
  const library = new Set((assetRows ?? []).filter((a) => a.product_id === null).map((a) => a.id));
  let skipped = 0;
  const keep: CtRegion[] = [];
  for (const r of regions) {
    if (r.config.materialFrame) {
      skipped++;
      continue;
    }
    if (r.kind === "image") {
      const own = b.items.filter((i) => i.region_id === r.id);
      if (!own.length || own.some((i) => !library.has(i.asset_id))) {
        skipped++;
        continue;
      }
    }
    keep.push(r);
  }
  // A child zone whose parent stays behind would never show: it hangs under nothing (always shown) instead.
  const kept = new Set(keep.map((r) => r.id));
  const loose = keep.map((r) => (r.config.parent && !kept.has(r.config.parent.regionId) ? { ...r, config: { ...r.config, parent: undefined } } : r));
  if (!loose.length) return jsonError("Không có layer nào dùng được — các layer đã chọn dùng ảnh riêng của sản phẩm, không phải clipart thư viện", 400);
  const keptItems: CtRegionItem[] = b.items.filter((i) => kept.has(i.region_id));

  // ---- the bộ's product: a blank canvas of the same size, the layers on it ----
  const product = (await body<{ product: CtProduct }>(await h.createProduct(s, { name: b.name }))).product;
  try {
    const sheet = await sharp({ create: { width: b.width, height: b.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(sheet)], { type: "image/png" }), "canvas.png");
    form.set("role", "main");
    form.set("name", `Khung ${b.width}×${b.height}`);
    const main = (await body<{ asset: CtAsset }>(await h.uploadAsset(s, product.id, form))).asset;
    const cloned = cloneLayers(loose, keptItems, main.id);
    const outRegions = cloned.regions.map((r, i): CtRegion => {
      const config = { ...r.config };
      delete config.charSet;
      return { ...r, product_id: product.id, sort_order: i, config };
    });
    await body(await h.saveDesign(s, product.id, { regions: outRegions, items: cloned.items, config: defaultProductConfig() }));
    await s.supabase.from(CT_TABLES.products).update({ main_asset_id: main.id, notes: `Bộ clipart tách từ “${source.name}”` }).eq("id", product.id);

    // ---- the bộ ----
    const brief = { ...defaultCharBrief("character"), idea: `Tách từ sản phẩm “${source.name}”: ${outRegions.length} layer`, extracted: { productId: source.id, productName: source.name, layers: outRegions.length, at: new Date().toISOString() } };
    const { data: row, error } = await s.supabase
      .from(CT_TABLES.charProjects)
      .insert({ user_id: s.user.id, name: b.name, brief, status: "product", product_ids: [product.id] })
      .select("*")
      .single<CtCharProject>();
    if (error || !row) throw new Error(error?.message ?? "Không tạo được bộ");
    let project = projectRow(row);

    // Its picture in the library: the layers drawn together (sent by the editor), saved as the bộ's master.
    const m = /^data:image\/(?:png|webp|jpeg);base64,(.+)$/.exec(b.preview);
    if (m) {
      try {
        const saved = await saveCharFile(s.user.id, project.id, "master", Buffer.from(m[1], "base64"));
        const { data: im } = await s.supabase.from(CT_TABLES.charImages).insert({ project_id: project.id, user_id: s.user.id, kind: "master", role: "master", status: "done", ...saved }).select("id").single<{ id: string }>();
        if (im) {
          const { data: up } = await s.supabase.from(CT_TABLES.charProjects).update({ master_id: im.id }).eq("id", project.id).select("*").single<CtCharProject>();
          if (up) project = projectRow(up);
        }
      } catch (e) {
        console.warn("[ct] extract preview", e instanceof Error ? e.message : String(e));
      }
    }
    const result: CtExtractSetResult = { project, productId: product.id, layers: outRegions.length, skipped };
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    await h.deleteProduct(s, product.id).catch(() => undefined);
    return jsonError(e instanceof Error ? e.message : "Không tạo được bộ", 500);
  }
}
