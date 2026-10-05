/**
 * Bộ tổ hợp (migration 007, table ct_mockup_packs): named sets of hand-made
 * mockup scenes, shared by every product (lib/mockup.ts renders them in the
 * browser; a product puts its own main versions in the frames).
 *
 *   GET    library/packs           → { packs, admin }
 *   POST   library/packs           CtMockupPackBody
 *   PATCH  library/packs/:id       CtMockupPackBody
 *   DELETE library/packs/:id
 *   POST   library/packs/images    multipart file → { url, width, height }  (backgrounds, overlays, thumbnails)
 */

import { NextResponse } from "next/server";
import { CT_CONFIG, CT_TABLES } from "../config";
import type { CtMockupPack, CtMockupPackBody } from "../types";
import { normalizePack, normalizePackBody } from "../lib/mockup";
import { isAdmin } from "./ai-styles";
import { readImageInfo } from "./image-size";
import { ctLibraryPath, ctUpload } from "./storage";
import type { CtSession } from "./supabase";

type PackRow = Omit<CtMockupPack, "can_edit">;

/** Scene pictures are big photos, not print files. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/** Row columns: the canvas of the first scene (kept for listing). */
function row(body: CtMockupPackBody) {
  const first = body.slides[0];
  return { ...body, width: first?.width ?? 2000, height: first?.height ?? 2000 };
}

function missingMigration(message: string): string {
  return /ct_mockup_packs/.test(message) && /does not exist|schema cache|Could not find/i.test(message)
    ? `Thiếu migration: chạy supabase/migrations/007_mockup_packs.sql (${message})`
    : message;
}

export async function listPacks(s: CtSession): Promise<NextResponse> {
  const { data, error } = await s.supabase.from(CT_TABLES.mockupPacks).select("*").order("sort_order").order("created_at").returns<PackRow[]>();
  if (error) return jsonError(missingMigration(error.message), 500);
  const admin = await isAdmin(s);
  const packs: CtMockupPack[] = (data ?? []).map((p) => ({ ...normalizePack(p), can_edit: admin || p.user_id === s.user.id }));
  return NextResponse.json({ packs, admin });
}

export async function createPack(s: CtSession, body: CtMockupPackBody): Promise<NextResponse> {
  const clean = normalizePackBody(body);
  const { data, error } = await s.supabase.from(CT_TABLES.mockupPacks).insert({ ...row(clean), user_id: s.user.id }).select("*").single<PackRow>();
  if (error) return jsonError(missingMigration(error.message), 500);
  const pack: CtMockupPack = { ...normalizePack(data), can_edit: true };
  return NextResponse.json({ pack }, { status: 201 });
}

export async function updatePack(s: CtSession, id: string, body: CtMockupPackBody): Promise<NextResponse> {
  const clean = normalizePackBody(body);
  const { data, error } = await s.supabase.from(CT_TABLES.mockupPacks).update(row(clean)).eq("id", id).select("*").maybeSingle<PackRow>();
  if (error) return jsonError(error.message, 500);
  if (!data) return jsonError("Chỉ người tạo hoặc admin mới được sửa bộ tổ hợp", 403);
  const pack: CtMockupPack = { ...normalizePack(data), can_edit: true };
  return NextResponse.json({ pack });
}

export async function deletePack(s: CtSession, id: string): Promise<NextResponse> {
  const { error, count } = await s.supabase.from(CT_TABLES.mockupPacks).delete({ count: "exact" }).eq("id", id);
  if (error) return jsonError(error.message, 500);
  if (!count) return jsonError("Chỉ người tạo hoặc admin mới được xoá bộ tổ hợp", 403);
  return new NextResponse(null, { status: 204 });
}

export async function uploadPackImage(s: CtSession, form: FormData): Promise<NextResponse> {
  const file = form.get("file");
  if (!(file instanceof Blob)) return jsonError("Thiếu file", 400);
  if (file.size > Math.min(MAX_IMAGE_BYTES, CT_CONFIG.maxUploadBytes)) return jsonError("Ảnh quá lớn (tối đa 25MB)", 413);
  const data = Buffer.from(await file.arrayBuffer());
  const info = readImageInfo(data);
  if (!info) return jsonError("File không phải ảnh PNG/JPEG/WebP hợp lệ", 400);
  try {
    const url = await ctUpload(ctLibraryPath(s.user.id, null, "pack", info.mime), data, info.mime);
    return NextResponse.json({ url, width: info.width, height: info.height }, { status: 201 });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Upload thất bại", 500);
  }
}
