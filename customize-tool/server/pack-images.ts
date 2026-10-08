/**
 * Thư viện ảnh tổ hợp (ct_pack_images, migrations 015–016) — the photos tổ hợp Image frames use, kept so editors
 * reuse them and the @flexiprint agent finds them (MCP list_pack_images) before searching the web or generating more.
 *
 *   GET    library/pack-images?q=&scope=all|mine|ai&limit=   → { images } newest first (listed ones)
 *   POST   library/pack-images            multipart file, name → { image }  (saved as <name>_<timestamp>.<ext>)
 *   POST   library/pack-images/generate   multipart description, aspect, refs (urls JSON), ref files, prompt?,
 *                                         parent_id?, transparent? → { image } status "running", then "done" /
 *                                         "failed" — poll GET …/:id. With `prompt` (the editor edited one) it is
 *                                         drawn as written; without, a one-shot LLM writes it (used only when
 *                                         @flexiprint is unreachable — the dialog sends requests to the agent,
 *                                         server/agent/tasks.ts kind pack_image). parent_id = the photo it edits.
 *   GET    library/pack-images/:id        → { image }
 *   DELETE library/pack-images/:id        owner or admin (RLS)
 *   GET    library/pack-collections       → { collections } the editor's bộ ảnh (migration 017)
 *   POST   library/pack-collections       {name} → { collection }
 *   PATCH  library/pack-collections/:id   {name}
 *
 * drawPackImage draws one photo (Nano Banana 2, references; a layer is drawn on chroma green and keyed out) — the
 * agent's MCP tool generate_pack_image and the direct path share it.
 *
 * Env: FAL_KEY (prompt LLM + fal image models), CPA_API_KEY / CPA_BASE_URL (company image API).
 */

import { NextResponse } from "next/server";
import { CT_CONFIG, CT_TABLES } from "../config";
import type { CtPackCollection, CtPackImage, CtPackImageAspect } from "../types";
import { fileStem, IMAGE_EXT } from "../lib/file-name";
import { askLlm, jsonObject, readSavedRefs, str } from "./ai/llm";
import sharp from "sharp";
import { readImageInfo } from "./image-size";
import { isOwnUploadUrl } from "./library";
import { ctServiceClient, type CtSession } from "./supabase";
import { ctRemove, ctUpload } from "./storage";
import { currentImageModel } from "./settings";
import { CT_IMAGE_MODELS } from "../lib/image-models";

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_REFS = 6;
const ASPECTS: CtPackImageAspect[] = ["1:1", "4:5", "3:4", "2:3", "4:3", "3:2", "16:9", "9:16"];

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

function storageKey(userId: string, stem: string, mime: string, folder = "pack-library"): string {
  return `${userId}/${CT_CONFIG.storagePrefix}/${folder}/${stem}_${Date.now()}.${IMAGE_EXT[mime] ?? "png"}`;
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
  if (scope === "ai") q = q.eq("source", "ai");
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
// Tạo ảnh với AI
// ---------------------------------------------------------------------------

const PROMPT_SYSTEM = `You write image-generation prompts for FlexiPrint's "tổ hợp" editor, where editors compose product mockups by hand: they need photos such as backgrounds and scenes (a Christmas tree with bokeh, a desk, a car interior), hands holding something, props and textures, which product pictures are later placed on top of.

You get the editor's request (often Vietnamese) and possibly reference photos, numbered in the order given.

Write ONE prompt in English for an image model (Gemini image / Nano Banana) that:
- describes the photo concretely: subject, setting, materials, lighting (direction, softness, colour temperature), camera (angle, lens, depth of field), composition and mood — photorealistic unless the request says otherwise;
- says exactly what to take from each reference ("Reference image 1: …") — its subject, its style, its colours or its layout — as the request implies; references are not copied wholesale unless asked;
- keeps clear, uncluttered space where a product will go when the photo is a background or scene (say where: centre, lower third…);
- has no text, logos, watermarks or borders unless the request asks for them;
- never adds a product the request did not ask for.
- when the request has "Yêu cầu riêng cho ảnh này (ưu tiên)", that wins over "Yêu cầu chung" wherever they disagree; Reference image 1 is then the photo being edited — keep everything the request does not ask to change (pose, framing, skin, lighting).

Answer with JSON only: {"name": "<short file-friendly name, ≤ 40 characters, in the request's language>", "prompt": "<the prompt>"}`;

interface FalImageResponse {
  images?: Array<{ url?: string; content_type?: string }>;
  detail?: string | Array<{ msg?: string }>;
}

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
async function drawCpa(model: string, prompt: string, refs: string[], aspect: string, fit: "crop" | "pad" = "crop"): Promise<{ data: Buffer; mime: string }> {
  const key = process.env.CPA_API_KEY;
  if (!key) throw new Error("Chưa cấu hình CPA_API_KEY");
  const base = (process.env.CPA_BASE_URL || "https://cpa.next.lc/v1").replace(/\/+$/, "");
  const { size, ratio } = cpaSize(aspect);
  const images = await Promise.all(
    refs.slice(0, 8).map(async (u) => {
      const r = await fetch(u, { signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`Ảnh tham khảo ${r.status}`);
      const mime = r.headers.get("content-type")?.split(";")[0] ?? "image/png";
      return { image_url: `data:${mime};base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}` };
    }),
  );
  const res = await fetch(`${base}/images/${images.length ? "edits" : "generations"}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, size, ...(images.length ? { images } : {}) }),
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
  const img = sharp(Buffer.from(b64, "base64"));
  const meta = await img.metadata();
  const W = meta.width ?? 1024;
  const H = meta.height ?? 1024;
  if (fit === "pad") {
    const w = Math.max(W, Math.round(H * ratio));
    const h = Math.max(H, Math.round(W / ratio));
    const left = Math.floor((w - W) / 2);
    const top = Math.floor((h - H) / 2);
    const data = await img.extend({ left, right: w - W - left, top, bottom: h - H - top, background: "#ffffff" }).png().toBuffer();
    return { data, mime: "image/png" };
  }
  const w = Math.min(W, Math.round(H * ratio));
  const h = Math.min(H, Math.round(W / ratio));
  const data = await img.extract({ left: Math.floor((W - w) / 2), top: Math.floor((H - h) / 2), width: w, height: h }).png().toBuffer();
  return { data, mime: "image/png" };
}

/** One photo with `model` (a lib/image-models id: "cpa:<model>" or "fal:<endpoint>/edit"). */
export async function drawImage(model: string, prompt: string, refs: string[], aspect: string, fit: "crop" | "pad" = "crop"): Promise<{ data: Buffer; mime: string }> {
  if (model.startsWith("cpa:")) return drawCpa(model.slice(4), prompt, refs, aspect, fit);
  return drawFal(model.replace(/^fal:/, "").replace(/\/edit$/, ""), prompt, refs, aspect);
}

async function drawFal(model: string, prompt: string, refs: string[], aspect: string): Promise<{ data: Buffer; mime: string }> {
  const key = process.env.FAL_KEY;
  if (!key) throw new Error("Chưa cấu hình FAL_KEY");
  const endpoint = refs.length ? `${model}/edit` : model;
  // "auto" (an in-place edit): the model keeps the input picture's own size and framing.
  const input: Record<string, unknown> = { prompt, num_images: 1, ...(aspect === "auto" ? {} : { aspect_ratio: aspect }), output_format: "png", ...(refs.length ? { image_urls: refs } : {}) };
  if (model === "fal-ai/nano-banana-2") input.resolution = "2K";
  const res = await fetch(`https://fal.run/${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(240_000),
  });
  const json = (await res.json().catch(() => ({}))) as FalImageResponse;
  if (!res.ok) {
    const d = json.detail;
    const msg = typeof d === "string" ? d : Array.isArray(d) ? d.map((x) => x.msg ?? "").join("; ") : "";
    throw new Error(`fal.ai ${res.status}: ${(msg || "lỗi").slice(0, 300)}`);
  }
  const out = json.images?.[0];
  if (!out?.url) throw new Error("fal.ai không trả ảnh");
  if (out.url.startsWith("data:")) {
    const [head, b64] = out.url.split(",", 2);
    return { data: Buffer.from(b64 ?? "", "base64"), mime: head.slice(5).split(";")[0] || "image/png" };
  }
  const file = await fetch(out.url, { signal: AbortSignal.timeout(60_000) });
  if (!file.ok) throw new Error(`fal.ai output ${file.status}`);
  return { data: Buffer.from(await file.arrayBuffer()), mime: file.headers.get("content-type")?.split(";")[0] ?? out.content_type ?? "image/png" };
}

type Db = CtSession["supabase"] | NonNullable<ReturnType<typeof ctServiceClient>>;

/**
 * A layer is drawn on chroma green and keyed out here. A matting model (rembg / BiRefNet) looks for one salient
 * object and drops what it is unsure of — a thumb entering from the corner lost its skin and kept only the nail.
 */
const LAYER_BACKDROP =
  " Shot against a perfectly uniform, flat pure chroma-key green (#00FF00) background that fills the whole frame: evenly lit, no gradient, no shadow on the background, no green reflections or green tint on the subject, nothing green in the subject. Nothing else in frame.";

/** Key the green backdrop out → PNG with alpha: soft edge, the backdrop's colour taken out of the edge, no spill. */
async function chromaKey(input: Buffer): Promise<{ data: Buffer; mime: string }> {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  // The backdrop: the median colour of the border pixels.
  const border: number[] = [];
  for (let x = 0; x < w; x += 4) border.push((0 * w + x) * 4, ((h - 1) * w + x) * 4);
  for (let y = 0; y < h; y += 4) border.push((y * w) * 4, (y * w + w - 1) * 4);
  const median = (c: number) => {
    const v = border.map((i) => data[i + c]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)] ?? 0;
  };
  const K = [median(0), median(1), median(2)];
  const key = Math.max(60, K[1] - Math.max(K[0], K[2]));
  const lo = key * 0.18;
  const hi = key * 0.6;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];
    const e = g - Math.max(r, b);
    if (e <= lo) continue;
    // Opaque below lo, clear above hi, soft between.
    const a = e >= hi ? 0 : 1 - (e - lo) / (hi - lo);
    data[i + 3] = Math.round(data[i + 3] * a);
    if (a <= 0) continue;
    // An edge pixel is subject + backdrop mixed: take the backdrop out, then cap what green is left.
    r = (r - (1 - a) * K[0]) / a;
    g = (g - (1 - a) * K[1]) / a;
    b = (b - (1 - a) * K[2]) / a;
    data[i] = Math.max(0, Math.min(255, Math.round(r)));
    data[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
    data[i + 1] = Math.max(0, Math.min(255, Math.round(Math.min(g, Math.max(r, b)))));
  }
  const out = await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  return { data: out, mime: "image/png" };
}

export interface PackImageDraw {
  name: string;
  prompt: string;
  /** Reference photo urls (our storage), in order: "Reference image 1" is the first. */
  refs: string[];
  aspect: string;
  /** Cut the background out (a layer). */
  transparent: boolean;
}

/**
 * Draw one photo → its file, uploaded (cut out when `transparent`): the team's image model (home page), then the
 * others in list order if it fails.
 */
export async function drawPackImage(userId: string, d: PackImageDraw): Promise<Pick<CtPackImage, "url" | "storage_path" | "mime" | "width" | "height" | "model">> {
  const prompt = d.transparent ? d.prompt + LAYER_BACKDROP : d.prompt;
  let lastError: unknown = null;
  const picked = await currentImageModel();
  for (const model of [picked, ...CT_IMAGE_MODELS.map((m) => m.id).filter((m) => m !== picked)]) {
    try {
      let out = await drawImage(model, prompt, d.refs, d.aspect);
      if (d.transparent) out = await chromaKey(out.data);
      const info = readImageInfo(out.data);
      const mime = info?.mime ?? out.mime;
      const path = storageKey(userId, fileStem(d.name), mime);
      const url = await ctUpload(path, out.data, mime);
      return { url, storage_path: path, mime, width: info?.width ?? null, height: info?.height ?? null, model };
    } catch (e) {
      lastError = e;
      console.warn(`[ct] pack image "${d.name}": ${model} failed — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Tạo ảnh thất bại");
}

/**
 * The other hand: a photo flipped left ↔ right, pixel for pixel. Image models asked to "mirror" a reference hand it
 * back unflipped (a "right hand" that was the left one again), so the flip is never the model's job.
 */
export async function mirrorPackImage(userId: string, name: string, url: string): Promise<Pick<CtPackImage, "url" | "storage_path" | "mime" | "width" | "height" | "model">> {
  if (!isOwnUploadUrl(url)) throw new Error("Not a FlexiPrint image url");
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const src = sharp(Buffer.from(await res.arrayBuffer()));
  const meta = await src.metadata();
  const jpeg = meta.format === "jpeg" && !meta.hasAlpha;
  const data = await (jpeg ? src.flop().jpeg({ quality: 95 }) : src.flop().png()).toBuffer();
  const mime = jpeg ? "image/jpeg" : "image/png";
  const path = storageKey(userId, fileStem(name), mime);
  const out = await ctUpload(path, data, mime);
  return { url: out, storage_path: path, mime, width: meta.width ?? null, height: meta.height ?? null, model: "mirror" };
}

/** The fallback prompt writer (one LLM call) — only when the agent can't be reached. */
async function writePrompt(description: string, refs: string[], aspect: string): Promise<{ name: string; prompt: string }> {
  const seen = await readSavedRefs(refs);
  const reply = await askLlm(PROMPT_SYSTEM, `Editor's request:\n${description}\n\nAspect ratio: ${aspect}\nReference photos attached: ${seen.length}`, seen);
  if (typeof reply !== "string") throw new Error("Không viết được prompt (LLM lỗi)");
  const parsed = jsonObject(reply);
  const prompt = str(parsed?.prompt).trim() || reply.trim();
  if (!prompt) throw new Error("LLM không trả prompt");
  return { name: str(parsed?.name).trim().slice(0, 200), prompt };
}

/** The direct generation, after the request has answered: prompt (given or written) → photo → row done / failed. */
async function runGeneration(db: Db, userId: string, image: CtPackImage, given: string): Promise<void> {
  const update = (patch: Partial<CtPackImage>) => db.from(CT_TABLES.packImages).update(patch).eq("id", image.id);
  try {
    let { name, prompt } = image;
    if (!given) {
      const w = await writePrompt(image.description, image.refs, image.aspect);
      prompt = w.prompt;
      name = w.name || name;
      await update({ prompt, name });
    }
    const file = await drawPackImage(userId, { name, prompt, refs: image.refs, aspect: image.aspect, transparent: image.transparent });
    await update({ ...file, status: "done", error: "" });
  } catch (e) {
    await update({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 1000) });
  }
}

/** POST library/pack-images/generate */
export async function generatePackImage(s: CtSession, form: FormData): Promise<NextResponse> {
  if (!process.env.FAL_KEY) return jsonError("Chưa cấu hình FAL_KEY", 501);
  const description = str(form.get("description")).trim().slice(0, 4000);
  const given = str(form.get("prompt")).trim().slice(0, 8000);
  if (!description && !given) return jsonError("Mô tả ảnh cần tạo", 400);
  const aspectRaw = str(form.get("aspect"));
  const aspect = ASPECTS.includes(aspectRaw as CtPackImageAspect) ? aspectRaw : "1:1";
  const transparent = str(form.get("transparent")) === "1";
  const collectionId = /^[0-9a-f-]{36}$/i.test(str(form.get("collection_id"))) ? str(form.get("collection_id")) : null;

  // The photo it edits goes first ("Reference image 1").
  const parentId = str(form.get("parent_id"));
  let parent: CtPackImage | null = null;
  if (parentId) {
    const { data } = await s.supabase.from(CT_TABLES.packImages).select("*").eq("id", parentId).maybeSingle<CtPackImage>();
    if (!data?.url) return jsonError("Không tìm thấy ảnh gốc để chỉnh", 404);
    parent = data;
  }
  // References: photos already in our storage (library picks), plus files uploaded with the request.
  let refs: string[] = parent?.url ? [parent.url] : [];
  try {
    const listed = JSON.parse(str(form.get("refs")) || "[]") as unknown;
    if (Array.isArray(listed)) refs.push(...listed.filter(isOwnUploadUrl));
  } catch {
    return jsonError("refs không hợp lệ", 400);
  }
  for (const f of form.getAll("ref")) {
    if (refs.length >= MAX_REFS) break;
    const file = await readUpload(f);
    if (typeof file === "string") return jsonError(file, 400);
    try {
      refs.push(await ctUpload(storageKey(s.user.id, "ref", file.mime, "pack-library/refs"), file.data, file.mime));
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : "Upload ảnh tham khảo thất bại", 500);
    }
  }
  refs = [...new Set(refs)].slice(0, MAX_REFS);

  const { data, error } = await s.supabase
    .from(CT_TABLES.packImages)
    .insert({
      user_id: s.user.id,
      name: (parent?.name ?? description).slice(0, 60) || "Ảnh AI",
      source: "ai",
      status: "running",
      description: description || parent?.description || "",
      prompt: given,
      refs,
      aspect,
      transparent,
      parent_id: parent?.id ?? null,
      collection_id: collectionId ?? parent?.collection_id ?? null,
    })
    .select("*")
    .single<CtPackImage>();
  if (error || !data) return jsonError(error?.message ?? "Lưu thất bại", 500);
  if (data.collection_id) await touchCollection(s.supabase, data.collection_id);
  // Runs on after the answer; the dialog polls the row. The service client outlives the user's request.
  void runGeneration(ctServiceClient() ?? s.supabase, s.user.id, row(data), given);
  return NextResponse.json({ image: row(data) }, { status: 202 });
}

// ---------------------------------------------------------------------------
// Bộ ảnh
// ---------------------------------------------------------------------------

/** A bộ moves to the top of the list when something happens in it. */
export async function touchCollection(db: Db, id: string): Promise<void> {
  await db.from(CT_TABLES.packCollections).update({ updated_at: new Date().toISOString() }).eq("id", id);
}

/** GET library/pack-collections — the editor's own, latest activity first. */
export async function listPackCollections(s: CtSession): Promise<NextResponse> {
  const { data, error } = await s.supabase.from(CT_TABLES.packCollections).select("*").eq("user_id", s.user.id).order("updated_at", { ascending: false }).limit(200).returns<CtPackCollection[]>();
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ collections: data ?? [] });
}

/** POST library/pack-collections */
export async function createPackCollection(s: CtSession, body: unknown): Promise<NextResponse> {
  const name = str((body as { name?: unknown } | null)?.name).trim().slice(0, 120);
  if (!name) return jsonError("Đặt tên cho bộ ảnh", 400);
  const { data, error } = await s.supabase.from(CT_TABLES.packCollections).insert({ user_id: s.user.id, name }).select("*").single<CtPackCollection>();
  if (error || !data) return jsonError(error?.message ?? "Không tạo được bộ ảnh", 500);
  return NextResponse.json({ collection: data }, { status: 201 });
}

/** PATCH library/pack-collections/:id */
export async function renamePackCollection(s: CtSession, id: string, body: unknown): Promise<NextResponse> {
  const name = str((body as { name?: unknown } | null)?.name).trim().slice(0, 120);
  if (!name) return jsonError("Đặt tên cho bộ ảnh", 400);
  const { data, error } = await s.supabase.from(CT_TABLES.packCollections).update({ name }).eq("id", id).select("*").maybeSingle<CtPackCollection>();
  if (error) return jsonError(error.message, 500);
  return data ? NextResponse.json({ collection: data }) : jsonError("Không đổi được tên bộ ảnh này", 403);
}
