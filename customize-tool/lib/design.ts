/**
 * Design-level helpers shared by the editor, the preview, the compositor and
 * the Shopify storefront runtime. Pure — no DOM, no React.
 */

import { CT_FONTS } from "../config";
import { CT_BASE_OPTION, CT_MAIN_KEY } from "../types";
import type {
  CtImageConfig,
  CtMainOptionConfig,
  CtMainSubOptions,
  CtMockupEdit,
  CtPhotoConfig,
  CtPhotoFrame,
  CtPhotoMode,
  CtPhotoStyleRef,
  CtProductConfig,
  CtProductPrint,
  CtProductScene,
  CtRegion,
  CtRegionConfig,
  CtRegionItem,
  CtRegionKind,
  CtRegionSelection,
  CtRenderAsset,
  CtSelection,
  CtShape,
  CtTextMode,
  CtTransform,
  CtZoneParent,
  CtZoneOption,
  CtZoneOptions,
  CtZoneMockup,
  CtZoneTextStyle,
} from "../types";
import { IDENTITY_PHOTO_FRAME, IDENTITY_TRANSFORM, newId } from "./geometry";
import { CT_FACE_STYLES, isAiStyleRef, isPhotoStyleRef, styleFamily } from "./photo-styles";
import { normalizeLayouts, onVersion } from "./layout";
import { defaultMaterialConfig, normalizeMaterialConfig } from "./materials";
import { defaultScene, normalizeScene } from "./scene";
import { isPrintKind, normalizePrintSpec } from "./print-template";

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
      extraOptions: {},
      defaultAssetId: null,
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
    options: { label: kind === "photo" ? "Choose shape" : "Choose style", display: "button", baseName: "Default", list: [] },
  };
}

function normalizeImageConfig(base: CtImageConfig, cfg: Partial<CtImageConfig> | undefined): CtImageConfig {
  const { follows, ...rest } = { ...base, ...cfg };
  return typeof follows === "string" && follows ? { ...rest, follows } : rest;
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
      ...(cfg.parent && typeof cfg.parent.regionId === "string" && typeof cfg.parent.optionId === "string" ? { parent: { regionId: cfg.parent.regionId, optionId: cfg.parent.optionId } } : {}),
      image: normalizeImageConfig(base.image, cfg.image),
      text: { ...base.text, ...cfg.text },
      photo: normalizePhotoConfig({ ...base.photo, ...cfg.photo }),
      options: normalizeZoneOptions(cfg.options, base.options),
      ...(region.kind === "image" && cfg.materialFrame === true ? { materialFrame: true } : {}),
      ...(region.kind === "image" && Array.isArray(cfg.cuts) && cfg.cuts.length
        ? { cuts: cfg.cuts.filter((s): s is CtShape => Boolean(s) && typeof s === "object" && "type" in s) }
        : {}),
      ...(region.kind === "image" && cfg.fill && (cfg.fill.mode === "tile" || cfg.fill.mode === "cover")
        ? { fill: { mode: cfg.fill.mode, tile: Math.max(8, Number(cfg.fill.tile) || 256), ...(typeof cfg.fill.zone === "string" && cfg.fill.zone ? { zone: cfg.fill.zone } : {}) } }
        : {}),
      ...(cfg.printOnly === true ? { printOnly: true } : {}),
    },
  };
}

const TEXT_STYLE_KEYS = ["fontFamily", "fontWeight", "fontSize", "color", "strokeColor", "strokeWidth", "letterSpacing", "curve", "uppercase", "align"] as const;

/** The lettering keys a text sub-option may override. */
export const ZONE_TEXT_STYLE_KEYS: ReadonlyArray<keyof CtZoneTextStyle> = TEXT_STYLE_KEYS;

function normalizeZoneOptions(raw: Partial<CtZoneOptions> | undefined, base: CtZoneOptions): CtZoneOptions {
  const list: CtZoneOption[] = [];
  const seen = new Set<string>();
  for (const o of Array.isArray(raw?.list) ? raw.list : []) {
    if (!o || typeof o.id !== "string" || !o.id || seen.has(o.id)) continue;
    seen.add(o.id);
    const text: CtZoneTextStyle = {};
    if (o.text && typeof o.text === "object") {
      for (const k of TEXT_STYLE_KEYS) if (o.text[k] !== undefined) (text as Record<string, unknown>)[k] = o.text[k];
    }
    list.push({
      id: o.id,
      name: typeof o.name === "string" ? o.name : "",
      ...(typeof o.swatch === "string" && o.swatch ? { swatch: o.swatch } : {}),
      ...(Object.keys(text).length ? { text } : {}),
      ...(o.shape && typeof o.shape === "object" && "type" in o.shape ? { shape: o.shape } : {}),
      ...(typeof o.value === "string" ? { value: o.value } : {}),
    });
    if (list.length >= 24) break;
  }
  return {
    label: typeof raw?.label === "string" ? raw.label : base.label,
    display: raw?.display === "image" || raw?.display === "swatch" || raw?.display === "button" || raw?.display === "dropdown" ? raw.display : base.display,
    baseName: typeof raw?.baseName === "string" ? raw.baseName : base.baseName,
    ...(typeof raw?.baseSwatch === "string" && raw.baseSwatch ? { baseSwatch: raw.baseSwatch } : {}),
    ...(typeof raw?.baseValue === "string" ? { baseValue: raw.baseValue } : {}),
    list,
  };
}

/** What the customer does with a text zone (CtTextConfig.mode; older zones: list when they have choices). */
export function textMode(region: CtRegion): CtTextMode {
  const t = region.config?.text;
  const m = t?.mode;
  if (m === "input" || m === "fixed" || m === "list" || m === "options") return m;
  return (t?.choices ?? []).filter(Boolean).length ? "list" : "input";
}

/** The option id a selection shows for its zone, as CtZoneParent names it (null = no choice / none). */
export function shownOptionId(region: CtRegion, sel: CtSelection[string] | undefined): string | null {
  if (!sel) return null;
  if (region.kind === "image") return sel.kind === "image" ? sel.assetId : null;
  if (sel.kind !== "text" && sel.kind !== "photo") return null;
  return sel.optionId && region.config?.options?.list.some((o) => o.id === sel.optionId) ? sel.optionId : CT_BASE_OPTION;
}

/**
 * Is a (child) zone drawn / asked with this selection? Roots always; a child while its parent is and shows the
 * option it belongs to (CtZoneParent) — all the way up.
 */
export function zoneActive(region: CtRegion, byId: Map<string, CtRegion>, selection: CtSelection, depth = 0): boolean {
  const p: CtZoneParent | undefined = region.config?.parent;
  if (!p) return true;
  const parent = byId.get(p.regionId);
  if (!parent || depth > 12) return false;
  return shownOptionId(parent, selection[parent.id]) === p.optionId && zoneActive(parent, byId, selection, depth + 1);
}

/** The zones a selection draws / asks: roots + the children of the options it shows. */
export function activeRegions<R extends CtRegion>(regions: R[], selection: CtSelection): R[] {
  const byId = new Map<string, CtRegion>(regions.map((r) => [r.id, r]));
  return regions.filter((r) => zoneActive(r, byId, selection));
}

/** The text a text zone draws: typed / picked, the designer's (fixed), or the chosen option's value (options). */
export function zoneText(region: CtRegion, sel: CtSelection[string] | undefined): string {
  const mode = textMode(region);
  if (mode === "fixed") return region.config.text.defaultText;
  if (mode === "options") {
    const o = region.config.options;
    const opt = sel?.kind === "text" && sel.optionId ? o.list.find((x) => x.id === sel.optionId) : undefined;
    return opt ? (opt.value ?? opt.name) : (o.baseValue ?? o.baseName);
  }
  return sel?.kind === "text" ? sel.text : "";
}

/** The sub-option a selection picks for its zone (null = the zone's own look). */
export function zoneOptionOf(region: CtRegion, sel: CtSelection[string] | undefined): CtZoneOption | null {
  if (!sel || (sel.kind !== "text" && sel.kind !== "photo") || !sel.optionId) return null;
  return region.config?.options?.list.find((o) => o.id === sel.optionId) ?? null;
}

/** `region` as sub-option `option` draws it: its shape and (text) lettering swapped in. */
export function withZoneOption(region: CtRegion, option: CtZoneOption | null): CtRegion {
  if (!option || (!option.shape && !option.text)) return region;
  const n = normalizeRegion(region);
  return {
    ...n,
    ...(option.shape ? { shape: option.shape } : {}),
    config: option.text ? { ...n.config, text: { ...n.config.text, ...option.text } } : n.config,
  };
}

/** The zone as the selection shows it. */
export function regionForSelection(region: CtRegion, sel: CtSelection[string] | undefined): CtRegion {
  return withZoneOption(region, zoneOptionOf(region, sel));
}

/**
 * Drop unknown styles and keep defaultStyle inside the offered list.
 * A zone offers styles of ONE family, customer picks: free filters, face
 * filters, or AI styles (several since 2026-10-15, each with a demo picture).
 * Cut-out + cropped-edge fade are always on (no longer a per-zone choice), so
 * zones saved with them off pick them up too.
 */
function normalizePhotoConfig(p: CtPhotoConfig): CtPhotoConfig {
  const styles = p.styles.filter((id, i, all) => isPhotoStyleRef(id) && all.indexOf(id) === i);
  // Families never mix: any AI style makes it an AI zone (its AI styles only); free or face styles combine within theirs.
  const aiStyle = styles.find(isAiStyleRef);
  const family = aiStyle ? "ai" : styles[0] ? styleFamily(styles[0]) : "free";
  const same = styles.filter((s) => styleFamily(s) === family);
  // Face is a fixed set: every filter, whichever were stored.
  const list: CtPhotoStyleRef[] = aiStyle ? styles.filter(isAiStyleRef) : family === "face" ? CT_FACE_STYLES.map((s) => s.id) : same.length ? same : ["original"];
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
  // Face filters are a "Filter" row of round swatches (default Real face); zones saved with the generic label get it.
  const styleLabel = family === "face" && (!p.styleLabel?.trim() || p.styleLabel === "Choose style") ? "Filter" : p.styleLabel;
  return { ...p, mode, frame, cutout: true, fadeCrop: true, styles: list, styleLabel, defaultStyle: list.includes(p.defaultStyle) ? p.defaultStyle : list[0] };
}

export function defaultProductConfig(): CtProductConfig {
  return {
    main: { enabled: false, label: "Choose color", display: "image", subOptions: [] },
    scene: defaultScene(),
    layouts: {},
    material: defaultMaterialConfig(),
    samples: {},
    mockupEdit: null,
    print: null,
    mockupsByOption: {},
    zoneMockups: [],
  };
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
    else if (v.kind === "text")
      out[key] = { kind: "text", text: typeof v.text === "string" ? v.text.slice(0, 500) : "", ...(typeof v.optionId === "string" ? { optionId: v.optionId } : {}) };
    else if (v.kind === "photo") {
      const t: Partial<CtTransform> = v.transform ?? {};
      const n = (x: unknown, fallback: number) => (typeof x === "number" && Number.isFinite(x) ? x : fallback);
      out[key] = {
        kind: "photo",
        url: stored(v.url),
        sourceUrl: stored(v.sourceUrl),
        ...(typeof v.style === "string" && isPhotoStyleRef(v.style) ? { style: v.style } : {}),
        ...(typeof v.optionId === "string" ? { optionId: v.optionId } : {}),
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
    mockupEdit: normalizeMockupEdit(raw?.mockupEdit),
    print: normalizeProductPrint(raw?.print),
    mockupsByOption: normalizeMockupsByOption(raw?.mockupsByOption),
    zoneMockups: normalizeZoneMockups(raw?.zoneMockups),
  };
}

function normalizeProductPrint(raw: unknown): CtProductPrint | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<CtProductPrint>;
  if (!p.spec) return null;
  return { templateId: typeof p.templateId === "string" ? p.templateId : null, name: typeof p.name === "string" ? p.name : "", kind: isPrintKind(p.kind) ? p.kind : "flat", spec: normalizePrintSpec(p.spec) };
}

function normalizeMockupsByOption(raw: unknown): Record<string, Record<string, CtProductScene>> {
  const out: Record<string, Record<string, CtProductScene>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [layer, byOption] of Object.entries(raw as Record<string, unknown>)) {
    if (!byOption || typeof byOption !== "object") continue;
    const scenes: Record<string, CtProductScene> = {};
    for (const [option, scene] of Object.entries(byOption as Record<string, Partial<CtProductScene>>)) {
      const n = normalizeScene(scene);
      if (n.url) scenes[option] = n;
    }
    if (Object.keys(scenes).length) out[layer] = scenes;
  }
  return out;
}

function normalizeZoneMockups(raw: unknown): CtZoneMockup[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((m) => m as Partial<CtZoneMockup>)
    .filter((m) => typeof m.id === "string" && typeof m.url === "string" && m.url && typeof m.width === "number" && typeof m.height === "number")
    .map((m) => ({
      id: m.id as string,
      name: typeof m.name === "string" ? m.name : "",
      url: m.url as string,
      width: m.width as number,
      height: m.height as number,
      zones: Object.fromEntries(Object.entries(m.zones ?? {}).filter(([, v]) => Boolean(v) && typeof v === "object" && "type" in v)) as Record<string, CtShape>,
      tile: typeof m.tile === "number" && m.tile > 4 ? m.tile : 120,
      shading: typeof m.shading === "number" ? Math.min(1, Math.max(0, m.shading)) : 0.85,
    }));
}

function normalizeMockupEdit(raw: unknown): CtMockupEdit | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Partial<CtMockupEdit>;
  if (typeof m.assetId !== "string" || !m.slide || typeof m.slide !== "object" || !Array.isArray(m.slide.layers)) return null;
  const frames: CtMockupEdit["frames"] = {};
  for (const [id, f] of Object.entries(m.frames ?? {})) if (f && typeof f === "object") frames[id] = { hole: f.hole === true, cord: f.cord ?? "none" };
  return { assetId: m.assetId, slide: m.slide, frames, materialVersion: typeof m.materialVersion === "string" ? m.materialVersion : null };
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

/** A date typed digit by digit, shown as dd/mm/yyyy ("2512" → "25/12"). */
export function formatDateInput(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 8);
  return [d.slice(0, 2), d.slice(2, 4), d.slice(4)].filter(Boolean).join("/");
}

/** A complete, real dd/mm/yyyy date. */
export function isValidDate(text: string): boolean {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim());
  if (!m) return false;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d;
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
// Linked layers (config.image.follows)
// ---------------------------------------------------------------------------

/** The layer a linked layer follows, when it is an image layer of the product (never itself). */
export function linkedLeader(region: CtRegion, regions: CtRegion[]): CtRegion | null {
  const id = region.kind === "image" ? normalizeRegion(region).config.image.follows : undefined;
  if (!id || id === region.id) return null;
  return regions.find((r) => r.id === id && r.kind === "image") ?? null;
}

/** A layer that shows what another layer shows: never offered to the customer. */
export function isLinkedLayer(region: CtRegion, regions: CtRegion[]): boolean {
  return linkedLeader(region, regions) !== null;
}

/**
 * The selection with every linked layer set to the option at its leader's group / option position (a chain is
 * followed; a loop stops). Every renderer resolves this before drawing, so the editor, print file, mockups and
 * storefront always agree.
 */
export function resolveLinked<A extends CtRenderAsset>(regions: CtRegion[], items: CtRegionItem[], assets: A[], selection: CtSelection): CtSelection {
  const linked = regions.filter((r) => isLinkedLayer(r, regions));
  if (!linked.length) return selection;
  const out: CtSelection = { ...selection };
  const done = new Set<string>();
  const resolve = (r: CtRegion, depth: number): void => {
    if (done.has(r.id) || depth > regions.length) return;
    const leader = linkedLeader(r, regions);
    if (!leader) return;
    if (isLinkedLayer(leader, regions)) resolve(leader, depth + 1);
    const lead = out[leader.id];
    const at = locateOption(regionGroups(leader, items, assets), lead?.kind === "image" ? lead.assetId : null);
    const groups = regionGroups(r, items, assets);
    const g = groups[at.group];
    out[r.id] = { kind: "image", assetId: g ? g.options[Math.min(at.option, g.options.length - 1)].id : null };
    done.add(r.id);
  };
  for (const r of linked) resolve(r, 0);
  return out;
}

/**
 * Where a linked layer's options do not mirror its leader's (layer-rules §6, §10): group names, group counts and
 * option counts must match. Empty = in step.
 */
export function linkMismatches<A extends CtRenderAsset>(region: CtRegion, regions: CtRegion[], items: CtRegionItem[], assets: A[]): string[] {
  const leader = linkedLeader(region, regions);
  if (!leader) return [];
  const mine = regionGroups(region, items, assets);
  const theirs = regionGroups(leader, items, assets);
  const out: string[] = [];
  if (mine.length !== theirs.length) out.push(`${mine.length} nhóm, layer gốc có ${theirs.length}`);
  theirs.forEach((g, i) => {
    const m = mine[i];
    if (!m) return;
    if (m.name.trim().toLowerCase() !== g.name.trim().toLowerCase()) out.push(`nhóm ${i + 1}: "${m.name}" ≠ "${g.name}"`);
    if (m.options.length !== g.options.length) out.push(`nhóm "${g.name}": ${m.options.length} lựa chọn, layer gốc có ${g.options.length}`);
  });
  return out;
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
  return resolveLinked(regions, items, assets, sel);
}

export function defaultRegionSelection(region: CtRegion, items: CtRegionItem[], assets: CtRenderAsset[]): CtRegionSelection {
  const r = normalizeRegion(region);
  switch (r.kind) {
    case "text":
      return { kind: "text", text: r.config.text.choices[0] ?? r.config.text.defaultText };
    case "photo":
      return { kind: "photo", url: null, transform: { ...IDENTITY_TRANSFORM }, style: r.config.photo.defaultStyle, sourceUrl: null };
    case "image": {
      if (r.config.image.allowNone && r.config.image.defaultNone) return { kind: "image", assetId: null };
      const groups = regionGroups(r, items, assets);
      const picked = r.config.image.defaultAssetId;
      if (picked && locateOption(groups, picked).group >= 0) return { kind: "image", assetId: picked };
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
    for (const region of regions.filter((r) => r.kind === "image" && !isLinkedLayer(r, regions) && (mainId === null || onVersion(r, mainId)))) {
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
    out.push(...combos.slice(0, room).map((c) => resolveLinked(regions, items, assets, c)));
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
  for (const region of regions.filter((r) => r.kind === "image" && !isLinkedLayer(r, regions) && (mainId === null || onVersion(r, mainId)))) {
    const choices = regionChoices(region, items, assets);
    if (choices.length === 0) continue;
    sel[region.id] = { kind: "image", assetId: pick(choices).asset.id };
  }
  return resolveLinked(regions, items, assets, sel);
}

/** Google Fonts families a set of regions needs. */
export function fontsUsed(regions: CtRegion[]): string[] {
  const fonts = regions
    .filter((r) => r.kind === "text")
    .map(normalizeRegion)
    .flatMap((r) => [r.config.text.fontFamily, ...r.config.options.list.map((o) => o.text?.fontFamily ?? "")]);
  return Array.from(new Set(fonts.filter(Boolean)));
}

/** A zone and every zone under it (its child zones, theirs…) — deleted together. */
export function zoneSubtree(regions: CtRegion[], id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of regions) if (r.config?.parent && out.has(r.config.parent.regionId) && !out.has(r.id)) {
      out.add(r.id);
      grew = true;
    }
  }
  return out;
}
