/**
 * The team's font library (asked 2026-11-04: "thêm thư viện font chữ để có thể tải được font chữ mới lên dùng chung
 * được cho tất cả"). One list in ct_settings 'fonts' (migration 020 — no table of its own), the files on R2.
 *
 *   GET    fonts        → { fonts: CtLibraryFont[], admin }
 *   POST   fonts        multipart: file (.ttf / .otf / .woff), name? → { font }
 *   DELETE fonts/:id    the uploader or an admin; text layers using it keep drawing it (their own fontUrl)
 *
 * TTF / OTF / WOFF only: the server print reads fonts with opentype.js, which cannot read WOFF2.
 */

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { CT_CONFIG, CT_FONTS, CT_TABLES } from "../config";
import type { CtLibraryFont, CtLibraryFontFormat } from "../types";
import { isAdmin } from "./ai-styles";
import { ctUpload } from "./storage";
import type { CtSession } from "./supabase";

const KEY = "fonts";
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_FONTS = 500;

const MIME: Record<CtLibraryFontFormat, string> = { ttf: "font/ttf", otf: "font/otf", woff: "font/woff" };

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

function missingMigration(message: string): string {
  return /ct_settings/.test(message) && /does not exist|schema cache|Could not find/i.test(message)
    ? `Thiếu migration: chạy supabase/migrations/020_settings.sql (${message})`
    : message;
}

/** The file's format from its first bytes (the name's extension is not trusted). */
function sniff(buf: Buffer): CtLibraryFontFormat | "woff2" | null {
  if (buf.length < 12) return null;
  const tag = buf.subarray(0, 4).toString("latin1");
  if (tag === "wOFF") return "woff";
  if (tag === "wOF2") return "woff2";
  if (tag === "OTTO") return "otf";
  if (tag === "true" || buf.readUInt32BE(0) === 0x00010000) return "ttf";
  return null;
}

function isFont(raw: unknown): raw is CtLibraryFont {
  if (!raw || typeof raw !== "object") return false;
  const f = raw as Partial<CtLibraryFont>;
  return typeof f.id === "string" && typeof f.family === "string" && typeof f.url === "string";
}

async function readFonts(s: CtSession): Promise<CtLibraryFont[]> {
  const { data, error } = await s.supabase.from(CT_TABLES.settings).select("value").eq("key", KEY).maybeSingle<{ value: unknown }>();
  if (error) throw new Error(missingMigration(error.message));
  return Array.isArray(data?.value) ? data.value.filter(isFont) : [];
}

async function writeFonts(s: CtSession, fonts: CtLibraryFont[]): Promise<void> {
  const { error } = await s.supabase.from(CT_TABLES.settings).upsert({ key: KEY, value: fonts }, { onConflict: "key" });
  if (error) throw new Error(missingMigration(error.message));
}

/** A family name the page has not got yet: letters, digits, spaces and dashes, never a Google font of the tool. */
function freeFamily(want: string, taken: Set<string>): string {
  const base = want.replace(/[^\p{L}\p{N} _-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Font";
  const lower = new Set([...taken, ...CT_FONTS.map((f) => f.family)].map((x) => x.toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!lower.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/** GET fonts */
export async function listFonts(s: CtSession): Promise<NextResponse> {
  try {
    return NextResponse.json({ fonts: await readFonts(s), admin: await isAdmin(s) });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không đọc được thư viện font", 500);
  }
}

/** POST fonts */
export async function uploadFont(s: CtSession, form: FormData | null): Promise<NextResponse> {
  const file = form?.get("file");
  if (!(file instanceof File) || !file.size) return jsonError("Chọn file font (.ttf, .otf, .woff)", 400);
  if (file.size > MAX_BYTES) return jsonError("File font quá lớn (tối đa 15 MB)", 400);
  const buf = Buffer.from(await file.arrayBuffer());
  const format = sniff(buf);
  if (format === "woff2") return jsonError("WOFF2 chưa dùng được cho file in — tải bản .ttf / .otf / .woff của font", 400);
  if (!format) return jsonError("File này không phải font (.ttf, .otf, .woff)", 400);
  const asked = typeof form?.get("name") === "string" ? String(form?.get("name")).trim() : "";
  const fromFile = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
  try {
    const fonts = await readFonts(s);
    if (fonts.length >= MAX_FONTS) return jsonError(`Thư viện đã có ${MAX_FONTS} font — xoá bớt trước`, 400);
    const hash = createHash("sha1").update(buf).digest("hex").slice(0, 16);
    const same = fonts.find((f) => f.url.includes(hash));
    if (same) return NextResponse.json({ font: same, existed: true });
    const family = freeFamily(asked || fromFile, new Set(fonts.map((f) => f.family)));
    const url = await ctUpload(`${CT_CONFIG.storagePrefix}-fonts/${hash}.${format}`, buf, MIME[format]);
    const font: CtLibraryFont = { id: crypto.randomUUID(), family, name: asked || fromFile || family, url, format, user_id: s.user.id, created_at: new Date().toISOString() };
    // Read again right before writing: two uploads at once both keep their font.
    const now = await readFonts(s);
    await writeFonts(s, [...now, font]);
    return NextResponse.json({ font }, { status: 201 });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không lưu được font", 500);
  }
}

/** DELETE fonts/:id — the file stays on R2: text layers that use it still point at it. */
export async function deleteFont(s: CtSession, id: string): Promise<NextResponse> {
  try {
    const fonts = await readFonts(s);
    const font = fonts.find((f) => f.id === id);
    if (!font) return jsonError("Không tìm thấy font", 404);
    if (font.user_id !== s.user.id && !(await isAdmin(s))) return jsonError("Chỉ người tải lên hoặc admin xoá được font này", 403);
    await writeFonts(s, fonts.filter((f) => f.id !== id));
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không xoá được font", 500);
  }
}
