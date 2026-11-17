/**
 * Helpers of the web-app tasks shared by the MCP tool modules (tools.ts, char-tools.ts) — kept apart so neither
 * module imports the other.
 */

import { CT_TABLES } from "../../config";
import type { CtAgentQuestion, CtAgentTask } from "../../types";
import type { CtServiceClient } from "../supabase";
import { str } from "../ai/llm";
import type { CtMcpContext, CtMcpOutput } from "./tools";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const json = (v: unknown): CtMcpOutput => ({ json: v });

export async function loadTask(ctx: CtMcpContext, id: unknown): Promise<{ db: CtServiceClient; task: CtAgentTask }> {
  const db = ctx.service;
  if (!db) throw new Error("Tasks need the agent token");
  const key = str(id);
  if (!UUID.test(key)) throw new Error("task_id is not a valid id");
  const { data, error } = await db.from(CT_TABLES.agentTasks).select("*").eq("id", key).maybeSingle<CtAgentTask>();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No such task");
  if (ctx.caller === "user") {
    // A user's own task (admins: anyone's) that @flexiprint is not running (a web-app task sent to the agent stays its).
    if (data.user_id !== ctx.userId && !ctx.admin) throw new Error("No such task, or it is not yours");
    if (data.agent_job_id) throw new Error("@flexiprint is working on this task — open your own: char_open_task (a set) or work without task_id");
  }
  return { db, task: data };
}

/** Who a tool works for: the task's user (agent, task_id required) or the signed-in user (task_id optional). */
export async function actorOf(ctx: CtMcpContext, id: unknown): Promise<{ db: CtServiceClient; task: CtAgentTask | null; userId: string }> {
  if (ctx.caller === "user" && !str(id)) {
    if (!ctx.service || !ctx.userId) throw new Error("Not signed in");
    return { db: ctx.service, task: null, userId: ctx.userId };
  }
  const { db, task } = await loadTask(ctx, id);
  if (!task.user_id) throw new Error("The task has no user");
  return { db, task, userId: task.user_id };
}

export function openTask(task: CtAgentTask): void {
  if (task.status !== "pending" && task.status !== "running" && task.status !== "waiting") throw new Error(`Task is ${task.status} — nothing more to do`);
}

/** The task's open question (asked, not answered yet), if any. */
export function openQuestion(task: CtAgentTask): CtAgentQuestion | null {
  return (task.questions ?? []).find((q) => !q.answer) ?? null;
}

/** "running", or "waiting" while a question of the agent's is unanswered. */
export function liveStatus(task: CtAgentTask): "running" | "waiting" {
  return openQuestion(task) ? "waiting" : "running";
}

export async function patchTask(db: CtServiceClient, id: string, patch: Partial<CtAgentTask>): Promise<void> {
  const { error } = await db.from(CT_TABLES.agentTasks).update(patch).eq("id", id);
  if (error) throw new Error(error.message);
}

export const TASK_ARG = { task_id: { type: "string", description: "The task id from the message." } };
/** task_id of a tool a signed-in user calls without a task. */
export const OPT_TASK_ARG = { task_id: { type: "string", description: "Agent: the task id from the message. A signed-in user: leave out." } };

