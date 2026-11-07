/**
 * Artwork → products (asked 2026-11-06, like Teeinblue's Artwork ↔ Campaign, with one rule of our own): a product
 * made from an artwork holds a SNAPSHOT of the artwork's design — layers, options, versions, khuôn, print settings.
 * Editing the artwork only changes the artwork (its save bumps config.artworkRevision); a product shows "Có bản
 * artwork mới" until someone updates it by hand (one product, or several at once). Products made for an older design
 * keep that design for as long as nobody updates them.
 *
 *   GET  products/:id/artwork                  → { revision, source, products } — the artwork this product was made
 *                                                 from (if any) and the products made from this one
 *   POST products/:id/artwork-products {baseProductId, name?} → { product } a new product (kind "product") made
 *                                                 from this artwork on a base product (variants + price)
 *   POST products/:id/artwork-sync             → { product } this product takes its artwork's current design
 *   POST products/:id/artwork-products/sync {ids} → { updated, failed } several products of this artwork at once
 *
 * The artwork is an ordinary product row (every product is its own artwork until linked). Its layers and items are
 * copied with new ids, kept stable across updates (link.regionMap / itemMap) so what the product keys on a layer — a
 * photo per background option, zone mockups, the editor's samples — survives an update. Versions and library
 * cliparts are shared, not copied: the product reads the artwork's own pictures (server/library.ts loadProductAssets).
 */

import { NextResponse } from "next/server";
import { CT_TABLES } from "../config";
import type { CtArtworkLink, CtArtworkProductRow, CtArtworkSource, CtBaseProduct, CtCreateFromArtworkBody, CtProduct, CtProductConfig, CtRegion, CtRegionItem } from "../types";
import type { CtPrintTemplate } from "../types/print";
import { normalizePlacement, normalizeProductConfig } from "../lib/design";
import { withBase } from "../lib/base-fit";
import { jsonError, ownedProduct } from "./handlers";
import type { CtServiceClient, CtSession } from "./supabase";
import { loadBaseProduct } from "./base-products";
import { templateRow } from "./print-templates";

/** What the snapshot copies from the artwork's config: the design. The rest (photos, mockups) is the product's own. */
const DESIGN_KEYS = ["main", "layouts", "samples", "material", "print", "printGuide", "printSilhouette"] as const;

type Db = CtSession["supabase"] | CtServiceClient;

async function loadDesign(db: Db, artworkId: string): Promise<{ regions: CtRegion[]; items: CtRegionItem[] }> {
  const { data: regions, error } = await db.from(CT_TABLES.regions).select("*").eq("product_id", artworkId).order("sort_order").returns<CtRegion[]>();
  if (error) throw new Error(error.message);
  const ids = (regions ?? []).map((r) => r.id);
  const items: CtRegionItem[] = [];
  for (let i = 0; i < ids.length; i += 60) {
    const { data, error: e } = await db.from(CT_TABLES.items).select("*").in("region_id", ids.slice(i, i + 60)).returns<CtRegionItem[]>();
    if (e) throw new Error(e.message);
    items.push(...(data ?? []));
  }
  return { regions: regions ?? [], items };
}

/** Every artwork id in `json` replaced by its copy's (ids are UUIDs: no other text can match). */
function remap(json: string, map: Record<string, string>): string {
  const keys = Object.keys(map);
  if (!keys.length) return json;
  return json.replace(new RegExp(keys.map((k) => k.replace(/[-]/g, "\\-")).join("|"), "g"), (m) => map[m] ?? m);
}

/**
 * Write the artwork's current design onto `product`: layers + items (stable copied ids), the design part of the
 * config, the versions. First time (no link yet) the product-level config is copied too, as a start.
 */
async function snapshot(db: Db, artwork: CtProduct, product: CtProduct): Promise<CtProduct> {
  const art = normalizeProductConfig(artwork.config);
  if (art.artworkLink) throw new Error(`"${artwork.name}" là sản phẩm làm từ artwork khác — mở artwork gốc của nó`);
  const mine = normalizeProductConfig(product.config);
  const first = !mine.artworkLink;
  const { regions, items } = await loadDesign(db, artwork.id);
  const regionMap: Record<string, string> = {};
  const itemMap: Record<string, string> = {};
  for (const r of regions) regionMap[r.id] = mine.artworkLink?.regionMap[r.id] ?? crypto.randomUUID();
  for (const i of items) itemMap[i.id] = mine.artworkLink?.itemMap[i.id] ?? crypto.randomUUID();
  const map = { ...regionMap, ...itemMap };

  const design: Partial<CtProductConfig> = {};
  for (const k of DESIGN_KEYS) (design as Record<string, unknown>)[k] = art[k];
  // The first time, the product starts from the artwork's photos too (phôi, per-option photos) — keyed on layers.
  const start: Partial<CtProductConfig> = first ? { scene: art.scene, mockupsByOption: art.mockupsByOption, zoneMockups: art.zoneMockups, mockupEdit: art.mockupEdit } : {};
  const copied = JSON.parse(remap(JSON.stringify({ regions, items, design, start }), map)) as {
    regions: CtRegion[];
    items: CtRegionItem[];
    design: Partial<CtProductConfig>;
    start: Partial<CtProductConfig>;
  };

  const { error } = await db.rpc("ct_save_design", {
    p_product_id: product.id,
    p_regions: copied.regions.map((r, i) => ({ ...r, product_id: product.id, sort_order: i })),
    p_items: copied.items,
  });
  if (error) throw new Error(error.message);

  const { data: own } = await db.from(CT_TABLES.assets).select("id").eq("product_id", artwork.id).neq("role", "mockup").returns<Array<{ id: string }>>();
  const link: CtArtworkLink = {
    artworkId: artwork.id,
    revision: art.artworkRevision,
    regionMap,
    itemMap,
    assetIds: (own ?? []).map((a) => a.id),
    syncedAt: new Date().toISOString(),
  };
  const config: CtProductConfig = normalizeProductConfig({ ...mine, ...copied.start, ...copied.design, artworkLink: link, artworkRevision: 0 });
  const { data: saved, error: e2 } = await db
    .from(CT_TABLES.products)
    .update({ config, main_asset_id: artwork.main_asset_id })
    .eq("id", product.id)
    .select("*")
    .single<CtProduct>();
  if (e2 || !saved) throw new Error(e2?.message ?? "Không lưu được sản phẩm");

  // The artwork's versions picked from the library (ct_product_mains): the product uses the same ones.
  const { data: mains } = await db.from(CT_TABLES.productMains).select("asset_id,sort_order").eq("product_id", artwork.id).returns<Array<{ asset_id: string; sort_order: number }>>();
  await db.from(CT_TABLES.productMains).delete().eq("product_id", product.id);
  if (mains?.length) await db.from(CT_TABLES.productMains).insert(mains.map((m) => ({ product_id: product.id, asset_id: m.asset_id, sort_order: m.sort_order })));
  return applyBase(db, saved);
}

async function loadTemplate(db: Db, id: string | null): Promise<CtPrintTemplate | null> {
  if (!id) return null;
  const { data } = await db.from(CT_TABLES.printTemplates).select("*").eq("id", id).maybeSingle<CtPrintTemplate>();
  return data ? templateRow(data) : null;
}

/**
 * Lay the product's artwork on its base (lib/base-fit withBase), saved into the product: the base's khuôn as a khuôn
 * layer (the previous one taken out), its material / mm / silhouette, its preview photo. Run after every snapshot,
 * base change and placement change — so the storefront, the deploy and the server print read the product as it is.
 */
export async function applyBase(db: Db, product: CtProduct): Promise<CtProduct> {
  if (product.kind !== "product") return product;
  const config = normalizeProductConfig(product.config);
  const base = product.base_product_id ? await loadBaseProduct(db, product.base_product_id) : null;
  if (!base) return product;
  const { data: main } = product.main_asset_id
    ? await db.from(CT_TABLES.assets).select("width,height").eq("id", product.main_asset_id).maybeSingle<{ width: number; height: number }>()
    : { data: null };
  if (!main?.width || !main.height) return product;
  const template = await loadTemplate(db, base.config.templateId);
  const { regions, items } = await loadDesign(db, product.id);
  const frameId = config.baseFrameId ?? crypto.randomUUID();
  const fit = withBase({ productId: product.id, config, regions, main }, base, template, config.placement, frameId);
  const hadFrame = regions.some((r) => r.id === frameId);
  if (fit.frame || hadFrame) {
    const { error } = await db.rpc("ct_save_design", {
      p_product_id: product.id,
      p_regions: fit.regions.map((r, i) => ({ ...r, product_id: product.id, sort_order: i })),
      p_items: items.filter((i) => fit.regions.some((r) => r.id === i.region_id)),
    });
    if (error) throw new Error(error.message);
  }
  const next: CtProductConfig = { ...fit.config, baseFrameId: fit.frame ? frameId : null };
  const { data: saved, error } = await db.from(CT_TABLES.products).update({ config: next }).eq("id", product.id).select("*").single<CtProduct>();
  if (error || !saved) throw new Error(error?.message ?? "Không lưu được sản phẩm");
  return saved;
}

/** POST products/:id/placement CtBasePlacement — where the artwork sits in the base's khuôn (Teeinblue "Locate artwork"). */
export async function setPlacement(s: CtSession, id: string, body: unknown): Promise<NextResponse> {
  const product = await ownedProduct(s, id);
  if (!product) return jsonError("Không tìm thấy sản phẩm", 404);
  if (product.kind !== "product") return jsonError("Chỉ sản phẩm mới chỉnh vị trí trên khuôn", 400);
  const config = { ...normalizeProductConfig(product.config), placement: normalizePlacement(body) };
  const { data, error } = await s.supabase.from(CT_TABLES.products).update({ config }).eq("id", id).select("*").single<CtProduct>();
  if (error || !data) return jsonError(error?.message ?? "Không lưu được", 500);
  try {
    return NextResponse.json({ product: await applyBase(s.supabase, data) });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không ghép được artwork lên base", 500);
  }
}

async function linkedProducts(db: Db, artworkId: string): Promise<CtProduct[]> {
  const { data } = await db.from(CT_TABLES.products).select("*").eq("config->artworkLink->>artworkId", artworkId).order("created_at").returns<CtProduct[]>();
  return data ?? [];
}

/** GET products/:id/artwork */
export async function artworkStatus(s: CtSession, id: string): Promise<NextResponse> {
  const product = await ownedProduct(s, id);
  if (!product) return jsonError("Không tìm thấy sản phẩm", 404);
  const cfg = normalizeProductConfig(product.config);
  let source: (CtArtworkSource & { linkedRevision: number }) | null = null;
  if (cfg.artworkLink) {
    const { data: art } = await s.supabase.from(CT_TABLES.products).select("id,name,config").eq("id", cfg.artworkLink.artworkId).maybeSingle<Pick<CtProduct, "id" | "name" | "config">>();
    source = art
      ? { id: art.id, name: art.name, revision: normalizeProductConfig(art.config).artworkRevision, linkedRevision: cfg.artworkLink.revision }
      : { id: cfg.artworkLink.artworkId, name: "(artwork đã xoá)", revision: cfg.artworkLink.revision, linkedRevision: cfg.artworkLink.revision };
  }
  const products: CtArtworkProductRow[] = cfg.artworkLink
    ? []
    : (await linkedProducts(s.supabase, id)).map((p) => ({
        id: p.id,
        name: p.name,
        revision: normalizeProductConfig(p.config).artworkLink?.revision ?? 0,
        published_version: p.published_version ?? null,
        shopify: !!p.shopify,
        updated_at: p.updated_at,
      }));
  return NextResponse.json({ revision: cfg.artworkRevision, source, products });
}

/**
 * A product (what is sold) made from `artwork` on `base` — the snapshot + its base product. Its name starts as the
 * artwork's (the theme), renamed freely. The service client (MCP) passes the owner's id.
 */
export async function makeProductFromArtwork(db: Db, userId: string, artwork: CtProduct, base: CtBaseProduct, name?: string): Promise<CtProduct> {
  if ((artwork.kind ?? "artwork") !== "artwork" || normalizeProductConfig(artwork.config).artworkLink) throw new Error(`"${artwork.name}" là sản phẩm, không phải artwork — tạo từ artwork gốc của nó`);
  const title = (name?.trim() || artwork.name).slice(0, 200);
  const { count: before } = await db.from(CT_TABLES.products).select("id", { count: "exact", head: true }).eq("kind", "product").eq("config->artworkLink->>artworkId", artwork.id);
  const { data: product, error } = await db.from(CT_TABLES.products).insert({ user_id: userId, name: title, kind: "product", base_product_id: base.id }).select("*").single<CtProduct>();
  if (error || !product) throw new Error(error?.message ?? "Không tạo được sản phẩm");
  let made: CtProduct;
  try {
    made = await snapshot(db, artwork, product);
  } catch (e) {
    await db.from(CT_TABLES.products).delete().eq("id", product.id);
    throw e;
  }
  // The artwork's first product takes the mockups the artwork still holds (an import's sales pictures, photos made
  // before artworks and products were split, 2026-11-07): an artwork shows none.
  if (!before) await db.from(CT_TABLES.assets).update({ product_id: made.id }).eq("product_id", artwork.id).eq("role", "mockup");
  return made;
}

/**
 * The artwork's first product, made on `base` when it has none yet (an import going to Shopify, the agent).
 */
export async function ensureProductFor(db: Db, userId: string, artwork: CtProduct, base: CtBaseProduct): Promise<CtProduct> {
  const { data: made } = await db.from(CT_TABLES.products).select("*").eq("kind", "product").eq("config->artworkLink->>artworkId", artwork.id).order("created_at").limit(1).returns<CtProduct[]>();
  if (made?.[0]) return made[0];
  return makeProductFromArtwork(db, userId, artwork, base);
}

/** POST products/:id/artwork-products CtCreateFromArtworkBody */
export async function createFromArtwork(s: CtSession, artworkId: string, body: unknown): Promise<NextResponse> {
  const artwork = await ownedProduct(s, artworkId);
  if (!artwork) return jsonError("Không tìm thấy artwork", 404);
  const b = body && typeof body === "object" ? (body as Partial<Record<keyof CtCreateFromArtworkBody, unknown>>) : {};
  const base = typeof b.baseProductId === "string" ? await loadBaseProduct(s.supabase, b.baseProductId) : null;
  if (!base) return jsonError("Chọn product base (loại sản phẩm: biến thể + giá) cho sản phẩm", 400);
  try {
    const product = await makeProductFromArtwork(s.supabase, s.user.id, artwork, base, typeof b.name === "string" ? b.name : undefined);
    return NextResponse.json({ product }, { status: 201 });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không chép được artwork", 500);
  }
}

/** POST products/:id/artwork-sync */
export async function syncFromArtwork(s: CtSession, id: string): Promise<NextResponse> {
  const product = await ownedProduct(s, id);
  if (!product) return jsonError("Không tìm thấy sản phẩm", 404);
  const link = normalizeProductConfig(product.config).artworkLink;
  if (!link) return jsonError("Sản phẩm này không làm từ artwork nào", 400);
  const artwork = await ownedProduct(s, link.artworkId);
  if (!artwork) return jsonError("Artwork gốc không còn", 404);
  try {
    return NextResponse.json({ product: await snapshot(s.supabase, artwork, product) });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không cập nhật được", 500);
  }
}

/** POST products/:id/artwork-products/sync {ids} */
export async function syncManyFromArtwork(s: CtSession, artworkId: string, body: unknown): Promise<NextResponse> {
  const artwork = await ownedProduct(s, artworkId);
  if (!artwork) return jsonError("Không tìm thấy artwork", 404);
  const ids = body && typeof body === "object" && Array.isArray((body as { ids?: unknown }).ids) ? ((body as { ids: unknown[] }).ids.filter((x) => typeof x === "string") as string[]) : [];
  const linked = new Map((await linkedProducts(s.supabase, artworkId)).map((p) => [p.id, p]));
  const updated: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const id of ids) {
    const p = linked.get(id);
    if (!p) {
      failed.push({ id, error: "Không làm từ artwork này" });
      continue;
    }
    try {
      await snapshot(s.supabase, artwork, p);
      updated.push(id);
    } catch (e) {
      failed.push({ id, error: e instanceof Error ? e.message : "Lỗi" });
    }
  }
  return NextResponse.json({ updated, failed });
}
