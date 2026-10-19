"use client";

/**
 * Step 3 — the cut (rebuilt 2026-10-14, lib/char-plan.ts — pixel lock): 3a the master's own cut-out at print size →
 * 3b the paper doll and every option drawn on it (@flexiprint writes each prompt, or "Tạo ngay" with the planned ones)
 * → 3c "Bộ custom": ONE button takes each option's pixels that differ from the doll as its file and builds the product;
 * the dress-up view (layers on the left, the options of each item on the right) is where files are checked / fixed.
 * 3a runs by itself when the master is approved; 3b can run at the same time.
 */

import { VersionsPanel } from "./versions-panel";
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import type { CtCharImage } from "../../types";
import { planEdits } from "../../lib/char-plan";
import { latestEditsOf } from "../../lib/char-images";
import { CHECKER_STYLE, CtButton, CtModal, FLOAT_BTN, cx } from "../ui";
import type { CharCtx } from "./char-project";
import { ProductStep } from "./product-step";
import { CustomSection, CutEditor, MatteSection, type CutEdit } from "./cut-panel";
import { AutoStepGuide } from "./step-guide";

type Sub = "matte" | "edits" | "custom";

export function LayersPanel(ctx: CharCtx & { step: "layers" | "product" }) {
  const { project, images } = ctx;
  const plan = useMemo(() => planEdits(project.brief), [project.brief]);
  const latest = latestEditsOf(images);
  const editsDone = plan.filter((e) => latest.get(e.role)?.status === "done").length;
  const ready = editsDone === plan.length;
  const cut = project.cut;
  const first: Sub = cut?.matte?.status !== "done" ? "matte" : !ready ? "edits" : "custom";
  const [sub, setSub] = useState<Sub>(first);
  const [edit, setEdit] = useState<CutEdit>(null);
  const { setSection } = ctx;
  useEffect(() => {
    setSection(sub === "matte" ? "3a" : sub === "edits" ? "3b" : "3c");
  }, [sub, setSection]);
  if (ctx.step === "product") return <ProductStep {...ctx} />;
  const tabs: Array<{ id: Sub; label: string; ok: boolean; note: string }> = [
    { id: "matte", label: "3a. Master cỡ in", ok: cut?.matte?.status === "done", note: cut?.matte?.status === "running" ? "đang chạy" : "" },
    { id: "edits", label: "3b. AI vẽ ảnh để cắt", ok: ready, note: `${editsDone}/${plan.length}` },
    { id: "custom", label: "3c. Bộ custom → sản phẩm", ok: !!project.layers?.approved, note: cut?.plan?.status === "running" ? "đang phác thảo" : project.layers?.status === "building" ? "đang cắt + tạo sản phẩm" : "" },
  ];
  // The editors are modals over whichever tab is open.
  const onEdit = (e: CutEdit) => setEdit(e);
  return (
    <div className="space-y-4 p-6">
      <AutoStepGuide what="@flexiprint cắt clipart từ master" />
      <VersionsPanel {...ctx} />
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
          <p className="mt-1 text-muted-foreground">Sang tab “2. Ảnh master”, cho @flexiprint vẽ rồi bấm Duyệt 1 bản. Duyệt xong, @flexiprint tự làm hết: 3a master cỡ in → 3b búp bê giấy và từng kiểu vẽ lên búp bê → 3c cắt clipart và ráp sản phẩm → bước 4 nền, phần tử, mockup. Bạn chỉ xem; cần sửa thì bấm Dừng và nhắn ở ô chat.</p>
          <CtButton className="mt-3" onClick={() => ctx.goto("master")}>
            Sang bước 2 →
          </CtButton>
        </div>
      ) : (
        <>
          {sub === "matte" && <MatteSection {...ctx} onEdit={onEdit} />}
          {sub === "edits" && <EditsSection {...ctx} />}
          {sub === "custom" && <CustomSection {...ctx} onEdit={onEdit} ready={ready} missing={ready ? "" : `Cần đủ ảnh ở bước 3b (${editsDone}/${plan.length}).`} />}
        </>
      )}
      {edit && <CutEditor {...ctx} edit={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

/** How far the edit's kept pixels moved (local, 90th percentile; older rows: the overall shift). */
const shift = (im: CtCharImage) => (im.meta.align ? (im.meta.align.before ?? Math.hypot(im.meta.align.dx, im.meta.align.dy)) : null);

function EditsSection(ctx: CharCtx) {
  const { project, images } = ctx;
  const plan = useMemo(() => planEdits(project.brief), [project.brief]);
  const latest = latestEditsOf(images);
  const [zoomRole, setZoomRole] = useState<string | null>(null);
  const done = plan.filter((e) => latest.get(e.role)?.status === "done").length;
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

  return (
    <section className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <h3 className="text-sm font-semibold">AI vẽ ảnh để cắt clipart ({done}/{plan.length})</h3>
          <p className="text-xs text-muted-foreground">
            Tự động: @flexiprint vẽ búp bê giấy (bỏ mọi phần khách đổi) rồi vẽ TỪNG kiểu lên chính búp bê đó, tự xem và vẽ lại ảnh sai. Mỗi clipart = đúng những pixel ảnh của kiểu đó khác búp bê, nên ghép lại không lệch. Thấy ảnh nào chưa ưng thì nhắn ở ô chat bên dưới.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 2xl:grid-cols-8">
        {plan.map((e) => {
          const im = latest.get(e.role);
          const d = im ? shift(im) : null;
          return (
            <div key={e.role} className="overflow-hidden rounded-lg border">
              <button className="block aspect-square w-full" style={CHECKER_STYLE} disabled={im?.status !== "done"} onClick={() => im && setZoomRole(im.role)}>
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
                      className={cx("rounded px-1 font-medium", im.meta.align.residual <= 0.5 && (d ?? 0) <= 4 ? "bg-emerald-500/15 text-emerald-600" : "bg-destructive/15 text-destructive")}
                      title={`Model xê dịch phần giữ nguyên một chút khi sửa; lúc cắt layer ảnh được kéo về đúng chỗ (không vẽ lại). Còn lệch: ${im.meta.align.residual.toFixed(2)} px, chỗ tệ nhất ${(im.meta.align.max ?? im.meta.align.residual).toFixed(2)} px`}
                    >
                      {(d ?? 0).toFixed(2)} → {im.meta.align.residual.toFixed(2)} px
                    </span>
                  ) : d !== null ? (
                    <span className={cx("rounded px-1 font-medium", d <= 3 ? "bg-muted text-muted-foreground" : "bg-destructive/15 text-destructive")} title="Sẽ được chỉnh khi cắt layer">
                      dời {d.toFixed(2)} px
                    </span>
                  ) : null}
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
                  <button className={cx("absolute left-1 top-1/2 -translate-y-1/2 p-2", FLOAT_BTN)} onClick={() => step(-1)} title="Ảnh trước (←)">
                    <ChevronLeft className="h-6 w-6" />
                  </button>
                  <button className={cx("absolute right-1 top-1/2 -translate-y-1/2 p-2", FLOAT_BTN)} onClick={() => step(1)} title="Ảnh sau (→)">
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
