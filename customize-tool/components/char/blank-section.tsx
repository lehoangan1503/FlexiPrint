"use client";

/**
 * Step 4 — the khuôn in and the phôi trơn of the products. Nothing runs by itself (asked 2026-10-13): the khuôn is the
 * brief's (picked / uploaded) or one AI draws to fit the master when asked (server/char/khuon.ts); the phôi is the
 * uploaded photo, the khuôn's own, or one AI draws from the khuôn when asked (server/char/blank.ts) — the products get
 * it for Xem trước and Mockups.
 */

import { useEffect, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { CHECKER_STYLE, CtButton } from "../ui";
import { charApi } from "../../lib/api-client";
import { printApi } from "../../lib/print-api";
import type { CtPrintTemplate } from "../../types/print";
import { PrintSheet } from "../print/print-sheet";
import type { CtCharImage } from "../../types";
import type { CharCtx } from "./char-project";

/** A drawing still "running" after this long was cut off (a server restart): shown as stopped, the button works again. */
const STALE_MS = 10 * 60 * 1000;
const running = (im: CtCharImage | null | undefined): boolean => im?.status === "running" && Date.now() - Date.parse(im.created_at) < STALE_MS;
const stopped = (im: CtCharImage | null | undefined): boolean => im?.status === "running" && !running(im);

export function BlankSection(ctx: CharCtx) {
  const { project, images, editable } = ctx;
  const [busy, setBusy] = useState(false);
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
      {tile(
        templateId && template ? `Khuôn in: ${template.name}` : "Khuôn in (AI theo master)",
        null,
        templateId && template ? (
          <PrintSheet spec={template.spec} className="h-full w-full" />
        ) : running(aiKhuon) ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : aiKhuon?.status === "failed" || stopped(aiKhuon) ? (
          <span className="p-2 text-center text-[11px] text-destructive">{aiKhuon?.error || "Bị ngắt — vẽ lại"}</span>
        ) : (
          <span className="p-2 text-center text-[11px] text-muted-foreground">Chưa có</span>
        ),
      )}
      {tile(
        uploaded ? "Phôi trơn (upload)" : kept ? "Phôi của khuôn (Thư viện → Phôi)" : "Phôi trơn (AI theo khuôn in)",
        uploaded?.status === "done" ? uploaded.thumb_url || uploaded.url : kept ?? (blank?.status === "done" ? blank.thumb_url || blank.url : null),
        running(blank) ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : blank?.status === "failed" || stopped(blank) ? (
          <span className="p-2 text-center text-[11px] text-destructive">{blank?.error || "Bị ngắt — vẽ lại"}</span>
        ) : (
          <span className="p-2 text-center text-[11px] text-muted-foreground">Chưa có</span>
        ),
      )}
      <div className="min-w-[220px] flex-1 space-y-2 text-xs text-muted-foreground">
        <p>
          Khuôn in và phôi trơn (sản phẩm chưa in, chụp thẳng) chỉ cần khi làm sản phẩm: chọn khuôn ở tab 1 hoặc bấm tạo ở đây — không có gì tự chạy. Có phôi thì <b>Xem trước</b> và <b>Mockups</b> đặt artwork lên phôi; Thiết kế và File in vẫn phẳng.
        </p>
        {editable && (!templateId || aiKhuon?.status === "done" || stopped(aiKhuon)) && (
          <CtButton size="sm" disabled={busy || running(aiKhuon)} onClick={() => void remakeKhuon()}>
            {busy || running(aiKhuon) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} {aiKhuon ? "Vẽ lại khuôn AI" : "Tạo khuôn bằng AI"}
          </CtButton>
        )}
        {canMake && editable && (
          <CtButton size="sm" disabled={busy || running(blank)} onClick={() => void remake()}>
            {busy || running(blank) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} {ai ? "Vẽ lại phôi AI" : "Tạo phôi bằng AI"}
          </CtButton>
        )}
      </div>
    </section>
  );
}

/**
 * Step 4 — the backgrounds the customer picks (brief.backdrops, server/char/backdrops.ts): drawn by AI only when asked,
 * each redrawn on its own; the product gets them once it is built again ("Dựng lại sản phẩm").
 */
export function BackdropSection(ctx: CharCtx) {
  const { project, images, editable } = ctx;
  const [busy, setBusy] = useState<string | null>(null);
  const list = project.brief.backdrops;
  if (!list.length && !project.brief.texts.length) return null;
  const latest = (id: string) => [...images].reverse().find((im) => im.kind === "blank" && im.role === `backdrop:${id}`) ?? null;
  const draw = async (ids: string[]) => {
    setBusy(ids.join(",") || "all");
    ctx.error(null);
    try {
      ctx.addImages(await charApi.backdrops(project.id, ids));
    } catch (e) {
      ctx.error(e instanceof Error ? e.message : "Không vẽ được nền");
    } finally {
      setBusy(null);
    }
  };
  const remake = async () => {
    if (!window.confirm("Dựng lại sản phẩm của bộ với nền và chữ hiện tại? Sản phẩm cũ (và thư mục clipart của nó) được thay bằng sản phẩm mới.")) return;
    setBusy("product");
    ctx.error(null);
    try {
      await charApi.remakeProduct(project.id);
      await ctx.reload();
    } catch (e) {
      ctx.error(e instanceof Error ? e.message : "Không dựng lại được sản phẩm");
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1">
          <h3 className="text-sm font-semibold">Nền & chữ cho khách chọn</h3>
          <p className="text-xs text-muted-foreground">
            Nền (tab 1 → Nền) AI vẽ phủ cả mặt phôi, nằm sau nhân vật — mỗi nền là 1 option. Chữ: {project.brief.texts.map((t) => `${t.label} (${t.kind === "choice" ? `chọn 1 trong ${t.choices.length}` : "khách gõ"})`).join(" · ") || "không có"}. Đổi nền / chữ xong bấm Dựng lại sản phẩm.
          </p>
        </div>
        {editable && list.length > 0 && (
          <CtButton size="sm" disabled={!!busy || list.some((b) => running(latest(b.id)))} onClick={() => void draw([])}>
            {busy === "all" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} {list.some((b) => latest(b.id)) ? "Vẽ lại tất cả nền" : "AI vẽ nền"}
          </CtButton>
        )}
        {editable && (project.layers?.approved || (project.brief.kind === "photo" && project.product_ids.length > 0)) && (
          <CtButton size="sm" variant="primary" disabled={!!busy} onClick={() => void remake()}>
            {busy === "product" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} Dựng lại sản phẩm
          </CtButton>
        )}
      </div>
      {list.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {list.map((b) => {
            const im = latest(b.id);
            return (
              <figure key={b.id} className="w-40 shrink-0">
                <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg border" style={CHECKER_STYLE}>
                  {im?.status === "done" ? (
                    // eslint-disable-next-line @next/next/no-img-element -- our R2 preview
                    <img src={im.thumb_url || im.url} alt={b.name} className="h-full w-full object-cover" />
                  ) : running(im) ? (
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  ) : im?.status === "failed" || stopped(im) ? (
                    <span className="p-2 text-center text-[11px] text-destructive">{im?.error || "Bị ngắt — vẽ lại"}</span>
                  ) : (
                    <span className="p-2 text-center text-[11px] text-muted-foreground">Chưa vẽ</span>
                  )}
                </div>
                <figcaption className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                  <span className="flex-1 truncate" title={b.value}>
                    {b.name}
                  </span>
                  {editable && im && !running(im) && (
                    <button type="button" className="rounded px-1 hover:bg-accent" disabled={!!busy} onClick={() => void draw([b.id])} title="Vẽ lại nền này">
                      Vẽ lại
                    </button>
                  )}
                </figcaption>
              </figure>
            );
          })}
        </div>
      )}
    </section>
  );
}
