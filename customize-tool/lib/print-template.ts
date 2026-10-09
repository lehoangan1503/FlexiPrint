/**
 * Khuôn in (types/print.ts): normalising a stored spec, the starting templates, and the geometry the editor, the
 * storefront and the MCP share — the safe zone check, a size's sheet and zones.
 */

import type { CtBounds, CtPoint, CtShape } from "../types";
import type { CtPrintKind, CtPrintSize, CtPrintSpec, CtPrintZone } from "../types/print";
import { pointInShape, shapeBounds } from "./geometry";

const num = (v: unknown, fallback: number, lo = 0, hi = 100000): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

function isShape(v: unknown): v is CtShape {
  if (!v || typeof v !== "object") return false;
  const s = v as { type?: unknown; points?: unknown };
  if (s.type === "rect" || s.type === "ellipse") return true;
  return s.type === "polygon" && Array.isArray(s.points) && s.points.length >= 3;
}

const shapes = (v: unknown): CtShape[] => (Array.isArray(v) ? v.filter(isShape) : []);

export function normalizePrintSpec(raw: unknown): CtPrintSpec {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof CtPrintSpec, unknown>>;
  const width = Math.round(num(r.width, 1000, 16, 20000));
  const height = Math.round(num(r.height, 1000, 16, 20000));
  const zones: CtPrintZone[] = (Array.isArray(r.zones) ? r.zones : [])
    .map((z) => z as Partial<CtPrintZone>)
    .filter((z) => typeof z.id === "string" && isShape(z.shape))
    .map((z) => ({ id: z.id as string, name: str(z.name, z.id as string), shape: z.shape as CtShape }));
  const sizes: CtPrintSize[] = (Array.isArray(r.sizes) ? r.sizes : [])
    .map((s) => s as Partial<CtPrintSize>)
    .filter((s) => typeof s.id === "string" && typeof s.name === "string")
    .map((s) => ({
      id: s.id as string,
      name: s.name as string,
      width: Math.round(num(s.width, width, 16, 20000)),
      height: Math.round(num(s.height, height, 16, 20000)),
      ...(s.zones && typeof s.zones === "object" ? { zones: Object.fromEntries(Object.entries(s.zones).filter(([, v]) => isShape(v))) } : {}),
    }));
  const box = r.blankBox as Partial<CtBounds> | null | undefined;
  return {
    width,
    height,
    dpi: Math.round(num(r.dpi, 300, 30, 1200)),
    widthMm: num(r.widthMm, 0, 0, 10000),
    heightMm: num(r.heightMm, 0, 0, 10000),
    outline: isShape(r.outline) ? r.outline : null,
    bleed: num(r.bleed, 0, 0, 2000),
    safe: shapes(r.safe),
    cuts: shapes(r.cuts),
    zones,
    sizes,
    frameUrl: typeof r.frameUrl === "string" && r.frameUrl ? r.frameUrl : null,
    blankUrl: typeof r.blankUrl === "string" && r.blankUrl ? r.blankUrl : null,
    blankBox: box && typeof box.w === "number" && typeof box.h === "number" ? { x: num(box.x, 0, -1e5, 1e5), y: num(box.y, 0, -1e5, 1e5), w: num(box.w, 1, 1), h: num(box.h, 1, 1) } : null,
    notes: str(r.notes),
  };
}

export function isPrintKind(v: unknown): v is CtPrintKind {
  return v === "flat" || v === "cut" || v === "panels";
}

// ---- shapes ------------------------------------------------------------------------------------------------

export function scaleShape(shape: CtShape, kx: number, ky: number): CtShape {
  switch (shape.type) {
    case "rect":
      return { ...shape, x: shape.x * kx, y: shape.y * ky, w: shape.w * kx, h: shape.h * ky, radius: shape.radius * Math.min(kx, ky) };
    case "ellipse":
      return { ...shape, cx: shape.cx * kx, cy: shape.cy * ky, rx: shape.rx * kx, ry: shape.ry * ky };
    case "polygon":
      return { ...shape, points: shape.points.map((p) => ({ x: p.x * kx, y: p.y * ky })) };
  }
}

/** The shape shrunk by `d` px on every side (polygons: towards their centre, by their bounding box). */
export function insetShape(shape: CtShape, d: number): CtShape {
  switch (shape.type) {
    case "rect":
      return { ...shape, x: shape.x + d, y: shape.y + d, w: Math.max(1, shape.w - 2 * d), h: Math.max(1, shape.h - 2 * d), radius: Math.max(0, shape.radius - d) };
    case "ellipse":
      return { ...shape, rx: Math.max(1, shape.rx - d), ry: Math.max(1, shape.ry - d) };
    case "polygon": {
      const b = shapeBounds(shape);
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const kx = b.w > 2 * d ? (b.w - 2 * d) / b.w : 0.5;
      const ky = b.h > 2 * d ? (b.h - 2 * d) / b.h : 0.5;
      return { ...shape, points: shape.points.map((p) => ({ x: cx + (p.x - cx) * kx, y: cy + (p.y - cy) * ky })) };
    }
  }
}

/** Where main elements must stay: the safe zones, else the cut line inset by twice the bleed, else the sheet. */
export function safeShapes(spec: CtPrintSpec): CtShape[] {
  if (spec.safe.length) return spec.safe;
  if (spec.outline) return [insetShape(spec.outline, Math.max(spec.bleed * 2, Math.min(spec.width, spec.height) * 0.04))];
  if (spec.zones.length) return spec.zones.map((z) => z.shape);
  const m = Math.min(spec.width, spec.height) * 0.04;
  return [{ type: "rect", x: m, y: m, w: spec.width - 2 * m, h: spec.height - 2 * m, radius: 0 }];
}

function edgePoints(b: CtBounds): CtPoint[] {
  const pts: CtPoint[] = [];
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    pts.push({ x: b.x + b.w * t, y: b.y }, { x: b.x + b.w * t, y: b.y + b.h }, { x: b.x, y: b.y + b.h * t }, { x: b.x + b.w, y: b.y + b.h * t });
  }
  return pts;
}

/** A box lies inside the safe zone: every point of its edge inside ONE safe shape, none in a cut. */
export function boundsInSafe(spec: CtPrintSpec, b: CtBounds): boolean {
  const pts = edgePoints(b);
  if (spec.cuts.some((c) => pts.some((p) => pointInShape(p, c)))) return false;
  return safeShapes(spec).some((s) => pts.every((p) => pointInShape(p, s)));
}

/** The sheet + zone shapes of one size (null / unknown = the base). */
export function printSize(spec: CtPrintSpec, sizeId: string | null | undefined): { id: string | null; name: string; width: number; height: number; zones: Record<string, CtShape> } {
  const size = sizeId ? spec.sizes.find((s) => s.id === sizeId || s.name.toLowerCase() === sizeId.toLowerCase()) : undefined;
  const base = Object.fromEntries(spec.zones.map((z) => [z.id, z.shape]));
  if (!size) return { id: null, name: "", width: spec.width, height: spec.height, zones: base };
  const kx = size.width / spec.width;
  const ky = size.height / spec.height;
  const zones = Object.fromEntries(spec.zones.map((z) => [z.id, size.zones?.[z.id] ?? scaleShape(z.shape, kx, ky)]));
  return { id: size.id, name: size.name, width: size.width, height: size.height, zones };
}

// ---- composition hint ---------------------------------------------------------------------------------------

/**
 * One sentence for an image model on how a picture must sit on this piece (v2 brief → master prompt): the safe zone
 * as a share of the picture, the hole to keep clear. English, the model reads it.
 */
export function layoutHint(kind: CtPrintKind, spec: CtPrintSpec): string {
  if (kind === "cut") return "die-cut along the artwork's own outline: one compact connected shape, no thin parts sticking out, nothing floating apart";
  if (kind === "panels") return "printed on a sewn garment: the design is made of patterns that fill named areas, no single picture spans the seams";
  const safe = safeShapes(spec)[0];
  const b = safe ? shapeBounds(safe) : { x: 0, y: 0, w: spec.width, h: spec.height };
  const pct = Math.round((Math.min(b.w / spec.width, b.h / spec.height) || 1) * 100);
  const round = spec.outline?.type === "ellipse";
  const parts = [
    round
      ? `a round piece: every character and any text stays inside a centred circle about ${pct}% of the picture's width; the circle's rim is cut, so nothing important near it`
      : `a ${spec.width >= spec.height ? (spec.width === spec.height ? "square" : "landscape") : "portrait"} piece: everything stays inside the central ${pct}% of the picture, a clear margin all around`,
  ];
  const top = spec.cuts.find((c) => shapeBounds(c).y < spec.height * 0.3);
  if (top) parts.push("keep the top centre clear (a hanging hole is punched there)");
  return parts.join("; ");
}

// ---- starting templates ------------------------------------------------------------------------------------

const circle = (cx: number, cy: number, r: number): CtShape => ({ type: "ellipse", cx, cy, rx: r, ry: r });
const poly = (pts: Array<[number, number]>): CtShape => ({ type: "polygon", points: pts.map(([x, y]) => ({ x, y })) });
const mirror = (pts: Array<[number, number]>, w: number): Array<[number, number]> => pts.map(([x, y]) => [w - x, y] as [number, number]).reverse();

function base(width: number, height: number, mm: [number, number], patch: Partial<CtPrintSpec>): CtPrintSpec {
  return normalizePrintSpec({ width, height, dpi: Math.round((width / mm[0]) * 25.4), widthMm: mm[0], heightMm: mm[1], bleed: 0, safe: [], cuts: [], zones: [], sizes: [], frameUrl: null, blankUrl: null, blankBox: null, notes: "", outline: null, ...patch });
}

/** Front of a pair of all-over-print trousers laid flat (M), in zones a layer can fill; a demo grade S…XL. */
function trousers(): CtPrintSpec {
  const W = 2400;
  const left = {
    skin: [[530, 520], [940, 560], [1200, 1180], [1180, 1260], [560, 1120]] as Array<[number, number]>,
    leg: [[560, 1120], [1180, 1260], [1190, 1320], [1150, 2760], [700, 2760], [600, 1900], [540, 1400]] as Array<[number, number]>,
    cuff: [[700, 2760], [1150, 2760], [1150, 2960], [700, 2960]] as Array<[number, number]>,
  };
  return base(W, 3000, [610, 762], {
    zones: [
      { id: "waist", name: "Cạp", shape: poly([[560, 120], [1840, 120], [1850, 300], [550, 300]]) },
      { id: "brief", name: "Quần lót", shape: poly([[550, 300], [1850, 300], [1870, 520], [1460, 560], [1200, 1180], [940, 560], [530, 520]]) },
      { id: "skin-l", name: "Da trái", shape: poly(left.skin) },
      { id: "skin-r", name: "Da phải", shape: poly(mirror(left.skin, W)) },
      { id: "leg-l", name: "Ống trái", shape: poly(left.leg) },
      { id: "leg-r", name: "Ống phải", shape: poly(mirror(left.leg, W)) },
      { id: "cuff-l", name: "Gấu trái", shape: poly(left.cuff) },
      { id: "cuff-r", name: "Gấu phải", shape: poly(mirror(left.cuff, W)) },
    ],
    sizes: [
      { id: "S", name: "S", width: 2280, height: 2850 },
      { id: "M", name: "M", width: 2400, height: 3000 },
      { id: "L", name: "L", width: 2520, height: 3150 },
      { id: "XL", name: "XL", width: 2640, height: 3300 },
    ],
    notes: "Mẫu thử: mặt trước quần trải phẳng, vùng vẽ gần đúng. Thay bằng rập thật của xưởng (từng mảnh, từng cỡ) khi có.",
  });
}

export const PRINT_PRESETS: Array<{ name: string; kind: CtPrintKind; spec: CtPrintSpec }> = [
  {
    name: "Circle Ceramic Ornament 3\"",
    kind: "flat",
    spec: base(1000, 1000, [76, 76], {
      outline: circle(500, 500, 474),
      bleed: 14,
      safe: [circle(500, 500, 432)],
      cuts: [circle(500, 158, 27)],
      notes: "Artwork phủ kín hình tròn ngoài; hình, chữ, vật chính nằm trong vòng nét đứt; giữ trống lỗ treo.",
    }),
  },
  {
    name: "Square Tile 4\"",
    kind: "flat",
    spec: base(1200, 1200, [102, 102], {
      outline: { type: "rect", x: 12, y: 12, w: 1176, h: 1176, radius: 60 },
      bleed: 12,
      safe: [{ type: "rect", x: 72, y: 72, w: 1056, h: 1056, radius: 30 }],
    }),
  },
  {
    name: "Poster 8×12\"",
    kind: "flat",
    spec: base(2400, 3600, [203, 305], {
      outline: { type: "rect", x: 38, y: 38, w: 2324, h: 3524, radius: 0 },
      bleed: 38,
      safe: [{ type: "rect", x: 150, y: 150, w: 2100, h: 3300, radius: 0 }],
    }),
  },
  {
    name: "Sticker / acrylic cắt viền",
    kind: "cut",
    spec: base(2000, 2000, [100, 100], { bleed: 24, notes: "Đường cắt = viền hình (alpha) + 24 px; không có khung cố định." }),
  },
  { name: "Quần in toàn thân (mặt trước, mẫu thử)", kind: "panels", spec: trousers() },
];
