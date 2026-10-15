/**
 * Thư viện ảnh mockup (ct_pack_images, migrations 015–016) — the photos the Mockups tab's Image frames use, uploaded
 * by hand and kept so editors reuse them.
 *
 *   GET    library/pack-images?q=&scope=all|mine&limit=   → { images } newest first (listed ones)
 *   POST   library/pack-images            multipart file, name → { image }  (saved as <name>_<timestamp>.<ext>)
 *   GET    library/pack-images/:id        → { image }
 *   DELETE library/pack-images/:id        owner or admin (RLS)
 *
 * drawImage (one picture from the team's image model) lives here too: the v2 bộ nhân vật draws its masters with it
 * (server/char/projects.ts).
 *
 * Env: CPA_API_KEY / CPA_BASE_URL (company image API).
 */

import { NextResponse } from "next/server";
import { CT_CONFIG, CT_TABLES } from "../config";
import type { CtPackImage } from "../types";
import { fileStem, IMAGE_EXT } from "../lib/file-name";
import { str } from "./ai/llm";
import sharp from "sharp";
import { readImageInfo } from "./image-size";
import type { CtSession } from "./supabase";
import { ctRemove, ctUpload } from "./storage";

const MAX_BYTES = 25 * 1024 * 1024;

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

function storageKey(userId: string, stem: string, mime: string): string {
  return `${userId}/${CT_CONFIG.storagePrefix}/pack-library/${stem}_${Date.now()}.${IMAGE_EXT[mime] ?? "png"}`;
}

function row(raw: CtPackImage): CtPackImage {
  return { ...raw, refs: Array.isArray(raw.refs) ? raw.refs.filter((u): u is string => typeof u === "string") : [] };
}

/** GET library/pack-images */
export async function listPackImages(s: CtSession, params: URLSearchParams): Promise<NextResponse> {
  const scope = params.get("scope");
  const limit = Math.min(Math.max(Number(params.get("limit")) || 300, 1), 500);
  let q = s.supabase.from(CT_TABLES.packImages).select("*").eq("listed", true).order("created_at", { ascending: false }).limit(limit);
  const collection = params.get("collection");
  if (collection && /^[0-9a-f-]{36}$/i.test(collection)) q = q.eq("collection_id", collection);
  if (scope === "mine") q = q.eq("user_id", s.user.id).eq("source", "upload");
  const words = (params.get("q") ?? "").trim();
  if (words) {
    const like = `%${words.replace(/[%_,()]/g, " ")}%`;
    q = q.or(`name.ilike.${like},description.ilike.${like}`);
  }
  const { data, error } = await q.returns<CtPackImage[]>();
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ images: (data ?? []).map(row) });
}

/** GET library/pack-images/:id */
export async function getPackImage(s: CtSession, id: string): Promise<NextResponse> {
  const { data, error } = await s.supabase.from(CT_TABLES.packImages).select("*").eq("id", id).maybeSingle<CtPackImage>();
  if (error) return jsonError(error.message, 500);
  return data ? NextResponse.json({ image: row(data) }) : jsonError("Không tìm thấy ảnh", 404);
}

async function readUpload(file: FormDataEntryValue | null): Promise<{ data: Buffer; mime: string; width: number; height: number } | string> {
  if (!(file instanceof Blob)) return "Thiếu file";
  if (file.size > MAX_BYTES) return "Ảnh quá lớn (tối đa 25MB)";
  const data = Buffer.from(await file.arrayBuffer());
  const info = readImageInfo(data);
  if (!info) return "Trình duyệt này không mở được định dạng ảnh này — thử Chrome/Safari mới hoặc đổi sang PNG/JPEG";
  return { data, mime: info.mime, width: info.width, height: info.height };
}

/** POST library/pack-images — multipart file + name. */
export async function uploadPackLibraryImage(s: CtSession, form: FormData): Promise<NextResponse> {
  const file = await readUpload(form.get("file"));
  if (typeof file === "string") return jsonError(file, 400);
  const name = str(form.get("name")).trim().slice(0, 200) || "Ảnh";
  const path = storageKey(s.user.id, fileStem(name), file.mime);
  let url: string;
  try {
    url = await ctUpload(path, file.data, file.mime);
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Upload thất bại", 500);
  }
  const { data, error } = await s.supabase
    .from(CT_TABLES.packImages)
    .insert({ user_id: s.user.id, name, source: "upload", status: "done", url, storage_path: path, mime: file.mime, width: file.width, height: file.height })
    .select("*")
    .single<CtPackImage>();
  if (error || !data) {
    await ctRemove([path]);
    return jsonError(error?.message ?? "Lưu thất bại", 500);
  }
  return NextResponse.json({ image: row(data) }, { status: 201 });
}

/** DELETE library/pack-images/:id — the row (RLS: owner or admin) and its file. */
export async function deletePackImage(s: CtSession, id: string): Promise<NextResponse> {
  const { data, error } = await s.supabase.from(CT_TABLES.packImages).delete().eq("id", id).select("storage_path").returns<Array<Pick<CtPackImage, "storage_path">>>();
  if (error) return jsonError(error.message, 500);
  if (!data?.length) return jsonError("Chỉ người tạo hoặc admin mới được xoá ảnh này", 403);
  await ctRemove(data.map((d) => d.storage_path ?? ""));
  return new NextResponse(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// One picture from an image model (v2 bộ nhân vật masters)
// ---------------------------------------------------------------------------

interface CpaImageResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
  error?: { message?: string } | string;
}

/** gpt-image sizes: square, landscape, portrait — the photo is then cropped to the asked aspect. */
function cpaSize(aspect: string): { size: string; ratio: number } {
  const [w, h] = aspect.split(":").map(Number);
  const ratio = w > 0 && h > 0 ? w / h : 1;
  return { size: ratio === 1 ? "1024x1024" : ratio > 1 ? "1536x1024" : "1024x1536", ratio };
}

/** The company image API (OpenAI-compatible, like services/comfy providers._cpa): references go as data URIs. */
async function drawCpa(model: string, prompt: string, refs: string[], aspect: string, fit: "crop" | "pad" = "crop", transparent = false): Promise<{ data: Buffer; mime: string }> {
  const key = process.env.CPA_API_KEY;
  if (!key) throw new Error("Chưa cấu hình CPA_API_KEY");
  const base = (process.env.CPA_BASE_URL || "https://cpa.next.lc/v1").replace(/\/+$/, "");
  const { size, ratio } = cpaSize(aspect);
  const images = await Promise.all(
    refs.slice(0, 8).map(async (u) => {
      const r = await fetch(u, { signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`Ảnh tham khảo ${r.status}`);
      const mime = r.headers.get("content-type")?.split(";")[0] ?? "image/png";
      const raw = Buffer.from(await r.arrayBuffer());
      // A cut-out picture edited into an opaque one: on white. Sent transparent, gpt-image paints the empty canvas
      // black with a glow of the figure's colours (tested 2026-10-10) — the edit then no longer matches the master.
      if (!transparent && (await sharp(raw).metadata()).hasAlpha) {
        const flat = await sharp(raw).flatten({ background: "#ffffff" }).png().toBuffer();
        return { image_url: `data:image/png;base64,${flat.toString("base64")}` };
      }
      return { image_url: `data:${mime};base64,${raw.toString("base64")}` };
    }),
  );
  const res = await fetch(`${base}/images/${images.length ? "edits" : "generations"}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, size, quality: "high", ...(transparent ? { background: "transparent", output_format: "png" } : {}), ...(images.length ? { images } : {}) }),
    signal: AbortSignal.timeout(300_000),
  });
  const json = (await res.json().catch(() => ({}))) as CpaImageResponse;
  if (!res.ok) {
    const msg = typeof json.error === "string" ? json.error : (json.error?.message ?? "lỗi");
    throw new Error(`cpa ${res.status}: ${msg.slice(0, 300)}`);
  }
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error("cpa không trả ảnh");
  // Cropped (centre) to the exact aspect the frame wants — or, for a picture nothing may be cut from (a master
  // character sheet on white), padded with white to it.
  let raw: Buffer = Buffer.from(b64, "base64");
  if (transparent) {
    await assertTransparent(raw);
    raw = await solidAlpha(raw);
  }
  const img = sharp(raw);
  const meta = await img.metadata();
  const W = meta.width ?? 1024;
  const H = meta.height ?? 1024;
  if (fit === "pad") {
    const w = Math.max(W, Math.round(H * ratio));
    const h = Math.max(H, Math.round(W / ratio));
    const left = Math.floor((w - W) / 2);
    const top = Math.floor((h - H) / 2);
    const padded = await img.extend({ left, right: w - W - left, top, bottom: h - H - top, background: transparent ? { r: 0, g: 0, b: 0, alpha: 0 } : "#ffffff" }).png().toBuffer();
    return { data: await exactSquare(padded, ratio), mime: "image/png" };
  }
  const w = Math.min(W, Math.round(H * ratio));
  const h = Math.min(H, Math.round(W / ratio));
  const data = await img.extract({ left: Math.floor((W - w) / 2), top: Math.floor((H - h) / 2), width: w, height: h }).png().toBuffer();
  return { data: await exactSquare(data, ratio), mime: "image/png" };
}

/** A square picture is exactly 1024×1024 (gpt-image hands back 1027² now and then): every picture of a set on one
 * canvas, so registration only undoes the model's own drift (asked 2026-10-12). */
async function exactSquare(png: Buffer, ratio: number): Promise<Buffer> {
  if (ratio !== 1) return png;
  const m = await sharp(png).metadata();
  if (m.width === SQUARE && m.height === SQUARE) return png;
  return sharp(png).resize(SQUARE, SQUARE, { fit: "fill", kernel: "lanczos3" }).png().toBuffer();
}

const SQUARE = 1024;

/**
 * gpt-image's cut-outs are not quite opaque inside: alpha 253 all over the figure (measured 2026-10-12) — a checker
 * showed faintly through every face. The figure's own level becomes 255; the soft edge is scaled with it.
 */
async function solidAlpha(png: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const hist = new Array<number>(256).fill(0);
  for (let i = 3; i < data.length; i += 4) hist[data[i]]++;
  // The figure's level: the most common alpha above 200.
  let level = 255;
  for (let v = 201, best = 0; v < 256; v++) if (hist[v] > best) (best = hist[v]), (level = v);
  if (level >= 255) return png;
  const k = 255 / level;
  for (let i = 3; i < data.length; i += 4) data[i] = Math.min(255, Math.round(data[i] * k));
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

/**
 * A picture asked with a transparent background really has one: gpt-image now and then paints a checkerboard (or
 * white) instead — that picture is refused (the caller tries again).
 */
async function assertTransparent(png: Buffer): Promise<void> {
  const { data, info } = await sharp(png).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  let clear = 0;
  for (let i = 0; i < data.length; i++) if (data[i] < 8) clear++;
  if (clear < info.width * info.height * 0.02) throw new Error("Ảnh không có nền trong suốt thật (model vẽ nền) — chạy lại");
}

/** One picture with `model` (lib/image-models CT_IMAGE_MODEL, "cpa:<model>" — the only one). */
export async function drawImage(model: string, prompt: string, refs: string[], aspect: string, fit: "crop" | "pad" = "crop", transparent = false): Promise<{ data: Buffer; mime: string }> {
  if (!model.startsWith("cpa:")) throw new Error(`Model ảnh không hỗ trợ: ${model}`);
  return drawCpa(model.slice(4), prompt, refs, aspect, fit, transparent);
}
