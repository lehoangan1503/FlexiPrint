/**
 * Products using a bộ nhân vật follow it (asked 2026-10-29): when the set's product is built again (a new cut,
 * "Cắt lại", @flexiprint remaking the set) its clipart folder is replaced — so every other product whose layers came
 * from the set (CtRegionConfig.charSet, dropped from the editor's library) gets the set's NEW layers in place of the
 * old ones, on each version that had them, at the same place in its layer order. Hand fixes of one clipart need none
 * of this: they rewrite the file of the same library clipart (server/char/layers.ts).
 */

import sharp from "sharp";
import { CT_TABLES } from "../../config";
import type { CtAsset, CtCharProject, CtProduct, CtProductBundle, CtRegion, CtRegionItem } from "../../types";
import { charSetDrop } from "../../lib/char-set-layers";
import { inChunks } from "../in-chunks";
import { insertClipart, loadProductAssets } from "../library";
import type { CtSession } from "../supabase";

async function bundleOf(db: CtSession["supabase"], productId: string): Promise<CtProductBundle | null> {
  const { data: product } = await db.from(CT_TABLES.products).select("*").eq("id", productId).maybeSingle<CtProduct>();
  if (!product) return null;
  const { data: regions } = await db.from(CT_TABLES.regions).select("*").eq("product_id", productId).order("sort_order").returns<CtRegion[]>();
  const ids = (regions ?? []).map((r) => r.id);
  const items = (await inChunks(ids, (x) => db.from(CT_TABLES.items).select("*").in("region_id", x).returns<CtRegionItem[]>())).sort((a, b) => a.sort_order - b.sort_order);
  const assets = await loadProductAssets(db, product, items, regions ?? []);
  return { product, assets, regions: regions ?? [], items, generations: [] };
}

/** → how many products were refreshed. Errors on one product are logged, the others still follow. */
export async function refreshSetUsers(s: CtSession, p: CtCharProject, newProductId: string): Promise<number> {
  const db = s.supabase;
  const { data: using } = await db.from(CT_TABLES.regions).select("product_id").eq("config->charSet->>projectId", p.id).returns<Array<{ product_id: string }>>();
  const skip = new Set([...p.product_ids, newProductId]);
  const targets = [...new Set((using ?? []).map((r) => r.product_id))].filter((id) => !skip.has(id));
  if (!targets.length) return 0;
  const source = await bundleOf(db, newProductId);
  if (!source) return 0;
  const blank = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const makeChooser = async (names: string[]): Promise<CtAsset[]> => {
    const out: CtAsset[] = [];
    for (const name of names) out.push(await insertClipart(db, s.user.id, { categoryId: null, parentId: out[0]?.id ?? null, rendition: false, name, spec: "", tags: [], source: "ai", meta: {}, generationId: null, data: blank }));
    return out;
  };
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
