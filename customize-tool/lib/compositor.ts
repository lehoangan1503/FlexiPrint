/**
 * Browser compositor — flattens main asset + regions + a selection into one
 * canvas. Used for the live preview, composite export (AI mockup input) and,
 * later, the storefront. Everything is drawn in main-asset pixel space and
 * scaled once at the end, so preview and full-res export are the same picture.
 */

import type { CtFillConfig, CtMainFrame, CtMainLayout, CtRegion, CtRegionItem, CtRenderAsset, CtRenditionPad, CtSelection, CtShape, CtTextConfig, CtTransform } from "../types";
import { itemPlacement, orientedBox, photoFrameBox, resolvePhotoFrame, shapeBounds } from "./geometry";
import { activeRegions, normalizeRegion, regionForSelection, resolveLinked, selectedMainId, selectedMainImageId, textMode, zoneText } from "./design";
import { mainFrameFor, resolveLayout } from "./layout";
import { frameRegionFor, renditionFrameBox, traceFrame } from "./material-frame";
import { scaleShape } from "./print-template";

const imageCache = new Map<string, Promise<HTMLImageElement>>();

export function loadImage(url: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(url);
  if (cached) return cached;
  const p = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => {
      imageCache.delete(url);
      reject(new Error(`Không tải được ảnh: ${url}`));
    };
    img.src = url;
  });
  imageCache.set(url, p);
  return p;
}

export interface CompositeInput {
  /** Default main: its pixel size is the design's coordinate space. */
  main: CtRenderAsset;
  assets: CtRenderAsset[];
  regions: CtRegion[];
  items: CtRegionItem[];
  selection: CtSelection;
  /** Output scale relative to the main asset (1 = full resolution). */
  scale: number;
  /** Paint behind everything; omit for transparent. */
  background?: string;
  /** Per-main-version layouts (CtProductConfig.layouts): the selected version's overrides apply. */
  layouts?: Record<string, CtMainLayout>;
  /**
   * Grow the canvas by the shown main's rendition padding (its acrylic plate, a cord above it), so nothing
   * of the material version is cut off. Off (default): the canvas is the main's own box, as the print uses.
   */
  bleed?: boolean;
  /**
   * The print file of a product with a khuôn vật liệu (lib/material-frame): the canvas is the khuôn's box and
   * everything outside it (and its cut-out parts) is cleared. No khuôn: the main's own box, as without.
   */
  cutToFrame?: boolean;
  /** The product shown on its photo (preview / mockup): print-only layers (a background the photo shows) are left out. */
  display?: boolean;
  /**
   * One size of a khuôn in (lib/print-template printSize): the canvas is that size's sheet, fill layers fill their
   * zone of that size (patterns keep their px size), everything else is stretched with the sheet.
   */
  size?: { width: number; height: number; zones: Record<string, CtShape> } | null;
}

/**
 * Where the shown main picture is drawn: its version frame, or — a vật liệu made theo khuôn (meta.frame) — the
 * khuôn's box, upright. `pad`: the rendition's padding, a fraction of that box.
 */
function mainPictureBox(input: Pick<CompositeInput, "main" | "assets" | "selection" | "layouts" | "regions">): { f: CtMainFrame; pad?: CtRenditionPad } {
  const { main } = input;
  const mainId = selectedMainId(input.selection, input.assets, main.id);
  const imageId = selectedMainImageId(input.selection, input.assets, main.id);
  const shown = input.assets.find((a) => a.id === imageId) ?? input.assets.find((a) => a.id === mainId);
  const frame = shown?.meta?.frame;
  if (frame) return { f: { ...renditionFrameBox(input.regions, frame), rotation: 0 }, pad: shown?.meta?.pad };
  return { f: mainFrameFor(input.layouts, mainId, main.width, main.height), pad: shown?.meta?.pad };
}

/** Extra room around the main's box the shown main version's rendition needs, in main pixels. */
export function compositeBleed(input: Pick<CompositeInput, "main" | "assets" | "selection" | "layouts"> & Partial<Pick<CompositeInput, "regions">>): { x: number; y: number } {
  const { main } = input;
  const { f, pad } = mainPictureBox({ ...input, regions: input.regions ?? [] });
  const px = (pad?.x ?? 0) * f.w;
  const py = (pad?.y ?? 0) * f.h;
  // How far the picture (frame + its rendition's plate / cord) reaches past the artboard.
  const x = Math.max(0, px - f.x, f.x + f.w + px - main.width);
  const y = Math.max(0, py - f.y, f.y + f.h + py - main.height);
  return { x: Math.round(x), y: Math.round(y) };
}

export async function renderComposite(input: CompositeInput): Promise<HTMLCanvasElement> {
  const { main, scale } = input;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D không khả dụng");
  const cut = input.cutToFrame ? printFrame(input) : null;
  if (cut) {
    const box = shapeBounds(cut.shape);
    canvas.width = Math.max(1, Math.round(box.w * scale));
    canvas.height = Math.max(1, Math.round(box.h * scale));
    await drawComposite(ctx, input, { x: -box.x, y: -box.y });
    // Only the khuôn is printed: the piece, minus the parts cut out of it.
    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, -box.x * scale, -box.y * scale);
    ctx.globalCompositeOperation = "destination-in";
    ctx.beginPath();
    traceFrame(ctx, cut);
    ctx.fill("evenodd");
    ctx.restore();
    return canvas;
  }
  if (input.size) {
    canvas.width = Math.max(1, Math.round(input.size.width * scale));
    canvas.height = Math.max(1, Math.round(input.size.height * scale));
    await drawComposite(ctx, input);
    return canvas;
  }
  const b = input.bleed ? compositeBleed(input) : { x: 0, y: 0 };
  canvas.width = Math.max(1, Math.round((main.width + 2 * b.x) * scale));
  canvas.height = Math.max(1, Math.round((main.height + 2 * b.y) * scale));
  await drawComposite(ctx, input, b);
  return canvas;
}

/** The khuôn vật liệu the shown version is printed to (lib/material-frame), if the product has one. */
export function printFrame(input: Pick<CompositeInput, "main" | "assets" | "selection" | "regions">): CtRegion | null {
  const mainId = selectedMainId(input.selection, input.assets, input.main.id);
  return frameRegionFor(input.regions.map(normalizeRegion), mainId, input.main.id);
}

/** `offset`: where the main's box starts on the canvas, main pixels (renderComposite's bleed). */
export async function drawComposite(ctx: CanvasRenderingContext2D, input: CompositeInput, offset = { x: 0, y: 0 }): Promise<void> {
  const { main, assets, scale, background } = input;
  // Linked layers (the back half of a hairstyle) show what their leader shows — resolved here, so every renderer agrees.
  const selection = resolveLinked(input.regions, input.items, assets, input.selection);
  // A main version (selection[CT_MAIN_KEY]) is drawn into the default main's
  // box, so every zone keeps its place whichever version is showing — unless
  // that version carries its own layout, which moves / hides zones.
  const mainId = selectedMainId(selection, assets, main.id);
  const resolved = resolveLayout(input.regions, input.items, input.layouts, mainId);
  const items = resolved.items;
  // A zone's chosen sub-option (its shape / lettering) is drawn in place of its own look.
  // Child zones only while their parent shows the option they belong to.
  const regions = activeRegions(resolved.regions.map(normalizeRegion), selection)
    .map((r) => regionForSelection(normalizeRegion(r), selection[r.id]))
    .filter((r) => !(input.display && r.config.printOnly))
    .sort((a, b) => a.sort_order - b.sort_order);
  // A size of the khuôn in: fills take that size's zone, the rest is stretched with the sheet.
  const size = input.size ?? null;
  const kx = size ? size.width / main.width : 1;
  const ky = size ? size.height / main.height : 1;
  const draw = async (r: CtRegion) => {
    const zone = size && r.config.fill?.zone ? size.zones[r.config.fill.zone] : undefined;
    if (r.config.fill) return drawRegion(ctx, zone ? { ...r, shape: zone } : r.kind === "image" && size ? { ...r, shape: scaleShape(r.shape, kx, ky) } : r, items, byId, selection);
    ctx.save();
    ctx.scale(kx, ky);
    await drawRegion(ctx, r, items, byId, selection);
    ctx.restore();
  };
  const byId = new Map(assets.map((a) => [a.id, a]));

  // Fonts used by text regions must be loaded before measureText, or the
  // first render measures the fallback font and the text lands off-centre.
  await Promise.all(
    regions
      .filter((r) => r.kind === "text")
      .map((r) => document.fonts.load(`${r.config.text.fontWeight} 32px "${r.config.text.fontFamily}"`).catch(() => [])),
  );

  // A sub-option of the version ("Thêm option") swaps the picture only; layers and layout stay the version's.
  const imageId = selectedMainImageId(selection, assets, main.id);
  const mainImg = await loadImage((byId.get(imageId) ?? byId.get(mainId) ?? main).url);

  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, offset.x * scale, offset.y * scale);
  const sheetW = size ? size.width : main.width;
  const sheetH = size ? size.height : main.height;
  ctx.clearRect(-offset.x, -offset.y, sheetW + 2 * offset.x, sheetH + 2 * offset.y);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(-offset.x, -offset.y, sheetW + 2 * offset.x, sheetH + 2 * offset.y);
  }

  const below = regions.filter((r) => !r.config.aboveMain);
  const above = regions.filter((r) => r.config.aboveMain);

  for (const r of below) await draw(r);
  // The version's picture lands in its frame on the artboard (moved / resized / turned in the editor); a rendition
  // on a larger canvas brings its plate / cord around that box.
  const { f, pad: mainPad } = mainPictureBox(input);
  const px = (mainPad?.x ?? 0) * f.w;
  const py = (mainPad?.y ?? 0) * f.h;
  ctx.save();
  ctx.scale(kx, ky);
  ctx.translate(f.x + f.w / 2, f.y + f.h / 2);
  if (f.rotation) ctx.rotate((f.rotation * Math.PI) / 180);
  ctx.drawImage(mainImg, -f.w / 2 - px, -f.h / 2 - py, f.w + 2 * px, f.h + 2 * py);
  ctx.restore();
  for (const r of above) await draw(r);

  ctx.restore();
}

function clipToShape(ctx: CanvasRenderingContext2D, region: CtRegion): void {
  clipShape(ctx, region.shape);
}

function clipShape(ctx: CanvasRenderingContext2D, s: CtShape): void {
  ctx.beginPath();
  if (s.type === "rect") {
    if (s.radius > 0 && typeof ctx.roundRect === "function") ctx.roundRect(s.x, s.y, s.w, s.h, s.radius);
    else ctx.rect(s.x, s.y, s.w, s.h);
  } else if (s.type === "ellipse") {
    ctx.ellipse(s.cx, s.cy, Math.max(0, s.rx), Math.max(0, s.ry), 0, 0, Math.PI * 2);
  } else {
    s.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
  }
  ctx.clip();
}

/** Which region item a chosen asset (a sub, or one of its variants) belongs to. */
function itemFor(region: CtRegion, items: CtRegionItem[], asset: CtRenderAsset): CtRegionItem | undefined {
  const subId = asset.role === "variant" ? asset.parent_id : asset.id;
  return items.find((i) => i.region_id === region.id && i.asset_id === subId);
}

async function drawRegion(
  ctx: CanvasRenderingContext2D,
  region: CtRegion,
  items: CtRegionItem[],
  byId: Map<string, CtRenderAsset>,
  selection: CtSelection,
): Promise<void> {
  const fixedText = region.kind === "text" && textMode(region) === "fixed";
  const sel = selection[region.id] ?? (fixedText ? { kind: "text" as const, text: "" } : undefined);
  if (!sel) return;
  const bounds = shapeBounds(region.shape);

  ctx.save();
  if (region.config.clip || region.config.fill) clipToShape(ctx, region);

  if (region.kind === "image" && region.config.fill && sel.kind === "image" && sel.assetId) {
    const asset = byId.get(sel.assetId);
    if (asset) drawFill(ctx, await loadImage(asset.url), bounds, region.config.fill);
  } else if (region.kind === "image" && sel.kind === "image" && sel.assetId) {
    const asset = byId.get(sel.assetId);
    const item = asset ? itemFor(region, items, asset) : undefined;
    if (asset && item) {
      const img = await loadImage(asset.url);
      drawPlaced(ctx, img, bounds, item.transform, "contain", asset.meta?.pad);
    }
  } else if (region.kind === "photo" && sel.kind === "photo" && sel.url) {
    const img = await loadImage(sel.url);
    // The photo lives in the zone's child frame (moved / resized / tilted — or fitted to this photo), clipped to it and to the zone.
    const f = photoFrameBox(bounds, resolvePhotoFrame(region.config.photo, region.shape, { width: img.naturalWidth, height: img.naturalHeight }));
    ctx.translate(f.cx, f.cy);
    ctx.rotate((f.rotation * Math.PI) / 180);
    ctx.beginPath();
    ctx.rect(-f.w / 2, -f.h / 2, f.w, f.h);
    ctx.clip();
    // Fitted inside the frame's margin: the photo at its own aspect, sized by the frame — it is only ever scaled here, once.
    const m = f.margin;
    drawPlaced(ctx, img, { x: -f.w / 2 + m, y: -f.h / 2 + m, w: Math.max(1, f.w - 2 * m), h: Math.max(1, f.h - 2 * m) }, sel.transform, region.config.photo.fit);
  } else if (region.kind === "text" && sel.kind === "text") {
    // maxChars limits what the customer types; a text the designer set (fixed, list, option) is drawn whole.
    const cfg = textMode(region) === "input" ? region.config.text : { ...region.config.text, maxChars: Number.MAX_SAFE_INTEGER };
    // A polygon zone drawn along a slanted band (a tilted lid, a sign) writes along it: its outline's tilt.
    const band = textBand(region.shape);
    if (band.rotation) {
      ctx.translate(band.cx, band.cy);
      ctx.rotate((band.rotation * Math.PI) / 180);
      drawText(ctx, zoneText(region, sel), cfg, { x: -band.w / 2, y: -band.h / 2, w: band.w, h: band.h });
    } else {
      drawText(ctx, zoneText(region, sel), cfg, bounds);
    }
  }
  ctx.restore();
}

/**
 * The line a text zone writes along: its outline's oriented box, turned so the text runs along the long side and
 * reads left → right (never upside down). Rect / ellipse zones: upright.
 */
export function textBand(shape: CtShape): { cx: number; cy: number; w: number; h: number; rotation: number } {
  const b = orientedBox(shape);
  let { w, h, rotation } = b;
  if (h > w) {
    [w, h] = [h, w];
    rotation -= 90;
  }
  if (rotation <= -90) rotation += 180;
  if (rotation > 90) rotation -= 180;
  return { cx: b.cx, cy: b.cy, w, h, rotation: Math.abs(rotation) < 1 ? 0 : rotation };
}

/**
 * A fill layer's picture over its (already clipped) outline: repeated `tile` px wide from the outline's corner, or
 * one picture covering it.
 */
function drawFill(ctx: CanvasRenderingContext2D, img: HTMLImageElement, bounds: { x: number; y: number; w: number; h: number }, fill: CtFillConfig): void {
  const iw = img.naturalWidth || 1;
  const ih = img.naturalHeight || 1;
  if (fill.mode === "cover") {
    const k = Math.max(bounds.w / iw, bounds.h / ih);
    ctx.drawImage(img, bounds.x + (bounds.w - iw * k) / 2, bounds.y + (bounds.h - ih * k) / 2, iw * k, ih * k);
    return;
  }
  const tw = Math.max(4, fill.tile);
  const th = (tw * ih) / iw;
  for (let y = bounds.y; y < bounds.y + bounds.h; y += th) for (let x = bounds.x; x < bounds.x + bounds.w; x += tw) ctx.drawImage(img, x, y, tw, th);
}

/** `pad`: the image is a rendition on a larger canvas — placed by its art's box, the padding drawn around it. */
function drawPlaced(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  bounds: { x: number; y: number; w: number; h: number },
  t: CtTransform,
  fit: "contain" | "cover",
  pad?: CtRenditionPad,
): void {
  const kx = 1 + 2 * (pad?.x ?? 0);
  const ky = 1 + 2 * (pad?.y ?? 0);
  const p = itemPlacement(bounds, img.naturalWidth / kx, img.naturalHeight / ky, t, fit);
  ctx.save();
  ctx.translate(p.cx, p.cy);
  ctx.rotate((p.rotation * Math.PI) / 180);
  ctx.drawImage(img, (-p.w * kx) / 2, (-p.h * ky) / 2, p.w * kx, p.h * ky);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function measureSpaced(ctx: CanvasRenderingContext2D, text: string, spacing: number): number {
  let w = 0;
  for (const ch of text) w += ctx.measureText(ch).width + spacing;
  return Math.max(0, w - spacing);
}

export function drawText(
  ctx: CanvasRenderingContext2D,
  raw: string,
  cfg: CtTextConfig,
  bounds: { x: number; y: number; w: number; h: number },
): void {
  const text = (cfg.uppercase ? raw.toUpperCase() : raw).slice(0, Math.max(1, cfg.maxChars));
  if (!text.trim()) return;

  // Shrink-to-fit: never overflow the zone horizontally or vertically.
  let size = Math.min(cfg.fontSize, bounds.h);
  const setFont = () => {
    ctx.font = `${cfg.fontWeight} ${size}px "${cfg.fontFamily}"`;
  };
  setFont();
  const spacing = () => (cfg.letterSpacing * size) / 100;
  const arcFactor = cfg.curve === 0 ? 1 : 1 + Math.abs(cfg.curve) / 400;
  while (size > 6 && measureSpaced(ctx, text, spacing()) * arcFactor > bounds.w) {
    size -= 1;
    setFont();
  }

  ctx.fillStyle = cfg.color;
  ctx.strokeStyle = cfg.strokeColor;
  ctx.lineWidth = cfg.strokeWidth;
  ctx.lineJoin = "round";
  ctx.textBaseline = "middle";

  const paint = (ch: string, x: number, y: number) => {
    if (cfg.strokeWidth > 0) ctx.strokeText(ch, x, y);
    ctx.fillText(ch, x, y);
  };

  const total = measureSpaced(ctx, text, spacing());
  const cy = bounds.y + bounds.h / 2;

  if (cfg.curve === 0) {
    let x =
      cfg.align === "left" ? bounds.x : cfg.align === "right" ? bounds.x + bounds.w - total : bounds.x + (bounds.w - total) / 2;
    ctx.textAlign = "left";
    for (const ch of text) {
      paint(ch, x, cy);
      x += ctx.measureText(ch).width + spacing();
    }
    return;
  }

  // Arc: positive curve bows upward (∩), negative downward (∪). The arc
  // spans up to 180° at |curve| = 100; the radius follows from the text length.
  const sweep = (Math.abs(cfg.curve) / 100) * Math.PI;
  const radius = total / sweep;
  const up = cfg.curve > 0;
  const cx = bounds.x + bounds.w / 2;
  const centerY = up ? cy + radius : cy - radius;
  ctx.textAlign = "center";

  let travelled = 0;
  for (const ch of text) {
    const w = ctx.measureText(ch).width;
    const mid = travelled + w / 2;
    const theta = (mid / total - 0.5) * sweep;
    ctx.save();
    if (up) {
      ctx.translate(cx + radius * Math.sin(theta), centerY - radius * Math.cos(theta));
      ctx.rotate(theta);
    } else {
      ctx.translate(cx + radius * Math.sin(theta), centerY + radius * Math.cos(theta));
      ctx.rotate(-theta);
    }
    paint(ch, 0, 0);
    ctx.restore();
    travelled += w + spacing();
  }
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = "image/png", quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Không xuất được ảnh"))), type, quality);
  });
}
