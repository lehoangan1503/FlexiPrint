/**
 * The product of a bộ ảnh khách (brief.kind "photo", asked 2026-10-15 — a memorial pet ornament: the customer's pet
 * redrawn in a style they pick, angel wings behind it, a halo over it, a band of clouds over its cut-off body, a
 * message and the pet's name):
 *
 *   background (fill, the customer picks)  →  "behind" elements  →  the customer's photo  →  "above" / "free"
 *   elements  →  "bottom" elements (a perBackdrop band follows the background)  →  texts
 *
 * Every element picture is trimmed to what is drawn and fitted (contain) in its box (lib/photo-layout.ts); a band
 * fills its box's width. The photo zone is a photo layer: treat "ai" = the customer picks one of the zone's AI
 * styles (cut out, the cut edge faded), "face" = the head only; its sample (the master's pet alone) shows until
 * they upload. Like a bộ nhân vật's product, the pictures are cliparts in the product's library folder.
 */

import sharp from "sharp";
import { CT_TABLES } from "../../config";
import type { CtAsset, CtCharElement, CtCharImage, CtCharProject, CtPhotoFrame, CtPhotoStyleRef, CtProduct, CtRegion, CtRegionItem, CtShape } from "../../types";
import { defaultProductConfig, defaultRegionConfig } from "../../lib/design";
import { applyMaterialPreset, isMaterialId } from "../../lib/materials";
import { photoLayout } from "../../lib/photo-layout";
import { CT_FACE_STYLES } from "../../lib/photo-styles";
import { safeShapes } from "../../lib/print-template";
import { shapeBounds } from "../../lib/geometry";
import * as h from "../handlers";
import type { CtSession } from "../supabase";
import { productFolder } from "../artworks";
import { insertClipart } from "../library";
import { getTemplate } from "../print-templates";
import { makeTemplateProduct, productPrintOf } from "../print-products";
import { guessedBox, sceneForBlank } from "../product-mockups";
import { latestBackdrops } from "./backdrops";
import { AI_BLANK_ROLE, projectBlank } from "./blank";
import { SAMPLE_ROLE, elementPictures, latestElementImages } from "./elements";
import { fetchImage } from "./files";
import { textRegion } from "./product";
import { loadImages } from "./projects";

/** A photo zone the editor reshaped in the product: kept when the set's product is made again (by the zone's name). */
export interface KeptZone {
  shape: CtShape;
  frame: CtPhotoFrame;
}

/** Frame of a product without a khuôn in (px). */
const FRAME = 2000;

async function body<T>(res: Response): Promise<T> {
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

/** The drawn part of a transparent picture (a little margin kept), so its box holds the element itself. */
async function trimmed(png: Buffer): Promise<Buffer> {
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
  if (x1 < 0) return png;
  const m = 2;
  const left = Math.max(0, x0 - m);
  const top = Math.max(0, y0 - m);
  return sharp(png).extract({ left, top, width: Math.min(info.width, x1 + m + 1) - left, height: Math.min(info.height, y1 + m + 1) - top }).png().toBuffer();
}

/** Every picture the product needs is drawn (the editor sees what is missing). */
export function photoSetMissing(p: CtCharProject, images: CtCharImage[]): string[] {
  const done = latestElementImages(images);
  const out = elementPictures(p)
    .filter((x) => !done.has(x.role))
    .map((x) => `${x.element.name} — ${x.name}`);
  if (p.brief.backdrops.length && !latestBackdrops(p, images).length) out.push("nền");
  return out;
}

export async function buildPhotoProduct(s: CtSession, p: CtCharProject, name: string, kept: Map<string, KeptZone> = new Map()): Promise<string> {
  const brief = p.brief;
  const images = await loadImages(s.supabase, p.id);
  const missing = photoSetMissing(p, images);
  if (missing.length) throw new Error(`Chưa vẽ xong: ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? "…" : ""}`);
  const done = latestElementImages(images);

  const template = brief.product.templateId ? await getTemplate(s, brief.product.templateId) : null;
  const product = template ? await makeTemplateProduct(s.supabase, s.user.id, template, name) : (await body<{ product: CtProduct }>(await h.createProduct(s, { name }))).product;
  const folder = await productFolder(s.supabase, s.user.id, { id: product.id, name });
  const clipart = (data: Buffer, assetName: string, parentId: string | null, meta: CtAsset["meta"]): Promise<CtAsset> =>
    insertClipart(s.supabase, s.user.id, { categoryId: folder.id, parentId, rendition: false, name: assetName, spec: "", tags: [], source: "ai", meta, generationId: null, data });
  const upload = async (data: Buffer, role: string, assetName: string): Promise<CtAsset> => {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(data)], { type: "image/png" }), `${assetName || role}.png`);
    form.set("role", role);
    form.set("name", assetName);
    return (await body<{ asset: CtAsset }>(await h.uploadAsset(s, product.id, form))).asset;
  };

  // The sheet: the khuôn's, else a square frame.
  let main: CtAsset;
  let W = FRAME;
  let H = FRAME;
  let keep: CtRegion[] = [];
  if (template) {
    const { data: sheet } = await s.supabase.from(CT_TABLES.assets).select("*").eq("id", product.main_asset_id ?? "").single<CtAsset>();
    if (!sheet) throw new Error("Không thấy tờ in của khuôn");
    main = sheet;
    W = template.spec.width;
    H = template.spec.height;
    const { data: frames } = await s.supabase.from(CT_TABLES.regions).select("*").eq("product_id", product.id).returns<CtRegion[]>();
    keep = frames ?? [];
  } else {
    main = await upload(await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer(), "main", `Khung in ${W}×${H}`);
  }
  const pieceShape: CtShape = template?.spec.outline ?? { type: "rect", x: 0, y: 0, w: W, h: H, radius: 0 };
  const safe = template ? safeShapes(template.spec)[0] : undefined;
  const area = safe ? shapeBounds(safe) : { x: 0, y: 0, w: W, h: H };
  const zone = brief.photoZones[0];
  // A zone the editor reshaped in the product: the layout starts from it (the decorations follow it).
  const keptZone = zone ? kept.get(`Ảnh khách — ${zone.label}`) : undefined;
  const kb = keptZone ? shapeBounds(keptZone.shape) : null;
  const layout = photoLayout({
    area,
    piece: shapeBounds(pieceShape),
    round: safe?.type === "ellipse",
    holes: template ? template.spec.cuts.map(shapeBounds) : [],
    texts: brief.texts,
    zone: kb ? { x: (kb.x - area.x) / area.w, y: (kb.y - area.y) / area.h, w: kb.w / area.w, h: kb.h / area.h } : (zone?.box ?? null),
    elements: brief.elements,
  });

  const regions: CtRegion[] = [];
  const items: CtRegionItem[] = [];
  const addItem = (r: CtRegion, sub: CtAsset, index: number) =>
    items.push({ id: crypto.randomUUID(), region_id: r.id, asset_id: sub.id, transform: { offsetX: 0, offsetY: 0, scale: 1, rotation: 0 }, is_default: index === 0, sort_order: index });
  const imageRegion = (label: string, customerLabel: string, shape: CtShape, extra: Partial<CtRegion["config"]> = {}, image: Partial<CtRegion["config"]["image"]> = {}): CtRegion => {
    const cfg = defaultRegionConfig("image");
    const r: CtRegion = { id: crypto.randomUUID(), product_id: product.id, name: label, kind: "image", shape, config: { ...cfg, clip: false, mainId: main.id, ...extra, image: { ...cfg.image, label: customerLabel, ...image } }, sort_order: 0 };
    regions.push(r);
    return r;
  };
  const rect = (b: { x: number; y: number; w: number; h: number }): CtShape => ({ type: "rect", x: b.x, y: b.y, w: b.w, h: b.h, radius: 0 });

  // 0) the background the customer picks, over the whole piece.
  const backdrops = latestBackdrops(p, images);
  let background: CtRegion | null = null;
  if (backdrops.length) {
    background = imageRegion("Nền", "Background", pieceShape, { fill: { mode: "cover", tile: 256 } }, { display: "image" });
    let i = 0;
    for (const { backdrop, image } of backdrops) addItem(background, await clipart(await fetchImage(image.url), `Background · ${backdrop.name}`, null, {}), i++);
  }

  /** An element as a layer: its options one group (the first the gốc, the others its đa sắc); a perBackdrop one =
   * a group per background, following the background layer. */
  const elementRegion = async (e: CtCharElement) => {
    const box = layout.elements[e.id];
    const pics = elementPictures(p).filter((x) => x.element.id === e.id);
    const files = await Promise.all(pics.map(async (x) => ({ pic: x, png: await trimmed(await fetchImage(done.get(x.role)!.url)) })));
    // A band fills its box (cover: its sides may be cropped, never its soft top) from the photo's lower part to the
    // piece's bottom edge.
    const shape = rect(box);
    const swatches = e.mode === "color";
    const r = imageRegion(
      `Phần tử — ${e.name}`,
      e.name,
      shape,
      e.place === "bottom" ? { fill: { mode: "cover", tile: 256 } } : {},
      { display: swatches ? "swatch" : "image" },
    );
    if (e.perBackdrop && background) {
      // One group per background, in the background's order.
      let i = 0;
      for (const { backdrop } of backdrops) {
        const f = files.find((x) => x.pic.backdrop?.id === backdrop.id);
        if (f) addItem(r, await clipart(f.png, `${e.name} · ${backdrop.name}`, null, {}), i++);
      }
      r.config.image.follows = background.id;
      return;
    }
    let sub: CtAsset | null = null;
    for (const f of files) {
      const hex = e.options.find((o) => o.name === f.pic.name)?.value;
      const a = await clipart(f.png, `${e.name} · ${f.pic.name}`, sub?.id ?? null, swatches && hex && /^#[0-9a-f]{6}$/i.test(hex) ? { swatch: hex } : {});
      sub ??= a;
    }
    if (sub) addItem(r, sub, 0);
  };

  for (const e of brief.elements.filter((x) => x.place === "behind")) await elementRegion(e);

  // The customer's photo.
  for (const z of brief.photoZones) {
    const cfg = defaultRegionConfig("photo");
    const k = kept.get(`Ảnh khách — ${z.label}`);
    const sample = done.get(`${SAMPLE_ROLE}${z.id}`);
    const treat = z.treat ?? "photo";
    const styles: CtPhotoStyleRef[] = treat === "ai" ? ((z.styles ?? []) as CtPhotoStyleRef[]) : treat === "face" ? CT_FACE_STYLES.map((x) => x.id) : ["original"];
    regions.push({
      id: crypto.randomUUID(),
      product_id: product.id,
      name: `Ảnh khách — ${z.label}`,
      kind: "photo",
      shape: k?.shape ?? rect(layout.photo),
      config: {
        ...cfg,
        clip: false,
        mainId: main.id,
        photo: {
          ...cfg.photo,
          label: z.label,
          fit: "contain",
          required: true,
          mode: treat === "photo" ? "free" : treat,
          styles: styles.length ? styles : ["original"],
          defaultStyle: styles[0] ?? "original",
          styleLabel: treat === "face" ? "Filter" : "Choose Style",
          cutout: true,
          fadeCrop: true,
          frame: k?.frame ?? { ...cfg.photo.frame, enabled: false },
          ...(sample ? { sampleUrl: sample.url } : {}),
        },
      },
      sort_order: 0,
    });
  }

  for (const e of brief.elements.filter((x) => x.place === "above" || x.place === "free")) await elementRegion(e);
  for (const e of brief.elements.filter((x) => x.place === "bottom")) await elementRegion(e);
  for (const t of brief.texts) {
    const at = layout.texts.find((x) => x.id === t.id);
    if (at) regions.push(textRegion(product.id, main.id, t, at, false, 0));
  }

  const config = { ...defaultProductConfig(), print: template ? productPrintOf(template) : null };
  const material = brief.product.material && isMaterialId(brief.product.material) ? brief.product.material : null;
  config.material = { ...(material ? applyMaterialPreset(config.material, material) : config.material), widthMm: template?.spec.widthMm || brief.product.widthMm || 76 };
  // The phôi: the khuôn's own, else the set's (uploaded / AI).
  const blank: CtCharImage | null = projectBlank(p, images);
  const keptBlank = template?.spec.blanks[0];
  if (blank?.role !== "blank" && keptBlank) config.scene = { url: keptBlank.url, width: keptBlank.width, height: keptBlank.height, box: keptBlank.box };
  else if (blank?.width && blank.height) {
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
