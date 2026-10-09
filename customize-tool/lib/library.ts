/**
 * Clipart library helpers shared by the editor, the library page and the
 * server. Pure — no DOM, no React.
 *
 * Every library picture is a clipart; what it is comes from where it hangs:
 *
 *   gốc        parent_id NULL: an original clipart (role main | sub — the old
 *              category usage, no longer shown anywhere)
 *   đa sắc     another colour / style of a clipart: parent → its gốc (role
 *              variant | main), or parent → a vật liệu version (role rendition
 *              with meta.variant: the đa sắc of that material version)
 *   vật liệu   the AI material version of a clipart (role rendition, no
 *              meta.variant): acrylic, glitter…
 *
 * A product uses whichever picture was dragged in, as it is: on the Version
 * column it is a version (role main), on the canvas a layer clipart (role sub)
 * — asVersion / asLayerClipart give the role the product reads it with.
 */

import type { CtAsset, CtAssetRole, CtCategoryBody, CtCategoryRules, CtClipartCategory, CtMaterialDisplay, CtRenderAsset } from "../types";
import { normalizeMaterialSpecs } from "./materials";

export function defaultCategoryRules(): CtCategoryRules {
  return {
    canvas: { w: 1024, h: 1024 },
    fill: 0.85,
    anchor: "center",
    background: "auto",
    lockSilhouette: true,
    shape: "alpha",
    stylePackId: null,
    materialIds: [],
    refs: [],
    details: [],
    productRefs: [],
    detailsNote: "",
    productId: null,
  };
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Rules saved before materialIds: one default material. */
type LegacyRules = Partial<CtCategoryRules> & { materialId?: unknown };

function idList(v: unknown): string[] {
  return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x !== ""))].slice(0, 8) : [];
}

/** Reference photo urls (uploaded through presets/refs). */
export function refList(v: unknown, max = 6): string[] {
  return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && /^https?:\/\//.test(x)))].slice(0, max) : [];
}

export function normalizeCategoryRules(raw: LegacyRules | null | undefined): CtCategoryRules {
  const base = defaultCategoryRules();
  const r = raw ?? {};
  return {
    canvas: { w: Math.round(num(r.canvas?.w, base.canvas.w, 64, 4096)), h: Math.round(num(r.canvas?.h, base.canvas.h, 64, 4096)) },
    fill: num(r.fill, base.fill, 0.1, 1),
    anchor: r.anchor === "bottom" ? "bottom" : "center",
    // The background rule left the dialog: every category keeps the model's transparency, else cuts out.
    background: "auto",
    lockSilhouette: typeof r.lockSilhouette === "boolean" ? r.lockSilhouette : base.lockSilhouette,
    shape: r.shape === "frame" ? "frame" : "alpha",
    stylePackId: typeof r.stylePackId === "string" && r.stylePackId ? r.stylePackId : null,
    materialIds: Array.isArray(r.materialIds) ? idList(r.materialIds) : idList([r.materialId]),
    refs: refList(r.refs),
    details: normalizeMaterialSpecs(r.details),
    productRefs: refList(r.productRefs),
    detailsNote: typeof r.detailsNote === "string" ? r.detailsNote.trim().slice(0, 4000) : "",
    productId: typeof r.productId === "string" && r.productId ? r.productId : null,
  };
}

/** A category body with only the name changed (everything else as it is, or the defaults for a new one). */
export function categoryBody(name: string, c: CtClipartCategory | null): CtCategoryBody {
  return {
    name: name.trim(),
    parent_id: c?.parent_id ?? null,
    usage: c?.usage ?? "element",
    mode: c?.mode ?? "origin_set",
    spec: c?.spec ?? "",
    rules: c?.rules ?? defaultCategoryRules(),
    sort_order: c?.sort_order ?? 0,
  };
}

/** A finished design saved from a product (meta.artwork) — the category's Artwork tab, not its Clipart tab. */
export function isArtworkClipart(a: Pick<CtAsset, "meta">): boolean {
  return Boolean(a.meta?.artwork);
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

/**
 * A main clipart used as an element — an option of a custom layer, not a
 * version of the product: it reads as a sub (the product's version list and
 * the storefront's "choose version" skip it).
 */
export function mainAsElement(a: CtAsset): CtAsset {
  return a.role === "main" ? { ...a, role: "sub", parent_id: null } : a;
}

/** A material version (vật liệu) — the AI version of a clipart, or a đa sắc made from one. */
export function isMaterialClipart(a: Pick<CtAsset, "role">): boolean {
  return a.role === "rendition";
}

/** A đa sắc: another colour / style of a gốc, or of a vật liệu version. */
export function isMulticolorClipart(a: Pick<CtAsset, "role" | "parent_id" | "meta">): boolean {
  if (a.parent_id === null) return false;
  return a.role === "rendition" ? Boolean(a.meta?.variant) : true;
}

export interface CtClipartBadges {
  origin: boolean;
  multicolor: boolean;
  material: boolean;
}

export function clipartBadges(a: Pick<CtAsset, "role" | "parent_id" | "meta">): CtClipartBadges {
  return { origin: a.parent_id === null, multicolor: isMulticolorClipart(a), material: isMaterialClipart(a) };
}

/** A clipart dragged onto the Version column: a version of the product, as it is. */
export function asVersion<A extends CtAsset>(a: A): A {
  return a.role === "main" && a.parent_id === null ? a : { ...a, role: "main", parent_id: null };
}

/** A clipart dragged onto the canvas: a layer's clipart (an option group's head), as it is. */
export function asLayerClipart<A extends CtAsset>(a: A): A {
  return a.role === "sub" && a.parent_id === null ? a : { ...a, role: "sub", parent_id: null };
}

/** A clipart added under a version with "Thêm option": a sub-option of it. */
export function asMainOption<A extends CtAsset>(a: A, mainId: string): A {
  return { ...a, role: "variant", parent_id: mainId };
}

/**
 * Everything hanging off a library gốc in `list` (đa sắc, vật liệu, đa sắc of vật liệu, vật liệu of đa sắc),
 * the gốc first.
 */
export function clipartFamily<A extends CtAsset>(list: A[], origin: A): A[] {
  const kids = list.filter((a) => a.parent_id === origin.id);
  const ids = new Set(kids.map((a) => a.id));
  return [origin, ...kids, ...list.filter((a) => a.parent_id !== null && ids.has(a.parent_id))];
}

export function isLibraryAsset(a: Pick<CtAsset, "product_id">): boolean {
  return a.product_id === null;
}

/** Library origins (no parent) among `assets`. */
export function libraryOrigins<A extends CtAsset>(assets: A[]): A[] {
  return assets.filter((a) => a.parent_id === null && (a.role === "main" || a.role === "sub"));
}

/** Đa sắc of a clipart, in display order: set members of a gốc, or the đa sắc of a vật liệu version. */
export function setMembers<A extends CtRenderAsset>(assets: A[], originId: string): A[] {
  return assets
    .filter((a) => a.parent_id === originId && (a.role !== "rendition" || Boolean(a.meta?.variant)))
    .sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at));
}

/**
 * Newest rendition of a clipart, if any — of material version `version` ("có dây") when it has one, else its
 * base version ("" = the base).
 */
export function renditionOf<A extends CtRenderAsset>(assets: A[], assetId: string, version = ""): A | null {
  // One made theo khuôn (cut to this product's khuôn vật liệu — a product's assets only carry its own) wins.
  const all = renditionsOf(assets, assetId);
  const list = [...all.filter((a) => a.meta?.frame), ...all.filter((a) => !a.meta?.frame)];
  const of = (v: string) => list.find((a) => (a.meta?.materialVersion ?? "") === v);
  return (version ? of(version) : undefined) ?? of("") ?? list[0] ?? null;
}

/** The material versions the renditions of `assets` offer besides the base one ("có dây"…). */
export function materialVersions(assets: CtRenderAsset[]): string[] {
  const names = assets.filter((a) => a.role === "rendition" && a.meta?.materialVersion).map((a) => a.meta.materialVersion as string);
  return [...new Set(names)];
}

/**
 * Every material version of a clipart, newest first — one per material when its category has several. The đa sắc
 * of a material version (rendition children with meta.variant) are not material versions of it.
 */
export function renditionsOf<A extends CtRenderAsset>(assets: A[], assetId: string): A[] {
  return assets
    .filter((a) => a.role === "rendition" && a.parent_id === assetId && !a.meta?.variant)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/**
 * The storefront look (material display "rendition"): every clipart that has
 * a rendition is drawn with the rendition's image, keeping the clipart's own
 * id and size so zones, transforms and selections are untouched — except the
 * ones in `flatIds` (material switched off for this product).
 */
export function withRenditions<A extends CtRenderAsset>(assets: A[], flatIds: readonly string[] = [], version = ""): A[] {
  const flat = new Set(flatIds);
  return assets
    .filter((a) => a.role !== "rendition")
    .map((a) => {
      const r = flat.has(a.id) ? null : renditionOf(assets, a.id, version);
      if (!r) return a;
      // A rendition on a larger canvas (plate / cord around the art) brings its padding: drawn around the clipart's box.
      const meta = { ...a.meta };
      delete meta.pad;
      if (r.meta?.pad) meta.pad = r.meta.pad;
      // Made theo khuôn: drawn over the khuôn's box, not the clipart's frame.
      delete meta.frame;
      if (r.meta?.frame) meta.frame = r.meta.frame;
      return { ...a, url: r.url, meta };
    });
}

/**
 * The cliparts a product is drawn with — storefront, cart preview AND print
 * file alike, so what gets printed is exactly what the customer saw.
 */
export function displayAssets<A extends CtRenderAsset>(assets: A[], display: CtMaterialDisplay, flatIds: readonly string[] = [], version = ""): A[] {
  return display === "rendition" ? withRenditions(assets, flatIds, version) : assets.filter((a) => a.role !== "rendition");
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
