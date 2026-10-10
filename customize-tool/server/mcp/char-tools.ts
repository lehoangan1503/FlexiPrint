/**
 * flexiprint-mcp — v2 bộ nhân vật (agent task kind "char", migration 022). Asked 2026-10-08: every suggestion and
 * prompt of v2 is written by @flexiprint, which reads the DB and this code; the server only runs what it asks:
 *
 *   brainstorm  get_task gives the brief rules → submit_result {summary, questions, ideas} → a new idea round
 *   master      char_draw_masters (the agent's own prompt) → char_wait → view_image → char_refine_master … →
 *               submit_result {summary, image_ids: recommended, best first}; the editor approves one
 *   edits       get_task lists the planned in-place edits (lib/char-plan.ts) with a starting prompt each →
 *               char_run_edits {prompts by role} → char_wait → view_image → redo the wrong ones → submit_result
 *
 * Every picture uses the team's image model (server/char/projects.ts). A bộ nhân vật's tasks are one agent_ide
 * session (server/agent/tasks.ts), so "như lần trước" refers to the earlier steps.
 */

import { CT_TABLES } from "../../config";
import type { CtAgentTask, CtAgentTaskProgress, CtCharImage, CtCharProject, CtCharTaskResult } from "../../types";
import { REF_USE_INFO, masterPrompt } from "../../lib/char-brief";
import { KEEP, KEEP_CLEAR, KEY, planEdits, tailOf } from "../../lib/char-plan";
import { latestEditsOf } from "../../lib/char-images";
import { imageModelLabel } from "../../lib/image-models";
import type { CtServiceClient } from "../supabase";
import { currentImageModel } from "../settings";
import { clip, record, str } from "../ai/llm";
import { CHAR_BRIEF_RULES, ideaRoundFrom } from "../char/brainstorm";
import { KEEP_REFINE, drawIdeaPreviews, drawMasters, loadImages, loadProject, projectRow, refineMasterImage } from "../char/projects";
import { runEditRoles } from "../char/layers";
import { TASK_ARG, json, liveStatus, loadTask, openTask, patchTask } from "./task-common";
import type { CtMcpContext, CtMcpTool } from "./tools";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WAIT_MS = 170_000;
const POLL_MS = 4_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const COMMON = [
  "You work on a v2 bộ nhân vật (character set) of FlexiPrint: ONE approved AI master illustration → pixel-registered layers (the customer swaps hair, colours, outfits…) → print products. READ flexiprint://guide/layer-rules first if you have not in this session — every picture after the master is an IN-PLACE edit of it.",
  "The image model is the team's (get_task \"imageModel\", default GPT Image 2.5 on the company API). GPT Image canvases: 1024×1536 (portrait), 1536×1024 (landscape), 1024×1024. It re-draws a little of what it keeps (≈ 0.2 % scale, < 1 px per character): layer-kit measures and undoes that, so an edit is usable when what must stay looks the same — never ask it to move, zoom or re-frame.",
  "Write prompts in English. Talk to the editor (report_progress, summary, ask_user) in Vietnamese. report_progress before every batch of pictures (~30–60 s each).",
  "Pictures you make appear live in the editor's page. Look at every one with view_image before you judge it.",
  "\"references\" are pictures the editor dropped into the brief, each with a use (sample | style | character | outfit | pose | product | avoid) and the editor's note in Vietnamese — that note is what they want from it. view_image EVERY reference before you write anything. style / character / outfit / pose ones are attached to every master drawing automatically (with a line saying what to take from each) — your prompt must agree with them, never contradict them. product = how it should sit on the product; avoid = what must NOT be made. sample = a FINISHED product the editor wants something like (often the only picture): read everything from it — the product (shape, cut, size), the art style, every character (left → right: look, hair, skin, outfit, pose), the text (what it says, where, which parts are names the customer types), the decor and background — and turn it into the brief: characters → subjects, their hair / colours / outfits → slots (what the customer may change, per the note; ask_user when the note does not say), text → text, background / ornaments → decor (never part of the master). The master is only the characters on white; the rest comes back as separate layers.",
];

const BRAINSTORM_INSTRUCTIONS = [
  ...COMMON,
  "STEP brainstorm — turn the editor's idea into briefs. The brief rules and the result format are in \"briefRules\" (follow them exactly: English option names, slot modes, poses that keep parts separable).",
  "1. Read the idea, the request, the brief so far, the earlier rounds and steps; view_image every reference and the blank product. The briefs you write must follow what the references show and their notes (style sentence from the style references, subjects described as the character / outfit references show them, scene from the pose ones) — and say in each idea's \"why\" which reference it follows. A reference you cannot tell what to take from → ask_user.",
  "2. Only when something decides everything and you cannot guess it (the product, the cast), ask_user once with options. Otherwise go on.",
  "The piece: brief.product.templateId / layout (a khuôn in — list_print_templates) when the editor picked one; keep them in every idea and compose for its safe zone (a round ornament: everyone inside the centred circle, the top centre clear for the hole). None picked and the product is clear → set templateId + layout from list_print_templates yourself.",
  "3. submit_result(task_id, {summary, questions, ideas: [exactly 3 × {title, why, brief}]}) — the page shows them as directions the editor can take, each with a master the server draws from its brief (so every brief must be complete enough to draw).",
].join("\n");

const MASTER_INSTRUCTIONS = [
  ...COMMON,
  "STEP master — make the ONE master every layer will be cut from. \"assembledPrompt\" is the server's template from the brief: a starting point, not a rule — improve it.",
  "1. Read the brief (style, subjects left → right, slots with their FIRST option = how the master shows it, photo zones, product). view_image every reference (and their notes) and the blank product.",
  "2. Write the master prompt: the style; every subject in order, full body, its fixed clothing + the first option of every slot, PLAIN solid colours with the hex when given (no pattern, logo, text on any part a customer recolours); the pose / arrangement with a small gap between subjects (nobody covers another one's customisable part, no hair over someone else, pets beside the feet); photo zones drawn EMPTY (plain light grey, clean edge); the group centred with a generous empty margin; pure flat white background, no floor, no cast shadow, no scenery, no text. For a die-cut product (cut \"alpha\") everything must be one connected silhouette.",
  "3. char_draw_masters(task_id, prompt, count 2) → char_wait → view_image. Check: it follows the references as their notes say (style, faces, outfits) without copying anything else; every subject, in order, nobody cropped; every customisable part clearly visible and plain; hair fully visible (it will be removed and re-added); white background clean; photo zones empty; the style right.",
  "4. A candidate that is close: char_refine_master(task_id, image_id, prompt) with ONE precise change (\"make the dog 20 % smaller, keep it where it is\") — an in-place edit, the rest stays. A candidate that is wrong overall: fix the prompt and draw again. At most ~3 rounds; then submit what is best and say what is still off.",
  "5. A refinement request (task \"imageId\" set): edit THAT master by the request (char_refine_master), check it, submit it.",
  "6. submit_result(task_id, {summary: Vietnamese — what you drew, what you checked, what is still off; image_ids: the masters you recommend, best first}). The editor approves one — you never approve.",
].join("\n");

const EDITS_INSTRUCTIONS = [
  ...COMMON,
  "STEP edits (UI: 3b \"AI tô vùng clipart\") — the in-place pictures the clipart cut is made FROM (layer-rules §9b: each part's magenta paint / in-place option IS its region, so paint the WHOLE part and nothing else) (\"edits\" lists every one: role, what it is for, the source it is made from, a starting prompt, and the current result if any). The server decides WHICH edits exist; you write HOW each is asked.",
  "Roles: work = the approved master itself (no prompt) · base = every \"shape\" part removed (bald heads, no hats) · part:<slot> = a shape part painted magenta on the master (with several shape slots — the master's part is cut by it) · mask:<slot> = a colour/texture part painted magenta on the base · texture:<slot>:<option> / shape:<slot>:<option> = another material / another shape added on the base · zone:<zone> = a customer-photo zone painted magenta on the base.",
  "1. For each edit write a prompt that changes EXACTLY one thing on the named subject (say which one: \"the second character from the left, the girl in the green sweater\") WITHOUT the keep-everything sentence (\"keepSentence\"): the server appends it to every edit prompt. Magenta edits: solid flat pure magenta #FF00FF over ALL of the part (sleeves, cuffs, the part under hands too), nothing else, no outline change. Base: hair removed completely — a smooth bald scalp, ears visible, nothing else changed (clothes, faces, poses stay). Shape options: the new hairstyle / hat in the same art style, sitting naturally on the bald head of the base, same colour as the master's unless given.",
  "2. char_run_edits(task_id, prompts: {role: prompt}, roles: [...]) — base first when it is missing (everything on the base is made from it; redoing base redoes them), then the rest in one call. \"roles\" runs a role with its starting prompt (get_task shows one example per kind, \"startingPromptExamples\"); give a prompt only where you want a different one. → char_wait → view_image the results (a few at a time).",
  "3. Check each against its purpose: the magenta covers the whole part and only it; the base has no hair left and nothing else changed; shapes look right and match the style; nothing moved. Wrong → a better prompt and char_run_edits for that role again (at most ~3 tries per role).",
  "KEY MODE (get_task clipMode \"key\" — every new project; UI 3b \"AI tạo clipart\"): there is no paint step and no region cut. Each clipart is ONE picture: the part kept as drawn, everything else of every character a flat magenta silhouette, background transparent (the server appends keySentence; base gets baseSentence). layer-kit takes the non-magenta pixels as the file, places it by the silhouette and fits the colours of a master part back to the master. Roles: work · base = the PAPER DOLL (every part any slot changes removed: bald, a smooth skin-tone bodysuit, empty hands, bare arms / feet) — it is used as the body file as it is · clip:<slot>:<option> = a shape option, ALL from work (the first = the master's own part kept; the others = the part taken off and replaced, then kept) · clip:<slot> = a colour / texture part from work (recoloured by code) · clip:<slot>:<option> of a texture slot = that material, from work.",
  "KEY MODE prompts (tested 2026-10-10): a part of the master is asked as \"Turn EVERYTHING magenta except the <part> itself of <who>. Her <every other part BY NAME AND COLOUR: mustard cardigan, red shoes, wine glass, hairstyle (top bun)>, face, arms, legs all become magenta, also where they lie over the <part>; only the <part> keeps its drawing and colours\" — \"keep only the dress\" kept the cardigan and shoes too. Never ask for the part alone on an empty transparent canvas: the model invents a new one anywhere (the silhouettes are what hold it in place). Another option, from work: \"Take OFF the <part> of <who> (the <current option>) and give her a completely DIFFERENT one: <option + colour, its own features>. Nothing of the <current option> stays — not its shape, neckline, belt or details (\"replace with a skater dress\" kept the wrap dress's belt and bow); same pose. Then turn EVERYTHING magenta except that new <part>: <the others by name>…\". Never draw options on the paper doll: on that transparent picture the model re-frames the figures ~10 % bigger and moves the arms — a mug lands beside the hand.",
  "KEY MODE check (view_image each): ONLY the part is in colour (anything else in colour → redo with that thing named magenta); the magenta is flat with no inner lines; the background is transparent (a checkerboard or white drawn in = refused by the server, it retries); the part is complete and where it belongs. An option that came out like the current one (same dress under another name) → redo with what must differ named. The base (paper doll) may be refused by the safety filter: the server retries; word it as a family-friendly paper-doll dress-up base.",
  "4. submit_result(task_id, {summary: Vietnamese — what you ran, what you redid and why, what is still off; image_ids: the final edits}). The editor then cuts the layers (layer-kit) and sees the registration checks.",
].join("\n");

const STEP_INSTRUCTIONS = { brainstorm: BRAINSTORM_INSTRUCTIONS, master: MASTER_INSTRUCTIONS, edits: EDITS_INSTRUCTIONS } as const;

async function charOf(db: CtServiceClient, task: CtAgentTask): Promise<{ project: CtCharProject; images: CtCharImage[] }> {
  const id = task.input.char?.projectId;
  if (task.kind !== "char" || !id) throw new Error("This tool is for bộ nhân vật (char) tasks");
  const project = await loadProject(db, id);
  if (!project) throw new Error("The bộ nhân vật of this task no longer exists");
  return { project, images: await loadImages(db, id) };
}

function picture(im: CtCharImage, numbers?: Map<string, number>) {
  return {
    id: im.id,
    ...(numbers ? { number: numbers.get(im.id) } : {}),
    status: im.status,
    url: im.url,
    width: im.width,
    height: im.height,
    prompt: im.prompt,
    ...(im.note ? { note: im.note } : {}),
    ...(im.parent_id ? { parent_id: im.parent_id } : {}),
    ...(im.model ? { model: imageModelLabel(im.model) } : {}),
    ...(im.meta.align ? { align: im.meta.align } : {}),
    ...(im.error ? { error: im.error } : {}),
  };
}

/** The brief for the edits step: no option / colour ids (the roles carry them), no reference list (references). */
function compactBrief(b: CtCharProject["brief"]) {
  const { refs: _refs, ...rest } = b;
  return {
    ...rest,
    subjects: b.subjects.map((sub) => ({
      ...sub,
      slots: sub.slots.map((sl) => ({ ...sl, options: sl.options.map((o) => ({ name: o.name, value: o.value })), colors: sl.colors.map((x) => ({ name: x.name, value: x.value })) })),
    })),
  };
}

/** An edit prompt without its ending sentence (keep-everything, or key mode's magenta / transparent one — the server
 * adds it: withTail). */
const withoutKeep = (prompt: string) => [KEEP, KEEP_CLEAR, KEY].reduce((p, t) => p.replace(t, ""), prompt).trim();
const withTail = (prompt: string, tail: string) => (prompt.includes(tail.trim()) ? prompt : withoutKeep(prompt).replace(/\.?\s*$/, ".") + tail);

/** get_task of a char task. */
export async function charTaskView(db: CtServiceClient, task: CtAgentTask): Promise<unknown> {
  const c = task.input.char!;
  const { project: p, images } = await charOf(db, task);
  const masters = images.filter((im) => im.kind === "master");
  const numbers = new Map(masters.map((m, i) => [m.id, i + 1]));
  const { data: before } = await db
    .from(CT_TABLES.agentTasks)
    .select("id,created_at,status,input,result,error")
    .eq("kind", "char")
    .eq("input->char->>projectId", p.id)
    .neq("id", task.id)
    .order("created_at")
    .limit(30)
    .returns<Array<Pick<CtAgentTask, "id" | "created_at" | "status" | "input" | "result" | "error">>>();
  const latest = latestEditsOf(images);
  const out: Record<string, unknown> = {
    id: task.id,
    kind: task.kind,
    step: c.step,
    request: c.request,
    ...(c.imageId ? { imageId: c.imageId, what: `Refine master #${numbers.get(c.imageId) ?? "?"} by the request.` } : {}),
    imageModel: imageModelLabel(await currentImageModel()),
    project: {
      id: p.id,
      name: p.name,
      status: p.status,
      approvedMasterId: p.master_id,
      // edits: the brief without the option / colour ids (they are in the roles) — get_task must stay small
      brief: c.step === "edits" ? compactBrief(p.brief) : p.brief,
      layers: p.layers ? { status: p.layers.status, error: p.layers.error, checks: p.layers.checks.filter((x) => !x.ok) } : null,
    },
    // The editor's reference pictures, each with what it is for and their own words about it.
    references: p.brief.refs
      .map((r) => {
        const im = images.find((x) => x.id === r.id && x.status === "done");
        return im ? { id: im.id, use: r.use, editorNote: r.note, sentToImageModel: !!REF_USE_INFO[r.use].take, url: im.url } : null;
      })
      .filter(Boolean),
    blankProduct: images.find((im) => im.id === p.brief.product.blankId && im.status === "done")?.url ?? null,
    // The edits step works on the approved master only (get_task must stay small: the agent's tool output is capped).
    masters:
      c.step === "edits"
        ? masters.filter((m) => m.id === p.master_id).map((m) => ({ id: m.id, number: numbers.get(m.id), url: m.url, width: m.width, height: m.height, approved: true }))
        : masters.map((m) => ({ ...picture(m, numbers), approved: m.id === p.master_id })),
    earlier: (before ?? []).map((t) => ({
      at: t.created_at,
      step: t.input.char?.step,
      request: t.input.char?.request ?? "",
      status: t.status,
      summary: t.result && "summary" in t.result ? clip(str(t.result.summary), 800) : t.error,
    })),
    questions: (task.questions ?? []).map((q) => ({ id: q.id, question: q.question, options: q.options.map((o) => o.label), answer: q.answer })),
    instructions: STEP_INSTRUCTIONS[c.step],
  };
  if (c.step === "brainstorm") {
    out.ideaRounds = p.ideas.slice(-3).map((r) => ({ request: r.request, summary: r.summary, ideas: r.ideas.map((i) => ({ title: i.title, why: i.why })) }));
    out.briefRules = CHAR_BRIEF_RULES;
  }
  if (c.step === "master") out.assembledPrompt = masterPrompt(p.brief);
  if (c.step === "edits") {
    // Compact: 40+ edits on a big brief. The keep sentence is given once; a made edit carries its prompt only when
    // it is not the starting one.
    out.keepSentence = KEEP.trim();
    if (p.brief.clips === "key") {
      out.clipMode = "key";
      out.keySentence = KEY.trim();
      out.baseSentence = KEEP_CLEAR.trim();
    }
    out.edits = planEdits(p.brief).map((e) => {
      const im = latest.get(e.role);
      const current = im
        ? {
            id: im.id,
            status: im.status,
            url: im.url,
            ...(im.prompt && withoutKeep(im.prompt) !== withoutKeep(e.prompt) ? { prompt: clip(withoutKeep(im.prompt), 600) } : {}),
            ...(im.meta.align ? { align: im.meta.align } : {}),
            ...(im.error ? { error: clip(im.error, 300) } : {}),
          }
        : null;
      return { role: e.role, label: e.label, source: e.source, ...(c.roles.length && !c.roles.includes(e.role) ? { notAsked: true } : {}), current };
    });
    // One starting prompt per kind of edit (base, part, shape, mask, texture, zone): the others follow the same
    // pattern; char_run_edits with "roles" runs any role with its own starting prompt.
    const seen = new Set<string>();
    out.startingPromptExamples = planEdits(p.brief)
      .filter((e) => e.prompt && !seen.has(e.role.split(":")[0]) && seen.add(e.role.split(":")[0]))
      .map((e) => ({ role: e.role, prompt: withoutKeep(e.prompt) }));
    if (c.roles.length) out.what = `Only these roles were asked: ${c.roles.join(", ")}.`;
  }
  return out;
}

/** A progress line with pictures on the task (the editor watches it). */
async function progress(db: CtServiceClient, taskId: string, text: string, images: string[] = []): Promise<void> {
  const { data: task } = await db.from(CT_TABLES.agentTasks).select("*").eq("id", taskId).single<CtAgentTask>();
  if (!task) return;
  const line: CtAgentTaskProgress = { at: new Date().toISOString(), text, ...(images.length ? { images } : {}), kind: "run" };
  await patchTask(db, task.id, { status: liveStatus(task), progress: [...(task.progress ?? []), line].slice(-50) });
}

/** submit_result of a char task → the result row (throws a message the agent can act on). */
export async function submitCharResult(db: CtServiceClient, task: CtAgentTask, raw: Record<string, unknown>, summary: string): Promise<CtCharTaskResult> {
  const c = task.input.char!;
  const { project: p, images } = await charOf(db, task);
  const mine = images.filter((im) => im.meta.taskId === task.id);
  const running = mine.filter((im) => im.status === "running");
  if (running.length) throw new Error(`Not submitted — ${running.length} picture(s) of this task still being drawn: call char_wait with ${running.map((im) => im.id).join(", ")}, look at them, then submit.`);
  const ids = [...new Set((Array.isArray(raw.image_ids) ? raw.image_ids : Array.isArray(raw.imageIds) ? raw.imageIds : []).map(str).filter((x) => UUID.test(x)))];
  if (c.step === "brainstorm") {
    const round = ideaRoundFrom(raw, p, c.request);
    const { error } = await db.from(CT_TABLES.charProjects).update({ ideas: [...p.ideas, round].slice(-10) }).eq("id", p.id);
    if (error) throw new Error(error.message);
    // Each direction drawn once, so the editor sees it before choosing (a failed picture never fails the round).
    if (task.user_id) await drawIdeaPreviews(db, task.user_id, p, round).catch((e: Error) => console.warn("[ct] idea previews", e.message));
    return { step: c.step, summary, roundId: round.id };
  }
  if (c.step === "master") {
    const ok = new Set(images.filter((im) => im.kind === "master" && im.status === "done").map((im) => im.id));
    const bad = ids.filter((x) => !ok.has(x));
    if (bad.length) throw new Error(`Not submitted — not a finished master of this bộ: ${bad.join(", ")}`);
    if (!ids.length && !mine.some((im) => im.kind === "master" && im.status === "done")) throw new Error('Result needs "image_ids": the masters you recommend (make them with char_draw_masters / char_refine_master)');
    return { step: c.step, summary, imageIds: ids };
  }
  const editRows = images.filter((im) => im.kind === "edit");
  if (editRows.some((im) => im.status === "running")) throw new Error("Not submitted — edits of this bộ are still running: char_wait for them first.");
  return { step: c.step, summary, imageIds: ids.length ? ids : mine.filter((im) => im.kind === "edit" && im.status === "done").map((im) => im.id) };
}

function taskDb(ctx: CtMcpContext): CtServiceClient {
  if (!ctx.service) throw new Error("Tasks need the agent token");
  return ctx.service;
}

async function openCharTask(ctx: CtMcpContext, id: unknown): Promise<{ db: CtServiceClient; task: CtAgentTask; project: CtCharProject }> {
  const { db, task } = await loadTask(ctx, id);
  openTask(task);
  const { project } = await charOf(db, task);
  if (!task.user_id) throw new Error("The task has no owner");
  return { db: taskDb(ctx), task, project: projectRow(project) };
}

export const CT_MCP_CHAR_TOOLS: CtMcpTool[] = [
  {
    name: "char_draw_masters",
    description:
      "Bộ nhân vật (char task, step master): draw master candidates from YOUR prompt with the team's image model (~30–60 s each, in the background). Returns their ids at once — then char_wait, then view_image. The style reference picture of the brief (if any) is sent with it automatically.",
    inputSchema: {
      type: "object",
      properties: {
        ...TASK_ARG,
        prompt: { type: "string", description: "The full English master prompt." },
        count: { type: "number", description: "1–4 candidates (default 2)." },
        aspect: { type: "string", description: "2:3 (default for 1–2 subjects) | 3:2 (3+ subjects, wide groups) | 1:1 — the model's own canvases." },
      },
      required: ["task_id", "prompt"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id);
      if (task.input.char?.step !== "master") throw new Error("char_draw_masters is for the master step");
      const prompt = clip(str(args.prompt), 8000);
      if (!prompt) throw new Error("prompt is required");
      const rows = await drawMasters(db, task.user_id!, project, { prompt, count: Number(args.count) || 2, aspect: str(args.aspect) || null, taskId: task.id });
      await progress(db, task.id, `Đang vẽ ${rows.length} master`);
      return json({ image_ids: rows.map((r) => r.id), next: "char_wait with these ids, then view_image." });
    },
  },
  {
    name: "char_refine_master",
    description:
      "Bộ nhân vật (step master): an IN-PLACE edit of one master candidate — your prompt says the one change; a sentence keeping everything else (same characters, pose, framing, white background) is appended. Returns the new candidate's id → char_wait.",
    inputSchema: {
      type: "object",
      properties: {
        ...TASK_ARG,
        image_id: { type: "string", description: "The master to edit (id from get_task masters or char_wait)." },
        prompt: { type: "string", description: "English: exactly what to change." },
        note: { type: "string", description: "Vietnamese, short: what you changed (shown under the picture)." },
      },
      required: ["task_id", "image_id", "prompt"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id);
      if (task.input.char?.step !== "master") throw new Error("char_refine_master is for the master step");
      const change = clip(str(args.prompt), 4000);
      if (!change) throw new Error("prompt is required");
      const row = await refineMasterImage(db, task.user_id!, project, str(args.image_id), change.replace(/\.?$/, ".") + KEEP_REFINE, clip(str(args.note), 300) || clip(change, 300), task.id);
      await progress(db, task.id, `Đang sửa master: ${clip(str(args.note) || change, 160)}`);
      return json({ image_id: row.id, next: "char_wait, then view_image." });
    },
  },
  {
    name: "char_run_edits",
    description:
      "Bộ nhân vật (step edits): run in-place edits of the approved master with YOUR prompt per role (roles from get_task \"edits\"). Roles you give a prompt for are (re)made; \"base\" redoes everything made from it; \"work\" is a copy (no prompt). Runs in the background — char_wait with the returned ids.",
    inputSchema: {
      type: "object",
      properties: {
        ...TASK_ARG,
        prompts: { type: "object", description: "{ role: English prompt } — e.g. {\"base\": \"…\", \"mask:<slot id>\": \"…\"}." },
        roles: { type: "array", items: { type: "string" }, description: "Extra roles to (re)make with their last / starting prompt (optional)." },
      },
      required: ["task_id"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id);
      if (task.input.char?.step !== "edits") throw new Error("char_run_edits is for the edits step");
      const plan = planEdits(project.brief);
      const prompts: Record<string, string> = {};
      for (const [role, v] of Object.entries(record(args.prompts))) {
        if (!plan.some((e) => e.role === role)) throw new Error(`Unknown role "${role}" — use the roles of get_task "edits"`);
        if (role !== "work" && str(v).trim()) prompts[role] = withTail(clip(str(v), 7600), tailOf(project.brief, role));
      }
      const extra = (Array.isArray(args.roles) ? args.roles : []).map(str).filter((r) => plan.some((e) => e.role === r));
      const roles = [...new Set([...Object.keys(prompts), ...extra])];
      if (!roles.length) throw new Error("Give prompts {role: prompt} (or roles) to run");
      const rows = await runEditRoles(db, task.user_id!, project, { roles, prompts, taskId: task.id });
      await progress(db, task.id, `Đang chạy ${rows.length} bản sửa: ${rows.map((r) => r.note || r.role).slice(0, 8).join(", ")}${rows.length > 8 ? "…" : ""}`);
      return json({ started: rows.map((r) => ({ image_id: r.id, role: r.role })), next: "char_wait with these ids (base first finishes before the others start), then view_image." });
    },
  },
  {
    name: "char_wait",
    description: "Wait for pictures of a bộ nhân vật to finish (the server waits up to ~3 min per call) → each one's status, url, prompt, registration. \"still running\" → call again.",
    inputSchema: { type: "object", properties: { ...TASK_ARG, image_ids: { type: "array", items: { type: "string" }, description: "Ids from char_draw_masters / char_refine_master / char_run_edits." } }, required: ["task_id", "image_ids"] },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task } = await loadTask(ctx, args.task_id);
      const ids = (Array.isArray(args.image_ids) ? args.image_ids : [args.image_ids]).map(str).filter((x) => UUID.test(x)).slice(0, 40);
      if (!ids.length) throw new Error("image_ids is required");
      const projectId = task.input.char?.projectId ?? "";
      const read = async () => (await db.from(CT_TABLES.charImages).select("*").in("id", ids).eq("project_id", projectId).returns<CtCharImage[]>()).data ?? [];
      const deadline = Date.now() + WAIT_MS;
      let rows = await read();
      const was = new Map(rows.map((r) => [r.id, r.status]));
      while (rows.some((r) => r.status === "running") && Date.now() + POLL_MS < deadline) {
        await sleep(POLL_MS);
        rows = await read();
      }
      const fresh = rows.filter((r) => r.status === "done" && was.get(r.id) === "running");
      if (fresh.length) await progress(db, task.id, `Xong ${fresh.length} ảnh`, fresh.map((r) => r.thumb_url || r.url));
      const failed = rows.filter((r) => r.status === "failed" && was.get(r.id) === "running");
      if (failed.length) await progress(db, task.id, `Lỗi ${failed.length} ảnh: ${clip(failed[0].error, 200)}`);
      const still = rows.filter((r) => r.status === "running").length;
      return json({
        pictures: rows.map((r) => ({ ...picture(r), role: r.role })),
        ...(still ? { message: `${still} still running — call char_wait again.` } : { next: "Look at them with view_image (url) before you judge." }),
      });
    },
  },
];
