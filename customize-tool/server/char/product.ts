/**
 * A product from a bộ nhân vật's layer set — one set, many products (bag, mug, sticker…).
 *
 *   POST char/projects/:id/products {name?} → { productId } a draft product, opened in the editor
 *
 * With it comes a clipart set (asked 2026-10-10): the product's folder in the library — a category with the
 * product's name (server/artworks.ts) — holds every layer file as a clipart (a group's first file the gốc, the others
 * its đa sắc); the product's layers use those cliparts, and its artworks are saved into the same folder. On a khuôn in
 * the canvas is its sheet; without one the edit frame IS the print file's frame (the set's canvas, + a band for the
 * text). The phôi trơn — uploaded, else the AI one (server/char/blank.ts) — becomes the product photo (config.scene).
 *
 * Built by the layer rules: every image layer gets the SAME box (the set's canvas fitted into the print, aspect
 * kept, transforms identity → files land 1:1); z-order fixed bottom → top: wrapping parts' back halves, body,
 * customer photo zones, colour / texture parts, shape parts (front halves), text. A back half follows its front
 * half (config.image.follows) with groups in the same order. The blank product photo becomes the product scene;
 * a die-cut (alpha) product prints on a contour plate cut around the composite.
 */

import { NextResponse } from "next/server";
import sharp from "sharp";
import { CT_FONTS, CT_TABLES } from "../../config";
import type { CtAsset, CtCharBrief, CtCharElement, CtCharShownWhen, CtCharImage, CtCharLayerFile, CtCharLayerSet, CtCharLayerSlot, CtCharProject, CtCharTextField, CtCharTextPlace, CtPhotoStyleRef, CtProduct, CtRegion, CtRegionItem, CtShape } from "../../types";
import { defaultProductConfig, defaultRegionConfig } from "../../lib/design";
import { applyMaterialPreset, isMaterialId } from "../../lib/materials";
import { charLayout, type CtCharLayoutText, type CtLayoutBox } from "../../lib/char-layout";
import { charElementBoxes, charVersions, fromShares, subjectName, underText, unionBox } from "../../lib/char-lineup";
import { elementPictures, latestElementImages } from "./elements";
import { latestBackdrops } from "./backdrops";
import { latestEditsOf } from "../../lib/char-images";
import * as h from "../handlers";
import type { CtSession } from "../supabase";
import { fetchImage } from "./files";
import { NOT_YOURS, canEditProject, jobDb, jsonError, loadImages, loadProject, projectRow, type Db } from "./projects";
import { getTemplate } from "../print-templates";
import { makeTemplateProduct, productPrintOf } from "../print-products";
import { safeShapes } from "../../lib/print-template";
import { shapeBounds } from "../../lib/geometry";
import type { CtPrintSpec } from "../../types/print";
import { findProductFolder, productFolder } from "../artworks";
import { ctRemove } from "../storage";
import { insertClipart } from "../library";
import { guessedBox, sceneForBlank } from "../product-mockups";
import { AI_BLANK_ROLE, projectBlank } from "./blank";
import { buildPhotoProduct, trimmed, type KeptZone } from "./photo-product";
import { CT_FACE_STYLES } from "../../lib/photo-styles";
import { isFace } from "../../lib/char-plan";

/** A personalised text of the brief as a text layer in its box (lib/char-layout). Over a patterned background the
 * letters get a light halo so they read. */
export function textRegion(productId: string, mainId: string, t: CtCharTextField, at: CtCharLayoutText, onPattern: boolean, order: number): CtRegion {
  const cfg = defaultRegionConfig("text");
  const font = CT_FONTS.find((f) => f.family === t.font) ?? CT_FONTS.find((f) => f.family === "Great Vibes")!;
  const first = t.kind === "choice" ? (t.choices[0] ?? "") : t.defaultText;
  return {
    id: crypto.randomUUID(),
    product_id: productId,
    name: `Chữ — ${t.label}`,
    kind: "text",
    shape: { type: "rect", ...at.box, radius: 0 },
    config: {
      ...cfg,
      mainId,
      text: {
        ...cfg.text,
        mode: t.kind === "choice" ? "list" : t.kind === "fixed" ? "fixed" : "input",
        label: t.label,
        placeholder: t.kind === "input" ? `Example: ${t.defaultText}` : "",
        defaultText: first,
        choices: t.kind === "choice" ? t.choices : [],
        // A fixed line is never cut ("This Grandma Belongs To" lost its "To" at 20, 2026-10-19).
        maxChars: Math.max(t.maxChars, ...t.choices.map((c) => c.length), t.kind === "fixed" ? t.defaultText.length : 0),
        fontFamily: font.family,
        // Bold for a slogan, a fixed line (the sign) and a name on a hat — like the samples.
        fontWeight: font.weights.includes(700) && (t.kind !== "input" || t.place === "on") ? 700 : font.weights[0],
        fontSize: at.fontSize,
        color: t.color,
        ...(onPattern ? { strokeColor: "#fffaf0", strokeWidth: Math.max(2, Math.round(at.fontSize * (t.kind === "choice" ? 0.16 : 0.12))) } : {}),
        align: at.align,
        curve: at.curve || t.curve || 0,
        uppercase: t.uppercase === true,
      },
    },
    sort_order: order,
  };
}

/**
 * How a bộ nhân vật's photo zone shows the customer's photo (brief photoZones[].treat): a face on an elf body is the
 * head only, cut out, fitted to the zone (asked 2026-10-15 — the die-cut elf ornament with the customers' faces);
 * an AI zone offers its styles; a framed photo fills its frame as uploaded.
 */
function zonePhoto(brief: CtCharBrief, zoneId: string): Partial<CtRegion["config"]["photo"]> {
  const z = brief.photoZones.find((x) => x.id === zoneId);
  const treat = z?.treat ?? "photo";
  if (treat === "face") return { mode: "face", styles: CT_FACE_STYLES.map((x) => x.id), defaultStyle: CT_FACE_STYLES[0].id, styleLabel: "Filter", fit: "contain", cutout: true, fadeCrop: false };
  if (treat === "ai" && z?.styles?.length) return { mode: "ai", styles: z.styles as CtPhotoStyleRef[], defaultStyle: z.styles[0] as CtPhotoStyleRef, styleLabel: "Choose Style", fit: "contain", cutout: true, fadeCrop: true };
  return { fit: "cover", cutout: false, fadeCrop: false };
}

/** A layer file with polygons (its own canvas px) cut out of it — the hole a face zone is seen through. */
async function punched(png: Buffer, polygons: number[][][]): Promise<Buffer> {
  const m = await sharp(png).metadata();
  const paths = polygons.map((pts) => `<path d="M${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join("L")}Z" fill="#000"/>`).join("");
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${m.width}" height="${m.height}">${paths}</svg>`);
  return sharp(png).ensureAlpha().composite([{ input: mask, blend: "dest-out" }]).png().toBuffer();
}

/** Print width (mm) of a product without a khuôn in or a size in the brief. */
const DEFAULT_MM = 220;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

async function body<T>(res: NextResponse): Promise<T> {
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

/** "Younger daughter, about 6…" → "Younger daughter"; two subjects with the same words (two older women) get where
 * they stand, so the customer can tell whose dress they pick: "Older woman in her late 60s (left)". */
function who(brief: CtCharBrief, slotKey: string): { name: string; part: string } {
  const id = slotKey.split(":")[0];
  const short = (d: string) => {
    const x = d.split(/[,.;]/)[0].trim();
    return x ? x[0].toUpperCase() + x.slice(1) : "Character";
  };
  for (const [i, sub] of brief.subjects.entries()) {
    const slot = sub.slots.find((s) => s.id === id);
    if (!slot) continue;
    if (sub.name?.trim()) return { name: sub.name.trim(), part: slot.part };
    const name = short(sub.description);
    const same = brief.subjects.filter((x) => short(x.description) === name);
    if (same.length < 2) return { name, part: slot.part };
    const k = same.indexOf(brief.subjects[i]);
    const where = k === 0 ? "left" : k === same.length - 1 ? "right" : ["middle", "second", "third", "fourth"][Math.min(k, 3)];
    return { name: `${name} (${where})`, part: slot.part };
  }
  return { name: "", part: "" };
}

function swatchOf(brief: CtCharBrief, slotKey: string, optionName: string, colorName: string): string | undefined {
  const id = slotKey.split(":")[0];
  for (const sub of brief.subjects)
    for (const slot of sub.slots) {
      if (slot.id !== id) continue;
      const hex = slot.mode === "shape" ? slot.colors.find((c) => c.name === colorName)?.value : slot.mode === "color" ? slot.options.find((o) => o.name === optionName)?.value : undefined;
      return hex && /^#[0-9a-f]{6}$/i.test(hex) ? hex : undefined;
    }
  return undefined;
}

/** POST char/projects/:id/products */
export async function createCharProduct(s: CtSession, id: string, raw: unknown): Promise<NextResponse> {
  const p = await loadProject(s.supabase, id);
  if (!p) return jsonError("Không tìm thấy bộ nhân vật", 404);
  // A bộ ảnh khách: one product, made again from the drawn pieces (server/char/photo-product.ts).
  if (p.brief.kind === "photo") return remakeCharProduct(s, id);
  const set = p.layers;
  if (!set || set.status !== "done") return jsonError("Cắt layer trước", 409);
  if (!set.approved) return jsonError("Duyệt bộ file cuối (bước 3d) trước", 409);
  const name = raw && typeof raw === "object" && typeof (raw as { name?: unknown }).name === "string" && (raw as { name: string }).name.trim() ? (raw as { name: string }).name.trim().slice(0, 200) : `${p.name}`;
  try {
    const productId = await build(s, p, set, name);
    await s.supabase.from(CT_TABLES.charProjects).update({ product_ids: [...p.product_ids, productId], status: "product" }).eq("id", id);
    return NextResponse.json({ productId }, { status: 201 });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không tạo được sản phẩm", 500);
  }
}

/** POST char/projects/:id/products/remake — the set's product built again from the current set and brief (new
 * backgrounds / texts of step 4), replacing the set's products like "Tạo bộ custom" does. */
export async function remakeCharProduct(s: CtSession, id: string): Promise<NextResponse> {
  const p = await loadProject(s.supabase, id);
  if (!p) return jsonError("Không tìm thấy bộ nhân vật", 404);
  if (!(await canEditProject(s, p))) return jsonError(NOT_YOURS, 403);
  const photo = p.brief.kind === "photo";
  if (!photo && (p.layers?.status !== "done" || !p.layers.approved)) return jsonError("Tạo bộ custom ở bước 3c trước", 409);
  try {
    const productId = await remakeSetProduct(jobDb(s), p.user_id ?? s.user.id, p, p.layers);
    await jobDb(s).from(CT_TABLES.charProjects).update({ product_ids: [productId], status: "product" }).eq("id", id);
    return NextResponse.json({ productId }, { status: 201 });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không dựng lại được sản phẩm", 500);
  }
}

/**
 * "Tạo bộ custom" ends here (asked 2026-10-10: the set IS the cliparts + a finished product, ready in the editor):
 * the cut that just finished (layers.ts runBuild, minutes after the request — the service client acting as the
 * project's owner) replaces the products made from the set before — each with its clipart folder — by ONE new
 * product built from `set`. → the new product id.
 */
/** A session acting as `userId` on the service client (background jobs, @flexiprint over MCP). */
export async function serviceSession(db: CtSession["supabase"], userId: string): Promise<CtSession> {
  const { data, error } = await db.auth.admin.getUserById(userId);
  if (error || !data.user) throw new Error(`Không đọc được người dùng: ${error?.message ?? "không có"}`);
  return { supabase: db, user: data.user };
}

export async function remakeSetProduct(db: CtSession["supabase"], userId: string, p: CtCharProject, set: CtCharLayerSet | null, opts: { resetZones?: boolean } = {}): Promise<string> {
  const s = await serviceSession(db, userId);
  // Customer photo zones the editor reshaped in the product (asked 2026-10-15: the zone stays editable after
  // @flexiprint made it) are kept by name — unless asked to start from the set's own layout again.
  const kept = new Map<string, KeptZone>();
  if (!opts.resetZones && p.product_ids.length) {
    const { data: old } = await db.from(CT_TABLES.regions).select("*").in("product_id", p.product_ids).eq("kind", "photo").returns<CtRegion[]>();
    for (const r of old ?? []) kept.set(r.name, { shape: r.shape, frame: r.config.photo.frame });
  }
  for (const pid of p.product_ids) {
    const folder = await findProductFolder(db, pid);
    if (folder) {
      const { data: cliparts } = await db.from(CT_TABLES.assets).select("id, storage_path").eq("category_id", folder.id).returns<Array<Pick<CtAsset, "id" | "storage_path">>>();
      await ctRemove((cliparts ?? []).map((c) => c.storage_path).filter(Boolean));
      await db.from(CT_TABLES.assets).delete().eq("category_id", folder.id);
      await db.from(CT_TABLES.categories).delete().eq("id", folder.id);
    }
    await h.deleteProduct(s, pid);
  }
  if (p.brief.kind === "photo") return buildPhotoProduct(s, p, p.name, kept);
  if (!set) throw new Error("Bộ chưa có file layer");
  return build(s, p, set, p.name, kept);
}

/**
 * A body file split per subject (asked 2026-10-18: the customer picks who is in the picture — each one's body is its
 * own layer). The subjects stand apart in the master (lib/char-brief LINEUP_LINE): every connected piece of the body
 * goes to the subject whose centre is nearest; a piece that holds two centres (two figures that touch) is split between
 * them pixel by pixel, by x. `centres` are x on the canvas, left → right.
 */
async function splitBody(png: Buffer, centres: number[]): Promise<Buffer[]> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const n = W * H;
  const label = new Int32Array(n).fill(-1);
  const comps: Array<{ minX: number; maxX: number; sumX: number; count: number }> = [];
  const stack = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (label[i] >= 0 || data[i * 4 + 3] <= 8) continue;
    const id = comps.length;
    const c = { minX: W, maxX: -1, sumX: 0, count: 0 };
    let top = 0;
    stack[top++] = i;
    label[i] = id;
    while (top) {
      const j = stack[--top];
      const x = j % W;
      c.count++;
      c.sumX += x;
      if (x < c.minX) c.minX = x;
      if (x > c.maxX) c.maxX = x;
      const y = (j - x) / W;
      const near = [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, y > 0 ? j - W : -1, y < H - 1 ? j + W : -1];
      for (const k of near) if (k >= 0 && label[k] < 0 && data[k * 4 + 3] > 8) {
        label[k] = id;
        stack[top++] = k;
      }
    }
    comps.push(c);
  }
  const nearest = (x: number, among: number[]) => among.reduce((best, s) => (Math.abs(centres[s] - x) < Math.abs(centres[best] - x) ? s : best), among[0]);
  const all = centres.map((_, i) => i);
  // A piece → its subject, or -1 = split by x among the centres inside it.
  const owner = comps.map((c) => {
    const inside = all.filter((s) => centres[s] >= c.minX && centres[s] <= c.maxX);
    return inside.length >= 2 ? { split: inside } : { to: nearest(c.sumX / c.count, all) };
  });
  const outs = centres.map(() => Buffer.alloc(n * 4));
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3];
    if (!a) continue;
    const x = i % W;
    const l = label[i];
    const o = l >= 0 ? owner[l] : null;
    const s = o && "to" in o ? o.to! : nearest(x, o && "split" in o ? o.split! : all);
    data.copy(outs[s], i * 4, i * 4, i * 4 + 4);
  }
  return Promise.all(outs.map((b) => sharp(b, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer()));
}

/** How strongly a pixel is the doll's magenta (lib/char-plan DOLL_COLOUR): its red and blue over its green. */
const keyness = (r: number, g: number, b: number) => Math.min(r, b) - g;

/**
 * The doll's magenta never shows on a product (found 2026-10-18 on the family rug: a magenta line along the mom's hair
 * over her t-shirt, a sliver of the shorts between a t-shirt and pants). The standard chroma-key clean-up, the same for
 * every set:
 *   body    the doll's underwear left uncovered is a shadow (dark), not magenta
 *   option  a key-coloured pixel near the file's edge is the doll mixed into its outline (the AI drew the hair over
 *           the magenta top): gone. A file that IS magenta / purple (a purple dress) is left alone.
 */
export async function cleanKey(png: Buffer, body: boolean): Promise<Buffer> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  let changed = 0;
  if (body) {
    for (let i = 0; i < W * H; i++) {
      const o = i * 4;
      if (!data[o + 3] || keyness(data[o], data[o + 1], data[o + 2]) <= 50) continue;
      const y = (data[o] + data[o + 1] + data[o + 2]) / 3;
      data[o] = Math.round(28 + y * 0.12);
      data[o + 1] = Math.round(24 + y * 0.1);
      data[o + 2] = Math.round(30 + y * 0.12);
      changed++;
    }
  } else {
    const ks: number[] = [];
    for (let i = 0; i < W * H; i += 7) if (data[i * 4 + 3] > 128) ks.push(keyness(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]));
    ks.sort((a, b) => a - b);
    // A magenta / purple part: its own colour, never cleaned.
    if (!ks.length || ks[Math.floor(ks.length * 0.9)] > 25) return png;
    // Distance to the transparent outside, up to 4 px.
    const near = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) if (data[i * 4 + 3] < 20) near[i] = 1;
    let edge = near;
    for (let step = 0; step < 4; step++) {
      const next = new Uint8Array(edge);
      for (let y = 1; y < H - 1; y++)
        for (let x = 1; x < W - 1; x++) {
          const i = y * W + x;
          if (!edge[i] && (edge[i - 1] || edge[i + 1] || edge[i - W] || edge[i + W])) next[i] = 1;
        }
      edge = next;
    }
    for (let i = 0; i < W * H; i++) {
      const o = i * 4;
      if (data[o + 3] && edge[i] && keyness(data[o], data[o + 1], data[o + 2]) > 30) {
        data[o + 3] = 0;
        changed++;
      }
    }
  }
  return changed ? sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer() : png;
}

/** [x, y, w, h] of the visible pixels. */
/** A hat's brim / cuff on its file (canvas coordinates): in its lower part, the band of rows whose solid run through
 * the hat's middle is the longest — the Santa hat's cuff, a witch hat's band, a beanie's fold. Measured through the
 * middle so the pom-pom hanging at the side does not count (it pulled the names below the cuff, 2026-10-19). Asked
 * 2026-10-19: names on the hats, no box in the brief. */
async function brimBox(png: Buffer): Promise<CtLayoutBox | null> {
  const { data, info } = await sharp(png).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const solid = (x: number, y: number) => data[y * W + x] > 128;
  let top = -1;
  let bottom = -1;
  let left = W;
  let right = -1;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < W; x++)
      if (solid(x, y)) {
        if (top < 0) top = y;
        bottom = y;
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
  if (top < 0) return null;
  const h = bottom - top + 1;
  const mid = Math.round((left + right) / 2);
  // The solid run through the middle column of a row (none when the middle is clear).
  const run = (y: number): [number, number] | null => {
    if (!solid(mid, y)) return null;
    let a = mid;
    let b = mid;
    while (a > 0 && solid(a - 1, y)) a--;
    while (b < W - 1 && solid(b + 1, y)) b++;
    return [a, b];
  };
  const len = (y: number) => {
    const r = run(y);
    return r ? r[1] - r[0] + 1 : 0;
  };
  let best = -1;
  for (let y = top + Math.floor(h * 0.4); y <= bottom; y++) if (best < 0 || len(y) > len(best)) best = y;
  if (best < 0 || len(best) === 0) return null;
  const wide = len(best) * 0.85;
  let y0 = best;
  let y1 = best;
  while (y0 > top && len(y0 - 1) >= wide) y0--;
  while (y1 < bottom && len(y1 + 1) >= wide) y1++;
  // A thin band still gets a readable line (≥ 14 % of the hat).
  const need = Math.round(h * 0.14) - (y1 - y0 + 1);
  if (need > 0) {
    y0 = Math.max(top, y0 - Math.ceil(need / 2));
    y1 = Math.min(bottom, y1 + Math.floor(need / 2));
  }
  let x0 = Infinity;
  let x1 = -Infinity;
  for (let y = y0; y <= y1; y++) {
    const r = run(y);
    if (r) {
      x0 = Math.min(x0, r[0]);
      x1 = Math.max(x1, r[1]);
    }
  }
  const inset = (x1 - x0) * 0.1;
  return { x: x0 + inset, y: y0, w: x1 - x0 - 2 * inset, h: y1 - y0 + 1 };
}

async function alphaBox(png: Buffer): Promise<CtLayoutBox | null> {
  const { data, info } = await sharp(png).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  let x0 = info.width;
  let y0 = info.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++)
      if (data[y * info.width + x] > 12) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** A repeating background's tile (backdrop.tile): the picture beside its mirror, over both mirrored — every seam meets
 * itself, so the repeat never shows an edge. `across` only: mirrored left ↔ right (a band of ground). */
export async function seamlessTile(raw: Buffer, across = false): Promise<Buffer> {
  // A pattern square comes padded with white to the canvas (the model drew it wider): only the pattern repeats.
  let png = raw;
  if (!across) {
    // The pattern without the white padding, and 3 px of each edge (blended with the padding).
    const t = await sharp(raw).trim({ background: "#ffffff", threshold: 12 }).png().toBuffer();
    const tm = await sharp(t).metadata();
    png = await sharp(t).extract({ left: 3, top: 3, width: (tm.width ?? 10) - 6, height: (tm.height ?? 10) - 6 }).png().toBuffer();
  }
  const m = await sharp(png).metadata();
  const w = m.width ?? 1024;
  const h = m.height ?? 1024;
  const flop = await sharp(png).flop().png().toBuffer();
  if (across)
    return sharp({ create: { width: 2 * w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: png, left: 0, top: 0 }, { input: flop, left: w, top: 0 }])
      .png()
      .toBuffer();
  const flip = await sharp(png).flip().png().toBuffer();
  const both = await sharp(png).flip().flop().png().toBuffer();
  return sharp({ create: { width: 2 * w, height: 2 * h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: png, left: 0, top: 0 }, { input: flop, left: w, top: 0 }, { input: flip, left: 0, top: h }, { input: both, left: w, top: h }])
    .png()
    .toBuffer();
}

/** The pieces of an outfit file (alpha components): the headwear = the piece with the topmost pixel and every piece
 * that starts above its bottom (a pom-pom apart from the hat); the rest is the top (a sweater). The face lies between
 * them, so they never touch (asked 2026-10-19: the hats lie over the hair, the sweaters under it). */
async function splitHeadwear(png: Buffer): Promise<{ hat: Buffer; rest: Buffer }> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const n = W * H;
  const label = new Int32Array(n).fill(-1);
  const comps: Array<{ minY: number; maxY: number; count: number }> = [];
  const stack = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (label[i] >= 0 || data[i * 4 + 3] <= 8) continue;
    const id = comps.length;
    const c = { minY: H, maxY: -1, count: 0 };
    let top = 0;
    stack[top++] = i;
    label[i] = id;
    while (top) {
      const j = stack[--top];
      const x = j % W;
      const y = (j - x) / W;
      c.count++;
      if (y < c.minY) c.minY = y;
      if (y > c.maxY) c.maxY = y;
      const near = [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, y > 0 ? j - W : -1, y < H - 1 ? j + W : -1];
      for (const k of near)
        if (k >= 0 && label[k] < 0 && data[k * 4 + 3] > 8) {
          label[k] = id;
          stack[top++] = k;
        }
    }
    comps.push(c);
  }
  const big = comps.map((c, i) => ({ ...c, i })).filter((c) => c.count >= 200);
  const first = big.sort((a, b) => a.minY - b.minY)[0];
  const isHat = new Set(first ? big.filter((c) => c.minY < first.maxY && c.maxY <= first.maxY + (first.maxY - first.minY) * 0.25).map((c) => c.i) : []);
  const hat = Buffer.alloc(n * 4);
  const rest = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    if (!data[i * 4 + 3]) continue;
    data.copy(isHat.has(label[i]) ? hat : rest, i * 4, i * 4, i * 4 + 4);
  }
  const out = (b: Buffer) => sharp(b, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  return { hat: await out(hat), rest: await out(rest) };
}

/**
 * A plank sign stretched to `aspect` (w / h) the way a real one is made longer: its decorated ends kept as drawn, the
 * plain middle (the columns where nothing rises above the plank's top edge) mirrored and repeated — one sign picture
 * serves the short version of one grandchild and the long one of four (asked 2026-10-19).
 */
async function stretchPlank(png: Buffer, aspect: number): Promise<Buffer> {
  const { data, info } = await sharp(png).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  const W0 = info.width;
  const H0 = info.height;
  const Wt = Math.max(8, Math.round(H0 * aspect));
  if (Math.abs(Wt - W0) <= 2) return png;
  const top = Array.from({ length: W0 }, (_, x) => {
    for (let y = 0; y < H0; y++) if (data[y * W0 + x] > 128) return y;
    return H0;
  });
  const mid = top.slice(Math.round(W0 * 0.4), Math.round(W0 * 0.6)).sort((p, q) => p - q);
  const plankTop = mid[mid.length >> 1] ?? 0;
  const plain = (x: number) => top[x] >= plankTop - H0 * 0.03;
  let m0 = Math.round(W0 / 2);
  let m1 = m0;
  while (m0 > 0 && plain(m0 - 1)) m0--;
  while (m1 < W0 - 1 && plain(m1 + 1)) m1++;
  // A little inside the plain run (the decorations' soft edges).
  // Each end at least a fifth of the sign: a decoration lying on the plank (holly that does not rise above its top
  // edge) is no dip in the outline (2026-10-19: the right end lost its holly).
  const pad = Math.round((m1 - m0) * 0.04);
  m0 = Math.max(m0 + pad, Math.round(W0 * 0.22));
  m1 = Math.min(m1 - pad, W0 - 1 - Math.round(W0 * 0.22));
  const left = m0;
  const right = W0 - 1 - m1;
  const run = m1 - m0 + 1;
  const need = Wt - left - right;
  if (run < 8 || need < 8) return sharp(png).resize({ width: Wt, height: H0, fit: "fill" }).png().toBuffer();
  const crop = (x: number, width: number) => sharp(png).extract({ left: x, top: 0, width, height: H0 }).png().toBuffer();
  const parts: Array<{ input: Buffer; left: number; top: number }> = [{ input: await crop(0, left), left: 0, top: 0 }];
  if (need <= run) parts.push({ input: await crop(m0 + Math.floor((run - need) / 2), need), left, top: 0 });
  else {
    const a = await crop(m0, run);
    const b = await sharp(a).flop().png().toBuffer();
    for (let x = 0, k = 0; x < need; x += run, k++) {
      const w = Math.min(run, need - x);
      const tile = w === run ? (k % 2 ? b : a) : await sharp(k % 2 ? b : a).extract({ left: 0, top: 0, width: w, height: H0 }).png().toBuffer();
      parts.push({ input: tile, left: left + x, top: 0 });
    }
  }
  parts.push({ input: await crop(m1 + 1, right), left: left + need, top: 0 });
  return sharp({ create: { width: left + need + right, height: H0, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(parts).png().toBuffer();
}

/** The sign in front of the characters (element place "plaque"), shares of the characters' crop: its top a little
 * over their cut-off bottom (the forearms rest on it), a quarter of the piece's height, a little wider than them. */
const PLAQUE = { top: 0.93, h: 0.31, w: 1.06 };
/** The lettering on the sign: the plain middle, between the decorated ends. */
const PLAQUE_TEXT = { x: 0.2, y: 0.22, w: 0.6, h: 0.52 };

/** One set a product version is made of: the set itself, or a version set of a drawn lineup (brief.lineup.drawn). */
interface Source {
  p: CtCharProject;
  set: CtCharLayerSet;
  images: CtCharImage[];
}

/** A version of the product: its customer name, the set its layers come from, the subjects (of that set) in it. */
interface Version {
  name: string;
  src: Source;
  subjects: number[];
}

/** The version sets of a drawn lineup, by position (server/char/versions.ts makes them). */
export async function versionSetsOf(db: Db, parentId: string): Promise<CtCharProject[]> {
  const { data } = await db.from(CT_TABLES.charProjects).select("*").eq("brief->versionOf->>id", parentId).returns<CtCharProject[]>();
  return (data ?? []).map(projectRow).sort((a, b) => (a.brief.versionOf?.index ?? 0) - (b.brief.versionOf?.index ?? 0));
}

async function build(s: CtSession, p: CtCharProject, set: CtCharLayerSet, name: string, keptZones: Map<string, KeptZone> = new Map()): Promise<string> {
  const brief = p.brief;
  // On a khuôn in (brief.product.templateId): the product's canvas is its sheet, the characters sit in its safe zone.
  const template = brief.product.templateId ? await getTemplate(s, brief.product.templateId) : null;
  const product = template ? await makeTemplateProduct(s.supabase, s.user.id, template, name) : (await body<{ product: CtProduct }>(await h.createProduct(s, { name }))).product;
  // The product's clipart set: its folder in the library, named after it.
  const folder = await productFolder(s.supabase, s.user.id, { id: product.id, name });
  const clipart = (data: Buffer, assetName: string, parentId: string | null, meta: CtAsset["meta"]): Promise<CtAsset> =>
    insertClipart(s.supabase, s.user.id, { categoryId: folder.id, parentId, rendition: false, name: assetName, spec: "", tags: [], source: "ai", meta, generationId: null, data });
  const upload = async (data: Buffer, role: string, assetName: string, parentId: string | null = null, meta: Record<string, unknown> = {}): Promise<CtAsset> => {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(data)], { type: "image/png" }), `${assetName || role}.png`);
    form.set("role", role);
    form.set("name", assetName);
    if (parentId) form.set("parent_id", parentId);
    form.set("meta", JSON.stringify(meta));
    return (await body<{ asset: CtAsset }>(await h.uploadAsset(s, product.id, form))).asset;
  };

  // The print canvas: the template's sheet, else the set's own canvas (transparent).
  const mmW = template?.spec.widthMm || brief.product.widthMm || DEFAULT_MM;
  let main: CtAsset;
  let W: number;
  let H: number;
  let keep: CtRegion[] = [];
  let sheetPng: Buffer;
  if (template) {
    const { data: sheet } = await s.supabase.from(CT_TABLES.assets).select("*").eq("id", product.main_asset_id ?? "").single<CtAsset>();
    if (!sheet) throw new Error("Không thấy tờ in của khuôn");
    main = sheet;
    W = template.spec.width;
    H = template.spec.height;
    sheetPng = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    // The khuôn layer made with the product stays (saveDesign replaces the regions).
    const { data: frames } = await s.supabase.from(CT_TABLES.regions).select("*").eq("product_id", product.id).returns<CtRegion[]>();
    keep = frames ?? [];
  } else {
    // No khuôn in: the edit frame is the print file's frame — the set's canvas, bands for the texts around it.
    const has = (p: CtCharTextPlace) => brief.texts.some((t) => t.place === p);
    const bandH = Math.round(set.height * 0.16);
    W = Math.round(set.width * (has("left") || has("right") ? 1.6 : 1));
    H = set.height + (has("top") ? bandH : 0) + (has("bottom") || has("under") ? bandH : 0);
    sheetPng = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    main = await upload(sheetPng, "main", `Khung in ${W}×${H}`);
  }

  // Characters + texts (lib/char-layout.ts): the set's canvas fitted, aspect kept exactly, into the template's safe
  // zone (the whole frame without one) with the texts around it.
  const safe = template ? safeShapes(template.spec)[0] : undefined;
  const area = template ? (safe ? shapeBounds(safe) : { x: 0, y: 0, w: W, h: H }) : { x: 0, y: 0, w: W, h: H };
  const piece = template?.spec.outline ? shapeBounds(template.spec.outline) : { x: 0, y: 0, w: W, h: H };
  const D = Math.min(area.w, area.h);
  const layout = charLayout({
    area,
    round: safe?.type === "ellipse",
    holes: template ? template.spec.cuts.map(shapeBounds) : [],
    set: { width: set.width, height: set.height },
    texts: brief.texts,
  });
  // Where the characters may go: the brief's box, else what the texts left (the layout's own fit of the whole set).
  const charArea: CtLayoutBox = brief.charactersBox ? fromShares(area, brief.charactersBox) : layout.characters;

  const images = await loadImages(s.supabase, p.id);
  const fileCache = new Map<string, Buffer>();
  const bytes = async (url: string) => {
    const hit = fileCache.get(url);
    if (hit) return hit;
    const b = await fetchImage(url);
    fileCache.set(url, b);
    return b;
  };

  // ---- the versions, each from its own set ----
  const own: Source = { p, set, images };
  const named = charVersions(brief);
  const drawn = brief.lineup?.drawn === true && named.length > 1;
  let versions: Version[];
  if (drawn) {
    // The biggest version is this set; each smaller one its own version set (server/char/versions.ts).
    const children = await versionSetsOf(s.supabase, p.id);
    versions = [];
    for (const [i, v] of named.entries()) {
      if (i === named.length - 1) {
        versions.push({ name: v.name, src: own, subjects: brief.subjects.map((_, k) => k) });
        continue;
      }
      const c = children.find((x) => x.brief.versionOf?.index === i);
      if (!c?.layers || c.layers.status !== "done") throw new Error(`Phiên bản "${v.name}" chưa cắt xong`);
      versions.push({ name: v.name, src: { p: c, set: c.layers, images: await loadImages(s.supabase, c.id) }, subjects: c.brief.subjects.map((_, k) => k) });
    }
  } else versions = named.map((v) => ({ name: v.name, src: own, subjects: v.subjects }));
  const lineup = versions.length > 1;

  // ---- per set: who is where, its files and cliparts (made once, used by every version of it) ----
  const cap = (x: string) => (x ? x[0].toUpperCase() + x.slice(1) : x);
  const HAT = /\b(hat|cap|beanie|helmet|crown|hood)\b|mũ|nón/i;
  const prepared = new Map<string, Awaited<ReturnType<typeof prepare>>>();
  async function prepare(src: Source) {
    const sb = src.p.brief;
    const sset = src.set;
    const allSlots = sb.subjects.flatMap((sub) => sub.slots);
    const slotOf = (sl: CtCharLayerSlot) => allSlots.find((x) => x.id === sl.key.split(":")[0]);
    const subjectOfSlot = new Map<string, number>();
    sb.subjects.forEach((sub, i) => sub.slots.forEach((sl) => subjectOfSlot.set(sl.id, i)));
    const slotSubject = (sl: CtCharLayerSlot) => subjectOfSlot.get(sl.key.split(":")[0]) ?? -1;
    const fileBox = (f: CtCharLayerFile): CtLayoutBox | null => (f.bbox && f.bbox.length === 4 ? { x: f.bbox[0], y: f.bbox[1], w: f.bbox[2], h: f.bbox[3] } : null);
    const boxesOf = (i: number) => sset.slots.filter((sl) => slotSubject(sl) === i).flatMap((sl) => sl.files.map(fileBox).filter((b): b is CtLayoutBox => b !== null));
    // A lineup cut from ONE picture splits the body per subject; a drawn version has its own body.
    const split = lineup && !drawn;
    const bodySlot = sset.slots.find((sl) => sl.key === "body");
    // Face zones: their outline is cut out of the body file (the face shows through it from the layer under the body).
    const faceHoles = sset.zones.filter((z) => sb.photoZones.find((x) => x.id === z.id)?.treat === "face").map((z) => z.polygon);
    const bodyPng = bodySlot?.files[0] ? await cleanKey(faceHoles.length ? await punched(await bytes(bodySlot.files[0].url), faceHoles) : await bytes(bodySlot.files[0].url), true) : null;
    const bodyBox = bodyPng ? await alphaBox(bodyPng) : null;
    // Each subject's centre (its parts' boxes; one without parts gets its share of the body's width).
    const centres = sb.subjects.map((_, i) => {
      const u = unionBox(boxesOf(i));
      if (u) return u.x + u.w / 2;
      const b = bodyBox ?? { x: 0, y: 0, w: sset.width, h: sset.height };
      return b.x + (b.w * (i + 0.5)) / Math.max(1, sb.subjects.length);
    });
    const bodies = bodyPng ? (split ? await splitBody(bodyPng, centres) : [bodyPng]) : [];
    const bodyBoxes = await Promise.all(bodies.map(alphaBox));
    const subjectBox = (i: number): CtLayoutBox | null => unionBox([...boxesOf(i), ...(split && bodyBoxes[i] ? [bodyBoxes[i]!] : [])]);
    const cropOf = (subs: number[]): CtLayoutBox =>
      (split ? unionBox(subs.map(subjectBox).filter((b): b is CtLayoutBox => b !== null)) : null) ?? (subs.length === sb.subjects.length ? unionBox([...(bodyBox ? [bodyBox] : []), ...subs.flatMap(boxesOf)]) : null) ?? bodyBox ?? { x: 0, y: 0, w: sset.width, h: sset.height };

    // A headwear outfit (slot.headwear): the hat becomes its own layer over the hair, the rest stays where the slot is.
    const hats = new Map<string, string>();
    const slots: CtCharLayerSlot[] = [];
    for (const sl of sset.slots) {
      slots.push(sl);
      if (slotOf(sl)?.headwear && !sl.follows) {
        const key = `${sl.key}:hat`;
        hats.set(key, sl.key);
      }
    }
    const hatSlots: CtCharLayerSlot[] = [...hats].map(([key, of]) => {
      const sl = sset.slots.find((x) => x.key === of)!;
      return { ...sl, key, label: `${sl.label} — nón` };
    });
    const pieceOf = async (sl: CtCharLayerSlot, url: string): Promise<Buffer> => {
      const png = await bytes(url);
      if (hats.has(sl.key)) return (await splitHeadwear(png)).hat;
      if (slotOf(sl)?.headwear) return (await splitHeadwear(png)).rest;
      return png;
    };

    // The thumbnail pictures (3b "thumb:<slot>:<option>") by role.
    const thumbs = new Map([...latestEditsOf(src.images)].filter(([role, im]) => role.startsWith("thumb:") && im.status === "done").map(([role, im]) => [role, im.url]));
    const thumbPictureOf = (slot: CtCharLayerSlot, f: CtCharLayerFile) => {
      const sl = slotOf(slot);
      const o = sl?.options.find((x) => x.name === f.option);
      return o ? thumbs.get(`thumb:${sl!.id}:${o.id}`) : undefined;
    };
    /** A slot's groups: shape slots with colours → one group per colour (options = shapes); otherwise one group. */
    const slotGroups = new Map<string, Promise<Array<{ name: string; sub: CtAsset | null }>>>();
    const groupsOf = (slot: CtCharLayerSlot, label: string) => {
      const hit = slotGroups.get(slot.key);
      if (hit) return hit;
      const colours = [...new Set(slot.files.map((f) => f.color))];
      const grouped = colours.length > 1 || colours[0] !== "";
      const groups = grouped ? colours.map((c) => ({ name: c, files: slot.files.filter((f) => f.color === c) })) : [{ name: "", files: slot.files }];
      // A wrapping part's option is shown as it is seen (back + front, server/char/layers.ts views).
      const back = sset.slots.find((x) => x.follows === slot.key);
      const thumbOf = (f: CtCharLayerFile) => (f.viewUrl ? f : back?.files.find((b) => b.option === f.option && b.color === f.color));
      // Uploads of a group go in order (variants hang on the first); groups in parallel.
      const made = Promise.all(
        groups.map(async (g) => {
          let sub: CtAsset | null = null;
          for (const f of g.files) {
            const swatch = swatchOf(sb, slot.key, f.option, f.color);
            const whole = thumbOf(f);
            const thumb = thumbPictureOf(slot, f) ?? (whole ? whole.viewUrl || whole.url : undefined);
            const a = await clipart(await cleanKey(await pieceOf(slot, f.url), false), [label, f.option, f.color].filter(Boolean).join(" · "), sub?.id ?? null, { charLayerId: f.imageId, ...(swatch ? { swatch } : {}), ...(thumb ? { thumb } : {}) });
            sub ??= a;
          }
          return { name: grouped ? g.name : "", sub };
        }),
      );
      slotGroups.set(slot.key, made);
      return made;
    };
    const bodyCliparts = bodies.map((png, i) => clipart(png, split ? `Body · ${subjectName(sb, i)}` : drawn ? `Body · ${src.p.brief.versionOf?.name ?? named[named.length - 1].name}` : "Body", null, bodySlot?.files[0] ? { charLayerId: bodySlot.files[0].imageId } : {}));

    // A name "on" a character with no box of its own sits on that character's hat brim (its first hat file).
    const brims = new Map<number, CtLayoutBox | null>();
    for (const t of brief.texts.filter((x) => x.place === "on" && !x.box)) {
      const i = sb.subjects.findIndex((x) => x.id === t.subject);
      if (i < 0 || brims.has(i)) continue;
      const hatSlot = sb.subjects[i].slots.find((sl) => sl.headwear) ?? sb.subjects[i].slots.find((sl) => HAT.test(sl.part));
      const sl = hatSlot && sset.slots.find((x) => x.key === hatSlot.id || x.key === `${hatSlot.id}:front`);
      // The default option's hat (the files come in any order: the witch hat's brim put the names over the Santa hats).
      const first = hatSlot?.options[0]?.name;
      const file = sl?.files.find((f) => f.option === first && (f.color === "" || f.color === hatSlot?.colors[0]?.name)) ?? sl?.files[0];
      brims.set(i, file ? await brimBox(hatSlot?.headwear ? (await splitHeadwear(await bytes(file.url))).hat : await bytes(file.url)) : null);
    }
    return { sb, sset, slotOf, slotSubject, subjectBox, cropOf, slots, hatSlots, groupsOf, bodies, bodyCliparts, brims };
  }
  for (const v of versions) if (!prepared.has(v.src.p.id)) prepared.set(v.src.p.id, await prepare(v.src));

  // ---- where each version goes: its characters' crop (+ the sign under them) fitted in the characters' area ----
  const done = latestElementImages(images);
  // An element with a picture missing is left out (the cut makes the product before step 4 draws them; "Dựng lại sản
  // phẩm" puts them in).
  const pics = elementPictures(p);
  const ready = brief.elements.filter((e) => pics.filter((x) => x.element.id === e.id).every((x) => done.has(x.role)));
  const plaque = ready.find((e) => e.place === "plaque") ?? null;
  const blockOf = (c: CtLayoutBox) => (plaque ? { w: c.w * PLAQUE.w, h: c.h * (PLAQUE.top + PLAQUE.h) } : { w: c.w, h: c.h });
  const fitOf = (c: CtLayoutBox) => Math.min(charArea.w / blockOf(c).w, charArea.h / blockOf(c).h);
  const cropOfVersion = (v: Version) => prepared.get(v.src.p.id)!.cropOf(v.subjects);
  const last = versions[versions.length - 1];
  const lastCrop = cropOfVersion(last);
  // "count": one size for everyone — the whole row's fit (one person is as big as in the row of five); a drawn
  // version (its own picture) gets the height the whole row's characters have.
  const rowScale = fitOf(lastCrop);
  const rowHeight = lastCrop.h * rowScale;
  const placeOf = (v: Version): { box: CtLayoutBox; k: number; plaque: CtLayoutBox | null } => {
    const sset = v.src.set;
    if (!lineup && !brief.charactersBox && !plaque) {
      const k = layout.characters.w / sset.width;
      return { box: layout.characters, k, plaque: null };
    }
    const crop = cropOfVersion(v);
    const k = brief.lineup?.mode === "count" ? (drawn ? Math.min(rowHeight / crop.h, fitOf(crop)) : rowScale) : fitOf(crop);
    const b = blockOf(crop);
    const bx = charArea.x + (charArea.w - b.w * k) / 2;
    const by = charArea.y + charArea.h - b.h * k;
    const chars = { x: bx + ((b.w - crop.w) * k) / 2, y: by, w: crop.w * k, h: crop.h * k };
    return {
      box: { x: chars.x - crop.x * k, y: chars.y - crop.y * k, w: sset.width * k, h: sset.height * k },
      k,
      plaque: plaque ? { x: bx, y: chars.y + chars.h * PLAQUE.top, w: crop.w * k * PLAQUE.w, h: chars.h * PLAQUE.h } : null,
    };
  };

  // The backgrounds the customer picks (over the whole piece); a repeating one (plaid) as a seamless tile.
  const backdrops = latestBackdrops(p, images);
  const tiled = backdrops.length > 0 && backdrops.every((b) => b.backdrop.tile);
  const backdropCliparts = Promise.all(backdrops.map(async ({ backdrop, image }) => clipart(backdrop.tile ? await seamlessTile(await bytes(image.url)) : await bytes(image.url), `Background · ${backdrop.name}`, null, {})));

  // Decorations (asked 2026-10-18): drawn alone (server/char/elements.ts), trimmed, placed in their box.
  const elementBoxes = charElementBoxes(brief.elements, charArea, area, piece);
  const elementCliparts = new Map<string, Promise<Array<{ name: string; sub: CtAsset }>>>();
  /** An element's cliparts; the sign (place "plaque") stretched to each version's width (`aspect`). */
  const cliparsOf = (e: CtCharElement, aspect = 0): Promise<Array<{ name: string; sub: CtAsset }>> => {
    const key = `${e.id}@${aspect ? aspect.toFixed(2) : ""}`;
    const hit = elementCliparts.get(key);
    if (hit) return hit;
    const made = (async () => {
      const list = pics.filter((x) => x.element.id === e.id);
      const out: Array<{ name: string; sub: CtAsset }> = [];
      let first: CtAsset | null = null;
      // perBackdrop: each picture its own group (no gốc / đa sắc chain).
      for (const x of list) {
        let png = await trimmed(await fetchImage(done.get(x.role)!.url));
        // The ground under the characters: mirrored beside itself, repeated along the band (a 3:1 rug from a 3:2 picture).
        if (e.place === "bottom" && !e.box) png = await seamlessTile(png, true);
        if (e.place === "plaque" && aspect) png = await stretchPlank(png, aspect);
        const hex = e.options.find((o) => o.name === x.name)?.value;
        const a = await clipart(png, `${e.name} · ${x.name}${aspect && lineup ? ` · ${aspect.toFixed(1)}` : ""}`, e.perBackdrop ? null : (first?.id ?? null), e.mode === "color" && hex && /^#[0-9a-f]{6}$/i.test(hex) ? { swatch: hex } : {});
        first ??= a;
        out.push({ name: x.name, sub: a });
      }
      return out;
    })();
    elementCliparts.set(key, made);
    return made;
  };

  // Choosers (brief.choosers — a grandchild a boy or a girl, hats or no hats, the Theme): a layer that draws nothing (its
  // options are empty pictures named after the choice) and that the parts / texts / decorations with shownWhen hang
  // under, or that follow it.
  const blankPng = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const chooserAssets = new Map<string, Promise<Map<string, CtAsset>>>();
  for (const c of brief.choosers ?? [])
    chooserAssets.set(
      c.id,
      (async () => {
        const out = new Map<string, CtAsset>();
        let first: CtAsset | null = null;
        for (const o of c.options) {
          const a = await clipart(blankPng, `${c.label} · ${o.name}`, first?.id ?? null, {});
          first ??= a;
          out.set(o.id, a);
        }
        return out;
      })(),
    );

  // ---- the versions ----
  const mains: CtAsset[] = [main];
  for (const v of versions.slice(1)) mains.push(await upload(sheetPng, "main", v.name));
  if (lineup) await s.supabase.from(CT_TABLES.assets).update({ name: versions[0].name }).eq("id", main.id);

  const regions: CtRegion[] = [];
  const items: CtRegionItem[] = [];
  // Cliparts are made once, in the background, and put in every version's layers as they come.
  const fills: Array<Promise<void>> = [];
  let order = 0;
  const addItem = (r: CtRegion, sub: CtAsset, index: number, groupName = "") => {
    const id = crypto.randomUUID();
    items.push({ id, region_id: r.id, asset_id: sub.id, transform: { offsetX: 0, offsetY: 0, scale: 1, rotation: 0 }, is_default: index === 0, sort_order: index });
    if (groupName) r.config.image.groupNames[id] = groupName;
  };

  for (const [vi, v] of versions.entries()) {
    const mainId = mains[vi].id;
    const P = prepared.get(v.src.p.id)!;
    const sb = P.sb;
    const ownSet = new Set(v.subjects);
    const { box, k, plaque: plaqueBox } = placeOf(v);
    const many = v.subjects.length > 1;
    const modeOf = (sl: CtCharLayerSlot) => P.slotOf(sl)?.mode;
    // One character in the picture: the part alone ("Hair"); several: "Person 2 — Hair".
    const labelFor = (sl: CtCharLayerSlot) => {
      const w = who(sb, sl.key);
      const part = P.slotOf(sl)?.headwear ? (sl.key.endsWith(":hat") ? "Hat" : "Top") : w.part;
      if (part && !many) return cap(part);
      return w.name ? `${w.name} — ${part}` : sl.label;
    };
    const imageRegion = (label: string, customerLabel: string, image: Partial<CtRegion["config"]["image"]>, shape: CtShape = { type: "rect", x: box.x, y: box.y, w: box.w, h: box.h, radius: 0 }, extra: Partial<CtRegion["config"]> = {}): CtRegion => {
      const cfg = defaultRegionConfig("image");
      const r: CtRegion = {
        id: crypto.randomUUID(),
        product_id: product.id,
        name: lineup ? `${label} [${v.name}]` : label,
        kind: "image",
        shape,
        config: { ...cfg, clip: false, mainId, ...extra, image: { ...cfg.image, label: customerLabel, ...image } },
        sort_order: order++,
      };
      regions.push(r);
      return r;
    };
    const rect = (b: CtLayoutBox): CtShape => ({ type: "rect", x: b.x, y: b.y, w: b.w, h: b.h, radius: 0 });
    // This version's choosers (one that belongs to a character only where that character is).
    const choosers = new Map<string, { region: CtRegion; assets: Map<string, CtAsset> }>();
    for (const c of brief.choosers ?? []) {
      const si = c.subject ? sb.subjects.findIndex((x) => x.id === c.subject) : -1;
      if (c.subject && !ownSet.has(si)) continue;
      const assets = await chooserAssets.get(c.id)!;
      const r = imageRegion(`Chọn — ${c.label}`, c.label, { display: "button" }, { type: "rect", x: 0, y: 0, w: 1, h: 1, radius: 0 });
      const first = assets.get(c.options[0].id);
      if (first) addItem(r, first, 0);
      choosers.set(c.id, { region: r, assets });
    }
    const parentOf = (w: CtCharShownWhen | null | undefined): CtRegion["config"]["parent"] | undefined => {
      const c = w ? choosers.get(w.chooser) : undefined;
      const a = c && w ? c.assets.get(w.option) : undefined;
      return c && a ? { regionId: c.region.id, optionId: a.id } : undefined;
    };

    // 0) the background (over the whole piece), 1) decorations behind, 2) back halves (linked), 3) bodies, 4) photo
    // zones, 5) every other part in the set's order (front halves last), 6) hats, 7) decorations in front, 8) texts.
    if (backdrops.length) {
      const r = imageRegion("Nền", "Background", { display: "image" }, template?.spec.outline ?? { type: "rect", x: 0, y: 0, w: W, h: H, radius: 0 }, {
        clip: false,
        fill: tiled ? { mode: "tile", tile: Math.round(Math.min(W, H) * 1.6) } : { mode: "cover", tile: 256 },
      });
      (await backdropCliparts).forEach((a, i) => addItem(r, a, i));
    }
    const elementRegions = new Map<string, CtRegion>();
    const placeElement = async (e: CtCharElement) => {
      const b = e.place === "plaque" && plaqueBox ? plaqueBox : elementBoxes[e.id];
      const list = await cliparsOf(e, e.place === "plaque" && plaqueBox ? plaqueBox.w / plaqueBox.h : 0);
      const first = list[0]?.sub;
      // The ground: one row of the mirrored band along it, as tall as it.
      const ground = e.place === "bottom" && !e.box;
      const tile = first?.width && first.height ? Math.round((b.h * first.width) / first.height) : Math.round(b.w);
      const r = imageRegion(`Phần tử — ${e.name}`, e.name, { display: e.mode === "color" ? "swatch" : "image" }, rect(b), { ...(ground ? { fill: { mode: "tile", tile } } : {}), ...(parentOf(e.shownWhen) ? { parent: parentOf(e.shownWhen) } : {}) });
      elementRegions.set(e.id, r);
      // A perBackdrop one: a group per background (it follows the background); else one group, the first picture
      // the gốc and the others its đa sắc — a follower shows the option at its leader's position.
      if (e.perBackdrop && backdrops.length) list.forEach((x, i) => addItem(r, x.sub, i));
      else if (first) addItem(r, first, 0);
    };
    for (const e of ready.filter((x) => !x.front && x.place !== "plaque")) await placeElement(e);

    const byKey = new Map([...P.slots, ...P.hatSlots].map((sl) => [sl.key, sl]));
    const mine = (sl: CtCharLayerSlot) => ownSet.has(P.slotSubject(sl));
    const backs = P.slots.filter((sl) => sl.follows && mine(sl));
    const fronts = P.slots.filter((sl) => !sl.follows && sl.key !== "body" && mine(sl));
    const hatsOver = P.hatSlots.filter(mine);
    const regionOf = new Map<string, CtRegion>();
    const fillRegion = (r: CtRegion, sl: CtCharLayerSlot) =>
      fills.push(
        P.groupsOf(sl, labelFor(sl)).then((groups) =>
          groups.forEach((g, gi) => {
            if (g.sub) addItem(r, g.sub, gi, g.name);
          }),
        ),
      );
    for (const sl of backs) regionOf.set(sl.key, imageRegion(sl.label, labelFor(sl), {}));
    if (P.bodies.length) {
      for (const [i, c] of P.bodyCliparts.entries()) {
        if (lineup && !drawn && !ownSet.has(i)) continue;
        const r = imageRegion(lineup && !drawn ? `Thân — ${subjectName(sb, i)}` : "Thân", "Body", {});
        fills.push(c.then((a) => addItem(r, a, 0)));
      }
    }
    const firstBody = regions.findIndex((r) => r.config.mainId === mainId && r.name.startsWith("Thân"));
    const photoRegions: CtRegion[] = v.src.set.zones.map((z) => {
      const cfg = defaultRegionConfig("photo");
      const keptZone = keptZones.get(`Ảnh khách — ${z.label}`);
      const r: CtRegion = {
        id: crypto.randomUUID(),
        product_id: product.id,
        name: `Ảnh khách — ${z.label}`,
        kind: "photo",
        shape: keptZone?.shape ?? { type: "polygon", points: z.polygon.map(([x, y]) => ({ x: box.x + x * k, y: box.y + y * k })) },
        // A face under the body: the body's hole edges it (its hair may show past the hat, like the reference) — not clipped.
        config: { ...cfg, clip: sb.photoZones.find((x) => x.id === z.id)?.treat !== "face", mainId, photo: { ...cfg.photo, ...zonePhoto(sb, z.id), label: z.label, required: true, ...(keptZone ? { frame: keptZone.frame } : {}) } },
        sort_order: order++,
      };
      return r;
    });
    // Photo zones right above the bodies — a face zone right UNDER them, seen through the hole cut in the body (the
    // hat brim, the hair edge and the collar lie over the customer's face).
    if (photoRegions.length) {
      const at = firstBody >= 0 ? firstBody : regions.length;
      const under = photoRegions.filter((r) => r.config.photo.mode === "face");
      const over = photoRegions.filter((r) => r.config.photo.mode !== "face");
      const lastBody = regions.reduce((n, r, i) => (r.config.mainId === mainId && r.name.startsWith("Thân") ? i : n), at - 1);
      regions.splice(lastBody + 1, 0, ...over);
      regions.splice(at, 0, ...under);
    }
    // In the set's own order (every part is a layer drawn on the doll: a cardigan that only changes colour lies over the
    // dress like any garment — 2026-10-14); the hats of headwear outfits over everything of the characters.
    for (const sl of [...fronts, ...hatsOver]) {
      const slot = P.slotOf(sl);
      const optional = slot?.optional === true;
      if (modeOf(sl) !== "shape") {
        regionOf.set(sl.key, imageRegion(sl.label, labelFor(sl), { display: modeOf(sl) === "color" ? "swatch" : "image", allowNone: optional, defaultNone: optional }));
        continue;
      }
      const coloured = sl.files.some((f) => f.color !== "");
      const w = who(sb, sl.key);
      const part = w.part.replace(/\s*(style|kiểu)$/i, "").trim() || w.part;
      // A face's expression is picked by its name (its file alone is only eyes and a mouth).
      const face = slot ? isFace(slot.part) : false;
      // The styles are picked by their picture (a back half's full clipart — meta.thumb), the colour by its swatch.
      regionOf.set(sl.key, imageRegion(sl.label, labelFor(sl), { display: face ? "button" : "image", allowNone: optional, defaultNone: optional, groupLabel: !many ? `${cap(part)} Colour` : `${w.name} — ${part} Colour`, groupDisplay: coloured ? "swatch" : "button" }));
    }
    for (const sl of backs) {
      const leader = regionOf.get(sl.follows ?? "");
      const r = regionOf.get(sl.key);
      if (leader && r) {
        r.config.image.follows = leader.id;
        r.config.image.allowNone = leader.config.image.allowNone;
        r.config.image.defaultNone = leader.config.image.defaultNone;
      }
    }
    // A part only there for one choice (a boy's hair): under its chooser.
    for (const [key, r] of regionOf) {
      const parent = parentOf(P.slotOf(byKey.get(key)!)?.shownWhen);
      if (parent) r.config.parent = parent;
    }
    for (const [key, r] of regionOf) fillRegion(r, byKey.get(key)!);
    for (const e of ready.filter((x) => x.front || x.place === "plaque")) await placeElement(e);
    // A part that follows a decoration or a chooser (the sweaters and hats follow the Theme): linked, no choice of its own.
    for (const [key, r] of regionOf) {
      const sl = byKey.get(key)!;
      const lead = sl.follows ? null : P.slotOf(sl)?.follows;
      const er = lead ? (elementRegions.get(lead) ?? choosers.get(lead)?.region) : undefined;
      if (er) r.config.image.follows = er.id;
    }
    // A decoration that follows another (the right-hand tree follows the left-hand one's theme) or a chooser (the sign
    // follows the Theme): linked, no choice.
    for (const e of brief.elements) {
      const r = elementRegions.get(e.id);
      if (!r) continue;
      const lead = e.follows ? (elementRegions.get(e.follows) ?? choosers.get(e.follows)?.region) : undefined;
      if (lead) r.config.image.follows = lead.id;
      else if (e.perBackdrop) {
        const bg = regions.find((x) => x.config.mainId === mainId && x.name.startsWith("Nền"));
        if (bg) r.config.image.follows = bg.id;
      }
    }
    // Texts above everything: around the characters, under each of them, on the sign, or in their own box.
    for (const t of brief.texts) {
      let at = layout.texts.find((x) => x.id === t.id);
      if (t.place === "free" && t.box) {
        const b = fromShares(area, t.box);
        at = { id: t.id, box: b, fontSize: Math.round(b.h * 0.78), curve: 0, align: "center" };
      } else if (t.place === "plaque") {
        const b = plaqueBox ? fromShares(plaqueBox, t.box ?? PLAQUE_TEXT) : null;
        at = b ? { id: t.id, box: b, fontSize: Math.round(b.h * 0.78), curve: t.curve ?? 0, align: "center" } : undefined;
      } else if (t.place === "under" || t.place === "on") {
        const i = sb.subjects.findIndex((x) => x.id === t.subject);
        const sbx = i >= 0 && ownSet.has(i) ? P.subjectBox(i) : null;
        const onSb = sbx ? { x: box.x + sbx.x * k, y: box.y + sbx.y * k, w: sbx.w * k, h: sbx.h * k } : null;
        const brim = t.place === "on" && !t.box && onSb ? P.brims.get(i) : null;
        if (t.place === "on" && onSb && t.box) {
          // Shares of that character's own box (a name on the hat's brim).
          const b = fromShares(onSb, t.box);
          at = { id: t.id, box: b, fontSize: Math.round(b.h * 0.78), curve: t.curve ?? 0, align: "center" };
        } else if (brim) {
          const b = { x: box.x + brim.x * k, y: box.y + brim.y * k, w: brim.w * k, h: brim.h * k };
          at = { id: t.id, box: b, fontSize: Math.round(b.h * 0.72), curve: t.curve ?? 0, align: "center" };
        } else at = onSb && t.place === "under" ? underText(t, onSb, area, D) : undefined;
      }
      if (at) {
        const parent = parentOf(t.shownWhen);
        // A name on a hat and the line on the sign get the light halo too: the theme changes what is under them (dark red on
        // a black witch hat / dark Halloween wood could not be read, 2026-10-20).
        const r = textRegion(product.id, mainId, t, at, backdrops.length > 0 || t.place === "on" || t.place === "plaque", order++);
        regions.push({ ...r, ...(lineup ? { name: `Chữ — ${t.label} [${v.name}]` } : {}), ...(parent ? { config: { ...r.config, parent } } : {}) });
      }
    }
  }
  await Promise.all(fills);
  items.sort((a, b) => regions.findIndex((r) => r.id === a.region_id) - regions.findIndex((r) => r.id === b.region_id) || a.sort_order - b.sort_order);

  const config = { ...defaultProductConfig(), print: template ? productPrintOf(template) : null };
  if (lineup && brief.lineup) config.main = { ...config.main, enabled: true, label: brief.lineup.label, display: "button", subOptions: [] };
  // The brief's material (a ceramic ornament → "ceramic_gloss"), else by the cut: die-cut → white acrylic.
  const material = brief.product.material && isMaterialId(brief.product.material) ? brief.product.material : brief.product.cut === "alpha" ? "acrylic_white" : null;
  config.material = { ...(material ? applyMaterialPreset(config.material, material) : config.material), widthMm: mmW };
  // The phôi trơn (uploaded, else the AI one): Xem trước, the storefront and the mockups draw the design on it. The
  // sheet's box is found on the photo when the piece has a fixed shape (or the AI drew it on its plain backdrop).
  const blank: CtCharImage | null = projectBlank(p, images);
  const kept = template?.spec.blanks[0];
  if (blank?.role !== "blank" && kept) {
    // The khuôn's own phôi (Thư viện → Phôi) wins over one the set drew by AI: it is the one the team keeps.
    config.scene = { url: kept.url, width: kept.width, height: kept.height, box: kept.box };
  } else if (blank?.width && blank.height) {
    const photo = await fetchImage(blank.url);
    const ref = await upload(photo, "reference", blank.role === AI_BLANK_ROLE ? "Phôi trơn (AI)" : "Phôi trơn chụp thẳng");
    config.scene =
      template?.spec.outline || blank.role === AI_BLANK_ROLE
        ? await sceneForBlank(photo, ref.url, template?.spec ?? { width: W, height: H, outline: null })
        : { url: ref.url, width: blank.width, height: blank.height, box: guessedBox(blank.width, blank.height, W, H) };
  }
  // The khuôn layer: one per version (a version shows only its own layers).
  const frames = lineup ? keep.flatMap((r) => mains.map((m, i) => ({ ...r, id: i === 0 ? r.id : crypto.randomUUID(), config: { ...r.config, mainId: m.id } }))) : keep;
  const all = [...frames, ...regions].map((r, i) => ({ ...r, sort_order: i }));
  await body(await h.saveDesign(s, product.id, { regions: all, items, config }));
  return product.id;
}
