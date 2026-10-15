/**
 * The global AI photo-style library (ct_ai_styles, migrations/003) and the
 * guards around running it for anonymous storefront visitors.
 *
 * Library rules: every signed-in user reads all styles and creates their own;
 * the owner edits / deletes theirs; admins (tool admin or superadmin, same
 * tiers as src/lib/auth/roles.ts) edit all. RLS enforces the same rules — the
 * checks here only turn them into readable errors.
 *
 * Abuse guards for the public photo endpoint (every call bills the image API):
 *   - the client sends only file + region + style ref; prompt, model and
 *     params are loaded here from the DB (never from the request, never
 *     published to the storefront)
 *   - the ref must be offered by that zone in the latest published template
 *   - durable per-day caps per IP and in total (ct_ai_usage_hit), env
 *     CT_AI_DAILY_LIMIT (default 300) and CT_AI_IP_DAILY_LIMIT (default 12)
 *   - optional Origin allowlist CT_ALLOWED_ORIGINS (comma list, e.g.
 *     https://mystore.com,https://mystore.myshopify.com) — blocks other
 *     websites embedding the endpoint; curl can fake it, the caps can't be
 *   - identical requests are served from the result cache (server/ai/photo.ts)
 *     and don't count
 */

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import sharp from "sharp";
import { CT_CONFIG, CT_TABLES } from "../config";
import type { CtAiStyle, CtAiStyleBody, CtAiStyleRef, CtPublicAiStyle } from "../types";
import { CT_AI_STYLE_MODEL, normalizeAiStyleParams } from "../lib/ai-style-models";
import { aiStyleId, aiStyleRef } from "../lib/photo-styles";
import { ctServiceClient, type CtServiceClient, type CtSession } from "./supabase";
import { ctDownload, ctUpload } from "./storage";
import { processPhoto } from "./ai/photo";

type CtAiStyleRow = Omit<CtAiStyle, "owner" | "can_edit">;

const COLUMNS = "id,user_id,name,prompt,model,params,sort_order,created_at,updated_at";

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

function missingMigration(message: string): string | null {
  return /ct_ai_styles|ct_ai_usage/.test(message) && /does not exist|schema cache|Could not find/i.test(message)
    ? `Thiếu migration: chạy customize-tool/migrations/003_ai_photo_styles.sql trên Supabase (${message})`
    : null;
}

function withDefaults(row: CtAiStyleRow): CtAiStyleRow {
  return { ...row, model: CT_AI_STYLE_MODEL, params: normalizeAiStyleParams(row.params) };
}

/** Tool admin (user_profiles.role) or superadmin (app_metadata.role). */
export async function isAdmin(s: CtSession): Promise<boolean> {
  if (s.user.app_metadata?.role === "admin") return true;
  const { data } = await s.supabase.from("user_profiles").select("role").eq("user_id", s.user.id).maybeSingle<{ role: string | null }>();
  return data?.role === "admin";
}

function validBody(body: CtAiStyleBody): string | null {
  const name = (body.name ?? "").trim();
  const prompt = (body.prompt ?? "").trim();
  if (!name || name.length > 80) return "Tên style 1–80 ký tự";
  if (!prompt || prompt.length > 4000) return "Prompt 1–4000 ký tự";
  return null;
}

function cleanBody(body: CtAiStyleBody): CtAiStyleBody {
  return { name: body.name.trim(), prompt: body.prompt.trim(), model: CT_AI_STYLE_MODEL, params: normalizeAiStyleParams(body.params) };
}

// ---------------------------------------------------------------------------
// Editor CRUD
// ---------------------------------------------------------------------------

export async function listAiStyles(s: CtSession): Promise<NextResponse> {
  const { data, error } = await s.supabase
    .from(CT_TABLES.aiStyles)
    .select(COLUMNS)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })
    .returns<CtAiStyleRow[]>();
  if (error) return jsonError(missingMigration(error.message) ?? error.message, 500);
  const rows = (data ?? []).map(withDefaults);
  const admin = await isAdmin(s);
  const ownerIds = [...new Set(rows.map((r) => r.user_id).filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string>();
  if (ownerIds.length) {
    const { data: profiles } = await s.supabase
      .from("user_profiles")
      .select("user_id,nickname,email")
      .in("user_id", ownerIds)
      .returns<Array<{ user_id: string; nickname: string | null; email: string }>>();
    for (const p of profiles ?? []) names.set(p.user_id, p.nickname || p.email);
  }
  const styles: CtAiStyle[] = rows.map((r) => ({
    ...r,
    owner: r.user_id ? (r.user_id === s.user.id ? "Bạn" : names.get(r.user_id) ?? "Người dùng khác") : "Built-in",
    can_edit: admin || (r.user_id !== null && r.user_id === s.user.id),
  }));
  return NextResponse.json({ styles, admin });
}

export async function createAiStyle(s: CtSession, body: CtAiStyleBody): Promise<NextResponse> {
  const bad = validBody(body);
  if (bad) return jsonError(bad, 400);
  const { data, error } = await s.supabase
    .from(CT_TABLES.aiStyles)
    .insert({ ...cleanBody(body), user_id: s.user.id })
    .select(COLUMNS)
    .single<CtAiStyleRow>();
  if (error) return jsonError(missingMigration(error.message) ?? error.message, 500);
  const style: CtAiStyle = { ...withDefaults(data), owner: "Bạn", can_edit: true };
  return NextResponse.json({ style }, { status: 201 });
}

async function editable(s: CtSession, id: string): Promise<CtAiStyleRow | NextResponse> {
  const { data, error } = await s.supabase.from(CT_TABLES.aiStyles).select(COLUMNS).eq("id", id).maybeSingle<CtAiStyleRow>();
  if (error) return jsonError(missingMigration(error.message) ?? error.message, 500);
  if (!data) return jsonError("Style không tồn tại", 404);
  if (data.user_id !== s.user.id && !(await isAdmin(s))) return jsonError("Chỉ người tạo style hoặc admin mới được sửa / xoá", 403);
  return data;
}

export async function updateAiStyle(s: CtSession, id: string, body: CtAiStyleBody): Promise<NextResponse> {
  const bad = validBody(body);
  if (bad) return jsonError(bad, 400);
  const row = await editable(s, id);
  if (row instanceof NextResponse) return row;
  const { data, error } = await s.supabase.from(CT_TABLES.aiStyles).update(cleanBody(body)).eq("id", id).select(COLUMNS).maybeSingle<CtAiStyleRow>();
  if (error) return jsonError(error.message, 500);
  if (!data) return jsonError("Không có quyền sửa style này", 403);
  const style: CtAiStyle = { ...withDefaults(data), owner: data.user_id === s.user.id ? "Bạn" : data.user_id ? "Người dùng khác" : "Built-in", can_edit: true };
  return NextResponse.json({ style });
}

export async function deleteAiStyle(s: CtSession, id: string): Promise<NextResponse> {
  const row = await editable(s, id);
  if (row instanceof NextResponse) return row;
  const { error, count } = await s.supabase.from(CT_TABLES.aiStyles).delete({ count: "exact" }).eq("id", id);
  if (error) return jsonError(error.message, 500);
  if (!count) return jsonError("Không có quyền xoá style này", 403);
  return new NextResponse(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// Resolving refs (server only)
// ---------------------------------------------------------------------------

type Reader = CtSession["supabase"] | CtServiceClient;

/** The full row for a ref — prompt and model included — for running it. */
export async function loadAiStyle(db: Reader, ref: CtAiStyleRef): Promise<CtAiStyle | null> {
  const { data } = await db.from(CT_TABLES.aiStyles).select(COLUMNS).eq("id", aiStyleId(ref)).maybeSingle<CtAiStyleRow>();
  return data ? { ...withDefaults(data), owner: "", can_edit: false } : null;
}

/** Names + demo pictures, for the published template. Unknown / deleted refs are dropped. */
export async function publicAiStyles(db: Reader, refs: CtAiStyleRef[]): Promise<CtPublicAiStyle[]> {
  const ids = [...new Set(refs.map(aiStyleId))];
  if (!ids.length) return [];
  const { data } = await db.from(CT_TABLES.aiStyles).select("id,name,params").in("id", ids).returns<Array<Pick<CtAiStyleRow, "id" | "name" | "params">>>();
  return (data ?? []).map((r) => {
    const demoUrl = normalizeAiStyleParams(r.params).demoUrl;
    return { ref: aiStyleRef(r.id), name: r.name, ...(demoUrl ? { demoUrl } : {}) };
  });
}

// ---------------------------------------------------------------------------
// Demo pictures (asked 2026-10-15: the editor and the customer pick a style by its picture)
// ---------------------------------------------------------------------------

/** The stock sample every demo is made from unless the editor uploads their own (a pet photo, made once with
 * GPT Image 2.5 — scripts in .scratch-e2e, 2026-10-15). */
export const AI_STYLE_SAMPLE_URL = "https://flexiprint.next.lc/files/shared/customize-tool/ai-styles/sample-pet.jpg";

/** POST ai-styles/:id/demo [file sample] — run the style on the sample photo, store the result as params.demoUrl. */
export async function makeAiStyleDemo(s: CtSession, id: string, form: FormData | null): Promise<NextResponse> {
  const row = await editable(s, id);
  if (row instanceof NextResponse) return row;
  let sample: { data: Buffer; mime: string };
  let sourceUrl = AI_STYLE_SAMPLE_URL;
  const file = form?.get("sample");
  try {
    if (file instanceof Blob && file.size > 0) {
      if (file.size > 12 * 1024 * 1024) return jsonError("Ảnh mẫu tối đa 12 MB", 400);
      const raw = Buffer.from(await file.arrayBuffer());
      // ~1600 px like a storefront upload.
      const data = await sharp(raw).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
      sample = { data, mime: "image/jpeg" };
      sourceUrl = await ctUpload(`${s.user.id}/${CT_CONFIG.storagePrefix}/ai-styles/${id}/sample-${crypto.randomUUID()}.jpg`, data, "image/jpeg");
    } else sample = await ctDownload(sourceUrl);
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không đọc được ảnh mẫu", 400);
  }
  const style: CtAiStyle = { ...withDefaults(row), owner: "", can_edit: true };
  let demoUrl: string;
  try {
    const out = await processPhoto({ image: sample, style: aiStyleRef(id), cutout: true, aiStyle: style });
    const png = await sharp(out.image.data).png().toBuffer();
    demoUrl = await ctUpload(`${s.user.id}/${CT_CONFIG.storagePrefix}/ai-styles/${id}/demo-${crypto.randomUUID()}.png`, png, "image/png");
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không tạo được ảnh demo", 502);
  }
  const params = { ...normalizeAiStyleParams(row.params), demoUrl, demoSourceUrl: sourceUrl };
  const { data, error } = await s.supabase.from(CT_TABLES.aiStyles).update({ params }).eq("id", id).select(COLUMNS).maybeSingle<CtAiStyleRow>();
  if (error) return jsonError(error.message, 500);
  if (!data) return jsonError("Không có quyền sửa style này", 403);
  return NextResponse.json({ style: { ...withDefaults(data), owner: data.user_id === s.user.id ? "Bạn" : data.user_id ? "Người dùng khác" : "Built-in", can_edit: true } satisfies CtAiStyle });
}

// ---------------------------------------------------------------------------
// Abuse guards
// ---------------------------------------------------------------------------

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/** CT_ALLOWED_ORIGINS unset = any origin (the caps still apply). */
export function originAllowed(origin: string | null): boolean {
  const list = (process.env.CT_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);
  if (!list.length) return true;
  return origin !== null && list.includes(origin.replace(/\/$/, ""));
}

export type AiQuota = "ok" | "ip" | "total" | "unavailable";

/**
 * Count one AI call for `ip`. Durable across serverless instances (Postgres).
 * "unavailable" = migration 003 missing or no service key → refuse rather than
 * run uncapped.
 */
export async function takeAiQuota(ip: string): Promise<AiQuota> {
  const db = ctServiceClient();
  if (!db) return "unavailable";
  const total = envInt("CT_AI_DAILY_LIMIT", 300);
  const perIp = envInt("CT_AI_IP_DAILY_LIMIT", 12);
  const ipBucket = `ip:${createHash("sha256").update(ip).digest("hex").slice(0, 32)}`;
  const { data, error } = await db.rpc("ct_ai_usage_hit", { p_buckets: [ipBucket, "all"], p_limits: [perIp, total] });
  if (error) {
    console.error("[ct] ct_ai_usage_hit failed", error.message);
    return "unavailable";
  }
  if (data === true) return "ok";
  // Which one tripped? One cheap read to give the right message.
  const { data: row } = await db
    .from("ct_ai_usage")
    .select("count")
    .eq("day", new Date().toISOString().slice(0, 10))
    .eq("bucket", "all")
    .maybeSingle<{ count: number }>();
  return (row?.count ?? 0) >= total ? "total" : "ip";
}
