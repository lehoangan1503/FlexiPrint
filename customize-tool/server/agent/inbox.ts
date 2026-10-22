/**
 * "Gửi chen" (asked 2026-10-22: "chen vào đoạn hội thoại đang hoạt động và agent có thể hiểu được thay đổi của editor
 * ngay cả khi đang chạy"). agent_ide takes no message into a turn that is running, so what the editor says or does
 * meanwhile waits in ct_agent_inbox (migration 028) and rides on the agent's next MCP tool call of that bộ:
 *
 *   POST ai/agent-tasks/:id/inject {text, attachments, tab, section} → CtAgentTask  the editor's message (kind message)
 *   recordEdit(…)                     a change made by hand in the editor while a task runs (kind edit; char/* routes)
 *   takeInbox(…)                      server/mcp/server.ts: the unread rows as one text block, marked seen
 *
 * submit_result is refused while a message is unread (the agent would end without having read it).
 */

import { NextResponse } from "next/server";
import { CT_TABLES } from "../../config";
import type { CtAgentInboxRow, CtAgentTask, CtAgentTaskProgress, CtCharChatTab } from "../../types";
import { ctServiceClient, type CtServiceClient, type CtSession } from "../supabase";
import { clip, jsonError, record, str } from "../ai/llm";
import { CHAT_TAB_TEXT, chatAttachments } from "./tasks";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUNNING = ["pending", "running"];

/** The bộ a char task works on. */
const projectOf = (t: Pick<CtAgentTask, "input">): string | null => t.input.char?.projectId ?? null;

/** POST ai/agent-tasks/:id/inject */
export async function injectAgentTask(s: CtSession, id: string, body: unknown): Promise<NextResponse> {
  if (!UUID.test(id)) return jsonError("id không hợp lệ", 400);
  const db = ctServiceClient();
  if (!db) return jsonError("Thiếu service key", 501);
  const { data: task } = await db.from(CT_TABLES.agentTasks).select("*").eq("id", id).maybeSingle<CtAgentTask>();
  if (!task) return jsonError("Không tìm thấy task", 404);
  const projectId = projectOf(task);
  if (!projectId) return jsonError("Chỉ gửi chen được vào việc của bộ nhân vật", 400);
  if (!RUNNING.includes(task.status)) return jsonError(task.status === "waiting" ? "Agent đang chờ bạn trả lời câu hỏi — trả lời ở khung trên" : "Agent đã xong việc này — bấm Gửi", 409);
  const b = record(body);
  const attachments = chatAttachments(b.attachments);
  const tab = str(b.tab) as CtCharChatTab;
  const where = CHAT_TAB_TEXT[tab] ? `${CHAT_TAB_TEXT[tab]}${str(b.section) ? ` → ${clip(str(b.section), 10)}` : ""}` : "";
  const text = clip(str(b.text).trim(), 8000);
  if (!text && !attachments.length) return jsonError("Viết gì đó để gửi chen", 400);
  const row = { project_id: projectId, task_id: task.id, user_id: s.user.id, kind: "message", text: `${where ? `(đang ở tab ${where}) ` : ""}${text}`, attachments };
  const { error } = await db.from(CT_TABLES.agentInbox).insert(row);
  if (error) return jsonError(error.message, 500);
  // Shown in the task's live log (the agent's own lines may race this one: the inbox row is what counts).
  const line: CtAgentTaskProgress = { at: new Date().toISOString(), text: `Bạn gửi chen: ${clip(text || "(ảnh)", 200)}${attachments.length ? ` · ${attachments.length} ảnh` : ""}`, kind: "inject", ...(attachments.length ? { images: attachments.map((a) => a.url) } : {}) };
  const progress = [...(task.progress ?? []), line].slice(-50);
  await db.from(CT_TABLES.agentTasks).update({ progress }).eq("id", task.id);
  return NextResponse.json({ ...task, progress });
}

/**
 * A change the editor made by hand on bộ `projectId` (or on a pose / version set of it): kept for the task working on
 * it, if one runs. The same unread line is not written twice (the brief is saved as it is typed).
 */
export async function recordEdit(userId: string, projectId: string, parentId: string | null, text: string): Promise<void> {
  const db = ctServiceClient();
  if (!db || !text) return;
  const ids = [projectId, ...(parentId ? [parentId] : [])];
  const { data: tasks } = await db
    .from(CT_TABLES.agentTasks)
    .select("id, input")
    .eq("kind", "char")
    .in("status", RUNNING)
    .in("input->char->>projectId", ids)
    .order("created_at", { ascending: false })
    .limit(1)
    .returns<Array<Pick<CtAgentTask, "id" | "input">>>();
  const task = tasks?.[0];
  const owner = task ? projectOf(task) : null;
  if (!task || !owner) return;
  const line = clip(owner === projectId ? text : `${text} (trên bộ con ${projectId})`, 1000);
  const { data: same } = await db.from(CT_TABLES.agentInbox).select("id").eq("project_id", owner).eq("kind", "edit").eq("text", line).is("seen_at", null).limit(1);
  if (same?.length) return;
  await db.from(CT_TABLES.agentInbox).insert({ project_id: owner, task_id: task.id, user_id: userId, kind: "edit", text: line });
}

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Ho_Chi_Minh" });

/**
 * The unread rows of the bộ task `taskId` works on, as the text appended to a tool's answer ("" when none), marked
 * seen.
 */
export async function takeInbox(db: CtServiceClient, taskId: string): Promise<{ text: string; messages: number }> {
  if (!UUID.test(taskId)) return { text: "", messages: 0 };
  const { data: task } = await db.from(CT_TABLES.agentTasks).select("id, input").eq("id", taskId).maybeSingle<Pick<CtAgentTask, "id" | "input">>();
  const projectId = task ? projectOf(task) : null;
  if (!projectId) return { text: "", messages: 0 };
  const { data: rows } = await db.from(CT_TABLES.agentInbox).select("*").eq("project_id", projectId).is("seen_at", null).order("created_at").limit(40).returns<CtAgentInboxRow[]>();
  if (!rows?.length) return { text: "", messages: 0 };
  await db.from(CT_TABLES.agentInbox).update({ seen_at: new Date().toISOString() }).in("id", rows.map((r) => r.id));
  const messages = rows.filter((r) => r.kind === "message");
  const edits = rows.filter((r) => r.kind === "edit");
  const text = [
    "",
    "──────── 📩 GỬI CHEN — mới từ người dùng trong lúc bạn đang làm ────────",
    ...messages.flatMap((r) => [
      `[${hhmm(r.created_at)}] Người dùng nhắn: ${r.text}`,
      ...r.attachments.map((a, i) => `   ảnh ${i + 1}: ${a.label || "ảnh"}${a.imageId ? ` (image ${a.imageId})` : ""}: ${a.url}`),
    ]),
    ...(edits.length ? ["Người dùng vừa sửa tay trên editor (dữ liệu đã đổi — đọc lại bằng get_task / tool tương ứng trước khi làm tiếp phần liên quan, đừng ghi đè sửa tay của họ):", ...edits.map((r) => `   [${hhmm(r.created_at)}] ${r.text}`)] : []),
    messages.length
      ? "→ Đọc kỹ và điều chỉnh việc đang làm theo tin này NGAY (nó thay đổi / bổ sung yêu cầu ban đầu); báo bằng report_progress là đã nhận. Đừng kết thúc lượt trước khi đã làm theo."
      : "→ Tính đến các thay đổi này trong phần việc còn lại.",
  ].join("\n");
  return { text, messages: messages.length };
}

/** Whether a message of the editor waits unread for the bộ of task `taskId` (submit_result is refused then). */
export async function unreadMessages(db: CtServiceClient, taskId: string): Promise<number> {
  if (!UUID.test(taskId)) return 0;
  const { data: task } = await db.from(CT_TABLES.agentTasks).select("input").eq("id", taskId).maybeSingle<Pick<CtAgentTask, "input">>();
  const projectId = task ? projectOf(task) : null;
  if (!projectId) return 0;
  const { count } = await db.from(CT_TABLES.agentInbox).select("id", { count: "exact", head: true }).eq("project_id", projectId).eq("kind", "message").is("seen_at", null);
  return count ?? 0;
}
