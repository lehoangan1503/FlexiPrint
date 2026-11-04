/**
 * "Cân màu" — the clipart editor's colour-balancing brush (asked 2026-11-04). A file's soft edge sometimes carries
 * 1–2 px of a colour that is NOT the clipart's: the thigh skin of the 3b picture along a sweater's hem, laid over the
 * jeans below as a light line. Making those pixels transparent ("Làm mịn") lets the doll's pink behind show instead;
 * this brush keeps their alpha and gives them the clipart's own colour — a navy sweater's stray skin turns navy, so
 * the sweater still covers what lies under it.
 *
 * Only the edge band (`band` px from where the file turns transparent) under the brush is touched. It is walked from
 * the inside out, ring by ring: each pixel is compared with its neighbours just inside it (as they are by then) and,
 * when it differs by more than `tol`, takes their colour — so the colour that fills the line is the one right next to
 * it (the dark navy along the hem, not the lighter navy further in: asked 2026-11-04), and a whole stray line goes,
 * not a pixel here and there. Wider faults are not fixed here — the set is cut again.
 * The same function runs in the editor (preview) and on the server (every colour of the option, in its own colours).
 */

export interface EdgeFix {
  /** Width of the edge band in px of the file (1–10; the set's canvas is print size, so 6 px there is ~1–2 px on
   * screen — the thigh-skin line of set 21ec438a needed 6). */
  band: number;
  /** ΔE (CIE76) a pixel must lie from its inner neighbours' colour to be repainted. */
  tol: number;
  /** "Thêm": how many px the clipart grows past its edge (1–10, like "Độ mịn" for Làm mịn). */
  grow: number;
}

export const EDGE_FIX_DEFAULT: EdgeFix = { band: 6, tol: 10, grow: 2 };

/** The limits the UI and the server both keep to. */
export function edgeFixOf(v: unknown): EdgeFix {
  const o = (v ?? {}) as { band?: unknown; tol?: unknown; grow?: unknown };
  const band = Math.round(Number(o.band));
  const tol = Number(o.tol);
  const grow = Math.round(Number(o.grow));
  return {
    band: Number.isFinite(band) ? Math.min(10, Math.max(1, band)) : EDGE_FIX_DEFAULT.band,
    tol: Number.isFinite(tol) ? Math.min(60, Math.max(3, tol)) : EDGE_FIX_DEFAULT.tol,
    // Saved before "Phủ thêm" had its own size: it grew by the band.
    grow: Number.isFinite(grow) ? Math.min(10, Math.max(1, grow)) : Number.isFinite(band) ? Math.min(10, Math.max(1, band)) : EDGE_FIX_DEFAULT.grow,
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
  // The brush's box, then the box the work looks into.
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
  const pad = band + 3;
  const x0 = Math.max(0, bx0 - pad), y0 = Math.max(0, by0 - pad);
  const x1 = Math.min(w - 1, bx1 + pad), y1 = Math.min(h - 1, by1 + pad);
  const ww = x1 - x0 + 1;
  const hh = y1 - y0 + 1;
  const n = ww * hh;
  const G = (i: number) => (y0 + Math.floor(i / ww)) * w + x0 + (i % ww);
  // Distance (px, chamfer 1 / √2) from the nearest pixel where the file is under half alpha.
  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) dist[i] = alpha[G(i)] < 128 ? 0 : 1e6;
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
  // The colours as the walk leaves them; `final` = settled (everything visible that is not to be walked).
  const cur = new Float32Array(n * 3);
  const final = new Uint8Array(n);
  const list: number[] = [];
  for (let i = 0; i < n; i++) {
    const g = G(i);
    cur[i * 3] = col[g * 4];
    cur[i * 3 + 1] = col[g * 4 + 1];
    cur[i * 3 + 2] = col[g * 4 + 2];
    if (alpha[g] === 0) continue;
    if (cover[g] >= 64 && dist[i] <= band) list.push(i);
    else final[i] = 1;
  }
  if (!list.length) return 0;
  // Inside out: the deepest ring first.
  list.sort((a, b) => dist[b] - dist[a]);
  const lab = new Float32Array(6);
  const tol2 = tol * tol;
  const changed = new Uint8Array(n);
  /** Settle pixel i from its settled neighbours (`inner`: only those at least as deep). False = none yet. */
  const settle = (i: number, inner: boolean): boolean => {
    const lx = i % ww;
    const ly = Math.floor(i / ww);
    let r = 0, g = 0, b = 0, k = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = lx + dx;
        const yy = ly + dy;
        if (xx < 0 || yy < 0 || xx >= ww || yy >= hh) continue;
        const j = yy * ww + xx;
        if (!final[j] || (inner && dist[j] < dist[i])) continue;
        // Solid neighbours count more; diagonals a little less.
        const wt = (alpha[G(j)] / 255) * (dx && dy ? 0.7 : 1);
        if (wt <= 0) continue;
        r += cur[j * 3] * wt;
        g += cur[j * 3 + 1] * wt;
        b += cur[j * 3 + 2] * wt;
        k += wt;
      }
    if (!k) return false;
    r /= k;
    g /= k;
    b /= k;
    toLab(cur[i * 3], cur[i * 3 + 1], cur[i * 3 + 2], lab, 0);
    toLab(r, g, b, lab, 3);
    const de = (lab[0] - lab[3]) ** 2 + (lab[1] - lab[4]) ** 2 + (lab[2] - lab[5]) ** 2;
    if (de > tol2) {
      cur[i * 3] = r;
      cur[i * 3 + 1] = g;
      cur[i * 3 + 2] = b;
      changed[i] = 1;
    }
    final[i] = 1;
    return true;
  };
  let left = list.filter((i) => !settle(i, true));
  // Pixels with no deeper neighbour (a corner, a thin tip): from any settled neighbour, a few rounds.
  for (let round = 0; left.length && round < 2 * band + 4; round++) {
    const next = left.filter((i) => !settle(i, false));
    if (next.length === left.length) break;
    left = next;
  }
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (!changed[i]) continue;
    const g = G(i) * 4;
    col[g] = Math.round(cur[i * 3]);
    col[g + 1] = Math.round(cur[i * 3 + 1]);
    col[g + 2] = Math.round(cur[i * 3 + 2]);
    count++;
  }
  return count;
}

/** Band of the file's edge evened out before "Thêm" grows it (its pink- / skin-mixed pixels, ~5 px at print size). */
export const GROW_CLEAN_BAND = 6;

/**
 * "Cân màu — Thêm" (asked 2026-11-04): the clipart grows over a thin strip its 3b picture left uncovered — the doll's
 * pink tank top showing between a tee's hem and the jeans' waist, which no picture of the set covers.
 * Under the brush: first the file's own edge is evened out (fixEdgeColours over GROW_CLEAN_BAND: its mixed pixels take
 * the colour right inside them), then its edge moves out by exactly `grow` px, soft ramp and all — each pixel's alpha
 * = the highest within `grow` px (a disk), as far as the picture's own figure goes (never onto the background) — and
 * every pixel that gained takes the colour of the NEAREST solid pixel of the file (asked 2026-11-04: "màu gần nhất với
 * pixel kế bên"; a mean or a deeper colour came out lighter than the edge, and growing ring by ring with the old soft
 * edge made opaque grew more than asked). col: RGBA colours (RGB written); alpha: the file's alpha (written); figure:
 * the 3b picture's alpha (the plate's). Returns how many px gained.
 */
export function growEdge(col: Bytes, alpha: Bytes, figure: ArrayLike<number>, cover: ArrayLike<number>, w: number, h: number, fix: EdgeFix): number {
  fixEdgeColours(col, alpha, cover, w, h, { ...fix, band: GROW_CLEAN_BAND });
  const r = fix.grow;
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
  // The disk's offsets, nearest first (the first solid one found is the nearest).
  const disk: Array<[number, number]> = [];
  const far = r + GROW_CLEAN_BAND;
  for (let dy = -far; dy <= far; dy++) for (let dx = -far; dx <= far; dx++) if (dx * dx + dy * dy <= far * far) disk.push([dx, dy]);
  disk.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]));
  const r2 = r * r + 0.5;
  const a0 = Uint8Array.from(alpha);
  const out: Array<[number, number, number]> = [];
  for (let y = by0; y <= by1; y++)
    for (let x = bx0; x <= bx1; x++) {
      const g = y * w + x;
      if (cover[g] < 64 || !figure[g]) continue;
      let best = a0[g];
      let src = -1;
      for (const [dx, dy] of disk) {
        const d2 = dx * dx + dy * dy;
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (d2 <= r2 && a0[q] > best) best = a0[q];
        if (src < 0 && a0[q] >= 128) src = q;
        if (d2 > r2 && src >= 0) break;
      }
      best = Math.min(best, figure[g]);
      if (best > a0[g] && src >= 0) out.push([g, best, src]);
    }
  for (const [g, a, q] of out) {
    alpha[g] = a;
    col[g * 4] = col[q * 4];
    col[g * 4 + 1] = col[q * 4 + 1];
    col[g * 4 + 2] = col[q * 4 + 2];
  }
  return out.length;
}
