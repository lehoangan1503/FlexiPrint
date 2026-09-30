/**
 * The global clipart library (migration 006): categories, library cliparts,
 * prompt presets, main versions a product picks from the library, and the
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
  CtClipartCategory,
  CtClipartUsage,
  CtPreset,
  CtPresetBody,
  CtPresetKind,
  CtProduct,
  CtRegionItem,
  CtUpdateClipartBody,
} from "../types";
import { memberRole, normalizeCategoryRules, originRole } from "../lib/library";
import { isAdmin } from "./ai-styles";
import { readImageInfo } from "./image-size";
import { ctLibraryPath, ctRemove, ctUpload } from "./storage";
import type { CtServiceClient, CtSession, CtSupabase } from "./supabase";

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

function cleanCategory(body: CtCategoryBody): CtCategoryBody | string {
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
  return NextResponse.json({ category });
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

/**
 * Store one library clipart. The role follows the structure: an origin gets
 * the category's usage (main / sub), a set member its parent's member role,
 * a rendition "rendition". Shared by the editor upload and the ComfyUI studio.
 */
export async function insertClipart(db: Db, userId: string, a: InsertClipartArgs): Promise<CtAsset> {
  const info = readImageInfo(a.data);
  if (!info) throw new Error("File không phải ảnh PNG/JPEG/WebP hợp lệ");

  let role: CtAssetRole;
  let categoryId = a.categoryId;
  if (a.parentId) {
    const { data: parent } = await db.from(CT_TABLES.assets).select("*").eq("id", a.parentId).maybeSingle<CtAsset>();
    if (!parent || parent.product_id !== null) throw new Error("Clipart cha không nằm trong thư viện");
    const member = memberRole(parent);
    if (a.rendition) role = "rendition";
    else if (member && parent.parent_id === null) role = member;
    else throw new Error("Chỉ clipart gốc mới có bộ biến thể");
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
  countQuery = a.parentId ? countQuery.eq("parent_id", a.parentId) : categoryId ? countQuery.eq("category_id", categoryId).is("parent_id", null) : countQuery.is("category_id", null).is("parent_id", null);
  const { count } = await countQuery;

  const { data, error } = await db
    .from(CT_TABLES.assets)
    .insert({
      user_id: userId,
      product_id: null,
      category_id: categoryId,
      role,
      parent_id: a.parentId,
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
      meta: a.meta,
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
  const regionIds = [...new Set((items.data ?? []).map((i) => i.region_id))];
  if (regionIds.length) {
    const { data: regions } = await db.from(CT_TABLES.regions).select("product_id").in("id", regionIds).returns<Array<{ product_id: string }>>();
    for (const r of regions ?? []) productIds.add(r.product_id);
  }
  if (!productIds.size) return [];
  const { data: products } = await db.from(CT_TABLES.products).select("id,name").in("id", [...productIds]).returns<Array<{ id: string; name: string }>>();
  return (products ?? []).map((p) => ({ productId: p.id, productName: p.name }));
}

export async function getClipartUsage(s: CtSession, id: string): Promise<NextResponse> {
  const kids = await descendants(s.supabase, [id]);
  return NextResponse.json({ usage: await clipartUsage(s.supabase, [id, ...kids.map((k) => k.id)]) });
}

export async function deleteClipart(s: CtSession, id: string): Promise<NextResponse> {
  const cur = await editableClipart(s, id);
  if (cur instanceof NextResponse) return cur;
  const kids = await descendants(s.supabase, [id]);
  // A set member is offered wherever its origin is placed.
  const usage = await clipartUsage(s.supabase, [id, ...kids.map((k) => k.id), ...(cur.parent_id && cur.role !== "rendition" ? [cur.parent_id] : [])]);
  if (usage.length) {
    return NextResponse.json(
      { error: `Clipart đang được dùng trong: ${usage.map((u) => u.productName).join(", ")}. Gỡ khỏi các sản phẩm đó trước.`, usage },
      { status: 409 },
    );
  }
  const { error } = await s.supabase.from(CT_TABLES.assets).delete().eq("id", id);
  if (error) return jsonError(error.message, 500);
  await ctRemove([cur.storage_path, ...kids.map((k) => k.storage_path)]);
  return new NextResponse(null, { status: 204 });
}

/**
 * POST assets/:id/promote { category_id } — move a product's clipart (and its
 * versions) into the library. The product keeps using it: zone items point at
 * the same id, and a main becomes a linked main version.
 */
export async function promoteAsset(s: CtSession, id: string, categoryId: string | null): Promise<NextResponse> {
  const { data: asset } = await s.supabase.from(CT_TABLES.assets).select("*").eq("id", id).maybeSingle<CtAsset>();
  if (!asset) return jsonError("Không tìm thấy asset", 404);
  if (asset.user_id !== s.user.id) return jsonError("Chỉ người tạo mới đưa được vào thư viện", 403);
  if (asset.product_id === null) return jsonError("Đã nằm trong thư viện", 400);
  if (asset.parent_id || (asset.role !== "main" && asset.role !== "sub")) return jsonError("Chỉ main / sub gốc mới đưa được vào thư viện", 400);
  if (categoryId) {
    const { data: cat } = await s.supabase.from(CT_TABLES.categories).select("usage").eq("id", categoryId).maybeSingle<Pick<CtClipartCategory, "usage">>();
    if (!cat) return jsonError("Danh mục không tồn tại", 400);
    if (originRole(cat) !== asset.role) return jsonError(cat.usage === "main" ? "Danh mục này dành cho main object" : "Danh mục này dành cho element (sub)", 400);
  }
  const productId = asset.product_id;
  const kids = await descendants(s.supabase, [id]);
  const ids = [id, ...kids.map((k) => k.id)];
  const { error } = await s.supabase.from(CT_TABLES.assets).update({ product_id: null, category_id: categoryId }).in("id", ids).eq("user_id", s.user.id);
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
  return data && data.user_id === s.user.id ? data : null;
}

/** POST products/:id/mains { asset_id } — use a library main as a version of this product. */
export async function linkProductMain(s: CtSession, productId: string, assetId: string): Promise<NextResponse> {
  const product = await ownedProduct(s, productId);
  if (!product) return jsonError("Không có quyền sửa sản phẩm này", 403);
  const { data: asset } = await s.supabase.from(CT_TABLES.assets).select("*").eq("id", assetId).maybeSingle<CtAsset>();
  if (!asset || asset.product_id !== null || asset.role !== "main") return jsonError("Chỉ main clipart trong thư viện mới thêm được làm version", 400);
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
 * Library cliparts `ids` as this product sees them: a sub brings its variants
 * and renditions, a main only its renditions (other colours of a main origin
 * are separate versions the product links one by one). Linked mains take the
 * product's own order.
 */
async function loadLinkedAssets(db: Db, productId: string, ids: string[]): Promise<CtAsset[]> {
  if (!ids.length) return [];
  const [{ data: roots }, { data: links }] = await Promise.all([
    db.from(CT_TABLES.assets).select("*").in("id", ids).is("product_id", null).returns<CtAsset[]>(),
    db.from(CT_TABLES.productMains).select("asset_id,sort_order").eq("product_id", productId).returns<Array<{ asset_id: string; sort_order: number }>>(),
  ]);
  const order = new Map((links ?? []).map((l) => [l.asset_id, l.sort_order]));
  const base = (roots ?? []).map((a) => (a.role === "main" && order.has(a.id) ? { ...a, sort_order: order.get(a.id) ?? a.sort_order } : a));
  const byId = new Map(base.map((a) => [a.id, a]));
  const kids = (await descendants(db, base.map((a) => a.id))).filter((k) => {
    const parent = k.parent_id ? byId.get(k.parent_id) : undefined;
    if (!parent) return k.role === "rendition"; // rendition of a variant
    return parent.role === "sub" ? k.role === "variant" || k.role === "rendition" : k.role === "rendition";
  });
  // Renditions of variants hang one level deeper: keep them only under kept variants.
  const kept = new Set([...base.map((a) => a.id), ...kids.filter((k) => k.role !== "rendition").map((k) => k.id)]);
  return [...base, ...kids.filter((k) => k.role !== "rendition" || (k.parent_id !== null && kept.has(k.parent_id)))];
}

/** Every asset the editor / publish needs: the product's own + the library cliparts it uses. */
export async function loadProductAssets(db: Db, product: CtProduct, items: CtRegionItem[]): Promise<CtAsset[]> {
  const [{ data: own }, { data: links }] = await Promise.all([
    db.from(CT_TABLES.assets).select("*").eq("product_id", product.id).order("sort_order").order("created_at").returns<CtAsset[]>(),
    db.from(CT_TABLES.productMains).select("asset_id").eq("product_id", product.id).returns<Array<{ asset_id: string }>>(),
  ]);
  const ownList = own ?? [];
  const ownIds = new Set(ownList.map((a) => a.id));
  const wanted = new Set<string>([...items.map((i) => i.asset_id), ...(links ?? []).map((l) => l.asset_id)]);
  if (product.main_asset_id) wanted.add(product.main_asset_id);
  const libIds = [...wanted].filter((id) => !ownIds.has(id));
  const lib = await loadLinkedAssets(db, product.id, libIds);
  return [...ownList, ...lib.filter((a) => !ownIds.has(a.id))];
}

// ---------------------------------------------------------------------------
// Presets (style packs, materials, scenes)
// ---------------------------------------------------------------------------

type PresetRow = Omit<CtPreset, "can_edit">;

function cleanPreset(body: CtPresetBody): CtPresetBody | string {
  const name = (body.name ?? "").trim();
  const prompt = (body.prompt ?? "").trim();
  if (!PRESET_KINDS.includes(body.kind)) return "Loại preset không hợp lệ";
  if (!name || name.length > 80) return "Tên preset 1–80 ký tự";
  if (!prompt || prompt.length > 6000) return "Prompt 1–6000 ký tự";
  return {
    kind: body.kind,
    name,
    prompt,
    reference_asset_ids: Array.isArray(body.reference_asset_ids) ? body.reference_asset_ids.slice(0, 8) : [],
    params: {
      ...(typeof body.params?.lockSilhouette === "boolean" ? { lockSilhouette: body.params.lockSilhouette } : {}),
      ...(typeof body.params?.model === "string" && body.params.model ? { model: body.params.model } : {}),
    },
    ...(typeof body.sort_order === "number" ? { sort_order: body.sort_order } : {}),
  };
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

export async function createPreset(s: CtSession, body: CtPresetBody): Promise<NextResponse> {
  const clean = cleanPreset(body);
  if (typeof clean === "string") return jsonError(clean, 400);
  const { data, error } = await s.supabase.from(CT_TABLES.presets).insert({ ...clean, user_id: s.user.id }).select("*").single<PresetRow>();
  if (error) return jsonError(missingMigration(error.message), 500);
  const preset: CtPreset = { ...data, can_edit: true };
  return NextResponse.json({ preset }, { status: 201 });
}

export async function updatePreset(s: CtSession, id: string, body: CtPresetBody): Promise<NextResponse> {
  const clean = cleanPreset(body);
  if (typeof clean === "string") return jsonError(clean, 400);
  const { data, error } = await s.supabase.from(CT_TABLES.presets).update(clean).eq("id", id).select("*").maybeSingle<PresetRow>();
  if (error) return jsonError(error.message, 500);
  if (!data) return jsonError("Chỉ người tạo hoặc admin mới được sửa preset", 403);
  const preset: CtPreset = { ...data, can_edit: true };
  return NextResponse.json({ preset });
}

export async function deletePreset(s: CtSession, id: string): Promise<NextResponse> {
  const { error, count } = await s.supabase.from(CT_TABLES.presets).delete({ count: "exact" }).eq("id", id);
  if (error) return jsonError(error.message, 500);
  if (!count) return jsonError("Chỉ người tạo hoặc admin mới được xoá preset", 403);
  return new NextResponse(null, { status: 204 });
}
