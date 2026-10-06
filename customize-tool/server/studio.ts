/**
 * ComfyUI studio (services/comfy) ↔ FlexiPrint.
 *
 * 1. Gate. ComfyUI has no auth of its own. nginx serves it under /comfy/
 *    on the app's domain (deploy/nginx/flexiprint-comfy.locations) behind
 *    `auth_request` → GET studio/auth, which accepts the `fp_studio` cookie:
 *    HMAC(userId, expiry) with CT_STUDIO_SECRET, set by POST studio/session
 *    for a signed-in user (the /studio page calls it before loading the
 *    iframe). CT_STUDIO_URL (default "/comfy/") is what the iframe loads;
 *    CT_STUDIO_COOKIE_DOMAIN only matters if the studio ever moves to a
 *    subdomain.
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
 *    POST internal/mockups                     multipart: file, product_id, name?, prompt?, model?, parent_id?, material? → { asset }
 *                                              parent_id = an artwork (composite) of the product: saved as its AI material
 *                                              version (role rendition), which the editor's Tổ hợp draws instead
 *
 *    Everything the studio creates is logged in ct_generations (provider
 *    "comfy", the resolved prompt and the graph that ran) and owned by
 *    CT_STUDIO_USER_ID (falls back to the first superadmin).
 *
 * 3. AI dialog (signed-in user). The editor's "Tạo bằng AI" dialog doesn't
 *    draw graphs: it sends one of the four recipes (origin / variant /
 *    material / mockup; the Tổ hợp tab also artwork_material / mockup_enhance)
 *    and ComfyUI expands it into the same FP nodes
 *    (services/comfy/custom_nodes/flexiprint/recipes.py). The app reaches
 *    ComfyUI directly at CT_COMFY_URL (docker: http://comfy:8188, dev:
 *    http://127.0.0.1:8188) with CT_COMFY_TOKEN.
 *
 *    GET  studio/models        → { models }
 *    POST studio/runs          CtStudioRunBody → { run_id }
 *    GET  studio/runs/:id      → CtStudioRunStatus (assets = what it saved)
 *    POST studio/drafts        CtStudioRunBody → { draft_id }  (open it: /studio?draft=)
 *    POST studio/refs          multipart file → { name }  reference photo for an origin line
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { CT_TABLES } from "../config";
import type { CtAsset, CtAssetMeta, CtAssetRole, CtClipartCategory, CtPreset, CtProduct, CtStudioRunBody, CtStudioRunState, CtStudioRunStatus } from "../types";
import { normalizeCategoryRules } from "../lib/library";
import { readImageInfo } from "./image-size";
import type { LibraryDb } from "./ai/library-tools";
import { ctServiceClient, type CtServiceClient, type CtSession } from "./supabase";
import { ctRemove, ctStoragePath, ctUpload } from "./storage";
import { insertClipart } from "./library";
import { currentImageModel } from "./settings";

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
  const url = process.env.CT_STUDIO_URL || "/comfy/";
  if (!secret) return jsonError("Studio chưa cấu hình (CT_STUDIO_SECRET)", 501);
  const res = NextResponse.json({ url });
  res.cookies.set(COOKIE, makeToken(s.user.id, secret), {
    httpOnly: true,
    secure: url.startsWith("https://") || (url.startsWith("/") && process.env.NODE_ENV === "production"),
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
export async function ownerId(db: CtServiceClient): Promise<string | null> {
  if (process.env.CT_STUDIO_USER_ID) return process.env.CT_STUDIO_USER_ID;
  if (studioOwner) return studioOwner;
  const { data } = await db.auth.admin.listUsers({ perPage: 200 });
  studioOwner = data?.users.find((u) => u.app_metadata?.role === "admin")?.id ?? null;
  return studioOwner;
}

export function internalAuthorized(req: NextRequest): boolean {
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
  // An artwork's AI material version: a rendition of that composite.
  const parentId = str(form, "parent_id");
  let role: CtAssetRole = "mockup";
  if (parentId) {
    if (!UUID.test(parentId)) return jsonError("parent_id không hợp lệ", 400);
    const { data: parent } = await db.from(CT_TABLES.assets).select("id,product_id,role").eq("id", parentId).maybeSingle<Pick<CtAsset, "id" | "product_id" | "role">>();
    if (!parent || parent.product_id !== productId || parent.role !== "composite") return jsonError("parent_id phải là artwork của sản phẩm", 400);
    role = "rendition";
  }
  const material = str(form, "material");
  const generationId = await logGeneration(db, {
    userId: product.user_id,
    productId,
    categoryId: null,
    role,
    parentId: parentId || null,
    model: str(form, "model"),
    prompt: str(form, "prompt"),
    resolvedPrompt: str(form, "resolved_prompt"),
    workflow: jsonField<object | null>(form, "workflow", null),
  });
  const path = ctStoragePath(product.user_id, productId, role, info.mime);
  const url = await ctUpload(path, data, info.mime);
  const { data: asset, error } = await db
    .from(CT_TABLES.assets)
    .insert({
      user_id: product.user_id,
      product_id: productId,
      role,
      parent_id: parentId || null,
      generation_id: generationId,
      name: str(form, "name") || "Studio mockup",
      url,
      storage_path: path,
      width: info.width,
      height: info.height,
      mime: info.mime,
      source: "ai",
      meta: role === "rendition" && UUID.test(material) ? { material } : {},
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

// ---------------------------------------------------------------------------
// AI dialog → ComfyUI recipes
// ---------------------------------------------------------------------------

const RECIPES = new Set(["origin", "refine", "adjust", "variant", "material", "mockup", "artwork_material", "mockup_enhance"]);

/** What ComfyUI's /flexi/run/:id answers. */
interface ComfyRunStatus {
  status: CtStudioRunState;
  position?: number;
  node?: string | null;
  error?: string;
  ids: string[];
}

interface ComfyError {
  error?: string;
}

async function comfy<T>(path: string, init?: RequestInit): Promise<T> {
  const token = process.env.CT_COMFY_TOKEN;
  if (!token) throw new StudioError("Studio chưa cấu hình (CT_COMFY_TOKEN)", 501);
  const base = (process.env.CT_COMFY_URL || "http://127.0.0.1:8188").replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new StudioError(`Không kết nối được ComfyUI (${base}) — studio đang chạy chưa?`, 502);
  }
  const body = (await res.json().catch(() => ({}))) as T & ComfyError;
  if (!res.ok) throw new StudioError(body.error || `ComfyUI HTTP ${res.status}`, res.status >= 500 ? 502 : res.status);
  return body;
}

class StudioError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function studioCall(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof StudioError) return jsonError(e.message, e.status);
    throw e;
  }
}

function validRunBody(body: CtStudioRunBody | null): body is CtStudioRunBody {
  return Boolean(body && RECIPES.has(body.recipe) && body.params && typeof body.params === "object");
}

/** POST studio/refs — a reference photo, stored in ComfyUI's input folder. */
export async function studioUploadRef(form: FormData): Promise<NextResponse> {
  const file = form.get("file");
  if (!(file instanceof Blob)) return jsonError("Thiếu file", 400);
  if (file.size > 20 * 1024 * 1024) return jsonError("Ảnh quá lớn (tối đa 20 MB)", 413);
  const token = process.env.CT_COMFY_TOKEN;
  if (!token) return jsonError("Studio chưa cấu hình (CT_COMFY_TOKEN)", 501);
  const base = (process.env.CT_COMFY_URL || "http://127.0.0.1:8188").replace(/\/$/, "");
  const out = new FormData();
  out.append("file", file, "ref.png");
  try {
    const res = await fetch(`${base}/flexi/refs`, { method: "POST", body: out, headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    const body = (await res.json().catch(() => ({}))) as { name?: string } & ComfyError;
    if (!res.ok || !body.name) return jsonError(body.error || `ComfyUI HTTP ${res.status}`, res.ok ? 502 : res.status);
    return NextResponse.json({ name: body.name });
  } catch {
    return jsonError(`Không kết nối được ComfyUI (${base})`, 502);
  }
}

/** GET studio/models */
export function studioModels(): Promise<NextResponse> {
  return studioCall(async () => NextResponse.json(await comfy<{ models: string[] }>("/flexi/models")));
}

/** Every AI run uses the team's image model (home page, server/settings.ts) — whatever the caller asked for. */
async function withImageModel(body: CtStudioRunBody): Promise<CtStudioRunBody> {
  if (body.recipe === "adjust") return body;
  return { ...body, params: { ...body.params, model: await currentImageModel() } } as CtStudioRunBody;
}

/** POST studio/runs */
export function studioRun(body: CtStudioRunBody | null): Promise<NextResponse> {
  if (!validRunBody(body)) return Promise.resolve(jsonError("Body không hợp lệ", 400));
  return studioCall(async () =>
    NextResponse.json(await comfy<{ run_id: string }>("/flexi/run", { method: "POST", body: JSON.stringify(await withImageModel(body)) }), { status: 202 }),
  );
}

/** POST studio/drafts */
export function studioDraft(body: CtStudioRunBody | null): Promise<NextResponse> {
  if (!validRunBody(body)) return Promise.resolve(jsonError("Body không hợp lệ", 400));
  return studioCall(async () => NextResponse.json(await comfy<{ draft_id: string }>("/flexi/draft", { method: "POST", body: JSON.stringify(await withImageModel(body)) })));
}

/** GET studio/runs/:id — the run's state plus the assets it saved (the user's own client, or the MCP's). */
export function studioRunStatus(db: LibraryDb, runId: string): Promise<NextResponse> {
  if (!UUID.test(runId)) return Promise.resolve(jsonError("id không hợp lệ", 400));
  return studioCall(async () => {
    const run = await comfy<ComfyRunStatus>(`/flexi/run/${runId}`);
    const ids = (run.ids ?? []).filter((id) => UUID.test(id));
    const { data } = ids.length ? await db.from(CT_TABLES.assets).select("*").in("id", ids).returns<CtAsset[]>() : { data: [] as CtAsset[] };
    const byId = new Map((data ?? []).map((a) => [a.id, a]));
    const out: CtStudioRunStatus = {
      status: run.status,
      position: run.position,
      node: run.node ?? null,
      error: run.error,
      assets: ids.map((id) => byId.get(id)).filter((a): a is CtAsset => a !== undefined),
    };
    return NextResponse.json(out);
  });
}
