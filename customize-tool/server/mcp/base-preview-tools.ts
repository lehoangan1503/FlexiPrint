/**
 * Base preview tasks (kind base_preview, asked 2026-11-17: "khi 1 sản phẩm khác hoặc product base loại khác cũng bị
 * trường hợp artwork không hiển thị đầy đủ trên preview thì có thể tự phân tích … phải gửi flexiprint phân tích như cách
 * chúng ta soi code rồi làm thì kết quả mới tốt được"). The base page's "Gửi @flexiprint" hands the base to the agent:
 * it measures what the preview hides, looks at real designs on it, writes the place / mood of new photos, draws them
 * (base-scenes: the size, the magenta face, the keying stay the system's), checks each and recommends one.
 *
 *   base_preview_check     {task_id, base_id} → the preview + every scene: pictures, hidden share per side, facts
 *   render_base_preview    {task_id, base_id, scene_id?, product_id?} → a product's design laid on a scene (picture)
 *   make_base_scene        {task_id, base_id, prompt | preset} → job (background, 1–3 min; added to the base's scenes)
 *   base_scene_status      {task_id, job_id} → waits ≤ 50 s → the scene + its hidden shares, or still running
 *   set_base_preview       {task_id, base_id, scene_id} → that scene = the base's preview (products re-laid in flexi2;
 *                          the store keeps the old one until the editor clicks "Cập nhật store")
 *   submit_result          {summary, scene_id, applied} → submitBasePreviewResult
 */

import sharp, { type OverlayOptions } from "sharp";
import { CT_CONFIG, CT_TABLES } from "../../config";
import type { CtAgentTask, CtBasePreviewResult, CtBaseProduct, CtBaseScene, CtBaseScenePreset, CtProduct, CtProductScene, CtSideLoss } from "../../types";
import { normalizeProductConfig } from "../../lib/design";
import { clip, str } from "../ai/llm";
import { serviceSession } from "../char/product";
import { fetchImage } from "../char/files";
import { loadBaseProduct } from "../base-products";
import { previewLoss, sceneJob, startSceneJob } from "../base-scenes";
import { baseStoreState, setBasePreview } from "../base-republish";
import { ctUpload } from "../storage";
import type { CtServiceClient } from "../supabase";
import { TASK_ARG, json, liveStatus, loadTask, openTask } from "./task-common";
import type { CtMcpContext, CtMcpTool } from "./tools";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Drawings one task may ask for (each is a paid gpt-image call). */
const MAX_DRAWINGS = 6;
const PRESETS: CtBaseScenePreset[] = ["home", "holiday", "minimal"];

const INSTRUCTIONS = [
  "Goal: the product base's STORE PREVIEW (the photo every product on this base is shown on: phôi trơn + overlay + the print sheet's box) must show as much of the artwork as possible — each side hidden ≤ 3 % (never cut a title or a name) — and be an appealing, believable photo for this kind of product that suits the designs sold on it. Follow the editor's request first.",
  "1. base_preview_check: the current preview, every scene already made (pictures, hidden share per side, preset / prompt), the base's facts, the khuôn aspect, sample products. view_image the current preview and 1–2 render_base_preview pictures (a real design laid on it: what the customer sees).",
  "2. Analyse like a developer reading the code, not like a prompt writer guessing: WHY is the artwork hidden or the photo weak? (the product is small in the frame; a person / hands / props cover it; the fabric curves or folds away; the photo's product has another aspect than the khuôn; the box sits off the product; the scene does not suit the designs…) Say it in report_progress.",
  "3. How a drawing works (server/base-scenes.ts): for a base whose phôi has a fulfiller OVERLAY and a flat rectangular product (blankets…), the model gets a layout guide — a MAGENTA rectangle with the khuôn's aspect, 86 % of the frame high, on plain grey — and draws the product hanging straight / displayed flat there, no person; the magenta face is keyed back into phôi trơn + overlay + box, so the box = the product face and almost nothing is hidden. Other bases: the plain phôi is put into a new background (the piece's place found again). YOUR text (prompt) only sets the PLACE, MOOD and PROPS (English, 1–3 sentences, e.g. \"hung from the rail of a wooden bunk bed in a bright kids' room, soccer ball and sneakers on the floor\"); the size, straightness, magenta face and 'nothing covers it' are added by the system — do not fight them (never ask for a person holding it, a draped / folded / rolled product, a close-up crop).",
  `4. make_base_scene {base_id, prompt} (or preset home | holiday | minimal) → base_scene_status {job_id} until done (each call waits ≤ 50 s; a drawing takes 1–3 min). Then view_image the scene picture AND render_base_preview {scene_id} with a sample product; read its hidden shares. Not good → change the place / props and draw again (at most ${MAX_DRAWINGS} drawings per task). Several ideas → you may start 2 jobs at once.`,
  "5. Pick the best scene (hidden shares, the product clearly the focus, fitting the designs). Only when the editor's request asks to apply it (\"đặt luôn\", \"áp dụng\", \"thay luôn\"…) call set_base_preview {base_id, scene_id} — it re-lays every product on the base in flexi2; the store keeps its old preview until the editor clicks \"Cập nhật store\" on the base page (say so).",
  "6. report_progress (Vietnamese, short) while you work. End with submit_result {summary (Vietnamese: what was wrong, what you drew, the hidden shares of the scene you recommend, whether you applied it), scene_id (the recommended scene, \"\" if none is good), applied (true when you called set_base_preview)}; or fail_task with the reason.",
];

async function progress(db: CtServiceClient, taskId: string, text: string, images: string[] = []): Promise<void> {
  const { data: task } = await db.from(CT_TABLES.agentTasks).select("*").eq("id", taskId).single<CtAgentTask>();
  if (!task) return;
  await db
    .from(CT_TABLES.agentTasks)
    .update({ status: liveStatus(task), progress: [...(task.progress ?? []), { at: new Date().toISOString(), text, kind: "run", ...(images.length ? { images } : {}) }].slice(-50) })
    .eq("id", taskId);
}

async function openBase(ctx: CtMcpContext, args: Record<string, unknown>): Promise<{ db: CtServiceClient; task: CtAgentTask; base: CtBaseProduct }> {
  const { db, task } = await loadTask(ctx, args.task_id);
  openTask(task);
  const id = str(args.base_id) || task.input.basePreview?.baseId || "";
  if (!UUID.test(id)) throw new Error("base_id is not a valid id");
  const base = await loadBaseProduct(db, id);
  if (!base) throw new Error("No such product base");
  return { db, task, base };
}

const pct = (l: CtSideLoss | null | undefined) =>
  l ? { top: `${Math.round(l.top * 100)}%`, bottom: `${Math.round(l.bottom * 100)}%`, left: `${Math.round(l.left * 100)}%`, right: `${Math.round(l.right * 100)}%` } : null;

function sceneView(sc: CtBaseScene, current: string | null) {
  return {
    scene_id: sc.id,
    preset: sc.preset,
    prompt: sc.prompt,
    picture: sc.scene.url,
    overlay: sc.scene.overlay ?? null,
    is_preview: sc.scene.url === current,
    hidden: pct(sc.loss),
    made_at: sc.at,
  };
}

/** The base's products (newest first) with their design picture. */
async function sampleProducts(db: CtServiceClient, baseId: string, limit = 4): Promise<Array<{ id: string; name: string; design: string | null; mockup: string | null }>> {
  const { data: products } = await db
    .from(CT_TABLES.products)
    .select("id, name, main_asset_id")
    .eq("base_product_id", baseId)
    .eq("kind", "product")
    .order("updated_at", { ascending: false })
    .limit(limit)
    .returns<Array<Pick<CtProduct, "id" | "name" | "main_asset_id">>>();
  const out: Array<{ id: string; name: string; design: string | null; mockup: string | null }> = [];
  for (const p of products ?? []) {
    const { data: main } = p.main_asset_id ? await db.from(CT_TABLES.assets).select("url").eq("id", p.main_asset_id).maybeSingle<{ url: string }>() : { data: null };
    const { data: mock } = await db.from(CT_TABLES.assets).select("url").eq("product_id", p.id).eq("role", "mockup").order("created_at", { ascending: false }).limit(1).maybeSingle<{ url: string }>();
    out.push({ id: p.id, name: p.name, design: main?.url ?? null, mockup: mock?.url ?? null });
  }
  return out;
}

/** A product's design (its main picture, as the preview lays it) on `scene`: phôi, design in its canvas box, overlay. */
async function renderOn(db: CtServiceClient, product: CtProduct, baseScene: CtProductScene, scene: CtProductScene): Promise<string> {
  const cfg = normalizeProductConfig(product.config);
  const { data: main } = product.main_asset_id ? await db.from(CT_TABLES.assets).select("url").eq("id", product.main_asset_id).maybeSingle<{ url: string }>() : { data: null };
  if (!main?.url) throw new Error("The product has no design picture");
  // The product's canvas box sits on the base's sheet box; the same place on the scene's sheet box.
  const cur = baseScene.box;
  const k = scene.box.w / Math.max(1, cur.w);
  const c = cfg.scene.box;
  const box = { x: scene.box.x + (c.x - cur.x) * k, y: scene.box.y + (c.y - cur.y) * k, w: c.w * k, h: c.h * k };
  const W = Math.round(scene.width);
  const H = Math.round(scene.height);
  const left = Math.round(box.x);
  const top = Math.round(box.y);
  const w = Math.max(1, Math.round(box.w));
  const h = Math.max(1, Math.round(box.h));
  // Only the part of the design on the photo (sharp refuses a layer that sticks out).
  const design = await sharp(await fetchImage(main.url)).resize(w, h, { fit: "fill" }).png().toBuffer();
  const cl = Math.max(0, -left);
  const ct = Math.max(0, -top);
  const cw = Math.min(w - cl, W - Math.max(0, left));
  const ch = Math.min(h - ct, H - Math.max(0, top));
  const layers: OverlayOptions[] = [];
  if (cw > 0 && ch > 0) layers.push({ input: await sharp(design).extract({ left: cl, top: ct, width: cw, height: ch }).toBuffer(), left: Math.max(0, left), top: Math.max(0, top) });
  if (scene.overlay) layers.push({ input: await sharp(await fetchImage(scene.overlay)).resize(W, H, { fit: "fill" }).png().toBuffer(), left: 0, top: 0 });
  const jpg = await sharp(await fetchImage(scene.url as string)).resize(W, H, { fit: "fill" }).composite(layers).jpeg({ quality: 88 }).toBuffer();
  return ctUpload(`${product.user_id}/${CT_CONFIG.storagePrefix}/bases/agent-check/${crypto.randomUUID()}.jpg`, jpg, "image/jpeg");
}

/** get_task of a base_preview task. */
export async function basePreviewTaskView(db: CtServiceClient, task: CtAgentTask): Promise<unknown> {
  const b = task.input.basePreview!;
  const drawings = (task.progress ?? []).filter((p) => p.kind === "run" && p.text.startsWith("Vẽ nền")).length;
  return {
    id: task.id,
    kind: task.kind,
    what: "A product base whose store preview hides part of the artwork or looks wrong. Measure, analyse, draw new preview photos, recommend one.",
    request: b.request,
    base: { id: b.baseId, name: b.baseName, editor: `/base-products/${b.baseId}` },
    drawings_used: drawings,
    drawings_max: MAX_DRAWINGS,
    instructions: INSTRUCTIONS,
  };
}

/** submit_result of a base_preview task. */
export function submitBasePreviewResult(task: CtAgentTask, raw: Record<string, unknown>, summary: string): { result: CtBasePreviewResult; message: string } {
  const sceneId = clip(str(raw.scene_id) || str(raw.sceneId), 64);
  return {
    result: { summary, sceneId, applied: raw.applied === true },
    message: sceneId ? "Đã gửi — trang product base hiện nền agent đề xuất." : "Đã gửi (không có nền đề xuất).",
  };
}

export const CT_MCP_BASE_PREVIEW_TOOLS: CtMcpTool[] = [
  {
    name: "base_preview_check",
    description:
      "Base preview task: the product base's store preview and every AI scene made for it — pictures (phôi trơn / scene, overlay), the share of the print sheet each hides per side (top / bottom / left / right; null = no overlay, nothing hidden by it), preset / prompt; the base's facts (name, type, description, print area, khuôn aspect), how many products use it / are on the store, sample products (design picture + latest mockup) for render_base_preview.",
    inputSchema: { type: "object", properties: { ...TASK_ARG, base_id: { type: "string", description: "Default = the task's base." } }, required: ["task_id"] },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, base } = await openBase(ctx, args);
      const cfg = base.config;
      const current = cfg.preview.url ?? null;
      const picked = cfg.previewScenes.find((sc) => sc.scene.url === current) ?? null;
      const area = cfg.printAreas[0];
      const store = await baseStoreState(db, base.id).catch(() => null);
      return json({
        base: { id: base.id, name: base.name, productType: cfg.productType, material: cfg.material, description: clip(cfg.description, 1500), print_area: area ? { width: area.width, height: area.height, aspect: Math.round((area.width / Math.max(1, area.height)) * 1000) / 1000 } : null, cut: cfg.cut.mode },
        preview: current
          ? { picture: current, overlay: cfg.preview.overlay ?? null, box: cfg.preview.box, size: [cfg.preview.width, cfg.preview.height], scene_id: picked?.id ?? null, hidden: pct(picked?.loss ?? (await previewLoss(cfg.preview).catch(() => null))) }
          : null,
        scenes: cfg.previewScenes.map((sc) => sceneView(sc, current)),
        products: { on_store: store?.deployed ?? null, store_preview_old: store?.stale.length ?? null },
        samples: await sampleProducts(db, base.id),
        next: "view_image the preview, render_base_preview with a sample product, analyse, then make_base_scene.",
      });
    },
  },
  {
    name: "render_base_preview",
    description:
      "Base preview task: a product's real design laid on a scene of the base (default: the current preview) exactly like the storefront preview — phôi, the design in its box, the overlay over it → a picture url to view_image. product_id from base_preview_check samples (default: the first).",
    inputSchema: {
      type: "object",
      properties: { ...TASK_ARG, base_id: { type: "string", description: "Default = the task's base." }, scene_id: { type: "string", description: "A scene of the base; omit = the current preview." }, product_id: { type: "string", description: "A product on the base; omit = the newest." } },
      required: ["task_id"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, base } = await openBase(ctx, args);
      const pid = str(args.product_id) || (await sampleProducts(db, base.id, 1))[0]?.id || "";
      if (!UUID.test(pid)) throw new Error("No product on this base — product_id");
      const { data: product } = await db.from(CT_TABLES.products).select("*").eq("id", pid).eq("base_product_id", base.id).maybeSingle<CtProduct>();
      if (!product) throw new Error("That product is not on this base");
      const sc = str(args.scene_id) ? base.config.previewScenes.find((x) => x.id === str(args.scene_id)) : null;
      if (str(args.scene_id) && !sc) throw new Error("No such scene on this base");
      const scene = sc ? sc.scene : base.config.preview;
      if (!scene.url) throw new Error("The base has no preview photo");
      const url = await renderOn(db, product, base.config.preview, scene);
      return json({ picture: url, product: product.name, scene_id: sc?.id ?? null, hidden: pct(sc ? sc.loss : await previewLoss(scene).catch(() => null)) });
    },
  },
  {
    name: "make_base_scene",
    description:
      "Base preview task: draw one new preview photo for the base in the background (~1–3 min) — prompt = ONLY the place, mood and props (English, 1–3 sentences), or preset home | holiday | minimal. The system adds the product's size, straightness, printable face and keying. Added to the base's scenes (not made the preview). → job_id for base_scene_status.",
    inputSchema: {
      type: "object",
      properties: { ...TASK_ARG, base_id: { type: "string", description: "Default = the task's base." }, prompt: { type: "string", description: "Place / mood / props, English." }, preset: { type: "string", description: "home | holiday | minimal (instead of prompt)." } },
      required: ["task_id"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, base } = await openBase(ctx, args);
      if (!task.user_id) throw new Error("The task has no user");
      const used = (task.progress ?? []).filter((p) => p.kind === "run" && p.text.startsWith("Vẽ nền")).length;
      if (used >= MAX_DRAWINGS) throw new Error(`This task already drew ${used} scenes (max ${MAX_DRAWINGS}) — pick the best, or submit_result / fail_task`);
      const prompt = clip(str(args.prompt).trim(), 1000);
      const preset = PRESETS.find((p) => p === str(args.preset)) ?? (prompt ? "custom" : null);
      if (!preset) throw new Error("Give prompt (place / mood / props) or preset");
      const job = startSceneJob(db, task.user_id, base.id, preset, preset === "custom" ? prompt : "");
      await progress(db, task.id, `Vẽ nền: ${preset === "custom" ? prompt : preset}`);
      return json({ job_id: job, next: "base_scene_status {job_id} (waits ≤ 50 s per call) until done." });
    },
  },
  {
    name: "base_scene_status",
    description: "Base preview task: a make_base_scene job — waits up to 50 s → done (the scene: scene_id, picture, hidden shares per side), failed (why), or still running (call again).",
    inputSchema: { type: "object", properties: { ...TASK_ARG, job_id: { type: "string", description: "From make_base_scene." } }, required: ["task_id", "job_id"] },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task } = await loadTask(ctx, args.task_id);
      openTask(task);
      const id = str(args.job_id);
      const until = Date.now() + 50_000;
      let job = sceneJob(id);
      while (job?.status === "running" && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 3000));
        job = sceneJob(id);
      }
      if (!job) throw new Error("No such job (the server restarted?) — draw it again");
      if (job.status === "running") return json({ status: "running", next: "Call base_scene_status again." });
      if (job.status === "failed") return json({ status: "failed", error: job.error });
      const sc = job.scene!;
      await progress(db, task.id, `Nền mới · che trên ${pct(sc.loss)?.top ?? "?"} dưới ${pct(sc.loss)?.bottom ?? "?"} trái ${pct(sc.loss)?.left ?? "?"} phải ${pct(sc.loss)?.right ?? "?"}`, [sc.scene.url as string]);
      return json({ status: "done", ...sceneView(sc, null), next: "view_image picture + render_base_preview {scene_id} to judge it." });
    },
  },
  {
    name: "set_base_preview",
    description:
      "Base preview task — ONLY when the editor's request asks to apply it: make a scene the base's preview. Every product on the base is re-laid on it in flexi2 at once; the store keeps its old preview until the editor clicks \"Cập nhật store\" on the base page.",
    inputSchema: { type: "object", properties: { ...TASK_ARG, base_id: { type: "string", description: "Default = the task's base." }, scene_id: { type: "string", description: "From base_preview_check / base_scene_status." } }, required: ["task_id", "scene_id"] },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, base } = await openBase(ctx, args);
      if (!task.user_id) throw new Error("The task has no user");
      const s = await serviceSession(db, task.user_id);
      const r = await setBasePreview(s, base.id, str(args.scene_id));
      await progress(db, task.id, `Đặt làm preview của base · ${r.reapplied} sản phẩm cập nhật trong flexi2${r.failed.length ? ` · lỗi ${r.failed.length}` : ""}`);
      return json({ ok: true, ...r, note: "The store still shows the old preview until the editor clicks “Cập nhật store” on the base page — tell them." });
    },
  },
];
