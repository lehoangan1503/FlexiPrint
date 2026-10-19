/**
 * What the editor does on each step of a bộ (asked 2026-10-19): 1 and 2 are reviewed by hand — the options, the
 * typed names and the backgrounds; the master every clipart is cut from — 3 and 4 run by themselves.
 */

import { Bot, Hand, MessageSquare } from "lucide-react";
import { cx } from "../ui";

export function StepGuide({ auto = false, title, children }: { auto?: boolean; title: string; children: React.ReactNode }) {
  return (
    <div className={cx("flex gap-3 rounded-xl border p-4 text-sm", auto ? "border-sky-500/40 bg-sky-500/5" : "border-amber-500/50 bg-amber-500/10")}>
      {auto ? <Bot className="mt-0.5 h-5 w-5 shrink-0 text-sky-500" /> : <Hand className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />}
      <div className="space-y-1">
        <div className="font-semibold">{title}</div>
        <div className="space-y-1 text-xs text-muted-foreground [&_b]:text-foreground">{children}</div>
      </div>
    </div>
  );
}

/** Steps 3 and 4: nothing to press — look if you want, fix by hand or in the chat at the bottom. */
export function AutoStepGuide({ what }: { what: string }) {
  return (
    <StepGuide auto title={`Bước này chạy tự động — ${what}`}>
      <p>
        Duyệt master xong, @flexiprint tự làm hết, <b>bạn không cần bấm gì</b>. Muốn thì mở ra xem từng phần.
      </p>
      <p>
        Clipart kết quả <b>sửa tay được</b> (bấm vào file), hoặc <MessageSquare className="inline h-3.5 w-3.5 align-[-2px]" /> <b>nhờ @flexiprint sửa tiếp</b>: gõ yêu cầu vào ô chat ở dưới cùng màn hình.
      </p>
    </StepGuide>
  );
}
