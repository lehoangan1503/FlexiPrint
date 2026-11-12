/**
 * A print sheet of sewn pieces (2026-11-12, the Printbelle Wearable Hooded Blanket — the user: "preview hiện cái đầu ở
 * trên nón là đúng, nhưng file in gửi xuống sẽ sai — phần artwork đó phải nằm ở bản vẽ của nón", then: "mình không tự ý
 * lật, thay đổi và xoá khuôn in của xưởng — mình phân tích clipart và cắt ảnh artwork như 3 ảnh tham khảo"):
 *
 *   print sheet   the factory's khuôn, never moved or redrawn: the blanket's body (a big rect), the 2 hood pieces + 2
 *                 pockets under it. The design is laid on it and printed as it is (Printbelle's "Correct sample").
 *   product       the body as the blanket, the hood pieces sewn above its top edge (where the phôi photo shows them).
 *
 * Each piece (CtSewnPiece): `to` = its box on the sheet, `from` = where it shows on the product (one scale).
 *  - preview: the product sewn from the sheet (lib/compositor `assembled`);
 *  - "Cắt artwork theo khuôn" (cutArtwork): an artwork laid out as the product looks (a character standing on the
 *    blanket with its head up on the hood — how Printbelle's own phôi shows a flat sheet) is cut into the sheet: each
 *    picture's part on the hood → a copy on the hood piece, clipped to it, following the same option; the rest moved
 *    with the body. Backgrounds stay as they lie (they fill the pieces and the spare area: "not to be left blank").
 * The base holds it in the khuôn's sheet px (server/base-assembly.ts reads it); withBase lays it on the canvas.
 */

import type { CtBaseAssembly, CtBounds, CtPrintAssembly, CtRegion, CtRegionItem, CtSewnPiece, CtShape } from "../types";
import { newId, shapeBounds } from "./geometry";

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
    if (sh && from && to) out.push({ name: typeof p.name === "string" ? p.name.slice(0, 60) : "", role: p.role === "hood" ? "hood" : "body", shape: sh, from, to });
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

/** Where it shows on the product → its place on the sheet (the piece's mapping). */
export function designToSheet(s: CtShape, p: CtSewnPiece): CtShape {
  const k = p.to.w / p.from.w;
  return moveShapeBy(s, k, p.to.x - p.from.x * k, p.to.y - p.from.y * k);
}

function overlaps(a: CtBounds, b: CtBounds): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Names of the copies cutArtwork puts on the hood pieces. */
export const HOOD_COPY = "[Nón] ";

export interface CtCutResult {
  regions: CtRegion[];
  items: CtRegionItem[];
  /** Layers moved with the body / copies put on the hood / backgrounds left as they lie. */
  moved: number;
  hood: number;
  kept: number;
  /** Layers on the hood that cannot follow there (texts / photos the customer fills): their names. */
  skipped: string[];
}

/**
 * A background: a fill, or a layer covering most of the canvas — left as it lies (it fills every piece and the spare
 * area, like the factory's sample).
 */
function isBackground(r: CtRegion, canvas: { width: number; height: number }): boolean {
  if (r.config.fill) return true;
  const b = shapeBounds(r.shape);
  return b.w * b.h >= 0.85 * canvas.width * canvas.height;
}

/**
 * The artwork, laid out as the product looks (see the file comment), cut into the factory's sheet. Pure: the editor
 * commits it (undo works). An artwork already cut (it has hood copies) is returned unchanged with moved = 0.
 */
export function cutArtwork(regions: CtRegion[], items: CtRegionItem[], pieces: CtSewnPiece[], canvas: { width: number; height: number }): CtCutResult {
  const body = pieces.find((p) => p.role === "body");
  const hoods = pieces.filter((p) => p.role === "hood");
  const none: CtCutResult = { regions, items, moved: 0, hood: 0, kept: 0, skipped: [] };
  if (!body || regions.some((r) => r.name.startsWith(HOOD_COPY))) return none;
  const outR: CtRegion[] = [];
  const outI: CtRegionItem[] = items.slice();
  let moved = 0;
  let hood = 0;
  let kept = 0;
  const skipped: string[] = [];
  const kb = body.to.w / body.from.w;
  for (const r of [...regions].sort((a, b) => a.sort_order - b.sort_order)) {
    if (r.config.materialFrame || r.config.previewOnly || r.config.printOnly || isBackground(r, canvas)) {
      if (!r.config.materialFrame) kept++;
      outR.push(r);
      continue;
    }
    const b = shapeBounds(r.shape);
    // With the body: moved + scaled like the blanket, only inside the body piece (its head, up on the hood, is cut
    // off here — it goes on the hood pieces below).
    const text = r.kind === "text" ? { text: { ...r.config.text, fontSize: Math.max(1, Math.round(r.config.text.fontSize * kb * 10) / 10) } } : {};
    outR.push({ ...r, shape: designToSheet(r.shape, body), config: { ...r.config, ...text, clipTo: body.shape } });
    moved++;
    // On the hood: a copy on each hood piece it reaches, clipped to it, showing what the layer shows.
    for (const h of hoods) {
      if (!overlaps(b, h.from)) continue;
      if (r.kind !== "image") {
        if (!skipped.includes(r.name)) skipped.push(r.name);
        continue;
      }
      const id = newId();
      const leader = r.config.image.follows && r.config.image.follows !== r.id ? r.config.image.follows : r.id;
      outR.push({
        ...r,
        id,
        name: `${HOOD_COPY}${r.name}`.slice(0, 120),
        shape: designToSheet(r.shape, h),
        config: { ...r.config, clipTo: h.shape, image: { ...r.config.image, follows: leader } },
      });
      for (const it of items.filter((i) => i.region_id === r.id)) outI.push({ ...it, id: newId(), region_id: id });
      hood++;
    }
  }
  return { regions: outR.map((r, i) => ({ ...r, sort_order: i })), items: outI, moved, hood, kept, skipped };
}
