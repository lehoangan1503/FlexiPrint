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
import type { CtAgentTask, CtAgentTaskProgress, CtCharBrief, CtCharImage, CtCharProject, CtCharTaskResult } from "../../types";
import { REF_USE_INFO, masterPrompt, parseCharBrief } from "../../lib/char-brief";
import { KEEP, KEEP_CLEAR, planEdits, tailOf } from "../../lib/char-plan";
import { latestEditsOf } from "../../lib/char-images";
import { CT_IMAGE_MODEL, imageModelLabel } from "../../lib/image-models";
import type { CtServiceClient } from "../supabase";
import { clip, record, str } from "../ai/llm";
import { CHAR_BRIEF_RULES, ideaRoundFrom } from "../char/brainstorm";
import { KEEP_REFINE, drawIdeaPreviews, drawMasters, loadImages, loadProject, projectRow, refineMasterImage, setApprovedMaster } from "../char/projects";
import { startBackdrops } from "../char/backdrops";
import { withTemplateProduct } from "../char/blank";
import { remakeSetProduct } from "../char/product";
import { runEditRoles, startBuild } from "../char/layers";
import { startMatte, startPlan } from "../char/cut";
import { SAMPLE_ROLE, elementPictures, latestElementImages, startElements } from "../char/elements";
import { TASK_ARG, json, liveStatus, loadTask, openTask, patchTask } from "./task-common";
import type { CtMcpContext, CtMcpTool } from "./tools";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WAIT_MS = 170_000;
const POLL_MS = 4_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const COMMON = [
  "You work on a v2 bộ nhân vật (character set) of FlexiPrint: ONE approved AI master illustration → pixel-registered layers (the customer swaps hair, colours, outfits…) → print products. READ flexiprint://guide/layer-rules first if you have not in this session — every picture after the master is an IN-PLACE edit of it.",
  "The image model is GPT Image 2.5 on the company API — the only one. Masters and the edits layers are cut from come on a transparent background (its own cut-out; no bg-remover). Every picture of a set is 1024×1024 (one canvas, one ratio — a tall or wide group still fits inside the square with a margin). It re-draws a little of what it keeps (≈ 0.2 % scale, < 1 px per character): layer-kit measures and undoes that, so an edit is usable when what must stay looks the same — never ask it to move, zoom or re-frame.",
  "Write prompts in English. Talk to the editor (report_progress, summary, ask_user) in Vietnamese. report_progress before every batch of pictures (~30–60 s each).",
  "Pictures you make appear live in the editor's page. Look at every one with view_image before you judge it.",
  "\"references\" are pictures the editor dropped into the brief, each with a use (sample | style | character | outfit | pose | product | avoid) and the editor's note in Vietnamese — that note is what they want from it. view_image EVERY reference before you write anything. style / character / outfit / pose ones are attached to every master drawing automatically (with a line saying what to take from each) — your prompt must agree with them, never contradict them. product = how it should sit on the product; avoid = what must NOT be made. sample = a FINISHED product the editor wants something like (often the only picture): read everything from it — the product (shape, cut, size), the art style, every character (left → right: look, hair, skin, outfit, pose), the text (what it says, where, which parts are names the customer types), the decor and background — and turn it into the brief: characters → subjects, their hair / colours / outfits → slots (what the customer may change, per the note; ask_user when the note does not say), text → text, background / ornaments → decor (never part of the master). The master is only the characters, cut out on a transparent background; the rest comes back as separate layers.",
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
  "2. Write the master prompt: the style; every subject in order, full body, its fixed clothing + the first option of every slot, PLAIN solid colours with the hex when given (no pattern, logo, text on any part a customer recolours); the pose / arrangement with a small gap between subjects (nobody covers another one's customisable part, no hair over someone else, pets beside the feet); photo zones drawn EMPTY (plain light grey, clean edge); the group centred with a generous empty margin; a fully transparent background (the server draws every master cut out), no floor, no cast shadow, no scenery, no text. For a die-cut product (cut \"alpha\") everything must be one connected silhouette.",
  "3. char_draw_masters(task_id, prompt, count 2) → char_wait → view_image. Check: it follows the references as their notes say (style, faces, outfits) without copying anything else; every subject, in order, nobody cropped; every customisable part clearly visible and plain; hair fully visible (it will be removed and re-added); background transparent and clean (no white or checkerboard drawn in); photo zones empty; the style right.",
  "4. A candidate that is close: char_refine_master(task_id, image_id, prompt) with ONE precise change (\"make the dog 20 % smaller, keep it where it is\") — an in-place edit, the rest stays. A candidate that is wrong overall: fix the prompt and draw again. At most ~3 rounds; then submit what is best and say what is still off.",
  "5. A refinement request (task \"imageId\" set): edit THAT master by the request (char_refine_master), check it, submit it.",
  "6. submit_result(task_id, {summary: Vietnamese — what you drew, what you checked, what is still off; image_ids: the masters you recommend, best first}). The editor approves one — you never approve.",
].join("\n");

const EDITS_INSTRUCTIONS = [
  ...COMMON,
  "STEP edits (UI: 3b \"AI vẽ ảnh để cắt clipart\") — the pictures the clipart files are cut from (\"edits\" lists every one: role, what it is for, the source it is drawn from, a starting prompt, and the current result if any). The server decides WHICH pictures exist; you write HOW each is asked. How the set is cut (rebuilt 2026-10-14, pixel lock): the PAPER DOLL is the body file; every option is drawn ON the doll, in place; a clipart file = the option picture's pixels where it differs from the doll — nothing is segmented or guessed. So the doll + a file IS that picture: what you see in a picture is exactly what the customer gets.",
  "Roles: work = the approved master itself (no prompt) · base = the paper doll: every part the customer changes taken off (bald, a flat magenta tank top and shorts, empty hands) — the body file and the canvas of every option · shape:<slot>:<option> = one option drawn on the doll (every option of a shape / texture part, the first option of a colour part — its other colours are recolours of that picture) · zone:<zone> = a customer-photo zone painted magenta on the doll · thumb:<slot>:<option> = a held item / accessory drawn ALONE and complete from its option picture (the part the hand hides drawn too) — only the option's thumbnail in the shop, never cut (its server ending asks for the object alone, centred, transparent).",
  "1. For each edit write a prompt that changes EXACTLY one thing on the named subject (say which one: \"the second character from the left\") WITHOUT the ending sentence: the server appends keepSentence (zones — drawn on white) or clearSentence (every other picture — drawn on a transparent background). base: a family-friendly paper-doll dress-up base (worded so; plainly \"remove her dress\" is refused), the bodies exactly as they were. An option: the hairstyle / garment / item in the same art style, sitting naturally on the doll — a garment covers the magenta underwear completely where it is worn (an open jacket shows it only in its opening); nothing else of the doll moves.",
  "2. char_run_edits(task_id, prompts: {role: prompt}, roles: [...]) — the doll is made first automatically; \"roles\" runs a role with its starting prompt (get_task \"startingPromptExamples\"); give a prompt only where you want a different one. → char_wait → view_image the results (a few at a time).",
  "3. Check each: transparent background; the doll's body, face, arms and hands did NOT move or change (a layer can only ADD to the doll — an arm drawn in a new place leaves the old arm visible); no magenta shows on a garment (it is a chroma key: never part of a clipart); the part looks right in the art style. Wrong → a better prompt and char_run_edits for that role again (at most ~3 tries per role). After the cut, the plan checks say it too (\"Khớp\" = the picture moved, \"xoá / dời … px của búp bê\" = it changed the doll).",
  "4. submit_result(task_id, {summary: Vietnamese — what you ran, what you redid and why, what is still off; image_ids: the final edits}). The editor then cuts the layers (layer-kit) and sees the checks.",
].join("\n");

const CHAT_INSTRUCTIONS = [
  ...COMMON,
  "STEP chat — the editor typed a request in the sticky chat of the set's page (like talking to you in a terminal). \"tab\" / \"section\" say where they were (1. Brief · 2. Master · 3. Layer → 3a master cỡ in, 3b AI vẽ ảnh để cắt, 3c cắt clipart · 4. Sản phẩm) — the request is about THAT part unless it says otherwise. \"attachments\" are screenshots or pictures of the page they sent: view_image EVERY one first and find what they point at (a clipart file, a layer, a region, a master…). \"set\" is the whole bộ: brief, masters, the 3b pictures (edits, with prompts), the 3c regions (plan.pieces: key, picture, region url), the layer files (layers.slots[].files: option, colour, url, piece), the products, the earlier requests and what you answered.",
  "Do exactly what is asked, nothing else, then check it with view_image. The tools:",
  "- brief: char_update_brief(task_id, brief) — the whole brief back (from \"set.brief\" with your change). Once a master is approved only additions are allowed (a new option / colour / slot / zone; existing ids and every slot's first option stay) — after one, run its 3b picture (char_run_edits) and re-cut (char_cut).",
  "- master: char_draw_masters / char_refine_master → char_wait → view_image. The editor approves a master themself (say which one you recommend).",
  "- 3b pictures: char_run_edits(task_id, prompts {role: prompt}, roles) — a redone picture redoes what is drawn from it; then char_cut so the files follow.",
  "- cut: char_cut(task_id, \"plan\") finds every region again from the 3b pictures and cuts the files; char_cut(task_id, \"build\") cuts the files (and remakes the product) from the current regions. char_status(task_id) waits for it and returns the checks and the new files — view_image the files you changed (and a combination of them) before you say it is fixed.",
  "- approve a master: ONLY when the editor's request hands you the whole set (\"làm hết\", \"tự duyệt\") — char_approve_master(task_id, image_id); it starts 3a. Otherwise recommend one and let them approve.",
  "- step 4 (product): the texts (brief.texts: names typed by the customer, a slogan picked from a list — place top / bottom / left / right) and the backgrounds (brief.backdrops) are changed with char_update_brief (allowed after the master is approved). char_draw_backdrops draws the backgrounds (char_wait, view_image each), char_remake_product builds the set's product again with them. Then list_product_options / render_artwork (mode \"print\", options) to check it, make_product_mockups (one entry per option set + scenes) → wait_product_mockups → view_image.",
  "- a question only the editor can answer → ask_user (Vietnamese, with options).",
  "BỘ ẢNH KHÁCH (set.brief.kind \"photo\" — the customer's own photo is the hero: a pet memorial ornament, a portrait): there are no characters, no 3a/3b/3c and no cut. brief.photoZones[0] = the customer's photo (where = what it shows, e.g. \"the customer's pet, sitting\"; treat \"ai\" + styles = the AI style refs the customer picks from — list_ai_styles; \"face\" = head only; box = shares of the safe area, null = laid out). brief.elements = the decorations, each {name, place: behind (wings) | above (halo) | bottom (a band of clouds over the photo's cut body, the texts lie on it) | free (box), mode shape | color (#hex options, the first drawn, the others recoloured), options, perBackdrop (one picture per background in its colours, follows the background)}. Flow: char_update_brief → char_draw_masters (the whole flat design with a SAMPLE pet) → the editor approves (or char_approve_master when handed the whole set) → char_draw_backdrops → char_draw_elements (every element option + the zone's sample: the master's pet alone) → char_wait, view_image each (whole? transparent? same look as the master?) → char_remake_product (keeps a photo zone the editor reshaped; reset_zones true = the layout again) → list_product_options, render_artwork, make_product_mockups.",
  "A bộ nhân vật with a customer FACE (an elf / Santa body with the customers' faces, a die-cut acrylic): a normal character set with brief.photoZones [{where: \"the left elf's face\", treat: \"face\"}] and product.cut \"alpha\" — the master leaves the face empty, the body file gets a hole there and the face sits under it (hat brim, hair edge and collar over it).",
  "submit_result(task_id, {summary: Vietnamese — what you changed, where to see it on the page, what is still off; image_ids: pictures you made, if any}).",
].join("\n");

const STEP_INSTRUCTIONS = { brainstorm: BRAINSTORM_INSTRUCTIONS, master: MASTER_INSTRUCTIONS, edits: EDITS_INSTRUCTIONS, chat: CHAT_INSTRUCTIONS } as const;

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

/** What a new brief drops of the approved one (the edits, regions and files hang on these ids). */
function briefLosses(old: CtCharBrief, next: CtCharBrief): string[] {
  const out: string[] = [];
  for (const sub of old.subjects) {
    const ns = next.subjects.find((x) => x.id === sub.id);
    if (!ns) {
      out.push(`subject ${sub.id} removed`);
      continue;
    }
    for (const sl of sub.slots) {
      const nl = ns.slots.find((x) => x.id === sl.id);
      if (!nl) {
        out.push(`slot ${sl.part} removed`);
        continue;
      }
      if (nl.mode !== sl.mode || nl.wraps !== sl.wraps) out.push(`slot ${sl.part}: mode / wraps changed`);
      sl.options.forEach((o, i) => {
        const no = nl.options[i];
        if (!no || no.id !== o.id) out.push(`slot ${sl.part}: option ${o.name} moved or removed`);
      });
      sl.colors.forEach((o, i) => {
        const no = nl.colors[i];
        if (!no || no.id !== o.id) out.push(`slot ${sl.part}: colour ${o.name} moved or removed`);
      });
    }
  }
  for (const z of old.photoZones) if (!next.photoZones.some((x) => x.id === z.id)) out.push(`photo zone ${z.label} removed`);
  return out;
}

/** An edit prompt without its ending sentence (the server adds it: withTail). */
const withoutKeep = (prompt: string) => [KEEP, KEEP_CLEAR].reduce((p, t) => p.replace(t, ""), prompt).trim();
const withTail = (prompt: string, tail: string) => (prompt.includes(tail.trim()) ? prompt : withoutKeep(prompt).replace(/\.?\s*$/, ".") + tail);

type EarlierTask = Pick<CtAgentTask, "id" | "created_at" | "status" | "input" | "result" | "error">;

/** get_task of a chat request: the whole set, nothing left out (asked 2026-10-12: the agent must see what the editor
 * sees — brief, masters, 3b pictures with their prompts, 3c regions, every layer file, the products). */
function chatView(task: CtAgentTask, p: CtCharProject, images: CtCharImage[], numbers: Map<string, number>, before: EarlierTask[]): Record<string, unknown> {
  const c = task.input.char!;
  const latest = latestEditsOf(images);
  const plan = p.cut?.plan ?? null;
  return {
    id: task.id,
    kind: task.kind,
    step: c.step,
    request: c.request,
    tab: c.tab ?? "brief",
    section: c.section ?? "",
    attachments: (c.attachments ?? []).map((a) => ({ ...a, picture: a.imageId ? (images.find((im) => im.id === a.imageId) ?? null) : null })),
    imageModel: imageModelLabel(CT_IMAGE_MODEL),
    set: {
      id: p.id,
      name: p.name,
      status: p.status,
      approvedMasterId: p.master_id,
      briefLocked: !!p.master_id,
      brief: p.brief,
      references: p.brief.refs.map((r) => ({ ...r, url: images.find((x) => x.id === r.id)?.url ?? null })),
      blankProduct: images.find((im) => im.id === p.brief.product.blankId && im.status === "done")?.url ?? null,
      masters: images.filter((im) => im.kind === "master").map((m) => ({ ...picture(m, numbers), approved: m.id === p.master_id })),
      assembledMasterPrompt: masterPrompt(p.brief),
      edits: p.master_id && p.brief.kind !== "photo"
        ? planEdits(p.brief).map((e) => {
            const im = latest.get(e.role);
            return { role: e.role, label: e.label, source: e.source, startingPrompt: e.prompt, current: im ? { ...picture(im), role: im.role } : null };
          })
        : [],
      masterAtPrintSize: p.cut?.matte ? { status: p.cut.matte.status, error: p.cut.matte.error, url: p.cut.matte.colourUrl, alphaUrl: p.cut.matte.alpha?.url ?? null, width: p.cut.matte.width, height: p.cut.matte.height } : null,
      plan: plan
        ? {
            status: plan.status,
            error: plan.error,
            width: plan.width,
            height: plan.height,
            approved: plan.approved,
            pictures: plan.pictures.map((x) => ({ id: x.id, label: x.label, url: x.colourUrl, alphaUrl: x.alphaUrl })),
            pieces: plan.pieces.map((x) => ({ key: x.key, label: x.label, kind: x.kind, slot: x.slot, option: x.option, picture: x.picture, region: x.region.url, handFixed: x.region.edited })),
            checks: plan.checks,
          }
        : null,
      layers: p.layers
        ? {
            status: p.layers.status,
            error: p.layers.error,
            width: p.layers.width,
            height: p.layers.height,
            approved: p.layers.approved ?? false,
            checks: p.layers.checks,
            diff: p.layers.diffUrl ?? null,
            slots: p.layers.slots.map((sl) => ({ key: sl.key, label: sl.label, follows: sl.follows, files: sl.files.map((f) => ({ imageId: f.imageId, option: f.option, color: f.color, url: f.url, view: f.viewUrl ?? null, piece: f.piece ?? null })) })),
          }
        : null,
      // A bộ ảnh khách: every element picture the brief needs (+ the zone samples), with its newest picture.
      ...(p.brief.kind === "photo"
        ? {
            elementPictures: [
              ...elementPictures(p).map((x) => ({ role: x.role, element: x.element.name, option: x.name, recolouredFromFirst: !!x.recolor, current: latestElementImages(images).has(x.role) ? picture(latestElementImages(images).get(x.role)!) : null })),
              ...p.brief.photoZones.map((z) => ({ role: `${SAMPLE_ROLE}${z.id}`, element: `sample — ${z.label}`, option: "", recolouredFromFirst: false, current: latestElementImages(images).has(`${SAMPLE_ROLE}${z.id}`) ? picture(latestElementImages(images).get(`${SAMPLE_ROLE}${z.id}`)!) : null })),
            ],
            running: images.filter((im) => im.status === "running").map((im) => ({ id: im.id, role: im.role })),
          }
        : {}),
      productIds: p.product_ids,
      // Step 4: the backgrounds drawn for brief.backdrops (newest per backdrop last) and the phôi.
      backdropPictures: images.filter((im) => im.kind === "blank" && im.role.startsWith("backdrop:")).map((im) => ({ id: im.id, backdrop: im.role.slice(9), status: im.status, url: im.url, prompt: im.prompt, error: im.error || undefined })),
      blanks: images.filter((im) => im.kind === "blank" && !im.role.startsWith("backdrop:") && im.status === "done").map((im) => ({ id: im.id, role: im.role, url: im.url })),
    },
    keepSentence: KEEP.trim(),
    clearSentence: KEEP_CLEAR.trim(),
    earlier: before.map((t) => ({
      at: t.created_at,
      step: t.input.char?.step,
      tab: t.input.char?.tab,
      section: t.input.char?.section,
      request: t.input.char?.request ?? "",
      attachments: t.input.char?.attachments ?? [],
      status: t.status,
      answer: t.result && "summary" in t.result ? str(t.result.summary) : t.error,
    })),
    questions: (task.questions ?? []).map((q) => ({ id: q.id, question: q.question, options: q.options.map((o) => o.label), answer: q.answer })),
    instructions: CHAT_INSTRUCTIONS,
  };
}

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
  if (c.step === "chat") return chatView(task, p, images, numbers, before ?? []);
  const out: Record<string, unknown> = {
    id: task.id,
    kind: task.kind,
    step: c.step,
    request: c.request,
    ...(c.imageId ? { imageId: c.imageId, what: `Refine master #${numbers.get(c.imageId) ?? "?"} by the request.` } : {}),
    imageModel: imageModelLabel(CT_IMAGE_MODEL),
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
    out.clearSentence = KEEP_CLEAR.trim();
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
    // One starting prompt per kind of edit (base, shape, zone): the others follow the same
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
  if (c.step === "chat") {
    const ok = new Set(images.map((im) => im.id));
    return { step: c.step, summary, imageIds: ids.filter((x) => ok.has(x)) };
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
      },
      required: ["task_id", "prompt"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id);
      if (task.input.char?.step !== "master" && task.input.char?.step !== "chat") throw new Error("char_draw_masters is for the master step");
      const prompt = clip(str(args.prompt), 8000);
      if (!prompt) throw new Error("prompt is required");
      const rows = await drawMasters(db, task.user_id!, project, { prompt, count: Number(args.count) || 2, taskId: task.id });
      await progress(db, task.id, `Đang vẽ ${rows.length} master`);
      return json({ image_ids: rows.map((r) => r.id), next: "char_wait with these ids, then view_image." });
    },
  },
  {
    name: "char_refine_master",
    description:
      "Bộ nhân vật (step master): an IN-PLACE edit of one master candidate — your prompt says the one change; a sentence keeping everything else (same characters, pose, framing, transparent background) is appended. Returns the new candidate's id → char_wait.",
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
      if (task.input.char?.step !== "master" && task.input.char?.step !== "chat") throw new Error("char_refine_master is for the master step");
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
      "Bộ nhân vật (step edits): run in-place edits of the approved master with YOUR prompt per role (roles from get_task \"edits\"). Roles you give a prompt for are (re)made; \a redone picture redoes everything made from it; \"work\" is a copy (no prompt). Runs in the background — char_wait with the returned ids.",
    inputSchema: {
      type: "object",
      properties: {
        ...TASK_ARG,
        prompts: { type: "object", description: "{ role: English prompt } — e.g. {\"base\": \"…\", \"shape:<slot>:<option>\": \"…\"}." },
        roles: { type: "array", items: { type: "string" }, description: "Extra roles to (re)make with their last / starting prompt (optional)." },
      },
      required: ["task_id"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id);
      if (task.input.char?.step !== "edits" && task.input.char?.step !== "chat") throw new Error("char_run_edits is for the edits step");
      if (!project.master_id) throw new Error("No approved master yet — the editor approves one first");
      const plan = planEdits(project.brief);
      const prompts: Record<string, string> = {};
      for (const [role, v] of Object.entries(record(args.prompts))) {
        if (!plan.some((e) => e.role === role)) throw new Error(`Unknown role "${role}" — use the roles of get_task "edits"`);
        if (role !== "work" && str(v).trim()) prompts[role] = withTail(clip(str(v), 7600), tailOf(role));
      }
      const extra = (Array.isArray(args.roles) ? args.roles : []).map(str).filter((r) => plan.some((e) => e.role === r));
      const roles = [...new Set([...Object.keys(prompts), ...extra])];
      if (!roles.length) throw new Error("Give prompts {role: prompt} (or roles) to run");
      const rows = await runEditRoles(db, task.user_id!, project, { roles, prompts, taskId: task.id });
      await progress(db, task.id, `Đang chạy ${rows.length} bản sửa: ${rows.map((r) => r.note || r.role).slice(0, 8).join(", ")}${rows.length > 8 ? "…" : ""}`);
      return json({ started: rows.map((r) => ({ image_id: r.id, role: r.role })), next: "char_wait with these ids (the pictures others are drawn from finish first), then view_image." });
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
  {
    name: "char_update_brief",
    description:
      "Bộ nhân vật (chat): save the whole brief (get_task set.brief with your change). After a master is approved only additions are allowed — a new option / colour / slot / photo zone; existing ids and every slot's first option stay.",
    inputSchema: { type: "object", properties: { ...TASK_ARG, brief: { type: "object", description: "The full CtCharBrief." } }, required: ["task_id", "brief"] },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id);
      if (task.input.char?.step !== "chat") throw new Error("char_update_brief is for chat requests");
      // A khuôn in named by templateId fills the cut, size and layout sentence like the page does.
      const brief = await withTemplateProduct(db, parseCharBrief(args.brief));
      if (project.master_id) {
        const lost = briefLosses(project.brief, brief);
        if (lost.length) throw new Error(`Master approved — only additions: ${lost.join("; ")}`);
      }
      const { error } = await db.from(CT_TABLES.charProjects).update({ brief }).eq("id", project.id);
      if (error) throw new Error(error.message);
      await progress(db, task.id, "Đã sửa brief");
      return json({ ok: true, next: project.master_id ? "New option → char_run_edits for its role (get_task again for the role list), then char_cut." : "Done." });
    },
  },
  {
    name: "char_cut",
    description:
      "Bộ nhân vật (chat): \"plan\" = find every 3c region again from the 3b pictures, then cut the files; \"build\" = cut the files from the current regions and remake the product. Runs in the background → char_status.",
    inputSchema: { type: "object", properties: { ...TASK_ARG, what: { type: "string", description: "\"plan\" or \"build\"." } }, required: ["task_id", "what"] },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id);
      if (task.input.char?.step !== "chat") throw new Error("char_cut is for chat requests");
      if (str(args.what) === "plan") await startPlan(db, task.user_id!, project, true);
      else await startBuild(db, task.user_id!, project, project.cut?.plan ? { ...project.cut, plan: { ...project.cut.plan, approved: true } } : undefined, true);
      await progress(db, task.id, str(args.what) === "plan" ? "Đang tìm lại vùng 3c và cắt file" : "Đang cắt lại file layer");
      return json({ next: "char_status (it waits)." });
    },
  },
  {
    name: "char_status",
    description: "Bộ nhân vật (chat): wait (up to ~3 min) for the 3c regions / the layer cut to finish → their status, checks and the layer files.",
    inputSchema: { type: "object", properties: { ...TASK_ARG }, required: ["task_id"] },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task } = await loadTask(ctx, args.task_id);
      const id = task.input.char?.projectId ?? "";
      const busy = (p: CtCharProject) => p.cut?.matte?.status === "running" || p.cut?.plan?.status === "running" || p.layers?.status === "building";
      const deadline = Date.now() + WAIT_MS;
      let p = await loadProject(db, id);
      while (p && busy(p) && Date.now() + POLL_MS < deadline) {
        await sleep(POLL_MS);
        p = await loadProject(db, id);
      }
      if (!p) throw new Error("The bộ nhân vật no longer exists");
      return json({
        running: busy(p),
        plan: p.cut?.plan ? { status: p.cut.plan.status, error: p.cut.plan.error, checks: p.cut.plan.checks } : null,
        layers: p.layers
          ? { status: p.layers.status, error: p.layers.error, checks: p.layers.checks, diff: p.layers.diffUrl ?? null, slots: p.layers.slots.map((sl) => ({ key: sl.key, label: sl.label, files: sl.files.map((f) => ({ option: f.option, color: f.color, url: f.url, piece: f.piece ?? null })) })) }
          : null,
        productIds: p.product_ids,
        ...(busy(p) ? { message: "Still running — call char_status again." } : {}),
      });
    },
  },
  {
    name: "char_approve_master",
    description:
      "Bộ nhân vật (chat): approve a finished master — ONLY when the editor's request hands you the whole set (they said to do everything / approve yourself). Starts the master at print size (3a); then char_run_edits for the 3b pictures, char_cut(\"plan\") and char_cut(\"build\").",
    inputSchema: { type: "object", properties: { ...TASK_ARG, image_id: { type: "string", description: "The master (set.masters / char_wait)." } }, required: ["task_id", "image_id"] },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id);
      if (task.input.char?.step !== "chat") throw new Error("char_approve_master is for chat requests");
      const id = str(args.image_id);
      if (!UUID.test(id)) throw new Error("image_id is not a valid id");
      const p = await setApprovedMaster(db, project, id);
      if (p.brief.kind === "photo") {
        await progress(db, task.id, "Đã duyệt master");
        return json({ ok: true, next: "char_draw_backdrops (if brief.backdrops), then char_draw_elements." });
      }
      await startMatte(db, task.user_id!, p);
      await progress(db, task.id, "Đã duyệt master, đang làm master cỡ in (3a)");
      return json({ ok: true, next: "char_status waits for 3a; then char_run_edits (roles from get_task set.edits — get_task again now that a master is approved)." });
    },
  },
  {
    name: "char_draw_backdrops",
    description:
      "Bộ nhân vật (chat, step 4): draw the backgrounds of brief.backdrops with the team's image model (the whole piece, behind the characters; ~1 min each, in the background). prompts {backdrop id: English prompt} replaces a starting prompt; ids = only these (default: all). → image ids for char_wait; then char_remake_product.",
    inputSchema: {
      type: "object",
      properties: {
        ...TASK_ARG,
        ids: { type: "array", items: { type: "string" }, description: "brief.backdrops ids (empty = all)." },
        prompts: { type: "object", description: "{ backdrop id: full English prompt } (optional)." },
      },
      required: ["task_id"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id);
      if (task.input.char?.step !== "chat") throw new Error("char_draw_backdrops is for chat requests");
      const prompts = Object.fromEntries(Object.entries(record(args.prompts)).map(([k, v]) => [k, clip(str(v), 4000)]).filter(([, v]) => v));
      const ids = (Array.isArray(args.ids) ? args.ids : []).map(str).filter(Boolean);
      const rows = await startBackdrops(db, task.user_id!, project, { ids, prompts, taskId: task.id });
      await progress(db, task.id, `Đang vẽ ${rows.length} nền: ${rows.map((r) => r.note.replace(/^Nền — /, "")).join(", ")}`);
      return json({ image_ids: rows.map((r) => r.id), next: "char_wait, view_image each; then char_remake_product." });
    },
  },
  {
    name: "char_draw_elements",
    description:
      "Bộ ảnh khách (brief.kind \"photo\", after the master is approved): draw the decorations of brief.elements — each option ALONE on transparency in the master's look (perBackdrop ones: one per background, needs the backgrounds drawn first; colour options are recoloured from the first) — and each photo zone's sample (role \"sample:<zone id>\": the master's pet alone). roles / prompts {role: English prompt} = only these (roles in get_task set.elementPictures); none = every missing one. ~1 min each, in the background → image ids for char_wait.",
    inputSchema: {
      type: "object",
      properties: {
        ...TASK_ARG,
        roles: { type: "array", items: { type: "string" }, description: "\"el:<element id>:<option id>\", \"el:<element id>:bd:<backdrop id>\", \"sample:<zone id>\" (empty = every missing one)." },
        prompts: { type: "object", description: "{ role: full English prompt } (optional)." },
      },
      required: ["task_id"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id);
      if (task.input.char?.step !== "chat") throw new Error("char_draw_elements is for chat requests");
      const prompts = Object.fromEntries(Object.entries(record(args.prompts)).map(([k, v]) => [k, clip(str(v), 4000)]).filter(([, v]) => v));
      const roles = (Array.isArray(args.roles) ? args.roles : []).map(str).filter(Boolean);
      const rows = await startElements(db, task.user_id!, project, { roles, prompts, taskId: task.id });
      await progress(db, task.id, `Đang vẽ ${rows.length} phần tử: ${rows.map((r) => r.note).slice(0, 8).join(", ")}`);
      return json({ image_ids: rows.map((r) => r.id), next: "char_wait, view_image each (colour options appear after their first is done); then char_remake_product." });
    },
  },
  {
    name: "char_remake_product",
    description:
      "Bộ nhân vật (chat, step 4): build the set's product again from the current files and brief (backgrounds, texts, material) — it replaces the set's product. → the new product id; check it with list_product_options and render_artwork.",
    inputSchema: {
      type: "object",
      properties: { ...TASK_ARG, reset_zones: { type: "boolean", description: "true = customer photo zones from the set's own layout again (default: a zone the editor reshaped in the product is kept)." } },
      required: ["task_id"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id);
      if (task.input.char?.step !== "chat") throw new Error("char_remake_product is for chat requests");
      if (project.brief.kind !== "photo" && (project.layers?.status !== "done" || !project.layers.approved)) throw new Error('The files are not cut yet — char_cut("build") first (it makes the product too)');
      const productId = await remakeSetProduct(db, project.user_id ?? task.user_id!, project, project.layers, { resetZones: args.reset_zones === true });
      const { error } = await db.from(CT_TABLES.charProjects).update({ product_ids: [productId], status: "product" }).eq("id", project.id);
      if (error) throw new Error(error.message);
      await progress(db, task.id, "Đã dựng lại sản phẩm");
      return json({ product_id: productId, next: "list_product_options, render_artwork (mode print), make_product_mockups." });
    },
  },
];
