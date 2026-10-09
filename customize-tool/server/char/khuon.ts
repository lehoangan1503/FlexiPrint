/**
 * The khuôn in of a bộ nhân vật (asked 2026-10-10): the brief takes the editor's own khuôn as a picture (and their
 * phôi trơn photo, server/char/blank.ts); when they gave none, the team's image model draws a khuôn that fits the
 * approved master — in the strict green code of server/print-khuon.ts — while the edits (bản sửa) are made, and the
 * AI phôi trơn is then drawn from it. Either way the khuôn is a new ct_print_templates row (Thư viện → Khuôn in /
 * Phôi show it) and the brief points at it (brief.product.templateId).
 *
 *   POST char/projects/:id/khuon   multipart file, name? → { template }   a khuôn from the editor's picture
 *   POST char/projects/:id/khuon   {} → { image }                         (re)draw the AI one from the master now
 *
 * The AI one runs as a ct_char_images row kind "blank", role "khuon:ai" (its file = the khuôn's picture).
 */

import sharp from "sharp";
import { NextResponse } from "next/server";
import { CT_CONFIG, CT_TABLES } from "../../config";
import type { CtCharImage, CtCharProject } from "../../types";
import type { CtPrintFace, CtPrintTemplate } from "../../types/print";
import { newId } from "../../lib/geometry";
import { layoutHint, normalizePrintSpec } from "../../lib/print-template";
import { drawImage } from "../pack-images";
import { addTemplateBlank } from "../print-blanks";
import { fitMask, readGreen, renderFace } from "../print-khuon";
import { templateRow } from "../print-templates";
import { currentImageModel } from "../settings";
import { ctUpload } from "../storage";
import type { CtSession } from "../supabase";
import { AI_BLANK_ROLE, briefTemplate, startCharBlank } from "./blank";
import { fetchImage, saveCharFile } from "./files";
import { jobDb, jsonError, loadImages, loadProject, masterFile, type Db } from "./projects";

export const AI_KHUON_ROLE = "khuon:ai";

const MAX_FILE = 30 * 1024 * 1024;
/** Sheet long side of a khuôn read from a picture that is smaller / larger than this range. */
const MIN_SIDE = 1000;
const MAX_SIDE = 4000;
/** Sheet long side of the AI khuôn (no factory numbers: the editor sets mm / dpi in Thư viện later). */
const AI_SIDE = 2400;

interface Read {
  mask: Buffer;
  width: number;
  height: number;
}

/**
 * The printed area of a khuôn picture, cropped to it: the green code (an AI / our own drawing), else its alpha (a PNG
 * cut-out), else the piece on a plain backdrop (everything the border's colour does not reach — a filled shape, or
 * a line drawing's closed cut line). null = nothing sensible (the picture is kept as it is).
 */
export async function readKhuonPicture(data: Buffer): Promise<Read | null> {
  const { data: px, info } = await sharp(data).ensureAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const N = W * H;
  let green = 0;
  let clear = 0;
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    if (px[p + 3] < 16) clear++;
    else if (px[p + 1] - Math.max(px[p], px[p + 2]) >= 60) green++;
  }
  const sensible = (r: Read | null): Read | null => {
    if (!r) return null;
    let on = 0;
    for (let i = 0; i < r.mask.length; i++) if (r.mask[i] >= 128) on++;
    const share = on / N;
    return share > 0.03 && share < 0.985 ? r : null;
  };
  if (green / N > 0.05) {
    const flat = await sharp(data).flatten({ background: "#ffffff" }).png().toBuffer();
    return sensible(await readGreen(flat).catch(() => null));
  }
  const m = Buffer.alloc(N);
  if (clear / N > 0.05) {
    for (let i = 0; i < N; i++) m[i] = px[i * 4 + 3] >= 128 ? 255 : 0;
  } else {
    // The backdrop: the border pixels' mean colour; flood from the border through everything close to it.
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    const border = (x: number, y: number) => {
      const p = (y * W + x) * 4;
      r += px[p];
      g += px[p + 1];
      b += px[p + 2];
      n++;
    };
    for (let x = 0; x < W; x++) (border(x, 0), border(x, H - 1));
    for (let y = 0; y < H; y++) (border(0, y), border(W - 1, y));
    r /= n;
    g /= n;
    b /= n;
    const near = (i: number) => {
      const p = i * 4;
      return Math.abs(px[p] - r) + Math.abs(px[p + 1] - g) + Math.abs(px[p + 2] - b) < 60;
    };
    const outside = new Uint8Array(N);
    const stack: number[] = [];
    const seed = (i: number) => {
      if (!outside[i] && near(i)) {
        outside[i] = 1;
        stack.push(i);
      }
    };
    for (let x = 0; x < W; x++) (seed(x), seed((H - 1) * W + x));
    for (let y = 0; y < H; y++) (seed(y * W), seed(y * W + W - 1));
    while (stack.length) {
      const i = stack.pop() as number;
      const x = i % W;
      if (x > 0) seed(i - 1);
      if (x < W - 1) seed(i + 1);
      if (i >= W) seed(i - W);
      if (i < N - W) seed(i + W);
    }
    for (let i = 0; i < N; i++) m[i] = outside[i] ? 0 : 255;
  }
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < N; i++) {
    if (!m[i]) continue;
    const x = i % W;
    const y = (i - x) / W;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const crop = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) m.copy(crop, y * w, (y + y0) * W + x0, (y + y0) * W + x0 + w);
  return sensible({ mask: crop, width: w, height: h });
}

async function put(userId: string, data: Buffer, name: string): Promise<string> {
  return ctUpload(`${userId}/${CT_CONFIG.storagePrefix}/khuon/${name}-${crypto.randomUUID()}.png`, data, "image/png");
}

/** A khuôn row from a read printed area (sheet = its own aspect, long side `side`), or from the picture alone. */
async function saveKhuon(db: Db, userId: string, name: string, read: Read | null, picture: Buffer, side: number | null): Promise<CtPrintTemplate> {
  let face: CtPrintFace;
  let W: number;
  let H: number;
  if (read) {
    const long = Math.max(read.width, read.height);
    const k = side ? side / long : long < MIN_SIDE ? MIN_SIDE / long : long > MAX_SIDE ? MAX_SIDE / long : 1;
    W = Math.max(16, Math.round(read.width * k));
    H = Math.max(16, Math.round(read.height * k));
    const out = await renderFace(await fitMask(read, W, H), W, H);
    const [maskUrl, guideUrl, imageUrl] = await Promise.all([put(userId, out.mask, "mask"), put(userId, out.guide, "guide"), put(userId, out.image, "image")]);
    face = { id: newId(), name: "Mặt in", imageUrl, maskUrl, guideUrl };
  } else {
    const meta = await sharp(picture).metadata();
    W = meta.width ?? 1000;
    H = meta.height ?? 1000;
    face = { id: newId(), name: "Mặt in", imageUrl: await put(userId, await sharp(picture).png().toBuffer(), "image"), maskUrl: null, guideUrl: null };
  }
  const dpi = 300;
  const spec = normalizePrintSpec({ width: W, height: H, dpi, widthMm: Math.round((W / dpi) * 254) / 10, heightMm: Math.round((H / dpi) * 254) / 10, faces: [face] });
  const { data, error } = await db.from(CT_TABLES.printTemplates).insert({ name: name.slice(0, 200), kind: "flat", spec, user_id: userId }).select("*").single<CtPrintTemplate>();
  if (error || !data) throw new Error(error?.message ?? "Không lưu được khuôn");
  return templateRow(data);
}

/** The brief's product pointed at a khuôn (what TemplatePick does on the page). */
export function productOnTemplate(p: CtCharProject, t: CtPrintTemplate): CtCharProject["brief"]["product"] {
  return {
    ...p.brief.product,
    templateId: t.id,
    label: p.brief.product.label || t.name,
    cut: t.kind === "cut" ? "alpha" : t.spec.outline || t.spec.faces.some((f) => f.maskUrl) ? "frame" : "rect",
    widthMm: t.spec.widthMm || p.brief.product.widthMm,
    heightMm: t.spec.heightMm || p.brief.product.heightMm,
    layout: layoutHint(t.kind, t.spec),
  };
}

function khuonPrompt(p: CtCharProject, hasBlank: boolean): string {
  const label = p.brief.product.label || "printed gift product";
  return [
    `Reference picture 1 is an illustration that will be printed on: ${label}.`,
    hasBlank ? "Reference picture 2 is a photo of that blank product: take the piece's EXACT outline, proportions and holes from it." : "",
    `Draw the flat 2D print template (khuôn in / die line) of ONE ${label}, seen flat and straight from the front: the real product's usual shape (a round ornament = a circle with its small hanging hole near the top; a tile = a rounded square; a garment = its pattern piece), sized so this illustration fits inside it with a clear margin all around.`,
    p.brief.idea ? `What the product is about: ${p.brief.idea.slice(0, 400)}` : "",
    "STRICT COLOUR CODE: every area that gets printed is filled with flat pure green #00FF00. Everything else — the background, holes, cut-outs, parts that are not printed — is pure white #FFFFFF.",
    "Solid flat fills only: do NOT draw the illustration, no outline strokes, no seam lines, no inner shapes, no perspective, no shading, no text, no labels, no measurements, no other colours. The piece fills most of the picture with a small white margin.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Start drawing the AI khuôn from the approved master (a running row now; the brief gets it, then the AI phôi). */
export async function startCharKhuon(db: Db, userId: string, p: CtCharProject): Promise<CtCharImage | null> {
  const master = await masterFile(db, p);
  if (!master) return null;
  const images = await loadImages(db, p.id);
  const blank = p.brief.product.blankId ? images.find((im) => im.id === p.brief.product.blankId && im.status === "done") : undefined;
  const label = p.brief.product.label || p.name;
  const prompt = khuonPrompt(p, !!blank);
  const { data: row } = await db
    .from(CT_TABLES.charImages)
    .insert({ project_id: p.id, user_id: userId, kind: "blank", role: AI_KHUON_ROLE, status: "running", note: `Khuôn in AI — ${label}`, prompt })
    .select("*")
    .single<CtCharImage>();
  if (!row) return null;
  void (async () => {
    try {
      const model = await currentImageModel();
      let last = "";
      let read: Read | null = null;
      let drawing: Buffer | null = null;
      for (let attempt = 0; attempt < 2 && !read; attempt++) {
        try {
          drawing = (await drawImage(model, prompt, [master.image.url, ...(blank ? [blank.url] : [])], "1:1", "pad")).data;
          read = await readGreen(drawing);
        } catch (e) {
          last = e instanceof Error ? e.message : String(e);
        }
      }
      if (!read || !drawing) throw new Error(`Không tạo được khuôn: ${last}`);
      const template = await saveKhuon(db, userId, `${label} — khuôn AI`, read, drawing, AI_SIDE);
      // The brief points at it before the row is done: the page's last poll reads both.
      const fresh = (await loadProject(db, p.id)) ?? p;
      const next = { ...fresh, brief: { ...fresh.brief, product: productOnTemplate(fresh, template) } };
      await db.from(CT_TABLES.charProjects).update({ brief: next.brief }).eq("id", p.id);
      const shown = await fetchImage(template.spec.faces[0]?.imageUrl ?? "");
      const saved = await saveCharFile(userId, p.id, "blank", shown);
      await db.from(CT_TABLES.charImages).update({ ...saved, status: "done", error: "", meta: { templateId: template.id } }).eq("id", row.id);
      await blankFor(db, userId, next, template);
    } catch (e) {
      await db.from(CT_TABLES.charImages).update({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 1000) }).eq("id", row.id);
    }
  })();
  return row;
}

/** The phôi of a khuôn just linked: the uploaded photo goes with the khuôn, else the AI draws one from it. */
async function blankFor(db: Db, userId: string, p: CtCharProject, t: CtPrintTemplate): Promise<void> {
  if (t.spec.blanks.length) return;
  const images = await loadImages(db, p.id);
  const uploaded = p.brief.product.blankId ? images.find((im) => im.id === p.brief.product.blankId && im.status === "done") : undefined;
  if (uploaded) {
    await addTemplateBlank(db, userId, t, await fetchImage(uploaded.url), "Phôi upload", false).catch(() => undefined);
    return;
  }
  if (images.some((im) => im.kind === "blank" && im.role === AI_BLANK_ROLE && im.status !== "failed")) return;
  await startCharBlank(db, userId, p);
}

/**
 * After the master is approved (the edits start now): no khuôn in → the AI one (then its phôi); a khuôn and no phôi
 * → the uploaded photo is kept with the khuôn, else the AI phôi. Never throws.
 */
export async function autoCharKit(db: Db, userId: string, p: CtCharProject): Promise<void> {
  try {
    if (!p.brief.product.templateId) {
      const images = await loadImages(db, p.id);
      if (images.some((im) => im.kind === "blank" && im.role === AI_KHUON_ROLE && im.status === "running")) return;
      await startCharKhuon(db, userId, p);
      return;
    }
    const t = await briefTemplate(db, p);
    if (t) await blankFor(db, userId, p, t);
  } catch (e) {
    console.warn(`[ct] char kit ${p.id}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** POST char/projects/:id/khuon — multipart = the editor's khuôn picture; JSON = (re)draw the AI one. */
export async function charKhuonRoute(s: CtSession, id: string, form: FormData | null): Promise<NextResponse> {
  const p = await loadProject(s.supabase, id);
  if (!p) return jsonError("Không tìm thấy bộ nhân vật", 404);
  if (p.user_id && p.user_id !== s.user.id) return jsonError("Bộ nhân vật của người khác — chỉ xem", 403);
  if (!form) {
    if (!p.master_id) return jsonError("Duyệt master trước — khuôn AI vẽ theo master", 409);
    const image = await startCharKhuon(jobDb(s), s.user.id, p);
    return image ? NextResponse.json({ image }, { status: 202 }) : jsonError("Không tạo được", 500);
  }
  const file = form.get("file");
  if (!(file instanceof Blob) || !file.size) return jsonError("Thiếu ảnh", 400);
  if (file.size > MAX_FILE) return jsonError("Ảnh quá lớn (tối đa 30 MB)", 413);
  const raw = form.get("name");
  const name = (typeof raw === "string" ? raw.trim() : "").slice(0, 160) || `${p.brief.product.label || p.name} — khuôn`;
  try {
    const data = Buffer.from(await file.arrayBuffer());
    const template = await saveKhuon(s.supabase, s.user.id, name, await readKhuonPicture(data), data, null);
    return NextResponse.json({ template }, { status: 201 });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không đọc được khuôn", 400);
  }
}
