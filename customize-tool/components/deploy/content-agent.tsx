"use client";

/**
 * "Tạo content với FlexiPrint": the product's Shopify title + description written by @flexiprint (agent task kind
 * "content", server/agent/tasks.ts). Every request of a product is one conversation: the history lists each
 * request with what came back — "Dùng" puts it in the form, "Sửa tiếp" continues from that version.
 */

import { useCallback, useEffect, useState } from "react";
import { Check, History, Loader2, Sparkles, Undo2 } from "lucide-react";
import type { CtAgentTask, CtContentResult } from "../../types";
import { ctApi } from "../../lib/api-client";
import { defaultCategoryRules } from "../../lib/library";
import { AgentBadge, AgentProgress, useAgentStatus, useAgentTask } from "../library/agent-brain";
import { CtButton, CtTextarea, cx } from "../ui";

const TIME = new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short" });

function contentOf(t: CtAgentTask): CtContentResult | null {
  return t.result && "descriptionHtml" in t.result ? t.result : null;
}

export function ContentAgent({
  productId,
  productName,
  title,
  descriptionHtml,
  facts,
  imageUrls,
  onUse,
}: {
  productId: string;
  productName: string;
  /** The form's title / description now: what the agent edits from. */
  title: string;
  descriptionHtml: string;
  facts: string[];
  imageUrls: string[];
  onUse: (c: CtContentResult) => void;
}) {
  const status = useAgentStatus();
  const agent = useAgentTask();
  const [request, setRequest] = useState("");
  const [history, setHistory] = useState<CtAgentTask[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** The version "Sửa tiếp" continues from (null = the form as it is). */
  const [base, setBase] = useState<CtAgentTask | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const reload = useCallback(() => {
    ctApi
      .listAgentTasks("content", productId)
      .then(setHistory)
      .catch(() => undefined);
  }, [productId]);
  useEffect(reload, [reload]);

  const send = async () => {
    setError(null);
    const from = base ? contentOf(base) : null;
    try {
      const r = await agent.run<CtContentResult>("content", {
        category: { id: null, name: "", spec: "", rules: defaultCategoryRules() },
        note: "",
        images: [],
        refUrls: [],
        content: { productId, productName, request: request.trim(), title: from?.title ?? title, descriptionHtml: from?.descriptionHtml ?? descriptionHtml, facts, imageUrls },
      });
      onUse(r);
      setRequest("");
      setBase(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Agent không trả kết quả");
    } finally {
      reload();
    }
  };

  const busy = agent.task !== null;
  const done = history.filter((t) => contentOf(t));

  return (
    <div className="space-y-2 rounded-lg border border-violet-500/30 bg-violet-500/5 p-3">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-violet-500" />
        <span className="text-sm font-semibold">Tạo content với FlexiPrint</span>
        <AgentBadge status={status} />
        <button className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent" onClick={() => setShowHistory((v) => !v)}>
          <History className="h-3.5 w-3.5" /> Lịch sử ({done.length})
        </button>
      </div>
      {base && (
        <div className="flex items-center gap-1.5 rounded bg-background/60 px-2 py-1 text-[11px]">
          <Undo2 className="h-3 w-3" /> Sửa tiếp từ bản {TIME.format(new Date(base.created_at))}: <b className="truncate">{contentOf(base)?.title}</b>
          <button className="ml-auto text-muted-foreground hover:text-foreground" onClick={() => setBase(null)}>
            bỏ
          </button>
        </div>
      )}
      <CtTextarea
        rows={2}
        value={request}
        onChange={(e) => setRequest(e.target.value)}
        placeholder="Mô tả content / mong muốn cho title, description (vd. quà cho tài xế mới, giọng ấm áp, nhấn mạnh in tên + bang, ~150 từ)…"
        disabled={busy}
      />
      <div className="flex items-center gap-2">
        <CtButton size="sm" variant="primary" onClick={() => void send()} disabled={busy || status?.configured === false}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {base ? "Gửi sửa tiếp" : title || descriptionHtml ? "Viết lại / sửa" : "Tạo title + description"}
        </CtButton>
        <span className="text-[11px] text-muted-foreground">Agent đọc sản phẩm, option khách, bảng giá, ảnh và các lần trước.</span>
      </div>
      {agent.task && <AgentProgress task={agent.task} onCancel={agent.cancel} onAnswer={agent.answer} />}
      {error && <div className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">{error}</div>}

      {showHistory && (
        <div className="max-h-80 space-y-1.5 overflow-y-auto">
          {history.length === 0 && <p className="text-[11px] text-muted-foreground">Chưa có lần nào.</p>}
          {history.map((t) => {
            const c = contentOf(t);
            return (
              <div key={t.id} className={cx("rounded-md border bg-background/70 p-2 text-[11px]", base?.id === t.id && "ring-1 ring-violet-500")}>
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <span>{TIME.format(new Date(t.created_at))}</span>
                  <span>·</span>
                  <span className="truncate">{t.input.content?.request || "(không ghi yêu cầu)"}</span>
                  {!c && <span className="ml-auto shrink-0">{t.status === "failed" ? "lỗi" : t.status === "cancelled" ? "đã dừng" : "đang làm"}</span>}
                </div>
                {c && (
                  <>
                    <div className="mt-1 font-medium">{c.title}</div>
                    <div className="line-clamp-3 text-muted-foreground">{c.descriptionHtml.replace(/<[^>]+>/g, " ")}</div>
                    {c.summary && <div className="mt-0.5 italic text-muted-foreground">{c.summary}</div>}
                    <div className="mt-1 flex gap-1.5">
                      <CtButton size="sm" onClick={() => onUse(c)}>
                        <Check className="h-3 w-3" /> Dùng bản này
                      </CtButton>
                      <CtButton size="sm" variant="ghost" onClick={() => setBase(t)} disabled={busy}>
                        <Undo2 className="h-3 w-3" /> Sửa tiếp
                      </CtButton>
                    </div>
                  </>
                )}
                {!c && t.error && <div className="text-destructive">{t.error}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
