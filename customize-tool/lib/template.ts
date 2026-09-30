/**
 * Build the published template (what the storefront renders) from a product
 * bundle. Only assets the customer can actually reach are included, so the
 * JSON stays small and never leaks references / composites / mockups.
 *
 * Pure: the server runs it on Publish, the editor's "Xem trước" tab runs it
 * on the unsaved draft so the preview is exactly what Publish would ship.
 */

import type { CtAsset, CtProduct, CtProductConfig, CtPublicAiStyle, CtRegion, CtRegionItem, CtRenderAsset, CtTemplate } from "../types";
import { mainVersions, normalizeProductConfig, normalizeRegion, variantsOf } from "./design";
import { pruneLayout } from "./layout";
import { withRenditions } from "./library";

function renderAsset(a: CtAsset): CtRenderAsset {
  return {
    id: a.id,
    role: a.role,
    parent_id: a.parent_id,
    name: a.name,
    url: a.url,
    width: a.width,
    height: a.height,
    // Only what rendering / the option UI reads.
    meta: a.meta?.swatch ? { swatch: a.meta.swatch } : {},
    sort_order: a.sort_order,
    created_at: a.created_at,
  };
}

export function buildTemplate(args: {
  product: CtProduct;
  assets: CtAsset[];
  regions: CtRegion[];
  items: CtRegionItem[];
  version: number;
  publishedAt: string;
  /** Names of the AI styles the zones offer (the prompt never goes into the template). */
  aiStyles?: CtPublicAiStyle[];
}): CtTemplate {
  const { product, version, publishedAt } = args;
  const config = normalizeProductConfig(product.config);
  // "Rendition" display: the storefront draws the AI material versions; print files keep the flat art.
  const assets = config.material.display === "rendition" ? withRenditions(args.assets) : args.assets.filter((a) => a.role !== "rendition");
  const main = assets.find((a) => a.id === product.main_asset_id && a.role === "main");
  if (!main) throw new Error("Chưa có main object — không publish được");

  const regions = args.regions.map(normalizeRegion).sort((a, b) => a.sort_order - b.sort_order);
  const regionIds = new Set(regions.map((r) => r.id));
  const byId = new Map(assets.map((a) => [a.id, a]));
  const items = args.items.filter((i) => regionIds.has(i.region_id) && byId.get(i.asset_id)?.role === "sub");

  const used = new Map<string, CtAsset>();
  const mains = config.main.enabled ? mainVersions(assets, main.id) : [main];
  for (const m of mains) used.set(m.id, m);
  for (const it of items) {
    const sub = byId.get(it.asset_id);
    if (!sub) continue;
    used.set(sub.id, sub);
    for (const v of variantsOf(assets, sub.id)) used.set(v.id, v);
  }

  // Only layouts of versions the customer can pick, pointing at zones / items that still exist.
  const itemIds = new Set(items.map((i) => i.id));
  const layouts: CtProductConfig["layouts"] = {};
  for (const m of mains) {
    const l = config.layouts[m.id];
    if (l) layouts[m.id] = pruneLayout(l, regionIds, itemIds);
  }
  return {
    schema: 1,
    productId: product.id,
    version,
    name: product.name,
    publishedAt,
    mainAssetId: main.id,
    width: main.width,
    height: main.height,
    config: { ...config, layouts },
    assets: Array.from(used.values()).map(renderAsset),
    regions,
    items,
    aiStyles: args.aiStyles ?? [],
  };
}
