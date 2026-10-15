/**
 * A product's folder in the clipart library (asked 2026-10-10): the category named after the product
 * (rules.productId = the product). Its Artwork tab holds the finished designs — one per main version, saved again
 * whenever the design is saved (meta.artwork.versionId), plus extras saved by hand. A v2 bộ nhân vật puts its layer
 * cliparts in the same folder (server/char/product.ts). Renaming the product renames the folder.
 *
 *   GET  products/:id/artworks              → CtProductArtworks
 *   POST products/:id/artworks              multipart file, versionId?, hash?, name?, selection (JSON) → { artwork }
 *   POST products/:id/artworks/prune        { versionIds } — version artworks of versions no longer there are deleted
 */

import { NextResponse } from "next/server";
import { CT_TABLES } from "../config";
import type { CtArtworkMeta, CtAsset, CtClipartCategory, CtProduct, CtProductArtworks, CtSelection } from "../types";
import { defaultCategoryRules, normalizeCategoryRules } from "../lib/library";
import { normalizeSamples } from "../lib/design";
import { isAdmin } from "./ai-styles";
import { readImageInfo } from "./image-size";
import { insertClipart } from "./library";
import { ctLibraryPath, ctRemove, ctUpload } from "./storage";
import type { CtServiceClient, CtSession, CtSupabase } from "./supabase";

type Db = CtSupabase | CtServiceClient;

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

function categoryRow(c: Omit<CtClipartCategory, "count" | "can_edit">): CtClipartCategory {
  return { ...c, rules: normalizeCategoryRules(c.rules), can_edit: true };
}

/** The product's folder, or null when it has none yet. */
export async function findProductFolder(db: Db, productId: string): Promise<CtClipartCategory | null> {
  const { data } = await db.from(CT_TABLES.categories).select("*").filter("rules->>productId", "eq", productId).order("created_at").limit(1).returns<CtClipartCategory[]>();
  return data?.[0] ? categoryRow(data[0]) : null;
}

/** The product's folder, made (named after the product) when it has none yet. */
export async function productFolder(db: Db, userId: string, product: Pick<CtProduct, "id" | "name">): Promise<CtClipartCategory> {
  const have = await findProductFolder(db, product.id);
  if (have) return have;
  const { data, error } = await db
    .from(CT_TABLES.categories)
    .insert({ user_id: userId, name: product.name.slice(0, 120) || "Sản phẩm", parent_id: null, usage: "element", mode: "origin_set", spec: "", rules: { ...defaultCategoryRules(), productId: product.id } })
    .select("*")
    .single<CtClipartCategory>();
  if (error || !data) throw new Error(error?.message ?? "Không tạo được danh mục của sản phẩm");
  return categoryRow(data);
}

/** The product was renamed: its folder follows. */
export async function renameProductFolder(db: Db, productId: string, name: string): Promise<void> {
  const folder = await findProductFolder(db, productId);
  if (folder && folder.name !== name) await db.from(CT_TABLES.categories).update({ name: name.slice(0, 120) }).eq("id", folder.id);
}

async function ownedProduct(s: CtSession, id: string): Promise<CtProduct | null> {
  const { data } = await s.supabase.from(CT_TABLES.products).select("*").eq("id", id).maybeSingle<CtProduct>();
  return data && (data.user_id === s.user.id || (await isAdmin(s))) ? data : null;
}

/** The artworks saved from product `productId` (in its folder, or moved elsewhere since). */
async function artworksOf(db: Db, productId: string): Promise<CtAsset[]> {
  const { data } = await db.from(CT_TABLES.assets).select("*").is("product_id", null).is("parent_id", null).filter("meta->artwork->>productId", "eq", productId).order("created_at").returns<CtAsset[]>();
  return data ?? [];
}

/** GET products/:id/artworks */
export async function listProductArtworks(s: CtSession, productId: string): Promise<NextResponse> {
  const body: CtProductArtworks = { category: await findProductFolder(s.supabase, productId), artworks: await artworksOf(s.supabase, productId) };
  return NextResponse.json(body);
}

function parseSelection(raw: FormDataEntryValue | null): CtSelection {
  if (typeof raw !== "string" || !raw) return {};
  try {
    return normalizeSamples(JSON.parse(raw) as CtSelection);
  } catch {
    return {};
  }
}

/** POST products/:id/artworks — a version's artwork is replaced in place (same clipart, new picture). */
export async function saveProductArtwork(s: CtSession, productId: string, form: FormData): Promise<NextResponse> {
  const product = await ownedProduct(s, productId);
  if (!product) return jsonError("Không có quyền sửa sản phẩm này", 403);
  const file = form.get("file");
  if (!(file instanceof Blob) || !file.size) return jsonError("Thiếu ảnh artwork", 400);
  const data = Buffer.from(await file.arrayBuffer());
  const info = readImageInfo(data);
  if (!info) return jsonError("Ảnh artwork không hợp lệ", 400);
  const versionId = typeof form.get("versionId") === "string" ? String(form.get("versionId")) : "";
  const hash = typeof form.get("hash") === "string" ? String(form.get("hash")).slice(0, 200) : "";
  const name = (typeof form.get("name") === "string" ? String(form.get("name")).trim() : "").slice(0, 200) || `${product.name} — artwork`;
  const meta: CtArtworkMeta = {
    productId,
    selection: parseSelection(form.get("selection")),
    templateId: product.config?.print?.templateId ?? null,
    ...(versionId ? { versionId } : {}),
    ...(hash ? { hash } : {}),
  };
  try {
    const folder = await productFolder(s.supabase, s.user.id, product);
    const old = versionId ? (await artworksOf(s.supabase, productId)).find((a) => a.meta.artwork?.versionId === versionId) : undefined;
    if (old) {
      const path = ctLibraryPath(s.user.id, old.category_id, old.role, info.mime);
      const url = await ctUpload(path, data, info.mime);
      const { data: row, error } = await s.supabase
        .from(CT_TABLES.assets)
        .update({ url, storage_path: path, width: info.width, height: info.height, mime: info.mime, name, meta: { ...old.meta, artwork: meta } })
        .eq("id", old.id)
        .select("*")
        .single<CtAsset>();
      if (error || !row) {
        await ctRemove([path]);
        return jsonError(error?.message ?? "Không lưu được artwork", 500);
      }
      await ctRemove([old.storage_path]);
      return NextResponse.json({ artwork: row });
    }
    const artwork = await insertClipart(s.supabase, s.user.id, {
      categoryId: folder.id,
      parentId: null,
      rendition: false,
      name,
      spec: "",
      tags: ["artwork"],
      source: "upload",
      meta: { artwork: meta },
      generationId: null,
      data,
    });
    return NextResponse.json({ artwork }, { status: 201 });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không lưu được artwork", 500);
  }
}

/** POST products/:id/artworks/prune — artworks of versions the product no longer has go away. */
export async function pruneProductArtworks(s: CtSession, productId: string, body: unknown): Promise<NextResponse> {
  if (!(await ownedProduct(s, productId))) return jsonError("Không có quyền sửa sản phẩm này", 403);
  const raw = body && typeof body === "object" ? (body as { versionIds?: unknown }).versionIds : null;
  const keep = new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  const gone = (await artworksOf(s.supabase, productId)).filter((a) => a.meta.artwork?.versionId && !keep.has(a.meta.artwork.versionId));
  if (gone.length) {
    await s.supabase.from(CT_TABLES.assets).delete().in("id", gone.map((a) => a.id));
    await ctRemove(gone.map((a) => a.storage_path));
  }
  return NextResponse.json({ removed: gone.length });
}
