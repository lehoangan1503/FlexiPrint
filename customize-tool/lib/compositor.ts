/**
 * Browser compositor — flattens main asset + regions + a selection into one
 * canvas. Used for the live preview, composite export (AI mockup input) and,
 * later, the storefront. Everything is drawn in main-asset pixel space and
 * scaled once at the end, so preview and full-res export are the same picture.
 */

import type { CtFillConfig, CtMainFrame, CtMainLayout, CtPrintSilhouette, CtRegion, CtRegionItem, CtRenderAsset, CtRenditionPad, CtPrintAssembly, CtSelection, CtSewnPiece, CtShape, CtTextConfig, CtTransform } from "../types";
import { itemPlacement, photoFrameBox, resolvePhotoFrame, shapeBounds, textBand } from "./geometry";

export { textBand };
import { activeRegions, isStaticLayer, normalizeRegion, regionChoices, regionForSelection, resolveLinked, selectedMainId, textColorFromOption, selectedMainImageId, textMode, zoneText } from "./design";
import { mainFrameFor, resolveLayout } from "./layout";
import { frameRegionFor, frameSvgPath, renditionFrameBox, traceFrame } from "./material-frame";
import { scaleShape } from "./print-template";
import { overflowFolds } from "./assembly";

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
   * Only one part of the design (2026-11-08, a version's AI phôi — CtVersionPhoi): "static" = what the customer cannot
   * change (the version's picture + layers with one fixed picture), drawn into the AI photo; "dynamic" = what they pick
   * or type (options, texts, photos), laid on that photo live. Absent = everything.
   */
  part?: "static" | "dynamic";
  /**
   * One size of a khuôn in (lib/print-template printSize): the canvas is that size's sheet, fill layers fill their
   * zone of that size (patterns keep their px size), everything else is stretched with the sheet.
   */
  size?: { width: number; height: number; zones: Record<string, CtShape> } | null;
  /**
   * The product sewn from its print sheet (lib/assembly, a hooded blanket — the preview only): each piece of the sheet
   * is drawn where it shows on the product (the hood pieces above the blanket's top edge), nothing else. The print
   * file never takes it: it is the sheet as designed.
   */
  assembled?: CtSewnPiece[] | null;
  /**
   * The base's sewn pieces on this canvas (CtProductConfig.assembly): what reaches above the sheet's top cut line is
   * drawn again lower on it (lib/assembly overflowFolds) — in the editor, the print file and the preview alike.
   */
  assembly?: CtPrintAssembly | null;
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
  if (input.assembled?.length && !input.size) {
    // The product sewn from its sheet (preview only): the pieces where they show, the khuôn's own cut is the pieces'.
    canvas.width = Math.max(1, Math.round(main.width * scale));
    canvas.height = Math.max(1, Math.round(main.height * scale));
    await drawAssembled(ctx, input, input.assembled);
    return canvas;
  }
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
    // The khuôn's mask fills its layer's box (the whole canvas for a khuôn made with the artwork, its place on the
    // canvas for a base's khuôn — lib/base-fit).
    const mb = cut.shape.type === "rect" ? cut.shape : { x: 0, y: 0, w: main.width, h: main.height };
    if (mask) ctx.drawImage(mask, mb.x, mb.y, mb.w, mb.h);
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

/**
 * The product as it is sewn (input.assembled): each piece of the sheet (`to`, clipped to its outline) drawn where it
 * shows on the product (`from`) — the layers themselves at that scale, not pixels.
 */
async function drawAssembled(ctx: CanvasRenderingContext2D, input: CompositeInput, pieces: CtSewnPiece[]): Promise<void> {
  const { scale } = input;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  for (const piece of pieces) {
    // A piece the photo does not show (a pocket): printed, not drawn here.
    if (piece.role === "other") continue;
    // Sheet → product: its sheet box drawn into its product box, whole — the corners a rounded piece leaves (a hood
    // piece's crown seam) show the sheet's background there, not a notch in the photo.
    const p = { shape: { type: "rect" as const, ...piece.from, radius: 0 }, from: piece.to, to: piece.from };
    const k = p.to.w / p.from.w;
    if (!(k > 0) || !Number.isFinite(k)) continue;
    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    clipShape(ctx, p.shape);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (input.background) {
      ctx.fillStyle = input.background;
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    }
    // drawComposite maps a design point q to (q + offset) × its scale: from.x → to.x.
    await drawComposite(ctx, { ...input, scale: scale * k, background: undefined }, { x: p.to.x / k - p.from.x, y: p.to.y / k - p.from.y });
    ctx.restore();
  }
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
    .map((r) => textColorFromOption(regionForSelection(normalizeRegion(r), selection[r.id]), selection))
    // Print only / preview only (Teeinblue's two groups): a picture of the product leaves out what only the factory
    // gets, the print file what only the customer sees.
    .filter((r) => (input.display ? !r.config.printOnly : !r.config.previewOnly))
    .filter((r) => !input.part || (input.part === "static") === isStaticLayer(r, resolved.items, input.assets))
    .sort((a, b) => a.sort_order - b.sort_order);
  return { selection, mainId, items: resolved.items, regions };
}

// isStaticLayer lives in lib/design (the server's phôi reference uses it too).
export { isStaticLayer };

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
      .map(async (r) => {
        if (r.config.text.fontUrl) await addFontFile(r.config.text.fontFamily, r.config.text.fontUrl);
        await document.fonts.load(`${r.config.text.fontWeight} 32px "${r.config.text.fontFamily}"`).catch(() => []);
      }),
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
  if (input.part !== "dynamic") {
    ctx.save();
    ctx.scale(kx, ky);
    ctx.translate(f.x + f.w / 2, f.y + f.h / 2);
    if (f.rotation) ctx.rotate((f.rotation * Math.PI) / 180);
    ctx.drawImage(mainImg, -f.w / 2 - px, -f.h / 2 - py, f.w + 2 * px, f.h + 2 * py);
    ctx.restore();
  }
  for (const r of above) await draw(r);

  // A sheet of sewn pieces: what reaches above its top cut line is printed again lower on the sheet, by the base's rule
  // (lib/assembly overflowFolds): "wrap" = from the bottom cut line up, same x, on whatever piece lies there; "hood" =
  // onto the 2 hood pieces. Backgrounds (fills) are not folded: the pieces keep the background they lie on.
  const folds = !size && input.assembly ? overflowFolds(input.assembly) : [];
  for (const fold of folds) {
    ctx.save();
    clipShape(ctx, fold.shape);
    ctx.translate(fold.dx, fold.dy);
    // Only what is above the top edge (it lands inside the piece; the rest would fall under it, outside the clip).
    ctx.beginPath();
    ctx.rect(fold.src.x, fold.src.y, fold.src.w, fold.src.h);
    ctx.clip();
    const folded = (r: CtRegion) => !r.config.fill && !r.config.materialFrame && !r.config.noHood;
    for (const r of below.filter(folded)) await draw(r);
    if (input.part !== "dynamic") {
      ctx.save();
      ctx.translate(f.x + f.w / 2, f.y + f.h / 2);
      if (f.rotation) ctx.rotate((f.rotation * Math.PI) / 180);
      ctx.drawImage(mainImg, -f.w / 2 - px, -f.h / 2 - py, f.w + 2 * px, f.h + 2 * py);
      ctx.restore();
    }
    for (const r of above.filter(folded)) await draw(r);
    ctx.restore();
  }

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

/**
 * Silhouette of a print sheet (asked 2026-11-05, like Teeinblue's acrylic files): every pixel the print covers —
 * grown by `offset` px and with its inner holes filled, so it is the piece's outer shape — painted solid black on a
 * transparent sheet of the same size. The factory reads it as the white-ink / cut layer.
 */
export function silhouetteOf(sheet: HTMLCanvasElement, offset = 0): HTMLCanvasElement {
  const w = sheet.width;
  const h = sheet.height;
  const src = sheet.getContext("2d")?.getImageData(0, 0, w, h);
  if (!src) throw new Error("Canvas 2D không khả dụng");
  // 1) Binary mask of what is printed (alpha ≥ 16), as a black-on-transparent canvas.
  const bin = document.createElement("canvas");
  bin.width = w;
  bin.height = h;
  const bctx = bin.getContext("2d");
  if (!bctx) throw new Error("Canvas 2D không khả dụng");
  const bd = bctx.createImageData(w, h);
  for (let i = 3; i < src.data.length; i += 4) if (src.data[i] >= 16) bd.data[i] = 255;
  bctx.putImageData(bd, 0, 0);
  // 2) Grow it: the mask stamped on rings around itself (a disc dilation, fine for a few dozen px).
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d");
  if (!octx) throw new Error("Canvas 2D không khả dụng");
  octx.drawImage(bin, 0, 0);
  const r = Math.max(0, Math.round(offset));
  for (let ring = r; ring > 0; ring -= Math.max(1, Math.ceil(r / 3))) {
    const steps = Math.max(16, Math.ceil(2 * Math.PI * ring));
    for (let k = 0; k < steps; k++) {
      const a = (2 * Math.PI * k) / steps;
      octx.drawImage(bin, Math.round(ring * Math.cos(a)), Math.round(ring * Math.sin(a)));
    }
  }
  // 3) Fill the holes: what the outside cannot reach from the sheet's border is inside the piece.
  const od = octx.getImageData(0, 0, w, h);
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const seed = (i: number) => {
    if (!outside[i] && od.data[i * 4 + 3] < 128) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop() as number;
    const x = i % w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (i >= w) seed(i - w);
    if (i < w * (h - 1)) seed(i + w);
  }
  for (let i = 0; i < w * h; i++) {
    const on = outside[i] ? 0 : 255;
    od.data[i * 4] = 0;
    od.data[i * 4 + 1] = 0;
    od.data[i * 4 + 2] = 0;
    od.data[i * 4 + 3] = on;
  }
  octx.putImageData(od, 0, 0);
  return out;
}

/** Where the silhouette's shape comes from when the product has a khuôn (CtRegion material frame): its cut line. */
export interface SilhouetteCut {
  /** The khuôn's outline + holes as an SVG path in the sheet's px (lib/material-frame.ts frameSvgPath). */
  path?: string;
  /** A khuôn cut by an AI mask: the mask picture (alpha = the piece), stretched to the sheet. */
  maskUrl?: string;
  /** The khuôn has its own holes (a hanging hole drawn in it): no tab is added. */
  hasHoles?: boolean;
}

/** A solid black shape of the khuôn on a transparent sheet of `w` × `h`. */
async function silhouetteOfCut(w: number, h: number, cut: SilhouetteCut): Promise<HTMLCanvasElement | null> {
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D không khả dụng");
  if (cut.path) {
    ctx.fillStyle = "#000";
    ctx.fill(new Path2D(cut.path), "evenodd");
    return out;
  }
  if (cut.maskUrl) {
    const img = await loadImage(cut.maskUrl);
    ctx.drawImage(img, 0, 0, w, h);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    return out;
  }
  return null;
}

/**
 * A hanging tab with its hole (asked 2026-11-06, like Teeinblue's ornament silhouettes): a black ring centred over the
 * shape's top edge, its hole cut through. `size` = the ring's outer diameter as a % of the shape's width.
 */
export function addHangingHole(sil: HTMLCanvasElement, size = 9): void {
  const w = sil.width;
  const h = sil.height;
  const ctx = sil.getContext("2d");
  if (!ctx) return;
  const a = ctx.getImageData(0, 0, w, h).data;
  // The shape's box (alpha ≥ 128).
  let x0 = w;
  let x1 = -1;
  let y0 = h;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (a[(y * w + x) * 4 + 3] >= 128) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
      }
  if (x1 < 0) return;
  const cx = Math.round((x0 + x1) / 2);
  // The top of the shape right under the ring's centre (a dome is lower there than the box's top only at its sides).
  let top = y0;
  for (let y = y0; y < h; y++)
    if (a[(y * w + cx) * 4 + 3] >= 128) {
      top = y;
      break;
    }
  // Sized on the piece, not the sheet (a small figure on a wide sheet keeps a small tab) — Teeinblue's are ~8–10 %.
  const R = Math.max(6, ((x1 - x0 + 1) * Math.max(2, Math.min(25, size))) / 200);
  const cy = Math.max(R, top - R * 0.45);
  ctx.save();
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fill();
  // A neck so the ring is one piece with the shape below it.
  ctx.fillRect(cx - R * 0.6, cy, R * 1.2, Math.max(0, top - cy) + R * 0.5);
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.42, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** The print sheet with its silhouette above it (Merchize / Teeinblue acrylic layout): one file twice as tall. */
export function silhouetteStack(sheet: HTMLCanvasElement, sil: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = sheet.width;
  out.height = sheet.height * 2;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D không khả dụng");
  ctx.drawImage(sil, 0, 0);
  ctx.drawImage(sheet, 0, sheet.height);
  return out;
}

/**
 * Apply the product's silhouette setting (CtProductConfig.printSilhouette) to a finished print sheet: the khuôn's own
 * shape when the product has one (`cut`), else the print's outer shape grown by `offset`; + the hanging hole.
 */
export async function withSilhouette(sheet: HTMLCanvasElement, cfg: CtPrintSilhouette | null | undefined, cut?: SilhouetteCut | null): Promise<HTMLCanvasElement> {
  if (!cfg?.enabled) return sheet;
  const sil = (cut ? await silhouetteOfCut(sheet.width, sheet.height, cut) : null) ?? silhouetteOf(sheet, cfg.offset);
  if (cfg.hole && !cut?.hasHoles) addHangingHole(sil, cfg.holeSize);
  return silhouetteStack(sheet, sil);
}

/** The silhouette's khuôn for a print sheet cut to its frame (none for a mirrored sheet: it follows the print). */
export function silhouetteCutOf(frame: CtRegion | null, mirrored: boolean): SilhouetteCut | null {
  if (!frame || mirrored) return null;
  if (frame.config.maskUrl) return { maskUrl: frame.config.maskUrl };
  const path = frameSvgPath(frame);
  return path ? { path, hasHoles: (frame.config.cuts ?? []).length > 0 } : null;
}

const fontFiles = new Map<string, Promise<void>>();

/** A font that is not a Google font (an imported set's own TTF, CtTextConfig.fontUrl): added to the page once under
 * its family name, so drawing and measuring use it like any other font. */
export function addFontFile(family: string, url: string): Promise<void> {
  const key = `${family}|${url}`;
  let hit = fontFiles.get(key);
  if (!hit) {
    hit = new FontFace(family, `url(${JSON.stringify(url)})`)
      .load()
      .then((face) => {
        document.fonts.add(face);
      })
      .catch(() => {
        fontFiles.delete(key);
      });
    fontFiles.set(key, hit);
  }
  return hit;
}

/** What the khuôn of a print sheet is, for the factory pair (khuonPair). */
export interface KhuonPairInput {
  /** The khuôn's cut line / mask (silhouetteCutOf). */
  cut: SilhouetteCut | null;
  /** No khuôn: the piece is cut along the print's own outline (acrylic alpha), grown by `offset` px. */
  alpha: boolean;
  offset: number;
  /** An alpha piece's hanging tab (CtPrintSilhouette.hole / holeSize). */
  hole: boolean;
  holeSize: number;
  /** The khuôn's own lines, drawn on `onKhuon` in place of the plain cut line (null: no khuôn / not on this sheet). */
  lines?: KhuonLines | null;
}

/**
 * The khuôn as the factory drew it (asked 2026-11-10: "lấy chính khuôn in có nét liền, nét đứt"): solid line = the
 * cut (everything printed lies inside it), dashed line = the safe zone for custom options and customers' photos.
 */
export interface KhuonLines {
  /** A khuôn given as a picture: its guide (its own solid + dashed lines) and its box on the sheet. */
  picture?: { url: string; x: number; y: number; w: number; h: number } | null;
  /** A khuôn drawn by shapes, as SVG paths in the sheet's px: cut line, safe zones, holes. */
  cut?: string;
  safe?: string[];
  holes?: string[];
}

/** Solid cut line, dashed safe zone, dashed holes — the khuôn's colours (components/print/print-sheet.tsx). */
async function drawKhuonLines(ctx: CanvasRenderingContext2D, w: number, h: number, lines: KhuonLines): Promise<void> {
  if (lines.picture) {
    const img = await loadImage(lines.picture.url);
    ctx.drawImage(img, lines.picture.x, lines.picture.y, lines.picture.w, lines.picture.h);
    return;
  }
  const stroke = Math.max(2, Math.min(w, h) / 250);
  ctx.save();
  ctx.lineWidth = stroke;
  ctx.setLineDash([]);
  ctx.strokeStyle = "#15803d";
  if (lines.cut) ctx.stroke(new Path2D(lines.cut));
  ctx.setLineDash([stroke * 6, stroke * 4]);
  ctx.strokeStyle = "#16a34a";
  for (const d of lines.safe ?? []) ctx.stroke(new Path2D(d));
  ctx.setLineDash([stroke * 3, stroke * 3]);
  ctx.strokeStyle = "#dc2626";
  for (const d of lines.holes ?? []) ctx.stroke(new Path2D(d));
  ctx.restore();
}

/** Colour of the khuôn's line in the factory files: magenta, the usual cut-contour colour. */
const KHUON_LINE = "#ff00ff";

/** The edge of a shape (alpha ≥ 128) `px` wide, painted `color`: the shape minus itself shrunk. */
function shapeEdge(shape: HTMLCanvasElement, px: number, color: string): HTMLCanvasElement {
  const w = shape.width;
  const h = shape.height;
  const inner = document.createElement("canvas");
  inner.width = w;
  inner.height = h;
  const ictx = inner.getContext("2d");
  if (!ictx) throw new Error("Canvas 2D không khả dụng");
  ictx.drawImage(shape, 0, 0);
  // Erosion: keep only what is still shape when shifted every way by px.
  ictx.globalCompositeOperation = "destination-in";
  const steps = 12;
  for (let k = 0; k < steps; k++) {
    const a = (2 * Math.PI * k) / steps;
    ictx.drawImage(shape, Math.round(px * Math.cos(a)), Math.round(px * Math.sin(a)));
  }
  const edge = document.createElement("canvas");
  edge.width = w;
  edge.height = h;
  const ectx = edge.getContext("2d");
  if (!ectx) throw new Error("Canvas 2D không khả dụng");
  ectx.drawImage(shape, 0, 0);
  ectx.globalCompositeOperation = "destination-out";
  ectx.drawImage(inner, 0, 0);
  ectx.globalCompositeOperation = "source-in";
  ectx.fillStyle = color;
  ectx.fillRect(0, 0, w, h);
  return edge;
}

/**
 * The two files the factory lays on each other (asked 2026-11-07: "preview nằm trong khuôn in và khuôn in (rỗng) để
 * ghép đôi"), both exactly the print sheet's px:
 *   blank    the empty khuôn as Teeinblue's "Print silhouette": the piece's shape in SOLID BLACK, transparent outside
 *            (asked 2026-11-07 — no white fill, no line);
 *   onKhuon  the khuôn (white) with the print on it and the khuôn's own lines on top (solid cut, dashed safe zone —
 *            KhuonLines), else a plain cut line — laid on `blank`, it is the piece.
 * The shape is the khuôn's own (cut line / mask), else the print's outline (an acrylic cut along the art), else the
 * whole sheet.
 */
export async function khuonPair(sheet: HTMLCanvasElement, input: KhuonPairInput): Promise<{ blank: HTMLCanvasElement; onKhuon: HTMLCanvasElement }> {
  const w = sheet.width;
  const h = sheet.height;
  let shape = input.cut ? await silhouetteOfCut(w, h, input.cut) : null;
  if (!shape && input.alpha) {
    shape = silhouetteOf(sheet, input.offset);
    if (input.hole) addHangingHole(shape, input.holeSize);
  }
  if (!shape) {
    shape = document.createElement("canvas");
    shape.width = w;
    shape.height = h;
    const sctx = shape.getContext("2d");
    if (!sctx) throw new Error("Canvas 2D không khả dụng");
    sctx.fillStyle = "#000";
    sctx.fillRect(0, 0, w, h);
  }
  const line = Math.max(2, Math.round(Math.max(w, h) / 400));
  const edge = input.lines ? null : shapeEdge(shape, line, KHUON_LINE);
  const blank = document.createElement("canvas");
  blank.width = w;
  blank.height = h;
  const bctx = blank.getContext("2d");
  if (!bctx) throw new Error("Canvas 2D không khả dụng");
  bctx.drawImage(shape, 0, 0);
  bctx.globalCompositeOperation = "source-in";
  bctx.fillStyle = "#000";
  bctx.fillRect(0, 0, w, h);
  const onKhuon = document.createElement("canvas");
  onKhuon.width = w;
  onKhuon.height = h;
  const octx = onKhuon.getContext("2d");
  if (!octx) throw new Error("Canvas 2D không khả dụng");
  octx.drawImage(shape, 0, 0);
  octx.globalCompositeOperation = "source-in";
  octx.fillStyle = "#fff";
  octx.fillRect(0, 0, w, h);
  octx.globalCompositeOperation = "source-over";
  octx.drawImage(sheet, 0, 0);
  if (input.lines) await drawKhuonLines(octx, w, h, input.lines);
  else if (edge) octx.drawImage(edge, 0, 0);
  return { blank, onKhuon };
}
