"use client";

/**
 * @flexiprint on a bộ nhân vật (agent task kind "char", server/mcp/char-tools.ts): brainstorm, the master prompt and
 * every edit prompt are the agent's. One task at a time per bộ; the page follows it (also after a reload), shows
 * what the agent is doing live, and refreshes the pictures it makes. The last finished task's summary stays visible.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, X } from "lucide-react";
import type { CtAgentTask, CtCharTaskResult, CtCharTaskStep } from "../../types";
import { ctApi } from "../../lib/api-client";
import { defaultCategoryRules } from "../../lib/library";
import { AgentBadge, AgentProgress, useAgentStatus } from "../library/agent-brain";

const isOpen = (t: CtAgentTask) => t.status === "pending" || t.status === "running" || t.status === "waiting";

export interface CharAgent {
  /** The task being worked on (null = idle). */
  task: CtAgentTask | null;
  /** The last task that ended (its summary / error is shown until dismissed). */
  last: CtAgentTask | null;
  busy: boolean;
  start: (step: CtCharTaskStep, request: string, extra?: { imageId?: string | null; roles?: string[] }) => Promise<void>;
}

export function useCharAgent(projectId: string, onChange: () => Promise<void>, onError: (msg: string | null) => void) {
  const [task, setTask] = useState<CtAgentTask | null>(null);
  const [last, setLast] = useState<CtAgentTask | null>(null);
  const following = useRef<string | null>(null);
  const changed = useRef(onChange);
  useEffect(() => {
    changed.current = onChange;
  }, [onChange]);

  const follow = useCallback(async (t: CtAgentTask) => {
    following.current = t.id;
    setTask(t);
    let cur = t;
    while (isOpen(cur) && following.current === t.id) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        cur = await ctApi.agentTask(t.id);
      } catch {
        continue;
      }
      if (following.current !== t.id) return;
      setTask(cur);
      // The agent makes pictures while it works: show them as they come.
      await changed.current();
    }
    if (following.current !== t.id) return;
    following.current = null;
    setTask(null);
    setLast(cur);
    await changed.current();
  }, []);

  // A task still open from before a reload: follow it again.
  useEffect(() => {
    let live = true;
    ctApi
      .listAgentTasks("char", projectId)
      .then((list) => {
        if (!live) return;
        const open = list.find(isOpen);
        if (open) void follow(open);
        else if (list[0]) setLast(list[0]);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      following.current = null;
    };
  }, [projectId, follow]);

  const start: CharAgent["start"] = async (step, request, extra) => {
    onError(null);
    try {
      const t = await ctApi.createAgentTask({
        kind: "char",
        input: {
          category: { id: null, name: "", spec: "", rules: defaultCategoryRules() },
          note: "",
          images: [],
          refUrls: [],
          char: { projectId, step, request, imageId: extra?.imageId ?? null, roles: extra?.roles ?? [] },
        },
      });
      setLast(null);
      void follow(t);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Không gửi được cho @flexiprint");
    }
  };

  const cancel = async () => {
    if (!task) return;
    following.current = null;
    try {
      setLast(await ctApi.cancelAgentTask(task.id));
    } finally {
      setTask(null);
    }
  };

  const answer = async (questionId: string, choices: string[], text: string) => {
    if (!task) return;
    setTask(await ctApi.answerAgentTask(task.id, { question_id: questionId, choices, text }));
  };

  const agent: CharAgent = { task, last, busy: task !== null, start };
  return { agent, cancel, answer, dismiss: () => setLast(null) };
}

const STEP_LABEL: Record<CtCharTaskStep, string> = { brainstorm: "Brainstorm", master: "Master", edits: "Tô vùng clipart" };

/** Under the header: what @flexiprint is doing now, or what it said when it finished. */
export function CharAgentBar(props: ReturnType<typeof useCharAgent>) {
  const status = useAgentStatus();
  const { task, last } = props.agent;
  if (!task && !last) return null;
  const result = last?.result && "step" in last.result ? (last.result as CtCharTaskResult) : null;
  return (
    <div className="mx-4 mt-3 space-y-2 rounded-lg border border-violet-500/30 bg-violet-500/5 p-3">
      <div className="flex items-center gap-2 text-sm">
        <Bot className="h-4 w-4 text-violet-500" />
        <span className="font-semibold">
          @flexiprint — {STEP_LABEL[(task ?? last)?.input.char?.step ?? "brainstorm"]}
          {(task ?? last)?.input.char?.request ? <span className="font-normal text-muted-foreground"> · “{(task ?? last)?.input.char?.request}”</span> : null}
        </span>
        <AgentBadge status={status} />
        {!task && (
          <button className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent" onClick={props.dismiss} title="Ẩn">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {task && <AgentProgress task={task} onCancel={() => void props.cancel()} onAnswer={props.answer} />}
      {!task && last && (
        <p className={last.status === "done" ? "whitespace-pre-wrap text-xs" : "text-xs text-destructive"}>
          {last.status === "done" ? (result?.summary ?? "Xong.") : last.status === "cancelled" ? "Đã dừng." : last.error || "Agent không trả kết quả."}
        </p>
      )}
    </div>
  );
}
