"use client";

/**
 * The editor's own agent — @flexiprint on agent_ide, which sees the system through flexiprint-mcp
 * (server/agent/tasks.ts, server/mcp). Used by the deploy page's content writer and the v2 bộ nhân vật: a task is
 * sent and followed until it ends.
 */

import { useEffect, useRef, useState } from "react";
import { Bot, Loader2, MessageCircleQuestionMark, Send, Square } from "lucide-react";
import type { CtAgentQuestion, CtAgentStatus, CtAgentTask, CtAgentTaskInput, CtAgentTaskKind, CtAgentTaskProgress } from "../../types";
import { ctApi } from "../../lib/api-client";
import { CHECKER_STYLE, CtButton, CtTextarea, cx } from "../ui";

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
  const title = !status ? "Đang kiểm tra agent…" : !status.configured ? "Chưa cấu hình agent @flexiprint" : status.online ? "Agent trên agent_ide: xem toàn hệ thống" : `Agent chưa trả lời: ${status.error || "offline"}`;
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
  /** The last task that ended with a result — its test images go with the result. */
  const [finished, setFinished] = useState<CtAgentTask | null>(null);
  const stop = useRef(false);
  /** Set by answer(): the answered task replaces the polled one at once. */
  const latest = useRef<CtAgentTask | null>(null);

  const run = async <T,>(kind: CtAgentTaskKind, input: CtAgentTaskInput): Promise<T> => {
    stop.current = false;
    setFinished(null);
    let t = await ctApi.createAgentTask({ kind, input });
    latest.current = t;
    setTask(t);
    while (t.status === "pending" || t.status === "running" || t.status === "waiting") {
      await new Promise((r) => setTimeout(r, 2500));
      if (stop.current) {
        t = await ctApi.cancelAgentTask(t.id);
        break;
      }
      t = await ctApi.agentTask(t.id);
      latest.current = t;
      setTask(t);
    }
    latest.current = null;
    setTask(null);
    if (t.status === "done" && t.result) {
      setFinished(t);
      return t.result as T;
    }
    throw new Error(t.status === "cancelled" ? "Đã dừng agent" : t.error || "Agent không trả kết quả");
  };

  /** The editor's answer to the agent's open question. */
  const answer = async (questionId: string, choices: string[], text: string) => {
    const cur = latest.current;
    if (!cur) return;
    const t = await ctApi.answerAgentTask(cur.id, { question_id: questionId, choices, text });
    latest.current = t;
    setTask(t);
  };

  return { task, finished, run, answer, cancel: () => (stop.current = true) };
}

function Thumbs({ urls, size = "h-16 w-16" }: { urls: string[]; size?: string }) {
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {urls.map((u) => (
        <a key={u} href={u} target="_blank" rel="noreferrer" className={cx("block overflow-hidden rounded border", size)} style={CHECKER_STYLE}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={u} alt="" className="h-full w-full object-contain" />
        </a>
      ))}
    </div>
  );
}

const KIND_STYLE: Record<NonNullable<CtAgentTaskProgress["kind"]>, string> = {
  note: "",
  run: "text-sky-700 dark:text-sky-400",
  question: "font-medium text-amber-700 dark:text-amber-400",
  answer: "text-emerald-700 dark:text-emerald-400",
  inject: "font-medium text-violet-700 dark:text-violet-400",
};

/** What the agent is doing, live — every line of the task, its test images, and its question when it asks one. */
export function AgentProgress({ task, onCancel, onAnswer }: { task: CtAgentTask; onCancel: () => void; onAnswer: (questionId: string, choices: string[], text: string) => Promise<void> }) {
  const lines: CtAgentTaskProgress[] = task.progress ?? [];
  const asked = task.status === "waiting" ? (task.questions ?? []).find((q) => !q.answer) ?? null : null;
  const end = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [lines.length]);
  return (
    <div className="space-y-1 rounded-md border border-violet-500/30 bg-violet-500/5 p-2 text-[11px]">
      <div className="flex items-center gap-1.5 font-medium">
        {asked ? <MessageCircleQuestionMark className="h-3 w-3 text-amber-600" /> : <Loader2 className="h-3 w-3 animate-spin" />}
        {asked ? "Agent đang chờ bạn trả lời" : `Agent đang làm${task.status === "pending" ? " (đang gửi)" : ""}…`}
        <button className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent" onClick={onCancel}>
          <Square className="h-3 w-3" /> Dừng
        </button>
      </div>
      <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
        {lines.length === 0 ? (
          <p className="text-muted-foreground">Agent đang đọc task và hệ thống…</p>
        ) : (
          lines.map((l, i) => (
            <div key={`${l.at}-${i}`} className={cx(KIND_STYLE[l.kind ?? "note"], i < lines.length - 1 && !l.kind && "text-muted-foreground")}>
              <p>
                <span className="mr-1 text-muted-foreground">{TIME.format(new Date(l.at))}</span>
                {l.text}
              </p>
              {l.images && l.images.length > 0 && (
                <div className="pl-3">
                  <Thumbs urls={l.images} />
                </div>
              )}
            </div>
          ))
        )}
        <div ref={end} />
      </div>
      {asked && <QuestionBox key={asked.id} question={asked} onAnswer={(c, t) => onAnswer(asked.id, c, t)} />}
    </div>
  );
}

const TIME = new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** The agent's question: its options (one or several) and / or a typed answer. */
function QuestionBox({ question, onAnswer }: { question: CtAgentQuestion; onAnswer: (choices: string[], text: string) => Promise<void> }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (label: string) =>
    setPicked((cur) => (question.multi ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : cur[0] === label ? [] : [label]));
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await onAnswer(picked, text.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi");
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1.5 rounded-md border border-amber-500/40 bg-background p-2">
      <p className="whitespace-pre-line text-xs font-medium">{question.question}</p>
      {question.options.length > 0 && (
        <div className="space-y-1">
          {question.options.map((o) => (
            <button
              key={o.label}
              type="button"
              onClick={() => toggle(o.label)}
              className={cx("block w-full rounded border px-2 py-1 text-left", picked.includes(o.label) ? "border-amber-500 bg-amber-500/10" : "hover:bg-accent")}
            >
              <span className="font-medium">{o.label}</span>
              {o.description && <span className="block text-muted-foreground">{o.description}</span>}
            </button>
          ))}
          {question.multi && <p className="text-muted-foreground">Chọn được nhiều phương án.</p>}
        </div>
      )}
      {question.allow_text && (
        <CtTextarea rows={2} className="text-xs" placeholder={question.options.length ? "Hoặc / thêm ý của bạn…" : "Câu trả lời của bạn…"} value={text} onChange={(e) => setText(e.target.value)} />
      )}
      {error && <p className="text-destructive">{error}</p>}
      <div className="flex justify-end">
        <CtButton size="sm" variant="primary" onClick={() => void send()} disabled={busy || (!picked.length && !text.trim())}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Gửi trả lời
        </CtButton>
      </div>
    </div>
  );
}
