/**
 * A bộ nhân vật v2 dropped into a product (asked 2026-10-29): the layers of the set's own product (server/char/
 * product.ts — every image layer the same box, files 1:1 on the set's canvas) copied onto one version of another
 * product, tagged CtRegionConfig.charSet so the editor lists them as one "bộ" layer. The set's canvas is contain-fitted
 * into the artboard as a whole — never layer by layer — so the clipart stay pixel-registered.
 *
 * Only what another product can reference comes along: library cliparts (product_id null — the set's folder) and
 * text / photo zones. A layer using the set product's own pictures, or its khuôn vật liệu, stays behind.
 *
 * A set whose product has several versions (Boy / Girl, 1–5 people) lands as OPTIONS of the one version it is dropped
 * on (asked 2026-10-29): a chooser layer that draws nothing ("Chọn — …", buttons named after the set's versions — the
 * way server/char/product.ts makes brief.choosers), each set version's layers hanging under its option (config.parent).
 *
 * charSetLayers is pure; charSetDrop makes the chooser's pictures through `makeChooser` (the editor uploads them, the
 * server inserts them when a remade set refreshes the products using it — server/char/set-users.ts).
 */

import type { CtAsset, CtProductBundle, CtRegion, CtRegionCharSet, CtRegionItem, CtShape } from "../types";
import { defaultRegionConfig, mainVersions, normalizeProductConfig, normalizeRegion } from "./design";
import { IDENTITY_TRANSFORM, fitShapeToBounds, newId, shapeBounds } from "./geometry";
import { cloneLayers, resolveLayout } from "./layout";

export interface CtCharSetLayers {
  regions: CtRegion[];
  items: CtRegionItem[];
  /** Library cliparts the copied layers use (and their đa sắc / vật liệu), for the editor's asset list. */
  assets: CtAsset[];
  /** Layers left behind (they use the set product's own pictures, or are its khuôn). */
  skipped: number;
}

export interface CtCharSetTarget {
  productId: string;
  mainId: string;
  board: { w: number; h: number };
  firstOrder: number;
}

/** The layers of ONE version of the set's product (`srcMainId`, default: its default version). */
export function charSetLayers(bundle: CtProductBundle, target: CtCharSetTarget, set: CtRegionCharSet, srcMainId?: string): CtCharSetLayers {
  const src = bundle.product;
  const srcMain = bundle.assets.find((a) => a.id === (srcMainId ?? src.main_asset_id));
  if (!srcMain) throw new Error("Sản phẩm của bộ chưa có version");
  const config = normalizeProductConfig(src.config);
  const shown = resolveLayout(bundle.regions.map(normalizeRegion), bundle.items, config.layouts, srcMain.id);
  const library = new Map(bundle.assets.filter((a) => a.product_id === null && a.role !== "main").map((a) => [a.id, a]));

  let skipped = 0;
  const keep: CtRegion[] = [];
  for (const r of [...shown.regions].sort((a, b) => a.sort_order - b.sort_order)) {
    if (r.config.materialFrame) {
      skipped++;
      continue;
    }
    if (r.kind === "image") {
      const own = shown.items.filter((i) => i.region_id === r.id);
      if (!own.length || own.some((i) => !library.has(i.asset_id))) {
        skipped++;
        continue;
      }
    }
    keep.push(r);
  }

  const cloned = cloneLayers(keep, shown.items, target.mainId);
  // The set's canvas fitted into the artboard, centred (identity when they are the same size).
  const k = Math.min(target.board.w / Math.max(1, srcMain.width), target.board.h / Math.max(1, srcMain.height));
  const ox = (target.board.w - srcMain.width * k) / 2;
  const oy = (target.board.h - srcMain.height * k) / 2;
  const same = Math.abs(k - 1) < 1e-6 && Math.abs(ox) < 1e-6 && Math.abs(oy) < 1e-6;
  const place = (s: CtShape): CtShape => {
    if (same) return s;
    const b = shapeBounds(s);
    return fitShapeToBounds(s, { x: ox + b.x * k, y: oy + b.y * k, w: b.w * k, h: b.h * k });
  };
  const regions = cloned.regions.map((r, i): CtRegion => ({
    ...r,
    product_id: target.productId,
    shape: place(r.shape),
    sort_order: target.firstOrder + i,
    config: {
      ...r.config,
      text: same ? r.config.text : { ...r.config.text, fontSize: r.config.text.fontSize * k, strokeWidth: r.config.text.strokeWidth * k },
      charSet: set,
    },
  }));

  const used = new Set(cloned.items.map((i) => i.asset_id));
  // A clipart brings its đa sắc / vật liệu (children in the bundle) along, as the library drop does.
  const assets = [...library.values()].filter((a) => used.has(a.id) || (a.parent_id !== null && used.has(a.parent_id)));
  return { regions, items: cloned.items, assets, skipped };
}

/**
 * The whole set onto version `target.mainId`: its one version as it is, or every version as an option of a chooser.
 * `makeChooser(names)` → one picture per name, the first a gốc and the others its đa sắc (they are the options).
 */
export async function charSetDrop(
  bundle: CtProductBundle,
  target: CtCharSetTarget,
  set: CtRegionCharSet,
  makeChooser: (names: string[]) => Promise<CtAsset[]>,
): Promise<CtCharSetLayers> {
  const versions = mainVersions(bundle.assets, bundle.product.main_asset_id);
  if (versions.length < 2) return charSetLayers(bundle, target, set);
  const label = normalizeProductConfig(bundle.product.config).main.label || "Choose character";
  const pictures = await makeChooser(versions.map((v, i) => v.name || `${i + 1}`));
  const cfg = defaultRegionConfig("image");
  const chooser: CtRegion = {
    id: newId(),
    product_id: target.productId,
    name: `Chọn — ${label}`,
    kind: "image",
    shape: { type: "rect", x: 0, y: 0, w: 1, h: 1, radius: 0 },
    config: { ...cfg, clip: false, mainId: target.mainId, image: { ...cfg.image, label, display: "button" }, charSet: set },
    sort_order: target.firstOrder,
  };
  const out: CtCharSetLayers = {
    regions: [chooser],
    items: [{ id: newId(), region_id: chooser.id, asset_id: pictures[0].id, transform: IDENTITY_TRANSFORM, is_default: true, sort_order: 0 }],
    assets: pictures,
    skipped: 0,
  };
  for (const [i, v] of versions.entries()) {
    const got = charSetLayers(bundle, { ...target, firstOrder: target.firstOrder + out.regions.length }, set, v.id);
    // The version's own layers (not its child zones — they keep their parent) hang under its option.
    const option = { regionId: chooser.id, optionId: pictures[i].id };
    out.regions.push(...got.regions.map((r) => (r.config.parent ? r : { ...r, config: { ...r.config, parent: option } })));
    out.items.push(...got.items);
    out.assets.push(...got.assets.filter((a) => !out.assets.some((x) => x.id === a.id)));
    out.skipped += got.skipped;
  }
  return out;
}
