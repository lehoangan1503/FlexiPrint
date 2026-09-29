/**
 * Design-level helpers shared by the editor, the preview, the compositor and
 * the Shopify storefront runtime. Pure — no DOM, no React.
 */

import { CT_FONTS } from "../config";
import { CT_MAIN_KEY } from "../types";
import type {
  CtMainOptionConfig,
  CtPhotoConfig,
  CtPhotoStyleRef,
  CtProductConfig,
  CtRegion,
  CtRegionConfig,
  CtRegionItem,
  CtRegionKind,
  CtRegionSelection,
  CtRenderAsset,
  CtSelection,
  CtShape,
} from "../types";
import { IDENTITY_TRANSFORM, newId } from "./geometry";
import { isAiStyleRef, isPhotoStyleRef } from "./photo-styles";
import { normalizeLayouts } from "./layout";
import { defaultMaterialConfig, normalizeMaterialConfig } from "./materials";

export function defaultRegionConfig(kind: CtRegionKind): CtRegionConfig {
  return {
    clip: true,
    aboveMain: true,
    image: {
      label: "Choose option",
      display: "image",
      groupLabel: "Choose style",
      groupDisplay: "button",
      groupNames: {},
      hiddenAssetIds: [],
      allowNone: false,
    },
    text: {
      label: "Enter name",
      placeholder: "Example: Sophia",
      defaultText: "SOPHIA",
      maxChars: 12,
      fontFamily: CT_FONTS[1].family,
      fontWeight: 700,
      fontSize: 96,
      color: "#3b2412",
      strokeColor: "#ffffff",
      strokeWidth: 0,
      align: "center",
      letterSpacing: 0,
      curve: 0,
      uppercase: true,
      choices: [],
    },
    photo: {
      label: "Upload your photo",
      fit: "cover",
      required: true,
      styles: ["original"],
      defaultStyle: "original",
      styleLabel: "Choose style",
      cutout: true,
      fadeCrop: true,
    },
  };
}

/** Fill in fields a region saved by an older build may lack. */
export function normalizeRegion(region: CtRegion): CtRegion {
  const base = defaultRegionConfig(region.kind);
  const cfg: Partial<CtRegionConfig> = region.config ?? {};
  return {
    ...region,
    config: {
      clip: cfg.clip ?? base.clip,
      aboveMain: cfg.aboveMain ?? base.aboveMain,
      image: { ...base.image, ...cfg.image },
      text: { ...base.text, ...cfg.text },
      photo: normalizePhotoConfig({ ...base.photo, ...cfg.photo }),
    },
  };
}

/**
 * Drop unknown styles and keep defaultStyle inside the offered list.
 * A zone offers either free styles (customer picks) or exactly one AI style.
 * Cut-out + cropped-edge fade are always on (no longer a per-zone choice), so
 * zones saved with them off pick them up too.
 */
function normalizePhotoConfig(p: CtPhotoConfig): CtPhotoConfig {
  const styles = p.styles.filter((id, i, all) => isPhotoStyleRef(id) && all.indexOf(id) === i);
  // An AI style is used alone (no customer dropdown); only free styles combine.
  const aiStyle = styles.find(isAiStyleRef);
  const list: CtPhotoStyleRef[] = aiStyle ? [aiStyle] : styles.length ? styles : ["original"];
  return { ...p, cutout: true, fadeCrop: true, styles: list, defaultStyle: list.includes(p.defaultStyle) ? p.defaultStyle : list[0] };
}

export function defaultProductConfig(): CtProductConfig {
  return { main: { enabled: false, label: "Choose color", display: "swatch" }, layouts: {}, material: defaultMaterialConfig() };
}

export function normalizeProductConfig(raw: Partial<CtProductConfig> | null | undefined): CtProductConfig {
  const base = defaultProductConfig();
  const main: Partial<CtMainOptionConfig> = raw?.main ?? {};
  return { main: { ...base.main, ...main }, layouts: normalizeLayouts(raw?.layouts), material: normalizeMaterialConfig(raw?.material) };
}

export function makeRegion(productId: string, kind: CtRegionKind, shape: CtShape, index: number): CtRegion {
  const names: Record<CtRegionKind, string> = { image: "Custom layer", text: "Text zone", photo: "Photo zone" };
  return {
    id: newId(),
    product_id: productId,
    name: `${names[kind]} ${index + 1}`,
    kind,
    shape,
    config: defaultRegionConfig(kind),
    sort_order: index,
  };
}

export function makeItem(regionId: string, assetId: string, index: number): CtRegionItem {
  return {
    id: newId(),
    region_id: regionId,
    asset_id: assetId,
    transform: { ...IDENTITY_TRANSFORM },
    is_default: index === 0,
    sort_order: index,
  };
}

function byOrder(a: CtRenderAsset, b: CtRenderAsset): number {
  return a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at);
}

/** Versions of a sub asset, in display order. */
export function variantsOf<A extends CtRenderAsset>(assets: A[], subId: string): A[] {
  return assets.filter((a) => a.role === "variant" && a.parent_id === subId).sort(byOrder);
}

/** Regions in customer-form order: the Layers panel order (topmost first). */
export function formOrder(regions: CtRegion[]): CtRegion[] {
  return [...regions].sort((a, b) => b.sort_order - a.sort_order);
}

// ---------------------------------------------------------------------------
// Main versions
// ---------------------------------------------------------------------------

/** Every main asset is a version of the main object; the default comes first. */
export function mainVersions<A extends CtRenderAsset>(assets: A[], defaultMainId: string | null): A[] {
  const mains = assets.filter((a) => a.role === "main").sort(byOrder);
  const def = mains.find((m) => m.id === defaultMainId);
  return def ? [def, ...mains.filter((m) => m !== def)] : mains;
}

/** The main version a selection shows (falls back to the default main). */
export function selectedMainId(selection: CtSelection, assets: CtRenderAsset[], defaultMainId: string): string {
  const sel = selection[CT_MAIN_KEY];
  if (sel?.kind === "main" && sel.assetId && assets.some((a) => a.id === sel.assetId && a.role === "main")) return sel.assetId;
  return defaultMainId;
}

// ---------------------------------------------------------------------------
// Image zones: groups and options
// ---------------------------------------------------------------------------

export interface CtChoiceGroup<A extends CtRenderAsset = CtRenderAsset> {
  item: CtRegionItem;
  name: string;
  /** Offered options: the sub asset, then its variants, minus hidden ones. */
  options: A[];
}

export function regionGroups<A extends CtRenderAsset>(region: CtRegion, items: CtRegionItem[], assets: A[]): Array<CtChoiceGroup<A>> {
  const cfg = normalizeRegion(region).config.image;
  const hidden = new Set(cfg.hiddenAssetIds);
  const byId = new Map(assets.map((a) => [a.id, a]));
  const out: Array<CtChoiceGroup<A>> = [];
  for (const item of items.filter((i) => i.region_id === region.id).sort((a, b) => a.sort_order - b.sort_order)) {
    const sub = byId.get(item.asset_id);
    if (!sub) continue;
    const options = [sub, ...variantsOf(assets, sub.id)].filter((a) => !hidden.has(a.id));
    if (options.length === 0) continue;
    out.push({ item, name: cfg.groupNames[item.id]?.trim() || sub.name || "Group", options });
  }
  return out;
}

/**
 * A choice the customer can make in an image region (flattened over groups).
 * Kept for bulk combination export.
 */
export interface CtChoice<A extends CtRenderAsset = CtRenderAsset> {
  asset: A;
  item: CtRegionItem;
}

export function regionChoices<A extends CtRenderAsset>(region: CtRegion, items: CtRegionItem[], assets: A[]): Array<CtChoice<A>> {
  return regionGroups(region, items, assets).flatMap((g) => g.options.map((asset) => ({ asset, item: g.item })));
}

/** Group index + option index of an asset inside a region; -1 when not offered. */
export function locateOption(groups: CtChoiceGroup[], assetId: string | null): { group: number; option: number } {
  if (!assetId) return { group: -1, option: -1 };
  for (let g = 0; g < groups.length; g++) {
    const o = groups[g].options.findIndex((a) => a.id === assetId);
    if (o >= 0) return { group: g, option: o };
  }
  return { group: -1, option: -1 };
}

/** Switch group, keeping the option position ("blue" stays "blue"). */
export function optionInGroup(groups: CtChoiceGroup[], groupIndex: number, currentAssetId: string | null): string | null {
  const g = groups[groupIndex];
  if (!g) return null;
  const { option } = locateOption(groups, currentAssetId);
  return g.options[Math.min(Math.max(option, 0), g.options.length - 1)].id;
}

// ---------------------------------------------------------------------------
// Selections
// ---------------------------------------------------------------------------

export function defaultSelection(
  regions: CtRegion[],
  items: CtRegionItem[],
  assets: CtRenderAsset[],
  defaultMainId: string | null,
): CtSelection {
  const sel: CtSelection = { [CT_MAIN_KEY]: { kind: "main", assetId: defaultMainId } };
  for (const region of regions) {
    sel[region.id] = defaultRegionSelection(region, items, assets);
  }
  return sel;
}

export function defaultRegionSelection(region: CtRegion, items: CtRegionItem[], assets: CtRenderAsset[]): CtRegionSelection {
  const r = normalizeRegion(region);
  switch (r.kind) {
    case "text":
      return { kind: "text", text: r.config.text.choices[0] ?? r.config.text.defaultText };
    case "photo":
      return { kind: "photo", url: null, transform: { ...IDENTITY_TRANSFORM }, style: r.config.photo.defaultStyle, sourceUrl: null };
    case "image": {
      const groups = regionGroups(r, items, assets);
      const def = groups.find((g) => g.item.is_default) ?? groups[0];
      return { kind: "image", assetId: def ? def.options[0].id : null };
    }
  }
}

/** Is `sel` still a legal choice for `region` after zones/items/assets changed? */
export function isSelectionValid(
  region: CtRegion,
  sel: CtSelection[string] | undefined,
  items: CtRegionItem[],
  assets: CtRenderAsset[],
): boolean {
  if (!sel || sel.kind !== region.kind) return false;
  if (sel.kind !== "image") return true;
  const r = normalizeRegion(region);
  const choices = regionChoices(r, items, assets);
  if (sel.assetId === null) return r.config.image.allowNone || choices.length === 0;
  return choices.some((c) => c.asset.id === sel.assetId);
}

/** Every combination of main versions × image-region choices, capped (bulk composite export). */
export function enumerateCombinations(
  regions: CtRegion[],
  items: CtRegionItem[],
  assets: CtRenderAsset[],
  base: CtSelection,
  limit: number,
  mains: CtRenderAsset[] = [],
): CtSelection[] {
  let combos: CtSelection[] = [{ ...base }];
  const axes: Array<{ key: string; values: Array<CtSelection[string]> }> = [];
  if (mains.length > 1) axes.push({ key: CT_MAIN_KEY, values: mains.map((m) => ({ kind: "main", assetId: m.id })) });
  for (const region of regions.filter((r) => r.kind === "image")) {
    const choices = regionChoices(region, items, assets);
    if (choices.length) axes.push({ key: region.id, values: choices.map((c) => ({ kind: "image", assetId: c.asset.id })) });
  }
  for (const axis of axes) {
    const next: CtSelection[] = [];
    for (const combo of combos) {
      for (const v of axis.values) {
        next.push({ ...combo, [axis.key]: v });
        if (next.length >= limit) break;
      }
      if (next.length >= limit) break;
    }
    combos = next;
  }
  return combos.slice(0, limit);
}

export function randomSelection(
  regions: CtRegion[],
  items: CtRegionItem[],
  assets: CtRenderAsset[],
  base: CtSelection,
  mains: CtRenderAsset[] = [],
): CtSelection {
  const sel: CtSelection = { ...base };
  const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];
  if (mains.length > 1) sel[CT_MAIN_KEY] = { kind: "main", assetId: pick(mains).id };
  for (const region of regions.filter((r) => r.kind === "image")) {
    const choices = regionChoices(region, items, assets);
    if (choices.length === 0) continue;
    sel[region.id] = { kind: "image", assetId: pick(choices).asset.id };
  }
  return sel;
}

/** Google Fonts families a set of regions needs. */
export function fontsUsed(regions: CtRegion[]): string[] {
  return Array.from(new Set(regions.filter((r) => r.kind === "text").map((r) => normalizeRegion(r).config.text.fontFamily)));
}
