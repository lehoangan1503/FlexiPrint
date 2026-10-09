/**
 * Layers of a bộ nhân vật, from the approved master (layer-rules: one canvas, in-place edits, nothing re-drawn).
 *
 *   POST char/projects/:id/edits  {roles?} → { images } the planned edits (lib/char-plan.ts) still missing — or
 *                                 the given roles again — made in the background: work master (the master), base,
 *                                 then the rest from it; each edit's registration is measured (layer-kit /align)
 *   POST char/projects/:id/layers → { project } layers.status "building", then "done" / "failed": layer-kit /cut
 *                                 cuts the set from the reviewed matte + regions (server/char/cut.ts); every file
 *                                 is stored (PNG original + WebP preview) as kind "layer"
 *   POST char/projects/:id/layers/approve {approved} → { project } the editor checked the files (final)
 *
 * Redoing "work" redoes everything; redoing "base" redoes every edit made from it (they share its pixels).
 *
 * Env: CT_LAYER_KIT_URL (services/layer-kit, default http://127.0.0.1:7005), CT_LAYER_KIT_TOKEN.
 */

import { NextResponse } from "next/server";
import { CT_TABLES } from "../../config";
import type { CtAsset, CtCharAlign, CtCharCutState, CtCharImage, CtCharLayerCheck, CtCharLayerFile, CtCharLayerSet, CtCharLayerSlot, CtCharProject } from "../../types";
import { planEdits, slotLabel, type CtCharEditPlan } from "../../lib/char-plan";
import { latestEditsOf } from "../../lib/char-images";
import type { CtSession } from "../supabase";
import { ctRemove, ctStoragePath, ctUpload } from "../storage";
import { fetchImage, saveCharFile, saveCharRaw } from "./files";
import { kitForget, kitJob, kitPost } from "./kit";
import { remakeSetProduct } from "./product";
import { editModels, jobDb, jsonError, loadImages, loadProject, projectRow, runCharDraw } from "./projects";

type Db = ReturnType<typeof jobDb>;

const EDIT_CONCURRENCY = 4;


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
  // prompt (the agent runs base first, then writes the rest).
  const made = (e: CtCharEditPlan) => latest.has(e.role);
  if (set.has("work")) plan.filter(made).forEach((e) => set.add(e.role));
  if (set.has("base")) plan.filter((e) => e.source === "base" && made(e)).forEach((e) => set.add(e.role));
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
    const prompt = a.prompts?.[role]?.trim() || (last?.meta.taskId && last.prompt) || e?.prompt || "";
    const byAgent = !!a.prompts?.[role]?.trim() || !!(last?.meta.taskId && last.prompt);
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
  if (p.user_id !== s.user.id) return jsonError("Bộ nhân vật của người khác — chỉ xem", 403);
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
  const byRole = new Map(rows.map((r) => [r.role, r]));
  let work = before.get("work")?.status === "done" ? before.get("work")! : null;
  let base = before.get("base")?.status === "done" ? before.get("base")! : null;
  try {
    const workRow = byRole.get("work");
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
      work = data ?? null;
    }
    if (!work) throw new Error("Chưa có master làm việc");
    const models = await editModels();
    const draw = async (row: CtCharImage, src: CtCharImage) => {
      // The source is written before drawing: a measure that hangs (the VPS swapping) must not leave a finished
      // edit without it — the plan step would call it "made from an old base".
      const meta = { ...row.meta, sourceId: src.id };
      await db.from(CT_TABLES.charImages).update({ parent_id: src.id, meta }).eq("id", row.id);
      const done = await runCharDraw(db, userId, { ...row, parent_id: src.id, meta }, { prompt: row.prompt, refs: [src.url], aspect: null, refSize: { w: src.width, h: src.height }, models });
      if (!done) return null;
      const align = await measure(src.url, done.url);
      if (!align) return done;
      const { data } = await db.from(CT_TABLES.charImages).update({ meta: { ...meta, ...done.meta, align } }).eq("id", done.id).select("*").single<CtCharImage>();
      return data ?? done;
    };
    const baseRow = byRole.get("base");
    if (baseRow) base = await draw(baseRow, work);
    const rest = rows.filter((r) => r.role !== "work" && r.role !== "base");
    await pool(rest, EDIT_CONCURRENCY, async (row) => {
      const src = plan.find((e) => e.role === row.role)?.source === "base" ? base : work;
      if (!src) return failRow(db, row, "Thiếu bản gốc bỏ phần đổi kiểu (base) — làm lại base");
      await draw(row, src);
    });
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
}

interface KitCut {
  width: number;
  height: number;
  order: Array<{ key: string; label: string; follows: string | null }>;
  zones: Array<{ id: string; polygon: number[][] }>;
  checks: CtCharLayerCheck[];
  /** Where the stacked files differ from the master (PNG base64, the files' crop). */
  diff: string;
  files: KitFile[];
}

/** The edits the plan step needs (layer-kit /plan), or why it can't run yet. */
export function kitPlanInput(p: CtCharProject, latest: Map<string, CtCharImage>): { plan: { base: string | null; slots: unknown[]; zones: unknown[] } } | { missing: string[] } {
  const plan = planEdits(p.brief);
  const missing = plan.filter((e) => latest.get(e.role)?.status !== "done").map((e) => e.label);
  if (missing.length) return { missing };
  const work = latest.get("work")!;
  const base = latest.get("base") ?? null;
  // Every edit must come from the CURRENT work / base (redone ones invalidate what was made from the old pixels).
  const stale = plan
    .filter((e) => e.role !== "work")
    .filter((e) => {
      const im = latest.get(e.role)!;
      const src = e.source === "base" ? base : work;
      return (im.meta as { sourceId?: string }).sourceId !== src?.id;
    })
    .map((e) => e.label);
  if (stale.length) return { missing: stale.map((l) => `${l} (làm từ bản gốc cũ — làm lại)`) };
  const url = (role: string) => latest.get(role)?.url ?? null;
  const slots = p.brief.subjects.flatMap((sub, i) =>
    sub.slots.map((slot) => ({
      key: slot.id,
      label: slotLabel(p.brief, i, slot),
      mode: slot.mode,
      mask: slot.mode === "shape" ? url(`part:${slot.id}`) : url(`mask:${slot.id}`),
      options: slot.options.map((o, j) => ({
        name: o.name,
        hex: slot.mode === "color" ? o.value : null,
        url: j === 0 ? null : slot.mode === "shape" ? url(`shape:${slot.id}:${o.id}`) : slot.mode === "texture" ? url(`texture:${slot.id}:${o.id}`) : null,
      })),
      colors: slot.mode === "shape" ? slot.colors.map((c) => ({ name: c.name, hex: c.value })) : [],
      wraps: slot.mode === "shape" && slot.wraps,
    })),
  );
  return { plan: { base: base?.url ?? null, slots, zones: p.brief.photoZones.map((z) => ({ id: z.id, label: z.label, mask: url(`zone:${z.id}`) })) } };
}

/** layer-kit /cut input: the reviewed matte + regions, slots as the brief has them. */
function cutInput(p: CtCharProject): Record<string, unknown> {
  const matte = p.cut?.matte;
  const plan = p.cut?.plan;
  if (!matte?.alpha || matte.status !== "done" || !plan || plan.status !== "done") throw new Error("Cần tách nền và phác thảo lớp xong trước");
  if (!plan.approved) throw new Error("Duyệt phần phác thảo lớp trước");
  const pictures: Record<string, { colour: string; alpha?: string | null; own?: string | null; keep?: string | null; parent?: string | null }> = {
    master: { colour: matte.colourUrl, alpha: matte.alpha.url },
  };
  for (const pic of plan.pictures) if (pic.id !== "master") pictures[pic.id] = { colour: pic.colourUrl, alpha: pic.alphaUrl, own: pic.ownUrl, keep: pic.keepUrl, parent: pic.parent };
  const piece = (key: string) => plan.pieces.find((x) => x.key === key);
  const body = piece("body");
  if (!body) throw new Error("Phác thảo thiếu vùng thân — phác thảo lại");
  const slots = p.brief.subjects.flatMap((sub, i) =>
    sub.slots.map((slot) => ({
      key: slot.id,
      label: slotLabel(p.brief, i, slot),
      mode: slot.mode,
      wraps: slot.mode === "shape" && slot.wraps,
      region: slot.mode === "shape" ? null : (piece(slot.id)?.region.url ?? null),
      options: slot.options.map((o, j) => {
        if (slot.mode === "shape") {
          const pc = piece(`${slot.id}#${j}`);
          return { name: o.name, hex: null, picture: pc?.picture ?? null, region: pc?.region.url ?? null };
        }
        const tex = `tex.${slot.id}.${j}`;
        return { name: o.name, hex: slot.mode === "color" ? o.value : null, picture: slot.mode === "texture" && j > 0 && pictures[tex] ? tex : null, region: null };
      }),
      colors: slot.mode === "shape" ? slot.colors.map((c) => ({ name: c.name, hex: c.value })) : [],
    })),
  );
  const zones = plan.pieces.filter((x) => x.kind === "zone").map((x) => ({ id: x.key.slice(5), region: x.region.url }));
  return { pictures, body_picture: body.picture, body_region: body.region.url, slots, zones };
}

/**
 * Start the cut of the set (layers.status "building", files made in the background). Throws with a message for the
 * editor. `product` ("Tạo bộ custom"): the set is approved and the product rebuilt from it when the cut is done.
 */
export async function startBuild(db: Db, userId: string, p: CtCharProject, cut?: CtCharCutState, product = false): Promise<CtCharProject> {
  if (!p.master_id) throw new Error("Duyệt master trước");
  if (p.layers?.status === "building") throw new Error("Đang cắt layer");
  const input = cutInput(p);
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
  if (p.user_id !== s.user.id) return jsonError("Bộ nhân vật của người khác — chỉ xem", 403);
  if (!p.master_id) return jsonError("Duyệt master trước", 409);
  if (p.layers?.status === "building") return jsonError("Đang cắt layer", 409);
  try {
    return NextResponse.json({ project: await startBuild(jobDb(s), s.user.id, p, undefined, true) }, { status: 202 });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Chưa cắt được", 400);
  }
}

/** POST char/projects/:id/layers/approve {approved} */
export async function approveCharLayers(s: CtSession, id: string, body: unknown): Promise<NextResponse> {
  const p = await loadProject(s.supabase, id);
  if (!p) return jsonError("Không tìm thấy bộ nhân vật", 404);
  if (p.user_id !== s.user.id) return jsonError("Bộ nhân vật của người khác — chỉ xem", 403);
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
    const diff = await saveCharRaw(userId, p.id, "cut", Buffer.from(kit.diff, "base64"), "image/png");
    const order = new Map(kit.files.map((f, i) => [f, i]));
    stored.sort((a, b) => (order.get(a.file) ?? 0) - (order.get(b.file) ?? 0));
    const slots: CtCharLayerSlot[] = kit.order.map((o) => ({
      key: o.key,
      label: o.label,
      follows: o.follows,
      files: stored
        .filter((x) => x.file.slot === o.key)
        .map((x): CtCharLayerFile => ({ imageId: x.image.id, url: x.image.url, thumbUrl: x.image.thumb_url, option: x.file.option, color: x.file.color, bbox: x.file.bbox, piece: x.file.piece })),
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
    };
    if (product) {
      // "Tạo bộ custom": the cliparts + the finished product, made from this set (the old product goes with the old files).
      const now = (await loadProject(db, p.id)) ?? p;
      try {
        const productId = await remakeSetProduct(db, userId, now, { ...layers, approved: true });
        await db.from(CT_TABLES.charProjects).update({ layers: { ...layers, approved: true }, product_ids: [productId], status: "product" }).eq("id", p.id);
      } catch (e) {
        const msg = `Đã cắt file nhưng chưa tạo được sản phẩm: ${e instanceof Error ? e.message : String(e)}`.slice(0, 1000);
        await db.from(CT_TABLES.charProjects).update({ layers: { ...layers, error: msg }, status: "layers" }).eq("id", p.id);
      }
    } else await db.from(CT_TABLES.charProjects).update({ layers, status: p.status === "product" ? "product" : "layers" }).eq("id", p.id);
    // The previous build's files are replaced — in the products made from them too.
    if (oldLayers.length) {
      if (!product) await relinkProducts(db, p, oldLayers, stored.map((x) => x.image)).catch((e: Error) => console.warn("[ct] char relink products", e.message));
      await db.from(CT_TABLES.charImages).delete().in("id", oldLayers.map((x) => x.id));
      await ctRemove([...new Set(oldLayers.flatMap((x) => [x.storage_path, x.thumb_path]))]);
    }
    if (oldSet?.diffPath) await ctRemove([oldSet.diffPath]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const failed: CtCharLayerSet = { ...(p.layers ?? { width: 0, height: 0, slots: [], zones: [], checks: [], builtAt: "" }), status: "failed", error: msg.slice(0, 1000) };
    await db.from(CT_TABLES.charProjects).update({ layers: failed }).eq("id", p.id);
  } finally {
    if (job) await kitForget(job);
  }
}

/** After the set is cut again: every product asset copied from an old file gets the new file of the same slot,
 * option and colour (and the link to it). Old files with no counterpart leave their assets as they are. */
export async function relinkProducts(db: Db, p: CtCharProject, oldFiles: CtCharImage[], newFiles: CtCharImage[]): Promise<number> {
  if (!p.product_ids.length) return 0;
  const byRole = new Map(newFiles.map((f) => [f.role, f]));
  let n = 0;
  for (const old of oldFiles) {
    const next = byRole.get(old.role);
    if (!next) continue;
    // A front half's options are shown by their back half (meta.thumb, server/char/product.ts): that link too.
    for (const was of [old.thumb_url, old.url].filter((u): u is string => !!u)) {
      const { data: shown } = await db.from(CT_TABLES.assets).select("id, meta").in("product_id", p.product_ids).eq("meta->>thumb", was).returns<Array<Pick<CtAsset, "id" | "meta">>>();
      for (const a of shown ?? []) await db.from(CT_TABLES.assets).update({ meta: { ...a.meta, thumb: next.thumb_url || next.url } }).eq("id", a.id);
    }
    const { data: assets } = await db.from(CT_TABLES.assets).select("*").in("product_id", p.product_ids).eq("meta->>charLayerId", old.id).returns<CtAsset[]>();
    if (!assets?.length) continue;
    const data = await fetchImage(next.url);
    for (const a of assets) {
      const path = ctStoragePath(a.user_id, a.product_id ?? "library", a.role, "image/png");
      const url = await ctUpload(path, data, "image/png");
      await db.from(CT_TABLES.assets).update({ url, storage_path: path, width: next.width ?? a.width, height: next.height ?? a.height, meta: { ...a.meta, charLayerId: next.id } }).eq("id", a.id);
      await ctRemove([a.storage_path]);
      n++;
    }
  }
  return n;
}
