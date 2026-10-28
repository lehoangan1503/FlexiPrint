/**
 * The AI styles of a bộ ảnh khách (asked 2026-10-28): the editor writes "4 kiểu: khăn choàng, bộ đồ siêu nhân áo
 * choàng đỏ, dây đèn quấn quanh…" in the brief, @flexiprint writes one style per idea — a prompt + style reference
 * pictures (image 2, 3… after the customer's photo, e.g. the approved master) — tests each on the editor's test
 * photos, and every style the zone offers becomes one style option on the storefront (the published template carries
 * names + demo pictures; the prompt stays on the server and is read at every customer upload, so a prompt fixed
 * later works at once — a rebuilt / republished product picks up new names, demos and styles).
 *
 * A style is a ct_ai_styles row (params.setId = the set) so the public photo endpoint runs it like a library style.
 * Its tests are ct_char_images rows kind "edit", role "style:<style id>:<n>" (meta.sourceUrl = the test photo),
 * made exactly like a customer's upload (server/ai/photo.ts processPhoto: the style, cut out).
 *
 *   GET    char/projects/:id/photo-styles                       → { styles }
 *   POST   char/projects/:id/photo-styles  {id?, name, prompt, refUrls?, zoneId?}  → { styles, project } create / update
 *   DELETE char/projects/:id/photo-styles/:styleId              → { styles, project }
 *   POST   char/projects/:id/photo-styles/test {styleIds?, photos?}  → { images } (running rows)
 *   POST   char/projects/:id/photo-styles/demo {styleId, imageId}    → { styles } a test picture = the style's demo
 *   POST   char/projects/:id/photo-styles/photos {zoneId?, photos}   → { project } the zone's test photos
 *   POST   char/projects/:id/photo-styles/order {zoneId?, styleIds}  → { project } the zone's styles, in this order
 */

import { NextResponse } from "next/server";
import sharp from "sharp";
import { CT_TABLES } from "../../config";
import type { CtAiStyle, CtAiStyleParams, CtCharImage, CtCharPhotoStyle, CtCharPhotoZone, CtCharProject } from "../../types";
import { CT_AI_STYLE_MODEL, normalizeAiStyleParams } from "../../lib/ai-style-models";
import { aiStyleId, aiStyleRef, isAiStyleRef } from "../../lib/photo-styles";
import { AI_STYLE_SAMPLE_URL } from "../ai-styles";
import { processPhoto } from "../ai/photo";
import type { CtSession } from "../supabase";
import { fetchImage, saveCharFile } from "./files";
import { NOT_YOURS, canEditProject, jobDb, jsonError, loadProject, type Db } from "./projects";

export const STYLE_TEST_ROLE = "style:";

const COLUMNS = "id,user_id,name,prompt,model,params,sort_order,created_at,updated_at";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** gpt-image calls at once for one test run (each ~1 min). */
const PARALLEL = 3;

type StyleRow = Omit<CtAiStyle, "owner" | "can_edit">;


function zoneOf(p: CtCharProject, zoneId?: string): CtCharPhotoZone {
  const zones = p.brief.photoZones;
  const z = zoneId ? zones.find((x) => x.id === zoneId) : zones[0];
  if (!z) throw new Error(zoneId ? `Không có vùng ảnh khách ${zoneId}` : "Brief chưa có vùng ảnh khách (brief.photoZones)");
  return z;
}

async function saveZone(db: Db, p: CtCharProject, zone: CtCharPhotoZone): Promise<CtCharProject> {
  const brief = { ...p.brief, photoZones: p.brief.photoZones.map((z) => (z.id === zone.id ? zone : z)) };
  const { error } = await db.from(CT_TABLES.charProjects).update({ brief }).eq("id", p.id);
  if (error) throw new Error(error.message);
  return { ...p, brief };
}

/** The set's styles: those its zones offer (in that order), then the ones made for it and taken off. */
export async function setPhotoStyles(db: Db, p: CtCharProject): Promise<CtCharPhotoStyle[]> {
  const offered = [...new Set(p.brief.photoZones.flatMap((z) => z.styles ?? []).filter(isAiStyleRef))];
  const ids = offered.map(aiStyleId);
  const [{ data: byRef }, { data: own }] = await Promise.all([
    ids.length ? db.from(CT_TABLES.aiStyles).select(COLUMNS).in("id", ids).returns<StyleRow[]>() : Promise.resolve({ data: [] as StyleRow[] }),
    db.from(CT_TABLES.aiStyles).select(COLUMNS).eq("params->>setId", p.id).order("created_at").returns<StyleRow[]>(),
  ]);
  const rows = new Map<string, StyleRow>();
  for (const r of [...(byRef ?? []), ...(own ?? [])]) rows.set(r.id, r);
  const view = (r: StyleRow): CtCharPhotoStyle => {
    const params = normalizeAiStyleParams(r.params);
    return { id: r.id, ref: aiStyleRef(r.id), name: r.name, prompt: r.prompt, refUrls: params.refUrls, demoUrl: params.demoUrl, offered: ids.includes(r.id), own: params.setId === p.id, updated_at: r.updated_at };
  };
  const first = ids.map((id) => rows.get(id)).filter((r): r is StyleRow => !!r);
  const rest = [...rows.values()].filter((r) => !ids.includes(r.id));
  return [...first, ...rest].map(view);
}

export interface SaveStyleArgs {
  id?: string;
  name: string;
  prompt: string;
  /** Style reference pictures (image 2, 3…); absent = unchanged (a new style: none). */
  refUrls?: string[];
  zoneId?: string;
}

const httpUrl = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//.test(u);

/** Create a style for the set (offered by the zone, last) or change one of the set's own. */
export async function savePhotoStyle(db: Db, userId: string, p: CtCharProject, a: SaveStyleArgs): Promise<{ style: CtCharPhotoStyle; project: CtCharProject }> {
  if (p.brief.kind !== "photo") throw new Error("Style ảnh khách chỉ có ở bộ ảnh khách (brief.kind \"photo\")");
  const name = a.name.trim().slice(0, 80);
  const prompt = a.prompt.trim();
  if (!name) throw new Error("Style cần tên (khách thấy tên này)");
  if (!prompt || prompt.length > 4000) throw new Error("Prompt 1–4000 ký tự");
  const refUrls = a.refUrls?.filter(httpUrl).slice(0, 3);
  let row: StyleRow | null;
  if (a.id) {
    const { data: cur } = await db.from(CT_TABLES.aiStyles).select(COLUMNS).eq("id", a.id).maybeSingle<StyleRow>();
    if (!cur) throw new Error(`Không có style ${a.id}`);
    const params = normalizeAiStyleParams(cur.params);
    if (params.setId !== p.id) throw new Error(`"${cur.name}" là style của thư viện chung — sửa ở thư viện, hoặc tạo style riêng cho bộ`);
    const next: CtAiStyleParams = { ...params, ...(refUrls ? { refUrls } : {}) };
    const { data, error } = await db.from(CT_TABLES.aiStyles).update({ name, prompt, params: next }).eq("id", a.id).select(COLUMNS).single<StyleRow>();
    if (error) throw new Error(error.message);
    row = data;
  } else {
    const params: CtAiStyleParams = { ...normalizeAiStyleParams({}), refUrls: refUrls ?? [], setId: p.id };
    const { data, error } = await db
      .from(CT_TABLES.aiStyles)
      .insert({ user_id: userId, name, prompt, model: CT_AI_STYLE_MODEL, params, sort_order: 1000 })
      .select(COLUMNS)
      .single<StyleRow>();
    if (error) throw new Error(/permission denied/i.test(error.message) ? `${error.message} — chạy migration 029_set_photo_styles.sql` : error.message);
    row = data;
  }
  if (!row) throw new Error("Không lưu được style");
  let project = p;
  const zone = zoneOf(p, a.zoneId);
  const ref = aiStyleRef(row.id);
  if (!(zone.styles ?? []).includes(ref)) project = await saveZone(db, p, { ...zone, treat: "ai", styles: [...(zone.styles ?? []), ref] });
  const style = (await setPhotoStyles(db, project)).find((x) => x.id === row!.id)!;
  return { style, project };
}

/** Take a style off the set (deleted when it was made for the set). */
export async function removePhotoStyle(db: Db, p: CtCharProject, id: string): Promise<CtCharProject> {
  const ref = aiStyleRef(id);
  const brief = { ...p.brief, photoZones: p.brief.photoZones.map((z) => ({ ...z, styles: (z.styles ?? []).filter((x) => x !== ref) })) };
  const { error } = await db.from(CT_TABLES.charProjects).update({ brief }).eq("id", p.id);
  if (error) throw new Error(error.message);
  const { data: row } = await db.from(CT_TABLES.aiStyles).select("params").eq("id", id).maybeSingle<{ params: Partial<CtAiStyleParams> }>();
  if (row && normalizeAiStyleParams(row.params).setId === p.id) await db.from(CT_TABLES.aiStyles).delete().eq("id", id);
  return { ...p, brief };
}

/** The zone's styles in this order (ids or refs); styles not named stay after them. */
export async function orderPhotoStyles(db: Db, p: CtCharProject, ids: string[], zoneId?: string): Promise<CtCharProject> {
  const zone = zoneOf(p, zoneId);
  const cur = zone.styles ?? [];
  const named = ids.map((x) => (isAiStyleRef(x) ? x : aiStyleRef(x))).filter((r) => cur.includes(r));
  return saveZone(db, p, { ...zone, styles: [...new Set([...named, ...cur])] });
}

/** The zone's test photos (≤ 6 http urls). */
export async function setTestPhotos(db: Db, p: CtCharProject, photos: string[], zoneId?: string): Promise<CtCharProject> {
  const zone = zoneOf(p, zoneId);
  return saveZone(db, p, { ...zone, testPhotos: [...new Set(photos.filter(httpUrl))].slice(0, 6) });
}

/** The pictures a style test runs on: asked, else the zone's test photos, else the stock sample pet. */
export function testPhotosOf(p: CtCharProject, asked?: string[]): string[] {
  const list = asked?.filter(httpUrl) ?? [];
  if (list.length) return list.slice(0, 6);
  const zone = p.brief.photoZones[0];
  return zone?.testPhotos?.length ? zone.testPhotos : [AI_STYLE_SAMPLE_URL];
}

/** Run each style on each test photo in the background (like a customer's upload): running rows now. */
export async function startStyleTests(db: Db, userId: string, p: CtCharProject, args: { styleIds?: string[]; photos?: string[]; taskId?: string }): Promise<CtCharImage[]> {
  const all = await setPhotoStyles(db, p);
  const want = args.styleIds?.length ? all.filter((x) => args.styleIds!.includes(x.id) || args.styleIds!.includes(x.ref)) : all.filter((x) => x.offered);
  if (!want.length) throw new Error(args.styleIds?.length ? `Không có style ${args.styleIds.join(", ")} trong bộ` : "Vùng ảnh khách chưa có style nào");
  const photos = testPhotosOf(p, args.photos);
  const { data: full } = await db.from(CT_TABLES.aiStyles).select(COLUMNS).in("id", want.map((x) => x.id)).returns<StyleRow[]>();
  const rows: Array<{ row: CtCharImage; style: CtAiStyle; photo: string }> = [];
  for (const st of want) {
    const style = full?.find((r) => r.id === st.id);
    if (!style) continue;
    for (const [i, photo] of photos.entries()) {
      const { data: row } = await db
        .from(CT_TABLES.charImages)
        .insert({ project_id: p.id, user_id: userId, kind: "edit", role: `${STYLE_TEST_ROLE}${st.id}:${i}`, status: "running", note: `Style ${st.name} — ảnh thử ${i + 1}`, prompt: style.prompt, meta: { sourceUrl: photo, styleId: st.id, ...(args.taskId ? { taskId: args.taskId } : {}) } })
        .select("*")
        .single<CtCharImage>();
      if (row) rows.push({ row, style: { ...style, model: CT_AI_STYLE_MODEL, params: normalizeAiStyleParams(style.params), owner: "", can_edit: false }, photo });
    }
  }
  // A few at a time: a 4 styles × 3 photos run is 12 gpt-image calls.
  const queue = [...rows];
  const work = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) await runStyleTest(db, userId, p.id, job.row, job.style, job.photo);
  };
  for (let k = 0; k < Math.min(PARALLEL, queue.length); k++) void work();
  return rows.map((r) => r.row);
}

async function runStyleTest(db: Db, userId: string, projectId: string, row: CtCharImage, style: CtAiStyle, photo: string): Promise<void> {
  try {
    // ~1600 px like a storefront upload.
    const raw = await fetchImage(photo);
    const data = await sharp(raw).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
    const out = await processPhoto({ image: { data, mime: "image/jpeg" }, style: aiStyleRef(style.id), cutout: true, aiStyle: style });
    let png: Buffer = await sharp(out.image.data).ensureAlpha().png().toBuffer();
    // The browser keys out a white backdrop for the customer; here the server does it.
    if (out.backdrop === "white") png = await keyWhite(png);
    const saved = await saveCharFile(userId, projectId, "edit", png);
    await db.from(CT_TABLES.charImages).update({ ...saved, model: CT_AI_STYLE_MODEL, status: "done", error: "" }).eq("id", row.id);
  } catch (e) {
    await db.from(CT_TABLES.charImages).update({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 1000) }).eq("id", row.id);
  }
}

/** Near-white pixels → transparent (a style drawn on flat white without a cut-out service). */
async function keyWhite(png: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) if (data[i] > 244 && data[i + 1] > 244 && data[i + 2] > 244) data[i + 3] = 0;
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

/** A test picture becomes the style's demo (what the editor and the customer pick the style by). */
export async function setStyleDemo(db: Db, p: CtCharProject, styleId: string, imageId: string): Promise<void> {
  const { data: im } = await db.from(CT_TABLES.charImages).select("*").eq("id", imageId).eq("project_id", p.id).maybeSingle<CtCharImage>();
  if (!im || im.status !== "done" || !im.role.startsWith(`${STYLE_TEST_ROLE}${styleId}:`)) throw new Error("Ảnh thử không thuộc style này (hoặc chưa xong)");
  const { data: row } = await db.from(CT_TABLES.aiStyles).select("params").eq("id", styleId).maybeSingle<{ params: Partial<CtAiStyleParams> }>();
  if (!row) throw new Error("Không có style");
  const params = normalizeAiStyleParams(row.params);
  if (params.setId !== p.id) throw new Error("Style của thư viện chung — đặt demo ở thư viện");
  const sourceUrl = (im.meta as { sourceUrl?: string }).sourceUrl ?? "";
  const { error } = await db.from(CT_TABLES.aiStyles).update({ params: { ...params, demoUrl: im.url, demoSourceUrl: httpUrl(sourceUrl) ? sourceUrl : "" } }).eq("id", styleId);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** char/projects/:id/photo-styles[/:sub] */
export async function photoStylesRoute(s: CtSession, method: string, id: string, sub: string, body: unknown): Promise<NextResponse> {
  const p = await loadProject(s.supabase, id);
  if (!p) return jsonError("Không tìm thấy bộ", 404);
  const db = jobDb(s);
  if (method === "GET") return NextResponse.json({ styles: await setPhotoStyles(db, p) });
  if (!(await canEditProject(s, p))) return jsonError(NOT_YOURS, 403);
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const zoneId = typeof b.zoneId === "string" ? b.zoneId : undefined;
  try {
    if (method === "DELETE" && UUID.test(sub)) {
      const project = await removePhotoStyle(db, p, sub);
      return NextResponse.json({ styles: await setPhotoStyles(db, project), project });
    }
    if (method !== "POST") return jsonError("Method not allowed", 405);
    if (!sub) {
      const { project } = await savePhotoStyle(db, s.user.id, p, {
        id: typeof b.id === "string" && UUID.test(b.id) ? b.id : undefined,
        name: typeof b.name === "string" ? b.name : "",
        prompt: typeof b.prompt === "string" ? b.prompt : "",
        refUrls: Array.isArray(b.refUrls) ? strs(b.refUrls) : undefined,
        zoneId,
      });
      return NextResponse.json({ styles: await setPhotoStyles(db, project), project });
    }
    if (sub === "test") {
      const images = await startStyleTests(db, s.user.id, p, { styleIds: strs(b.styleIds), photos: strs(b.photos) });
      return NextResponse.json({ images }, { status: 202 });
    }
    if (sub === "demo") {
      await setStyleDemo(db, p, String(b.styleId ?? ""), String(b.imageId ?? ""));
      return NextResponse.json({ styles: await setPhotoStyles(db, p) });
    }
    if (sub === "photos") return NextResponse.json({ project: await setTestPhotos(db, p, strs(b.photos), zoneId) });
    if (sub === "order") return NextResponse.json({ project: await orderPhotoStyles(db, p, strs(b.styleIds), zoneId) });
    return jsonError("Không có thao tác này", 404);
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Lỗi style", 400);
  }
}

/** The newest test picture of each (style, photo) — for get_task and the page. */
export function latestStyleTests(images: CtCharImage[]): CtCharImage[] {
  const out = new Map<string, CtCharImage>();
  for (const im of images) if (im.role.startsWith(STYLE_TEST_ROLE) && (!out.has(im.role) || out.get(im.role)!.created_at <= im.created_at)) out.set(im.role, im);
  return [...out.values()];
}

