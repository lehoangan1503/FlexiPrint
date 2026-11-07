/**
 * The product scene (Thiết kế → Nền): a background photo with the design —
 * main + its layers, in main px — drawn into `box` (background px). The
 * storefront and the editor preview show the product this way; print files
 * never include it — and the design takes the photo's own light (lib/blank-shading). Small on purpose: the
 * storefront bundle imports it.
 */

import type { CtProductScene } from "../types";
import { loadImage } from "./compositor";
import { lightOnBlank } from "./blank-shading";

function num(v: unknown, fallback: number, lo: number, hi: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}


export function defaultScene(): CtProductScene {
  return { url: null, width: 0, height: 0, box: { x: 0, y: 0, w: 0, h: 0 } };
}

export function normalizeScene(raw: Partial<CtProductScene> | null | undefined): CtProductScene {
  if (!raw || typeof raw !== "object" || typeof raw.url !== "string" || !raw.url) return defaultScene();
  const width = num(raw.width, 0, 1, 8192);
  const height = num(raw.height, 0, 1, 8192);
  if (!width || !height) return defaultScene();
  const b = raw.box ?? { x: 0, y: 0, w: width, h: height };
  const plate = raw.plate && typeof raw.plate === "object" ? { border: num(raw.plate.border, 0.02, 0, 0.3) } : null;
  return {
    url: raw.url,
    width,
    height,
    box: { x: num(b.x, 0, -width * 4, width * 5), y: num(b.y, 0, -height * 4, height * 5), w: num(b.w, width, 1, width * 8), h: num(b.h, height, 1, height * 8) },
    ...(plate ? { plate } : {}),
  };
}

/** A new background: the design contain-fitted into its middle 80 %. */
export function sceneFor(url: string, width: number, height: number, main: { width: number; height: number }): CtProductScene {
  const k = Math.min((width * 0.8) / main.width, (height * 0.8) / main.height);
  const w = main.width * k;
  const h = main.height * k;
  return { url, width, height, box: { x: (width - w) / 2, y: (height - h) / 2, w, h } };
}

/** Draw the design canvas on the scene's background (storefront / preview). */
/**
 * `bleed`: the design canvas reaches past the main's box by this fraction of its width / height on each side
 * (a material version's plate / cord — compositor bleed): drawn around the scene's box, not squeezed into it.
 */
export async function drawOnScene(
  raw: Partial<CtProductScene> | null | undefined,
  design: HTMLCanvasElement,
  maxSide: number,
  bleed: { x: number; y: number } = { x: 0, y: 0 },
  /** Pasted as it is (layers laid on a version's AI phôi): not lit by the photo, no plate. */
  flat = false,
): Promise<HTMLCanvasElement> {
  const scene = normalizeScene(raw);
  if (!scene.url) return design;
  const k = Math.min(1, maxSide / Math.max(scene.width, scene.height));
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(scene.width * k));
  out.height = Math.max(1, Math.round(scene.height * k));
  const ctx = out.getContext("2d");
  if (!ctx) return design;
  const bg = await loadImage(scene.url).catch(() => null);
  if (bg) ctx.drawImage(bg, 0, 0, out.width, out.height);
  const bx = scene.box.w * bleed.x;
  const by = scene.box.h * bleed.y;
  const dx = (scene.box.x - bx) * k;
  const dy = (scene.box.y - by) * k;
  const dw = (scene.box.w + 2 * bx) * k;
  const dh = (scene.box.h + 2 * by) * k;
  if (flat) {
    ctx.drawImage(design, dx, dy, dw, dh);
    return out;
  }
  if (scene.plate) {
    // A cut-to-shape clear plate: made from the design itself (its shadow, the clear plate, its bright rim), then
    // the print on it as it is — the background photo shows through the plate.
    drawPlate(ctx, design, dx, dy, dw, dh, scene.plate.border * scene.box.w * k);
    ctx.drawImage(design, dx, dy, dw, dh);
    return out;
  }
  if (!bg || !lightDesign(ctx, design, dx, dy, dw, dh)) ctx.drawImage(design, dx, dy, dw, dh);
  return out;
}

/** The design's printed pixels as one solid shape grown by `r` px (a ring of shifted copies), in `color`. */
function grownShape(design: HTMLCanvasElement, w: number, h: number, pad: number, r: number, color: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w + 2 * pad));
  c.height = Math.max(1, Math.round(h + 2 * pad));
  const ctx = c.getContext("2d");
  if (!ctx) return c;
  const steps = r > 0 ? Math.max(16, Math.min(48, Math.round(r * 2))) : 1;
  for (let ring = r > 0 ? 1 : 0; ring >= 0; ring -= 1) {
    const rr = ring ? r : r * 0.5;
    for (let i = 0; i < steps; i++) {
      const a = (2 * Math.PI * i) / steps;
      ctx.drawImage(design, pad + rr * Math.cos(a), pad + rr * Math.sin(a), w, h);
    }
  }
  ctx.drawImage(design, pad, pad, w, h);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

/**
 * The clear acrylic plate under a cut-to-shape design (`r` px past its printed pixels): a soft shadow, the plate
 * lightly frosted, a bright rim on its cut edge.
 */
export function drawPlate(ctx: CanvasRenderingContext2D, design: HTMLCanvasElement, dx: number, dy: number, dw: number, dh: number, r: number): void {
  const border = Math.max(1, r);
  const pad = Math.ceil(border + 4);
  const plate = grownShape(design, dw, dh, pad, border, "#fff");
  const rimW = Math.max(1.5, border * 0.22);
  const inner = grownShape(design, dw, dh, pad, Math.max(0, border - rimW), "#fff");
  const rim = document.createElement("canvas");
  rim.width = plate.width;
  rim.height = plate.height;
  const rctx = rim.getContext("2d");
  if (!rctx) return;
  rctx.drawImage(plate, 0, 0);
  rctx.globalCompositeOperation = "destination-out";
  rctx.drawImage(inner, 0, 0);
  ctx.save();
  // Shadow: the plate, dark and soft, a little down-right.
  ctx.filter = `blur(${Math.max(2, border * 0.8)}px)`;
  ctx.globalAlpha = 0.35;
  const shadow = grownShape(design, dw, dh, pad, border, "#000");
  ctx.drawImage(shadow, dx - pad + border * 0.35, dy - pad + border * 0.6);
  ctx.filter = "none";
  // The plate: frosted clear.
  ctx.globalAlpha = 0.2;
  ctx.drawImage(plate, dx - pad, dy - pad);
  // Its cut edge catches the light.
  ctx.globalAlpha = 0.8;
  ctx.drawImage(rim, dx - pad, dy - pad);
  ctx.restore();
}

/**
 * The design printed on the photo, lit by it (lib/blank-shading): the phôi's shading and gloss stay on the print.
 * False when the photo's pixels can't be read (a picture served without CORS) — the caller pastes it flat.
 */
function lightDesign(ctx: CanvasRenderingContext2D, design: HTMLCanvasElement, dx: number, dy: number, dw: number, dh: number): boolean {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const x0 = Math.max(0, Math.floor(dx));
  const y0 = Math.max(0, Math.floor(dy));
  const x1 = Math.min(W, Math.ceil(dx + dw));
  const y1 = Math.min(H, Math.ceil(dy + dh));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return true;
  const layer = document.createElement("canvas");
  layer.width = w;
  layer.height = h;
  const lctx = layer.getContext("2d");
  if (!lctx) return false;
  lctx.drawImage(design, dx - x0, dy - y0, dw, dh);
  try {
    const under = ctx.getImageData(x0, y0, w, h);
    const art = lctx.getImageData(0, 0, w, h);
    lightOnBlank(art.data, under.data, w, h, 4, under.data);
    ctx.putImageData(under, x0, y0);
    return true;
  } catch {
    return false;
  }
}

