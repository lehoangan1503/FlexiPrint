/**
 * Layers of a bộ nhân vật, from the approved master (layer-rules: one canvas, in-place edits, nothing re-drawn).
 *
 *   POST char/projects/:id/edits  {roles?} → { images } the planned edits (the agent's brief.pictures, lib/char-pictures.ts;
 *                                 else lib/char-plan.ts) still missing — or
 *                                 the given roles again — made in the background, in waves (work → base → every
 *                                 option on the doll); each edit's registration is measured (layer-kit /align)
 *   POST char/projects/:id/layers → { project } layers.status "building", then "done" / "failed": layer-kit /cut
 *                                 cuts the set from the plan's pictures + regions (server/char/cut.ts); every file
 *                                 is stored (PNG original + WebP preview) as kind "layer"
 *   POST char/projects/:id/layers/approve {approved} → { project } the editor checked the files (final)
 *
 * Redoing a picture redoes every edit made from it (they share its pixels).
 *
 * Env: CT_LAYER_KIT_URL (services/layer-kit, default http://127.0.0.1:7005), CT_LAYER_KIT_TOKEN.
 */

import { NextResponse } from "next/server";
import sharp from "sharp";
import { CT_TABLES } from "../../config";
import type { CtAsset, CtCharAlign, CtCharFileFx, CtCharCutState, CtCharImage, CtCharLayerCheck, CtCharLayerFile, CtCharLayerSet, CtCharLayerSlot, CtCharProject, CtCharSlot } from "../../types";
import { DOLL_COLOUR, isFace, isThumbRole, optionPictures, planEdits, slotLabel, type CtCharEditPlan } from "../../lib/char-plan";
import { latestEditsOf } from "../../lib/char-images";
import { checkPictures } from "../../lib/char-pictures";
import type { CtSession } from "../supabase";
import { ctLibraryPath, ctRemove, ctStoragePath, ctUpload } from "../storage";
import { findProductFolder } from "../artworks";
import { fetchImage, saveCharFile, saveCharRaw } from "./files";
import { kitForget, kitJob, kitPost } from "./kit";
import { charClipart, remakeSetProduct } from "./product";
import { jobDb, jsonError, loadImages, loadProject, projectRow, runCharDraw, canEditProject, NOT_YOURS } from "./projects";
import { editLayerFile, reapplyEdits, revertLayerFile } from "./file-edit";
import { remakeDrawnProduct } from "./versions";

type Db = ReturnType<typeof jobDb>;

// Every option is drawn from the doll in one wave: as many at once as the image API takes comfortably.
const EDIT_CONCURRENCY = 6;


async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    for (let t = queue.shift(); t !== undefined; t = queue.shift()) await fn(t);
  }));
}

export const latestEdits = latestEditsOf;

// ---- working master ---------------------------------------------------------------------------------------
// The approved master as it is: every edit is made from it at the image model's own size. The print size comes
// later — layer-kit upscales the registered pictures (Real-ESRGAN, free, on its own CPU) before it cuts the set.

async function measure(refUrl: string, url: string): Promise<CtCharAlign | null> {
  try {
    const j = await kitPost<CtCharAlign>("/align", { ref: refUrl, url });
    return { dx: j.dx, dy: j.dy, unchanged: j.unchanged, before: j.before, residual: j.residual, max: j.max };
  } catch {
    return null;
  }
}

// ---- edits -----------------------------------------------------------------------------------------------

/** The roles to (re)make: missing / failed ones, or the asked ones with everything already made from them. */
function rolesToRun(plan: CtCharEditPlan[], latest: Map<string, CtCharImage>, asked: string[] | null): string[] {
  if (!asked) return plan.filter((e) => latest.get(e.role)?.status !== "done" && latest.get(e.role)?.status !== "running").map((e) => e.role);
  const set = new Set(asked.filter((r) => plan.some((e) => e.role === r)));
  // What was already made from a redone picture is stale: redone too. What does not exist yet is left for its own
  // prompt (the agent runs the pictures others are made from first, then writes the rest).
  const made = (e: CtCharEditPlan) => latest.has(e.role);
  if (set.has("work")) plan.filter(made).forEach((e) => set.add(e.role));
  // Everything made from a redone picture, down the chain (base → an option).
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of plan)
      if (!set.has(e.role) && made(e) && set.has(e.source)) {
        set.add(e.role);
        grew = true;
      }
  }
  return plan.filter((e) => set.has(e.role)).map((e) => e.role);
}

export interface EditRunArgs {
  /** Roles to (re)make; null = the planned ones still missing. */
  roles: string[] | null;
  /** The agent's own prompt per role (else: the agent's last prompt for that role, else the planned one). */
  prompts?: Record<string, string>;
  taskId?: string | null;
}

/** Start the in-place edits (rows "running" now, made in the background). Throws with a message for the editor. */
export async function runEditRoles(db: Db, userId: string, p: CtCharProject, a: EditRunArgs): Promise<CtCharImage[]> {
  if (!p.master_id) throw new Error("Duyệt master trước");
  if (p.layers?.status === "building") throw new Error("Đang cắt layer — chờ xong");
  const plan = planEdits(p.brief);
  const images = await loadImages(db, p.id);
  const latest = latestEdits(images);
  const roles = rolesToRun(plan, latest, a.roles);
  if (!roles.length) return [];
  // Everything is made from the working master: it comes first when it is missing.
  const work = latest.get("work");
  if (!roles.includes("work") && work?.status !== "done" && work?.status !== "running") roles.unshift("work");
  if (roles.some((r) => latest.get(r)?.status === "running")) throw new Error("Bản sửa này đang chạy");
  const rows = roles.map((role) => {
    const e = plan.find((x) => x.role === role);
    const last = latest.get(role);
    // The agent's last prompt is kept for a redo — unless the option it was written for changed since (its label is
    // the option's name: "Side Braid" renamed "Chin Bob" was drawn again as a braid, 2026-10-14).
    // A plan of the agent's own (brief.pictures) IS its prompt: a redo asks what the plan says now.
    const agentLast = !p.brief.pictures?.length && last?.meta.taskId && last.prompt && (!e || last.note === e.label) ? last.prompt : "";
    const prompt = a.prompts?.[role]?.trim() || agentLast || e?.prompt || "";
    const byAgent = !!a.prompts?.[role]?.trim() || !!agentLast;
    const taskId = a.prompts?.[role]?.trim() ? a.taskId : last?.meta.taskId;
    return { project_id: p.id, user_id: userId, kind: "edit", role, status: "running", prompt: prompt.slice(0, 8000), note: e?.label ?? "", meta: byAgent && taskId ? { taskId } : {} };
  });
  const { data, error } = await db.from(CT_TABLES.charImages).insert(rows).select("*").returns<CtCharImage[]>();
  if (error || !data) throw new Error(error?.message ?? "Không tạo được");
  void runEdits(db, userId, p, plan, data, latest);
  return data;
}

/** POST char/projects/:id/edits */
export async function startEdits(s: CtSession, id: string, body: unknown): Promise<NextResponse> {
  const p = await loadProject(s.supabase, id);
  if (!p) return jsonError("Không tìm thấy bộ nhân vật", 404);
  if (!(await canEditProject(s, p))) return jsonError(NOT_YOURS, 403);
  const asked = body && typeof body === "object" && Array.isArray((body as { roles?: unknown }).roles) ? ((body as { roles: unknown[] }).roles.filter((r) => typeof r === "string") as string[]) : null;
  try {
    const images = await runEditRoles(jobDb(s), s.user.id, p, { roles: asked });
    return NextResponse.json({ images }, { status: images.length ? 202 : 200 });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không chạy được", 409);
  }
}

async function failRow(db: Db, row: CtCharImage, msg: string): Promise<void> {
  await db.from(CT_TABLES.charImages).update({ status: "failed", error: msg.slice(0, 1000) }).eq("id", row.id);
}

async function runEdits(db: Db, userId: string, p: CtCharProject, plan: CtCharEditPlan[], rows: CtCharImage[], before: Map<string, CtCharImage>): Promise<void> {
  // What each edit can be drawn from: the done pictures not made again in this run, then what this run makes.
  const have = new Map<string, CtCharImage>([...before].filter(([role, im]) => im.status === "done" && !rows.some((r) => r.role === role)));
  const sourceOf = (row: CtCharImage) => plan.find((e) => e.role === row.role)?.source ?? "work";
  try {
    const workRow = rows.find((r) => r.role === "work");
    if (workRow) {
      const { data: master } = await db.from(CT_TABLES.charImages).select("*").eq("id", p.master_id!).single<CtCharImage>();
      if (!master) throw new Error("Không thấy master đã duyệt");
      const saved = await saveCharFile(userId, p.id, "edit", await fetchImage(master.url));
      const { data } = await db
        .from(CT_TABLES.charImages)
        .update({ ...saved, model: "master", status: "done", error: "", parent_id: master.id, meta: { ...workRow.meta, sourceId: master.id } })
        .eq("id", workRow.id)
        .select("*")
        .single<CtCharImage>();
      if (data) have.set("work", data);
    }
    if (!have.has("work")) throw new Error("Chưa có master làm việc");
    const draw = async (row: CtCharImage, src: CtCharImage) => {
      // The source is written before drawing: a measure that hangs must not leave a finished edit without it — the
      // plan step would call it "made from an old picture".
      const meta = { ...row.meta, sourceId: src.id };
      await db.from(CT_TABLES.charImages).update({ parent_id: src.id, meta }).eq("id", row.id);
      const transparent = plan.find((e) => e.role === row.role)?.transparent === true;
      const done = await runCharDraw(db, userId, { ...row, parent_id: src.id, meta }, { prompt: row.prompt, refs: [src.url], aspect: null, refSize: { w: src.width, h: src.height }, transparent });
      if (!done) return null;
      // A thumbnail is drawn alone and re-framed: nothing to measure.
      if (isThumbRole(row.role)) return done;
      const align = await measure(src.url, done.url);
      if (!align) return done;
      const { data } = await db.from(CT_TABLES.charImages).update({ meta: { ...meta, ...done.meta, align } }).eq("id", done.id).select("*").single<CtCharImage>();
      return data ?? done;
    };
    // In waves: every edit whose source picture is there (work → base → the options).
    let pending = rows.filter((r) => r.role !== "work");
    while (pending.length) {
      const ready = pending.filter((r) => have.has(sourceOf(r)) && !pending.some((x) => x.role === sourceOf(r)));
      if (!ready.length) {
        for (const r of pending) await failRow(db, r, `Thiếu ảnh nguồn (${plan.find((e) => e.role === sourceOf(r))?.label ?? sourceOf(r)}) — làm lại ảnh đó trước`);
        break;
      }
      await pool(ready, EDIT_CONCURRENCY, async (row) => {
        const done = await draw(row, have.get(sourceOf(row))!);
        if (done) have.set(row.role, done);
      });
      pending = pending.filter((r) => !ready.includes(r));
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    for (const r of rows) {
      const { data } = await db.from(CT_TABLES.charImages).select("status").eq("id", r.id).single<{ status: string }>();
      if (data?.status === "running") await failRow(db, r, msg);
    }
  }
}

// ---- the build -------------------------------------------------------------------------------------------

interface KitFile {
  slot: string;
  label: string;
  option: string;
  color: string;
  piece: string;
  png: string;
  bbox: number[];
  /** Key of its colour plate (KitCut.plates). */
  plate?: string;
}

interface KitView {
  slot: string;
  option: string;
  color: string;
  png: string;
}

interface KitCut {
  views?: KitView[];
  /** Colour plates (JPEG base64) by key: each file's colours over the whole canvas. */
  plates?: Record<string, string>;
  crop?: { x: number; y: number; w: number; h: number };
  width: number;
  height: number;
  order: Array<{ key: string; label: string; follows: string | null }>;
  zones: Array<{ id: string; polygon: number[][] }>;
  checks: CtCharLayerCheck[];
  /** Where the stacked files differ from the master (PNG base64, the files' crop). */
  diff: string;
  files: KitFile[];
}

/** layer-kit /plan input: the doll and every option drawn on it. */
export interface KitPlanInput {
  doll: string;
  /** The doll's underwear colour: a chroma key, never part of an option. */
  key: string;
  /** How many figures the doll has (subjects, left → right). */
  subjects: number;
  options: Array<{ key: string; slot: string; label: string; option: string; index: number; picture: string; url: string; subject: number; against?: string; fine?: boolean; spread?: boolean }>;
  zones: Array<{ id: string; label: string; mask: string }>;
  /** Per piece: the urls its region comes from — the same again keeps a hand-fixed region on a re-plan. */
  sigs: Record<string, string>;
}

/** The picture id of option `index` of a slot (layer-kit); a group's options share their picture's. */
const optionId = (slotId: string, index: number): string => `opt.${slotId}.${index}`;
const pictureIdOf = (x: { slot: CtCharSlot; index: number; pictureId?: string }): string => x.pictureId ?? (x.slot.group ? `grp.${x.slot.group}.${x.index}` : optionId(x.slot.id, x.index));

/** The edits the plan step needs (layer-kit /plan), or why it can't run yet. */
export function kitPlanInput(p: CtCharProject, latest: Map<string, CtCharImage>): { plan: KitPlanInput } | { missing: string[] } {
  // The agent's plan must still draw every option (an option added to the brief after it was written).
  if (p.brief.pictures?.length) {
    const errors = checkPictures(p.brief, p.brief.pictures, !p.brief.versionOf);
    if (errors.length) return { missing: errors.map((e) => `Kế hoạch 3b: ${e}`) };
  }
  // Thumbnail pictures are never cut: the set can be cut without them.
  const plan = planEdits(p.brief).filter((e) => !isThumbRole(e.role));
  const missing = plan.filter((e) => latest.get(e.role)?.status !== "done").map((e) => e.label);
  if (missing.length) return { missing };
  // Every edit must come from the CURRENT picture it names (a redone doll invalidates what was drawn on the old one).
  const stale = plan
    .filter((e) => e.role !== "work")
    .filter((e) => (latest.get(e.role)!.meta as { sourceId?: string }).sourceId !== latest.get(e.source)?.id)
    .map((e) => e.label);
  if (stale.length) return { missing: stale.map((l) => `${l} (làm từ ảnh nguồn cũ — làm lại)`) };
  const url = (role: string) => latest.get(role)!.url;
  const doll = url("base");
  const sigs: Record<string, string> = { body: doll };
  const options = optionPictures(p.brief).map((x) => {
    const o = x.slot.options[x.index];
    const key = `${x.slot.id}#${x.index}`;
    const against = x.against ? url(x.against) : undefined;
    sigs[key] = [url(x.role), doll, ...(against ? [against] : [])].join("|");
    return { key, slot: x.slot.id, label: `${slotLabel(p.brief, x.subject, x.slot)}: ${o.name}`, option: o.name, index: x.index, picture: pictureIdOf(x), url: url(x.role), subject: x.subject, ...(against ? { against } : {}), ...((x.fine ?? isFace(x.slot.part)) ? { fine: true } : {}), ...(x.slot.headwear ? { spread: true } : {}) };
  });
  const zones = p.brief.photoZones.map((z) => ({ id: z.id, label: z.label, mask: url(`zone:${z.id}`) }));
  for (const z of zones) sigs[`zone:${z.id}`] = [z.mask, doll].join("|");
  return { plan: { doll, key: DOLL_COLOUR.hex, subjects: p.brief.subjects.length, options, zones, sigs } };
}

/** layer-kit /cut input: the doll, every option picture + its region, slots as the brief has them. */
function cutInput(p: CtCharProject): Record<string, unknown> {
  const plan = p.cut?.plan;
  if (!plan || plan.status !== "done") throw new Error("Cần phác thảo lớp xong trước");
  if (!plan.approved) throw new Error("Duyệt phần phác thảo lớp trước");
  const pictures: Record<string, { colour: string; alpha: string }> = {};
  for (const pic of plan.pictures) if (pic.alphaUrl) pictures[pic.id] = { colour: pic.colourUrl, alpha: pic.alphaUrl };
  if (!pictures.base) throw new Error("Phác thảo thiếu búp bê — phác thảo lại");
  const piece = (key: string) => plan.pieces.find((x) => x.key === key);
  const body = piece("body");
  if (!body) throw new Error("Phác thảo thiếu vùng thân — phác thảo lại");
  // A wrapping part cut against another picture (hair under the hats of the outfit picture) lies in front where that
  // picture's figure is (the sweaters): that picture, as the plan step saved it.
  const options = optionPictures(p.brief);
  const figureOf = (slotId: string): string | undefined => {
    const x = options.find((y) => y.slot.id === slotId && y.against);
    const host = x ? options.find((y) => y.role === x.against) : undefined;
    return host ? piece(`${host.slot.id}#${host.index}`)?.picture : undefined;
  };
  const slots = p.brief.subjects.flatMap((sub, i) =>
    sub.slots.map((slot) => ({
      key: slot.id,
      label: slotLabel(p.brief, i, slot),
      mode: slot.mode,
      wraps: slot.mode === "shape" && slot.wraps,
      // A colour slot: one drawing (its first option), the other options are its recolours.
      options: slot.options.map((o, j) => {
        const pc = slot.mode === "color" && j > 0 ? undefined : piece(`${slot.id}#${j}`);
        return { name: o.name, hex: slot.mode === "color" ? o.value : null, picture: pc?.picture ?? null, region: pc?.region.url ?? null };
      }),
      colors: slot.mode === "shape" ? slot.colors.map((c) => ({ name: c.name, hex: c.value })) : [],
      ...(slot.mode === "shape" && slot.wraps && figureOf(slot.id) ? { figure: figureOf(slot.id) } : {}),
    })),
  );
  const zones = plan.pieces.filter((x) => x.kind === "zone").map((x) => ({ id: x.key.slice(5), region: x.region.url }));
  return { pictures, body_picture: "base", body_region: body.region.url, slots, zones };
}

/**
 * Start the cut of the set (layers.status "building", files made in the background). Throws with a message for the
 * editor. `product` ("Tạo bộ custom"): the set is approved and the product rebuilt from it when the cut is done.
 */
export async function startBuild(db: Db, userId: string, p: CtCharProject, cut?: CtCharCutState, product = false): Promise<CtCharProject> {
  if (!p.master_id) throw new Error("Duyệt master trước");
  if (p.layers?.status === "building") throw new Error("Đang cắt layer");
  // The cut state given (a plan approved with this build — MCP char_cut "build" after a region fix) is the one cut.
  const input = cutInput(cut ? { ...p, cut } : p);
  const images = await loadImages(db, p.id);
  const building: CtCharLayerSet = { status: "building", error: "", width: 0, height: 0, slots: p.layers?.slots ?? [], zones: [], checks: [], builtAt: "" };
  // `cut` (the plan just approved, server/char/cut.ts) is saved in the same write: the page never sees a finished plan with nothing running.
  const { data, error } = await db.from(CT_TABLES.charProjects).update({ layers: building, ...(cut ? { cut } : {}) }).eq("id", p.id).select("*").single<CtCharProject>();
  if (error || !data) throw new Error(error?.message ?? "Không lưu được");
  const project = projectRow(data);
  void runBuild(db, userId, project, input, images.filter((im) => im.kind === "layer"), p.layers, product);
  return project;
}

/** POST char/projects/:id/layers */
export async function buildCharLayers(s: CtSession, id: string, _body: unknown): Promise<NextResponse> {
  const p = await loadProject(s.supabase, id);
  if (!p) return jsonError("Không tìm thấy bộ nhân vật", 404);
  if (!(await canEditProject(s, p))) return jsonError(NOT_YOURS, 403);
  if (!p.master_id) return jsonError("Duyệt master trước", 409);
  if (p.layers?.status === "building") return jsonError("Đang cắt layer", 409);
  try {
    return NextResponse.json({ project: await startBuild(jobDb(s), s.user.id, p, undefined, true) }, { status: 202 });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Chưa cắt được", 400);
  }
}

/** POST char/projects/:id/layers/file[/revert] {imageId, mask} — one clipart edited by hand (server/char/file-edit.ts). */
export async function layerFileRoute(s: CtSession, id: string, action: string | undefined, body: unknown): Promise<NextResponse> {
  const p = await loadProject(s.supabase, id);
  if (!p) return jsonError("Không tìm thấy bộ nhân vật", 404);
  if (!(await canEditProject(s, p))) return jsonError(NOT_YOURS, 403);
  if (p.layers?.status === "building") return jsonError("Đang cắt layer — đợi xong rồi sửa", 409);
  try {
    const project = action === "revert" ? await revertLayerFile(jobDb(s), p, body) : await editLayerFile(jobDb(s), s.user.id, p, body);
    return NextResponse.json({ project });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không sửa được file", 400);
  }
}

/** POST char/projects/:id/layers/approve {approved} */
export async function approveCharLayers(s: CtSession, id: string, body: unknown): Promise<NextResponse> {
  const p = await loadProject(s.supabase, id);
  if (!p) return jsonError("Không tìm thấy bộ nhân vật", 404);
  if (!(await canEditProject(s, p))) return jsonError(NOT_YOURS, 403);
  if (p.layers?.status !== "done") return jsonError("Chưa cắt xong", 409);
  const approved = (body as { approved?: unknown } | null)?.approved !== false;
  const { data, error } = await s.supabase.from(CT_TABLES.charProjects).update({ layers: { ...p.layers, approved } }).eq("id", id).select("*").single<CtCharProject>();
  if (error || !data) return jsonError(error?.message ?? "Không lưu được", 500);
  return NextResponse.json({ project: projectRow(data) });
}

async function runBuild(db: Db, userId: string, p: CtCharProject, input: Record<string, unknown>, oldLayers: CtCharImage[], oldSet: CtCharLayerSet | null, product: boolean): Promise<void> {
  let job = "";
  try {
    const r = await kitJob<KitCut>("/cut", input);
    job = r.job;
    const kit = r.result;
    const stored: Array<{ file: KitFile; image: CtCharImage }> = [];
    await pool(kit.files, 6, async (f) => {
      const saved = await saveCharFile(userId, p.id, "layer", Buffer.from(f.png, "base64"));
      const { data } = await db
        .from(CT_TABLES.charImages)
        .insert({ project_id: p.id, user_id: userId, kind: "layer", role: `${f.slot}|${f.option}|${f.color}`, status: "done", note: f.label, ...saved, meta: {} })
        .select("*")
        .single<CtCharImage>();
      if (data) stored.push({ file: f, image: data });
    });
    // A wrapping part as it is seen, per option × colour (kind "layer" too: replaced with the files on the next cut).
    const views = new Map<string, CtCharImage>();
    await pool(kit.views ?? [], 6, async (v) => {
      const saved = await saveCharFile(userId, p.id, "layer", Buffer.from(v.png, "base64"));
      const { data } = await db
        .from(CT_TABLES.charImages)
        .insert({ project_id: p.id, user_id: userId, kind: "layer", role: `${v.slot}|${v.option}|${v.color}|view`, status: "done", note: "view", ...saved, meta: {} })
        .select("*")
        .single<CtCharImage>();
      if (data) views.set(`${v.slot.split(":")[0]}|${v.option}|${v.color}`, data);
    });
    const diff = await saveCharRaw(userId, p.id, "cut", Buffer.from(kit.diff, "base64"), "image/png");
    // Each file's colour plate (what a hand edit paints added pixels from, server/char/file-edit.ts).
    const plates = new Map<string, { url: string; path: string }>();
    await pool(Object.entries(kit.plates ?? {}), 6, async ([key, b64]) => {
      plates.set(key, await saveCharRaw(userId, p.id, "cut", Buffer.from(b64, "base64"), "image/jpeg"));
    });
    const order = new Map(kit.files.map((f, i) => [f, i]));
    stored.sort((a, b) => (order.get(a.file) ?? 0) - (order.get(b.file) ?? 0));
    const slots: CtCharLayerSlot[] = kit.order.map((o) => ({
      key: o.key,
      label: o.label,
      follows: o.follows,
      files: stored
        .filter((x) => x.file.slot === o.key)
        .map((x): CtCharLayerFile => {
          const view = views.get(`${x.file.slot.split(":")[0]}|${x.file.option}|${x.file.color}`);
          const plate = x.file.plate ? plates.get(x.file.plate) : undefined;
          return { imageId: x.image.id, url: x.image.url, thumbUrl: x.image.thumb_url, ...(view ? { viewUrl: view.url, viewThumbUrl: view.thumb_url || view.url } : {}), option: x.file.option, color: x.file.color, bbox: x.file.bbox, piece: x.file.piece, ...(plate ? { plateUrl: plate.url } : {}) };
        }),
    }));
    const plan = p.cut?.plan;
    const layers: CtCharLayerSet = {
      status: "done",
      error: "",
      width: kit.width,
      height: kit.height,
      slots,
      zones: kit.zones.map((z) => ({ id: z.id, label: p.brief.photoZones.find((x) => x.id === z.id)?.label ?? "Your photo", polygon: z.polygon })),
      // The plan's own checks (registration of every edit, regions found) come first.
      checks: [...(plan?.checks ?? []), ...kit.checks],
      builtAt: new Date().toISOString(),
      diffUrl: diff.url,
      diffPath: diff.path,
      approved: false,
      ...(kit.crop ? { crop: kit.crop } : {}),
      extraPaths: [...plates.values()].map((x) => x.path),
    };
    // The doll's "phần nằm sau" (server/char/behind.ts) stays.
    if (oldSet?.behindUrl) layers.behindUrl = oldSet.behindUrl;
    // The files the editor had edited by hand get their edits again (each clipart stays as they left it).
    layers.extraPaths!.push(...(await reapplyEdits(db, userId, p, oldSet, layers)));
    const now = (await loadProject(db, p.id)) ?? p;
    // A lineup drawn version by version: the product takes every set of it — made by the parent once all are cut.
    const lineupOf = now.brief.versionOf?.id ?? (now.brief.lineup?.drawn ? now.id : null);
    if (product && lineupOf) {
      await db.from(CT_TABLES.charProjects).update({ layers: { ...layers, approved: true }, status: now.brief.versionOf ? "layers" : now.status === "product" ? "product" : "layers" }).eq("id", p.id);
      await remakeDrawnProduct(db, userId, lineupOf).catch(async (e: Error) => {
        // A pose set's parent has no files of its own: the reason stays on the pose set.
        const on = now.brief.versionOf?.pose ? p.id : lineupOf;
        const cur = on === p.id ? layers : ((await loadProject(db, on))?.layers ?? layers);
        await db.from(CT_TABLES.charProjects).update({ layers: { ...cur, approved: true, error: `Đã cắt file nhưng chưa tạo được sản phẩm: ${e.message}`.slice(0, 1000) } }).eq("id", on);
      });
    } else if (product) {
      // "Tạo bộ custom": the cliparts + the finished product, made from this set (the old product goes with the old files).
      try {
        const productId = await remakeSetProduct(db, userId, now, { ...layers, approved: true });
        await db.from(CT_TABLES.charProjects).update({ layers: { ...layers, approved: true }, status: "product" }).eq("id", p.id);
      } catch (e) {
        const msg = `Đã cắt file nhưng chưa tạo được sản phẩm: ${e instanceof Error ? e.message : String(e)}`.slice(0, 1000);
        await db.from(CT_TABLES.charProjects).update({ layers: { ...layers, error: msg }, status: "layers" }).eq("id", p.id);
      }
    } else await db.from(CT_TABLES.charProjects).update({ layers, status: p.status === "product" ? "product" : "layers" }).eq("id", p.id);
    // The previous build's files are replaced — in the products made from them too.
    if (oldLayers.length) {
      if (!product) {
        // The files the set ends with (an edit applied again replaced the plain cut of its file).
        const ids = layers.slots.flatMap((sl) => sl.files.map((f) => f.imageId));
        const urls = layers.slots.flatMap((sl) => sl.files.map((f) => f.viewUrl ?? "")).filter(Boolean);
        const { data: finals } = await db.from(CT_TABLES.charImages).select("*").eq("project_id", p.id).or([`id.in.(${ids.join(",")})`, ...(urls.length ? [`url.in.(${urls.map((u) => `"${u}"`).join(",")})`] : [])].join(",")).returns<CtCharImage[]>();
        await relinkProducts(db, p, oldLayers, finals ?? stored.map((x) => x.image)).catch((e: Error) => console.warn("[ct] char relink products", e.message));
      }
      await db.from(CT_TABLES.charImages).delete().in("id", oldLayers.map((x) => x.id));
      await ctRemove([...new Set(oldLayers.flatMap((x) => [x.storage_path, x.thumb_path]))]);
    }
    if (oldSet?.diffPath || oldSet?.extraPaths?.length) await ctRemove([oldSet.diffPath ?? "", ...(oldSet.extraPaths ?? [])].filter(Boolean));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const failed: CtCharLayerSet = { ...(p.layers ?? { width: 0, height: 0, slots: [], zones: [], checks: [], builtAt: "" }), status: "failed", error: msg.slice(0, 1000) };
    // A few tries: one blip of the database left the set "building" for ever, nothing could cut it again (2026-10-18).
    for (let attempt = 0; attempt < 3; attempt++) {
      const { error } = await db.from(CT_TABLES.charProjects).update({ layers: failed }).eq("id", p.id);
      if (!error) break;
      await new Promise((r) => setTimeout(r, 5_000 * (attempt + 1)));
    }
  } finally {
    if (job) await kitForget(job);
  }
}

/** After the set is cut again: every product asset copied from an old file gets the new file of the same slot,
 * option and colour (and the link to it). Old files with no counterpart leave their assets as they are.
 * A pose set's files live in its PARENT's product (asked 2026-10-22: clipart fixed on the parent's page): those
 * assets are the file made the product's way again (meta.charFx: flopped, hat / rest; older ones: the way that
 * matches what the asset is). */
export async function relinkProducts(db: Db, p: CtCharProject, oldFiles: CtCharImage[], newFiles: CtCharImage[]): Promise<number> {
  const parent = p.brief.versionOf?.pose ? await loadProject(db, p.brief.versionOf.id) : null;
  const productIds = [...new Set([...p.product_ids, ...(parent?.product_ids ?? [])])];
  if (!productIds.length) return 0;
  // A product's cliparts live in its folder of the library (product_id null), its own assets on the product.
  const folders = (await Promise.all(productIds.map((pid) => findProductFolder(db, pid)))).filter((f): f is NonNullable<typeof f> => !!f).map((f) => f.id);
  const scope = [`product_id.in.(${productIds.join(",")})`, ...(folders.length ? [`category_id.in.(${folders.join(",")})`] : [])].join(",");
  const byRole = new Map(newFiles.map((f) => [f.role, f]));
  let n = 0;
  for (const old of oldFiles) {
    const next = byRole.get(old.role);
    if (!next) continue;
    // A front half's options are shown by their back half (meta.thumb, server/char/product.ts): that link too.
    for (const was of [old.thumb_url, old.url].filter((u): u is string => !!u)) {
      const { data: shown } = await db.from(CT_TABLES.assets).select("id, meta").or(scope).eq("meta->>thumb", was).returns<Array<Pick<CtAsset, "id" | "meta">>>();
      for (const a of shown ?? []) await db.from(CT_TABLES.assets).update({ meta: { ...a.meta, thumb: next.thumb_url || next.url } }).eq("id", a.id);
    }
    const { data: assets } = await db.from(CT_TABLES.assets).select("*").or(scope).eq("meta->>charLayerId", old.id).returns<CtAsset[]>();
    if (!assets?.length) continue;
    const data = await fetchImage(next.url);
    const made = new Map<string, Promise<Buffer>>();
    const asMade = (fx: CtCharFileFx) => {
      const key = JSON.stringify(fx);
      return made.get(key) ?? made.set(key, charClipart(data, fx)).get(key)!;
    };
    for (const a of assets) {
      const fx = parent ? (a.meta.charFx ?? (await guessFx(old, a))) : null;
      const png = fx ? await asMade(fx) : data;
      const path = a.product_id ? ctStoragePath(a.user_id, a.product_id, a.role, "image/png") : ctLibraryPath(a.user_id, a.category_id, a.role, "image/png");
      const url = await ctUpload(path, png, "image/png");
      await db.from(CT_TABLES.assets).update({ url, storage_path: path, width: next.width ?? a.width, height: next.height ?? a.height, meta: { ...a.meta, charLayerId: next.id, ...(fx ? { charFx: fx } : {}) } }).eq("id", a.id);
      await ctRemove([a.storage_path]);
      n++;
    }
  }
  return n;
}

/** A pose file's clipart made before meta.charFx: the way (flopped or not, whole / hat / rest) whose alpha is closest
 * to the asset's. */
async function guessFx(old: CtCharImage, a: CtAsset): Promise<CtCharFileFx> {
  const S = 128;
  const alpha = async (png: Buffer) => sharp(png).ensureAlpha().extractChannel(3).resize(S, S, { fit: "fill" }).raw().toBuffer();
  const have = await alpha(await fetchImage(a.url));
  const src = await fetchImage(old.url);
  let best: { fx: CtCharFileFx; d: number } = { fx: {}, d: Infinity };
  for (const flip of [false, true])
    for (const part of [undefined, "hat", "rest"] as const) {
      const fx: CtCharFileFx = { ...(flip ? { flip } : {}), ...(part ? { part } : {}) };
      const mine = await alpha(await charClipart(src, fx)).catch(() => null);
      if (!mine) continue;
      let d = 0;
      for (let i = 0; i < have.length; i++) d += Math.abs(have[i] - mine[i]);
      if (d < best.d) best = { fx, d };
    }
  return best.fx;
}
