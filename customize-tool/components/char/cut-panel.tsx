"use client";

/**
 * Step 3 of a bộ nhân vật, reviewed on the master (server/char/cut.ts):
 *   Nền        the master without its backdrop — leftovers removed at points marked on it (MatteFix), approved
 *   Phác thảo  every layer's region highlighted on its picture — fixed by hand (MaskEditor), approved
 *   File cuối  the files cut from both, checked automatically (stacked = master?), looked over, approved, ZIP
 */

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Download, ExternalLink, Eye, Loader2, Pencil, RefreshCw, Scissors, Undo2, XCircle } from "lucide-react";
import type { CtCharLayerCheck, CtCharLayerFile, CtCharLayerSet, CtCharLayerSlot, CtCharPiece, CtCharPicture, CtCharPlan } from "../../types";
import { charApi } from "../../lib/api-client";
import { redoRoleOf } from "../../lib/char-plan";
import { CT_CONFIG } from "../../config";
import { zip } from "../../lib/zip";
import { CHECKER_STYLE, CtButton, FLOAT_BTN, cx } from "../ui";
import type { CharCtx } from "./char-project";
import { MaskEditor } from "./mask-editor";
import { MatteFix } from "./matte-fix";
import { LayerFiles, Thumb, backFile, colourGroups } from "./layer-files";

/** `picks`: the option shown per slot in the dress-up preview (LayerView) — the editor shows the clipart in that outfit. */
export type CutEdit = { kind: "matte" } | { kind: "piece"; key: string } | { kind: "file"; imageId: string; picks?: Record<string, number> } | null;

const PALETTE = ["#f97316", "#2563eb", "#16a34a", "#a855f7", "#eab308", "#ec4899", "#06b6d4", "#dc2626", "#84cc16", "#4f46e5"];

/** A colour per piece, distinct among the pieces of one picture (the body is grey, zones sky blue). */
export function pieceColour(plan: CtCharPlan, key: string): string {
  const pc = plan.pieces.find((x) => x.key === key);
  if (!pc || pc.kind === "body") return "#94a3b8";
  if (pc.kind === "zone") return "#38bdf8";
  const same = plan.pieces.filter((x) => x.kind === "part" && x.picture === pc.picture);
  return PALETTE[same.indexOf(pc) % PALETTE.length];
}

const maskStyle = (url: string): React.CSSProperties => ({
  WebkitMaskImage: `url(${url})`,
  maskImage: `url(${url})`,
  WebkitMaskSize: "100% 100%",
  maskSize: "100% 100%",
  WebkitMaskRepeat: "no-repeat",
  maskRepeat: "no-repeat",
});

function useAct(ctx: CharCtx) {
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    ctx.error(null);
    try {
      await fn();
    } catch (e) {
      ctx.error(e instanceof Error ? e.message : "Không làm được");
    } finally {
      setBusy(null);
    }
  };
  return { busy, act };
}

function Status({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <span className={cx("rounded px-1.5 py-0.5 text-[11px] font-medium", ok ? "bg-emerald-500/15 text-emerald-600" : "bg-muted text-muted-foreground")}>{children}</span>;
}

// ---- Nền ------------------------------------------------------------------------------------------------

export function MatteSection(ctx: CharCtx & { onEdit: (e: CutEdit) => void }) {
  const { project, editable } = ctx;
  const m = project.cut?.matte ?? null;
  const { busy, act } = useAct(ctx);
  const done = m?.status === "done" && !!m.alpha;
  const start = () =>
    act("start", async () => {
      if (m?.alpha?.edited && !window.confirm("Tách lại sẽ bỏ phần đã sửa tay. Vẫn tách lại?")) return;
      ctx.setProject(await charApi.cut(project.id, "matte"));
    });
  return (
    <section className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-start gap-3">
        <div className="flex-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            Master cỡ in {done && <Status ok>Xong</Status>}
          </h3>
          <p className="text-xs text-muted-foreground">
            Master do GPT Image 2.5 vẽ sẵn trên nền trong suốt — đó chính là phần tách nền, không qua dịch vụ tách nền nào. Bước này tự chạy khi duyệt master: phóng to ×2 để in (Real-ESRGAN). Chỉ khi thấy mảnh rời sót lại mới cần “Sửa nền”.
          </p>
        </div>
        {editable && (
          <div className="flex flex-wrap gap-2">
            {done && (
              <CtButton onClick={() => ctx.onEdit({ kind: "matte" })}>
                <Pencil className="h-4 w-4" /> Sửa nền
              </CtButton>
            )}
            <CtButton variant={done ? "outline" : "primary"} disabled={!!busy || m?.status === "running"} onClick={() => void start()}>
              {busy === "start" || m?.status === "running" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scissors className="h-4 w-4" />}
              {m?.status === "running" ? "Đang phóng to (~20 giây)…" : m ? "Làm lại" : "Phóng to để in"}
            </CtButton>
          </div>
        )}
      </div>
      {m?.status === "failed" && <p className="mb-2 rounded bg-destructive/10 p-2 text-xs text-destructive">{m.error}</p>}
      {done && m.alpha && (
        <div className="grid gap-4 md:grid-cols-2">
          <figure>
            <div className="relative w-full overflow-hidden rounded-lg border" style={{ aspectRatio: `${m.width} / ${m.height}`, ...CHECKER_STYLE }}>
              <div className="absolute inset-0 bg-cover" style={{ backgroundImage: `url(${m.previewUrl || m.colourUrl})`, backgroundSize: "100% 100%", ...maskStyle(m.alpha.url) }} />
            </div>
            <figcaption className="mt-1 text-[11px] text-muted-foreground">
              Đã tách nền · {m.width}×{m.height}px{m.alpha.edited ? " · đã sửa tay" : ""}
            </figcaption>
          </figure>
          <figure>
            <div className="relative w-full overflow-hidden rounded-lg border bg-white" style={{ aspectRatio: `${m.width} / ${m.height}` }}>
              {/* eslint-disable-next-line @next/next/no-img-element -- the master at print size */}
              <img src={m.previewUrl || m.colourUrl} alt="master" className="absolute inset-0 h-full w-full" />
              <div className="absolute inset-0 bg-red-500/60" style={{ ...maskStyle(m.alpha.url), WebkitMaskComposite: "xor", maskComposite: "exclude", WebkitMaskImage: `linear-gradient(#000,#000), url(${m.alpha.url})`, maskImage: `linear-gradient(#000,#000), url(${m.alpha.url})` }} />
            </div>
            <figcaption className="mt-1 text-[11px] text-muted-foreground">Ảnh gốc — phần tô đỏ là phần bị xoá (thành nền)</figcaption>
          </figure>
        </div>
      )}
      {!m && <p className="text-xs text-muted-foreground">Chưa có — bấm “Phóng to để in”.</p>}
    </section>
  );
}

function Checks({ checks, plan, onEdit, title }: { checks: CtCharLayerCheck[]; plan: CtCharPlan | null; onEdit: ((e: CutEdit) => void) | null; title: string }) {
  const bad = checks.filter((c) => !c.ok);
  return (
    <div className="rounded-lg border p-3 text-xs">
      <div className="mb-1.5 flex items-center gap-2 font-semibold">
        {bad.length ? <AlertTriangle className="h-4 w-4 text-amber-500" /> : <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
        {title}
      </div>
      <ul className="max-h-72 space-y-0.5 overflow-auto">
        {checks.map((c, i) => (
          <li key={i} className="flex items-start gap-1.5">
            {c.ok ? <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" /> : <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />}
            <span className="flex-1">{c.name}</span>
            <span className="text-muted-foreground">{c.detail}</span>
            {onEdit && c.piece && plan?.pieces.some((x) => x.key === c.piece) && (
              <button className="rounded border px-1 text-[10px] hover:bg-accent" onClick={() => onEdit({ kind: "piece", key: c.piece! })}>
                Sửa vùng
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- Bộ custom: phác thảo + cắt file trong một nút ------------------------------------------------------------

/** One button for the whole set: the plan (regions) then the files, then the dress-up view (FinalSection). */
export function CustomSection(ctx: CharCtx & { onEdit: (e: CutEdit) => void; ready: boolean; missing: string }) {
  const { project, editable } = ctx;
  const plan = project.cut?.plan ?? null;
  const { busy, act } = useAct(ctx);
  const planning = plan?.status === "running";
  const building = project.layers?.status === "building";
  const hasSet = !!project.layers;
  const canStart = ctx.ready;
  const edited = plan?.pieces.filter((x) => x.region.edited).length ?? 0;
  const start = () =>
    act("start", async () => {
      if (hasSet && !window.confirm(`Tạo lại bộ custom: tìm lại vùng rồi cắt lại toàn bộ file (vài phút).${edited ? ` ${edited} vùng đã sửa tay được giữ nếu ảnh của chúng không đổi.` : ""}${project.product_ids.length ? " Sản phẩm cũ của bộ (và thư mục clipart của nó) được thay bằng sản phẩm mới." : ""} Tiếp tục?`)) return;
      ctx.setProject(await charApi.cut(project.id, "plan", undefined, { auto: true }));
    });
  /** The plan is done but the files are not (the cut failed or could not start): cut again without planning again. */
  const cutOnly = !!plan && plan.status === "done" && (!project.layers || project.layers.status === "failed");
  const cutNow = () =>
    act("cut", async () => {
      await charApi.cut(project.id, "plan", "approve", { approved: true });
      ctx.setProject(await charApi.buildLayers(project.id));
    });
  return (
    <div className="space-y-4">
      <section className={cx("rounded-xl border bg-card p-4", !hasSet && "p-6")}>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1">
            <h3 className="text-sm font-semibold">Bộ custom</h3>
            <p className="text-xs text-muted-foreground">
              Một nút: mỗi clipart = đúng phần ảnh 3b của kiểu đó khác búp bê (không đoán, không tách bằng model), rồi ráp thành sản phẩm hoàn chỉnh — mở trong editor là dùng được ngay. Xong sẽ hiện: bên trái master xếp lớp, bên phải các kiểu của từng hạng mục — chưa ưng thì “Sửa clipart” (cọ, đũa thần, làm mịn…) hoặc làm lại ảnh, rồi cắt lại.
            </p>
          </div>
          {editable && cutOnly && (
            <CtButton variant="primary" disabled={!!busy || building} onClick={() => void cutNow()}>
              {busy === "cut" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scissors className="h-4 w-4" />}
              Cắt file (giữ phác thảo)
            </CtButton>
          )}
          {editable && (
            <CtButton variant={hasSet || cutOnly ? "outline" : "primary"} disabled={!!busy || planning || building || !canStart} title={!ctx.ready ? ctx.missing : ""} onClick={() => void start()}>
              {busy === "start" || planning || building ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scissors className="h-4 w-4" />}
              {planning ? "Đang phác thảo vùng…" : building ? "Đang cắt clipart + tạo sản phẩm…" : hasSet ? "Tạo lại bộ custom" : "Tạo bộ custom"}
            </CtButton>
          )}
          {project.product_ids[0] && project.layers?.status === "done" && (
            <Link href={`${CT_CONFIG.basePath}/${project.product_ids[0]}`} target="_blank" className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm hover:bg-accent">
              <ExternalLink className="h-4 w-4" /> Mở sản phẩm trong editor
            </Link>
          )}
        </div>
        {!ctx.ready && <p className="mt-2 text-xs text-muted-foreground">{ctx.missing}</p>}
        {plan?.status === "failed" && <p className="mt-2 rounded bg-destructive/10 p-2 text-xs text-destructive">{plan.error}</p>}
        {project.layers?.status === "done" && project.layers.error && <p className="mt-2 rounded bg-destructive/10 p-2 text-xs text-destructive">{project.layers.error}</p>}
        {plan?.status === "done" && plan.error && <p className="mt-2 rounded bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">{plan.error}</p>}
      </section>
      {hasSet && <FinalSection {...ctx} />}
    </div>
  );
}

// ---- File cuối ----------------------------------------------------------------------------------------------

export function FinalSection(ctx: CharCtx & { onEdit: (e: CutEdit) => void }) {
  const { project, editable } = ctx;
  const set = project.layers;
  const plan = project.cut?.plan ?? null;
  const { busy, act } = useAct(ctx);
  const [zipping, setZipping] = useState<string | null>(null);
  if (!set) return <section className="rounded-xl border bg-card p-4 text-xs text-muted-foreground">Chưa cắt file — bấm “Tạo bộ custom”.</section>;
  const total = set.slots.reduce((n, s) => n + s.files.length, 0);
  const stale = !!plan && plan.status === "done" && !plan.approved;
  /** Regions were fixed by hand after the last cut: approve the plan and cut again (products made from the old files get the new ones). */
  const cutAgain = () =>
    act("cut", async () => {
      if (project.product_ids.length && !window.confirm("Cắt lại sẽ thay toàn bộ clipart và làm lại sản phẩm của bộ (sản phẩm cũ bị thay). Tiếp tục?")) return;
      await charApi.cut(project.id, "plan", "approve", { approved: true });
      ctx.setProject(await charApi.buildLayers(project.id));
    });

  const download = async () => {
    setZipping("0");
    try {
      const entries: Array<{ name: string; data: Uint8Array }> = [];
      const safe = (v: string) => v.replace(/[^\p{L}\p{N}._ -]+/gu, "-").replace(/\s+/g, "_").slice(0, 60);
      let i = 0;
      for (const [si, s] of set.slots.entries())
        for (const f of s.files) {
          const res = await fetch(f.url);
          entries.push({ name: `${String(si + 1).padStart(2, "0")}_${safe(s.label)}/${safe([f.option, f.color].filter(Boolean).join("_") || "file")}.png`, data: new Uint8Array(await res.arrayBuffer()) });
          setZipping(String(++i));
        }
      const manifest = { name: project.name, width: set.width, height: set.height, order: "bottom → top", slots: set.slots.map((s) => ({ key: s.key, label: s.label, follows: s.follows, files: s.files.map((f) => ({ option: f.option, color: f.color })) })), zones: set.zones, checks: set.checks };
      entries.push({ name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
      const url = URL.createObjectURL(zip(entries));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safe(project.name)}-layers.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      ctx.error(e instanceof Error ? e.message : "Không tải được");
    } finally {
      setZipping(null);
    }
  };

  return (
    <section className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-start gap-3">
        <div className="flex-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            Bộ file cuối ({total} file) {set.status === "done" && <Status ok={!!set.approved}>{set.approved ? "Đã duyệt — final" : "Chờ duyệt"}</Status>}
          </h3>
          <p className="text-xs text-muted-foreground">
            Cắt tự động: mỗi file = vùng × ảnh của nó (nền trong suốt của AI). Kiểm tra tự động: các lớp ráp lại so với master (lỗ hổng / thừa được tô lên hình; khác màu là do AI vẽ lại các ảnh), mảnh rời trong từng file, độ khớp của từng ảnh. Xem từng kiểu ở cột phải, sửa vùng nếu cần (rồi “Cắt lại” — clipart và sản phẩm làm lại theo), hoặc tải ZIP gửi người làm tiếp. Sản phẩm của bộ đã sẵn trong editor.
          </p>
        </div>
        {set.status === "done" && (
          <div className="flex flex-wrap gap-2">
            {editable && stale && (
              <CtButton variant="primary" disabled={!!busy} onClick={() => void cutAgain()}>
                {busy === "cut" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scissors className="h-4 w-4" />}
                Cắt lại
              </CtButton>
            )}
            <CtButton disabled={!!zipping} onClick={() => void download()}>
              {zipping ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {zipping ? `Đang gom ${zipping}/${total}…` : "Tải ZIP"}
            </CtButton>
            {editable && (
              <CtButton variant={set.approved ? "outline" : "primary"} disabled={!!busy || stale} title={stale ? "Vùng đã sửa sau lần cắt này — cắt lại trước" : ""} onClick={() => act("approve", async () => ctx.setProject(await charApi.approveLayers(project.id, !set.approved)))}>
                {busy === "approve" ? <Loader2 className="h-4 w-4 animate-spin" /> : set.approved ? <Undo2 className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                {set.approved ? "Bỏ duyệt" : "Duyệt bộ file (final)"}
              </CtButton>
            )}
            {set.approved && (
              <CtButton variant="primary" onClick={() => ctx.goto("product")}>
                Sang bước Sản phẩm →
              </CtButton>
            )}
          </div>
        )}
      </div>
      {set.status === "building" && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Đang cắt file…
        </p>
      )}
      {set.status === "failed" && <p className="rounded bg-destructive/10 p-2 text-xs text-destructive">{set.error}</p>}
      {stale && set.status === "done" && <p className="mb-2 rounded bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">Vùng lớp đã sửa sau lần cắt này — bấm “Cắt lại” để file cập nhật.</p>}
      {set.status === "done" && set.slots.length > 0 && (
        <div className="space-y-6">
          <LayerView ctx={ctx} set={set} plan={plan} onEdit={editable ? ctx.onEdit : null} />
          <LayerFiles set={set} onFix={editable ? (f) => ctx.onEdit({ kind: "file", imageId: f.imageId }) : null} />
        </div>
      )}
    </section>
  );
}

/** Checks + a dress-up preview: pick an option per slot, the files stack on one canvas; the diff shows on top. */
function LayerView({ ctx, set, plan, onEdit }: { ctx: CharCtx; set: CtCharLayerSet; plan: CtCharPlan | null; onEdit: ((e: CutEdit) => void) | null }) {
  const [pick, setPick] = useState<Record<string, number>>({});
  const [focus, setFocus] = useState<string | null>(null);
  const [diff, setDiff] = useState(true);
  const focused = focus ? set.slots.find((s) => s.key === focus) : null;
  const ff = focused ? focused.files[Math.min(pick[focused.key] ?? 0, focused.files.length - 1)] : null;
  const redoRole = ff?.piece ? redoRoleOf(ctx.project.brief, ff.piece) : null;
  const files = (s: CtCharLayerSlot) => {
    const leader = s.follows ? set.slots.find((x) => x.key === s.follows) : null;
    return { list: s.files, index: Math.min(pick[leader?.key ?? s.key] ?? 0, s.files.length - 1) };
  };
  const defaults = Object.values(pick).every((v) => v === 0);
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_440px]">
      {/* The stack stays in view while the option list on the right scrolls (under the sticky page header). */}
      <div className="lg:sticky lg:top-16 lg:self-start">
        {/* Fits the screen whatever the canvas (a tall single figure was shown at 640 px wide: only the face). */}
        <div className="relative mx-auto max-w-[640px]" style={{ aspectRatio: `${set.width} / ${set.height}`, width: `min(100%, calc(62vh * ${set.width} / ${set.height}))`, ...CHECKER_STYLE }}>
          {set.slots.map((s) => {
            const { list, index } = files(s);
            const f = list[index];
            return f ? (
              // eslint-disable-next-line @next/next/no-img-element -- stacked layers of one canvas
              <img key={s.key} src={f.url} alt={s.label} className="absolute inset-0 h-full w-full" />
            ) : null;
          })}
          {set.zones.map((z) => (
            <svg key={z.id} className="absolute inset-0 h-full w-full" viewBox={`0 0 ${set.width} ${set.height}`}>
              <polygon points={z.polygon.map((p) => p.join(",")).join(" ")} fill="rgba(56,189,248,0.35)" stroke="#0ea5e9" strokeWidth={4} />
            </svg>
          ))}
          {diff && defaults && set.diffUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- where the stack differs from the master
            <img src={set.diffUrl} alt="diff" className="pointer-events-none absolute inset-0 h-full w-full" />
          )}
        </div>
        {set.diffUrl && (
          <label className="mx-auto mt-2 flex max-w-[640px] items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={diff} onChange={(e) => setDiff(e.target.checked)} />
            Tô chỗ lệch so với master (đỏ = lỗ hổng, xanh = thừa, vàng = khác màu){!defaults && " — chỉ hiện khi chọn kiểu mặc định"}
          </label>
        )}
      </div>
      <div className="space-y-4">
        <Checks checks={set.checks} plan={plan} onEdit={onEdit} title={`Kiểm tra tự động — ${set.width}×${set.height}px`} />
        {set.slots
          .filter((s) => !s.follows && s.files.length > 1)
          .map((s) => (
            <SlotOptions
              key={s.key}
              set={set}
              slot={s}
              onEdit={onEdit ? (f) => onEdit({ kind: "file", imageId: f.imageId, picks: pick }) : null}
              picked={pick[s.key] ?? 0}
              onPick={(i) => {
                setPick((p) => ({ ...p, [s.key]: i }));
                setFocus(s.key);
              }}
            />
          ))}
        {focused && ff && onEdit && (
          <div className="rounded-lg border border-dashed p-3 text-xs">
            <div className="mb-2 font-medium">
              Chưa ưng “{focused.label}
              {[ff.option, ff.color].filter(Boolean).length ? ` · ${[ff.option, ff.color].filter(Boolean).join(" · ")}` : ""}”?
            </div>
            <div className="flex flex-wrap gap-2">
              <CtButton onClick={() => onEdit({ kind: "file", imageId: ff.imageId, picks: pick })}>
                <Pencil className="h-4 w-4" /> Sửa clipart này
              </CtButton>
              {ff.piece && plan?.pieces.some((x) => x.key === ff.piece) && (
                <CtButton variant="outline" onClick={() => onEdit({ kind: "piece", key: ff.piece! })} title="Vùng gốc của cả lớp (mọi màu / kiểu cắt từ cùng ảnh) — cần Tạo lại bộ custom">
                  <Scissors className="h-4 w-4" /> Sửa vùng gốc (cả lớp)
                </CtButton>
              )}
              {redoRole && (
                <CtButton
                  onClick={async () => {
                    ctx.error(null);
                    try {
                      await charApi.edits(ctx.project.id, [redoRole]);
                      await ctx.reload();
                    } catch (e) {
                      ctx.error(e instanceof Error ? e.message : "Không chạy được");
                    }
                  }}
                >
                  <RefreshCw className="h-4 w-4" /> Vẽ lại ảnh này
                </CtButton>
              )}
            </div>
            {redoRole && <p className="mt-2 text-muted-foreground">Làm lại ảnh xong thì bấm “Tạo lại bộ custom” ở trên — vùng bạn đã sửa tay của các ảnh không đổi được giữ nguyên.</p>}
          </div>
        )}
      </div>
    </div>
  );
}

/** A slot's options as sets of one colour: a radio per colour, the set of that colour below it. A part made of a
 * back + a front layer (hair) shows each option by its BACK file — the whole part; its pencil edits the front. */
function SlotOptions({ set, slot, picked, onPick, onEdit }: { set: CtCharLayerSet; slot: CtCharLayerSlot; picked: number; onPick: (i: number) => void; onEdit: ((f: CtCharLayerFile) => void) | null }) {
  const back = set.slots.find((x) => x.follows === slot.key);
  const colours = colourGroups(slot.files);
  const current = slot.files[Math.min(picked, slot.files.length - 1)];
  const [colour, setColour] = useState(current?.color ?? colours[0] ?? "");
  const shown = slot.files.map((f, i) => ({ f, i })).filter(({ f }) => colours.length < 2 || f.color === colour);
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {back ? slot.label.replace(/\s+—\s+lớp trước$/i, "") : slot.label} ({colours.length > 1 ? `${shown.length} kiểu × ${colours.length} màu` : slot.files.length})
      </div>
      {colours.length > 1 && (
        <div role="radiogroup" aria-label={`Màu — ${slot.label}`} className="mb-1.5 flex flex-wrap gap-1">
          {colours.map((c) => (
            <button
              key={c}
              role="radio"
              aria-checked={c === colour}
              onClick={() => {
                setColour(c);
                // The same option in the new colour.
                const same = slot.files.findIndex((f) => f.color === c && f.option === current?.option);
                const first = slot.files.findIndex((f) => f.color === c);
                if (same >= 0 || first >= 0) onPick(same >= 0 ? same : first);
              }}
              className={cx("flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]", c === colour ? "border-orange-500 bg-orange-500/10" : "hover:bg-accent")}
            >
              <span className={cx("h-2.5 w-2.5 rounded-full border", c === colour ? "border-[3px] border-orange-500" : "border-muted-foreground")} />
              {c}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {shown.map(({ f, i }) => (
          <div key={f.imageId} className="group relative">
            <button
              title={[f.option, f.color].filter(Boolean).join(" · ")}
              onClick={() => onPick(i)}
              className={cx("block h-14 w-14 overflow-hidden rounded border bg-white", picked === i && "ring-2 ring-orange-500")}
            >
              <Thumb set={set} file={backFile(back, f)} />
            </button>
            {onEdit && (
              <button
                title="Sửa clipart này (xoá phần thừa / tô lại chỗ thiếu) — lưu là file, thumbnail và sản phẩm đổi ngay"
                onClick={() => onEdit(f)}
                className={cx("absolute -right-1.5 -top-1.5 p-1", FLOAT_BTN)}
              >
                <Pencil className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- the editor, opened from any section ------------------------------------------------------------------

export function CutEditor(ctx: CharCtx & { edit: CutEdit; onClose: () => void }) {
  const { project, edit } = ctx;
  const m = project.cut?.matte ?? null;
  const plan = project.cut?.plan ?? null;
  if (!edit || !m?.alpha) return null;
  if (edit.kind === "matte")
    return (
      <MatteFix
        width={m.width}
        height={m.height}
        colourUrl={m.colourUrl}
        alphaUrl={m.alpha.url}
        canRevert={m.alpha.history.length > 0}
        readOnly={!ctx.editable}
        onFix={async (points) => ctx.setProject(await charApi.cut(project.id, "matte", "fix", { points }))}
        onRevert={async () => ctx.setProject(await charApi.cut(project.id, "matte", "revert"))}
        onClose={ctx.onClose}
      />
    );
  if (edit.kind === "file") return <FileEditor {...ctx} imageId={edit.imageId} picks={edit.picks ?? {}} />;
  const pc = plan?.pieces.find((x) => x.key === edit.key);
  const pic = pc ? plan?.pictures.find((x) => x.id === pc.picture) : null;
  if (!plan || !pc || !pic) return null;
  const others = plan.pieces.filter((x) => x.picture === pc.picture && x.key !== pc.key && x.kind !== "body");
  return (
    <MaskEditor
      key={pc.key}
      title={`Sửa clipart: ${pc.label}`}
      hint={`Đang hiện đúng clipart này (cắt từ ảnh “${pic.label}”; bật “Ảnh mờ phía sau” để thấy chỗ thiếu). Bớt = xoá phần thừa, Thêm = tô lại chỗ AI cắt thiếu, Làm mịn = mép bớt sắc. “Tô màu vùng” để xem cả ảnh gốc. Lưu rồi Cắt lại.`}
      focusPiece
      tint={pieceColour(plan, pc.key)}
      width={plan.width}
      height={plan.height}
      colourUrl={pic.colourUrl}
      maskUrl={pc.region.url}
      subjectUrl={pic.id === "master" ? m.alpha.url : pic.alphaUrl}
      others={others.map((o) => ({ url: o.region.url, color: pieceColour(plan, o.key), label: o.label }))}
      canRevert={pc.region.history.length > 0}
      readOnly={!ctx.editable}
      onSave={async (png) => ctx.setProject(await charApi.cut(project.id, "plan", "region", { key: pc.key, mask: png }))}
      onRevert={async () => ctx.setProject(await charApi.cut(project.id, "plan", "revert", { key: pc.key }))}
      onClose={ctx.onClose}
    />
  );
}

/** One clipart file, edited by hand on the set's canvas (server/char/file-edit.ts): the clipart bright, the outfit
 * around it dark, a live preview of the outfit on the right and every clipart of the set on the left (one click opens
 * it — asked 2026-10-14). Saving replaces the file, its thumbnail and the products' copies at once. */
function FileEditor(ctx: CharCtx & { onClose: () => void; imageId: string; picks: Record<string, number> }) {
  const { project } = ctx;
  const set = project.layers;
  // Which clipart is open: by slot + option + colour (a save gives the file a new id).
  const [open, setOpen] = useState(() => {
    const sl = set?.slots.find((x) => x.files.some((f) => f.imageId === ctx.imageId));
    const f = sl?.files.find((x) => x.imageId === ctx.imageId);
    return { slot: sl?.key ?? "", option: f?.option ?? "", color: f?.color ?? "" };
  });
  const [picks, setPicks] = useState(ctx.picks);
  const slot = set?.slots.find((sl) => sl.key === open.slot);
  const file = slot?.files.find((f) => f.option === open.option && f.color === open.color);
  if (!set || !slot || !file) return null;
  // A part made of a back + a front layer (hair) is edited by its front alone: the back is the whole part, as drawn.
  const base = slot.key.replace(/:(back|front)$/, "");
  const main = base !== slot.key ? (set.slots.find((x) => x.key === `${base}:front`)?.files.find((x) => x.option === file.option && x.color === file.color) ?? file) : file;
  const mainSlot = set.slots.find((sl) => sl.files.includes(main))?.key ?? slot.key;
  const leadOf = (sl: CtCharLayerSlot) => sl.follows ?? sl.key;
  // The outfit around it, in the product's order: the picks (the dress-up preview's, then what was opened here), the
  // other half of the same clipart (its back) moving with it; `selfAt` = where the clipart itself lies in the stack.
  const shown = (sl: CtCharLayerSlot) => sl.files[Math.min(picks[leadOf(sl)] ?? 0, sl.files.length - 1)];
  const context: Array<{ url: string; moves: boolean }> = [];
  let selfAt = 0;
  for (const sl of set.slots) {
    if (sl.key === mainSlot) {
      selfAt = context.length;
      continue;
    }
    const half = base !== slot.key && (sl.key === `${base}:back` || sl.key === `${base}:front`) ? sl.files.find((x) => x.option === main.option && x.color === main.color) : null;
    const f = half ?? shown(sl);
    if (f) context.push({ url: f.url, moves: !!half });
  }
  const go = (sl: CtCharLayerSlot, f: CtCharLayerFile, i: number) => {
    setPicks((cur) => ({ ...cur, [leadOf(sl)]: i }));
    setOpen({ slot: sl.key, option: f.option, color: f.color });
  };
  return (
    <MaskEditor
      key={main.imageId}
      title={`Sửa clipart: ${slot.label.replace(/\s+—\s+lớp sau$/i, " — lớp trước")} — ${[file.option, file.color].filter(Boolean).join(" · ")}`}
      hint="Clipart đang sửa sáng, cả bộ đồ tối phía sau; khung bên phải = nhân vật như ở 3c, đổi ngay khi sửa. Bớt = xoá phần thừa, Thêm = tô lại chỗ thiếu (màu của chính file này), Làm mịn = mép bớt sắc, Di chuyển = kéo cả bộ clipart (trước + sau, mọi màu). Lưu là file, thumbnail và mọi sản phẩm đổi ngay."
      width={set.width}
      height={set.height}
      colourUrl={main.plateUrl ?? main.url}
      maskUrl={main.url}
      subjectUrl={null}
      canRevert={(main.history?.length ?? 0) > 0}
      readOnly={!ctx.editable}
      focusPiece
      context={context}
      selfAt={selfAt}
      movable
      sidebar={(leave) => (
        <div className="flex flex-col gap-2">
          <div className="text-[11px] font-medium text-muted-foreground">Tất cả clipart — bấm để mở</div>
          {set.slots
            .filter((sl) => !sl.follows)
            .map((sl) => (
              <div key={sl.key}>
                <div className="mb-0.5 truncate text-[10px] text-muted-foreground" title={sl.label}>
                  {sl.label.replace(/^Người \d+ — /, "").replace(/\s+—\s+lớp trước$/i, "")}
                </div>
                <div className="grid grid-cols-3 gap-1">
                  {sl.files.map((f, i) => {
                    const on = sl.key === mainSlot && f.option === main.option && f.color === main.color;
                    const back = set.slots.find((x) => x.follows === sl.key);
                    return (
                      <button
                        key={f.imageId}
                        title={[f.option, f.color].filter(Boolean).join(" · ")}
                        onClick={() => !on && leave(() => go(sl, f, i))}
                        className={cx("aspect-square overflow-hidden rounded border", on ? "ring-2 ring-orange-500" : "opacity-80 hover:opacity-100 hover:ring-1 hover:ring-orange-400")}
                        style={CHECKER_STYLE}
                      >
                        <Thumb set={set} file={backFile(back, f)} />
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
        </div>
      )}
      onSave={async (png, move) => ctx.setProject(await charApi.editFile(project.id, main.imageId, png, move))}
      onRevert={async () => ctx.setProject(await charApi.revertFile(project.id, main.imageId))}
      onClose={ctx.onClose}
    />
  );
}
