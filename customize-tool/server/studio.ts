/**
 * ComfyUI studio (services/comfy) ↔ FlexiPrint.
 *
 * 1. Gate. ComfyUI has no auth of its own. nginx puts it behind
 *    `auth_request` → GET studio/auth, which accepts the `fp_studio` cookie:
 *    HMAC(userId, expiry) with CT_STUDIO_SECRET, set by POST studio/session
 *    for a signed-in user (the /studio page calls it before loading the
 *    iframe). CT_STUDIO_COOKIE_DOMAIN (e.g. ".next.lc") lets the cookie reach
 *    a studio subdomain; unset = host-only (studio on another port of the
 *    same host — cookies ignore ports).
 *
 * 2. Internal API for the FlexiPrint node pack, `Authorization: Bearer
 *    CT_COMFY_TOKEN`, over the docker network (never exposed by nginx):
 *
 *    GET  internal/categories                  → { categories }
 *    GET  internal/presets?kind=               → { presets }
 *    GET  internal/cliparts?category=&q=       → { cliparts }  (origins + members + renditions)
 *    GET  internal/cliparts/:id                → { clipart }
 *    GET  internal/products                    → { products: [{ id, name, composites }] }
 *    POST internal/cliparts                    multipart: file, category_id?, parent_id?, rendition=1?, name, spec?, tags?,
 *                                              meta?, prompt?, resolved_prompt?, model?, workflow? → { clipart }
 *    POST internal/mockups                     multipart: file, product_id, name?, prompt?, model? → { asset }
 *
 *    Everything the studio creates is logged in ct_generations (provider
 *    "comfy", the resolved prompt and the graph that ran) and owned by
 *    CT_STUDIO_USER_ID (falls back to the first superadmin).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { CT_TABLES } from "../config";
import type { CtAsset, CtAssetMeta, CtAssetRole, CtClipartCategory, CtPreset, CtProduct } from "../types";
import { normalizeCategoryRules } from "../lib/library";
import { readImageInfo } from "./image-size";
import { ctServiceClient, type CtServiceClient, type CtSession } from "./supabase";
import { ctRemove, ctStoragePath, ctUpload } from "./storage";
import { insertClipart } from "./library";

const COOKIE = "fp_studio";
const TTL_S = 12 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** `<userId>.<exp>.<sig>` */
function makeToken(userId: string, secret: string): string {
  const payload = `${userId}.${Math.floor(Date.now() / 1000) + TTL_S}`;
  return `${payload}.${sign(payload, secret)}`;
}

function verifyToken(token: string, secret: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, exp, sig] = parts;
  const expected = Buffer.from(sign(`${userId}.${exp}`, secret));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  if (!UUID.test(userId) || Number(exp) < Date.now() / 1000) return null;
  return userId;
}

/** POST studio/session — signed-in user → studio cookie + where the studio lives. */
export function studioSession(s: CtSession): NextResponse {
  const secret = process.env.CT_STUDIO_SECRET;
  const url = process.env.CT_STUDIO_URL;
  if (!secret || !url) return jsonError("Studio chưa cấu hình (CT_STUDIO_SECRET, CT_STUDIO_URL)", 501);
  const res = NextResponse.json({ url });
  res.cookies.set(COOKIE, makeToken(s.user.id, secret), {
    httpOnly: true,
    secure: url.startsWith("https://"),
    sameSite: "lax",
    path: "/",
    maxAge: TTL_S,
    ...(process.env.CT_STUDIO_COOKIE_DOMAIN ? { domain: process.env.CT_STUDIO_COOKIE_DOMAIN } : {}),
  });
  return res;
}

/** GET studio/auth — nginx auth_request: 204 + X-Studio-User, or 401. */
export function studioAuth(req: NextRequest): NextResponse {
  const secret = process.env.CT_STUDIO_SECRET;
  const token = req.cookies.get(COOKIE)?.value;
  const userId = secret && token ? verifyToken(token, secret) : null;
  if (!userId) return new NextResponse(null, { status: 401 });
  return new NextResponse(null, { status: 204, headers: { "X-Studio-User": userId } });
}

// ---------------------------------------------------------------------------
// Internal API (ComfyUI nodes)
// ---------------------------------------------------------------------------

let studioOwner: string | null = null;

/** Who owns what the studio creates. */
async function ownerId(db: CtServiceClient): Promise<string | null> {
  if (process.env.CT_STUDIO_USER_ID) return process.env.CT_STUDIO_USER_ID;
  if (studioOwner) return studioOwner;
  const { data } = await db.auth.admin.listUsers({ perPage: 200 });
  studioOwner = data?.users.find((u) => u.app_metadata?.role === "admin")?.id ?? null;
  return studioOwner;
}

function internalAuthorized(req: NextRequest): boolean {
  const token = process.env.CT_COMFY_TOKEN;
  return Boolean(token) && req.headers.get("authorization") === `Bearer ${token}`;
}

async function listCliparts(db: CtServiceClient, category: string | null, q: string): Promise<CtAsset[]> {
  let query = db.from(CT_TABLES.assets).select("*").is("product_id", null).is("parent_id", null);
  if (category === "none") query = query.is("category_id", null);
  else if (category) query = query.eq("category_id", category);
  const safe = q.replace(/[%,()]/g, " ").trim();
  if (safe) query = query.or(`name.ilike.%${safe}%,spec.ilike.%${safe}%`);
  const { data } = await query.order("sort_order").order("created_at").limit(500).returns<CtAsset[]>();
  const origins = data ?? [];
  if (!origins.length) return [];
  const { data: kids } = await db.from(CT_TABLES.assets).select("*").in("parent_id", origins.map((o) => o.id)).returns<CtAsset[]>();
  const level1 = kids ?? [];
  const { data: grand } = level1.length
    ? await db.from(CT_TABLES.assets).select("*").in("parent_id", level1.map((k) => k.id)).returns<CtAsset[]>()
    : { data: [] as CtAsset[] };
  return [...origins, ...level1, ...(grand ?? [])];
}

interface LogArgs {
  userId: string;
  productId: string | null;
  categoryId: string | null;
  role: CtAssetRole;
  parentId: string | null;
  model: string;
  prompt: string;
  resolvedPrompt: string;
  workflow: object | null;
}

async function logGeneration(db: CtServiceClient, a: LogArgs): Promise<string | null> {
  const { data, error } = await db
    .from(CT_TABLES.generations)
    .insert({
      user_id: a.userId,
      product_id: a.productId,
      category_id: a.categoryId,
      target_role: a.role,
      parent_asset_id: a.parentId,
      provider: "comfy",
      model: a.model || "comfy",
      prompt: a.prompt || "(studio)",
      resolved_prompt: a.resolvedPrompt,
      workflow: a.workflow,
      status: "succeeded",
      finished_at: new Date().toISOString(),
    })
    .select("id")
    .single<{ id: string }>();
  if (error) console.warn("[ct] studio generation log failed", error.message);
  return data?.id ?? null;
}

function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
}

function jsonField<T>(form: FormData, key: string, fallback: T): T {
  const raw = str(form, key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function saveClipart(db: CtServiceClient, form: FormData): Promise<NextResponse> {
  const file = form.get("file");
  if (!(file instanceof Blob)) return jsonError("Thiếu file", 400);
  const userId = await ownerId(db);
  if (!userId) return jsonError("Không xác định được chủ sở hữu (CT_STUDIO_USER_ID)", 500);
  const parentId = str(form, "parent_id") || null;
  const rendition = str(form, "rendition") === "1";
  const categoryId = str(form, "category_id") || null;
  let role: CtAssetRole = rendition ? "rendition" : parentId ? "variant" : "sub";
  if (!rendition && !parentId && categoryId) {
    const { data: cat } = await db.from(CT_TABLES.categories).select("usage").eq("id", categoryId).maybeSingle<Pick<CtClipartCategory, "usage">>();
    if (cat?.usage === "main") role = "main";
  }
  const generationId = await logGeneration(db, {
    userId,
    productId: null,
    categoryId,
    role,
    parentId,
    model: str(form, "model"),
    prompt: str(form, "prompt"),
    resolvedPrompt: str(form, "resolved_prompt"),
    workflow: jsonField<object | null>(form, "workflow", null),
  });
  try {
    const clipart = await insertClipart(db, userId, {
      categoryId,
      parentId,
      rendition,
      name: str(form, "name") || "studio",
      spec: str(form, "spec"),
      tags: jsonField<string[]>(form, "tags", []).map((t) => String(t).trim().toLowerCase()).filter(Boolean),
      source: "ai",
      meta: jsonField<CtAssetMeta>(form, "meta", {}),
      generationId,
      data: Buffer.from(await file.arrayBuffer()),
    });
    return NextResponse.json({ clipart }, { status: 201 });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Lưu clipart thất bại", 400);
  }
}

async function saveMockup(db: CtServiceClient, form: FormData): Promise<NextResponse> {
  const file = form.get("file");
  const productId = str(form, "product_id");
  if (!(file instanceof Blob) || !UUID.test(productId)) return jsonError("Thiếu file / product_id", 400);
  const { data: product } = await db.from(CT_TABLES.products).select("id,user_id").eq("id", productId).maybeSingle<Pick<CtProduct, "id" | "user_id">>();
  if (!product) return jsonError("Sản phẩm không tồn tại", 404);
  const data = Buffer.from(await file.arrayBuffer());
  const info = readImageInfo(data);
  if (!info) return jsonError("File không phải ảnh PNG/JPEG/WebP hợp lệ", 400);
  const generationId = await logGeneration(db, {
    userId: product.user_id,
    productId,
    categoryId: null,
    role: "mockup",
    parentId: null,
    model: str(form, "model"),
    prompt: str(form, "prompt"),
    resolvedPrompt: str(form, "resolved_prompt"),
    workflow: jsonField<object | null>(form, "workflow", null),
  });
  const path = ctStoragePath(product.user_id, productId, "mockup", info.mime);
  const url = await ctUpload(path, data, info.mime);
  const { data: asset, error } = await db
    .from(CT_TABLES.assets)
    .insert({
      user_id: product.user_id,
      product_id: productId,
      role: "mockup",
      generation_id: generationId,
      name: str(form, "name") || "Studio mockup",
      url,
      storage_path: path,
      width: info.width,
      height: info.height,
      mime: info.mime,
      source: "ai",
      meta: {},
    })
    .select("*")
    .single<CtAsset>();
  if (error) {
    await ctRemove([path]);
    return jsonError(error.message, 500);
  }
  return NextResponse.json({ asset }, { status: 201 });
}

export async function dispatchInternal(req: NextRequest, path: string[]): Promise<NextResponse> {
  if (!internalAuthorized(req)) return jsonError("Unauthorized", 401);
  const db = ctServiceClient();
  if (!db) return jsonError("SUPABASE_SERVICE_ROLE_KEY chưa được cấu hình", 501);
  const [, resource, id] = path;
  const method = req.method;
  const params = req.nextUrl.searchParams;

  if (resource === "categories" && method === "GET") {
    const { data, error } = await db.from(CT_TABLES.categories).select("*").order("sort_order").order("name").returns<CtClipartCategory[]>();
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ categories: (data ?? []).map((c) => ({ ...c, rules: normalizeCategoryRules(c.rules) })) });
  }
  if (resource === "presets" && method === "GET") {
    let q = db.from(CT_TABLES.presets).select("*");
    const kind = params.get("kind");
    if (kind) q = q.eq("kind", kind);
    const { data, error } = await q.order("kind").order("sort_order").order("created_at").returns<CtPreset[]>();
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ presets: data ?? [] });
  }
  if (resource === "cliparts" && method === "GET" && !id) {
    const category = params.get("category");
    if (category && category !== "none" && !UUID.test(category)) return jsonError("category không hợp lệ", 400);
    return NextResponse.json({ cliparts: await listCliparts(db, category, params.get("q") ?? "") });
  }
  if (resource === "cliparts" && method === "GET" && id) {
    if (!UUID.test(id)) return jsonError("id không hợp lệ", 400);
    const { data } = await db.from(CT_TABLES.assets).select("*").eq("id", id).maybeSingle<CtAsset>();
    return data ? NextResponse.json({ clipart: data }) : jsonError("Không tìm thấy", 404);
  }
  if (resource === "products" && method === "GET") {
    const { data: products } = await db
      .from(CT_TABLES.products)
      .select("id,name")
      .neq("status", "archived")
      .order("updated_at", { ascending: false })
      .limit(100)
      .returns<Array<Pick<CtProduct, "id" | "name">>>();
    const ids = (products ?? []).map((p) => p.id);
    const { data: composites } = ids.length
      ? await db
          .from(CT_TABLES.assets)
          .select("id,product_id,name,url,width,height")
          .in("product_id", ids)
          .eq("role", "composite")
          .order("created_at", { ascending: false })
          .returns<Array<Pick<CtAsset, "id" | "product_id" | "name" | "url" | "width" | "height">>>()
      : { data: [] };
    return NextResponse.json({
      products: (products ?? []).map((p) => ({ ...p, composites: (composites ?? []).filter((c) => c.product_id === p.id) })),
    });
  }
  if (resource === "cliparts" && method === "POST" && !id) return saveClipart(db, await req.formData());
  if (resource === "mockups" && method === "POST") return saveMockup(db, await req.formData());
  return jsonError("Not found", 404);
}
