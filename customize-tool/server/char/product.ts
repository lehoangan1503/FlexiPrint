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
import type { CtAsset, CtCharBrief, CtCharImage, CtCharLayerFile, CtCharLayerSet, CtCharLayerSlot, CtCharProject, CtCharTextField, CtCharTextPlace, CtPhotoStyleRef, CtProduct, CtRegion, CtRegionItem, CtShape } from "../../types";
import { defaultProductConfig, defaultRegionConfig } from "../../lib/design";
import { applyMaterialPreset, isMaterialId } from "../../lib/materials";
import { charLayout, type CtCharLayoutText } from "../../lib/char-layout";
import { latestBackdrops } from "./backdrops";
import { latestEditsOf } from "../../lib/char-images";
import * as h from "../handlers";
import type { CtSession } from "../supabase";
import { fetchImage } from "./files";
import { NOT_YOURS, canEditProject, jobDb, jsonError, loadImages, loadProject } from "./projects";
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
import { buildPhotoProduct, type KeptZone } from "./photo-product";
import { CT_FACE_STYLES } from "../../lib/photo-styles";

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
        mode: t.kind === "choice" ? "list" : "input",
        label: t.label,
        placeholder: t.kind === "input" ? `Example: ${t.defaultText}` : "",
        defaultText: first,
        choices: t.kind === "choice" ? t.choices : [],
        maxChars: Math.max(t.maxChars, ...t.choices.map((c) => c.length)),
        fontFamily: font.family,
        fontWeight: font.weights.includes(700) && t.kind === "choice" ? 700 : font.weights[0],
        fontSize: at.fontSize,
        color: t.color,
        ...(onPattern ? { strokeColor: "#fffaf0", strokeWidth: Math.max(2, Math.round(at.fontSize * (t.kind === "choice" ? 0.16 : 0.12))) } : {}),
        align: at.align,
        curve: at.curve,
        uppercase: false,
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
  if (template) {
    const { data: sheet } = await s.supabase.from(CT_TABLES.assets).select("*").eq("id", product.main_asset_id ?? "").single<CtAsset>();
    if (!sheet) throw new Error("Không thấy tờ in của khuôn");
    main = sheet;
    W = template.spec.width;
    H = template.spec.height;
    // The khuôn layer made with the product stays (saveDesign replaces the regions).
    const { data: frames } = await s.supabase.from(CT_TABLES.regions).select("*").eq("product_id", product.id).returns<CtRegion[]>();
    keep = frames ?? [];
  } else {
    // No khuôn in: the edit frame is the print file's frame — the set's canvas, bands for the texts around it.
    const has = (p: CtCharTextPlace) => brief.texts.some((t) => t.place === p);
    const bandH = Math.round(set.height * 0.16);
    W = Math.round(set.width * (has("left") || has("right") ? 1.6 : 1));
    H = set.height + (has("top") ? bandH : 0) + (has("bottom") ? bandH : 0);
    const canvas = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    main = await upload(canvas, "main", `Khung in ${W}×${H}`);
  }

  // Characters + texts (lib/char-layout.ts): the set's canvas fitted, aspect kept exactly, into the template's safe
  // zone (the whole frame without one) with the texts around it.
  const safe = template ? safeShapes(template.spec)[0] : undefined;
  const layout = charLayout({
    area: template ? (safe ? shapeBounds(safe) : { x: 0, y: 0, w: W, h: H }) : { x: 0, y: 0, w: W, h: H },
    round: safe?.type === "ellipse",
    holes: template ? template.spec.cuts.map(shapeBounds) : [],
    set: { width: set.width, height: set.height },
    texts: brief.texts,
  });
  const box: Box = layout.characters;
  const k = box.w / set.width;

  const regions: CtRegion[] = [];
  const items: CtRegionItem[] = [];
  let order = 0;
  const imageRegion = (label: string, customerLabel: string, image: Partial<CtRegion["config"]["image"]>): CtRegion => {
    const cfg = defaultRegionConfig("image");
    const r: CtRegion = {
      id: crypto.randomUUID(),
      product_id: product.id,
      name: label,
      kind: "image",
      shape: { type: "rect", x: box.x, y: box.y, w: box.w, h: box.h, radius: 0 },
      config: { ...cfg, clip: false, mainId: main.id, image: { ...cfg.image, label: customerLabel, ...image } },
      sort_order: order++,
    };
    regions.push(r);
    return r;
  };
  const addItem = (r: CtRegion, sub: CtAsset, index: number) =>
    items.push({ id: crypto.randomUUID(), region_id: r.id, asset_id: sub.id, transform: { offsetX: 0, offsetY: 0, scale: 1, rotation: 0 }, is_default: index === 0, sort_order: index });

  const fileCache = new Map<string, Buffer>();
  const bytes = async (url: string) => {
    const hit = fileCache.get(url);
    if (hit) return hit;
    const b = await fetchImage(url);
    fileCache.set(url, b);
    return b;
  };

  const images = await loadImages(s.supabase, p.id);
  // The thumbnail pictures (3b "thumb:<slot>:<option>") by role.
  const thumbs = new Map([...latestEditsOf(images)].filter(([role, im]) => role.startsWith("thumb:") && im.status === "done").map(([role, im]) => [role, im.url]));

  /** Groups: shape slots with colours → one group per colour (options = shapes); otherwise one group. */
  const fill = async (r: CtRegion, slot: CtCharLayerSlot) => {
    const colours = [...new Set(slot.files.map((f) => f.color))];
    const grouped = colours.length > 1 || colours[0] !== "";
    const groups = grouped ? colours.map((c) => ({ name: c, files: slot.files.filter((f) => f.color === c) })) : [{ name: "", files: slot.files }];
    // A wrapping part's option is shown as it is seen (back + front, server/char/layers.ts views).
    const back = set.slots.find((x) => x.follows === slot.key);
    const thumbOf = (f: CtCharLayerFile) => (f.viewUrl ? f : back?.files.find((b) => b.option === f.option && b.color === f.color));
    // A part a hand hides partly: its thumbnail picture (3b "thumb:"), the whole object — the clipart stays the cut.
    const thumbPicture = (f: CtCharLayerFile) => {
      const sl = brief.subjects.flatMap((sub) => sub.slots).find((x) => x.id === slot.key.split(":")[0]);
      const o = sl?.options.find((x) => x.name === f.option);
      return o ? thumbs.get(`thumb:${sl!.id}:${o.id}`) : undefined;
    };
    // Uploads of a group go in order (variants hang on the first); groups in parallel.
    const subs = await Promise.all(
      groups.map(async (g) => {
        let sub: CtAsset | null = null;
        for (const f of g.files) {
          const swatch = swatchOf(brief, slot.key, f.option, f.color);
          const label = [labelFor(slot), f.option, f.color].filter(Boolean).join(" · ");
          const whole = thumbOf(f);
          const thumb = thumbPicture(f) ?? (whole ? whole.viewUrl || whole.url : undefined);
          const data = slot.key === "body" && faceHoles.length ? await punched(await bytes(f.url), faceHoles) : await bytes(f.url);
          const a = await clipart(data, label, sub?.id ?? null, { charLayerId: f.imageId, ...(swatch ? { swatch } : {}), ...(thumb ? { thumb } : {}) });
          sub ??= a;
        }
        return sub;
      }),
    );
    subs.forEach((sub, gi) => {
      if (!sub) return;
      addItem(r, sub, gi);
      if (grouped) r.config.image.groupNames[items[items.length - 1].id] = groups[gi].name;
    });
  };

  // Face zones: their outline is cut out of the body file (the face shows through it from the layer under the body).
  const faceHoles = set.zones.filter((z) => brief.photoZones.find((x) => x.id === z.id)?.treat === "face").map((z) => z.polygon);
  const byKey = new Map(set.slots.map((sl) => [sl.key, sl]));
  const backs = set.slots.filter((sl) => sl.follows);
  const body_ = byKey.get("body");
  const fronts = set.slots.filter((sl) => !sl.follows && sl.key !== "body");
  const regionOf = new Map<string, CtRegion>();
  // One character: the part alone ("Hair", "Sweater") — "Little girl about 6 years old — hair" read badly on the store.
  const cap = (x: string) => (x ? x[0].toUpperCase() + x.slice(1) : x);
  const labelFor = (sl: CtCharLayerSlot) => {
    const w = who(brief, sl.key);
    if (w.part && brief.subjects.length === 1) return cap(w.part);
    return w.name ? `${w.name} — ${w.part}` : sl.label;
  };

  // 0) the background the customer picks (over the whole piece), 1) back halves (linked), 2) body, 3) photo zones,
  // 4) every other part in the set's order (front halves last), 5) texts.
  const backdrops = latestBackdrops(p, images);
  if (backdrops.length) {
    const cfg = defaultRegionConfig("image");
    const piece: CtShape = template?.spec.outline ?? { type: "rect", x: 0, y: 0, w: W, h: H, radius: 0 };
    const r: CtRegion = {
      id: crypto.randomUUID(),
      product_id: product.id,
      name: "Nền",
      kind: "image",
      shape: piece,
      config: { ...cfg, mainId: main.id, fill: { mode: "cover", tile: 256 }, image: { ...cfg.image, label: "Background", display: "image" } },
      sort_order: order++,
    };
    regions.push(r);
    let i = 0;
    for (const { backdrop, image } of backdrops) {
      const a = await clipart(await bytes(image.url), `Background · ${backdrop.name}`, null, {});
      addItem(r, a, i++);
    }
  }
  for (const sl of backs) regionOf.set(sl.key, imageRegion(sl.label, labelFor(sl), {}));
  if (body_) regionOf.set("body", imageRegion("Thân", "Body", {}));
  const photoRegions: CtRegion[] = set.zones.map((z) => {
    const cfg = defaultRegionConfig("photo");
    const r: CtRegion = {
      id: crypto.randomUUID(),
      product_id: product.id,
      name: `Ảnh khách — ${z.label}`,
      kind: "photo",
      shape: keptZones.get(`Ảnh khách — ${z.label}`)?.shape ?? { type: "polygon", points: z.polygon.map(([x, y]) => ({ x: box.x + x * k, y: box.y + y * k })) },
      // A face under the body: the body's hole edges it (its hair may show past the hat, like the reference) — not clipped.
      config: { ...cfg, clip: brief.photoZones.find((x) => x.id === z.id)?.treat !== "face", mainId: main.id, photo: { ...cfg.photo, ...zonePhoto(brief, z.id), label: z.label, required: true, ...(keptZones.get(`Ảnh khách — ${z.label}`) ? { frame: keptZones.get(`Ảnh khách — ${z.label}`)!.frame } : {}) } },
      sort_order: order++,
    };
    regions.push(r);
    return r;
  });
  const modeOf = (sl: CtCharLayerSlot) => brief.subjects.flatMap((sub) => sub.slots).find((x) => x.id === sl.key.split(":")[0])?.mode;
  const isShape = (sl: CtCharLayerSlot) => modeOf(sl) === "shape";
  // In the set's own order (every part is a layer drawn on the doll: a cardigan that only changes colour lies over the
  // dress like any garment — 2026-10-14).
  for (const sl of fronts) {
    if (!isShape(sl)) {
      regionOf.set(sl.key, imageRegion(sl.label, labelFor(sl), { display: modeOf(sl) === "color" ? "swatch" : "image" }));
      continue;
    }
    const coloured = sl.files.some((f) => f.color !== "");
    const w = who(brief, sl.key);
    const part = w.part.replace(/\s*(style|kiểu)$/i, "").trim() || w.part;
    // The styles are picked by their picture (a back half's full clipart — meta.thumb), the colour by its swatch.
    regionOf.set(sl.key, imageRegion(sl.label, labelFor(sl), { display: "image", groupLabel: brief.subjects.length === 1 ? `${cap(part)} Colour` : `${w.name} — ${part} Colour`, groupDisplay: coloured ? "swatch" : "button" }));
  }
  for (const sl of backs) {
    const leader = regionOf.get(sl.follows ?? "");
    const r = regionOf.get(sl.key);
    if (leader && r) r.config.image.follows = leader.id;
  }
  // Texts above everything, each in its box around the characters.
  for (const t of brief.texts) {
    const at = layout.texts.find((x) => x.id === t.id);
    if (at) regions.push(textRegion(product.id, main.id, t, at, backdrops.length > 0, order++));
  }
  // Keep the z-order: photo zones sit right above the body — a face zone right UNDER it, seen through the hole cut
  // in the body (the hat brim, the hair edge and the collar lie over the customer's face).
  const bodyIdx = regions.findIndex((r) => r.name === "Thân");
  if (bodyIdx >= 0 && photoRegions.length) {
    const rest = regions.filter((r) => !photoRegions.includes(r));
    const under = photoRegions.filter((r) => r.config.photo.mode === "face");
    const over = photoRegions.filter((r) => r.config.photo.mode !== "face");
    const at = rest.findIndex((r) => r.name === "Thân");
    rest.splice(at + 1, 0, ...over);
    rest.splice(at, 0, ...under);
    rest.forEach((r, i) => (r.sort_order = i));
    regions.splice(0, regions.length, ...rest);
  }

  // Files (all slots in parallel; a slot's groups keep their order).
  await Promise.all(set.slots.map((sl) => (regionOf.get(sl.key) ? fill(regionOf.get(sl.key)!, sl) : Promise.resolve())));
  items.sort((a, b) => regions.findIndex((r) => r.id === a.region_id) - regions.findIndex((r) => r.id === b.region_id) || a.sort_order - b.sort_order);

  const config = { ...defaultProductConfig(), print: template ? productPrintOf(template) : null };
  // The brief's material (a ceramic ornament → "ceramic_gloss"), else by the cut: die-cut → white acrylic.
  const material = brief.product.material && isMaterialId(brief.product.material) ? brief.product.material : brief.product.cut === "alpha" ? "acrylic_white" : null;
  config.material = { ...(material ? applyMaterialPreset(config.material, material) : config.material), widthMm: mmW };
  // The phôi trơn (uploaded, else the AI one): Xem trước, the storefront and the mockups draw the design on it. The
  // sheet's box is found on the photo when the piece has a fixed shape (or the AI drew it on its plain backdrop).
  const blank: CtCharImage | null = projectBlank(p, await loadImages(s.supabase, p.id));
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
  const all = [...keep, ...regions].map((r, i) => ({ ...r, sort_order: i }));
  await body(await h.saveDesign(s, product.id, { regions: all, items, config }));
  return product.id;
}
