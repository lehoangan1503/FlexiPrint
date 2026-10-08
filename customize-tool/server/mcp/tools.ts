/**
 * flexiprint-mcp tools. Three callers (server/mcp/server.ts decides who is calling):
 *   - "agent"  — the @flexiprint agent on agent_ide (Bearer CT_AGENT_TOKEN): everything, tasks included;
 *   - "studio" — the ComfyUI node pack (Bearer CT_COMFY_TOKEN): library reads;
 *   - "user"   — a signed-in editor (cookie): library reads with their own rights.
 * Reads go through `db` (the service client for agent / studio, the user's client otherwise). A web-app task is
 * answered with submit_result (the editor approves it); a person asking the agent directly on agent_ide gets
 * saved changes (server/mcp/write-tools.ts — checked, history kept, restorable).
 */

import { CT_TABLES } from "../../config";
import { normalizeCategoryRules } from "../../lib/library";
import type { CtAgentQuestion, CtAgentTask, CtAgentTaskProgress, CtAgentTaskRun, CtAsset, CtPackImage, CtPackImageResult, CtContentResult, CtCategoryRevision, CtCategoryHistoryEntry, CtCategorySnapshot, CtClipartCategory, CtMaterialSpec, CtStudioRunBody, CtStudioRunStatus } from "../../types";
import { normalizeMaterialSpecs } from "../../lib/materials";
import { isOwnUploadUrl } from "../library";
import * as studio from "../studio";
import type { CtServiceClient } from "../supabase";
import { CT_LIBRARY_TOOLS, loadLibraryCatalog, type CtLibraryCatalog, type LibraryDb } from "../ai/library-tools";
import { flatPrompt, lintCategory, materialPrompts, type ReviewInput } from "../ai/prompt-review";
import { buildRevision, revisionContext, suggestionFromAgent, type RevisionContext } from "../ai/prompt-writer";
import { clip, record, str } from "../ai/llm";
import { CT_MCP_WRITE_TOOLS } from "./write-tools";
import sharp from "sharp";
import { drawPackImage, mirrorPackImage, touchCollection } from "../pack-images";
import { packBases } from "../../lib/file-name";
import { CT_MCP_CHAR_TOOLS, charTaskView, submitCharResult } from "./char-tools";
import { TASK_ARG, json, liveStatus, loadTask, openQuestion, openTask, patchTask } from "./task-common";

export type CtMcpCaller = "agent" | "studio" | "user";

export interface CtMcpContext {
  db: LibraryDb;
  /** The service client — agent only (tasks). */
  service: CtServiceClient | null;
  caller: CtMcpCaller;
}

interface JsonSchema {
  type: "object";
  properties: Record<string, { type: string; description: string; items?: { type: string } }>;
  required?: string[];
}

/** A tool's answer: JSON (shown to the model as text) or images. */
export type CtMcpOutput = { json: unknown } | { images: Array<{ data: string; mimeType: string; url: string }> };

export interface CtMcpTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Who may call it. */
  callers: CtMcpCaller[];
  run: (ctx: CtMcpContext, args: Record<string, unknown>) => Promise<CtMcpOutput>;
}

const ALL: CtMcpCaller[] = ["agent", "studio", "user"];
const AGENT: CtMcpCaller[] = ["agent"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORY_ARG = { type: "string", description: "The category's id or exact name." };

type CategoryRow = Pick<CtClipartCategory, "id" | "name" | "usage" | "mode" | "spec" | "rules" | "parent_id" | "updated_at">;

async function findCategory(db: LibraryDb, ref: unknown): Promise<CategoryRow> {
  const key = str(ref);
  if (!key) throw new Error("category is required");
  const { data, error } = await db
    .from(CT_TABLES.categories)
    .select("id,name,usage,mode,spec,rules,parent_id,updated_at")
    .eq(UUID.test(key) ? "id" : "name", key)
    .limit(1)
    .maybeSingle<CategoryRow>();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`No category "${key}" — list_categories shows them`);
  return { ...data, rules: normalizeCategoryRules(data.rules) };
}



// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

const libraryTools: CtMcpTool[] = CT_LIBRARY_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema as JsonSchema,
  callers: ALL,
  run: async (ctx, args) => json(await t.run(await loadLibraryCatalog(ctx.db), args, ctx.db)),
}));

/** Thư viện ảnh tổ hợp (server/pack-images.ts): photos editors put in tổ hợp — check here before searching or generating. */
const packImageTools: CtMcpTool[] = [
  {
    name: "list_pack_images",
    description:
      "The tổ hợp photo library (thư viện ảnh tổ hợp): backgrounds, scenes, hands, props editors uploaded or made with AI for mockups, newest first. Look here first when a mockup needs a photo — only search the web or generate when nothing fits. AI ones carry the editor's description and the prompt that made them. Urls can be opened with view_image.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional words matched against the name and the AI description." },
        source: { type: "string", description: "Optional: \"upload\" or \"ai\"." },
        limit: { type: "number", description: "Max rows (default 40)." },
      },
    },
    callers: ALL,
    run: async (ctx, args) => {
      const limit = Math.min(Math.max(Number(args.limit) || 40, 1), 200);
      let q = ctx.db
        .from(CT_TABLES.packImages)
        .select("id,name,source,url,width,height,transparent,description,prompt,created_at")
        .eq("status", "done")
        .eq("listed", true)
        .order("created_at", { ascending: false })
        .limit(limit);
      const source = str(args.source);
      if (source === "upload" || source === "ai") q = q.eq("source", source);
      const words = str(args.query).trim().replace(/[%_,()]/g, " ");
      if (words) q = q.or(`name.ilike.%${words}%,description.ilike.%${words}%`);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json({ images: data ?? [] });
    },
  },
];

const categoryTools: CtMcpTool[] = [
  {
    name: "list_categories",
    description: "Every clipart category: id, name, spec (clipped), style pack / material names, details count. Start here.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Optional words to filter by name / spec." } } },
    callers: ALL,
    run: async (ctx, args) => {
      const [{ data, error }, cat] = await Promise.all([
        ctx.db.from(CT_TABLES.categories).select("id,name,usage,mode,spec,rules,parent_id,updated_at").order("sort_order").order("name").returns<CategoryRow[]>(),
        loadLibraryCatalog(ctx.db),
      ]);
      if (error) throw new Error(error.message);
      const words = str(args.query).toLowerCase().split(/\s+/).filter(Boolean);
      return json(
        (data ?? [])
          .filter((c) => words.every((w) => `${c.name} ${c.spec}`.toLowerCase().includes(w)))
          .map((c) => {
            const r = normalizeCategoryRules(c.rules);
            return {
              id: c.id,
              name: c.name,
              usage: c.usage,
              spec: clip(c.spec, 300),
              stylePack: cat.stylePacks.find((p) => p.id === r.stylePackId)?.name ?? null,
              materials: r.materialIds.map((id) => cat.materials.find((m) => m.id === id)?.name ?? id),
              details: r.details.length,
              productPhotos: r.productRefs.length,
              updatedAt: c.updated_at,
            };
          }),
      );
    },
  },
  {
    name: "get_category",
    description:
      "A category in full: spec, rules (details, reference photos, product photos, the editor's details note, framing), its style pack and materials with full prompts and the other categories sharing them.",
    inputSchema: { type: "object", properties: { category: CATEGORY_ARG }, required: ["category"] },
    callers: ALL,
    run: async (ctx, args) => {
      const c = await findCategory(ctx.db, args.category);
      const cat = await loadLibraryCatalog(ctx.db);
      const others = (list: string[]) => list.filter((n) => n !== c.name);
      const style = cat.stylePacks.find((p) => p.id === c.rules.stylePackId) ?? null;
      return json({
        id: c.id,
        name: c.name,
        usage: c.usage,
        mode: c.mode,
        spec: c.spec,
        updatedAt: c.updated_at,
        stylePack: style ? { id: style.id, name: style.name, prompt: style.prompt, alsoUsedBy: others(style.usedBy), updatedAt: style.updatedAt } : null,
        materials: c.rules.materialIds.map((id) => {
          const m = cat.materials.find((x) => x.id === id);
          return m ? { id: m.id, name: m.name, art: m.art, prompt: m.prompt, alsoUsedBy: others(m.usedBy), updatedAt: m.updatedAt } : { id, missing: true };
        }),
        shape: c.rules.shape,
        details: c.rules.details,
        detailsNote: c.rules.detailsNote,
        designRefs: c.rules.refs,
        productRefs: c.rules.productRefs,
        framing: { canvas: c.rules.canvas, fill: c.rules.fill, anchor: c.rules.anchor, background: c.rules.background, lockSilhouette: c.rules.lockSilhouette },
      });
    },
  },
  {
    name: "list_cliparts",
    description:
      "A category's cliparts as a tree: each origin (gốc) with its children — variants (đa sắc) and renditions (material versions: meta.material, meta.materialVersion). Urls can be opened with view_image.",
    inputSchema: {
      type: "object",
      properties: { category: CATEGORY_ARG, query: { type: "string", description: "Optional words to filter origins by name." }, limit: { type: "number", description: "Max origins (default 30)." } },
      required: ["category"],
    },
    callers: ALL,
    run: async (ctx, args) => {
      const c = await findCategory(ctx.db, args.category);
      const cols = "id,name,role,url,spec,meta,parent_id,created_at";
      type Row = Pick<CtAsset, "id" | "name" | "role" | "url" | "spec" | "meta" | "parent_id" | "created_at">;
      const { data: origins, error } = await ctx.db
        .from(CT_TABLES.assets)
        .select(cols)
        .eq("category_id", c.id)
        .is("product_id", null)
        .is("parent_id", null)
        .order("created_at")
        .returns<Row[]>();
      if (error) throw new Error(error.message);
      const words = str(args.query).toLowerCase().split(/\s+/).filter(Boolean);
      const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
      const picked = (origins ?? []).filter((o) => words.every((w) => o.name.toLowerCase().includes(w))).slice(0, limit);
      const kidsOf = async (ids: string[]): Promise<Row[]> => {
        if (!ids.length) return [];
        const { data } = await ctx.db.from(CT_TABLES.assets).select(cols).in("parent_id", ids).order("created_at").returns<Row[]>();
        return data ?? [];
      };
      const kids = await kidsOf(picked.map((o) => o.id));
      const grand = await kidsOf(kids.map((k) => k.id));
      const node = (r: Row, pool: Row[]): Record<string, unknown> => ({
        id: r.id,
        name: r.name,
        role: r.role,
        url: r.url,
        ...(r.spec ? { spec: r.spec } : {}),
        ...(Object.keys(r.meta ?? {}).length ? { meta: r.meta } : {}),
        createdAt: r.created_at,
        children: pool.filter((k) => k.parent_id === r.id).map((k) => node(k, grand)),
      });
      return json({ category: c.name, origins: picked.map((o) => node(o, kids)) });
    },
  },
  {
    name: "get_history",
    description: "A category's history, newest first: every AI revision (the editor's note, the images they looked at, the plan) and every save. Read it to see what was already tried.",
    inputSchema: { type: "object", properties: { category: CATEGORY_ARG, limit: { type: "number", description: "Max rows (default 10)." } }, required: ["category"] },
    callers: ALL,
    run: async (ctx, args) => {
      const c = await findCategory(ctx.db, args.category);
      const { data, error } = await ctx.db
        .from(CT_TABLES.categoryHistory)
        .select("*")
        .eq("category_id", c.id)
        .order("created_at", { ascending: false })
        .limit(Math.min(Math.max(Number(args.limit) || 10, 1), 50))
        .returns<CtCategoryHistoryEntry[]>();
      if (error) throw new Error(error.message);
      return json((data ?? []).map((h) => ({ id: h.id, event: h.event, at: h.created_at, note: h.note, refUrls: h.ref_urls, imageUrls: h.image_urls, model: h.model, result: h.result })));
    },
  },
  {
    name: "view_image",
    description: "Look at images of the library (cliparts, renditions, reference / product photos, tổ hợp photos): up to 4 urls from the other tools. Shown at ≤ 1568 px; transparent areas appear mid grey.",
    inputSchema: { type: "object", properties: { urls: { type: "array", items: { type: "string" }, description: "Image urls (FlexiPrint storage only)." } }, required: ["urls"] },
    callers: ALL,
    run: async (_ctx, args) => {
      const urls = (Array.isArray(args.urls) ? args.urls : [args.urls]).map(str).filter(isOwnUploadUrl).slice(0, 4);
      if (!urls.length) throw new Error("No FlexiPrint image url given");
      const images = await Promise.all(
        urls.map(async (url) => {
          const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
          const type = res.headers.get("content-type") ?? "";
          if (!res.ok || !type.startsWith("image/")) throw new Error(`${url}: ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          // Sized for looking (≤ 1568 px — what the model sees anyway): a 2K PNG layer is 5–8 MB, which the agent's
          // client refuses — so it never saw its own results. Transparent pixels show on mid grey, so a cut-out's
          // edge is visible.
          const view = await sharp(buf)
            .resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true })
            .flatten({ background: "#808080" })
            .jpeg({ quality: 85 })
            .toBuffer();
          return { data: view.toString("base64"), mimeType: "image/jpeg", url };
        }),
      );
      return { images };
    },
  },
];

// ---------------------------------------------------------------------------
// Prompts as the image models get them
// ---------------------------------------------------------------------------

interface DraftArgs {
  spec?: unknown;
  style_prompt?: unknown;
  details?: unknown;
  materials?: unknown;
}

function reviewInputOf(c: CategoryRow, draft: DraftArgs, cat: CtLibraryCatalog): ReviewInput {
  const others = (list: string[]) => list.filter((n) => n !== c.name);
  const style = cat.stylePacks.find((p) => p.id === c.rules.stylePackId) ?? null;
  const draftMaterials = Array.isArray(draft.materials) ? draft.materials.map(record) : null;
  const materials = draftMaterials
    ? draftMaterials.map((m, i) => {
        const lib = cat.materials.find((x) => x.id === str(m.id)) ?? null;
        return {
          key: `M${i + 1}`,
          name: str(m.name) || lib?.name || `material ${i + 1}`,
          prompt: str(m.prompt) || lib?.prompt || "",
          art: (str(m.art) || lib?.art) === "surface" ? ("surface" as const) : ("print" as const),
          usedByOthers: lib ? others(lib.usedBy) : [],
        };
      })
    : c.rules.materialIds
        .map((id) => cat.materials.find((m) => m.id === id))
        .filter((m): m is NonNullable<typeof m> => Boolean(m))
        .map((m, i) => ({ key: `M${i + 1}`, name: m.name, prompt: m.prompt, art: m.art === "surface" ? ("surface" as const) : ("print" as const), usedByOthers: others(m.usedBy) }));
  const details: CtMaterialSpec[] = draft.details !== undefined ? normalizeMaterialSpecs(draft.details) : c.rules.details;
  return {
    name: c.name,
    usage: c.usage,
    spec: str(draft.spec) || c.spec,
    style: str(draft.style_prompt) ? { name: style?.name ?? "draft", prompt: str(draft.style_prompt), usedByOthers: [] } : style ? { name: style.name, prompt: style.prompt, usedByOthers: others(style.usedBy) } : null,
    materials,
    rules: { ...c.rules, details },
  };
}

const promptTools: CtMcpTool[] = [
  {
    name: "assemble_prompts",
    description:
      "The EXACT prompts the image models receive for a category — the flat drawing and every material pass (base + one edit per 'version' detail) — plus automatic lint leads. Pass a draft (any of spec / style_prompt / details / materials) to see your change assembled before you submit it.",
    inputSchema: {
      type: "object",
      properties: {
        category: CATEGORY_ARG,
        spec: { type: "string", description: "Draft spec (replaces the saved one)." },
        style_prompt: { type: "string", description: "Draft style pack prompt." },
        details: { type: "array", items: { type: "object" }, description: "Draft details [{text, mode, label}]." },
        materials: { type: "array", items: { type: "object" }, description: "Draft materials [{id?, name?, prompt?, art?}] — id alone = that library material." },
      },
      required: ["category"],
    },
    callers: ALL,
    run: async (ctx, args) => {
      const c = await findCategory(ctx.db, args.category);
      const input = reviewInputOf(c, args, await loadLibraryCatalog(ctx.db));
      return json({ flat: flatPrompt(input), materials: input.materials.flatMap((m) => materialPrompts(input, m)), leads: lintCategory(input) });
    },
  },
];

// ---------------------------------------------------------------------------
// Studio (ComfyUI)
// ---------------------------------------------------------------------------

async function bodyOf(res: Response): Promise<unknown> {
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(str(out.error) || `HTTP ${res.status}`);
  return out;
}

/** How long one wait_run call holds before answering "still running" (nginx cuts /api/ at 600 s). */
const WAIT_MS = 170_000;
const POLL_MS = 5_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runStatus(db: LibraryDb, runId: string): Promise<CtStudioRunStatus> {
  return (await bodyOf(await studio.studioRunStatus(db, runId))) as CtStudioRunStatus;
}

/** What a run makes, in the editor's words. */
function runLabel(recipe: string, params: Record<string, unknown>): string {
  const names = (list: unknown, key = "name") => (Array.isArray(list) ? list.map(record).map((x) => str(x[key])).filter(Boolean) : []);
  const what = { origin: "clipart gốc", refine: "sửa clipart", variant: "đa sắc", material: "vật liệu" }[recipe] ?? recipe;
  const list = recipe === "origin" ? names(params.subjects) : recipe === "variant" ? names(params.variants) : names(params.targets);
  return clip(`${what}${params.draft ? " (prompt nháp)" : ""}${list.length ? `: ${list.join(", ")}` : ""}`, 200);
}

/** A material run's draft: prompts proposed but not saved, checked here before ComfyUI sees them. */
function materialDraft(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const d = record(raw);
  const out: Record<string, unknown> = {};
  if (str(d.material_prompt)) out.material_prompt = clip(str(d.material_prompt), 4000);
  if (Array.isArray(d.details)) out.details = normalizeMaterialSpecs(d.details);
  if (Array.isArray(d.product_refs)) out.product_refs = d.product_refs.map(str).filter(isOwnUploadUrl).slice(0, 6);
  return Object.keys(out).length ? out : null;
}

const studioTools: CtMcpTool[] = [
  {
    name: "list_models",
    description: "Image models the studio knows. Every run uses the team's pick from the home page (params.model is overridden server-side).",
    inputSchema: { type: "object", properties: {} },
    callers: AGENT,
    run: async () => json(await bodyOf(await studio.studioModels())),
  },
  {
    name: "run_studio",
    description: [
      "Make images with the studio (ComfyUI; the team's image model from the home page — billed; a material run takes ~5 min). Returns run_id, then call wait_run (it waits for you). Results are saved into the library like the web app's.",
      "Working on a web-app task: pass task_id — the editor sees the run live, and submit_result is refused until every run of the task has finished.",
      "Recipes and their params:",
      '- origin: new origins of a category. {category_id, style_pack_id: null (category default), material_id: null | "none" | id, material_extra: "", material_ids?: [ids → also make those material versions], note: "", subjects: [{name, text}], model: "", chain_reference: true, cutout: "category", rules: {}, tags: []}',
      '- refine: edit origins. {targets: [{clipart_id, name, edit?, spec?}], instruction, keep, refs: [], model: "", cutout: "category"}',
      '- variant: đa sắc of an origin. {clipart_id, variants: [{name, text: "#hex" or a change, mode?: "recolor" | "ai"}], method: "auto", lock_silhouette: true, model: ""}',
      '- material: material versions. {material_id, targets: [{clipart_id, name}], lock: "preset", edge_px: 0, extra: "", model: "", draft?: {material_prompt?, details?: [{text, mode, label}], product_refs?: [urls]}}',
      "  draft = test YOUR PROPOSED prompts without saving: they replace the material preset's prompt / the category's details / product photos for this run only; the images are saved named \"… · thử\". Use it to check a details or material change before you submit it.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        recipe: { type: "string", description: "origin | refine | variant | material" },
        params: { type: "object", description: "The recipe's params (see description)." },
        task_id: { type: "string", description: "The web-app task this run is for (shown to the editor; must finish before submit_result)." },
      },
      required: ["recipe", "params"],
    },
    callers: AGENT,
    run: async (ctx, args) => {
      const recipe = str(args.recipe);
      if (!["origin", "refine", "variant", "material"].includes(recipe)) throw new Error("recipe: origin | refine | variant | material");
      const params = { ...record(args.params) };
      delete params.draft;
      const draft = recipe === "material" ? materialDraft(record(args.params).draft) : null;
      if (draft) params.draft = draft;
      const owner = str(args.task_id) ? await loadTask(ctx, args.task_id) : null;
      if (owner) openTask(owner.task);
      const out = record(await bodyOf(await studio.studioRun({ recipe, params } as unknown as CtStudioRunBody)));
      const runId = str(out.run_id);
      if (owner && runId) {
        const { db, task } = owner;
        const label = runLabel(recipe, params);
        const run: CtAgentTaskRun = { run_id: runId, recipe, label, status: "queued", started_at: new Date().toISOString(), finished_at: null, asset_ids: [], error: "" };
        await patchTask(db, task.id, {
          status: liveStatus(task),
          runs: [...(task.runs ?? []), run],
          progress: [...(task.progress ?? []), { at: run.started_at, text: `Đang tạo ảnh — ${label}`, kind: "run" as const }].slice(-50),
        });
      }
      return json({ ...out, next: "Call wait_run with this run_id — it waits until the images are done." });
    },
  },
  {
    name: "get_run",
    description: "A studio run's state right now (queued / running / done / error) and the cliparts it saved so far. To wait for it, use wait_run instead.",
    inputSchema: { type: "object", properties: { run_id: { type: "string", description: "From run_studio." } }, required: ["run_id"] },
    callers: AGENT,
    run: async (ctx, args) => json(await runStatus(ctx.db, str(args.run_id))),
  },
  {
    name: "wait_run",
    description:
      "Wait for a studio run to finish (the server waits, up to ~3 min per call) → its images (look at them with view_image) or its error. \"still running\" → call wait_run again. Never submit a task's result while one of its runs is unfinished.",
    inputSchema: { type: "object", properties: { run_id: { type: "string", description: "From run_studio." } }, required: ["run_id"] },
    callers: AGENT,
    run: async (ctx, args) => {
      const runId = str(args.run_id);
      const deadline = Date.now() + WAIT_MS;
      let st = await runStatus(ctx.db, runId);
      while ((st.status === "queued" || st.status === "running") && Date.now() + POLL_MS < deadline) {
        await sleep(POLL_MS);
        st = await runStatus(ctx.db, runId);
      }
      const finished = st.status === "done" || st.status === "error";
      if (finished) await finishTaskRun(ctx, runId, st);
      const assets = st.assets.map((a) => ({ id: a.id, name: a.name, url: a.url, ...(Object.keys(a.meta ?? {}).length ? { meta: a.meta } : {}) }));
      if (!finished) return json({ status: st.status, position: st.position, node: st.node, assets, message: "Still running — call wait_run again." });
      return json({ status: st.status, error: st.error, assets, next: st.status === "done" ? "Look at the images with view_image before you decide." : "The run failed — fix and run again, or explain it in your result." });
    },
  },
];

/** A finished run on the task that started it: recorded, and its images shown to the editor. */
async function finishTaskRun(ctx: CtMcpContext, runId: string, st: CtStudioRunStatus): Promise<void> {
  const db = ctx.service;
  if (!db) return;
  const { data: tasks } = await db.from(CT_TABLES.agentTasks).select("*").filter("runs", "cs", JSON.stringify([{ run_id: runId }])).limit(1).returns<CtAgentTask[]>();
  const task = tasks?.[0];
  const run = task?.runs.find((r) => r.run_id === runId);
  if (!task || !run || run.finished_at) return;
  const done: CtAgentTaskRun = { ...run, status: st.status, finished_at: new Date().toISOString(), asset_ids: st.assets.map((a) => a.id), error: st.error ?? "" };
  const line: CtAgentTaskProgress =
    st.status === "done"
      ? { at: done.finished_at ?? "", text: `Ảnh đã xong — ${run.label}`, images: st.assets.map((a) => a.url).slice(0, 12), kind: "run" }
      : { at: done.finished_at ?? "", text: `Tạo ảnh lỗi — ${run.label}: ${clip(st.error ?? "", 200)}`, kind: "run" };
  const patch: Partial<CtAgentTask> = { runs: task.runs.map((r) => (r.run_id === runId ? done : r)) };
  // A closed task keeps its record, but its progress is not touched any more.
  if (task.status === "pending" || task.status === "running" || task.status === "waiting") patch.progress = [...(task.progress ?? []), line].slice(-50);
  await patchTask(db, task.id, patch);
}

/** The task's runs still queued / running, after asking ComfyUI about each. */
async function unfinishedRuns(ctx: CtMcpContext, task: CtAgentTask): Promise<CtAgentTaskRun[]> {
  const open: CtAgentTaskRun[] = [];
  for (const r of (task.runs ?? []).filter((x) => !x.finished_at)) {
    let st: CtStudioRunStatus;
    try {
      st = await runStatus(ctx.db, r.run_id);
    } catch {
      // ComfyUI can't be asked: don't lock the task forever on it.
      continue;
    }
    if (st.status === "done" || st.status === "error") await finishTaskRun(ctx, r.run_id, st);
    else open.push(r);
  }
  return open;
}

// ---------------------------------------------------------------------------
// Tasks from the web app (migration 011)
// ---------------------------------------------------------------------------

/**
 * The revise result as agents tend to write it — the assemble_prompts draft shapes ("spec": "…", "details": […],
 * "materials": [{id, prompt}]) — turned into the reviser's plan shape that buildRevision reads.
 */
function normalizeRevisePlan(raw: Record<string, unknown>, cat: CtCategorySnapshot, ctx: RevisionContext): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  if (typeof raw.spec === "string") out.spec = str(raw.spec) && str(raw.spec) !== cat.spec ? { text: str(raw.spec), why: "" } : null;
  if (Array.isArray(raw.details)) out.details = { list: raw.details, why: "" };
  if (typeof raw.style === "string") out.style = { action: "edit", prompt: raw.style, why: "" };
  else if (raw.style && typeof raw.style === "object") {
    const st = record(raw.style);
    const target = str(st.switchTo) || (str(st.id) && str(st.id) !== ctx.style?.id ? str(st.id) : "");
    if (!str(st.action)) out.style = { ...st, action: target ? "switch" : str(st.prompt) && str(st.prompt) !== ctx.style?.prompt ? "edit" : "keep", ...(target ? { switchTo: target } : {}) };
  }
  if (Array.isArray(raw.materials)) {
    out.materials = raw.materials.map(record).map((m) => {
      const handle = str(m.handle) || str(m.id) || str(m.currentId);
      const cur = ctx.current.find((x) => x.id === handle);
      if (str(m.action)) return { ...m, handle };
      return { ...m, handle, action: str(m.switchTo) ? "switch" : cur && str(m.prompt) && str(m.prompt) !== cur.prompt ? "edit" : "keep" };
    });
  }
  return out;
}

/** Changes in the plan that buildRevision did not carry over (wrong handle, unknown id, bad shape). */
function lostChanges(plan: Record<string, unknown>, cat: CtCategorySnapshot, rev: CtCategoryRevision): string[] {
  const lost: string[] = [];
  const spec = record(plan.spec);
  if (str(spec.text) && str(spec.text) !== cat.spec && !rev.spec) lost.push('"spec" (send the full text)');
  const det = record(plan.details);
  if (Array.isArray(det.list) && det.list.length && !rev.details) lost.push('"details" (send {"list": [{text, mode, label}], "why"})');
  for (const m of (Array.isArray(plan.materials) ? plan.materials : []).map(record)) {
    const action = str(m.action);
    if (action === "keep" || !action) continue;
    const hit = rev.materials.find((x) => x.currentId === str(m.handle) || x.targetId === str(m.switchTo));
    if (!hit || hit.action === "keep") lost.push(`material ${str(m.handle) || "?"} (${action}: use a current material id from get_category${action === "switch" ? " and a library id in switchTo" : ""})`);
  }
  const st = record(plan.style);
  if (["edit", "switch", "new"].includes(str(st.action)) && rev.style.action === "keep") lost.push(`style (${str(st.action)}: needs "prompt"${str(st.action) === "switch" ? " / a library style pack id in switchTo" : ""})`);
  return lost;
}

/** How to do a content task (Shopify title + description) — handed out with get_task. */
const CONTENT_INSTRUCTIONS = [
  "You write the Shopify product page copy for a personalized print-on-demand gift (US English, US shoppers).",
  "1. Read \"product\" (name, what the customer personalizes — facts —, price table, photos: look at them with view_image) and \"request\" (what the editor wants: tone, keywords, length, things to keep). \"current\" is the title / description on the page now; \"earlier\" is this product's earlier requests and your results, oldest first — \"shorter\", \"keep the title\", \"như lần trước\" refer to them. With a request that only asks a change, change only that and keep the rest of the latest version.",
  "2. Title: under 90 characters, the gift + what is personalized + who it is for (\"New Driver Custom State Car Plate Ornament, First Teenager Car Gift - Personalized Ornament\"). No emojis, no ALL CAPS words, no claims you cannot see in the facts.",
  "3. description_html: clean HTML for Shopify (p, ul/li, strong, h3 only — no inline styles, no scripts, no images): a short hook, then what makes it personal (each option the customer fills in, from the facts), sizes / pack savings if the price table has them, materials only when the facts or photos show them, a closing gift line. 120–250 words unless the request says otherwise.",
  "4. report_progress (Vietnamese) once while writing, then submit_result(task_id, {summary: Vietnamese, one or two lines — what you wrote and what you changed from the last version; title; description_html}).",
];

/** How to do a pack_image task — in get_task too, so it works before the agent machine pulls the skill. */
const PACK_INSTRUCTIONS = [
  "You make photos for the tổ hợp photo library: editors compose product mockups by hand from layers — a background, the product, hands / fingers holding it, props. They will put your photos in Image frames.",
  "1. Understand the request exactly. Count how many SEPARATE photos it asks for (\"2 tấm… tổng cộng 4 tấm\" = 4 photos) and, for each: the subject, which part only (e.g. index + middle finger only; the thumb alone), side (left / right hand), where it enters the frame (bottom-left corner, top edge…), style (nail art theme…). A LAYER — a part placed over or under the product (fingers, a hand, a prop) — must be transparent: generate it with transparent=true (drawn on a plain backdrop, then cut out). A background / scene is transparent=false. Look at every reference (view_image) and at base (the photo to keep editing, if any).",
  "1b. Photos sent back to keep editing (bases): each comes with the editor's OWN note for that photo. A base's note is the highest-priority instruction FOR THAT PHOTO: it overrides the general description wherever they disagree, and it applies to that photo only — never carry it over to another photo, never merge the notes into one prompt. Before generating, write yourself one line per base: what its note asks, what the general description adds (only where the note does not say otherwise), what must stay exactly as it is. Every base gets its own edited result (generate_pack_image with parent_id = the base id, its url FIRST in refs, the same transparent setting unless the note says otherwise) — submit_result is refused if one is missing. A base without a note is edited by the general description.",
  "1c. SPLITTING an existing photo into layers (\"tách ngón cái ra\", \"tách thành 2 lớp\") must keep the photo's own pixels — a redraw never lines up. You have no tool for it: do NOT redraw; tell the editor (summary, or ask_user if that is all they asked) to split it in the tổ hợp editor with the Cắt (lasso) tool — duplicate the layer, keep the part in one copy, cut it away in the other.",
  "1d. A bộ ảnh (collection) is one conversation: \"earlier\" in get_task lists its previous requests and results — \"ảnh trước\", \"cặp đó\", \"như lần trước\" refer to them.",
  "2. Only if something is genuinely ambiguous (how many photos, which parts are separate) ask_user once with concrete options, then end your turn. Otherwise go on.",
  "3. list_pack_images first: a photo that already fits can be handed back as is (its id in image_ids).",
  "4. For each photo write a precise English prompt for Nano Banana: exactly what is in frame and what is NOT (\"only the thumb and the base of the palm, no other fingers\"), pose, framing and the edge it comes from, skin / nails / materials, lighting that matches the references, photorealistic. Photos that belong together (the fingers and the thumb that will pinch the product) must match: make the first, then pass its url in refs for the next and say \"same hand, same skin tone, same nails, same lighting as Reference image 1\". References go to the model in order (Reference image 1 = the first url). Editing a base photo: pass it first in refs and say what to change and what to keep. The same photo for the OTHER hand = mirror_pack_image on the finished one (a real flip) — never a \"mirror it\" prompt.",
  "   generate_pack_image(task_id, name, prompt, refs, aspect, transparent) — about 1 minute each; report_progress (Vietnamese) before each.",
  "5. view_image every result and check it against the request: the right fingers, the right hand, the theme, where it enters the frame, a clean cut-out. Wrong → fix the prompt and generate again (at most ~3 tries a photo).",
  "6. submit_result(task_id, {summary: Vietnamese — what you made, which photo is which, and for EACH base: its note and how you applied it, what is still off; image_ids: the final photos in a useful order — an edit of every base included}). Photos you made but did not list stay out of the library.",
].join("\n");

const packTools: CtMcpTool[] = [
  {
    name: "generate_pack_image",
    description:
      "Make one photo for a pack_image task (Nano Banana 2 on fal.ai — billed, ~1 min): your prompt, reference photos (urls from the task, the library or your earlier results; Reference image 1 = the first), an aspect ratio, and transparent=true for a layer (cut out from a plain backdrop). Saved as a draft of the task: shown to the editor live, listed in the library only when you submit it. Returns its id and url — look at it with view_image.",
    inputSchema: {
      type: "object",
      properties: {
        ...TASK_ARG,
        name: { type: "string", description: "Short name, in the editor's language (\"Ngón trỏ + giữa — tay trái\")." },
        prompt: { type: "string", description: "The English prompt for the image model." },
        refs: { type: "array", items: { type: "string" }, description: "Reference photo urls, in order (max 6)." },
        aspect: { type: "string", description: "1:1 | 4:5 | 3:4 | 2:3 | 4:3 | 3:2 | 16:9 | 9:16 (default: the task's)." },
        transparent: { type: "boolean", description: "A layer: cut the background out (default false)." },
        parent_id: { type: "string", description: "The photo this one edits — REQUIRED for an edit of a base (its id); also a library / earlier result id." },
      },
      required: ["task_id", "name", "prompt"],
    },
    callers: AGENT,
    run: async (ctx, args) => {
      const { db, task } = await loadTask(ctx, args.task_id);
      openTask(task);
      if (task.kind !== "pack_image" || !task.user_id) throw new Error("generate_pack_image is for pack_image tasks");
      const name = clip(str(args.name), 200) || "Ảnh AI";
      const prompt = clip(str(args.prompt), 8000);
      if (!prompt) throw new Error("prompt is required");
      const refs = (Array.isArray(args.refs) ? args.refs : []).map(str).filter(isOwnUploadUrl).slice(0, 6);
      const aspect = ["1:1", "4:5", "3:4", "2:3", "4:3", "3:2", "16:9", "9:16"].includes(str(args.aspect)) ? str(args.aspect) : (task.input.pack?.aspect ?? "1:1");
      const transparent = args.transparent === true;
      const parentId = UUID.test(str(args.parent_id)) ? str(args.parent_id) : null;
      const file = await drawPackImage(task.user_id, { name, prompt, refs, aspect, transparent });
      const data = await saveTaskPhoto(ctx, db, task, { ...file, name, prompt, refs, aspect, transparent, parent_id: parentId }, `Đã tạo: ${name}${transparent ? " (nền trong suốt)" : ""}`);
      return json({ id: data.id, name, url: data.url, width: data.width, height: data.height, transparent, next: "Look at it with view_image and check it against the request." });
    },
  },
  {
    name: "mirror_pack_image",
    description:
      "The same photo for the OTHER hand: flips a photo left ↔ right, pixel for pixel (free, instant) — a left hand becomes the right one, entering from the opposite side. Use this whenever the request is \"the same, for the other hand\" — NEVER ask the image model to mirror (it hands the reference back unflipped). Saved as a draft of the task like generate_pack_image.",
    inputSchema: {
      type: "object",
      properties: {
        ...TASK_ARG,
        image_id: { type: "string", description: "The photo to flip: a result of this task, a base or a library photo (its id)." },
        name: { type: "string", description: "Short name, in the editor's language (\"Tay phải – cái + trỏ + giữa\")." },
      },
      required: ["task_id", "image_id", "name"],
    },
    callers: AGENT,
    run: async (ctx, args) => {
      const { db, task } = await loadTask(ctx, args.task_id);
      openTask(task);
      if (task.kind !== "pack_image" || !task.user_id) throw new Error("mirror_pack_image is for pack_image tasks");
      const id = str(args.image_id);
      if (!UUID.test(id)) throw new Error("image_id is required");
      const { data: src } = await db.from(CT_TABLES.packImages).select("*").eq("id", id).maybeSingle<CtPackImage>();
      if (!src?.url) throw new Error("No such photo");
      const name = clip(str(args.name), 200) || `${src.name} (lật)`;
      const file = await mirrorPackImage(task.user_id, name, src.url);
      const prompt = `Mirrored left ↔ right from “${src.name}”.${src.prompt ? `\n\nOriginal prompt: ${src.prompt}` : ""}`;
      const data = await saveTaskPhoto(ctx, db, task, { ...file, name, prompt, refs: [src.url], aspect: src.aspect, transparent: src.transparent, parent_id: src.id }, `Đã lật: ${name}`);
      return json({ id: data.id, name, url: data.url, width: data.width, height: data.height, transparent: data.transparent, next: "Look at it with view_image." });
    },
  },
];

/** A photo the agent made for a pack_image task: a draft of the task (listed on submit), shown live in its progress. */
async function saveTaskPhoto(
  ctx: Parameters<CtMcpTool["run"]>[0],
  db: Awaited<ReturnType<typeof loadTask>>["db"],
  task: CtAgentTask,
  photo: Pick<CtPackImage, "url" | "storage_path" | "mime" | "width" | "height" | "model" | "name" | "prompt" | "refs" | "aspect" | "transparent" | "parent_id">,
  progress: string,
): Promise<CtPackImage> {
  const { data, error } = await db
    .from(CT_TABLES.packImages)
    .insert({
      ...photo,
      user_id: task.user_id,
      source: "ai",
      status: "done",
      description: task.input.pack?.description ?? "",
      task_id: task.id,
      listed: false,
      collection_id: task.input.pack?.collectionId ?? null,
    })
    .select("*")
    .single<CtPackImage>();
  if (error || !data) throw new Error(error?.message ?? "Could not save the photo");
  const fresh = (await loadTask(ctx, task.id)).task;
  await patchTask(db, task.id, {
    status: liveStatus(fresh),
    progress: [...(fresh.progress ?? []), { at: new Date().toISOString(), text: progress, images: [data.url ?? ""], kind: "run" as const }].slice(-50),
  });
  return data;
}

const taskTools: CtMcpTool[] = [
  {
    name: "get_task",
    description:
      "A task the editor sent from the web app. kind content: the Shopify title + description of a product (follow its \"instructions\"). kind char: a step of a v2 bộ nhân vật (brainstorm | master | edits — the brief, its pictures, the planned edits and \"instructions\"; work with the char_* tools). kind pack_image: photos for the tổ hợp photo library — general description, references, bases (photos to keep editing, each with its own note that outranks the description for that photo), and \"instructions\" to follow. kind create | revise: the category as their dialog has it (maybe unsaved), their note, the numbered result images (#1…) they looked at, new reference photos. Read flexiprint://guide/task-results for what to submit.",
    inputSchema: { type: "object", properties: TASK_ARG, required: ["task_id"] },
    callers: AGENT,
    run: async (ctx, args) => {
      const { db, task } = await loadTask(ctx, args.task_id);
      openTask(task);
      if (task.status === "pending") await patchTask(db, task.id, { status: "running" });
      const { input } = task;
      if (task.kind === "char") return json(await charTaskView(db, task));
      if (task.kind === "content") {
        const c = input.content;
        const { data: before } = c
          ? await db
              .from(CT_TABLES.agentTasks)
              .select("id,created_at,status,input,result")
              .eq("kind", "content")
              .eq("input->content->>productId", c.productId)
              .neq("id", task.id)
              .order("created_at")
              .limit(20)
              .returns<Array<Pick<CtAgentTask, "id" | "created_at" | "status" | "input" | "result">>>()
          : { data: [] };
        return json({
          id: task.id,
          kind: task.kind,
          what: "Write the Shopify title + description of this product.",
          request: c?.request ?? "",
          product: { name: c?.productName ?? "", facts: c?.facts ?? [], photos: c?.imageUrls ?? [] },
          current: { title: c?.title ?? "", description_html: c?.descriptionHtml ?? "" },
          earlier: (before ?? []).map((t) => ({
            at: t.created_at,
            status: t.status,
            request: t.input.content?.request ?? "",
            title: t.result && "title" in t.result ? t.result.title : "",
            description_html: t.result && "descriptionHtml" in t.result ? clip(t.result.descriptionHtml, 4000) : "",
          })),
          questions: (task.questions ?? []).map((q) => ({ id: q.id, question: q.question, options: q.options.map((o) => o.label), answer: q.answer })),
          instructions: CONTENT_INSTRUCTIONS,
        });
      }
      if (task.kind === "pack_image") {
        const p = input.pack;
        const asked = packBases(p);
        const { data: rows } = asked.length
          ? await db.from(CT_TABLES.packImages).select("id,name,url,prompt,transparent,aspect").in("id", asked.map((b) => b.id)).returns<Array<Pick<CtPackImage, "id" | "name" | "url" | "prompt" | "transparent" | "aspect">>>()
          : { data: [] };
        const bases = asked.map((b, i) => {
          const r = rows?.find((x) => x.id === b.id);
          return {
            number: i + 1,
            id: b.id,
            url: r?.url ?? b.url,
            name: r?.name ?? b.name,
            note: b.note || "(no own note — edit it by the general description)",
            priority: "This note outranks the general description for THIS photo only.",
            transparent: r?.transparent ?? false,
            aspect: r?.aspect ?? "",
            prompt: r?.prompt ?? "",
          };
        });
        const { data: made } = await db.from(CT_TABLES.packImages).select("id,name,url,prompt,transparent,parent_id").eq("task_id", task.id).order("created_at");
        // The bộ ảnh this request belongs to: its earlier requests and what came of them.
        let collection: Record<string, unknown> | null = null;
        if (p?.collectionId) {
          const { data: col } = await db.from(CT_TABLES.packCollections).select("id,name").eq("id", p.collectionId).maybeSingle();
          const { data: before } = await db
            .from(CT_TABLES.agentTasks)
            .select("id,created_at,status,input,result")
            .eq("kind", "pack_image")
            .eq("input->pack->>collectionId", p.collectionId)
            .neq("id", task.id)
            .order("created_at")
            .returns<Array<Pick<CtAgentTask, "id" | "created_at" | "status" | "input" | "result">>>();
          const { data: photos } = await db
            .from(CT_TABLES.packImages)
            .select("id,name,url,transparent,parent_id,task_id,listed")
            .eq("collection_id", p.collectionId)
            .eq("listed", true)
            .order("created_at");
          collection = {
            name: col?.name ?? "",
            earlier: (before ?? []).map((t) => ({
              at: t.created_at,
              status: t.status,
              request: t.input.pack?.description ?? "",
              notes: packBases(t.input.pack).map((b) => ({ photo: b.id, note: b.note })),
              summary: t.result && "summary" in t.result ? clip(str(t.result.summary), 800) : "",
              photos: (photos ?? []).filter((ph) => ph.task_id === t.id),
            })),
            // Every photo of the bộ now in the library (incl. ones redrawn or split by the editor).
            photos: photos ?? [],
          };
        }
        return json({
          id: task.id,
          kind: task.kind,
          what: bases.length ? `Keep editing ${bases.length} photo(s), each by its own note first (bases), then the general description.` : "Make the photos the editor asks for.",
          description: p?.description ?? "",
          aspect: p?.aspect ?? "1:1",
          refUrls: input.refUrls,
          bases,
          collection,
          // Photos you already made for this task (after a question, say).
          made: made ?? [],
          questions: (task.questions ?? []).map((q) => ({ id: q.id, question: q.question, options: q.options.map((o) => o.label), answer: q.answer })),
          instructions: PACK_INSTRUCTIONS,
        });
      }
      return json({
        id: task.id,
        kind: task.kind,
        what: task.kind === "create" ? "Draft a whole new category." : input.note ? "Revise the category from the editor's feedback." : "Only check the category's prompts (no feedback): find conflicts and fix them.",
        category: input.category,
        savedCategoryId: task.category_id,
        note: input.note,
        images: input.images.map((im, i) => ({ number: i + 1, url: im.url, label: im.label })),
        refUrls: input.refUrls,
        // What you asked the editor so far (ask_user) and what they answered.
        questions: (task.questions ?? []).map((q) => ({ id: q.id, question: q.question, options: q.options.map((o) => o.label), answer: q.answer })),
        resultFormat: "flexiprint://guide/task-results",
      });
    },
  },
  {
    name: "report_progress",
    description: "Tell the editor (live, in the web app) what you are doing — one short Vietnamese line.",
    inputSchema: { type: "object", properties: { ...TASK_ARG, text: { type: "string", description: "One short line, Vietnamese." } }, required: ["task_id", "text"] },
    callers: AGENT,
    run: async (ctx, args) => {
      const { db, task } = await loadTask(ctx, args.task_id);
      openTask(task);
      const line: CtAgentTaskProgress = { at: new Date().toISOString(), text: clip(str(args.text), 300), kind: "note" };
      await patchTask(db, task.id, { status: liveStatus(task), progress: [...(task.progress ?? []), line].slice(-50) });
      return json({ ok: true });
    },
  },
  {
    name: "ask_user",
    description: [
      "Ask the editor a question in the web app when a choice is genuinely theirs (two good directions, a taste call, missing information) — options to pick from, and/or a typed answer.",
      "After calling it, END YOUR TURN (no more tool calls, a one-line reply). The answer comes back as a new message in this session (\"[FlexiPrint task <id>] Người dùng trả lời …\"); then continue the task. One open question at a time; submit_result is refused while it is unanswered.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        ...TASK_ARG,
        question: { type: "string", description: "The question, Vietnamese, short — say what you found and what the choice changes." },
        options: { type: "array", items: { type: "object" }, description: "2–6 options [{label: \"VI, short\", description?: \"VI: what it means\"}]. May be empty when only a typed answer makes sense." },
        multi: { type: "boolean", description: "Several options may be picked (default false)." },
        allow_text: { type: "boolean", description: "Accept a typed answer too (default true)." },
      },
      required: ["task_id", "question"],
    },
    callers: AGENT,
    run: async (ctx, args) => {
      const { db, task } = await loadTask(ctx, args.task_id);
      openTask(task);
      const open = openQuestion(task);
      if (open) throw new Error(`Question "${clip(open.question, 80)}" is still waiting for the editor — end your turn and wait for the answer.`);
      const question = clip(str(args.question), 1000);
      if (!question) throw new Error("question is required");
      const options = (Array.isArray(args.options) ? args.options : [])
        .map((o) => (typeof o === "string" ? { label: o } : record(o)))
        .map((o) => ({ label: clip(str(o.label), 120), description: clip(str(o.description), 300) }))
        .filter((o) => o.label)
        .slice(0, 6);
      const allowText = args.allow_text !== false || options.length === 0;
      const q: CtAgentQuestion = { id: crypto.randomUUID(), question, options, multi: args.multi === true && options.length > 1, allow_text: allowText, asked_at: new Date().toISOString(), answer: null };
      await patchTask(db, task.id, {
        status: "waiting",
        questions: [...(task.questions ?? []), q],
        progress: [...(task.progress ?? []), { at: q.asked_at, text: `Hỏi: ${clip(question, 200)}`, kind: "question" as const }].slice(-50),
      });
      return json({ ok: true, question_id: q.id, next: "End your turn now. The editor's answer arrives as a new message in this session; then continue the task." });
    },
  },
  {
    name: "submit_result",
    description: "Finish a task with its result (JSON per flexiprint://guide/task-results). The editor then sees it as a plan to tick and apply.",
    inputSchema: { type: "object", properties: { ...TASK_ARG, result: { type: "object", description: "The result JSON." } }, required: ["task_id", "result"] },
    callers: AGENT,
    run: async (ctx, args) => {
      const { db, task } = await loadTask(ctx, args.task_id);
      openTask(task);
      const asked = openQuestion(task);
      if (asked) throw new Error(`Not submitted — your question "${clip(asked.question, 80)}" is not answered yet. End your turn and wait for the answer.`);
      // Only the final answer: every test image of the task must be done (and looked at) first.
      const open = await unfinishedRuns(ctx, task);
      if (open.length) {
        throw new Error(
          `Not submitted — ${open.length} studio run(s) of this task still running: ${open.map((r) => `${r.run_id} (${r.label})`).join("; ")}. Call wait_run for each, look at the images, then submit_result.`,
        );
      }
      const raw = record(typeof args.result === "string" ? JSON.parse(args.result) : args.result);
      const summary = clip(str(raw.summary), 3000);
      if (!summary) throw new Error('Result needs "summary" (Vietnamese): what you did, which test images you made and what they showed, what is still uncertain — see flexiprint://guide/task-results');
      if (task.kind === "char") {
        const result = await submitCharResult(db, task, raw, summary);
        await patchTask(db, task.id, { status: "done", result, finished_at: new Date().toISOString() });
        return json({ ok: true, message: "Đã gửi — người dùng thấy ngay trên trang bộ nhân vật." });
      }
      if (task.kind === "content") {
        const title = clip(str(raw.title), 255).trim();
        const descriptionHtml = clip(str(raw.description_html) || str(raw.descriptionHtml), 20000).trim();
        if (!title || !descriptionHtml) throw new Error('Result needs "title" and "description_html" (and "summary")');
        if (/<script|\son\w+=|javascript:/i.test(descriptionHtml)) throw new Error("description_html must be plain HTML: no scripts, event handlers or javascript: links");
        const result: CtContentResult = { summary, title, descriptionHtml };
        await patchTask(db, task.id, { status: "done", result, finished_at: new Date().toISOString() });
        return json({ ok: true, message: "Đã gửi title + description — người dùng thấy ngay trên trang Deploy." });
      }
      if (task.kind === "pack_image") {
        const ids = [...new Set((Array.isArray(raw.image_ids) ? raw.image_ids : Array.isArray(raw.imageIds) ? raw.imageIds : []).map(str).filter((x) => UUID.test(x)))].slice(0, 12);
        if (!ids.length) throw new Error('Result needs "image_ids": the photos you made (generate_pack_image) or picked from list_pack_images');
        const { data: found } = await db.from(CT_TABLES.packImages).select("id,task_id,listed,status").in("id", ids).returns<Array<Pick<CtPackImage, "id" | "task_id" | "listed" | "status">>>();
        const ok = new Set((found ?? []).filter((r) => r.status === "done" && (r.task_id === task.id || r.listed)).map((r) => r.id));
        const bad = ids.filter((x) => !ok.has(x));
        if (bad.length) throw new Error(`Not submitted — unknown photo id(s): ${bad.join(", ")} (use ids from generate_pack_image or list_pack_images)`);
        // Every photo sent back must come back edited: its own note would otherwise be lost.
        const bases = packBases(task.input.pack);
        if (bases.length) {
          const { data: edits } = await db.from(CT_TABLES.packImages).select("parent_id").in("id", ids).returns<Array<Pick<CtPackImage, "parent_id">>>();
          const answered = new Set((edits ?? []).map((e) => e.parent_id));
          const missing = bases.filter((b) => !answered.has(b.id));
          if (missing.length) {
            throw new Error(
              `Not submitted — no edited photo for ${missing.map((b) => `base ${b.id}${b.note ? ` (note: "${clip(b.note, 120)}")` : ""}`).join("; ")}. Make it with generate_pack_image(parent_id = that base id, its url first in refs), look at it, and include it in image_ids.`,
            );
          }
        }
        const { error: listErr } = await db.from(CT_TABLES.packImages).update({ listed: true }).in("id", ids);
        if (listErr) throw new Error(listErr.message);
        const packResult: CtPackImageResult = { summary, imageIds: ids };
        if (task.input.pack?.collectionId) await touchCollection(db, task.input.pack.collectionId);
        await patchTask(db, task.id, { status: "done", result: packResult, finished_at: new Date().toISOString() });
        return json({ ok: true, message: "Đã gửi ảnh — người dùng thấy ngay trong thư viện ảnh tổ hợp." });
      }
      const snapshot: CtCategorySnapshot = { name: task.input.category.name, spec: task.input.category.spec, rules: normalizeCategoryRules(task.input.category.rules) };
      let result: CtAgentTask["result"];
      if (task.kind === "create") {
        result = suggestionFromAgent(raw, await loadLibraryCatalog(db), task.input.refUrls.length, snapshot.name);
        if (!result) throw new Error('Result needs "spec" and a "style" ({reuseId} or {name, prompt}) — see flexiprint://guide/task-results');
      } else {
        if (!str(raw.diagnosis)) throw new Error('Result needs "diagnosis" — see flexiprint://guide/task-results');
        const rctx = await revisionContext(db, snapshot);
        const plan = normalizeRevisePlan(raw, snapshot, rctx);
        result = buildRevision(plan, snapshot, rctx, task.input.refUrls);
        // Never drop a change silently: what the agent sent but the plan does not carry → it resubmits.
        const lost = lostChanges(plan, snapshot, result);
        if (lost.length) throw new Error(`Not understood, nothing saved — fix and submit again: ${lost.join("; ")}. Format: flexiprint://guide/task-results`);
        result = { ...result, summary };
      }
      await patchTask(db, task.id, { status: "done", result, finished_at: new Date().toISOString() });
      return json({ ok: true, message: "Đã gửi kết quả — người dùng sẽ duyệt trên app." });
    },
  },
  {
    name: "fail_task",
    description: "Give up on a task, with the reason the editor will read (Vietnamese).",
    inputSchema: { type: "object", properties: { ...TASK_ARG, reason: { type: "string", description: "Why, Vietnamese." } }, required: ["task_id", "reason"] },
    callers: AGENT,
    run: async (ctx, args) => {
      const { db, task } = await loadTask(ctx, args.task_id);
      openTask(task);
      await patchTask(db, task.id, { status: "failed", error: clip(str(args.reason) || "Agent dừng", 1000), finished_at: new Date().toISOString() });
      return json({ ok: true });
    },
  },
];

export const CT_MCP_TOOLS: CtMcpTool[] = [...categoryTools, ...libraryTools, ...packImageTools, ...packTools, ...promptTools, ...studioTools, ...taskTools, ...CT_MCP_CHAR_TOOLS, ...CT_MCP_WRITE_TOOLS];
