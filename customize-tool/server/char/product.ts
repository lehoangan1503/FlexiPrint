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
import type { CtAsset, CtCharBrief, CtCharImage, CtCharLayerFile, CtCharLayerSet, CtCharLayerSlot, CtCharProject, CtProduct, CtRegion, CtRegionItem } from "../../types";
import { defaultProductConfig, defaultRegionConfig } from "../../lib/design";
import { applyMaterialPreset } from "../../lib/materials";
import * as h from "../handlers";
import type { CtSession } from "../supabase";
import { fetchImage } from "./files";
import { jsonError, loadImages, loadProject } from "./projects";
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

/** Where the characters + text go on a template: its first safe shape (a circle / ellipse → the rectangle inside it). */
function safeArea(spec: CtPrintSpec): Box {
  const s = safeShapes(spec)[0];
  if (!s) return { x: 0, y: 0, w: spec.width, h: spec.height };
  if (s.type === "ellipse") {
    const w = s.rx * Math.SQRT2;
    const h = s.ry * Math.SQRT2;
    return { x: s.cx - w / 2, y: s.cy - h / 2, w, h };
  }
  return shapeBounds(s);
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

/** "Younger daughter, about 6…" → "Younger daughter". */
function who(brief: CtCharBrief, slotKey: string): { name: string; part: string } {
  const id = slotKey.split(":")[0];
  for (const sub of brief.subjects) {
    const slot = sub.slots.find((s) => s.id === id);
    if (!slot) continue;
    const short = sub.description.split(/[,.;]/)[0].trim();
    return { name: short ? short[0].toUpperCase() + short.slice(1) : "Character", part: slot.part };
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

/**
 * "Tạo bộ custom" ends here (asked 2026-10-10: the set IS the cliparts + a finished product, ready in the editor):
 * the cut that just finished (layers.ts runBuild, minutes after the request — the service client acting as the
 * project's owner) replaces the products made from the set before — each with its clipart folder — by ONE new
 * product built from `set`. → the new product id.
 */
export async function remakeSetProduct(db: CtSession["supabase"], userId: string, p: CtCharProject, set: CtCharLayerSet): Promise<string> {
  const { data, error } = await db.auth.admin.getUserById(userId);
  if (error || !data.user) throw new Error(`Không đọc được người dùng: ${error?.message ?? "không có"}`);
  const s: CtSession = { supabase: db, user: data.user };
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
  return build(s, p, set, p.name);
}

async function build(s: CtSession, p: CtCharProject, set: CtCharLayerSet, name: string): Promise<string> {
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
    // No khuôn in: the edit frame is the print file's frame — the set's canvas exactly, a band below for the text.
    W = set.width;
    H = set.height + (brief.text.enabled ? Math.round(set.height * 0.2) : 0);
    const canvas = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    main = await upload(canvas, "main", `Khung in ${W}×${H}`);
  }

  // Characters: the set's canvas fitted into the print area (a band below for the text), aspect kept exactly. The
  // area is the template's safe zone (a round one: the rectangle inside the circle), else the whole frame.
  const area = template ? safeArea(template.spec) : { x: 0, y: 0, w: W, h: H };
  const textBand = brief.text.enabled ? (template ? Math.round(area.h * 0.2) : H - set.height) : 0;
  const areaW = area.w;
  const areaH = area.h - textBand;
  const k = Math.min(areaW / set.width, areaH / set.height);
  const box: Box = { w: set.width * k, h: set.height * k, x: 0, y: 0 };
  box.x = area.x + (area.w - box.w) / 2;
  box.y = area.y + (areaH - box.h) / 2;

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

  /** Groups: shape slots with colours → one group per colour (options = shapes); otherwise one group. */
  const fill = async (r: CtRegion, slot: CtCharLayerSlot) => {
    const colours = [...new Set(slot.files.map((f) => f.color))];
    const grouped = colours.length > 1 || colours[0] !== "";
    const groups = grouped ? colours.map((c) => ({ name: c, files: slot.files.filter((f) => f.color === c) })) : [{ name: "", files: slot.files }];
    // A front half's option is shown by its back half (the whole part — hair over the face is cut from the front).
    const back = set.slots.find((x) => x.follows === slot.key);
    const thumbOf = (f: CtCharLayerFile) => back?.files.find((b) => b.option === f.option && b.color === f.color);
    // Uploads of a group go in order (variants hang on the first); groups in parallel.
    const subs = await Promise.all(
      groups.map(async (g) => {
        let sub: CtAsset | null = null;
        for (const f of g.files) {
          const swatch = swatchOf(brief, slot.key, f.option, f.color);
          const label = [labelFor(slot), f.option, f.color].filter(Boolean).join(" · ");
          const whole = thumbOf(f);
          const a = await clipart(await bytes(f.url), label, sub?.id ?? null, { charLayerId: f.imageId, ...(swatch ? { swatch } : {}), ...(whole ? { thumb: whole.thumbUrl || whole.url } : {}) });
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

  const byKey = new Map(set.slots.map((sl) => [sl.key, sl]));
  const backs = set.slots.filter((sl) => sl.follows);
  const body_ = byKey.get("body");
  const fronts = set.slots.filter((sl) => !sl.follows && sl.key !== "body");
  const regionOf = new Map<string, CtRegion>();
  const labelFor = (sl: CtCharLayerSlot) => {
    const w = who(brief, sl.key);
    return w.name ? `${w.name} — ${w.part}` : sl.label;
  };

  // 1) back halves (linked), 2) body, 3) photo zones, 4) colour / texture parts, 5) shapes & front halves, 6) text.
  for (const sl of backs) regionOf.set(sl.key, imageRegion(sl.label, labelFor(sl), {}));
  if (body_) regionOf.set("body", imageRegion("Thân", "Body", {}));
  const photoRegions: CtRegion[] = set.zones.map((z) => {
    const cfg = defaultRegionConfig("photo");
    const r: CtRegion = {
      id: crypto.randomUUID(),
      product_id: product.id,
      name: `Ảnh khách — ${z.label}`,
      kind: "photo",
      shape: { type: "polygon", points: z.polygon.map(([x, y]) => ({ x: box.x + x * k, y: box.y + y * k })) },
      config: { ...cfg, clip: true, mainId: main.id, photo: { ...cfg.photo, label: z.label, fit: "cover", cutout: false, fadeCrop: false, required: true } },
      sort_order: order++,
    };
    regions.push(r);
    return r;
  });
  const modeOf = (sl: CtCharLayerSlot) => brief.subjects.flatMap((sub) => sub.slots).find((x) => x.id === sl.key.split(":")[0])?.mode;
  const isShape = (sl: CtCharLayerSlot) => modeOf(sl) === "shape";
  for (const sl of fronts.filter((x) => !isShape(x))) regionOf.set(sl.key, imageRegion(sl.label, labelFor(sl), { display: modeOf(sl) === "color" ? "swatch" : "image" }));
  for (const sl of fronts.filter(isShape)) {
    const coloured = sl.files.some((f) => f.color !== "");
    const w = who(brief, sl.key);
    const part = w.part.replace(/\s*(style|kiểu)$/i, "").trim() || w.part;
    // The styles are picked by their picture (a back half's full clipart — meta.thumb), the colour by its swatch.
    regionOf.set(sl.key, imageRegion(sl.label, labelFor(sl), { display: "image", groupLabel: `${w.name} — ${part} Colour`, groupDisplay: coloured ? "swatch" : "button" }));
  }
  for (const sl of backs) {
    const leader = regionOf.get(sl.follows ?? "");
    const r = regionOf.get(sl.key);
    if (leader && r) r.config.image.follows = leader.id;
  }
  // Text above everything.
  if (brief.text.enabled) {
    const cfg = defaultRegionConfig("text");
    const font = CT_FONTS.some((f) => f.family === brief.text.font) ? brief.text.font : "Great Vibes";
    const bandY = area.y + area.h - textBand;
    regions.push({
      id: crypto.randomUUID(),
      product_id: product.id,
      name: "Chữ",
      kind: "text",
      shape: { type: "rect", x: area.x, y: bandY, w: area.w, h: textBand, radius: 0 },
      config: {
        ...cfg,
        mainId: main.id,
        text: { ...cfg.text, label: "Enter name", placeholder: `Example: ${brief.text.defaultText || "Jessica"}`, defaultText: brief.text.defaultText || "Jessica", maxChars: 24, fontFamily: font, fontWeight: CT_FONTS.find((f) => f.family === font)?.weights[0] ?? 400, fontSize: Math.round(textBand * 0.62), color: "#1d1d1f", uppercase: false },
      },
      sort_order: order++,
    });
  }
  // Keep the z-order: photo zones sit right above the body.
  const bodyIdx = regions.findIndex((r) => r.name === "Thân");
  if (bodyIdx >= 0 && photoRegions.length) {
    const rest = regions.filter((r) => !photoRegions.includes(r));
    rest.splice(bodyIdx + 1, 0, ...photoRegions);
    rest.forEach((r, i) => (r.sort_order = i));
    regions.splice(0, regions.length, ...rest);
  }

  // Files (all slots in parallel; a slot's groups keep their order).
  await Promise.all(set.slots.map((sl) => (regionOf.get(sl.key) ? fill(regionOf.get(sl.key)!, sl) : Promise.resolve())));
  items.sort((a, b) => regions.findIndex((r) => r.id === a.region_id) - regions.findIndex((r) => r.id === b.region_id) || a.sort_order - b.sort_order);

  const config = { ...defaultProductConfig(), print: template ? productPrintOf(template) : null };
  if (brief.product.cut === "alpha") config.material = { ...applyMaterialPreset(config.material, "acrylic_white"), widthMm: mmW };
  else config.material = { ...config.material, widthMm: mmW };
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
