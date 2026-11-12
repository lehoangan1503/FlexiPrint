/**
 * AI backgrounds of a product base's preview (asked 2026-11-12: "nền đặt phôi lên tự sinh ra cho phù hợp thay vì chỉ là
 * 1 nền xám … thảm tròn thì nền là sàn gỗ trong nhà, xung quanh vài vật dụng trang trí" — then: "làm 1 prompt chung
 * chung, cho nó phân tích sản phẩm là gì, dùng trong bối cảnh nào, vị trí thường đặt, cấu trúc … dựa theo thông tin đã
 * import được từ product base", 3 templates):
 *
 *   POST base-products/:id/scenes   CtBaseSceneRequest → { scene: CtBaseScene }   (~1–2 min: call it with jobFetch)
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
import type { CtBaseProduct, CtBaseProductConfig, CtBaseScene, CtBaseScenePreset, CtBounds, CtMaterialId, CtProductScene } from "../types";
import type { CtPrintSpec, CtPrintTemplate } from "../types/print";
import { normalizeBaseConfig } from "../lib/base-product";
import { normalizeScene } from "../lib/scene";
import { newId } from "../lib/geometry";
import { CT_IMAGE_MODEL } from "../lib/image-models";
import { drawImage } from "./pack-images";
import { fetchImage } from "./char/files";
import { loadBaseProduct } from "./base-products";
import { getTemplate } from "./print-templates";
import { pieceBounds, sheetBoxOn } from "./product-mockups";
import { ctRemove, ctUpload } from "./storage";
import { jsonError, record, str } from "./ai/llm";
import type { CtSession } from "./supabase";

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

function scenePrompt(o: { facts: string; where: string; photos: number; piece: boolean }): string {
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

/** POST base-products/:id/scenes */
export async function makeBaseScene(s: CtSession, baseId: string, raw: unknown): Promise<NextResponse> {
  const req = readRequest(raw);
  if (!req) return jsonError("Chọn 1 template nền hoặc viết mô tả nền", 400);
  const base = await loadBaseProduct(s.supabase, baseId);
  if (!base) return jsonError("Không tìm thấy product base", 404);
  const cfg = base.config;
  const template = cfg.templateId ? await getTemplate(s, cfg.templateId) : null;
  const sheet = sheetOf(cfg, template);
  const aspect = sheet.width / Math.max(1, sheet.height);
  const alpha = cfg.cut.mode === "alpha";
  if (!alpha && !req.source.url) return jsonError("Chưa có phôi trơn để đặt vào nền — tạo hoặc tải phôi trước", 409);

  const where = req.preset === "custom" ? `${req.prompt} (the editor's own description of the place — follow it)` : PRESETS[req.preset];
  const photos = (cfg.source?.photos ?? []).slice(0, 3);
  const dir = `${s.user.id}/${CT_CONFIG.storagePrefix}/bases/${baseId}/scenes`;
  const temp: string[] = [];
  try {
    const refs: string[] = [];
    let expect: CtBounds;
    if (!alpha) {
      const ref = await squareRef(req.source);
      const path = `${dir}/ref-${crypto.randomUUID()}.png`;
      refs.push(await ctUpload(path, ref.png, "image/png"));
      temp.push(path);
      expect = ref.box;
    } else if (req.source.url && req.source.width && req.source.height) {
      // The plate goes where it went on the old background (same share of the frame).
      const b = req.source.box;
      expect = { x: (b.x / req.source.width) * SIDE, y: (b.y / req.source.height) * SIDE, w: (b.w / req.source.width) * SIDE, h: (b.h / req.source.height) * SIDE };
    } else {
      const w = aspect >= 1 ? SIDE * 0.55 : SIDE * 0.55 * aspect;
      const h = w / aspect;
      expect = { x: (SIDE - w) / 2, y: (SIDE - h) / 2, w, h };
    }
    refs.push(...photos);
    const prompt = scenePrompt({ facts: productFacts(base, template), where, photos: photos.length, piece: !alpha });

    let picture: Buffer | null = null;
    let last = "";
    for (let attempt = 0; attempt < 2 && !picture; attempt++) {
      try {
        picture = (await drawImage(CT_IMAGE_MODEL, prompt, refs, "1:1", "crop")).data;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
    }
    if (!picture) return jsonError(`AI không vẽ được nền: ${last}`, 502);

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
    const url = await ctUpload(`${dir}/${req.preset}-${crypto.randomUUID()}.jpg`, jpg, "image/jpeg");
    const scene: CtProductScene = { url, width: m.width ?? SIDE, height: m.height ?? SIDE, box, ...(alpha && req.source.plate ? { plate: req.source.plate } : {}) };
    const entry: CtBaseScene = { id: newId(), preset: req.preset, prompt: req.prompt, scene, plain: req.plain, found, at: new Date().toISOString() };

    // Kept on the base at once: a picture that took a minute is never lost to an unsaved page.
    const { data: row } = await s.supabase.from(CT_TABLES.baseProducts).select("config").eq("id", baseId).maybeSingle<{ config: Record<string, unknown> | null }>();
    const now = row?.config ?? {};
    const previewScenes = [...normalizeBaseConfig(now).previewScenes, entry].slice(-24);
    const { error } = await s.supabase.from(CT_TABLES.baseProducts).update({ config: { ...now, previewScenes } }).eq("id", baseId);
    if (error) console.warn(`[ct] base scene ${baseId}: ${error.message}`);
    console.info(`[ct] base scene ${base.name} ${req.preset}: ${found ? "piece found" : "box kept from the phôi"}`);
    return NextResponse.json({ scene: entry });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không tạo được nền", 500);
  } finally {
    if (temp.length) await ctRemove(temp).catch(() => undefined);
  }
}
