/**
 * Build the published template (what the storefront renders) from a product
 * bundle. Only assets the customer can actually reach are included, so the
 * JSON stays small and never leaks references / composites / mockups, nor
 * the design's own samples (config.samples).
 *
 * Pure: the server runs it on Publish, the editor's "Xem trước" tab runs it
 * on the unsaved draft so the preview is exactly what Publish would ship.
 */

import type { CtAsset, CtProduct, CtProductConfig, CtPublicAiStyle, CtRegion, CtRegionItem, CtRenderAsset, CtTemplate } from "../types";
import { mainSubOptions, mainVersions, normalizeProductConfig, normalizeRegion, variantsOf } from "./design";
import { onVersion, pruneLayout } from "./layout";
import { displayAssets } from "./library";

function renderAsset(a: CtAsset, thumb?: string): CtRenderAsset {
  return {
    id: a.id,
    role: a.role,
    parent_id: a.parent_id,
    name: a.name,
    url: a.url,
    width: a.width,
    height: a.height,
    // Only what rendering / the option UI reads.
    meta: {
      ...(a.meta?.swatch ? { swatch: a.meta.swatch } : {}),
      ...(thumb && thumb !== a.url ? { thumb } : {}),
      ...(a.meta?.pad ? { pad: a.meta.pad } : {}),
    },
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
  // "Rendition" display: the AI material versions replace the flat art everywhere (storefront, cart, print).
  const assets = displayAssets(args.assets, config.material.display, config.material.flatIds, config.material.version);
  const flatUrl = new Map(args.assets.map((a) => [a.id, a.url]));
  const main = assets.find((a) => a.id === product.main_asset_id && a.role === "main");
  if (!main) throw new Error("Chưa có main object — không publish được");

  const mains = config.main.enabled ? mainVersions(assets, main.id) : [main];
  // Only layers of versions the customer can pick.
  const regions = args.regions
    .map(normalizeRegion)
    .filter((r) => mains.some((m) => onVersion(r, m.id)))
    .sort((a, b) => a.sort_order - b.sort_order);
  const regionIds = new Set(regions.map((r) => r.id));
  const byId = new Map(assets.map((a) => [a.id, a]));
  const items = args.items.filter((i) => regionIds.has(i.region_id) && byId.get(i.asset_id)?.role === "sub");

  const used = new Map<string, CtAsset>();
  for (const m of mains) {
    used.set(m.id, m);
    // Its sub-options ("Thêm option"): only offered while the customer picks versions.
    if (config.main.enabled) for (const o of mainSubOptions(assets, config.main, m.id)) used.set(o.id, o);
  }
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
    // The design's samples (texts, test photos) stay in the project: customers bring their own.
    config: {
      main: { ...config.main, subOptions: config.main.enabled ? config.main.subOptions.filter((e) => mains.some((m) => m.id === e.mainId)) : [] },
      scene: config.scene,
      layouts,
      material: config.material,
    },
    // Main version swatches show the flat clipart even when the design is drawn with its material.
    assets: Array.from(used.values()).map((a) => renderAsset(a, a.role === "main" || (a.role === "variant" && mains.some((m) => m.id === a.parent_id)) ? flatUrl.get(a.id) : undefined)),
    regions,
    items,
    aiStyles: args.aiStyles ?? [],
  };
}
