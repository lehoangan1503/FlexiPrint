/**
 * Since 2026-11-13 (asked: "phần vượt qua sẽ được hiển thị ở dưới, nhưng phải tôn trọng vị trí của chính cái frame
 * đang bị overflow … không ưu tiên vào 2 vòm tròn … không bỏ qua bất kì bản vẽ nào … editor tự kéo thả không ép vào
 * khuôn nào cả"): the general rule is `wrap` (overflowFolds) — what crosses the sheet's top cut line shows again from
 * its bottom cut line up, at the same x, on whatever piece lies there (hood, pocket) or none. The hooded blanket's
 * first rule (below, `hood`: the overflow over the body's middle moved onto the 2 hood pieces) stays as its own logic.
 * Every piece of the sheet is kept (role "other" = a pocket: printed, not on the preview photo).
 *
 * A print sheet of sewn pieces (2026-11-12, the Printbelle Wearable Hooded Blanket — the user: "preview hiện cái đầu ở
 * trên nón là đúng, nhưng file in gửi xuống sẽ sai — phần artwork đó phải nằm ở bản vẽ của nón", then: "mình không tự ý
 * lật, thay đổi và xoá khuôn in của xưởng — mình phân tích clipart và cắt ảnh artwork như 3 ảnh tham khảo"):
 *
 *   print sheet   the factory's khuôn, never moved or redrawn: the blanket's body (a big rect), the 2 hood pieces + 2
 *                 pockets under it. The design is laid on it and printed as it is (Printbelle's "Correct sample").
 *   product       the body as the blanket, the hood pieces sewn above its top edge (where the phôi photo shows them).
 *
 * Each piece (CtSewnPiece): `to` = its box on the sheet, `from` = where it shows on the product photo.
 *  - the hood: what any layer reaches ABOVE the body's top edge is printed on the hood pieces (hoodFolds), live — in
 *    the editor, the print file and the preview (a layer can turn it off: CtRegionConfig.noHood). Backgrounds (fills)
 *    are not folded: the pieces keep the background they lie on, like Printbelle's sample;
 *  - preview: the product sewn from the sheet (lib/compositor `assembled`): body → blanket, hood pieces → hood.
 * The base holds it in the khuôn's sheet px (server/base-assembly.ts reads it); withBase lays it on the canvas.
 */

import type { CtBaseAssembly, CtBounds, CtPrintAssembly, CtSewnPiece, CtShape, CtSheetKind, CtSheetOverflow } from "../types";
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
    if (!sh || !from || !to) continue;
    const role = p.role === "hood" || p.role === "other" ? p.role : "body";
    const half: Pick<CtSewnPiece, "half"> = role === "hood" && (p.half === "left" || p.half === "right") ? { half: p.half } : {};
    out.push({ name: typeof p.name === "string" ? p.name.slice(0, 60) : "", role, ...half, shape: sh, from, to });
  }
  return out.slice(0, 12);
}

/** Saved before 2026-11-13 = no field: the general rule (wrap) — the user's rule for every sheet since. */
function overflow(raw: unknown): CtSheetOverflow {
  return raw === "hood" ? "hood" : "wrap";
}

function kind(raw: unknown, list: CtSewnPiece[]): CtSheetKind {
  if (raw === "sheet" || raw === "hooded-blanket") return raw;
  return list.some((p) => p.role === "hood") ? "hooded-blanket" : "sheet";
}

export function normalizeBaseAssembly(raw: unknown): CtBaseAssembly | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Partial<Record<keyof CtBaseAssembly, unknown>>;
  const list = pieces(a.pieces);
  if (!list.length) return null;
  return {
    kind: kind(a.kind, list),
    overflow: overflow(a.overflow),
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
  return { kind: kind(a.kind, list), overflow: overflow(a.overflow), pieces: list, sheetGuide: g && typeof g.url === "string" && g.url && gb ? { url: g.url, ...gb } : null };
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

/** The pieces the preview sews onto the product photo (body + hood); null = the sheet is shown as it is. */
export function previewPieces(a: CtPrintAssembly | null | undefined): CtSewnPiece[] | null {
  if (!a || a.kind !== "hooded-blanket") return null;
  const list = a.pieces.filter((p) => p.role !== "other");
  return list.length ? list : null;
}

export interface CtHoodFold {
  /** Where it lands (canvas px): a hood piece's outline, or the sheet's box (wrap). */
  shape: CtShape;
  /** What it takes: the box above the top cut line (canvas px). */
  src: CtBounds;
  /** src → where it lands: a move only (printed at the same size as the body). */
  dx: number;
  dy: number;
}

/**
 * What reaches above the body's top edge goes on the hood pieces (2026-11-12, asked: "khi artwork di chuyển vertical,
 * phần overflow phải được cắt vào phía dưới"): the hood is sewn on the body's top edge, in its middle — each piece
 * takes its half of the space above that edge (the piece's own size, its bottom on the edge, the hood's middle on the
 * piece's side that is sewn there), moved down onto it.
 */
export function hoodFolds(a: CtPrintAssembly): CtHoodFold[] {
  const body = a.pieces.find((p) => p.role === "body");
  if (!body) return [];
  const top = body.to.y;
  const cx = body.to.x + body.to.w / 2;
  return a.pieces
    .filter((p) => p.role === "hood" && p.half)
    .map((p) => {
      const src = { x: p.half === "left" ? cx - p.to.w : cx, y: top - p.to.h, w: p.to.w, h: p.to.h };
      return { shape: p.shape, src, dx: p.to.x - src.x, dy: p.to.y - src.y };
    });
}

/**
 * The general rule (CtSheetOverflow "wrap", 2026-11-13): the sheet read as a band rolled top ↔ bottom — what a layer
 * reaches above the sheet's top cut line shows again from its bottom cut line up, at the same x and size. Nothing
 * is pushed onto a piece: it lands on whatever lies there (a hood piece, a pocket, or the gap between them).
 */
export function wrapFolds(a: CtPrintAssembly): CtHoodFold[] {
  if (!a.pieces.length) return [];
  const x0 = Math.min(...a.pieces.map((p) => p.to.x));
  const y0 = Math.min(...a.pieces.map((p) => p.to.y));
  const x1 = Math.max(...a.pieces.map((p) => p.to.x + p.to.w));
  const y1 = Math.max(...a.pieces.map((p) => p.to.y + p.to.h));
  const h = y1 - y0;
  if (!(h > 0) || !(x1 > x0)) return [];
  return [{ shape: { type: "rect", x: x0, y: y0, w: x1 - x0, h, radius: 0 }, src: { x: x0, y: y0 - h, w: x1 - x0, h }, dx: 0, dy: h }];
}

/** What reaches above the sheet's top goes where the base's rule says (CtSheetOverflow). */
export function overflowFolds(a: CtPrintAssembly): CtHoodFold[] {
  return a.overflow === "hood" ? hoodFolds(a) : wrapFolds(a);
}
