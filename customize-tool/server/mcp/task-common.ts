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
  return { db, task: data };
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

