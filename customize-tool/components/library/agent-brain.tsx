"use client";

/**
 * The category dialog's AI is the editor's own agent — @flexiprint on agent_ide, which sees the whole system
 * through flexiprint-mcp (server/agent/tasks.ts, server/mcp). The dialog sends a task and waits for it; the
 * result comes back in the built-in LLM's shape, so the rest of the dialog (tick, apply) does not change.
 */

import { useEffect, useRef, useState } from "react";
import { Bot, Loader2, Square } from "lucide-react";
import type { CtAgentStatus, CtAgentTask, CtAgentTaskInput, CtAgentTaskKind, CtAgentTaskProgress } from "../../types";
import { ctApi } from "../../lib/api-client";
import { cx } from "../ui";

/** Whether @flexiprint is set up and answering. null while loading. */
export function useAgentStatus() {
  const [status, setStatus] = useState<CtAgentStatus | null>(null);
  useEffect(() => {
    let live = true;
    ctApi
      .agentStatus()
      .then((s) => live && setStatus(s))
      .catch((e: Error) => live && setStatus({ configured: false, online: false, name: "", error: e.message }));
    return () => {
      live = false;
    };
  }, []);
  return status;
}

/** "@flexiprint ●" — who the dialog sends the work to, and whether it is online. */
export function AgentBadge({ status }: { status: CtAgentStatus | null }) {
  const title = !status ? "Đang kiểm tra agent…" : !status.configured ? "Chưa cấu hình agent @flexiprint" : status.online ? "Agent trên agent_ide: xem toàn hệ thống, có thể tạo ảnh thử rồi mới đề xuất" : `Agent chưa trả lời: ${status.error || "offline"}`;
  return (
    <span title={title} className="inline-flex items-center gap-1 rounded-md border bg-muted/50 px-2 py-0.5 text-[11px]">
      <Bot className="h-3 w-3" /> @{status?.name || "flexiprint"}
      <span className={cx("h-1.5 w-1.5 rounded-full", !status ? "bg-muted-foreground" : status.configured && status.online ? "bg-emerald-500" : "bg-rose-500")} />
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
