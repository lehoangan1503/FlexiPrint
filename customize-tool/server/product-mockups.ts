/**
 * The product as it is sold (asked 2026-10-10): Thiết kế and File in stay flat 2D (the print, no phôi); Xem trước and
 * Mockups show the finished artwork ON the phôi trơn — the blank piece — and the mockups are made by AI, no hand edit.
 *
 *   POST products/:id/blank     → { product }  AI phôi trơn from the product's khuôn in (its outline, hole, size):
 *                                 stored as a product picture, becomes config.scene (the sheet's box detected on it)
 *   POST products/:id/mockups   multipart print (PNG, the artwork at sheet size cut to the khuôn), scenes (JSON
 *                               string[]) → { jobs } the front mockup (the print laid on the phôi, exact, no AI) +
 *                               one AI lifestyle photo per scene made from it, in the background
 *   GET  products/:id/mockups   → { jobs } newest first
 *
 * Jobs are rows of ct_pack_images (listed = false, name "mockup:<product id>"): running → done (the picture is also
 * added to the product as a mockup) / failed. The v2 bộ nhân vật makes its phôi with the same code (makeBlank).
 */

import sharp from "sharp";
import { NextResponse } from "next/server";
import { CT_CONFIG, CT_TABLES } from "../config";
import type { CtAsset, CtBaseProduct, CtBounds, CtPackImage, CtProduct, CtProductScene, CtSelection } from "../types";
import type { CtPrintSpec } from "../types/print";
import { normalizeProductConfig, resolveLinked } from "../lib/design";
import { CT_MAIN_KEY } from "../types";
import type { ArtworkBundle } from "./print-render";
import { shapePolygon } from "../lib/material-frame";
import { shapeBounds } from "../lib/geometry";
import { isAdmin } from "./ai-styles";
import { drawImage } from "./pack-images";
import { CT_IMAGE_MODEL } from "../lib/image-models";
import { ctRemove, ctUpload } from "./storage";
import { fetchImage } from "./char/files";
import { lightOnBlank } from "../lib/blank-shading";
import { materialPreset } from "../lib/materials";
import { uploadAsset } from "./handlers";
import { ctServiceClient, type CtServiceClient, type CtSession } from "./supabase";
type MockDb = CtSession["supabase"] | CtServiceClient;
import { splitScenes } from "../lib/mockup-scenes";
import { customizable, isCustomizable, mockupVariants } from "../lib/mockup-variants";
import { fillVariantPhotos } from "./mockup-samples";

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export const jobName = (productId: string) => `mockup:${productId}`;

import { CLEAR_ACRYLIC_LOOK, CT_MOCKUP_BLOCK_REFS_MAX, CT_MOCKUP_REFS_MAX, GLASS_LOOK, KEEP_PRINT, badBlockRefs, fillMockupWrap, isGlass, mockupBlockList, mockupRefList } from "../lib/mockup-prompt";
import { normalizeBaseMockup } from "../lib/base-product";
import type { CtBaseMockup, CtMockupBlock } from "../types";
// Moved to lib/mockup-prompt.ts (2026-11-17: the base page shows them); kept here for the old imports.
export { CLEAR_ACRYLIC_LOOK, GLASS_LOOK, KEEP_PRINT, isGlass };

// ---- the front mockup: the print laid exactly on the phôi --------------------------------------------------

/**
 * The print on the blank photo, inside `box` (photo px, may reach past the photo), lit by the blank's own shading —
 * or, with the fulfiller's `overlay` (CtProductScene.overlay), pasted flat with the overlay laid over it.
 */
export async function frontMockup(blank: Buffer, print: Buffer, box: CtProductScene["box"], overlay: Buffer | null = null, opaque = false): Promise<Buffer> {
  const meta = await sharp(blank).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const bw = Math.max(1, Math.round(box.w));
  const bh = Math.max(1, Math.round(box.h));
  const bx = Math.round(box.x);
  const by = Math.round(box.y);
  // The part of the box on the photo.
  const x = Math.max(0, bx);
  const y = Math.max(0, by);
  const w = Math.min(W, bx + bw) - x;
  const hh = Math.min(H, by + bh) - y;
  if (w <= 0 || hh <= 0) return sharp(blank).removeAlpha().jpeg({ quality: 92 }).toBuffer();
  const art = await sharp(await sharp(print).resize(bw, bh, { fit: "fill", kernel: "lanczos3" }).ensureAlpha().png().toBuffer())
    .extract({ left: x - bx, top: y - by, width: w, height: hh })
    .raw()
    .toBuffer();
  if (overlay || opaque) {
    // An opaque print (white ink under it, lib/materials whiteInk) is not lit by a clear phôi's glare / backdrop.
    const over = overlay ? await sharp(overlay).resize(W, H, { fit: "fill" }).ensureAlpha().png().toBuffer() : null;
    const flat = await sharp(art, { raw: { width: w, height: hh, channels: 4 } }).png().toBuffer();
    const laid = await sharp(blank)
      .ensureAlpha()
      .composite([{ input: flat, left: x, top: y }, ...(over ? [{ input: over, left: 0, top: 0 }] : [])])
      .png()
      .toBuffer();
    return sharp(laid).flatten({ background: "#ffffff" }).jpeg({ quality: 92 }).toBuffer();
  }
  // The phôi's own light on the print: its shading darkens it, its gloss highlights lie over it (lib/blank-shading).
  const under = await sharp(blank).removeAlpha().extract({ left: x, top: y, width: w, height: hh }).raw().toBuffer();
  const out = Buffer.alloc(w * hh * 4);
  lightOnBlank(art, under, w, hh, 3, out);
  const patch = await sharp(out, { raw: { width: w, height: hh, channels: 4 } }).removeAlpha().png().toBuffer();
  return sharp(blank).removeAlpha().composite([{ input: patch, left: x, top: y }]).jpeg({ quality: 92 }).toBuffer();
}

// ---- a die-cut acrylic piece: its phôi IS its outline --------------------------------------------------------

/** Every mockup of a product is one square picture of this side (asked 2026-10-22: "tất cả mockup tạo ra đều phải tuân
 * thủ cùng 1 tỉ lệ width height ảnh, không tạo ngẫu nhiên") — the AI scenes are asked square too (gpt-image draws a
 * square as asked: nothing is cropped off). */
export const MOCKUP_SIDE = 2048;
export const MOCKUP_ASPECT = "1:1";
/** The long side of the artwork a mockup is made from (2026-11-27: it was the print size — 7400×10000 for a fleece
 * blanket, 20 at once per product — the main CPU load of flexi2; the front picture is laid on a ~2000 px phôi and
 * squared to MOCKUP_SIDE, so more pixels than this never reach the photo). */
export const MOCKUP_PRINT_SIDE = 3072;
/** The side to render a mockup's artwork at: the print's, capped at MOCKUP_PRINT_SIDE. */
export function mockupPrintSide(spec: { width?: number; height?: number } | null | undefined): number {
  return Math.min(MOCKUP_PRINT_SIDE, Math.max(spec?.width ?? 2000, spec?.height ?? 2000));
}

/** The visible pixels of a print (its sheet's transparent margin cut off). */
async function inkOnly(png: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(png).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  let x0 = info.width;
  let y0 = info.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++)
      if (data[y * info.width + x] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return png;
  return sharp(png).extract({ left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }).png().toBuffer();
}

/** A picture as a MOCKUP_SIDE square: a square one resized; another one centred on its own corner colour (the piece
 * whole, nothing cropped). */
async function squared(jpegOrPng: Buffer): Promise<Buffer> {
  const m = await sharp(jpegOrPng).metadata();
  const W = m.width ?? MOCKUP_SIDE;
  const H = m.height ?? MOCKUP_SIDE;
  if (W !== H) {
    const { data } = await sharp(jpegOrPng).removeAlpha().extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
    const side = Math.max(W, H);
    const background = { r: data[0], g: data[1], b: data[2] };
    jpegOrPng = await sharp(jpegOrPng).removeAlpha().extend({ left: Math.floor((side - W) / 2), right: Math.ceil((side - W) / 2), top: Math.floor((side - H) / 2), bottom: Math.ceil((side - H) / 2), background }).png().toBuffer();
  }
  return sharp(jpegOrPng).resize(MOCKUP_SIDE, MOCKUP_SIDE, { kernel: "lanczos3" }).removeAlpha().jpeg({ quality: 92 }).toBuffer();
}

/** A mask grown by r px (blur, then any trace counts — sharp thresholds before it blurs, so by hand). */
async function grow(mask: Buffer, w: number, h: number, r: number): Promise<Buffer> {
  // One band out (sharp hands a blurred single band back as three otherwise).
  const blurred = await sharp(mask, { raw: { width: w, height: h, channels: 1 } }).blur(Math.max(0.5, r / 2)).extractChannel(0).raw().toBuffer();
  const out = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) out[i] = blurred[i] > 6 ? 255 : 0;
  return out;
}

/**
 * The front photo of a die-cut clear acrylic ornament (asked 2026-10-18 — there is no blank to shoot: the piece is the
 * artwork's own outline): the print on a clear plate cut `borderPx` around it, a round clear tab at the top centre
 * with the hanging hole, the plate's edge catching the light, on a soft light backdrop. The AI scenes start from it.
 */
export async function acrylicFront(sheet: Buffer, borderPx: number): Promise<Buffer> {
  // The artwork alone (the sheet's empty margin made the piece small in its photo, 2026-10-22), in the middle of a
  // square: the piece with its tab about three quarters of the width — every mockup of a product the same size.
  const print = await inkOnly(sheet);
  const m = await sharp(print).metadata();
  const pw = m.width ?? 1024;
  const ph = m.height ?? 1024;
  const tabR = Math.round(Math.max(pw, ph) * 0.055);
  const W = Math.round(Math.max((pw + 2 * borderPx) / 0.76, (ph + 2 * borderPx + tabR * 3) / 0.7));
  const H = W;
  const ax = Math.round((W - pw) / 2);
  const ay = Math.round((H - ph + tabR * 1.5) / 2);
  const art = await sharp(print).ensureAlpha().extend({ top: ay, bottom: H - ph - ay, left: ax, right: W - pw - ax, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const alpha = await sharp(art).extractChannel(3).raw().toBuffer();
  const ink = Buffer.alloc(W * H);
  for (let i = 0; i < W * H; i++) ink[i] = alpha[i] > 24 ? 255 : 0;
  const plate = await grow(ink, W, H, borderPx);
  // The tab: a disc over the plate's top edge at the middle of the artwork, the hole through it.
  let top = H;
  let x0 = W;
  let x1 = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (plate[y * W + x]) {
        if (y < top) top = y;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
      }
  const cx = Math.round((x0 + x1) / 2);
  // The plate's top at the middle (the tab sits on what is there, not on the highest point elsewhere).
  let midTop = top;
  for (let y = 0; y < H; y++)
    if ([-2, 0, 2].some((d) => plate[y * W + cx + Math.round((d * tabR) / 4)])) {
      midTop = y;
      break;
    }
  const cy = midTop - Math.round(tabR * 0.45);
  const holeR = Math.round(tabR * 0.45);
  for (let y = Math.max(0, cy - tabR); y <= Math.min(H - 1, cy + tabR); y++)
    for (let x = Math.max(0, cx - tabR); x <= Math.min(W - 1, cx + tabR); x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= tabR * tabR) plate[y * W + x] = 255;
  // A neck between the tab and the plate (the tab must hold).
  for (let y = cy; y <= midTop + borderPx; y++) for (let x = cx - Math.round(tabR * 0.6); x <= cx + Math.round(tabR * 0.6); x++) if (y >= 0 && y < H && x >= 0 && x < W) plate[y * W + x] = 255;
  for (let y = cy - holeR; y <= cy + holeR; y++) for (let x = cx - holeR; x <= cx + holeR; x++) if (y >= 0 && y < H && (x - cx) ** 2 + (y - cy) ** 2 <= holeR * holeR) plate[y * W + x] = 0;
  // The plate: faintly white, its rim brighter with a soft grey line outside (the cut edge's thickness).
  const rimIn = await grow(Buffer.from(plate.map((v) => 255 - v)), W, H, Math.max(2, borderPx * 0.18));
  const outer = await grow(plate, W, H, Math.max(2, borderPx * 0.12));
  const px = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    if (plate[i] && rimIn[i]) {
      px[o] = px[o + 1] = px[o + 2] = 255;
      px[o + 3] = 210;
    } else if (plate[i]) {
      px[o] = 248;
      px[o + 1] = 251;
      px[o + 2] = 255;
      px[o + 3] = 95;
    } else if (outer[i]) {
      px[o] = 150;
      px[o + 1] = 156;
      px[o + 2] = 165;
      px[o + 3] = 150;
    }
  }
  const glass = await sharp(px, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  const shadow = await sharp(Buffer.from(plate), { raw: { width: W, height: H, channels: 1 } }).blur(Math.max(4, borderPx)).extractChannel(0).raw().toBuffer();
  const shade = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) shade[i * 4 + 3] = Math.round(shadow[i] * 0.16);
  const shadowPng = await sharp(shade, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><radialGradient id="g" cx="50%" cy="40%" r="75%"><stop offset="0" stop-color="#f7f7f5"/><stop offset="1" stop-color="#dcdcd8"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`);
  return sharp(bg)
    .composite([
      { input: shadowPng, left: Math.round(borderPx * 0.6), top: Math.round(borderPx * 0.9) },
      { input: glass, left: 0, top: 0 },
      { input: art, left: 0, top: 0 },
    ])
    .flatten({ background: "#eeeeec" })
    .jpeg({ quality: 92 })
    .toBuffer();
}

// ---- the phôi trơn ------------------------------------------------------------------------------------------

/** What the piece is cut to, in sheet px: the khuôn outline, else the whole sheet. */
export function pieceBounds(spec: Pick<CtPrintSpec, "width" | "height" | "outline">): CtBounds {
  return spec.outline ? shapeBounds(spec.outline) : { x: 0, y: 0, w: spec.width, h: spec.height };
}

/** The khuôn drawn as a line drawing (the image model copies its shape and hole). */
async function outlineDrawing(spec: CtPrintSpec): Promise<Buffer> {
  const b = pieceBounds(spec);
  const pad = Math.max(b.w, b.h) * 0.15;
  const vb = `${b.x - pad} ${b.y - pad} ${b.w + 2 * pad} ${b.h + 2 * pad}`;
  const stroke = Math.max(b.w, b.h) / 160;
  const path = (pts: Array<{ x: number; y: number }>) => `M${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("L")}Z`;
  const outline = spec.outline ? path(shapePolygon(spec.outline)) : path([{ x: 0, y: 0 }, { x: spec.width, y: 0 }, { x: spec.width, y: spec.height }, { x: 0, y: spec.height }]);
  const cuts = spec.cuts.map((c) => `<path d="${path(shapePolygon(c))}" fill="#ffffff" stroke="#000" stroke-width="${stroke}"/>`).join("");
  const side = 1024;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" viewBox="${vb}" preserveAspectRatio="xMidYMid meet"><rect x="${b.x - pad}" y="${b.y - pad}" width="${b.w + 2 * pad}" height="${b.h + 2 * pad}" fill="#ffffff"/><path d="${outline}" fill="#eeeeee" stroke="#000" stroke-width="${stroke}"/>${cuts}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * A khuôn given as a picture, drawn from its MASK like outlineDrawing: the sheet framed the same way, the piece filled
 * light grey with one thin black edge — none of the khuôn's own lines (2026-11-12: the Printbelle Round Rug guide's
 * dashed safe-zone line was sent as is and the AI drew it on the blank as stitching).
 */
async function maskDrawing(spec: CtPrintSpec, maskUrl: string): Promise<Buffer> {
  const side = 1024;
  const pad = Math.max(spec.width, spec.height) * 0.15;
  const k = side / (Math.max(spec.width, spec.height) + 2 * pad);
  const w = Math.max(1, Math.round(spec.width * k));
  const h = Math.max(1, Math.round(spec.height * k));
  const { data, info } = await sharp(await fetchImage(maskUrl)).ensureAlpha().resize(w, h, { fit: "fill" }).extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  const c = info.channels;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && data[(y * w + x) * c] > 127;
  const r = Math.max(1, Math.round(side / 400));
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!inside(x, y)) continue;
      let edge = false;
      for (let dy = -r; dy <= r && !edge; dy++) for (let dx = -r; dx <= r && !edge; dx++) if (!inside(x + dx, y + dy)) edge = true;
      const v = edge ? 0 : 0xee;
      const i = (y * w + x) * 4;
      px[i] = v;
      px[i + 1] = v;
      px[i + 2] = v;
      px[i + 3] = 255;
    }
  const piece = await sharp(px, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  return sharp({ create: { width: side, height: side, channels: 3, background: "#ffffff" } })
    .composite([{ input: piece, left: Math.round((side - w) / 2), top: Math.round((side - h) / 2) }])
    .png()
    .toBuffer();
}

/** The prompt of a phôi trơn: the bare piece, straight on, on a plain grey backdrop (so its box can be found). */
export function blankPrompt(label: string, spec: CtPrintSpec | null, material?: string, looks = 0, first = 1, extra = ""): string {
  // A photo of the real piece decides its material: a name with "glass" in it (Printbelle "Stained Glass" is FROSTED)
  // does not make it clear crystal (2026-11-12).
  const glass = material === "glass_clear" || (!looks && isGlass(material, label));
  const nums = Array.from({ length: looks }, (_, i) => first + i).join(", ");
  const size = spec?.widthMm && spec.heightMm ? ` (${Math.round(spec.widthMm)} × ${Math.round(spec.heightMm)} mm)` : "";
  const hole = spec?.cuts.length ? " including the punched hole exactly where the drawing shows it (the small shape inside the outline)" : "";
  // Real photos / a product description tell how the piece is BUILT (Quilt Blanket 2026-11-18: diamond quilting came
  // back as a plain sheet — "no pattern, no stitching line" wiped it): that construction is part of the blank.
  const known = looks > 0 || !!extra.trim();
  return [
    `Studio product photo of ONE blank, unprinted ${label || "product"}${size}, completely plain: no print, no printed picture, no text, no printed pattern, no logo.`,
    known
      ? "Blank means unprinted, NOT unbuilt: the piece keeps its own physical construction exactly as the real product has it (quilted stitch pattern, seams, hem, binding, piping, fabric weave, texture) — that is part of the product, not a print."
      : "",
    spec ? `The piece has EXACTLY the outline of the reference drawing${hole} (its filled area is the piece) — the same shape and proportions.` : "",
    // A khuôn's guide lines (dashed safe zone, bleed) are for the designer, never on the real piece (2026-11-12).
    spec
      ? known
        ? "The drawing is only a shape guide: copy NONE of its lines onto the piece — no dashed or dotted line, no safe-zone or bleed line, no inner border taken from it; any stitching on the face is the real product's own, as described above."
        : "The drawing is only a shape guide: copy NONE of its lines onto the piece — no dashed or dotted line, no inner border or stitching line inside the face, no safe-zone or bleed line; the blank's face is one even, uninterrupted surface up to its edge."
      : "",
    "Shot exactly front-on, camera square to the piece's face (orthographic: no perspective, no tilt, no angle from above or below), centred, the piece filling about 70% of the picture's width.",
    // The print is laid flat on the box found around the piece (2026-11-04: a tilted ceramic disc showed its bottom
    // thickness as a white band and the round print left it bare): only the front face may show.
    "Only the FRONT FACE of the piece is visible: its side, rim depth and thickness are NOT seen anywhere (no band below or beside it), so its silhouette is exactly the outline.",
    "Plain flat medium-grey seamless backdrop (#9a9a9a), soft even studio light, a faint natural shadow.",
    "Nothing attached or around it: no ribbon, no string, no hook, no hanger, no props, no hands.",
    glass ? `The piece is ${GLASS_LOOK}; the grey backdrop shows through it.` : "",
    !glass && material === "acrylic_clear" ? `The piece is ${CLEAR_ACRYLIC_LOOK}; the grey backdrop shows through it.` : "",
    looks
      ? `Reference picture${looks > 1 ? "s" : ""} ${nums} show${looks > 1 ? "" : "s"} the REAL piece the editor sells (a photo of the blank, or of the finished product with a print on it): copy its material, colour, finish, construction (quilting / stitch pattern, seams, hem, binding, texture — same pattern, same scale) and the hole's look exactly — but leave out every print, picture, text, ribbon and prop on it, keep the outline${spec ? " of the drawing" : " they show"}, and never copy its camera angle: a tilted or perspective reference is still shot front-on here. A reference that shows no physical piece is ignored.`
      : "",
    "Photorealistic surface of the real material.",
    extra.trim(),
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * What a base tells the phôi AI about the real piece (2026-11-18: "đọc cấu trúc sản phẩm + xem ảnh phôi của đơn vị
 * fulfill"): the fulfiller's phôi + product photos as references, its name + description as text.
 */
export function baseBlankHints(base: CtBaseProduct): { looks: string[]; extra: string } {
  const cfg = base.config;
  const looks = [...(cfg.preview.url ? [cfg.preview.url] : []), ...(cfg.source?.photos ?? [])].filter((u, i, all) => !!u && all.indexOf(u) === i).slice(0, 3);
  const about = cfg.description.replace(/\s+/g, " ").trim().slice(0, 900);
  const extra = about ? `What the product is (its product page): "${base.name}" — ${about} Draw the blank exactly as this product is built.` : "";
  return { looks, extra };
}

/**
 * Where the piece is on a phôi photo (photo px), found against the backdrop (the corners' colour), fitted to the
 * piece's own aspect; null when nothing sensible is found.
 */
export async function detectPieceBox(photo: Buffer, aspect: number): Promise<CtBounds | null> {
  const fullW = (await sharp(photo).metadata()).width ?? 0;
  const { data, info } = await sharp(photo).removeAlpha().resize({ width: 512, height: 512, fit: "inside" }).raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const ch = info.channels;
  const at = (x: number, y: number) => (y * W + x) * ch;
  const corners = [at(2, 2), at(W - 3, 2), at(2, H - 3), at(W - 3, H - 3)];
  const bg = [0, 1, 2].map((c) => corners.reduce((s, i) => s + data[i + c], 0) / corners.length);
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  let n = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = at(x, y);
      const d = Math.max(Math.abs(data[i] - bg[0]), Math.abs(data[i + 1] - bg[1]), Math.abs(data[i + 2] - bg[2]));
      if (d < 48) continue;
      n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  if (x1 < 0 || n < W * H * 0.03) return null;
  const k = fullW ? fullW / W : 1;
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > W * H * 0.95) return null;
  // The printable FACE, not the whole piece: a photo shows the edge's thickness (a light rim on one side, a darker one
  // on the other — a round ornament's face was ~3 % smaller and off-centre, the print lay over its rim, 2026-10-15).
  // The face = the pixels of the colour at the piece's middle, connected to it; a face that is not one plain colour
  // (wood, a pattern) keeps the whole piece.
  const face = plainFace(data, W, H, ch, { x0, y0, x1, y1 });
  if (face) ({ x0, y0, x1, y1 } = face);
  let w = x1 - x0 + 1;
  let h = y1 - y0 + 1;
  const cx = x0 + w / 2;
  if (Math.abs(w / aspect - h) / Math.max(h, 1) > 0.35) return null;
  if (face) {
    // The face found: the print COVERS it (bleed past the shorter side, never a bare strip), centred on it.
    const cy = y0 + h / 2;
    w = Math.max(w, h * aspect);
    h = w / aspect;
    return { x: (cx - w / 2) * k, y: (cy - h / 2) * k, w: w * k, h: h * k };
  }
  // The whole piece: width wins and the top edge holds (the shadow falls below it, nothing hangs above).
  h = w / aspect;
  return { x: (cx - w / 2) * k, y: y0 * k, w: w * k, h: h * k };
}

/** The plain face of a piece inside its box (512 px raw RGB): the middle's colour (median) flooded from the middle,
 * holes filled by taking the box of what is reached; null when it covers too little of the piece. */
function plainFace(data: Buffer, W: number, H: number, ch: number, b: { x0: number; y0: number; x1: number; y1: number }): { x0: number; y0: number; x1: number; y1: number } | null {
  const cx = Math.round((b.x0 + b.x1) / 2);
  const cy = Math.round((b.y0 + b.y1) / 2);
  const r = Math.max(2, Math.round((b.x1 - b.x0) * 0.08));
  const samples: number[][] = [[], [], []];
  for (let y = cy - r; y <= cy + r; y++)
    for (let x = cx - r; x <= cx + r; x++) for (let c = 0; c < 3; c++) samples[c].push(data[(y * W + x) * ch + c]);
  const med = samples.map((v) => v.sort((p, q) => p - q)[v.length >> 1]);
  // The middle's colour, or the same colour lit brighter: a glossy face has highlights (a ceramic ornament's top
  // band stopped the flood ~1 % short and the print left a strip bare, 2026-10-15). The rim's edge is darker.
  const like = (i: number) => {
    const d = [data[i] - med[0], data[i + 1] - med[1], data[i + 2] - med[2]];
    if (Math.max(...d.map(Math.abs)) <= 9) return true;
    return Math.min(...d) >= -4 && Math.max(...d) - Math.min(...d) <= 12;
  };
  const seen = new Uint8Array(W * H);
  const stack = [cy * W + cx];
  seen[cy * W + cx] = 1;
  let n = 0;
  const out = { x0: W, y0: H, x1: -1, y1: -1 };
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % W;
    const y = (p - x) / W;
    n++;
    if (x < out.x0) out.x0 = x;
    if (x > out.x1) out.x1 = x;
    if (y < out.y0) out.y0 = y;
    if (y > out.y1) out.y1 = y;
    for (const q of [p - 1, p + 1, p - W, p + W]) {
      const qx = q % W;
      const qy = (q - qx) / W;
      if (q < 0 || q >= W * H || seen[q] || Math.abs(qx - x) > 1 || qx < b.x0 || qx > b.x1 || qy < b.y0 || qy > b.y1) continue;
      seen[q] = 1;
      if (like(q * ch)) stack.push(q);
    }
  }
  const pieceArea = (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);
  const faceArea = (out.x1 - out.x0 + 1) * (out.y1 - out.y0 + 1);
  return n > pieceArea * 0.3 && faceArea > pieceArea * 0.8 ? out : null;
}

/** The sheet's box on a phôi photo from the piece's box there (the piece = the khuôn outline of the sheet). */
export function sheetBoxOn(piece: CtBounds, spec: Pick<CtPrintSpec, "width" | "height" | "outline">): CtBounds {
  const ob = pieceBounds(spec);
  const k = piece.w / Math.max(1, ob.w);
  return { x: piece.x - ob.x * k, y: piece.y - ob.y * k, w: spec.width * k, h: spec.height * k };
}

/** A phôi photo with no box found: the sheet in its middle 60 %, a little low (old guess). */
export function guessedBox(photoW: number, photoH: number, sheetW: number, sheetH: number): CtBounds {
  const w = photoW * 0.6;
  const h = (w * sheetH) / sheetW;
  return { x: (photoW - w) / 2, y: Math.max(0, photoH * 0.55 - h / 2), w, h };
}

/** A scene for a phôi photo: the sheet's box detected on it when the piece can be found, else guessed. */
export async function sceneForBlank(photo: Buffer, url: string, spec: Pick<CtPrintSpec, "width" | "height" | "outline">): Promise<CtProductScene> {
  const meta = await sharp(photo).metadata();
  const W = meta.width ?? 1024;
  const H = meta.height ?? 1024;
  const ob = pieceBounds(spec);
  const piece = await detectPieceBox(photo, ob.w / Math.max(1, ob.h)).catch(() => null);
  return { url, width: W, height: H, box: piece ? sheetBoxOn(piece, spec) : guessedBox(W, H, spec.width, spec.height) };
}

/**
 * Make a phôi trơn with the team's image model: the khuôn's outline as a line drawing goes with the prompt (`spec`
 * null = a product without a khuôn in: its name alone). Throws a message for the editor.
 */
/** looks = photos of the real piece (the editor's sample / product pictures, asked 2026-10-29), sent after the outline. */
/** extra = one more English sentence of the agent's / editor's own ("front-on, flat, no thickness"). */
export async function makeBlank(userId: string, label: string, spec: CtPrintSpec | null, material?: string, looks: string[] = [], extra = ""): Promise<Buffer> {
  const refs: string[] = [];
  let guide: string | null = null;
  const face = spec?.faces[0];
  // A khuôn picture without a mask (lines only) is the only one sent as is — its lines are told off in the prompt.
  if (face?.imageUrl && !face.maskUrl && !spec?.outline) refs.push(face.imageUrl);
  else if (spec) {
    guide = `${userId}/${CT_CONFIG.storagePrefix}/blank-guides/${crypto.randomUUID()}.png`;
    const drawing = face?.maskUrl && !spec.outline ? await maskDrawing(spec, face.maskUrl) : await outlineDrawing(spec);
    refs.push(await ctUpload(guide, drawing, "image/png"));
  }
  const model = CT_IMAGE_MODEL;
  let last = "";
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await drawImage(model, blankPrompt(label, spec, material, looks.length, refs.length + 1, extra), [...refs, ...looks], "1:1", "crop");
        return out.data;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
    }
  } finally {
    if (guide) await ctRemove([guide]);
  }
  throw new Error(`Không tạo được phôi: ${last}`);
}

async function ownedProduct(s: CtSession, id: string): Promise<CtProduct | null> {
  const { data } = await s.supabase.from(CT_TABLES.products).select("*").eq("id", id).maybeSingle<CtProduct>();
  return data && (data.user_id === s.user.id || (await isAdmin(s))) ? data : null;
}

async function main(s: CtSession, product: CtProduct): Promise<CtAsset | null> {
  if (!product.main_asset_id) return null;
  const { data } = await s.supabase.from(CT_TABLES.assets).select("*").eq("id", product.main_asset_id).maybeSingle<CtAsset>();
  return data ?? null;
}

/** POST products/:id/blank */
export async function makeProductBlank(s: CtSession, productId: string): Promise<NextResponse> {
  const product = await ownedProduct(s, productId);
  if (!product) return jsonError("Không có quyền sửa sản phẩm này", 403);
  const config = normalizeProductConfig(product.config);
  const board = await main(s, product);
  const spec: CtPrintSpec | null = config.print?.spec ?? null;
  const sheet = spec ?? (board ? { width: board.width, height: board.height, outline: null } : null);
  if (!sheet) return jsonError("Sản phẩm chưa có khung thiết kế", 409);
  try {
    const photo = await makeBlank(s.user.id, config.print?.name || product.name, spec, config.material.id);
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(photo)], { type: "image/png" }), "phoi-tron.png");
    form.set("role", "reference");
    form.set("name", "Phôi trơn (AI)");
    const res = await uploadAsset(s, productId, form);
    const json = (await res.json()) as { asset?: CtAsset; error?: string };
    if (!res.ok || !json.asset) return jsonError(json.error ?? "Không lưu được phôi", 500);
    const scene = await sceneForBlank(photo, json.asset.url, sheet);
    const next = { ...config, scene };
    const { data, error } = await s.supabase.from(CT_TABLES.products).update({ config: next }).eq("id", productId).select("*").single<CtProduct>();
    if (error || !data) return jsonError(error?.message ?? "Không lưu được", 500);
    // The khuôn keeps it too: the next product / brief on the same piece reuses it (server/print-blanks.ts).
    if (config.print?.templateId) {
      const { getTemplate } = await import("./print-templates");
      const { addTemplateBlank } = await import("./print-blanks");
      const t = await getTemplate(s, config.print.templateId);
      if (t) await addTemplateBlank(s.supabase, s.user.id, t, photo, "Phôi AI", true).catch(() => undefined);
    }
    // The phôi it replaces, when it was one of this product's own pictures, goes.
    if (config.scene.url) {
      const { data: old } = await s.supabase.from(CT_TABLES.assets).delete().eq("product_id", productId).eq("role", "reference").eq("url", config.scene.url).select("storage_path").returns<Array<{ storage_path: string }>>();
      await ctRemove((old ?? []).map((o) => o.storage_path));
    }
    return NextResponse.json({ product: data, asset: json.asset });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không tạo được phôi", 500);
  }
}

// ---- mockups ------------------------------------------------------------------------------------------------

/** GET products/:id/mockups */
export async function listMockupJobs(s: CtSession, productId: string): Promise<NextResponse> {
  const { data, error } = await s.supabase.from(CT_TABLES.packImages).select("*").eq("name", jobName(productId)).order("created_at", { ascending: false }).limit(1000).returns<CtPackImage[]>();
  if (error) return jsonError(error.message, 500);
  const jobs = await failOrphans(ctServiceClient() ?? s.supabase, data ?? []);
  return NextResponse.json({ jobs });
}

/**
 * DELETE products/:id/mockups/failed — drops the product's failed mockup cards (asked 2026-11-24: "nút xoá mấy cái
 * này"). Only the failed job rows: a failed job has no photo (url null), its refs are the shared front, so nothing in
 * storage goes; running jobs and the product's mockup photos (assets) are untouched.
 */
export async function clearFailedMockupJobs(s: CtSession, productId: string): Promise<NextResponse> {
  const product = await ownedProduct(s, productId);
  if (!product) return jsonError("Không có quyền sửa sản phẩm này", 403);
  const db = ctServiceClient() ?? s.supabase;
  const { data, error } = await db.from(CT_TABLES.packImages).delete().eq("name", jobName(productId)).eq("status", "failed").select("id");
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ removed: data?.length ?? 0 });
}

/** When this process started: a "running" job last touched before it was drawn by an app that is gone. */
const PROCESS_STARTED = Date.now();
export const ORPHAN_ERROR = "Bị ngắt giữa chừng vì server khởi động lại (triển khai bản mới) — bấm Tạo mockup để vẽ lại.";

/**
 * Jobs are drawn in this process's memory (drawMockupJob): a restart loses them and their rows stayed "running" for
 * good — the card spun forever with no error (2026-11-18, product fbf93189). A running row this process is not
 * drawing and that was last touched before it started is marked failed.
 */
export async function failOrphans(db: MockDb, jobs: CtPackImage[]): Promise<CtPackImage[]> {
  const orphans = jobs.filter((j) => j.status === "running" && !activeJobs.has(j.id) && Date.parse(j.created_at) < PROCESS_STARTED);
  if (!orphans.length) return jobs;
  const ids = orphans.map((j) => j.id);
  const { error } = await db.from(CT_TABLES.packImages).update({ status: "failed", error: ORPHAN_ERROR }).in("id", ids).eq("status", "running");
  if (error) return jobs;
  return jobs.map((j) => (ids.includes(j.id) ? { ...j, status: "failed" as const, error: ORPHAN_ERROR } : j));
}

const NO_SCENES = "Không có prompt cảnh nào để tạo mockup — điền ô Mockups của sản phẩm hoặc ô «Cảnh» ở trang product base.";

/** The form's "scenes": JSON of prompts — strings, or blocks {prompt, refs} (asked 2026-11-23: refs per prompt). */
function parseBlocks(raw: FormDataEntryValue | null): CtMockupBlock[] {
  if (typeof raw !== "string" || !raw) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  const bad = badBlockRefs(v);
  if (bad) throw new Error(bad);
  return mockupBlockList(v);
}

/** Same prompts, same pictures. */
function sameBlocks(a: CtMockupBlock[], b: CtMockupBlock[]): boolean {
  return a.length === b.length && a.every((x, i) => x.prompt === b[i].prompt && x.refs.join("\n") === b[i].refs.join("\n"));
}

/** The base's scenes as blocks: each scene with no pictures of its own (the base's refs go with it when drawn). */
function baseBlocks(base: CtBaseMockup): CtMockupBlock[] {
  return base.scenes.trim() ? splitScenes(base.scenes).scenes.map((prompt) => ({ prompt, refs: [] })) : [];
}

/** The blocks kept on the product: [] when they are only its base's scenes with no pictures of their own. */
async function ownBlocks(db: MockDb, product: CtProduct, blocks: CtMockupBlock[]): Promise<CtMockupBlock[]> {
  if (!blocks.length) return [];
  return sameBlocks(blocks, baseBlocks(await baseMockup(db, product))) ? [] : blocks;
}

/** The blocks of the editor's last "Tạo mockup" kept on the product (CtProductConfig.mockupBlocks) — the bulk "Tạo
 * mockup" uses them — and whether its mockups were each a different custom pick (CtProductConfig.mockupVary). */
async function keepBlocks(s: CtSession, product: CtProduct, blocks: CtMockupBlock[], vary: boolean | null): Promise<void> {
  const config = normalizeProductConfig(product.config);
  // Left as the base's prompts: nothing of its own — the product keeps following its base (asked 2026-11-18).
  const next = await ownBlocks(ctServiceClient() ?? s.supabase, product, blocks);
  if (sameBlocks(config.mockupBlocks, next) && (vary === null || config.mockupVary === vary)) return;
  await s.supabase.from(CT_TABLES.products).update({ config: { ...config, mockupBlocks: next, ...(vary === null ? {} : { mockupVary: vary }) } }).eq("id", product.id);
}

/** The base's mockup prompts (CtBaseProductConfig.mockup); empty when the product has no base. */
async function baseMockup(db: MockDb, product: CtProduct): Promise<CtBaseMockup> {
  if (!product.base_product_id) return normalizeBaseMockup(null);
  const { data } = await db.from(CT_TABLES.baseProducts).select("config").eq("id", product.base_product_id).maybeSingle<{ config: { mockup?: unknown } | null }>();
  return normalizeBaseMockup(data?.config?.mockup);
}

/**
 * The wrap sentence and the base's reference pictures: the base's wrap (a product has none of its own); a block
 * without pictures of its own is sent with the base's refs. No hidden prompt (asked 2026-11-18: "trống là trống").
 * An empty wrap is allowed (asked 2026-11-19): then each scene IS the whole prompt. A wrap without {scene} is refused.
 */
async function mockupSetup(db: MockDb, product: CtProduct): Promise<{ wrap: string; baseRefs: string[] }> {
  if (!product.base_product_id) throw new Error("Sản phẩm chưa gắn product base — không có prompt mockup.");
  const base = await baseMockup(db, product);
  if (base.wrap.trim() && !base.wrap.includes("{scene}")) throw new Error("Câu bọc prompt mockup của product base thiếu {scene} — thêm {scene} vào chỗ đặt cảnh ở trang product base.");
  // This product's own replacement of the base's pictures wins (asked 2026-11-24, CtProductConfig.mockupBaseRefs).
  const own = normalizeProductConfig(product.config).mockupBaseRefs;
  return { wrap: base.wrap.trim() ? base.wrap : "{scene}", baseRefs: own ?? base.refs.slice(0, CT_MOCKUP_REFS_MAX) };
}

/** POST products/:id/mockups/prompt {} — the editor's "Dùng prompt của product base": drops the product's own blocks. */
export async function clearOwnMockupScenes(s: CtSession, productId: string): Promise<NextResponse> {
  const product = await ownedProduct(s, productId);
  if (!product) return jsonError("Không có quyền sửa sản phẩm này", 403);
  const config = normalizeProductConfig(product.config);
  const { data, error } = await s.supabase.from(CT_TABLES.products).update({ config: { ...config, mockupBlocks: [] } }).eq("id", product.id).select("*").single<CtProduct>();
  if (error || !data) return jsonError(error?.message ?? "Không lưu được", 500);
  return NextResponse.json({ product: data });
}

/**
 * POST products/:id/mockups/base-refs {refs: string[] | null} — the base's reference pictures for THIS product only
 * (asked 2026-11-24: drop one, put another in, the base itself untouched). null = back to the base's own.
 */
export async function setOwnBaseRefs(s: CtSession, productId: string, raw: unknown): Promise<NextResponse> {
  const product = await ownedProduct(s, productId);
  if (!product) return jsonError("Không có quyền sửa sản phẩm này", 403);
  const given = raw && typeof raw === "object" ? (raw as { refs?: unknown }).refs : undefined;
  let refs: string[] | null = null;
  if (given !== null && given !== undefined) {
    if (!Array.isArray(given)) return jsonError("refs phải là danh sách url https hoặc null", 400);
    refs = mockupRefList(given, CT_MOCKUP_BLOCK_REFS_MAX);
    if (given.length > refs.length) return jsonError(`Ảnh tham chiếu chỉ nhận url https, không trùng, tối đa ${CT_MOCKUP_BLOCK_REFS_MAX} ảnh`, 400);
  }
  // Exactly the base's own pictures → follow the base again, its later changes come through (same rule for the
  // editor, the API and MCP set_product_mockup_prompt).
  if (refs && refs.join("\n") === (await baseMockup(ctServiceClient() ?? s.supabase, product)).refs.slice(0, CT_MOCKUP_REFS_MAX).join("\n")) refs = null;
  const config = normalizeProductConfig(product.config);
  const { data, error } = await s.supabase.from(CT_TABLES.products).update({ config: { ...config, mockupBaseRefs: refs } }).eq("id", product.id).select("*").single<CtProduct>();
  if (error || !data) return jsonError(error?.message ?? "Không lưu được", 500);
  return NextResponse.json({ product: data });
}

/** POST products/:id/mockups/blocks {blocks: [{prompt, refs}]} — the product's own prompt blocks ([] = back to its base's). */
export async function setOwnMockupBlocks(s: CtSession, productId: string, raw: unknown): Promise<NextResponse> {
  const product = await ownedProduct(s, productId);
  if (!product) return jsonError("Không có quyền sửa sản phẩm này", 403);
  const blocks = raw && typeof raw === "object" ? (raw as { blocks?: unknown }).blocks : undefined;
  try {
    return NextResponse.json({ product: await saveOwnMockupPrompt(s.supabase, product, { blocks: Array.isArray(blocks) ? blocks : [] }) });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không lưu được", 400);
  }
}

/**
 * What a product's next mockups are drawn with (MCP get_product_mockup_prompt): its blocks (its own, else its base's
 * scenes), the base's wrap, and the shared reference pictures sent with every block that has none of its own — the
 * product's own set (config.mockupBaseRefs) or its base's.
 */
export async function productMockupPrompt(db: MockDb, product: CtProduct): Promise<{
  blocks: CtMockupBlock[];
  blocksFrom: "product" | "base" | "none";
  wrap: string;
  sharedRefs: string[];
  sharedRefsFrom: "product" | "base";
  baseRefs: string[];
}> {
  const base = await baseMockup(db, product);
  const own = normalizeProductConfig(product.config).mockupBaseRefs;
  const baseRefs = base.refs.slice(0, CT_MOCKUP_REFS_MAX);
  const { blocks, from } = await productBlocks(db, product);
  return { blocks, blocksFrom: from, wrap: base.wrap, sharedRefs: own ?? baseRefs, sharedRefsFrom: own ? "product" : "base", baseRefs };
}

/** The prompt blocks a product's mockups use when none are given: its own, else its base's scenes, else none (refused when drawn). */
export async function productBlocks(db: MockDb, product: CtProduct): Promise<{ blocks: CtMockupBlock[]; from: "product" | "base" | "none" }> {
  const config = normalizeProductConfig(product.config);
  if (config.mockupBlocks.length) return { blocks: config.mockupBlocks, from: "product" };
  const base = baseBlocks(await baseMockup(db, product));
  return base.length ? { blocks: base, from: "base" } : { blocks: [], from: "none" };
}

/**
 * Keeps a product's own mockup prompts (sent over MCP — asked 2026-11-17: "prompt gửi kèm qua MCP lưu riêng vào sản
 * phẩm"; asked 2026-11-23: one block per prompt with its own pictures). blocks = [{prompt, refs}] or prompt strings;
 * scenes = the older one-text form (split like the old Mockups box, no pictures). undefined = unchanged, [] / "" = back
 * to the base's. Refuses (throws) what the editor would refuse.
 */
export async function saveOwnMockupPrompt(db: MockDb, product: CtProduct, own: { blocks?: unknown; scenes?: string }): Promise<CtProduct> {
  let blocks: CtMockupBlock[] | undefined;
  if (own.blocks !== undefined) {
    const bad = badBlockRefs(own.blocks);
    if (bad) throw new Error(bad);
    blocks = mockupBlockList(own.blocks);
  } else if (own.scenes !== undefined) blocks = splitScenes(own.scenes).scenes.map((prompt) => ({ prompt, refs: [] }));
  if (!blocks) return product;
  const config = normalizeProductConfig(product.config);
  const next = { ...config, mockupBlocks: await ownBlocks(db, product, blocks) };
  const { data, error } = await db.from(CT_TABLES.products).update({ config: next }).eq("id", product.id).select("*").single<CtProduct>();
  if (error) throw new Error(error.message);
  return data;
}

/** POST products/:id/mockups */
export async function makeProductMockups(s: CtSession, productId: string, form: FormData): Promise<NextResponse> {
  const product = await ownedProduct(s, productId);
  if (!product) return jsonError("Không có quyền sửa sản phẩm này", 403);
  // One print for every scene, or one per scene (each mockup a different custom pick, lib/mockup-variants.ts).
  const files = form.getAll("print").flatMap((f) => (f instanceof Blob && f.size > 0 ? [f] : []));
  if (!files.length) return jsonError("Thiếu artwork", 400);
  // No limit on how many prompts or how long (asked 2026-11-18).
  let given: CtMockupBlock[];
  try {
    given = parseBlocks(form.get("scenes"));
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Prompt không hợp lệ", 400);
  }
  const blocks = given.length ? given : (await productBlocks(ctServiceClient() ?? s.supabase, product)).blocks;
  if (!blocks.length) return jsonError(NO_SCENES, 400);
  if (files.length > 1 && files.length !== Math.max(1, blocks.length)) return jsonError(`${files.length} artwork cho ${blocks.length} prompt — mỗi prompt 1 artwork`, 400);
  try {
    const prints = await Promise.all(files.map(async (f) => Buffer.from(await f.arrayBuffer())));
    const out = await productMockups(s, product, prints.length === 1 ? prints[0] : prints, blocks);
    const vary = form.get("vary");
    // keep=1: the blocks given are the product's own from now on (the editor's Tạo mockup).
    if (given.length && form.get("keep") === "1") await keepBlocks(s, product, given, vary === "1" ? true : vary === "0" ? false : null).catch(() => undefined);
    return NextResponse.json(out, { status: 202 });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không lưu được mockup", 500);
  }
}

/**
 * POST products/:id/mockups/auto (the product list's bulk "Tạo mockup", asked 2026-11-17): the same mockups as the
 * editor's button, made on the server — the product's own prompts (its Mockups box as last used, else the defaults for
 * its name), each drawn from a different custom pick (lib/mockup-variants.ts: version, options, names, a sample
 * person in each photo zone — server/mockup-samples.ts) unless the box was last used with that off; a product with
 * nothing to customise, or with it off: the design's own content (Thiết kế, config.samples).
 */
export async function autoProductMockups(s: CtSession, productId: string): Promise<NextResponse> {
  const product = await ownedProduct(s, productId);
  if (!product) return jsonError("Không có quyền sửa sản phẩm này", 403);
  if ((product.kind ?? "artwork") !== "product") return jsonError("Đây là artwork — mockup làm trên sản phẩm", 400);
  const config = normalizeProductConfig(product.config);
  // Still drawing from an earlier click (2026-11-19: a product clicked 4 times queued 40 photos ahead of the others,
  // the bulk report said "Xong" each time): refused with how many are left.
  const { data: open } = await (ctServiceClient() ?? s.supabase).from(CT_TABLES.packImages).select("*").eq("name", jobName(productId)).eq("status", "running").returns<CtPackImage[]>();
  const running = (await failOrphans(ctServiceClient() ?? s.supabase, open ?? [])).filter((j) => j.status === "running");
  if (running.length) return jsonError(`Sản phẩm còn ${running.length} ảnh mockup đang vẽ/chờ từ lần bấm trước — chờ xong rồi tạo tiếp`, 409);
  const { blocks } = await productBlocks(ctServiceClient() ?? s.supabase, product);
  if (!blocks.length) return jsonError(NO_SCENES, 400);
  const { loadArtwork, renderArtwork } = await import("./print-render");
  const bundle = await loadArtwork(s.supabase, productId);
  if (!bundle) return jsonError("Không đọc được thiết kế của sản phẩm", 404);
  try {
    // With the version's own picture, like the editor's Tạo mockup (lib/compositor draws it): an artwork that IS one
    // picture (Girl Soccer blanket, 2026-11-17) gave an empty print and a blank front mockup.
    const side = mockupPrintSide(bundle.spec);
    const render = (selection: CtSelection) => renderArtwork(bundle, selection, side, "print", { withMain: true });
    // The sample names / people (~1 min) are drawn in the background: the rows come back at once.
    if (config.mockupVary && canVaryMockups(product, bundle)) return NextResponse.json({ jobs: (await variedProductMockups(s, product, bundle, config.samples, blocks)).jobs }, { status: 202 });
    return NextResponse.json(await productMockups(s, product, await render(config.samples), blocks), { status: 202 });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không tạo được mockup", 500);
  }
}

/**
 * The mockups of one print of a product (the editor's Mockups tab, a bộ nhân vật's step 4, @flexiprint over MCP —
 * one pipeline): one AI lifestyle photo per scene (jobs running in the background), each drawn from the front picture
 * = the print laid exactly on the phôi with its own light (no AI). The front is only that reference (2026-10-30: "không
 * đưa mockup phôi trơn, cũng không cần tạo phôi trơn có artwork") — a file, not a mockup of the product: the
 * product's pictures, and what Deploy sends to Shopify, are the scene photos. `label` names the option set when
 * several prints of one product are mocked up ("Christmas — Snowflakes").
 */
export async function productMockups(s: CtSession, product: CtProduct, print: Buffer | Buffer[], scenes: Array<string | CtMockupBlock>, label = ""): Promise<{ jobs: CtPackImage[]; front: { url: string } }> {
  // One print for every scene, or one per scene (asked 2026-11-17: each mockup a different custom pick —
  // lib/mockup-variants.ts): scene i is drawn from print i.
  const prints = Array.isArray(print) ? print : [print];
  if (!prints.length) throw new Error("Thiếu artwork");
  const rows = await mockupRows(s, product, scenes);
  return startMockupRows(s, product, rows, prints);
}

/**
 * The rows of a mockup run, one per prompt, inserted 'running' before any picture exists (the prompts first: nothing
 * to draw from = refused, never a built-in one). refs = the prompt's own pictures; startMockupRows puts the front first.
 */
async function mockupRows(s: CtSession, product: CtProduct, scenes: Array<string | CtMockupBlock>): Promise<CtPackImage[]> {
  const config = normalizeProductConfig(product.config);
  const piece = config.print?.name || product.name;
  const want = mockupBlockList(scenes);
  if (!want.length) throw new Error(NO_SCENES);
  const db = ctServiceClient() ?? s.supabase;
  const { wrap, baseRefs } = await mockupSetup(db, product);
  // One square for every scene (a 4:5 one was drawn 2:3 and cropped — the ornament's ends were cut off, 2026-10-22).
  const sceneAspect = MOCKUP_ASPECT;
  const model = CT_IMAGE_MODEL;
  const rows: CtPackImage[] = [];
  // The prompt = the base's wrap with {product} / {scene} filled (its page, CtBaseMockup — asked 2026-11-17: "prompt
  // tạo mockup đưa ra khỏi code"); no wrap = the scene alone ({product} filled); nothing added by the code.
  // Each block's own pictures go with its prompt only (asked 2026-11-23); a block with none takes the base's.
  for (const block of want) {
    const sc = block.prompt;
    const refs = block.refs.length ? block.refs : baseRefs;
    const prompt = fillMockupWrap(wrap, piece, sc);
    const { data: row } = await db
      .from(CT_TABLES.packImages)
      .insert({ user_id: s.user.id, name: jobName(product.id), source: "ai", status: "running", listed: false, description: sc, prompt, refs, aspect: sceneAspect, model })
      .select("*")
      .single<CtPackImage>();
    if (row) {
      // Not an orphan while its prints are made (a list in between must not fail it).
      activeJobs.add(row.id);
      rows.push(row);
    }
  }
  return rows;
}

/** Rows that will not draw: failed with why. */
async function failRows(s: CtSession, rows: CtPackImage[], why: string): Promise<void> {
  const db = ctServiceClient() ?? s.supabase;
  for (const r of rows) activeJobs.delete(r.id);
  if (rows.length) await db.from(CT_TABLES.packImages).update({ status: "failed", error: why }).in("id", rows.map((r) => r.id)).eq("status", "running");
}

/**
 * Row i drawn from print i (or the only print): its front — the print laid exactly on the phôi with its own light, no
 * AI — goes first in its refs, then it draws in the background. The front is only that reference (2026-10-30: "không
 * đưa mockup phôi trơn, cũng không cần tạo phôi trơn có artwork"). A failure here fails the rows.
 */
async function startMockupRows(s: CtSession, product: CtProduct, rows: CtPackImage[], prints: Buffer[]): Promise<{ jobs: CtPackImage[]; front: { url: string } }> {
  const productId = product.id;
  const config = normalizeProductConfig(product.config);
  const db = ctServiceClient() ?? s.supabase;
  let fronts: Array<{ url: string }>;
  try {
    // A die-cut acrylic: its plate made from the artwork's outline (+ the border, the hanging tab). Without a phôi: on white.
    const dieCut = config.print?.kind === "cut" || (config.material.id.startsWith("acrylic") && config.material.shape === "contour");
    const blank = config.scene.url && config.scene.box.w > 0 ? await fetchImage(config.scene.url) : null;
    const overlay = blank && config.scene.overlay ? await fetchImage(config.scene.overlay).catch(() => null) : null;
    const frontOf = async (art: Buffer): Promise<{ url: string }> => {
      let front: Buffer;
      if (blank) front = await frontMockup(blank, art, config.scene.box, overlay, materialPreset(config.material.id).whiteInk);
      else if (dieCut) {
        const pw = (await sharp(art).metadata()).width ?? 1024;
        const mm = config.print?.spec.widthMm || config.material.widthMm || 90;
        front = await acrylicFront(art, Math.max(4, Math.round((config.material.borderMm || 2.5) * (pw / mm))));
      } else {
        const m = await sharp(art).metadata();
        const pad = Math.round(Math.max(m.width ?? 0, m.height ?? 0) * 0.08);
        front = await sharp(art).flatten({ background: "#ffffff" }).extend({ top: pad, bottom: pad, left: pad, right: pad, background: "#ffffff" }).jpeg({ quality: 92 }).toBuffer();
      }
      front = await squared(front);
      return { url: await ctUpload(`${s.user.id}/${CT_CONFIG.storagePrefix}/${productId}/mockup-ref/${crypto.randomUUID()}.jpg`, front, "image/jpeg") };
    };
    fronts = await Promise.all(prints.map(frontOf));
  } catch (e) {
    await failRows(s, rows, e instanceof Error ? e.message : String(e));
    throw e;
  }
  const jobs: CtPackImage[] = [];
  for (const [i, row] of rows.entries()) {
    const refs = [(fronts[i] ?? fronts[0]).url, ...row.refs];
    await db.from(CT_TABLES.packImages).update({ refs }).eq("id", row.id);
    const ready = { ...row, refs };
    jobs.push(ready);
    drawMockupJob(s, productId, ready);
  }
  return { jobs, front: fronts[0] };
}

/**
 * Mockups each drawn from a different custom pick (lib/mockup-variants.ts: version, options, names, a sample person /
 * a drawn name in each photo zone — server/mockup-samples.ts), answered at once: the rows are 'running' while the
 * samples (~1 min, the image model) and the prints are made in the background, then each draws. `pinned` = picks the
 * caller chose (MCP options): kept in every variant; a pinned version keeps every variant on it.
 */
export async function variedProductMockups(
  s: CtSession,
  product: CtProduct,
  bundle: ArtworkBundle,
  base: CtSelection,
  scenes: Array<string | CtMockupBlock>,
  pinned: CtSelection = {},
): Promise<{ jobs: CtPackImage[]; picks: string[] }> {
  const config = normalizeProductConfig(product.config);
  const want = mockupBlockList(scenes);
  const version = pinned[CT_MAIN_KEY]?.kind === "main" ? pinned[CT_MAIN_KEY] : null;
  const variants = mockupVariants({
    regions: bundle.regions,
    items: bundle.items,
    assets: bundle.assets,
    base,
    main: version ? { ...config.main, enabled: false } : config.main,
    defaultMainId: version ? version.assetId : product.main_asset_id,
    count: Math.max(1, want.length),
  });
  for (const v of variants) v.selection = resolveLinked(bundle.regions, bundle.items, bundle.assets, { ...v.selection, ...pinned });
  const rows = await mockupRows(s, product, want);
  void (async () => {
    try {
      const missed = await fillVariantPhotos(s, product, bundle.regions, variants);
      if (missed.length) console.warn(`[ct] mockup samples ${product.id}: ${missed.join("; ")}`);
      const { renderArtwork } = await import("./print-render");
      const side = mockupPrintSide(bundle.spec);
      // One after another (2026-11-27: 20 variants rendered at once took every core of the server).
      const prints: Buffer[] = [];
      for (const v of variants) prints.push(await renderArtwork(bundle, v.selection, side, "print", { withMain: true }));
      await startMockupRows(s, product, rows, prints);
    } catch (e) {
      await failRows(s, rows, e instanceof Error ? e.message : String(e));
    }
  })();
  return { jobs: rows, picks: variants.map((v) => v.label) };
}

/** Whether the customer can change anything on the product (versions, layer options, texts, photo / name zones). */
export function canVaryMockups(product: CtProduct, bundle: ArtworkBundle): boolean {
  return isCustomizable(customizable(bundle.regions, bundle.items, bundle.assets, normalizeProductConfig(product.config).main, product.main_asset_id));
}

/** A finished mockup photo added to the product's pictures. */
async function mockupToProduct(s: CtSession, productId: string, data: Buffer, name: string): Promise<CtAsset> {
  const f = new FormData();
  f.set("file", new Blob([new Uint8Array(data)], { type: "image/jpeg" }), `${name}.jpg`);
  f.set("role", "mockup");
  f.set("name", name);
  const res = await uploadAsset(s, productId, f);
  const json = (await res.json()) as { asset?: CtAsset; error?: string };
  if (!res.ok || !json.asset) throw new Error(json.error ?? "Không lưu được mockup");
  return json.asset;
}

/**
 * Mockup photos drawn at once, all products together (2026-11-17: a bulk "Tạo mockup" of 20 products would send ~60
 * at the same time to the image model). The rest wait their turn (still "running" on their card).
 */
// How many at once = 2 × the CPA accounts that can draw right now (asked 2026-11-19), read from the gate's account
// list (CPA_STATUS_URL + CPA_STATUS_KEY — a key that sees only codex accounts) every minute; unreadable = 4 as before.
const MOCKUP_PARALLEL_FALLBACK = 4;
const MOCKUP_PARALLEL_MAX = 30;
let parallel = { n: MOCKUP_PARALLEL_FALLBACK, at: 0 };
/** When the account list was last read. Unreadable for 5 min = back to the fallback (2026-11-27: the list timed out
 * every minute for hours and the last count, 30 at once, was kept — 30 mockups drawn together on an 8-core server). */
let parallelReadAt = 0;
async function mockupParallel(): Promise<number> {
  if (Date.now() - parallel.at < 60_000) return parallel.n;
  parallel.at = Date.now();
  const key = process.env.CPA_STATUS_KEY;
  const base = (process.env.CPA_STATUS_URL || process.env.CPA_FALLBACK_BASE_URL || "").replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  if (!key || !base) return parallel.n;
  try {
    const r = await fetch(`${base}/v0/management/auth-files`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    const j = (await r.json()) as { files?: Array<{ provider?: string; status?: string; disabled?: boolean; unavailable?: boolean; cooldowns?: Array<{ model_key?: string; retry_at?: string }> }> };
    if (!r.ok || !Array.isArray(j.files)) throw new Error(`auth-files ${r.status}`);
    const now = Date.now();
    const ready = j.files.filter(
      (a) => a.provider === "codex" && a.status === "active" && !a.disabled && !a.unavailable && !(a.cooldowns ?? []).some((c) => /image/i.test(c.model_key ?? "") && Date.parse(c.retry_at ?? "") > now),
    ).length;
    const n = Math.min(MOCKUP_PARALLEL_MAX, Math.max(2, ready * 2));
    if (n !== parallel.n) console.log(`[ct] mockup parallel ${parallel.n} → ${n} (${ready} CPA accounts ready)`);
    parallel = { n, at: now };
    parallelReadAt = now;
  } catch (e) {
    if (Date.now() - parallelReadAt > 5 * 60_000) parallel = { n: MOCKUP_PARALLEL_FALLBACK, at: parallel.at };
    console.warn(`[ct] CPA account count: ${e instanceof Error ? e.message : String(e)} — keeping ${parallel.n}`);
  }
  return parallel.n;
}
let drawing = 0;
const waiting: Array<() => void> = [];
/** Let in as many waiting jobs as the current limit allows. */
function admit(limit: number): void {
  while (drawing < limit && waiting.length) {
    drawing++;
    waiting.shift()!();
  }
}
async function mockupSlot(): Promise<() => void> {
  const limit = await mockupParallel();
  if (drawing < limit && !waiting.length) drawing++;
  else {
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
      admit(limit);
    });
  }
  return () => {
    drawing--;
    void mockupParallel().then(admit);
  };
}

/** One mockup job drawn in the background from its row (prompt, the front picture in refs) → done (a product picture) / failed. */
const activeJobs = new Set<string>();
function drawMockupJob(s: CtSession, productId: string, row: CtPackImage): void {
  const db = ctServiceClient() ?? s.supabase;
  activeJobs.add(row.id);
  void (async () => {
    const release = await mockupSlot();
    try {
      await drawMockupNow(db, s, productId, row);
    } finally {
      release();
      activeJobs.delete(row.id);
    }
  })();
}

async function drawMockupNow(db: NonNullable<ReturnType<typeof ctServiceClient>> | CtSession["supabase"], s: CtSession, productId: string, row: CtPackImage): Promise<void> {
  {
    let last = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await drawImage(CT_IMAGE_MODEL, row.prompt, row.refs.slice(0, 1 + CT_MOCKUP_BLOCK_REFS_MAX), row.aspect || MOCKUP_ASPECT, "crop");
        const jpeg = await squared(await sharp(out.data).flatten({ background: "#ffffff" }).png().toBuffer());
        const asset = await mockupToProduct(s, productId, jpeg, `mockup_${row.description.split(/\s+/).slice(0, 4).join("_")}`);
        const m = await sharp(jpeg).metadata();
        await db.from(CT_TABLES.packImages).update({ status: "done", url: asset.url, mime: "image/jpeg", width: m.width ?? null, height: m.height ?? null, error: "" }).eq("id", row.id);
        return;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
        // Refused by the model's safety system: the same prompt is refused again — no second try.
        if (isSafetyRefusal(last)) break;
      }
    }
    await db.from(CT_TABLES.packImages).update({ status: "failed", error: last.slice(0, 1000) }).eq("id", row.id);
  }
}

/** The image model refused the request on safety grounds (gpt-image: "rejected by the safety system … safety_violations=[…]"). */
export function isSafetyRefusal(error: string): boolean {
  return /safety system|safety_violations|moderation_blocked|content policy/i.test(error);
}

/**
 * A failed mockup job drawn again with a new prompt (asked 2026-11-12: a scene refused for "sensitive words" goes to
 * @flexiprint, which rewrites the prompt and sends it again) — the same job row, so its card in the Mockups tab turns
 * back to running and then to the photo.
 */
export async function retryMockupJob(s: CtSession, productId: string, jobId: string, prompt: string): Promise<CtPackImage> {
  const db = ctServiceClient() ?? s.supabase;
  const { data: row } = await db.from(CT_TABLES.packImages).select("*").eq("id", jobId).eq("name", jobName(productId)).maybeSingle<CtPackImage>();
  if (!row) throw new Error("Không có job mockup này");
  if (row.status === "running") throw new Error("Job đang chạy — chờ nó xong");
  if (!row.refs.length) throw new Error("Job không có ảnh tham chiếu (front)");
  activeJobs.add(jobId); // before the row turns running: a list in between must not take it for an orphan
  const { data: next, error } = await db.from(CT_TABLES.packImages).update({ prompt, status: "running", error: "", url: null }).eq("id", jobId).select("*").single<CtPackImage>();
  if (error || !next) {
    activeJobs.delete(jobId);
    throw new Error(error?.message ?? "Không cập nhật được job");
  }
  drawMockupJob(s, productId, next);
  return next;
}
