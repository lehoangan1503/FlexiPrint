/**
 * Clipart library helpers shared by the editor, the library page and the
 * server. Pure — no DOM, no React.
 *
 *   origin      parent_id NULL: an original clipart (role main | sub)
 *   set member  parent_id → origin: another colour / style of the same
 *               silhouette (role variant for elements, main for mains)
 *   rendition   parent_id → any clipart: AI material version (acrylic…)
 */

import type { CtAsset, CtAssetRole, CtCategoryRules, CtClipartCategory, CtRenderAsset } from "../types";

export function defaultCategoryRules(): CtCategoryRules {
  return {
    canvas: { w: 1024, h: 1024 },
    fill: 0.85,
    anchor: "center",
    background: "cutout",
    lockSilhouette: true,
    variantAxes: [],
    stylePackId: null,
  };
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function normalizeCategoryRules(raw: Partial<CtCategoryRules> | null | undefined): CtCategoryRules {
  const base = defaultCategoryRules();
  const r = raw ?? {};
  return {
    canvas: { w: Math.round(num(r.canvas?.w, base.canvas.w, 64, 4096)), h: Math.round(num(r.canvas?.h, base.canvas.h, 64, 4096)) },
    fill: num(r.fill, base.fill, 0.1, 1),
    anchor: r.anchor === "bottom" ? "bottom" : "center",
    background: r.background === "transparent" || r.background === "none" ? r.background : "cutout",
    lockSilhouette: typeof r.lockSilhouette === "boolean" ? r.lockSilhouette : base.lockSilhouette,
    variantAxes: Array.isArray(r.variantAxes) ? r.variantAxes.filter((a): a is string => typeof a === "string" && a.trim() !== "").map((a) => a.trim()) : [],
    stylePackId: typeof r.stylePackId === "string" && r.stylePackId ? r.stylePackId : null,
  };
}

/** Role an ORIGIN of the category gets. */
export function originRole(category: Pick<CtClipartCategory, "usage"> | null): CtAssetRole {
  return category?.usage === "main" ? "main" : "sub";
}

/** Role a SET MEMBER of `parent` gets (element → variant, main → main). */
export function memberRole(parent: Pick<CtAsset, "role">): CtAssetRole | null {
  if (parent.role === "sub") return "variant";
  if (parent.role === "main") return "main";
  return null;
}

export function isLibraryAsset(a: Pick<CtAsset, "product_id">): boolean {
  return a.product_id === null;
}

/** Library origins (no parent) among `assets`. */
export function libraryOrigins<A extends CtAsset>(assets: A[]): A[] {
  return assets.filter((a) => a.parent_id === null && (a.role === "main" || a.role === "sub"));
}

/** Set members of an origin, in display order (renditions excluded). */
export function setMembers<A extends CtRenderAsset>(assets: A[], originId: string): A[] {
  return assets
    .filter((a) => a.parent_id === originId && a.role !== "rendition")
    .sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at));
}

/** Newest rendition of a clipart, if any. */
export function renditionOf<A extends CtRenderAsset>(assets: A[], assetId: string): A | null {
  const list = assets.filter((a) => a.role === "rendition" && a.parent_id === assetId);
  return list.sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
}

/** Categories as an indented, depth-first list (for selects and the tree). */
export function flattenCategories(list: CtClipartCategory[]): Array<{ category: CtClipartCategory; depth: number }> {
  const byParent = new Map<string | null, CtClipartCategory[]>();
  const ids = new Set(list.map((c) => c.id));
  for (const c of list) {
    const key = c.parent_id && ids.has(c.parent_id) ? c.parent_id : null;
    byParent.set(key, [...(byParent.get(key) ?? []), c]);
  }
  const out: Array<{ category: CtClipartCategory; depth: number }> = [];
  const walk = (parent: string | null, depth: number) => {
    const kids = (byParent.get(parent) ?? []).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
    for (const c of kids) {
      out.push({ category: c, depth });
      if (depth < 8) walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}
