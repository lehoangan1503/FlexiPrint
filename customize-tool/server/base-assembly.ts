/**
 * A base's print sheet sewn from pieces (lib/assembly), read off its khuôn + its phôi (asked 2026-11-12 on the
 * Printbelle Wearable Hooded Blanket: the preview shows the top of the design on the hood, the file in must carry it
 * on the hood pieces):
 *
 *   POST base-products/:id/assembly  { swap?: boolean, off?: boolean } → { base, note, reapplied }
 *
 *  - pieces of the khuôn: the guide's grey band (server/printbelle-khuon.ts keeps it as a transparent marker, alpha
 *    BAND_ALPHA; guides read before 2026-11-12 had it opaque grey 222) closes each piece;
 *    the body = the biggest, the hood = the two mirrored pieces that are not rectangles (the rectangles are pockets);
 *  - where they show: the phôi's overlay (Printbelle mockup "main": opaque off the product) — its wide rows are the
 *    blanket, the narrow rows above them the hood. The preview lays the sheet on the photo at `box`, so both read back
 *    in sheet px;
 *  - body: the blanket on the preview → the body piece (one scale, by width, from its top edge);
 *    hood: each half of it → one hood piece, the middle of the hood on the piece's straight edge, its bottom on the
 *    piece's bottom (`swap`: the left half on the right-hand piece, the hood's middle on that piece's rounded side);
 *  - the guide the editor shows on the design: each piece's own lines cut out of the khuôn and moved to where it shows.
 */

import sharp, { type OverlayOptions } from "sharp";
import { NextResponse } from "next/server";
import { CT_CONFIG, CT_TABLES } from "../config";
import type { CtBaseAssembly, CtBaseProduct, CtBounds, CtProduct, CtProductScene, CtSewnPiece, CtShape } from "../types";
import type { CtPrintTemplate } from "../types/print";
import { shapeToSvgPath } from "../lib/geometry";
import { moveShapeBy } from "../lib/assembly";
import { fetchImage } from "./char/files";
import { loadBaseProduct } from "./base-products";
import { applyBase, loadTemplate } from "./artwork-link";
import { BAND, BAND_ALPHA, groupsOf, grow, outline, reach, simplify } from "./printbelle-khuon";
import { ctUpload } from "./storage";
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
  // Body: the blanket as the preview shows it, from its top edge, one scale by width.
  const kb = body.box.w / parts.body.w;
  out.push({ name: "Thân", shape: body.shape, from: { x: parts.body.x, y: parts.body.y, w: parts.body.w, h: body.box.h / kb }, to: body.box });
  // Hood: one half of it on each piece, its middle on the piece's straight edge (swap: on its rounded side), its
  // bottom on the piece's bottom, one scale by height.
  const { x0, x1, top, bottom } = parts.hood;
  const cx = (x0 + x1) / 2;
  const [L, R] = pair;
  const kh = (L.box.h + R.box.h) / 2 / (bottom - top);
  const half = (p: SheetPiece, side: "left" | "right", name: string): CtSewnPiece => {
    const w = p.box.w / kh;
    const h = p.box.h / kh;
    return { name, shape: p.shape, from: { x: side === "left" ? cx - w : cx, y: bottom - h, w, h }, to: p.box };
  };
  if (!swap) out.push(half(L, "left", "Nón (nửa trái)"), half(R, "right", "Nón (nửa phải)"));
  else out.push(half(R, "left", "Nón (nửa trái)"), half(L, "right", "Nón (nửa phải)"));
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const note =
    `Thân: phần thiết kế từ y ${Math.round(out[0].from.y)} đến ${Math.round(out[0].from.y + out[0].from.h)}px (mép trên thân chăn trên preview) → ô thân · ` +
    `Nón: vùng ${Math.round(x0)}–${Math.round(x1)} × ${Math.round(top)}–${Math.round(bottom)}px (trên preview) → 2 mảnh nón, phóng ${pct(kh)}` +
    (swap ? " · nửa trái ↔ mảnh phải" : "") +
    (pieces.length > 3 ? ` · ${pieces.length - 3} mảnh khác (túi…) giữ thiết kế nằm tại chỗ` : "");
  return { pieces: out, note };
}

/** An overlay placed at (x, y) on a W × H sheet, cut to the sheet. */
async function placed(img: Buffer, x: number, y: number, W: number, H: number): Promise<OverlayOptions | null> {
  const m = await sharp(img).metadata();
  const iw = m.width ?? 0;
  const ih = m.height ?? 0;
  const left = Math.max(0, x);
  const topY = Math.max(0, y);
  const right = Math.min(W, x + iw);
  const bottom = Math.min(H, y + ih);
  if (right <= left || bottom <= topY) return null;
  const cut = await sharp(img)
    .extract({ left: left - x, top: topY - y, width: right - left, height: bottom - topY })
    .png()
    .toBuffer();
  return { input: cut, left, top: topY };
}

/** The khuôn's lines as they fall on the design: each piece's own lines (cut to its outline) moved to `from`. */
export async function designGuide(guide: Buffer, W: number, H: number, pieces: CtSewnPiece[]): Promise<Buffer> {
  const layers: OverlayOptions[] = [];
  for (const p of pieces) {
    const left = Math.max(0, Math.floor(p.to.x));
    const top = Math.max(0, Math.floor(p.to.y));
    const width = Math.min(W - left, Math.ceil(p.to.w));
    const height = Math.min(H - top, Math.ceil(p.to.h));
    if (width < 2 || height < 2) continue;
    const local = moveShapeBy(p.shape, 1, -left, -top);
    const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><path d="${shapeToSvgPath(local)}" fill="#fff"/></svg>`);
    const cut = await sharp(guide, { limitInputPixels: false })
      .extract({ left, top, width, height })
      .ensureAlpha()
      .composite([{ input: mask, blend: "dest-in" }])
      .png()
      .toBuffer();
    const k = p.from.w / p.to.w;
    const rw = Math.max(1, Math.round(width * k));
    const rh = Math.max(1, Math.round(height * k));
    const scaled = await sharp(cut).resize(rw, rh, { fit: "fill" }).png().toBuffer();
    const o = await placed(scaled, Math.round(p.from.x + (left - p.to.x) * k), Math.round(p.from.y + (top - p.to.y) * k), W, H);
    if (o) layers.push(o);
  }
  return sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(layers)
    .png()
    .toBuffer();
}

/** Reads the base's assembly (see the file comment); a string = why there is none. */
export async function readAssembly(userId: string, base: CtBaseProduct, template: CtPrintTemplate | null, swap: boolean): Promise<CtBaseAssembly | string> {
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
  const png = await designGuide(guide, W, H, sewn.pieces);
  const guideUrl = await ctUpload(`${userId}/${CT_CONFIG.storagePrefix}/bases/${base.id}/assembly-${crypto.randomUUID()}.png`, png, "image/png");
  return { pieces: sewn.pieces, guideUrl, swap, note: sewn.note, at: new Date().toISOString() };
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
    const read = await readAssembly(s.user.id, base, await loadTemplate(s.supabase, base.config.templateId), body.swap === true);
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
    const read = await readAssembly(userId, base, await loadTemplate(db, base.config.templateId), false);
    if (typeof read === "string") return null;
    await saveAssembly(db, baseId, read);
    return "ráp mảnh nón + thân";
  } catch (e) {
    console.warn(`[ct] auto assembly ${baseId}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

