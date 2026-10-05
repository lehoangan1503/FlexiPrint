/**
 * Design-level helpers shared by the editor, the preview, the compositor and
 * the Shopify storefront runtime. Pure — no DOM, no React.
 */

import { CT_FONTS } from "../config";
import { CT_MAIN_KEY } from "../types";
import type {
  CtMainOptionConfig,
  CtMainSubOptions,
  CtPhotoConfig,
  CtPhotoFrame,
  CtPhotoMode,
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
  CtTransform,
} from "../types";
import { IDENTITY_PHOTO_FRAME, IDENTITY_TRANSFORM, newId } from "./geometry";
import { CT_FACE_STYLES, isAiStyleRef, isPhotoStyleRef, styleFamily } from "./photo-styles";
import { normalizeLayouts, onVersion } from "./layout";
import { defaultMaterialConfig, normalizeMaterialConfig } from "./materials";
import { defaultScene, normalizeScene } from "./scene";

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
      frame: { ...IDENTITY_PHOTO_FRAME },
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
      ...(cfg.mainId ? { mainId: cfg.mainId } : {}),
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
  // An AI style is used alone (no customer dropdown); free or face styles combine within their family.
  const aiStyle = styles.find(isAiStyleRef);
  const family = aiStyle ? "ai" : styles[0] ? styleFamily(styles[0]) : "free";
  const same = styles.filter((s) => styleFamily(s) === family);
  // Face is a fixed set: every filter, whichever were stored.
  const list: CtPhotoStyleRef[] = aiStyle ? [aiStyle] : family === "face" ? CT_FACE_STYLES.map((s) => s.id) : same.length ? same : ["original"];
  const mode: CtPhotoMode | undefined = p.mode === "free" || p.mode === "ai" || p.mode === "face" ? p.mode : undefined;
  const f: Partial<CtPhotoFrame> = p.frame ?? {};
  const num = (v: unknown, fallback: number, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
  const frame: CtPhotoFrame = {
    offsetX: num(f.offsetX, 0, -5, 5),
    offsetY: num(f.offsetY, 0, -5, 5),
    scaleX: num(f.scaleX, 1, 0.02, 20),
    scaleY: num(f.scaleY, 1, 0.02, 20),
    rotation: num(f.rotation, 0, -360, 360),
    auto: false,
    tilt: typeof f.tilt === "number" && Number.isFinite(f.tilt) ? Math.min(180, Math.max(-180, f.tilt)) : null,
    padding: num(f.padding, 0, 0, 0.45),
    enabled: f.enabled !== false,
  };
  // Face zones saved before `auto` existed fit the head automatically unless their frame was moved by hand.
  const untouched = frame.offsetX === 0 && frame.offsetY === 0 && frame.scaleX === 1 && frame.scaleY === 1 && frame.rotation === 0 && frame.padding === 0;
  frame.auto = typeof f.auto === "boolean" ? f.auto : family === "face" && untouched;
  return { ...p, mode, frame, cutout: true, fadeCrop: true, styles: list, defaultStyle: list.includes(p.defaultStyle) ? p.defaultStyle : list[0] };
}

export function defaultProductConfig(): CtProductConfig {
  return { main: { enabled: false, label: "Choose color", display: "image", subOptions: [] }, scene: defaultScene(), layouts: {}, material: defaultMaterialConfig(), samples: {} };
}

/** Keep well-formed choices only; photos must be stored URLs (a blob: URL dies with its tab). */
export function normalizeSamples(raw: unknown): CtSelection {
  const out: CtSelection = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const stored = (u: unknown): string | null => (typeof u === "string" && /^https?:\/\//.test(u) ? u : null);
  for (const [key, v] of Object.entries(raw as Record<string, CtSelection[string]>)) {
    if (!v || typeof v !== "object" || key.length > 64) continue;
    if (v.kind === "main") out[key] = { kind: "main", assetId: typeof v.assetId === "string" ? v.assetId : null, ...(typeof v.optionId === "string" ? { optionId: v.optionId } : {}) };
    else if (v.kind === "image") out[key] = { kind: "image", assetId: typeof v.assetId === "string" ? v.assetId : null };
    else if (v.kind === "text") out[key] = { kind: "text", text: typeof v.text === "string" ? v.text.slice(0, 500) : "" };
    else if (v.kind === "photo") {
      const t: Partial<CtTransform> = v.transform ?? {};
      const n = (x: unknown, fallback: number) => (typeof x === "number" && Number.isFinite(x) ? x : fallback);
      out[key] = {
        kind: "photo",
        url: stored(v.url),
        sourceUrl: stored(v.sourceUrl),
        ...(typeof v.style === "string" && isPhotoStyleRef(v.style) ? { style: v.style } : {}),
        transform: { offsetX: n(t.offsetX, 0), offsetY: n(t.offsetY, 0), scale: n(t.scale, 1), rotation: n(t.rotation, 0) },
      };
    }
  }
  return out;
}

export function normalizeProductConfig(raw: Partial<CtProductConfig> | null | undefined): CtProductConfig {
  const base = defaultProductConfig();
  const main: Partial<CtMainOptionConfig> = raw?.main ?? {};
  return {
    main: { ...base.main, ...main, subOptions: normalizeSubOptions(main.subOptions) },
    scene: normalizeScene(raw?.scene),
    layouts: normalizeLayouts(raw?.layouts),
    material: normalizeMaterialConfig(raw?.material),
    samples: normalizeSamples(raw?.samples),
  };
}

/** One entry per version, ids unique across versions (an asset is the sub-option of one version only). */
export function normalizeSubOptions(raw: unknown): CtMainSubOptions[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: CtMainSubOptions[] = [];
  for (const e of raw as Array<Partial<CtMainSubOptions> | null>) {
    if (!e || typeof e.mainId !== "string" || !e.mainId || seen.has(e.mainId) || !Array.isArray(e.ids)) continue;
    seen.add(e.mainId);
    const ids = e.ids.filter((id): id is string => typeof id === "string" && id !== "" && id !== e.mainId && !seen.has(id));
    for (const id of ids) seen.add(id);
    if (ids.length) out.push({ mainId: e.mainId, ids: ids.slice(0, 24) });
  }
  return out;
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

/**
 * Sub-options of version `mainId` ("Thêm option"), in the editor's order: they are in the bundle / template as
 * role "variant" with parent = the version. The version itself is not included.
 */
export function mainSubOptions<A extends CtRenderAsset>(assets: A[], main: Pick<CtMainOptionConfig, "subOptions">, mainId: string): A[] {
  const ids = main.subOptions.find((e) => e.mainId === mainId)?.ids ?? [];
  const byId = new Map(assets.filter((a) => a.role === "variant" && a.parent_id === mainId).map((a) => [a.id, a]));
  return ids.map((id) => byId.get(id)).filter((a): a is A => a !== undefined);
}

/**
 * The picture drawn for the selected main version: its chosen sub-option, else the version itself. Layers,
 * layout and config always follow the version (selectedMainId).
 */
export function selectedMainImageId(selection: CtSelection, assets: CtRenderAsset[], defaultMainId: string): string {
  const mainId = selectedMainId(selection, assets, defaultMainId);
  const sel = selection[CT_MAIN_KEY];
  const opt = sel?.kind === "main" ? sel.optionId : null;
  if (opt && assets.some((a) => a.id === opt && a.role === "variant" && a.parent_id === mainId)) return opt;
  return mainId;
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
/**
 * A photo zone shows its child frame only while a test photo is in it: the frame is worked out again for every
 * upload, so with no photo (removed, or after a reload) there is nothing to show. The stored frame still applies
 * to customers' photos.
 */
export function hasTestPhoto(sel: CtSelection[string] | undefined): boolean {
  return sel?.kind === "photo" && !!(sel.url || sel.sourceUrl);
}

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

/** The main version a selection names, else `fallback`. */
function shownMain(sel: CtSelection, fallback: string | null): string | null {
  const m = sel[CT_MAIN_KEY];
  return m?.kind === "main" && m.assetId ? m.assetId : fallback;
}

/** Every combination of main versions × image-region choices, capped (bulk composite export). Each version varies only its own layers. */
export function enumerateCombinations(
  regions: CtRegion[],
  items: CtRegionItem[],
  assets: CtRenderAsset[],
  base: CtSelection,
  limit: number,
  mains: CtRenderAsset[] = [],
  defaultMainId: string | null = null,
): CtSelection[] {
  const mainIds: Array<string | null> = mains.length > 1 ? mains.map((m) => m.id) : [shownMain(base, defaultMainId)];
  const out: CtSelection[] = [];
  for (const mainId of mainIds) {
    let combos: CtSelection[] = [mains.length > 1 ? { ...base, [CT_MAIN_KEY]: { kind: "main", assetId: mainId } } : { ...base }];
    const room = limit - out.length;
    for (const region of regions.filter((r) => r.kind === "image" && (mainId === null || onVersion(r, mainId)))) {
      const choices = regionChoices(region, items, assets);
      if (!choices.length) continue;
      const next: CtSelection[] = [];
      for (const combo of combos) {
        for (const c of choices) {
          next.push({ ...combo, [region.id]: { kind: "image", assetId: c.asset.id } });
          if (next.length >= room) break;
        }
        if (next.length >= room) break;
      }
      combos = next;
    }
    out.push(...combos.slice(0, room));
    if (out.length >= limit) break;
  }
  return out;
}

export function randomSelection(
  regions: CtRegion[],
  items: CtRegionItem[],
  assets: CtRenderAsset[],
  base: CtSelection,
  mains: CtRenderAsset[] = [],
  defaultMainId: string | null = null,
): CtSelection {
  const sel: CtSelection = { ...base };
  const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];
  if (mains.length > 1) sel[CT_MAIN_KEY] = { kind: "main", assetId: pick(mains).id };
  const mainId = shownMain(sel, defaultMainId);
  for (const region of regions.filter((r) => r.kind === "image" && (mainId === null || onVersion(r, mainId)))) {
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
