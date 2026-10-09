"use client";

/**
 * Step 3 — the cut, done on the master (asked 2026-10-09): 3a the master's backdrop removed and fixed by hand →
 * 3b the in-place edits the brief needs (@flexiprint writes each prompt, runs it on the approved master, checks it)
 * → 3c every layer's region highlighted on its picture, fixed by hand → 3d the files cut from both, checked, approved.
 * 3a and 3b are independent (the edits can run while the backdrop is reviewed).
 */

import { useEffect, useMemo, useState } from "react";
import { Bot, CheckCircle2, ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import type { CtCharImage } from "../../types";
import { planEdits } from "../../lib/char-plan";
import { latestEditsOf } from "../../lib/char-images";
import { CHECKER_STYLE, CtButton, CtModal, CtTextarea, cx } from "../ui";
import type { CharCtx } from "./char-project";
import { ProductStep } from "./product-step";
import { CutEditor, FinalSection, MatteSection, PlanSection, type CutEdit } from "./cut-panel";

type Sub = "matte" | "edits" | "plan" | "final";

export function LayersPanel(ctx: CharCtx & { step: "layers" | "product" }) {
  const { project, images } = ctx;
  const plan = useMemo(() => planEdits(project.brief), [project.brief]);
  const latest = latestEditsOf(images);
  const editsDone = plan.filter((e) => latest.get(e.role)?.status === "done").length;
  const ready = editsDone === plan.length;
  const cut = project.cut;
  const first: Sub = !cut?.matte?.approved ? "matte" : !ready ? "edits" : !cut.plan?.approved || !project.layers ? "plan" : "final";
  const [sub, setSub] = useState<Sub>(first);
  const [edit, setEdit] = useState<CutEdit>(null);
  if (ctx.step === "product") return <ProductStep {...ctx} />;
  const tabs: Array<{ id: Sub; label: string; ok: boolean; note: string }> = [
    { id: "matte", label: "3a. Tách nền", ok: !!cut?.matte?.approved, note: cut?.matte?.status === "running" ? "đang chạy" : "" },
    { id: "edits", label: "3b. Bản sửa (AI)", ok: ready, note: `${editsDone}/${plan.length}` },
    { id: "plan", label: "3c. Phác thảo lớp", ok: !!cut?.plan?.approved, note: cut?.plan?.status === "running" ? "đang chạy" : "" },
    { id: "final", label: "3d. File cuối", ok: !!project.layers?.approved, note: project.layers?.status === "building" ? "đang cắt" : "" },
  ];
  const onEdit = (e: CutEdit) => {
    if (e?.kind === "piece") setSub("plan");
    setEdit(e);
  };
  return (
    <div className="space-y-4 p-6">
      <nav className="flex flex-wrap items-center gap-1 text-sm">
        {tabs.map((t, i) => (
          <div key={t.id} className="flex items-center gap-1">
            {i > 0 && <span className="px-1 text-muted-foreground">→</span>}
            <button disabled={!project.master_id} onClick={() => setSub(t.id)} className={cx("disabled:opacity-50", "flex items-center gap-1.5 rounded-md border px-3 py-1.5", sub === t.id ? "border-foreground bg-foreground text-background" : "hover:bg-accent")}>
              {t.ok && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
              {t.label}
              {t.note && <span className="text-[11px] opacity-70">{t.note}</span>}
            </button>
          </div>
        ))}
      </nav>
      {!project.master_id ? (
        <div className="rounded-xl border bg-card p-6 text-sm">
          <p className="font-medium">Bước 3 bắt đầu khi đã có master được duyệt.</p>
          <p className="mt-1 text-muted-foreground">Sang tab “2. Master”, cho @flexiprint vẽ rồi bấm Duyệt 1 bản. Sau đó ở đây lần lượt: 3a tách nền (sửa nền bằng tay) → 3b bản sửa AI → 3c phác thảo vùng từng lớp (sửa vùng bằng tay) → 3d cắt file, kiểm tra, duyệt.</p>
          <CtButton className="mt-3" onClick={() => ctx.goto("master")}>
            Sang bước Master →
          </CtButton>
        </div>
      ) : (
        <>
          {sub === "matte" && <MatteSection {...ctx} onEdit={onEdit} />}
      {sub === "edits" && <EditsSection {...ctx} />}
      {sub === "plan" && <PlanSection {...ctx} onEdit={onEdit} ready={ready} missing={ready ? "" : `Cần đủ bản sửa ở bước 3b (${editsDone}/${plan.length}).`} />}
      {sub === "final" && <FinalSection {...ctx} onEdit={onEdit} />}
        </>
      )}
      {edit && <CutEditor {...ctx} edit={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

/** How far the edit's kept pixels moved (local, 90th percentile; older rows: the overall shift). */
const shift = (im: CtCharImage) => (im.meta.align ? (im.meta.align.before ?? Math.hypot(im.meta.align.dx, im.meta.align.dy)) : null);

function EditsSection(ctx: CharCtx) {
  const { project, images, editable } = ctx;
  const plan = useMemo(() => planEdits(project.brief), [project.brief]);
  const latest = latestEditsOf(images);
  const [request, setRequest] = useState("");
  const [zoomRole, setZoomRole] = useState<string | null>(null);
  const done = plan.filter((e) => latest.get(e.role)?.status === "done").length;
  const missing = plan.length - done;
  const running = plan.some((e) => latest.get(e.role)?.status === "running");
  const busy = ctx.agent.busy;
  const working = ctx.agent.task?.input.char?.step === "edits";
  // The viewer steps through the finished edits in the grid's order (‹ › or the arrow keys).
  const viewable = plan.map((e) => latest.get(e.role)).filter((im): im is CtCharImage => im?.status === "done");
  const at = viewable.findIndex((im) => im.role === zoomRole);
  const zoom = at >= 0 ? viewable[at] : null;
  const step = (d: number) => viewable.length && setZoomRole(viewable[(at + d + viewable.length) % viewable.length].role);
  useEffect(() => {
    if (!zoom) return;
    const kd = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") step(-1);
      if (e.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", kd);
    return () => window.removeEventListener("keydown", kd);
  });

  /** @flexiprint writes the prompts, runs them and checks the results (roles: only those; none = what is missing). */
  const run = async (roles?: string[]) => {
    await ctx.agent.start("edits", request.trim(), { roles: roles ?? [] });
    setRequest("");
  };

  return (
    <section className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <h3 className="text-sm font-semibold">
            Bản sửa tại chỗ ({done}/{plan.length})
          </h3>
          <p className="text-xs text-muted-foreground">
            Danh sách bản sửa tự sinh từ brief; @flexiprint viết prompt từng bản, chạy trên master đã duyệt, tự xem và làm lại bản sai. Model xê dịch phần giữ nguyên một chút: lúc cắt layer, mỗi bản được đo và kéo về đúng chỗ (còn ≤ 0,3 px mới đạt, đỏ = làm lại).
          </p>
        </div>
        {editable && (
          <div className="flex w-full items-end gap-2 sm:w-auto">
            <CtTextarea rows={1} className="min-w-[260px]" value={request} disabled={busy} placeholder="Yêu cầu cho @flexiprint (không bắt buộc)" onChange={(e) => setRequest(e.target.value)} />
            <CtButton variant="primary" disabled={busy || running || (missing === 0 && !request.trim())} onClick={() => void run()}>
              {working || running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
              {working ? "@flexiprint đang làm…" : missing > 0 ? `Gửi @flexiprint tạo ${missing} bản còn thiếu` : "Gửi @flexiprint xem lại"}
            </CtButton>
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 2xl:grid-cols-8">
        {plan.map((e) => {
          const im = latest.get(e.role);
          const d = im ? shift(im) : null;
          return (
            <div key={e.role} className="overflow-hidden rounded-lg border">
              <button className="block aspect-square w-full bg-white" disabled={im?.status !== "done"} onClick={() => im && setZoomRole(im.role)}>
                {im?.status === "done" ? (
                  // eslint-disable-next-line @next/next/no-img-element -- our R2 WebP preview
                  <img src={im.thumb_url || im.url} alt={e.label} className="h-full w-full object-contain" />
                ) : im?.status === "running" ? (
                  <div className="flex h-full items-center justify-center">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : im?.status === "failed" ? (
                  <div className="flex h-full items-center justify-center p-2 text-[10px] text-destructive">{im.error || "Lỗi"}</div>
                ) : (
                  <div className="flex h-full items-center justify-center text-[10px] text-muted-foreground">Chưa tạo</div>
                )}
              </button>
              <div className="space-y-1 p-1.5">
                <div className="truncate text-[11px] font-medium" title={e.label}>
                  {e.label}
                </div>
                <div className="flex items-center gap-1 text-[10px]">
                  {e.role === "work" ? (
                    <span className="text-muted-foreground">{im?.width ? `${im.width}×${im.height}` : ""}</span>
                  ) : im?.meta.align?.residual !== undefined ? (
                    <span
                      className={cx("rounded px-1 font-medium", im.meta.align.residual <= 0.3 && (d ?? 0) <= 3 ? "bg-emerald-500/15 text-emerald-600" : "bg-destructive/15 text-destructive")}
                      title={`Model xê dịch phần giữ nguyên một chút khi sửa; lúc cắt layer ảnh được kéo về đúng chỗ (không vẽ lại). Còn lệch: ${im.meta.align.residual.toFixed(2)} px, chỗ tệ nhất ${(im.meta.align.max ?? im.meta.align.residual).toFixed(2)} px`}
                    >
                      {(d ?? 0).toFixed(2)} → {im.meta.align.residual.toFixed(2)} px
                    </span>
                  ) : d !== null ? (
                    <span className={cx("rounded px-1 font-medium", d <= 3 ? "bg-muted text-muted-foreground" : "bg-destructive/15 text-destructive")} title="Sẽ được chỉnh khi cắt layer">
                      dời {d.toFixed(2)} px
                    </span>
                  ) : null}
                  {editable && im && im.status !== "running" && e.role !== "work" && (
                    <button
                      className="ml-auto rounded p-0.5 hover:bg-accent disabled:opacity-40"
                      disabled={busy}
                      title={e.role === "base" ? "@flexiprint làm lại (kéo theo các bản làm từ nó) — ghi yêu cầu ở ô trên nếu cần" : "@flexiprint làm lại bản này — ghi yêu cầu ở ô trên nếu cần"}
                      onClick={() => void run([e.role])}
                    >
                      <RefreshCw className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <CtModal open={!!zoom} onOpenChange={(o) => !o && setZoomRole(null)} title={zoom ? `${zoom.note || zoom.role} · ${at + 1}/${viewable.length}` : ""} wide>
        {zoom && (
          <div className="space-y-2">
            <div className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element -- the original */}
              <img src={zoom.url} alt="edit" className="mx-auto max-h-[70vh] w-auto object-contain" style={CHECKER_STYLE} />
              {viewable.length > 1 && (
                <>
                  <button className="absolute left-1 top-1/2 -translate-y-1/2 rounded-full bg-background/80 p-2 shadow hover:bg-background" onClick={() => step(-1)} title="Ảnh trước (←)">
                    <ChevronLeft className="h-6 w-6" />
                  </button>
                  <button className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full bg-background/80 p-2 shadow hover:bg-background" onClick={() => step(1)} title="Ảnh sau (→)">
                    <ChevronRight className="h-6 w-6" />
                  </button>
                </>
              )}
            </div>
            {zoom.prompt && <pre className="whitespace-pre-wrap rounded bg-muted/50 p-2 text-[11px]">{zoom.prompt}</pre>}
          </div>
        )}
      </CtModal>
    </section>
  );
}
