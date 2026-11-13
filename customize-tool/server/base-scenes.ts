/**
 * AI backgrounds of a product base's preview (asked 2026-11-12: "nền đặt phôi lên tự sinh ra cho phù hợp thay vì chỉ là
 * 1 nền xám … thảm tròn thì nền là sàn gỗ trong nhà, xung quanh vài vật dụng trang trí" — then: "làm 1 prompt chung
 * chung, cho nó phân tích sản phẩm là gì, dùng trong bối cảnh nào, vị trí thường đặt, cấu trúc … dựa theo thông tin đã
 * import được từ product base", 3 templates):
 *
 *   POST base-products/:id/scenes        CtBaseSceneRequest → { scene: CtBaseScene }   (~30 s–2 min: call it with jobFetch)
 *   POST base-products/:id/scenes/auto   → CtBaseScenesAuto   the 3 ready backgrounds, in the background (+ an AI phôi
 *                                        first when the base has none); GET = its state
 *   POST cron/base-scenes                Bearer CT_CRON_SECRET, { ids? } → the same for every base not done yet
 *
 * Asked 2026-11-12 ("không có mặc định tạo sẵn 3 background à? … base chưa có hình thì tạo hình luôn"): every base gets
 * the 3 once (import, first open, cron — config.scenesAuto); a base no product uses yet shows the "home" one at once,
 * one already in use keeps its preview (its products would change) and only gets the 3 to pick from.
 *
 * The plain phôi (the piece on grey, straight on) goes to the image model with everything the base knows (name, type,
 * sizes, colours, description, the fulfiller's product photos): the model works out what the product is and where it
 * lives, and photographs THAT blank piece there, same framing. The piece's face stays blank — the design is laid on
 * it — and its box is found again on the answer (the model moves a few %), else the plain phôi's box is kept.
 * A cut-along-the-art base (acrylic) gets a background with the middle left open (the plate is drawn by code).
 *
 * Every picture made is added to config.previewScenes at once (never lost); the editor picks which one is the preview.
 */

import sharp from "sharp";
import { NextResponse } from "next/server";
import { CT_CONFIG, CT_TABLES } from "../config";
import type { CtBaseProduct, CtBaseProductConfig, CtBaseScene, CtBaseScenePreset, CtBaseScenesAuto, CtBounds, CtMaterialId, CtProductScene } from "../types";
import type { CtPrintSpec, CtPrintTemplate } from "../types/print";
import { normalizeBaseConfig } from "../lib/base-product";
import { normalizeScene } from "../lib/scene";
import { newId } from "../lib/geometry";
import { CT_IMAGE_MODEL } from "../lib/image-models";
import { drawImage } from "./pack-images";
import { fetchImage } from "./char/files";
import { loadBaseProduct } from "./base-products";
import { templateRow } from "./print-templates";
import { addTemplateBlank } from "./print-blanks";
import { CLEAR_ACRYLIC_LOOK, makeBlank, pieceBounds, sheetBoxOn } from "./product-mockups";
import { ctRemove, ctUpload } from "./storage";
import { jsonError, record, str } from "./ai/llm";
import { ctServiceClient, type CtServiceClient, type CtSession, type CtSupabase } from "./supabase";

type Db = CtSupabase | CtServiceClient;

const SIDE = 1024;

/** The 3 templates: WHERE comes from the model's reading of the product, these only set the mood. */
const PRESETS: Record<Exclude<CtBaseScenePreset, "custom">, string> = {
  home: "its most typical everyday place in a cozy, tasteful, lived-in home — the furniture, surface and decor a real customer would have around it, soft natural daylight",
  holiday:
    "that same typical place dressed for the Christmas holidays as a gift moment: festive decor that suits this product and its place (pine branches, wrapped presents, warm fairy-light glow, red and gold accents), cozy and warm",
  minimal: "a bright, clean, minimal version of its typical place: calm neutral colours, only one or two simple props, soft natural daylight, so the piece clearly stands out",
};

const MATERIAL_WORDS: Partial<Record<CtMaterialId, string>> = {
  acrylic_white: "white-backed acrylic",
  acrylic_clear: "clear acrylic",
  glass_clear: "clear glass",
  ceramic_gloss: "glossy ceramic",
  ceramic_matte: "matte ceramic",
  aluminum: "aluminium",
  wood: "wood",
};

const uniq = (list: string[]) => [...new Set(list.map((v) => v.trim()).filter(Boolean))];

/** What the base knows about its product, as listing facts for the prompt. */
function productFacts(base: CtBaseProduct, template: CtPrintTemplate | null): string {
  const c = base.config;
  const sizes = uniq(c.variants.map((v) => v.size)).slice(0, 8);
  const colours = uniq(c.variants.map((v) => v.color)).slice(0, 8);
  const mm = template?.spec.widthMm && template.spec.heightMm ? `${Math.round(template.spec.widthMm)} × ${Math.round(template.spec.heightMm)} mm` : "";
  const desc = c.description.replace(/\s+/g, " ").trim().slice(0, 700);
  return [
    `name "${base.name}"`,
    c.productType ? `store category "${c.productType}"` : "",
    sizes.length ? `sizes sold: ${sizes.join(", ")}` : "",
    colours.length ? `colours: ${colours.join(", ")}` : "",
    mm ? `printed face ${mm}` : "",
    MATERIAL_WORDS[c.material] ? `material ${MATERIAL_WORDS[c.material]}` : "",
    desc ? `description: "${desc}"` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function scenePrompt(o: { facts: string; where: string; photos: number; piece: boolean; clear?: boolean }): string {
  const first = o.piece ? 2 : 1;
  const nums = Array.from({ length: o.photos }, (_, i) => first + i).join(", ");
  return [
    o.piece
      ? "Picture 1 is a studio photo of ONE blank product on a plain grey backdrop — the piece a customer's own design is printed on."
      : "",
    `About this product (from its store listing): ${o.facts}.`,
    o.photos
      ? `Picture${o.photos > 1 ? "s" : ""} ${nums} ${o.photos > 1 ? "are" : "is"} the maker's photos of this product with sample prints: use them ONLY to understand what it is, its real size and how and where people use it — copy none of their prints, texts, logos or exact rooms.`
      : "",
    "First work out for yourself what this product is, who uses it, where it normally is in real life (on the floor, on a wall, on a table or shelf, hung on a tree, on a bed or sofa, outdoors…), how big it is next to the things around it and how it is built.",
    o.piece
      ? `Then make ONE real, lively lifestyle photograph of THIS exact blank piece in that natural place: ${o.where}.`
      : `Then make ONE background photograph for the store's preview of this product, in its natural place: ${o.where}. The product itself is NOT in the photo: the middle of the frame is left open with nothing in front of it — the piece is added there later, about half the frame wide, at the camera's natural distance for it; that spot is the clear focus, the rest gently out of focus behind it.`,
    o.piece
      ? "The piece keeps EXACTLY the outline, size and position it has in picture 1 — same place in the frame, same share of the frame — and the camera stays square to its face: a piece lying on a floor, bed or table is photographed from straight above, a hanging or standing piece straight from the front. No perspective, no tilt, no angle, do not zoom, move or crop it."
      : "",
    o.piece
      ? "Its printable face stays completely BLANK: one even surface of its own material, no print, pattern, picture, text, logo, stitching or dashed line — the design is added on it later. Nothing covers, overlaps or touches its face: furniture, props and decor stay around it toward the edges of the picture, some partly cropped by the frame, at real-world scale next to the piece."
      : "",
    o.piece && o.clear ? `The piece is ${CLEAR_ACRYLIC_LOOK}.` : "",
    "Natural light with soft realistic shadows, photorealistic, warm and inviting, like a premium online-store lifestyle photo. No people, no hands, no text, no watermark.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The plain face of the piece on the AI's photo, near where it was put: the colour at the expected box's middle flooded
 * outward (a blurred copy, small steps only — the face's soft light passes, its edge stops it). null = not found
 * sensibly (too small / too big / leaking into the room) — the caller keeps the expected box.
 */
async function findPiece(photo: Buffer, expect: CtBounds, aspect: number): Promise<CtBounds | null> {
  const meta = await sharp(photo).metadata();
  const W0 = meta.width ?? SIDE;
  const H0 = meta.height ?? SIDE;
  const S = 512;
  const { data, info } = await sharp(photo).removeAlpha().resize(S, S, { fit: "fill" }).blur(1.2).raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const ch = info.channels;
  const kx = W / W0;
  const ky = H / H0;
  const ex = { x: expect.x * kx, y: expect.y * ky, w: expect.w * kx, h: expect.h * ky };
  if (ex.w < 8 || ex.h < 8) return null;
  const pad = 0.2 * Math.max(ex.w, ex.h);
  const lim = { x0: Math.max(0, Math.floor(ex.x - pad)), y0: Math.max(0, Math.floor(ex.y - pad)), x1: Math.min(W - 1, Math.ceil(ex.x + ex.w + pad)), y1: Math.min(H - 1, Math.ceil(ex.y + ex.h + pad)) };
  const cx = Math.round(ex.x + ex.w / 2);
  const cy = Math.round(ex.y + ex.h / 2);
  const r = Math.max(2, Math.round(ex.w * 0.06));
  const samples: number[][] = [[], [], []];
  for (let y = cy - r; y <= cy + r; y++)
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      for (let c = 0; c < 3; c++) samples[c].push(data[(y * W + x) * ch + c]);
    }
  const seed = samples.map((v) => v.sort((p, q) => p - q)[v.length >> 1] ?? 0);
  const near = (i: number, j: number) => Math.max(Math.abs(data[i] - data[j]), Math.abs(data[i + 1] - data[j + 1]), Math.abs(data[i + 2] - data[j + 2])) <= 10;
  const likeSeed = (i: number) => Math.max(Math.abs(data[i] - seed[0]), Math.abs(data[i + 1] - seed[1]), Math.abs(data[i + 2] - seed[2])) <= 45;
  const seen = new Uint8Array(W * H);
  const start = cy * W + cx;
  if (!likeSeed(start * ch)) return null;
  const stack = [start];
  seen[start] = 1;
  let n = 0;
  const b = { x0: W, y0: H, x1: -1, y1: -1 };
  while (stack.length) {
    const p = stack.pop() as number;
    const x = p % W;
    const y = (p - x) / W;
    n++;
    if (x < b.x0) b.x0 = x;
    if (x > b.x1) b.x1 = x;
    if (y < b.y0) b.y0 = y;
    if (y > b.y1) b.y1 = y;
    for (const [qx, qy] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ]) {
      if (qx < lim.x0 || qx > lim.x1 || qy < lim.y0 || qy > lim.y1) continue;
      const q = qy * W + qx;
      if (seen[q]) continue;
      seen[q] = 1;
      if (near(q * ch, p * ch) && likeSeed(q * ch)) stack.push(q);
    }
  }
  // Leaked into the room (reached the search limit), or not the piece's size.
  if (b.x0 <= lim.x0 || b.y0 <= lim.y0 || b.x1 >= lim.x1 || b.y1 >= lim.y1) return null;
  const bw = b.x1 - b.x0 + 1;
  const bh = b.y1 - b.y0 + 1;
  if (n < ex.w * ex.h * 0.35) return null;
  if (bw < ex.w * 0.8 || bw > ex.w * 1.2 || bh < ex.h * 0.8 || bh > ex.h * 1.2) return null;
  const w = Math.max(bw, bh * aspect);
  const h = w / aspect;
  const mx = b.x0 + bw / 2;
  const my = b.y0 + bh / 2;
  return { x: (mx - w / 2) / kx, y: (my - h / 2) / ky, w: w / kx, h: h / ky };
}

/** The plain phôi on a 1024² canvas (a non-square photo padded with its own edge), and its sheet box there. */
async function squareRef(source: CtProductScene): Promise<{ png: Buffer; box: CtBounds }> {
  if (!source.url) throw new Error("Chưa có ảnh phôi trơn");
  const raw = await sharp(await fetchImage(source.url)).flatten({ background: "#9a9a9a" }).png().toBuffer();
  const m = await sharp(raw).metadata();
  const W = m.width ?? source.width;
  const H = m.height ?? source.height;
  const side = Math.max(W, H);
  const left = Math.floor((side - W) / 2);
  const top = Math.floor((side - H) / 2);
  const png = await sharp(raw)
    .extend({ left, right: side - W - left, top, bottom: side - H - top, extendWith: "copy" })
    .resize(SIDE, SIDE, { fit: "fill" })
    .png()
    .toBuffer();
  // The stored box is in the scene's own px (its width / height), the file may be another size.
  const sx = W / Math.max(1, source.width);
  const sy = H / Math.max(1, source.height);
  const k = SIDE / side;
  const b = source.box;
  return { png, box: { x: (b.x * sx + left) * k, y: (b.y * sy + top) * k, w: b.w * sx * k, h: b.h * sy * k } };
}

function readRequest(raw: unknown): { preset: CtBaseScenePreset; prompt: string; source: CtProductScene; plain: CtProductScene } | null {
  const o = record(raw);
  const preset = (["home", "holiday", "minimal", "custom"] as const).find((p) => p === o.preset);
  if (!preset) return null;
  const prompt = str(o.prompt).slice(0, 1000);
  if (preset === "custom" && !prompt) return null;
  return {
    preset,
    prompt: preset === "custom" ? prompt : "",
    source: normalizeScene(record(o.source) as Partial<CtProductScene>),
    plain: normalizeScene(record(o.plain) as Partial<CtProductScene>),
  };
}

/** The sheet of the piece the base sells: its khuôn, else its first print area (a flat piece, no outline). */
function sheetOf(cfg: CtBaseProductConfig, template: CtPrintTemplate | null): Pick<CtPrintSpec, "width" | "height" | "outline"> {
  if (cfg.cut.mode !== "alpha" && template) return template.spec;
  const a = cfg.printAreas[0];
  return { width: a?.width ?? 1000, height: a?.height ?? 1000, outline: null };
}

async function loadTemplate(db: Db, id: string | null): Promise<CtPrintTemplate | null> {
  if (!id) return null;
  const { data } = await db.from(CT_TABLES.printTemplates).select("*").eq("id", id).maybeSingle<CtPrintTemplate>();
  return data ? templateRow(data) : null;
}

/** One AI background: drawn, its piece found again, stored. Not yet on the base (saveScenes). Throws a message. */
async function drawBaseScene(o: {
  userId: string;
  base: CtBaseProduct;
  template: CtPrintTemplate | null;
  preset: CtBaseScenePreset;
  prompt: string;
  source: CtProductScene;
  plain: CtProductScene;
}): Promise<CtBaseScene> {
  const { base, template, preset, source } = o;
  const cfg = base.config;
  const sheet = sheetOf(cfg, template);
  const aspect = sheet.width / Math.max(1, sheet.height);
  const alpha = cfg.cut.mode === "alpha";
  if (!alpha && !source.url) throw new Error("Chưa có phôi trơn để đặt vào nền — tạo hoặc tải phôi trước");
  const where = preset === "custom" ? `${o.prompt} (the editor's own description of the place — follow it)` : PRESETS[preset];
  const photos = (cfg.source?.photos ?? []).slice(0, 3);
  const dir = `${o.userId}/${CT_CONFIG.storagePrefix}/bases/${base.id}/scenes`;
  const temp: string[] = [];
  try {
    const refs: string[] = [];
    let expect: CtBounds;
    if (!alpha) {
      const ref = await squareRef(source);
      const path = `${dir}/ref-${crypto.randomUUID()}.png`;
      refs.push(await ctUpload(path, ref.png, "image/png"));
      temp.push(path);
      expect = ref.box;
    } else if (source.url && source.width && source.height) {
      // The plate goes where it went on the old background (same share of the frame).
      const b = source.box;
      expect = { x: (b.x / source.width) * SIDE, y: (b.y / source.height) * SIDE, w: (b.w / source.width) * SIDE, h: (b.h / source.height) * SIDE };
    } else {
      const w = aspect >= 1 ? SIDE * 0.55 : SIDE * 0.55 * aspect;
      const h = w / aspect;
      expect = { x: (SIDE - w) / 2, y: (SIDE - h) / 2, w, h };
    }
    refs.push(...photos);
    const prompt = scenePrompt({ facts: productFacts(base, template), where, photos: photos.length, piece: !alpha, clear: base.config.material === "acrylic_clear" });

    let picture: Buffer | null = null;
    let last = "";
    for (let attempt = 0; attempt < 2 && !picture; attempt++) {
      try {
        picture = (await drawImage(CT_IMAGE_MODEL, prompt, refs, "1:1", "crop")).data;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
    }
    if (!picture) throw new Error(`AI không vẽ được nền: ${last}`);

    const m = await sharp(picture).metadata();
    const k = (m.width ?? SIDE) / SIDE;
    let box: CtBounds = { x: expect.x * k, y: expect.y * k, w: expect.w * k, h: expect.h * k };
    let found = alpha;
    if (!alpha) {
      // Found as the PIECE's face (the khuôn outline inside the sheet), turned back into the sheet's box.
      const ob = pieceBounds(sheet);
      const ks = box.w / Math.max(1, sheet.width);
      const piece = { x: box.x + ob.x * ks, y: box.y + ob.y * ks, w: ob.w * ks, h: ob.h * ks };
      const hit = await findPiece(picture, piece, ob.w / Math.max(1, ob.h)).catch(() => null);
      if (hit) {
        box = sheetBoxOn(hit, sheet);
        found = true;
      }
    }
    const jpg = await sharp(picture).flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer();
    const url = await ctUpload(`${dir}/${preset}-${crypto.randomUUID()}.jpg`, jpg, "image/jpeg");
    const scene: CtProductScene = { url, width: m.width ?? SIDE, height: m.height ?? SIDE, box, ...(alpha && source.plate ? { plate: source.plate } : {}) };
    console.info(`[ct] base scene ${base.name} ${preset}: ${found ? "piece found" : "box kept from the phôi"}`);
    return { id: newId(), preset, prompt: o.prompt, scene, plain: o.plain, found, at: new Date().toISOString() };
  } finally {
    if (temp.length) await ctRemove(temp).catch(() => undefined);
  }
}

/** Adds scenes to the base (read fresh: a picture that took a minute is never lost to an unsaved page) + other fields. */
async function saveScenes(db: Db, baseId: string, add: CtBaseScene[], extra: Partial<CtBaseProductConfig> = {}): Promise<void> {
  const { data: row } = await db.from(CT_TABLES.baseProducts).select("config").eq("id", baseId).maybeSingle<{ config: Record<string, unknown> | null }>();
  const now = row?.config ?? {};
  const previewScenes = [...normalizeBaseConfig(now).previewScenes, ...add].slice(-24);
  const { error } = await db.from(CT_TABLES.baseProducts).update({ config: { ...now, ...extra, previewScenes } }).eq("id", baseId);
  if (error) throw new Error(error.message);
}

/** POST base-products/:id/scenes */
export async function makeBaseScene(s: CtSession, baseId: string, raw: unknown): Promise<NextResponse> {
  const req = readRequest(raw);
  if (!req) return jsonError("Chọn 1 template nền hoặc viết mô tả nền", 400);
  const base = await loadBaseProduct(s.supabase, baseId);
  if (!base) return jsonError("Không tìm thấy product base", 404);
  try {
    const template = await loadTemplate(s.supabase, base.config.templateId);
    const entry = await drawBaseScene({ userId: s.user.id, base, template, preset: req.preset, prompt: req.prompt, source: req.source, plain: req.plain });
    await saveScenes(s.supabase, baseId, [entry]).catch((e: Error) => console.warn(`[ct] base scene ${baseId}: ${e.message}`));
    return NextResponse.json({ scene: entry });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không tạo được nền", 500);
  }
}

// ---------------------------------------------------------------------------
// The 3 ready backgrounds, made on their own
// ---------------------------------------------------------------------------

const AUTO_PRESETS: Array<Exclude<CtBaseScenePreset, "custom">> = ["home", "holiday", "minimal"];
const runs = new Map<string, CtBaseScenesAuto>();

/**
 * The plain phôi a base's backgrounds are made from — made by AI when its khuôn has none (added to the khuôn like
 * "Tạo phôi bằng AI"). skip + why = nothing to make it from.
 */
async function plainPhoi(db: Db, userId: string, base: CtBaseProduct, template: CtPrintTemplate | null, say: (t: string) => void): Promise<{ source: CtProductScene; plain: CtProductScene } | { skip: string }> {
  const cfg = base.config;
  const current = cfg.previewScenes.find((sc) => sc.scene.url && sc.scene.url === cfg.preview.url);
  const plain = current ? current.plain : cfg.preview;
  if (cfg.cut.mode === "alpha") return { source: plain, plain };
  if (plain.overlay) return { skip: "Phôi có lớp phủ nếp vải của nhà in — nền AI không giữ được, ảnh sinh động để mockup AI làm" };
  if (plain.url) return { source: plain, plain };
  const blank = template?.spec.blanks[0];
  if (blank) return { source: { url: blank.url, width: blank.width, height: blank.height, box: blank.box }, plain };
  if (template) {
    say("AI đang vẽ phôi trơn từ khuôn…");
    const photo = await makeBlank(userId, template.name, template.spec, cfg.material);
    const t = await addTemplateBlank(db, userId, template, photo, "Phôi AI", true);
    const b = t.spec.blanks[0];
    return { source: { url: b.url, width: b.width, height: b.height, box: b.box }, plain };
  }
  // No khuôn: the AI has nothing to draw the piece's shape from (Wood Ornament 2026-11-12: a made-up orange shape
  // filling the frame) — the editor uploads a phôi first.
  return { skip: "Base chưa có khuôn hay ảnh phôi — tải phôi lên trước, rồi bấm template để tạo nền" };
}

async function runAuto(db: Db, userId: string, baseId: string, state: CtBaseScenesAuto): Promise<void> {
  const say = (t: string) => void (state.step = t);
  try {
    const base = await loadBaseProduct(db, baseId);
    if (!base) throw new Error("Không tìm thấy product base");
    const { data: row } = await db.from(CT_TABLES.baseProducts).select("config").eq("id", baseId).maybeSingle<{ config: Record<string, unknown> | null }>();
    await db.from(CT_TABLES.baseProducts).update({ config: { ...(row?.config ?? {}), scenesAuto: new Date().toISOString() } }).eq("id", baseId);
    const template = await loadTemplate(db, base.config.templateId);
    const got = await plainPhoi(db, userId, base, template, say);
    if ("skip" in got) {
      state.status = "skipped";
      say(got.skip);
      return;
    }
    const fresh = (await loadBaseProduct(db, baseId)) ?? base;
    const have = new Set(fresh.config.previewScenes.map((sc) => sc.preset));
    const todo = AUTO_PRESETS.filter((p) => !have.has(p));
    say(`AI đang tạo ${todo.length} nền bối cảnh…`);
    const made = (
      await Promise.allSettled(todo.map((preset) => drawBaseScene({ userId, base: fresh, template, preset, prompt: "", source: got.source, plain: got.plain })))
    ).flatMap((r) => (r.status === "fulfilled" ? [r.value] : (console.warn(`[ct] base scene ${base.name}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`), [])));
    state.made = made.length;
    // Shown at once only on a base nothing is made on yet (else every product's preview would change unasked) and
    // never over a background the editor picked; a cut-along-the-art base keeps the background its phôi were drawn on.
    const { count } = await db.from(CT_TABLES.products).select("id", { count: "exact", head: true }).eq("base_product_id", baseId).eq("kind", "product");
    const picked = fresh.config.previewScenes.some((sc) => sc.scene.url && sc.scene.url === fresh.config.preview.url);
    const home = made.find((sc) => sc.preset === "home") ?? made[0];
    const show = home && fresh.config.cut.mode !== "alpha" && !count && !picked;
    await saveScenes(db, baseId, made, show ? { preview: home.scene } : {});
    state.status = made.length ? "done" : "failed";
    say(made.length ? `Đã tạo ${made.length} nền${show ? " — nền “Nơi dùng quen thuộc” đang làm nền xem trước" : ""}` : "AI không vẽ được nền nào — bấm template để thử lại");
  } catch (e) {
    state.status = "failed";
    say(e instanceof Error ? e.message : String(e));
  }
}

/** Starts the automatic run of a base (once at a time) → its state. */
export function startBaseScenes(db: Db, userId: string, baseId: string): CtBaseScenesAuto {
  const now = runs.get(baseId);
  if (now?.status === "running") return now;
  const state: CtBaseScenesAuto = { status: "running", step: "Đang chuẩn bị…", made: 0 };
  runs.set(baseId, state);
  void runAuto(db, userId, baseId, state);
  return state;
}

/** POST base-products/:id/scenes/auto */
export async function autoBaseScenes(s: CtSession, baseId: string): Promise<NextResponse> {
  const base = await loadBaseProduct(s.supabase, baseId);
  if (!base) return jsonError("Không tìm thấy product base", 404);
  // The service client when there is one: the run outlives the editor's login token.
  return NextResponse.json(startBaseScenes(ctServiceClient() ?? s.supabase, s.user.id, baseId));
}

/** GET base-products/:id/scenes/auto */
export function autoBaseScenesState(baseId: string): NextResponse {
  return NextResponse.json(runs.get(baseId) ?? ({ status: "idle", step: "", made: 0 } satisfies CtBaseScenesAuto));
}

/** POST cron/base-scenes — every base without its automatic run (or `ids`), one after the other. */
export async function cronBaseScenes(authorization: string | null, raw: unknown): Promise<NextResponse> {
  const secret = process.env.CT_CRON_SECRET;
  if (!secret) return jsonError("CT_CRON_SECRET chưa được cấu hình", 503);
  if (authorization !== `Bearer ${secret}`) return jsonError("Unauthorized", 401);
  const db = ctServiceClient();
  if (!db) return jsonError("Thiếu service key", 503);
  const ids = (Array.isArray(record(raw).ids) ? (record(raw).ids as unknown[]) : []).filter((v): v is string => typeof v === "string");
  const { data } = await db.from(CT_TABLES.baseProducts).select("id, name, user_id, config").returns<Array<{ id: string; name: string; user_id: string | null; config: Record<string, unknown> | null }>>();
  const list = (data ?? []).filter((b) => (ids.length ? ids.includes(b.id) : !normalizeBaseConfig(b.config).scenesAuto) && b.user_id);
  void (async () => {
    for (const b of list) {
      const state: CtBaseScenesAuto = { status: "running", step: "Đang chuẩn bị…", made: 0 };
      runs.set(b.id, state);
      await runAuto(db, b.user_id as string, b.id, state);
      console.info(`[ct] base scenes (cron) ${b.name}: ${state.status} · ${state.step}`);
    }
  })();
  return NextResponse.json({ started: list.map((b) => ({ id: b.id, name: b.name })) });
}
