/**
 * Pixel steps of the customer-photo clean-up on raw RGBA, with no canvas: the browser (lib/image-tools,
 * lib/photo-process) runs them on ImageData, the server (server/photo-tasks.ts) on sharp's raw buffers — so a photo
 * finished on the server is the same picture the browser would have made.
 */

/** An RGBA pixel array: ImageData.data in the browser, a Buffer on the server. */
export type CtRgba = Uint8ClampedArray | Uint8Array;

export interface RemoveBackgroundOptions {
  /** 0–255 per-channel distance from the sampled backdrop colour. */
  tolerance: number;
  /** Width (px) of the soft edge ramp. */
  feather: number;
}

export function sampleBackdrop(data: CtRgba, w: number, h: number): [number, number, number] {
  // Median of the four corners' 4x4 blocks — robust to one stray corner.
  const samples: Array<[number, number, number]> = [];
  const corners: Array<[number, number]> = [
    [0, 0],
    [w - 4, 0],
    [0, h - 4],
    [w - 4, h - 4],
  ];
  for (const [cx, cy] of corners) {
    for (let y = Math.max(0, cy); y < Math.min(h, cy + 4); y++) {
      for (let x = Math.max(0, cx); x < Math.min(w, cx + 4); x++) {
        const i = (y * w + x) * 4;
        samples.push([data[i], data[i + 1], data[i + 2]]);
      }
    }
  }
  const median = (k: 0 | 1 | 2) => {
    const v = samples.map((s) => s[k]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)] ?? 255;
  };
  return [median(0), median(1), median(2)];
}

/**
 * Flood-fills from every border pixel that matches the backdrop, so only backdrop CONNECTED to the edge goes
 * transparent (white eyes inside the subject survive), then feathers the cut. In place.
 */
export function keyOutBackdrop(d: CtRgba, w: number, h: number, opts: RemoveBackgroundOptions): void {
  const [br, bg, bb] = sampleBackdrop(d, w, h);
  const dist = (i: number) => Math.max(Math.abs(d[i] - br), Math.abs(d[i + 1] - bg), Math.abs(d[i + 2] - bb));

  const visited = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  const push = (p: number) => {
    if (visited[p]) return;
    if (dist(p * 4) > opts.tolerance) return;
    visited[p] = 1;
    queue[tail++] = p;
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (head < tail) {
    const p = queue[head++];
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w);
    if (y < h - 1) push(p + w);
  }

  // Hard cut, then a distance-based feather on the boundary.
  for (let p = 0; p < w * h; p++) if (visited[p]) d[p * 4 + 3] = 0;

  const feather = Math.max(0, Math.round(opts.feather));
  if (feather > 0) {
    // Distance (in px, chessboard metric) from each kept pixel to the cut, capped at feather.
    const far = feather + 1;
    const distMap = new Uint8Array(w * h).fill(far);
    for (let p = 0; p < w * h; p++) if (visited[p]) distMap[p] = 0;
    for (let pass = 0; pass < feather; pass++) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const p = y * w + x;
          if (distMap[p] <= pass) continue;
          const n =
            (x > 0 && distMap[p - 1] === pass) ||
            (x < w - 1 && distMap[p + 1] === pass) ||
            (y > 0 && distMap[p - w] === pass) ||
            (y < h - 1 && distMap[p + w] === pass);
          if (n) distMap[p] = pass + 1;
        }
      }
    }
    for (let p = 0; p < w * h; p++) {
      const k = distMap[p];
      if (k === 0 || k === far) continue;
      // Pixels near the cut that still look like backdrop fade more.
      const closeness = 1 - Math.min(1, dist(p * 4) / Math.max(1, opts.tolerance * 2));
      const alpha = (k / (feather + 1)) * (1 - closeness * 0.6);
      d[p * 4 + 3] = Math.round(d[p * 4 + 3] * Math.min(1, alpha + 0.15));
    }
  }
}

/** The box of the pixels with alpha > 8, grown by `padding` and kept on the picture; null = all transparent. */
export function opaqueBox(d: CtRgba, w: number, h: number, padding = 4): { x: number; y: number; w: number; h: number } | null {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = Math.min(w - 1, maxX + padding);
  maxY = Math.min(h - 1, maxY + padding);
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * A cut-out whose body runs off the photo (the usual pet portrait: chest cut
 * by the bottom of the frame) would end in a ruler-straight line. Fade it out
 * toward every photo edge the subject actually touches, over ~12% of the
 * image. The reach wanders slowly and is broken up by bristle-width streaks
 * running into the edge, so it ends like the tail of a brush stroke rather
 * than a straight gradient. Edges the subject doesn't touch are left alone, so ears
 * near the top are never faded. In place; false = nothing was cropped.
 */
export function fadeCroppedEdgesData(d: CtRgba, w: number, h: number): boolean {
  if (w < 8 || h < 8) return false;
  const alphaAt = (x: number, y: number) => d[(y * w + x) * 4 + 3];

  let top = 0;
  let bottom = 0;
  let left = 0;
  let right = 0;
  for (let x = 0; x < w; x++) {
    if (alphaAt(x, 0) > 128) top++;
    if (alphaAt(x, h - 1) > 128) bottom++;
  }
  for (let y = 0; y < h; y++) {
    if (alphaAt(0, y) > 128) left++;
    if (alphaAt(w - 1, y) > 128) right++;
  }
  // A few stray pixels (a whisker tip) don't count as a crop.
  const cropped = { top: top > w * 0.04, bottom: bottom > w * 0.04, left: left > h * 0.04, right: right > h * 0.04 };
  if (!cropped.top && !cropped.bottom && !cropped.left && !cropped.right) return false;

  const size = Math.min(w, h);
  const reach = Math.max(10, size * 0.12);
  // Smooth, deterministic wobble of the reach along an edge (0.7..1.3).
  const wobble = (t: number, seed: number) => {
    const u = (t / size) * Math.PI * 2;
    return 1 + 0.18 * Math.sin(u * 2.3 + seed) + 0.12 * Math.sin(u * 5.7 + seed * 1.7);
  };
  // Deterministic value noise along an edge: brush-width clumps (~2% of the image) plus finer bristles.
  const bristle = Math.max(3, size * 0.02);
  const hash = (i: number, seed: number) => {
    const v = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
    return v - Math.floor(v);
  };
  const octave = (t: number, seed: number) => {
    const p = t / bristle;
    const i = Math.floor(p);
    const f = p - i;
    const a = hash(i, seed);
    return a + (hash(i + 1, seed) - a) * f * f * (3 - 2 * f);
  };
  const streaks = (t: number, seed: number) => 0.65 * octave(t, seed) + 0.35 * octave(t * 2.9, seed + 7);
  const ease = (e: number) => (e >= 1 ? 1 : e <= 0 ? 0 : e * e * (3 - 2 * e));
  const rowTop = new Float32Array(w);
  const rowBottom = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    rowTop[x] = reach * wobble(x, 1.3) * (0.8 + 0.4 * streaks(x, 1.3));
    rowBottom[x] = reach * wobble(x, 4.1) * (0.8 + 0.4 * streaks(x, 4.1));
  }
  const colLeft = new Float32Array(h);
  const colRight = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    colLeft[y] = reach * wobble(y, 2.2) * (0.8 + 0.4 * streaks(y, 2.2));
    colRight[y] = reach * wobble(y, 5.9) * (0.8 + 0.4 * streaks(y, 5.9));
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4 + 3;
      if (d[i] === 0) continue;
      let f = 1;
      if (cropped.top) f = Math.min(f, ease(y / rowTop[x]));
      if (cropped.bottom) f = Math.min(f, ease((h - 1 - y) / rowBottom[x]));
      if (cropped.left) f = Math.min(f, ease(x / colLeft[y]));
      if (cropped.right) f = Math.min(f, ease((w - 1 - x) / colRight[y]));
      if (f < 1) d[i] = Math.round(d[i] * f);
    }
  }
  return true;
}
