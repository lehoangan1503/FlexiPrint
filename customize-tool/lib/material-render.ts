/**
 * Browser material renderer — turns the flat composite into a physical-looking
 * product (acrylic plate, ceramic ornament…) and optionally places it on a
 * scene photo. Runs on every preview change, so it is canvas-only (no server
 * round trip): ~20–60 ms at storefront preview sizes.
 *
 * Plate outline:
 *   contour  the design's silhouette, grown by the border (distance transform),
 *            holes filled, concave notches smoothed (closing) — the laser cut line.
 *            services/material-render computes the same outline at print
 *            resolution for the SVG cut file.
 *   main     the main asset's alpha (a white ceramic disk is the blank); every
 *            layer is printed onto it and clipped to it.
 *
 * Layers, bottom → top: drop shadow · plate edge (thickness) · plate face ·
 * print · edge shading (pillow) · bevel rim light · gloss / sheen / grain.
 */

import type { CtMaterialConfig, CtRenderAsset } from "../types";
import type { CompositeInput } from "./compositor";
import { loadImage, renderComposite } from "./compositor";
import { materialActive, materialPreset, pxPerMm } from "./materials";
import { selectedMainId } from "./design";

export interface MaterialRenderInput {
  /** Flat composite (transparent background), main-asset size × scale. */
  design: HTMLCanvasElement;
  /** The main version shown — its alpha is the plate for shape "main". */
  mainImage: HTMLImageElement | null;
  material: CtMaterialConfig;
  /** Main asset width in its own pixels (mm → px). */
  mainWidthPx: number;
  /** Design canvas px per main-asset px. */
  scale: number;
  /** Grow the canvas so border / edge / shadow fit (false = same size as the design, for the editor overlay). */
  pad: boolean;
}

export interface MaterialRenderResult {
  canvas: HTMLCanvasElement;
  /** Where the design's (0,0) sits inside `canvas`. */
  offset: number;
  /** Design size inside `canvas`. */
  designW: number;
  designH: number;
}

/** Long side of the grid the outline is computed on (then smoothed up to full size). */
const MASK_WORK_PX = 720;

// ---------------------------------------------------------------------------
// canvas helpers
// ---------------------------------------------------------------------------

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D không khả dụng");
  return ctx;
}

/** `mask`'s alpha filled with one colour. */
function tint(mask: HTMLCanvasElement, color: string): HTMLCanvasElement {
  const out = canvas(mask.width, mask.height);
  const c = ctx2d(out);
  c.fillStyle = color;
  c.fillRect(0, 0, out.width, out.height);
  c.globalCompositeOperation = "destination-in";
  c.drawImage(mask, 0, 0);
  return out;
}

/**
 * Gaussian-blurred copy via shadowBlur (ctx.filter is missing on older
 * Safari): the source is drawn far off-canvas and only its shadow lands.
 */
function blurred(src: HTMLCanvasElement, radius: number, color = "#000"): HTMLCanvasElement {
  const out = canvas(src.width, src.height);
  if (radius <= 0.5) {
    ctx2d(out).drawImage(tint(src, color), 0, 0);
    return out;
  }
  const c = ctx2d(out);
  const far = src.width + radius * 4 + 100;
  c.shadowColor = color;
  c.shadowBlur = radius;
  c.shadowOffsetX = far;
  c.drawImage(src, -far, 0);
  return out;
}

/** Keep only what lies inside `mask`. */
function clipTo(layer: HTMLCanvasElement, mask: HTMLCanvasElement): HTMLCanvasElement {
  const c = ctx2d(layer);
  c.save();
  c.globalCompositeOperation = "destination-in";
  c.drawImage(mask, 0, 0);
  c.restore();
  return layer;
}

function mix(a: string, b: string, t: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  const ch = (i: number) => Math.round(pa[i] + (pb[i] - pa[i]) * t);
  return `rgb(${ch(0)},${ch(1)},${ch(2)})`;
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((x) => x + x).join("") : h.padEnd(6, "0");
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

// ---------------------------------------------------------------------------
// outline (distance transform)
// ---------------------------------------------------------------------------

const INF = 1e20;

/** 1-D squared distance transform (Felzenszwalb & Huttenlocher). */
function dt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/** Squared Euclidean distance from every pixel to the nearest `seed` pixel. */
function edt(seed: Uint8Array, w: number, h: number): Float64Array {
  const grid = new Float64Array(w * h);
  for (let i = 0; i < grid.length; i++) grid[i] = seed[i] ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    dt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = grid[row + x];
    dt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) grid[row + x] = d[x];
  }
  return grid;
}

/** Set every "0" pixel not connected to the border to 1 (holes inside the plate). */
function fillHoles(bin: Uint8Array, w: number, h: number): void {
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => {
    if (!bin[i] && !outside[i]) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop() as number;
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < w * (h - 1)) push(i + w);
  }
  for (let i = 0; i < bin.length; i++) if (!outside[i]) bin[i] = 1;
}

/**
 * Plate outline of a contour-cut product: design alpha grown by `borderPx`,
 * holes filled, then a morphological closing rounds the notches between
 * letters (a laser can't cut hairline slots, and they'd snap anyway).
 * Returns a white canvas whose alpha is the plate, same size as `design`.
 */
export function contourMask(design: HTMLCanvasElement, borderPx: number): HTMLCanvasElement {
  const k = Math.min(1, MASK_WORK_PX / Math.max(design.width, design.height));
  const w = Math.max(1, Math.round(design.width * k));
  const h = Math.max(1, Math.round(design.height * k));
  const small = canvas(w, h);
  const sc = ctx2d(small);
  sc.drawImage(design, 0, 0, w, h);
  const px = sc.getImageData(0, 0, w, h);

  const fg = new Uint8Array(w * h);
  for (let i = 0; i < fg.length; i++) fg[i] = px.data[i * 4 + 3] >= 40 ? 1 : 0;

  const r = Math.max(0, borderPx * k);
  // Closing radius: rounds concave corners; proportional to the border, at least ~1.5 px.
  const s = Math.max(1.5, r * 0.9);
  const grow = edt(fg, w, h);
  const plate = new Uint8Array(w * h);
  const reach = (r + s) * (r + s);
  for (let i = 0; i < plate.length; i++) plate[i] = grow[i] <= reach ? 1 : 0;
  fillHoles(plate, w, h);

  // Erode back by s: distance to the nearest outside pixel.
  const outside = new Uint8Array(w * h);
  for (let i = 0; i < outside.length; i++) outside[i] = plate[i] ? 0 : 1;
  const shrink = edt(outside, w, h);
  const out = sc.createImageData(w, h);
  for (let i = 0; i < plate.length; i++) {
    // Antialiased edge from the continuous distance.
    const a = Math.min(1, Math.max(0, Math.sqrt(shrink[i]) - s + 0.5));
    out.data[i * 4] = 255;
    out.data[i * 4 + 1] = 255;
    out.data[i * 4 + 2] = 255;
    out.data[i * 4 + 3] = Math.round(a * 255);
  }
  sc.putImageData(out, 0, 0);

  const full = canvas(design.width, design.height);
  const fc = ctx2d(full);
  fc.imageSmoothingEnabled = true;
  fc.imageSmoothingQuality = "high";
  fc.drawImage(small, 0, 0, full.width, full.height);
  return full;
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

export function renderMaterial(input: MaterialRenderInput): MaterialRenderResult {
  const { design, material } = input;
  const preset = materialPreset(material.id);
  const W = design.width;
  const H = design.height;
  if (material.id === "none") return { canvas: design, offset: 0, designW: W, designH: H };

  const mm = pxPerMm(material, input.mainWidthPx) * input.scale;
  const border = material.shape === "contour" ? material.borderMm * mm : 0;
  const depth = material.thicknessMm * mm * 0.6;
  const shadowBlur = Math.max(2, Math.min(W, H) * 0.025) * (0.4 + material.shadow);
  const shadowDrop = depth + shadowBlur * 0.45;
  const P = input.pad ? Math.ceil(border + depth + shadowBlur * 1.6 + shadowDrop + 4) : 0;
  const CW = W + 2 * P;
  const CH = H + 2 * P;

  // Design placed on the padded grid.
  const art = canvas(CW, CH);
  ctx2d(art).drawImage(design, P, P);

  // Plate mask (white, alpha = plate).
  let mask: HTMLCanvasElement;
  if (material.shape === "main" && input.mainImage) {
    mask = canvas(CW, CH);
    const mc = ctx2d(mask);
    mc.drawImage(input.mainImage, P, P, W, H);
    mask = tint(mask, "#fff");
  } else {
    mask = contourMask(art, border);
  }

  const out = canvas(CW, CH);
  const o = ctx2d(out);

  // 1. Drop shadow, cast down-right by the plate standing off the surface.
  if (material.shadow > 0) {
    o.save();
    o.globalAlpha = Math.min(1, 0.65 * material.shadow);
    o.drawImage(blurred(mask, shadowBlur, "rgba(0,0,0,1)"), shadowDrop * 0.35, shadowDrop);
    o.restore();
  }

  // 2. Plate edge: the mask stacked towards the viewer's bottom-right, darkening with depth.
  if (depth >= 0.75) {
    const steps = Math.min(28, Math.max(2, Math.ceil(depth)));
    for (let i = steps; i >= 1; i--) {
      const t = i / steps;
      o.drawImage(tint(mask, mix(preset.edge[0], preset.edge[1], t)), depth * t * 0.35, depth * t);
    }
  }

  // 3. Plate face (contour plates; a "main" blank is already in the design).
  if (preset.face && material.shape === "contour") {
    o.save();
    o.globalAlpha = preset.faceOpacity;
    o.drawImage(tint(mask, preset.face), 0, 0);
    o.restore();
  }

  // 4. Print — clipped to the blank for "main" (ceramic: nothing prints off the disk).
  let print = art;
  if (preset.printTint) {
    const tinted = canvas(CW, CH);
    const tc = ctx2d(tinted);
    tc.drawImage(art, 0, 0);
    tc.globalCompositeOperation = "multiply";
    tc.fillStyle = preset.printTint;
    tc.fillRect(0, 0, CW, CH);
    tc.globalCompositeOperation = "destination-in";
    tc.drawImage(art, 0, 0);
    print = tinted;
  }
  if (material.shape === "main") print = clipTo(copy(print), mask);
  o.drawImage(print, 0, 0);

  // Lighting goes on its own layer, clipped to the plate.
  const light = canvas(CW, CH);
  const l = ctx2d(light);
  const minSide = Math.min(W, H);

  // 5. Pillow: soft shade creeping in from the outline (curved glaze, rounded edge).
  if (preset.pillow > 0) {
    const inv = canvas(CW, CH);
    const ic = ctx2d(inv);
    ic.fillStyle = "#000";
    ic.fillRect(0, 0, CW, CH);
    ic.globalCompositeOperation = "destination-out";
    ic.drawImage(mask, 0, 0);
    l.save();
    l.globalAlpha = preset.pillow;
    l.drawImage(blurred(inv, minSide * 0.05, "#000"), minSide * 0.006, minSide * 0.01);
    l.restore();
  }

  // 6. Bevel: light rim top-left, dark rim bottom-right.
  if (preset.bevel > 0) {
    const w = Math.max(1, 0.35 * mm);
    const rim = (color: string, dx: number, dy: number, alpha: number) => {
      const r = tint(mask, color);
      const rc = ctx2d(r);
      rc.globalCompositeOperation = "destination-out";
      rc.drawImage(mask, dx, dy);
      l.save();
      l.globalAlpha = alpha;
      l.drawImage(blurred(r, Math.max(0.6, w * 0.6), color), 0, 0);
      l.restore();
    };
    rim("#ffffff", w, w, preset.bevel);
    rim("#000000", -w, -w, preset.bevel * 0.35);
  }

  // 7. Surface finish.
  const g = material.gloss;
  if (g > 0 && preset.finish === "gloss") {
    // A broad soft highlight top-left + a thin diagonal streak.
    const rg = l.createRadialGradient(P + W * 0.3, P + H * 0.22, 0, P + W * 0.3, P + H * 0.22, Math.max(W, H) * 0.55);
    rg.addColorStop(0, `rgba(255,255,255,${0.5 * g})`);
    rg.addColorStop(0.5, `rgba(255,255,255,${0.14 * g})`);
    rg.addColorStop(1, "rgba(255,255,255,0)");
    l.fillStyle = rg;
    l.fillRect(0, 0, CW, CH);
    const lg = l.createLinearGradient(P, P, P + W, P + H);
    lg.addColorStop(0.18, "rgba(255,255,255,0)");
    lg.addColorStop(0.24, `rgba(255,255,255,${0.32 * g})`);
    lg.addColorStop(0.3, "rgba(255,255,255,0)");
    l.fillStyle = lg;
    l.fillRect(0, 0, CW, CH);
  } else if (g > 0 && preset.finish === "sheen") {
    const lg = l.createLinearGradient(P, P, P + W, P + H * 0.25);
    const bands = 7;
    for (let i = 0; i <= bands; i++) {
      const t = i / bands;
      lg.addColorStop(t, i % 2 === 0 ? `rgba(255,255,255,${0.3 * g})` : `rgba(0,0,0,${0.12 * g})`);
    }
    l.fillStyle = lg;
    l.fillRect(0, 0, CW, CH);
  } else if (preset.finish === "grain") {
    drawGrain(l, P, P, W, H, 0.1 + g);
  }
  o.drawImage(clipTo(light, mask), 0, 0);

  return { canvas: out, offset: P, designW: W, designH: H };
}

function copy(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = canvas(src.width, src.height);
  ctx2d(c).drawImage(src, 0, 0);
  return c;
}

/** Deterministic wood fibres (same picture on every render). */
function drawGrain(l: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, strength: number): void {
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  l.save();
  l.globalCompositeOperation = "multiply";
  const lines = Math.round(h / 5);
  for (let i = 0; i < lines; i++) {
    const yy = y + (i / lines) * h + rand() * 3;
    const amp = 2 + rand() * 6;
    const freq = 0.004 + rand() * 0.01;
    l.strokeStyle = `rgba(120,80,40,${(0.06 + rand() * 0.12) * strength})`;
    l.lineWidth = 0.6 + rand() * 1.8;
    l.beginPath();
    for (let xx = x; xx <= x + w; xx += 6) {
      const py = yy + Math.sin(xx * freq + i) * amp;
      if (xx === x) l.moveTo(xx, py);
      else l.lineTo(xx, py);
    }
    l.stroke();
  }
  l.restore();
}

// ---------------------------------------------------------------------------
// scene
// ---------------------------------------------------------------------------

/** Place a rendered product onto the scene photo (placement in scene fractions). */
export function placeOnScene(product: MaterialRenderResult, scene: HTMLImageElement, material: CtMaterialConfig, maxSide: number): HTMLCanvasElement {
  const k0 = Math.min(1, maxSide / Math.max(scene.naturalWidth, scene.naturalHeight));
  const SW = Math.round(scene.naturalWidth * k0);
  const SH = Math.round(scene.naturalHeight * k0);
  const out = canvas(SW, SH);
  const c = ctx2d(out);
  c.drawImage(scene, 0, 0, SW, SH);
  const p = material.scene;
  const k = (p.width * SW) / Math.max(1, product.designW);
  c.save();
  c.translate(p.x * SW, p.y * SH);
  c.rotate((p.rotation * Math.PI) / 180);
  c.imageSmoothingQuality = "high";
  c.drawImage(
    product.canvas,
    (-product.designW / 2 - product.offset) * k,
    (-product.designH / 2 - product.offset) * k,
    product.canvas.width * k,
    product.canvas.height * k,
  );
  c.restore();
  return out;
}

// ---------------------------------------------------------------------------
// one call: selection → finished product picture
// ---------------------------------------------------------------------------

export interface ProductRenderInput extends Omit<CompositeInput, "scale"> {
  material: CtMaterialConfig;
  /** Long side of the output picture. */
  maxSide: number;
}

/**
 * What the customer sees: composite → material → scene. With no material and
 * no scene this is just the composite at `maxSide`.
 */
export async function renderProduct(input: ProductRenderInput): Promise<HTMLCanvasElement> {
  const { main, material } = input;
  const byId = new Map(input.assets.map((a) => [a.id, a]));
  const sceneAsset: CtRenderAsset | undefined = material.sceneAssetId ? byId.get(material.sceneAssetId) : undefined;
  const scene = sceneAsset ? await loadImage(sceneAsset.url).catch(() => null) : null;

  if (!materialActive(material) || (material.id === "none" && !scene)) {
    const scale = Math.min(1, input.maxSide / Math.max(main.width, main.height));
    return renderComposite({ ...input, scale });
  }

  // On a scene the product is only as big as its placement.
  let scale = Math.min(1, input.maxSide / Math.max(main.width, main.height));
  if (scene) {
    const k0 = Math.min(1, input.maxSide / Math.max(scene.naturalWidth, scene.naturalHeight));
    scale = Math.min(1, (material.scene.width * scene.naturalWidth * k0) / main.width);
  }
  const design = await renderComposite({ ...input, scale });
  const mainId = selectedMainId(input.selection, input.assets, main.id);
  const mainImage = material.shape === "main" ? await loadImage((byId.get(mainId) ?? main).url).catch(() => null) : null;
  const product = renderMaterial({ design, mainImage, material, mainWidthPx: main.width, scale, pad: true });
  if (scene) return placeOnScene(product, scene, material, input.maxSide);

  // No scene: fit the padded product into maxSide.
  const c = product.canvas;
  const k = Math.min(1, input.maxSide / Math.max(c.width, c.height));
  if (k >= 1) return c;
  const out = canvas(c.width * k, c.height * k);
  ctx2d(out).drawImage(c, 0, 0, out.width, out.height);
  return out;
}
