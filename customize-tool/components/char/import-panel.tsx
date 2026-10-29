"use client";

/**
 * An imported bộ's first step (asked 2026-10-29): what the upload was, how the server or @flexiprint read it, the
 * build's progress and the files that did not fit. The product is the next step (product-step.tsx, as for a drawn set).
 */

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { charApi } from "../../lib/api-client";
import { CHECKER_STYLE, CtButton } from "../ui";
import type { CharCtx } from "./char-project";

const STATUS_TEXT: Record<string, string> = {
  uploading: "Đang tải folder lên (trang import chưa xong — mở lại từ danh sách nếu bị ngắt)",
  analyzing: "Đang đọc folder…",
  agent: "@flexiprint đang phân tích folder (định dạng lạ) — xem ở ô chat",
  building: "Đang dựng bộ + sản phẩm từ file…",
  done: "Đã dựng xong bộ và sản phẩm",
  failed: "Import lỗi",
};

export function ImportPanel(ctx: CharCtx) {
  const { project, images, editable } = ctx;
  const imp = project.brief.imported;
  const [busy, setBusy] = useState(false);
  if (!imp) return null;
  const running = imp.status === "analyzing" || imp.status === "building" || imp.status === "agent";
  const sample = images.find((im) => im.id === project.master_id);
  const rebuild = async () => {
    setBusy(true);
    try {
      await charApi.importRebuild(project.id);
      await ctx.reload();
    } catch (e) {
      ctx.error(e instanceof Error ? e.message : "Không dựng lại được");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-5xl space-y-5 p-6">
      <section className="flex flex-wrap items-start gap-5 rounded-xl border bg-card p-5">
        {sample && (
          <div className="aspect-square w-48 shrink-0 overflow-hidden rounded-lg border" style={CHECKER_STYLE}>
            {/* eslint-disable-next-line @next/next/no-img-element -- our R2 preview */}
            <img src={sample.thumb_url || sample.url} alt="Ảnh mẫu" className="h-full w-full object-contain" />
          </div>
        )}
        <div className="min-w-[260px] flex-1 space-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold">
            {running ? <Loader2 className="h-4 w-4 animate-spin text-sky-500" /> : imp.status === "done" ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : imp.status === "failed" ? <AlertTriangle className="h-4 w-4 text-destructive" /> : null}
            {STATUS_TEXT[imp.status] ?? imp.status}
          </div>
          {imp.status === "building" && imp.total > 0 && (
            <div>
              <div className="h-2 overflow-hidden rounded bg-muted">
                <div className="h-full bg-sky-500 transition-all" style={{ width: `${Math.round((imp.done / imp.total) * 100)}%` }} />
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {imp.done} / {imp.total} file layer
              </div>
            </div>
          )}
          {imp.error && <p className="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{imp.error}</p>}
          <p className="text-xs text-muted-foreground">
            Nguồn: {imp.files} file ({(imp.bytes / 1024 / 1024).toFixed(0)} MB){imp.format ? ` · đọc bằng ${imp.format === "agent" ? "@flexiprint" : imp.format}` : ""}
          </p>
          {imp.summary.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-xs">
              {imp.summary.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            {project.product_ids.length > 0 && (
              <CtButton variant="primary" onClick={() => ctx.goto("product")}>
                Xem sản phẩm
              </CtButton>
            )}
            {editable && imp.manifestUrl && !running && (
              <CtButton onClick={() => void rebuild()} disabled={busy} title="Dựng lại sản phẩm từ các file đã tải (sản phẩm đã kéo bộ vào cũng tự cập nhật)">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Dựng lại
              </CtButton>
            )}
          </div>
        </div>
      </section>
      {imp.problems.length > 0 && (
        <section className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle className="h-4 w-4 text-amber-500" /> Cần xem ({imp.problems.length})
          </div>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
            {imp.problems.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </section>
      )}
      <p className="text-xs text-muted-foreground">
        Bộ import không vẽ bằng AI: mọi file layer giữ nguyên (cùng khung, không cắt, không co giãn). Muốn sửa cách đọc (lớp nào khách chọn, tên hiện cho khách…) hay thêm sản phẩm khác từ bộ thì nhắn ở ô chat bên dưới.
      </p>
    </div>
  );
}
