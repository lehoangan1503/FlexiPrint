"use client";

/**
 * Step 2 — the master: @flexiprint writes the ONE master prompt from the brief, draws candidates, looks at them and
 * refines in place; refinements the editor asks for go through it too ("make the dog smaller"). The editor approves
 * one. Every layer is cut from the approved master, so nothing past this step is drawn from scratch again. Drawing
 * from a prompt typed by hand stays as a fallback (agent offline).
 */

import { useMemo, useState } from "react";
import { ArrowRight, Bot, CheckCircle2, Loader2, Pencil, RotateCcw, Sparkles, Wand2 } from "lucide-react";
import type { CtCharImage } from "../../types";
import { REF_USE_INFO, briefCombos, briefProblems, masterPrompt } from "../../lib/char-brief";
import { charApi } from "../../lib/api-client";
import { imageModelLabel } from "../../lib/image-models";
import { CHECKER_STYLE, CtButton, CtModal, CtSelect, CtTextarea, cx } from "../ui";
import type { CharCtx } from "./char-project";

export function MasterPanel(ctx: CharCtx) {
  const { project, images, editable } = ctx;
  const brief = project.brief;
  const assembled = useMemo(() => masterPrompt(brief), [brief]);
  const [custom, setCustom] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [request, setRequest] = useState("");
  const agentBusy = ctx.agent.busy;
  const drawing = ctx.agent.task?.input.char?.step === "master";
  const [count, setCount] = useState<"1" | "2" | "3" | "4">("2");
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState<CtCharImage | null>(null);
  const problems = briefProblems(brief);
  const masters = images.filter((im) => im.kind === "master");
  const numbers = new Map(masters.map((m, i) => [m.id, i + 1]));
  const approved = masters.find((m) => m.id === project.master_id) ?? null;
  const locked = !!project.master_id;

  const generate = async () => {
    setBusy(true);
    ctx.error(null);
    try {
      ctx.addImages(await charApi.masters(project.id, { prompt: custom ?? undefined, count: Number(count) }));
    } catch (e) {
      ctx.error(e instanceof Error ? e.message : "Không tạo được master");
    } finally {
      setBusy(false);
    }
  };

  const approve = async (id: string | null) => {
    try {
      ctx.setProject(await charApi.approve(project.id, id));
    } catch (e) {
      ctx.error(e instanceof Error ? e.message : "Không duyệt được");
    }
  };

  return (
    <div className="grid gap-6 p-6 xl:grid-cols-[440px_1fr]">
      <div className="space-y-4">
        {approved ? (
          <div className="rounded-xl border border-emerald-500/50 bg-emerald-500/10 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" /> Master #{numbers.get(approved.id)} đã duyệt
            </div>
            <p className="mt-1 text-xs text-muted-foreground">Mọi layer sẽ cắt từ đúng tấm này. Muốn đổi thì bỏ duyệt (chỉ được khi chưa cắt layer).</p>
            <div className="mt-3 flex gap-2">
              <CtButton size="sm" variant="primary" onClick={() => ctx.goto("layers")}>
                Sang bước Layer <ArrowRight className="h-3.5 w-3.5" />
              </CtButton>
              {editable && project.status === "master" && (
                <CtButton size="sm" onClick={() => void approve(null)}>
                  <RotateCcw className="h-3.5 w-3.5" /> Bỏ duyệt
                </CtButton>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3 rounded-xl border border-violet-500/30 bg-violet-500/5 p-4">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              <Bot className="h-4 w-4 text-violet-500" /> @flexiprint tạo master
            </h3>
            <p className="text-xs text-muted-foreground">Agent đọc brief, viết prompt master, tạo vài bản, tự xem và sửa tại chỗ rồi đề xuất bản tốt nhất. Bạn chỉ việc duyệt.</p>
            <CtTextarea rows={2} value={request} disabled={!editable || agentBusy} placeholder="Yêu cầu thêm (không bắt buộc) — VD: mẹ cao hơn chút, cún ngồi bên phải…" onChange={(e) => setRequest(e.target.value)} />
            {problems.length > 0 && (
              <ul className="list-disc space-y-0.5 rounded-md bg-amber-500/10 p-2 pl-6 text-xs text-amber-800 dark:text-amber-300">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            <CtButton
              variant="primary"
              className="w-full justify-center"
              disabled={!editable || agentBusy || !brief.subjects.length}
              onClick={() => void ctx.flush().then(() => ctx.agent.start("master", request.trim())).then(() => setRequest(""))}
            >
              {drawing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
              {drawing ? "@flexiprint đang làm…" : masters.length ? "Gửi @flexiprint tạo thêm" : "Gửi @flexiprint tạo master"}
            </CtButton>
            <p className="text-[11px] text-muted-foreground">{briefCombos(brief).toLocaleString("vi-VN")} tổ hợp khách có thể chọn.</p>
            <button className="text-[11px] text-muted-foreground underline" onClick={() => setManual((v) => !v)}>
              {manual ? "Ẩn" : "Tự viết prompt (không qua agent)"}
            </button>
          </div>
        )}
        {!approved && manual && (
          <div className="rounded-xl border bg-card p-4">
            <h3 className="text-sm font-semibold">Prompt master — tự viết</h3>
            <p className="mb-2 text-xs text-muted-foreground">
              Ghép tự động từ brief. Sửa brief là prompt đổi theo. {brief.refs.some((r) => REF_USE_INFO[r.use].take) ? "Có kèm ảnh tham khảo (phong cách / nhân vật / trang phục / dáng) — mỗi ảnh có câu dặn lấy phần nào." : ""}
            </p>
            {custom === null ? (
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2.5 text-xs leading-relaxed">{assembled}</pre>
            ) : (
              <CtTextarea rows={12} className="font-mono text-xs" value={custom} onChange={(e) => setCustom(e.target.value)} />
            )}
            <div className="mt-2 flex items-center gap-2">
              {custom === null ? (
                <CtButton size="sm" variant="ghost" disabled={!editable} onClick={() => setCustom(assembled)}>
                  <Pencil className="h-3.5 w-3.5" /> Sửa tay prompt
                </CtButton>
              ) : (
                <CtButton size="sm" variant="ghost" onClick={() => setCustom(null)}>
                  <RotateCcw className="h-3.5 w-3.5" /> Dùng lại prompt từ brief
                </CtButton>
              )}
              <span className="ml-auto text-xs text-muted-foreground">Số bản</span>
              <div className="w-16">
                <CtSelect<"1" | "2" | "3" | "4"> value={count} onChange={setCount} options={["1", "2", "3", "4"].map((v) => ({ value: v as "1" | "2" | "3" | "4", label: v }))} />
              </div>
            </div>
            <CtButton variant="primary" className="mt-3 w-full justify-center" disabled={!editable || busy || (!brief.subjects.length && !custom)} onClick={() => void generate()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Tạo {count} master
            </CtButton>
            <p className="mt-2 text-[11px] text-muted-foreground">Vẽ đúng prompt trên, không qua agent. Một bản mất ~30–60 giây.</p>
          </div>
        )}
        <div className="rounded-xl border bg-card p-4 text-xs text-muted-foreground">
          <div className="mb-1 font-semibold text-foreground">Duyệt master — kiểm tra:</div>
          <ul className="list-disc space-y-0.5 pl-4">
            <li>Đủ nhân vật, đúng thứ tự trái → phải, thấy trọn người, có khoảng trống quanh nhóm.</li>
            <li>Phần khách đổi được nhìn rõ, không bị người khác che (tóc, áo, giày…).</li>
            <li>Quần áo trơn một màu, không hoạ tiết / chữ (để đổi màu chính xác).</li>
            <li>Nền trắng phẳng, không bóng đổ, không cảnh.</li>
            <li>Vùng ảnh khách (nếu có) được vẽ trống, viền rõ.</li>
          </ul>
          <p className="mt-2">Chưa đúng ý: bấm “Sửa” trên tấm gần đúng nhất và viết cần sửa gì — @flexiprint viết prompt sửa tại chỗ, giữ nguyên phần còn lại.</p>
        </div>
      </div>

      <div>
        {masters.length === 0 ? (
          <div className="flex h-64 items-center justify-center rounded-xl border border-dashed text-sm text-muted-foreground">Chưa có master — bấm “Tạo master”.</div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-3">
            {[...masters].reverse().map((m) => (
              <MasterCard
                key={m.id}
                ctx={ctx}
                image={m}
                number={numbers.get(m.id) ?? 0}
                parentNumber={m.parent_id ? (numbers.get(m.parent_id) ?? null) : null}
                approved={m.id === project.master_id}
                locked={locked}
                onZoom={() => setZoom(m)}
                onApprove={() => void approve(m.id)}
              />
            ))}
          </div>
        )}
      </div>

      <CtModal open={!!zoom} onOpenChange={(o) => !o && setZoom(null)} title={zoom ? `Master #${numbers.get(zoom.id)} — ${zoom.width}×${zoom.height}px` : ""} wide>
        {zoom && (
          // eslint-disable-next-line @next/next/no-img-element -- the original, full size
          <img src={zoom.url} alt="master" className="mx-auto max-h-[78vh] w-auto object-contain" style={CHECKER_STYLE} />
        )}
      </CtModal>
    </div>
  );
}

function MasterCard(props: { ctx: CharCtx; image: CtCharImage; number: number; parentNumber: number | null; approved: boolean; locked: boolean; onZoom: () => void; onApprove: () => void }) {
  const { ctx, image: m, approved, locked } = props;
  const [note, setNote] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const busy = ctx.agent.busy;
  const refine = async () => {
    if (!note?.trim()) return;
    await ctx.agent.start("master", note.trim(), { imageId: m.id });
    setNote(null);
  };
  return (
    <div className={cx("overflow-hidden rounded-xl border bg-card", approved && "ring-2 ring-emerald-500")}>
      <button className="block aspect-[4/5] w-full bg-white" onClick={props.onZoom} disabled={m.status !== "done"}>
        {m.status === "done" ? (
          // eslint-disable-next-line @next/next/no-img-element -- our R2 WebP preview
          <img src={m.thumb_url || m.url} alt={`master ${props.number}`} className="h-full w-full object-contain" />
        ) : m.status === "running" ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" /> Đang vẽ…
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-4 text-xs text-destructive">{m.error || "Lỗi"}</div>
        )}
      </button>
      <div className="space-y-2 p-2.5">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-semibold">#{props.number}</span>
          {props.parentNumber && <span className="text-muted-foreground">sửa từ #{props.parentNumber}</span>}
          {m.model && <span className="text-muted-foreground">· {imageModelLabel(m.model)}</span>}
          {m.width && <span className="text-muted-foreground">· {m.width}×{m.height}</span>}
          {approved && <span className="ml-auto rounded bg-emerald-500 px-1.5 text-[10px] font-medium leading-4 text-white">Đã duyệt</span>}
        </div>
        {m.note && <p className="text-xs italic text-muted-foreground">“{m.note}”</p>}
        {m.prompt && (
          <button className="text-[11px] text-muted-foreground underline" onClick={() => setShowPrompt((v) => !v)}>
            {showPrompt ? "Ẩn prompt" : m.meta.taskId ? "Prompt của @flexiprint" : "Prompt"}
          </button>
        )}
        {showPrompt && <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[11px]">{m.prompt}</pre>}
        {m.status === "done" && !locked && ctx.editable && (
          <>
            {note === null ? (
              <div className="flex gap-2">
                <CtButton size="sm" disabled={busy} onClick={() => setNote("")}>
                  <Wand2 className="h-3.5 w-3.5" /> Sửa
                </CtButton>
                <CtButton size="sm" variant="primary" className="ml-auto" onClick={props.onApprove}>
                  <CheckCircle2 className="h-3.5 w-3.5" /> Duyệt master này
                </CtButton>
              </div>
            ) : (
              <div className="space-y-1.5">
                <CtTextarea rows={2} autoFocus value={note} placeholder="VD: cún nhỏ lại chút; áo mẹ tay ngắn hơn" onChange={(e) => setNote(e.target.value)} />
                <div className="flex gap-2">
                  <CtButton size="sm" variant="primary" disabled={busy || !note.trim()} onClick={() => void refine()}>
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bot className="h-3.5 w-3.5" />} Gửi @flexiprint sửa
                  </CtButton>
                  <CtButton size="sm" variant="ghost" onClick={() => setNote(null)}>
                    Huỷ
                  </CtButton>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
