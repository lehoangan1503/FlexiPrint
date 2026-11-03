/**
 * "Cân màu" — the clipart editor's colour-balancing brush (asked 2026-11-04). A file's soft edge sometimes carries
 * 1–2 px of a colour that is NOT the clipart's: the thigh skin of the 3b picture along a sweater's hem, laid over the
 * jeans below as a light line. Making those pixels transparent ("Làm mịn") lets the doll's pink behind show instead;
 * this brush keeps their alpha and gives them the clipart's own colour from just inside — a navy sweater's stray
 * skin turns navy, so the sweater still covers what lies under it.
 *
 * Only the edge band (`band` px from where the file turns transparent) under the brush is touched, and only pixels
 * whose colour appears nowhere in the clipart's solid inside nearby (ΔE > `tol` to every one of them): a darker
 * outline or a leopard spot that is also inside stays. Wider faults are not fixed here — the set is cut again.
 * The same function runs in the editor (preview) and on the server (every colour of the option, in its own colours).
 */

export interface EdgeFix {
  /** Width of the edge band in px of the file (1–10; the set's canvas is print size, so 6 px there is ~1–2 px on
   * screen — the thigh-skin line of set 21ec438a needed 6). */
  band: number;
  /** ΔE (CIE76) a pixel must lie from every solid inside colour nearby to be repainted. */
  tol: number;
}

export const EDGE_FIX_DEFAULT: EdgeFix = { band: 6, tol: 20 };

/** The limits the UI and the server both keep to. */
export function edgeFixOf(v: unknown): EdgeFix {
  const o = (v ?? {}) as { band?: unknown; tol?: unknown };
  const band = Math.round(Number(o.band));
  const tol = Number(o.tol);
  return {
    band: Number.isFinite(band) ? Math.min(10, Math.max(1, band)) : EDGE_FIX_DEFAULT.band,
    tol: Number.isFinite(tol) ? Math.min(60, Math.max(5, tol)) : EDGE_FIX_DEFAULT.tol,
  };
}

type Bytes = Uint8Array | Uint8ClampedArray;

const lin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const fLab = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

function toLab(r: number, g: number, b: number, out: Float32Array, at: number): void {
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const x = fLab((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const y = fLab(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const z = fLab((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  out[at] = 116 * y - 16;
  out[at + 1] = 500 * (x - y);
  out[at + 2] = 200 * (y - z);
}

/**
 * Repaint the stray edge pixels under `cover`, in place.
 * col: RGBA of the clipart's colours (w×h×4; only RGB is written). alpha: the file's alpha (w×h, 0–255) — the edge is
 * where it falls under half. cover: where the brush went (w×h, 0–255; ≥ 64 counts). Returns how many px changed.
 */
export function fixEdgeColours(col: Bytes, alpha: ArrayLike<number>, cover: ArrayLike<number>, w: number, h: number, fix: EdgeFix): number {
  const { band, tol } = fix;
  // The brush's box, then the box the work looks into (the inside colours lie up to `reach` px further in).
  let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (cover[y * w + x] >= 64) {
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
      }
  if (bx1 < 0) return 0;
  const reach = band + 3;
  const pad = reach + band + 2;
  const x0 = Math.max(0, bx0 - pad), y0 = Math.max(0, by0 - pad);
  const x1 = Math.min(w - 1, bx1 + pad), y1 = Math.min(h - 1, by1 + pad);
  const ww = x1 - x0 + 1;
  const hh = y1 - y0 + 1;
  const n = ww * hh;
  const A = (lx: number, ly: number) => alpha[(y0 + ly) * w + x0 + lx];
  // Distance (px, chamfer 1 / √2) from the nearest pixel where the file is under half alpha.
  const BIG = 1e6;
  const dist = new Float32Array(n);
  for (let ly = 0; ly < hh; ly++) for (let lx = 0; lx < ww; lx++) dist[ly * ww + lx] = A(lx, ly) < 128 ? 0 : BIG;
  const D = Math.SQRT2;
  for (let ly = 0; ly < hh; ly++)
    for (let lx = 0; lx < ww; lx++) {
      const i = ly * ww + lx;
      let d = dist[i];
      if (!d) continue;
      if (lx > 0) d = Math.min(d, dist[i - 1] + 1);
      if (ly > 0) {
        d = Math.min(d, dist[i - ww] + 1);
        if (lx > 0) d = Math.min(d, dist[i - ww - 1] + D);
        if (lx < ww - 1) d = Math.min(d, dist[i - ww + 1] + D);
      }
      dist[i] = d;
    }
  for (let ly = hh - 1; ly >= 0; ly--)
    for (let lx = ww - 1; lx >= 0; lx--) {
      const i = ly * ww + lx;
      let d = dist[i];
      if (!d) continue;
      if (lx < ww - 1) d = Math.min(d, dist[i + 1] + 1);
      if (ly < hh - 1) {
        d = Math.min(d, dist[i + ww] + 1);
        if (lx < ww - 1) d = Math.min(d, dist[i + ww + 1] + D);
        if (lx > 0) d = Math.min(d, dist[i + ww - 1] + D);
      }
      dist[i] = d;
    }
  // Candidates: under the brush, visible, in the edge band. Inside: solid, past the band, not a candidate.
  const cand = new Uint8Array(n);
  const list: number[] = [];
  for (let ly = 0; ly < hh; ly++)
    for (let lx = 0; lx < ww; lx++) {
      const i = ly * ww + lx;
      const g = (y0 + ly) * w + x0 + lx;
      if (cover[g] >= 64 && alpha[g] > 0 && dist[i] <= band) {
        cand[i] = 1;
        list.push(i);
      }
    }
  if (!list.length) return 0;
  const inside = (i: number) => !cand[i] && dist[i] > band && A(i % ww, Math.floor(i / ww)) >= 230;
  const lab = new Float32Array(n * 3);
  const done = new Uint8Array(n);
  const labOf = (i: number) => {
    if (!done[i]) {
      const g = ((y0 + Math.floor(i / ww)) * w + x0 + (i % ww)) * 4;
      toLab(col[g], col[g + 1], col[g + 2], lab, i * 3);
      done[i] = 1;
    }
    return i * 3;
  };
  const paint: Array<[number, number, number, number]> = [];
  const tol2 = tol * tol;
  for (const i of list) {
    const lx = i % ww;
    const ly = Math.floor(i / ww);
    const p = labOf(i);
    let near = Infinity;
    let close = false;
    for (let dy = -reach; dy <= reach && !close; dy++) {
      const yy = ly + dy;
      if (yy < 0 || yy >= hh) continue;
      for (let dx = -reach; dx <= reach; dx++) {
        const xx = lx + dx;
        if (xx < 0 || xx >= ww) continue;
        const j = yy * ww + xx;
        if (!inside(j)) continue;
        const q = labOf(j);
        const de = (lab[p] - lab[q]) ** 2 + (lab[p + 1] - lab[q + 1]) ** 2 + (lab[p + 2] - lab[q + 2]) ** 2;
        if (de <= tol2) {
          close = true;
          break;
        }
        near = Math.min(near, dx * dx + dy * dy);
      }
    }
    // Its colour is the clipart's own (or no inside near enough to say): left as it is.
    if (close || near === Infinity) continue;
    // The new colour: the mean of the nearest inside pixels (within 1 px of the nearest).
    const lim = (Math.sqrt(near) + 1) ** 2;
    let r = 0, g = 0, b = 0, k = 0;
    for (let dy = -reach; dy <= reach; dy++) {
      const yy = ly + dy;
      if (yy < 0 || yy >= hh) continue;
      for (let dx = -reach; dx <= reach; dx++) {
        const xx = lx + dx;
        if (xx < 0 || xx >= ww || dx * dx + dy * dy > lim) continue;
        const j = yy * ww + xx;
        if (!inside(j)) continue;
        const s = ((y0 + yy) * w + x0 + xx) * 4;
        r += col[s];
        g += col[s + 1];
        b += col[s + 2];
        k++;
      }
    }
    if (k) paint.push([((y0 + ly) * w + x0 + lx) * 4, r / k, g / k, b / k]);
  }
  // Written after every decision: each pixel is judged on the colours as they were.
  for (const [s, r, g, b] of paint) {
    col[s] = Math.round(r);
    col[s + 1] = Math.round(g);
    col[s + 2] = Math.round(b);
  }
  return paint.length;
}
