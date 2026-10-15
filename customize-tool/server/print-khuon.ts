/**
 * Khuôn made / changed by AI (asked 2026-10-10): the editor gives a sample product photo or a pattern drawing and
 * says what they want ("quần in 2 mặt trước / sau, chỉ làm 1 ống, cạp không in"), or numbers from the factory; the
 * image model draws the khuôn in a strict colour code — printed area pure green, everything else white — and the
 * server reads it back exactly:
 *
 *   mask   alpha 255 where ink goes (holes / non-printed parts / outside = 0), at the sheet size — what the print
 *          file is cut to (lib/compositor cutToFrame)
 *   guide  the cut line (solid) and the safe zone (dashed, a band inside it) for the editor
 *   image  a clean picture of the khuôn (light fill + guide) for cards and as the next round's reference
 *
 *   POST print-templates/ai  CtPrintAiRequest (+ base: the faces of an unsaved round to change) → CtPrintAiResult
 *
 * Nothing is saved to the template here: the editor looks, asks again, then keeps one (PATCH / POST template).
 */

import sharp, { type Sharp } from "sharp";
import { NextResponse } from "next/server";
import { CT_CONFIG } from "../config";
import type { CtPrintAiRequest, CtPrintAiResult, CtPrintFace, CtPrintSpec } from "../types/print";
import { newId } from "../lib/geometry";
import { shapePolygon } from "../lib/material-frame";
import { drawImage } from "./pack-images";
import { getTemplate } from "./print-templates";
import { CT_IMAGE_MODEL } from "../lib/image-models";
import { ctRemove, ctUpload } from "./storage";
import type { CtSession } from "./supabase";

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/** Long side of a sheet when the editor gave no size. */
const DEFAULT_LONG_SIDE = 3000;

const folder = (userId: string) => `${userId}/${CT_CONFIG.storagePrefix}/khuon`;

async function put(userId: string, data: Buffer, name: string): Promise<{ url: string; path: string }> {
  const path = `${folder(userId)}/${name}-${crypto.randomUUID()}.png`;
  return { url: await ctUpload(path, data, "image/png"), path };
}

/** A face's printed area as a green-on-white drawing (the reference of the next round). */
async function greenDrawing(spec: CtPrintSpec, face: CtPrintFace | null): Promise<Buffer | null> {
  if (face?.maskUrl) {
    const res = await fetch(face.maskUrl, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return null;
    const mask = await sharp(Buffer.from(await res.arrayBuffer())).ensureAlpha().extractChannel(3).toBuffer();
    const meta = await sharp(mask).metadata();
    const green = await sharp({ create: { width: meta.width ?? 1, height: meta.height ?? 1, channels: 3, background: "#00ff00" } }).joinChannel(mask).png().toBuffer();
    return sharp({ create: { width: meta.width ?? 1, height: meta.height ?? 1, channels: 3, background: "#ffffff" } }).composite([{ input: green }]).png().toBuffer();
  }
  if (face?.imageUrl) {
    const res = await fetch(face.imageUrl, { signal: AbortSignal.timeout(60_000) });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  }
  // A khuôn drawn by shapes (a round ornament): the outline minus its cuts.
  const path = (pts: Array<{ x: number; y: number }>) => `M${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("L")}Z`;
  const outline = spec.outline ? path(shapePolygon(spec.outline)) : `M0,0L${spec.width},0L${spec.width},${spec.height}L0,${spec.height}Z`;
  const cuts = spec.cuts.map((c) => path(shapePolygon(c))).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${spec.width}" height="${spec.height}" viewBox="0 0 ${spec.width} ${spec.height}"><rect width="100%" height="100%" fill="#ffffff"/><path d="${outline}${cuts}" fill="#00ff00" fill-rule="evenodd"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function promptFor(req: CtPrintAiRequest, name: string, face: string, faces: number, base: boolean): string {
  return [
    base
      ? `The first reference picture is the CURRENT print template (khuôn in) of "${name}": green = printed area, white = not printed. Change it as asked and keep everything else exactly the same.`
      : `Make a flat 2D print template (khuôn in / sewing-and-print pattern) for: ${name}.`,
    req.prompt ? `What the editor wants: ${req.prompt}` : "",
    faces > 1 ? `This drawing is ONLY the "${face}" face of the piece.` : "",
    req.mirror ? "Draw ONLY ONE half of the symmetric piece (for trousers: one leg; for a shirt: one side) — the other half is made later by mirroring it, so do not draw it." : "",
    req.refs.length ? "The other reference pictures show the real product or its pattern: take the shapes and proportions of the pieces from them." : "",
    req.width && req.height ? `The sheet is ${req.width} × ${req.height} (width × height); fit the piece into it.` : "",
    "STRICT COLOUR CODE: every area that gets printed is filled with flat pure green #00FF00. Everything else — the background, holes, cut-outs, parts that are not printed (an unprinted waistband, cuffs, a hanging hole) — is pure white #FFFFFF.",
    "Solid flat fills only: no outline strokes, no seam lines, no stitching, no inner shapes — the only white inside a piece is a part that is really not printed (a hole, a cut-out). Seen flat and straight from the front like a die line, no perspective, no shading, no text, no labels, no measurements, no other colours. The piece fills most of the picture with a small white margin.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** The aspect gpt-image is asked for (it pads to it; white = not printed). */
function aspectOf(w: number, h: number): string {
  if (!w || !h) return "2:3";
  const r = w / h;
  return r > 1.2 ? "3:2" : r < 0.83 ? "2:3" : "1:1";
}

interface Read {
  /** 1 channel, 0–255 printed. */
  mask: Buffer;
  width: number;
  height: number;
}

/** The green area of the drawing, cropped to it. */
export async function readGreen(drawing: Buffer): Promise<Read> {
  const { data, info } = await sharp(drawing).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const ch = info.channels;
  const m = Buffer.alloc(W * H);
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0, p = 0; i < W * H; i++, p += ch) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    // Green = clearly more green than red / blue (a pale or a dark green line the model added counts too): in or out.
    const v = g - Math.max(r, b) >= 60 ? 255 : 0;
    m[i] = v;
    if (v < 128) continue;
    const x = i % W;
    const y = (i - x) / W;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x1 < 0) throw new Error("AI không vẽ vùng in (xanh lá) — thử mô tả rõ hơn");
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const crop = await gray(sharp(m, { raw: { width: W, height: H, channels: 1 } }).extract({ left: x0, top: y0, width: w, height: h }));
  return { mask: crop, width: w, height: h };
}

/** The mask at the sheet size: contain-fitted, centred. */
export async function fitMask(read: Read, W: number, H: number): Promise<Buffer> {
  const k = Math.min(W / read.width, H / read.height);
  const w = Math.max(1, Math.round(read.width * k));
  const h = Math.max(1, Math.round(read.height * k));
  const scaled = await gray(sharp(read.mask, { raw: { width: read.width, height: read.height, channels: 1 } }).resize(w, h, { fit: "fill" }));
  const left = Math.floor((W - w) / 2);
  const top = Math.floor((H - h) / 2);
  return gray(sharp(scaled, { raw: { width: w, height: h, channels: 1 } }).extend({ left, right: W - w - left, top, bottom: H - h - top, background: { r: 0, g: 0, b: 0 } }));
}

/** `mask` shrunk by about `d` px (blur, then only what stays fully inside) — the sheet's own edge counts as outside. */
async function erode(mask: Buffer, W: number, H: number, d: number): Promise<Buffer> {
  const pad = Math.ceil(d) + 2;
  const grown = await gray(sharp(mask, { raw: { width: W, height: H, channels: 1 } }).extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0 } }));
  // sharp runs threshold before blur whatever the call order: blur here, threshold by hand.
  const blurred = await gray(sharp(grown, { raw: { width: W + 2 * pad, height: H + 2 * pad, channels: 1 } }).blur(Math.max(0.3, d / 2)));
  const out = Buffer.alloc(W * H);
  const GW = W + 2 * pad;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = blurred[(y + pad) * GW + x + pad] >= 250 ? 255 : 0;
  return out;
}

/** One byte per pixel, whatever sharp would output (it may widen a single channel). */
async function gray(img: Sharp): Promise<Buffer> {
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  if (info.channels === 1) return data;
  const out = Buffer.alloc(info.width * info.height);
  for (let i = 0; i < out.length; i++) out[i] = data[i * info.channels];
  return out;
}

/** mask PNG (white, alpha = printed), guide PNG (cut line + dashed safe line), clean image (fill + guide). */
export async function renderFace(mask: Buffer, W: number, H: number): Promise<{ mask: Buffer; guide: Buffer; image: Buffer }> {
  const stroke = Math.max(3, Math.round(Math.max(W, H) / 300));
  const safeD = Math.max(stroke * 3, Math.round(Math.min(W, H) * 0.04));
  const [inner, safe, safeInner] = await Promise.all([erode(mask, W, H, stroke), erode(mask, W, H, safeD), erode(mask, W, H, safeD + stroke * 2)]);
  const dash = Math.max(8, stroke * 6);
  const guide = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    if (mask[i] >= 128 && inner[i] < 128) {
      // Cut line: dark green.
      guide[o] = 21;
      guide[o + 1] = 128;
      guide[o + 2] = 61;
      guide[o + 3] = 255;
    } else if (safe[i] >= 128 && safeInner[i] < 128) {
      const x = i % W;
      const y = (i - x) / W;
      if (Math.floor((x + y) / dash) % 2 === 0) {
        guide[o] = 34;
        guide[o + 1] = 197;
        guide[o + 2] = 94;
        guide[o + 3] = 230;
      }
    }
  }
  const alpha = await sharp(mask, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
  const maskPng = await sharp({ create: { width: W, height: H, channels: 3, background: "#ffffff" } }).joinChannel(alpha).png().toBuffer();
  const guidePng = await sharp(guide, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  const fill = await sharp({ create: { width: W, height: H, channels: 3, background: "#e5f3ea" } }).joinChannel(alpha).png().toBuffer();
  const image = await sharp({ create: { width: W, height: H, channels: 3, background: "#ffffff" } })
    .composite([{ input: fill }, { input: guidePng }])
    .png()
    .toBuffer();
  return { mask: maskPng, guide: guidePng, image };
}

/** POST print-templates/ai */
export async function khuonAi(s: CtSession, raw: unknown): Promise<NextResponse> {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<CtPrintAiRequest> & { name?: unknown; base?: unknown };
  const req: CtPrintAiRequest = {
    templateId: typeof r.templateId === "string" ? r.templateId : null,
    prompt: typeof r.prompt === "string" ? r.prompt.trim().slice(0, 3000) : "",
    refs: Array.isArray(r.refs) ? r.refs.filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u)).slice(0, 4) : [],
    faces: Array.isArray(r.faces) ? r.faces.filter((f): f is string => typeof f === "string" && f.trim() !== "").map((f) => f.trim().slice(0, 60)).slice(0, 4) : [],
    mirror: r.mirror === true,
    width: Math.max(0, Math.min(20000, Math.round(Number(r.width) || 0))),
    height: Math.max(0, Math.min(20000, Math.round(Number(r.height) || 0))),
    dpi: Math.max(30, Math.min(1200, Math.round(Number(r.dpi) || 300))),
  };
  const base: CtPrintFace[] = Array.isArray(r.base) ? (r.base as CtPrintFace[]).filter((f) => f && typeof f.id === "string") : [];
  if (!req.prompt && !req.refs.length && !base.length && !req.templateId) return jsonError("Mô tả khuôn hoặc thêm ảnh mẫu", 400);
  const template = req.templateId ? await getTemplate(s, req.templateId) : null;
  const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : (template?.name ?? "sản phẩm");
  // The faces to draw: as asked, else those of the round / template being changed, else one.
  const current: CtPrintFace[] = base.length ? base : (template?.spec.faces ?? []);
  const faceNames = req.faces.length ? req.faces : current.length ? current.map((f) => f.name) : ["Mặt in"];
  const model = CT_IMAGE_MODEL;
  const temp: string[] = [];
  try {
    const drawings = await Promise.all(
      faceNames.map(async (faceName, i) => {
        const was = current.find((f) => f.name === faceName) ?? current[i] ?? null;
        const refs: string[] = [];
        if (was || template) {
          const ref = template || was ? await greenDrawing(template?.spec ?? emptySpec(), was) : null;
          if (ref) {
            const up = await put(s.user.id, ref, "ref");
            temp.push(up.path);
            refs.push(up.url);
          }
        }
        refs.push(...req.refs);
        const out = await drawImage(model, promptFor(req, name, faceName, faceNames.length, refs.length > req.refs.length), refs, aspectOf(req.width, req.height), "pad");
        return { faceName, read: await readGreen(out.data) };
      }),
    );
    // The sheet: as asked, else the first face's drawing at DEFAULT_LONG_SIDE.
    const first = drawings[0].read;
    const k = DEFAULT_LONG_SIDE / Math.max(first.width, first.height);
    const W = req.width || template?.spec.width || Math.round(first.width * k);
    const H = req.height || template?.spec.height || Math.round(first.height * k);
    const faces = await Promise.all(
      drawings.map(async ({ faceName, read }) => {
        const out = await renderFace(await fitMask(read, W, H), W, H);
        const [mask, guide, image] = await Promise.all([put(s.user.id, out.mask, "mask"), put(s.user.id, out.guide, "guide"), put(s.user.id, out.image, "image")]);
        return { id: newId(), name: faceName, maskUrl: mask.url, guideUrl: guide.url, imageUrl: image.url } satisfies CtPrintFace;
      }),
    );
    const result: CtPrintAiResult = { width: W, height: H, faces };
    return NextResponse.json(result);
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không tạo được khuôn", 500);
  } finally {
    await ctRemove(temp);
  }
}

function emptySpec(): CtPrintSpec {
  return { width: 1000, height: 1000, dpi: 300, widthMm: 0, heightMm: 0, outline: null, bleed: 0, safe: [], cuts: [], zones: [], sizes: [], frameUrl: null, blankUrl: null, blankBox: null, notes: "", faces: [], mirror: false, blanks: [], history: [] };
}
