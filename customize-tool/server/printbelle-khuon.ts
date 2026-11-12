/**
 * Printbelle's khuôn in (asked 2026-11-11: "import thì tự tải khuôn in về"). The catalog API has no khuôn, but the
 * public site's product list (POST index/product/search, no account) gives every product an `artTemplateUrl`: a public
 * Google Drive folder that always holds the same files — 1=Correct sample, 2=Preview, 3=Template preview (dont use),
 * 4=Template.tif. The .tif is the khuôn at the print area's exact px, drawn the same way for every product:
 *
 *   grey #BFBFBF fill   "Content Safety" — the band between the cut and the safe zone (bleed / curved part)
 *   solid line          the cut (the piece's edge)
 *   dashed line         the safe zone
 *   light grey grid     "Spare Area" (sewn pieces: fabric around the pieces, filled but not cut to)
 *   middle of the sheet a legend: title, size, order codes, "Safe Area / Content Safety / Spare Area" icons, logo
 *
 * cleanPrintbelleKhuon keeps only the khuôn itself — the grey band and the lines that touch it — so the generic
 * reader (print-khuon-read.ts: solid = piece, dashed = safe zone) is not fooled by the legend's icons and text. The
 * band is kept as a light grey (not ink for the reader, a faint band in the guide). Sheets with no band (the
 * "USE FOR PRINT | USE FOR CUTOUT" custom-shape acrylics, whose cut is the design's own outline) give null.
 */

import sharp from "sharp";
import { CT_TABLES } from "../config";
import { newId } from "../lib/geometry";
import { normalizePrintSpec } from "../lib/print-template";
import type { CtPoint, CtShape } from "../types";
import type { CtPrintTemplate } from "../types/print";
import { ctLibraryPath, ctUpload } from "./storage";
import type { CtSession } from "./supabase";

const URL_INDEX = "https://fulfillment.printbelle.com/prod_api/index/product/search";

interface PbIndexItem {
  productCode: string;
  artTemplateUrl: string | null;
}

let indexCache: { at: number; byCode: Map<string, PbIndexItem> } | null = null;

/** The site's product list (one call, ~2 MB), kept for an hour. */
async function siteIndex(): Promise<Map<string, PbIndexItem>> {
  if (indexCache && Date.now() - indexCache.at < 3600_000) return indexCache.byCode;
  const res = await fetch(URL_INDEX, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ pageNum: 1, pageSize: 5000 }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Printbelle site: HTTP ${res.status}`);
  const body = (await res.json()) as { code: number; data: { list: PbIndexItem[] } | null };
  const byCode = new Map<string, PbIndexItem>();
  for (const p of body.data?.list ?? []) if (p.productCode) byCode.set(p.productCode.toUpperCase(), p);
  indexCache = { at: Date.now(), byCode };
  return byCode;
}

export interface DriveEntry {
  name: string;
  /** A file's id, or a folder's. */
  id: string;
  folder: boolean;
}

/** A public Drive folder's entries (Drive's embedded folder view — plain HTML, no API key). */
export async function driveFolder(id: string): Promise<DriveEntry[]> {
  const res = await fetch(`https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Google Drive: HTTP ${res.status}`);
  const html = await res.text();
  const out: DriveEntry[] = [];
  const unescape = (s: string) => s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  for (const m of html.matchAll(/<a href="([^"]+)"[^>]*>[\s\S]*?<div class="flip-entry-title">([^<]*)<\/div>/g)) {
    const href = unescape(m[1]);
    const file = /\/file\/d\/([\w-]+)/.exec(href);
    const dir = /\/folders\/([\w-]+)/.exec(href);
    if (file) out.push({ name: unescape(m[2]), id: file[1], folder: false });
    else if (dir) out.push({ name: unescape(m[2]), id: dir[1], folder: true });
  }
  return out;
}

function templateFile(entries: DriveEntry[]): DriveEntry | null {
  // "4=Template.tif", "4-TEMPLATE TIFF.tif"
  return entries.find((e) => !e.folder && /\.tiff?$/i.test(e.name) && /template/i.test(e.name) && !/preview/i.test(e.name)) ?? null;
}

export interface PbKhuonFile {
  /** Where it came from (shown on the base). */
  folderUrl: string;
  fileName: string;
  data: Buffer;
}

/** The product's Template.tif off its Drive folder (a "1PCS" sub-folder when the sheet is per pack); null = none. */
export async function printbelleKhuonFile(spu: string): Promise<PbKhuonFile | null> {
  const item = (await siteIndex()).get(spu.toUpperCase());
  const folderId = item?.artTemplateUrl ? /\/folders\/([\w-]+)/.exec(item.artTemplateUrl)?.[1] : null;
  if (!item?.artTemplateUrl || !folderId) return null;
  const entries = await driveFolder(folderId);
  let file = templateFile(entries);
  if (!file) {
    const one = entries.find((e) => e.folder && /^1\s*pcs/i.test(e.name));
    if (one) file = templateFile(await driveFolder(one.id));
  }
  if (!file) return null;
  const res = await fetch(`https://drive.usercontent.google.com/download?id=${encodeURIComponent(file.id)}&export=download&confirm=t`, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`Google Drive: tải ${file.name} lỗi HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length < 1000 || data.subarray(0, 64).toString("latin1").includes("<!DOCTYPE")) throw new Error(`Google Drive: không tải được ${file.name}`);
  return { folderUrl: item.artTemplateUrl, fileName: file.name, data };
}


/** A 0/1 map's 8-connected groups. */
export interface Group {
  px: Int32Array;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function groupsOf(map: Uint8Array, w: number, h: number): Group[] {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const out: Group[] = [];
  for (let s = 0; s < w * h; s++) {
    if (!map[s] || seen[s]) continue;
    const px: number[] = [];
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    let top = 0;
    seen[s] = 1;
    stack[top++] = s;
    while (top) {
      const i = stack[--top];
      px.push(i);
      const x = i % w;
      const y = (i - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (map[j] && !seen[j]) {
            seen[j] = 1;
            stack[top++] = j;
          }
        }
    }
    out.push({ px: Int32Array.from(px), x0, y0, x1, y1 });
  }
  return out;
}

/** 1 where the border of a w × h grid reaches over cells that are 0 in `wall` (4-connected). */
export function reach(wall: Uint8Array, w: number, h: number): Uint8Array {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let top = 0;
  const seed = (i: number) => {
    if (!wall[i] && !seen[i]) {
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
    if (i < (h - 1) * w) seed(i + w);
  }
  return seen;
}

/** Square dilation by `r` (row pass + column pass of running counts). */
export function grow(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let n = 0;
    for (let x = 0; x < Math.min(r, w); x++) n += src[row + x];
    for (let x = 0; x < w; x++) {
      if (x + r < w) n += src[row + x + r];
      if (x - r - 1 >= 0) n -= src[row + x - r - 1];
      tmp[row + x] = n > 0 ? 1 : 0;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let n = 0;
    for (let y = 0; y < Math.min(r, h); y++) n += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      if (y + r < h) n += tmp[(y + r) * w + x];
      if (y - r - 1 >= 0) n -= tmp[(y - r - 1) * w + x];
      out[y * w + x] = n > 0 ? 1 : 0;
    }
  }
  return out;
}

/** A filled region (local grid `w` × `h`, 1 = in) → its outline (Moore neighbour tracing), in local px. */
export function outline(map: Uint8Array, w: number, h: number): CtPoint[] {
  let start = -1;
  for (let i = 0; i < w * h; i++)
    if (map[i]) {
      start = i;
      break;
    }
  if (start < 0) return [];
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && map[y * w + x] === 1;
  // Clockwise from west.
  const DX = [-1, -1, 0, 1, 1, 1, 0, -1];
  const DY = [0, -1, -1, -1, 0, 1, 1, 1];
  const sx = start % w;
  const sy = (start - sx) / w;
  const pts: CtPoint[] = [{ x: sx, y: sy }];
  let x = sx;
  let y = sy;
  let dir = 0; // came in from the west (the cell before `start` in raster order is empty)
  for (let step = 0; step < 4 * w * h; step++) {
    let found = false;
    for (let k = 0; k < 8; k++) {
      const d = (dir + k) % 8;
      if (at(x + DX[d], y + DY[d])) {
        x += DX[d];
        y += DY[d];
        dir = (d + 6) % 8; // look again from the cell beside where we came from
        found = true;
        break;
      }
    }
    if (!found || (x === sx && y === sy)) break;
    pts.push({ x, y });
  }
  return pts;
}

/** Douglas–Peucker on a closed outline. */
export function simplify(pts: CtPoint[], tol: number): CtPoint[] {
  if (pts.length < 8) return pts;
  const keep = new Uint8Array(pts.length);
  // Split at the point farthest from the first, so the closed loop becomes two open runs.
  let far = 0;
  let best = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = (pts[i].x - pts[0].x) ** 2 + (pts[i].y - pts[0].y) ** 2;
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const run = (a: number, b: number) => {
    const stack: Array<[number, number]> = [[a, b]];
    while (stack.length) {
      const [i, j] = stack.pop() as [number, number];
      keep[i] = 1;
      keep[j % pts.length] = 1;
      const p = pts[i];
      const q = pts[j % pts.length];
      const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      let m = -1;
      let md = tol;
      for (let k = i + 1; k < j; k++) {
        const r = pts[k % pts.length];
        const d = Math.abs((q.x - p.x) * (p.y - r.y) - (p.x - r.x) * (q.y - p.y)) / len;
        if (d > md) {
          md = d;
          m = k;
        }
      }
      if (m >= 0) stack.push([i, m], [m, j]);
    }
  };
  run(0, far);
  run(far, pts.length);
  return pts.filter((_, i) => keep[i]);
}

/** A safe area (local map of its box, offset ox/oy, `k` = sheet px per map px) → rect / ellipse / polygon. */
function shapeOf(map: Uint8Array, w: number, h: number, ox: number, oy: number, k: number): CtShape | null {
  let n = 0;
  for (let i = 0; i < w * h; i++) n += map[i];
  if (!n) return null;
  const r = (v: number) => Math.round(v * 10) / 10;
  const fill = n / (w * h);
  if (fill > 0.95) return { type: "rect", x: r(ox * k), y: r(oy * k), w: r(w * k), h: r(h * k), radius: 0 };
  // An ellipse: the box's inscribed ellipse matches the area cell for cell (a hexagon-ish mask can fill π/4 too).
  if (Math.abs(fill - Math.PI / 4) < 0.03) {
    let off = 0;
    const rx = w / 2;
    const ry = h / 2;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const e = ((x + 0.5 - rx) / rx) ** 2 + ((y + 0.5 - ry) / ry) ** 2 <= 1 ? 1 : 0;
        if (e !== map[y * w + x]) off++;
      }
    if (off < 0.02 * n) return { type: "ellipse", cx: r((ox + rx) * k), cy: r((oy + ry) * k), rx: r(rx * k), ry: r(ry * k) };
  }
  const pts = simplify(outline(map, w, h), Math.max(1, Math.max(w, h) / 300));
  if (pts.length < 3) return null;
  return { type: "polygon", points: pts.map((p) => ({ x: r((ox + p.x + 0.5) * k), y: r((oy + p.y + 0.5) * k) })) };
}

/** The band kept in the clean khuôn's picture: a light grey (a faint band under the lines in the guide). */
const BAND = 222;
/** Long side the sheet is read at for the piece and the safe areas (the guide keeps the sheet's own px). */
const READ_SIDE = 3000;

export interface PbKhuonRead {
  width: number;
  height: number;
  /** The khuôn alone: the grey band + the lines touching it, transparent elsewhere (PNG, sheet px). */
  guide: Buffer;
  /** Alpha 255 = printed, sheet px, 1 channel; null = the whole sheet is printed. */
  mask: Buffer | null;
  /** The safe areas (what the band closes in: the dashed line runs along its inner edge), sheet px. */
  safe: CtShape[];
}

/**
 * Printbelle's Template.tif → the khuôn. null = no grey band (nothing to read). "print-cutout" = a 2:1 sheet split
 * down the middle, "USE FOR PRINT | USE FOR CUTOUT" (custom-shape acrylic / wood: the left half is printed, the right
 * half is the cut — the design's own outline in white): not a khuôn to cut to, so it is not used.
 *
 *  - band: grey groups that close in a big printable middle (≥ 0.5 % of the sheet) — the legend's solid "Content
 *    Safety" square and its small "Spare Area" grid icon close in nothing that big;
 *  - safe areas: those middles, the ones at least 40 % of the biggest (a hooded blanket's hood pieces and pockets are
 *    printed but are not where the design goes; a tote's front + back are both kept);
 *  - piece: what the sheet's white border can't reach through anything drawn (lines, band, spare-area grid): the
 *    spare area is printed ("not to be left blank"), white around a round ornament is not;
 *  - guide: the band (light grey) + every line touching it — the cut and the dashes; legend text and icons, the logo
 *    and the grid stand off the band and are dropped.
 */
export async function readPrintbelleKhuon(tif: Buffer): Promise<PbKhuonRead | "print-cutout" | null> {
  const { data, info } = await sharp(tif, { limitInputPixels: false, unlimited: true }).flatten({ background: "#ffffff" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const ch = info.channels;
  const N = W * H;
  const grey = new Uint8Array(N);
  const line = new Uint8Array(N);
  const drawn = new Uint8Array(N);
  for (let i = 0, p = 0; i < N; i++, p += ch) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const hi = Math.max(r, g, b);
    const lo = Math.min(r, g, b);
    if (lo < 245) drawn[i] = 1;
    if (Math.abs(r - 191) <= 6 && Math.abs(g - 191) <= 6 && Math.abs(b - 191) <= 6) grey[i] = 1;
    // Lines are coloured (purple / navy) or dark; the spare-area grid is a light neutral grey.
    else if (lo < 200 && (hi - lo > 40 || hi < 150)) line[i] = 1;
  }
  if (Math.abs(W / H - 2) < 0.03) {
    let rows = 0;
    const c0 = Math.round(W / 2 - W * 0.005);
    const c1 = Math.round(W / 2 + W * 0.005);
    for (let y = 0; y < H; y++)
      for (let x = c0; x <= c1; x++)
        if (line[y * W + x]) {
          rows++;
          break;
        }
    if (rows > 0.9 * H) return "print-cutout";
  }

  // Read the piece + safe areas on a smaller copy (nearest cell: the grey stays exactly grey).
  const k = Math.max(1, Math.max(W, H) / READ_SIDE);
  const w = Math.max(1, Math.round(W / k));
  const h = Math.max(1, Math.round(H / k));
  const at = (x: number, y: number) => Math.min(H - 1, Math.floor((y + 0.5) * (H / h))) * W + Math.min(W - 1, Math.floor((x + 0.5) * (W / w)));
  const sGrey = new Uint8Array(w * h);
  const sDrawn = new Uint8Array(w * h);
  const sLine = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const j = at(x, y);
      sGrey[y * w + x] = grey[j];
      sDrawn[y * w + x] = drawn[j];
      sLine[y * w + x] = line[j];
    }
  const sLineNear = grow(sLine, w, h, 1);

  const minHole = 0.005 * w * h;
  const band = new Uint8Array(w * h);
  const holes: Array<{ map: Uint8Array; bw: number; bh: number; ox: number; oy: number; n: number }> = [];
  for (const g of groupsOf(sGrey, w, h)) {
    if (g.px.length < 0.0005 * w * h) continue;
    const ox = g.x0 - 1;
    const oy = g.y0 - 1;
    const bw = g.x1 - g.x0 + 3;
    const bh = g.y1 - g.y0 + 3;
    const wall = new Uint8Array(bw * bh);
    for (const i of g.px) {
      const x = i % w;
      const y = (i - x) / w;
      wall[(y - oy) * bw + (x - ox)] = 1;
    }
    const holesOf = (walls: Uint8Array) => {
      const out = reach(walls, bw, bh);
      const inside = new Uint8Array(bw * bh);
      for (let i = 0; i < bw * bh; i++) if (!walls[i] && !out[i]) inside[i] = 1;
      return groupsOf(inside, bw, bh).filter((x) => x.px.length >= minHole);
    };
    let found = holesOf(wall);
    if (!found.length) {
      // A band open on one side (trouser legs: the hem is only the solid line) — the lines close it.
      for (let y = 0; y < bh; y++)
        for (let x = 0; x < bw; x++) {
          const gx = ox + x;
          const gy = oy + y;
          if (gx >= 0 && gy >= 0 && gx < w && gy < h && sLineNear[gy * w + gx]) wall[y * bw + x] = 1;
        }
      found = holesOf(wall);
    }
    let kept = false;
    for (const hole of found) {
      const hw = hole.x1 - hole.x0 + 1;
      const hh = hole.y1 - hole.y0 + 1;
      const map = new Uint8Array(hw * hh);
      for (const i of hole.px) {
        const x = i % bw;
        const y = (i - x) / bw;
        map[(y - hole.y0) * hw + (x - hole.x0)] = 1;
      }
      holes.push({ map, bw: hw, bh: hh, ox: ox + hole.x0, oy: oy + hole.y0, n: hole.px.length });
      kept = true;
    }
    if (kept) for (const i of g.px) band[i] = 1;
  }
  const big = Math.max(0, ...holes.map((x) => x.n));
  if (!big) return null;
  const safe = holes
    .filter((x) => x.n >= 0.4 * big)
    .map((x) => shapeOf(x.map, x.bw, x.bh, x.ox, x.oy, W / w))
    .filter((s): s is CtShape => !!s);

  // The piece: what the white border can't reach through anything drawn.
  const outside = reach(sDrawn, w, h);
  let out = 0;
  for (let i = 0; i < w * h; i++) out += outside[i];
  let mask: Buffer | null = null;
  if (out > 0.005 * w * h) {
    const piece = Buffer.alloc(w * h);
    for (let i = 0; i < w * h; i++) piece[i] = outside[i] ? 0 : 255;
    const up = await sharp(piece, { raw: { width: w, height: h, channels: 1 } }).resize(W, H, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
    mask = Buffer.alloc(N);
    for (let i = 0; i < N; i++) mask[i] = up.data[i * up.info.channels] >= 128 ? 255 : 0;
  }

  // The guide at the sheet's px: the kept band + the lines touching it.
  const bandFull = new Uint8Array(N);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, Math.floor(y / (H / h)));
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (grey[i] && band[sy * w + Math.min(w - 1, Math.floor(x / (W / w)))]) bandFull[i] = 1;
    }
  }
  const near = grow(bandFull, W, H, Math.max(3, Math.round(Math.max(W, H) * 0.003)));
  const pix = Buffer.alloc(N * 4);
  for (const g of groupsOf(line, W, H)) {
    let touches = false;
    for (const i of g.px)
      if (near[i]) {
        touches = true;
        break;
      }
    if (!touches) continue;
    for (const i of g.px) {
      pix[i * 4] = data[i * ch];
      pix[i * 4 + 1] = data[i * ch + 1];
      pix[i * 4 + 2] = data[i * ch + 2];
      pix[i * 4 + 3] = 255;
    }
  }
  for (let i = 0; i < N; i++)
    if (bandFull[i] && !pix[i * 4 + 3]) {
      pix[i * 4] = BAND;
      pix[i * 4 + 1] = BAND;
      pix[i * 4 + 2] = BAND;
      pix[i * 4 + 3] = 255;
    }
  const guide = await sharp(pix, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  return { width: W, height: H, guide, mask, safe };
}

export interface PbKhuonImport {
  /** The new khuôn (ct_print_templates), null = none made. */
  templateId: string | null;
  /** What happened, for the base's notes. */
  note: string;
  /** Printbelle's Drive folder with the khuôn files (Template.tif, samples), when found. */
  folderUrl: string | null;
}

/**
 * Printbelle product `spu` → a new khuôn in (its Template.tif read as above): the picture's own lines as the guide,
 * the piece as the mask, the safe areas. Never throws: a khuôn that can't be had is a note.
 */
export async function importPrintbelleKhuon(s: CtSession, spu: string, name: string): Promise<PbKhuonImport> {
  try {
    const file = await printbelleKhuonFile(spu);
    if (!file) return { templateId: null, note: "Printbelle không có file khuôn (Template.tif)", folderUrl: null };
    const folderUrl = file.folderUrl;
    const read = await readPrintbelleKhuon(file.data);
    if (read === "print-cutout") return { templateId: null, note: "Khuôn Printbelle dạng 2 ô (ô in | ô cắt theo hình thiết kế) — không dùng làm khuôn cắt", folderUrl };
    if (!read) return { templateId: null, note: `Không đọc được khuôn trong ${file.fileName}`, folderUrl };
    const put = (data: Buffer) => ctUpload(ctLibraryPath(s.user.id, null, "print-template", "image/png"), data, "image/png");
    const guideUrl = await put(read.guide);
    let maskUrl: string | null = null;
    if (read.mask) {
      const alpha = await sharp(read.mask, { raw: { width: read.width, height: read.height, channels: 1 } }).png().toBuffer();
      maskUrl = await put(await sharp({ create: { width: read.width, height: read.height, channels: 3, background: "#ffffff" } }).joinChannel(alpha).png().toBuffer());
    }
    const mm = (px: number) => Math.round((px / 300) * 254) / 10;
    const spec = normalizePrintSpec({
      width: read.width,
      height: read.height,
      dpi: 300,
      widthMm: mm(read.width),
      heightMm: mm(read.height),
      safe: read.safe,
      faces: [{ id: newId(), name: "Mặt in", imageUrl: guideUrl, maskUrl, guideUrl }],
      notes: `Khuôn Printbelle ${spu}: ${file.fileName} · ${file.folderUrl}`,
    });
    const { data: last } = await s.supabase.from(CT_TABLES.printTemplates).select("sort_order").order("sort_order", { ascending: false }).limit(1).maybeSingle<{ sort_order: number }>();
    const { data, error } = await s.supabase
      .from(CT_TABLES.printTemplates)
      .insert({ name: `${name} · Printbelle ${spu}`.slice(0, 200), kind: "flat", spec, sort_order: (last?.sort_order ?? 0) + 1, user_id: s.user.id })
      .select("*")
      .single<CtPrintTemplate>();
    if (error) return { templateId: null, note: `Không lưu được khuôn: ${error.message}`, folderUrl };
    return { templateId: data.id, note: `Khuôn in tải từ Printbelle (${file.fileName}, ${read.width}×${read.height}px${read.safe.length ? `, ${read.safe.length} vùng an toàn` : ""})`, folderUrl };
  } catch (e) {
    return { templateId: null, note: `Không tải được khuôn Printbelle: ${e instanceof Error ? e.message : "lỗi"}`, folderUrl: null };
  }
}
