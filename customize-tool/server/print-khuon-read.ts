/**
 * An uploaded khuôn picture read the way the factory draws it (asked 2026-11-10: "lấy chính khuôn in có nét liền,
 * nét đứt làm khuôn in luôn"):
 *
 *   nét liền (solid)  the cut line — everything it closes in is the piece: what the print is cut to + the silhouette
 *   nét đứt (dashed)  the safe zone — custom options and the customer's photos stay inside it
 *
 * The picture's background (transparent or white) is reached from the sheet's border: a dashed line has gaps, so only
 * the solid lines stop it. What the border cannot reach is the piece (the mask). Dashed outlines are the line
 * groups inside the piece that close in a big area once their gaps are bridged; each becomes a rect / ellipse.
 * The guide drawn over the editor and the File in tab is the picture's own lines (background made transparent).
 *
 * Read at most READ_SIDE px on the long side (the mask is scaled back to the sheet): fast, and a line is still
 * placed within a few px of a factory sheet.
 */

import sharp from "sharp";
import type { CtShape } from "../types";

const READ_SIDE = 3000;

export interface KhuonPictureRead {
  /** Alpha 255 = the piece (inside the solid lines), sheet size, 1 channel; null = no closed solid line found. */
  mask: Buffer | null;
  /** The picture's lines on a transparent sheet (PNG, sheet size). */
  guide: Buffer;
  /** The dashed safe zones in sheet px. */
  safe: CtShape[];
}

/** Square dilation of a 0/1 map by `r` px (a row pass then a column pass of running counts). */
function dilate(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return src.slice();
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let count = 0;
    for (let x = 0; x < Math.min(r, w); x++) count += src[row + x];
    for (let x = 0; x < w; x++) {
      if (x + r < w) count += src[row + x + r];
      if (x - r - 1 >= 0) count -= src[row + x - r - 1];
      tmp[row + x] = count > 0 ? 1 : 0;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y < Math.min(r, h); y++) count += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      if (y + r < h) count += tmp[(y + r) * w + x];
      if (y - r - 1 >= 0) count -= tmp[(y - r - 1) * w + x];
      out[y * w + x] = count > 0 ? 1 : 0;
    }
  }
  return out;
}

/** 1 where the sheet's border reaches over cells that are 0 in `wall` (4-connected). */
function reachFromBorder(wall: Uint8Array, w: number, h: number): Uint8Array {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let top = 0;
  const seed = (i: number) => {
    if (!seen[i] && !wall[i]) {
      seen[i] = 1;
      stack[top++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (top) {
    const i = stack[--top];
    const x = i % w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (i >= w) seed(i - w);
    if (i < w * (h - 1)) seed(i + w);
  }
  return seen;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The connected groups (8-connected) of 1s in `map`, each as its pixel list + box. */
function groups(map: Uint8Array, w: number, h: number): Array<{ px: Int32Array; box: Box }> {
  const label = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const out: Array<{ px: Int32Array; box: Box }> = [];
  for (let s = 0; s < w * h; s++) {
    if (!map[s] || label[s]) continue;
    const px: number[] = [];
    const box: Box = { x0: w, y0: h, x1: -1, y1: -1 };
    let top = 0;
    label[s] = 1;
    stack[top++] = s;
    while (top) {
      const i = stack[--top];
      px.push(i);
      const x = i % w;
      const y = (i - x) / w;
      if (x < box.x0) box.x0 = x;
      if (x > box.x1) box.x1 = x;
      if (y < box.y0) box.y0 = y;
      if (y > box.y1) box.y1 = y;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (map[j] && !label[j]) {
            label[j] = 1;
            stack[top++] = j;
          }
        }
    }
    out.push({ px: Int32Array.from(px), box });
  }
  return out;
}

/**
 * The area a line group closes in (its box with the group as the wall, reached from the box's border = outside), as
 * a rect or an ellipse by how much of its own box it fills; null when it closes in nothing worth a safe zone.
 */
function enclosedShape(g: { px: Int32Array; box: Box }, w: number, grow: number): CtShape | null {
  const bx = g.box.x0 - 1;
  const by = g.box.y0 - 1;
  const bw = g.box.x1 - g.box.x0 + 3;
  const bh = g.box.y1 - g.box.y0 + 3;
  const wall = new Uint8Array(bw * bh);
  for (const i of g.px) {
    const x = i % w;
    const y = (i - x) / w;
    wall[(y - by) * bw + (x - bx)] = 1;
  }
  const out = reachFromBorder(wall, bw, bh);
  let n = 0;
  const box: Box = { x0: bw, y0: bh, x1: -1, y1: -1 };
  for (let i = 0; i < bw * bh; i++) {
    if (out[i] || wall[i]) continue;
    n++;
    const x = i % bw;
    const y = (i - x) / bw;
    if (x < box.x0) box.x0 = x;
    if (x > box.x1) box.x1 = x;
    if (y < box.y0) box.y0 = y;
    if (y > box.y1) box.y1 = y;
  }
  if (box.x1 < 0) return null;
  const iw = box.x1 - box.x0 + 1;
  const ih = box.y1 - box.y0 + 1;
  if (n < 0.3 * bw * bh) return null;
  // Back out to the dashed line's middle (the gaps were bridged by growing the line `grow` px).
  const x = bx + box.x0 - grow;
  const y = by + box.y0 - grow;
  const W = iw + 2 * grow;
  const H = ih + 2 * grow;
  const fill = n / (iw * ih);
  if (fill > 0.9) return { type: "rect", x, y, w: W, h: H, radius: 0 };
  if (fill > 0.7 && fill < 0.86) return { type: "ellipse", cx: x + W / 2, cy: y + H / 2, rx: W / 2, ry: H / 2 };
  return { type: "rect", x, y, w: W, h: H, radius: 0 };
}

function scaleShape(s: CtShape, kx: number, ky: number): CtShape {
  const r = (v: number) => Math.round(v * 10) / 10;
  if (s.type === "rect") return { type: "rect", x: r(s.x * kx), y: r(s.y * ky), w: r(s.w * kx), h: r(s.h * ky), radius: r(s.radius * kx) };
  if (s.type === "ellipse") return { type: "ellipse", cx: r(s.cx * kx), cy: r(s.cy * ky), rx: r(s.rx * kx), ry: r(s.ry * ky) };
  return { type: "polygon", points: s.points.map((p) => ({ x: r(p.x * kx), y: r(p.y * ky) })) };
}

/** Read a khuôn picture (any size; stretched to the sheet `W` × `H` like the editor draws it). */
export async function readKhuonPicture(picture: Buffer, W: number, H: number): Promise<KhuonPictureRead> {
  // The guide: the picture at the sheet size, near-white made transparent.
  const full = await sharp(picture).ensureAlpha().resize(W, H, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const g = full.data;
  for (let p = 0; p < g.length; p += 4) {
    const lo = Math.min(g[p], g[p + 1], g[p + 2]);
    if (lo >= 235) g[p + 3] = 0;
    else if (lo > 200) g[p + 3] = Math.round((g[p + 3] * (235 - lo)) / 35);
  }
  const guide = await sharp(g, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();

  // Read at a working size.
  const k = Math.min(1, READ_SIDE / Math.max(W, H));
  const w = Math.max(1, Math.round(W * k));
  const h = Math.max(1, Math.round(H * k));
  const small = await sharp(picture).ensureAlpha().resize(w, h, { fit: "fill" }).raw().toBuffer();
  const ink = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) ink[i] = small[p + 3] >= 96 && Math.min(small[p], small[p + 1], small[p + 2]) < 200 ? 1 : 0;

  // 1) The piece: what the border cannot reach through the solid lines (anti-aliasing gaps bridged by 1 px).
  const wall = dilate(ink, w, h, 1);
  const outside = reachFromBorder(wall, w, h);
  // Undo the 1 px bridge on the outside so the cut sits on the line's outer edge.
  const outGrown = dilate(outside, w, h, 1);
  let inside = 0;
  const pieceSmall = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++)
    if (!outside[i] && !(outGrown[i] && !ink[i])) {
      pieceSmall[i] = 255;
      inside++;
    }
  const closed = inside > 0.02 * w * h && inside < 0.999 * w * h;
  let mask: Buffer | null = null;
  if (closed) {
    const up = await sharp(Buffer.from(pieceSmall), { raw: { width: w, height: h, channels: 1 } }).resize(W, H, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
    const ch = up.info.channels;
    mask = Buffer.alloc(W * H);
    for (let i = 0; i < W * H; i++) mask[i] = up.data[i * ch] >= 128 ? 255 : 0;
  }

  // 2) The dashed safe zones: line groups inside the piece, not touching the outside, gaps bridged.
  const safe: CtShape[] = [];
  if (closed) {
    const bridge = Math.max(4, Math.round(Math.max(w, h) / 100));
    // The solid lines themselves (every ink group the outside touches) are not safe zones.
    const touch = dilate(outside, w, h, 2);
    const solid = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    let top = 0;
    for (let i = 0; i < w * h; i++)
      if (ink[i] && touch[i]) {
        solid[i] = 1;
        stack[top++] = i;
      }
    while (top) {
      const i = stack[--top];
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w, x > 0 ? i - w - 1 : -1, x < w - 1 ? i - w + 1 : -1, x > 0 ? i + w - 1 : -1, x < w - 1 ? i + w + 1 : -1])
        if (j >= 0 && j < w * h && ink[j] && !solid[j]) {
          solid[j] = 1;
          stack[top++] = j;
        }
    }
    const innerInk = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) if (ink[i] && pieceSmall[i] && !solid[i]) innerInk[i] = 1;
    const joined = dilate(innerInk, w, h, bridge);
    const minSide = Math.min(w, h) * 0.15;
    for (const grp of groups(joined, w, h)) {
      if (grp.box.x1 - grp.box.x0 < minSide || grp.box.y1 - grp.box.y0 < minSide) continue;
      const s = enclosedShape(grp, w, bridge);
      if (s) safe.push(scaleShape(s, W / w, H / h));
    }
  }
  return { mask, guide, safe };
}
