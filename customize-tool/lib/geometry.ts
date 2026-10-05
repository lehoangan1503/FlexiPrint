/**
 * Pure geometry helpers for regions. No DOM access — safe on server and client.
 */

import type { CtBounds, CtPhotoConfig, CtPhotoFrame, CtPoint, CtShape, CtTransform } from "../types";

export const IDENTITY_TRANSFORM: CtTransform = { offsetX: 0, offsetY: 0, scale: 1, rotation: 0 };

export const IDENTITY_PHOTO_FRAME: CtPhotoFrame = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0, auto: false, tilt: null, padding: 0, enabled: true };

/** A box turned by `rotation` degrees (clockwise) about its centre, in main-asset px. */
export interface CtOrientedBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
  rotation: number;
}

/** Convex hull, counter-clockwise (monotone chain). */
function convexHull(points: CtPoint[]): CtPoint[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: CtPoint, a: CtPoint, b: CtPoint) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: CtPoint[] = [];
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
    lower.push(pt);
  }
  const upper: CtPoint[] = [];
  for (const pt of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
    upper.push(pt);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * The zone's outline as a turned box: its tilt and its widest extent along
 * that tilt both ways. Rects / ellipses are upright. A polygon gets its
 * smallest enclosing rectangle (one side always lies on a hull edge); near
 * ties (≤ 3 % more area — an octagon is as small upright as at 45°) go to the
 * least turned one, so a roughly upright outline stays upright.
 */
export function orientedBox(shape: CtShape): CtOrientedBox {
  const b = shapeBounds(shape);
  const upright: CtOrientedBox = { cx: b.x + b.w / 2, cy: b.y + b.h / 2, w: b.w, h: b.h, rotation: 0 };
  if (shape.type !== "polygon") return upright;
  const hull = convexHull(shape.points);
  if (hull.length < 3) return upright;
  const candidates: Array<CtOrientedBox & { area: number }> = [{ ...upright, area: b.w * b.h }];
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const c = hull[(i + 1) % hull.length];
    // Edge angle folded into (-45°, 45°]: the box's "width" axis is the one closest to horizontal.
    let t = Math.atan2(c.y - a.y, c.x - a.x);
    t -= Math.round(t / (Math.PI / 2)) * (Math.PI / 2);
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of hull) {
      const u = p.x * cos + p.y * sin;
      const v = -p.x * sin + p.y * cos;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    const um = (u0 + u1) / 2;
    const vm = (v0 + v1) / 2;
    candidates.push({ cx: um * cos - vm * sin, cy: um * sin + vm * cos, w: u1 - u0, h: v1 - v0, rotation: (t * 180) / Math.PI, area: (u1 - u0) * (v1 - v0) });
  }
  const min = Math.min(...candidates.map((c) => c.area));
  const best = candidates.filter((c) => c.area <= min * 1.03).sort((x, y) => Math.abs(x.rotation) - Math.abs(y.rotation))[0];
  // Under a degree is a hand-drawn wobble, not a tilt.
  if (Math.abs(best.rotation) < 1) return upright;
  return { cx: best.cx, cy: best.cy, w: best.w, h: best.h, rotation: Math.round(best.rotation * 10) / 10 };
}

/** Points along a shape's outline (a rect's corners, an ellipse sampled), in main-asset px. */
export function outlinePoints(shape: CtShape): CtPoint[] {
  switch (shape.type) {
    case "rect":
      return [
        { x: shape.x, y: shape.y },
        { x: shape.x + shape.w, y: shape.y },
        { x: shape.x + shape.w, y: shape.y + shape.h },
        { x: shape.x, y: shape.y + shape.h },
      ];
    case "ellipse":
      return Array.from({ length: 64 }, (_, i) => {
        const t = (i / 64) * Math.PI * 2;
        return { x: shape.cx + shape.rx * Math.cos(t), y: shape.cy + shape.ry * Math.sin(t) };
      });
    case "polygon":
      return shape.points;
  }
}

/** Smallest circle around `points` (Welzl, iterative — expected linear time). */
export function enclosingCircle(points: CtPoint[]): { cx: number; cy: number; r: number } {
  const p = [...points];
  // Deterministic shuffle (the same zone always gives the same circle).
  for (let i = p.length - 1; i > 0; i--) {
    const j = (i * 7919 + 13) % (i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }
  const inside = (c: { cx: number; cy: number; r: number }, q: CtPoint) => Math.hypot(q.x - c.cx, q.y - c.cy) <= c.r * (1 + 1e-9) + 1e-7;
  const two = (a: CtPoint, b: CtPoint) => ({ cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, r: Math.hypot(a.x - b.x, a.y - b.y) / 2 });
  const three = (a: CtPoint, b: CtPoint, c: CtPoint) => {
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) < 1e-12) {
      // Collinear: the circle on the farthest pair.
      const pairs = [two(a, b), two(a, c), two(b, c)];
      return pairs.reduce((m, q) => (q.r > m.r ? q : m));
    }
    const a2 = a.x * a.x + a.y * a.y;
    const b2 = b.x * b.x + b.y * b.y;
    const c2 = c.x * c.x + c.y * c.y;
    const cx = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
    const cy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
    return { cx, cy, r: Math.hypot(a.x - cx, a.y - cy) };
  };
  if (p.length === 0) return { cx: 0, cy: 0, r: 0 };
  let c = { cx: p[0].x, cy: p[0].y, r: 0 };
  for (let i = 1; i < p.length; i++) {
    if (inside(c, p[i])) continue;
    c = { cx: p[i].x, cy: p[i].y, r: 0 };
    for (let j = 0; j < i; j++) {
      if (inside(c, p[j])) continue;
      c = two(p[i], p[j]);
      for (let k = 0; k < j; k++) if (!inside(c, p[k])) c = three(p[i], p[j], p[k]);
    }
  }
  return c;
}

/** The tilt an auto frame turns by: the zone's own (CtPhotoFrame.tilt) or read from its outline. */
export function zoneTilt(shape: CtShape, frame?: Pick<CtPhotoFrame, "tilt"> | null): number {
  const t = frame?.tilt;
  return typeof t === "number" && Number.isFinite(t) ? t : orientedBox(shape).rotation;
}

/** Auto frame: how much the photo's square outgrows the zone's enclosing circle, per side (fraction of the side). */
export const AUTO_FRAME_GROW = 0.15;
/** Auto frame: empty margin around the photo, as a fraction of the photo's shorter side. */
export const AUTO_FRAME_MARGIN = 0.06;

/**
 * The auto child frame (CtPhotoFrame.auto) for a photo of aspect `aspect`
 * (w / h; 1 = square, before a photo is in):
 *   1. the zone's tilt (`tilt`, else read from its outline), and the smallest
 *      circle around its outline measured in that tilted frame — its centre
 *      is where the frame goes, its square (side = diameter) holds any outline
 *   2. that square grown AUTO_FRAME_GROW on every side: the photo (a Face
 *      photo is the upright, trimmed head) is contain-fitted into it, so its
 *      rounded outline still covers every corner of the zone
 *   3. AUTO_FRAME_MARGIN of empty space around the photo, so the frame never
 *      sits right on the face's edge
 * The frame turns by the tilt: an upright face ends up at the zone's angle.
 */
export function autoPhotoFrame(shape: CtShape, aspect: number, tilt?: number | null): CtPhotoFrame {
  const b = shapeBounds(shape);
  const deg = typeof tilt === "number" && Number.isFinite(tilt) ? tilt : orientedBox(shape).rotation;
  const t = (deg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  // The outline in the zone's own (tilted) axes.
  const local = outlinePoints(shape).map((p) => ({ x: p.x * cos + p.y * sin, y: -p.x * sin + p.y * cos }));
  const circle = enclosingCircle(local);
  const side = Math.max(1, 2 * circle.r) * (1 + 2 * AUTO_FRAME_GROW);
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  const pw = a >= 1 ? side : side * a;
  const ph = a >= 1 ? side / a : side;
  const m = AUTO_FRAME_MARGIN * Math.min(pw, ph);
  const w = pw + 2 * m;
  const h = ph + 2 * m;
  const cx = circle.cx * cos - circle.cy * sin;
  const cy = circle.cx * sin + circle.cy * cos;
  const bw = Math.max(1, b.w);
  const bh = Math.max(1, b.h);
  return {
    offsetX: (cx - (b.x + b.w / 2)) / bw,
    offsetY: (cy - (b.y + b.h / 2)) / bh,
    scaleX: w / bw,
    scaleY: h / bh,
    rotation: Math.round(deg * 10) / 10,
    auto: true,
    tilt: typeof tilt === "number" && Number.isFinite(tilt) ? tilt : null,
    padding: m / Math.min(w, h),
    enabled: true,
  };
}

/** The frame a photo zone actually uses: the stored one, worked out for this photo when `auto`, the zone's box when there is none. */
export function resolvePhotoFrame(photo: CtPhotoConfig, shape: CtShape, photoSize?: { width: number; height: number } | null): CtPhotoFrame {
  const f = photo.frame ?? IDENTITY_PHOTO_FRAME;
  if (f.enabled === false) return { ...IDENTITY_PHOTO_FRAME, enabled: false };
  if (!f.auto) return f;
  return autoPhotoFrame(shape, photoSize && photoSize.height > 0 ? photoSize.width / photoSize.height : 1, f.tilt);
}

/** Two frames that place the photo identically (frames are rebuilt on every normalize, so compare values). */
export function sameFrame(a: CtPhotoFrame | undefined, b: CtPhotoFrame | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.offsetX === b.offsetX &&
    a.offsetY === b.offsetY &&
    a.scaleX === b.scaleX &&
    a.scaleY === b.scaleY &&
    a.rotation === b.rotation &&
    a.auto === b.auto &&
    (a.tilt ?? null) === (b.tilt ?? null) &&
    (a.padding ?? 0) === (b.padding ?? 0) &&
    a.enabled === b.enabled
  );
}

/** A photo zone's child frame (CtPhotoFrame) in main-asset px: centre, size, rotation (degrees). */
export function photoFrameBox(bounds: CtBounds, f: CtPhotoFrame): { cx: number; cy: number; w: number; h: number; rotation: number; margin: number } {
  const w = bounds.w * f.scaleX;
  const h = bounds.h * f.scaleY;
  return {
    cx: bounds.x + bounds.w / 2 + f.offsetX * bounds.w,
    cy: bounds.y + bounds.h / 2 + f.offsetY * bounds.h,
    w,
    h,
    rotation: f.rotation,
    /** px of empty margin inside the frame around the photo (CtPhotoFrame.padding). */
    margin: Math.max(0, Math.min(0.45, f.padding ?? 0)) * Math.min(w, h),
  };
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function shapeBounds(shape: CtShape): CtBounds {
  switch (shape.type) {
    case "rect":
      return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
    case "ellipse":
      return { x: shape.cx - shape.rx, y: shape.cy - shape.ry, w: shape.rx * 2, h: shape.ry * 2 };
    case "polygon": {
      if (shape.points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of shape.points) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
  }
}

/** Move a shape by dx/dy. */
export function translateShape(shape: CtShape, dx: number, dy: number): CtShape {
  switch (shape.type) {
    case "rect":
      return { ...shape, x: shape.x + dx, y: shape.y + dy };
    case "ellipse":
      return { ...shape, cx: shape.cx + dx, cy: shape.cy + dy };
    case "polygon":
      return { ...shape, points: shape.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  }
}

/**
 * Map a shape from its old bounds onto new bounds (used by the bbox resize
 * handles). Polygons scale their points, so the outline keeps its proportions.
 */
export function fitShapeToBounds(shape: CtShape, next: CtBounds): CtShape {
  const w = Math.max(1, next.w);
  const h = Math.max(1, next.h);
  switch (shape.type) {
    case "rect":
      return { ...shape, x: next.x, y: next.y, w, h };
    case "ellipse":
      return { ...shape, cx: next.x + w / 2, cy: next.y + h / 2, rx: w / 2, ry: h / 2 };
    case "polygon": {
      const b = shapeBounds(shape);
      const sx = b.w > 0 ? w / b.w : 1;
      const sy = b.h > 0 ? h / b.h : 1;
      return {
        ...shape,
        points: shape.points.map((p) => ({ x: next.x + (p.x - b.x) * sx, y: next.y + (p.y - b.y) * sy })),
      };
    }
  }
}

export function pointInPolygon(pt: CtPoint, points: CtPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    const intersects = a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function pointInShape(pt: CtPoint, shape: CtShape): boolean {
  switch (shape.type) {
    case "rect":
      return pt.x >= shape.x && pt.x <= shape.x + shape.w && pt.y >= shape.y && pt.y <= shape.y + shape.h;
    case "ellipse": {
      if (shape.rx <= 0 || shape.ry <= 0) return false;
      const nx = (pt.x - shape.cx) / shape.rx;
      const ny = (pt.y - shape.cy) / shape.ry;
      return nx * nx + ny * ny <= 1;
    }
    case "polygon":
      return pointInPolygon(pt, shape.points);
  }
}

/** SVG path data for a shape (editor overlay). */
export function shapeToSvgPath(shape: CtShape): string {
  switch (shape.type) {
    case "rect": {
      const r = clamp(shape.radius, 0, Math.min(shape.w, shape.h) / 2);
      const { x, y, w, h } = shape;
      if (r <= 0) return `M${x},${y}h${w}v${h}h${-w}Z`;
      return `M${x + r},${y}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${-(w - 2 * r)}a${r},${r} 0 0 1 ${-r},${-r}v${-(h - 2 * r)}a${r},${r} 0 0 1 ${r},${-r}Z`;
    }
    case "ellipse": {
      const { cx, cy, rx, ry } = shape;
      return `M${cx - rx},${cy}a${rx},${ry} 0 1 0 ${rx * 2},0a${rx},${ry} 0 1 0 ${-rx * 2},0Z`;
    }
    case "polygon":
      if (shape.points.length === 0) return "";
      return `M${shape.points.map((p) => `${p.x},${p.y}`).join("L")}Z`;
  }
}

/**
 * Rectangle an item image occupies: contain-fit into the region bbox, then the
 * item's own scale/offset. Rotation is applied around the returned centre.
 */
export function itemPlacement(
  bounds: CtBounds,
  imgW: number,
  imgH: number,
  t: CtTransform,
  fit: "contain" | "cover" = "contain"
): { cx: number; cy: number; w: number; h: number; rotation: number } {
  const ratio = imgW > 0 && imgH > 0 ? imgW / imgH : 1;
  const boxRatio = bounds.h > 0 ? bounds.w / bounds.h : 1;
  const widthLimited = fit === "contain" ? ratio > boxRatio : ratio < boxRatio;
  let w = widthLimited ? bounds.w : bounds.h * ratio;
  let h = widthLimited ? bounds.w / ratio : bounds.h;
  w *= t.scale;
  h *= t.scale;
  return {
    cx: bounds.x + bounds.w / 2 + t.offsetX * bounds.w,
    cy: bounds.y + bounds.h / 2 + t.offsetY * bounds.h,
    w,
    h,
    rotation: t.rotation,
  };
}

export function newId(): string {
  return crypto.randomUUID();
}

/** Fractions of the main artwork that act as an invisible snap grid (edges, quarters, centre). */
export const SNAP_FRACTIONS = [0, 0.25, 0.5, 0.75, 1];

/**
 * Closest snap of any `features` coordinate (a frame's edges / centre) onto
 * any `lines` coordinate within `threshold`. `delta` is what to add to the
 * features; `line` is the guide to draw.
 */
export function snapAxis(features: number[], lines: number[], threshold: number): { delta: number; line: number } | null {
  let best: { delta: number; line: number } | null = null;
  for (const f of features) {
    for (const l of lines) {
      const d = l - f;
      if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, line: l };
    }
  }
  return best;
}
