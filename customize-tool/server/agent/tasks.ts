/**
 * The editor's own agent: the category dialog's AI work handed to the @flexiprint agent on agent_ide
 * (migration 011) instead of the built-in LLM.
 *
 *   GET  ai/agent-tasks?kind=        → { tasks } the editor's latest tasks of that kind (the photo library's history)
 *   POST ai/agent-tasks             {kind, input} → CtAgentTask: saved, then sent to agent_ide as a turn
 *                                   (POST /kernel/v1/turns). The agent reads it over flexiprint-mcp (get_task) and
 *                                   answers with submit_result / fail_task (server/mcp/tools.ts).
 *   GET  ai/agent-tasks/:id         → CtAgentTask (the dialog polls it). While it runs, the agent_ide job is checked
 *                                   too: a turn that ended without submitting fails the task with its last words.
 *   POST ai/agent-tasks/:id/answer  {question_id, choices, text} — the editor answers the agent's ask_user question;
 *                                   sent to the agent as a new turn in the task's agent_ide session.
 *   POST ai/agent-tasks/:id/cancel  stops the agent's turn.
 *   GET  ai/agent-status            → CtAgentStatus (is the dialog's "Agent @flexiprint" choice usable).
 *
 * One agent_ide session per category: the next task of the same category continues it, so the agent remembers
 * what it already tried there. kind pack_image ("Tạo ảnh với AI" of the thư viện ảnh tổ hợp, input.pack): a new
 * session per request; "Chỉnh tiếp" on a photo continues the session of the task that made it.
 *
 * Env: AGENT_IDE_URL (https://… of agent_ide), AGENT_IDE_TOKEN (its svc_… service token for the @flexiprint
 * project). The agent reaches back with CT_AGENT_TOKEN (server/mcp/server.ts).
 */

import { NextResponse } from "next/server";
import { CT_TABLES } from "../../config";
import { defaultCategoryRules, normalizeCategoryRules } from "../../lib/library";
import type { CtAgentQuestion, CtAgentStatus, CtAgentTask, CtAgentTaskInput, CtAgentTaskKind, CtAgentTaskProgress, CtPackImage, CtPackImageAspect } from "../../types";
import { isOwnUploadUrl } from "../library";
import type { CtSession } from "../supabase";
import { clip, jsonError, record, str } from "../ai/llm";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Only a hung task is given up: agent_ide itself stops a turn after 2 h. */
const TASK_TIMEOUT_MS = 3 * 60 * 60 * 1000;
/** A question left unanswered this long ends the task. */
const ANSWER_TIMEOUT_MS = 24 * 60 * 60 * 1000;

const isOpen = (t: CtAgentTask) => t.status === "pending" || t.status === "running" || t.status === "waiting";

interface KernelConfig {
  url: string;
  token: string;
}

function kernelConfig(): KernelConfig | null {
  const url = (process.env.AGENT_IDE_URL ?? "").trim().replace(/\/$/, "");
  const token = (process.env.AGENT_IDE_TOKEN ?? "").trim();
  return url && token ? { url, token } : null;
}

class KernelError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function kernel<T>(cfg: KernelConfig, path: string, init?: { method?: string; body?: unknown; timeoutMs?: number }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${cfg.url}/kernel/v1${path}`, {
      method: init?.method ?? "GET",
      headers: { Authorization: `Bearer ${cfg.token}`, ...(init?.body ? { "Content-Type": "application/json" } : {}) },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(init?.timeoutMs ?? 15_000),
    });
  } catch (e) {
    throw new KernelError(`Không kết nối được agent_ide: ${e instanceof Error ? e.message : String(e)}`, 502);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new KernelError(str(body.error) || str(body.message) || `agent_ide HTTP ${res.status}`, res.status);
  return body as T;
}

/** GET ai/agent-status */
export async function agentStatus(): Promise<NextResponse> {
  const cfg = kernelConfig();
  const out: CtAgentStatus = { configured: cfg !== null, online: false, name: "", error: "" };
  if (!cfg) return NextResponse.json(out);
  try {
    const ping = await kernel<Record<string, unknown>>(cfg, "/ping", { timeoutMs: 5_000 });
    const card = record(ping.card);
    out.online = true;
    out.name = str(card.name) || str(card.title) || "flexiprint";
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }
  return NextResponse.json(out);
}

const PACK_ASPECTS: CtPackImageAspect[] = ["1:1", "4:5", "3:4", "2:3", "4:3", "3:2", "16:9", "9:16"];

/** A pack_image request: what to make, its references, and the photo it continues (if any). */
function parsePackInput(raw: unknown): CtAgentTaskInput {
  const o = record(raw);
  const p = record(o.pack);
  const aspect = PACK_ASPECTS.includes(str(p.aspect) as CtPackImageAspect) ? (str(p.aspect) as CtPackImageAspect) : "1:1";
  const baseUrl = isOwnUploadUrl(str(p.baseUrl)) ? str(p.baseUrl) : "";
  return {
    category: { id: null, name: "", spec: "", rules: defaultCategoryRules() },
    note: "",
    images: [],
    refUrls: (Array.isArray(o.refUrls) ? o.refUrls : []).map(str).filter(isOwnUploadUrl).slice(0, 6),
    pack: { description: clip(str(p.description), 4000), aspect, baseId: baseUrl && UUID.test(str(p.baseId)) ? str(p.baseId) : null, baseUrl },
  };
}

function parseInput(raw: unknown): CtAgentTaskInput | null {
  const o = record(raw);
  const c = record(o.category);
  const name = str(c.name);
  const id = UUID.test(str(c.id)) ? str(c.id) : null;
  return {
    category: { id, name, spec: str(c.spec), rules: normalizeCategoryRules(record(c.rules)) },
    note: clip(str(o.note), 4000),
    images: (Array.isArray(o.images) ? o.images : [])
      .map(record)
      .filter((im) => isOwnUploadUrl(str(im.url)))
      .slice(0, 12)
      .map((im) => ({ url: str(im.url), label: clip(str(im.label), 200) })),
    refUrls: (Array.isArray(o.refUrls) ? o.refUrls : []).map(str).filter(isOwnUploadUrl).slice(0, 6),
  };
}

/** The turn's message: short — the agent reads the task itself over the MCP. */
function turnPrompt(task: CtAgentTask): string {
  if (task.kind === "pack_image") {
    const p = task.input.pack;
    return [
      `[FlexiPrint task ${task.id}] Tạo ảnh cho thư viện ảnh tổ hợp${p?.baseId ? " (chỉnh tiếp từ một ảnh đã tạo)" : ""}.`,
      p?.description ? `Người dùng viết: ${clip(p.description, 800)}` : "",
      `Làm theo skill flexiprint-pack-image (nếu chưa có thì theo "instructions" trong get_task): gọi mcp__flexiprint__get_task với task_id "${task.id}", tạo ảnh bằng mcp__flexiprint__generate_pack_image, xem lại từng ảnh, rồi kết thúc bằng mcp__flexiprint__submit_result hoặc fail_task.`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  const what =
    task.kind === "create" ? "Tạo danh mục mới" : task.input.note || task.input.images.length || task.input.refUrls.length ? "Cập nhật danh mục theo phản hồi" : "Kiểm tra prompt của danh mục";
  return [
    `[FlexiPrint task ${task.id}] ${what}: "${task.input.category.name || "(chưa đặt tên)"}".`,
    task.input.note ? `Người dùng viết: ${clip(task.input.note, 600)}` : "",
    `Làm theo skill flexiprint-task: gọi mcp__flexiprint__get_task với task_id "${task.id}", làm việc (report_progress từng bước), rồi kết thúc bằng mcp__flexiprint__submit_result hoặc fail_task.`,
  ]
    .filter(Boolean)
    .join("\n");
}

interface KernelTurn {
  jobId: string;
  sessionId: string;
}

/** POST ai/agent-tasks */
export async function createAgentTask(s: CtSession, body: unknown): Promise<NextResponse> {
  const cfg = kernelConfig();
  if (!cfg) return jsonError("Chưa cấu hình agent (AGENT_IDE_URL, AGENT_IDE_TOKEN)", 501);
  const b = record(body);
  const kind: CtAgentTaskKind | null = b.kind === "create" || b.kind === "revise" || b.kind === "pack_image" ? b.kind : null;
  const input = kind === "pack_image" ? parsePackInput(b.input) : parseInput(b.input);
  if (!kind || !input) return jsonError("Task không hợp lệ", 400);
  if (kind === "create" && !input.note && !input.refUrls.length && !input.category.name) return jsonError("Nhập tên, ghi chú hoặc thả ảnh tham khảo", 400);
  if (kind === "pack_image" && !input.pack?.description) return jsonError("Mô tả ảnh cần tạo", 400);

  const { data: task, error } = await s.supabase
    .from(CT_TABLES.agentTasks)
    .insert({ user_id: s.user.id, category_id: input.category.id, kind, input, status: "pending" })
    .select("*")
    .single<CtAgentTask>();
  if (error || !task) return jsonError(error?.message ?? "Không tạo được task", 500);

  // The category's agent session, when it has one — for a photo being edited further, the session that made it.
  let sessionId = "";
  if (kind === "pack_image" && input.pack?.baseId) {
    const { data: base } = await s.supabase.from(CT_TABLES.packImages).select("task_id").eq("id", input.pack.baseId).maybeSingle<Pick<CtPackImage, "task_id">>();
    if (base?.task_id) {
      const { data: made } = await s.supabase.from(CT_TABLES.agentTasks).select("agent_session_id").eq("id", base.task_id).maybeSingle<Pick<CtAgentTask, "agent_session_id">>();
      sessionId = made?.agent_session_id ?? "";
    }
  } else if (input.category.id) {
    const { data: last } = await s.supabase
      .from(CT_TABLES.agentTasks)
      .select("agent_session_id")
      .eq("category_id", input.category.id)
      .neq("agent_session_id", "")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<Pick<CtAgentTask, "agent_session_id">>();
    sessionId = last?.agent_session_id ?? "";
  }
  const send = (sid: string) => kernel<KernelTurn>(cfg, "/turns", { method: "POST", body: { prompt: turnPrompt(task), ...(sid ? { sessionId: sid } : {}) } });
  let turn: KernelTurn;
  try {
    try {
      turn = await send(sessionId);
    } catch (e) {
      // That session is busy (409) or gone (404): a fresh one.
      if (sessionId && e instanceof KernelError && (e.status === 409 || e.status === 404)) turn = await send("");
      else throw e;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await s.supabase.from(CT_TABLES.agentTasks).update({ status: "failed", error: msg, finished_at: new Date().toISOString() }).eq("id", task.id);
    return jsonError(e instanceof KernelError && e.status === 429 ? "Agent đã hết lượt trong ngày" : msg, e instanceof KernelError ? e.status : 502);
  }
  const patch = { status: "running" as const, agent_job_id: str(turn.jobId), agent_session_id: str(turn.sessionId) };
  await s.supabase.from(CT_TABLES.agentTasks).update(patch).eq("id", task.id);
  return NextResponse.json({ ...task, ...patch }, { status: 201 });
}

interface KernelJob {
  sessionId?: string;
  status: "running" | "done" | "error" | "needs_input";
  text?: string;
  error?: string;
}

/** GET ai/agent-tasks?kind= — the editor's own latest tasks of a kind. */
export async function listAgentTasks(s: CtSession, kind: string | null): Promise<NextResponse> {
  let q = s.supabase.from(CT_TABLES.agentTasks).select("*").eq("user_id", s.user.id).order("created_at", { ascending: false }).limit(30);
  if (kind === "create" || kind === "revise" || kind === "pack_image") q = q.eq("kind", kind);
  const { data, error } = await q.returns<CtAgentTask[]>();
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ tasks: data ?? [] });
}

/** GET ai/agent-tasks/:id */
export async function getAgentTask(s: CtSession, id: string): Promise<NextResponse> {
  if (!UUID.test(id)) return jsonError("id không hợp lệ", 400);
  const { data: task, error } = await s.supabase.from(CT_TABLES.agentTasks).select("*").eq("id", id).maybeSingle<CtAgentTask>();
  if (error) return jsonError(error.message, 500);
  if (!task) return jsonError("Không tìm thấy task", 404);
  if (task.status === "waiting") {
    // The agent asked the editor and ended its turn on purpose: nothing to check until they answer.
    const asked = (task.questions ?? []).find((q) => !q.answer);
    if (!asked || Date.now() - Date.parse(asked.asked_at) <= ANSWER_TIMEOUT_MS) return NextResponse.json(task);
    const patch = { status: "failed" as const, error: "Câu hỏi của agent không được trả lời sau 24 giờ", finished_at: new Date().toISOString() };
    await s.supabase.from(CT_TABLES.agentTasks).update(patch).eq("id", id);
    return NextResponse.json({ ...task, ...patch });
  }
  if (!isOpen(task)) {
    // Finished before the session was known (submit_result came before the first poll): fill it in once.
    const cfg = kernelConfig();
    if (cfg && task.agent_job_id && !task.agent_session_id) {
      const job = await kernel<KernelJob>(cfg, `/jobs/${encodeURIComponent(task.agent_job_id)}`, { timeoutMs: 5_000 }).catch(() => null);
      if (job && str(job.sessionId)) {
        task.agent_session_id = str(job.sessionId);
        await s.supabase.from(CT_TABLES.agentTasks).update({ agent_session_id: task.agent_session_id }).eq("id", id);
      }
    }
    return NextResponse.json(task);
  }

  // Still open: did the agent's turn end without an answer?
  let fail = "";
  const cfg = kernelConfig();
  // Counted from the last answer when the agent asked something (its new turn starts then).
  const lastAnswer = Math.max(0, ...(task.questions ?? []).map((q) => (q.answer ? Date.parse(q.answer.at) : 0)));
  if (Date.now() - Math.max(Date.parse(task.created_at), lastAnswer) > TASK_TIMEOUT_MS) fail = "Agent không trả lời sau 3 giờ";
  else if (cfg && task.agent_job_id) {
    try {
      const job = await kernel<KernelJob>(cfg, `/jobs/${encodeURIComponent(task.agent_job_id)}`, { timeoutMs: 5_000 });
      // The turn's 202 comes before agent_ide knows the session: keep it once known (the category's next task resumes it).
      if (!task.agent_session_id && str(job.sessionId)) {
        task.agent_session_id = str(job.sessionId);
        await s.supabase.from(CT_TABLES.agentTasks).update({ agent_session_id: task.agent_session_id }).eq("id", id);
      }
      if (job.status === "error") fail = `Agent lỗi: ${clip(str(job.error) || str(job.text), 600)}`;
      else if (job.status === "needs_input") fail = `Agent cần thêm thông tin: ${clip(str(job.text), 600)}`;
      else if (job.status === "done") {
        // submit_result may land a moment after the turn ends: read the row once more before failing it.
        const { data: again } = await s.supabase.from(CT_TABLES.agentTasks).select("*").eq("id", id).maybeSingle<CtAgentTask>();
        if (again && (again.status === "waiting" || !isOpen(again))) return NextResponse.json(again);
        if (Date.now() - Date.parse(task.updated_at) > 20_000) fail = `Agent đã xong lượt nhưng không nộp kết quả${str(job.text) ? `: ${clip(str(job.text), 600)}` : ""}`;
      }
    } catch {
      // agent_ide unreachable for a moment: keep waiting (the timeout above still applies).
    }
  }
  if (!fail) return NextResponse.json(task);
  const patch = { status: "failed" as const, error: fail, finished_at: new Date().toISOString() };
  await s.supabase.from(CT_TABLES.agentTasks).update(patch).eq("id", id);
  return NextResponse.json({ ...task, ...patch });
}

/** POST ai/agent-tasks/:id/cancel */
export async function cancelAgentTask(s: CtSession, id: string): Promise<NextResponse> {
  if (!UUID.test(id)) return jsonError("id không hợp lệ", 400);
  const { data: task } = await s.supabase.from(CT_TABLES.agentTasks).select("*").eq("id", id).maybeSingle<CtAgentTask>();
  if (!task) return jsonError("Không tìm thấy task", 404);
  const cfg = kernelConfig();
  if (cfg && task.agent_session_id && (task.status === "pending" || task.status === "running")) {
    // (waiting: the agent's turn is already over.)
    await kernel(cfg, `/sessions/${encodeURIComponent(task.agent_session_id)}/stop`, { method: "POST", body: {} }).catch(() => undefined);
  }
  const patch = { status: "cancelled" as const, finished_at: new Date().toISOString() };
  await s.supabase.from(CT_TABLES.agentTasks).update(patch).eq("id", id);
  return NextResponse.json({ ...task, ...patch });
}

/** The answer, as the agent reads it in its next turn. */
function answerPrompt(task: CtAgentTask, q: CtAgentQuestion): string {
  const a = q.answer;
  const picked = a?.choices.length ? `chọn: ${a.choices.map((c) => `"${c}"`).join(", ")}` : "";
  const typed = a?.text ? `viết: ${clip(a.text, 1500)}` : "";
  return [
    `[FlexiPrint task ${task.id}] Người dùng trả lời câu hỏi "${clip(q.question, 300)}" — ${[picked, typed].filter(Boolean).join("; ")}.`,
    "Làm tiếp task này theo câu trả lời (get_task nếu cần xem lại), rồi kết thúc bằng mcp__flexiprint__submit_result hoặc fail_task — chỉ khi mọi việc đã xong.",
  ].join("\n");
}

/** POST ai/agent-tasks/:id/answer */
export async function answerAgentTask(s: CtSession, id: string, body: unknown): Promise<NextResponse> {
  if (!UUID.test(id)) return jsonError("id không hợp lệ", 400);
  const cfg = kernelConfig();
  if (!cfg) return jsonError("Chưa cấu hình agent (AGENT_IDE_URL, AGENT_IDE_TOKEN)", 501);
  const { data: task } = await s.supabase.from(CT_TABLES.agentTasks).select("*").eq("id", id).maybeSingle<CtAgentTask>();
  if (!task) return jsonError("Không tìm thấy task", 404);
  if (task.status !== "waiting") return jsonError("Agent không chờ câu trả lời nào", 409);
  const b = record(body);
  const q = (task.questions ?? []).find((x) => x.id === str(b.question_id) && !x.answer);
  if (!q) return jsonError("Câu hỏi đã được trả lời hoặc không còn", 409);
  const labels = new Set(q.options.map((o) => o.label));
  const choices = (Array.isArray(b.choices) ? b.choices : []).map(str).filter((c) => labels.has(c)).slice(0, q.multi ? 6 : 1);
  const text = q.allow_text ? clip(str(b.text), 2000) : "";
  if (!choices.length && !text) return jsonError(q.options.length ? "Chọn một phương án hoặc viết câu trả lời" : "Viết câu trả lời", 400);

  const at = new Date().toISOString();
  const answered: CtAgentQuestion = { ...q, answer: { choices, text, at } };
  const questions = task.questions.map((x) => (x.id === q.id ? answered : x));
  const line: CtAgentTaskProgress = { at, text: `Bạn trả lời: ${clip([...choices, text].filter(Boolean).join(" · "), 200)}`, kind: "answer" };

  // The session the agent asked from — learnt from its job when not known yet.
  let sessionId = task.agent_session_id;
  if (!sessionId && task.agent_job_id) {
    const job = await kernel<KernelJob>(cfg, `/jobs/${encodeURIComponent(task.agent_job_id)}`, { timeoutMs: 5_000 }).catch(() => null);
    sessionId = str(job?.sessionId);
  }
  if (!sessionId) return jsonError("Không tìm thấy phiên của agent để gửi câu trả lời", 409);

  // The agent's turn may still be closing after ask_user (409 busy): try for a little while.
  let turn: KernelTurn | null = null;
  let lastError = "";
  for (let i = 0; i < 8 && !turn; i++) {
    try {
      turn = await kernel<KernelTurn>(cfg, "/turns", { method: "POST", body: { prompt: answerPrompt(task, answered), sessionId } });
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (!(e instanceof KernelError && e.status === 409)) break;
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  if (!turn) return jsonError(`Chưa gửi được câu trả lời cho agent: ${lastError}`, 502);

  const patch = {
    status: "running" as const,
    questions,
    progress: [...(task.progress ?? []), line].slice(-50),
    agent_job_id: str(turn.jobId),
    agent_session_id: str(turn.sessionId) || sessionId,
  };
  await s.supabase.from(CT_TABLES.agentTasks).update(patch).eq("id", id);
  return NextResponse.json({ ...task, ...patch });
}
