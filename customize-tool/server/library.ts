/**
 * The global clipart library (migration 006): categories, library cliparts,
 * material presets (read-only: they name vật liệu versions), main versions a product picks from the library, and the
 * shared "which assets does this product render" loader.
 *
 * Rules (RLS enforces the same; the checks here only produce readable errors):
 * every signed-in user reads everything and adds their own; the owner or an
 * admin edits / deletes. A library clipart that a product still uses cannot
 * be deleted — the product would lose an option silently.
 */

import { NextResponse } from "next/server";
import { CT_CONFIG, CT_TABLES } from "../config";
import type {
  CtAsset,
  CtAssetMeta,
  CtAssetRole,
  CtAssetSource,
  CtCategoryBody,
  CtCategoryHistoryEntry,
  CtClipartCategory,
  CtClipartUsage,
  CtMainLayout,
  CtPreset,
  CtPresetKind,
  CtProduct,
  CtRegion,
  CtRegionItem,
  CtUpdateClipartBody,
} from "../types";
import { asLayerClipart, asMainOption, asVersion, memberRole, normalizeCategoryRules, originRole } from "../lib/library";
import { normalizeSubOptions } from "../lib/design";
import { isAdmin } from "./ai-styles";
import { readImageInfo } from "./image-size";
import { r2PublicUrl } from "./r2";
import { ctLibraryPath, ctRemove, ctUpload } from "./storage";
import { ctServiceClient, type CtServiceClient, type CtSession, type CtSupabase } from "./supabase";

type Db = CtSupabase | CtServiceClient;

const PRESET_KINDS: CtPresetKind[] = ["style_pack", "material", "scene"];
const SOURCES: CtAssetSource[] = ["upload", "ai", "stock"];

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

function missingMigration(message: string): string {
  return /ct_clipart_categories|ct_presets|ct_product_mains|category_id/.test(message) && /does not exist|schema cache|Could not find/i.test(message)
    ? `Thiếu migration: chạy supabase/migrations/006_clipart_library.sql (${message})`
    : message;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

type CategoryRow = Omit<CtClipartCategory, "count" | "can_edit">;

export function cleanCategory(body: CtCategoryBody): CtCategoryBody | string {
  const name = (body.name ?? "").trim();
  if (!name || name.length > 120) return "Tên danh mục 1–120 ký tự";
  return {
    name,
    parent_id: body.parent_id || null,
    usage: body.usage === "main" ? "main" : "element",
    mode: body.mode === "variant_set" ? "variant_set" : "origin_set",
    spec: (body.spec ?? "").trim(),
    rules: normalizeCategoryRules(body.rules),
    ...(typeof body.sort_order === "number" ? { sort_order: body.sort_order } : {}),
  };
}

export async function listCategories(s: CtSession): Promise<NextResponse> {
  const { data, error } = await s.supabase
    .from(CT_TABLES.categories)
    .select("*")
    .order("sort_order")
    .order("name")
    .returns<CategoryRow[]>();
  if (error) return jsonError(missingMigration(error.message), 500);
  const { data: origins } = await s.supabase
    .from(CT_TABLES.assets)
    .select("category_id")
    .is("product_id", null)
    .is("parent_id", null)
    .returns<Array<{ category_id: string | null }>>();
  const counts = new Map<string, number>();
  for (const o of origins ?? []) {
    const key = o.category_id ?? "none";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const admin = await isAdmin(s);
  const categories: CtClipartCategory[] = (data ?? []).map((c) => ({
    ...c,
    rules: normalizeCategoryRules(c.rules),
    count: counts.get(c.id) ?? 0,
    can_edit: admin || c.user_id === s.user.id,
  }));
  return NextResponse.json({ categories, uncategorized: counts.get("none") ?? 0, admin });
}

export async function createCategory(s: CtSession, body: CtCategoryBody): Promise<NextResponse> {
  const clean = cleanCategory(body);
  if (typeof clean === "string") return jsonError(clean, 400);
  const { data, error } = await s.supabase
    .from(CT_TABLES.categories)
    .insert({ ...clean, user_id: s.user.id })
    .select("*")
    .single<CategoryRow>();
  if (error) return jsonError(missingMigration(error.message), 500);
  const category: CtClipartCategory = { ...data, rules: normalizeCategoryRules(data.rules), count: 0, can_edit: true };
  await recordCategorySave(s, category);
  return NextResponse.json({ category }, { status: 201 });
}

export async function updateCategory(s: CtSession, id: string, body: CtCategoryBody): Promise<NextResponse> {
  const clean = cleanCategory(body);
  if (typeof clean === "string") return jsonError(clean, 400);
  if (clean.parent_id === id) return jsonError("Danh mục không thể là cha của chính nó", 400);
  const { data, error } = await s.supabase.from(CT_TABLES.categories).update(clean).eq("id", id).select("*").maybeSingle<CategoryRow>();
  if (error) return jsonError(missingMigration(error.message), 500);
  if (!data) return jsonError("Không có quyền sửa danh mục này", 403);
  const category: CtClipartCategory = { ...data, rules: normalizeCategoryRules(data.rules), can_edit: true };
  await recordCategorySave(s, category);
  return NextResponse.json({ category });
}

// ---------------------------------------------------------------------------
// Category history (migration 010): every save (earlier rows also hold AI revisions)
// ---------------------------------------------------------------------------

type CategoryHistoryInsert = Omit<CtCategoryHistoryEntry, "id" | "user_id" | "created_at">;

/** One history row. Never fails the caller: without migration 010 the history just isn't kept. */
async function recordCategoryHistory(s: CtSession, row: CategoryHistoryInsert): Promise<CtCategoryHistoryEntry | null> {
  const { data, error } = await s.supabase
    .from(CT_TABLES.categoryHistory)
    .insert({ ...row, user_id: s.user.id })
    .select("*")
    .single<CtCategoryHistoryEntry>();
  if (error) {
    console.warn("[ct] category history:", error.message);
    return null;
  }
  return data;
}

async function recordCategorySave(s: CtSession, c: CtClipartCategory): Promise<void> {
  await recordCategoryHistory(s, {
    category_id: c.id,
    event: "save",
    note: "",
    ref_urls: [],
    image_urls: [],
    input: {},
    result: { name: c.name, spec: c.spec, rules: c.rules },
    model: "",
  });
}

export async function deleteCategory(s: CtSession, id: string): Promise<NextResponse> {
  const [{ count: cliparts }, { count: children }] = await Promise.all([
    s.supabase.from(CT_TABLES.assets).select("id", { count: "exact", head: true }).eq("category_id", id),
    s.supabase.from(CT_TABLES.categories).select("id", { count: "exact", head: true }).eq("parent_id", id),
  ]);
  if (cliparts) return jsonError(`Danh mục còn ${cliparts} clipart — chuyển hoặc xoá chúng trước`, 409);
  if (children) return jsonError(`Danh mục còn ${children} danh mục con`, 409);
  const { error, count } = await s.supabase.from(CT_TABLES.categories).delete({ count: "exact" }).eq("id", id);
  if (error) return jsonError(error.message, 500);
  if (!count) return jsonError("Không có quyền xoá danh mục này", 403);
  return new NextResponse(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// Cliparts
// ---------------------------------------------------------------------------

/** Children (set members + renditions) and their renditions, two levels deep. */
async function descendants(db: Db, ids: string[]): Promise<CtAsset[]> {
  if (!ids.length) return [];
  const { data: kids } = await db.from(CT_TABLES.assets).select("*").in("parent_id", ids).returns<CtAsset[]>();
  const level1 = kids ?? [];
  if (!level1.length) return [];
  const { data: grand } = await db
    .from(CT_TABLES.assets)
    .select("*")
    .in("parent_id", level1.map((a) => a.id))
    .returns<CtAsset[]>();
  return [...level1, ...(grand ?? [])];
}

/** GET library/cliparts?category=<id|none>&q= → origins + everything hanging off them. */
export async function listCliparts(s: CtSession, category: string | null, q: string): Promise<NextResponse> {
  let query = s.supabase.from(CT_TABLES.assets).select("*").is("product_id", null).is("parent_id", null);
  if (category === "none") query = query.is("category_id", null);
  else if (category) query = query.eq("category_id", category);
  if (q) {
    const safe = q.replace(/[%,()]/g, " ").trim();
    if (safe) query = query.or(`name.ilike.%${safe}%,spec.ilike.%${safe}%,tags.cs.{${safe.toLowerCase()}}`);
  }
  const { data, error } = await query.order("sort_order").order("created_at").limit(400).returns<CtAsset[]>();
  if (error) return jsonError(missingMigration(error.message), 500);
  const origins = data ?? [];
  const kids = await descendants(s.supabase, origins.map((a) => a.id));
  return NextResponse.json({ cliparts: [...origins, ...kids] });
}

export interface InsertClipartArgs {
  categoryId: string | null;
  parentId: string | null;
  /** "rendition" for an AI material version; otherwise derived from the category / parent. */
  rendition: boolean;
  name: string;
  spec: string;
  tags: string[];
  source: CtAssetSource;
  meta: CtAssetMeta;
  generationId: string | null;
  data: Buffer;
}

async function libraryRow(db: Db, id: string): Promise<CtAsset | null> {
  const { data } = await db.from(CT_TABLES.assets).select("*").eq("id", id).maybeSingle<CtAsset>();
  return data && data.product_id === null ? data : null;
}

/**
 * What a picture made from vật liệu version `src` takes over from it: the material it was rendered with (so a
 * fixed gốc renders it again the same way), its material version, and its canvas padding when the size is the same.
 */
function materialMeta(src: CtAsset, width: number, height: number): CtAssetMeta {
  const m = src.meta ?? {};
  return {
    ...(m.material ? { material: m.material } : {}),
    ...(m.materialVersion ? { materialVersion: m.materialVersion } : {}),
    ...(m.pad && src.width === width && src.height === height ? { pad: m.pad } : {}),
    // Made theo khuôn: still that product's, cut to its khuôn (same size = same cut).
    ...(m.frame && src.width === width && src.height === height ? { frame: m.frame } : {}),
  };
}

/**
 * Store one library clipart. The role follows the structure: an origin gets
 * the category's usage (main / sub), a set member its parent's member role,
 * a rendition "rendition" — so does a đa sắc of a rendition, and an edit of
 * one (meta.derivedFrom = a rendition).
 */
export async function insertClipart(db: Db, userId: string, a: InsertClipartArgs): Promise<CtAsset> {
  const info = readImageInfo(a.data);
  if (!info) throw new Error("File không phải ảnh PNG/JPEG/WebP hợp lệ");

  let role: CtAssetRole;
  let categoryId = a.categoryId;
  let meta = a.meta;
  let parent = a.parentId ? await libraryRow(db, a.parentId) : null;
  if (a.parentId && !parent) throw new Error("Clipart cha không nằm trong thư viện");
  // An edit / recolour of a vật liệu version (or of its đa sắc) stays one: saved next to the one it fixes, same
  // material. Not when the upload named a vật liệu parent itself.
  const derived = !a.rendition && typeof a.meta?.derivedFrom === "string" ? await libraryRow(db, a.meta.derivedFrom) : null;
  const fromMaterial = derived !== null && derived.role === "rendition" && derived.parent_id !== null && parent?.role !== "rendition";
  if (fromMaterial && derived?.parent_id) {
    parent = await libraryRow(db, derived.parent_id);
    if (!parent) throw new Error("Clipart cha không nằm trong thư viện");
    meta = { ...materialMeta(derived, info.width, info.height), ...(derived.meta?.variant ? { variant: derived.meta.variant } : {}), ...a.meta };
  }
  if (parent) {
    const member = memberRole(parent);
    if (a.rendition || fromMaterial) role = "rendition";
    else if (parent.role === "rendition") {
      // Đa sắc of a vật liệu version: a colour / style of that material picture — a material version itself.
      role = "rendition";
      meta = { ...materialMeta(parent, info.width, info.height), ...meta };
    } else if (member && parent.parent_id === null) role = member;
    else throw new Error("Chỉ clipart gốc hoặc bản vật liệu mới có đa sắc");
    categoryId = parent.category_id;
  } else {
    if (a.rendition) throw new Error("Rendition cần clipart gốc (parent_id)");
    const { data: cat } = categoryId
      ? await db.from(CT_TABLES.categories).select("usage").eq("id", categoryId).maybeSingle<Pick<CtClipartCategory, "usage">>()
      : { data: null };
    if (categoryId && !cat) throw new Error("Danh mục không tồn tại");
    role = originRole(cat);
  }

  const path = ctLibraryPath(userId, categoryId, role, info.mime);
  const url = await ctUpload(path, a.data, info.mime);
  let countQuery = db.from(CT_TABLES.assets).select("id", { count: "exact", head: true }).is("product_id", null);
  countQuery = parent ? countQuery.eq("parent_id", parent.id) : categoryId ? countQuery.eq("category_id", categoryId).is("parent_id", null) : countQuery.is("category_id", null).is("parent_id", null);
  const { count } = await countQuery;

  const { data, error } = await db
    .from(CT_TABLES.assets)
    .insert({
      user_id: userId,
      product_id: null,
      category_id: categoryId,
      role,
      parent_id: parent?.id ?? null,
      generation_id: a.generationId,
      name: a.name,
      spec: a.spec,
      tags: a.tags,
      source: a.source,
      url,
      storage_path: path,
      width: info.width,
      height: info.height,
      mime: info.mime,
      meta,
      sort_order: count ?? 0,
    })
    .select("*")
    .single<CtAsset>();
  if (error) {
    await ctRemove([path]);
    throw new Error(missingMigration(error.message));
  }
  return data;
}

function parseJson<T>(raw: FormDataEntryValue | null, fallback: T): T | null {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** POST library/cliparts — multipart: file, category_id?, parent_id?, rendition=1?, name?, spec?, tags (JSON), source?, meta (JSON) */
export async function uploadClipart(s: CtSession, form: FormData): Promise<NextResponse> {
  const file = form.get("file");
  if (!(file instanceof Blob)) return jsonError("Thiếu file", 400);
  if (file.size > CT_CONFIG.maxUploadBytes) return jsonError("File quá lớn", 413);
  const tags = parseJson<string[]>(form.get("tags"), []);
  const meta = parseJson<CtAssetMeta>(form.get("meta"), {});
  if (!tags || !meta) return jsonError("tags / meta không phải JSON", 400);
  const source = String(form.get("source") ?? "upload") as CtAssetSource;
  try {
    const clipart = await insertClipart(s.supabase, s.user.id, {
      categoryId: (form.get("category_id") as string | null) || null,
      parentId: (form.get("parent_id") as string | null) || null,
      rendition: form.get("rendition") === "1",
      name: String(form.get("name") ?? (file instanceof File ? file.name : "")).replace(/\.[a-z0-9]+$/i, ""),
      spec: String(form.get("spec") ?? ""),
      tags: tags.map((t) => t.trim().toLowerCase()).filter(Boolean),
      source: SOURCES.includes(source) ? source : "upload",
      meta,
      generationId: null,
      data: Buffer.from(await file.arrayBuffer()),
    });
    return NextResponse.json({ clipart }, { status: 201 });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Upload thất bại", 400);
  }
}

async function editableClipart(s: CtSession, id: string): Promise<CtAsset | NextResponse> {
  const { data } = await s.supabase.from(CT_TABLES.assets).select("*").eq("id", id).maybeSingle<CtAsset>();
  if (!data || data.product_id !== null) return jsonError("Clipart không có trong thư viện", 404);
  if (data.user_id !== s.user.id && !(await isAdmin(s))) return jsonError("Chỉ người tạo hoặc admin mới được sửa / xoá", 403);
  return data;
}

export async function updateClipart(s: CtSession, id: string, body: CtUpdateClipartBody): Promise<NextResponse> {
  const cur = await editableClipart(s, id);
  if (cur instanceof NextResponse) return cur;
  const patch: Partial<CtAsset> = {};
  if (typeof body.name === "string") patch.name = body.name.trim();
  if (typeof body.spec === "string") patch.spec = body.spec;
  if (typeof body.license === "string") patch.license = body.license;
  if (typeof body.sort_order === "number") patch.sort_order = body.sort_order;
  if (Array.isArray(body.tags)) patch.tags = body.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  if (body.meta) patch.meta = { ...cur.meta, ...body.meta };
  const moving = body.category_id !== undefined && body.category_id !== cur.category_id;
  if (moving) {
    if (cur.parent_id) return jsonError("Chỉ clipart gốc mới đổi được danh mục (biến thể đi theo gốc)", 400);
    patch.category_id = body.category_id;
  }
  const { data, error } = await s.supabase.from(CT_TABLES.assets).update(patch).eq("id", id).select("*").maybeSingle<CtAsset>();
  if (error) return jsonError(error.message, 500);
  if (!data) return jsonError("Không có quyền sửa clipart này", 403);
  if (moving) {
    const kids = await descendants(s.supabase, [id]);
    if (kids.length) await s.supabase.from(CT_TABLES.assets).update({ category_id: body.category_id }).in("id", kids.map((k) => k.id));
  }
  return NextResponse.json({ clipart: data });
}

/** Products that render any of `ids` (placed in a zone, picked as a main version, or the default main). */
export async function clipartUsage(db: Db, ids: string[]): Promise<CtClipartUsage[]> {
  if (!ids.length) return [];
  const [items, mains, defaults] = await Promise.all([
    db.from(CT_TABLES.items).select("region_id").in("asset_id", ids).returns<Array<{ region_id: string }>>(),
    db.from(CT_TABLES.productMains).select("product_id").in("asset_id", ids).returns<Array<{ product_id: string }>>(),
    db.from(CT_TABLES.products).select("id").in("main_asset_id", ids).returns<Array<{ id: string }>>(),
  ]);
  const productIds = new Set<string>([...(mains.data ?? []).map((m) => m.product_id), ...(defaults.data ?? []).map((p) => p.id)]);
  for (const p of await subOptionProducts(db, ids)) productIds.add(p.id);
  const regionIds = [...new Set((items.data ?? []).map((i) => i.region_id))];
  if (regionIds.length) {
    const { data: regions } = await db.from(CT_TABLES.regions).select("product_id").in("id", regionIds).returns<Array<{ product_id: string }>>();
    for (const r of regions ?? []) productIds.add(r.product_id);
  }
  if (!productIds.size) return [];
  const { data: products } = await db.from(CT_TABLES.products).select("id,name").in("id", [...productIds]).returns<Array<{ id: string; name: string }>>();
  return (products ?? []).map((p) => ({ productId: p.id, productName: p.name }));
}

/** Products offering any of `ids` as a version's sub-option ("Thêm option", config.main.subOptions). */
async function subOptionProducts(db: Db, ids: string[]): Promise<Array<Pick<CtProduct, "id" | "config">>> {
  const found = await Promise.all(
    ids.slice(0, 40).map((id) =>
      db
        .from(CT_TABLES.products)
        .select("id,config")
        .contains("config", { main: { subOptions: [{ ids: [id] }] } })
        .returns<Array<Pick<CtProduct, "id" | "config">>>()
        .then((r) => r.data ?? []),
    ),
  );
  const byId = new Map(found.flat().map((p) => [p.id, p]));
  return [...byId.values()];
}

/**
 * GET library/cliparts/:id/materials → the material pictures of a clipart (tổ hợp picker): its vật liệu versions,
 * the đa sắc of those, and the vật liệu of its own đa sắc — newest first within each.
 */
export async function getClipartMaterials(s: CtSession, id: string): Promise<NextResponse> {
  const kids = await descendants(s.supabase, [id]);
  return NextResponse.json({ cliparts: kids.filter((k) => k.role === "rendition") });
}

export async function getClipartUsage(s: CtSession, id: string): Promise<NextResponse> {
  const kids = await descendants(s.supabase, [id]);
  return NextResponse.json({ usage: await clipartUsage(s.supabase, [id, ...kids.map((k) => k.id)]) });
}

/**
 * Point every product that uses library clipart `oldId` at `nextId` instead
 * (null = stop using it): zone groups (region items), linked main versions,
 * the default main (+ thumbnail), the version's own layout and the zones'
 * hidden-option lists. Runs with the service role when configured — the
 * caller has checked the clipart is theirs to change; the products may belong
 * to other editors who placed the shared clipart.
 */
async function repointUsage(s: CtSession, oldId: string, next: CtAsset | null): Promise<void> {
  const db: Db = ctServiceClient() ?? s.supabase;
  const [items, mains, defaults] = await Promise.all([
    db.from(CT_TABLES.items).select("id,region_id").eq("asset_id", oldId).returns<Array<{ id: string; region_id: string }>>(),
    db.from(CT_TABLES.productMains).select("product_id").eq("asset_id", oldId).returns<Array<{ product_id: string }>>(),
    db.from(CT_TABLES.products).select("id").eq("main_asset_id", oldId).returns<Array<{ id: string }>>(),
  ]);
  const regionIds = [...new Set((items.data ?? []).map((i) => i.region_id))];
  const { data: itemRegions } = regionIds.length
    ? await db.from(CT_TABLES.regions).select("product_id").in("id", regionIds).returns<Array<{ product_id: string }>>()
    : { data: [] as Array<{ product_id: string }> };
  const productIds = [...new Set([...(mains.data ?? []).map((m) => m.product_id), ...(defaults.data ?? []).map((p) => p.id), ...(itemRegions ?? []).map((r) => r.product_id)])];

  if (next) {
    await db.from(CT_TABLES.items).update({ asset_id: next.id }).eq("asset_id", oldId);
    await db.from(CT_TABLES.productMains).update({ asset_id: next.id }).eq("asset_id", oldId);
    await db.from(CT_TABLES.products).update({ main_asset_id: next.id, thumbnail_url: next.url }).eq("main_asset_id", oldId);
  } else {
    await db.from(CT_TABLES.items).delete().eq("asset_id", oldId);
    await db.from(CT_TABLES.productMains).delete().eq("asset_id", oldId);
    // A product whose default main goes falls back to another version it has (linked, or its own), else none.
    for (const p of defaults.data ?? []) {
      const { data: linked } = await db.from(CT_TABLES.productMains).select("asset_id").eq("product_id", p.id).order("sort_order").limit(1).returns<Array<{ asset_id: string }>>();
      const { data: own } = linked?.length
        ? { data: [] as CtAsset[] }
        : await db.from(CT_TABLES.assets).select("*").eq("product_id", p.id).eq("role", "main").order("sort_order").limit(1).returns<CtAsset[]>();
      const fallback = linked?.[0]?.asset_id ?? own?.[0]?.id ?? null;
      const { data: fb } = fallback ? await db.from(CT_TABLES.assets).select("url").eq("id", fallback).maybeSingle<Pick<CtAsset, "url">>() : { data: null };
      await db.from(CT_TABLES.products).update({ main_asset_id: fallback, thumbnail_url: fb?.url ?? null }).eq("id", p.id);
    }
  }
  if (!productIds.length) return;

  // Ids kept inside JSON config: a main version's own layout and sub-options, a zone's hidden options, the version a
  // layer belongs to.
  const { data: products } = await db.from(CT_TABLES.products).select("id,config").in("id", productIds).returns<Array<Pick<CtProduct, "id" | "config">>>();
  const withOptions = await subOptionProducts(db, [oldId]);
  const all = new Map([...(products ?? []), ...withOptions].map((p) => [p.id, p]));
  for (const p of all.values()) {
    let config = p.config ?? {};
    let changed = false;
    const layouts = config.layouts;
    if (layouts && layouts[oldId]) {
      const rest: Record<string, CtMainLayout> = { ...layouts };
      const moved = rest[oldId];
      delete rest[oldId];
      if (next) rest[next.id] = moved;
      config = { ...config, layouts: rest };
      changed = true;
    }
    const main = config.main;
    if (main && Array.isArray(main.subOptions) && main.subOptions.some((e) => e.mainId === oldId || e.ids.includes(oldId))) {
      const subOptions = main.subOptions
        .filter((e) => next !== null || e.mainId !== oldId)
        .map((e) => ({
          mainId: e.mainId === oldId && next ? next.id : e.mainId,
          ids: next ? e.ids.map((x) => (x === oldId ? next.id : x)) : e.ids.filter((x) => x !== oldId),
        }));
      config = { ...config, main: { ...main, subOptions } };
      changed = true;
    }
    if (changed) await db.from(CT_TABLES.products).update({ config }).eq("id", p.id);
  }
  const { data: regions } = await db.from(CT_TABLES.regions).select("id,config").in("product_id", productIds).returns<Array<Pick<CtRegion, "id" | "config">>>();
  for (const r of regions ?? []) {
    const hidden = r.config?.image?.hiddenAssetIds;
    const hides = Array.isArray(hidden) && hidden.includes(oldId);
    // A layer of the replaced main version follows it to the new one.
    const owned = r.config?.mainId === oldId && next !== null;
    if (!hides && !owned) continue;
    let config = r.config;
    if (hides && Array.isArray(hidden)) config = { ...config, image: { ...config.image, hiddenAssetIds: next ? hidden.map((x) => (x === oldId ? next.id : x)) : hidden.filter((x) => x !== oldId) } };
    if (owned && next) config = { ...config, mainId: next.id };
    await db.from(CT_TABLES.regions).update({ config }).eq("id", r.id);
  }
}

/**
 * DELETE library/cliparts/:id[?force=1]. Used by a product → 409 with the
 * usage, unless `force`: then it is taken out of those products first (zone
 * groups, main versions). Its files stay in Storage while it was used — a
 * published template may still show it until the product is published again.
 */
export async function deleteClipart(s: CtSession, id: string, force = false): Promise<NextResponse> {
  const cur = await editableClipart(s, id);
  if (cur instanceof NextResponse) return cur;
  const kids = await descendants(s.supabase, [id]);
  // A set member is offered wherever its origin is placed.
  const usage = await clipartUsage(s.supabase, [id, ...kids.map((k) => k.id), ...(cur.parent_id && cur.role !== "rendition" ? [cur.parent_id] : [])]);
  if (usage.length && !force) {
    return NextResponse.json(
      { error: `Clipart đang được dùng trong: ${usage.map((u) => u.productName).join(", ")}.`, usage },
      { status: 409 },
    );
  }
  if (usage.length) for (const x of [id, ...kids.map((k) => k.id)]) await repointUsage(s, x, null);
  const { error } = await s.supabase.from(CT_TABLES.assets).delete().eq("id", id);
  if (error) return jsonError(error.message, 500);
  if (!usage.length) await ctRemove([cur.storage_path, ...kids.map((k) => k.storage_path)]);
  return new NextResponse(null, { status: 204 });
}

/**
 * POST library/cliparts/:id/replace { with } — an edited version (AI refine)
 * takes the old one's place: every product using the old clipart now uses the
 * new one, then the old one is deleted with its own material versions (drawn
 * from the old art; `keepRenditions` moves them too); its đa sắc move to the
 * new one. Both are origins, or members / renditions of the same parent.
 */
export async function replaceClipart(s: CtSession, id: string, withId: string, keepRenditions = false): Promise<NextResponse> {
  const cur = await editableClipart(s, id);
  if (cur instanceof NextResponse) return cur;
  const { data: next } = await s.supabase.from(CT_TABLES.assets).select("*").eq("id", withId).maybeSingle<CtAsset>();
  if (!next || next.product_id !== null || next.id === id) return jsonError("Bản mới không có trong thư viện", 400);
  // An origin by an origin, or a set member by another member of the same origin (a fixed colour / variant).
  if (cur.role !== next.role || cur.parent_id !== next.parent_id) return jsonError("Chỉ thay được bằng clipart cùng loại (gốc ↔ gốc, biến thể ↔ biến thể cùng gốc)", 400);
  // A member fixed by AI is still the same colour / style of its origin: it keeps how it was made.
  if (cur.meta?.variant && !next.meta?.variant) {
    await s.supabase.from(CT_TABLES.assets).update({ meta: { ...next.meta, variant: cur.meta.variant } }).eq("id", next.id);
  }
  // The old one's đa sắc (colours / versions — of a vật liệu version too) are cliparts in their own right — they
  // move to the new one, with their own renditions. Its own material versions go (drawn from the old art), unless
  // `keepRenditions`: the caller renders them again from the new art and replaces them one by one.
  const { data: own } = await s.supabase.from(CT_TABLES.assets).select("*").eq("parent_id", id).returns<CtAsset[]>();
  const members = (own ?? []).filter((a) => a.role !== "rendition" || Boolean(a.meta?.variant) || keepRenditions);
  const renditions = (own ?? []).filter((a) => !members.includes(a));
  if (members.length) {
    const { error: moveError } = await s.supabase.from(CT_TABLES.assets).update({ parent_id: next.id }).in("id", members.map((m) => m.id));
    if (moveError) return jsonError(moveError.message, 500);
  }
  const usage = await clipartUsage(s.supabase, [id, ...renditions.map((k) => k.id)]);
  if (usage.length) {
    await repointUsage(s, id, next);
    for (const k of renditions) await repointUsage(s, k.id, null);
  }
  const { error } = await s.supabase.from(CT_TABLES.assets).delete().eq("id", id);
  if (error) return jsonError(error.message, 500);
  // A recolour keeps the picture it started from ("Màu gốc" brings it back): that file stays.
  const keepFile = next.meta?.colorSource?.url === cur.url;
  if (!usage.length) await ctRemove([...(keepFile ? [] : [cur.storage_path]), ...renditions.map((k) => k.storage_path)]);
  return NextResponse.json({ usage, moved: members.map((m) => m.id) });
}

/**
 * POST assets/:id/promote { category_id } — move a product's clipart (and its
 * versions) into the library. The product keeps using it: zone items point at
 * the same id, and a main becomes a linked main version.
 */
export async function promoteAsset(s: CtSession, id: string, categoryId: string | null): Promise<NextResponse> {
  const { data: asset } = await s.supabase.from(CT_TABLES.assets).select("*").eq("id", id).maybeSingle<CtAsset>();
  if (!asset) return jsonError("Không tìm thấy asset", 404);
  if (asset.user_id !== s.user.id && !(await isAdmin(s))) return jsonError("Chỉ người tạo hoặc admin mới đưa được vào thư viện", 403);
  if (asset.product_id === null) return jsonError("Đã nằm trong thư viện", 400);
  if (asset.parent_id || (asset.role !== "main" && asset.role !== "sub")) return jsonError("Chỉ main / sub gốc mới đưa được vào thư viện", 400);
  if (categoryId) {
    const { data: cat } = await s.supabase.from(CT_TABLES.categories).select("id").eq("id", categoryId).maybeSingle<Pick<CtClipartCategory, "id">>();
    if (!cat) return jsonError("Danh mục không tồn tại", 400);
  }
  const productId = asset.product_id;
  const kids = await descendants(s.supabase, [id]);
  const ids = [id, ...kids.map((k) => k.id)];
  const { error } = await s.supabase.from(CT_TABLES.assets).update({ product_id: null, category_id: categoryId }).in("id", ids);
  if (error) return jsonError(missingMigration(error.message), 500);
  if (asset.role === "main") {
    await s.supabase.from(CT_TABLES.productMains).upsert({ product_id: productId, asset_id: id, sort_order: asset.sort_order });
  }
  const { data } = await s.supabase.from(CT_TABLES.assets).select("*").in("id", ids).returns<CtAsset[]>();
  return NextResponse.json({ assets: data ?? [] });
}

// ---------------------------------------------------------------------------
// Main versions picked from the library
// ---------------------------------------------------------------------------

async function ownedProduct(s: CtSession, productId: string): Promise<CtProduct | null> {
  const { data } = await s.supabase.from(CT_TABLES.products).select("*").eq("id", productId).maybeSingle<CtProduct>();
  return data && (data.user_id === s.user.id || (await isAdmin(s))) ? data : null;
}

/**
 * POST products/:id/mains { asset_id } — use a library clipart as a version of this product: any of them (gốc,
 * đa sắc, vật liệu), as it is.
 */
export async function linkProductMain(s: CtSession, productId: string, assetId: string): Promise<NextResponse> {
  const product = await ownedProduct(s, productId);
  if (!product) return jsonError("Không có quyền sửa sản phẩm này", 403);
  const { data: asset } = await s.supabase.from(CT_TABLES.assets).select("*").eq("id", assetId).maybeSingle<CtAsset>();
  if (!asset || asset.product_id !== null) return jsonError("Chỉ clipart trong thư viện mới thêm được làm version", 400);
  const { count } = await s.supabase.from(CT_TABLES.productMains).select("asset_id", { count: "exact", head: true }).eq("product_id", productId);
  const { error } = await s.supabase.from(CT_TABLES.productMains).upsert({ product_id: productId, asset_id: assetId, sort_order: 100 + (count ?? 0) });
  if (error) return jsonError(missingMigration(error.message), 500);
  if (!product.main_asset_id) await s.supabase.from(CT_TABLES.products).update({ main_asset_id: assetId, thumbnail_url: asset.url }).eq("id", productId);
  const assets = await loadLinkedAssets(s.supabase, productId, [assetId]);
  return NextResponse.json({ assets, main_asset_id: product.main_asset_id ?? assetId }, { status: 201 });
}

/** DELETE products/:id/mains/:assetId — stop using it (the clipart stays in the library). */
export async function unlinkProductMain(s: CtSession, productId: string, assetId: string): Promise<NextResponse> {
  const product = await ownedProduct(s, productId);
  if (!product) return jsonError("Không có quyền sửa sản phẩm này", 403);
  const { error } = await s.supabase.from(CT_TABLES.productMains).delete().eq("product_id", productId).eq("asset_id", assetId);
  if (error) return jsonError(error.message, 500);
  if (product.main_asset_id === assetId) await s.supabase.from(CT_TABLES.products).update({ main_asset_id: null }).eq("id", productId);
  return new NextResponse(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// What a product renders
// ---------------------------------------------------------------------------

/**
 * Library cliparts `ids` as this product sees them — each one exactly the picture that was dragged in: a linked
 * version (or the default main) reads as role "main", anything else as a layer clipart (role "sub"), whatever it
 * is in the library (gốc, đa sắc, vật liệu). A gốc placed in a layer brings its đa sắc along as the group's
 * options (the editor hides them until they are switched on); every clipart brings its vật liệu versions for the
 * "rendition" display — never the đa sắc of a vật liệu version (they are pictures of their own). Linked versions
 * take the product's own order.
 */
async function loadLinkedAssets(db: Db, productId: string, ids: string[], mainAssetId: string | null = null): Promise<CtAsset[]> {
  if (!ids.length) return [];
  const [{ data: roots }, { data: links }] = await Promise.all([
    db.from(CT_TABLES.assets).select("*").in("id", ids).is("product_id", null).returns<CtAsset[]>(),
    db.from(CT_TABLES.productMains).select("asset_id,sort_order").eq("product_id", productId).returns<Array<{ asset_id: string; sort_order: number }>>(),
  ]);
  const order = new Map((links ?? []).map((l) => [l.asset_id, l.sort_order]));
  const base = (roots ?? []).map((a) => {
    if (order.has(a.id)) return { ...asVersion(a), sort_order: order.get(a.id) ?? a.sort_order };
    return a.id === mainAssetId ? asVersion(a) : asLayerClipart(a);
  });
  // Only a gốc used as a layer offers its đa sắc (role variant: an element origin's colours).
  const offers = new Set((roots ?? []).filter((a) => a.parent_id === null && a.role === "sub" && !order.has(a.id) && a.id !== mainAssetId).map((a) => a.id));
  const baseIds = new Set(base.map((a) => a.id));
  const kids = (await descendants(db, base.map((a) => a.id))).filter((k) => {
    if (baseIds.has(k.id)) return false;
    if (k.role === "rendition") return !k.meta?.variant;
    return k.role === "variant" && k.parent_id !== null && offers.has(k.parent_id);
  });
  // Renditions one level deeper (of a đa sắc): kept only under kept cliparts.
  const kept = new Set([...baseIds, ...kids.filter((k) => k.role !== "rendition").map((k) => k.id)]);
  return [...base, ...kids.filter((k) => k.parent_id !== null && kept.has(k.parent_id))];
}

/** Sub-options of the product's versions ("Thêm option"), as the product reads them: role variant, parent = the version. */
async function loadSubOptions(db: Db, product: CtProduct, have: Set<string>): Promise<CtAsset[]> {
  const entries = normalizeSubOptions(product.config?.main?.subOptions);
  const want = entries.flatMap((e) => e.ids.map((id) => ({ id, mainId: e.mainId }))).filter((x) => !have.has(x.id));
  if (!want.length) return [];
  const { data } = await db.from(CT_TABLES.assets).select("*").in("id", want.map((x) => x.id)).returns<CtAsset[]>();
  const byId = new Map((data ?? []).filter((a) => a.product_id === null || a.product_id === product.id).map((a) => [a.id, a]));
  const options = want.flatMap((x) => {
    const a = byId.get(x.id);
    return a ? [asMainOption(a, x.mainId)] : [];
  });
  // Their vật liệu versions too: the "rendition" display draws a sub-option in its material, like its version.
  const { data: renditions } = options.length
    ? await db.from(CT_TABLES.assets).select("*").eq("role", "rendition").in("parent_id", options.map((a) => a.id)).returns<CtAsset[]>()
    : { data: [] as CtAsset[] };
  return [...options, ...(renditions ?? []).filter((r) => !r.meta?.variant && !have.has(r.id))];
}

/**
 * Pictures a layer group offers beyond its gốc's đa sắc (config.image.extraOptions — a đa sắc of a vật liệu version
 * picked with its gốc), as the product reads them: role variant, parent = the group's sub.
 */
async function loadGroupExtras(db: Db, product: CtProduct, regions: CtRegion[], have: Set<string>): Promise<CtAsset[]> {
  const want = new Map<string, string>();
  for (const r of regions) {
    const extra: unknown = r.config?.image?.extraOptions;
    if (!extra || typeof extra !== "object") continue;
    for (const [id, subId] of Object.entries(extra as Record<string, unknown>)) if (typeof subId === "string" && !have.has(id)) want.set(id, subId);
  }
  if (!want.size) return [];
  const { data } = await db.from(CT_TABLES.assets).select("*").in("id", [...want.keys()]).returns<CtAsset[]>();
  return (data ?? []).filter((a) => a.product_id === null || a.product_id === product.id).map((a) => asMainOption(a, want.get(a.id) ?? ""));
}

/** Every asset the editor / publish needs: the product's own + the library cliparts it uses. */
export async function loadProductAssets(db: Db, product: CtProduct, items: CtRegionItem[], regions: CtRegion[] = []): Promise<CtAsset[]> {
  const [{ data: own }, { data: links }] = await Promise.all([
    db.from(CT_TABLES.assets).select("*").eq("product_id", product.id).order("sort_order").order("created_at").returns<CtAsset[]>(),
    db.from(CT_TABLES.productMains).select("asset_id").eq("product_id", product.id).returns<Array<{ asset_id: string }>>(),
  ]);
  const ownList = own ?? [];
  const ownIds = new Set(ownList.map((a) => a.id));
  const wanted = new Set<string>([...items.map((i) => i.asset_id), ...(links ?? []).map((l) => l.asset_id)]);
  if (product.main_asset_id) wanted.add(product.main_asset_id);
  const libIds = [...wanted].filter((id) => !ownIds.has(id));
  const lib = await loadLinkedAssets(db, product.id, libIds, product.main_asset_id);
  const list = [...ownList, ...lib.filter((a) => !ownIds.has(a.id))];
  const withOptions = [...list, ...(await loadSubOptions(db, product, new Set(list.map((a) => a.id))))];
  const all = [...withOptions, ...(await loadGroupExtras(db, product, regions, new Set(withOptions.map((a) => a.id))))];
  // A vật liệu made theo khuôn belongs to the product whose khuôn it was cut to.
  return all.filter((a) => !a.meta?.frame || a.meta.frame.productId === product.id);
}

// ---------------------------------------------------------------------------
// Presets (style packs, materials, scenes)
// ---------------------------------------------------------------------------

type PresetRow = Omit<CtPreset, "can_edit">;

/** A url of a file in our own storage (R2). */
export function isOwnUploadUrl(u: unknown): u is string {
  return typeof u === "string" && u.startsWith(r2PublicUrl(""));
}

export async function listPresets(s: CtSession, kind: string | null): Promise<NextResponse> {
  let q = s.supabase.from(CT_TABLES.presets).select("*");
  if (kind && PRESET_KINDS.includes(kind as CtPresetKind)) q = q.eq("kind", kind);
  const { data, error } = await q.order("kind").order("sort_order").order("created_at").returns<PresetRow[]>();
  if (error) return jsonError(missingMigration(error.message), 500);
  const admin = await isAdmin(s);
  const presets: CtPreset[] = (data ?? []).map((p) => ({ ...p, can_edit: admin || p.user_id === s.user.id }));
  return NextResponse.json({ presets, admin });
}
