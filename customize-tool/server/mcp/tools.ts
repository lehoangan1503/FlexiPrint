/**
 * flexiprint-mcp tools. Two callers (server/mcp/server.ts decides who is calling):
 *   - "agent"  — the @flexiprint agent on agent_ide (Bearer CT_AGENT_TOKEN): everything, tasks included;
 *   - "user"   — a signed-in editor (cookie): library reads with their own rights.
 * Reads go through `db` (the service client for the agent, the user's client otherwise). A web-app task (kind
 * content | char) is answered with submit_result.
 */

import { CT_TABLES } from "../../config";
import { normalizeCategoryRules } from "../../lib/library";
import type { CtAgentQuestion, CtAgentTask, CtAgentTaskProgress, CtAsset, CtContentResult, CtCategoryHistoryEntry, CtClipartCategory } from "../../types";
import { isOwnUploadUrl } from "../library";
import type { CtServiceClient, CtSupabase } from "../supabase";
import { clip, record, str } from "../ai/llm";
import sharp from "sharp";
import { CT_MCP_PRINT_TOOLS } from "./print-tools";
import { CT_MCP_CHAR_TOOLS, charTaskView, submitCharResult } from "./char-tools";
import { TASK_ARG, json, liveStatus, loadTask, openQuestion, openTask, patchTask } from "./task-common";

export type CtMcpCaller = "agent" | "user";

export type LibraryDb = CtSupabase | CtServiceClient;

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

const ALL: CtMcpCaller[] = ["agent", "user"];
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
const categoryTools: CtMcpTool[] = [
  {
    name: "list_categories",
    description: "Every clipart category: id, name, parent, spec (clipped). Start here.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Optional words to filter by name / spec." } } },
    callers: ALL,
    run: async (ctx, args) => {
      const { data, error } = await ctx.db.from(CT_TABLES.categories).select("id,name,usage,mode,spec,rules,parent_id,updated_at").order("sort_order").order("name").returns<CategoryRow[]>();
      if (error) throw new Error(error.message);
      const words = str(args.query).toLowerCase().split(/\s+/).filter(Boolean);
      return json(
        (data ?? [])
          .filter((c) => words.every((w) => `${c.name} ${c.spec}`.toLowerCase().includes(w)))
          .map((c) => ({ id: c.id, name: c.name, parentId: c.parent_id, usage: c.usage, spec: clip(c.spec, 300), updatedAt: c.updated_at })),
      );
    },
  },
  {
    name: "get_category",
    description: "A category in full: spec and rules (details, reference photos, product photos, the editor's details note, framing).",
    inputSchema: { type: "object", properties: { category: CATEGORY_ARG }, required: ["category"] },
    callers: ALL,
    run: async (ctx, args) => {
      const c = await findCategory(ctx.db, args.category);
      return json({
        id: c.id,
        name: c.name,
        parentId: c.parent_id,
        usage: c.usage,
        mode: c.mode,
        spec: c.spec,
        updatedAt: c.updated_at,
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
    description: "A category's history, newest first: earlier AI revisions and every save.",
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
    description: "Look at images of the library (cliparts, renditions, reference / product photos, mockup photos): up to 4 urls from the other tools. Shown at ≤ 1568 px; transparent areas appear mid grey.",
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
// Tasks from the web app (migration 011)
// ---------------------------------------------------------------------------

/** How to do a content task (Shopify title + description) — handed out with get_task. */
const CONTENT_INSTRUCTIONS = [
  "You write the Shopify product page copy for a personalized print-on-demand gift (US English, US shoppers).",
  "1. Read \"product\" (name, what the customer personalizes — facts —, price table, photos: look at them with view_image) and \"request\" (what the editor wants: tone, keywords, length, things to keep). \"current\" is the title / description on the page now; \"earlier\" is this product's earlier requests and your results, oldest first — \"shorter\", \"keep the title\", \"như lần trước\" refer to them. With a request that only asks a change, change only that and keep the rest of the latest version.",
  "2. Title: under 90 characters, the gift + what is personalized + who it is for (\"New Driver Custom State Car Plate Ornament, First Teenager Car Gift - Personalized Ornament\"). No emojis, no ALL CAPS words, no claims you cannot see in the facts.",
  "3. description_html: clean HTML for Shopify (p, ul/li, strong, h3 only — no inline styles, no scripts, no images): a short hook, then what makes it personal (each option the customer fills in, from the facts), sizes / pack savings if the price table has them, materials only when the facts or photos show them, a closing gift line. 120–250 words unless the request says otherwise.",
  "4. report_progress (Vietnamese) once while writing, then submit_result(task_id, {summary: Vietnamese, one or two lines — what you wrote and what you changed from the last version; title; description_html}).",
];

const taskTools: CtMcpTool[] = [
  {
    name: "get_task",
    description:
      "A task the editor sent from the web app. kind content: the Shopify title + description of a product (follow its \"instructions\"). kind char: a step of a v2 bộ nhân vật (brainstorm | master | edits — the brief, its pictures, the planned edits and \"instructions\"; work with the char_* tools).",
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
      throw new Error(`Task kind "${task.kind}" is no longer supported`);
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
    description: "Finish a task with its result JSON (content: {summary, title, description_html}; char: per the task's \"instructions\").",
    inputSchema: { type: "object", properties: { ...TASK_ARG, result: { type: "object", description: "The result JSON." } }, required: ["task_id", "result"] },
    callers: AGENT,
    run: async (ctx, args) => {
      const { db, task } = await loadTask(ctx, args.task_id);
      openTask(task);
      const asked = openQuestion(task);
      if (asked) throw new Error(`Not submitted — your question "${clip(asked.question, 80)}" is not answered yet. End your turn and wait for the answer.`);
      const raw = record(typeof args.result === "string" ? JSON.parse(args.result) : args.result);
      const summary = clip(str(raw.summary), 3000);
      if (!summary) throw new Error('Result needs "summary" (Vietnamese): what you did and what is still uncertain');
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
      throw new Error(`Task kind "${task.kind}" is no longer supported`);
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

export const CT_MCP_TOOLS: CtMcpTool[] = [...categoryTools, ...taskTools, ...CT_MCP_CHAR_TOOLS, ...CT_MCP_PRINT_TOOLS];
