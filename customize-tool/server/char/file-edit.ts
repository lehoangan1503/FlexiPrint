/**
 * One clipart file edited by hand (asked 2026-10-12: "mỗi clipart khi tạo ra rồi là độc lập — sửa là thumbnail sửa
 * luôn, clipart sửa luôn; chỉ vị trí so với master là không đổi"):
 *
 *   POST char/projects/:id/layers/file {imageId, mask}  → { project } the file (and its thumbnail, and every product
 *                                                          clipart copied from it) becomes the mask the editor drew
 *   POST char/projects/:id/layers/file/revert {imageId} → { project } back to the version before
 *
 * The mask is the file's alpha on the set's canvas. Pixels it keeps keep their colours; pixels it adds are painted
 * from the file's own colour plate (layer-kit "plates": black jeans stay black). A part made of a back + a front layer
 * (hair) is edited by its FRONT file alone (asked 2026-10-13: the back is the whole hair, only the front needs fixing);
 * its back and its option picture (the whole part) do not change.
 * The editor can also MOVE a clipart (asked 2026-10-14: "kéo bộ clipart … lưu vị trí mới … khắp mọi sản phẩm"): every
 * file of that option (each colour, back and front, its view, plate and edit masks) is shifted by whole px; the shift
 * is kept on the file (`offset`) and a new cut is shifted the same. The canvas and its size never change. The mask is
 * kept on the file and applied again when the
 * set is cut again (runBuild → reapplyEdits) — as a difference: what the editor erased from / added to the plain cut it
 * started from (editBaseUrl) is erased from / added to the new cut, so everything else takes the new cut's edges.
 */

import sharp from "sharp";
import { CT_TABLES } from "../../config";
import type { CtCharCrop, CtCharFileVersion, CtCharImage, CtCharLayerFile, CtCharLayerSet, CtCharProject } from "../../types";
import { fetchImage, saveCharFile, saveCharRaw } from "./files";
import { projectRow, type Db } from "./projects";

interface Raw {
  data: Buffer;
  w: number;
  h: number;
}

async function rgba(src: Buffer, w?: number, h?: number): Promise<Raw> {
  let img = sharp(src, { limitInputPixels: 20000 * 20000 }).ensureAlpha();
  if (w && h) img = img.resize(w, h, { fit: "fill" });
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

const png = (r: Raw) => sharp(r.data, { raw: { width: r.w, height: r.h, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();

/** A data URL / base64 PNG → its bytes. */
export function pngBytes(v: unknown): Buffer | null {
  if (typeof v !== "string") return null;
  const m = /^data:image\/png;base64,(.+)$/.exec(v);
  const b = Buffer.from(m ? m[1] : v, "base64");
  return b.length > 100 ? b : null;
}

/** [x, y, w, h] of the visible pixels. */
function bboxOf(r: Raw): number[] {
  let x0 = r.w, y0 = r.h, x1 = -1, y1 = -1;
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++)
      if (r.data[(y * r.w + x) * 4 + 3] > 2) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? [0, 0, 0, 0] : [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}

/** A mask drawn on an older canvas, moved onto this one (the same place on the master). */
function moveMask(mask: Raw, from: CtCharCrop | undefined, to: CtCharCrop | undefined, w: number, h: number): Raw {
  const dx = (from?.x ?? 0) - (to?.x ?? 0);
  const dy = (from?.y ?? 0) - (to?.y ?? 0);
  if (!dx && !dy && mask.w === w && mask.h === h) return mask;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= mask.h) continue;
    for (let x = 0; x < w; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= mask.w) continue;
      mask.data.copy(out, (y * w + x) * 4, (sy * mask.w + sx) * 4, (sy * mask.w + sx) * 4 + 4);
    }
  }
  return { data: out, w, h };
}

/** Square min (erode) / max (dilate) of a 0/1 plane, radius r — separable. */
function morph(src: Uint8Array, w: number, h: number, r: number, max: boolean): Uint8Array {
  const tmp = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  const run = (a: Uint8Array, b: Uint8Array, n: number, m: number, stride: number, step: number) => {
    for (let i = 0; i < n; i++)
      for (let j = 0; j < m; j++) {
        let v = max ? 0 : 1;
        for (let k = Math.max(0, j - r); k <= Math.min(m - 1, j + r); k++) {
          const x = a[i * stride + k * step];
          if (max ? x : !x) {
            v = max ? 1 : 0;
            break;
          }
        }
        b[i * stride + j * step] = v;
      }
  };
  run(src, tmp, h, w, w, 1);
  run(tmp, out, w, h, 1, w);
  return out;
}

/** Only the parts of a difference at least ~2r px across: a band along the edge (an older cut's edge, not a stroke)
 * goes. `d` is the difference's size per pixel (0–255). */
function wideOnly(d: Int16Array, w: number, h: number, r: number): void {
  const on = new Uint8Array(d.length);
  for (let i = 0; i < d.length; i++) on[i] = d[i] > 64 ? 1 : 0;
  const keep = morph(morph(morph(on, w, h, r, false), w, h, r, true), w, h, 1, true);
  for (let i = 0; i < d.length; i++) if (!keep[i]) d[i] = 0;
}

/** The file with this id and its slot. */
function fileOf(set: CtCharLayerSet, imageId: string): { slot: string; file: CtCharLayerFile } | null {
  for (const sl of set.slots) {
    const f = sl.files.find((x) => x.imageId === imageId);
    if (f) return { slot: sl.key, file: f };
  }
  return null;
}

interface Saved {
  entry: Pick<CtCharLayerFile, "imageId" | "url" | "thumbUrl" | "bbox">;
  row: CtCharImage;
}

async function store(db: Db, userId: string, p: CtCharProject, old: CtCharImage, r: Raw): Promise<Saved> {
  const saved = await saveCharFile(userId, p.id, "layer", await png(r));
  const { data, error } = await db
    .from(CT_TABLES.charImages)
    .insert({ project_id: p.id, user_id: userId, kind: "layer", role: old.role, status: "done", note: old.note, ...saved, meta: { edited: true, editOf: old.id } })
    .select("*")
    .single<CtCharImage>();
  if (error || !data) throw new Error(error?.message ?? "Không lưu được file");
  return { entry: { imageId: data.id, url: data.url, thumbUrl: data.thumb_url, bbox: bboxOf(r) }, row: data };
}

async function rowsOf(db: Db, ids: string[]): Promise<Map<string, CtCharImage>> {
  const { data } = await db.from(CT_TABLES.charImages).select("*").in("id", ids).returns<CtCharImage[]>();
  return new Map((data ?? []).map((r) => [r.id, r]));
}

/**
 * Apply a mask to a file on `set` (in memory): the new file stored, the set's entry replaced. Returns the old and new
 * image rows (for the products) and the R2 paths it added.
 */
async function applyMask(db: Db, userId: string, p: CtCharProject, set: CtCharLayerSet, g: { slot: string; file: CtCharLayerFile }, maskPng: Buffer, history: boolean): Promise<{ olds: CtCharImage[]; news: CtCharImage[]; paths: string[] }> {
  const W = set.width;
  const H = set.height;
  const f = g.file;
  // The plain cut the edits are made on: kept from the first edit on.
  const base = f.editBaseUrl ?? f.url;
  const mask = await rgba(maskPng, W, H);
  // Added pixels take the file's own colours (its plate); kept pixels keep theirs.
  const plate = f.plateUrl ? await rgba(await fetchImage(f.plateUrl), W, H) : null;
  const old = (await rowsOf(db, [f.imageId])).get(f.imageId);
  if (!old) throw new Error("Không thấy file");
  const src = await rgba(await fetchImage(f.url), W, H);
  const out: Raw = { data: Buffer.alloc(W * H * 4), w: W, h: H };
  for (let i = 0; i < W * H * 4; i += 4) {
    const alpha = mask.data[i + 3];
    const from = src.data[i + 3] > 0 || !plate ? src : plate;
    out.data[i] = alpha ? from.data[i] : 0;
    out.data[i + 1] = alpha ? from.data[i + 1] : 0;
    out.data[i + 2] = alpha ? from.data[i + 2] : 0;
    out.data[i + 3] = alpha;
  }
  const { history: _h, ...was } = f;
  const now: CtCharFileVersion = { at: new Date().toISOString(), files: [{ slot: g.slot, file: was }] };
  const s = await store(db, userId, p, old, out);
  // The mask stays with the file (applied again after a new cut), and the version before it for "Hoàn tác".
  const m = await saveCharRaw(userId, p.id, "cut", maskPng, "image/png");
  const patch: Partial<CtCharLayerFile> = { ...s.entry, editMaskUrl: m.url, editCrop: set.crop, editBaseUrl: base, history: history ? [...(f.history ?? []), now].slice(-8) : f.history };
  set.slots = set.slots.map((sl) => (sl.key !== g.slot ? sl : { ...sl, files: sl.files.map((x) => (x.imageId === f.imageId ? { ...x, ...patch } : x)) }));
  return { olds: [old], news: [s.row], paths: [m.path] };
}

/** A picture on the set's canvas moved by whole px (what leaves the canvas goes, what comes in is empty). */
function shifted(r: Raw, dx: number, dy: number): Raw {
  const out = Buffer.alloc(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= r.h) continue;
    const x0 = Math.max(0, dx);
    const x1 = Math.min(r.w, r.w + dx);
    if (x1 <= x0) continue;
    r.data.copy(out, (y * r.w + x0) * 4, (sy * r.w + x0 - dx) * 4, (sy * r.w + x1 - dx) * 4);
  }
  return { data: out, w: r.w, h: r.h };
}

/** The files a move takes along: every colour of the option, its back and front (same option name, same part). */
function moveGroup(set: CtCharLayerSet, g: { slot: string; file: CtCharLayerFile }): Array<{ slot: string; file: CtCharLayerFile }> {
  const base = g.slot.replace(/:(back|front)$/, "");
  return set.slots.filter((sl) => sl.key === base || sl.key === `${base}:back` || sl.key === `${base}:front`).flatMap((sl) => sl.files.filter((f) => f.option === g.file.option).map((file) => ({ slot: sl.key, file })));
}

/**
 * Move files on `set` (in memory) by (dx, dy) whole px: each file, its view, plate and edit masks shifted and stored,
 * its entry updated (offset added up). With `history`, one version on `main` holds every file as it was.
 */
async function moveFiles(db: Db, userId: string, p: CtCharProject, set: CtCharLayerSet, files: Array<{ slot: string; file: CtCharLayerFile }>, dx: number, dy: number, main: { slot: string; file: CtCharLayerFile } | null): Promise<{ olds: CtCharImage[]; news: CtCharImage[]; paths: string[] }> {
  const W = set.width;
  const H = set.height;
  const olds: CtCharImage[] = [];
  const news: CtCharImage[] = [];
  const paths: string[] = [];
  const raw = async (url: string, mime: "image/png" | "image/jpeg") => {
    const r = shifted(await rgba(await fetchImage(url), W, H), dx, dy);
    const img = sharp(r.data, { raw: { width: W, height: H, channels: 4 } });
    const saved = await saveCharRaw(userId, p.id, "cut", mime === "image/png" ? await img.png({ compressionLevel: 9 }).toBuffer() : await img.flatten({ background: "#ffffff" }).jpeg({ quality: 92 }).toBuffer(), mime);
    paths.push(saved.path);
    return saved.url;
  };
  // Shared pictures (a view, a plate) are moved once.
  const done = new Map<string, string>();
  const once = async (url: string, make: () => Promise<string>) => done.get(url) ?? done.set(url, await make()).get(url)!;
  const rows = await rowsOf(db, files.map((x) => x.file.imageId));
  const version: CtCharFileVersion = { at: new Date().toISOString(), files: [] };
  for (const { slot, file: f } of files) {
    const old = rows.get(f.imageId);
    if (!old) throw new Error("Không thấy file");
    const { history: _h, ...was } = f;
    version.files.push({ slot, file: was });
    const s = await store(db, userId, p, old, shifted(await rgba(await fetchImage(f.url), W, H), dx, dy));
    olds.push(old);
    news.push(s.row);
    const patch: Partial<CtCharLayerFile> = { ...s.entry, offset: [(f.offset?.[0] ?? 0) + dx, (f.offset?.[1] ?? 0) + dy] };
    if (f.viewUrl) {
      const v = f.viewUrl;
      const url = await once(v, async () => {
        const { data: vr } = await db.from(CT_TABLES.charImages).select("*").eq("project_id", p.id).eq("url", v).maybeSingle<CtCharImage>();
        if (!vr) return v;
        const sv = await store(db, userId, p, vr, shifted(await rgba(await fetchImage(v), W, H), dx, dy));
        olds.push(vr);
        news.push(sv.row);
        done.set(`thumb:${v}`, sv.row.thumb_url || sv.row.url);
        return sv.row.url;
      });
      patch.viewUrl = url;
      patch.viewThumbUrl = done.get(`thumb:${v}`) ?? f.viewThumbUrl;
    }
    if (f.plateUrl) patch.plateUrl = await once(f.plateUrl, () => raw(f.plateUrl!, "image/jpeg"));
    // A hand edit is kept where the file now is (applied again after a new cut, once that is moved the same).
    if (f.editMaskUrl) patch.editMaskUrl = await once(f.editMaskUrl, () => raw(f.editMaskUrl!, "image/png"));
    if (f.editBaseUrl) patch.editBaseUrl = await once(f.editBaseUrl, () => raw(f.editBaseUrl!, "image/png"));
    set.slots = set.slots.map((sl) => (sl.key !== slot ? sl : { ...sl, files: sl.files.map((x) => (x.imageId === f.imageId ? { ...x, ...patch } : x)) }));
  }
  if (main) {
    const { option, color, history } = main.file;
    set.slots = set.slots.map((sl) => (sl.key !== main.slot ? sl : { ...sl, files: sl.files.map((x) => (x.option === option && x.color === color ? { ...x, history: [...(history ?? []), version].slice(-8) } : x)) }));
  }
  return { olds, news, paths };
}

async function relink(db: Db, p: CtCharProject, olds: CtCharImage[], news: CtCharImage[]): Promise<void> {
  const { relinkProducts } = await import("./layers");
  await relinkProducts(db, p, olds, news).catch((e: Error) => console.warn("[ct] char file relink", e.message));
}

/** POST …/layers/file {imageId, mask?, move?: {dx, dy}} — the mask first (drawn where the file is), then the move. */
export async function editLayerFile(db: Db, userId: string, p: CtCharProject, body: unknown): Promise<CtCharProject> {
  const b = (body ?? {}) as { imageId?: unknown; mask?: unknown; move?: { dx?: unknown; dy?: unknown } | null };
  const set = p.layers;
  if (!set || set.status !== "done") throw new Error("Chưa có bộ file");
  const g = fileOf(set, String(b.imageId ?? ""));
  if (!g) throw new Error("Không thấy file này trong bộ");
  const mask = b.mask == null ? null : pngBytes(b.mask);
  if (b.mask != null && !mask) throw new Error("Mặt nạ không hợp lệ (PNG)");
  const dx = Math.round(Number(b.move?.dx) || 0);
  const dy = Math.round(Number(b.move?.dy) || 0);
  if (!mask && !dx && !dy) throw new Error("Không có thay đổi");
  const next: CtCharLayerSet = { ...set, slots: set.slots.map((s) => ({ ...s, files: [...s.files] })) };
  const r = { olds: [] as CtCharImage[], news: [] as CtCharImage[], paths: [] as string[] };
  const add = (x: typeof r) => (r.olds.push(...x.olds), r.news.push(...x.news), r.paths.push(...x.paths));
  if (mask) {
    // Every colour of the option is the same cut-out recoloured (layer-kit): the edit goes to each, in its own colours
    // (asked 2026-10-20: "sửa 1 màu, tất cả các màu còn lại cũng update theo"). One version on the opened file holds
    // them all for "Hoàn tác".
    const colours = next.slots.find((sl) => sl.key === g.slot)!.files.filter((f) => f.option === g.file.option);
    const version: CtCharFileVersion = { at: new Date().toISOString(), files: colours.map(({ history: _h, ...was }) => ({ slot: g.slot, file: was })) };
    for (const file of colours) add(await applyMask(db, userId, p, next, { slot: g.slot, file }, mask, false));
    next.slots = next.slots.map((sl) => (sl.key !== g.slot ? sl : { ...sl, files: sl.files.map((x) => (x.option === g.file.option && x.color === g.file.color ? { ...x, history: [...(g.file.history ?? []), version].slice(-8) } : x)) }));
  }
  if (dx || dy) {
    const now = fileOf(next, next.slots.find((sl) => sl.key === g.slot)?.files.find((f) => f.option === g.file.option && f.color === g.file.color)?.imageId ?? "")!;
    add(await moveFiles(db, userId, p, next, moveGroup(next, now), dx, dy, now));
  }
  next.extraPaths = [...(next.extraPaths ?? []), ...r.paths];
  const { data, error } = await db.from(CT_TABLES.charProjects).update({ layers: next }).eq("id", p.id).select("*").single<CtCharProject>();
  if (error || !data) throw new Error(error?.message ?? "Không lưu được");
  await relink(db, p, r.olds, r.news);
  return projectRow(data);
}

/** POST …/layers/file/revert {imageId} — the group as it was before its last edit (the older files are kept). */
export async function revertLayerFile(db: Db, p: CtCharProject, body: unknown): Promise<CtCharProject> {
  const set = p.layers;
  if (!set || set.status !== "done") throw new Error("Chưa có bộ file");
  const g = fileOf(set, String((body as { imageId?: unknown } | null)?.imageId ?? ""));
  const last = g?.file.history?.at(-1);
  if (!g || !last) throw new Error("Không có bản trước để hoàn tác");
  const rest = g.file.history!.slice(0, -1);
  // Each restored entry ↔ the one it replaces (the products follow its url).
  const swaps: Array<{ now: CtCharLayerFile; was: CtCharLayerFile }> = [];
  const next: CtCharLayerSet = {
    ...set,
    slots: set.slots.map((sl) => ({
      ...sl,
      files: sl.files.map((f) => {
        const was = last.files.find((x) => x.slot === sl.key && x.file.option === f.option && x.file.color === f.color);
        if (!was) return f;
        swaps.push({ now: f, was: was.file });
        const main = sl.key === g.slot && f.option === g.file.option && f.color === g.file.color;
        return { ...was.file, history: main ? rest : f.history };
      }),
    })),
  };
  const { data, error } = await db.from(CT_TABLES.charProjects).update({ layers: next }).eq("id", p.id).select("*").single<CtCharProject>();
  if (error || !data) throw new Error(error?.message ?? "Không lưu được");
  const pairs = swaps.flatMap((x) => [[x.now.url, x.was.url] as const, [x.now.viewUrl, x.was.viewUrl] as const]).filter((x): x is readonly [string, string] => !!x[0] && !!x[1] && x[0] !== x[1]);
  const urls = pairs.flat();
  const { data: rows } = await db.from(CT_TABLES.charImages).select("*").eq("project_id", p.id).in("url", [...new Set(urls)]).returns<CtCharImage[]>();
  const byUrl = new Map((rows ?? []).map((r) => [r.url, r]));
  const olds: CtCharImage[] = [];
  const news: CtCharImage[] = [];
  const seen = new Set<string>();
  for (const [a, b] of pairs) {
    const o = byUrl.get(a);
    const n = byUrl.get(b);
    if (!o || !n || o.id === n.id || seen.has(o.id)) continue;
    seen.add(o.id);
    olds.push(o);
    news.push(n);
  }
  await relink(db, p, olds, news);
  return projectRow(data);
}

/**
 * After a new cut: every file the editor had edited gets its mask again (moved if the canvas moved on the master).
 * Called on the new set before it is saved.
 */
export async function reapplyEdits(db: Db, userId: string, p: CtCharProject, oldSet: CtCharLayerSet | null, set: CtCharLayerSet): Promise<string[]> {
  const paths: string[] = [];
  if (!oldSet) return paths;
  // Moved by hand: the new cut is moved the same first (its edit masks were kept where the file was moved to).
  const moves = new Map<string, Array<{ slot: string; file: CtCharLayerFile }>>();
  for (const sl of oldSet.slots)
    for (const f of sl.files) {
      const [dx = 0, dy = 0] = f.offset ?? [];
      const cur = set.slots.find((x) => x.key === sl.key)?.files.find((x) => x.option === f.option && x.color === f.color);
      if ((!dx && !dy) || !cur) continue;
      const key = `${dx},${dy}`;
      moves.set(key, [...(moves.get(key) ?? []), { slot: sl.key, file: cur }]);
    }
  for (const [key, files] of moves) {
    const [dx, dy] = key.split(",").map(Number);
    try {
      paths.push(...(await moveFiles(db, userId, p, set, files, dx, dy, null)).paths);
    } catch (e) {
      console.warn("[ct] char reapply move", e instanceof Error ? e.message : String(e));
    }
  }
  for (const sl of oldSet.slots)
    for (const f of sl.files) {
      if (!f.editMaskUrl) continue;
      const g = (() => {
        const cur = set.slots.find((x) => x.key === sl.key)?.files.find((x) => x.option === f.option && x.color === f.color);
        return cur ? fileOf(set, cur.imageId) : null;
      })();
      if (!g) continue;
      try {
        const W = set.width;
        const H = set.height;
        let moved = moveMask(await rgba(await fetchImage(f.editMaskUrl)), f.editCrop, set.crop, W, H);
        // An edit saved before editBaseUrl existed: its oldest version is the plain cut it was made on.
        const first = f.history?.[0]?.files.find((x) => x.slot === sl.key)?.file;
        const baseUrl = f.editBaseUrl ?? first?.url;
        if (baseUrl) {
          // new = the new cut + (the edit − what it was made on)
          const was = moveMask(await rgba(await fetchImage(baseUrl)), f.editCrop, set.crop, W, H);
          const now = await rgba(await fetchImage(g.file.url), W, H);
          const erased = new Int16Array(W * H);
          const added = new Int16Array(W * H);
          for (let i = 0; i < W * H; i++) {
            const d = moved.data[i * 4 + 3] - was.data[i * 4 + 3];
            erased[i] = Math.max(0, -d);
            added[i] = Math.max(0, d);
          }
          // Only real strokes count: a thin band along the edge is where two cuts' edges differ (an edit saved before
          // editBaseUrl carried its cut's hard edge; carried on, it eroded the new soft edge into a ring — 2026-10-12).
          const r = Math.max(2, Math.round(Math.max(W, H) / 512));
          wideOnly(erased, W, H, r);
          wideOnly(added, W, H, r);
          const out = Buffer.from(now.data);
          for (let i = 0; i < W * H; i++) out[i * 4 + 3] = Math.max(0, Math.min(255, now.data[i * 4 + 3] + added[i] - erased[i]));
          moved = { data: out, w: W, h: H };
        }
        // History = the plain cut of the file: "Hoàn tác" drops the edit.
        const r = await applyMask(db, userId, p, set, g, await png(moved), true);
        paths.push(...r.paths);
      } catch (e) {
        console.warn("[ct] char reapply edit", e instanceof Error ? e.message : String(e));
      }
    }
  return paths;
}
