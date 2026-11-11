/**
 * Storefront photo tasks (2026-11-09, asked: "tách AI style ảnh khách xong, nếu là vật liệu acrylic cần vẽ lại cho giống
 * thật thì vẽ lại thêm 1 phút nữa … các hoạt ảnh generate chạy ngầm … khách có thể làm nhiều sản phẩm mà không phải
 * đợi"): the whole chain runs here, so it goes on when the customer leaves the page.
 *
 *   POST public/tasks/:productId        multipart: file, region, style, cutout=1, mainId, selection (JSON picks),
 *                                       optionId? → 202 { task: CtPhotoTask }
 *   GET  public/tasks/:taskId           → { task }
 *   POST public/tasks/:taskId/phoi      JSON { mainId, transform, selection, optionId } → { task } — the phôi again for
 *                                       another placement / version / picks (Apply after moving the photo, a new vehicle)
 *
 *   1. style: the AI style (server/ai/photo, cached per photo + style like public/photo)
 *   2. the browser's finishing steps done here (lib/pixel-ops): white backdrop keyed out, the cropped edge faded, trimmed
 *      — the same picture lib/photo-process makes in the browser
 *   3. photo + upload stored (public, under customize-tool-orders/)
 *   4. only with the deploy's "Phôi AI có ảnh khách" tick (config.customerPhoi, off by default — 2026-11-10: it adds
 *      ~1 min; off = the browser lays the photo on the version's phôi). A version with an AI phôi (acrylic, cut to shape): the phôi drawn again WITH the photo (server/version-phoi-ref
 *      with the customer's picks → gpt-image → layer-kit register), the photo as big as its zone allows until the
 *      customer places it. Preview only: print files stay the design + khuôn + silhouette.
 *
 * Tasks live in this process's memory (like server/jobs.ts) for KEEP_MS; a restart loses them and the poll answers 404.
 */

import sharp from "sharp";
import { NextResponse } from "next/server";
import { CT_CONFIG, CT_TABLES } from "../config";
import type { CtAiStyleRef, CtPhotoTask, CtProduct, CtSelection, CtTemplate, CtTransform } from "../types";
import { normalizeRegion } from "../lib/design";
import { IDENTITY_TRANSFORM, shapeBounds } from "../lib/geometry";
import { layoutFor } from "../lib/layout";
import { faceTargets, placeFaces, type FaceTargets } from "../lib/face-center";
import { fadeCroppedEdgesData, keyOutBackdrop, opaqueBox } from "../lib/pixel-ops";
import { phoiPicks, phoiTaskKey } from "../lib/photo-task-key";
import { isAiStyleRef, styleFamily } from "../lib/photo-styles";
import { cachedAiResult, processPhoto, type PhotoJob, type PhotoResult } from "./ai/photo";
import { aiStylesConfigured } from "./ai/style-run";
import { loadAiStyle, originAllowed, takeAiQuota, type AiQuota } from "./ai-styles";
import { loadBaseProduct } from "./base-products";
import { CORS_HEADERS, photoRateLimited, publicError, publicJson, readPhotoRequest } from "./handlers";
import { ctPublicUploadPath, ctUpload } from "./storage";
import { drawPhoi, promptFor } from "./version-phoi";
import { phoiReference } from "./version-phoi-ref";
import { ctServiceClient, type CtServiceClient } from "./supabase";

const KEEP_MS = 6 * 60 * 60_000;

interface Task {
  state: CtPhotoTask;
  ip: string;
  /** Last touched (ms) — dropped KEEP_MS after. */
  at: number;
  fadeCrop: boolean;
}

const tasks = new Map<string, Task>();

function sweep(): void {
  const now = Date.now();
  for (const [id, t] of tasks) if (now - t.at > KEEP_MS) tasks.delete(id);
}

function touch(t: Task, patch: Partial<CtPhotoTask>): void {
  t.state = { ...t.state, ...patch, updatedAt: new Date().toISOString() };
  t.at = Date.now();
}

const QUOTA_TEXT: Record<Exclude<AiQuota, "ok">, string> = {
  ip: "Daily limit reached for AI styles — please try again tomorrow.",
  total: "AI styles are busy right now — please try again later.",
  unavailable: "AI styles unavailable (spend cap not configured — run migration 003)",
};

async function latestTemplate(db: CtServiceClient, productId: string): Promise<CtTemplate | null> {
  const { data } = await db
    .from(CT_TABLES.templates)
    .select("template")
    .eq("product_id", productId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle<{ template: CtTemplate }>();
  return data?.template ?? null;
}

/** The version id when it is one of the template's versions, else the template's main. */
function versionOf(tpl: CtTemplate, mainId: unknown): string {
  return typeof mainId === "string" && tpl.assets.some((a) => a.id === mainId && a.role === "main") ? mainId : tpl.mainAssetId;
}

function readTransform(raw: unknown): CtTransform {
  const t = raw as Partial<CtTransform> | null;
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  if (!t || typeof t !== "object") return { ...IDENTITY_TRANSFORM };
  return { offsetX: n(t.offsetX, 0), offsetY: n(t.offsetY, 0), scale: Math.min(8, Math.max(0.1, n(t.scale, 1))), rotation: n(t.rotation, 0) };
}

function readSelection(raw: unknown): CtSelection {
  return raw && typeof raw === "object" ? phoiPicks(raw as CtSelection) : {};
}

function parseJson(v: FormDataEntryValue | null): unknown {
  try {
    return typeof v === "string" ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}

/** Each figure of the picture centred on its safe area (lib/face-center), one scale for all; null = nothing to place. */
async function centerFaces(data: Buffer, w: number, h: number, targets: FaceTargets): Promise<Buffer | null> {
  const plan = placeFaces(data, w, h, targets);
  if (!plan) return null;
  const layers = await Promise.all(
    plan.pieces.map(async (p) => {
      const dw = Math.max(1, Math.min(plan.width, Math.round(p.dst.w)));
      const dh = Math.max(1, Math.min(plan.height, Math.round(p.dst.h)));
      const input = await sharp(data, { raw: { width: w, height: h, channels: 4 } })
        .extract({ left: p.src.x, top: p.src.y, width: p.src.w, height: p.src.h })
        .resize(dw, dh, { fit: "fill", kernel: "lanczos3" })
        .png()
        .toBuffer();
      const clamp = (v: number, size: number, room: number) => Math.max(0, Math.min(room - size, Math.round(v)));
      return { input, left: clamp(p.dst.x, dw, plan.width), top: clamp(p.dst.y, dh, plan.height) };
    }),
  );
  const background = plan.opaque ? { r: 255, g: 255, b: 255, alpha: 1 } : { r: 0, g: 0, b: 0, alpha: 0 };
  return sharp({ create: { width: plan.width, height: plan.height, channels: 4, background } }).composite(layers).png().toBuffer();
}

/** The browser's finishing steps (lib/photo-process) on the server's answer: key, fade, trim → PNG. With 2+ safe areas
 * of the khuôn in the zone (`targets`) each figure is centred on its own area instead (front + back of a doll). */
async function finishPhoto(out: PhotoResult, cutout: boolean, fadeCrop: boolean, face: boolean, targets: FaceTargets | null): Promise<Buffer> {
  const { data, info } = await sharp(out.image.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  if (out.backdrop === "white") keyOutBackdrop(data, w, h, { tolerance: 26, feather: 2 });
  if (targets) {
    const centred = await centerFaces(data, w, h, targets);
    if (centred) return centred;
  }
  if (cutout && fadeCrop && !face) fadeCroppedEdgesData(data, w, h);
  const img = sharp(data, { raw: { width: w, height: h, channels: 4 } });
  const box = cutout ? opaqueBox(data, w, h, 2) : null;
  return (box ? img.extract({ left: box.x, top: box.y, width: box.w, height: box.h }) : img).png().toBuffer();
}

/** POST public/tasks/:productId */
export async function createPhotoTask(productId: string, form: FormData, ip: string, origin: string | null): Promise<NextResponse> {
  sweep();
  const db = ctServiceClient();
  if (!db) return publicError("SUPABASE_SERVICE_ROLE_KEY chưa được cấu hình", 501);
  if (!originAllowed(origin)) return publicError("Origin not allowed", 403);
  if (photoRateLimited(ip)) return publicError("Too many requests — please wait a few minutes.", 429);
  const parsed = await readPhotoRequest(form);
  if (typeof parsed === "string") return publicError(parsed, 400);
  const tpl = await latestTemplate(db, productId);
  if (!tpl) return publicError("Sản phẩm chưa publish", 404);
  const region = tpl.regions.find((r) => r.id === parsed.regionId);
  if (!region || region.kind !== "photo") return publicError("Vùng ảnh không tồn tại", 400);
  const cfg = normalizeRegion(region).config.photo;
  const style = parsed.style;
  if (!isAiStyleRef(style) || !cfg.styles.includes(style)) return publicError("Style không được bật cho vùng này", 400);
  if (parsed.cutout && !cfg.cutout) return publicError("Vùng này không bật tách nền", 400);
  if (!aiStylesConfigured()) return publicError("AI styles are not configured (CPA_API_KEY)", 501);
  const aiStyle = await loadAiStyle(db, style);
  if (!aiStyle) return publicError("This style is no longer available", 410);
  const job: PhotoJob = { image: { data: parsed.data, mime: parsed.mime }, style: style as CtAiStyleRef, cutout: parsed.cutout, aiStyle, name: parsed.name };
  // Same photo + same style = already paid for (not counted), like public/photo.
  const hit = await cachedAiResult(job);
  if (!hit) {
    const quota = await takeAiQuota(ip);
    if (quota !== "ok") return publicError(QUOTA_TEXT[quota], quota === "unavailable" ? 503 : 429);
  }

  const id = crypto.randomUUID();
  const task: Task = {
    ip,
    at: Date.now(),
    fadeCrop: cfg.fadeCrop,
    state: { id, productId, regionId: region.id, style, stage: "style", photoUrl: null, sourceUrl: null, phoi: null, phoiPending: null, error: null, updatedAt: new Date().toISOString() },
  };
  tasks.set(id, task);
  const mainId = versionOf(tpl, form.get("mainId"));
  const selection = readSelection(parseJson(form.get("selection")));
  const optionId = typeof form.get("optionId") === "string" && form.get("optionId") ? String(form.get("optionId")) : null;
  // A khuôn with 2+ safe areas in the zone (as it sits on this version): the figures go on them.
  const targets = faceTargets(tpl.config.print, shapeBounds(layoutFor(tpl.config.layouts, mainId)?.regions[region.id]?.shape ?? region.shape));

  void (async () => {
    try {
      const out = hit ?? (await processPhoto(job));
      const png = await finishPhoto(out, parsed.cutout, cfg.fadeCrop, styleFamily(style) === "face", targets);
      const [photoUrl, sourceUrl] = await Promise.all([
        ctUpload(ctPublicUploadPath(productId, "photo", "image/png"), png, "image/png"),
        ctUpload(ctPublicUploadPath(productId, "source", parsed.mime), parsed.data, parsed.mime),
      ]);
      // The phôi with the photo only when the deploy ticked "Phôi AI có ảnh khách" (off by default, 2026-11-10).
      const hasPhoi = tpl.config.customerPhoi === true && (tpl.config.versionPhoi ?? []).some((v) => v.mainId === mainId);
      touch(task, { photoUrl, sourceUrl, stage: hasPhoi ? "phoi" : "done" });
      // Until the customer places it, the photo sits as big as its zone allows (the identity transform: contain).
      if (hasPhoi) await phoiRound(db, task, { mainId, transform: { ...IDENTITY_TRANSFORM }, selection, optionId });
    } catch (e) {
      touch(task, { stage: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  })();
  return publicJson({ task: task.state }, 202);
}

interface PhoiAsk {
  mainId: string;
  transform: CtTransform;
  selection: CtSelection;
  optionId: string | null;
}

/** The phôi of the task's photo for one design; the task goes back to "done" with or without it (the photo is ready). */
async function phoiRound(db: CtServiceClient, task: Task, ask: PhoiAsk): Promise<void> {
  const { state } = task;
  const key = phoiTaskKey(ask.mainId, state.regionId, ask.transform, ask.selection, ask.optionId);
  if (state.phoi?.key === key || state.phoiPending === key || !state.photoUrl) return;
  touch(task, { stage: "phoi", phoiPending: key, error: null });
  const quota = await takeAiQuota(task.ip);
  if (quota !== "ok") {
    if (task.state.phoiPending === key) touch(task, { stage: "done", phoiPending: null, error: QUOTA_TEXT[quota] });
    return;
  }
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data: product } = await db.from(CT_TABLES.products).select("*").eq("id", state.productId).maybeSingle<CtProduct>();
      if (!product?.base_product_id) throw new Error("Sản phẩm không có product base");
      const base = await loadBaseProduct(db, product.base_product_id);
      if (!base || base.config.cut.mode !== "alpha") throw new Error("Base không cắt theo viền thiết kế");
      const selection: CtSelection = { ...ask.selection, [state.regionId]: { kind: "photo", url: state.photoUrl, transform: ask.transform, optionId: ask.optionId } };
      const ref = await phoiReference(db, state.productId, base, ask.mainId, { selection });
      const dir = `${CT_CONFIG.storagePrefix}-orders/${state.productId}/${new Date().toISOString().slice(0, 10)}/phoi-${state.id}`;
      const refUrl = await ctUpload(`${dir}/ref-${crypto.randomUUID()}.png`, ref.ref, "image/png");
      const out = await drawPhoi({ ref: ref.ref, refUrl, mask: ref.mask, box: ref.box, prompt: promptFor(base.config.material, base.config.cut.hole), dir, name: ask.mainId });
      const latest = task.state.phoiPending === key;
      touch(task, { phoi: { key, mainId: ask.mainId, ...out }, ...(latest ? { phoiPending: null, stage: "done" as const } : {}) });
      return;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
  }
  console.warn(`[ct] phôi khách ${state.id}: ${last}`);
  if (task.state.phoiPending === key) touch(task, { phoiPending: null, stage: "done", error: last });
}

/** GET public/tasks/:taskId */
export function photoTaskStatus(id: string): NextResponse {
  sweep();
  const task = tasks.get(id);
  if (!task) return publicError("This preview is no longer on the server — please upload the photo again.", 404);
  return NextResponse.json({ task: task.state }, { headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
}

/** POST public/tasks/:taskId/phoi */
export async function requestTaskPhoi(id: string, body: unknown, origin: string | null): Promise<NextResponse> {
  sweep();
  const db = ctServiceClient();
  if (!db) return publicError("SUPABASE_SERVICE_ROLE_KEY chưa được cấu hình", 501);
  if (!originAllowed(origin)) return publicError("Origin not allowed", 403);
  const task = tasks.get(id);
  if (!task) return publicError("This preview is no longer on the server — please upload the photo again.", 404);
  if (!task.state.photoUrl) return publicError("The photo is not ready yet", 409);
  const b = (body ?? {}) as { mainId?: unknown; transform?: unknown; selection?: unknown; optionId?: unknown };
  const tpl = await latestTemplate(db, task.state.productId);
  if (!tpl) return publicError("Sản phẩm chưa publish", 404);
  const mainId = versionOf(tpl, b.mainId);
  if (tpl.config.customerPhoi !== true || !(tpl.config.versionPhoi ?? []).some((v) => v.mainId === mainId)) return publicJson({ task: task.state });
  const ask: PhoiAsk = { mainId, transform: readTransform(b.transform), selection: readSelection(b.selection), optionId: typeof b.optionId === "string" && b.optionId ? b.optionId : null };
  // phoiRound marks the round pending before its first await: the answer already shows it.
  void phoiRound(db, task, ask);
  return publicJson({ task: task.state });
}
