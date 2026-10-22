/**
 * The editor's own agent: work handed to the @flexiprint agent on agent_ide (migration 011) — kind "content"
 * (Shopify title + description, deploy page) and kind "char" (a v2 bộ nhân vật step).
 *
 *   GET  ai/agent-tasks?kind=&collection= → { tasks } latest tasks of that kind (a product's / a bộ nhân vật's)
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
 * One agent_ide session per product (content) / per bộ nhân vật (char): the next task continues it, so the agent
 * remembers what it already did there.
 *
 * Env: AGENT_IDE_URL (https://… of agent_ide), AGENT_IDE_TOKEN (its svc_… service token for the @flexiprint
 * project). The agent reaches back with CT_AGENT_TOKEN (server/mcp/server.ts).
 */

import { NextResponse } from "next/server";
import { CT_TABLES } from "../../config";
import { defaultCategoryRules } from "../../lib/library";
import type { CtAgentQuestion, CtAgentStatus, CtAgentTask, CtAgentTaskInput, CtAgentTaskKind, CtAgentTaskProgress, CtCharChatAttachment, CtCharChatTab, CtCharTaskStep } from "../../types";
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

/** A content request: the product, what the editor wants, the title / description to start from. */
function parseContentInput(raw: unknown): CtAgentTaskInput | null {
  const o = record(raw);
  const c = record(o.content);
  if (!UUID.test(str(c.productId))) return null;
  return {
    category: { id: null, name: "", spec: "", rules: defaultCategoryRules() },
    note: "",
    images: [],
    refUrls: [],
    content: {
      productId: str(c.productId),
      productName: clip(str(c.productName), 200),
      request: clip(str(c.request), 4000),
      title: clip(str(c.title), 255),
      descriptionHtml: clip(str(c.descriptionHtml), 20000),
      facts: (Array.isArray(c.facts) ? c.facts : []).map((f) => clip(str(f), 400)).filter(Boolean).slice(0, 40),
      imageUrls: (Array.isArray(c.imageUrls) ? c.imageUrls : []).map(str).filter(isOwnUploadUrl).slice(0, 6),
    },
  };
}

const CHAR_STEPS: CtCharTaskStep[] = ["brainstorm", "master", "edits", "chat", "auto"];
const CHAT_TABS: CtCharChatTab[] = ["brief", "master", "layers", "product"];

/** The pictures of a chat request: our own uploads only (screenshots / page pictures on R2). */
export function chatAttachments(raw: unknown): CtCharChatAttachment[] {
  return (Array.isArray(raw) ? raw : [])
    .map((v) => {
      const a = record(v);
      const source = a.source === "page" || a.source === "file" ? a.source : "screenshot";
      return { url: str(a.url), imageId: UUID.test(str(a.imageId)) ? str(a.imageId) : null, label: clip(str(a.label), 200), source } as CtCharChatAttachment;
    })
    .filter((a) => isOwnUploadUrl(a.url))
    .slice(0, 12);
}

/** A step of a bộ nhân vật (v2): the project, the step, what the editor wants. */
function parseCharInput(raw: unknown): CtAgentTaskInput | null {
  const o = record(raw);
  const c = record(o.char);
  if (!UUID.test(str(c.projectId)) || !CHAR_STEPS.includes(str(c.step) as CtCharTaskStep)) return null;
  const step = str(c.step) as CtCharTaskStep;
  return {
    category: { id: null, name: "", spec: "", rules: defaultCategoryRules() },
    note: "",
    images: [],
    refUrls: [],
    char: {
      projectId: str(c.projectId),
      step,
      // A chat request is kept whole (asked 2026-10-12: nothing of what the editor wrote is cut).
      request: clip(str(c.request), step === "chat" ? 20000 : 4000),
      imageId: UUID.test(str(c.imageId)) ? str(c.imageId) : null,
      roles: (Array.isArray(c.roles) ? c.roles : []).map(str).filter(Boolean).slice(0, 60),
      ...(step === "chat"
        ? { tab: CHAT_TABS.includes(str(c.tab) as CtCharChatTab) ? (str(c.tab) as CtCharChatTab) : "brief", section: clip(str(c.section), 10), attachments: chatAttachments(c.attachments) }
        : {}),
    },
  };
}

const CHAR_STEP_TEXT: Record<CtCharTaskStep, string> = {
  brainstorm: "Brainstorm 3 hướng brief",
  master: "Viết prompt master, tạo và tự duyệt master",
  edits: "Viết prompt các ảnh AI để cắt clipart (3b), chạy và kiểm tra",
  chat: "Yêu cầu từ ô chat",
  auto: "Master đã duyệt — tự làm hết bước 3 (ảnh để cắt, cắt clipart) và bước 4 (nền, phần tử, sản phẩm, mockup), tự kiểm tra từng bước, đến khi xong sản phẩm",
};

export const CHAT_TAB_TEXT: Record<CtCharChatTab, string> = { brief: "1. Mô tả bộ clipart (brief)", master: "2. Ảnh master", layers: "3. Cắt clipart", product: "4. Sản phẩm" };

/**
 * This instance's MCP server in the agent's capability (CT_AGENT_MCP): "flexi2" (an-vm) — the only one since
 * 2026-10-19 (the VPS server "flexiprint" was dropped); every turn still names it.
 */
function agentMcp(): string {
  return (process.env.CT_AGENT_MCP || "flexi2").replace(/[^a-z0-9_-]/gi, "");
}

const mcpLine = () => `Task này nằm trên MCP server "${agentMcp()}": chỉ dùng các tool mcp__${agentMcp()}__* (không dùng server FlexiPrint khác).`;

/** "Gửi chen" (server/agent/inbox.ts): how the agent hears the editor while it works. */
const injectLine = () =>
  `Trong lúc bạn làm, người dùng có thể "gửi chen" tin nhắn hoặc sửa tay trên editor: nó tới ở cuối kết quả của tool ${agentMcp()} kế tiếp, mục "📩 GỬI CHEN". Gặp mục đó thì làm theo ngay (nó đổi / bổ sung yêu cầu), sửa tay của người dùng thì đọc lại dữ liệu và không ghi đè.`;

/** The turn's message: short — the agent reads the task itself over the MCP. */
function turnPrompt(task: CtAgentTask): string {
  const m = `mcp__${agentMcp()}__`;
  if (task.kind === "content") {
    const c = task.input.content;
    return [
      `[FlexiPrint task ${task.id}] Viết content Shopify (title + description) cho sản phẩm "${clip(c?.productName ?? "", 120)}".`,
      c?.request ? `Người dùng muốn: ${clip(c.request, 800)}` : "",
      mcpLine(),
      `Gọi ${m}get_task với task_id "${task.id}" (có sản phẩm, option khách, ảnh, các lần viết trước và "instructions"), viết, rồi kết thúc bằng ${m}submit_result {summary, title, description_html} hoặc fail_task.`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (task.kind === "char" && task.input.char?.step === "chat") {
    const c = task.input.char;
    const where = `${CHAT_TAB_TEXT[c.tab ?? "brief"]}${c.section ? ` → ${c.section}` : ""}`;
    return [
      `[FlexiPrint task ${task.id}] Bộ nhân vật v2 — yêu cầu từ ô chat, người dùng đang ở tab ${where}.`,
      `Người dùng viết:\n${c.request}`,
      mcpLine(),
      injectLine(),
      ...(c.attachments?.length ? [`Ảnh gửi kèm (xem bằng view_image):`, ...c.attachments.map((a, i) => `${i + 1}. ${a.label || (a.source === "page" ? "Ảnh trên trang" : "Ảnh chụp màn hình")}${a.imageId ? ` (image ${a.imageId})` : ""}: ${a.url}`)] : []),
      `Gọi ${m}get_task với task_id "${task.id}" — có toàn bộ bộ nhân vật (brief, master, ảnh 3b, vùng 3c, file layer, sản phẩm, các yêu cầu trước) và "instructions". Làm đúng yêu cầu bằng các tool char_*, xem lại kết quả bằng view_image, rồi kết thúc bằng ${m}submit_result {summary} hoặc fail_task.`,
    ].join("\n");
  }
  if (task.kind === "char") {
    const c = task.input.char;
    return [
      `[FlexiPrint task ${task.id}] Bộ nhân vật v2 — ${c ? CHAR_STEP_TEXT[c.step] : ""}${c?.imageId ? ` (sửa master ${c.imageId})` : ""}.`,
      c?.request ? `Người dùng muốn: ${clip(c.request, 800)}` : "",
      mcpLine(),
      injectLine(),
      `Làm theo skill flexiprint-char (nếu chưa có thì theo "instructions" trong get_task): gọi ${m}get_task với task_id "${task.id}" (có brief, ảnh, các bước trước và quy tắc layer), làm việc bằng các tool char_*, xem lại từng ảnh bằng view_image, rồi kết thúc bằng ${m}submit_result hoặc fail_task.`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return "";
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
  const kind: CtAgentTaskKind | null = b.kind === "content" || b.kind === "char" ? b.kind : null;
  const input = kind === "content" ? parseContentInput(b.input) : kind === "char" ? parseCharInput(b.input) : null;
  if (!kind || !input) return jsonError("Task không hợp lệ", 400);

  const { data: task, error } = await s.supabase
    .from(CT_TABLES.agentTasks)
    .insert({ user_id: s.user.id, category_id: input.category.id, kind, input, status: "pending" })
    .select("*")
    .single<CtAgentTask>();
  if (error || !task) return jsonError(error?.message ?? "Không tạo được task", 500);

  // The product's / bộ nhân vật's agent session, when it has one.
  let sessionId = "";
  const contentOf = kind === "content" ? (input.content?.productId ?? null) : null;
  const charOf = kind === "char" ? (input.char?.projectId ?? null) : null;
  if (charOf) {
    // A bộ nhân vật is one conversation: brainstorm → master → edits continue the same session.
    const { data: last } = await s.supabase
      .from(CT_TABLES.agentTasks)
      .select("agent_session_id")
      .eq("kind", "char")
      .eq("input->char->>projectId", charOf)
      .neq("agent_session_id", "")
      .neq("id", task.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<Pick<CtAgentTask, "agent_session_id">>();
    sessionId = last?.agent_session_id ?? "";
  } else if (contentOf) {
    // A product's content requests are one conversation: its latest session goes on.
    const { data: last } = await s.supabase
      .from(CT_TABLES.agentTasks)
      .select("agent_session_id")
      .eq("kind", "content")
      .eq("input->content->>productId", contentOf)
      .neq("agent_session_id", "")
      .neq("id", task.id)
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
export async function listAgentTasks(s: CtSession, kind: string | null, collection: string | null = null): Promise<NextResponse> {
  let q = s.supabase.from(CT_TABLES.agentTasks).select("*").order("created_at", { ascending: false }).limit(collection ? 200 : 30);
  q = kind === "content" || kind === "char" ? q.eq("kind", kind) : q.in("kind", ["content", "char"]);
  // A product's content history / a bộ nhân vật's tasks (anyone working on it); everything else: the editor's own.
  if (kind === "content" && collection && UUID.test(collection)) q = q.eq("input->content->>productId", collection);
  else if (kind === "char" && collection && UUID.test(collection)) q = q.eq("input->char->>projectId", collection);
  else q = q.eq("user_id", s.user.id);
  const { data, error } = await q.returns<CtAgentTask[]>();
  if (error) return jsonError(error.message, 500);
  // A task @flexiprint opened for itself (char_open_task: no agent_ide job of its own) and left "running" kept the set's
  // chat busy for ever (2026-10-19): closed once it has been quiet for 20 minutes.
  const now = Date.now();
  const idle = (data ?? []).filter((t) => t.kind === "char" && t.status === "running" && !t.agent_job_id && now - Date.parse(t.updated_at) > IDLE_SELF_MS);
  if (idle.length) {
    const patch = { status: "done" as const, result: { step: "chat" as const, summary: "Task phụ của @flexiprint — tự đóng sau 20 phút không hoạt động.", imageIds: [] }, finished_at: new Date().toISOString() };
    await s.supabase.from(CT_TABLES.agentTasks).update(patch).in("id", idle.map((t) => t.id));
    for (const t of idle) Object.assign(t, patch);
  }
  return NextResponse.json({ tasks: data ?? [] });
}

const IDLE_SELF_MS = 20 * 60_000;

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
      // The turn's 202 comes before agent_ide knows the session: keep it once known (the next task resumes it).
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
    mcpLine(),
    ...(task.kind === "char" ? [injectLine()] : []),
    `Làm tiếp task này theo câu trả lời (get_task nếu cần xem lại), rồi kết thúc bằng mcp__${agentMcp()}__submit_result hoặc fail_task — chỉ khi mọi việc đã xong.`,
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
