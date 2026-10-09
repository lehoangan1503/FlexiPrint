/**
 * Khuôn in (types/print.ts): normalising a stored spec, the starting templates, and the geometry the editor, the
 * storefront and the MCP share — the safe zone check, a size's sheet and zones.
 */

import type { CtBounds, CtPoint, CtShape } from "../types";
import type { CtPrintBlank, CtPrintFace, CtPrintHistoryEntry, CtPrintKind, CtPrintSize, CtPrintSpec, CtPrintZone } from "../types/print";
import { pointInShape, shapeBounds } from "./geometry";

const num = (v: unknown, fallback: number, lo = 0, hi = 100000): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const urlOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

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
  const blankBox: CtBounds | null = box && typeof box.w === "number" && typeof box.h === "number" ? { x: num(box.x, 0, -1e5, 1e5), y: num(box.y, 0, -1e5, 1e5), w: num(box.w, 1, 1), h: num(box.h, 1, 1) } : null;
  const blankUrl = typeof r.blankUrl === "string" && r.blankUrl ? r.blankUrl : null;
  const blanks: CtPrintBlank[] = (Array.isArray(r.blanks) ? r.blanks : [])
    .map((b) => b as Partial<CtPrintBlank>)
    .filter((b) => typeof b.url === "string" && b.url && b.box && typeof b.box.w === "number")
    .map((b, i) => ({
      id: typeof b.id === "string" ? b.id : `blank-${i}`,
      name: str(b.name, "Phôi"),
      url: b.url as string,
      width: Math.round(num(b.width, 1000, 1, 20000)),
      height: Math.round(num(b.height, 1000, 1, 20000)),
      box: { x: num(b.box?.x, 0, -1e5, 1e5), y: num(b.box?.y, 0, -1e5, 1e5), w: num(b.box?.w, 1, 1), h: num(b.box?.h, 1, 1) },
      ai: b.ai === true,
    }));
  const faces: CtPrintFace[] = (Array.isArray(r.faces) ? r.faces : [])
    .map((f) => f as Partial<CtPrintFace>)
    .filter((f) => typeof f.id === "string")
    .map((f) => ({ id: f.id as string, name: str(f.name, "Mặt in"), imageUrl: urlOrNull(f.imageUrl), maskUrl: urlOrNull(f.maskUrl), guideUrl: urlOrNull(f.guideUrl) }));
  const history: CtPrintHistoryEntry[] = (Array.isArray(r.history) ? r.history : [])
    .map((h) => h as Partial<CtPrintHistoryEntry>)
    .filter((h) => typeof h.prompt === "string")
    .map((h) => ({ at: str(h.at), prompt: h.prompt as string, refs: Array.isArray(h.refs) ? h.refs.filter((u): u is string => typeof u === "string") : [] }))
    .slice(-20);
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
    blankUrl,
    blankBox,
    notes: str(r.notes),
    faces,
    mirror: r.mirror === true,
    // The legacy single photo is the first blank.
    blanks: blanks.length || !blankUrl || !blankBox ? blanks : [{ id: "legacy", name: "Phôi", url: blankUrl, width: Math.round(blankBox.x * 2 + blankBox.w), height: Math.round(blankBox.y * 2 + blankBox.h), box: blankBox, ai: false }],
    history,
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

/**
 * A closed curve through `pts` (Catmull-Rom, `steps` points per span) — smooth seams from a few control points; a
 * point in `corners` stays a sharp corner (a span between two corners is straight: a hem).
 */
function smooth(pts: Array<[number, number]>, steps = 6, corners: Array<[number, number]> = []): Array<[number, number]> {
  const n = pts.length;
  const sharp = (p: [number, number]) => corners.some((c) => c[0] === p[0] && c[1] === p[1]);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const [p1, p2] = [pts[i], pts[(i + 1) % n]];
    const p0 = sharp(p1) ? p1 : pts[(i - 1 + n) % n];
    const p3 = sharp(p2) ? p2 : pts[(i + 2) % n];
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const at = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([Math.round(at(p0[0], p1[0], p2[0], p3[0])), Math.round(at(p0[1], p1[1], p2[1], p3[1]))]);
    }
  }
  return out;
}

/** The polygon moved `d` px inwards along each corner's bisector (a seam allowance; fine for gentle curves). */
function insetPolygon(pts: Array<[number, number]>, d: number): Array<[number, number]> {
  const n = pts.length;
  let area = 0;
  for (let i = 0; i < n; i++) area += pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1];
  const inward = area > 0 ? -1 : 1;
  return pts.map((p, i) => {
    const a = pts[(i - 1 + n) % n];
    const b = pts[(i + 1) % n];
    const n1 = norm([a[1] - p[1], p[0] - a[0]]);
    const n2 = norm([p[1] - b[1], b[0] - p[0]]);
    const m = norm([n1[0] + n2[0], n1[1] + n2[1]]);
    const k = d / Math.max(0.35, m[0] * n1[0] + m[1] * n1[1]);
    return [Math.round(p[0] - inward * m[0] * k), Math.round(p[1] - inward * m[1] * k)] as [number, number];
  });
}

function norm(v: [number, number]): [number, number] {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}

/**
 * One face of all-over-print joggers laid flat (asked 2026-10-10, the "chaps" Christmas trousers): ONE printed
 * piece like an ornament — cut line + safe zone, no panels; the design is the v2 master's layers (thong, skin,
 * leg pattern) over the whole piece. The rib waistband and ankle cuffs are not printed, so the sheet starts under
 * the waistband and ends above the cuffs. ~60 × 107 cm at 150 dpi (adult M); the back has the higher rise and the
 * fuller seat.
 */
function joggerFace(back: boolean): CtPrintSpec {
  const W = 3600;
  const H = 6400;
  const top = back ? 150 : 190;
  // Left half, waist centre → ankle → crotch, then mirrored.
  const crotch = back ? 2010 : 1930;
  const left: Array<[number, number]> = [
    [1800, back ? 90 : top],
    [1150, back ? 115 : top],
    [600, top + 10],
    [470, 650],
    back ? [345, 1250] : [385, 1250],
    [400, 1950],
    [500, 3300],
    [660, 4800],
    [840, 6240],
    [1500, 6240],
    [1570, 4800],
    [1630, 3300],
    [1680, crotch + 280],
    [1730, crotch + 90],
  ];
  const right = mirror(left.slice(1), W);
  const control = [...left, [1800, crotch] as [number, number], ...right];
  const hems = control.filter(([, y]) => y === 6240);
  const outline = smooth(control, 5, hems);
  return base(W, H, [610, 1084], {
    outline: poly(outline),
    bleed: 60,
    safe: [poly(insetPolygon(outline, 150))],
    notes: back
      ? "Mặt sau quần jogger in toàn thân (cỡ M): artwork phủ kín đường cắt + 1 cm; hình, chữ chính trong nét đứt (cách đường may 2.5 cm). Cạp và bo gấu không in."
      : "Mặt trước quần jogger in toàn thân (cỡ M): artwork phủ kín đường cắt + 1 cm; hình, chữ chính trong nét đứt (cách đường may 2.5 cm). Cạp và bo gấu không in.",
  });
}

export const PRINT_PRESETS: Array<{ name: string; kind: CtPrintKind; spec: CtPrintSpec }> = [
  {
    name: "Circle Ceramic Ornament 3\"",
    kind: "flat",
    // The piece IS the sheet (asked 2026-10-10): the edit frame, the print file and the khuôn are all 1000 × 1000.
    spec: base(1000, 1000, [76, 76], {
      outline: circle(500, 500, 500),
      bleed: 0,
      safe: [circle(500, 500, 456)],
      cuts: [circle(500, 139, 28.5)],
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
  { name: "Quần jogger in toàn thân — mặt trước", kind: "flat", spec: joggerFace(false) },
  { name: "Quần jogger in toàn thân — mặt sau", kind: "flat", spec: joggerFace(true) },
];
