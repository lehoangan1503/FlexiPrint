/**
 * Browser compositor — flattens main asset + regions + a selection into one
 * canvas. Used for the live preview, composite export (AI mockup input) and,
 * later, the storefront. Everything is drawn in main-asset pixel space and
 * scaled once at the end, so preview and full-res export are the same picture.
 */

import type { CtFillConfig, CtMainFrame, CtMainLayout, CtRegion, CtRegionItem, CtRenderAsset, CtRenditionPad, CtSelection, CtShape, CtTextConfig, CtTransform } from "../types";
import { itemPlacement, photoFrameBox, resolvePhotoFrame, shapeBounds, textBand } from "./geometry";

export { textBand };
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
   * The print file of a product with a khuôn vật liệu (lib/material-frame): the canvas is the whole artboard and
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
    // The print file is the whole edit frame (asked 2026-10-10): the khuôn sits inside it, and only the piece —
    // minus the parts cut out of it — is printed.
    canvas.width = Math.max(1, Math.round(main.width * scale));
    canvas.height = Math.max(1, Math.round(main.height * scale));
    await drawComposite(ctx, input);
    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.globalCompositeOperation = "destination-in";
    const mask = cut.config.maskUrl ? await loadImage(cut.config.maskUrl).catch(() => null) : null;
    if (mask) ctx.drawImage(mask, 0, 0, main.width, main.height);
    else {
      ctx.beginPath();
      traceFrame(ctx, cut);
      ctx.fill("evenodd");
    }
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

/** What drawComposite draws, bottom first: the selection with linked layers resolved, the version's layout, the shown layers. */
function drawPlan(input: CompositeInput): { selection: CtSelection; mainId: string; items: CtRegionItem[]; regions: CtRegion[] } {
  // Linked layers (the back half of a hairstyle) show what their leader shows — resolved here, so every renderer agrees.
  const selection = resolveLinked(input.regions, input.items, input.assets, input.selection);
  // A main version (selection[CT_MAIN_KEY]) is drawn into the default main's
  // box, so every zone keeps its place whichever version is showing — unless
  // that version carries its own layout, which moves / hides zones.
  const mainId = selectedMainId(selection, input.assets, input.main.id);
  const resolved = resolveLayout(input.regions, input.items, input.layouts, mainId);
  // A zone's chosen sub-option (its shape / lettering) is drawn in place of its own look.
  // Child zones only while their parent shows the option they belong to.
  const regions = activeRegions(resolved.regions.map(normalizeRegion), selection)
    .map((r) => regionForSelection(normalizeRegion(r), selection[r.id]))
    .filter((r) => !(input.display && r.config.printOnly))
    .sort((a, b) => a.sort_order - b.sort_order);
  return { selection, mainId, items: resolved.items, regions };
}

/** One layer's visible pixels (alpha, row by row) on a pick map; id null = the version's picture. */
export interface CtPickLayer {
  id: string | null;
  alpha: Uint8ClampedArray;
}

/** Every shown layer's pixels at a small scale, bottom first — what a click on the canvas lands on (pickAt). */
export interface CtPickMap {
  scale: number;
  w: number;
  h: number;
  layers: CtPickLayer[];
}

/**
 * Draws each layer alone, like drawComposite, and keeps its alpha. Text and customer-photo zones count as their whole
 * band / outline (letters are thin, an empty photo zone has no pixels), pictures as their own pixels — so a click
 * picks the picture under the pointer, not the biggest frame around it.
 */
export async function renderPickMap(input: CompositeInput, maxSide = 640): Promise<CtPickMap> {
  const { main } = input;
  const scale = Math.min(1, maxSide / Math.max(main.width, main.height, 1));
  const w = Math.max(1, Math.round(main.width * scale));
  const h = Math.max(1, Math.round(main.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { scale, w, h, layers: [] };
  const { selection, mainId, items, regions } = drawPlan(input);
  const byId = new Map(input.assets.map((a) => [a.id, a]));
  const grab = async (id: string | null, paint: () => Promise<void> | void): Promise<CtPickLayer> => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.save();
    await paint();
    ctx.restore();
    const data = ctx.getImageData(0, 0, w, h).data;
    const alpha = new Uint8ClampedArray(w * h);
    for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
    return { id, alpha };
  };
  const layer = (r: CtRegion) =>
    grab(r.id, async () => {
      if (r.kind === "text" || r.kind === "photo") {
        ctx.fillStyle = "#000";
        if (r.kind === "text") {
          const b = textBand(r.shape);
          ctx.translate(b.cx, b.cy);
          ctx.rotate((b.rotation * Math.PI) / 180);
          ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
        } else {
          clipShape(ctx, r.shape);
          ctx.fillRect(0, 0, main.width, main.height);
        }
        return;
      }
      await drawRegion(ctx, r, items, byId, selection).catch(() => undefined);
    });
  const layers: CtPickLayer[] = [];
  for (const r of regions.filter((x) => !x.config.aboveMain)) layers.push(await layer(r));
  const imageId = selectedMainImageId(selection, input.assets, main.id);
  const mainImg = await loadImage((byId.get(imageId) ?? byId.get(mainId) ?? main).url).catch(() => null);
  if (mainImg) {
    const { f } = mainPictureBox(input);
    layers.push(
      await grab(null, () => {
        ctx.translate(f.x + f.w / 2, f.y + f.h / 2);
        if (f.rotation) ctx.rotate((f.rotation * Math.PI) / 180);
        ctx.drawImage(mainImg, -f.w / 2, -f.h / 2, f.w, f.h);
      }),
    );
  }
  for (const r of regions.filter((x) => x.config.aboveMain)) layers.push(await layer(r));
  return { scale, w, h, layers };
}

/**
 * The topmost layer with a visible pixel within `radius` (main px) of `pt`: a region id, null for the version's
 * picture, undefined for nothing.
 */
export function pickAt(map: CtPickMap, pt: { x: number; y: number }, radius = 0): string | null | undefined {
  const cx = Math.floor(pt.x * map.scale);
  const cy = Math.floor(pt.y * map.scale);
  const r = Math.max(0, Math.round(radius * map.scale));
  for (let k = map.layers.length - 1; k >= 0; k--) {
    const a = map.layers[k].alpha;
    for (let y = Math.max(0, cy - r); y <= Math.min(map.h - 1, cy + r); y++)
      for (let x = Math.max(0, cx - r); x <= Math.min(map.w - 1, cx + r); x++) if (a[y * map.w + x] > 40) return map.layers[k].id;
  }
  return undefined;
}

/** `offset`: where the main's box starts on the canvas, main pixels (renderComposite's bleed). */
export async function drawComposite(ctx: CanvasRenderingContext2D, input: CompositeInput, offset = { x: 0, y: 0 }): Promise<void> {
  const { main, assets, scale, background } = input;
  const { selection, mainId, items, regions } = drawPlan(input);
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
  // Text is never clipped to its zone, like the print file (server/print-render): a name bent along a hat's brim
  // (arcTilt) reaches past its box, and the clip cut the first / last letters off (2026-10-22).
  if (region.kind !== "text" && (region.config.clip || region.config.fill)) clipToShape(ctx, region);

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
  } else if (region.kind === "photo" && sel.kind === "photo" && (sel.url || region.config.photo.sampleUrl)) {
    // No photo yet: the zone's sample (types CtPhotoConfig.sampleUrl).
    const img = await loadImage(sel.url ?? region.config.photo.sampleUrl!);
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
  // A fixed circle (arcRadius): the chord is shorter than the text, the width test on the text itself is enough.
  const arcFactor = cfg.curve === 0 || cfg.arcRadius ? 1 : 1 + Math.abs(cfg.curve) / 400;
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
  // spans up to 180° at |curve| = 100; the radius follows from the text length — or is arcRadius × the zone's width.
  const radius = cfg.arcRadius ? cfg.arcRadius * bounds.w : total / ((Math.abs(cfg.curve) / 100) * Math.PI);
  const sweep = total / radius;
  const up = cfg.curve > 0;
  const cx = bounds.x + bounds.w / 2;
  // The circle's centre: under (∩) or over (∪) the zone's centre, turned by the tilt.
  const tilt = ((cfg.arcTilt ?? 0) * Math.PI) / 180;
  const centerX = up ? cx - radius * Math.sin(tilt) : cx + radius * Math.sin(tilt);
  const centerY = up ? cy + radius * Math.cos(tilt) : cy - radius * Math.cos(tilt);
  ctx.textAlign = "center";

  let travelled = 0;
  for (const ch of text) {
    const w = ctx.measureText(ch).width;
    const mid = travelled + w / 2;
    const theta = (mid / total - 0.5) * sweep;
    ctx.save();
    if (up) {
      const a = theta + tilt;
      ctx.translate(centerX + radius * Math.sin(a), centerY - radius * Math.cos(a));
      ctx.rotate(a);
    } else {
      const a = theta - tilt;
      ctx.translate(centerX + radius * Math.sin(a), centerY + radius * Math.cos(a));
      ctx.rotate(-a);
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

/**
 * A khuôn in whose sheet is ONE half of a symmetric piece (spec.mirror — one trouser leg): the print file is the
 * half and its mirror image side by side (the half on the left).
 */
export function mirrorSheet(half: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = half.width * 2;
  out.height = half.height;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D không khả dụng");
  ctx.drawImage(half, 0, 0);
  ctx.save();
  ctx.translate(out.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(half, 0, 0);
  ctx.restore();
  return out;
}
