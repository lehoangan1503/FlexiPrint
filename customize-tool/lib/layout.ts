/**
 * Layers per main version. Every version has its OWN set of layers
 * (CtRegionConfig.mainId): a new version starts empty, and its layers can be
 * copied from another version in one go (copyVersionLayers). A layer without
 * an owner — made before versions had their own — shows on every version.
 *
 * LEGACY per-main-version layouts (CtProductConfig.layouts). A main version can carry
 * its own zone positions / shapes, hide zones, and move the objects inside
 * them — "1 person / 2 people / 3 people" are main versions, each arranging
 * the photo zones its own way; a car whose helmet sits elsewhere reshapes the
 * photo zone and keeps its own child frame (position, size, tilt). Anything
 * not overridden inherits the base layout — and the editor pins a version's
 * inherited value before the base changes (components/editor/use-design.ts),
 * so a version with its own layout is never moved by another version's edit.
 *
 * Pure — the compositor, the storefront form and the editor all resolve
 * through here, so every surface agrees on what a version shows.
 */

import type { CtMainFrame, CtMainLayout, CtRegion, CtRegionItem, CtRegionOverride, CtTransform } from "../types";
import { newId } from "./geometry";

/** Does main version `mainId` show this layer? (No owner = every version.) */
export function onVersion(region: CtRegion, mainId: string | null | undefined): boolean {
  const owner = region.config?.mainId;
  return !owner || owner === mainId;
}

/** The layers of one main version, and their items. */
export function versionLayers(regions: CtRegion[], items: CtRegionItem[], mainId: string | null | undefined): { regions: CtRegion[]; items: CtRegionItem[] } {
  const own = regions.filter((r) => onVersion(r, mainId));
  const ids = new Set(own.map((r) => r.id));
  return { regions: own, items: items.filter((i) => ids.has(i.region_id)) };
}

/**
 * Copies of `regions` (+ their items) owned by `toMainId`, with fresh ids.
 * `idMap` maps every old region id to its copy (to carry preview choices over).
 * Links between the copied layers (a back half's `follows`, a child zone's
 * `parent`) point at the copies; a link to a layer not copied is dropped.
 */
export function cloneLayers(
  regions: CtRegion[],
  items: CtRegionItem[],
  toMainId: string,
): { regions: CtRegion[]; items: CtRegionItem[]; idMap: Map<string, string> } {
  const idMap = new Map<string, string>();
  const out: CtRegion[] = [];
  const outItems: CtRegionItem[] = [];
  for (const r of regions) idMap.set(r.id, newId());
  for (const r of regions) {
    const id = idMap.get(r.id) ?? newId();
    const itemIds = new Map<string, string>();
    for (const i of items.filter((x) => x.region_id === r.id)) {
      const iid = newId();
      itemIds.set(i.id, iid);
      outItems.push({ ...i, id: iid, region_id: id });
    }
    // Group names are keyed by item id.
    const names = r.config?.image?.groupNames ?? {};
    const groupNames: Record<string, string> = {};
    for (const [from, to] of itemIds) if (names[from]) groupNames[to] = names[from];
    const image = { ...r.config.image, groupNames };
    delete image.follows;
    const follows = r.config.image?.follows ? idMap.get(r.config.image.follows) : undefined;
    if (follows) image.follows = follows;
    const config = { ...r.config, mainId: toMainId, image };
    delete config.parent;
    const parentId = r.config.parent ? idMap.get(r.config.parent.regionId) : undefined;
    if (parentId && r.config.parent) config.parent = { regionId: parentId, optionId: r.config.parent.optionId };
    out.push({ ...r, id, config });
  }
  return { regions: out, items: outItems, idMap };
}

/**
 * Older designs: layers shared by every version. They were drawn on the
 * default main, so they become ITS layers; every other version starts empty
 * (copy layers over from the editor's "Sao chép layer" list). Null = nothing
 * to move.
 */
export function claimSharedLayers(regions: CtRegion[], defaultMainId: string): CtRegion[] | null {
  if (!regions.some((r) => !r.config?.mainId)) return null;
  return regions.map((r) => (r.config?.mainId ? r : { ...r, config: { ...r.config, mainId: defaultMainId } }));
}

export function emptyLayout(): CtMainLayout {
  return { regions: {}, items: {} };
}

export function layoutFor(layouts: Record<string, CtMainLayout> | undefined, mainId: string | null | undefined): CtMainLayout | undefined {
  return mainId ? layouts?.[mainId] : undefined;
}

/** Zones and items with the version's overrides applied. Hidden zones are KEPT (the editor still shows them). */
export function applyLayout(regions: CtRegion[], items: CtRegionItem[], layout: CtMainLayout | undefined): { regions: CtRegion[]; items: CtRegionItem[] } {
  if (!layout) return { regions, items };
  return {
    regions: regions.map((r) => {
      const o = layout.regions[r.id];
      if (!o?.shape && !o?.frame) return r;
      const out = o.shape ? { ...r, shape: o.shape } : { ...r };
      if (o.frame) out.config = { ...r.config, photo: { ...r.config?.photo, frame: o.frame } };
      return out;
    }),
    items: items.map((i) => {
      const t = layout.items[i.id];
      return t ? { ...i, transform: t } : i;
    }),
  };
}

export function isHidden(layout: CtMainLayout | undefined, regionId: string): boolean {
  return layout?.regions[regionId]?.hidden === true;
}

/** What a selection of main `mainId` renders / offers: its own layers, overrides applied, hidden zones dropped. */
export function resolveLayout(
  regions: CtRegion[],
  items: CtRegionItem[],
  layouts: Record<string, CtMainLayout> | undefined,
  mainId: string | null | undefined,
): { regions: CtRegion[]; items: CtRegionItem[] } {
  ({ regions, items } = versionLayers(regions, items, mainId));
  const layout = layoutFor(layouts, mainId);
  if (!layout) return { regions, items };
  const applied = applyLayout(regions, items, layout);
  const shown = applied.regions.filter((r) => !isHidden(layout, r.id));
  const ids = new Set(shown.map((r) => r.id));
  return { regions: shown, items: applied.items.filter((i) => ids.has(i.region_id)) };
}

/** Drop overrides pointing at zones / items that no longer exist, and empty entries. */
export function pruneLayout(layout: CtMainLayout, regionIds: Set<string>, itemIds: Set<string>): CtMainLayout {
  const regions: Record<string, CtRegionOverride> = {};
  for (const [id, o] of Object.entries(layout.regions)) {
    if (!regionIds.has(id)) continue;
    const clean: CtRegionOverride = {};
    if (o.shape) clean.shape = o.shape;
    if (o.frame) clean.frame = o.frame;
    if (o.hidden) clean.hidden = true;
    if (clean.shape || clean.frame || clean.hidden) regions[id] = clean;
  }
  const items: Record<string, CtTransform> = {};
  for (const [id, t] of Object.entries(layout.items)) if (itemIds.has(id)) items[id] = t;
  return { regions, items, ...(layout.frame ? { frame: layout.frame } : {}) };
}

/** Where main version `mainId`'s picture sits on the artboard (w × h): its own frame, else the whole artboard. */
export function mainFrameFor(layouts: Record<string, CtMainLayout> | undefined, mainId: string | null | undefined, w: number, h: number): CtMainFrame {
  return layoutFor(layouts, mainId)?.frame ?? { x: 0, y: 0, w, h, rotation: 0 };
}

/** A picture of iw × ih contain-fitted, centred, into the artboard (w × h). */
export function fitMainFrame(iw: number, ih: number, w: number, h: number): CtMainFrame {
  const s = iw > 0 && ih > 0 ? Math.min(w / iw, h / ih) : 1;
  const fw = iw * s;
  const fh = ih * s;
  return { x: (w - fw) / 2, y: (h - fh) / 2, w: fw, h: fh, rotation: 0 };
}

function frameOf(raw: unknown): CtMainFrame | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const f = raw as Partial<CtMainFrame>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const [x, y, w, h] = [n(f.x), n(f.y), n(f.w), n(f.h)];
  if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) return undefined;
  return { x, y, w, h, rotation: n(f.rotation) ?? 0 };
}

/** Parse whatever is stored under config.layouts (older rows: nothing). */
export function normalizeLayouts(raw: unknown): Record<string, CtMainLayout> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, CtMainLayout> = {};
  for (const [mainId, value] of Object.entries(raw as Record<string, Partial<CtMainLayout> | null>)) {
    if (!value || typeof value !== "object") continue;
    const frame = frameOf(value.frame);
    out[mainId] = {
      regions: value.regions && typeof value.regions === "object" ? value.regions : {},
      items: value.items && typeof value.items === "object" ? value.items : {},
      ...(frame ? { frame } : {}),
    };
  }
  return out;
}
