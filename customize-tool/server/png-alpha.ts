/**
 * Does a PNG actually use transparency? Decodes just enough of the file
 * (node:zlib + scanline unfiltering) to count see-through pixels, so the
 * server can tell whether an AI model already cut the subject out and the
 * bg-remover pass can be skipped. No native image library (see image-size.ts).
 */

import { inflateSync } from "node:zlib";

interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Channels per colour type: 0 grey, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * True when at least `minFraction` of the pixels are mostly transparent
 * (alpha < 50%). A few soft edge pixels don't count: a model that returns an
 * opaque photo with anti-aliased corners has not removed its background.
 */
export function pngHasTransparency(buf: Buffer, minFraction = 0.02): boolean {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) return false;
  let header: PngHeader | null = null;
  const idat: Buffer[] = [];
  let hasTrns = false;
  for (let i = 8; i + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString("latin1", i + 4, i + 8);
    const data = buf.subarray(i + 8, i + 8 + len);
    if (type === "IHDR") {
      header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8], colorType: data[9], interlace: data[12] };
    } else if (type === "tRNS") {
      hasTrns = true;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    i += 12 + len;
  }
  if (!header) return false;
  // Palette / key-colour transparency: rare from image models, and decoding it
  // needs the palette — a tRNS chunk is only written when something is see-through.
  if (header.colorType !== 4 && header.colorType !== 6) return hasTrns;
  // Adam7 would need per-pass decoding; an interlaced PNG with an alpha channel is treated as cut out.
  if (header.interlace !== 0) return true;

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return false;
  }
  const { width, height, bitDepth, colorType } = header;
  const bytesPerSample = bitDepth === 16 ? 2 : 1;
  const bpp = CHANNELS[colorType] * bytesPerSample;
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) return false;

  const alphaOffset = (CHANNELS[colorType] - 1) * bytesPerSample; // high byte for 16-bit
  let prev = Buffer.alloc(stride);
  let cur = Buffer.alloc(stride);
  let clear = 0;
  const need = Math.max(1, Math.ceil(width * height * minFraction));
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    const filter = raw[row];
    for (let x = 0; x < stride; x++) {
      const v = raw[row + 1 + x];
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      switch (filter) {
        case 1: cur[x] = v + a; break;
        case 2: cur[x] = v + b; break;
        case 3: cur[x] = v + ((a + b) >> 1); break;
        case 4: cur[x] = v + paeth(a, b, c); break;
        default: cur[x] = v;
      }
    }
    for (let x = alphaOffset; x < stride; x += bpp) {
      if (cur[x] < 128 && ++clear >= need) return true;
    }
    [prev, cur] = [cur, prev];
  }
  return false;
}
