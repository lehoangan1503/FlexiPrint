/**
 * A customer photo drawn as several figures side by side (a plush doll's front + back) placed on the khuôn's print
 * areas: each figure centred on its own safe area, all at ONE scale (front and back the same size, like one sewing
 * pattern) — asked 2026-11-11 for the Funny Face doll ("2 mặt ảnh phải ở center khuôn in"). Runs on AI styles with
 * params.keepFrame when the photo zone holds safe areas of the product's khuôn.
 *
 * Pure geometry on RGBA pixels: placeFaces says which source box goes where on a new picture shaped like the zone;
 * the browser (lib/photo-process, canvas) and the server (server/photo-tasks, sharp) draw it.
 */

import type { CtBounds } from "../types";
import type { CtProductPrint } from "../types/print";
import { shapeBounds } from "./geometry";

/** The zone and the safe areas inside it, canvas px. */
export interface FaceTargets {
  zone: CtBounds;
  faces: CtBounds[];
}

export interface FacePiece {
  /** Box in the source picture (px). */
  src: CtBounds;
  /** Where it goes on the new picture (px). */
  dst: CtBounds;
}

export interface FacePlacement {
  width: number;
  height: number;
  pieces: FacePiece[];
  /** The source had no transparency (a white backdrop): the new picture is filled white too. */
  opaque: boolean;
}

/** Figures fill their safe area up to this fraction (a hair inside the dashed line). */
const FILL = 0.97;
/** The new picture's longest side at most (a print zone is often 8 000 px wide; the AI picture ~1 800). */
const MAX_SIDE = 4096;

/** The khuôn's safe areas whose centre lies in the zone (canvas px); null when there are none. */
export function faceTargets(print: CtProductPrint | null | undefined, zone: CtBounds): FaceTargets | null {
  const faces = (print?.spec.safe ?? []).map(shapeBounds).filter((b) => {
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    return b.w > 0 && b.h > 0 && cx >= zone.x && cx <= zone.x + zone.w && cy >= zone.y && cy <= zone.y + zone.h;
  });
  return faces.length && zone.w > 0 && zone.h > 0 ? { zone, faces } : null;
}

type Pixels = Uint8Array | Uint8ClampedArray;

/** "Ink": a visible pixel that is not the flat white backdrop of an opaque picture. */
function inkTest(data: Pixels, w: number, h: number): { ink: (i: number) => boolean; opaque: boolean } {
  let opaque = true;
  for (let i = 3; i < w * h * 4; i += 16) {
    if (data[i] < 250) {
      opaque = false;
      break;
    }
  }
  return {
    opaque,
    ink: opaque ? (i) => data[i] < 238 || data[i + 1] < 238 || data[i + 2] < 238 : (i) => data[i + 3] > 24,
  };
}

/**
 * Where each figure goes. Figures are split along the line the safe areas run (left → right, or top → bottom) at the
 * widest empty gaps; with fewer gaps than needed the drawn width is cut in equal parts. null = nothing visible.
 */
export function placeFaces(data: Pixels, w: number, h: number, targets: FaceTargets): FacePlacement | null {
  const n = targets.faces.length;
  const { ink, opaque } = inkTest(data, w, h);
  const xs = targets.faces.map((f) => f.x + f.w / 2);
  const ys = targets.faces.map((f) => f.y + f.h / 2);
  const across = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
  const faces = [...targets.faces].sort((a, b) => (across ? a.x + a.w / 2 - (b.x + b.w / 2) : a.y + a.h / 2 - (b.y + b.h / 2)));

  // Ink per column (or row).
  const len = across ? w : h;
  const profile = new Uint32Array(len);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) if (ink((y * w + x) * 4)) profile[across ? x : y]++;
  }
  const NOISE = 2;
  let lo = 0;
  while (lo < len && profile[lo] <= NOISE) lo++;
  let hi = len - 1;
  while (hi > lo && profile[hi] <= NOISE) hi--;
  if (lo >= hi) return null;

  // Cuts: the n-1 widest empty runs inside, else equal parts.
  const gaps: Array<{ at: number; size: number }> = [];
  for (let i = lo; i <= hi; ) {
    if (profile[i] > NOISE) {
      i++;
      continue;
    }
    let j = i;
    while (j <= hi && profile[j] <= NOISE) j++;
    gaps.push({ at: (i + j) / 2, size: j - i });
    i = j;
  }
  const cuts =
    gaps.length >= n - 1
      ? gaps
          .sort((a, b) => b.size - a.size)
          .slice(0, n - 1)
          .map((g) => Math.round(g.at))
          .sort((a, b) => a - b)
      : Array.from({ length: n - 1 }, (_, i) => Math.round(lo + ((hi + 1 - lo) * (i + 1)) / n));
  const edges = [lo, ...cuts, hi + 1];

  // Each figure's box.
  const boxes: CtBounds[] = [];
  for (let k = 0; k < n; k++) {
    const a = edges[k];
    const b = edges[k + 1];
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -1;
    let y1 = -1;
    const [xa, xb, ya, yb] = across ? [a, b, 0, h] : [0, w, a, b];
    for (let y = ya; y < yb; y++) {
      for (let x = xa; x < xb; x++) {
        if (!ink((y * w + x) * 4)) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return null;
    boxes.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }

  // One scale for all (zone px per source px): the tightest figure fills its safe area.
  const s = Math.min(...boxes.map((b, k) => Math.min((faces[k].w * FILL) / b.w, (faces[k].h * FILL) / b.h)));
  const { zone } = targets;
  // Output px per zone px: figures drawn at their own size, unless that makes the picture too big.
  let m = 1 / s;
  const side = Math.max(zone.w, zone.h) * m;
  if (side > MAX_SIDE) m *= MAX_SIDE / side;
  const k = s * m; // output px per source px
  return {
    width: Math.max(1, Math.round(zone.w * m)),
    height: Math.max(1, Math.round(zone.h * m)),
    opaque,
    pieces: boxes.map((src, i) => {
      const f = faces[i];
      const dw = src.w * k;
      const dh = src.h * k;
      return { src, dst: { x: (f.x + f.w / 2 - zone.x) * m - dw / 2, y: (f.y + f.h / 2 - zone.y) * m - dh / 2, w: dw, h: dh } };
    }),
  };
}
