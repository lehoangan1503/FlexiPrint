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
 *   POST   char/projects/:id/masters   {prompt?, count?} → { images } (1024×1024) status running, then done / failed
 *   POST   char/projects/:id/masters/:imageId/refine {note} → { image } an in-place edit of that master
 *   POST   char/projects/:id/approve   {imageId | null} → { project } the master every layer is cut from
 *   POST   char/projects/:id/khuon     server/char/khuon.ts — the editor's khuôn picture → a khuôn; {} → the AI one
 *   POST   char/projects/:id/edits     server/char/layers.ts — in-place edits the brief needs
 *   POST   char/projects/:id/layers    server/char/layers.ts — cut the layer set (services/layer-kit)
 *   POST   char/projects/:id/products  server/char/product.ts — a draft product from the set (one set, many products)
 *   (mockups of a set's product: the product's own, server/product-mockups.ts — POST products/:id/mockups)
 *
 * Every picture — masters, refinements, layer edits, mockup scenes — is GPT Image 2.5 on the company API, no other
 * model; masters and the edits layers are cut from come on a transparent background (the AI's cut-out is the matte). GPT Image moves what it keeps (≈ 0.2 % scale per axis + up to ~0.7 px per character): layer-kit
 * registers every edit back onto the master (affine + smoothed local flow, ≤ 0.4 px left — measured 2026-10-08).
 */

import { NextResponse } from "next/server";
import { CT_TABLES } from "../../config";
import type { CtAsset, CtCharBrief, CtCharCutState, CtCharIdeaRound, CtCharImage, CtCharImageKind, CtCharMask, CtCharProject, CtCharRef, CtCharRefUse } from "../../types";
import { REF_USE_INFO, masterBriefKey, masterPrompt, parseCharBrief, setAspect } from "../../lib/char-brief";
import { CT_IMAGE_MODEL } from "../../lib/image-models";
import { drawImage } from "../pack-images";
import { ctServiceClient, type CtSession } from "../supabase";
import { ctRemove } from "../storage";
import { fetchImage, saveCharFile, saveChatFile } from "./files";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILE = 30 * 1024 * 1024;

/** Every picture: GPT Image 2.5, tried twice — no other model (asked 2026-10-12). */
export const DRAW_MODELS = [CT_IMAGE_MODEL, CT_IMAGE_MODEL];

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
    for (const pic of cut.plan.pictures) if (pic.id !== "master") out.push(pic.colourPath, pic.previewPath, pic.alphaPath ?? "");
    for (const pc of cut.plan.pieces) out.push(...maskPaths(pc.region));
  }
  return out.filter(Boolean);
}

export async function loadProject(db: Db, id: string): Promise<CtCharProject | null> {
  if (!UUID.test(id)) return null;
  const { data } = await db.from(CT_TABLES.charProjects).select("*").eq("id", id).maybeSingle<CtCharProject>();
  return data ? projectRow(data) : null;
}

/** When this server process started: pictures are drawn in-process, so one still "running" from before is lost. */
const BOOTED_AT = Date.now();
const LOST_ON_RESTART = "Máy chủ khởi động lại khi đang vẽ — vẽ lại ảnh này";
/** A draw is ≤ 300 s per model tried + the 120 s measure, a long queue waits ~30 min: a row untouched for longer hung (a swapping VPS, 2026-10-18). */
const STALE_MS = 45 * 60_000;
const HUNG = "Ảnh treo quá lâu (máy chủ quá tải) — vẽ lại ảnh này";

export async function loadImages(db: Db, projectId: string): Promise<CtCharImage[]> {
  const { data } = await db.from(CT_TABLES.charImages).select("*").eq("project_id", projectId).order("created_at", { ascending: true }).returns<CtCharImage[]>();
  const images = data ?? [];
  // A deploy in the middle of a run left rows "running" for ever: nothing could redraw them ("Bản sửa này đang
  // chạy") and every wait timed out (2026-10-18). One app instance, so a row started before it booted is orphaned.
  // A row is touched when its draw starts (the source is written first), so a long queue does not count as hung.
  const now = Date.now();
  for (const [error, lost] of [
    [LOST_ON_RESTART, images.filter((im) => im.status === "running" && Date.parse(im.created_at) < BOOTED_AT)],
    [HUNG, images.filter((im) => im.status === "running" && Date.parse(im.created_at) >= BOOTED_AT && now - Date.parse(im.updated_at) > STALE_MS)],
  ] as const) {
    if (!lost.length) continue;
    await db.from(CT_TABLES.charImages).update({ status: "failed", error }).in("id", lost.map((im) => im.id));
    for (const im of lost) Object.assign(im, { status: "failed", error });
  }
  return images;
}

/** Whether the caller may change the set: its owner, or an admin (RLS ct_is_admin lets admins write too). */
export async function canEditProject(s: CtSession, p: CtCharProject): Promise<boolean> {
  if (!p.user_id || p.user_id === s.user.id) return true;
  const { data: admin } = await s.supabase.rpc("ct_is_admin");
  return admin === true;
}

export const NOT_YOURS = "Bộ nhân vật của người khác — chỉ xem";

/** The project when the caller may change it (owner or admin). */
async function ownProject(s: CtSession, id: string): Promise<CtCharProject | NextResponse> {
  const p = await loadProject(s.supabase, id);
  if (!p) return jsonError("Không tìm thấy bộ nhân vật", 404);
  if (!(await canEditProject(s, p))) return jsonError(NOT_YOURS, 403);
  return p;
}

/** GET char/projects */
export async function listCharProjects(s: CtSession): Promise<NextResponse> {
  const { data, error } = await s.supabase.from(CT_TABLES.charProjects).select("*").order("updated_at", { ascending: false }).limit(200).returns<CtCharProject[]>();
  if (error) return jsonError(error.message, 500);
  // A version set (one version of a lineup drawn version by version) is shown on its parent's page, not here.
  const projects = (data ?? []).map(projectRow).filter((p) => !p.brief.versionOf);
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
  // A set drawn pose by pose has no master of its own: its product's first mockup ("Chưa có master" on a finished
  // set, 2026-10-22).
  const bare = projects.filter((p) => !thumbs[p.id] && p.product_ids.length);
  if (bare.length) {
    const { data: fronts } = await s.supabase
      .from(CT_TABLES.assets)
      .select("product_id, url, name")
      .in("product_id", bare.flatMap((p) => p.product_ids))
      .eq("role", "mockup")
      .order("created_at", { ascending: true })
      .returns<Array<Pick<CtAsset, "product_id" | "url" | "name">>>();
    for (const p of bare) thumbs[p.id] = (fronts ?? []).find((f) => f.product_id && p.product_ids.includes(f.product_id))?.url ?? "";
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
    // The 3b plan is the agent's (char_plan_pictures): a page holding an older brief never drops or rolls it back.
    patch.brief = { ...parseCharBrief(b.brief), pictures: parseCharBrief(p.brief).pictures ?? null };
    // The edits, the plan and the layers hang on the brief's slot / option ids: once a master is approved that part
    // is frozen (texts, backgrounds, mockup scenes, material — step 4 — stay editable).
    if (p.master_id && masterBriefKey(patch.brief) !== masterBriefKey(parseCharBrief(p.brief))) return jsonError("Master đã duyệt — brief bị khoá (trừ chữ, nền, mockup, vật liệu). Bỏ duyệt master (về bước Master) nếu muốn đổi brief", 409);
  }
  const { data, error } = await s.supabase.from(CT_TABLES.charProjects).update(patch).eq("id", id).select("*").single<CtCharProject>();
  if (error || !data) return jsonError(error?.message ?? "Không lưu được", 500);
  return NextResponse.json({ project: projectRow(data) });
}

/** DELETE char/projects/:id */
export async function deleteCharProject(s: CtSession, id: string): Promise<NextResponse> {
  const p = await ownProject(s, id);
  if (p instanceof NextResponse) return p;
  // Its version sets (a lineup drawn version by version) go with it.
  const { data: kids } = await s.supabase.from(CT_TABLES.charProjects).select("*").eq("brief->versionOf->>id", id).returns<CtCharProject[]>();
  for (const k of [...(kids ?? []), p]) {
    const images = await loadImages(s.supabase, k.id);
    const { error } = await s.supabase.from(CT_TABLES.charProjects).delete().eq("id", k.id);
    if (error) return jsonError(error.message, 500);
    await ctRemove([...images.flatMap((im) => [im.storage_path, im.thumb_path]), ...cutPaths(k.cut), k.layers?.diffPath ?? ""].filter(Boolean));
  }
  return NextResponse.json({ ok: true });
}

/** POST char/projects/:id/chat-files — a screenshot / picture for the sticky chat → { url, width, height }. */
export async function uploadChatFile(s: CtSession, id: string, form: FormData): Promise<NextResponse> {
  const p = await ownProject(s, id);
  if (p instanceof NextResponse) return p;
  const file = form.get("file");
  if (!(file instanceof Blob) || file.size === 0) return jsonError("Thiếu ảnh", 400);
  if (file.size > MAX_FILE) return jsonError("Ảnh quá lớn (tối đa 30 MB)", 413);
  try {
    return NextResponse.json(await saveChatFile(s.user.id, id, Buffer.from(await file.arrayBuffer())), { status: 201 });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Upload thất bại", 400);
  }
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

/** "w:h" of the picture an edit is made from (gpt-image picks its canvas from it). */
function editAspect(w: number | null, h: number | null): string {
  return w && h ? `${w}:${h}` : "1:1";
}

export interface CharDraw {
  prompt: string;
  /** Reference picture urls, in order. An in-place edit: the picture being edited first. */
  refs: string[];
  /** Fixed aspect (new picture) or null (an edit: keep the first ref's). */
  aspect: string | null;
  refSize: { w: number | null; h: number | null };
  /** A transparent background: the picture comes cut out (no matting of ours — asked 2026-10-12). */
  transparent?: boolean;
}

/** Draw one picture into an existing running row → done / failed. Never throws. */
export async function runCharDraw(db: Db, userId: string, row: CtCharImage, d: CharDraw): Promise<CtCharImage | null> {
  let lastError = "";
  // Transparent: gpt-image now and then paints the background anyway (refused by drawImage) — three tries then.
  const models = d.transparent ? [...DRAW_MODELS, CT_IMAGE_MODEL] : DRAW_MODELS;
  for (const model of models) {
    try {
      const out = await drawImage(model, d.prompt, d.refs, d.aspect ?? editAspect(d.refSize.w, d.refSize.h), "pad", d.transparent === true);
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

// Every picture of a set is on ONE canvas (asked 2026-10-12: one ratio — whoever is tall or short fits in it): the
// master and every edit of it land on the same pixels; layer-kit only undoes the model's own drift. 1024×1024, or
// 1536×1024 for a row of 4+ characters (lib/char-brief setAspect, 2026-10-18).

export interface MasterDrawArgs {
  /** The full prompt (the style-reference line is added here); "" = assembled from the brief. */
  prompt: string;
  count: number;
  /** The @flexiprint task that asked for it (shown with the image, its progress lists it). */
  taskId?: string | null;
}

/** Master candidates: rows "running" now, drawn in the background. Throws with a message for the editor. */
export async function drawMasters(db: Db, userId: string, p: CtCharProject, a: MasterDrawArgs): Promise<CtCharImage[]> {
  if (p.master_id) throw new Error("Master đã duyệt — bỏ duyệt trước khi tạo master mới");
  const prompt = a.prompt.trim().slice(0, 8000) || masterPrompt(p.brief);
  if (p.brief.kind !== "photo" && !p.brief.subjects.length && !a.prompt.trim()) throw new Error("Brief chưa có nhân vật");
  const count = Math.min(Math.max(Math.round(a.count) || 2, 1), 4);
  const images = await loadImages(db, p.id);
  const { urls: refs, text } = modelRefs(p.brief, images);
  const full = text + prompt;
  const meta = (i: number) => ({ candidate: i + 1, ...(a.taskId ? { taskId: a.taskId } : {}) });
  const rows = Array.from({ length: count }, (_, i) => ({ project_id: p.id, user_id: userId, kind: "master" as CtCharImageKind, role: "master", status: "running", prompt: full, meta: meta(i) }));
  const { data, error } = await db.from(CT_TABLES.charImages).insert(rows).select("*").returns<CtCharImage[]>();
  if (error || !data) throw new Error(error?.message ?? "Không tạo được");
  // Drawn cut out (transparent): the AI's own cut-out is the matte (step 3a) — no bg-remover (asked 2026-10-12).
  // A bộ ảnh khách's master is the whole flat design, its background included.
  for (const row of data) void runCharDraw(db, userId, row, { prompt: full, refs, aspect: setAspect(p.brief), refSize: { w: null, h: null }, transparent: p.brief.kind !== "photo" });
  return data;
}

/**
 * One master preview per brainstorm idea (asked 2026-10-09: the editor sees each direction drawn before choosing):
 * the idea's own brief as a master prompt, with the project's reference pictures. Rows are masters with role
 * "idea:<idea id>" — the master step lists only "master" ones; taking the idea adopts its preview (adoptMaster).
 */
export async function drawIdeaPreviews(db: Db, userId: string, p: CtCharProject, round: CtCharIdeaRound): Promise<CtCharImage[]> {
  if (!round.ideas.length) return [];
  const images = await loadImages(db, p.id);
  const rows = round.ideas.map((idea) => {
    const brief = { ...idea.brief, refs: p.brief.refs };
    const { text } = modelRefs(brief, images);
    return { project_id: p.id, user_id: userId, kind: "master" as CtCharImageKind, role: `idea:${idea.id}`, status: "running", prompt: text + masterPrompt(brief), note: idea.title, meta: { ideaId: idea.id, roundId: round.id } };
  });
  const { data, error } = await db.from(CT_TABLES.charImages).insert(rows).select("*").returns<CtCharImage[]>();
  if (error || !data) throw new Error(error?.message ?? "Không tạo được");
  data.forEach((row, i) => {
    const brief = { ...round.ideas[i].brief, refs: p.brief.refs };
    const { urls } = modelRefs(brief, images);
    void runCharDraw(db, userId, row, { prompt: row.prompt, refs: urls, aspect: setAspect(brief), refSize: { w: null, h: null }, transparent: brief.kind !== "photo" });
  });
  return data;
}

/** An idea's preview becomes a master candidate of the project (the editor took that direction). */
export async function adoptMaster(s: CtSession, id: string, imageId: string): Promise<NextResponse> {
  const p = await ownProject(s, id);
  if (p instanceof NextResponse) return p;
  const { data, error } = await jobDb(s).from(CT_TABLES.charImages).update({ role: "master" }).eq("id", imageId).eq("project_id", id).eq("kind", "master").select("*").maybeSingle<CtCharImage>();
  if (error) return jsonError(error.message, 500);
  if (!data) return jsonError("Không tìm thấy ảnh", 404);
  return NextResponse.json({ image: data });
}

/** POST char/projects/:id/masters */
export async function generateMasters(s: CtSession, id: string, body: unknown): Promise<NextResponse> {
  const p = await ownProject(s, id);
  if (p instanceof NextResponse) return p;
  const b = (body && typeof body === "object" ? body : {}) as { prompt?: unknown; count?: unknown };
  try {
    const images = await drawMasters(jobDb(s), s.user.id, p, { prompt: typeof b.prompt === "string" ? b.prompt : "", count: Number(b.count) || 2 });
    return NextResponse.json({ images }, { status: 202 });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không tạo được", 400);
  }
}

export const KEEP_REFINE =
  " Change ONLY what is asked. Keep everything else exactly as it is: the same characters, faces, poses, clothes, colours, " +
  "composition, position, size, framing, art style and the fully transparent background. Do not move, zoom or crop.";

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
  void runCharDraw(db, userId, row, { prompt, refs: [parent.url], aspect: null, refSize: { w: parent.width, h: parent.height }, transparent: p.brief.kind !== "photo" });
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
  try {
    return NextResponse.json({ project: await setApprovedMaster(s.supabase, p, imageId) });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không lưu được", 400);
  }
}

/** Approve a finished master of the set (the page's "Duyệt", or @flexiprint when the editor handed it the whole set).
 * Throws a message when it cannot. */
export async function setApprovedMaster(db: Db, p: CtCharProject, imageId: string): Promise<CtCharProject> {
  if (p.master_id !== imageId && (p.status === "layers" || p.status === "product")) throw new Error("Đã cắt layer từ master khác — tạo bộ mới để đổi master");
  const { data: im } = await db.from(CT_TABLES.charImages).select("*").eq("id", imageId).eq("project_id", p.id).maybeSingle<CtCharImage>();
  if (!im || im.kind !== "master" || im.status !== "done") throw new Error("Chỉ duyệt được master đã tạo xong");
  // Another master: the backdrop / regions reviewed on the old one no longer fit.
  const changed = p.master_id !== im.id;
  const { data, error } = await db.from(CT_TABLES.charProjects).update({ master_id: im.id, status: p.status === "brief" ? "master" : p.status, ...(changed ? { cut: null, status: "master" } : {}) }).eq("id", p.id).select("*").single<CtCharProject>();
  if (error || !data) throw new Error(error?.message ?? "Không lưu được");
  if (changed) await ctRemove(cutPaths(p.cut));
  return projectRow(data);
}

/** The approved master's pixels (layers, align checks). */
export async function masterFile(db: Db, p: CtCharProject): Promise<{ image: CtCharImage; data: Buffer } | null> {
  if (!p.master_id) return null;
  const { data: im } = await db.from(CT_TABLES.charImages).select("*").eq("id", p.master_id).maybeSingle<CtCharImage>();
  if (!im?.url) return null;
  return { image: im, data: await fetchImage(im.url) };
}
