/**
 * Where a name goes on a hat (asked 2026-10-22: "căn chỉnh text cong theo vành nón phải kiểm tra lại thật kỹ" — the
 * names sat in a guessed box, straight-ish, off the brim): the band around the head (the Santa hat's fur cuff, the witch
 * hat's orange band, the bunny hat's fur) followed column by column by its colour, its middle line fitted with a
 * parabola → a box centred on the band and as tall as it, the circle the letters follow and the band's tilt.
 */

import sharp from "sharp";
import type { CtLayoutBox } from "../../lib/char-layout";

export interface CtBrimArc {
  /** The lettering's box on the file's canvas: its centre on the band's middle line, its height the band's. */
  box: CtLayoutBox;
  /** The circle the band's middle line follows (canvas px); 0 = straight. */
  radius: number;
  /** The band bows up (∩: its ends lower than its middle). */
  up: boolean;
  /** The band's slope at the box's centre, degrees clockwise (a tilted head). */
  tilt: number;
}

/** The band of rows in the hat's lower part whose solid run through the hat's middle is the longest — the cuff, a
 * band, a fold (the pom-pom at the side does not count: measured through the middle, 2026-10-19). */
export async function brimBox(png: Buffer, within?: CtLayoutBox | null): Promise<CtLayoutBox | null> {
  const { data, info } = await sharp(png).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const solid = (x: number, y: number) => data[y * W + x] > 128;
  let top = -1;
  let bottom = -1;
  let left = W;
  let right = -1;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < W; x++)
      if (solid(x, y)) {
        if (top < 0) top = y;
        bottom = y;
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
  if (top < 0) return null;
  const h = bottom - top + 1;
  let mid = Math.round((left + right) / 2);
  // Where the band is, given (text.band): the rows of that box, through its middle.
  let from = top + Math.floor(h * 0.4);
  let to = bottom;
  if (within) {
    from = Math.max(top, Math.floor(within.y));
    to = Math.min(bottom, Math.ceil(within.y + within.h));
    mid = Math.min(W - 1, Math.max(0, Math.round(within.x + within.w / 2)));
    if (from > to) return null;
  }
  // The solid run through the middle column of a row (none when the middle is clear).
  const run = (y: number): [number, number] | null => {
    if (!solid(mid, y)) return null;
    let a = mid;
    let b = mid;
    while (a > 0 && solid(a - 1, y)) a--;
    while (b < W - 1 && solid(b + 1, y)) b++;
    return [a, b];
  };
  const len = (y: number) => {
    const r = run(y);
    return r ? r[1] - r[0] + 1 : 0;
  };
  let best = -1;
  for (let y = from; y <= to; y++) if (best < 0 || len(y) > len(best)) best = y;
  if (best < 0 || len(best) === 0) return null;
  const wide = len(best) * 0.85;
  let y0 = best;
  let y1 = best;
  while (y0 > from && len(y0 - 1) >= wide) y0--;
  while (y1 < to && len(y1 + 1) >= wide) y1++;
  // A thin band still gets a readable line (≥ 14 % of the hat).
  const need = Math.round(h * 0.14) - (y1 - y0 + 1);
  if (need > 0) {
    y0 = Math.max(top, y0 - Math.ceil(need / 2));
    y1 = Math.min(bottom, y1 + Math.floor(need / 2));
  }
  let x0 = Infinity;
  let x1 = -Infinity;
  for (let y = y0; y <= y1; y++) {
    const r = run(y);
    if (r) {
      x0 = Math.min(x0, r[0]);
      x1 = Math.max(x1, r[1]);
    }
  }
  const inset = (x1 - x0) * 0.1;
  return { x: x0 + inset, y: y0, w: x1 - x0 - 2 * inset, h: y1 - y0 + 1 };
}

/** Least squares y = a·u² + b·u + c over (u, y) points. */
function fitParabola(pts: Array<[number, number]>): [number, number, number] | null {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (const [u, y] of pts) {
    const u2 = u * u;
    s0 += 1;
    s1 += u;
    s2 += u2;
    s3 += u2 * u;
    s4 += u2 * u2;
    t0 += y;
    t1 += u * y;
    t2 += u2 * y;
  }
  // [s4 s3 s2; s3 s2 s1; s2 s1 s0] · [a b c] = [t2 t1 t0]
  const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const M = [
    [s4, s3, s2],
    [s3, s2, s1],
    [s2, s1, s0],
  ];
  const D = det(M);
  if (!pts.length || Math.abs(D) < 1e-9) return null;
  const col = (i: number, v: number[]) => M.map((row, r) => row.map((x, c) => (c === i ? v[r] : x)));
  const v = [t2, t1, t0];
  return [det(col(0, v)) / D, det(col(1, v)) / D, det(col(2, v)) / D];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/**
 * The band a name sits on, on a hat file (the hat alone, canvas coordinates). Starts in the middle of brimBox's band,
 * takes its colour there and walks out to both sides column by column, each column's run of that colour found near the
 * last one's middle (the band curves and tilts). Null when no band is found.
 */
export async function brimArc(png: Buffer, within?: CtLayoutBox | null): Promise<CtBrimArc | null> {
  const seed = await brimBox(png, within);
  if (!seed) return null;
  const { data: alpha, info } = await sharp(png).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  // The colours a little blurred: fur and knit read as one colour.
  const { data: rgb } = await sharp(png).flatten({ background: "#000000" }).removeAlpha().blur(2).raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const at = (x: number, y: number) => (y * W + x) * 3;
  const sx = Math.round(seed.x + seed.w / 2);
  const sy = Math.round(seed.y + seed.h / 2);
  // The band's colour: the mean around the seed.
  let n = 0;
  const C = [0, 0, 0];
  for (let y = sy - 6; y <= sy + 6; y++)
    for (let x = sx - 6; x <= sx + 6; x++)
      if (x >= 0 && y >= 0 && x < W && y < H && alpha[y * W + x] > 128) {
        for (let k = 0; k < 3; k++) C[k] += rgb[at(x, y) + k];
        n++;
      }
  if (!n) return null;
  for (let k = 0; k < 3; k++) C[k] /= n;
  const T = 80;
  const isBand = (x: number, y: number) => {
    if (y < 0 || y >= H || alpha[y * W + x] <= 128) return false;
    const o = at(x, y);
    return Math.hypot(rgb[o] - C[0], rgb[o + 1] - C[1], rgb[o + 2] - C[2]) < T;
  };
  // A column's band run around `y` (gaps of a few px — a fur shadow — bridged); null when none is near.
  const reach = Math.max(4, Math.round(seed.h * 0.5));
  const runAt = (x: number, y: number): [number, number] | null => {
    let start = -1;
    for (let d = 0; d <= reach && start < 0; d++) {
      if (isBand(x, y - d)) start = y - d;
      else if (isBand(x, y + d)) start = y + d;
    }
    if (start < 0) return null;
    const gap = 4;
    let t = start;
    let b = start;
    for (let y2 = start - 1, miss = 0; y2 >= 0 && miss <= gap; y2--) {
      if (isBand(x, y2)) {
        t = y2;
        miss = 0;
      } else miss++;
    }
    for (let y2 = start + 1, miss = 0; y2 < H && miss <= gap; y2++) {
      if (isBand(x, y2)) {
        b = y2;
        miss = 0;
      } else miss++;
    }
    return [t, b];
  };
  const cols = new Map<number, [number, number]>();
  for (const dir of [-1, 1]) {
    let y = sy;
    let lost = 0;
    for (let x = dir < 0 ? sx : sx + 1; x >= 0 && x < W; x += dir) {
      const r = runAt(x, y);
      if (!r) {
        if (++lost > 6) break;
        continue;
      }
      lost = 0;
      cols.set(x, r);
      y = Math.round((r[0] + r[1]) / 2);
    }
  }
  if (cols.size < 10) return null;
  const xs = [...cols.keys()].sort((a, b) => a - b);
  const x0 = xs[0];
  const x1 = xs[xs.length - 1];
  const span = x1 - x0 + 1;
  // The ends turn down round the head (and a pom-pom may join one): fit the middle 60 %, where the name goes.
  const xc = (x0 + x1) / 2;
  const inner = xs.filter((x) => Math.abs(x - xc) <= span * 0.3);
  const thick = median(inner.map((x) => cols.get(x)![1] - cols.get(x)![0] + 1));
  let pts: Array<[number, number]> = inner.map((x) => [x - xc, (cols.get(x)![0] + cols.get(x)![1]) / 2]);
  let fit = fitParabola(pts);
  if (!fit) return null;
  // Columns far off the curve (a fold, the pom-pom's edge): out, fitted again.
  const [a0, b0, c0] = fit;
  pts = pts.filter(([u, y]) => Math.abs(a0 * u * u + b0 * u + c0 - y) < thick * 0.25);
  fit = fitParabola(pts) ?? fit;
  const [a, b, c] = fit;
  const w = span * 0.72;
  const h = thick;
  // Curvature at the centre: (1 + slope²)^1.5 / |2a|; nearly flat → straight.
  const radius = Math.abs(a) < 1e-7 ? 0 : Math.pow(1 + b * b, 1.5) / Math.abs(2 * a);
  return {
    box: { x: xc - w / 2, y: c - h / 2, w, h },
    radius: radius > w * 30 ? 0 : radius,
    up: a > 0,
    tilt: (Math.atan(b) * 180) / Math.PI,
  };
}

/** The pieces of an outfit file (alpha components): the headwear = the piece with the topmost pixel and every piece
 * that starts above its bottom (a pom-pom apart from the hat); the rest is the top (a sweater). The face lies between
 * them, so they never touch (asked 2026-10-19: the hats lie over the hair, the sweaters under it). */
export async function splitHeadwear(png: Buffer): Promise<{ hat: Buffer; rest: Buffer }> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const n = W * H;
  const label = new Int32Array(n).fill(-1);
  const comps: Array<{ minY: number; maxY: number; count: number }> = [];
  const stack = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (label[i] >= 0 || data[i * 4 + 3] <= 8) continue;
    const id = comps.length;
    const c = { minY: H, maxY: -1, count: 0 };
    let top = 0;
    stack[top++] = i;
    label[i] = id;
    while (top) {
      const j = stack[--top];
      const x = j % W;
      const y = (j - x) / W;
      c.count++;
      if (y < c.minY) c.minY = y;
      if (y > c.maxY) c.maxY = y;
      const near = [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, y > 0 ? j - W : -1, y < H - 1 ? j + W : -1];
      for (const k of near)
        if (k >= 0 && label[k] < 0 && data[k * 4 + 3] > 8) {
          label[k] = id;
          stack[top++] = k;
        }
    }
    comps.push(c);
  }
  const big = comps.map((c, i) => ({ ...c, i })).filter((c) => c.count >= 200);
  const first = big.sort((a, b) => a.minY - b.minY)[0];
  const isHat = new Set(first ? big.filter((c) => c.minY < first.maxY && c.maxY <= first.maxY + (first.maxY - first.minY) * 0.25).map((c) => c.i) : []);
  const hat = Buffer.alloc(n * 4);
  const rest = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    if (!data[i * 4 + 3]) continue;
    data.copy(isHat.has(label[i]) ? hat : rest, i * 4, i * 4, i * 4 + 4);
  }
  const out = (b: Buffer) => sharp(b, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  return { hat: await out(hat), rest: await out(rest) };
}
