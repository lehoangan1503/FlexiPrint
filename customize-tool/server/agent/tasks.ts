/**
 * The editor's own agent: the category dialog's AI work handed to the @flexiprint agent on agent_ide
 * (migration 011) instead of the built-in LLM.
 *
 *   POST ai/agent-tasks             {kind, input} → CtAgentTask: saved, then sent to agent_ide as a turn
 *                                   (POST /kernel/v1/turns). The agent reads it over flexiprint-mcp (get_task) and
 *                                   answers with submit_result / fail_task (server/mcp/tools.ts).
 *   GET  ai/agent-tasks/:id         → CtAgentTask (the dialog polls it). While it runs, the agent_ide job is checked
 *                                   too: a turn that ended without submitting fails the task with its last words.
 *   POST ai/agent-tasks/:id/cancel  stops the agent's turn.
 *   GET  ai/agent-status            → CtAgentStatus (is the dialog's "Agent @flexiprint" choice usable).
 *
 * One agent_ide session per category: the next task of the same category continues it, so the agent remembers
 * what it already tried there.
 *
 * Env: AGENT_IDE_URL (https://… of agent_ide), AGENT_IDE_TOKEN (its svc_… service token for the @flexiprint
 * project). The agent reaches back with CT_AGENT_TOKEN (server/mcp/server.ts).
 */

import { NextResponse } from "next/server";
import { CT_TABLES } from "../../config";
import { normalizeCategoryRules } from "../../lib/library";
import type { CtAgentStatus, CtAgentTask, CtAgentTaskInput, CtAgentTaskKind } from "../../types";
import { isOwnUploadUrl } from "../library";
import type { CtSession } from "../supabase";
import { clip, jsonError, record, str } from "../ai/llm";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Only a hung task is given up: agent_ide itself stops a turn after 2 h. */
const TASK_TIMEOUT_MS = 3 * 60 * 60 * 1000;

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
  const what =
    task.kind === "create" ? "Tạo danh mục mới" : task.input.note ? "Cập nhật danh mục theo phản hồi" : "Kiểm tra prompt của danh mục";
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
  const kind: CtAgentTaskKind | null = b.kind === "create" || b.kind === "revise" ? b.kind : null;
  const input = parseInput(b.input);
  if (!kind || !input) return jsonError("Task không hợp lệ", 400);
  if (kind === "create" && !input.note && !input.refUrls.length && !input.category.name) return jsonError("Nhập tên, ghi chú hoặc thả ảnh tham khảo", 400);

  const { data: task, error } = await s.supabase
    .from(CT_TABLES.agentTasks)
    .insert({ user_id: s.user.id, category_id: input.category.id, kind, input, status: "pending" })
    .select("*")
    .single<CtAgentTask>();
  if (error || !task) return jsonError(error?.message ?? "Không tạo được task", 500);

  // The category's agent session, when it has one.
  let sessionId = "";
  if (input.category.id) {
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

/** GET ai/agent-tasks/:id */
export async function getAgentTask(s: CtSession, id: string): Promise<NextResponse> {
  if (!UUID.test(id)) return jsonError("id không hợp lệ", 400);
  const { data: task, error } = await s.supabase.from(CT_TABLES.agentTasks).select("*").eq("id", id).maybeSingle<CtAgentTask>();
  if (error) return jsonError(error.message, 500);
  if (!task) return jsonError("Không tìm thấy task", 404);
  if (task.status !== "pending" && task.status !== "running") {
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
  if (Date.now() - Date.parse(task.created_at) > TASK_TIMEOUT_MS) fail = "Agent không trả lời sau 3 giờ";
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
        if (again && again.status !== "pending" && again.status !== "running") return NextResponse.json(again);
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
    await kernel(cfg, `/sessions/${encodeURIComponent(task.agent_session_id)}/stop`, { method: "POST", body: {} }).catch(() => undefined);
  }
  const patch = { status: "cancelled" as const, finished_at: new Date().toISOString() };
  await s.supabase.from(CT_TABLES.agentTasks).update(patch).eq("id", id);
  return NextResponse.json({ ...task, ...patch });
}
