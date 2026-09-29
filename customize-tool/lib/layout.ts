/**
 * Per-main-version layouts (CtProductConfig.layouts). A main version can carry
 * its own zone positions / shapes, hide zones, and move the objects inside
 * them — "1 person / 2 people / 3 people" are main versions, each arranging
 * the photo zones its own way; a car whose helmet sits elsewhere reshapes the
 * photo frame. Anything not overridden inherits the base layout.
 *
 * Pure — the compositor, the storefront form and the editor all resolve
 * through here, so every surface agrees on what a version shows.
 */

import type { CtMainLayout, CtRegion, CtRegionItem, CtRegionOverride, CtTransform } from "../types";

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
      const shape = layout.regions[r.id]?.shape;
      return shape ? { ...r, shape } : r;
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

/** What a selection of main `mainId` renders / offers: overrides applied, hidden zones dropped. */
export function resolveLayout(
  regions: CtRegion[],
  items: CtRegionItem[],
  layouts: Record<string, CtMainLayout> | undefined,
  mainId: string | null | undefined,
): { regions: CtRegion[]; items: CtRegionItem[] } {
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
    if (o.hidden) clean.hidden = true;
    if (clean.shape || clean.hidden) regions[id] = clean;
  }
  const items: Record<string, CtTransform> = {};
  for (const [id, t] of Object.entries(layout.items)) if (itemIds.has(id)) items[id] = t;
  return { regions, items };
}

/** Parse whatever is stored under config.layouts (older rows: nothing). */
export function normalizeLayouts(raw: unknown): Record<string, CtMainLayout> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, CtMainLayout> = {};
  for (const [mainId, value] of Object.entries(raw as Record<string, Partial<CtMainLayout> | null>)) {
    if (!value || typeof value !== "object") continue;
    out[mainId] = {
      regions: value.regions && typeof value.regions === "object" ? value.regions : {},
      items: value.items && typeof value.items === "object" ? value.items : {},
    };
  }
  return out;
}
