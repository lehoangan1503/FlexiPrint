/**
 * A fulfiller's mockup (phôi + overlay + box, Merchize / Printbelle import) drawn again by the image model in our own
 * style, with the product bigger and shaped like OUR khuôn (asked 2026-11-17 on the Premium Fleece Blanket: "lấy 2 cái
 * đó làm ảnh tham khảo gốc rồi vẽ lại 2 tấm theo style và độ lớn phôi to hơn cho gần bằng khuôn in … render ra y hệt
 * thằng merchize đã làm"). Image work only (sharp), no database:
 *
 *  1. overlayRef — the fulfiller's photo with its printable face painted MAGENTA (the overlay laid over flat magenta:
 *     its folds stay, the fingers holding it stay in front), stretched so the face has the khuôn's aspect and fills
 *     more of the frame. The model copies the reference's framing closely (a 0.81 blanket came back 0.80 every time
 *     until the reference itself was 0.74), so the reference carries the wanted shape.
 *     A flat rectangular product (the blanket) gets flatRef instead: a magenta rectangle on plain grey — the model
 *     then hangs it straight, no person, soft folds only (asked the same day after the first try came back held + curved).
 *  2. The model draws a new photo — new room (and new person when the photo is kept) — the face still flat magenta.
 *  3. splitKeyed — ONE picture keyed into the two Merchize files, pixel for pixel: the overlay (opaque photo off the
 *     face and over it — fingers —, see-through on the face with its folds as black / white shade) and the phôi trơn
 *     (that overlay over white = a white blank). The face's bounds give the box.
 *
 * The storefront / editor / mockups then lay the design exactly as they lay a Merchize import (lib/scene drawOnScene:
 * design flat in the box, overlay over it).
 */

import sharp from "sharp";

export interface KeyBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OverlayRef {
  /** The reference picture, SIDE² PNG. */
  png: Buffer;
  /** Where the printable face is on it (px of the reference). */
  face: KeyBounds;
  /**
   * A layout guide (magenta rectangle on plain grey) instead of the fulfiller's photo: the product is a flat
   * rectangle (a blanket), drawn hanging straight with no person — the photo's person, hands and curve came back
   * every time otherwise (user 2026-11-17: "không cần có người và cong cong, thẳng thẳng 1 xíu … hiện được càng nhiều
   * nội dung artwork càng tốt").
   */
  flat: boolean;
}

export interface KeyedScene {
  /** The phôi trơn (white face, same shade), JPEG. */
  phoi: Buffer;
  /** Laid over the design, PNG with alpha. */
  overlay: Buffer;
  width: number;
  height: number;
  /** The magenta face's bounds (px of the picture). */
  face: KeyBounds;
  /** Share of the face's bounds that is face (1 = a perfect rectangle). */
  fill: number;
}

const SIDE = 1024;
const OPAQUE = 250;

/** Bounds of the rows / columns of `mask` that hold at least `share` of the fullest one (strays left out). */
function maskBounds(mask: Uint8Array, W: number, H: number, share = 0.03): KeyBounds | null {
  const rows = new Uint32Array(H);
  const cols = new Uint32Array(W);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (mask[y * W + x]) {
        rows[y]++;
        cols[x]++;
      }
  const edge = (list: Uint32Array): [number, number] | null => {
    let max = 0;
    for (const v of list) if (v > max) max = v;
    if (!max) return null;
    const min = Math.max(1, max * share);
    let a = 0;
    while (list[a] < min) a++;
    let b = list.length - 1;
    while (list[b] < min) b--;
    return [a, b];
  };
  const ys = edge(rows);
  const xs = edge(cols);
  if (!ys || !xs) return null;
  return { x: xs[0], y: ys[0], w: xs[1] - xs[0] + 1, h: ys[1] - ys[0] + 1 };
}

/** Only the big connected parts of `mask` (4-neighbours): parts under `minShare` of the biggest are cleared. */
function bigParts(mask: Uint8Array, W: number, H: number, minShare = 0.05): void {
  const label = new Int32Array(W * H).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < W * H; start++) {
    if (!mask[start] || label[start] >= 0) continue;
    const id = sizes.length;
    let n = 0;
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop() as number;
      n++;
      const x = p % W;
      const y = (p - x) / W;
      if (x > 0 && mask[p - 1] && label[p - 1] < 0) (label[p - 1] = id), stack.push(p - 1);
      if (x < W - 1 && mask[p + 1] && label[p + 1] < 0) (label[p + 1] = id), stack.push(p + 1);
      if (y > 0 && mask[p - W] && label[p - W] < 0) (label[p - W] = id), stack.push(p - W);
      if (y < H - 1 && mask[p + W] && label[p + W] < 0) (label[p + W] = id), stack.push(p + W);
    }
    sizes.push(n);
  }
  const biggest = Math.max(0, ...sizes);
  for (let p = 0; p < W * H; p++) if (mask[p] && sizes[label[p]] < biggest * minShare) mask[p] = 0;
}

/**
 * Where the face goes on the reference: the khuôn's aspect, a little bigger than the fulfiller's (up to 86 % of the
 * frame's height, 90 % of its width), centred where theirs was, kept inside the frame.
 */
export function targetFace(was: KeyBounds, W: number, H: number, aspect: number): KeyBounds {
  const fx = was.w / W;
  const fy = was.h / H;
  // As big as theirs (by area), then grown a little — the editor asked for a bigger piece.
  let h = Math.min(0.86, Math.max(fy, Math.sqrt((fx * fy) / aspect)) * 1.06) * SIDE;
  let w = h * aspect;
  if (w > 0.9 * SIDE) {
    w = 0.9 * SIDE;
    h = w / aspect;
  }
  const cx = ((was.x + was.w / 2) / W) * SIDE;
  const cy = ((was.y + was.h / 2) / H) * SIDE;
  const x = Math.min(SIDE * 0.97 - w, Math.max(SIDE * 0.03, cx - w / 2));
  const y = Math.min(SIDE * 0.97 - h, Math.max(SIDE * 0.08, cy - h / 2));
  return { x, y, w, h };
}

/**
 * The reference for the model: the fulfiller's phôi with its printable face (overlay not opaque) painted magenta under
 * the overlay's shade, stretched so the face lands on `targetFace` (khuôn aspect), on a SIDE² canvas.
 */
export async function overlayRef(phoi: Buffer, overlay: Buffer, aspect: number): Promise<OverlayRef> {
  const om = await sharp(overlay).metadata();
  const W = om.width ?? SIDE;
  const H = om.height ?? SIDE;
  const { data: oa } = await sharp(overlay).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const hole = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) hole[p] = oa[p * 4 + 3] < OPAQUE ? 1 : 0;
  bigParts(hole, W, H);
  const was = maskBounds(hole, W, H);
  if (!was) throw new Error("Lớp phủ của phôi không có vùng sản phẩm (trong suốt) — không vẽ lại được");
  let inside = 0;
  for (let y = was.y; y < was.y + was.h; y++) for (let x = was.x; x < was.x + was.w; x++) inside += hole[y * W + x];
  // Nearly fills its bounds (fingers at the corners, a wavy hem) = a flat rectangle; a worn / shaped piece keeps the photo.
  if (inside / (was.w * was.h) > FLAT_FILL) return flatRef(aspect);
  const painted = await sharp(phoi)
    .removeAlpha()
    .resize(W, H, { fit: "fill" })
    .composite([
      // The face flat magenta, then the overlay's shade + the photo around it on top.
      { input: await sharp({ create: { width: W, height: H, channels: 4, background: { r: 255, g: 0, b: 255, alpha: 1 } } }).png().toBuffer(), blend: "over" },
      { input: overlay, blend: "over" },
    ])
    .png()
    .toBuffer();
  const face = targetFace(was, W, H, aspect);
  const sx = face.w / was.w;
  const sy = face.h / was.h;
  const RW = Math.max(1, Math.round(W * sx));
  const RH = Math.max(1, Math.round(H * sy));
  const offX = Math.round(face.x - was.x * sx);
  const offY = Math.round(face.y - was.y * sy);
  const pad = SIDE;
  const png = await sharp(await sharp(painted).resize(RW, RH, { fit: "fill" }).extend({ left: pad, right: pad, top: pad, bottom: pad, extendWith: "mirror" }).png().toBuffer())
    .extract({ left: pad - offX, top: pad - offY, width: SIDE, height: SIDE })
    .png()
    .toBuffer();
  return { png, face: { x: offX + was.x * sx, y: offY + was.y * sy, w: was.w * sx, h: was.h * sy }, flat: false };
}

/** Share of its bounds a flat rectangular product's face covers on the fulfiller's photo (Merchize blanket ≈ 0.9). */
const FLAT_FILL = 0.8;

/**
 * The layout guide for a flat rectangular product: plain soft grey, the face a magenta rectangle with the khuôn's
 * aspect, as big as the frame allows (86 % of its height, ≤ 90 % of its width), centred.
 */
export async function flatRef(aspect: number): Promise<OverlayRef> {
  let h = 0.86 * SIDE;
  let w = h * aspect;
  if (w > 0.9 * SIDE) {
    w = 0.9 * SIDE;
    h = w / aspect;
  }
  const face = { x: Math.round((SIDE - w) / 2), y: Math.round((SIDE - h) / 2), w: Math.round(w), h: Math.round(h) };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIDE}" height="${SIDE}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eeebe6"/><stop offset="1" stop-color="#d6d0c8"/></linearGradient></defs><rect width="${SIDE}" height="${SIDE}" fill="url(#g)"/><rect x="${face.x}" y="${face.y}" width="${face.w}" height="${face.h}" fill="#ff00ff"/></svg>`;
  return { png: await sharp(Buffer.from(svg)).png().toBuffer(), face, flat: true };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * The model's picture (face flat magenta) keyed into the Merchize pair: overlay + phôi trơn, same px. Throws when no
 * magenta face is there.
 */
export async function splitKeyed(picture: Buffer): Promise<KeyedScene> {
  const { data, info } = await sharp(picture).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const ch = info.channels;
  const N = W * H;
  // Magenta-ness: how far red AND blue stand above green (skin, wood, walls: ≤ ~20; the key: ~200).
  const ex = new Float32Array(N);
  for (let p = 0; p < N; p++) {
    const i = p * ch;
    ex[p] = Math.min(data[i], data[i + 2]) - data[i + 1];
  }
  const coreList: number[] = [];
  for (let p = 0; p < N; p++) if (ex[p] > 110) coreList.push(p);
  if (coreList.length < N * 0.05) throw new Error("AI không giữ vùng in màu magenta — không tách được phôi");
  const median = (vals: number[]) => {
    const s = [...vals].sort((a, b) => a - b);
    return s[s.length >> 1] ?? 0;
  };
  const sample = coreList.filter((_, i) => i % 7 === 0);
  const eKey = median(sample.map((p) => ex[p]));
  const lum = (p: number) => 0.299 * data[p * ch] + 0.587 * data[p * ch + 1] + 0.114 * data[p * ch + 2];
  const lKey = Math.max(1, median(sample.map(lum)));
  const mKey = [0, 1, 2].map((c) => median(sample.map((p) => data[p * ch + c])));

  // Key amount: 0 = photo, 1 = face; the soft edge in between.
  const lo = 30;
  const hi = Math.max(lo + 20, eKey * 0.72);
  const k = new Float32Array(N);
  const solid = new Uint8Array(N);
  for (let p = 0; p < N; p++) {
    k[p] = clamp((ex[p] - lo) / (hi - lo), 0, 1);
    solid[p] = k[p] > 0.5 ? 1 : 0;
  }
  // Stray magenta specks (a cushion, a reflection) are not the face.
  bigParts(solid, W, H);
  // The soft edge kept only next to the face (grown 3 px).
  const near = new Uint8Array(N);
  const R = 3;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!solid[y * W + x]) continue;
      for (let dy = -R; dy <= R; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < W) near[yy * W + xx] = 1;
        }
      }
    }
  const face = maskBounds(solid, W, H, 0.02);
  if (!face) throw new Error("Không tìm thấy vùng in trên ảnh AI");
  let count = 0;
  for (let p = 0; p < N; p++) if (solid[p]) count++;

  const over = Buffer.alloc(N * 4);
  const phoi = Buffer.alloc(N * 3);
  for (let p = 0; p < N; p++) {
    const i = p * ch;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const kk = near[p] ? k[p] : 0;
    let oR = r;
    let oG = g;
    let oB = b;
    let a = 1;
    if (kk > 0) {
      // The face's shade: its brightness against the key's — darker folds = black, lighter = white, over the design.
      const s = clamp(lum(p) / lKey, 0.55, 1.4);
      const aS = s < 1 ? (1 - s) * 1.0 : Math.min(0.6, (s - 1) * 0.8);
      const vS = s < 1 ? 0 : 255;
      // The photo's own colour behind a soft edge: the key taken out of it (and no magenta left over).
      let fR = r;
      let fG = g;
      let fB = b;
      if (kk < 1) {
        const q = 1 - kk;
        fR = clamp((r - kk * mKey[0]) / q, 0, 255);
        fG = clamp((g - kk * mKey[1]) / q, 0, 255);
        fB = clamp((b - kk * mKey[2]) / q, 0, 255);
        const spill = Math.min(fR, fB) - fG;
        if (spill > 0) {
          fR -= spill;
          fB -= spill;
        }
      }
      a = 1 - kk * (1 - aS);
      if (a > 0.002) {
        oR = ((1 - kk) * fR + kk * aS * vS) / a;
        oG = ((1 - kk) * fG + kk * aS * vS) / a;
        oB = ((1 - kk) * fB + kk * aS * vS) / a;
      } else {
        oR = oG = oB = 0;
      }
    } else if (ex[p] > lo) {
      // Magenta away from the face (a stray speck): greyed, so no pink shows.
      const m = (r + g + b) / 3;
      oR = oG = oB = m;
    }
    over[p * 4] = clamp(Math.round(oR), 0, 255);
    over[p * 4 + 1] = clamp(Math.round(oG), 0, 255);
    over[p * 4 + 2] = clamp(Math.round(oB), 0, 255);
    over[p * 4 + 3] = clamp(Math.round(a * 255), 0, 255);
    // The phôi trơn = the overlay over a white face.
    phoi[p * 3] = clamp(Math.round(a * over[p * 4] + (1 - a) * 255), 0, 255);
    phoi[p * 3 + 1] = clamp(Math.round(a * over[p * 4 + 1] + (1 - a) * 255), 0, 255);
    phoi[p * 3 + 2] = clamp(Math.round(a * over[p * 4 + 2] + (1 - a) * 255), 0, 255);
  }
  return {
    overlay: await sharp(over, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer(),
    phoi: await sharp(phoi, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 92 }).toBuffer(),
    width: W,
    height: H,
    face,
    fill: count / Math.max(1, face.w * face.h),
  };
}

/**
 * The smallest box of the khuôn piece's aspect that covers the whole face (no white blank showing past the design):
 * what the face hides of it is cut off, like Merchize's own box.
 */
export function coverBox(face: KeyBounds, aspect: number): KeyBounds {
  const w = Math.max(face.w, face.h * aspect);
  const h = w / aspect;
  return { x: face.x + face.w / 2 - w / 2, y: face.y + face.h / 2 - h / 2, w, h };
}

/**
 * How much of the print sheet the overlay hides on each side (0–1), measured through the sheet's middle like the
 * deploy page's red frame: overlay alpha > 128 = hidden, off the photo = hidden. `box` = the sheet on the photo.
 */
export async function sideLoss(overlay: Buffer, width: number, height: number, box: KeyBounds): Promise<{ top: number; bottom: number; left: number; right: number }> {
  const { data, info } = await sharp(overlay).ensureAlpha().resize(Math.round(width), Math.round(height), { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const hid = (x: number, y: number) => x < 0 || y < 0 || x >= W || y >= H || data[(y * W + x) * 4 + 3] > 128;
  const cx = Math.round(box.x + box.w / 2);
  const cy = Math.round(box.y + box.h / 2);
  const n = (from: number, to: number, at: (i: number) => boolean) => {
    let k = 0;
    const step = from < to ? 1 : -1;
    for (let i = from; i !== to && at(i); i += step) k++;
    return k;
  };
  const y0 = Math.floor(box.y);
  const y1 = Math.ceil(box.y + box.h) - 1;
  const x0 = Math.floor(box.x);
  const x1 = Math.ceil(box.x + box.w) - 1;
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return {
    top: r(n(y0, y1, (y) => hid(cx, y)) / box.h),
    bottom: r(n(y1, y0, (y) => hid(cx, y)) / box.h),
    left: r(n(x0, x1, (x) => hid(x, cy)) / box.w),
    right: r(n(x1, x0, (x) => hid(x, cy)) / box.w),
  };
}
