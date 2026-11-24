/**
 * MCP đợt 3 (2026-11-25, luật "mỗi nút giao diện có API + MCP"): the library pages and the rest of the editor's
 * buttons — clipart library (danh mục, tải lên / sửa / xoá / thay clipart, đưa vào thư viện), fonts, AI photo
 * styles (tạo / xoá / ảnh demo), khuôn in (vẽ bằng AI, lưu khuôn tự do, phôi AI), a picture → url on the server,
 * a blank artwork W×H, the editor's agent tasks (mở / huỷ / trả lời), and the bộ nhân vật list (đổi tên / xoá).
 * Every tool runs as the signed-in user (or the task's user) through the same handler as the web page. The
 * service session skips RLS, so where a handler leans on RLS for "owner or admin" the check is made here first.
 */

import { CT_TABLES } from "../../config";
import type { CtAgentTask, CtAiStyleBody, CtCategoryBody, CtClipartCategory, CtUpdateClipartBody } from "../../types";
import type { CtPrintTemplate } from "../../types/print";
import { str } from "../ai/llm";
import { CT_AI_STYLE_ASPECTS, CT_AI_STYLE_MAX_REFS, CT_AI_STYLE_MODEL, CT_AI_STYLE_PROMPT_MAX, isAiStyleAspect, normalizeAiStyleParams } from "../../lib/ai-style-models";
import { aiStyleRef } from "../../lib/photo-styles";
import { fetchImage } from "../char/files";
import * as lib from "../library";
import * as fonts from "../fonts";
import * as st from "../ai-styles";
import * as printTpl from "../print-templates";
import { khuonAi } from "../print-khuon";
import { aiTemplateBlank } from "../print-blanks";
import { createArtwork } from "../print-products";
import { answerAgentTask, cancelAgentTask, createAgentTask, listAgentTasks } from "../agent/tasks";
import { deleteCharProject, listCharProjects, updateCharProject } from "../char/projects";
import type { CtSession } from "../supabase";
import { answer, idOf, session } from "./crud-tools";
import { OPT_TASK_ARG, json } from "./task-common";
import type { CtMcpContext, CtMcpTool } from "./tools";

const MAX_FILE = 25 * 1024 * 1024;

async function adminOf(ctx: CtMcpContext, s: CtSession): Promise<boolean> {
  return ctx.caller === "user" ? ctx.admin : st.isAdmin(s);
}

/** The file of a call: data_base64 (a data: url or bare base64) or an https url. */
async function fileOf(args: Record<string, unknown>, urlKey = "image_url"): Promise<Buffer> {
  const b64 = str(args.data_base64).replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  const url = str(args[urlKey]).trim();
  let data: Buffer;
  if (b64) data = Buffer.from(b64, "base64");
  else if (/^https:\/\/\S+$/.test(url)) data = await fetchImage(url);
  else throw new Error(`Give ${urlKey} (https) or data_base64`);
  if (!data.length) throw new Error("The file is empty");
  if (data.length > MAX_FILE) throw new Error("The file is over 25 MB");
  return data;
}

function nameOf(args: Record<string, unknown>, urlKey: string, fallback: string): string {
  const given = str(args.name).trim();
  if (given) return given.slice(0, 120);
  const url = str(args[urlKey]).split("?")[0];
  return decodeURIComponent(url.split("/").pop() || "") || fallback;
}

async function categoryOf(s: CtSession, id: string): Promise<CtClipartCategory> {
  const { data } = await s.supabase.from(CT_TABLES.categories).select("*").eq("id", id).maybeSingle<CtClipartCategory>();
  if (!data) throw new Error("No such category — list_categories");
  return data;
}

async function editableCategory(ctx: CtMcpContext, s: CtSession, id: string): Promise<CtClipartCategory> {
  const c = await categoryOf(s, id);
  if (c.user_id !== s.user.id && !(await adminOf(ctx, s))) throw new Error("Only the category's maker or an admin may change it");
  return c;
}

async function editableTemplate(ctx: CtMcpContext, s: CtSession, id: string): Promise<CtPrintTemplate> {
  const t = await printTpl.getTemplate(s, id);
  if (!t) throw new Error("No such khuôn in — list_print_templates");
  if (t.user_id !== s.user.id && !(await adminOf(ctx, s))) throw new Error("Only the khuôn's maker or an admin may change it");
  return t;
}

async function ownTask(ctx: CtMcpContext, s: CtSession, id: string): Promise<CtAgentTask> {
  const { data } = await s.supabase.from(CT_TABLES.agentTasks).select("*").eq("id", id).maybeSingle<CtAgentTask>();
  if (!data) throw new Error("No such agent task — list_agent_tasks");
  if (data.user_id !== s.user.id && !(await adminOf(ctx, s))) throw new Error("Only the task's opener or an admin may change it");
  return data;
}

function strings(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : undefined;
}

/** Style reference pictures by url → our own copies (the same upload as the dialog's "Ảnh tham chiếu"). */
async function styleRefs(s: CtSession, urls: string[]): Promise<string[]> {
  if (!urls.length) return [];
  if (urls.length > CT_AI_STYLE_MAX_REFS) throw new Error(`At most ${CT_AI_STYLE_MAX_REFS} reference pictures`);
  const form = new FormData();
  for (const u of urls) {
    if (!/^https:\/\/\S+$/.test(u)) throw new Error(`Not an https link: ${u}`);
    form.append("file", new File([new Uint8Array(await fetchImage(u))], "ref.png"));
  }
  return ((await answer(await st.uploadAiStyleRefs(s, form))).urls as string[]) ?? [];
}

function styleOut(style: Record<string, unknown>): Record<string, unknown> {
  const p = normalizeAiStyleParams(style.params as never);
  return { id: style.id, ref: aiStyleRef(String(style.id)), name: style.name, promptLength: String(style.prompt ?? "").length, aspect: p.aspect, askName: p.askName, removeBackground: p.removeBackground, refUrls: p.refUrls, demoUrl: p.demoUrl || null };
}

const CATEGORY_PROPS = {
  name: { type: "string", description: "Category name (1–120 characters)." },
  parent_id: { type: "string", description: "Parent category id (\"\" = top level)." },
  usage: { type: "string", description: "element (default) | main — main = the cliparts are a product's main picture (versions)." },
  mode: { type: "string", description: "origin_set (default: each clipart its own origin) | variant_set (members of one origin are variants)." },
  spec: { type: "string", description: "The category's drawing spec (what the AI and the team draw for it)." },
  rules: { type: "object", description: "The category's rules object (get_category → rules); given whole." },
  sort_order: { type: "number", description: "Position in the list." },
};

const IMAGE_IN = {
  image_url: { type: "string", description: "An https link to the picture." },
  data_base64: { type: "string", description: "Or the file itself, base64 (a data: url works too) — for a file on the caller's machine." },
};

export const CT_MCP_LIBRARY_TOOLS: CtMcpTool[] = [
  // ---------------------------------------------------------------- clipart library
  {
    name: "create_category",
    description: "Thư viện clipart: a new category (the library page's \"+ Danh mục\"). → the category.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, ...CATEGORY_PROPS }, required: ["name"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const body: CtCategoryBody = { name: str(args.name), parent_id: str(args.parent_id) || null, usage: args.usage === "main" ? "main" : "element", mode: args.mode === "variant_set" ? "variant_set" : "origin_set", spec: str(args.spec), rules: (args.rules ?? {}) as CtCategoryBody["rules"], ...(typeof args.sort_order === "number" ? { sort_order: args.sort_order } : {}) };
      return json(await answer(await lib.createCategory(s, body)));
    },
  },
  {
    name: "update_category",
    description: "Thư viện clipart: change a category (name, parent, usage, mode, spec, rules, order) — only the fields given change. Its maker or an admin. → the category.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, category_id: { type: "string", description: "From list_categories." }, ...CATEGORY_PROPS }, required: ["category_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "category_id");
      const c = await editableCategory(ctx, s, id);
      const body: CtCategoryBody = {
        name: typeof args.name === "string" ? args.name : c.name,
        parent_id: args.parent_id === undefined ? c.parent_id : str(args.parent_id) || null,
        usage: args.usage === "main" || args.usage === "element" ? args.usage : c.usage,
        mode: args.mode === "variant_set" || args.mode === "origin_set" ? args.mode : c.mode,
        spec: typeof args.spec === "string" ? args.spec : c.spec,
        rules: (args.rules ?? c.rules) as CtCategoryBody["rules"],
        sort_order: typeof args.sort_order === "number" ? args.sort_order : c.sort_order,
      };
      return json(await answer(await lib.updateCategory(s, id, body)));
    },
  },
  {
    name: "delete_category",
    description: "Thư viện clipart: delete an EMPTY category (refused while it holds cliparts or sub-categories — move them first with update_clipart / update_category). Its maker or an admin.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, category_id: { type: "string", description: "From list_categories." } }, required: ["category_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "category_id");
      await editableCategory(ctx, s, id);
      await answer(await lib.deleteCategory(s, id));
      return json({ deleted: true, category_id: id });
    },
  },
  {
    name: "upload_clipart",
    description:
      "Thư viện clipart: add a picture to the library (the library page's upload) — a new origin in category_id, or with parent_id a member of that origin's set (rendition true = a vật liệu version of it). PNG with a transparent background for an element. → the clipart.",
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        ...IMAGE_IN,
        category_id: { type: "string", description: "The category (list_categories); leave out = uncategorised." },
        parent_id: { type: "string", description: "A set member / rendition of this clipart." },
        rendition: { type: "boolean", description: "true = a vật liệu version of parent_id." },
        name: { type: "string", description: "Name (default: the file name)." },
        spec: { type: "string", description: "What it is / how it is drawn." },
        tags: { type: "array", items: { type: "string" }, description: "Search tags." },
      },
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const data = await fileOf(args);
      const name = nameOf(args, "image_url", "clipart").replace(/\.[a-z0-9]+$/i, "");
      const form = new FormData();
      form.set("file", new File([new Uint8Array(data)], `${name}.png`));
      form.set("name", name);
      if (str(args.category_id)) form.set("category_id", idOf(args, "category_id"));
      if (str(args.parent_id)) form.set("parent_id", idOf(args, "parent_id"));
      if (args.rendition === true) form.set("rendition", "1");
      if (str(args.spec)) form.set("spec", str(args.spec));
      form.set("tags", JSON.stringify(strings(args.tags) ?? []));
      form.set("source", "upload");
      return json(await answer(await lib.uploadClipart(s, form)));
    },
  },
  {
    name: "update_clipart",
    description: "Thư viện clipart: change a library clipart (name, spec, tags, category — an origin only, its set follows —, order, license). Only the fields given change. Its maker or an admin. → the clipart.",
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        clipart_id: { type: "string", description: "From list_cliparts." },
        name: { type: "string", description: "New name." },
        spec: { type: "string", description: "New spec." },
        tags: { type: "array", items: { type: "string" }, description: "The tags (given whole)." },
        category_id: { type: "string", description: "Move to this category (\"\" = uncategorised)." },
        sort_order: { type: "number", description: "Position." },
        license: { type: "string", description: "License note." },
      },
      required: ["clipart_id"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "clipart_id");
      const body: CtUpdateClipartBody = {};
      if (typeof args.name === "string") body.name = args.name;
      if (typeof args.spec === "string") body.spec = args.spec;
      if (typeof args.license === "string") body.license = args.license;
      if (typeof args.sort_order === "number") body.sort_order = args.sort_order;
      const tags = strings(args.tags);
      if (tags) body.tags = tags;
      if (args.category_id !== undefined) body.category_id = str(args.category_id) ? idOf(args, "category_id") : null;
      if (!Object.keys(body).length) throw new Error("Nothing to change");
      return json(await answer(await lib.updateClipart(s, id, body)));
    },
  },
  {
    name: "clipart_usage",
    description: "Thư viện clipart: the products that use a clipart (placed in a zone, picked as a version) — look before delete_clipart / replace_clipart.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, clipart_id: { type: "string", description: "From list_cliparts." } }, required: ["clipart_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => json(await answer(await lib.getClipartUsage(await session(ctx, args), idOf(args, "clipart_id")))),
  },
  {
    name: "delete_clipart",
    description:
      "Thư viện clipart: delete a clipart with its set members / renditions. Refused while a product uses it (the error lists them) unless force true: then it is taken out of those products first. Its maker or an admin. Ask the editor before force.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, clipart_id: { type: "string", description: "From list_cliparts." }, force: { type: "boolean", description: "true = take it out of the products that use it, then delete." } }, required: ["clipart_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "clipart_id");
      await answer(await lib.deleteClipart(s, id, args.force === true));
      return json({ deleted: true, clipart_id: id });
    },
  },
  {
    name: "replace_clipart",
    description:
      "Thư viện clipart: a better clipart takes an old one's place (after an edit) — every product using clipart_id switches to with_id, then the old one is deleted. Both origins, or members of the same origin. keep_renditions true = its vật liệu versions move too (to be made again). Its maker or an admin.",
    inputSchema: {
      type: "object",
      properties: { ...OPT_TASK_ARG, clipart_id: { type: "string", description: "The old clipart." }, with_id: { type: "string", description: "The new clipart (already in the library)." }, keep_renditions: { type: "boolean", description: "Move its vật liệu versions too." } },
      required: ["clipart_id", "with_id"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => json(await answer(await lib.replaceClipart(await session(ctx, args), idOf(args, "clipart_id"), idOf(args, "with_id"), args.keep_renditions === true))),
  },
  {
    name: "promote_to_library",
    description: "Move a picture of a product (an asset, get_product → assets) into the clipart library, in category_id (the editor's \"Đưa vào thư viện\"). Its maker or an admin.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, asset_id: { type: "string", description: "The product's asset." }, category_id: { type: "string", description: "The library category (list_categories)." } }, required: ["asset_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => json(await answer(await lib.promoteAsset(await session(ctx, args), idOf(args, "asset_id"), str(args.category_id) ? idOf(args, "category_id") : null))),
  },
  // ---------------------------------------------------------------- fonts
  {
    name: "list_fonts",
    description: "The team's font library (the editor's text layers pick from it): family, name, url, who uploaded it.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG } },
    callers: ["agent", "user"],
    run: async (ctx, args) => json(await answer(await fonts.listFonts(await session(ctx, args)))),
  },
  {
    name: "upload_font",
    description: "Add a font to the library (.ttf / .otf / .woff — not .woff2, ≤ 15 MB). The same file twice gives back the one already there (existed true). → the font (its family is what a text layer uses).",
    inputSchema: {
      type: "object",
      properties: { ...OPT_TASK_ARG, font_url: { type: "string", description: "An https link to the font file." }, data_base64: { type: "string", description: "Or the file itself, base64." }, name: { type: "string", description: "Display name (default: the file name)." } },
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const data = await fileOf(args, "font_url");
      const file = nameOf({ name: "", font_url: args.font_url }, "font_url", "font.ttf");
      const form = new FormData();
      form.set("file", new File([new Uint8Array(data)], file));
      if (str(args.name)) form.set("name", str(args.name));
      return json(await answer(await fonts.uploadFont(s, form)));
    },
  },
  {
    name: "delete_font",
    description: "Take a font out of the library (its uploader or an admin). Text layers that use it keep their file.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, font_id: { type: "string", description: "From list_fonts." } }, required: ["font_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const id = idOf(args, "font_id");
      await answer(await fonts.deleteFont(await session(ctx, args), id));
      return json({ deleted: true, font_id: id });
    },
  },
  // ---------------------------------------------------------------- AI photo styles
  {
    name: "create_ai_style",
    description: `A new AI photo style in the library (the "Kiểu ảnh AI" page's "+ Thêm"): name, prompt (≤ ${CT_AI_STYLE_PROMPT_MAX} characters; [NAME] = the name the customer types), aspect, ask_name, remove_background (default true), ref_urls (≤ ${CT_AI_STYLE_MAX_REFS} style reference pictures, copied to our storage). Then make_ai_style_demo for its tile picture. → the style.`,
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        name: { type: "string", description: "Customer-facing name." },
        prompt: { type: "string", description: "The whole prompt." },
        aspect: { type: "string", description: `${CT_AI_STYLE_ASPECTS.map((x) => x.id).join(" | ")} (default auto).` },
        ask_name: { type: "boolean", description: "The customer types a name." },
        remove_background: { type: "boolean", description: "Cut the subject out (default true)." },
        ref_urls: { type: "array", items: { type: "string" }, description: "https style reference pictures." },
      },
      required: ["name", "prompt"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      if (args.aspect !== undefined && !isAiStyleAspect(args.aspect)) throw new Error(`aspect: ${CT_AI_STYLE_ASPECTS.map((x) => x.id).join(", ")}`);
      const refUrls = await styleRefs(s, strings(args.ref_urls) ?? []);
      const params = normalizeAiStyleParams({ ...(isAiStyleAspect(args.aspect) ? { aspect: args.aspect } : {}), askName: args.ask_name === true, removeBackground: args.remove_background !== false, refUrls });
      const body: CtAiStyleBody = { name: str(args.name), prompt: str(args.prompt), model: CT_AI_STYLE_MODEL, params };
      const out = await answer(await st.createAiStyle(s, body));
      return json({ style: styleOut(out.style as Record<string, unknown>) });
    },
  },
  {
    name: "delete_ai_style",
    description: "Delete an AI photo style of the library (its maker or an admin). Products that offer it lose it on their next deploy — check with the editor first.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, style_id: { type: "string", description: "From list_ai_styles (id, not the ai: ref)." } }, required: ["style_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const id = idOf({ id: str(args.style_id).replace(/^ai:/, "") }, "id");
      await answer(await st.deleteAiStyle(await session(ctx, args), id));
      return json({ deleted: true, style_id: id });
    },
  },
  {
    name: "make_ai_style_demo",
    description: "Run an AI photo style on a sample photo and keep the result as its demo (the tile the editor and the customer pick it by) — the dialog's \"Tạo ảnh demo\". sample_url = your own sample photo (default: the last sample, else the stock pet). One AI picture (~1 min). Its maker or an admin. → the style with demoUrl.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, style_id: { type: "string", description: "From list_ai_styles." }, sample_url: { type: "string", description: "https sample photo (optional)." } }, required: ["style_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf({ id: str(args.style_id).replace(/^ai:/, "") }, "id");
      const form = new FormData();
      const url = str(args.sample_url).trim();
      if (url) {
        if (!/^https:\/\/\S+$/.test(url)) throw new Error("sample_url must be an https link");
        form.set("sample", new File([new Uint8Array(await fetchImage(url))], "sample.jpg"));
      }
      const out = await answer(await st.makeAiStyleDemo(s, id, form));
      return json({ style: styleOut(out.style as Record<string, unknown>) });
    },
  },
  // ---------------------------------------------------------------- khuôn in
  {
    name: "draw_print_template_ai",
    description:
      "Khuôn in: let the AI draw a khuôn (the khuôn page's \"Vẽ khuôn bằng AI\") from a prompt + sample photos / pattern drawings (refs, ≤ 4 https). NOT saved: you get {width, height, faces} — look, ask again, then keep it with save_print_template (spec = {width, height, faces, …}). template_id = redraw that khuôn's shape. One AI picture.",
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        prompt: { type: "string", description: "What the piece is: shape, size, holes…" },
        refs: { type: "array", items: { type: "string" }, description: "https photos / drawings of the piece." },
        faces: { type: "array", items: { type: "string" }, description: "Face names (\"Mặt trước\", \"Mặt sau\"); empty = one face." },
        mirror: { type: "boolean", description: "The back is the front mirrored." },
        width: { type: "number", description: "Sheet px wanted (0 = from the drawing)." },
        height: { type: "number", description: "Sheet px wanted (0 = from the drawing)." },
        dpi: { type: "number", description: "300 small hard goods, 150 big soft ones." },
        template_id: { type: "string", description: "Redraw this khuôn's shape (optional)." },
      },
      required: ["prompt"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const body = { templateId: str(args.template_id) ? idOf(args, "template_id") : null, prompt: str(args.prompt), refs: strings(args.refs) ?? [], faces: strings(args.faces) ?? [], mirror: args.mirror === true, width: Number(args.width) || 0, height: Number(args.height) || 0, dpi: Number(args.dpi) || 300 };
      return json(await answer(await khuonAi(s, body)));
    },
  },
  {
    name: "save_print_template",
    description:
      "Khuôn in: save a khuôn of ANY shape (the khuôn page's editor: faces, safe zones, holes, zones, sizes) — the free form create_print_template (rectangle in mm) cannot make. No template_id = a new khuôn (name, kind, spec all needed); with template_id = change it (only what is given; spec given whole — get_print_template, change, send back). A face given only as a picture (imageUrl) is read by the server: solid lines = the piece, dashed = safe zone. Its maker or an admin. → the khuôn.",
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        template_id: { type: "string", description: "The khuôn to change (leave out = new)." },
        name: { type: "string", description: "Vietnamese name with the size." },
        kind: { type: "string", description: "flat | cut | panels." },
        spec: { type: "object", description: "The whole spec (get_print_template → spec, or draw_print_template_ai's {width, height, faces})." },
      },
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const body = { ...(typeof args.name === "string" ? { name: args.name } : {}), ...(args.kind !== undefined ? { kind: args.kind } : {}), ...(args.spec !== undefined ? { spec: args.spec } : {}) } as Parameters<typeof printTpl.createTemplate>[1];
      if (!str(args.template_id)) return json(await answer(await printTpl.createTemplate(s, body)));
      const id = idOf(args, "template_id");
      await editableTemplate(ctx, s, id);
      if (!Object.keys(body).length) throw new Error("Nothing to change");
      return json(await answer(await printTpl.updateTemplate(s, id, body)));
    },
  },
  {
    name: "make_template_blank_ai",
    description: "Khuôn in: the AI draws a phôi (the blank piece, nothing printed) for a khuôn — the khuôn page's \"Phôi AI\". base_id = from that base's page: its photos + description go to the AI too. One AI picture. → the khuôn (blanks[]); set_template_blank to make it the default.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, template_id: { type: "string", description: "From list_print_templates." }, base_id: { type: "string", description: "A product base (optional)." } }, required: ["template_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "template_id");
      await editableTemplate(ctx, s, id);
      return json(await answer(await aiTemplateBlank(s, id, str(args.base_id) ? { baseId: idOf(args, "base_id") } : {})));
    },
  },
  // ---------------------------------------------------------------- pictures, artworks
  {
    name: "upload_image",
    description: "A picture (png / jpg / webp ≤ 25 MB) → a url on FlexiPrint's storage, for every tool that takes an image url (char_add_reference, add_template_blank, ref_urls…). data_base64 = a file on the caller's machine; image_url = copy a picture from another site (links that expire, sites that block us).",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, ...IMAGE_IN } },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const form = new FormData();
      form.set("file", new File([new Uint8Array(await fileOf(args))], "image"));
      return json(await answer(await printTpl.uploadTemplateImage(s, form)));
    },
  },
  {
    name: "create_blank_artwork",
    description: "A new EMPTY artwork (the list's \"+ Artwork\"): on a product base (base_product_id — its print area is the canvas) or a free white canvas width × height px (no base). Fill it in the editor, or with set_artwork_layers. → the artwork (product row).",
    inputSchema: {
      type: "object",
      properties: { ...OPT_TASK_ARG, name: { type: "string", description: "Artwork name." }, base_product_id: { type: "string", description: "From list_base_products (optional)." }, width: { type: "number", description: "No base: canvas px." }, height: { type: "number", description: "No base: canvas px." } },
      required: ["name"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const body = { name: str(args.name), ...(str(args.base_product_id) ? { baseProductId: idOf(args, "base_product_id") } : {}), ...(Number(args.width) > 0 ? { width: Number(args.width) } : {}), ...(Number(args.height) > 0 ? { height: Number(args.height) } : {}) };
      return json(await answer(await createArtwork(s, body)));
    },
  },
  // ---------------------------------------------------------------- the editor's agent tasks (user only)
  {
    name: "list_agent_tasks",
    description: "The @flexiprint agent tasks the editor's buttons open: kind content (product text), mockup (redo a failed mockup), base_preview (a base's store preview), char (a bộ nhân vật). collection = that product / base / bộ's tasks (anyone's); leave out = your own latest.",
    inputSchema: { type: "object", properties: { kind: { type: "string", description: "content | mockup | base_preview | char (leave out = content + char)." }, collection: { type: "string", description: "Product id (content, mockup), base id (base_preview) or bộ id (char)." } } },
    callers: ["user"],
    run: async (ctx, args) => {
      const out = await answer(await listAgentTasks(await session(ctx, args), str(args.kind) || null, str(args.collection) || null));
      const tasks = (out.tasks as CtAgentTask[]) ?? [];
      return json({ tasks: tasks.map((t) => ({ id: t.id, kind: t.kind, status: t.status, created_at: t.created_at, updated_at: t.updated_at, error: t.error ?? null, questions: (t.questions ?? []).filter((q) => !q.answer).map((q) => ({ id: q.id, question: q.question })) })) });
    },
  },
  {
    name: "open_agent_task",
    description:
      "Hand a job to the @flexiprint agent like the editor's buttons do — input as the page sends it: kind content {content: {productId, request, title?, descriptionHtml?, facts?, imageUrls?}} (\"Viết nội dung\"), kind mockup {mockup: {productId, jobId, request?}} (redo a FAILED mockup job), kind base_preview {basePreview: {baseId, request?}} (one at a time per base: an open one is given back), kind char {char: {projectId, step: brainstorm|master|edits|chat|auto, request, tab?}}. The agent works on its own; follow it with get_task / list_agent_tasks.",
    inputSchema: { type: "object", properties: { kind: { type: "string", description: "content | mockup | base_preview | char." }, input: { type: "object", description: "The task's input, as described." } }, required: ["kind", "input"] },
    callers: ["user"],
    run: async (ctx, args) => json(await answer(await createAgentTask(await session(ctx, args), { kind: str(args.kind), input: args.input }))),
  },
  {
    name: "cancel_agent_task",
    description: "Stop an agent task you opened (its \"Huỷ\" button); admins any. → the task, status cancelled.",
    inputSchema: { type: "object", properties: { agent_task_id: { type: "string", description: "From list_agent_tasks." } }, required: ["agent_task_id"] },
    callers: ["user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "agent_task_id");
      await ownTask(ctx, s, id);
      const t = (await answer(await cancelAgentTask(s, id))) as unknown as CtAgentTask;
      return json({ id: t.id, kind: t.kind, status: t.status });
    },
  },
  {
    name: "answer_agent_task",
    description: "Answer the question an agent task is waiting on (list_agent_tasks → questions): choices (the options picked) and / or text. The agent goes on with it.",
    inputSchema: {
      type: "object",
      properties: { agent_task_id: { type: "string", description: "The task." }, question_id: { type: "string", description: "The open question's id." }, choices: { type: "array", items: { type: "string" }, description: "Options picked." }, text: { type: "string", description: "Free answer." } },
      required: ["agent_task_id", "question_id"],
    },
    callers: ["user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "agent_task_id");
      await ownTask(ctx, s, id);
      const t = (await answer(await answerAgentTask(s, id, { question_id: str(args.question_id), choices: strings(args.choices) ?? [], text: str(args.text) }))) as unknown as CtAgentTask;
      return json({ id: t.id, status: t.status });
    },
  },
  // ---------------------------------------------------------------- bộ nhân vật list
  {
    name: "char_list_sets",
    description: "The bộ nhân vật page's list: every set, newest first, with its preview picture, master and products.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, q: { type: "string", description: "Only sets whose name has this (optional)." } } },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const out = await answer(await listCharProjects(await session(ctx, args)));
      const q = str(args.q).trim().toLowerCase();
      const thumbs = (out.thumbs ?? {}) as Record<string, string>;
      const sets = ((out.projects as Array<{ id: string; name: string; user_id: string | null; master_id: string | null; product_ids: string[]; updated_at: string }>) ?? [])
        .filter((p) => !q || p.name.toLowerCase().includes(q))
        .map((p) => ({ id: p.id, name: p.name, user_id: p.user_id, master_id: p.master_id, product_ids: p.product_ids, updated_at: p.updated_at, thumb: thumbs[p.id] || null }));
      return json({ sets });
    },
  },
  {
    name: "char_rename_set",
    description: "Rename a bộ nhân vật (its maker or an admin).",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, project_id: { type: "string", description: "The bộ (char_list_sets)." }, name: { type: "string", description: "New name." } }, required: ["project_id", "name"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      if (!str(args.name).trim()) throw new Error("name is empty");
      const out = await answer(await updateCharProject(await session(ctx, args), idOf(args, "project_id"), { name: str(args.name) }));
      const p = out.project as { id: string; name: string };
      return json({ id: p.id, name: p.name });
    },
  },
  {
    name: "char_delete_set",
    description: "Delete a bộ nhân vật with its pictures and its version sets (its maker or an admin). Its products stay. Cannot be undone: confirm must be true, and ask the editor first.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, project_id: { type: "string", description: "The bộ." }, confirm: { type: "boolean", description: "true = really delete." } }, required: ["project_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const id = idOf(args, "project_id");
      if (args.confirm !== true) throw new Error("Not deleted: confirm must be true (ask the editor first)");
      await answer(await deleteCharProject(await session(ctx, args), id));
      return json({ deleted: true, project_id: id });
    },
  },
];

