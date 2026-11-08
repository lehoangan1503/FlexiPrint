/**
 * Products using a bộ nhân vật follow it (asked 2026-10-29): when the set's product is built again (a new cut,
 * "Cắt lại", @flexiprint remaking the set) its clipart folder is replaced — so every other product whose layers came
 * from the set (CtRegionConfig.charSet, dropped from the editor's library) gets the set's NEW layers in place of the
 * old ones, on each version that had them, at the same place in its layer order. Hand fixes of one clipart need none
 * of this: they rewrite the file of the same library clipart (server/char/layers.ts).
 */

import { NextResponse } from "next/server";
import sharp from "sharp";
import { CT_TABLES } from "../../config";
import type { CtAsset, CtBaseProduct, CtCharProject, CtProduct, CtProductBundle, CtProductCharSet, CtRegion, CtRegionItem } from "../../types";
import { parseCharBrief } from "../../lib/char-brief";
import type { CtPrintTemplate } from "../../types/print";
import { charSetDrop } from "../../lib/char-set-layers";
import { normalizeProductConfig } from "../../lib/design";
import { makeBaseArtwork } from "../print-products";
import { inChunks } from "../in-chunks";
import { insertClipart, loadProductAssets } from "../library";
import type { CtSession } from "../supabase";

export async function bundleOf(db: CtSession["supabase"], productId: string): Promise<CtProductBundle | null> {
  const { data: product } = await db.from(CT_TABLES.products).select("*").eq("id", productId).maybeSingle<CtProduct>();
  if (!product) return null;
  const { data: regions } = await db.from(CT_TABLES.regions).select("*").eq("product_id", productId).order("sort_order").returns<CtRegion[]>();
  const ids = (regions ?? []).map((r) => r.id);
  const items = (await inChunks(ids, (x) => db.from(CT_TABLES.items).select("*").in("region_id", x).returns<CtRegionItem[]>())).sort((a, b) => a.sort_order - b.sort_order);
  const assets = await loadProductAssets(db, product, items, regions ?? []);
  return { product, assets, regions: regions ?? [], items, generations: [] };
}

/** The pictures of a set's version chooser, made on the server (they draw nothing: 8 px transparent). */
function chooserMaker(db: CtSession["supabase"], userId: string): (names: string[]) => Promise<CtAsset[]> {
  return async (names) => {
    const blank = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const out: CtAsset[] = [];
    for (const name of names) out.push(await insertClipart(db, userId, { categoryId: null, parentId: out[0]?.id ?? null, rendition: false, name, spec: "", tags: [], source: "ai", meta: {}, generationId: null, data: blank }));
    return out;
  };
}

/**
 * Another artwork from the set (asked 2026-10-29: no "Tạo sản phẩm custom" button — a new piece, e.g. the glass
 * ornament's set as a rug, is asked in the set's chat), made FOR product base `base` (2026-11-08): a blank canvas of
 * the base's print area, viewed on it, with the whole set dropped on it as the editor's library drop does
 * (CtRegionConfig.charSet — so it is listed in the set's step 4 and follows the set when it is remade). No khuôn layer,
 * no phôi: the base's. The same artwork on another base needs no new artwork — make_product_from_artwork does it.
 */
export async function addSetProduct(db: CtSession["supabase"], userId: string, p: CtCharProject, base: CtBaseProduct, template: CtPrintTemplate | null, name: string): Promise<string> {
  const sourceId = p.product_ids[0];
  const source = sourceId ? await bundleOf(db, sourceId) : null;
  if (!source) throw new Error("The set has no artwork yet — wait for step 3 / char_remake_product first");
  const product = await makeBaseArtwork(db, userId, base, template, name);
  try {
    const b = await bundleOf(db, product.id);
    const board = b?.assets.find((a) => a.id === b.product.main_asset_id);
    if (!b || !board) throw new Error("The new product has no print sheet");
    const got = await charSetDrop(source, { productId: product.id, mainId: board.id, board: { w: board.width, h: board.height }, firstOrder: 0 }, { projectId: p.id, name: p.name }, chooserMaker(db, userId));
    if (!got.regions.length) throw new Error("The set's product has no layer another product can use");
    const regions = [...b.regions, ...got.regions];
    const { error } = await db.rpc("ct_save_design", { p_product_id: product.id, p_regions: regions.map((r, i) => ({ ...r, sort_order: i })), p_items: [...b.items, ...got.items] });
    if (error) throw new Error(error.message);
    return product.id;
  } catch (e) {
    await db.from(CT_TABLES.products).delete().eq("id", product.id);
    throw e;
  }
}

/** → how many products were refreshed. Errors on one product are logged, the others still follow. */
export async function refreshSetUsers(s: CtSession, p: CtCharProject, newProductId: string): Promise<number> {
  const db = s.supabase;
  const { data: using } = await db.from(CT_TABLES.regions).select("product_id").eq("config->charSet->>projectId", p.id).returns<Array<{ product_id: string }>>();
  const skip = new Set([...p.product_ids, newProductId]);
  let targets = [...new Set((using ?? []).map((r) => r.product_id))].filter((id) => !skip.has(id));
  if (!targets.length) return 0;
  // Only artworks follow the set (2026-11-07): a product (what is sold) is a snapshot of its artwork and changes only
  // when someone updates it ("Có bản artwork mới").
  const { data: sold } = await db.from(CT_TABLES.products).select("id").in("id", targets).eq("kind", "product").returns<Array<{ id: string }>>();
  const soldIds = new Set((sold ?? []).map((x) => x.id));
  targets = targets.filter((id) => !soldIds.has(id));
  if (!targets.length) return 0;
  const source = await bundleOf(db, newProductId);
  if (!source) return 0;
  const makeChooser = chooserMaker(db, s.user.id);
  let n = 0;
  for (const productId of targets) {
    try {
      const b = await bundleOf(db, productId);
      const board = b?.assets.find((a) => a.id === b.product.main_asset_id);
      if (!b || !board) continue;
      let regions = [...b.regions].sort((x, y) => x.sort_order - y.sort_order);
      let items = b.items;
      const versions = [...new Set(regions.filter((r) => r.config?.charSet?.projectId === p.id).map((r) => r.config.mainId ?? ""))];
      for (const mainId of versions) {
        const old = new Set(regions.filter((r) => r.config?.charSet?.projectId === p.id && (r.config.mainId ?? "") === mainId).map((r) => r.id));
        const at = regions.findIndex((r) => old.has(r.id));
        const got = await charSetDrop(source, { productId, mainId: mainId || board.id, board: { w: board.width, h: board.height }, firstOrder: 0 }, { projectId: p.id, name: p.name }, makeChooser);
        const keep = regions.filter((r) => !old.has(r.id));
        const before = regions.slice(0, at).filter((r) => !old.has(r.id)).length;
        regions = [...keep.slice(0, before), ...got.regions, ...keep.slice(before)];
        items = [...items.filter((i) => !old.has(i.region_id)), ...got.items];
      }
      const { error } = await db.rpc("ct_save_design", { p_product_id: productId, p_regions: regions.map((r, i) => ({ ...r, sort_order: i })), p_items: items });
      if (error) throw new Error(error.message);
      n++;
    } catch (e) {
      console.warn("[ct] set users refresh", productId, e instanceof Error ? e.message : e);
    }
  }
  return n;
}

/** GET char/projects/:id/used-by — the products made from the set (its own) and every product its layers were dropped
 * into, newest first. */
export async function setProducts(s: CtSession, projectId: string): Promise<NextResponse> {
  const db = s.supabase;
  const { data: p } = await db.from(CT_TABLES.charProjects).select("product_ids").eq("id", projectId).maybeSingle<{ product_ids: string[] | null }>();
  if (!p) return NextResponse.json({ error: "Không tìm thấy bộ nhân vật" }, { status: 404 });
  const own = p.product_ids ?? [];
  const { data: using } = await db.from(CT_TABLES.regions).select("product_id").eq("config->charSet->>projectId", projectId).returns<Array<{ product_id: string }>>();
  const ids = [...new Set([...own, ...(using ?? []).map((r) => r.product_id)])];
  const products = ids.length
    ? ((await db.from(CT_TABLES.products).select("id, name, thumbnail_url, created_at").in("id", ids).order("created_at", { ascending: false }).returns<Array<Pick<CtProduct, "id" | "name" | "thumbnail_url" | "created_at">>>()).data ?? [])
    : [];
  return NextResponse.json({ products: products.map((x) => ({ ...x, own: own.includes(x.id) })) });
}

/** GET char/projects?product=:id — the bộ nhân vật a product uses: the set it was built from (product_ids) first, then
 * every set whose layers were dropped into it (CtRegionConfig.charSet) — the editor's "Bộ nhân vật" button. */
export async function productSets(s: CtSession, productId: string): Promise<NextResponse> {
  const db = s.supabase;
  const { data: own } = await db.from(CT_TABLES.charProjects).select("id, name, brief").contains("product_ids", [productId]).returns<Array<{ id: string; name: string; brief: unknown }>>();
  const { data: dropped } = await db.from(CT_TABLES.regions).select("config").eq("product_id", productId).not("config->charSet", "is", null).returns<Array<Pick<CtRegion, "config">>>();
  const ownIds = new Set((own ?? []).map((x) => x.id));
  const others = [...new Set((dropped ?? []).flatMap((r) => (r.config?.charSet ? [r.config.charSet.projectId] : [])))].filter((id) => !ownIds.has(id));
  const named = others.length ? ((await db.from(CT_TABLES.charProjects).select("id, name, brief").in("id", others).returns<Array<{ id: string; name: string; brief: unknown }>>()).data ?? []) : [];
  // A bộ con is opened in the library, not on the /v2 page (the editor's header button).
  const row = (x: { id: string; name: string; brief: unknown }, own: boolean): CtProductCharSet => ({ id: x.id, name: x.name, own, ...(parseCharBrief(x.brief).extracted ? { extracted: true } : {}) });
  return NextResponse.json({ sets: [...(own ?? []).map((x) => row(x, true)), ...named.map((x) => row(x, false))] });
}
