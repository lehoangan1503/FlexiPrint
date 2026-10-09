"use client";

/**
 * Step 3 — the cut, done on the master (asked 2026-10-09): 3a the master's backdrop removed and fixed by hand →
 * 3b the in-place edits the brief needs (@flexiprint writes each prompt, runs it on the approved master, checks it)
 * → 3c "Bộ custom": ONE button plans every layer's region and cuts the files from both; the dress-up view (master on the
 * left, the options of each item on the right) is where regions are fixed by hand, files checked and approved.
 * 3a and 3b are independent (the edits can run while the backdrop is reviewed). PlanSection (cut-panel.tsx) is the
 * old step-by-step view of the regions, no longer in the nav.
 */

import { useEffect, useMemo, useState } from "react";
import { Bot, CheckCircle2, ChevronLeft, ChevronRight, Loader2, RefreshCw, Sparkles } from "lucide-react";
import type { CtCharImage } from "../../types";
import { planEdits } from "../../lib/char-plan";
import { latestEditsOf } from "../../lib/char-images";
import { CHECKER_STYLE, CtButton, CtModal, CtTextarea, cx } from "../ui";
import { charApi } from "../../lib/api-client";
import { printApi } from "../../lib/print-api";
import type { CtPrintTemplate } from "../../types/print";
import { PrintSheet } from "../print/print-sheet";
import type { CharCtx } from "./char-project";
import { ProductStep } from "./product-step";
import { CustomSection, CutEditor, MatteSection, type CutEdit } from "./cut-panel";

type Sub = "matte" | "edits" | "custom";

export function LayersPanel(ctx: CharCtx & { step: "layers" | "product" }) {
  const { project, images } = ctx;
  const plan = useMemo(() => planEdits(project.brief), [project.brief]);
  const latest = latestEditsOf(images);
  const editsDone = plan.filter((e) => latest.get(e.role)?.status === "done").length;
  const ready = editsDone === plan.length;
  const cut = project.cut;
  const first: Sub = !cut?.matte?.approved ? "matte" : !ready ? "edits" : "custom";
  const [sub, setSub] = useState<Sub>(first);
  const [edit, setEdit] = useState<CutEdit>(null);
  if (ctx.step === "product") return <ProductStep {...ctx} />;
  const tabs: Array<{ id: Sub; label: string; ok: boolean; note: string }> = [
    { id: "matte", label: "3a. Tách nền", ok: !!cut?.matte?.approved, note: cut?.matte?.status === "running" ? "đang chạy" : "" },
    { id: "edits", label: "3b. AI tô vùng clipart", ok: ready, note: `${editsDone}/${plan.length}` },
    { id: "custom", label: "3c. Bộ custom → sản phẩm", ok: !!project.layers?.approved, note: cut?.plan?.status === "running" ? "đang phác thảo" : project.layers?.status === "building" ? "đang cắt + tạo sản phẩm" : "" },
  ];
  // The editors are modals over whichever tab is open.
  const onEdit = (e: CutEdit) => setEdit(e);
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
          <p className="mt-1 text-muted-foreground">Sang tab “2. Master”, cho @flexiprint vẽ rồi bấm Duyệt 1 bản. Sau đó ở đây lần lượt: 3a tách nền (sửa nền bằng tay) → 3b AI tô vùng clipart (mỗi phần tô / vẽ trên master) → 3c bộ custom (một nút: cắt clipart theo vùng đã tô, ráp thành sản phẩm hoàn chỉnh trong editor).</p>
          <CtButton className="mt-3" onClick={() => ctx.goto("master")}>
            Sang bước Master →
          </CtButton>
        </div>
      ) : (
        <>
          <MasterAndBlank {...ctx} />
          {sub === "matte" && <MatteSection {...ctx} onEdit={onEdit} />}
          {sub === "edits" && <EditsSection {...ctx} />}
          {sub === "custom" && <CustomSection {...ctx} onEdit={onEdit} ready={ready} missing={ready ? "" : `Cần đủ ảnh tô vùng ở bước 3b (${editsDone}/${plan.length}).`} />}
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
            AI tô vùng clipart ({done}/{plan.length})
          </h3>
          <p className="text-xs text-muted-foreground">
            Mỗi clipart cần 1 ảnh AI làm trên master đã duyệt: tô hồng đúng vùng của nó, hoặc vẽ kiểu / màu khác tại chỗ. Bước 3c cắt clipart theo đúng các vùng này. Danh sách tự sinh từ brief; @flexiprint viết prompt từng ảnh, tự xem và làm lại ảnh sai. Model xê dịch phần giữ nguyên một chút: lúc cắt layer, mỗi bản được đo và kéo về đúng chỗ (còn ≤ 0,3 px mới đạt, đỏ = làm lại).
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

/**
 * The approved master, the khuôn in and the phôi trơn side by side: the khuôn is the brief's (picked / uploaded), else
 * the one AI draws to fit the master once it is approved (server/char/khuon.ts); the phôi is the uploaded photo, else
 * the one AI draws from the khuôn (server/char/blank.ts) — the products get it for Xem trước and Mockups.
 */
function MasterAndBlank(ctx: CharCtx) {
  const { project, images, editable } = ctx;
  const [busy, setBusy] = useState(false);
  const master = images.find((im) => im.id === project.master_id) ?? null;
  const uploaded = project.brief.product.blankId ? images.find((im) => im.id === project.brief.product.blankId) : undefined;
  const ai = [...images].reverse().find((im) => im.kind === "blank" && im.role === "blank:ai");
  const aiKhuon = [...images].reverse().find((im) => im.kind === "blank" && im.role === "khuon:ai");
  // The khuôn's own phôi (Thư viện → Phôi) is reused before an AI one.
  const [template, setTemplate] = useState<CtPrintTemplate | null>(null);
  const templateId = project.brief.product.templateId ?? null;
  useEffect(() => {
    if (!templateId) return;
    printApi
      .list()
      .then((list) => setTemplate(list.find((t) => t.id === templateId) ?? null))
      .catch(() => setTemplate(null));
  }, [templateId]);
  const kept = templateId ? (template?.spec.blanks[0]?.url ?? null) : null;
  const blank = uploaded ?? ai ?? null;
  const canMake = !!templateId && !uploaded;
  const remakeKhuon = async () => {
    setBusy(true);
    try {
      ctx.addImages([await charApi.khuonAi(project.id)]);
    } catch (e) {
      ctx.error(e instanceof Error ? e.message : "Không tạo được khuôn");
    } finally {
      setBusy(false);
    }
  };
  const remake = async () => {
    setBusy(true);
    try {
      ctx.addImages([await charApi.blank(project.id)]);
    } catch (e) {
      ctx.error(e instanceof Error ? e.message : "Không tạo được phôi");
    } finally {
      setBusy(false);
    }
  };
  const tile = (label: string, url: string | null, body: React.ReactNode) => (
    <figure className="w-40 shrink-0">
      <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg border" style={CHECKER_STYLE}>
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element -- our R2 preview
          <img src={url} alt={label} className="h-full w-full object-contain" />
        ) : (
          body
        )}
      </div>
      <figcaption className="mt-1 text-[11px] text-muted-foreground">{label}</figcaption>
    </figure>
  );
  return (
    <section className="flex flex-wrap items-start gap-4 rounded-xl border bg-card p-4">
      {tile("Master (đã duyệt)", master ? master.thumb_url || master.url : null, <span className="text-[11px] text-muted-foreground">—</span>)}
      {tile(
        templateId && template ? `Khuôn in: ${template.name}` : "Khuôn in (AI theo master)",
        null,
        templateId && template ? (
          <PrintSheet spec={template.spec} className="h-full w-full" />
        ) : aiKhuon?.status === "running" ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : aiKhuon?.status === "failed" ? (
          <span className="p-2 text-center text-[11px] text-destructive">{aiKhuon.error || "Lỗi"}</span>
        ) : (
          <span className="p-2 text-center text-[11px] text-muted-foreground">Chưa có</span>
        ),
      )}
      {tile(
        uploaded ? "Phôi trơn (upload)" : kept ? "Phôi của khuôn (Thư viện → Phôi)" : "Phôi trơn (AI theo khuôn in)",
        uploaded?.status === "done" ? uploaded.thumb_url || uploaded.url : kept ?? (blank?.status === "done" ? blank.thumb_url || blank.url : null),
        blank?.status === "running" ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : blank?.status === "failed" ? (
          <span className="p-2 text-center text-[11px] text-destructive">{blank.error || "Lỗi"}</span>
        ) : (
          <span className="p-2 text-center text-[11px] text-muted-foreground">Chưa có</span>
        ),
      )}
      <div className="min-w-[220px] flex-1 space-y-2 text-xs text-muted-foreground">
        <p>
          Phôi trơn = sản phẩm chưa in, chụp thẳng. Sản phẩm tạo ở bước 4 dùng nó cho <b>Xem trước</b> và <b>Mockups</b> (artwork đặt lên phôi); Thiết kế và File in vẫn phẳng.
        </p>
        {editable && (!templateId || aiKhuon?.status === "done") && (
          <CtButton size="sm" disabled={busy || aiKhuon?.status === "running"} onClick={() => void remakeKhuon()}>
            {busy || aiKhuon?.status === "running" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} {aiKhuon ? "Vẽ lại khuôn AI" : "Tạo khuôn bằng AI"}
          </CtButton>
        )}
        {canMake && editable && (
          <CtButton size="sm" disabled={busy || blank?.status === "running"} onClick={() => void remake()}>
            {busy || blank?.status === "running" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} {ai ? "Vẽ lại phôi AI" : "Tạo phôi bằng AI"}
          </CtButton>
        )}
      </div>
    </section>
  );
}
