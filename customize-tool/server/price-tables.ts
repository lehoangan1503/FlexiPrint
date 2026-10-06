/**
 * Bảng giá (ct_price_tables, migration 018): named Size × Pack tables every editor sees; the owner (or an admin)
 * edits / deletes. The Deploy page picks one per product (ct_products.shopify.priceTableId).
 */

import { NextResponse } from "next/server";
import { CT_TABLES } from "../config";
import type { CtPriceTable, CtPriceTableBody } from "../types";
import { normalizePriceTableConfig } from "../lib/pricing";
import type { CtSession } from "./supabase";

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

function migrationHint(message: string): string {
  return /ct_price_tables|shopify/.test(message) && /does not exist|schema cache|Could not find/i.test(message)
    ? `Thiếu migration: chạy supabase/migrations/018_price_tables_deploy.sql (${message})`
    : message;
}

function readBody(raw: unknown): CtPriceTableBody | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Partial<CtPriceTableBody>;
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 120) : "";
  if (!name) return null;
  return { name, config: normalizePriceTableConfig(b.config) };
}

function normalizeRow(row: CtPriceTable): CtPriceTable {
  return { ...row, config: normalizePriceTableConfig(row.config) };
}

export async function loadPriceTable(s: CtSession, id: string): Promise<CtPriceTable | null> {
  const { data } = await s.supabase.from(CT_TABLES.priceTables).select("*").eq("id", id).maybeSingle<CtPriceTable>();
  return data ? normalizeRow(data) : null;
}

export async function listPriceTables(s: CtSession): Promise<NextResponse> {
  const { data, error } = await s.supabase.from(CT_TABLES.priceTables).select("*").order("updated_at", { ascending: false }).limit(200).returns<CtPriceTable[]>();
  if (error) return jsonError(migrationHint(error.message), 500);
  return NextResponse.json({ tables: (data ?? []).map(normalizeRow) });
}

export async function createPriceTable(s: CtSession, raw: unknown): Promise<NextResponse> {
  const body = readBody(raw);
  if (!body) return jsonError("Bảng giá cần tên", 400);
  const { data, error } = await s.supabase
    .from(CT_TABLES.priceTables)
    .insert({ user_id: s.user.id, name: body.name, config: body.config })
    .select("*")
    .single<CtPriceTable>();
  if (error) return jsonError(migrationHint(error.message), 500);
  return NextResponse.json({ table: normalizeRow(data) }, { status: 201 });
}

export async function updatePriceTable(s: CtSession, id: string, raw: unknown): Promise<NextResponse> {
  const body = readBody(raw);
  if (!body) return jsonError("Bảng giá cần tên", 400);
  const { data, error } = await s.supabase
    .from(CT_TABLES.priceTables)
    .update({ name: body.name, config: body.config })
    .eq("id", id)
    .select("*")
    .maybeSingle<CtPriceTable>();
  if (error) return jsonError(migrationHint(error.message), 500);
  if (!data) return jsonError("Không có quyền sửa bảng giá này (chỉ người tạo hoặc admin)", 403);
  return NextResponse.json({ table: normalizeRow(data) });
}

export async function deletePriceTable(s: CtSession, id: string): Promise<NextResponse> {
  const { data, error } = await s.supabase.from(CT_TABLES.priceTables).delete().eq("id", id).select("id");
  if (error) return jsonError(migrationHint(error.message), 500);
  if (!data?.length) return jsonError("Không có quyền xoá bảng giá này (chỉ người tạo hoặc admin)", 403);
  return new NextResponse(null, { status: 204 });
}
