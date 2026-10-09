/**
 * Build the published template (what the storefront renders) from a product
 * bundle. Only assets the customer can actually reach are included, so the
 * JSON stays small and never leaks references / composites / mockups, nor
 * the design's own samples (config.samples).
 *
 * Pure: the server runs it on Deploy (Publish), the editor's "Xem trước" tab runs it
 * on the unsaved draft so the preview is exactly what a deploy would ship.
 */

import type { CtAsset, CtProduct, CtProductConfig, CtPublicAiStyle, CtRegion, CtRegionItem, CtRenderAsset, CtTemplate } from "../types";
import { defaultRegionSelection, mainSubOptions, mainVersions, normalizeProductConfig, normalizeRegion, variantsOf } from "./design";
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
  // The customer always sees the material version (vật liệu) of every clipart that has one — the canvas, the photo
  // dialog, the cart preview; option swatches keep the flat clipart (meta.thumb). Cliparts switched to flat for
  // this product (flatIds) stay flat. Print files use the flat art (lib/materials, not this template).
  // A mockup edit draws the design in the vật liệu version its tổ hợp shows ("có dây"), like the tổ hợp itself.
  const assets = displayAssets(args.assets, "rendition", config.material.flatIds, config.mockupEdit?.materialVersion ?? config.material.version);
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
  // Custom layers: the customer picks one of the layer's pictures (no editing); the default is the one picked in
  // the editor (the design's own choice), else the first.
  const picks: Record<string, string | null> = {};
  for (const it of items) {
    const sub = byId.get(it.asset_id);
    if (!sub) continue;
    used.set(sub.id, sub);
    for (const v of variantsOf(assets, sub.id)) used.set(v.id, v);
  }
  for (const r of regions.filter((x) => x.kind === "image")) {
    const offered = new Set(items.filter((i) => i.region_id === r.id).flatMap((i) => [i.asset_id, ...variantsOf(assets, i.asset_id).map((v) => v.id)]));
    const sample = config.samples[r.id];
    const fallback = defaultRegionSelection(r, items, assets);
    picks[r.id] = sample?.kind === "image" && sample.assetId && offered.has(sample.assetId) ? sample.assetId : fallback.kind === "image" ? fallback.assetId : null;
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
      mockupEdit: config.mockupEdit,
      // The storefront renders the print file at add-to-cart (sheet, sizes, cut line) and picks the photo per option.
      print: config.print,
      mockupsByOption: config.mockupsByOption,
      zoneMockups: config.zoneMockups,
    },
    // Swatches (main versions, layer options) show the flat clipart; the design is drawn with its material.
    assets: Array.from(used.values()).map((a) => renderAsset(a, flatUrl.get(a.id))),
    regions,
    items,
    aiStyles: args.aiStyles ?? [],
    picks,
  };
}
