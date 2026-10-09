/**
 * Phôi trơn of a khuôn in (asked 2026-10-10: one place for khuôn and phôi, reused by products, the v2 brief and the
 * MCP). A phôi is a straight photo of the blank piece + where the sheet sits on it (spec.blanks).
 *
 *   POST print-templates/:id/blanks      multipart file, name? → { template }  an uploaded photo (box found on it)
 *   POST print-templates/:id/blanks/ai   → { template }  drawn by AI from the khuôn
 *   (removing one = PATCH the template's spec.blanks)
 */

import { NextResponse } from "next/server";
import { CT_CONFIG, CT_TABLES } from "../config";
import type { CtPrintBlank, CtPrintTemplate } from "../types/print";
import { newId } from "../lib/geometry";
import { readImageInfo } from "./image-size";
import { getTemplate, templateRow } from "./print-templates";
import { makeBlank, sceneForBlank } from "./product-mockups";
import { ctUpload } from "./storage";
import type { CtServiceClient, CtSession, CtSupabase } from "./supabase";

type Db = CtSupabase | CtServiceClient;

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/** Store a phôi photo and add it to the template (first = the one products get). */
export async function addTemplateBlank(db: Db, userId: string, t: CtPrintTemplate, photo: Buffer, name: string, ai: boolean): Promise<CtPrintTemplate> {
  const info = readImageInfo(photo);
  if (!info) throw new Error("Ảnh phôi không hợp lệ");
  const path = `${userId}/${CT_CONFIG.storagePrefix}/blanks/${t.id}/${crypto.randomUUID()}.${info.mime === "image/jpeg" ? "jpg" : info.mime === "image/webp" ? "webp" : "png"}`;
  const url = await ctUpload(path, photo, info.mime);
  const scene = await sceneForBlank(photo, url, t.spec);
  const blank: CtPrintBlank = { id: newId(), name, url, width: scene.width, height: scene.height, box: scene.box, ai };
  const spec = { ...t.spec, blanks: [...t.spec.blanks, blank] };
  const { data, error } = await db.from(CT_TABLES.printTemplates).update({ spec }).eq("id", t.id).select("*").single<CtPrintTemplate>();
  if (error || !data) throw new Error(error?.message ?? "Không lưu được phôi");
  return templateRow(data);
}

/** POST print-templates/:id/blanks */
export async function uploadTemplateBlank(s: CtSession, id: string, form: FormData): Promise<NextResponse> {
  const t = await getTemplate(s, id);
  if (!t) return jsonError("Không tìm thấy khuôn in", 404);
  const file = form.get("file");
  if (!(file instanceof Blob) || !file.size) return jsonError("Thiếu ảnh", 400);
  const name = (typeof form.get("name") === "string" ? String(form.get("name")).trim() : "").slice(0, 120) || "Phôi";
  try {
    return NextResponse.json({ template: await addTemplateBlank(s.supabase, s.user.id, t, Buffer.from(await file.arrayBuffer()), name, false) });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không lưu được phôi", 500);
  }
}

/** POST print-templates/:id/blanks/ai */
export async function aiTemplateBlank(s: CtSession, id: string): Promise<NextResponse> {
  const t = await getTemplate(s, id);
  if (!t) return jsonError("Không tìm thấy khuôn in", 404);
  try {
    const photo = await makeBlank(s.user.id, t.name, t.spec);
    return NextResponse.json({ template: await addTemplateBlank(s.supabase, s.user.id, t, photo, "Phôi AI", true) });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không tạo được phôi", 500);
  }
}
