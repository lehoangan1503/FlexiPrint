/**
 * Mockup tasks (kind "mockup", asked 2026-11-12): a mockup photo of a product the image model refused ("Your request
 * was rejected by the safety system … safety_violations=[sexual]"). The editor's "Gửi @flexiprint sửa prompt" button
 * (Mockups tab) hands the job to the agent, which reads the prompt and the reference picture, rewrites the prompt and
 * draws the SAME job again — its card in the Mockups tab turns back to running, then to the photo.
 *
 *   get_task          (tools.ts) → mockupTaskView: the job, its refused prompt, the model's answer, the reference
 *   retry_mockup      {task_id, prompt} → the job drawn again with that prompt (background, ~1–3 min)
 *   wait_product_mockups (print-tools.ts) → its status
 *   submit_result     {summary, prompt} → submitMockupResult (draws it again itself when the agent has not)
 *
 * A product's own mockup prompt, without drawing (asked 2026-11-24: every editor feature also over API + MCP):
 *   get_product_mockup_prompt {product_id} → its blocks, the base's wrap, the shared reference pictures (its own or the base's)
 *   set_product_mockup_prompt {product_id, blocks?, shared_refs?} → the editor's Mockups blocks / "Ảnh tham chiếu chung",
 *     through the same handlers as POST products/:id/mockups/blocks and …/mockups/base-refs
 */

import { CT_TABLES } from "../../config";
import type { CtAgentTask, CtAgentTaskProgress, CtMockupFixResult, CtPackImage, CtProduct } from "../../types";
import type { CtServiceClient } from "../supabase";
import { clip, str } from "../ai/llm";
import { serviceSession } from "../char/product";
import { isSafetyRefusal, jobName, KEEP_PRINT, productMockupPrompt, retryMockupJob, setOwnBaseRefs, setOwnMockupBlocks } from "../product-mockups";
import { CT_MOCKUP_BLOCK_REFS_MAX, badBlockRefs } from "../../lib/mockup-prompt";
import { OPT_TASK_ARG, TASK_ARG, actorOf, json, liveStatus, loadTask, openTask, patchTask } from "./task-common";
import type { CtMcpContext, CtMcpTool } from "./tools";

/** Drawings one task may ask for (each is a paid gpt-image call). */
const MAX_RETRIES = 4;

const INSTRUCTIONS = [
  "A mockup photo (an AI lifestyle photo of the finished product, drawn from the reference picture = the print laid on the blank) was REFUSED by the image model's safety system. Make it pass while keeping the photo the same product photo.",
  "1. view_image the reference picture (refUrl): what in it could be read as sensitive — bare skin, a figure in a swimsuit / underwear / bath, a kiss, a bed, children, body words in the text… The model judges the prompt AND the picture together.",
  "2. Rewrite the prompt: drop or replace every word that can read as sensitive in that context (body, skin, bare, naked, intimate, sensual, bed, bath, lingerie, \"hot\", \"sexy\", touching, embrace…), describe the scene as a plain product photo of a gift / home decor item, and say it is family-friendly and fully clothed when the print has people. Keep: the product named the same way, the scene's place and light (change it only when the scene itself is the trigger — e.g. \"on a bed\" → \"on a wooden side table\"), the sentences that keep the product's material, size in frame and the printed artwork EXACTLY as in the reference (the print must never be redrawn). English only.",
  "3. retry_mockup {task_id, prompt} → then wait_product_mockups {product_id, job_ids: [job id]} until it is done or failed (calls of ~1 min; a drawing takes 1–3 min). Done → view_image the photo: the print must be unchanged on it. Refused again → change more (the scene, then softer words for what the print shows) and retry (at most " +
    MAX_RETRIES +
    " drawings per task). A failure that is not a safety refusal (timeout, network) → retry the same prompt once.",
  "4. report_progress (Vietnamese, short) while you work. End with submit_result {summary (Vietnamese: which words you changed and why, whether the photo passed), prompt (the final prompt)}; or fail_task with the reason when nothing passes.",
];

async function jobOf(db: CtServiceClient, task: CtAgentTask): Promise<CtPackImage> {
  const m = task.input.mockup;
  if (!m) throw new Error("Not a mockup task");
  const { data } = await db.from(CT_TABLES.packImages).select("*").eq("id", m.jobId).eq("name", jobName(m.productId)).maybeSingle<CtPackImage>();
  if (!data) throw new Error("The mockup job is gone (deleted)");
  return data;
}

/** get_task of a mockup task. */
export async function mockupTaskView(db: CtServiceClient, task: CtAgentTask): Promise<unknown> {
  const m = task.input.mockup!;
  const job = await jobOf(db, task);
  const tries = (task.progress ?? []).filter((p) => p.kind === "run").length;
  return {
    id: task.id,
    kind: task.kind,
    what: "A mockup photo the image model refused (safety). Rewrite its prompt and draw it again.",
    request: m.request,
    product: { id: m.productId, name: m.productName },
    job: {
      id: m.jobId,
      scene: m.scene,
      refused_prompt: m.prompt,
      model_answer: m.error,
      reference_picture: m.refUrl,
      now: { status: job.status, prompt: job.prompt === m.prompt ? "(unchanged)" : job.prompt, error: job.error || undefined, url: job.url || undefined },
    },
    keep_sentence: KEEP_PRINT.trim(),
    drawings_used: `${tries} / ${MAX_RETRIES}`,
    questions: (task.questions ?? []).map((q) => ({ id: q.id, question: q.question, options: q.options.map((o) => o.label), answer: q.answer })),
    instructions: INSTRUCTIONS,
  };
}

/** The job drawn again with `prompt` as the product's owner; the drawing is noted on the task. */
async function retry(db: CtServiceClient, task: CtAgentTask, prompt: string): Promise<CtPackImage> {
  const m = task.input.mockup!;
  const tries = (task.progress ?? []).filter((p) => p.kind === "run").length;
  if (tries >= MAX_RETRIES) throw new Error(`Already ${tries} drawings for this task — submit_result with what you found, or fail_task.`);
  const { data: product } = await db.from(CT_TABLES.products).select("id, user_id").eq("id", m.productId).maybeSingle<Pick<CtProduct, "id" | "user_id">>();
  if (!product?.user_id) throw new Error("The product is gone or has no owner");
  const s = await serviceSession(db, product.user_id);
  const job = await retryMockupJob(s, m.productId, m.jobId, prompt);
  const line: CtAgentTaskProgress = { at: new Date().toISOString(), text: `Tạo lại mockup “${clip(m.scene, 80)}” với prompt mới (lần ${tries + 1})`, kind: "run" };
  await patchTask(db, task.id, { status: liveStatus(task), progress: [...(task.progress ?? []), line].slice(-50) });
  return job;
}

function promptArg(v: unknown): string {
  const p = str(v).trim();
  if (!p) throw new Error("prompt is required (English, the whole prompt)");
  return p;
}

/** submit_result of a mockup task: the final prompt — drawn now when the job is not already drawn / drawing with it. */
export async function submitMockupResult(db: CtServiceClient, task: CtAgentTask, raw: Record<string, unknown>, summary: string): Promise<{ result: CtMockupFixResult; message: string }> {
  const m = task.input.mockup!;
  const prompt = promptArg(raw.prompt);
  let job = await jobOf(db, task);
  let message = "Đã gửi — người dùng thấy kết quả ở tab Mockups.";
  if (job.status === "failed" && (job.prompt !== prompt || !isSafetyRefusal(job.error))) {
    try {
      job = await retry(db, task, prompt);
      message = "Đã gửi và đã tạo lại mockup với prompt này — ảnh hiện ở tab Mockups khi xong.";
    } catch (e) {
      message = `Đã gửi — chưa tạo lại được: ${e instanceof Error ? e.message : String(e)}`;
    }
  } else if (job.status === "failed") {
    message = "Đã gửi — lưu ý: lần vẽ cuối với prompt này vẫn bị từ chối.";
  }
  return { result: { summary, prompt, jobId: m.jobId }, message };
}

/** A web handler's answer: its error text thrown, else its JSON. */
async function answer(res: Response): Promise<Record<string, unknown>> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status >= 400) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${res.status}`);
  return body;
}

const PRODUCT_ARG = { product_id: { type: "string", description: "The product (kind product)." } };

/** What get_product_mockup_prompt shows, also the answer of set_product_mockup_prompt. */
async function promptView(db: CtServiceClient, product: CtProduct): Promise<Record<string, unknown>> {
  const p = await productMockupPrompt(db, product);
  return {
    product: { id: product.id, name: product.name, base_product_id: product.base_product_id },
    blocks: p.blocks,
    blocks_from: p.blocksFrom,
    wrap: p.wrap,
    shared_refs: p.sharedRefs,
    shared_refs_from: p.sharedRefsFrom,
    base_refs: p.baseRefs,
    how_sent: "Each block = one photo. Picture 1 = the product's front picture; then the block's own refs, or — when it has none — shared_refs (picture 2, 3…). The prompt = wrap with {scene} = the block's prompt ({product} filled); an empty wrap sends the block's prompt alone.",
  };
}

async function productFor(ctx: CtMcpContext, args: Record<string, unknown>): Promise<{ db: CtServiceClient; userId: string; product: CtProduct }> {
  const { db, userId } = await actorOf(ctx, args.task_id);
  // Read as the caller (a signed-in user sees what the web page lets them see).
  const { data: product } = await ctx.db.from(CT_TABLES.products).select("*").eq("id", str(args.product_id)).maybeSingle<CtProduct>();
  if (!product) throw new Error("No such product");
  if (product.kind !== "product") throw new Error("That is an ARTWORK: mockup prompts are on a product (artwork + base)");
  return { db, userId, product };
}

export const CT_MCP_MOCKUP_TOOLS: CtMcpTool[] = [
  {
    name: "get_product_mockup_prompt",
    description:
      "What a PRODUCT's next mockups are drawn with (the editor's Mockups tab): blocks (one photo each, {prompt, refs}) — blocks_from product = its own, base = its product base's scenes, none = nothing (making mockups is refused); wrap = the base's sentence around each prompt; shared_refs = the reference pictures sent with every block that has no refs of its own — shared_refs_from product = this product's own set (set_product_mockup_prompt shared_refs), base = its base's refs (base_refs). Reads only, draws nothing.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, ...PRODUCT_ARG }, required: ["product_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const { db, product } = await productFor(ctx, args);
      return json(await promptView(db, product));
    },
  },
  {
    name: "set_product_mockup_prompt",
    description: `Change ONE product's own mockup prompt, nothing drawn, its product base untouched (other products on the base keep theirs) — the editor's Mockups tab: blocks = its prompt blocks [{"prompt": "<English scene>", "refs": ["https://…"]}] (one photo each; a block's refs, max ${CT_MOCKUP_BLOCK_REFS_MAX}, go with that prompt only; [] = drop its own, back to the base's scenes); shared_refs = its "Ảnh tham chiếu chung" (the editor's box under "Ảnh 1 · sản phẩm"): the whole new list of https urls (max ${CT_MOCKUP_BLOCK_REFS_MAX}, no repeats) sent with every block that has no refs of its own, in place of the base's refs — drop one = the list without it, add one = the list with its url (a local picture → flexiprint_upload_image first); [] = none at all. shared_refs_from_base: true = back to the base's refs (giving exactly the base's list also counts as back). Give only what changes. → the same view as get_product_mockup_prompt. Then make_product_mockups (no scenes) draws with it.`,
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        ...PRODUCT_ARG,
        blocks: { type: "array", items: { type: "object" }, description: "The product's prompt blocks, the whole new list; [] = back to the base's scenes." },
        shared_refs: { type: "array", items: { type: "string" }, description: "The shared reference pictures, the whole new list ([] = none)." },
        shared_refs_from_base: { type: "boolean", description: "true = drop the product's own shared pictures, back to its base's refs." },
      },
      required: ["product_id"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const hasBlocks = Array.isArray(args.blocks);
      const fromBase = args.shared_refs_from_base === true || args.shared_refs === null;
      const hasRefs = fromBase || Array.isArray(args.shared_refs);
      if (fromBase && Array.isArray(args.shared_refs)) throw new Error("Give shared_refs OR shared_refs_from_base, not both");
      if (!hasBlocks && !hasRefs) throw new Error("Nothing to change — give blocks and/or shared_refs (or shared_refs_from_base: true)");
      if (hasBlocks) {
        const bad = badBlockRefs(args.blocks);
        if (bad) throw new Error(`blocks: ${bad}`);
      }
      const { db, userId, product } = await productFor(ctx, args);
      // The web page's own handlers: ownership (own products; admins all) and the rules are checked the same way.
      const s = await serviceSession(db, userId);
      let row = product;
      if (hasBlocks) row = (await answer(await setOwnMockupBlocks(s, product.id, { blocks: args.blocks }))).product as CtProduct;
      if (hasRefs) row = (await answer(await setOwnBaseRefs(s, product.id, { refs: fromBase ? null : args.shared_refs }))).product as CtProduct;
      return json({ ...(await promptView(db, row)), changed: [hasBlocks && "blocks", hasRefs && "shared_refs"].filter(Boolean) });
    },
  },
  {
    name: "retry_mockup",
    description:
      "Mockup task (kind mockup): draw the refused mockup job again with your rewritten prompt (English, the whole prompt — not a diff). Runs in the background (~1–3 min) on the same job: its card in the editor's Mockups tab shows it. Then wait_product_mockups {product_id, job_ids: [job id]} and view_image the photo.",
    inputSchema: { type: "object", properties: { ...TASK_ARG, prompt: { type: "string", description: "The new prompt, whole, English." } }, required: ["task_id", "prompt"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const { db, task } = await loadTask(ctx, args.task_id);
      openTask(task);
      if (task.kind !== "mockup") throw new Error("Only for mockup tasks");
      const job = await retry(db, task, promptArg(args.prompt));
      return json({ job_id: job.id, product_id: task.input.mockup!.productId, status: job.status, next: "wait_product_mockups {product_id, job_ids: [job_id]} — then view_image the photo, or rewrite more if it is refused again." });
    },
  },
];
