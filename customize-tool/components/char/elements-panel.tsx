"use client";

/**
 * Step 3 of a bộ ảnh khách (asked 2026-10-15) — the pieces around the customer's photo. The backgrounds first (a band
 * that follows each background is drawn in its colours), then every element option alone on transparency in the
 * master's look, and the photo zone's sample (the master's pet alone — shown until the customer uploads). A picture
 * that is off is drawn again, with its prompt changed if needed. "Tạo sản phẩm" puts it all on the product.
 */

import { useState } from "react";
import { ArrowRight, Loader2, RefreshCw, Sparkles } from "lucide-react";
import type { CtCharImage } from "../../types";
import { charApi } from "../../lib/api-client";
import { CHECKER_STYLE, CtButton, CtModal, CtTextarea, cx } from "../ui";
import type { CharCtx } from "./char-project";
import { BackdropSection } from "./blank-section";

interface Row {
  role: string;
  group: string;
  name: string;
  /** Recoloured from the element's first picture (not drawn). */
  recolor: boolean;
}

/** Every picture the brief needs, grouped by element (mirrors server/char/elements.ts elementPictures). */
function rowsOf(ctx: CharCtx): Row[] {
  const b = ctx.project.brief;
  const out: Row[] = [];
  for (const z of b.photoZones) out.push({ role: `sample:${z.id}`, group: `Ảnh mẫu — ${z.label}`, name: "Mẫu (hiện khi khách chưa upload)", recolor: false });
  for (const e of b.elements) {
    if (e.perBackdrop) for (const bd of b.backdrops) out.push({ role: `el:${e.id}:bd:${bd.id}`, group: e.name, name: bd.name, recolor: false });
    else e.options.forEach((o, i) => out.push({ role: `el:${e.id}:${o.id}`, group: e.name, name: o.name, recolor: e.mode === "color" && i > 0 }));
  }
  return out;
}

export function ElementsPanel(ctx: CharCtx) {
  const { project, images, editable } = ctx;
  const [busy, setBusy] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ role: string; prompt: string } | null>(null);
  const rows = rowsOf(ctx);
  const latest = (role: string): CtCharImage | null => [...images].reverse().find((im) => im.role === role) ?? null;
  const missing = rows.filter((r) => latest(r.role)?.status !== "done");
  const running = rows.some((r) => latest(r.role)?.status === "running");

  const draw = async (roles: string[], prompts: Record<string, string> = {}) => {
    setBusy(roles.join(",") || "all");
    ctx.error(null);
    try {
      ctx.addImages(await charApi.elements(project.id, roles, prompts));
    } catch (e) {
      ctx.error(e instanceof Error ? e.message : "Không vẽ được");
    } finally {
      setBusy(null);
    }
  };
  const makeProduct = async () => {
    setBusy("product");
    ctx.error(null);
    try {
      await charApi.remakeProduct(project.id);
      await ctx.reload();
      ctx.goto("product");
    } catch (e) {
      ctx.error(e instanceof Error ? e.message : "Không tạo được sản phẩm");
    } finally {
      setBusy(null);
    }
  };

  if (!project.master_id) return <p className="p-6 text-center text-sm text-muted-foreground">Duyệt master ở bước 2 trước — mọi phần tử được vẽ theo phong cách của nó.</p>;
  const groups = [...new Set(rows.map((r) => r.group))];
  return (
    <div className="space-y-6 p-6">
      <BackdropSection {...ctx} />
      <section className="space-y-4 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex-1">
            <h3 className="text-sm font-semibold">Phần tử trang trí</h3>
            <p className="text-xs text-muted-foreground">Mỗi ô là 1 lựa chọn của khách, AI vẽ riêng trên nền trong suốt theo master. Lựa chọn màu (Đổi màu) được đổi màu từ ảnh đầu, cùng hình. Dải theo nền cần vẽ nền trước.</p>
          </div>
          {editable && (
            <CtButton size="sm" disabled={!!busy || running || !missing.length} onClick={() => void draw([])}>
              {busy === "all" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} Vẽ {missing.length ? `${missing.length} ảnh còn thiếu` : "đủ rồi"}
            </CtButton>
          )}
          {editable && (
            <CtButton size="sm" variant="primary" disabled={!!busy || running || missing.length > 0} onClick={() => void makeProduct()}>
              {busy === "product" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />} {project.product_ids.length ? "Dựng lại sản phẩm" : "Tạo sản phẩm"}
            </CtButton>
          )}
        </div>
        {groups.map((g) => (
          <div key={g}>
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{g}</div>
            <div className="flex flex-wrap gap-3">
              {rows
                .filter((r) => r.group === g)
                .map((r) => {
                  const im = latest(r.role);
                  return (
                    <figure key={r.role} className="w-44 shrink-0">
                      <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg border" style={CHECKER_STYLE}>
                        {im?.status === "done" ? (
                          // eslint-disable-next-line @next/next/no-img-element -- our R2 preview
                          <img src={im.thumb_url || im.url} alt={r.name} className="h-full w-full object-contain" />
                        ) : im?.status === "running" ? (
                          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                        ) : (
                          <span className={cx("px-2 text-center text-[11px]", im?.status === "failed" ? "text-destructive" : "text-muted-foreground")}>{im?.status === "failed" ? im.error.slice(0, 120) : r.recolor ? "đổi màu từ ảnh đầu" : "chưa vẽ"}</span>
                        )}
                      </div>
                      <figcaption className="mt-1 flex items-center gap-1 text-xs">
                        <span className="flex-1 truncate" title={r.name}>
                          {r.name}
                          {r.recolor && <span className="text-muted-foreground"> · đổi màu</span>}
                        </span>
                        {editable && !r.recolor && (
                          <button type="button" title="Vẽ lại (sửa prompt)" className="rounded p-1 hover:bg-accent" disabled={!!busy || im?.status === "running"} onClick={() => setEdit({ role: r.role, prompt: im?.prompt ?? "" })}>
                            <RefreshCw className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </figcaption>
                    </figure>
                  );
                })}
            </div>
          </div>
        ))}
        {!rows.length && <p className="text-sm text-muted-foreground">Brief chưa có vùng ảnh khách / phần tử nào (bước 1).</p>}
      </section>
      <CtModal open={!!edit} onOpenChange={(o) => !o && setEdit(null)} title="Vẽ lại ảnh này" wide>
        {edit && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Prompt tiếng Anh gửi cho AI (để trống = prompt mặc định từ brief). Ảnh đổi màu đi theo ảnh này.</p>
            <CtTextarea rows={8} value={edit.prompt} onChange={(e) => setEdit({ ...edit, prompt: e.target.value })} />
            <div className="flex justify-end gap-2">
              <CtButton onClick={() => setEdit(null)}>Huỷ</CtButton>
              <CtButton
                variant="primary"
                onClick={() => {
                  const e = edit;
                  setEdit(null);
                  void draw([e.role], e.prompt.trim() ? { [e.role]: e.prompt.trim() } : {});
                }}
              >
                <Sparkles className="h-3.5 w-3.5" /> Vẽ lại
              </CtButton>
            </div>
          </div>
        )}
      </CtModal>
    </div>
  );
}
