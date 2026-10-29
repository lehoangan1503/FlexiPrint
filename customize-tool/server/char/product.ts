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
import type { CtAsset, CtCharBrief, CtCharComposePerson, CtCharElement, CtCharFileFx, CtCharShownWhen, CtCharImage, CtCharLayerFile, CtCharLayerSet, CtCharLayerSlot, CtCharProject, CtCharSubject, CtCharTextField, CtCharTextPlace, CtPhotoStyleRef, CtProduct, CtRegion, CtRegionItem, CtShape } from "../../types";
import { defaultProductConfig, defaultRegionConfig } from "../../lib/design";
import { applyMaterialPreset, isMaterialId } from "../../lib/materials";
import { charLayout, type CtCharLayoutText, type CtLayoutBox } from "../../lib/char-layout";
import { charElementBoxes, charVersions, composedVersions, fromShares, picksShowing, slotShown, subjectName, underText, unionBox } from "../../lib/char-lineup";
import { poseOf } from "../../lib/char-brief";
import { elementPictures, latestElementImages } from "./elements";
import { latestBackdrops } from "./backdrops";
import { latestEditsOf } from "../../lib/char-images";
import * as h from "../handlers";
import type { CtSession } from "../supabase";
import { fetchImage, saveCharRaw } from "./files";
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
import { brimArc, splitHeadwear, type CtBrimArc } from "./brim";
import { refreshSetUsers } from "./set-users";

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
        ...(at.arcRadius ? { arcRadius: at.arcRadius, arcTilt: at.arcTilt ?? 0 } : {}),
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
    // No name: what the brief calls it elsewhere (its chooser, its name field).
    if (subjectName(brief, i) !== short(sub.description)) return { name: subjectName(brief, i), part: slot.part };
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
  const posed = !!p.brief.poses?.length;
  if (!photo && !posed && (p.layers?.status !== "done" || !p.layers.approved)) return jsonError("Tạo bộ custom ở bước 3c trước", 409);
  try {
    const productId = await remakeSetProduct(jobDb(s), p.user_id ?? s.user.id, p, posed ? null : p.layers);
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

/** One product build at a time per set (2026-10-22: two builds that overlapped each left a product behind, and a late
 * caller wrote an id the other build had already deleted). */
const remaking = new Map<string, Promise<unknown>>();

/** The set's product built again: the new one is made, saved as the set's product, then the old ones are deleted. */
export function remakeSetProduct(db: CtSession["supabase"], userId: string, p: CtCharProject, set: CtCharLayerSet | null, opts: { resetZones?: boolean } = {}): Promise<string> {
  const run = (remaking.get(p.id) ?? Promise.resolve()).catch(() => {}).then(() => remakeNow(db, userId, p, set, opts));
  remaking.set(p.id, run);
  void run.finally(() => remaking.get(p.id) === run && remaking.delete(p.id)).catch(() => {});
  return run;
}

async function remakeNow(db: CtSession["supabase"], userId: string, p0: CtCharProject, set: CtCharLayerSet | null, opts: { resetZones?: boolean }): Promise<string> {
  const s = await serviceSession(db, userId);
  // The set's product ids as they are now (the caller's copy may be from before an earlier build).
  const { data: row } = await db.from(CT_TABLES.charProjects).select("product_ids").eq("id", p0.id).maybeSingle<{ product_ids: string[] | null }>();
  const p: CtCharProject = { ...p0, product_ids: row?.product_ids ?? p0.product_ids };
  // Customer photo zones the editor reshaped in the product (asked 2026-10-15: the zone stays editable after
  // @flexiprint made it) are kept by name — unless asked to start from the set's own layout again.
  const kept = new Map<string, KeptZone>();
  if (!opts.resetZones && p.product_ids.length) {
    const { data: old } = await db.from(CT_TABLES.regions).select("*").in("product_id", p.product_ids).eq("kind", "photo").returns<CtRegion[]>();
    for (const r of old ?? []) kept.set(r.name, { shape: r.shape, frame: r.config.photo.frame });
  }
  if (!set && !p.brief.poses?.length && p.brief.kind !== "photo") throw new Error("Bộ chưa có file layer");
  // The new product first, the old ones after (2026-10-22: a build that failed half-way — "Upload thất bại" — had
  // already deleted the old product, and the set kept pointing at it: every product tool said "No such product").
  const productId =
    p.brief.kind === "photo"
      ? await buildPhotoProduct(s, p, p.name, kept)
      : // Characters drawn in their poses: no files of its own — a 3:2 frame the composed group is fitted in.
        await build(s, p, set ?? { status: "done", error: "", width: 3072, height: 2048, slots: [], zones: [], checks: [], builtAt: "" }, p.name, kept);
  const { error } = await db.from(CT_TABLES.charProjects).update({ product_ids: [productId], status: "product" }).eq("id", p.id);
  if (error) throw new Error(error.message);
  // Products using the set (dropped from the editor's library) take the new layers before the old clipart go.
  await refreshSetUsers(s, p, productId).catch((e: Error) => console.warn("[ct] set users refresh", e.message));
  for (const pid of p.product_ids) {
    if (pid === productId) continue;
    const folder = await findProductFolder(db, pid);
    if (folder) {
      const { data: cliparts } = await db.from(CT_TABLES.assets).select("id, storage_path").eq("category_id", folder.id).returns<Array<Pick<CtAsset, "id" | "storage_path">>>();
      await ctRemove((cliparts ?? []).map((c) => c.storage_path).filter(Boolean));
      await db.from(CT_TABLES.assets).delete().eq("category_id", folder.id);
      await db.from(CT_TABLES.categories).delete().eq("id", folder.id);
    }
    await h.deleteProduct(s, pid);
  }
  return productId;
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
/** A layer file made into a product clipart the way the product did it (meta.charFx): flopped, its hat or the rest. */
export async function charClipart(png: Buffer, fx: CtCharFileFx | null | undefined): Promise<Buffer> {
  let out = fx?.flip ? await sharp(png).flop().png().toBuffer() : png;
  if (fx?.part) out = (await splitHeadwear(out))[fx.part];
  if (fx?.behind) {
    const mask = await fetchImage(fx.behind.url);
    out = await keepMask(out, fx.flip ? await sharp(mask).flop().png().toBuffer() : mask, fx.behind.keep);
  }
  return cleanKey(out, false);
}

/** A layer's pixels inside ("in") or outside ("out") a mask (server/char/behind.ts: its back part / the rest). */
async function keepMask(png: Buffer, mask: Buffer, keep: "in" | "out"): Promise<Buffer> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  let m: Uint8Array = await sharp(mask).ensureAlpha().resize(W, H, { fit: "fill" }).extractChannel(3).raw().toBuffer();
  // The back part reaches 4 px under the front part: each half is resampled on its own when the print is drawn, and
  // two soft edges over each other let the background through as a thin line (2026-10-23).
  if (keep === "in") {
    const R = 4;
    const tmp = new Uint8Array(W * H);
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let v = 0;
        for (let k = Math.max(0, x - R); k <= Math.min(W - 1, x + R) && !v; k++) v = m[y * W + k];
        tmp[y * W + x] = v;
      }
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let v = 0;
        for (let k = Math.max(0, y - R); k <= Math.min(H - 1, y + R) && !v; k++) v = tmp[k * W + x];
        out[y * W + x] = v;
      }
    m = out;
  }
  // The back part: any coverage → all of it (it lies under the front part's soft edge).
  for (let i = 0; i < W * H; i++) {
    // Hard edges both ways: the front part keeps only pixels clearly outside (no half-see-through ring).
    const k = keep === "in" ? (m[i] > 0 ? 255 : 0) : m[i] >= 128 ? 0 : 255;
    data[i * 4 + 3] = Math.round((data[i * 4 + 3] * k) / 255);
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

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
/** Only the big connected pieces of a picture (≥ 5 % of the biggest): specks and slivers apart from it go. */
async function mainPieces(png: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const n = W * H;
  const label = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  const stack = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (label[i] >= 0 || data[i * 4 + 3] <= 8) continue;
    const id = sizes.length;
    let count = 0;
    let top = 0;
    stack[top++] = i;
    label[i] = id;
    while (top) {
      const j = stack[--top];
      count++;
      const x = j % W;
      const near = [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, j >= W ? j - W : -1, j < n - W ? j + W : -1];
      for (const k of near)
        if (k >= 0 && label[k] < 0 && data[k * 4 + 3] > 8) {
          label[k] = id;
          stack[top++] = k;
        }
    }
    sizes.push(count);
  }
  const big = sizes.reduce((m, x) => Math.max(m, x), 0);
  let dropped = 0;
  for (let i = 0; i < n; i++)
    if (label[i] >= 0 && sizes[label[i]] < big * 0.05) {
      data[i * 4 + 3] = 0;
      dropped++;
    }
  return dropped ? sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer() : png;
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

/**
 * The sign pictures of every theme on ONE canvas (asked 2026-10-22: "độ dài, rộng của 3 khung phải bằng nhau chỉ khác
 * theme"): each whole drawing (never cut or pieced together — the stretched sign showed its seams) scaled to the same
 * width, their bottoms on one line, the canvas as tall as the tallest (a bunny at the end rising higher) → the pictures
 * (same order) and where the plank's own top is (a share of the canvas height, measured in its plain middle:
 * the characters rest on it, the lettering sits below it).
 */
async function signCanvases(pngs: Buffer[]): Promise<{ pngs: Buffer[]; top: number }> {
  const W = 2048;
  const scaled = await Promise.all(pngs.map((png) => sharp(png).resize({ width: W }).png().toBuffer({ resolveWithObject: true })));
  const H = Math.max(...scaled.map((x) => x.info.height));
  const out = await Promise.all(scaled.map(({ data, info }) => sharp(data).extend({ top: H - info.height, bottom: 0, left: 0, right: 0, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()));
  // The plank's top in each: the first solid row of the middle fifth of the columns (median).
  const tops = await Promise.all(
    out.map(async (png) => {
      const { data } = await sharp(png).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
      const ys: number[] = [];
      for (let x = Math.round(W * 0.4); x < W * 0.6; x += 4) {
        let y = 0;
        while (y < H && data[y * W + x] <= 128) y++;
        ys.push(y);
      }
      ys.sort((p, q) => p - q);
      return ys[ys.length >> 1] ?? 0;
    }),
  );
  const top = [...tops].sort((p, q) => p - q)[tops.length >> 1] / H;
  return { pngs: out, top };
}

/** The sign in front of the characters (element place "plaque"): as wide as the characters' area in every version, as
 * tall as its picture's proportions say (lib/char-brief plaqueAspect — one for all themes); its top a little over the
 * characters' cut-off bottom (`top` of their height: the forearms rest on it); the characters at most `w` of its width. */
const PLAQUE = { top: 0.93, w: 0.97 };
/** The lettering on the sign: the plain middle between the decorated ends (x, w), and of the plank's own height (y, h). */
const PLAQUE_TEXT = { x: 0.22, y: 0.12, w: 0.56, h: 0.76 };

/** One set a product version is made of: the set itself, a version set of a drawn lineup (brief.lineup.drawn), or
 * one character of the parent drawn in its pose (brief.poses) — then `brief` is the parent's, `set` the pose set's files
 * renamed to that character's slots (and mirrored when it stands the other way). */
interface Source {
  key: string;
  p: CtCharProject;
  set: CtCharLayerSet;
  images: CtCharImage[];
  brief: CtCharBrief;
  /** A pose set placed as one of the parent's characters: its index in the parent's subjects. */
  as?: { subject: number; flip: boolean };
}

/** A piece of a version: a set and the subjects (of its brief) taken from it; a posed character with where it goes. */
interface Part {
  src: Source;
  subjects: number[];
  person?: CtCharComposePerson;
}

/** A version of the product: its customer name and what it is made of (one part, or one per posed character). */
interface Version {
  name: string;
  parts: Part[];
}

/** A file url that is drawn mirrored (a pose placed on the other side). */
const MIRROR = "mirror:";

/** A pose set's files as one character of the parent: slot keys renamed to that character's slots (same parts in the
 * same order — lib/char-brief poseProblems), labels to its name; mirrored: every file flopped (bbox too). */
function posedSet(set: CtCharLayerSet, poseSubject: CtCharSubject, target: CtCharSubject, name: string, flip: boolean): CtCharLayerSet {
  const ids = new Map(poseSubject.slots.map((sl, i) => [sl.id, target.slots[i]?.id ?? sl.id]));
  const key = (k: string) => {
    const [id, ...rest] = k.split(":");
    return [ids.get(id) ?? id, ...rest].join(":");
  };
  const m = (u: string | undefined) => (u && flip ? `${MIRROR}${u}` : u);
  const file = (f: CtCharLayerFile): CtCharLayerFile =>
    flip ? { ...f, url: m(f.url)!, thumbUrl: m(f.thumbUrl) ?? f.thumbUrl, viewUrl: m(f.viewUrl), viewThumbUrl: m(f.viewThumbUrl), bbox: f.bbox?.length === 4 ? [set.width - f.bbox[0] - f.bbox[2], f.bbox[1], f.bbox[2], f.bbox[3]] : f.bbox } : f;
  return {
    ...set,
    slots: set.slots.map((sl) => ({ ...sl, key: key(sl.key), label: sl.key === "body" ? sl.label : `${name} — ${sl.label.replace(/^Người \d+ — /, "")}`, follows: sl.follows ? key(sl.follows) : sl.follows, files: sl.files.map(file) })),
    zones: [],
    behindUrl: m(set.behindUrl),
  };
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
  const fileCache = new Map<string, Promise<Buffer>>();
  // A mirrored file (a pose placed on the other side): the file flopped.
  const bytes = (url: string): Promise<Buffer> => {
    const hit = fileCache.get(url);
    if (hit) return hit;
    const b = url.startsWith(MIRROR) ? bytes(url.slice(MIRROR.length)).then((x) => sharp(x).flop().png().toBuffer()) : fetchImage(url);
    fileCache.set(url, b);
    return b;
  };

  // ---- the versions, each from its own set ----
  const own: Source = { key: p.id, p, set, images, brief };
  const named = charVersions(brief);
  const posed = !!brief.poses?.length;
  // Each version its own drawing: a drawn lineup's version sets, or characters drawn alone in their poses.
  const drawn = posed || (brief.lineup?.drawn === true && named.length > 1);
  let versions: Version[];
  if (posed) {
    // Every character from its pose set, as the composition places it (lib/char-lineup composedVersions).
    const children = await versionSetsOf(s.supabase, p.id);
    const sources = new Map<string, Source>();
    const sourceOf = async (subjectId: string, flip: boolean): Promise<Source> => {
      const at = poseOf(brief, subjectId);
      const c = at ? children.find((x) => x.brief.versionOf?.pose === at.pose.id) : undefined;
      if (!at || !c?.layers || c.layers.status !== "done") throw new Error(`Dáng của "${subjectId}" chưa cắt xong`);
      const key = `${c.id}|${subjectId}|${flip}`;
      const hit = sources.get(key);
      if (hit) return hit;
      const i = brief.subjects.findIndex((x) => x.id === subjectId);
      const src: Source = { key, p: c, set: posedSet(c.layers, c.brief.subjects[0], brief.subjects[i], subjectName(brief, i), flip), images: await loadImages(s.supabase, c.id), brief, as: { subject: i, flip } };
      sources.set(key, src);
      return src;
    };
    versions = [];
    for (const v of composedVersions(brief)) {
      const parts: Part[] = [];
      for (const person of v.people) {
        const flip = person.flip ?? poseOf(brief, person.subject)?.mirrored ?? false;
        const src = await sourceOf(person.subject, flip);
        parts.push({ src, subjects: [src.as!.subject], person });
      }
      versions.push({ name: v.name, parts });
    }
  } else if (drawn) {
    // The biggest version is this set; each smaller one its own version set (server/char/versions.ts).
    const children = await versionSetsOf(s.supabase, p.id);
    versions = [];
    for (const [i, v] of named.entries()) {
      if (i === named.length - 1) {
        versions.push({ name: v.name, parts: [{ src: own, subjects: brief.subjects.map((_, k) => k) }] });
        continue;
      }
      const c = children.find((x) => x.brief.versionOf?.index === i);
      if (!c?.layers || c.layers.status !== "done") throw new Error(`Phiên bản "${v.name}" chưa cắt xong`);
      versions.push({ name: v.name, parts: [{ src: { key: c.id, p: c, set: c.layers, images: await loadImages(s.supabase, c.id), brief: c.brief }, subjects: c.brief.subjects.map((_, k) => k) }] });
    }
  } else versions = named.map((v) => ({ name: v.name, parts: [{ src: own, subjects: v.subjects }] }));
  const lineup = versions.length > 1;

  // ---- per set: who is where, its files and cliparts (made once, used by every version of it) ----
  const cap = (x: string) => (x ? x[0].toUpperCase() + x.slice(1) : x);
  const HAT = /\b(hat|cap|beanie|helmet|crown|hood)\b|mũ|nón/i;
  type Prepared = Awaited<ReturnType<typeof prepare>>;
  const prepared = new Map<string, Prepared>();
  async function prepare(src: Source) {
    const sb = src.brief;
    const sset = src.set;
    // One character of the parent drawn alone (a pose set): its files are all its own.
    const solo = src.as?.subject;
    const allSlots = sb.subjects.flatMap((sub) => sub.slots);
    const slotOf = (sl: CtCharLayerSlot) => allSlots.find((x) => x.id === sl.key.split(":")[0]);
    const subjectOfSlot = new Map<string, number>();
    sb.subjects.forEach((sub, i) => sub.slots.forEach((sl) => subjectOfSlot.set(sl.id, i)));
    const slotSubject = (sl: CtCharLayerSlot) => subjectOfSlot.get(sl.key.split(":")[0]) ?? -1;
    const fileBox = (f: CtCharLayerFile): CtLayoutBox | null => (f.bbox && f.bbox.length === 4 ? { x: f.bbox[0], y: f.bbox[1], w: f.bbox[2], h: f.bbox[3] } : null);
    const boxesOf = (i: number) => sset.slots.filter((sl) => slotSubject(sl) === i).flatMap((sl) => sl.files.map(fileBox).filter((b): b is CtLayoutBox => b !== null));
    // A lineup cut from ONE picture splits the body per subject; a drawn version has its own body.
    const split = lineup && !drawn && solo === undefined;
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
      (split ? unionBox(subs.map(subjectBox).filter((b): b is CtLayoutBox => b !== null)) : null) ?? (subs.length === sb.subjects.length || solo !== undefined ? unionBox([...(bodyBox ? [bodyBox] : []), ...subs.flatMap(boxesOf)]) : null) ?? bodyBox ?? { x: 0, y: 0, w: sset.width, h: sset.height };

    // A headwear outfit (slot.headwear): the hat becomes its own layer over the hair, the rest stays where the slot is —
    // unless the hair is drawn ON the outfit picture (slot.on, under its hat): that hair is cut against the outfit and
    // lies over it like in 3c. The hat over it showed the outfit file's own skin under the brim (the brim's shadow on
    // the forehead the hair covers in 3b) as a line between the brim and the hair (found 2026-10-29, set 1c307fa0).
    const hatOver = (sl: CtCharLayerSlot): boolean => {
      const b = slotOf(sl);
      if (!b?.headwear || sl.follows) return false;
      const own = sb.subjects[slotSubject(sl)]?.slots ?? [];
      return !own.some((x) => x.on && (x.on === b.id || x.on === b.group));
    };
    const hats = new Map<string, string>();
    const slots: CtCharLayerSlot[] = [];
    for (const sl of sset.slots) {
      slots.push(sl);
      if (hatOver(sl)) {
        const key = `${sl.key}:hat`;
        hats.set(key, sl.key);
      }
    }
    const hatSlots: CtCharLayerSlot[] = [...hats].map(([key, of]) => {
      const sl = sset.slots.find((x) => x.key === of)!;
      return { ...sl, key, label: `${sl.label} — nón` };
    });
    /**
     * A pose set's "phần nằm sau" of this layer (server/char/behind.ts) — a headwear outfit's mask holds for both its
     * hat and the rest (asked 2026-10-23: the sweater can go behind too). Mirrored characters: the mask url carries the
     * MIRROR prefix like the files.
     */
    // The doll's mask holds for every layer of it (asked 2026-10-23: "ra sau" = behind the whole neighbouring doll,
    // never behind the doll's own body — the sweater alone under everything showed the doll's tank top).
    const behindOf = (_sl: CtCharLayerSlot): string | undefined => (src.p.brief.versionOf?.pose ? sset.behindUrl : undefined);
    /** `keep`: "out" = the layer without its back part (the layer itself), "in" = its back part only. */
    const pieceOf = async (sl: CtCharLayerSlot, url: string, keep: "in" | "out" = "out"): Promise<Buffer> => {
      let png = await bytes(url);
      if (hats.has(sl.key)) png = (await splitHeadwear(png)).hat;
      else if (hatOver(sl)) png = (await splitHeadwear(png)).rest;
      const behind = behindOf(sl);
      return behind ? keepMask(png, await bytes(behind), keep) : png;
    };
    /** What pieceOf did to a pose set's file (kept on the clipart: a fix of the file is redone the same way). */
    const fxOf = (sl: CtCharLayerSlot, url: string, keep: "in" | "out" = "out"): CtCharFileFx | null => {
      if (!src.p.brief.versionOf?.pose) return null;
      const behind = behindOf(sl);
      return {
        ...(url.startsWith(MIRROR) ? { flip: true } : {}),
        ...(hats.has(sl.key) ? { part: "hat" as const } : hatOver(sl) ? { part: "rest" as const } : {}),
        ...(behind ? { behind: { url: behind.startsWith(MIRROR) ? behind.slice(MIRROR.length) : behind, keep } } : {}),
      };
    };

    // The thumbnail pictures (3b "thumb:<slot>:<option>") by role.
    const thumbs = new Map([...latestEditsOf(src.images)].filter(([role, im]) => role.startsWith("thumb:") && im.status === "done").map(([role, im]) => [role, im.url]));
    const thumbPictureOf = (slot: CtCharLayerSlot, f: CtCharLayerFile) => {
      const sl = slotOf(slot);
      const o = sl?.options.find((x) => x.name === f.option);
      return o ? thumbs.get(`thumb:${sl!.id}:${o.id}`) : undefined;
    };
    /**
     * An option's thumbnail = the whole character wearing it, as the product shows them — its body, every other part in
     * its first option, this option over it — cropped to that character, never the cut piece alone with its holes
     * (asked 2026-10-20: "thumb là hình hoàn chỉnh, clipart vẫn là clipart gốc"; a face's expression is a face, not eyes
     * floating in a tile). The 3b pictures cannot be it: they are drawn on the faceless, bald doll.
     */
    const madeThumbs = new Map<string, Promise<string | undefined>>();
    let ownBodies: Promise<Buffer[]> | null = null;
    const drawnThumbOf = (slot: CtCharLayerSlot, f: CtCharLayerFile): Promise<string | undefined> => {
      const i = slotSubject(slot);
      const base = slot.key.split(":")[0];
      const key = `${i}|${base}|${f.option}|${f.color}`;
      const hit = madeThumbs.get(key);
      if (hit) return hit;
      const made = (async () => {
        if (i < 0 || !bodyPng) return undefined;
        ownBodies ??= sb.subjects.length > 1 && solo === undefined ? splitBody(bodyPng, centres) : Promise.resolve([bodyPng]);
        const body = (await ownBodies)[solo === undefined ? i : 0];
        // The boy's hair with the boy's parts (his chooser on it), every other chooser on its first option.
        const picks = picksShowing(sb, slot.key, {});
        const mine = sset.slots.filter((sl) => sl.key !== "body" && slotSubject(sl) === i && slotShown(sb, sl.key, picks));
        const fileFor = (sl: CtCharLayerSlot): CtCharLayerFile | undefined => {
          if (sl.key.split(":")[0] === base) return sl.files.find((x) => x.option === f.option && x.color === f.color);
          const b = slotOf(sl);
          if (b?.optional) return undefined;
          const first = b?.options[0]?.name;
          const colour = b?.mode === "shape" ? (b.colors[0]?.name ?? "") : "";
          return sl.files.find((x) => x.option === first && x.color === colour) ?? sl.files[0];
        };
        // A headwear outfit: its sweater with the other parts, its hat over the hair (like the product).
        const pieces = (list: CtCharLayerSlot[], hat: boolean) =>
          Promise.all(
            list.flatMap((sl) => {
              const g = fileFor(sl);
              const head = hatOver(sl);
              if (!g || (hat && !head)) return [];
              return [head ? bytes(g.url).then(splitHeadwear).then((x) => (hat ? x.hat : x.rest)) : bytes(g.url)];
            }),
          );
        const backs = await pieces(mine.filter((sl) => sl.follows), false);
        const fronts = await pieces(mine.filter((sl) => !sl.follows), false);
        const hats = await pieces(mine.filter((sl) => !sl.follows), true);
        const stack = [...backs, body, ...fronts, ...hats];
        const all = await sharp({ create: { width: sset.width, height: sset.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
          .composite(stack.map((input) => ({ input })))
          .png()
          .toBuffer();
        // The character alone: a neighbour's ear or lock the body split / a cut left at the edge goes.
        const one = await mainPieces(all);
        const u = await alphaBox(one);
        if (!u) return undefined;
        const side = Math.round(Math.min(Math.max(u.w, u.h) * 1.06, sset.width, sset.height));
        const left = Math.round(Math.min(Math.max(0, u.x + u.w / 2 - side / 2), sset.width - side));
        const top = Math.round(Math.min(Math.max(0, u.y + u.h / 2 - side / 2), sset.height - side));
        const png = await sharp(one).extract({ left, top, width: side, height: side }).resize(480, 480).webp({ quality: 86, alphaQuality: 90 }).toBuffer();
        return (await saveCharRaw(src.p.user_id ?? s.user.id, src.p.id, "thumb", png, "image/webp")).url;
      })().catch((e: Error) => {
        console.warn("[ct] option thumb", e.message);
        return undefined;
      });
      madeThumbs.set(key, made);
      return made;
    };
    /** A slot's groups: shape slots with colours → one group per colour (options = shapes); otherwise one group. */
    const slotGroups = new Map<string, Promise<Array<{ name: string; sub: CtAsset | null }>>>();
    const groupsOf = (slot: CtCharLayerSlot, label: string, keep: "in" | "out" = "out") => {
      const cacheKey = `${slot.key}|${keep}`;
      const hit = slotGroups.get(cacheKey);
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
            const thumb = thumbPictureOf(slot, f) ?? (await drawnThumbOf(slot, f)) ?? (whole ? whole.viewUrl || whole.url : undefined);
            const fx = fxOf(slot, f.url, keep);
            const a = await clipart(await cleanKey(await pieceOf(slot, f.url, keep), false), [label, f.option, f.color, keep === "in" ? "back" : ""].filter(Boolean).join(" · "), sub?.id ?? null, { charLayerId: f.imageId, ...(fx ? { charFx: fx } : {}), ...(swatch ? { swatch } : {}), ...(thumb ? { thumb } : {}) });
            sub ??= a;
          }
          return { name: grouped ? g.name : "", sub };
        }),
      );
      slotGroups.set(cacheKey, made);
      return made;
    };
    /**
     * The customer's one choice for slots that are the same choice (slot.sameAs — the hair under each kind of hat, asked
     * 2026-10-30): empty pictures in this lead slot's groups, its options' thumbnails and swatches; the lead and every
     * slot sameAs it follow it (each shown by its own shownWhen), so the pick stays when the theme changes.
     */
    const pickers = new Map<string, Promise<Array<{ name: string; sub: CtAsset | null }>>>();
    const pickerOf = (slot: CtCharLayerSlot, label: string) => {
      const hit = pickers.get(slot.key);
      if (hit) return hit;
      const colours = [...new Set(slot.files.map((f) => f.color))];
      const grouped = colours.length > 1 || colours[0] !== "";
      const groups = grouped ? colours.map((c) => ({ name: c, files: slot.files.filter((f) => f.color === c) })) : [{ name: "", files: slot.files }];
      const back = sset.slots.find((x) => x.follows === slot.key);
      const made = Promise.all(
        groups.map(async (g) => {
          let sub: CtAsset | null = null;
          for (const f of g.files) {
            const swatch = swatchOf(sb, slot.key, f.option, f.color);
            const whole = f.viewUrl ? f : back?.files.find((b) => b.option === f.option && b.color === f.color);
            const thumb = thumbPictureOf(slot, f) ?? (await drawnThumbOf(slot, f)) ?? (whole ? whole.viewUrl || whole.url : undefined);
            const a = await clipart(blankPng, [label, f.option, f.color, "chọn"].filter(Boolean).join(" · "), sub?.id ?? null, { ...(swatch ? { swatch } : {}), ...(thumb ? { thumb } : {}) });
            sub ??= a;
          }
          return { name: grouped ? g.name : "", sub };
        }),
      );
      pickers.set(slot.key, made);
      return made;
    };
    const bodyName = split ? undefined : solo !== undefined ? `Body · ${subjectName(sb, solo)}` : drawn ? `Body · ${src.p.brief.versionOf?.name ?? named[named.length - 1].name}` : "Body";
    // A pose's body with a "phần nằm sau" (server/char/behind.ts): the body without it, and the part on its own.
    const bodyBehind = src.p.brief.versionOf?.pose && bodySlot ? sset.behindUrl : undefined;
    const bodyMeta = (keep: "in" | "out"): CtAsset["meta"] =>
      bodySlot?.files[0]
        ? {
            charLayerId: bodySlot.files[0].imageId,
            ...(src.p.brief.versionOf?.pose ? { charFx: { ...(bodySlot.files[0].url.startsWith(MIRROR) ? { flip: true } : {}), ...(bodyBehind ? { behind: { url: bodyBehind.replace(MIRROR, ""), keep } } : {}) } } : {}),
          }
        : {};
    const bodyCliparts = bodies.map(async (png, i) =>
      clipart(bodyBehind ? await keepMask(png, await bytes(bodyBehind), "out") : png, bodyName ?? `Body · ${subjectName(sb, i)}`, null, bodyMeta("out")),
    );
    const bodyBacks = bodyBehind ? bodies.map(async (png, i) => clipart(await keepMask(png, await bytes(bodyBehind), "in"), `${bodyName ?? `Body · ${subjectName(sb, i)}`} · back`, null, bodyMeta("in"))) : [];

    // A name "on" a character sits on that character's hat brim, following its curve — a box the brief gives is only
    // used without a hat (a guessed box put the names off the brims, 2026-10-22). Which hat: the default option's (the
    // files come in any order: the witch hat's brim put the names over the Santa hats), or — a name shown for one option
    // of the chooser the hats follow (a name per theme, asked 2026-10-30: a witch hat's band is not a Santa hat's) —
    // that option's hat.
    const brims = new Map<string, Promise<CtBrimArc | null>>();
    const brimOf = (i: number, when: CtCharShownWhen | null | undefined): Promise<CtBrimArc | null> => {
      const hatSlot = sb.subjects[i]?.slots.find((sl) => sl.headwear) ?? sb.subjects[i]?.slots.find((sl) => HAT.test(sl.part));
      const chooser = when && hatSlot?.follows === when.chooser ? (brief.choosers ?? []).find((c) => c.id === when.chooser) : undefined;
      const at = chooser ? Math.max(0, chooser.options.findIndex((o) => o.id === when!.option || o.name === when!.option)) : 0;
      const key = `${i}|${at}`;
      const hit = brims.get(key);
      if (hit) return hit;
      const made = (async () => {
        const sl = hatSlot && sset.slots.find((x) => x.key === hatSlot.id || x.key === `${hatSlot.id}:front`);
        const name = hatSlot?.options[at]?.name ?? hatSlot?.options[0]?.name;
        const file = sl?.files.find((f) => f.option === name && (f.color === "" || f.color === hatSlot?.colors[0]?.name)) ?? sl?.files[0];
        return file ? brimArc(hatSlot?.headwear ? (await splitHeadwear(await bytes(file.url))).hat : await bytes(file.url)) : null;
      })();
      brims.set(key, made);
      return made;
    };
    return { src, sb, sset, slotOf, slotSubject, hatOver, subjectBox, cropOf, slots, hatSlots, groupsOf, pickerOf, behindOf, bodies, bodyCliparts, bodyBacks, brimOf };
  }
  for (const v of versions) for (const pt of v.parts) if (!prepared.has(pt.src.key)) prepared.set(pt.src.key, await prepare(pt.src));

  // ---- where each version goes: its characters' crop (+ the sign under them) fitted in the characters' area ----
  const done = latestElementImages(images);
  // An element with a picture missing is left out (the cut makes the product before step 4 draws them; "Dựng lại sản
  // phẩm" puts them in).
  const pics = elementPictures(p);
  const ready = brief.elements.filter((e) => pics.filter((x) => x.element.id === e.id).every((x) => done.has(x.role)));
  const plaque = ready.find((e) => e.place === "plaque") ?? null;
  // Every theme's sign on one canvas: as wide as the characters' area, its height from that canvas.
  const signPics = plaque ? pics.filter((x) => x.element.id === plaque.id) : [];
  const signSet = plaque ? await signCanvases(await Promise.all(signPics.map(async (x) => trimmed(await fetchImage(done.get(x.role)!.url))))) : null;
  const signs = signSet?.pngs ?? [];
  const signMeta = signs[0] ? await sharp(signs[0]).metadata() : null;
  const signH = signMeta?.width && signMeta.height ? (charArea.w * signMeta.height) / signMeta.width : 0;
  // The canvas above the plank (decorations rising): the characters overlap it — they rest on the plank itself.
  const signAbove = signH * (signSet?.top ?? 0);
  // The characters over the sign: their height down to the sign's top, then the sign.
  const fitOf = (c: CtLayoutBox) => (plaque ? Math.min((charArea.w * PLAQUE.w) / c.w, (charArea.h - signH + signAbove) / (c.h * PLAQUE.top)) : Math.min(charArea.w / c.w, charArea.h / c.h));
  /**
   * A version's characters as one group: each part's crop on its own canvas, scaled to its person's height (a posed
   * character) or 1:1 (a set's own picture) — `crop` is the group in those units, each part's `at` where its crop lies.
   */
  const groupOf = (v: Version) => {
    const parts = v.parts.map((pt) => {
      const P = prepared.get(pt.src.key)!;
      const c = P.cropOf(pt.subjects);
      const u = pt.person ? pt.person.h / c.h : 1;
      const at = pt.person ? { x: pt.person.x - (c.w * u) / 2, y: pt.person.y - c.h * u, w: c.w * u, h: c.h * u } : c;
      return { pt, P, c, u, at };
    });
    return { parts, crop: unionBox(parts.map((x) => x.at))! };
  };
  const last = versions[versions.length - 1];
  const lastCrop = groupOf(last).crop;
  // "count": one size for everyone — the whole row's fit (one person is as big as in the row of five); a drawn
  // version (its own picture) gets the height the whole row's characters have.
  const rowScale = fitOf(lastCrop);
  const rowHeight = lastCrop.h * rowScale;
  /** Where each part's canvas goes on the print (box, k = print px per canvas px), and the sign under the group. */
  const placeOf = (v: Version): { parts: Array<{ pt: Part; P: Prepared; box: CtLayoutBox; k: number }>; plaque: CtLayoutBox | null } => {
    const g = groupOf(v);
    if (!lineup && !brief.charactersBox && !plaque && !posed) {
      const only = g.parts[0];
      return { parts: [{ pt: only.pt, P: only.P, box: layout.characters, k: layout.characters.w / only.P.sset.width }], plaque: null };
    }
    const crop = g.crop;
    const k = brief.lineup?.mode === "count" ? (drawn ? Math.min(rowHeight / crop.h, fitOf(crop)) : rowScale) : fitOf(crop);
    const blockH = plaque ? crop.h * k * PLAQUE.top + signH - signAbove : crop.h * k;
    const chars = { x: charArea.x + (charArea.w - crop.w * k) / 2, y: charArea.y + charArea.h - blockH, w: crop.w * k, h: crop.h * k };
    return {
      parts: g.parts.map(({ pt, P, c, u, at }) => {
        // This part's crop on the print, then its whole canvas around it.
        const kp = k * u;
        const x = chars.x + (at.x - crop.x) * k;
        const y = chars.y + (at.y - crop.y) * k;
        return { pt, P, box: { x: x - c.x * kp, y: y - c.y * kp, w: P.sset.width * kp, h: P.sset.height * kp }, k: kp };
      }),
      plaque: plaque ? { x: charArea.x, y: chars.y + chars.h * PLAQUE.top - signAbove, w: charArea.w, h: signH } : null,
    };
  };

  // The backgrounds the customer picks (over the whole piece); a repeating one (plaid) as a seamless tile.
  const backdrops = latestBackdrops(p, images);
  const tiled = backdrops.length > 0 && backdrops.every((b) => b.backdrop.tile);
  const backdropCliparts = Promise.all(backdrops.map(async ({ backdrop, image }) => clipart(backdrop.tile ? await seamlessTile(await bytes(image.url)) : await bytes(image.url), `Background · ${backdrop.name}`, null, {})));

  // Decorations (asked 2026-10-18): drawn alone (server/char/elements.ts), trimmed, placed in their box.
  const elementBoxes = charElementBoxes(brief.elements, charArea, area, piece);
  const elementCliparts = new Map<string, Promise<Array<{ name: string; sub: CtAsset }>>>();
  /** An element's cliparts; the sign (place "plaque") each on the one sign canvas (every theme the same size). */
  const cliparsOf = (e: CtCharElement): Promise<Array<{ name: string; sub: CtAsset }>> => {
    const key = e.id;
    const hit = elementCliparts.get(key);
    if (hit) return hit;
    const made = (async () => {
      const list = pics.filter((x) => x.element.id === e.id);
      const out: Array<{ name: string; sub: CtAsset }> = [];
      let first: CtAsset | null = null;
      // perBackdrop: each picture its own group (no gốc / đa sắc chain).
      for (const x of list) {
        let png = e.place === "plaque" ? signs[signPics.findIndex((y) => y.role === x.role)] : await trimmed(await fetchImage(done.get(x.role)!.url));
        // The ground under the characters: mirrored beside itself, repeated along the band (a 3:1 rug from a 3:2 picture).
        if (e.place === "bottom" && !e.box) png = await seamlessTile(png, true);
        const hex = e.options.find((o) => o.name === x.name)?.value;
        const a = await clipart(png, `${e.name} · ${x.name}`, e.perBackdrop ? null : (first?.id ?? null), e.mode === "color" && hex && /^#[0-9a-f]{6}$/i.test(hex) ? { swatch: hex } : {});
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
    const { parts, plaque: plaqueBox } = placeOf(v);
    // Who is in this version (subject indexes of each part's brief) — a part's own set may be a version set.
    const has = (subjectId: string | null | undefined) => parts.some(({ P, pt }) => pt.subjects.includes(P.sb.subjects.findIndex((x) => x.id === subjectId)));
    const many = parts.reduce((n, x) => n + x.pt.subjects.length, 0) > 1;
    const imageRegion = (label: string, customerLabel: string, image: Partial<CtRegion["config"]["image"]>, shape: CtShape, extra: Partial<CtRegion["config"]> = {}): CtRegion => {
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
      if (c.subject && !has(c.subject)) continue;
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

    // 0) the background (over the whole piece), 1) decorations behind, then each part (back → front: a posed character
    // later in the composition lies over the one before): 2) back halves (linked), 3) bodies, 4) photo zones, 5) every
    // other part in the set's order (front halves last), 6) hats; then 7) decorations in front, 8) texts.
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
      const list = await cliparsOf(e);
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

    // "Phần nằm sau" (server/char/behind.ts): inside a pose's mask the whole doll lies under every character — each of
    // its layers × the mask, in the doll's own order (back halves, body, parts, hats), each linked to its layer below.
    const behindRegions = new Map<Prepared, Map<string, CtRegion>>();
    for (const { pt, P, box } of parts) {
      const own = new Set(pt.subjects);
      const mineSl = (sl: CtCharLayerSlot) => own.has(P.slotSubject(sl)) && !!P.behindOf(sl);
      const map = new Map<string, CtRegion>();
      const add = (sl: CtCharLayerSlot) => {
        const r = imageRegion(`${sl.label} — phần sau`, `${sl.label} — back`, {}, rect(box));
        map.set(sl.key, r);
        fills.push(P.groupsOf(sl, sl.label, "in").then((groups) => groups.forEach((g, gi) => g.sub && addItem(r, g.sub, gi, g.name))));
      };
      P.slots.filter((sl) => sl.follows && mineSl(sl)).forEach(add);
      for (const back of P.bodyBacks.slice(0, 1)) {
        const r = imageRegion(`Thân — ${P.src.as ? subjectName(P.sb, P.src.as.subject) : ""} — phần sau`, "Body — back", {}, rect(box));
        fills.push(back.then((a) => addItem(r, a, 0)));
      }
      P.slots.filter((sl) => !sl.follows && sl.key !== "body" && mineSl(sl)).forEach(add);
      P.hatSlots.filter(mineSl).forEach(add);
      if (map.size) behindRegions.set(P, map);
    }

    // Every part's layers, linked afterwards (a part that follows the Theme needs the sign's region).
    const linked: Array<{ P: Prepared; sl: CtCharLayerSlot; r: CtRegion }> = [];
    for (const { pt, P, box, k } of parts) {
      const sb = P.sb;
      const ownSet = new Set(pt.subjects);
      const full = rect(box);
      const modeOf = (sl: CtCharLayerSlot) => P.slotOf(sl)?.mode;
      // One character in the picture: the part alone ("Hair"); several: "Person 2 — Hair".
      const labelFor = (sl: CtCharLayerSlot) => {
        const w = who(sb, sl.key);
        const part = sl.key.endsWith(":hat") ? "Hat" : P.hatOver(sl) ? "Top" : w.part;
        if (part && !many) return cap(part);
        return w.name ? `${w.name} — ${part}` : sl.label;
      };
      const byKey = new Map([...P.slots, ...P.hatSlots].map((sl) => [sl.key, sl]));
      const mine = (sl: CtCharLayerSlot) => ownSet.has(P.slotSubject(sl));
      const backs = P.slots.filter((sl) => sl.follows && mine(sl));
      const fronts = P.slots.filter((sl) => !sl.follows && sl.key !== "body" && mine(sl));
      const hatsOver = P.hatSlots.filter(mine);
      const regionOf = new Map<string, CtRegion>();
      const start = regions.length;
      for (const sl of backs) regionOf.set(sl.key, imageRegion(sl.label, labelFor(sl), {}, full));
      if (P.bodies.length) {
        for (const [i, c] of P.bodyCliparts.entries()) {
          const cut = lineup && !drawn;
          if (cut && !ownSet.has(i)) continue;
          const r = imageRegion(cut ? `Thân — ${subjectName(sb, i)}` : P.src.as ? `Thân — ${subjectName(sb, P.src.as.subject)}` : "Thân", "Body", {}, full);
          fills.push(c.then((a) => addItem(r, a, 0)));
        }
      }
      const isBody = (r: CtRegion) => r.name.startsWith("Thân");
      const firstBody = regions.findIndex((r, i) => i >= start && isBody(r));
      const photoRegions: CtRegion[] = P.sset.zones.map((z) => {
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
        const lastBody = regions.reduce((n, r, i) => (i >= start && isBody(r) ? i : n), at - 1);
        regions.splice(lastBody + 1, 0, ...over);
        regions.splice(at, 0, ...under);
      }
      // In the set's own order (every part is a layer drawn on the doll: a cardigan that only changes colour lies over
      // the dress like any garment — 2026-10-14); the hats of headwear outfits over everything of the character.
      for (const sl of [...fronts, ...hatsOver]) {
        const slot = P.slotOf(sl);
        const optional = slot?.optional === true;
        if (modeOf(sl) !== "shape") {
          regionOf.set(sl.key, imageRegion(sl.label, labelFor(sl), { display: modeOf(sl) === "color" ? "swatch" : "image", allowNone: optional, defaultNone: optional }, full));
          continue;
        }
        const coloured = sl.files.some((f) => f.color !== "");
        const w = who(sb, sl.key);
        const part = w.part.replace(/\s*(style|kiểu)$/i, "").trim() || w.part;
        // A face's expression is picked by its picture too: the character drawn with it (meta.thumb, its file alone is
        // only eyes and a mouth); by its name only when the set has no plan pictures to make that from.
        const face = slot ? isFace(slot.part) && !P.src.p.cut?.plan : false;
        // The styles are picked by their picture (the character drawn in it — meta.thumb), the colour by its swatch.
        regionOf.set(sl.key, imageRegion(sl.label, labelFor(sl), { display: face ? "button" : "image", allowNone: optional, defaultNone: optional, groupLabel: !many ? `${cap(part)} Colour` : `${w.name} — ${part} Colour`, groupDisplay: coloured ? "swatch" : "button" }, full));
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
      // Slots that are one choice (slot.sameAs): a picker drawing nothing, the lead slot's groups and thumbnails, never
      // under a chooser; the lead's layer and the layers of every slot sameAs it follow it (their back halves follow them).
      const fronts1 = [...regionOf].filter(([key]) => !byKey.get(key)!.follows && !key.endsWith(":hat"));
      for (const [key, r] of fronts1) {
        const lead = P.slotOf(byKey.get(key)!);
        if (!lead || lead.sameAs) continue;
        const same = fronts1.filter(([k]) => P.slotOf(byKey.get(k)!)?.sameAs === lead.id);
        if (!same.length) continue;
        const pick = imageRegion(`Chọn — ${byKey.get(key)!.label}`, r.config.image.label, { display: r.config.image.display, allowNone: r.config.image.allowNone, defaultNone: r.config.image.defaultNone, groupLabel: r.config.image.groupLabel, groupDisplay: r.config.image.groupDisplay }, { type: "rect", x: 0, y: 0, w: 1, h: 1, radius: 0 });
        for (const [, x] of [[key, r] as const, ...same]) x.config.image.follows = pick.id;
        fills.push(
          P.pickerOf(byKey.get(key)!, labelFor(byKey.get(key)!)).then((groups) =>
            groups.forEach((g, gi) => {
              if (g.sub) addItem(pick, g.sub, gi, g.name);
            }),
          ),
        );
      }
      for (const [key, r] of behindRegions.get(P) ?? []) {
        const lead = regionOf.get(key);
        if (!lead) continue;
        r.config.image.follows = lead.id;
        r.config.image.allowNone = lead.config.image.allowNone;
        r.config.image.defaultNone = lead.config.image.defaultNone;
        if (lead.config.parent) r.config.parent = lead.config.parent;
      }
      for (const [key, r] of regionOf) {
        const sl = byKey.get(key)!;
        linked.push({ P, sl, r });
        fills.push(
          P.groupsOf(sl, labelFor(sl)).then((groups) =>
            groups.forEach((g, gi) => {
              if (g.sub) addItem(r, g.sub, gi, g.name);
            }),
          ),
        );
      }
    }
    for (const e of ready.filter((x) => x.front || x.place === "plaque")) await placeElement(e);
    // A part that follows a decoration or a chooser (the sweaters and hats follow the Theme): linked, no choice of its own.
    for (const { P, sl, r } of linked) {
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
    const onBrims: CtRegion[] = [];
    for (const t of brief.texts) {
      let at = layout.texts.find((x) => x.id === t.id);
      if (t.place === "free" && t.box) {
        const b = fromShares(area, t.box);
        at = { id: t.id, box: b, fontSize: Math.round(b.h * 0.78), curve: 0, align: "center" };
      } else if (t.place === "plaque") {
        // On the plank itself (below what rises above it).
        const plank = plaqueBox ? { ...plaqueBox, y: plaqueBox.y + plaqueBox.h * (signSet?.top ?? 0), h: plaqueBox.h * (1 - (signSet?.top ?? 0)) } : null;
        const b = plank ? fromShares(plank, t.box ?? PLAQUE_TEXT) : null;
        at = b ? { id: t.id, box: b, fontSize: Math.round(b.h * 0.78), curve: t.curve ?? 0, align: "center" } : undefined;
      } else if (t.place === "under" || t.place === "on") {
        // The part the character is in.
        const hit = parts.map((x) => ({ ...x, i: x.P.sb.subjects.findIndex((y) => y.id === t.subject) })).find((x) => x.i >= 0 && x.pt.subjects.includes(x.i));
        const sbx = hit ? hit.P.subjectBox(hit.i) : null;
        const onSb = hit && sbx ? { x: hit.box.x + sbx.x * hit.k, y: hit.box.y + sbx.y * hit.k, w: sbx.w * hit.k, h: sbx.h * hit.k } : null;
        const brim = hit && t.place === "on" && onSb && (hit.P.src.as?.subject === undefined || hit.i === hit.P.src.as.subject) ? await hit.P.brimOf(hit.i, t.shownWhen) : null;
        if (hit && brim) {
          // Centred on the band, as tall as it, the letters on the band's own circle and tilt (a nearly flat band: a
          // circle too big to see).
          const bb = brim.box;
          const b = { x: hit.box.x + bb.x * hit.k, y: hit.box.y + bb.y * hit.k, w: bb.w * hit.k, h: bb.h * hit.k };
          at = { id: t.id, box: b, fontSize: Math.round(b.h * 0.88), curve: brim.up ? 1 : -1, align: "center", arcRadius: brim.radius ? brim.radius / bb.w : 1000, arcTilt: Math.round(brim.tilt * 10) / 10 };
        } else if (t.place === "on" && onSb && t.box) {
          // Shares of that character's own box (a name on a character without a hat).
          const b = fromShares(onSb, t.box);
          at = { id: t.id, box: b, fontSize: Math.round(b.h * 0.78), curve: t.curve ?? 0, align: "center" };
        } else at = onSb && t.place === "under" ? underText(t, onSb, area, D) : undefined;
      }
      if (at) {
        const parent = parentOf(t.shownWhen);
        // A name on a hat and the line on the sign get the light halo too: the theme changes what is under them (dark red on
        // a black witch hat / dark Halloween wood could not be read, 2026-10-20).
        const r = textRegion(product.id, mainId, t, at, backdrops.length > 0 || t.place === "on" || t.place === "plaque", order++);
        const region = { ...r, ...(lineup ? { name: `Chữ — ${t.label} [${v.name}]` } : {}), ...(parent ? { config: { ...r.config, parent } } : {}) };
        regions.push(region);
        if (at.arcRadius) onBrims.push(region);
      }
    }
    // Every name on a hat in one size (the smallest band's): the grandma's bigger hat does not make her name louder.
    const brimFont = Math.min(...onBrims.map((r) => r.config.text.fontSize));
    for (const r of onBrims) {
      r.config.text.fontSize = brimFont;
      r.config.text.strokeWidth = Math.max(2, Math.round(brimFont * 0.12));
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
