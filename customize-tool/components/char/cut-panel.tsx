"use client";

/**
 * Step 3 of a bộ nhân vật, reviewed on the master (server/char/cut.ts):
 *   Nền        the master without its backdrop — leftovers removed at points marked on it (MatteFix), approved
 *   Phác thảo  every layer's region highlighted on its picture — fixed by hand (MaskEditor), approved
 *   File cuối  the files cut from both, checked automatically (stacked = master?), looked over, approved, ZIP
 */

import { useState } from "react";
import { AlertTriangle, Bot, CheckCircle2, Download, Eye, Loader2, Pencil, RefreshCw, Scissors, Undo2, XCircle } from "lucide-react";
import type { CtCharLayerCheck, CtCharLayerSet, CtCharLayerSlot, CtCharPiece, CtCharPicture, CtCharPlan } from "../../types";
import { charApi } from "../../lib/api-client";
import { zip } from "../../lib/zip";
import { CHECKER_STYLE, CtButton, cx } from "../ui";
import type { CharCtx } from "./char-project";
import { MaskEditor } from "./mask-editor";
import { MatteFix } from "./matte-fix";
import { LayerFiles, Thumb } from "./layer-files";

export type CutEdit = { kind: "matte" } | { kind: "piece"; key: string } | null;

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
            Tách nền master {done && <Status ok={!!m?.approved}>{m?.approved ? "Đã duyệt" : "Chờ duyệt"}</Status>}
          </h3>
          <p className="text-xs text-muted-foreground">
            Master được vẽ trên nền trắng. Bước này phóng to master ×2 để in (Real-ESRGAN) rồi tách nền theo màu giấy trắng (chạy trên máy, miễn phí, không gọi API trả phí): nền và khe giữa các sợi tóc được tìm từ chính điểm ảnh, model BiRefNet (miễn phí, chạy local) chỉ giúp phân xử các khe khó. Bạn xem, chỗ nào nền còn sót thì bấm Sửa nền và chấm vào đó để xoá, rồi duyệt — mọi file layer sau này dùng chung đường viền này.
          </p>
        </div>
        {editable && (
          <div className="flex flex-wrap gap-2">
            {done && (
              <CtButton onClick={() => ctx.onEdit({ kind: "matte" })}>
                <Pencil className="h-4 w-4" /> Sửa nền
              </CtButton>
            )}
            {done && (
              <CtButton
                variant={m?.approved ? "outline" : "primary"}
                disabled={!!busy}
                onClick={() => act("approve", async () => ctx.setProject(await charApi.cut(project.id, "matte", "approve", { approved: !m?.approved })))}
              >
                {busy === "approve" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                {m?.approved ? "Bỏ duyệt" : "Duyệt nền"}
              </CtButton>
            )}
            <CtButton variant={done ? "outline" : "primary"} disabled={!!busy || m?.status === "running"} onClick={() => void start()}>
              {busy === "start" || m?.status === "running" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scissors className="h-4 w-4" />}
              {m?.status === "running" ? "Đang tách nền (~1 phút)…" : m ? "Tách lại" : "Tách nền"}
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
      {!m && <p className="text-xs text-muted-foreground">Chưa tách nền. Trong lúc chờ, có thể cho @flexiprint tạo các bản sửa ở mục dưới.</p>}
    </section>
  );
}

// ---- Phác thảo lớp ----------------------------------------------------------------------------------------

export function PlanSection(ctx: CharCtx & { onEdit: (e: CutEdit) => void; ready: boolean; missing: string }) {
  const { project, editable } = ctx;
  const m = project.cut?.matte ?? null;
  const plan = project.cut?.plan ?? null;
  const { busy, act } = useAct(ctx);
  const [hover, setHover] = useState<string | null>(null);
  const done = plan?.status === "done";
  const canStart = !!m?.approved && ctx.ready;
  const edited = plan?.pieces.filter((x) => x.region.edited).length ?? 0;
  const start = () =>
    act("start", async () => {
      if (edited && !window.confirm(`Phác thảo lại sẽ bỏ ${edited} vùng đã sửa tay. Vẫn làm lại?`)) return;
      ctx.setProject(await charApi.cut(project.id, "plan"));
    });
  const cutNow = () =>
    act("cut", async () => {
      if (!plan?.approved) await charApi.cut(project.id, "plan", "approve", { approved: true });
      const edits = ctx.images.filter((im) => im.kind === "layer").length;
      if (edits && project.layers?.status === "done" && !window.confirm("Cắt lại sẽ thay toàn bộ file đang có (cả trong các sản phẩm đã tạo). Tiếp tục?")) {
        await ctx.reload();
        return;
      }
      ctx.setProject(await charApi.buildLayers(project.id));
    });

  const byPicture = new Map<string, CtCharPiece[]>();
  for (const pc of plan?.pieces ?? []) byPicture.set(pc.picture, [...(byPicture.get(pc.picture) ?? []), pc]);
  const bad = (plan?.checks ?? []).filter((c) => !c.ok);

  return (
    <section className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-start gap-3">
        <div className="flex-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            Phác thảo tách lớp {done && <Status ok={!!plan?.approved}>{plan?.approved ? "Đã duyệt" : "Chờ duyệt"}</Status>}
          </h3>
          <p className="text-xs text-muted-foreground">
            Mỗi lớp (tóc, áo, giày…) được tô 1 màu trên ảnh của nó: master, bản gốc bỏ phần đổi kiểu, và từng kiểu tóc / phụ kiện. Xem vùng đã đủ chưa — thiếu hay lấn sang lớp khác thì bấm “Sửa” để tô thêm / bớt. Vùng tô rộng ra ngoài cũng được: file chỉ lấy phần có nhân vật (nền đã tách ở trên).
          </p>
        </div>
        {editable && (
          <div className="flex flex-wrap gap-2">
            <CtButton variant={done ? "outline" : "primary"} disabled={!!busy || plan?.status === "running" || !canStart} onClick={() => void start()} title={!m?.approved ? "Duyệt nền trước" : !ctx.ready ? ctx.missing : ""}>
              {busy === "start" || plan?.status === "running" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {plan?.status === "running" ? "Đang phác thảo (2–5 phút)…" : plan ? "Phác thảo lại" : "Phác thảo tách lớp"}
            </CtButton>
            {done && (
              <CtButton variant="primary" disabled={!!busy || project.layers?.status === "building"} onClick={() => void cutNow()}>
                {busy === "cut" || project.layers?.status === "building" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scissors className="h-4 w-4" />}
                {project.layers?.status === "building" ? "Đang cắt file…" : plan?.approved ? "Cắt file" : "Duyệt & cắt file"}
              </CtButton>
            )}
          </div>
        )}
      </div>
      {!m?.approved && <p className="text-xs text-muted-foreground">Cần duyệt phần tách nền trước.</p>}
      {m?.approved && !ctx.ready && <p className="text-xs text-muted-foreground">{ctx.missing}</p>}
      {plan?.status === "failed" && <p className="mb-2 rounded bg-destructive/10 p-2 text-xs text-destructive">{plan.error}</p>}
      {done && plan && (
        <div className="space-y-4">
          {bad.length > 0 && <Checks checks={bad} plan={plan} onEdit={editable ? ctx.onEdit : null} title="Cần xem" />}
          <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {plan.pictures
              .filter((pic) => byPicture.has(pic.id))
              .map((pic) => (
                <PictureCard key={pic.id} plan={plan} pic={pic} pieces={byPicture.get(pic.id)!} matteAlpha={m?.alpha?.url ?? null} hover={hover} setHover={setHover} onEdit={editable ? ctx.onEdit : null} />
              ))}
          </div>
        </div>
      )}
    </section>
  );
}

function PictureCard({ plan, pic, pieces, hover, setHover, onEdit }: { plan: CtCharPlan; pic: CtCharPicture; pieces: CtCharPiece[]; matteAlpha: string | null; hover: string | null; setHover: (k: string | null) => void; onEdit: ((e: CutEdit) => void) | null }) {
  const [showBody, setShowBody] = useState(false);
  const shown = pieces.filter((pc) => pc.kind !== "body" || showBody || hover === pc.key);
  return (
    <div className="rounded-lg border p-2">
      <div className="mb-1.5 text-xs font-medium">{pic.label}</div>
      <div className="relative w-full overflow-hidden rounded border bg-white" style={{ aspectRatio: `${plan.width} / ${plan.height}` }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- preview of the picture */}
        <img src={pic.previewUrl || pic.colourUrl} alt={pic.label} className="absolute inset-0 h-full w-full" />
        {shown.map((pc) => (
          <div
            key={pc.key}
            className="absolute inset-0 transition-opacity"
            style={{ backgroundColor: pieceColour(plan, pc.key), opacity: hover ? (hover === pc.key ? 0.65 : 0.12) : pc.kind === "body" ? 0.25 : 0.5, ...maskStyle(pc.region.url) }}
          />
        ))}
      </div>
      <ul className="mt-2 space-y-0.5">
        {pieces.map((pc) => (
          <li key={pc.key} className="flex items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-accent" onMouseEnter={() => setHover(pc.key)} onMouseLeave={() => setHover(null)}>
            <span className="h-3 w-3 shrink-0 rounded-sm" style={{ backgroundColor: pieceColour(plan, pc.key) }} />
            <span className="flex-1 truncate">{pc.label}</span>
            {pc.region.edited && <span className="rounded bg-sky-500/15 px-1 text-[10px] text-sky-700 dark:text-sky-400">đã sửa</span>}
            {pc.kind === "body" && (
              <button className="rounded p-0.5 text-muted-foreground hover:text-foreground" title="Hiện vùng thân" onClick={() => setShowBody((v) => !v)}>
                <Eye className="h-3.5 w-3.5" />
              </button>
            )}
            {onEdit && (
              <button className="rounded border px-1.5 py-0.5 text-[11px] hover:bg-background" onClick={() => onEdit({ kind: "piece", key: pc.key })}>
                Sửa
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
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
  const m = project.cut?.matte ?? null;
  const plan = project.cut?.plan ?? null;
  const { busy, act } = useAct(ctx);
  const planning = plan?.status === "running";
  const building = project.layers?.status === "building";
  const hasSet = !!project.layers;
  const canStart = !!m?.approved && ctx.ready;
  const edited = plan?.pieces.filter((x) => x.region.edited).length ?? 0;
  const start = () =>
    act("start", async () => {
      if (hasSet && !window.confirm(`Tạo lại bộ custom: phác thảo lại vùng rồi cắt lại toàn bộ file (vài chục phút).${edited ? ` ${edited} vùng đã sửa tay được giữ nếu ảnh của chúng không đổi.` : ""}${project.product_ids.length ? " Sản phẩm đã tạo: file chỉ được thay khi bạn bấm “Cắt lại” sau đó." : ""} Tiếp tục?`)) return;
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
              Một nút: phác thảo vùng từng lớp trên ảnh của nó rồi cắt luôn bộ file. Xong sẽ hiện thẳng: bên trái master xếp lớp, bên phải các kiểu của từng hạng mục — bấm từng kiểu để xem, chưa ưng thì sửa vùng hoặc nhờ @flexiprint làm lại ảnh. Mất vài chục phút.
            </p>
          </div>
          {editable && cutOnly && (
            <CtButton variant="primary" disabled={!!busy || building} onClick={() => void cutNow()}>
              {busy === "cut" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scissors className="h-4 w-4" />}
              Cắt file (giữ phác thảo)
            </CtButton>
          )}
          {editable && (
            <CtButton variant={hasSet || cutOnly ? "outline" : "primary"} disabled={!!busy || planning || building || !canStart} title={!m?.approved ? "Duyệt nền (3a) trước" : !ctx.ready ? ctx.missing : ""} onClick={() => void start()}>
              {busy === "start" || planning || building ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scissors className="h-4 w-4" />}
              {planning ? "Đang phác thảo vùng…" : building ? "Đang cắt file…" : hasSet ? "Tạo lại bộ custom" : "Tạo bộ custom"}
            </CtButton>
          )}
        </div>
        {!m?.approved && <p className="mt-2 text-xs text-muted-foreground">Cần duyệt phần tách nền (3a) trước.</p>}
        {m?.approved && !ctx.ready && <p className="mt-2 text-xs text-muted-foreground">{ctx.missing}</p>}
        {plan?.status === "failed" && <p className="mt-2 rounded bg-destructive/10 p-2 text-xs text-destructive">{plan.error}</p>}
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
      if (project.product_ids.length && !window.confirm("Cắt lại sẽ thay toàn bộ file đang có (cả trong các sản phẩm đã tạo). Tiếp tục?")) return;
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
            Cắt tự động từ nền + vùng đã duyệt. Kiểm tra tự động: các lớp ráp lại có ra đúng master không (lỗ hổng / thừa / khác màu được tô lên hình), mảnh rời trong từng file, độ khớp của từng bản sửa. Xem từng kiểu ở cột phải, sửa vùng nếu cần (rồi “Cắt lại”), duyệt để chuyển bộ file cho bước Sản phẩm hoặc tải ZIP gửi người làm tiếp.
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
          <LayerFiles set={set} onFix={editable ? (piece) => ctx.onEdit({ kind: "piece", key: piece }) : null} />
        </div>
      )}
    </section>
  );
}

/** The edit that made the picture a piece is found on (so "make it again" targets it): shape option i ≥ 1 → its shape
 * edit, colour / texture part → the slot's mask edit; the first shape option is the master itself (nothing to redo). */
function redoRoleOf(ctx: CharCtx, pieceKey: string): string | null {
  const hash = pieceKey.lastIndexOf("#");
  const slotId = hash < 0 ? pieceKey : pieceKey.slice(0, hash);
  const slot = ctx.project.brief.subjects.flatMap((s) => s.slots).find((x) => x.id === slotId);
  if (!slot) return null;
  if (slot.mode !== "shape") return `mask:${slot.id}`;
  const opt = hash < 0 ? undefined : slot.options[Number(pieceKey.slice(hash + 1))];
  return opt && Number(pieceKey.slice(hash + 1)) > 0 ? `shape:${slot.id}:${opt.id}` : null;
}

/** Checks + a dress-up preview: pick an option per slot, the files stack on one canvas; the diff shows on top. */
function LayerView({ ctx, set, plan, onEdit }: { ctx: CharCtx; set: CtCharLayerSet; plan: CtCharPlan | null; onEdit: ((e: CutEdit) => void) | null }) {
  const [pick, setPick] = useState<Record<string, number>>({});
  const [focus, setFocus] = useState<string | null>(null);
  const [diff, setDiff] = useState(true);
  const focused = focus ? set.slots.find((s) => s.key === focus) : null;
  const ff = focused ? focused.files[Math.min(pick[focused.key] ?? 0, focused.files.length - 1)] : null;
  const redoRole = ff?.piece ? redoRoleOf(ctx, ff.piece) : null;
  const files = (s: CtCharLayerSlot) => {
    const leader = s.follows ? set.slots.find((x) => x.key === s.follows) : null;
    return { list: s.files, index: Math.min(pick[leader?.key ?? s.key] ?? 0, s.files.length - 1) };
  };
  const defaults = Object.values(pick).every((v) => v === 0);
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_440px]">
      <div>
        <div className="relative mx-auto w-full max-w-[640px]" style={{ aspectRatio: `${set.width} / ${set.height}`, ...CHECKER_STYLE }}>
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
            <div key={s.key}>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {s.label} ({s.files.length})
              </div>
              <div className="flex flex-wrap gap-1.5">
                {s.files.map((f, i) => (
                  <button
                    key={f.imageId}
                    title={[f.option, f.color].filter(Boolean).join(" · ")}
                    onClick={() => {
                      setPick((p) => ({ ...p, [s.key]: i }));
                      setFocus(s.key);
                    }}
                    className={cx("h-14 w-14 overflow-hidden rounded border bg-white", (pick[s.key] ?? 0) === i && "ring-2 ring-orange-500")}
                  >
                    <Thumb set={set} file={f} />
                  </button>
                ))}
              </div>
            </div>
          ))}
        {focused && ff && onEdit && (
          <div className="rounded-lg border border-dashed p-3 text-xs">
            <div className="mb-2 font-medium">
              Chưa ưng “{focused.label}
              {[ff.option, ff.color].filter(Boolean).length ? ` · ${[ff.option, ff.color].filter(Boolean).join(" · ")}` : ""}”?
            </div>
            <div className="flex flex-wrap gap-2">
              {ff.piece && plan?.pieces.some((x) => x.key === ff.piece) && (
                <CtButton onClick={() => onEdit({ kind: "piece", key: ff.piece! })}>
                  <Pencil className="h-4 w-4" /> Sửa vùng
                </CtButton>
              )}
              {redoRole && (
                <CtButton disabled={ctx.agent.busy} onClick={() => void ctx.agent.start("edits", "", { roles: [redoRole] })}>
                  <Bot className="h-4 w-4" /> Nhờ @flexiprint làm lại ảnh
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
  const pc = plan?.pieces.find((x) => x.key === edit.key);
  const pic = pc ? plan?.pictures.find((x) => x.id === pc.picture) : null;
  if (!plan || !pc || !pic) return null;
  const others = plan.pieces.filter((x) => x.picture === pc.picture && x.key !== pc.key && x.kind !== "body");
  return (
    <MaskEditor
      key={pc.key}
      title={`Sửa vùng: ${pc.label}`}
      hint={`Trên ảnh “${pic.label}”. Thêm = thuộc lớp này, Bớt = không thuộc. Tô rộng ra nền cũng được — file chỉ lấy phần có nhân vật.`}
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
