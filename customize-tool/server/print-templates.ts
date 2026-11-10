/**
 * Khuôn in (migration 024, table ct_print_templates — types/print.ts, lib/print-template.ts): shared by the team.
 *
 *   GET    print-templates             → { templates }   (first visit: the starting templates are added)
 *   POST   print-templates             { name, kind, spec } → { template }
 *   PATCH  print-templates/:id         { name?, kind?, spec? } → { template }
 *   DELETE print-templates/:id
 *   POST   print-templates/images      multipart file → { url, width, height }   (guide sheet, blank photo)
 */

import sharp from "sharp";
import { NextResponse } from "next/server";
import { CT_CONFIG, CT_TABLES } from "../config";
import type { CtPrintKind, CtPrintSpec, CtPrintTemplate } from "../types/print";
import { PRINT_PRESETS, isPrintKind, normalizePrintSpec } from "../lib/print-template";
import { readImageInfo } from "./image-size";
import { readKhuonPicture } from "./print-khuon-read";
import { ctLibraryPath, ctUpload } from "./storage";
import type { CtSession } from "./supabase";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

interface TemplateBody {
  name?: unknown;
  kind?: unknown;
  spec?: unknown;
}

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

function missingMigration(message: string): string {
  return /ct_print_templates/.test(message) && /does not exist|schema cache|Could not find/i.test(message)
    ? `Thiếu migration: chạy supabase/migrations/024_print_templates.sql (${message})`
    : message;
}

export function templateRow(raw: CtPrintTemplate): CtPrintTemplate {
  return { ...raw, kind: isPrintKind(raw.kind) ? raw.kind : "flat", spec: normalizePrintSpec(raw.spec) };
}

function clean(body: TemplateBody, partial: boolean): { name?: string; kind?: CtPrintKind; spec?: CtPrintSpec } | string {
  const out: { name?: string; kind?: CtPrintKind; spec?: CtPrintSpec } = {};
  if (body.name !== undefined || !partial) {
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 200) : "";
    if (!name) return "Đặt tên khuôn in";
    out.name = name;
  }
  if (body.kind !== undefined || !partial) {
    if (!isPrintKind(body.kind)) return "Loại khuôn không hợp lệ";
    out.kind = body.kind;
  }
  if (body.spec !== undefined || !partial) out.spec = normalizePrintSpec(body.spec);
  return out;
}

/**
 * Faces given only as a picture (an uploaded khuôn): read the picture once — its solid lines = the piece (mask: the
 * print is cut to it, the silhouette is it), its dashed lines = the safe zones, its lines = the guide over the editor
 * (server/print-khuon-read.ts). A face read before has a guide, so nothing is read twice.
 */
async function readUploadedFaces(userId: string, spec: CtPrintSpec): Promise<CtPrintSpec> {
  if (!spec.faces.some((f) => f.imageUrl && !f.maskUrl && !f.guideUrl)) return spec;
  let safe = spec.safe;
  const faces = await Promise.all(
    spec.faces.map(async (f, i) => {
      if (!f.imageUrl || f.maskUrl || f.guideUrl) return f;
      try {
        const res = await fetch(f.imageUrl, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) return f;
        const read = await readKhuonPicture(Buffer.from(await res.arrayBuffer()), spec.width, spec.height);
        const put = (data: Buffer) => ctUpload(ctLibraryPath(userId, null, "print-template", "image/png"), data, "image/png");
        const guideUrl = await put(read.guide);
        let maskUrl: string | null = null;
        if (read.mask) {
          const alpha = await sharp(read.mask, { raw: { width: spec.width, height: spec.height, channels: 1 } }).png().toBuffer();
          maskUrl = await put(await sharp({ create: { width: spec.width, height: spec.height, channels: 3, background: "#ffffff" } }).joinChannel(alpha).png().toBuffer());
        }
        // The first face's dashed lines are the safe zones (every face is the same sheet).
        if (i === 0 && !safe.length && read.safe.length) safe = read.safe;
        return { ...f, maskUrl, guideUrl };
      } catch {
        return f;
      }
    }),
  );
  return { ...spec, faces, safe };
}

export async function listTemplates(s: CtSession): Promise<NextResponse> {
  const read = () => s.supabase.from(CT_TABLES.printTemplates).select("*").order("sort_order").order("created_at").returns<CtPrintTemplate[]>();
  let { data, error } = await read();
  if (error) return jsonError(missingMigration(error.message), 500);
  if (!data?.length) {
    // A team's first visit: the usual pieces to start from (edited / deleted like any other).
    await s.supabase.from(CT_TABLES.printTemplates).insert(PRINT_PRESETS.map((p, i) => ({ name: p.name, kind: p.kind, spec: p.spec, sort_order: i, user_id: s.user.id })));
    ({ data, error } = await read());
    if (error) return jsonError(error.message, 500);
  }
  const rows = (data ?? []).map(templateRow);
  // Khuôn uploaded before their pictures were read (2026-11-10): read them now, once.
  for (const [i, t] of rows.entries()) {
    const spec = await readUploadedFaces(s.user.id, t.spec);
    if (spec === t.spec) continue;
    const { data: saved } = await s.supabase.from(CT_TABLES.printTemplates).update({ spec }).eq("id", t.id).select("*").maybeSingle<CtPrintTemplate>();
    if (saved) rows[i] = templateRow(saved);
  }
  return NextResponse.json({ templates: rows });
}

export async function createTemplate(s: CtSession, body: TemplateBody): Promise<NextResponse> {
  const c = clean(body, false);
  if (typeof c === "string") return jsonError(c, 400);
  if (c.spec) c.spec = await readUploadedFaces(s.user.id, c.spec);
  const { data, error } = await s.supabase.from(CT_TABLES.printTemplates).insert({ ...c, user_id: s.user.id }).select("*").single<CtPrintTemplate>();
  if (error) return jsonError(missingMigration(error.message), 500);
  return NextResponse.json({ template: templateRow(data) }, { status: 201 });
}

export async function updateTemplate(s: CtSession, id: string, body: TemplateBody): Promise<NextResponse> {
  const c = clean(body, true);
  if (typeof c === "string") return jsonError(c, 400);
  if (c.spec) c.spec = await readUploadedFaces(s.user.id, c.spec);
  const { data, error } = await s.supabase.from(CT_TABLES.printTemplates).update(c).eq("id", id).select("*").maybeSingle<CtPrintTemplate>();
  if (error) return jsonError(error.message, 500);
  if (!data) return jsonError("Chỉ người tạo hoặc admin mới được sửa khuôn in", 403);
  return NextResponse.json({ template: templateRow(data) });
}

export async function deleteTemplate(s: CtSession, id: string): Promise<NextResponse> {
  const { error, count } = await s.supabase.from(CT_TABLES.printTemplates).delete({ count: "exact" }).eq("id", id);
  if (error) return jsonError(error.message, 500);
  if (!count) return jsonError("Chỉ người tạo hoặc admin mới được xoá khuôn in", 403);
  return new NextResponse(null, { status: 204 });
}

export async function getTemplate(s: CtSession, id: string): Promise<CtPrintTemplate | null> {
  const { data } = await s.supabase.from(CT_TABLES.printTemplates).select("*").eq("id", id).maybeSingle<CtPrintTemplate>();
  return data ? templateRow(data) : null;
}

export async function uploadTemplateImage(s: CtSession, form: FormData): Promise<NextResponse> {
  const file = form.get("file");
  if (!(file instanceof Blob)) return jsonError("Thiếu file", 400);
  if (file.size > Math.min(MAX_IMAGE_BYTES, CT_CONFIG.maxUploadBytes)) return jsonError("Ảnh quá lớn (tối đa 25MB)", 413);
  const data = Buffer.from(await file.arrayBuffer());
  const info = readImageInfo(data);
  if (!info) return jsonError("Không đọc được ảnh — dùng PNG / JPEG / WebP", 400);
  try {
    const url = await ctUpload(ctLibraryPath(s.user.id, null, "print-template", info.mime), data, info.mime);
    return NextResponse.json({ url, width: info.width, height: info.height }, { status: 201 });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Upload thất bại", 500);
  }
}
