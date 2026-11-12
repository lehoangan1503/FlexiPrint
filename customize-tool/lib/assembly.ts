/**
 * A print sheet sewn from pieces (2026-11-12, asked on the Printbelle Wearable Hooded Blanket: "preview hiện cái đầu ở
 * trên nón là đúng, nhưng file in gửi xuống sẽ sai — phần artwork đó phải nằm ở bản vẽ của nón"):
 *
 *   design / preview   the product as it is seen: the hood above the blanket's top edge, the blanket below
 *   print sheet        the factory's khuôn: the blanket's body (a big rect), the 2 hood halves + 2 pockets under it
 *
 * Each piece (CtSewnPiece) prints the part of the design the preview shows on it (`from`) into its place on the sheet
 * (`to`), one scale, clipped to its outline. What no piece takes (pockets, the spare area) keeps the design as it lies.
 * The base holds it in the khuôn's sheet px (server/base-assembly.ts reads it); withBase lays it on the canvas.
 */

import type { CtBaseAssembly, CtBounds, CtPrintAssembly, CtSewnPiece, CtShape } from "../types";
import { shapeBounds } from "./geometry";

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function bounds(raw: unknown): CtBounds | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Partial<Record<keyof CtBounds, unknown>>;
  const x = num(b.x);
  const y = num(b.y);
  const w = num(b.w);
  const h = num(b.h);
  return x !== null && y !== null && w !== null && h !== null && w > 0 && h > 0 ? { x, y, w, h } : null;
}

function shape(raw: unknown): CtShape | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (s.type === "rect") {
    const b = bounds(s);
    return b ? { type: "rect", ...b, radius: num(s.radius) ?? 0 } : null;
  }
  if (s.type === "ellipse") {
    const cx = num(s.cx);
    const cy = num(s.cy);
    const rx = num(s.rx);
    const ry = num(s.ry);
    return cx !== null && cy !== null && rx && ry ? { type: "ellipse", cx, cy, rx, ry } : null;
  }
  if (s.type === "polygon" && Array.isArray(s.points)) {
    const points = s.points
      .map((p: unknown) => (p && typeof p === "object" ? { x: num((p as { x: unknown }).x), y: num((p as { y: unknown }).y) } : null))
      .filter((p): p is { x: number; y: number } => !!p && p.x !== null && p.y !== null);
    return points.length >= 3 ? { type: "polygon", points } : null;
  }
  return null;
}

function pieces(raw: unknown): CtSewnPiece[] {
  if (!Array.isArray(raw)) return [];
  const out: CtSewnPiece[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const p = r as Partial<Record<keyof CtSewnPiece, unknown>>;
    const sh = shape(p.shape);
    const from = bounds(p.from);
    const to = bounds(p.to);
    if (sh && from && to) out.push({ name: typeof p.name === "string" ? p.name.slice(0, 60) : "", shape: sh, from, to });
  }
  return out.slice(0, 12);
}

export function normalizeBaseAssembly(raw: unknown): CtBaseAssembly | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Partial<Record<keyof CtBaseAssembly, unknown>>;
  const list = pieces(a.pieces);
  if (!list.length) return null;
  return {
    pieces: list,
    guideUrl: typeof a.guideUrl === "string" && a.guideUrl ? a.guideUrl : null,
    swap: a.swap === true,
    note: typeof a.note === "string" ? a.note.slice(0, 1000) : "",
    at: typeof a.at === "string" ? a.at.slice(0, 40) : "",
  };
}

export function normalizePrintAssembly(raw: unknown): CtPrintAssembly | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Partial<Record<keyof CtPrintAssembly, unknown>>;
  const list = pieces(a.pieces);
  if (!list.length) return null;
  const g = a.sheetGuide && typeof a.sheetGuide === "object" ? (a.sheetGuide as { url?: unknown }) : null;
  const gb = g ? bounds(g) : null;
  return { pieces: list, sheetGuide: g && typeof g.url === "string" && g.url && gb ? { url: g.url, ...gb } : null };
}

/** A point / box / shape moved by `k` then (dx, dy). */
function moveBox(b: CtBounds, k: number, dx: number, dy: number): CtBounds {
  return { x: b.x * k + dx, y: b.y * k + dy, w: b.w * k, h: b.h * k };
}

export function moveShapeBy(s: CtShape, k: number, dx: number, dy: number): CtShape {
  switch (s.type) {
    case "rect":
      return { ...s, ...moveBox(s, k, dx, dy), radius: s.radius * k };
    case "ellipse":
      return { ...s, cx: s.cx * k + dx, cy: s.cy * k + dy, rx: s.rx * k, ry: s.ry * k };
    case "polygon":
      return { ...s, points: s.points.map((p) => ({ x: p.x * k + dx, y: p.y * k + dy })) };
  }
}

/** The base's assembly (sheet px) where the sheet lies on the canvas (`place`, canvas px). */
export function assemblyOnCanvas(a: CtBaseAssembly, sheetWidth: number, place: CtBounds): CtSewnPiece[] {
  const k = place.w / sheetWidth;
  return a.pieces.map((p) => ({ ...p, shape: moveShapeBy(p.shape, k, place.x, place.y), from: moveBox(p.from, k, place.x, place.y), to: moveBox(p.to, k, place.x, place.y) }));
}

/** The piece of the sheet a shape (sheet / canvas px) lies on — by its middle; null = none. */
export function pieceOf(pieces: CtSewnPiece[], s: CtShape): CtSewnPiece | null {
  const b = shapeBounds(s);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  return pieces.find((p) => cx >= p.to.x && cx <= p.to.x + p.to.w && cy >= p.to.y && cy <= p.to.y + p.to.h) ?? null;
}

/** A shape on the print sheet → where it shows on the design (its piece's mapping undone). */
export function sheetToDesign(s: CtShape, p: CtSewnPiece): CtShape {
  const k = p.from.w / p.to.w;
  return moveShapeBy(s, k, p.from.x - p.to.x * k, p.from.y - p.to.y * k);
}
