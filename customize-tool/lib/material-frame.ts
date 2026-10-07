/**
 * Khuôn vật liệu — a product whose shape is fixed (a round ornament, a pair of trousers): the clipart is a flat
 * picture (a full square background), and one custom layer's outline is the product's shape (minus the parts cut
 * out of it, a hanging hole). The print file is cut to it, and a vật liệu made "theo khuôn" is the clipart cut to
 * it — the same khuôn gives every clipart a vật liệu of exactly the same size.
 *
 * Products cut along the clipart's own outline (acrylic die-cut) have no khuôn: their vật liệu follows the alpha.
 *
 * Pure — the compositor, the editor and the server share it.
 */

import type { CtBounds, CtFrameCut, CtMainFrame, CtPoint, CtRegion, CtShape } from "../types";
import { outlinePoints, shapeBounds } from "./geometry";

/** Longest side of a khuôn's vật liệu input (before the material's padding): the same for every clipart. */
export const FRAME_CUT_SIDE = 1536;

export function isMaterialFrame(r: CtRegion): boolean {
  return r.kind === "image" && r.config?.materialFrame === true;
}

/**
 * The khuôn version `mainId` is cut to: its own, else the default version's (one khuôn drawn on the default
 * version serves every version of the product). Null = no khuôn (the vật liệu follows the clipart's alpha).
 */
export function frameRegionFor(regions: CtRegion[], mainId: string | null | undefined, defaultMainId: string | null | undefined): CtRegion | null {
  const frames = regions.filter(isMaterialFrame);
  const of = (id: string | null | undefined) => (id ? frames.find((r) => r.config.mainId === id) : undefined);
  return of(mainId) ?? of(defaultMainId) ?? frames.find((r) => !r.config.mainId) ?? null;
}

/** An outline as points (rounded corners and ellipses made of segments) — what a canvas / PIL polygon draws. */
export function shapePolygon(shape: CtShape): CtPoint[] {
  if (shape.type !== "rect" || shape.radius <= 0) return outlinePoints(shape);
  const r = Math.min(shape.radius, shape.w / 2, shape.h / 2);
  const corners: Array<[number, number, number]> = [
    [shape.x + shape.w - r, shape.y + r, -90],
    [shape.x + shape.w - r, shape.y + shape.h - r, 0],
    [shape.x + r, shape.y + shape.h - r, 90],
    [shape.x + r, shape.y + r, 180],
  ];
  return corners.flatMap(([cx, cy, from]) =>
    Array.from({ length: 9 }, (_, i) => {
      const t = ((from + (i * 90) / 8) * Math.PI) / 180;
      return { x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) };
    }),
  );
}

/** Trace the khuôn (minus its cuts) as the current canvas path — fill / clip it with "evenodd". */
export function traceFrame(ctx: CanvasRenderingContext2D | Path2D, frame: CtRegion): void {
  for (const s of [frame.shape, ...(frame.config.cuts ?? [])]) {
    const pts = shapePolygon(s);
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
  }
}

/** SVG path of the khuôn with its cuts as holes (fill-rule evenodd). */
export function frameSvgPath(frame: CtRegion): string {
  return [frame.shape, ...(frame.config.cuts ?? [])]
    .map((s) => shapePolygon(s))
    .filter((pts) => pts.length >= 3)
    .map((pts) => `M${pts.map((p) => `${p.x},${p.y}`).join("L")}Z`)
    .join("");
}

/**
 * The clipart of a version (in `art`, its frame on the artboard) cut to `frame`: the canvas is the khuôn's box at
 * FRAME_CUT_SIDE — the same for every clipart cut to it.
 */
export function frameCut(frame: CtRegion, art: CtMainFrame): CtFrameCut {
  const b = shapeBounds(frame.shape);
  const k = FRAME_CUT_SIDE / Math.max(1, b.w, b.h);
  const at = (p: CtPoint): [number, number] => [round2((p.x - b.x) * k), round2((p.y - b.y) * k)];
  return {
    w: Math.max(1, Math.round(b.w * k)),
    h: Math.max(1, Math.round(b.h * k)),
    art: { x: round2((art.x - b.x) * k), y: round2((art.y - b.y) * k), w: round2(art.w * k), h: round2(art.h * k), rotation: art.rotation },
    clip: shapePolygon(frame.shape).map(at),
    cuts: (frame.config.cuts ?? []).map((s) => shapePolygon(s).map(at)).filter((c) => c.length >= 3),
  };
}

/** The khuôn outline relative to its box (0..1), for a small preview. */
export function frameOutline(frame: CtRegion): [number, number][] {
  const b = shapeBounds(frame.shape);
  return shapePolygon(frame.shape).map((p) => [round4((p.x - b.x) / Math.max(1, b.w)), round4((p.y - b.y) / Math.max(1, b.h))]);
}

/** A rendition made theo khuôn: the box it is drawn over — the khuôn's as it is now, else as it was. */
export function renditionFrameBox(regions: CtRegion[], frame: { regionId: string; box: CtBounds }): CtBounds {
  const r = regions.find((x) => x.id === frame.regionId);
  return r ? shapeBounds(r.shape) : frame.box;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round4 = (v: number) => Math.round(v * 10000) / 10000;
