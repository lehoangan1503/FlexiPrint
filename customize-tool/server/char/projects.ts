/**
 * v2 — bộ nhân vật (migration 021). One brief → master candidates the editor reviews → ONE approved master →
 * layers (server/char/layers.ts) → products. Rules: flexiprint://guide/layer-rules.
 *
 *   GET    char/projects                     → { projects } newest first, with the master's preview
 *   POST   char/projects        {name, brief?} → { project }
 *   GET    char/projects/:id                 → { project, images }
 *   PATCH  char/projects/:id    {name?, brief?}
 *   DELETE char/projects/:id                 (files stay on R2 only until the cleanup — rows cascade)
 *   POST   char/projects/:id/files     multipart file, kind (ref|blank) → { image }
 *   brainstorm, the master prompt and the edit prompts: @flexiprint (agent task kind "char", server/mcp/char-tools.ts)
 *   POST   char/projects/:id/masters   {prompt?, count?, aspect?} → { images } status running, then done / failed
 *   POST   char/projects/:id/masters/:imageId/refine {note} → { image } an in-place edit of that master
 *   POST   char/projects/:id/approve   {imageId | null} → { project } the master every layer is cut from
 *   POST   char/projects/:id/edits     server/char/layers.ts — in-place edits the brief needs
 *   POST   char/projects/:id/layers    server/char/layers.ts — cut the layer set (services/layer-kit)
 *   POST   char/projects/:id/layers/:imageId[/revert]  server/char/layer-edit.ts — fix one file by hand / undo
 *   POST   char/projects/:id/products  server/char/product.ts — a draft product from the set (one set, many products)
 *   POST   char/projects/:id/mockups   server/char/mockups.ts — front mockup (exact) + AI lifestyle scenes
 *
 * Every picture — masters, refinements, layer edits, mockup scenes — uses the team's image model (home page, default
 * GPT Image 2.5). GPT Image moves what it keeps (≈ 0.2 % scale per axis + up to ~0.7 px per character): layer-kit
 * registers every edit back onto the master (affine + smoothed local flow, ≤ 0.4 px left — measured 2026-10-08).
 */

import { NextResponse } from "next/server";
import { CT_TABLES } from "../../config";
import type { CtCharBrief, CtCharCutState, CtCharImage, CtCharImageKind, CtCharMask, CtCharProject, CtCharRef, CtCharRefUse } from "../../types";
import { REF_USE_INFO, masterPrompt, parseCharBrief } from "../../lib/char-brief";
import { CT_IMAGE_MODELS } from "../../lib/image-models";
import { drawImage } from "../pack-images";
import { currentImageModel } from "../settings";
import { ctServiceClient, type CtSession } from "../supabase";
import { ctRemove } from "../storage";
import { fetchImage, saveCharFile } from "./files";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILE = 30 * 1024 * 1024;

/** In-place edits use the team's model too (asked 2026-10-08), tried twice — never a silent switch to another one. */
export async function editModels(): Promise<string[]> {
  const picked = await currentImageModel();
  return [picked, picked];
}

export function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export type Db = CtSession["supabase"] | NonNullable<ReturnType<typeof ctServiceClient>>;

/** Background jobs outlive the request: they write with the service key when there is one. */
export function jobDb(s: CtSession): Db {
  return ctServiceClient() ?? s.supabase;
}

export function projectRow(raw: CtCharProject): CtCharProject {
  return {
    ...raw,
    brief: parseCharBrief(raw.brief),
    ideas: Array.isArray(raw.ideas) ? raw.ideas : [],
    cut: raw.cut && typeof raw.cut === "object" ? { matte: raw.cut.matte ?? null, plan: raw.cut.plan ?? null } : null,
    layers: raw.layers && typeof raw.layers === "object" && "status" in raw.layers ? raw.layers : null,
    product_ids: Array.isArray(raw.product_ids) ? raw.product_ids : [],
  };
}

export const maskPaths = (m: CtCharMask | null | undefined): string[] => (m ? [m.path, ...m.history.map((h) => h.path)] : []);

/** Every file of a cut state (server/char/cut.ts) — the master's own picture is the matte's. */
export function cutPaths(cut: CtCharCutState | null): string[] {
  if (!cut) return [];
  const out: string[] = [];
  if (cut.matte) out.push(cut.matte.colourPath, cut.matte.previewPath, ...maskPaths(cut.matte.alpha));
  if (cut.plan) {
    for (const pic of cut.plan.pictures) if (pic.id !== "master") out.push(pic.colourPath, pic.previewPath, pic.alphaPath ?? "", pic.ownPath ?? "", pic.keepPath ?? "");
    for (const pc of cut.plan.pieces) out.push(...maskPaths(pc.region));
  }
  return out.filter(Boolean);
}

export async function loadProject(db: Db, id: string): Promise<CtCharProject | null> {
  if (!UUID.test(id)) return null;
  const { data } = await db.from(CT_TABLES.charProjects).select("*").eq("id", id).maybeSingle<CtCharProject>();
  return data ? projectRow(data) : null;
}

export async function loadImages(db: Db, projectId: string): Promise<CtCharImage[]> {
  const { data } = await db.from(CT_TABLES.charImages).select("*").eq("project_id", projectId).order("created_at", { ascending: true }).returns<CtCharImage[]>();
  return data ?? [];
}

/** The project when the caller may change it (owner; RLS lets admins too). */
async function ownProject(s: CtSession, id: string): Promise<CtCharProject | NextResponse> {
  const p = await loadProject(s.supabase, id);
  if (!p) return jsonError("Không tìm thấy bộ nhân vật", 404);
  if (p.user_id && p.user_id !== s.user.id) {
    const { data: admin } = await s.supabase.rpc("ct_is_admin");
    if (admin !== true) return jsonError("Bộ nhân vật của người khác — chỉ xem", 403);
  }
  return p;
}

/** GET char/projects */
export async function listCharProjects(s: CtSession): Promise<NextResponse> {
  const { data, error } = await s.supabase.from(CT_TABLES.charProjects).select("*").order("updated_at", { ascending: false }).limit(200).returns<CtCharProject[]>();
  if (error) return jsonError(error.message, 500);
  const projects = (data ?? []).map(projectRow);
  // Preview: the approved master, else the newest finished master.
  const { data: masters } = await s.supabase
    .from(CT_TABLES.charImages)
    .select("id, project_id, thumb_url, created_at")
    .in("project_id", projects.map((p) => p.id))
    .eq("kind", "master")
    .eq("status", "done")
    .order("created_at", { ascending: false })
    .returns<Array<Pick<CtCharImage, "id" | "project_id" | "thumb_url">>>();
  const thumbs: Record<string, string> = {};
  for (const p of projects) {
    const mine = (masters ?? []).filter((m) => m.project_id === p.id);
    thumbs[p.id] = (mine.find((m) => m.id === p.master_id) ?? mine[0])?.thumb_url ?? "";
  }
  return NextResponse.json({ projects, thumbs });
}

/** POST char/projects */
export async function createCharProject(s: CtSession, body: unknown): Promise<NextResponse> {
  const b = (body && typeof body === "object" ? body : {}) as { name?: unknown; brief?: unknown };
  const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 200) : "Bộ nhân vật mới";
  const { data, error } = await s.supabase
    .from(CT_TABLES.charProjects)
    .insert({ user_id: s.user.id, name, brief: parseCharBrief(b.brief) })
    .select("*")
    .single<CtCharProject>();
  if (error || !data) return jsonError(error?.message ?? "Không tạo được", 500);
  return NextResponse.json({ project: projectRow(data) }, { status: 201 });
}

/** GET char/projects/:id */
export async function getCharProject(s: CtSession, id: string): Promise<NextResponse> {
  const project = await loadProject(s.supabase, id);
  if (!project) return jsonError("Không tìm thấy bộ nhân vật", 404);
  return NextResponse.json({ project, images: await loadImages(s.supabase, id) });
}

/** PATCH char/projects/:id */
export async function updateCharProject(s: CtSession, id: string, body: unknown): Promise<NextResponse> {
  const p = await ownProject(s, id);
  if (p instanceof NextResponse) return p;
  const b = (body && typeof body === "object" ? body : {}) as { name?: unknown; brief?: unknown };
  const patch: { name?: string; brief?: CtCharBrief } = {};
  if (typeof b.name === "string" && b.name.trim()) patch.name = b.name.trim().slice(0, 200);
  if (b.brief !== undefined) {
    patch.brief = parseCharBrief(b.brief);
    // The edits, the plan and the layers hang on the brief's slot / option ids: once a master is approved the brief is frozen.
    if (p.master_id && JSON.stringify(patch.brief) !== JSON.stringify(parseCharBrief(p.brief))) return jsonError("Master đã duyệt — brief bị khoá. Bỏ duyệt master (về bước Master) nếu muốn đổi brief", 409);
  }
  const { data, error } = await s.supabase.from(CT_TABLES.charProjects).update(patch).eq("id", id).select("*").single<CtCharProject>();
  if (error || !data) return jsonError(error?.message ?? "Không lưu được", 500);
  return NextResponse.json({ project: projectRow(data) });
}

/** DELETE char/projects/:id */
export async function deleteCharProject(s: CtSession, id: string): Promise<NextResponse> {
  const p = await ownProject(s, id);
  if (p instanceof NextResponse) return p;
  const images = await loadImages(s.supabase, id);
  const { error } = await s.supabase.from(CT_TABLES.charProjects).delete().eq("id", id);
  if (error) return jsonError(error.message, 500);
  await ctRemove([...images.flatMap((im) => [im.storage_path, im.thumb_path]), ...cutPaths(p.cut), p.layers?.diffPath ?? ""].filter(Boolean));
  return NextResponse.json({ ok: true });
}

/** POST char/projects/:id/files — a reference picture or the blank product photo. */
export async function uploadCharFile(s: CtSession, id: string, form: FormData): Promise<NextResponse> {
  const p = await ownProject(s, id);
  if (p instanceof NextResponse) return p;
  const file = form.get("file");
  const kind = form.get("kind");
  if (!(file instanceof Blob) || file.size === 0) return jsonError("Thiếu ảnh", 400);
  if (file.size > MAX_FILE) return jsonError("Ảnh quá lớn (tối đa 30 MB)", 413);
  if (kind !== "ref" && kind !== "blank") return jsonError("kind phải là ref hoặc blank", 400);
  let saved;
  try {
    saved = await saveCharFile(s.user.id, id, kind, Buffer.from(await file.arrayBuffer()));
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Upload thất bại", 400);
  }
  const { data, error } = await s.supabase
    .from(CT_TABLES.charImages)
    .insert({ project_id: id, user_id: s.user.id, kind, role: kind, status: "done", ...saved })
    .select("*")
    .single<CtCharImage>();
  if (error || !data) return jsonError(error?.message ?? "Không lưu được", 500);
  return NextResponse.json({ image: data }, { status: 201 });
}

// ---- pictures ---------------------------------------------------------------------------------------------

/** "w:h" of a picture, for a model that needs it; fal edits keep the input's own framing ("auto"). */
function editAspect(model: string, w: number | null, h: number | null): string {
  if (model.startsWith("fal:")) return "auto";
  return w && h ? `${w}:${h}` : "2:3";
}

export interface CharDraw {
  prompt: string;
  /** Reference picture urls, in order. An in-place edit: the picture being edited first. */
  refs: string[];
  /** Fixed aspect (new picture) or null (an edit: keep the first ref's). */
  aspect: string | null;
  refSize: { w: number | null; h: number | null };
  /** Models to try in order. */
  models: string[];
}

/** Draw one picture into an existing running row → done / failed. Never throws. */
export async function runCharDraw(db: Db, userId: string, row: CtCharImage, d: CharDraw): Promise<CtCharImage | null> {
  let lastError = "";
  for (const model of d.models) {
    try {
      const out = await drawImage(model, d.prompt, d.refs, d.aspect ?? editAspect(model, d.refSize.w, d.refSize.h), "pad");
      const saved = await saveCharFile(userId, row.project_id, row.kind, out.data);
      const { data } = await db
        .from(CT_TABLES.charImages)
        .update({ ...saved, model, status: "done", error: "" })
        .eq("id", row.id)
        .select("*")
        .single<CtCharImage>();
      return data ?? null;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      console.warn(`[ct] char ${row.kind} ${row.role}: ${model} failed — ${lastError}`);
    }
  }
  await db.from(CT_TABLES.charImages).update({ status: "failed", error: lastError.slice(0, 1000) }).eq("id", row.id);
  return null;
}

/** Team model first, then the others (a new picture: registration does not matter). */
async function newPictureModels(): Promise<string[]> {
  const picked = await currentImageModel();
  return [picked, ...CT_IMAGE_MODELS.map((m) => m.id).filter((m) => m !== picked)];
}

/** The brief's reference pictures the image model gets (≤ 4, style first), and the lines that say what each is
 * for — the model copies a reference too closely unless it is told exactly what to take. */
export function modelRefs(brief: CtCharBrief, images: CtCharImage[]): { urls: string[]; text: string } {
  const order: CtCharRefUse[] = ["sample", "style", "character", "outfit", "pose"];
  const picked = brief.refs
    .filter((r) => REF_USE_INFO[r.use].take)
    .sort((a, b) => order.indexOf(a.use) - order.indexOf(b.use))
    .map((r) => ({ r, im: images.find((im) => im.id === r.id && im.status === "done") }))
    .filter((x): x is { r: CtCharRef; im: CtCharImage } => !!x.im)
    .slice(0, 4);
  if (!picked.length) return { urls: [], text: "" };
  const lines = picked.map(({ r }, i) => `Reference picture ${i + 1}: take ${REF_USE_INFO[r.use].take}${r.note ? ` — the editor says: "${r.note}"` : ""}.`);
  return {
    urls: picked.map((x) => x.im.url),
    text: `${lines.join("\n")}\nDo not copy anything else from the references (no background, no text, no other characters, no layout unless asked).\n`,
  };
}

/** The image model's own canvases (GPT Image: 1024×1536, 1536×1024, 1024²): edits of a master drawn on one come
 * back on the same canvas, nothing padded or stretched. */
function masterAspect(brief: CtCharBrief): string {
  return brief.subjects.length <= 2 ? "2:3" : "3:2";
}

const ASPECTS = ["2:3", "3:2", "1:1"];

export interface MasterDrawArgs {
  /** The full prompt (the style-reference line is added here); "" = assembled from the brief. */
  prompt: string;
  count: number;
  aspect: string | null;
  /** The @flexiprint task that asked for it (shown with the image, its progress lists it). */
  taskId?: string | null;
}

/** Master candidates: rows "running" now, drawn in the background. Throws with a message for the editor. */
export async function drawMasters(db: Db, userId: string, p: CtCharProject, a: MasterDrawArgs): Promise<CtCharImage[]> {
  if (p.master_id) throw new Error("Master đã duyệt — bỏ duyệt trước khi tạo master mới");
  const prompt = a.prompt.trim().slice(0, 8000) || masterPrompt(p.brief);
  if (!p.brief.subjects.length && !a.prompt.trim()) throw new Error("Brief chưa có nhân vật");
  const count = Math.min(Math.max(Math.round(a.count) || 2, 1), 4);
  const aspect = a.aspect && ASPECTS.includes(a.aspect) ? a.aspect : masterAspect(p.brief);
  const images = await loadImages(db, p.id);
  const { urls: refs, text } = modelRefs(p.brief, images);
  const full = text + prompt;
  const meta = (i: number) => ({ candidate: i + 1, ...(a.taskId ? { taskId: a.taskId } : {}) });
  const rows = Array.from({ length: count }, (_, i) => ({ project_id: p.id, user_id: userId, kind: "master" as CtCharImageKind, role: "master", status: "running", prompt: full, meta: meta(i) }));
  const { data, error } = await db.from(CT_TABLES.charImages).insert(rows).select("*").returns<CtCharImage[]>();
  if (error || !data) throw new Error(error?.message ?? "Không tạo được");
  const models = await newPictureModels();
  for (const row of data) void runCharDraw(db, userId, row, { prompt: full, refs, aspect, refSize: { w: null, h: null }, models });
  return data;
}

/** POST char/projects/:id/masters */
export async function generateMasters(s: CtSession, id: string, body: unknown): Promise<NextResponse> {
  const p = await ownProject(s, id);
  if (p instanceof NextResponse) return p;
  const b = (body && typeof body === "object" ? body : {}) as { prompt?: unknown; count?: unknown; aspect?: unknown };
  try {
    const images = await drawMasters(jobDb(s), s.user.id, p, { prompt: typeof b.prompt === "string" ? b.prompt : "", count: Number(b.count) || 2, aspect: typeof b.aspect === "string" ? b.aspect : null });
    return NextResponse.json({ images }, { status: 202 });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không tạo được", 400);
  }
}

export const KEEP_REFINE =
  " Change ONLY what is asked. Keep everything else exactly as it is: the same characters, faces, poses, clothes, colours, " +
  "composition, position, size, framing, art style and the flat white background. Do not move, zoom or crop.";

/** An in-place edit of a master candidate: `prompt` as the model gets it, `note` what the editor asked. */
export async function refineMasterImage(db: Db, userId: string, p: CtCharProject, imageId: string, prompt: string, note: string, taskId?: string | null): Promise<CtCharImage> {
  if (p.master_id) throw new Error("Master đã duyệt — bỏ duyệt trước khi sửa");
  const images = await loadImages(db, p.id);
  const parent = images.find((im) => im.id === imageId && im.kind === "master" && im.status === "done");
  if (!parent) throw new Error("Không tìm thấy master");
  const { data: row, error } = await db
    .from(CT_TABLES.charImages)
    .insert({ project_id: p.id, user_id: userId, kind: "master", role: "master", parent_id: parent.id, status: "running", prompt, note, meta: taskId ? { taskId } : {} })
    .select("*")
    .single<CtCharImage>();
  if (error || !row) throw new Error(error?.message ?? "Không tạo được");
  void runCharDraw(db, userId, row, { prompt, refs: [parent.url], aspect: null, refSize: { w: parent.width, h: parent.height }, models: await editModels() });
  return row;
}

/** POST char/projects/:id/masters/:imageId/refine */
export async function refineMaster(s: CtSession, id: string, imageId: string, body: unknown): Promise<NextResponse> {
  const p = await ownProject(s, id);
  if (p instanceof NextResponse) return p;
  const note = body && typeof body === "object" && typeof (body as { note?: unknown }).note === "string" ? (body as { note: string }).note.trim().slice(0, 2000) : "";
  if (!note) return jsonError("Viết cần sửa gì", 400);
  try {
    const image = await refineMasterImage(jobDb(s), s.user.id, p, imageId, note.replace(/\.?$/, ".") + KEEP_REFINE, note);
    return NextResponse.json({ image }, { status: 202 });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không sửa được", 400);
  }
}

/** POST char/projects/:id/approve */
export async function approveMaster(s: CtSession, id: string, body: unknown): Promise<NextResponse> {
  const p = await ownProject(s, id);
  if (p instanceof NextResponse) return p;
  const imageId = body && typeof body === "object" ? (body as { imageId?: unknown }).imageId : null;
  if (imageId === null) {
    if (p.status === "layers" || p.status === "product") return jsonError("Đã cắt layer từ master này — tạo bộ mới để đổi master", 409);
    const { data } = await s.supabase.from(CT_TABLES.charProjects).update({ master_id: null, status: "brief", cut: null }).eq("id", id).select("*").single<CtCharProject>();
    await ctRemove(cutPaths(p.cut));
    return NextResponse.json({ project: data ? projectRow(data) : p });
  }
  if (typeof imageId !== "string" || !UUID.test(imageId)) return jsonError("imageId không hợp lệ", 400);
  const { data: im } = await s.supabase.from(CT_TABLES.charImages).select("*").eq("id", imageId).eq("project_id", id).maybeSingle<CtCharImage>();
  if (!im || im.kind !== "master" || im.status !== "done") return jsonError("Chỉ duyệt được master đã tạo xong", 400);
  // Another master: the backdrop / regions reviewed on the old one no longer fit.
  const changed = p.master_id !== im.id;
  const { data, error } = await s.supabase.from(CT_TABLES.charProjects).update({ master_id: im.id, status: "master", ...(changed ? { cut: null } : {}) }).eq("id", id).select("*").single<CtCharProject>();
  if (error || !data) return jsonError(error?.message ?? "Không lưu được", 500);
  if (changed) await ctRemove(cutPaths(p.cut));
  return NextResponse.json({ project: projectRow(data) });
}

/** The approved master's pixels (layers, align checks). */
export async function masterFile(db: Db, p: CtCharProject): Promise<{ image: CtCharImage; data: Buffer } | null> {
  if (!p.master_id) return null;
  const { data: im } = await db.from(CT_TABLES.charImages).select("*").eq("id", p.master_id).maybeSingle<CtCharImage>();
  if (!im?.url) return null;
  return { image: im, data: await fetchImage(im.url) };
}
