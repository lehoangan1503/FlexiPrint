"use client";

/**
 * Import bộ seen from every page (asked 2026-11-02): the header's mark (folders uploading, imports the server is
 * building, a check when one finished) and the toasts when one ends. The work itself is lib/import-queue.ts.
 */

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, FolderUp, Info, Loader2, X } from "lucide-react";
import { dismissToast, importSummary, startImportPolling, useImports } from "../../lib/import-queue";

/** App-wide, once (root layout): polls the imports and shows the toasts. */
export function ImportWatcher() {
  const { toasts } = useImports();
  useEffect(() => startImportPolling(), []);
  if (!toasts.length) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[100] flex w-[360px] max-w-[calc(100vw-32px)] flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} className={`flex gap-2 rounded-lg border bg-card p-3 text-sm shadow-lg ${t.kind === "error" ? "border-destructive/50" : t.kind === "success" ? "border-emerald-500/50" : ""}`}>
          {t.kind === "success" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" /> : t.kind === "error" ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" /> : <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-500" />}
          <div className="min-w-0 flex-1">
            <div className="font-medium">{t.title}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{t.body}</div>
            {t.href && (
              <Link href={t.href} onClick={() => dismissToast(t.id)} className="mt-1 inline-block text-xs font-medium text-sky-500 hover:underline">
                Mở bộ →
              </Link>
            )}
          </div>
          <button onClick={() => dismissToast(t.id)} className="h-fit rounded p-0.5 text-muted-foreground hover:bg-accent" aria-label="Đóng">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** The header's mark: nothing when no import runs or just finished. */
export function ImportStatus() {
  const s = useImports();
  const { running, percent, failed } = importSummary(s);
  const fresh = s.fresh.length;
  if (!running && !failed && !fresh) return null;
  const tone = failed ? "border-destructive/50 text-destructive" : running ? "border-sky-500/40 text-sky-600 dark:text-sky-400" : "border-emerald-500/50 text-emerald-600 dark:text-emerald-400";
  const text = running ? `Import ${running} bộ${percent !== null ? ` · ${percent}%` : ""}` : failed ? `Import lỗi ${failed}` : `Import xong ${fresh} bộ`;
  return (
    <Link href="/v2/import" title="Xem các bộ đang import" className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-xs font-medium hover:bg-accent ${tone}`}>
      {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : failed ? <AlertTriangle className="h-3.5 w-3.5" /> : fresh ? <CheckCircle2 className="h-3.5 w-3.5" /> : <FolderUp className="h-3.5 w-3.5" />}
      {text}
      {running > 0 && failed > 0 && <span className="text-destructive">· {failed} lỗi</span>}
    </Link>
  );
}
