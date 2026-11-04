/** Browser only: a canvas cropped to what it shows (a bộ's picture close round its character). */

/** A copy of `c` cropped to its visible pixels, with a small margin (the canvas itself when it is empty). */
export function trimCanvas(c: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = c.getContext("2d");
  if (!ctx || !c.width || !c.height) return c;
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let x0 = c.width;
  let y0 = c.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < c.height; y++)
    for (let x = 0; x < c.width; x++)
      if (data[(y * c.width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return c;
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.04);
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(c.width - 1, x1 + pad);
  y1 = Math.min(c.height - 1, y1 + pad);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext("2d")?.drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}
