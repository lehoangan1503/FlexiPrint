"use client";

/**
 * "Bộ não AI" of the category dialog: the built-in LLM (Gemini Flash) or the editor's own agent — @flexiprint on
 * agent_ide, which sees the whole system through flexiprint-mcp (server/agent/tasks.ts, server/mcp). With the
 * agent, the dialog sends a task and waits for it; the result comes back in the built-in LLM's shape, so the
 * rest of the dialog (tick, apply) does not change.
 */

import { useEffect, useRef, useState } from "react";
import { Bot, Loader2, Sparkles, Square } from "lucide-react";
import type { CtAgentStatus, CtAgentTask, CtAgentTaskInput, CtAgentTaskKind, CtAgentTaskProgress } from "../../types";
import { ctApi } from "../../lib/api-client";
import { cx } from "../ui";

export type CtAiBrain = "builtin" | "agent";

const BRAIN_KEY = "ct-ai-brain";

function readBrain(): CtAiBrain {
  try {
    return localStorage.getItem(BRAIN_KEY) === "agent" ? "agent" : "builtin";
  } catch {
    return "builtin";
  }
}

/** The chosen brain (remembered per browser) and whether the agent can be used at all. */
export function useAiBrain() {
  const [status, setStatus] = useState<CtAgentStatus | null>(null);
  const [brain, setBrainState] = useState<CtAiBrain>("builtin");
  useEffect(() => {
    let live = true;
    ctApi
      .agentStatus()
      .then((s) => {
        if (!live) return;
        setStatus(s);
        if (s.configured) setBrainState(readBrain());
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const setBrain = (b: CtAiBrain) => {
    setBrainState(b);
    try {
      localStorage.setItem(BRAIN_KEY, b);
    } catch {
      // The choice just isn't remembered.
    }
  };
  return { status, brain: status?.configured ? brain : ("builtin" as const), setBrain };
}

/** Flash | Agent switch — hidden while no agent is configured. */
export function BrainToggle(props: { status: CtAgentStatus | null; brain: CtAiBrain; onBrain: (b: CtAiBrain) => void; disabled?: boolean }) {
  if (!props.status?.configured) return null;
  const item = (b: CtAiBrain, label: React.ReactNode, title: string) => (
    <button
      type="button"
      disabled={props.disabled}
      title={title}
      onClick={() => props.onBrain(b)}
      className={cx("inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px]", props.brain === b ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}
    >
      {label}
    </button>
  );
  return (
    <span className="inline-flex items-center gap-0.5 rounded-md border bg-muted/50 p-0.5">
      {item("builtin", <><Sparkles className="h-3 w-3" /> Flash</>, "AI có sẵn (Gemini Flash) — nhanh")}
      {item(
        "agent",
        <>
          <Bot className="h-3 w-3" /> @{props.status.name || "flexiprint"}
          <span className={cx("h-1.5 w-1.5 rounded-full", props.status.online ? "bg-emerald-500" : "bg-rose-500")} />
        </>,
        props.status.online ? "Agent của bạn trên agent_ide: xem toàn hệ thống, có thể tạo ảnh thử rồi mới đề xuất — chậm hơn" : `Agent chưa trả lời: ${props.status.error || "offline"}`,
      )}
    </span>
  );
}

/** A task sent to the agent, followed until it ends. Resolves with the result; rejects with the agent's reason. */
export function useAgentTask() {
  const [task, setTask] = useState<CtAgentTask | null>(null);
  const stop = useRef(false);

  const run = async <T,>(kind: CtAgentTaskKind, input: CtAgentTaskInput): Promise<T> => {
    stop.current = false;
    let t = await ctApi.createAgentTask({ kind, input });
    setTask(t);
    while (t.status === "pending" || t.status === "running") {
      await new Promise((r) => setTimeout(r, 2500));
      if (stop.current) {
        t = await ctApi.cancelAgentTask(t.id);
        break;
      }
      t = await ctApi.agentTask(t.id);
      setTask(t);
    }
    setTask(null);
    if (t.status === "done" && t.result) return t.result as T;
    throw new Error(t.status === "cancelled" ? "Đã dừng agent" : t.error || "Agent không trả kết quả");
  };

  return { task, run, cancel: () => (stop.current = true) };
}

/** What the agent says it is doing, live. */
export function AgentProgress({ task, onCancel }: { task: CtAgentTask; onCancel: () => void }) {
  const lines: CtAgentTaskProgress[] = task.progress ?? [];
  return (
    <div className="space-y-1 rounded-md border border-violet-500/30 bg-violet-500/5 p-2 text-[11px]">
      <div className="flex items-center gap-1.5 font-medium">
        <Loader2 className="h-3 w-3 animate-spin" /> Agent đang làm{task.status === "pending" ? " (đang gửi)" : ""}…
        <button className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent" onClick={onCancel}>
          <Square className="h-3 w-3" /> Dừng
        </button>
      </div>
      {lines.length === 0 ? (
        <p className="text-muted-foreground">Agent đang đọc task và hệ thống…</p>
      ) : (
        lines.slice(-6).map((l, i) => (
          <p key={`${l.at}-${i}`} className={i === Math.min(lines.length, 6) - 1 ? "" : "text-muted-foreground"}>
            • {l.text}
          </p>
        ))
      )}
    </div>
  );
}
