/**
 * A product from a bộ nhân vật's layer set — one set, many products (bag, mug, sticker…).
 *
 *   POST char/projects/:id/products {name?} → { productId } a draft product, opened in the editor
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
import type { CtAsset, CtCharBrief, CtCharImage, CtCharLayerSet, CtCharLayerSlot, CtCharProject, CtProduct, CtRegion, CtRegionItem } from "../../types";
import { defaultProductConfig, defaultRegionConfig } from "../../lib/design";
import { applyMaterialPreset } from "../../lib/materials";
import * as h from "../handlers";
import type { CtSession } from "../supabase";
import { fetchImage } from "./files";
import { jsonError, loadImages, loadProject } from "./projects";

const DPI = 300;
const DEFAULT_MM = { w: 220, h: 150 };

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

async function build(s: CtSession, p: CtCharProject, set: CtCharLayerSet, name: string): Promise<string> {
  const brief = p.brief;
  const { product } = await body<{ product: CtProduct }>(await h.createProduct(s, { name }));
  const upload = async (data: Buffer, role: string, assetName: string, parentId: string | null = null, meta: Record<string, unknown> = {}): Promise<CtAsset> => {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(data)], { type: "image/png" }), `${assetName || role}.png`);
    form.set("role", role);
    form.set("name", assetName);
    if (parentId) form.set("parent_id", parentId);
    form.set("meta", JSON.stringify(meta));
    return (await body<{ asset: CtAsset }>(await h.uploadAsset(s, product.id, form))).asset;
  };

  // The print canvas: the print area at 300 dpi, transparent.
  const mmW = brief.product.widthMm || DEFAULT_MM.w;
  const mmH = brief.product.heightMm || DEFAULT_MM.h;
  const W = Math.round((mmW / 25.4) * DPI);
  const H = Math.round((mmH / 25.4) * DPI);
  const canvas = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const main = await upload(canvas, "main", "Vùng in");

  // Characters: the set's canvas fitted into the print (a band below for the text), aspect kept exactly.
  const margin = Math.round(Math.min(W, H) * 0.04);
  const textBand = brief.text.enabled ? Math.round(H * 0.2) : 0;
  const areaW = W - 2 * margin;
  const areaH = H - 2 * margin - textBand;
  const k = Math.min(areaW / set.width, areaH / set.height);
  const box: Box = { w: set.width * k, h: set.height * k, x: 0, y: 0 };
  box.x = (W - box.w) / 2;
  box.y = margin + (areaH - box.h) / 2;

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
    // Uploads of a group go in order (variants hang on the first); groups in parallel.
    const subs = await Promise.all(
      groups.map(async (g) => {
        let sub: CtAsset | null = null;
        for (const f of g.files) {
          const swatch = swatchOf(brief, slot.key, f.option, f.color);
          const a = await upload(await bytes(f.url), sub ? "variant" : "sub", f.option, sub?.id ?? null, { charLayerId: f.imageId, ...(swatch ? { swatch } : {}) });
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
    regionOf.set(sl.key, imageRegion(sl.label, labelFor(sl), { display: "button", groupLabel: `${w.name} — ${part} Colour`, groupDisplay: coloured ? "swatch" : "button" }));
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
    const bandY = H - margin - textBand;
    regions.push({
      id: crypto.randomUUID(),
      product_id: product.id,
      name: "Chữ",
      kind: "text",
      shape: { type: "rect", x: margin, y: bandY, w: W - 2 * margin, h: textBand, radius: 0 },
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

  const config = defaultProductConfig();
  if (brief.product.cut === "alpha") config.material = { ...applyMaterialPreset(config.material, "acrylic_white"), widthMm: mmW };
  else config.material = { ...config.material, widthMm: mmW };
  // The blank product photo: the storefront draws the design into the print area on it.
  const blank = brief.product.blankId ? (await loadImages(s.supabase, p.id)).find((im: CtCharImage) => im.id === brief.product.blankId) : undefined;
  if (blank?.width && blank.height) {
    const ref = await upload(await fetchImage(blank.url), "reference", "Phôi trơn chụp thẳng");
    const bw = blank.width * 0.6;
    const bh = (bw * H) / W;
    config.scene = { url: ref.url, width: blank.width, height: blank.height, box: { x: (blank.width - bw) / 2, y: Math.max(0, blank.height * 0.55 - bh / 2), w: bw, h: bh } };
  }
  await body(await h.saveDesign(s, product.id, { regions, items, config }));
  return product.id;
}
