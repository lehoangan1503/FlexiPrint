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
import type { CtAgentTask, CtAgentTaskProgress, CtAsset, CtCategoryRevision, CtCategoryHistoryEntry, CtCategorySnapshot, CtClipartCategory, CtMaterialSpec, CtStudioRunBody } from "../../types";
import { normalizeMaterialSpecs } from "../../lib/materials";
import { isOwnUploadUrl } from "../library";
import * as studio from "../studio";
import type { CtServiceClient } from "../supabase";
import { CT_LIBRARY_TOOLS, loadLibraryCatalog, type CtLibraryCatalog, type LibraryDb } from "../ai/library-tools";
import { flatPrompt, lintCategory, materialPrompts, type ReviewInput } from "../ai/prompt-review";
import { buildRevision, revisionContext, suggestionFromAgent, type RevisionContext } from "../ai/prompt-writer";
import { clip, record, str } from "../ai/llm";
import { CT_MCP_WRITE_TOOLS } from "./write-tools";

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

const json = (v: unknown): CtMcpOutput => ({ json: v });

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
    description: "Look at images of the library (cliparts, renditions, reference / product photos): up to 4 urls from the other tools.",
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
          if (buf.length > 5 * 1024 * 1024) throw new Error(`${url}: larger than 5 MB`);
          return { data: buf.toString("base64"), mimeType: type.split(";")[0], url };
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

const studioTools: CtMcpTool[] = [
  {
    name: "list_models",
    description: "Image models the studio can run (for run_studio params.model).",
    inputSchema: { type: "object", properties: {} },
    callers: AGENT,
    run: async () => json(await bodyOf(await studio.studioModels())),
  },
  {
    name: "run_studio",
    description: [
      "Make images with the studio (ComfyUI, models on fal.ai — billed). Returns run_id; poll get_run. Results are saved into the library like the web app's.",
      "Recipes and their params:",
      '- origin: new origins of a category. {category_id, style_pack_id: null (category default), material_id: null | "none" | id, material_extra: "", material_ids?: [ids → also make those material versions], note: "", subjects: [{name, text}], model: "", chain_reference: true, cutout: "category", rules: {}, tags: []}',
      '- refine: edit origins. {targets: [{clipart_id, name, edit?, spec?}], instruction, keep, refs: [], model: "", cutout: "category"}',
      '- variant: đa sắc of an origin. {clipart_id, variants: [{name, text: "#hex" or a change, mode?: "recolor" | "ai"}], method: "auto", lock_silhouette: true, model: ""}',
      '- material: material versions. {material_id, targets: [{clipart_id, name}], lock: "preset", edge_px: 0, extra: "", model: ""}',
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: { recipe: { type: "string", description: "origin | refine | variant | material" }, params: { type: "object", description: "The recipe's params (see description)." } },
      required: ["recipe", "params"],
    },
    callers: AGENT,
    run: async (_ctx, args) => {
      const recipe = str(args.recipe);
      if (!["origin", "refine", "variant", "material"].includes(recipe)) throw new Error("recipe: origin | refine | variant | material");
      return json(await bodyOf(await studio.studioRun({ recipe, params: record(args.params) } as unknown as CtStudioRunBody)));
    },
  },
  {
    name: "get_run",
    description: "A studio run's state (queued / running / done / error) and the cliparts it saved so far (view them with view_image).",
    inputSchema: { type: "object", properties: { run_id: { type: "string", description: "From run_studio." } }, required: ["run_id"] },
    callers: AGENT,
    run: async (ctx, args) => json(await bodyOf(await studio.studioRunStatus(ctx.db, str(args.run_id)))),
  },
];

// ---------------------------------------------------------------------------
// Tasks from the web app (migration 011)
// ---------------------------------------------------------------------------

async function loadTask(ctx: CtMcpContext, id: unknown): Promise<{ db: CtServiceClient; task: CtAgentTask }> {
  const db = ctx.service;
  if (!db) throw new Error("Tasks need the agent token");
  const key = str(id);
  if (!UUID.test(key)) throw new Error("task_id is not a valid id");
  const { data, error } = await db.from(CT_TABLES.agentTasks).select("*").eq("id", key).maybeSingle<CtAgentTask>();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No such task");
  return { db, task: data };
}

function openTask(task: CtAgentTask): void {
  if (task.status !== "pending" && task.status !== "running") throw new Error(`Task is ${task.status} — nothing more to do`);
}

async function patchTask(db: CtServiceClient, id: string, patch: Partial<CtAgentTask>): Promise<void> {
  const { error } = await db.from(CT_TABLES.agentTasks).update(patch).eq("id", id);
  if (error) throw new Error(error.message);
}

const TASK_ARG = { task_id: { type: "string", description: "The task id from the message." } };

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

const taskTools: CtMcpTool[] = [
  {
    name: "get_task",
    description:
      "A task the editor sent from the web app: kind (create | revise), the category as their dialog has it (maybe unsaved), their note, the numbered result images (#1…) they looked at, new reference photos. Read flexiprint://guide/task-results for what to submit.",
    inputSchema: { type: "object", properties: TASK_ARG, required: ["task_id"] },
    callers: AGENT,
    run: async (ctx, args) => {
      const { db, task } = await loadTask(ctx, args.task_id);
      openTask(task);
      if (task.status === "pending") await patchTask(db, task.id, { status: "running" });
      const { input } = task;
      return json({
        id: task.id,
        kind: task.kind,
        what: task.kind === "create" ? "Draft a whole new category." : input.note ? "Revise the category from the editor's feedback." : "Only check the category's prompts (no feedback): find conflicts and fix them.",
        category: input.category,
        savedCategoryId: task.category_id,
        note: input.note,
        images: input.images.map((im, i) => ({ number: i + 1, url: im.url, label: im.label })),
        refUrls: input.refUrls,
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
      const line: CtAgentTaskProgress = { at: new Date().toISOString(), text: clip(str(args.text), 300) };
      await patchTask(db, task.id, { status: "running", progress: [...(task.progress ?? []), line].slice(-50) });
      return json({ ok: true });
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
      const raw = record(typeof args.result === "string" ? JSON.parse(args.result) : args.result);
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

export const CT_MCP_TOOLS: CtMcpTool[] = [...categoryTools, ...libraryTools, ...promptTools, ...studioTools, ...taskTools, ...CT_MCP_WRITE_TOOLS];
