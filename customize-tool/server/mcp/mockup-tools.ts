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
 */

import { CT_TABLES } from "../../config";
import type { CtAgentTask, CtAgentTaskProgress, CtMockupFixResult, CtPackImage, CtProduct } from "../../types";
import type { CtServiceClient } from "../supabase";
import { clip, str } from "../ai/llm";
import { serviceSession } from "../char/product";
import { isSafetyRefusal, jobName, KEEP_PRINT, retryMockupJob } from "../product-mockups";
import { TASK_ARG, json, liveStatus, loadTask, openTask, patchTask } from "./task-common";
import type { CtMcpTool } from "./tools";

/** Drawings one task may ask for (each is a paid gpt-image call). */
const MAX_RETRIES = 4;
const PROMPT_MAX = 4000;

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
  const p = clip(str(v).trim(), PROMPT_MAX);
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

export const CT_MCP_MOCKUP_TOOLS: CtMcpTool[] = [
  {
    name: "retry_mockup",
    description:
      "Mockup task (kind mockup): draw the refused mockup job again with your rewritten prompt (English, the whole prompt — not a diff). Runs in the background (~1–3 min) on the same job: its card in the editor's Mockups tab shows it. Then wait_product_mockups {product_id, job_ids: [job id]} and view_image the photo.",
    inputSchema: { type: "object", properties: { ...TASK_ARG, prompt: { type: "string", description: "The new prompt, whole, English." } }, required: ["task_id", "prompt"] },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task } = await loadTask(ctx, args.task_id);
      openTask(task);
      if (task.kind !== "mockup") throw new Error("Only for mockup tasks");
      const job = await retry(db, task, promptArg(args.prompt));
      return json({ job_id: job.id, product_id: task.input.mockup!.productId, status: job.status, next: "wait_product_mockups {product_id, job_ids: [job_id]} — then view_image the photo, or rewrite more if it is refused again." });
    },
  },
];
