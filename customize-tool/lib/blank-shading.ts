/**
 * The artwork printed ON the phôi trơn (asked 2026-10-10): a flat paste loses what makes the photo real — the glaze's
 * shading towards the rim and its bright highlights. Here the art takes the phôi's own light: where the blank is
 * darker than its plain surface the print darkens with it (multiply), where it is brighter (a gloss highlight) the
 * highlight lies over the print (screen). On a light phôi (white glaze, white fabric) the print is also tinted by the
 * phôi's own colour and brightness — ink on a white ceramic photographed at 92 % reads at 92 %, not brighter than the
 * blank around it (asked 2026-10-10: the print must not cover the phôi's colour). Pure pixel math on RGBA buffers: the server's front mockup (sharp) and the
 * browser's Xem trước / storefront (canvas ImageData) share it.
 */

type Pixels = Uint8Array | Uint8ClampedArray;

/** How much of a highlight shows over the print (1 = all of it). */
const HIGHLIGHT = 1;
/** The darkest the phôi's shading may make the print (rim, hole edge). */
const MIN_SHADE = 0.3;
/** Shading is deepened (a glaze reads darker in its shade than a flat print would). */
const SHADE_GAMMA = 2.2;
/** Brightness above the surface that counts as a full highlight (a gloss on near-white glaze is only a few levels). */
const HIGHLIGHT_RANGE = 14;
/** Below this share of the surface's brightness a pixel is the backdrop (the print fades out over 0.1 above it). */
const OFF_PIECE = 0.66;

/** Plain-surface brightness from which the phôi counts as a white substrate (full tint at +80). */
const WHITE_FROM = 150;

const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/**
 * The phôi's light, smoothed (a box blur `r` px, twice): its grain and JPEG noise would print as specks on a
 * saturated colour; the glaze's shading and its bevel highlights are wider and stay.
 */
function lightOf(under: Pixels, w: number, h: number, uc: 3 | 4, r: number): Float32Array {
  const a = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) a[i] = lum(under[i * uc], under[i * uc + 1], under[i * uc + 2]);
  if (r < 1) return a;
  const b = new Float32Array(w * h);
  const pass = (src: Float32Array, dst: Float32Array, len: number, lines: number, step: number, lineStep: number) => {
    for (let l = 0; l < lines; l++) {
      const o = l * lineStep;
      let sum = 0;
      let cnt = 0;
      for (let k = 0; k < Math.min(len, r + 1); k++, cnt++) sum += src[o + k * step];
      for (let k = 0; k < len; k++) {
        dst[o + k * step] = sum / cnt;
        const add = k + r + 1;
        const drop = k - r;
        if (add < len) {
          sum += src[o + add * step];
          cnt++;
        }
        if (drop >= 0) {
          sum -= src[o + drop * step];
          cnt--;
        }
      }
    }
  };
  for (let t = 0; t < 2; t++) {
    pass(a, b, w, h, 1, w);
    pass(b, a, h, w, w, 1);
  }
  return a;
}

/**
 * Lay `art` (RGBA, w × h) on `under` (the phôi's pixels at the same place, `uc` channels) lit by the phôi; the result
 * (RGBA, opaque where `under` is) is written into `out` (may be `under` itself when it is RGBA).
 */
export function lightOnBlank(art: Pixels, under: Pixels, w: number, h: number, uc: 3 | 4, out: Pixels): void {
  const n = w * h;
  // The plain surface's brightness: the median of the phôi under the print.
  const hist = new Uint32Array(256);
  const chan = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (art[i * 4 + 3] < 128) continue;
    const j = i * uc;
    hist[Math.round(lum(under[j], under[j + 1], under[j + 2]))]++;
    for (let c = 0; c < 3; c++) chan[c][under[j + c]]++;
    count++;
  }
  const median = (h: Uint32Array, fallback: number) => {
    for (let v = 0, seen = 0; v < 256 && count; v++) {
      seen += h[v];
      if (seen >= count / 2) return Math.max(1, v);
    }
    return fallback;
  };
  const ref = median(hist, 255);
  // The phôi's own colour on the print: full on a light substrate (the ink is seen through the glaze / on the
  // fabric's white), none on a dark one (the print's colours are kept, only its light is taken).
  const white = Math.max(0, Math.min(1, (ref - WHITE_FROM) / 80));
  const tint = chan.map((h) => (median(h, 255) / 255) ** white);
  const room = Math.min(HIGHLIGHT_RANGE, Math.max(4, 255 - ref));
  const light = lightOf(under, w, h, uc, Math.round(Math.max(w, h) / 600));
  for (let i = 0; i < n; i++) {
    const j = i * uc;
    const L = light[i];
    // Far darker than the surface = the backdrop around the piece, not the piece: the print does not reach it.
    const onPiece = Math.max(0, Math.min(1, (L / ref - OFF_PIECE) / 0.1));
    const a = (art[i * 4 + 3] / 255) * onPiece;
    const o = i * 4;
    const ur = under[j];
    const ug = under[j + 1];
    const ub = under[j + 2];
    const ua = uc === 4 ? under[j + 3] : 255;
    if (a <= 0) {
      out[o] = ur;
      out[o + 1] = ug;
      out[o + 2] = ub;
      out[o + 3] = ua;
      continue;
    }
    const shade = Math.max(MIN_SHADE, Math.min(1, (L / ref) ** SHADE_GAMMA));
    const hl = Math.max(0, Math.min(1, (L - ref - 1) / room)) ** 0.8 * HIGHLIGHT;
    for (let c = 0; c < 3; c++) {
      let v = art[i * 4 + c] * shade * tint[c];
      v += (255 - v) * hl;
      out[o + c] = Math.round(v * a + under[j + c] * (1 - a));
    }
    out[o + 3] = Math.max(ua, Math.round(a * 255));
  }
}
