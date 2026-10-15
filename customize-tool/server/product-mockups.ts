/**
 * The product as it is sold (asked 2026-10-10): Thiết kế and File in stay flat 2D (the print, no phôi); Xem trước and
 * Mockups show the finished artwork ON the phôi trơn — the blank piece — and the mockups are made by AI, no hand edit.
 *
 *   POST products/:id/blank     → { product }  AI phôi trơn from the product's khuôn in (its outline, hole, size):
 *                                 stored as a product picture, becomes config.scene (the sheet's box detected on it)
 *   POST products/:id/mockups   multipart print (PNG, the artwork at sheet size cut to the khuôn), scenes (JSON
 *                               string[]) → { jobs } the front mockup (the print laid on the phôi, exact, no AI) +
 *                               one AI lifestyle photo per scene made from it, in the background
 *   GET  products/:id/mockups   → { jobs } newest first
 *
 * Jobs are rows of ct_pack_images (listed = false, name "mockup:<product id>"): running → done (the picture is also
 * added to the product as a mockup) / failed. The v2 bộ nhân vật makes its phôi with the same code (makeBlank).
 */

import sharp from "sharp";
import { NextResponse } from "next/server";
import { CT_CONFIG, CT_TABLES } from "../config";
import type { CtAsset, CtBounds, CtPackImage, CtProduct, CtProductScene } from "../types";
import type { CtPrintSpec } from "../types/print";
import { normalizeProductConfig } from "../lib/design";
import { shapePolygon } from "../lib/material-frame";
import { shapeBounds } from "../lib/geometry";
import { isAdmin } from "./ai-styles";
import { drawImage } from "./pack-images";
import { CT_IMAGE_MODEL } from "../lib/image-models";
import { ctRemove, ctUpload } from "./storage";
import { fetchImage } from "./char/files";
import { lightOnBlank } from "../lib/blank-shading";
import { uploadAsset } from "./handlers";
import { ctServiceClient, type CtSession } from "./supabase";

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

const jobName = (productId: string) => `mockup:${productId}`;

export const KEEP_PRINT =
  " The printed artwork on the product must stay EXACTLY as in the reference picture: the same characters, the same colours, " +
  "the same text letter for letter, the same size and position on the product. Do not redraw, restyle, crop or change the print. " +
  "Photorealistic product photography, natural soft light.";

// ---- the front mockup: the print laid exactly on the phôi --------------------------------------------------

/** The print on the blank photo, inside `box` (photo px, may reach past the photo), lit by the blank's own shading. */
export async function frontMockup(blank: Buffer, print: Buffer, box: CtProductScene["box"]): Promise<Buffer> {
  const meta = await sharp(blank).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const bw = Math.max(1, Math.round(box.w));
  const bh = Math.max(1, Math.round(box.h));
  const bx = Math.round(box.x);
  const by = Math.round(box.y);
  // The part of the box on the photo.
  const x = Math.max(0, bx);
  const y = Math.max(0, by);
  const w = Math.min(W, bx + bw) - x;
  const hh = Math.min(H, by + bh) - y;
  if (w <= 0 || hh <= 0) return sharp(blank).removeAlpha().jpeg({ quality: 92 }).toBuffer();
  const art = await sharp(await sharp(print).resize(bw, bh, { fit: "fill", kernel: "lanczos3" }).ensureAlpha().png().toBuffer())
    .extract({ left: x - bx, top: y - by, width: w, height: hh })
    .raw()
    .toBuffer();
  // The phôi's own light on the print: its shading darkens it, its gloss highlights lie over it (lib/blank-shading).
  const under = await sharp(blank).removeAlpha().extract({ left: x, top: y, width: w, height: hh }).raw().toBuffer();
  const out = Buffer.alloc(w * hh * 4);
  lightOnBlank(art, under, w, hh, 3, out);
  const patch = await sharp(out, { raw: { width: w, height: hh, channels: 4 } }).removeAlpha().png().toBuffer();
  return sharp(blank).removeAlpha().composite([{ input: patch, left: x, top: y }]).jpeg({ quality: 92 }).toBuffer();
}

// ---- the phôi trơn ------------------------------------------------------------------------------------------

/** What the piece is cut to, in sheet px: the khuôn outline, else the whole sheet. */
function pieceBounds(spec: Pick<CtPrintSpec, "width" | "height" | "outline">): CtBounds {
  return spec.outline ? shapeBounds(spec.outline) : { x: 0, y: 0, w: spec.width, h: spec.height };
}

/** The khuôn drawn as a line drawing (the image model copies its shape and hole). */
async function outlineDrawing(spec: CtPrintSpec): Promise<Buffer> {
  const b = pieceBounds(spec);
  const pad = Math.max(b.w, b.h) * 0.15;
  const vb = `${b.x - pad} ${b.y - pad} ${b.w + 2 * pad} ${b.h + 2 * pad}`;
  const stroke = Math.max(b.w, b.h) / 160;
  const path = (pts: Array<{ x: number; y: number }>) => `M${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("L")}Z`;
  const outline = spec.outline ? path(shapePolygon(spec.outline)) : path([{ x: 0, y: 0 }, { x: spec.width, y: 0 }, { x: spec.width, y: spec.height }, { x: 0, y: spec.height }]);
  const cuts = spec.cuts.map((c) => `<path d="${path(shapePolygon(c))}" fill="#ffffff" stroke="#000" stroke-width="${stroke}"/>`).join("");
  const side = 1024;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" viewBox="${vb}" preserveAspectRatio="xMidYMid meet"><rect x="${b.x - pad}" y="${b.y - pad}" width="${b.w + 2 * pad}" height="${b.h + 2 * pad}" fill="#ffffff"/><path d="${outline}" fill="#eeeeee" stroke="#000" stroke-width="${stroke}"/>${cuts}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** The prompt of a phôi trơn: the bare piece, straight on, on a plain grey backdrop (so its box can be found). */
export function blankPrompt(label: string, spec: CtPrintSpec | null): string {
  const size = spec?.widthMm && spec.heightMm ? ` (${Math.round(spec.widthMm)} × ${Math.round(spec.heightMm)} mm)` : "";
  const hole = spec?.cuts.length ? " including the punched hole exactly where the drawing shows it (the small shape inside the outline)" : "";
  return [
    `Studio product photo of ONE blank, unprinted ${label || "product"}${size}, completely plain: no print, no picture, no text, no pattern, no logo.`,
    spec ? `The piece has EXACTLY the outline of the reference drawing${hole} (its filled area is the piece) — the same shape and proportions.` : "",
    "Shot straight on from the front (no perspective, no tilt), centred, the piece filling about 70% of the picture's width.",
    "Plain flat medium-grey seamless backdrop (#9a9a9a), soft even studio light, a faint natural shadow.",
    "Nothing attached or around it: no ribbon, no string, no hook, no hanger, no props, no hands.",
    "Photorealistic, the real material's surface and edge thickness.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Where the piece is on a phôi photo (photo px), found against the backdrop (the corners' colour), fitted to the
 * piece's own aspect; null when nothing sensible is found.
 */
export async function detectPieceBox(photo: Buffer, aspect: number): Promise<CtBounds | null> {
  const fullW = (await sharp(photo).metadata()).width ?? 0;
  const { data, info } = await sharp(photo).removeAlpha().resize({ width: 512, height: 512, fit: "inside" }).raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const ch = info.channels;
  const at = (x: number, y: number) => (y * W + x) * ch;
  const corners = [at(2, 2), at(W - 3, 2), at(2, H - 3), at(W - 3, H - 3)];
  const bg = [0, 1, 2].map((c) => corners.reduce((s, i) => s + data[i + c], 0) / corners.length);
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  let n = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = at(x, y);
      const d = Math.max(Math.abs(data[i] - bg[0]), Math.abs(data[i + 1] - bg[1]), Math.abs(data[i + 2] - bg[2]));
      if (d < 48) continue;
      n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  if (x1 < 0 || n < W * H * 0.03) return null;
  const k = fullW ? fullW / W : 1;
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > W * H * 0.95) return null;
  // The printable FACE, not the whole piece: a photo shows the edge's thickness (a light rim on one side, a darker one
  // on the other — a round ornament's face was ~3 % smaller and off-centre, the print lay over its rim, 2026-10-15).
  // The face = the pixels of the colour at the piece's middle, connected to it; a face that is not one plain colour
  // (wood, a pattern) keeps the whole piece.
  const face = plainFace(data, W, H, ch, { x0, y0, x1, y1 });
  if (face) ({ x0, y0, x1, y1 } = face);
  let w = x1 - x0 + 1;
  let h = y1 - y0 + 1;
  const cx = x0 + w / 2;
  if (Math.abs(w / aspect - h) / Math.max(h, 1) > 0.35) return null;
  if (face) {
    // The face found: the print COVERS it (bleed past the shorter side, never a bare strip), centred on it.
    const cy = y0 + h / 2;
    w = Math.max(w, h * aspect);
    h = w / aspect;
    return { x: (cx - w / 2) * k, y: (cy - h / 2) * k, w: w * k, h: h * k };
  }
  // The whole piece: width wins and the top edge holds (the shadow falls below it, nothing hangs above).
  h = w / aspect;
  return { x: (cx - w / 2) * k, y: y0 * k, w: w * k, h: h * k };
}

/** The plain face of a piece inside its box (512 px raw RGB): the middle's colour (median) flooded from the middle,
 * holes filled by taking the box of what is reached; null when it covers too little of the piece. */
function plainFace(data: Buffer, W: number, H: number, ch: number, b: { x0: number; y0: number; x1: number; y1: number }): { x0: number; y0: number; x1: number; y1: number } | null {
  const cx = Math.round((b.x0 + b.x1) / 2);
  const cy = Math.round((b.y0 + b.y1) / 2);
  const r = Math.max(2, Math.round((b.x1 - b.x0) * 0.08));
  const samples: number[][] = [[], [], []];
  for (let y = cy - r; y <= cy + r; y++)
    for (let x = cx - r; x <= cx + r; x++) for (let c = 0; c < 3; c++) samples[c].push(data[(y * W + x) * ch + c]);
  const med = samples.map((v) => v.sort((p, q) => p - q)[v.length >> 1]);
  // The middle's colour, or the same colour lit brighter: a glossy face has highlights (a ceramic ornament's top
  // band stopped the flood ~1 % short and the print left a strip bare, 2026-10-15). The rim's edge is darker.
  const like = (i: number) => {
    const d = [data[i] - med[0], data[i + 1] - med[1], data[i + 2] - med[2]];
    if (Math.max(...d.map(Math.abs)) <= 9) return true;
    return Math.min(...d) >= -4 && Math.max(...d) - Math.min(...d) <= 12;
  };
  const seen = new Uint8Array(W * H);
  const stack = [cy * W + cx];
  seen[cy * W + cx] = 1;
  let n = 0;
  const out = { x0: W, y0: H, x1: -1, y1: -1 };
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % W;
    const y = (p - x) / W;
    n++;
    if (x < out.x0) out.x0 = x;
    if (x > out.x1) out.x1 = x;
    if (y < out.y0) out.y0 = y;
    if (y > out.y1) out.y1 = y;
    for (const q of [p - 1, p + 1, p - W, p + W]) {
      const qx = q % W;
      const qy = (q - qx) / W;
      if (q < 0 || q >= W * H || seen[q] || Math.abs(qx - x) > 1 || qx < b.x0 || qx > b.x1 || qy < b.y0 || qy > b.y1) continue;
      seen[q] = 1;
      if (like(q * ch)) stack.push(q);
    }
  }
  const pieceArea = (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);
  const faceArea = (out.x1 - out.x0 + 1) * (out.y1 - out.y0 + 1);
  return n > pieceArea * 0.3 && faceArea > pieceArea * 0.8 ? out : null;
}

/** The sheet's box on a phôi photo from the piece's box there (the piece = the khuôn outline of the sheet). */
export function sheetBoxOn(piece: CtBounds, spec: Pick<CtPrintSpec, "width" | "height" | "outline">): CtBounds {
  const ob = pieceBounds(spec);
  const k = piece.w / Math.max(1, ob.w);
  return { x: piece.x - ob.x * k, y: piece.y - ob.y * k, w: spec.width * k, h: spec.height * k };
}

/** A phôi photo with no box found: the sheet in its middle 60 %, a little low (old guess). */
export function guessedBox(photoW: number, photoH: number, sheetW: number, sheetH: number): CtBounds {
  const w = photoW * 0.6;
  const h = (w * sheetH) / sheetW;
  return { x: (photoW - w) / 2, y: Math.max(0, photoH * 0.55 - h / 2), w, h };
}

/** A scene for a phôi photo: the sheet's box detected on it when the piece can be found, else guessed. */
export async function sceneForBlank(photo: Buffer, url: string, spec: Pick<CtPrintSpec, "width" | "height" | "outline">): Promise<CtProductScene> {
  const meta = await sharp(photo).metadata();
  const W = meta.width ?? 1024;
  const H = meta.height ?? 1024;
  const ob = pieceBounds(spec);
  const piece = await detectPieceBox(photo, ob.w / Math.max(1, ob.h)).catch(() => null);
  return { url, width: W, height: H, box: piece ? sheetBoxOn(piece, spec) : guessedBox(W, H, spec.width, spec.height) };
}

/**
 * Make a phôi trơn with the team's image model: the khuôn's outline as a line drawing goes with the prompt (`spec`
 * null = a product without a khuôn in: its name alone). Throws a message for the editor.
 */
export async function makeBlank(userId: string, label: string, spec: CtPrintSpec | null): Promise<Buffer> {
  const refs: string[] = [];
  let guide: string | null = null;
  if (spec?.faces[0]?.imageUrl && !spec.outline) refs.push(spec.faces[0].imageUrl);
  else if (spec) {
    guide = `${userId}/${CT_CONFIG.storagePrefix}/blank-guides/${crypto.randomUUID()}.png`;
    refs.push(await ctUpload(guide, await outlineDrawing(spec), "image/png"));
  }
  const model = CT_IMAGE_MODEL;
  let last = "";
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await drawImage(model, blankPrompt(label, spec), refs, "1:1", "crop");
        return out.data;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
    }
  } finally {
    if (guide) await ctRemove([guide]);
  }
  throw new Error(`Không tạo được phôi: ${last}`);
}

async function ownedProduct(s: CtSession, id: string): Promise<CtProduct | null> {
  const { data } = await s.supabase.from(CT_TABLES.products).select("*").eq("id", id).maybeSingle<CtProduct>();
  return data && (data.user_id === s.user.id || (await isAdmin(s))) ? data : null;
}

async function main(s: CtSession, product: CtProduct): Promise<CtAsset | null> {
  if (!product.main_asset_id) return null;
  const { data } = await s.supabase.from(CT_TABLES.assets).select("*").eq("id", product.main_asset_id).maybeSingle<CtAsset>();
  return data ?? null;
}

/** POST products/:id/blank */
export async function makeProductBlank(s: CtSession, productId: string): Promise<NextResponse> {
  const product = await ownedProduct(s, productId);
  if (!product) return jsonError("Không có quyền sửa sản phẩm này", 403);
  const config = normalizeProductConfig(product.config);
  const board = await main(s, product);
  const spec: CtPrintSpec | null = config.print?.spec ?? null;
  const sheet = spec ?? (board ? { width: board.width, height: board.height, outline: null } : null);
  if (!sheet) return jsonError("Sản phẩm chưa có khung thiết kế", 409);
  try {
    const photo = await makeBlank(s.user.id, config.print?.name || product.name, spec);
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(photo)], { type: "image/png" }), "phoi-tron.png");
    form.set("role", "reference");
    form.set("name", "Phôi trơn (AI)");
    const res = await uploadAsset(s, productId, form);
    const json = (await res.json()) as { asset?: CtAsset; error?: string };
    if (!res.ok || !json.asset) return jsonError(json.error ?? "Không lưu được phôi", 500);
    const scene = await sceneForBlank(photo, json.asset.url, sheet);
    const next = { ...config, scene };
    const { data, error } = await s.supabase.from(CT_TABLES.products).update({ config: next }).eq("id", productId).select("*").single<CtProduct>();
    if (error || !data) return jsonError(error?.message ?? "Không lưu được", 500);
    // The khuôn keeps it too: the next product / brief on the same piece reuses it (server/print-blanks.ts).
    if (config.print?.templateId) {
      const { getTemplate } = await import("./print-templates");
      const { addTemplateBlank } = await import("./print-blanks");
      const t = await getTemplate(s, config.print.templateId);
      if (t) await addTemplateBlank(s.supabase, s.user.id, t, photo, "Phôi AI", true).catch(() => undefined);
    }
    // The phôi it replaces, when it was one of this product's own pictures, goes.
    if (config.scene.url) {
      const { data: old } = await s.supabase.from(CT_TABLES.assets).delete().eq("product_id", productId).eq("role", "reference").eq("url", config.scene.url).select("storage_path").returns<Array<{ storage_path: string }>>();
      await ctRemove((old ?? []).map((o) => o.storage_path));
    }
    return NextResponse.json({ product: data, asset: json.asset });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không tạo được phôi", 500);
  }
}

// ---- mockups ------------------------------------------------------------------------------------------------

/** GET products/:id/mockups */
export async function listMockupJobs(s: CtSession, productId: string): Promise<NextResponse> {
  const { data, error } = await s.supabase.from(CT_TABLES.packImages).select("*").eq("name", jobName(productId)).order("created_at", { ascending: false }).limit(40).returns<CtPackImage[]>();
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ jobs: data ?? [] });
}

function parseScenes(raw: FormDataEntryValue | null): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().slice(0, 400)).slice(0, 6) : [];
  } catch {
    return [];
  }
}

/** POST products/:id/mockups */
export async function makeProductMockups(s: CtSession, productId: string, form: FormData): Promise<NextResponse> {
  const product = await ownedProduct(s, productId);
  if (!product) return jsonError("Không có quyền sửa sản phẩm này", 403);
  const file = form.get("print");
  if (!(file instanceof Blob) || !file.size) return jsonError("Thiếu artwork", 400);
  try {
    return NextResponse.json(await productMockups(s, product, Buffer.from(await file.arrayBuffer()), parseScenes(form.get("scenes"))), { status: 202 });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không lưu được mockup", 500);
  }
}

/**
 * The mockups of one print of a product (the editor's Mockups tab, a bộ nhân vật's step 4, @flexiprint over MCP —
 * one pipeline): the front one = the print laid exactly on the phôi with its own light (no AI, done now), + one AI
 * lifestyle photo per scene made from it (jobs running in the background). `label` names the front when several
 * prints (option sets) of one product are mocked up ("Christmas — Snowflakes").
 */
export async function productMockups(s: CtSession, product: CtProduct, print: Buffer, scenes: string[], label = ""): Promise<{ jobs: CtPackImage[]; front: CtAsset }> {
  const productId = product.id;
  const config = normalizeProductConfig(product.config);
  const piece = config.print?.name || product.name;
  const toProduct = async (data: Buffer, name: string): Promise<CtAsset> => {
    const f = new FormData();
    f.set("file", new Blob([new Uint8Array(data)], { type: "image/jpeg" }), `${name}.jpg`);
    f.set("role", "mockup");
    f.set("name", name);
    const res = await uploadAsset(s, productId, f);
    const json = (await res.json()) as { asset?: CtAsset; error?: string };
    if (!res.ok || !json.asset) throw new Error(json.error ?? "Không lưu được mockup");
    return json.asset;
  };

  // The front one: the artwork laid exactly on the phôi (its own light and shade), no AI. Without a phôi: on white.
  let front: Buffer;
  if (config.scene.url && config.scene.box.w > 0) front = await frontMockup(await fetchImage(config.scene.url), print, config.scene.box);
  else {
    const m = await sharp(print).metadata();
    const pad = Math.round(Math.max(m.width ?? 0, m.height ?? 0) * 0.08);
    front = await sharp(print).flatten({ background: "#ffffff" }).extend({ top: pad, bottom: pad, left: pad, right: pad, background: "#ffffff" }).jpeg({ quality: 92 }).toBuffer();
  }
  const frontAsset = await toProduct(front, label ? `mockup_front_${label.replace(/[^\w]+/g, "_").slice(0, 40)}` : "mockup_front");
  const meta = await sharp(front).metadata();
  const db = ctServiceClient() ?? s.supabase;
  const { data: frontRow } = await db
    .from(CT_TABLES.packImages)
    .insert({ user_id: s.user.id, name: jobName(productId), source: "ai", status: "done", listed: false, url: frontAsset.url, storage_path: null, mime: "image/jpeg", width: meta.width ?? null, height: meta.height ?? null, description: label ? `Chụp thẳng trên phôi — ${label}` : "Chụp thẳng trên phôi (chính xác)", prompt: "", refs: [], aspect: "", model: "" })
    .select("*")
    .single<CtPackImage>();

  const want = scenes.length ? scenes : [`on a bright minimal surface with soft daylight and a few props that suit a ${piece}`];
  const model = CT_IMAGE_MODEL;
  const rows: CtPackImage[] = [];
  for (const sc of want) {
    const prompt = `Lifestyle product photo of this exact ${piece} ${sc}. The product is shown as a real physical object in a fitting, beautiful setting (the finished product with any hanger, ribbon or stand it would really have).${KEEP_PRINT}`;
    const { data: row } = await db
      .from(CT_TABLES.packImages)
      .insert({ user_id: s.user.id, name: jobName(productId), source: "ai", status: "running", listed: false, description: sc, prompt, refs: [frontAsset.url], aspect: "4:5", model })
      .select("*")
      .single<CtPackImage>();
    if (row) rows.push(row);
  }
  for (const row of rows)
    void (async () => {
      let last = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const out = await drawImage(model, row.prompt, [frontAsset.url], "4:5", "crop");
          const jpeg = await sharp(out.data).flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer();
          const asset = await toProduct(jpeg, `mockup_${row.description.split(/\s+/).slice(0, 4).join("_")}`);
          const m = await sharp(jpeg).metadata();
          await db.from(CT_TABLES.packImages).update({ status: "done", url: asset.url, mime: "image/jpeg", width: m.width ?? null, height: m.height ?? null, error: "" }).eq("id", row.id);
          return;
        } catch (e) {
          last = e instanceof Error ? e.message : String(e);
        }
      }
      await db.from(CT_TABLES.packImages).update({ status: "failed", error: last.slice(0, 1000) }).eq("id", row.id);
    })();
  return { jobs: [...rows, ...(frontRow ? [frontRow] : [])], front: frontAsset };
}
