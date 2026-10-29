/**
 * API handlers. Each takes the session + parsed request and returns a
 * Response; router.ts maps paths onto them.
 */

import { inChunks } from "./in-chunks";
import { NextResponse } from "next/server";
import { CT_CONFIG, CT_TABLES } from "../config";
import type {
  CtAiStyle,
  CtAiStyleRef,
  CtAsset,
  CtAssetMeta,
  CtAssetRole,
  CtCreateProductBody,
  CtDeployBody,
  CtDeployResponse,
  CtGeneration,
  CtProduct,
  CtProductConfig,
  CtProductBundle,
  CtProductListRow,
  CtPublicUploadResponse,
  CtPublishResponse,
  CtRegion,
  CtRegionItem,
  CtSaveDesignBody,
  CtShopifyInfo,
  CtShopifyStatus,
  CtTemplate,
  CtUpdateAssetBody,
  CtUpdateProductBody,
} from "../types";
import { normalizeProductConfig, normalizeRegion, normalizeSamples } from "../lib/design";
import { ctServiceClient, type CtServiceClient, type CtSession } from "./supabase";
import { ctLibraryPath, ctPublicUploadPath, ctRemove, ctStoragePath, ctUpload } from "./storage";
import { buildTemplate } from "../lib/template";
import { readImageInfo } from "./image-size";
import { listProviders } from "./ai/providers";
import { PhotoConfigError, cachedAiResult, photoCapabilities, processPhoto, type PhotoResult } from "./ai/photo";
import { sweepPhotoCache } from "./photo-cache";
import { isAiStyleRef, isPhotoStyleRef } from "../lib/photo-styles";
import { isAdmin, loadAiStyle, originAllowed, publicAiStyles, takeAiQuota } from "./ai-styles";
import { aiStylesConfigured } from "./ai/style-run";
import { printPack, readPrintPackForm } from "./material";
import { deleteClipart, loadProductAssets } from "./library";
import { renameProductFolder } from "./artworks";
import { loadPriceTable } from "./price-tables";
import { createCollection, deployToShopify, listCollections, searchShopifyProducts, shopifyConfigured, shopifyInfo } from "./shopify";
import { priceTableProblems } from "../lib/pricing";

const ROLES: CtAssetRole[] = ["main", "sub", "variant", "rendition", "composite", "mockup", "reference"];

export function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export async function ownedProduct(s: CtSession, productId: string): Promise<CtProduct | null> {
  const { data } = await s.supabase.from(CT_TABLES.products).select("*").eq("id", productId).maybeSingle<CtProduct>();
  // Admins have full rights on every product (RLS ct_*_admin_all, migration 026).
  if (!data || (data.user_id !== s.user.id && !(await isAdmin(s)))) return null;
  return data;
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export async function listProducts(s: CtSession, search: string): Promise<NextResponse> {
  let q = s.supabase
    .from(CT_TABLES.products)
    .select("*, main_asset:ct_assets!ct_products_main_asset_fk(url,width,height)")
    // Newest made first — not the last one edited (asked 2026-10-29: opening a product must not move it up).
    .order("created_at", { ascending: false })
    .limit(200);
  if (search) q = q.ilike("name", `%${search}%`);
  const { data, error } = await q.returns<Omit<CtProductListRow, "mockup_url">[]>();
  if (error) return jsonError(error.message, 500);
  // The card shows the product as it is sold: its first mockup (oldest = the straight-on one).
  const ids = (data ?? []).map((p) => p.id);
  const { data: mockups } = ids.length
    ? await s.supabase.from(CT_TABLES.assets).select("product_id, url").in("product_id", ids).eq("role", "mockup").order("created_at").returns<Array<{ product_id: string; url: string }>>()
    : { data: [] };
  const first = new Map<string, string>();
  for (const m of mockups ?? []) if (!first.has(m.product_id)) first.set(m.product_id, m.url);
  const products: CtProductListRow[] = (data ?? []).map((p) => ({ ...p, mockup_url: first.get(p.id) ?? null }));
  return NextResponse.json({ products });
}

export async function createProduct(s: CtSession, body: CtCreateProductBody): Promise<NextResponse> {
  const name = (body.name ?? "").trim();
  if (!name) return jsonError("Thiếu tên sản phẩm", 400);
  const { data, error } = await s.supabase
    .from(CT_TABLES.products)
    .insert({ user_id: s.user.id, name })
    .select("*")
    .single<CtProduct>();
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ product: data }, { status: 201 });
}

export async function getBundle(s: CtSession, productId: string): Promise<NextResponse> {
  const { data: product } = await s.supabase.from(CT_TABLES.products).select("*").eq("id", productId).maybeSingle<CtProduct>();
  if (!product) return jsonError("Không tìm thấy sản phẩm", 404);

  const [regions, generations] = await Promise.all([
    s.supabase.from(CT_TABLES.regions).select("*").eq("product_id", productId).order("sort_order").returns<CtRegion[]>(),
    s.supabase
      .from(CT_TABLES.generations)
      .select("*")
      .eq("product_id", productId)
      .order("created_at", { ascending: false })
      .limit(50)
      .returns<CtGeneration[]>(),
  ]);
  const regionIds = (regions.data ?? []).map((r) => r.id);
  const items = { data: (await inChunks(regionIds, (ids) => s.supabase.from(CT_TABLES.items).select("*").in("region_id", ids).returns<CtRegionItem[]>())).sort((a, b) => a.sort_order - b.sort_order) };

  // The product's own assets + the library cliparts its zones / main versions use.
  const assets = await loadProductAssets(s.supabase, product, items.data ?? [], regions.data ?? []);

  const bundle: CtProductBundle = {
    product,
    assets,
    regions: regions.data ?? [],
    items: items.data ?? [],
    generations: generations.data ?? [],
  };
  return NextResponse.json(bundle);
}

export async function updateProduct(s: CtSession, productId: string, body: CtUpdateProductBody): Promise<NextResponse> {
  const product = await ownedProduct(s, productId);
  if (!product) return jsonError("Không có quyền sửa sản phẩm này", 403);
  const patch: Omit<CtUpdateProductBody, "samples"> & { config?: CtProductConfig } = {};
  // Design samples: only that part of the stored config changes.
  if (body.samples !== undefined) patch.config = { ...normalizeProductConfig(product.config), samples: normalizeSamples(body.samples) };
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (body.status === "draft" || body.status === "ready" || body.status === "archived") patch.status = body.status;
  if (body.main_asset_id !== undefined) patch.main_asset_id = body.main_asset_id;
  if (body.thumbnail_url !== undefined) patch.thumbnail_url = body.thumbnail_url;
  if (typeof body.notes === "string") patch.notes = body.notes;
  const { data, error } = await s.supabase.from(CT_TABLES.products).update(patch).eq("id", productId).select("*").single<CtProduct>();
  if (error) return jsonError(error.message, 500);
  // Its folder in the library (artworks, a v2 set's cliparts) carries its name.
  if (patch.name && patch.name !== product.name) await renameProductFolder(s.supabase, productId, patch.name);
  return NextResponse.json({ product: data });
}

export async function deleteProduct(s: CtSession, productId: string): Promise<NextResponse> {
  if (!(await ownedProduct(s, productId))) return jsonError("Không có quyền xoá sản phẩm này", 403);
  const { data: assets } = await s.supabase.from(CT_TABLES.assets).select("storage_path").eq("product_id", productId);
  await ctRemove((assets ?? []).map((a: { storage_path: string }) => a.storage_path));
  const { error } = await s.supabase.from(CT_TABLES.products).delete().eq("id", productId);
  if (error) return jsonError(error.message, 500);
  return new NextResponse(null, { status: 204 });
}

export async function saveDesign(s: CtSession, productId: string, body: CtSaveDesignBody): Promise<NextResponse> {
  if (!(await ownedProduct(s, productId))) return jsonError("Không có quyền sửa sản phẩm này", 403);
  const regions = Array.isArray(body.regions) ? body.regions : [];
  const regionIds = new Set(regions.map((r) => r.id));
  const items = (Array.isArray(body.items) ? body.items : []).filter((i) => regionIds.has(i.region_id));
  const { error } = await s.supabase.rpc("ct_save_design", {
    p_product_id: productId,
    p_regions: regions.map((r, i) => ({ ...r, sort_order: i })),
    p_items: items,
  });
  if (error) return jsonError(error.message, 500);
  if (body.config) {
    const { error: cfgErr } = await s.supabase
      .from(CT_TABLES.products)
      .update({ config: normalizeProductConfig(body.config) })
      .eq("id", productId);
    if (cfgErr) return jsonError(missingMigration(cfgErr.message) ?? cfgErr.message, 500);
  }
  return NextResponse.json({ ok: true });
}

/** Friendlier error when migrations/002 has not been run yet. */
function missingMigration(message: string): string | null {
  return /config|published_|ct_templates/.test(message) && /does not exist|schema cache|Could not find/i.test(message)
    ? `Thiếu migration: chạy customize-tool/migrations/002_customize_tool_publish.sql trên Supabase (${message})`
    : null;
}

// ---------------------------------------------------------------------------
// Publish (Shopify storefront template)
// ---------------------------------------------------------------------------

export async function publish(s: CtSession, productId: string, origin: string): Promise<NextResponse> {
  const product = await ownedProduct(s, productId);
  if (!product) return jsonError("Không có quyền publish sản phẩm này", 403);
  const r = await publishTemplate(s, product, origin);
  if ("error" in r) return jsonError(r.error, r.status);
  return NextResponse.json(r);
}

/** The storefront template of the saved design as the next version would carry it (publish, and the MCP check_deploy). */
export async function productTemplate(
  s: CtSession,
  product: CtProduct,
): Promise<{ template: CtTemplate; version: number; publishedAt: string } | { error: string; status: number }> {
  const productId = product.id;
  const [regions, last] = await Promise.all([
    s.supabase.from(CT_TABLES.regions).select("*").eq("product_id", productId).returns<CtRegion[]>(),
    s.supabase
      .from(CT_TABLES.templates)
      .select("version")
      .eq("product_id", productId)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle<{ version: number }>(),
  ]);
  if (last.error) return { error: missingMigration(last.error.message) ?? last.error.message, status: 500 };
  const regionIds = (regions.data ?? []).map((r) => r.id);
  const items = { data: await inChunks(regionIds, (ids) => s.supabase.from(CT_TABLES.items).select("*").in("region_id", ids).returns<CtRegionItem[]>()) };
  const assets = await loadProductAssets(s.supabase, product, items.data ?? [], regions.data ?? []);

  const version = (last.data?.version ?? 0) + 1;
  const publishedAt = new Date().toISOString();
  // AI styles the zones offer: the template carries their names only.
  const aiRefs = (regions.data ?? [])
    .map(normalizeRegion)
    .filter((r) => r.kind === "photo")
    .flatMap((r) => r.config.photo.styles.filter(isAiStyleRef));
  const aiStyles = await publicAiStyles(s.supabase, aiRefs);
  let template: CtTemplate;
  try {
    template = buildTemplate({
      product,
      assets,
      regions: regions.data ?? [],
      items: items.data ?? [],
      version,
      publishedAt,
      aiStyles,
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Không dựng được template", status: 400 };
  }
  return { template, version, publishedAt };
}

/** Snapshot the saved design into the next ct_templates version (what the storefront loads). */
async function publishTemplate(
  s: CtSession,
  product: CtProduct,
  origin: string,
): Promise<{ product: CtProduct; publish: CtPublishResponse } | { error: string; status: number }> {
  const productId = product.id;
  const built = await productTemplate(s, product);
  if ("error" in built) return built;
  const { template, version, publishedAt } = built;

  const { error } = await s.supabase
    .from(CT_TABLES.templates)
    .insert({ product_id: productId, version, template, published_by: s.user.id, published_at: publishedAt });
  if (error) return { error: missingMigration(error.message) ?? error.message, status: 500 };

  const { data: updated, error: upErr } = await s.supabase
    .from(CT_TABLES.products)
    .update({ status: "ready", published_version: version, published_at: publishedAt })
    .eq("id", productId)
    .select("*")
    .single<CtProduct>();
  if (upErr) return { error: upErr.message, status: 500 };

  return {
    product: updated,
    publish: { version, publishedAt, templateUrl: `${origin}${CT_CONFIG.apiBase}/public/templates/${productId}` },
  };
}

// ---------------------------------------------------------------------------
// Deploy sản phẩm: template + Shopify product with the price table's variants (server/shopify.ts)
// ---------------------------------------------------------------------------

const SHOPIFY_STATUSES: CtShopifyStatus[] = ["ACTIVE", "DRAFT", "ARCHIVED"];

export function readDeployBody(raw: unknown): CtDeployBody | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Partial<CtDeployBody>;
  const title = typeof b.title === "string" ? b.title.trim().slice(0, 255) : "";
  if (!title || typeof b.priceTableId !== "string" || !b.priceTableId) return null;
  const strings = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()).slice(0, max) : []);
  return {
    priceTableId: b.priceTableId,
    title,
    descriptionHtml: typeof b.descriptionHtml === "string" ? b.descriptionHtml.slice(0, 60000) : "",
    status: SHOPIFY_STATUSES.includes(b.status as CtShopifyStatus) ? (b.status as CtShopifyStatus) : "ACTIVE",
    vendor: typeof b.vendor === "string" ? b.vendor.trim().slice(0, 255) : "",
    productType: typeof b.productType === "string" ? b.productType.trim().slice(0, 255) : "",
    tags: strings(b.tags, 60),
    mediaAssetIds: strings(b.mediaAssetIds, 30),
    collectionIds: strings(b.collectionIds, 50).filter((id) => /^gid:\/\/shopify\/Collection\/\d+$/.test(id)),
    primaryCollectionId: typeof b.primaryCollectionId === "string" && /^gid:\/\/shopify\/Collection\/\d+$/.test(b.primaryCollectionId) ? b.primaryCollectionId : null,
    shopifyProductId: typeof b.shopifyProductId === "string" && /^gid:\/\/shopify\/Product\/\d+$/.test(b.shopifyProductId) ? b.shopifyProductId : null,
  };
}

/** Absolute URL Shopify can download (asset urls may be site-relative /files/…). */
function absoluteUrl(url: string, origin: string): string {
  if (/^https?:\/\//.test(url)) return url;
  const base = (process.env.APP_URL || origin).replace(/\/$/, "");
  return `${base}${url.startsWith("/") ? "" : "/"}${url}`;
}

export async function deploy(s: CtSession, productId: string, raw: unknown, origin: string): Promise<NextResponse> {
  const product = await ownedProduct(s, productId);
  if (!product) return jsonError("Không có quyền deploy sản phẩm này", 403);
  const body = readDeployBody(raw);
  if (!body) return jsonError("Thiếu tên sản phẩm hoặc bảng giá", 400);
  const r = await runDeploy(s, product, body, origin);
  return "error" in r ? jsonError(r.error, r.status) : NextResponse.json(r);
}

/** Deploy a product the caller may edit: the template, then the Shopify product (the page's route and the MCP deploy_product). */
export async function runDeploy(s: CtSession, product: CtProduct, body: CtDeployBody, origin: string): Promise<CtDeployResponse | { error: string; status: number }> {
  const productId = product.id;
  if (!shopifyConfigured()) return { error: "Chưa cấu hình Shopify (SHOPIFY_STORE_DOMAIN / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET)", status: 501 };
  const table = await loadPriceTable(s, body.priceTableId);
  if (!table) return { error: "Không tìm thấy bảng giá", status: 404 };
  const problems = priceTableProblems(table.config);
  if (problems.length) return { error: `Bảng giá “${table.name}”: ${problems.join(" ")}`, status: 400 };

  let media: Array<{ asset: CtAsset; url: string }> = [];
  if (body.mediaAssetIds.length) {
    const { data } = await s.supabase.from(CT_TABLES.assets).select("*").eq("product_id", productId).in("id", body.mediaAssetIds).returns<CtAsset[]>();
    const byId = new Map((data ?? []).map((a) => [a.id, a]));
    media = body.mediaAssetIds.map((id) => byId.get(id)).filter((a): a is CtAsset => Boolean(a)).map((asset) => ({ asset, url: absoluteUrl(asset.url, origin) }));
  }

  // 1. The storefront template (what the customizer draws).
  const pub = await publishTemplate(s, product, origin);
  if ("error" in pub) return pub;

  // 2. The Shopify product: options + priced variants + metafields + images.
  let result: Awaited<ReturnType<typeof deployToShopify>>;
  try {
    result = await deployToShopify({
      ctProductId: productId,
      link: product.shopify ?? null,
      targetId: body.shopifyProductId ?? null,
      title: body.title,
      descriptionHtml: body.descriptionHtml,
      status: body.status,
      vendor: body.vendor,
      productType: body.productType,
      tags: body.tags,
      collectionIds: body.collectionIds,
      primaryCollectionId: body.primaryCollectionId && body.collectionIds.includes(body.primaryCollectionId) ? body.primaryCollectionId : null,
      priceTableId: table.id,
      pricing: table.config,
      media,
      templateVersion: pub.publish.version,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Deploy Shopify thất bại";
    return { error: `Đã publish template v${pub.publish.version}, nhưng Shopify lỗi: ${msg}`, status: 502 };
  }

  const { data: updated, error } = await s.supabase.from(CT_TABLES.products).update({ shopify: result.link }).eq("id", productId).select("*").single<CtProduct>();
  if (error) return { error: missingShopifyColumn(error.message), status: 500 };
  return { product: updated, publish: pub.publish, shopify: result.link, previewUrl: result.previewUrl, warnings: result.warnings };
}

function missingShopifyColumn(message: string): string {
  return /shopify/.test(message) && /does not exist|schema cache|Could not find/i.test(message)
    ? `Thiếu migration: chạy supabase/migrations/018_price_tables_deploy.sql (${message})`
    : message;
}

/** Shop + the linked Shopify product as it is now. */
export async function shopifyStatus(s: CtSession, productId: string): Promise<NextResponse> {
  const product = await ownedProduct(s, productId);
  if (!product) return jsonError("Không có quyền xem sản phẩm này", 403);
  try {
    return NextResponse.json(await shopifyInfo(product.shopify?.productId ?? null));
  } catch (e) {
    const info: CtShopifyInfo = { configured: shopifyConfigured(), shop: null, product: null, error: e instanceof Error ? e.message : String(e) };
    return NextResponse.json(info);
  }
}

export async function shopifyCollections(): Promise<NextResponse> {
  try {
    return NextResponse.json({ collections: await listCollections() });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : String(e), 502);
  }
}

export async function shopifyCreateCollection(raw: unknown): Promise<NextResponse> {
  const title = raw && typeof raw === "object" && typeof (raw as { title?: unknown }).title === "string" ? (raw as { title: string }).title.trim().slice(0, 255) : "";
  if (!title) return jsonError("Thiếu tên collection", 400);
  try {
    return NextResponse.json({ collection: await createCollection(title) }, { status: 201 });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : String(e), 502);
  }
}

export async function shopifySearch(q: string): Promise<NextResponse> {
  try {
    return NextResponse.json({ products: await searchShopifyProducts(q) });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : String(e), 502);
  }
}

// ---------------------------------------------------------------------------
// Public storefront endpoints (no session; CORS open)
// ---------------------------------------------------------------------------

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  "Access-Control-Expose-Headers": "X-Ct-Backdrop",
};

function publicJson(body: object, status = 200, extra: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...CORS_HEADERS, ...extra } });
}

function publicError(message: string, status: number): NextResponse {
  return publicJson({ error: message }, status);
}

export function publicPreflight(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/** Latest (or `?version=N`) published template. */
export async function publicTemplate(productId: string, version: number | null): Promise<NextResponse> {
  const db = ctServiceClient();
  if (!db) return publicError("SUPABASE_SERVICE_ROLE_KEY chưa được cấu hình", 501);
  let q = db.from(CT_TABLES.templates).select("template").eq("product_id", productId);
  q = version ? q.eq("version", version) : q.order("version", { ascending: false }).limit(1);
  const { data, error } = await q.maybeSingle<{ template: CtTemplate }>();
  if (error) return publicError(error.message, 500);
  if (!data) return publicError("Template chưa được publish", 404);
  // Short shared cache: a new Publish reaches the storefront within ~a minute,
  // a pinned version never changes.
  const cache = version ? "public, max-age=31536000, immutable" : "public, max-age=30, s-maxage=30, stale-while-revalidate=300";
  return publicJson(data.template, 200, { "Cache-Control": cache });
}

/** Customer photo / cart preview upload from the storefront. */
export async function publicUpload(productId: string, form: FormData): Promise<NextResponse> {
  const db = ctServiceClient();
  if (!db) return publicError("SUPABASE_SERVICE_ROLE_KEY chưa được cấu hình", 501);
  // Only products that are actually live accept uploads.
  const { data: live } = await db.from(CT_TABLES.templates).select("version").eq("product_id", productId).limit(1).maybeSingle();
  if (!live) return publicError("Sản phẩm chưa publish", 404);

  const file = form.get("file");
  if (!(file instanceof Blob)) return publicError("Thiếu file", 400);
  if (file.size > CT_CONFIG.publicUploadBytes) return publicError(`File quá lớn (tối đa ${Math.round(CT_CONFIG.publicUploadBytes / 1048576)}MB)`, 413);
  // preview: the cart's flattened picture · print: the full-size print file (khuôn in products) · photo: a customer photo.
  const k = form.get("kind");
  const kind = k === "preview" || k === "print" ? k : "photo";
  const data = Buffer.from(await file.arrayBuffer());
  const info = readImageInfo(data);
  if (!info) return publicError("File không phải ảnh PNG/JPEG/WebP hợp lệ", 400);
  try {
    const url = await ctUpload(ctPublicUploadPath(productId, kind, info.mime), data, info.mime);
    const body: CtPublicUploadResponse = { url };
    return publicJson(body, 201);
  } catch (e) {
    return publicError(e instanceof Error ? e.message : "Upload thất bại", 500);
  }
}

// ---------------------------------------------------------------------------
// Customer photo: AI style + subject cut-out
// ---------------------------------------------------------------------------

/** Input cap for photo processing — the browser shrinks to ~1600px first. */
const PHOTO_PROCESS_BYTES = 8 * 1024 * 1024;

/**
 * Naive per-instance limiter for the public endpoint: every call can cost an
 * AI request. Serverless instances each keep their own window, so this only
 * blunts bursts; put a real limiter (edge / Upstash) in front for heavy traffic.
 */
const photoHits = new Map<string, number[]>();
const PHOTO_LIMIT = { windowMs: 10 * 60 * 1000, max: 30 };

function photoRateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (photoHits.get(ip) ?? []).filter((t) => now - t < PHOTO_LIMIT.windowMs);
  if (hits.length >= PHOTO_LIMIT.max) {
    photoHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  photoHits.set(ip, hits);
  if (photoHits.size > 5000) photoHits.clear();
  return false;
}

interface PhotoRequest {
  data: Buffer;
  mime: string;
  style: string;
  cutout: boolean;
  regionId: string;
}

async function readPhotoRequest(form: FormData): Promise<PhotoRequest | string> {
  const file = form.get("file");
  if (!(file instanceof Blob)) return "Thiếu file";
  if (file.size > PHOTO_PROCESS_BYTES) return "Ảnh quá lớn (tối đa 8MB)";
  const data = Buffer.from(await file.arrayBuffer());
  const info = readImageInfo(data);
  if (!info) return "File không phải ảnh PNG/JPEG/WebP hợp lệ";
  return {
    data,
    mime: info.mime,
    style: String(form.get("style") ?? "original"),
    cutout: form.get("cutout") === "1",
    regionId: String(form.get("region") ?? ""),
  };
}

/** The image goes back as raw bytes; X-Ct-Backdrop says what is left to key out. */
function imageResponse(out: PhotoResult, headers: Record<string, string>): NextResponse {
  return new NextResponse(new Uint8Array(out.image.data), {
    status: 200,
    headers: { ...headers, "Content-Type": out.image.mime, "Cache-Control": "no-store", ...(out.backdrop ? { "X-Ct-Backdrop": out.backdrop } : {}) },
  });
}

/** Run the job (cached results come back without re-running, see server/photo-cache.ts). */
async function photoResponse(req: PhotoRequest, headers: Record<string, string>, aiStyle?: CtAiStyle): Promise<NextResponse> {
  if (!isPhotoStyleRef(req.style)) return NextResponse.json({ error: "Style không hợp lệ" }, { status: 400, headers });
  try {
    return imageResponse(await processPhoto({ image: { data: req.data, mime: req.mime }, style: req.style, cutout: req.cutout, aiStyle }), headers);
  } catch (e) {
    const status = e instanceof PhotoConfigError ? 501 : 502;
    return NextResponse.json({ error: e instanceof Error ? e.message : "Xử lý ảnh thất bại" }, { status, headers });
  }
}

/**
 * Storefront: only styles the published zone actually offers. For an AI style
 * the request carries nothing but the photo and the ref — prompt, model and
 * params come from ct_ai_styles (see server/ai-styles.ts for the abuse guards).
 */
export async function publicPhoto(productId: string, form: FormData, ip: string, origin: string | null): Promise<NextResponse> {
  const db = ctServiceClient();
  if (!db) return publicError("SUPABASE_SERVICE_ROLE_KEY chưa được cấu hình", 501);
  if (!originAllowed(origin)) return publicError("Origin not allowed", 403);
  if (photoRateLimited(ip)) return publicError("Too many requests — please wait a few minutes.", 429);
  const parsed = await readPhotoRequest(form);
  if (typeof parsed === "string") return publicError(parsed, 400);

  const { data } = await db
    .from(CT_TABLES.templates)
    .select("template")
    .eq("product_id", productId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle<{ template: CtTemplate }>();
  if (!data) return publicError("Sản phẩm chưa publish", 404);
  const region = data.template.regions.find((r) => r.id === parsed.regionId);
  if (!region || region.kind !== "photo") return publicError("Vùng ảnh không tồn tại", 400);
  const cfg = normalizeRegion(region).config.photo;
  const style = parsed.style;
  if (!isPhotoStyleRef(style) || !cfg.styles.includes(style)) return publicError("Style không được bật cho vùng này", 400);
  if (parsed.cutout && !cfg.cutout) return publicError("Vùng này không bật tách nền", 400);
  if (!isAiStyleRef(style)) return photoResponse(parsed, CORS_HEADERS);

  if (!aiStylesConfigured()) return publicError("AI styles are not configured (CPA_API_KEY)", 501);
  const aiStyle = await loadAiStyle(db, style);
  if (!aiStyle) return publicError("This style is no longer available", 410);
  const job = { image: { data: parsed.data, mime: parsed.mime }, style: style as CtAiStyleRef, cutout: parsed.cutout, aiStyle };
  // Same photo + same style version = already paid for: served from the cache, not counted.
  const hit = await cachedAiResult(job);
  if (hit) return imageResponse(hit, CORS_HEADERS);
  const quota = await takeAiQuota(ip);
  if (quota === "ip") return publicError("Daily limit reached for AI styles — please try again tomorrow.", 429);
  if (quota === "total") return publicError("AI styles are busy right now — please try again later.", 429);
  if (quota === "unavailable") return publicError("AI styles unavailable (spend cap not configured — run migration 003)", 503);
  return photoResponse(parsed, CORS_HEADERS, aiStyle);
}

/** Editor "try a customer photo" — any style (the library is global), owner of the product or an admin. */
export async function editorPhoto(s: CtSession, productId: string, form: FormData): Promise<NextResponse> {
  if (!(await ownedProduct(s, productId))) return jsonError("Không có quyền sửa sản phẩm này", 403);
  const parsed = await readPhotoRequest(form);
  if (typeof parsed === "string") return jsonError(parsed, 400);
  const style = parsed.style;
  if (!isAiStyleRef(style)) return photoResponse(parsed, {});
  const aiStyle = await loadAiStyle(s.supabase, style);
  if (!aiStyle) return jsonError("Style AI không tồn tại (hoặc chưa chạy migration 003)", 404);
  return photoResponse(parsed, {}, aiStyle);
}

/** Editor "Xuất file in": print files + cut path for the product's material (owner or admin). */
export async function editorPrintPack(s: CtSession, productId: string, form: FormData): Promise<NextResponse> {
  if (!(await ownedProduct(s, productId))) return jsonError("Không có quyền sửa sản phẩm này", 403);
  const parsed = readPrintPackForm(form);
  if (typeof parsed === "string") return jsonError(parsed, 400);
  return printPack(parsed);
}

/**
 * POST cron/cleanup — delete cached photo results older than CT_CACHE_TTL_HOURS.
 * Called hourly by scripts/cleanup-cache.sh with `Authorization: Bearer $CT_CRON_SECRET`.
 * Customer uploads for orders (customize-tool-orders/…) are never touched.
 */
export async function cronCleanup(authorization: string | null): Promise<NextResponse> {
  const secret = process.env.CT_CRON_SECRET;
  if (!secret) return jsonError("CT_CRON_SECRET chưa được cấu hình", 503);
  if (authorization !== `Bearer ${secret}`) return jsonError("Unauthorized", 401);
  try {
    return NextResponse.json(await sweepPhotoCache());
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Cleanup thất bại", 500);
  }
}

export function photoCapabilitiesResponse(): NextResponse {
  return NextResponse.json(photoCapabilities());
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export interface InsertAssetArgs {
  productId: string;
  role: CtAssetRole;
  parentId: string | null;
  generationId: string | null;
  name: string;
  data: Buffer;
  meta: CtAssetMeta;
}

export async function insertAsset(s: CtSession, a: InsertAssetArgs): Promise<CtAsset> {
  return insertAssetAs(s.supabase, s.user.id, a);
}

/** insertAsset for a caller without a session (the @flexiprint MCP writes with the service key for `userId`). */
export async function insertAssetAs(db: CtSession["supabase"] | CtServiceClient, userId: string, a: InsertAssetArgs): Promise<CtAsset> {
  const info = readImageInfo(a.data);
  if (!info) throw new Error("File không phải ảnh PNG/JPEG/WebP hợp lệ");
  const path = ctStoragePath(userId, a.productId, a.role, info.mime);
  const url = await ctUpload(path, a.data, info.mime);

  // New items go to the end of their list.
  let countQuery = db
    .from(CT_TABLES.assets)
    .select("id", { count: "exact", head: true })
    .eq("product_id", a.productId)
    .eq("role", a.role);
  if (a.parentId) countQuery = countQuery.eq("parent_id", a.parentId);
  const { count } = await countQuery;

  const { data, error } = await db
    .from(CT_TABLES.assets)
    .insert({
      user_id: userId,
      product_id: a.productId,
      role: a.role,
      parent_id: a.role === "variant" ? a.parentId : null,
      generation_id: a.generationId,
      name: a.name,
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
    throw new Error(error.message);
  }
  return data;
}

export async function uploadAsset(s: CtSession, productId: string, form: FormData): Promise<NextResponse> {
  const product = await ownedProduct(s, productId);
  if (!product) return jsonError("Không có quyền sửa sản phẩm này", 403);

  const file = form.get("file");
  if (!(file instanceof Blob)) return jsonError("Thiếu file", 400);
  if (file.size > CT_CONFIG.maxUploadBytes) return jsonError("File quá lớn", 413);
  const role = String(form.get("role") ?? "") as CtAssetRole;
  if (!ROLES.includes(role)) return jsonError("role không hợp lệ", 400);
  const parentId = (form.get("parent_id") as string | null) || null;
  if (role === "variant" && !parentId) return jsonError("Variant cần parent_id (sub object)", 400);
  const name = String(form.get("name") ?? (file instanceof File ? file.name : "")).replace(/\.[a-z0-9]+$/i, "");
  let meta: CtAssetMeta = {};
  const rawMeta = form.get("meta");
  if (typeof rawMeta === "string" && rawMeta) {
    try {
      meta = JSON.parse(rawMeta) as CtAssetMeta;
    } catch {
      return jsonError("meta không phải JSON", 400);
    }
  }

  try {
    const asset = await insertAsset(s, {
      productId,
      role,
      parentId,
      generationId: null,
      name,
      data: Buffer.from(await file.arrayBuffer()),
      meta,
    });
    // First main asset becomes the product's main automatically.
    if (role === "main" && !product.main_asset_id) {
      await s.supabase.from(CT_TABLES.products).update({ main_asset_id: asset.id }).eq("id", productId);
    }
    return NextResponse.json({ asset }, { status: 201 });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Upload thất bại", 500);
  }
}

export async function updateAsset(s: CtSession, assetId: string, body: CtUpdateAssetBody): Promise<NextResponse> {
  const { data: cur } = await s.supabase.from(CT_TABLES.assets).select("*").eq("id", assetId).maybeSingle<CtAsset>();
  // Admins edit anyone's asset.
  if (!cur || (cur.user_id !== s.user.id && !(await isAdmin(s)))) return jsonError("Không có quyền sửa asset này", 403);
  const patch: CtUpdateAssetBody = {};
  if (typeof body.name === "string") patch.name = body.name;
  if (typeof body.sort_order === "number") patch.sort_order = body.sort_order;
  if (body.meta) patch.meta = { ...cur.meta, ...body.meta };
  if (body.parent_id !== undefined && body.parent_id !== cur.parent_id) {
    // Moving an option between groups: variants only, onto a sub of the same product (or both in the library).
    if (cur.role !== "variant" || !body.parent_id) return jsonError("Chỉ version mới đổi được nhóm", 400);
    const { data: parent } = await s.supabase.from(CT_TABLES.assets).select("id, role, product_id").eq("id", body.parent_id).maybeSingle<Pick<CtAsset, "id" | "role" | "product_id">>();
    if (!parent || parent.role !== "sub" || parent.product_id !== cur.product_id) return jsonError("Nhóm đích không hợp lệ", 400);
    patch.parent_id = body.parent_id;
  }
  const { data, error } = await s.supabase.from(CT_TABLES.assets).update(patch).eq("id", assetId).select("*").maybeSingle<CtAsset>();
  if (error) return jsonError(error.message, 500);
  if (!data) return jsonError("Không có quyền sửa asset này", 403);
  return NextResponse.json({ asset: data });
}

/**
 * Swap an asset's image in place (e.g. after background removal) so every
 * foreign key pointing at it — region items, variants, main_asset_id — stays valid.
 */
export async function replaceAssetFile(s: CtSession, assetId: string, form: FormData): Promise<NextResponse> {
  const { data: asset } = await s.supabase.from(CT_TABLES.assets).select("*").eq("id", assetId).maybeSingle<CtAsset>();
  if (!asset) return jsonError("Không tìm thấy asset", 404);
  if (asset.user_id !== s.user.id && !(await isAdmin(s))) return jsonError("Không có quyền sửa asset này", 403);
  const file = form.get("file");
  if (!(file instanceof Blob)) return jsonError("Thiếu file", 400);
  if (file.size > CT_CONFIG.maxUploadBytes) return jsonError("File quá lớn", 413);
  const data = Buffer.from(await file.arrayBuffer());
  const info = readImageInfo(data);
  if (!info) return jsonError("File không phải ảnh PNG/JPEG/WebP hợp lệ", 400);
  try {
    const path = asset.product_id
      ? ctStoragePath(s.user.id, asset.product_id, asset.role, info.mime)
      : ctLibraryPath(s.user.id, asset.category_id, asset.role, info.mime);
    const url = await ctUpload(path, data, info.mime);
    const { data: updated, error } = await s.supabase
      .from(CT_TABLES.assets)
      .update({ url, storage_path: path, width: info.width, height: info.height, mime: info.mime })
      .eq("id", assetId)
      .select("*")
      .single<CtAsset>();
    if (error) {
      await ctRemove([path]);
      return jsonError(error.message, 500);
    }
    await ctRemove([asset.storage_path]);
    return NextResponse.json({ asset: updated });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Upload thất bại", 500);
  }
}

export async function deleteAsset(s: CtSession, assetId: string): Promise<NextResponse> {
  const { data: asset } = await s.supabase.from(CT_TABLES.assets).select("*").eq("id", assetId).maybeSingle<CtAsset>();
  if (!asset) return jsonError("Không tìm thấy asset", 404);
  // Library cliparts: refused while a product still uses them.
  if (asset.product_id === null) return deleteClipart(s, assetId);
  if (asset.user_id !== s.user.id && !(await isAdmin(s))) return jsonError("Không có quyền xoá asset này", 403);
  // Variants cascade in the DB; collect their files first.
  const { data: children } = await s.supabase.from(CT_TABLES.assets).select("storage_path").eq("parent_id", assetId);
  const { error } = await s.supabase.from(CT_TABLES.assets).delete().eq("id", assetId);
  if (error) return jsonError(error.message, 500);
  // A mockup is also listed as a job of the product (server/product-mockups.ts — a bộ nhân vật's step 4 shows those):
  // it goes with the picture, or step 4 keeps showing a mockup deleted in the editor.
  if (asset.role === "mockup" && asset.product_id)
    await (ctServiceClient() ?? s.supabase).from(CT_TABLES.packImages).delete().eq("name", `mockup:${asset.product_id}`).eq("url", asset.url);
  await ctRemove([asset.storage_path, ...(children ?? []).map((c: { storage_path: string }) => c.storage_path)]);
  return new NextResponse(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// AI generation
// ---------------------------------------------------------------------------

export function aiProviders(): NextResponse {
  return NextResponse.json({ providers: listProviders() });
}
