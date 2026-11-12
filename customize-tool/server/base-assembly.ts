/**
 * A base's print sheet of sewn pieces (lib/assembly), read off its khuôn + its phôi (2026-11-12, Printbelle Wearable
 * Hooded Blanket). The khuôn itself is never changed — this only says where each piece shows on the product:
 *
 *   POST base-products/:id/assembly  { swap?: boolean, off?: boolean } → { base, note, reapplied }
 *
 *  - pieces of the khuôn: the guide's grey band (server/printbelle-khuon.ts keeps it as a transparent marker, alpha
 *    BAND_ALPHA; guides read before 2026-11-12 had it opaque grey 222) closes each piece;
 *    the body = the biggest, the hood = the two mirrored pieces that are not rectangles (the rectangles are pockets);
 *  - where they show: the phôi's overlay (Printbelle mockup "main": opaque off the product) — its wide rows are the
 *    blanket, the narrow rows above them the hood. The preview lays the sheet on the photo at `box`, so both read back
 *    in sheet px;
 *  - body piece ↔ the blanket on the photo (one scale, covering it, from its top edge);
 *    hood pieces ↔ the hood, one half each, their bottom (neckline) on the blanket's top edge: by default the left
 *    half (seen from behind) on the piece rounded on its right — the rounded corner is the seam over the crown, down
 *    the middle of the back; `swap` the other way.
 */

import sharp from "sharp";
import { NextResponse } from "next/server";
import { CT_TABLES } from "../config";
import type { CtBaseAssembly, CtBaseProduct, CtBounds, CtProduct, CtProductScene, CtSewnPiece, CtShape } from "../types";
import type { CtPrintTemplate } from "../types/print";
import { fetchImage } from "./char/files";
import { loadBaseProduct } from "./base-products";
import { applyBase, loadTemplate } from "./artwork-link";
import { BAND, BAND_ALPHA, groupsOf, grow, outline, reach, simplify } from "./printbelle-khuon";
import type { CtServiceClient, CtSession } from "./supabase";

type Db = CtSession["supabase"] | CtServiceClient;

/** Long side the khuôn guide is read at. */
const READ_SIDE = 1600;

interface SheetPiece {
  /** Outline, sheet px. */
  shape: CtShape;
  box: CtBounds;
  /** Its filled map at read scale (for the mirror test). */
  map: Uint8Array;
  mw: number;
  mh: number;
  area: number;
  /** Filled share of its box (≈ 1: a rectangle). */
  fill: number;
}

/** The pieces the khuôn guide's grey band closes (sheet px). */
export async function sheetPieces(guide: Buffer, W: number, H: number): Promise<SheetPiece[]> {
  const k = Math.max(1, Math.max(W, H) / READ_SIDE);
  const w = Math.max(1, Math.round(W / k));
  const h = Math.max(1, Math.round(H / k));
  const { data, info } = await sharp(guide, { limitInputPixels: false }).ensureAlpha().resize(w, h, { fit: "fill", kernel: "nearest" }).raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const band = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += ch) {
    // The marker (alpha only: a resize drops the colour of a nearly transparent pixel), or an old opaque grey band.
    const a = data[p + 3];
    if (a > 0 && a <= BAND_ALPHA + 1) band[i] = 1;
    else if (a > 200 && Math.abs(data[p] - BAND) <= 8 && Math.abs(data[p + 1] - BAND) <= 8 && Math.abs(data[p + 2] - BAND) <= 8) band[i] = 1;
  }
  const sx = W / w;
  const sy = H / h;
  const out: SheetPiece[] = [];
  for (const g of groupsOf(band, w, h)) {
    if (g.px.length < 0.0003 * w * h) continue;
    const ox = g.x0 - 2;
    const oy = g.y0 - 2;
    const bw = g.x1 - g.x0 + 5;
    const bh = g.y1 - g.y0 + 5;
    const wall = new Uint8Array(bw * bh);
    for (const i of g.px) {
      const x = i % w;
      const y = (i - x) / w;
      wall[(y - oy) * bw + (x - ox)] = 1;
    }
    const outside = reach(wall, bw, bh);
    const inside = new Uint8Array(bw * bh);
    let area = 0;
    for (let i = 0; i < bw * bh; i++)
      if (!outside[i]) {
        inside[i] = 1;
        area++;
      }
    // A band that closes nothing (an icon, a stray stroke) is no piece.
    if (area < g.px.length * 1.5) continue;
    // The spare area's grid (thin lines over a big box) is no piece either.
    if (area < 0.3 * bw * bh) continue;
    // A little past the band: the solid cut line runs along its outer edge.
    const filled = grow(inside, bw, bh, 1);
    let x0 = bw;
    let y0 = bh;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < bh; y++)
      for (let x = 0; x < bw; x++)
        if (filled[y * bw + x]) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
    const mw = x1 - x0 + 1;
    const mh = y1 - y0 + 1;
    const map = new Uint8Array(mw * mh);
    let n = 0;
    for (let y = 0; y < mh; y++)
      for (let x = 0; x < mw; x++)
        if (filled[(y + y0) * bw + x + x0]) {
          map[y * mw + x] = 1;
          n++;
        }
    const box = { x: Math.max(0, (ox + x0) * sx), y: Math.max(0, (oy + y0) * sy), w: mw * sx, h: mh * sy };
    box.w = Math.min(box.w, W - box.x);
    box.h = Math.min(box.h, H - box.y);
    const fill = n / (mw * mh);
    const r = (v: number) => Math.round(v * 10) / 10;
    let shape: CtShape;
    if (fill > 0.97) shape = { type: "rect", x: r(box.x), y: r(box.y), w: r(box.w), h: r(box.h), radius: 0 };
    else {
      const pts = simplify(outline(map, mw, mh), 1);
      shape = { type: "polygon", points: pts.map((p) => ({ x: r(Math.min(W, Math.max(0, (ox + x0 + p.x + 0.5) * sx))), y: r(Math.min(H, Math.max(0, (oy + y0 + p.y + 0.5) * sy))) })) };
    }
    out.push({ shape, box, map, mw, mh, area: n, fill });
  }
  return out.sort((a, b) => b.area - a.area);
}

/** How alike `a` is to `b` turned over left ↔ right (IoU on a 48² grid). */
function mirrorMatch(a: SheetPiece, b: SheetPiece): number {
  const N = 48;
  let both = 0;
  let any = 0;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const va = a.map[Math.floor(((y + 0.5) / N) * a.mh) * a.mw + Math.floor(((x + 0.5) / N) * a.mw)];
      const vb = b.map[Math.floor(((y + 0.5) / N) * b.mh) * b.mw + Math.floor(((N - x - 0.5) / N) * b.mw)];
      if (va && vb) both++;
      if (va || vb) any++;
    }
  return any ? both / any : 0;
}

/** The two hood pieces: mirrored, alike in size, not rectangles — left one first. */
function hoodPair(pieces: SheetPiece[]): [SheetPiece, SheetPiece] | null {
  let best: [SheetPiece, SheetPiece] | null = null;
  let bestScore = 0.85;
  for (let i = 0; i < pieces.length; i++)
    for (let j = i + 1; j < pieces.length; j++) {
      const a = pieces[i];
      const b = pieces[j];
      if (a.fill > 0.95 || b.fill > 0.95) continue;
      if (Math.abs(a.box.w - b.box.w) > 0.08 * Math.max(a.box.w, b.box.w) || Math.abs(a.box.h - b.box.h) > 0.08 * Math.max(a.box.h, b.box.h)) continue;
      const score = mirrorMatch(a, b);
      if (score > bestScore) {
        bestScore = score;
        best = a.box.x <= b.box.x ? [a, b] : [b, a];
      }
    }
  return best;
}

interface PreviewParts {
  /** The blanket on the preview, sheet px. */
  body: CtBounds;
  /** The hood above it: its sides, its top, and its bottom (= the blanket's top edge), sheet px. */
  hood: { x0: number; x1: number; top: number; bottom: number } | null;
}

/** The product on the phôi's overlay (opaque = off the product), read back to the sheet's px. */
export async function previewParts(scene: CtProductScene, W: number, H: number): Promise<PreviewParts | null> {
  if (!scene.overlay) return null;
  const { data, info } = await sharp(await fetchImage(scene.overlay)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pw = info.width;
  const ph = info.height;
  const ch = info.channels;
  const first = new Int32Array(ph).fill(-1);
  const last = new Int32Array(ph).fill(-1);
  const width = new Int32Array(ph);
  for (let y = 0; y < ph; y++)
    for (let x = 0; x < pw; x++)
      if (data[(y * pw + x) * ch + 3] < 128) {
        if (first[y] < 0) first[y] = x;
        last[y] = x;
        width[y]++;
      }
  const maxW = Math.max(0, ...width);
  if (maxW < pw * 0.1) return null;
  const wide: number[] = [];
  for (let y = 0; y < ph; y++) if (width[y] >= 0.6 * maxW) wide.push(y);
  if (!wide.length) return null;
  const top = wide[0];
  const bottom = wide[wide.length - 1];
  const med = (v: number[]) => v.sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const mid = wide.filter((y) => y > top + (bottom - top) * 0.1 && y < bottom - (bottom - top) * 0.1);
  const rows = mid.length ? mid : wide;
  // The photo's px → the sheet's (scene.box = where the sheet lies on the photo).
  const X = (x: number) => ((x - scene.box.x) * W) / scene.box.w;
  const Y = (y: number) => ((y - scene.box.y) * H) / scene.box.h;
  // Inside the sheet: past it the design has nothing to print.
  const bx0 = Math.max(0, X(med(rows.map((y) => first[y]))));
  const bx1 = Math.min(W, X(med(rows.map((y) => last[y])) + 1));
  const body = { x: bx0, y: Y(top), w: bx1 - bx0, h: Y(bottom + 1) - Y(top) };
  // The hood: product rows above the blanket, narrow.
  let hTop = -1;
  for (let y = 0; y < top && hTop < 0; y++) if (width[y] >= 3) hTop = y;
  // Its sides from its upper three quarters: lower down it widens into the shoulders.
  let hx0 = pw;
  let hx1 = -1;
  if (hTop >= 0)
    for (let y = hTop; y < hTop + (top - hTop) * 0.75; y++) {
      if (width[y] < 3) continue;
      hx0 = Math.min(hx0, first[y]);
      hx1 = Math.max(hx1, last[y]);
    }
  const hood = hTop >= 0 && top - hTop > ph * 0.03 && hx1 - hx0 < 0.5 * maxW ? { x0: X(hx0), x1: X(hx1 + 1), top: Math.max(0, Y(hTop)), bottom: Y(top) } : null;
  return { body, hood };
}

/** The plain phôi whose overlay tells where the product is: the preview, else the plain one an AI scene was made from. */
function overlayScene(base: CtBaseProduct): CtProductScene | null {
  const { preview, previewScenes } = base.config;
  if (preview.overlay) return preview;
  return previewScenes.map((s) => s.plain).find((p) => !!p.overlay) ?? null;
}

/** The pieces + what each prints. `null` + why when the base is not a sewn sheet. */
export function sewPieces(pieces: SheetPiece[], parts: PreviewParts, swap: boolean): { pieces: CtSewnPiece[]; note: string } | string {
  const body = pieces[0];
  const pair = hoodPair(pieces.slice(1));
  if (!parts.hood) return "Phôi không thấy phần nón (lớp phủ không có phần hẹp nhô lên trên thân)";
  if (!pair) return "Khuôn không có cặp mảnh nón (2 mảnh đối xứng không phải hình chữ nhật)";
  const out: CtSewnPiece[] = [];
  // Body: covers the blanket on the photo (one scale, from its top edge, centred) — no bare strip on the preview.
  const s = Math.max(parts.body.w / body.box.w, parts.body.h / body.box.h);
  const bw = body.box.w * s;
  out.push({ name: "Thân", role: "body", shape: body.shape, from: { x: parts.body.x + (parts.body.w - bw) / 2, y: parts.body.y, w: bw, h: body.box.h * s }, to: body.box });
  // Hood: one half of it on each piece, at the body's scale (the hood is printed at the same size as the body), its
  // bottom (the neckline) on the blanket's top edge, the hood's middle on the blanket's middle. A hood piece is sewn
  // with its straight side at the face and its rounded corner over the crown down the back: seen from behind, the
  // middle of the hood is the rounded sides of both pieces — the left half is on the piece rounded on its right (swap:
  // the other way, the middle on the straight sides).
  const { x0, x1, top, bottom } = parts.hood;
  const [L, R] = pair;
  const cx = out[0].from.x + out[0].from.w / 2;
  const edge = out[0].from.y;
  const half = (p: SheetPiece, side: "left" | "right", name: string): CtSewnPiece => {
    const w = p.box.w * s;
    const h = p.box.h * s;
    return { name, role: "hood", half: side, shape: p.shape, from: { x: side === "left" ? cx - w : cx, y: edge - h, w, h }, to: p.box };
  };
  if (!swap) out.push(half(R, "left", "Nón (nửa trái, mảnh phải)"), half(L, "right", "Nón (nửa phải, mảnh trái)"));
  else out.push(half(L, "left", "Nón (nửa trái, mảnh trái)"), half(R, "right", "Nón (nửa phải, mảnh phải)"));
  const note =
    `Ô thân = thân chăn trên preview (mép trên ở y ${Math.round(parts.body.y)}px của tờ) · ` +
    `2 mảnh nón = nón trên preview (vùng ${Math.round(x0)}–${Math.round(x1)} × ${Math.round(top)}–${Math.round(bottom)}px), mỗi mảnh nửa nón · phần layer tràn lên trên mép ô thân in xuống 2 mảnh nón, cùng cỡ` +
    (swap ? " · đã đổi nửa nón" : "") +
    (pieces.length > 3 ? ` · ${pieces.length - 3} mảnh khác (túi…) không hiện trên preview` : "");
  return { pieces: out, note };
}

/** Reads the base's assembly (see the file comment); a string = why there is none. */
export async function readAssembly(base: CtBaseProduct, template: CtPrintTemplate | null, swap: boolean): Promise<CtBaseAssembly | string> {
  if (!template) return "Base chưa có khuôn in";
  const face = template.spec.faces[0];
  if (!face?.guideUrl) return "Khuôn in không có ảnh nét khuôn (guide)";
  const scene = overlayScene(base);
  if (!scene) return "Phôi không có lớp phủ (overlay) để biết nón / thân nằm đâu trên preview";
  const W = template.spec.width;
  const H = template.spec.height;
  const guide = await fetchImage(face.guideUrl);
  const pieces = await sheetPieces(guide, W, H);
  if (pieces.length < 3) return `Khuôn chỉ có ${pieces.length} mảnh — không phải tờ ráp nhiều mảnh`;
  const parts = await previewParts(scene, W, H);
  if (!parts) return "Không đọc được hình sản phẩm trên lớp phủ phôi";
  const sewn = sewPieces(pieces, parts, swap);
  if (typeof sewn === "string") return sewn;
  return { pieces: sewn.pieces, guideUrl: null, swap, note: sewn.note, at: new Date().toISOString() };
}

/** Saves the assembly into the base (read fresh — other fields stay) and lays every product on it again. */
async function saveAssembly(db: Db, baseId: string, assembly: CtBaseAssembly | null): Promise<{ base: CtBaseProduct | null; reapplied: number }> {
  const { data: row } = await db.from(CT_TABLES.baseProducts).select("config").eq("id", baseId).maybeSingle<{ config: Record<string, unknown> | null }>();
  const { error } = await db.from(CT_TABLES.baseProducts).update({ config: { ...(row?.config ?? {}), assembly } }).eq("id", baseId);
  if (error) throw new Error(error.message);
  const { data: products } = await db.from(CT_TABLES.products).select("*").eq("base_product_id", baseId).eq("kind", "product").returns<CtProduct[]>();
  let reapplied = 0;
  for (const p of products ?? []) await applyBase(db, p).then(() => reapplied++).catch((e: Error) => console.warn(`[ct] assembly reapply ${p.id}: ${e.message}`));
  return { base: await loadBaseProduct(db, baseId), reapplied };
}

/** POST base-products/:id/assembly */
export async function makeBaseAssembly(s: CtSession, baseId: string, raw: unknown): Promise<NextResponse> {
  const body = raw && typeof raw === "object" ? (raw as { swap?: unknown; off?: unknown }) : {};
  const base = await loadBaseProduct(s.supabase, baseId);
  if (!base) return NextResponse.json({ error: "Không tìm thấy product base" }, { status: 404 });
  try {
    if (body.off === true) {
      const r = await saveAssembly(s.supabase, baseId, null);
      return NextResponse.json({ base: r.base, note: "Đã bỏ ráp mảnh: file in = thiết kế nằm nguyên trên tờ khuôn", reapplied: r.reapplied });
    }
    const read = await readAssembly(base, await loadTemplate(s.supabase, base.config.templateId), body.swap === true);
    if (typeof read === "string") return NextResponse.json({ error: read }, { status: 422 });
    const r = await saveAssembly(s.supabase, baseId, read);
    return NextResponse.json({ base: r.base, note: read.note, reapplied: r.reapplied });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Không đọc được mảnh" }, { status: 500 });
  }
}

/** For an import / refresh: reads it when the base looks sewn, never throws; the note says what happened. */
export async function autoAssembly(db: Db, userId: string, baseId: string): Promise<string | null> {
  try {
    const base = await loadBaseProduct(db, baseId);
    if (!base || base.config.assembly) return null;
    const read = await readAssembly(base, await loadTemplate(db, base.config.templateId), false);
    if (typeof read === "string") return null;
    await saveAssembly(db, baseId, read);
    return "ráp mảnh nón + thân";
  } catch (e) {
    console.warn(`[ct] auto assembly ${baseId}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

