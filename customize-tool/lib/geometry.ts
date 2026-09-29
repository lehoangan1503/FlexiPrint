/**
 * Pure geometry helpers for regions. No DOM access — safe on server and client.
 */

import type { CtBounds, CtPoint, CtShape, CtTransform } from "../types";

export const IDENTITY_TRANSFORM: CtTransform = { offsetX: 0, offsetY: 0, scale: 1, rotation: 0 };

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
