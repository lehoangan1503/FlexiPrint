/**
 * The cut of a bộ nhân vật, reviewed on the master before any file is made (asked 2026-10-09: fixing 100 files one
 * by one does not work — fix the master's backdrop once, then each layer's region once).
 *
 *   POST char/projects/:id/matte                    → { project } the master at print size without its backdrop
 *                                                     (layer-kit /matte, background job; redo = start again)
 *   POST char/projects/:id/matte/fix {points}       → { project } "Sửa nền": backdrop left over at the points marked
 *                                                     on the page is removed (layer-kit /matte/fix); un-approves
 *   POST char/projects/:id/matte/revert             → { project } back to the previous alpha
 *   POST char/projects/:id/matte/approve {approved} → { project }
 *   POST char/projects/:id/plan {auto?}             → { project } every layer's region on its picture (layer-kit
 *                                                     /plan: edits registered + upscaled, regions found) — needs the
 *                                                     matte approved and every planned edit made; hand-fixed regions
 *                                                     of unchanged pictures are kept (piece.sig). auto: then approves
 *                                                     the plan and cuts the files (no products made yet)
 *   POST char/projects/:id/plan/region {key, mask}  → { project } one region fixed by hand; un-approves
 *   POST char/projects/:id/plan/revert {key}        → { project }
 *   POST char/projects/:id/plan/approve {approved}  → { project }
 *
 * The layer files are then cut from both (server/char/layers.ts, layer-kit /cut): region × the picture's subject
 * alpha, so a region never brings back backdrop, and a hand fix of the backdrop holds in every file.
 */

import { NextResponse } from "next/server";
import sharp from "sharp";
import { CT_TABLES } from "../../config";
import type { CtCharCutState, CtCharImage, CtCharLayerCheck, CtCharMask, CtCharMatte, CtCharPiece, CtCharPicture, CtCharPieceKind, CtCharPlan, CtCharProject } from "../../types";
import type { CtSession } from "../supabase";
import { ctRemove } from "../storage";
import { saveCharRaw } from "./files";
import { kitFile, kitForget, kitJob, kitPost } from "./kit";
import { kitPlanInput, latestEdits, startBuild } from "./layers";
import { cutPaths, jobDb, jsonError, loadImages, loadProject, maskPaths, projectRow, type Db } from "./projects";

const HISTORY = 5;

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    for (let t = queue.shift(); t !== undefined; t = queue.shift()) await fn(t);
  }));
}
const PREVIEW_SIDE = 1024;

export function cutState(p: CtCharProject): CtCharCutState {
  return { matte: p.cut?.matte ?? null, plan: p.cut?.plan ?? null };
}

async function saveCut(db: Db, id: string, cut: CtCharCutState): Promise<CtCharProject> {
  const { data, error } = await db.from(CT_TABLES.charProjects).update({ cut }).eq("id", id).select("*").single<CtCharProject>();
  if (error || !data) throw new Error(error?.message ?? "Không lưu được");
  return projectRow(data);
}

/** Re-read the project right before a write: jobs run for minutes while the editor keeps working. */
async function fresh(db: Db, id: string): Promise<CtCharProject> {
  const p = await loadProject(db, id);
  if (!p) throw new Error("Bộ nhân vật đã bị xoá");
  return p;
}

/** A picture at print size + its WebP preview (the page shows the preview; the editor loads the original). */
async function savePicture(userId: string, projectId: string, data: Buffer): Promise<{ url: string; path: string; previewUrl: string; previewPath: string }> {
  const preview = await sharp(data, { limitInputPixels: 20000 * 20000 }).resize({ width: PREVIEW_SIDE, height: PREVIEW_SIDE, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  const [full, small] = await Promise.all([saveCharRaw(userId, projectId, "cut", data, "image/png"), saveCharRaw(userId, projectId, "cut", preview, "image/webp")]);
  return { url: full.url, path: full.path, previewUrl: small.url, previewPath: small.path };
}

const dataUrlPng = (v: unknown): Buffer | null => (typeof v === "string" && v.startsWith("data:image/png;base64,") ? Buffer.from(v.slice(22), "base64") : null);

/** A new version of a mask: the old one goes to the history (≤ 5); returns the paths to delete. */
async function pushVersion(userId: string, projectId: string, m: CtCharMask, data: Buffer): Promise<{ mask: CtCharMask; drop: string[] }> {
  const saved = await saveCharRaw(userId, projectId, "cut", data, "image/png");
  const history = [...m.history, { url: m.url, path: m.path, at: new Date().toISOString() }];
  const drop = history.length > HISTORY ? history.splice(0, history.length - HISTORY).map((h) => h.path) : [];
  return { mask: { url: saved.url, path: saved.path, edited: true, history }, drop };
}

function popVersion(m: CtCharMask): { mask: CtCharMask; drop: string[] } {
  const history = [...m.history];
  const prev = history.pop();
  if (!prev) throw new Error("Không còn bản trước");
  return { mask: { url: prev.url, path: prev.path, edited: history.length > 0, history }, drop: [m.path] };
}

// ---- 1. matte --------------------------------------------------------------------------------------------

interface KitMatte {
  width: number;
  height: number;
  factor: number;
  files: { colour: string; alpha: string };
}

export async function startMatte(db: Db, userId: string, p: CtCharProject): Promise<CtCharProject> {
  if (!p.master_id) throw new Error("Duyệt master trước");
  if (p.cut?.matte?.status === "running") throw new Error("Đang tách nền");
  const { data: master } = await db.from(CT_TABLES.charImages).select("*").eq("id", p.master_id).single<CtCharImage>();
  if (!master?.url) throw new Error("Không thấy master đã duyệt");
  const old = p.cut?.matte ?? null;
  const running: CtCharMatte = { status: "running", error: "", width: old?.width ?? 0, height: old?.height ?? 0, colourUrl: old?.colourUrl ?? "", colourPath: old?.colourPath ?? "", previewUrl: old?.previewUrl ?? "", previewPath: old?.previewPath ?? "", alpha: old?.alpha ?? null, approved: false, at: new Date().toISOString() };
  const project = await saveCut(db, p.id, { ...cutState(p), matte: running });
  void runMatte(db, userId, p.id, master.url, old);
  return project;
}

async function runMatte(db: Db, userId: string, projectId: string, masterUrl: string, old: CtCharMatte | null): Promise<void> {
  let job = "";
  try {
    const r = await kitJob<KitMatte>("/matte", { master: masterUrl });
    job = r.job;
    const [colour, alpha] = await Promise.all([kitFile(job, r.result.files.colour), kitFile(job, r.result.files.alpha)]);
    const [c, a] = await Promise.all([savePicture(userId, projectId, colour), saveCharRaw(userId, projectId, "cut", alpha, "image/png")]);
    const matte: CtCharMatte = { status: "done", error: "", width: r.result.width, height: r.result.height, colourUrl: c.url, colourPath: c.path, previewUrl: c.previewUrl, previewPath: c.previewPath, alpha: { url: a.url, path: a.path, edited: false, history: [] }, approved: false, at: new Date().toISOString() };
    const p = await fresh(db, projectId);
    await saveCut(db, projectId, { ...cutState(p), matte });
    if (old) await ctRemove([old.colourPath, old.previewPath, ...maskPaths(old.alpha)].filter(Boolean));
  } catch (e) {
    const p = await fresh(db, projectId).catch(() => null);
    if (p?.cut?.matte) await saveCut(db, projectId, { ...cutState(p), matte: { ...p.cut.matte, status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 1000) } }).catch(() => undefined);
  } finally {
    if (job) await kitForget(job);
  }
}

function doneMatte(p: CtCharProject): CtCharMatte & { alpha: CtCharMask } {
  const m = p.cut?.matte;
  if (!m || m.status !== "done" || !m.alpha) throw new Error("Chưa tách nền xong");
  return m as CtCharMatte & { alpha: CtCharMask };
}

interface MattePoint {
  x: number;
  y: number;
}

/** The points marked on the page (matte pixels), checked. */
function pointsOf(body: unknown, m: CtCharMatte): MattePoint[] {
  const raw = (body as { points?: unknown } | null)?.points;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("Chưa chấm điểm nào");
  if (raw.length > 300) throw new Error("Tối đa 300 điểm mỗi lần");
  return raw.map((v) => {
    const pt = v as Partial<MattePoint> | null;
    const x = Number(pt?.x);
    const y = Number(pt?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= m.width || y >= m.height) throw new Error("Điểm nằm ngoài ảnh");
    return { x, y };
  });
}

export async function fixMatte(db: Db, userId: string, p: CtCharProject, body: unknown): Promise<CtCharProject> {
  const m = doneMatte(p);
  const points = pointsOf(body, m);
  const r = await kitPost<{ alpha: string; removed: number[] }>("/matte/fix", { colour: m.colourUrl, alpha: m.alpha.url, points }, 180_000);
  if (!r.removed.some((n) => n > 0)) throw new Error("Quanh các điểm đã chấm không còn chỗ nền nào để xoá — chấm đúng vào mảng trắng / mảnh còn sót");
  const { mask, drop } = await pushVersion(userId, p.id, m.alpha, Buffer.from(r.alpha, "base64"));
  const project = await saveCut(db, p.id, { ...cutState(p), matte: { ...m, alpha: mask, approved: false } });
  await ctRemove(drop);
  return project;
}

export async function revertMatte(db: Db, p: CtCharProject): Promise<CtCharProject> {
  const m = doneMatte(p);
  const { mask, drop } = popVersion(m.alpha);
  const project = await saveCut(db, p.id, { ...cutState(p), matte: { ...m, alpha: mask, approved: false } });
  await ctRemove(drop);
  return project;
}

// ---- 2. plan ---------------------------------------------------------------------------------------------

interface KitPlan {
  width: number;
  height: number;
  pictures: Array<{ id: string; label: string; parent: string | null; colour?: string; alpha?: string; own?: string; keep?: string }>;
  pieces: Array<{ key: string; slot: string; kind: CtCharPieceKind; label: string; option: string; index: number; picture: string; region: string }>;
  checks: CtCharLayerCheck[];
  align: Record<string, { dx: number; dy: number; unchanged: number; before: number; residual: number; max: number }>;
}

interface PlanInputSlot {
  key: string;
  mode: string;
  mask: string | null;
  options: Array<{ url: string | null }>;
}

/**
 * What each region is found from: the picture(s) it is looked for on + the matte. The same again after a re-plan
 * means the region would come out the same — so a hand-fixed one is kept (an editor's fix is not thrown away because
 * ONE other option was redone).
 */
function pieceSigs(input: { base: string | null; slots: unknown[]; zones: unknown[] }, masterUrl: string, alphaUrl: string): (key: string) => string {
  const slots = input.slots as PlanInputSlot[];
  const zones = input.zones as Array<{ id: string; mask: string | null }>;
  const base = input.base ?? masterUrl;
  return (key: string) => {
    if (key === "body") return [base, alphaUrl].join("|");
    if (key.startsWith("zone:")) return [zones.find((z) => z.id === key.slice(5))?.mask ?? "", base, alphaUrl].join("|");
    const hash = key.lastIndexOf("#");
    const slot = slots.find((x) => x.key === (hash < 0 ? key : key.slice(0, hash)));
    if (!slot) return "";
    if (hash < 0) return [slot.mask ?? "", ...slot.options.map((o) => o.url ?? ""), base, alphaUrl].join("|");
    const i = Number(key.slice(hash + 1));
    return [i === 0 ? masterUrl : (slot.options[i]?.url ?? ""), slot.mask ?? "", base, alphaUrl].join("|");
  };
}

/** `auto` ("Tạo bộ custom"): when the plan is done, approve it, cut the files and make the set's product from them
 * (it replaces the one made before — the page warns). */
export async function startPlan(db: Db, userId: string, p: CtCharProject, auto = false): Promise<CtCharProject> {
  const m = doneMatte(p);
  if (!m.approved) throw new Error("Duyệt phần tách nền trước");
  if (p.cut?.plan?.status === "running") throw new Error("Đang phác thảo");
  if (p.layers?.status === "building") throw new Error("Đang cắt layer — chờ xong");
  const images = await loadImages(db, p.id);
  const input = kitPlanInput(p, latestEdits(images));
  if ("missing" in input) throw new Error(`Chưa đủ ảnh tô vùng (3b): ${input.missing.join(", ")}`);
  const { data: master } = await db.from(CT_TABLES.charImages).select("url").eq("id", p.master_id!).single<{ url: string }>();
  if (!master) throw new Error("Không thấy master đã duyệt");
  const old = p.cut?.plan ?? null;
  const running: CtCharPlan = { status: "running", error: "", width: old?.width ?? 0, height: old?.height ?? 0, pictures: old?.pictures ?? [], pieces: old?.pieces ?? [], checks: [], approved: false, at: new Date().toISOString() };
  const project = await saveCut(db, p.id, { ...cutState(p), plan: running });
  const sigOf = pieceSigs(input.plan, master.url, m.alpha.url);
  void runPlan(db, userId, p.id, { source: master.url, colour: m.colourUrl, alpha: m.alpha.url, ...input.plan }, old, sigOf, auto);
  return project;
}

async function runPlan(db: Db, userId: string, projectId: string, body: Record<string, unknown>, old: CtCharPlan | null, sigOf: (key: string) => string, thenCut: boolean): Promise<void> {
  let job = "";
  const saved: string[] = [];
  const carried = new Set<string>();
  try {
    const r = await kitJob<KitPlan>("/plan", body);
    job = r.job;
    const store = async (name: string | undefined): Promise<{ url: string; path: string } | null> => {
      if (!name) return null;
      const s = await saveCharRaw(userId, projectId, "cut", await kitFile(job, name), "image/png");
      saved.push(s.path);
      return s;
    };
    const p0 = await fresh(db, projectId);
    const matte = doneMatte(p0);
    // Every picture / region to our storage, a few at a time (≈ 40 files of a few MB).
    const pictures: Array<CtCharPicture | null> = r.result.pictures.map(() => null);
    await pool(r.result.pictures.map((_, i) => i), 4, async (i) => {
      const pic = r.result.pictures[i];
      if (pic.id === "master") {
        pictures[i] = { id: "master", label: pic.label, colourUrl: matte.colourUrl, colourPath: "", previewUrl: matte.previewUrl, previewPath: "", alphaUrl: null, alphaPath: null, ownUrl: null, ownPath: null, keepUrl: null, keepPath: null, parent: null };
        return;
      }
      if (!pic.colour) return;
      const colour = await savePicture(userId, projectId, await kitFile(job, pic.colour));
      saved.push(colour.path, colour.previewPath);
      const [alpha, own, keep] = await Promise.all([store(pic.alpha), store(pic.own), store(pic.keep)]);
      pictures[i] = { id: pic.id, label: pic.label, colourUrl: colour.url, colourPath: colour.path, previewUrl: colour.previewUrl, previewPath: colour.previewPath, alphaUrl: alpha?.url ?? null, alphaPath: alpha?.path ?? null, ownUrl: own?.url ?? null, ownPath: own?.path ?? null, keepUrl: keep?.url ?? null, keepPath: keep?.path ?? null, parent: pic.parent };
    });
    const pieces: Array<CtCharPiece | null> = r.result.pieces.map(() => null);
    await pool(r.result.pieces.map((_, i) => i), 6, async (i) => {
      const pc = r.result.pieces[i];
      const sig = sigOf(pc.key);
      const prev = old?.pieces.find((x) => x.key === pc.key);
      const head = { key: pc.key, slot: pc.slot, kind: pc.kind, label: pc.label, option: pc.option, index: pc.index, picture: pc.picture, sig };
      // A hand-fixed region of a picture that did not change stays as the editor left it.
      if (prev?.region.edited && sig && prev.sig === sig) {
        carried.add(pc.key);
        pieces[i] = { ...head, region: prev.region };
        return;
      }
      const region = await store(pc.region);
      if (region) pieces[i] = { ...head, region: { url: region.url, path: region.path, edited: false, history: [] } };
    });
    // The plan measures every edit on the model's own canvas: keep that number on the edit.
    const { data: edits } = await db.from(CT_TABLES.charImages).select("id, url, meta").eq("project_id", projectId).eq("kind", "edit").returns<Array<Pick<CtCharImage, "id" | "url" | "meta">>>();
    for (const e of edits ?? []) {
      const a = r.result.align[e.url];
      if (a) await db.from(CT_TABLES.charImages).update({ meta: { ...e.meta, align: { dx: a.dx, dy: a.dy, unchanged: a.unchanged, before: a.before, residual: a.residual, max: a.max } } }).eq("id", e.id);
    }
    const plan: CtCharPlan = { status: "done", error: "", width: r.result.width, height: r.result.height, pictures: pictures.filter((x): x is CtCharPicture => !!x), pieces: pieces.filter((x): x is CtCharPiece => !!x), checks: r.result.checks, approved: false, at: new Date().toISOString() };
    const p = await fresh(db, projectId);
    // One button: the plan is stored approved and the cut starts in the SAME write, so the page (which polls only
    // while something runs) never sees a finished plan with nothing running. A cut that cannot start leaves the
    // plan done and unapproved, with the reason — the editor cuts from the page.
    let next: CtCharProject | null = null;
    let note = "";
    if (thenCut) {
      try {
        const cut = { ...cutState(p), plan: { ...plan, approved: true } };
        next = await startBuild(db, userId, { ...p, cut }, cut, true);
      } catch (e) {
        note = `Chưa tự cắt được: ${(e instanceof Error ? e.message : String(e)).slice(0, 500)}`;
      }
    }
    if (!next) await saveCut(db, projectId, { ...cutState(p), plan: { ...plan, error: note } });
    // The plan is stored: from here nothing may fail it (the old files going is housekeeping only).
    if (old) await ctRemove(cutPaths({ matte: null, plan: { ...old, pieces: old.pieces.filter((x) => !carried.has(x.key)) } })).catch((e: Error) => console.warn("[ct] char plan cleanup", e.message));
  } catch (e) {
    await ctRemove(saved);
    const p = await fresh(db, projectId).catch(() => null);
    if (p?.cut?.plan) await saveCut(db, projectId, { ...cutState(p), plan: { ...p.cut.plan, status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 1000) } }).catch(() => undefined);
  } finally {
    if (job) await kitForget(job);
  }
}

function donePlan(p: CtCharProject): CtCharPlan {
  const plan = p.cut?.plan;
  if (!plan || plan.status !== "done") throw new Error("Chưa phác thảo xong");
  return plan;
}

function pieceOf(plan: CtCharPlan, body: unknown): CtCharPiece {
  const key = (body as { key?: unknown } | null)?.key;
  const pc = typeof key === "string" ? plan.pieces.find((x) => x.key === key) : undefined;
  if (!pc) throw new Error("Không thấy vùng này");
  return pc;
}

async function setPiece(db: Db, p: CtCharProject, plan: CtCharPlan, key: string, region: CtCharMask): Promise<CtCharProject> {
  return saveCut(db, p.id, { ...cutState(p), plan: { ...plan, approved: false, pieces: plan.pieces.map((x) => (x.key === key ? { ...x, region } : x)) } });
}

export async function savePieceMask(db: Db, userId: string, p: CtCharProject, body: unknown): Promise<CtCharProject> {
  const plan = donePlan(p);
  const pc = pieceOf(plan, body);
  const data = dataUrlPng((body as { mask?: unknown } | null)?.mask);
  if (!data) throw new Error("Thiếu mặt nạ (PNG)");
  const { mask, drop } = await pushVersion(userId, p.id, pc.region, data);
  const project = await setPiece(db, p, plan, pc.key, mask);
  await ctRemove(drop);
  return project;
}

export async function revertPiece(db: Db, p: CtCharProject, body: unknown): Promise<CtCharProject> {
  const plan = donePlan(p);
  const pc = pieceOf(plan, body);
  const { mask, drop } = popVersion(pc.region);
  const project = await setPiece(db, p, plan, pc.key, mask);
  await ctRemove(drop);
  return project;
}

// ---- routes ----------------------------------------------------------------------------------------------

async function own(s: CtSession, id: string): Promise<CtCharProject | NextResponse> {
  const p = await loadProject(s.supabase, id);
  if (!p) return jsonError("Không tìm thấy bộ nhân vật", 404);
  if (p.user_id !== s.user.id) return jsonError("Bộ nhân vật của người khác — chỉ xem", 403);
  return p;
}

const approvedOf = (body: unknown) => (body as { approved?: unknown } | null)?.approved !== false;

/** POST char/projects/:id/matte[/fix|/revert|/approve] and …/plan[/region|/revert|/approve] */
export async function cutRoute(s: CtSession, id: string, step: "matte" | "plan", action: string | undefined, body: unknown): Promise<NextResponse> {
  const p = await own(s, id);
  if (p instanceof NextResponse) return p;
  const db = jobDb(s);
  try {
    let project: CtCharProject;
    if (step === "matte") {
      if (!action) project = await startMatte(db, s.user.id, p);
      else if (action === "fix") project = await fixMatte(db, s.user.id, p, body);
      else if (action === "revert") project = await revertMatte(db, p);
      else if (action === "approve") project = await saveCut(db, id, { ...cutState(p), matte: { ...doneMatte(p), approved: approvedOf(body) } });
      else return jsonError("Not found", 404);
    } else {
      if (!action) project = await startPlan(db, s.user.id, p, (body as { auto?: unknown } | null)?.auto === true);
      else if (action === "region") project = await savePieceMask(db, s.user.id, p, body);
      else if (action === "revert") project = await revertPiece(db, p, body);
      else if (action === "approve") project = await saveCut(db, id, { ...cutState(p), plan: { ...donePlan(p), approved: approvedOf(body) } });
      else return jsonError("Not found", 404);
    }
    return NextResponse.json({ project });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không làm được", 400);
  }
}
