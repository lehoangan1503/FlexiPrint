/**
 * Product base (ct_base_products, migration 031 — asked 2026-11-07, Teeinblue's "Product Base"): the blank product
 * that is sold. Title = the kind of product ("Acrylic Ornament 1 side"); its Notion price table makes the variants
 * (Size × Pack) and their prices; its khuôn in (+ phôi) is the piece an artwork is drawn for; print areas + fulfiller
 * are what the factory needs. It holds no design and starts with no mockups: its page shows the mockups of every
 * product made on it.
 *
 *   GET    base-products            → { bases: CtBaseProductRow[] }
 *   POST   base-products            CtBaseProductBody → { base }
 *   GET    base-products/:id        → CtBaseProductDetail
 *   PATCH  base-products/:id        CtBaseProductBody → { base }
 *   DELETE base-products/:id        (refused while products use it)
 */

import { NextResponse } from "next/server";
import { CT_TABLES } from "../config";
import type {
  CtAsset,
  CtBaseProduct,
  CtBaseProductBody,
  CtBaseProductDetail,
  CtBaseProductRow,
  CtBaseProductTemplate,
  CtBaseProductUse,
  CtPriceTable,
  CtProduct,
} from "../types";
import type { CtPrintTemplate } from "../types/print";
import { normalizePriceTableConfig } from "../lib/pricing";
import { normalizePrintSpec } from "../lib/print-template";
import { normalizeBaseConfig } from "../lib/base-product";
import { applyBase } from "./artwork-link";
import type { CtServiceClient, CtSession } from "./supabase";

type Db = CtSession["supabase"] | CtServiceClient;

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function readBody(raw: unknown): CtBaseProductBody | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Partial<Record<keyof CtBaseProductBody, unknown>>;
  const name = str(b.name, 160);
  return name ? { name, config: normalizeBaseConfig(b.config) } : null;
}

function normalizeRow(row: CtBaseProduct): CtBaseProduct {
  return { ...row, config: normalizeBaseConfig(row.config) };
}

function templateInfo(t: CtPrintTemplate): CtBaseProductTemplate {
  const spec = normalizePrintSpec(t.spec);
  return {
    id: t.id,
    name: t.name,
    kind: t.kind,
    width: spec.width,
    height: spec.height,
    widthMm: spec.widthMm,
    blankUrl: spec.blanks[0]?.url ?? null,
    blanks: spec.blanks.length,
  };
}

export async function loadBaseProduct(db: Db, id: string): Promise<CtBaseProduct | null> {
  const { data } = await db.from(CT_TABLES.baseProducts).select("*").eq("id", id).maybeSingle<CtBaseProduct>();
  return data ? normalizeRow(data) : null;
}

/** The base products with their khuôn, price table and how many products / mockups they have. */
async function rows(db: Db, only: string | null): Promise<CtBaseProductRow[]> {
  let q = db.from(CT_TABLES.baseProducts).select("*").order("sort_order").order("created_at");
  if (only) q = q.eq("id", only);
  const { data, error } = await q.returns<CtBaseProduct[]>();
  if (error) throw new Error(/ct_base_products/.test(error.message) ? `Thiếu migration 031_base_products.sql (${error.message})` : error.message);
  const bases = (data ?? []).map(normalizeRow);
  const tplIds = [...new Set(bases.flatMap((b) => (b.config.templateId ? [b.config.templateId] : [])))];
  const tableIds = [...new Set(bases.flatMap((b) => (b.config.priceTableId ? [b.config.priceTableId] : [])))];
  const [tpls, tables, products] = await Promise.all([
    tplIds.length ? db.from(CT_TABLES.printTemplates).select("*").in("id", tplIds).returns<CtPrintTemplate[]>() : Promise.resolve({ data: [] as CtPrintTemplate[] }),
    tableIds.length ? db.from(CT_TABLES.priceTables).select("*").in("id", tableIds).returns<CtPriceTable[]>() : Promise.resolve({ data: [] as CtPriceTable[] }),
    bases.length
      ? db.from(CT_TABLES.products).select("id,base_product_id").in("base_product_id", bases.map((b) => b.id)).eq("kind", "product").returns<Array<{ id: string; base_product_id: string }>>()
      : Promise.resolve({ data: [] as Array<{ id: string; base_product_id: string }> }),
  ]);
  const tplById = new Map((tpls.data ?? []).map((t) => [t.id, templateInfo(t)]));
  const tableById = new Map((tables.data ?? []).map((t) => [t.id, { ...t, config: normalizePriceTableConfig(t.config) }]));
  const productIds = (products.data ?? []).map((p) => p.id);
  const baseOf = new Map((products.data ?? []).map((p) => [p.id, p.base_product_id]));
  const mockups: Array<{ product_id: string; url: string; created_at: string }> = [];
  for (let i = 0; i < productIds.length; i += 60) {
    const { data: m } = await db
      .from(CT_TABLES.assets)
      .select("product_id,url,created_at")
      .in("product_id", productIds.slice(i, i + 60))
      .eq("role", "mockup")
      .returns<Array<{ product_id: string; url: string; created_at: string }>>();
    mockups.push(...(m ?? []));
  }
  return bases.map((b) => {
    const mine = mockups.filter((m) => baseOf.get(m.product_id) === b.id).sort((x, y) => y.created_at.localeCompare(x.created_at));
    return {
      ...b,
      template: b.config.templateId ? (tplById.get(b.config.templateId) ?? null) : null,
      priceTable: b.config.priceTableId ? (tableById.get(b.config.priceTableId) ?? null) : null,
      products: (products.data ?? []).filter((p) => p.base_product_id === b.id).length,
      mockups: mine.length,
      mockup_url: mine[0]?.url ?? null,
    };
  });
}

export async function listBaseRows(db: Db): Promise<CtBaseProductRow[]> {
  return rows(db, null);
}

export async function listBaseProducts(s: CtSession): Promise<NextResponse> {
  try {
    return NextResponse.json({ bases: await rows(s.supabase, null) });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Lỗi", 500);
  }
}

export async function baseProductDetail(db: Db, id: string): Promise<CtBaseProductDetail | null> {
  const [base] = await rows(db, id);
  if (!base) return null;
  const { data: products } = await db
    .from(CT_TABLES.products)
    .select("id,name,config,shopify,created_at")
    .eq("base_product_id", id)
    .eq("kind", "product")
    .order("created_at", { ascending: false })
    .returns<Array<Pick<CtProduct, "id" | "name" | "config" | "shopify" | "created_at">>>();
  const list = products ?? [];
  const artIds = [...new Set(list.flatMap((p) => (p.config?.artworkLink?.artworkId ? [p.config.artworkLink.artworkId] : [])))];
  const { data: arts } = artIds.length ? await db.from(CT_TABLES.products).select("id,name").in("id", artIds).returns<Array<{ id: string; name: string }>>() : { data: [] };
  const artName = new Map((arts ?? []).map((a) => [a.id, a.name]));
  const mockups: CtAsset[] = [];
  const ids = list.map((p) => p.id);
  for (let i = 0; i < ids.length; i += 60) {
    const { data } = await db.from(CT_TABLES.assets).select("*").in("product_id", ids.slice(i, i + 60)).eq("role", "mockup").order("created_at").returns<CtAsset[]>();
    mockups.push(...(data ?? []));
  }
  const uses: CtBaseProductUse[] = list.map((p) => {
    const artId = p.config?.artworkLink?.artworkId ?? null;
    return {
      id: p.id,
      name: p.name,
      artwork: artId ? { id: artId, name: artName.get(artId) ?? "(artwork đã xoá)" } : null,
      shopify: !!p.shopify,
      mockups: mockups.filter((m) => m.product_id === p.id),
    };
  });
  return { base, uses };
}

export async function getBaseProduct(s: CtSession, id: string): Promise<NextResponse> {
  try {
    const detail = await baseProductDetail(s.supabase, id);
    return detail ? NextResponse.json(detail) : jsonError("Không tìm thấy product base", 404);
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Lỗi", 500);
  }
}

export async function createBaseProduct(s: CtSession, raw: unknown): Promise<NextResponse> {
  const body = readBody(raw);
  if (!body) return jsonError("Product base cần tên (loại sản phẩm)", 400);
  const { data, error } = await s.supabase.from(CT_TABLES.baseProducts).insert({ user_id: s.user.id, name: body.name, config: body.config }).select("*").single<CtBaseProduct>();
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ base: normalizeRow(data) }, { status: 201 });
}

export async function updateBaseProduct(s: CtSession, id: string, raw: unknown): Promise<NextResponse> {
  const body = readBody(raw);
  if (!body) return jsonError("Product base cần tên (loại sản phẩm)", 400);
  const { data, error } = await s.supabase.from(CT_TABLES.baseProducts).update({ name: body.name, config: body.config }).eq("id", id).select("*").maybeSingle<CtBaseProduct>();
  if (error) return jsonError(error.message, 500);
  if (!data) return jsonError("Không có quyền sửa product base này (chỉ người tạo hoặc admin)", 403);
  // The base owns the khuôn, phôi and cut (2026-11-08): every product on it is laid on it again.
  const { data: products } = await s.supabase.from(CT_TABLES.products).select("*").eq("base_product_id", id).eq("kind", "product").returns<CtProduct[]>();
  const failed: string[] = [];
  for (const p of products ?? []) await applyBase(s.supabase, p).catch((e: Error) => failed.push(`${p.name}: ${e.message}`));
  return NextResponse.json({ base: normalizeRow(data), reapplied: (products ?? []).length - failed.length, failed });
}

export async function deleteBaseProduct(s: CtSession, id: string): Promise<NextResponse> {
  const { count } = await s.supabase.from(CT_TABLES.products).select("id", { count: "exact", head: true }).eq("base_product_id", id).eq("kind", "product");
  if (count) return jsonError(`Đang có ${count} sản phẩm dùng product base này — đổi base của chúng hoặc xoá chúng trước`, 409);
  const { data, error } = await s.supabase.from(CT_TABLES.baseProducts).delete().eq("id", id).select("id");
  if (error) return jsonError(error.message, 500);
  if (!data?.length) return jsonError("Không có quyền xoá product base này (chỉ người tạo hoặc admin)", 403);
  return new NextResponse(null, { status: 204 });
}
