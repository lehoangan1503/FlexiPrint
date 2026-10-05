/**
 * Tổ hợp (hand-made mockups) and the product scene — data helpers + the
 * canvas renderer (types: CtPackSlide, CtMockupPack, CtProductScene).
 *
 * A tổ hợp is a scene: a stack of frames — background fills (colour or
 * gradient), image frames (photos, a hand), product FRAMES (a main version
 * with the design's own content, config.samples, drawn with the MATERIAL
 * versions of its cliparts — the flat art never goes into a mockup) and
 * text. A set of tổ hợp (a template) is reused by other products of the
 * kind: a frame names its version by position, so each product puts its own
 * version — and its own design content — there.
 *
 * Rendering is deterministic (same scene + same pictures = the same image).
 * Browser only for rendering (canvas); the helpers above it are pure.
 */

import { CT_FONTS } from "../config";
import { CT_MAIN_KEY } from "../types";
import type {
  CtAsset,
  CtCordStyle,
  CtMainLayout,
  CtMaterialRules,
  CtMockupPack,
  CtMockupPackBody,
  CtPackBlend,
  CtPackBox,
  CtPackFillLayer,
  CtPackFrameLayer,
  CtPackGradient,
  CtPackImageLayer,
  CtPackLayer,
  CtPackLayerType,
  CtPackShadow,
  CtPackSlide,
  CtPackTextLayer,
  CtPreset,
  CtRegion,
  CtRegionItem,
  CtSelection,
} from "../types";
import { canvasToBlob, loadImage, renderComposite } from "./compositor";
import { newId } from "./geometry";
import { renditionOf, withRenditions } from "./library";

// ---------------------------------------------------------------------------
// Material rules
// ---------------------------------------------------------------------------

export const CORD_STYLES: Array<{ value: CtCordStyle; label: string }> = [
  { value: "none", label: "Không dây" },
  { value: "gold", label: "Dây vàng" },
  { value: "silver", label: "Dây bạc" },
  { value: "red", label: "Dây đỏ" },
  { value: "white", label: "Dây trắng" },
];

export function defaultMaterialRules(): CtMaterialRules {
  return { keepExact: true, realistic: true, hole: false, cord: "none" };
}

export function normalizeMaterialRules(raw: Partial<CtMaterialRules> | null | undefined): CtMaterialRules {
  const base = defaultMaterialRules();
  if (!raw || typeof raw !== "object") return base;
  return {
    keepExact: typeof raw.keepExact === "boolean" ? raw.keepExact : base.keepExact,
    realistic: typeof raw.realistic === "boolean" ? raw.realistic : base.realistic,
    hole: raw.hole === true,
    cord: CORD_STYLES.some((c) => c.value === raw.cord) ? (raw.cord as CtCordStyle) : base.cord,
  };
}

// ---------------------------------------------------------------------------
// Normalising stored scenes / sets
// ---------------------------------------------------------------------------

const BLENDS: CtPackBlend[] = ["normal", "multiply", "screen", "overlay", "soft-light", "darken", "lighten"];

function num(v: unknown, fallback: number, lo: number, hi: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function box(raw: Partial<CtPackBox> | undefined, w: number, h: number): CtPackBox {
  return {
    x: num(raw?.x, 0, -w * 4, w * 5),
    y: num(raw?.y, 0, -h * 4, h * 5),
    w: num(raw?.w, w / 2, 1, w * 8),
    h: num(raw?.h, h / 2, 1, h * 8),
    rotation: num(raw?.rotation, 0, -360, 360),
  };
}

function shadow(raw: Partial<CtPackShadow> | undefined): CtPackShadow {
  return {
    enabled: raw?.enabled !== false,
    blur: num(raw?.blur, 30, 0, 400),
    dx: num(raw?.dx, 0, -400, 400),
    dy: num(raw?.dy, 18, -400, 400),
    opacity: num(raw?.opacity, 0.35, 0, 1),
  };
}

/** A stored layer of any type, as loose as JSON gives it. */
interface RawLayer {
  type?: string;
  id?: string;
  name?: string;
  box?: Partial<CtPackBox>;
  opacity?: number;
  hidden?: boolean;
  url?: string;
  fit?: string;
  blend?: string;
  mainIndex?: number;
  artworkId?: string | null;
  shadow?: Partial<CtPackShadow> | boolean;
  hanger?: string;
  cordLength?: number;
  cordAngle?: number;
  text?: string;
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
  color?: string;
  align?: string;
  gradient?: Partial<CtPackGradient> | null;
}

function gradient(raw: Partial<CtPackGradient> | null | undefined): CtPackGradient | null {
  if (!raw || typeof raw !== "object") return null;
  const colors = (Array.isArray(raw.colors) ? raw.colors : []).filter((c): c is string => typeof c === "string" && c.length > 0 && c.length < 40).slice(0, 8);
  if (colors.length < 2) return null;
  return { name: str(raw.name).slice(0, 60), colors, angle: num(raw.angle, 90, -360, 360) };
}

/** Old scenes (thước đo, vòng chi tiết) lose those layers; everything else carries over. */
function normalizeLayer(raw: RawLayer, w: number, h: number): CtPackLayer | null {
  const base = { id: str(raw.id) || newId(), name: str(raw.name), box: box(raw.box, w, h), opacity: num(raw.opacity, 1, 0, 1), hidden: raw.hidden === true };
  switch (raw.type) {
    case "fill":
      return { ...base, type: "fill", color: str(raw.color, "#ffffff"), gradient: gradient(raw.gradient) };
    case "image":
      return {
        ...base,
        type: "image",
        url: str(raw.url),
        fit: raw.fit === "contain" || raw.fit === "stretch" ? raw.fit : "cover",
        blend: BLENDS.includes(raw.blend as CtPackBlend) ? (raw.blend as CtPackBlend) : "normal",
      };
    case "frame":
      return {
        ...base,
        type: "frame",
        mainIndex: Math.round(num(raw.mainIndex, 0, 0, 999)),
        artworkId: typeof raw.artworkId === "string" && raw.artworkId ? raw.artworkId : null,
        shadow: shadow(typeof raw.shadow === "object" ? raw.shadow : undefined),
        hanger: raw.hanger === "on" || raw.hanger === "off" ? raw.hanger : "auto",
        cordLength: num(raw.cordLength, h * 0.4, 0, h * 4),
        cordAngle: num(raw.cordAngle, 0, -80, 80),
      };
    case "text":
      return {
        ...base,
        type: "text",
        text: str(raw.text, "Text"),
        fontFamily: str(raw.fontFamily, "Poppins"),
        fontWeight: num(raw.fontWeight, 600, 100, 900),
        fontSize: num(raw.fontSize, 64, 6, 1000),
        color: str(raw.color, "#ffffff"),
        align: raw.align === "left" || raw.align === "right" ? raw.align : "center",
        shadow: raw.shadow !== false,
      };
    default:
      return null;
  }
}

export function normalizeSlide(raw: Partial<CtPackSlide>): CtPackSlide {
  const width = Math.round(num(raw.width, 2000, 64, 8192));
  const height = Math.round(num(raw.height, 2000, 64, 8192));
  const list: RawLayer[] = Array.isArray(raw.layers) ? (raw.layers as RawLayer[]) : [];
  const layers = list.map((l) => normalizeLayer(l, width, height)).filter((l): l is CtPackLayer => l !== null);
  // The old scene-wide colour is a background frame now.
  const legacy = str(raw.background);
  if (legacy) layers.unshift({ ...newLayer("fill", width, height), color: legacy } as CtPackFillLayer);
  return { id: str(raw.id) || newId(), name: str(raw.name, "Tổ hợp").slice(0, 120), width, height, background: "", layers };
}

/** Clean a set body (server and editor share it). */
export function normalizePackBody(raw: Partial<CtMockupPackBody>): CtMockupPackBody {
  return {
    name: str(raw.name).trim().slice(0, 120) || "Bộ tổ hợp",
    notes: str(raw.notes).slice(0, 4000),
    slides: (Array.isArray(raw.slides) ? raw.slides : []).slice(0, 40).map(normalizeSlide),
    thumbnail_url: typeof raw.thumbnail_url === "string" && raw.thumbnail_url ? raw.thumbnail_url : null,
  };
}

export function normalizePack(raw: CtMockupPack): CtMockupPack {
  return { ...raw, ...normalizePackBody(raw) };
}

// ---------------------------------------------------------------------------
// New things
// ---------------------------------------------------------------------------

export function newSlide(name = "Tổ hợp", width = 2000, height = 2000): CtPackSlide {
  return { id: newId(), name, width, height, background: "", layers: [] };
}

export const LAYER_LABEL: Record<CtPackLayerType, string> = {
  fill: "Nền",
  image: "Image frame",
  frame: "Sản phẩm",
  text: "Chữ",
};

/**
 * A new layer on a w×h canvas: fills and image frames cover the whole canvas
 * (the edit frame), text sits in the middle.
 */
export function newLayer(type: Exclude<CtPackLayerType, "frame">, w: number, h: number, extra: { url?: string } = {}): CtPackLayer {
  const full: CtPackBox = { x: 0, y: 0, w, h, rotation: 0 };
  const base = { id: newId(), name: LAYER_LABEL[type], opacity: 1, hidden: false };
  const side = Math.min(w, h);
  switch (type) {
    case "fill":
      return { ...base, type, box: full, color: "#ffffff", gradient: null };
    case "image":
      return { ...base, type, box: full, url: extra.url ?? "", fit: "cover", blend: "normal" };
    case "text": {
      const bw = Math.round(w * 0.6);
      const bh = Math.round(h * 0.1);
      return {
        ...base,
        type,
        box: { x: Math.round((w - bw) / 2), y: Math.round((h - bh) / 2), w: bw, h: bh, rotation: 0 },
        text: "Text",
        fontFamily: "Poppins",
        fontWeight: 600,
        fontSize: Math.round(side * 0.05),
        color: "#ffffff",
        align: "center",
        shadow: true,
      };
    }
  }
}

export function newFrame(slide: Pick<CtPackSlide, "width" | "height">, mainIndex: number, at: { x: number; y: number } | null, aspect: number): CtPackFrameLayer {
  const side = Math.min(slide.width, slide.height) * 0.5;
  const w = aspect >= 1 ? side : side * aspect;
  const h = aspect >= 1 ? side / aspect : side;
  const cx = at?.x ?? slide.width / 2;
  const cy = at?.y ?? slide.height / 2;
  return {
    id: newId(),
    name: "Sản phẩm",
    type: "frame",
    box: { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w: Math.round(w), h: Math.round(h), rotation: 0 },
    opacity: 1,
    hidden: false,
    mainIndex,
    artworkId: null,
    shadow: shadow(undefined),
    hanger: "auto",
    cordLength: Math.round(slide.height * 0.3),
    cordAngle: 0,
  };
}

/** Fresh ids for a copied scene. */
export function cloneSlide(slide: CtPackSlide, name = `${slide.name} (copy)`): CtPackSlide {
  return { ...slide, id: newId(), name, layers: slide.layers.map((l) => ({ ...l, id: newId() })) };
}

/**
 * The edit frame at a new size: the composition scales with it — full-canvas
 * fills / photos keep covering it, products and text keep their aspect.
 */
export function resizeSlide(slide: CtPackSlide, width: number, height: number): CtPackSlide {
  const w = Math.round(Math.min(8192, Math.max(64, width)));
  const h = Math.round(Math.min(8192, Math.max(64, height)));
  const kx = w / slide.width;
  const ky = h / slide.height;
  const k = Math.min(kx, ky);
  const layers = slide.layers.map((l): CtPackLayer => {
    const b = l.box;
    if (l.type === "fill" || l.type === "image") return { ...l, box: { ...b, x: b.x * kx, y: b.y * ky, w: b.w * kx, h: b.h * ky } };
    const cx = (b.x + b.w / 2) * kx;
    const cy = (b.y + b.h / 2) * ky;
    const box = { ...b, x: cx - (b.w * k) / 2, y: cy - (b.h * k) / 2, w: b.w * k, h: b.h * k };
    return l.type === "text" ? { ...l, box, fontSize: l.fontSize * k } : { ...l, box, cordLength: l.cordLength * k };
  });
  return { ...slide, width: w, height: h, layers };
}

/** CSS for a fill layer (layer list, gradient picker). */
export function fillCss(l: Pick<CtPackFillLayer, "color" | "gradient">): string {
  return l.gradient ? gradientCss(l.gradient) : l.color;
}

export function gradientCss(g: Pick<CtPackGradient, "colors" | "angle">): string {
  return `linear-gradient(${g.angle}deg, ${g.colors.join(", ")})`;
}

/** Does the scene paint every pixel (→ JPEG)? A visible fill, or an unrotated photo covering the canvas. */
export function sceneIsOpaque(slide: CtPackSlide): boolean {
  return slide.layers.some(
    (l) =>
      !l.hidden &&
      l.opacity >= 1 &&
      !l.box.rotation &&
      l.box.x <= 0 &&
      l.box.y <= 0 &&
      l.box.x + l.box.w >= slide.width &&
      l.box.y + l.box.h >= slide.height &&
      (l.type === "fill" || (l.type === "image" && l.fit !== "contain" && l.blend === "normal")),
  );
}

// ---------------------------------------------------------------------------
// Frames: the product drawn with its material
// ---------------------------------------------------------------------------

/** A frame's picture, ready to draw: the material render + the material's hanger rules. */
export interface CtSlotArt {
  url: string;
  hole: boolean;
  cord: CtCordStyle;
}

/** What a product brings to its frames. */
export interface CtFrameContext {
  /** The design's own content (config.samples) — every frame draws it. */
  samples: CtSelection;
  /** Default main (the design's coordinate space). */
  main: CtAsset;
  /** Main versions, default first — frames name theirs by position. */
  mains: CtAsset[];
  assets: CtAsset[];
  regions: CtRegion[];
  items: CtRegionItem[];
  layouts: Record<string, CtMainLayout>;
  presets: CtPreset[];
}

/** The version a frame shows in this product (its position, clamped). */
export function frameMain(frame: Pick<CtPackFrameLayer, "mainIndex">, ctx: Pick<CtFrameContext, "main" | "mains">): CtAsset {
  const list = ctx.mains.length ? ctx.mains : [ctx.main];
  return list[Math.min(frame.mainIndex, list.length - 1)] ?? ctx.main;
}

/** What a frame draws: the design's content on the frame's version. */
export function frameSelection(frame: Pick<CtPackFrameLayer, "mainIndex">, ctx: Pick<CtFrameContext, "main" | "mains" | "samples">): CtSelection {
  return { ...ctx.samples, [CT_MAIN_KEY]: { kind: "main", assetId: frameMain(frame, ctx).id } };
}

/** Cliparts a selection draws: its main version + every chosen image option. */
export function selectionCliparts(selection: CtSelection, assets: CtAsset[], defaultMainId: string): CtAsset[] {
  const ids = new Set<string>();
  const m = selection[CT_MAIN_KEY];
  ids.add(m?.kind === "main" && m.assetId ? m.assetId : defaultMainId);
  for (const v of Object.values(selection)) if (v.kind === "image" && v.assetId) ids.add(v.assetId);
  return [...ids].map((id) => assets.find((a) => a.id === id)).filter((a): a is CtAsset => !!a);
}

/** Cliparts of a frame with no material version yet — they must get one first. A frame with an AI artwork needs nothing. */
export function frameMissing(frame: CtPackFrameLayer, ctx: CtFrameContext): CtAsset[] {
  if (frame.artworkId && renditionOf(ctx.assets, frame.artworkId)) return [];
  return selectionCliparts(frameSelection(frame, ctx), ctx.assets, ctx.main.id).filter((c) => !renditionOf(ctx.assets, c.id));
}

/** Hanger rules: the material of the frame's main version. */
export function frameRules(frame: CtPackFrameLayer, ctx: CtFrameContext): CtMaterialRules {
  const r = renditionOf(ctx.assets, frameMain(frame, ctx).id);
  return normalizeMaterialRules(ctx.presets.find((p) => p.id === r?.meta.material)?.params.rules);
}

const frameRenders = new Map<string, Promise<string>>();

/**
 * The frame's picture: its saved AI artwork material, or the design re-drawn
 * with the material version of every clipart (no AI) — cached per input.
 */
export function frameArt(frame: CtPackFrameLayer, ctx: CtFrameContext): Promise<CtSlotArt> {
  const rules = frameRules(frame, ctx);
  const ai = frame.artworkId ? renditionOf(ctx.assets, frame.artworkId) : null;
  if (ai) return Promise.resolve({ url: ai.url, hole: rules.hole, cord: rules.cord });
  const selection = frameSelection(frame, ctx);
  const shown = withRenditions(ctx.assets);
  const key = JSON.stringify([
    selection,
    selectionCliparts(selection, shown, ctx.main.id).map((a) => a.url),
    ctx.regions.map((r) => [r.id, r.shape, r.config, r.sort_order]),
    ctx.items.map((i) => [i.id, i.transform]),
    ctx.layouts,
  ]);
  let job = frameRenders.get(key);
  if (!job) {
    job = renderComposite({ main: ctx.main, assets: shown, regions: ctx.regions, items: ctx.items, selection, scale: 1, layouts: ctx.layouts })
      .then((c) => canvasToBlob(c, "image/png"))
      .then((b) => URL.createObjectURL(b));
    job.catch(() => frameRenders.delete(key));
    frameRenders.set(key, job);
    if (frameRenders.size > 200) frameRenders.delete(frameRenders.keys().next().value as string);
  }
  return job.then((url) => ({ url, hole: rules.hole, cord: rules.cord }));
}

/** Pictures of every frame in a scene, by frame id. */
export async function sceneArts(slide: CtPackSlide, ctx: CtFrameContext): Promise<Record<string, CtSlotArt>> {
  const out: Record<string, CtSlotArt> = {};
  await Promise.all(
    slide.layers
      .filter((l): l is CtPackFrameLayer => l.type === "frame" && !l.hidden)
      .map((f) =>
        frameArt(f, ctx)
          .then((a) => (out[f.id] = a))
          .catch(() => undefined),
      ),
  );
  return out;
}

/** A set's scene for another product: frames keep their version position and draw that product's design. */
export function sceneForProduct(slide: CtPackSlide): CtPackSlide {
  const copy = cloneSlide(slide, slide.name);
  return { ...copy, layers: copy.layers.map((l) => (l.type === "frame" ? { ...l, artworkId: null } : l)) };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

interface ArtInfo {
  img: HTMLImageElement;
  /** Bounds of its visible pixels. */
  trim: { x: number; y: number; w: number; h: number };
  /** Hanging-hole centre + radius, image px: at the top of the silhouette, a little inside. */
  hole: { x: number; y: number; r: number };
}

const artCache = new Map<string, Promise<ArtInfo>>();

function analyse(img: HTMLImageElement): ArtInfo {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const whole: ArtInfo = { img, trim: { x: 0, y: 0, w, h }, hole: { x: w / 2, y: h * 0.05, r: w * 0.02 } };
  // Analyse at ≤512 px — plenty for bounds and the top point.
  const k = Math.min(1, 512 / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * k));
  const ch = Math.max(1, Math.round(h * k));
  const c = document.createElement("canvas");
  c.width = cw;
  c.height = ch;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return whole;
  ctx.drawImage(img, 0, 0, cw, ch);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, cw, ch).data;
  } catch {
    return whole;
  }
  let x0 = cw;
  let y0 = ch;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      if (data[(y * cw + x) * 4 + 3] > 24) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return whole;
  const trim = { x: x0 / k, y: y0 / k, w: (x1 - x0 + 1) / k, h: (y1 - y0 + 1) / k };
  // Top point: the middle of the opaque columns in a thin band under the top row.
  const band = Math.max(2, Math.round((y1 - y0) * 0.035));
  const xs: number[] = [];
  for (let y = y0; y <= Math.min(y1, y0 + band); y++) for (let x = x0; x <= x1; x++) if (data[(y * cw + x) * 4 + 3] > 24) xs.push(x);
  xs.sort((a, b) => a - b);
  const topX = xs.length ? xs[Math.floor(xs.length / 2)] : (x0 + x1) / 2;
  const r = Math.max(4, trim.w * 0.022);
  return { img, trim, hole: { x: topX / k, y: y0 / k + r * 2.1, r } };
}

function loadArt(url: string): Promise<ArtInfo> {
  const hit = artCache.get(url);
  if (hit) return hit;
  const p = loadImage(url).then(analyse);
  p.catch(() => artCache.delete(url));
  artCache.set(url, p);
  return p;
}

const COMPOSITE: Record<CtPackBlend, GlobalCompositeOperation> = {
  normal: "source-over",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  "soft-light": "soft-light",
  darken: "darken",
  lighten: "lighten",
};

const CORD_COLORS: Record<Exclude<CtCordStyle, "none">, [string, string, string]> = {
  gold: ["#7a5a14", "#f4d77f", "#a97f25"],
  silver: ["#6f6f6f", "#f4f4f4", "#9a9a9a"],
  red: ["#5e0b0b", "#e45050", "#8d1717"],
  white: ["#b5b5b5", "#ffffff", "#d4d4d4"],
};

export interface RenderSlideInput {
  slide: CtPackSlide;
  /** Frame layer id -> picture; missing = a placeholder (when `placeholders`) or nothing. */
  arts: Record<string, CtSlotArt | null | undefined>;
  /** Output px per pack px. */
  scale: number;
  /** Draw a dashed box for frames still rendering (editors). */
  placeholders?: boolean;
}

export async function renderSlide(input: RenderSlideInput): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(input.slide.width * input.scale));
  canvas.height = Math.max(1, Math.round(input.slide.height * input.scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D không khả dụng");
  await drawSlide(ctx, input);
  return canvas;
}

export async function drawSlide(ctx: CanvasRenderingContext2D, input: RenderSlideInput): Promise<void> {
  const { slide, scale } = input;
  const pack = { width: slide.width, height: slide.height };
  const layers = slide.layers.filter((l) => !l.hidden);
  // Load everything first so the drawing is one synchronous pass.
  const urls = new Set<string>();
  for (const l of layers) {
    if (l.type === "image" && l.url) urls.add(l.url);
    if (l.type === "frame") {
      const a = input.arts[l.id];
      if (a) urls.add(a.url);
    }
  }
  const loaded = new Map<string, ArtInfo>();
  await Promise.all([...urls].map((u) => loadArt(u).then((a) => loaded.set(u, a)).catch(() => undefined)));
  await Promise.all(
    layers
      .filter((l): l is CtPackTextLayer => l.type === "text")
      .map((l) => ensureFont(l.fontFamily, l.fontWeight)),
  );

  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, pack.width, pack.height);
  if (slide.background) {
    ctx.fillStyle = slide.background;
    ctx.fillRect(0, 0, pack.width, pack.height);
  }
  for (const layer of layers) {
    ctx.save();
    ctx.globalAlpha = layer.opacity;
    switch (layer.type) {
      case "fill":
        drawFillLayer(ctx, layer);
        break;
      case "image": {
        const art = loaded.get(layer.url);
        if (art) drawImageLayer(ctx, layer, art.img);
        else if (input.placeholders && !layer.url) drawPlaceholder(ctx, layer.box, "Ảnh");
        break;
      }
      case "frame": {
        const a = input.arts[layer.id];
        const art = a ? loaded.get(a.url) : undefined;
        if (a && art) drawFrameLayer(ctx, layer, a, art, scale);
        else if (input.placeholders) drawPlaceholder(ctx, layer.box, "…");
        break;
      }
      case "text":
        drawTextLayer(ctx, layer, scale);
        break;
    }
    ctx.restore();
  }
  ctx.restore();
}

const fontLinks = new Set<string>();

/** Load a Google Fonts family (text layers) before drawing with it. */
async function ensureFont(family: string, weight: number): Promise<void> {
  if (!fontLinks.has(family)) {
    fontLinks.add(family);
    const link = document.createElement("link");
    link.rel = "stylesheet";
    const weights = CT_FONTS.find((f) => f.family === family)?.weights;
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}${weights?.length ? `:wght@${weights.join(";")}` : ""}&display=swap`;
    document.head.appendChild(link);
    await new Promise<void>((resolve) => {
      link.onload = () => resolve();
      link.onerror = () => resolve();
    });
  }
  await document.fonts.load(`${weight} 32px "${family}"`).catch(() => []);
}

/** Move the context into a box: origin at its centre, rotated. */
function enterBox(ctx: CanvasRenderingContext2D, b: CtPackBox): void {
  ctx.translate(b.x + b.w / 2, b.y + b.h / 2);
  if (b.rotation) ctx.rotate((b.rotation * Math.PI) / 180);
}

/** A colour, or a linear gradient running at its CSS angle across the (rotated) box. */
function drawFillLayer(ctx: CanvasRenderingContext2D, l: CtPackFillLayer): void {
  const b = l.box;
  enterBox(ctx, b);
  const g = l.gradient;
  if (g) {
    // CSS: 0deg points up, 90deg right; the line is long enough for the corners to reach the end colours.
    const a = (g.angle * Math.PI) / 180;
    const dx = Math.sin(a);
    const dy = -Math.cos(a);
    const half = Math.abs((b.w / 2) * dx) + Math.abs((b.h / 2) * dy);
    const grad = ctx.createLinearGradient(-dx * half, -dy * half, dx * half, dy * half);
    g.colors.forEach((c, i) => grad.addColorStop(i / (g.colors.length - 1), c));
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = l.color;
  }
  ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
}

function drawImageLayer(ctx: CanvasRenderingContext2D, l: CtPackImageLayer, img: HTMLImageElement): void {
  const b = l.box;
  enterBox(ctx, b);
  ctx.globalCompositeOperation = COMPOSITE[l.blend];
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  if (l.fit === "stretch") {
    ctx.drawImage(img, -b.w / 2, -b.h / 2, b.w, b.h);
    return;
  }
  if (l.fit === "contain") {
    const s = Math.min(b.w / iw, b.h / ih);
    ctx.drawImage(img, (-iw * s) / 2, (-ih * s) / 2, iw * s, ih * s);
    return;
  }
  // cover: crop the image to the box.
  const s = Math.max(b.w / iw, b.h / ih);
  const sw = b.w / s;
  const sh = b.h / s;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, -b.w / 2, -b.h / 2, b.w, b.h);
}

/** Where the trimmed art lands inside a frame box (box-centred coords). */
function fitArt(b: CtPackBox, art: ArtInfo): { s: number; x: number; y: number; w: number; h: number } {
  const s = Math.min(b.w / art.trim.w, b.h / art.trim.h);
  const w = art.trim.w * s;
  const h = art.trim.h * s;
  return { s, x: -w / 2, y: -h / 2, w, h };
}

/** The trimmed art, with the hanging hole punched through when `hole`. */
function cutArt(art: ArtInfo, hole: boolean): HTMLCanvasElement {
  const off = document.createElement("canvas");
  off.width = Math.max(1, Math.round(art.trim.w));
  off.height = Math.max(1, Math.round(art.trim.h));
  const o = off.getContext("2d");
  if (!o) return off;
  o.drawImage(art.img, art.trim.x, art.trim.y, art.trim.w, art.trim.h, 0, 0, off.width, off.height);
  if (hole) {
    const hx = art.hole.x - art.trim.x;
    const hy = art.hole.y - art.trim.y;
    o.globalCompositeOperation = "destination-out";
    o.beginPath();
    o.arc(hx, hy, art.hole.r, 0, Math.PI * 2);
    o.fill();
    // The drilled acrylic edge.
    o.globalCompositeOperation = "source-over";
    o.lineWidth = Math.max(1, art.hole.r * 0.28);
    o.strokeStyle = "rgba(235,240,245,0.9)";
    o.beginPath();
    o.arc(hx, hy, art.hole.r + o.lineWidth / 2, 0, Math.PI * 2);
    o.stroke();
  }
  return off;
}

function drawFrameLayer(ctx: CanvasRenderingContext2D, l: CtPackFrameLayer, a: CtSlotArt, art: ArtInfo, scale: number): void {
  const b = l.box;
  const fit = fitArt(b, art);
  const cord: CtCordStyle = l.hanger === "off" ? "none" : a.cord !== "none" ? a.cord : l.hanger === "on" ? "gold" : "none";
  const hole = l.hanger === "on" || (l.hanger === "auto" && (a.hole || a.cord !== "none"));
  const cut = cutArt(art, hole);

  ctx.save();
  enterBox(ctx, b);
  if (l.shadow.enabled) {
    // Shadows ignore the transform: scale them by hand.
    ctx.shadowColor = `rgba(0,0,0,${l.shadow.opacity})`;
    ctx.shadowBlur = l.shadow.blur * scale;
    ctx.shadowOffsetX = l.shadow.dx * scale;
    ctx.shadowOffsetY = l.shadow.dy * scale;
  }
  ctx.drawImage(cut, fit.x, fit.y, fit.w, fit.h);
  ctx.restore();

  if (cord !== "none") {
    // Hole centre in pack coords (through the box's rotation).
    const lx = fit.x + (art.hole.x - art.trim.x) * fit.s;
    const ly = fit.y + (art.hole.y - art.trim.y) * fit.s;
    const rot = (b.rotation * Math.PI) / 180;
    const cx = b.x + b.w / 2 + lx * Math.cos(rot) - ly * Math.sin(rot);
    const cy = b.y + b.h / 2 + lx * Math.sin(rot) + ly * Math.cos(rot);
    drawCord(ctx, cx, cy, art.hole.r * fit.s, l.cordLength, l.cordAngle, cord, scale);
  }
}

/** A twisted cord looped through the hole, running up `length` px at `angle` degrees from vertical. */
function drawCord(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  length: number,
  angle: number,
  style: Exclude<CtCordStyle, "none">,
  scale: number,
): void {
  const [dark, light, mid] = CORD_COLORS[style];
  const width = Math.max(2, r * 0.75);
  const a = (angle * Math.PI) / 180;
  const tx = x + Math.sin(a) * length;
  const ty = y - Math.cos(a) * length;
  for (const fromX of [x - r * 0.45, x + r * 0.45]) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(fromX, y);
    ctx.lineTo(tx + (fromX - x) * 0.25, ty);
    const g = ctx.createLinearGradient(fromX - width, y, fromX + width, y);
    g.addColorStop(0, dark);
    g.addColorStop(0.45, light);
    g.addColorStop(1, mid);
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = width * scale;
    ctx.shadowOffsetY = width * 0.4 * scale;
    ctx.strokeStyle = g;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.stroke();
    // The twist: short dark dashes along the strand.
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = "rgba(60,40,0,0.35)";
    ctx.lineWidth = width * 0.45;
    ctx.setLineDash([width * 0.5, width * 0.7]);
    ctx.stroke();
    ctx.restore();
  }
  // The loop through the hole.
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(x, y, r * 0.55, r * 0.75, 0, 0, Math.PI);
  ctx.strokeStyle = mid;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.restore();
}

function drawPlaceholder(ctx: CanvasRenderingContext2D, b: CtPackBox, label: string): void {
  enterBox(ctx, b);
  ctx.fillStyle = "rgba(127,127,127,0.18)";
  ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
  const dash = Math.max(6, Math.min(b.w, b.h) * 0.03);
  ctx.setLineDash([dash, dash]);
  ctx.lineWidth = Math.max(2, Math.min(b.w, b.h) * 0.006);
  ctx.strokeStyle = "rgba(200,200,200,0.8)";
  ctx.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h);
  ctx.fillStyle = "rgba(220,220,220,0.9)";
  ctx.font = `700 ${Math.round(Math.min(b.w, b.h) * 0.22)}px Poppins, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, 0, 0, b.w * 0.9);
}

function drawTextLayer(ctx: CanvasRenderingContext2D, l: CtPackTextLayer, scale: number): void {
  const b = l.box;
  enterBox(ctx, b);
  ctx.font = `${l.fontWeight} ${l.fontSize}px "${l.fontFamily}", sans-serif`;
  ctx.fillStyle = l.color;
  ctx.textAlign = l.align;
  ctx.textBaseline = "top";
  if (l.shadow) {
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = l.fontSize * 0.15 * scale;
    ctx.shadowOffsetY = l.fontSize * 0.04 * scale;
  }
  const lines = l.text.split("\n");
  const lh = l.fontSize * 1.2;
  const x = l.align === "left" ? -b.w / 2 : l.align === "right" ? b.w / 2 : 0;
  const top = -(lines.length * lh) / 2;
  lines.forEach((line, i) => ctx.fillText(line, x, top + i * lh, b.w));
}
