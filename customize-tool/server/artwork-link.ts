/**
 * Artwork → products (asked 2026-11-06, like Teeinblue's Artwork ↔ Campaign, with one rule of our own): a product
 * made from an artwork holds a SNAPSHOT of the artwork's design — layers, options, versions, khuôn, print settings.
 * Editing the artwork only changes the artwork (its save bumps config.artworkRevision); a product shows "Có bản
 * artwork mới" until someone updates it by hand (one product, or several at once). Products made for an older design
 * keep that design for as long as nobody updates them.
 *
 *   GET  products/:id/artwork                  → { revision, source, products } — the artwork this product was made
 *                                                 from (if any) and the products made from this one
 *   POST products/:id/artwork-products {name?} → { product } a new product made from this artwork
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
import type { CtArtworkLink, CtArtworkProductRow, CtArtworkSource, CtProduct, CtProductConfig, CtRegion, CtRegionItem } from "../types";
import { normalizeProductConfig } from "../lib/design";
import { jsonError, ownedProduct } from "./handlers";
import type { CtSession } from "./supabase";

/** What the snapshot copies from the artwork's config: the design. The rest (photos, mockups) is the product's own. */
const DESIGN_KEYS = ["main", "layouts", "samples", "material", "print", "printGuide", "printSilhouette"] as const;

type Db = CtSession["supabase"];

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
  return saved;
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

/** POST products/:id/artwork-products {name?} */
export async function createFromArtwork(s: CtSession, artworkId: string, body: unknown): Promise<NextResponse> {
  const artwork = await ownedProduct(s, artworkId);
  if (!artwork) return jsonError("Không tìm thấy artwork", 404);
  if (normalizeProductConfig(artwork.config).artworkLink) return jsonError("Sản phẩm này làm từ artwork khác — tạo từ artwork gốc", 400);
  const raw = body && typeof body === "object" ? (body as { name?: unknown }).name : undefined;
  const name = (typeof raw === "string" && raw.trim() ? raw.trim() : `${artwork.name} — sản phẩm`).slice(0, 200);
  const { data: product, error } = await s.supabase.from(CT_TABLES.products).insert({ user_id: s.user.id, name }).select("*").single<CtProduct>();
  if (error || !product) return jsonError(error?.message ?? "Không tạo được sản phẩm", 500);
  try {
    return NextResponse.json({ product: await snapshot(s.supabase, artwork, product) }, { status: 201 });
  } catch (e) {
    await s.supabase.from(CT_TABLES.products).delete().eq("id", product.id);
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
