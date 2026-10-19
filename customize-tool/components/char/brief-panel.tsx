"use client";

/**
 * Step 1 — the brief. First a full-width brainstorm chat (@flexiprint proposes 3 directions, each a full brief with a
 * master drawn from it); taking one opens the brief itself — product, style, characters and what the customer may
 * change, photo zones, text, decor, mockups. Everything the later steps need comes from here; nothing else is asked.
 */

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Bot, ImagePlus, Loader2, MessagesSquare, Plus, Send, Trash2, X } from "lucide-react";
import type { CtCharBox, CtCharBrief, CtCharChooser, CtCharShownWhen, CtCharElement, CtCharElementPlace, CtCharIdea, CtCharImage, CtCharLineup, CtCharOption, CtCharPhotoTreat, CtCharSetKind, CtCharSlot, CtCharSlotMode, CtCharSubject, CtCharSubjectKind, CtCharTextField, CtCharTextPlace } from "../../types";
import { CHAR_ELEMENT_PLACE_LABEL, ELEMENT_PLACE_LABEL, PHOTO_TREAT_LABEL, briefCombos, newBackdrop, newCharOption, newCharSlot, newCharSubject, newElement, newPhotoZone, newTextField } from "../../lib/char-brief";
import { KIND_INFO, KindHelpButton } from "./kind-help";
import { useAiStyles } from "../editor/ai-styles-store";
import { aiStyleRef } from "../../lib/photo-styles";
import { CT_FONTS } from "../../config";
import { CT_MATERIALS } from "../../lib/materials";
import { charApi } from "../../lib/api-client";
import { CtButton, CtCheckbox, CtField, CtInput, CtModal, CtSelect, CtTextarea, cx } from "../ui";
import type { CharCtx } from "./char-project";
import { RefPictures } from "./ref-pictures";
import { StepGuide } from "./step-guide";
import type { CtPrintTemplate } from "../../types/print";
import { layoutHint } from "../../lib/print-template";
import { charVersions } from "../../lib/char-lineup";
import { printApi } from "../../lib/print-api";
import { PrintSheet } from "../print/print-sheet";

const MODES: Array<{ value: CtCharSlotMode; label: string }> = [
  { value: "color", label: "Đổi màu" },
  { value: "texture", label: "Đổi chất liệu" },
  { value: "shape", label: "Đổi kiểu (hình dạng)" },
];
const KINDS: Array<{ value: CtCharSubjectKind; label: string }> = [
  { value: "person", label: "Người" },
  { value: "pet", label: "Thú cưng" },
  { value: "object", label: "Vật / khác" },
];

export function BriefPanel(all: CharCtx) {
  // The edits, the plan and the layers hang on the brief's ids: with a master approved the brief is read-only
  // (the server refuses a changed brief too).
  // A bộ ảnh khách freezes only its look (style, references, khuôn): its photo zone and decorations stay editable.
  const photoSet = all.project.brief.kind === "photo";
  const locked = !!all.project.master_id && !photoSet;
  const ctx: CharCtx = locked ? { ...all, editable: false } : all;
  // Brainstorm first (a full-width chat); the brief opens once a direction is taken (or there is one already).
  const chosen = photoSet || ctx.project.brief.subjects.length > 0;
  const [view, setView] = useState<"chat" | "brief">(chosen ? "brief" : "chat");
  if (view === "chat") return <IdeaChat {...ctx} onTaken={() => setView("brief")} onBrief={chosen ? () => setView("brief") : null} />;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 border-b bg-muted/20 px-6 py-2.5">
        <CtButton size="sm" onClick={() => setView("chat")}>
          <MessagesSquare className="h-4 w-4" /> Brainstorm với @flexiprint
        </CtButton>
        <span className="text-xs text-muted-foreground">Brief của hướng đã chọn — sửa trực tiếp, hoặc quay lại brainstorm để @flexiprint đề xuất thêm.</span>
      </div>
      <div className="min-w-0 space-y-6 p-6">
        <StepGuide title="Bước 1 — mô tả chung về bộ clipart: bạn chỉ cần review">
          <p>@flexiprint đã viết sẵn mô tả từ ý tưởng, giữ nguyên cấu trúc. Bạn kiểm tra lại:</p>
          <ul className="list-disc space-y-0.5 pl-4">
            <li>
              <b>Các option khách chọn</b> — bấm <b>Xem trước</b> ở mục Custom option để hình dung như trang sản phẩm.
            </li>
            <li>
              <b>Chữ khách gõ (custom name)</b> và <b>nền (custom background)</b> — phần quan trọng nhất, khách nhìn thấy đầu tiên.
            </li>
            <li>Nền và cảnh mockup cũng là option của sản phẩm: AI vẽ ở bước 4, sửa được cả sau khi duyệt master.</li>
          </ul>
        </StepGuide>
        {locked && (
          <p className="rounded-md bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
            Master đã duyệt — brief bị khoá (chữ, nền, cảnh mockup vẫn sửa được). Muốn đổi phần khác: về bước Master, bỏ duyệt master (các ảnh để cắt clipart theo brief cũ sẽ không còn khớp).
          </p>
        )}
        <BriefForm {...ctx} productEditable={all.editable} />
      </div>
    </div>
  );
}

// ---- brainstorm chat ---------------------------------------------------------------------------------------

/**
 * The brainstorm as a chat (asked 2026-10-09): the editor writes, @flexiprint answers with 3 directions, each with a
 * master drawn from its own brief (server/char/projects.ts drawIdeaPreviews); "Dùng hướng này" fills the brief and
 * keeps that picture as a master candidate. The composer stays at the bottom: ask for more directions any time.
 */
function IdeaChat(ctx: CharCtx & { onTaken: () => void; onBrief: (() => void) | null }) {
  const { project, images, editable } = ctx;
  const brief = project.brief;
  const [request, setRequest] = useState("");
  const [taking, setTaking] = useState<string | null>(null);
  const [zoom, setZoom] = useState<CtCharImage | null>(null);
  const rounds = project.ideas;
  const busy = ctx.agent.busy;
  const thinking = ctx.agent.task?.input.char?.step === "brainstorm";
  const end = useRef<HTMLDivElement | null>(null);
  const first = rounds.length === 0;
  const text = first ? brief.idea : request;

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [rounds.length, thinking]);

  const ask = async () => {
    await ctx.flush();
    await ctx.agent.start("brainstorm", first ? "" : request.trim());
    setRequest("");
  };

  const preview = (ideaId: string) => images.find((im) => im.kind === "master" && im.role === `idea:${ideaId}`) ?? null;

  const take = async (idea: CtCharIdea) => {
    setTaking(idea.id);
    try {
      ctx.setBrief({ ...idea.brief, idea: brief.idea || idea.brief.idea, product: { ...idea.brief.product, blankId: brief.product.blankId }, refs: brief.refs });
      const im = preview(idea.id);
      if (im?.status === "done") {
        await charApi.adoptMaster(project.id, im.id);
        await ctx.reload();
      }
      ctx.onTaken();
    } catch (e) {
      ctx.error(e instanceof Error ? e.message : "Không dùng được hướng này");
    } finally {
      setTaking(null);
    }
  };

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] flex-col">
      <div className="mx-auto w-full max-w-6xl flex-1 space-y-5 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-start gap-3 rounded-xl border bg-card p-4">
          <Bot className="mt-0.5 h-5 w-5 text-violet-500" />
          <div className="min-w-0 flex-1 text-sm">
            <div className="font-semibold">Brainstorm với @flexiprint</div>
            <p className="text-xs text-muted-foreground">
              Kể ý tưởng (cho ai, dịp gì, sản phẩm gì, mấy người / thú, khách đổi được gì), thêm ảnh mẫu nếu có. @flexiprint đề xuất 3 hướng, mỗi hướng vẽ sẵn 1 master để bạn hình dung; chọn 1 hướng
              để mở brief, hoặc yêu cầu thêm hướng khác.
            </p>
          </div>
          {ctx.onBrief && (
            <CtButton size="sm" onClick={ctx.onBrief}>
              Mở brief <ArrowRight className="h-3.5 w-3.5" />
            </CtButton>
          )}
        </div>
        <KindPicker ctx={ctx} />
        <details className="rounded-xl border bg-card p-4" open={first}>
          <summary className="cursor-pointer text-sm font-medium">Ảnh mẫu / tham khảo ({brief.refs.length})</summary>
          <div className="mt-3">
            <RefPictures {...ctx} />
          </div>
        </details>

        {rounds.map((r, i) => (
          <div key={r.id} className="space-y-3">
            <div className="flex justify-end">
              <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-sky-600 px-4 py-2 text-sm text-white">{r.request || (i === 0 ? brief.idea : "Gợi ý thêm")}</div>
            </div>
            <div className="space-y-3 rounded-2xl rounded-bl-sm border bg-card p-4">
              {r.summary && <p className="whitespace-pre-wrap text-sm">{r.summary}</p>}
              {r.questions.length > 0 && (
                <div className="rounded-md bg-amber-500/10 p-2 text-xs">
                  <div className="mb-1 font-medium text-amber-700 dark:text-amber-400">Nên trả lời trước khi chọn (gõ ở ô dưới):</div>
                  <ul className="list-disc space-y-0.5 pl-4">
                    {r.questions.map((q) => (
                      <li key={q}>{q}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="grid gap-3 md:grid-cols-3">
                {r.ideas.map((idea) => {
                  const im = preview(idea.id);
                  return (
                    <div key={idea.id} className="flex flex-col overflow-hidden rounded-lg border">
                      <button className="block aspect-[4/5] w-full bg-white" disabled={im?.status !== "done"} onClick={() => im && setZoom(im)}>
                        {im?.status === "done" ? (
                          // eslint-disable-next-line @next/next/no-img-element -- our R2 preview
                          <img src={im.thumb_url || im.url} alt={idea.title} className="h-full w-full object-contain" />
                        ) : im?.status === "running" ? (
                          <span className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
                            <Loader2 className="h-5 w-5 animate-spin" /> Đang vẽ master xem trước…
                          </span>
                        ) : im?.status === "failed" ? (
                          <span className="flex h-full items-center justify-center p-3 text-center text-[11px] text-destructive">{im.error || "Không vẽ được"}</span>
                        ) : (
                          <span className="flex h-full items-center justify-center text-[11px] text-muted-foreground">Chưa có ảnh</span>
                        )}
                      </button>
                      <div className="flex flex-1 flex-col gap-1.5 p-3">
                        <div className="text-sm font-semibold">{idea.title}</div>
                        {idea.why && <p className="text-xs text-muted-foreground">{idea.why}</p>}
                        <p className="text-xs">
                          <span className="text-muted-foreground">Phong cách:</span> {idea.brief.style}
                        </p>
                        <ul className="space-y-0.5 text-xs">
                          {idea.brief.subjects.map((sub) => (
                            <li key={sub.id}>
                              • {sub.description}
                              {sub.slots.length > 0 && <span className="text-muted-foreground"> — {sub.slots.map((sl) => `${sl.part} (${sl.options.length}${sl.colors.length ? `×${sl.colors.length} màu` : ""})`).join(", ")}</span>}
                            </li>
                          ))}
                        </ul>
                        <div className="mt-auto flex items-center gap-2 pt-2">
                          <span className="text-[11px] text-muted-foreground">{briefCombos(idea.brief).toLocaleString("vi-VN")} tổ hợp</span>
                          <CtButton size="sm" variant="primary" className="ml-auto" disabled={!editable || taking !== null} onClick={() => void take(idea)}>
                            {taking === idea.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Dùng hướng này <ArrowRight className="h-3.5 w-3.5" />
                          </CtButton>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ))}
        {thinking && (
          <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm border bg-card p-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> @flexiprint đang nghĩ 3 hướng…
          </div>
        )}
        <div ref={end} />
      </div>

      <div className="sticky bottom-0 border-t bg-background/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-end gap-2 px-4 py-3 sm:px-6">
          <CtTextarea
            rows={first ? 3 : 2}
            className="flex-1"
            value={text}
            disabled={!editable}
            placeholder={first ? "VD: ornament tròn tặng 2 bạn thân, 2 bà nhảy múa nâng ly, khách đổi tóc, váy, đồ cầm, tên…" : "Yêu cầu thêm: thêm hướng màu nước; bỏ con mèo; trả lời câu hỏi…"}
            onChange={(e) => (first ? ctx.setBrief({ ...brief, idea: e.target.value }) : setRequest(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim() && !busy) void ask();
            }}
          />
          <CtButton variant="primary" disabled={!editable || busy || !text.trim()} onClick={() => void ask()}>
            {thinking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {first ? "Gợi ý 3 hướng" : "Gửi"}
          </CtButton>
        </div>
        {busy && !thinking && <p className="mx-auto max-w-6xl px-6 pb-2 text-[11px] text-muted-foreground">@flexiprint đang làm bước khác của bộ này — chờ xong.</p>}
      </div>

      <CtModal open={!!zoom} onOpenChange={(o) => !o && setZoom(null)} title={zoom?.note || "Master xem trước"} wide>
        {/* eslint-disable-next-line @next/next/no-img-element -- the original */}
        {zoom && <img src={zoom.url} alt="" className="mx-auto max-h-[75vh] w-auto object-contain" />}
      </CtModal>
    </div>
  );
}

// ---- khuôn in -----------------------------------------------------------------------------------------------

/**
 * The piece the set is made for (types/print.ts): picking one fills the product (cut, mm) and the layout sentence the
 * master prompt carries (its safe zone, a hanging hole to keep clear) — none of that is asked. The editor's own khuôn
 * can be uploaded as a picture (it becomes a khuôn of Thư viện → Khuôn in, its printed area read from it). None at
 * all: the AI draws one that fits the master once it is approved, then the phôi trơn (server/char/khuon.ts).
 */
function TemplatePick({ ctx, brief, onPick }: { ctx: CharCtx; brief: CtCharBrief; onPick: (p: CtCharBrief["product"]) => void }) {
  const [templates, setTemplates] = useState<CtPrintTemplate[]>([]);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const templateId = brief.product.templateId ?? null;
  useEffect(() => {
    printApi
      .list()
      .then(setTemplates)
      .catch(() => setTemplates([]));
    // A khuôn the AI made for this set shows up once it is linked.
  }, [templateId]);
  const p = brief.product;
  const NONE = "__none";
  const choose = (t: CtPrintTemplate) =>
    onPick({
      ...p,
      templateId: t.id,
      label: p.label || t.name,
      cut: t.kind === "cut" ? "alpha" : t.spec.outline || t.spec.faces.some((f) => f.maskUrl) ? "frame" : "rect",
      widthMm: t.spec.widthMm || p.widthMm,
      heightMm: t.spec.heightMm || p.heightMm,
      layout: layoutHint(t.kind, t.spec),
    });
  const pick = (id: string) => {
    const t = templates.find((x) => x.id === id);
    if (!t) return onPick({ ...p, templateId: null, layout: "", cut: "rect", widthMm: 0, heightMm: 0 });
    choose(t);
  };
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const t = await charApi.uploadKhuon(ctx.project.id, file);
      setTemplates((cur) => [...cur, t]);
      choose(t);
    } catch (e) {
      ctx.error(e instanceof Error ? e.message : "Upload khuôn thất bại");
    } finally {
      setBusy(false);
    }
  };
  const current = templates.find((t) => t.id === p.templateId) ?? null;
  return (
    <div className="space-y-2">
      <CtField label="Khuôn in" hint="Kích thước file in, đường cắt, safe zone — master tự bố cục trong safe zone. Chọn từ thư viện hoặc upload khuôn của xưởng. Không có → AI tạo khuôn khớp master khi duyệt master.">
        <CtSelect<string> value={p.templateId ?? NONE} options={[{ value: NONE, label: "— Chưa có (AI tạo theo master) —" }, ...templates.map((t) => ({ value: t.id, label: t.name }))]} onChange={pick} />
      </CtField>
      <CtField label="Vật liệu" hint="Chất liệu phôi của sản phẩm (sứ, acrylic…). Trống = theo kiểu cắt.">
        <CtSelect<string>
          value={p.material || NONE}
          options={[{ value: NONE, label: "— Theo kiểu cắt —" }, ...CT_MATERIALS.filter((m) => m.id !== "none").map((m) => ({ value: m.id, label: m.label }))]}
          onChange={(v) => onPick({ ...p, material: v === NONE ? "" : v })}
        />
      </CtField>
      <div className="flex items-start gap-2">
        {current && <PrintSheet spec={current.spec} className="h-36 w-36 rounded border" />}
        <button
          type="button"
          className="flex h-9 items-center gap-1 rounded-md border border-dashed px-2 text-xs text-muted-foreground hover:bg-accent"
          disabled={!ctx.editable || busy}
          onClick={() => input.current?.click()}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />} Upload khuôn
        </button>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void upload(f);
        }}
      />
    </div>
  );
}

// ---- the brief ---------------------------------------------------------------------------------------------

const PLACE_LABEL: Record<CtCharTextPlace, string> = { top: "Trên", bottom: "Dưới", left: "Trái", right: "Phải", under: "Dưới 1 nhân vật", free: "Tự đặt (ô)", on: "Trên 1 nhân vật (ô)" };

/** One personalised text: what the customer is asked, typed or picked from the list, font, colour, place. */
function TextFieldRow({ value: t, brief, readOnly, onChange, onRemove }: { value: CtCharTextField; brief: CtCharBrief; readOnly: boolean; onChange: (v: CtCharTextField) => void; onRemove: () => void }) {
  const subjects = brief.subjects;
  const patch = (p: Partial<CtCharTextField>) => onChange({ ...t, ...p });
  return (
    <div className="space-y-2 rounded-lg border p-2.5">
      <div className="grid grid-cols-[1fr_140px_90px_auto] gap-2">
        <CtInput value={t.label} disabled={readOnly} placeholder="Name on the left" onChange={(e) => patch({ label: e.target.value })} />
        <CtSelect<CtCharTextField["kind"]>
          value={t.kind}
          disabled={readOnly}
          options={[
            { value: "input", label: "Khách gõ" },
            { value: "choice", label: "Chọn từ list" },
            { value: "fixed", label: "Chữ cố định" },
          ]}
          onChange={(kind) => patch({ kind, choices: kind === "choice" ? (t.choices.length ? t.choices : [t.defaultText].filter(Boolean)) : [] })}
        />
        <CtSelect<CtCharTextPlace> value={t.place} disabled={readOnly} options={(Object.keys(PLACE_LABEL) as CtCharTextPlace[]).map((v) => ({ value: v, label: PLACE_LABEL[v] }))} onChange={(place) => patch({ place })} />
        <CtButton size="icon" variant="ghost" disabled={readOnly} onClick={onRemove}>
          <Trash2 className="h-4 w-4 text-destructive" />
        </CtButton>
      </div>
      {t.kind === "choice" ? (
        <CtTextarea
          rows={3}
          disabled={readOnly}
          value={t.choices.join("\n")}
          placeholder={"Best Friends Forever\nMerry Christmas Besties"}
          onChange={(e) => {
            const choices = e.target.value.split("\n").slice(0, 30);
            patch({ choices, defaultText: choices.find((c) => c.trim()) ?? "" });
          }}
        />
      ) : (
        <CtInput value={t.defaultText} disabled={readOnly} placeholder="Jessica" onChange={(e) => patch({ defaultText: e.target.value })} />
      )}
      {(t.place === "under" || t.place === "on") && (
        <CtSelect<string>
          value={t.subject ?? ""}
          disabled={readOnly}
          options={[{ value: "", label: "— chọn nhân vật —" }, ...subjects.map((sub, i) => ({ value: sub.id, label: `${i + 1}. ${sub.name || sub.description.split(/[,.;]/)[0]}` }))]}
          onChange={(subject) => patch({ subject: subject || null })}
        />
      )}
      {(t.place === "free" || t.place === "on") && <BoxInput label={t.place === "on" ? "Ô chữ (% ô của nhân vật)" : "Ô chữ (% vùng an toàn)"} value={t.box ?? null} disabled={readOnly} onChange={(box) => patch({ box })} />}
      <ShownWhenSelect brief={brief} value={t.shownWhen ?? null} onChange={(shownWhen) => patch({ shownWhen })} />
      <div className="grid grid-cols-[1fr_90px_80px] gap-2">
        <CtSelect<string> value={t.font} disabled={readOnly} options={CT_FONTS.map((f) => ({ value: f.family, label: f.label }))} onChange={(font) => patch({ font })} />
        <CtInput value={t.color} disabled={readOnly} placeholder="#1d1d1f" onChange={(e) => patch({ color: e.target.value })} />
        <CtInput type="number" value={String(t.maxChars)} disabled={readOnly} onChange={(e) => patch({ maxChars: Math.max(1, Math.min(60, Number(e.target.value) || 1)) })} />
      </div>
    </div>
  );
}

function Section({ title, hint, children, action }: { title: string; hint?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-start gap-2">
        <div className="flex-1">
          <h3 className="text-sm font-semibold">{title}</h3>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

type OptionView = "edit" | "preview";

/** `productEditable`: the texts, backgrounds, mockup scenes and material stay editable once the master is approved
 * (they are made in step 4 — nothing of the master, the edits or the cut hangs on them). */
function BriefForm({ productEditable, ...ctx }: CharCtx & { productEditable: boolean }) {
  const { project, editable } = ctx;
  const brief = project.brief;
  const [optionView, setOptionView] = useState<OptionView>("edit");
  const set = (patch: Partial<CtCharBrief>) => ctx.setBrief({ ...brief, ...patch });
  const setSubject = (i: number, sub: CtCharSubject) => set({ subjects: brief.subjects.map((s, j) => (j === i ? sub : s)) });
  const ro = !editable;
  const roProduct = !productEditable;
  const photoSet = brief.kind === "photo";

  return (
    <div className="space-y-6">
    <KindPicker ctx={ctx} />
    <fieldset disabled={ro} className="space-y-6">
      <Section
        title="Sản phẩm"
        hint="Tên, khuôn in và ảnh phôi trơn — chọn / upload nếu có. Thiếu khuôn → khi duyệt master AI tạo khuôn khớp master rồi phôi trơn theo khuôn; thiếu phôi → AI tạo phôi theo khuôn (thấy ở bước 3, dùng cho Xem trước & Mockups)."
      >
        <div className="grid gap-4 md:grid-cols-[1fr_1fr_220px]">
          <CtField label="Tên sản phẩm">
            <CtInput value={brief.product.label} placeholder="Round ceramic Christmas ornament" onChange={(e) => set({ product: { ...brief.product, label: e.target.value } })} />
          </CtField>
          <TemplatePick ctx={ctx} brief={brief} onPick={(product) => set({ product })} />
          <PictureSlot ctx={ctx} kind="blank" label="Ảnh phôi trơn (nếu có)" id={brief.product.blankId} onPick={(id) => set({ product: { ...brief.product, blankId: id } })} />
        </div>
      </Section>

      <Section title="Phong cách & bố cục" hint="Một câu phong cách (tiếng Anh cho AI). Ảnh tham khảo đặt ở cột ý tưởng bên trái.">
        <div className="grid gap-3">
          <div className="space-y-3">
            <CtField label="Phong cách">
              <CtTextarea rows={2} value={brief.style} placeholder="Cute stylized 3D-cartoon illustration, soft painterly shading, big friendly eyes" onChange={(e) => set({ style: e.target.value })} />
            </CtField>
            {!photoSet && (
              <CtField label="Bố cục / tư thế chung">
                <CtTextarea rows={2} value={brief.scene} placeholder="Sitting side by side on the floor, the dog in front of the girls" onChange={(e) => set({ scene: e.target.value })} />
              </CtField>
            )}
          </div>
        </div>
      </Section>
    </fieldset>

      {photoSet && <PhotoSetSections brief={brief} set={set} readOnly={ro} />}

      {/* Outside the read-only fieldset: the Nội dung / Xem trước switch works on a locked brief too. */}
      {!photoSet && (
      <Section
        title={`Custom option (${brief.subjects.length})`}
        hint="Mỗi mục là 1 thứ trong tranh (người, thú, vật…), thứ tự = từ trái sang phải. Phần khách đổi được ghi bên dưới, lựa chọn ĐẦU TIÊN = như trong master."
        action={
          <div className="flex flex-wrap items-center gap-1">
            <div className="mr-2 flex rounded-md border p-0.5 text-xs">
              {(
                [
                  ["edit", "Nội dung"],
                  ["preview", "Xem trước"],
                ] as Array<[OptionView, string]>
              ).map(([k, label]) => (
                <button key={k} type="button" onClick={() => setOptionView(k)} className={cx("rounded px-2.5 py-1 font-medium", optionView === k ? "bg-foreground text-background" : "hover:bg-accent")}>
                  {label}
                </button>
              ))}
            </div>
            {optionView === "edit" &&
              !ro &&
              KINDS.map((k) => (
                <CtButton key={k.value} size="sm" onClick={() => set({ subjects: [...brief.subjects, newCharSubject(k.value)] })}>
                  <Plus className="h-3.5 w-3.5" /> {k.label}
                </CtButton>
              ))}
          </div>
        }
      >
        {optionView === "preview" ? (
          <OptionsPreview ctx={ctx} />
        ) : (
        <fieldset disabled={ro} className="space-y-4">
          <LineupRow brief={brief} set={set} />
          <ChoosersRow brief={brief} set={set} />
          {brief.subjects.map((sub, i) => (
            <SubjectCard
              key={sub.id}
              brief={brief}
              index={i}
              subject={sub}
              onChange={(s) => setSubject(i, s)}
              onRemove={() => set({ subjects: brief.subjects.filter((_, j) => j !== i) })}
              onMove={(d) => {
                const list = [...brief.subjects];
                const j = i + d;
                if (j < 0 || j >= list.length) return;
                [list[i], list[j]] = [list[j], list[i]];
                set({ subjects: list });
              }}
            />
          ))}
          {!brief.subjects.length && <p className="text-sm text-muted-foreground">Chưa có — thêm tay, hoặc brainstorm với @flexiprint rồi chọn một hướng.</p>}
        </fieldset>
        )}
      </Section>
      )}

    {!photoSet && (
    <fieldset disabled={ro} className="space-y-6">
      <Section
        title="Ảnh khách tải lên"
        hint="Chỗ trong tranh khách tự đặt ảnh (khung ảnh cầm trên tay, mặt thú cưng…). AI vẽ chỗ đó trống, sau đó tô để lấy đúng vùng."
        action={
          <CtButton size="sm" onClick={() => set({ photoZones: [...brief.photoZones, newPhotoZone()] })}>
            <Plus className="h-3.5 w-3.5" /> Vùng ảnh
          </CtButton>
        }
      >
        <div className="space-y-2">
          {brief.photoZones.map((z, i) => (
            <div key={z.id} className="grid grid-cols-[1fr_200px_220px_auto] gap-2">
              <CtInput value={z.where} placeholder="a round photo frame she holds in both hands" onChange={(e) => set({ photoZones: brief.photoZones.map((x, j) => (j === i ? { ...x, where: e.target.value } : x)) })} />
              <CtInput value={z.label} placeholder="Upload your photo" onChange={(e) => set({ photoZones: brief.photoZones.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
              <CtSelect<CtCharPhotoTreat>
                value={z.treat === "face" ? "face" : "photo"}
                options={[
                  { value: "photo", label: "Ảnh nguyên (khung ảnh)" },
                  { value: "face", label: "Chỉ khuôn mặt (elf, ông già Noel…)" },
                ]}
                onChange={(treat) => set({ photoZones: brief.photoZones.map((x, j) => (j === i ? { ...x, treat } : x)) })}
              />
              <CtButton size="icon" variant="ghost" onClick={() => set({ photoZones: brief.photoZones.filter((_, j) => j !== i) })}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </CtButton>
            </div>
          ))}
          {!brief.photoZones.length && <p className="text-xs text-muted-foreground">Không có.</p>}
        </div>
      </Section>
    </fieldset>
    )}

    <fieldset disabled={roProduct} className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <Section
          title="Chữ cá nhân hoá"
          hint="Khách gõ (tên) hoặc chọn từ danh sách của shop (slogan). Vị trí quanh nhân vật; trên khuôn tròn chữ ở trên chạy theo vòng."
          action={
            !roProduct && (
              <span className="flex gap-1">
                <CtButton size="sm" variant="outline" onClick={() => set({ texts: [...brief.texts, newTextField("left")] })}>
                  <Plus className="h-3.5 w-3.5" /> Khách gõ
                </CtButton>
                <CtButton size="sm" variant="outline" onClick={() => set({ texts: [...brief.texts, newTextField("top", "choice")] })}>
                  <Plus className="h-3.5 w-3.5" /> Chọn từ list
                </CtButton>
              </span>
            )
          }
        >
          <div className="space-y-3">
            {brief.texts.map((t, i) => (
              <TextFieldRow key={t.id} value={t} brief={brief} readOnly={roProduct} onChange={(v) => set({ texts: brief.texts.map((x, j) => (j === i ? v : x)) })} onRemove={() => set({ texts: brief.texts.filter((_, j) => j !== i) })} />
            ))}
            {!brief.texts.length && <p className="text-xs text-muted-foreground">Không có chữ.</p>}
          </div>
        </Section>
        <Section
          title="Nền & mockup"
          hint="Mỗi nền là 1 option khách chọn, AI vẽ ở bước 4 (phủ cả mặt phôi, sau nhân vật). Không bao giờ vẽ vào master."
          action={
            !roProduct && (
              <CtButton size="sm" variant="outline" onClick={() => set({ backdrops: [...brief.backdrops, newBackdrop()] })}>
                <Plus className="h-3.5 w-3.5" /> Nền
              </CtButton>
            )
          }
        >
          <div className="space-y-2">
            {brief.backdrops.map((b, i) => (
              <div key={b.id} className="grid grid-cols-[140px_1fr_auto] gap-2">
                <CtInput value={b.name} disabled={roProduct} placeholder="Snowflakes" onChange={(e) => set({ backdrops: brief.backdrops.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                <CtInput value={b.value} disabled={roProduct} placeholder="cream background with small gold snowflakes scattered" onChange={(e) => set({ backdrops: brief.backdrops.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
                <CtButton size="icon" variant="ghost" disabled={roProduct} onClick={() => set({ backdrops: brief.backdrops.filter((_, j) => j !== i) })}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </CtButton>
              </div>
            ))}
            {!brief.backdrops.length && <p className="text-xs text-muted-foreground">Không có nền (màu phôi).</p>}
            {brief.backdrops.length > 0 && (
              <CtCheckbox
                checked={brief.backdrops.every((b) => b.tile)}
                onChange={(tile) => set({ backdrops: brief.backdrops.map((b) => ({ ...b, tile })) })}
                label="Nền là hoạ tiết lặp (caro, chấm bi…)"
                hint="AI vẽ 1 ô hoạ tiết, sản phẩm lặp ô đó (lật gương nên không thấy đường nối) — nét trên phôi to như thảm 120 cm."
              />
            )}
          </div>
          <div className="mt-3">
            <CtField label="Cảnh mockup (mỗi dòng 1 cảnh)">
              <CtTextarea rows={3} value={brief.mockups.join("\n")} placeholder={"on a marble vanity with makeup brushes\nflat lay with flowers and a mirror"} onChange={(e) => set({ mockups: e.target.value.split("\n").slice(0, 6) })} />
            </CtField>
          </div>
        </Section>
      </div>
      {!photoSet && <CharElementsSection brief={brief} set={set} readOnly={roProduct} />}
    </fieldset>

      <div className="flex justify-end">
        <CtButton variant="primary" disabled={photoSet ? !brief.photoZones.length : !brief.subjects.length} onClick={() => ctx.goto("master")}>
          Sang bước 2 · Ảnh master <ArrowRight className="h-4 w-4" />
        </CtButton>
      </div>
    </div>
  );
}

/**
 * A bộ ảnh khách's own sections (asked 2026-10-15): the customer's photo (how it is shown — AI styles the customer
 * picks, the head only, or as uploaded) and the decorations around it, each with its options.
 */
function PhotoSetSections({ brief, set, readOnly }: { brief: CtCharBrief; set: (patch: Partial<CtCharBrief>) => void; readOnly: boolean }) {
  const ai = useAiStyles();
  const zone = brief.photoZones[0];
  const setZone = (patch: Partial<NonNullable<typeof zone>>) => set({ photoZones: [{ ...(zone ?? newPhotoZone("the customer's pet, sitting", "Upload your pet's photo", "ai")), ...patch }, ...brief.photoZones.slice(1)] });
  const setElement = (i: number, e: CtCharElement) => set({ elements: brief.elements.map((x, j) => (j === i ? e : x)) });
  const styles = zone?.styles ?? [];
  return (
    <fieldset disabled={readOnly} className="space-y-6">
      <Section title="Ảnh khách tải lên" hint="Nhân vật chính là ảnh của khách. Master vẽ một mẫu (thú cưng mẫu) đúng phong cách; khách upload thì ảnh của họ thay vào.">
        {!zone ? (
          <CtButton size="sm" onClick={() => setZone({})}>
            <Plus className="h-3.5 w-3.5" /> Thêm vùng ảnh khách
          </CtButton>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-2 md:grid-cols-[1fr_220px_260px]">
              <CtField label="Ảnh khách là gì (tiếng Anh cho AI)">
                <CtInput value={zone.where} placeholder="the customer's pet, sitting" onChange={(e) => setZone({ where: e.target.value })} />
              </CtField>
              <CtField label="Khách thấy">
                <CtInput value={zone.label} placeholder="Upload your pet's photo" onChange={(e) => setZone({ label: e.target.value })} />
              </CtField>
              <CtField label="Ảnh được xử lý">
                <CtSelect<CtCharPhotoTreat> value={zone.treat ?? "photo"} options={(Object.keys(PHOTO_TREAT_LABEL) as CtCharPhotoTreat[]).map((value) => ({ value, label: PHOTO_TREAT_LABEL[value] }))} onChange={(treat) => setZone({ treat })} />
              </CtField>
            </div>
            {zone.treat === "ai" && (
              <div>
                <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Style khách chọn (style đầu = mặc định) — thư viện style AI chung</div>
                <div className="flex flex-wrap gap-2">
                  {ai.styles.map((st) => {
                    const ref = aiStyleRef(st.id);
                    const on = styles.includes(ref);
                    const demo = st.params.demoUrl;
                    return (
                      <button
                        key={st.id}
                        type="button"
                        onClick={() => setZone({ styles: on ? styles.filter((x) => x !== ref) : [...styles, ref] })}
                        className={cx("flex w-28 flex-col items-center gap-1 rounded-lg border p-1.5 text-[11px]", on ? "border-sky-500 bg-sky-500/10" : "hover:bg-accent")}
                      >
                        {demo ? <img src={demo} alt="" className="h-20 w-full rounded object-contain" /> : <span className="flex h-20 w-full items-center justify-center rounded bg-muted text-muted-foreground">chưa có demo</span>}
                        <span className="line-clamp-2 text-center">{on ? `${styles.indexOf(ref) + 1}. ` : ""}{st.name}</span>
                      </button>
                    );
                  })}
                  {!ai.styles.length && <p className="text-xs text-muted-foreground">{ai.loading ? "Đang tải…" : "Chưa có style AI nào (Editor → vùng ảnh → tab AI)."}</p>}
                </div>
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">Vị trí và hình dạng vùng ảnh sửa trực tiếp trong editor sản phẩm (kéo khung) — dựng lại sản phẩm vẫn giữ chỉnh tay đó.</p>
          </div>
        )}
      </Section>
      <Section
        title={`Phần tử trang trí (${brief.elements.length})`}
        hint="Mỗi phần tử là 1 lớp khách chọn (cánh, vòng sáng…). Mỗi lựa chọn AI vẽ riêng, nguyên vẹn, nền trong suốt, theo phong cách master. Dải dưới (mây) che phần thân ảnh khách bị cắt và nằm dưới chữ."
        action={
          !readOnly && (
            <span className="flex flex-wrap gap-1">
              {(Object.keys(ELEMENT_PLACE_LABEL) as CtCharElementPlace[]).map((place) => (
                <CtButton key={place} size="sm" variant="outline" onClick={() => set({ elements: [...brief.elements, newElement("", place)] })}>
                  <Plus className="h-3.5 w-3.5" /> {ELEMENT_PLACE_LABEL[place].split(" (")[0]}
                </CtButton>
              ))}
            </span>
          )
        }
      >
        <div className="space-y-3">
          {brief.elements.map((e, i) => (
            <div key={e.id} className="rounded-md bg-muted/40 p-2.5">
              <div className="grid grid-cols-[1fr_230px_170px_auto] items-center gap-2">
                <CtInput value={e.name} placeholder="Wings / Halo / Clouds" onChange={(ev) => setElement(i, { ...e, name: ev.target.value })} />
                <CtSelect<CtCharElementPlace> value={e.place} options={(Object.keys(ELEMENT_PLACE_LABEL) as CtCharElementPlace[]).map((value) => ({ value, label: ELEMENT_PLACE_LABEL[value] }))} onChange={(place) => setElement(i, { ...e, place })} />
                <CtSelect<"shape" | "color">
                  value={e.mode}
                  options={[
                    { value: "shape", label: "Đổi kiểu" },
                    { value: "color", label: "Đổi màu" },
                  ]}
                  onChange={(mode) => setElement(i, { ...e, mode, perBackdrop: mode === "color" ? false : e.perBackdrop, options: e.options.map((o) => (mode === "color" && !/^#/.test(o.value) ? { ...o, value: "#d4af37" } : o)) })}
                />
                <CtButton size="icon" variant="ghost" onClick={() => set({ elements: brief.elements.filter((_, j) => j !== i) })} title="Xoá phần tử">
                  <Trash2 className="h-4 w-4 text-destructive" />
                </CtButton>
              </div>
              {e.mode === "shape" && (
                <div className="mt-2">
                  <CtCheckbox checked={e.perBackdrop} onChange={(perBackdrop) => setElement(i, { ...e, perBackdrop })} label="Mỗi nền 1 bản, theo màu của nền (đi theo nền khách chọn)" hint="Dải mây hợp màu với từng nền. Khi bật, chỉ cần 1 mô tả." />
                </div>
              )}
              <OptionList mode={e.mode} label={e.perBackdrop ? "Mô tả (1 dòng cho mọi nền)" : e.mode === "color" ? "Màu" : "Kiểu"} options={e.perBackdrop ? e.options.slice(0, 1) : e.options} onChange={(options) => setElement(i, { ...e, options: e.perBackdrop ? options.slice(0, 1) : options })} />
            </div>
          ))}
          {!brief.elements.length && <p className="text-xs text-muted-foreground">Chưa có — ví dụ: Wings (sau ảnh, 3 kiểu), Halo (trên đầu, 2 màu), Clouds (dải dưới, theo nền).</p>}
        </div>
      </Section>
    </fieldset>
  );
}

function SubjectCard({ brief, index, subject, onChange, onRemove, onMove }: { brief: CtCharBrief; index: number; subject: CtCharSubject; onChange: (s: CtCharSubject) => void; onRemove: () => void; onMove: (d: number) => void }) {
  const setSlot = (i: number, slot: CtCharSlot) => onChange({ ...subject, slots: subject.slots.map((s, j) => (j === i ? slot : s)) });
  return (
    <div className="rounded-lg border p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">{index + 1}</span>
        <div className="w-32">
          <CtSelect<CtCharSubjectKind> value={subject.kind} options={KINDS} onChange={(kind) => onChange({ ...subject, kind })} />
        </div>
        <span className="text-xs text-muted-foreground">từ trái sang</span>
        <CtInput className="h-8 w-40" value={subject.name ?? ""} placeholder="Tên khách thấy (Boy…)" onChange={(e) => onChange({ ...subject, name: e.target.value })} />
        {brief.lineup && <CtCheckbox checked={subject.always === true} onChange={(always) => onChange({ ...subject, always })} label="Luôn có mặt" />}
        <div className="ml-auto flex gap-1">
          <CtButton size="sm" variant="ghost" onClick={() => onMove(-1)} title="Sang trái">
            ←
          </CtButton>
          <CtButton size="sm" variant="ghost" onClick={() => onMove(1)} title="Sang phải">
            →
          </CtButton>
          <CtButton size="icon" variant="ghost" onClick={onRemove} title="Xoá nhân vật">
            <Trash2 className="h-4 w-4 text-destructive" />
          </CtButton>
        </div>
      </div>
      <CtTextarea
        rows={2}
        value={subject.description}
        placeholder={subject.kind === "pet" ? "small fluffy corgi, sitting, tongue out" : "young woman, sitting on the floor, one knee raised, hands resting on it"}
        onChange={(e) => onChange({ ...subject, description: e.target.value })}
      />
      <div className="mt-3 space-y-2">
        {subject.slots.map((slot, i) => (
          <SlotRow key={slot.id} brief={brief} slot={slot} onChange={(s) => setSlot(i, s)} onRemove={() => onChange({ ...subject, slots: subject.slots.filter((_, j) => j !== i) })} />
        ))}
        <CtButton size="sm" variant="subtle" onClick={() => onChange({ ...subject, slots: [...subject.slots, newCharSlot()] })}>
          <Plus className="h-3.5 w-3.5" /> Phần khách đổi được (tóc, áo, giày, vòng cổ…)
        </CtButton>
      </div>
    </div>
  );
}

function SlotRow({ brief, slot, onChange, onRemove }: { brief: CtCharBrief; slot: CtCharSlot; onChange: (s: CtCharSlot) => void; onRemove: () => void }) {
  return (
    <div className="rounded-md bg-muted/40 p-2.5">
      <div className="grid grid-cols-[1fr_190px_auto] items-center gap-2">
        <CtInput value={slot.part} placeholder="hair / sweater / shoes / collar" onChange={(e) => onChange({ ...slot, part: e.target.value })} />
        <CtSelect<CtCharSlotMode>
          value={slot.mode}
          options={MODES}
          onChange={(mode) => onChange({ ...slot, mode, colors: mode === "shape" ? slot.colors : [], options: slot.options.map((o) => (mode === "color" && !/^#/.test(o.value) ? { ...o, value: "#888888" } : o)) })}
        />
        <CtButton size="icon" variant="ghost" onClick={onRemove} title="Xoá phần này">
          <Trash2 className="h-4 w-4 text-destructive" />
        </CtButton>
      </div>
      <OptionList mode={slot.mode} label={slot.mode === "shape" ? "Kiểu" : slot.mode === "texture" ? "Chất liệu" : "Màu"} options={slot.options} onChange={(options) => onChange({ ...slot, options })} />
      <div className="mt-2">
        <CtCheckbox checked={slot.optional === true} onChange={(optional) => onChange({ ...slot, optional })} label="Khách được chọn “Không” (NO)" hint="Kính, mũ, phụ kiện: thêm ô NO — khách bỏ trống phần này." />
      </div>
      <div className="mt-2 flex flex-wrap gap-3">
        <ShownWhenSelect brief={brief} value={slot.shownWhen ?? null} onChange={(shownWhen) => onChange({ ...slot, shownWhen })} />
        {brief.elements.length > 0 && (
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            Đi theo lựa chọn của
            <select className="rounded border bg-background px-1 py-0.5 text-xs text-foreground" value={slot.follows ?? ""} onChange={(e) => onChange({ ...slot, follows: e.target.value || null })}>
              <option value="">— (khách tự chọn)</option>
              {brief.elements.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name || "(chưa tên)"}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {slot.mode === "shape" && (
        <>
          <OptionList mode="color" label="Màu của mỗi kiểu" options={slot.colors} onChange={(colors) => onChange({ ...slot, colors })} />
          <div className="mt-2">
            <CtCheckbox checked={slot.wraps} onChange={(wraps) => onChange({ ...slot, wraps })} label="Vừa nằm sau vừa nằm trước người (tóc dài, khăn)" hint="Tách 2 lớp: sau = cả phần, trước = phần đè lên người. Lớp sau tự đi theo lựa chọn lớp trước." />
          </div>
        </>
      )}
    </div>
  );
}

function OptionList({ mode, label, options, onChange }: { mode: CtCharSlotMode; label: string; options: CtCharOption[]; onChange: (o: CtCharOption[]) => void }) {
  const set = (i: number, o: CtCharOption) => onChange(options.map((x, j) => (j === i ? o : x)));
  return (
    <div className="mt-2">
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label} <span className="normal-case tracking-normal">(đầu tiên = như trong master)</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o, i) => (
          <div key={o.id} className={cx("flex items-center gap-1 rounded-md border bg-background px-1.5 py-1", i === 0 && "border-orange-500")}>
            {mode === "color" ? (
              <input type="color" className="h-6 w-6 cursor-pointer rounded border-0 bg-transparent p-0" value={/^#[0-9a-f]{6}$/i.test(o.value) ? o.value : "#888888"} onChange={(e) => set(i, { ...o, value: e.target.value })} />
            ) : null}
            <input className="w-24 bg-transparent text-xs outline-none" value={o.name} placeholder="Tên" onChange={(e) => set(i, { ...o, name: e.target.value })} />
            {mode !== "color" && (
              <input className="w-48 border-l bg-transparent pl-1 text-xs text-muted-foreground outline-none" value={o.value} placeholder="mô tả cho AI (tiếng Anh)" onChange={(e) => set(i, { ...o, value: e.target.value })} />
            )}
            <button className="rounded p-0.5 hover:bg-accent" onClick={() => onChange(options.filter((_, j) => j !== i))} title="Bỏ">
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        <button className="rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground hover:bg-accent" onClick={() => onChange([...options, newCharOption("", mode === "color" ? "#888888" : "")])}>
          + thêm
        </button>
      </div>
    </div>
  );
}

/** Upload / pick a picture (style reference, blank product). */
function PictureSlot({ ctx, kind, label, id, onPick }: { ctx: CharCtx; kind: "ref" | "blank"; label: string; id: string | null; onPick: (id: string | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const pic: CtCharImage | undefined = ctx.images.find((im) => im.id === id);
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const im = await charApi.upload(ctx.project.id, file, kind);
      ctx.addImages([im]);
      onPick(im.id);
    } catch (e) {
      ctx.error(e instanceof Error ? e.message : "Upload thất bại");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="relative flex h-36 w-full max-w-[220px] items-center justify-center overflow-hidden rounded-lg border border-dashed bg-muted/30">
        {pic ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element -- our R2 WebP preview */}
            <img src={pic.thumb_url || pic.url} alt={label} className="h-full w-full object-contain" />
            {ctx.editable && (
              <button className="absolute right-1 top-1 rounded bg-background/80 p-1 hover:bg-background" onClick={() => onPick(null)} title="Bỏ ảnh">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </>
        ) : (
          <button className="flex flex-col items-center gap-1 text-xs text-muted-foreground" disabled={!ctx.editable || busy} onClick={() => input.current?.click()}>
            {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <ImagePlus className="h-5 w-5" />}
            Tải ảnh lên
          </button>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void upload(f);
        }}
      />
    </div>
  );
}

/**
 * "Xem trước" of the custom options: the master on the left (the approved one, else the newest), on the right every
 * option the customer will pick, laid out like the product page. Only the background can be clicked (asked
 * 2026-10-19): once step 4 has drawn it, the master is shown on it (multiply — the master's white drops out).
 */
function OptionsPreview({ ctx }: { ctx: CharCtx }) {
  const { project, images } = ctx;
  const brief = project.brief;
  const masters = images.filter((im) => im.kind === "master" && im.status === "done");
  const master = masters.find((im) => im.id === project.master_id) ?? [...masters].reverse().find((im) => im.role === "master") ?? [...masters].reverse()[0] ?? null;
  const [backdropId, setBackdropId] = useState<string | null>(brief.backdrops[0]?.id ?? null);
  const backdropPic = (id: string) => [...images].reverse().find((im) => im.kind === "blank" && im.role === `backdrop:${id}` && im.status === "done") ?? null;
  const shownBackdrop = backdropId ? backdropPic(backdropId) : null;
  const short = (d: string) => {
    const t = d.split(/[,.;]/)[0].trim();
    return t ? t[0].toUpperCase() + t.slice(1) : "";
  };
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div
        className="flex aspect-square items-center justify-center self-start overflow-hidden rounded-xl border bg-white bg-cover bg-center lg:sticky lg:top-20"
        style={shownBackdrop ? { backgroundImage: `url(${shownBackdrop.thumb_url || shownBackdrop.url})` } : undefined}
      >
        {master ? (
          // eslint-disable-next-line @next/next/no-img-element -- our R2 preview
          <img src={master.thumb_url || master.url} alt="master" className={cx("h-full w-full object-contain", shownBackdrop && "mix-blend-multiply")} />
        ) : (
          <span className="p-6 text-center text-sm text-muted-foreground">Chưa có master — sang bước 2 để vẽ.</span>
        )}
      </div>
      <div className="space-y-4 rounded-xl border bg-[#f6f3ee] p-4 text-[#1d1d1f]">
        <div className="rounded-md bg-gradient-to-r from-[#d9814a] to-transparent px-3 py-2 text-sm font-semibold text-white">Personalized</div>
        {brief.lineup && brief.subjects.length > 1 && (
          <div className="space-y-1.5">
            <div className="text-sm font-medium">
              {brief.lineup.label} <span className="text-[#c0392b]">*</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {/* The product's own versions (the grandma always there is not counted: 1–4 grandchildren). */}
              {charVersions(brief).map((v, i) => (
                <span key={v.name || i} className={cx("rounded-md border bg-white px-2.5 py-1 text-xs", i === 0 && "border-[#d9814a] ring-1 ring-[#d9814a]")}>
                  {v.name}
                </span>
              ))}
            </div>
          </div>
        )}
        {brief.subjects.map((sub, i) => (
          <div key={sub.id} className="space-y-3">
            {sub.slots.length > 0 && <div className="text-xs font-semibold uppercase tracking-wide text-[#8a7f73]">{sub.name || short(sub.description) || `Option ${i + 1}`}</div>}
            {sub.slots.map((slot) => (
              <div key={slot.id} className="space-y-1.5">
                <div className="text-sm font-medium">
                  Choose {slot.part || "option"} <span className="text-[#c0392b]">*</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {slot.optional && <span className="rounded-md border bg-white px-2.5 py-1 text-xs font-semibold text-[#d9814a]">NO</span>}
                  {slot.options.map((o, j) =>
                    slot.mode === "color" ? (
                      <span key={o.id} title={o.name} className={cx("h-8 w-8 rounded-full border-2", j === 0 ? "border-[#d9814a]" : "border-white shadow")} style={{ backgroundColor: /^#[0-9a-f]{6}$/i.test(o.value) ? o.value : "#cccccc" }} />
                    ) : (
                      <span key={o.id} className={cx("rounded-md border bg-white px-2.5 py-1 text-xs", j === 0 && "border-[#d9814a] ring-1 ring-[#d9814a]")}>
                        {o.name || "(chưa tên)"}
                      </span>
                    ),
                  )}
                </div>
                {slot.mode === "shape" && slot.colors.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pl-1">
                    {slot.colors.map((c, j) => (
                      <span key={c.id} title={c.name} className={cx("h-6 w-6 rounded-full border-2", j === 0 ? "border-[#d9814a]" : "border-white shadow")} style={{ backgroundColor: /^#[0-9a-f]{6}$/i.test(c.value) ? c.value : "#cccccc" }} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
        {brief.elements
          .filter((e) => !e.follows && !e.perBackdrop && e.options.length > 1)
          .map((e) => (
            <div key={e.id} className="space-y-1.5">
              <div className="text-sm font-medium">{e.name}</div>
              <div className="flex flex-wrap gap-1.5">
                {e.options.map((o, j) => (
                  <span key={o.id} className={cx("rounded-md border bg-white px-2.5 py-1 text-xs", j === 0 && "border-[#d9814a] ring-1 ring-[#d9814a]")}>
                    {o.name}
                  </span>
                ))}
              </div>
            </div>
          ))}
        {brief.photoZones.map((z) => (
          <div key={z.id} className="space-y-1.5">
            <div className="text-sm font-medium">{z.label || "Upload your photo"}</div>
            <span className="inline-flex rounded-md border border-dashed bg-white px-3 py-2 text-xs text-[#8a7f73]">Upload photo</span>
          </div>
        ))}
        <div className="space-y-1.5">
          <div className="text-sm font-medium">
            Background {brief.backdrops.length > 0 && <span className="text-[#c0392b]">*</span>}
          </div>
          {brief.backdrops.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {brief.backdrops.map((b) => {
                const pic = backdropPic(b.id);
                return (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => setBackdropId(b.id)}
                    className={cx("flex items-center gap-1.5 rounded-md border bg-white py-1 pl-1 pr-2.5 text-xs", backdropId === b.id && "border-[#d9814a] ring-1 ring-[#d9814a]")}
                  >
                    {pic ? (
                      // eslint-disable-next-line @next/next/no-img-element -- our R2 preview
                      <img src={pic.thumb_url || pic.url} alt="" className="h-6 w-6 rounded object-cover" />
                    ) : (
                      <span className="h-6 w-6 rounded bg-[#e8e2d8]" />
                    )}
                    {b.name || "(chưa tên)"}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-[#8a7f73]">Chưa có nền — thêm ở mục “Nền & mockup” bên dưới (không có nền = màu phôi).</p>
          )}
          {brief.backdrops.length > 0 && !brief.backdrops.some((b) => backdropPic(b.id)) && <p className="text-[11px] text-[#8a7f73]">Ảnh nền AI vẽ ở bước 4 — đến lúc đó bấm vào nền để thấy master trên nền.</p>}
        </div>
        {brief.texts.map((t) => (
          <div key={t.id} className="space-y-1.5">
            <div className="text-sm font-medium">
              {t.label} <span className="text-[#c0392b]">*</span>
            </div>
            <div className="rounded-md border bg-white px-3 py-2 text-sm" style={{ fontFamily: t.font || undefined }}>
              {t.kind === "choice" ? `${t.choices[0] ?? ""} ▾` : t.defaultText || "Jessica"}
            </div>
          </div>
        ))}
        {!brief.subjects.some((x) => x.slots.length) && !brief.texts.length && !brief.photoZones.length && <p className="text-xs text-[#8a7f73]">Chưa có option nào cho khách.</p>}
        <div className="rounded-md bg-[#d9814a] py-2 text-center text-sm font-semibold text-white opacity-80">Add to cart</div>
        {brief.mockups.length > 0 && (
          <div className="space-y-1 border-t border-[#e8e2d8] pt-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-[#8a7f73]">Ảnh mockup (AI tạo ở bước 4)</div>
            <ul className="list-disc space-y-0.5 pl-4 text-xs">
              {brief.mockups.filter((m) => m.trim()).map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-[11px] text-[#8a7f73]">Bấm nền để thử; các option khác chỉ để nhìn trực quan.</p>
      </div>
    </div>
  );
}

/**
 * What the set is (asked 2026-10-18: one "Bộ mới" button, the kind picked here): characters AI draws, or the
 * customer's photo as the hero. Fixed once a master is drawn — every picture after it follows the kind.
 */
function KindPicker({ ctx }: { ctx: CharCtx }) {
  const brief = ctx.project.brief;
  const drawn = !!ctx.project.master_id || ctx.images.some((im) => im.kind === "master" && im.role === "master");
  const pick = (kind: CtCharSetKind) => {
    if (kind === brief.kind) return;
    ctx.setBrief({ ...brief, kind, ...(kind === "photo" && !brief.photoZones.length ? { photoZones: [newPhotoZone("the customer's pet, sitting", "Upload your pet's photo", "ai")] } : {}) });
  };
  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm font-semibold">Loại bộ</span>
        <span className="text-xs text-muted-foreground">{drawn ? "Đã có master — không đổi loại được nữa." : "Chọn trước khi vẽ master."}</span>
        <span className="ml-auto">
          <KindHelpButton highlight={brief.kind} />
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {(["character", "photo"] as CtCharSetKind[]).map((k) => (
          <button
            key={k}
            type="button"
            disabled={drawn || !ctx.editable}
            onClick={() => pick(k)}
            className={cx("flex items-center gap-3 rounded-lg border p-2 text-left disabled:cursor-not-allowed", brief.kind === k ? "border-orange-500 bg-orange-500/10" : "hover:bg-accent disabled:opacity-50")}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- static guide picture */}
            <img src={KIND_INFO[k].pictures[2].src} alt="" className="h-12 w-12 rounded object-cover" />
            <span>
              <span className="block text-sm font-medium">{KIND_INFO[k].title}</span>
              <span className="block text-xs text-muted-foreground">{KIND_INFO[k].short}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

const LINEUP_OPTIONS: Array<{ value: "" | CtCharLineup["mode"]; label: string }> = [
  { value: "", label: "Luôn có đủ các nhân vật" },
  { value: "one", label: "Khách chọn 1 nhân vật (nam / nữ…)" },
  { value: "count", label: "Khách chọn số người (1, 2, 3…)" },
];

const FRAMING_OPTIONS: Array<{ value: "full" | "bust"; label: string }> = [
  { value: "full", label: "Cả người (đầu tới chân)" },
  { value: "bust", label: "Nửa người (ngực trở lên, biển che phía dưới)" },
];

/** Who is in the picture is a customer choice (asked 2026-10-18): one of the characters, or how many of them. */
function LineupRow({ brief, set }: { brief: CtCharBrief; set: (patch: Partial<CtCharBrief>) => void }) {
  const mode = brief.lineup?.mode ?? "";
  return (
    <div className="grid gap-2 rounded-md bg-muted/40 p-2.5 md:grid-cols-[260px_1fr]">
      <CtField label="Vẽ nhân vật">
        <CtSelect<"full" | "bust"> value={brief.framing ?? "full"} options={FRAMING_OPTIONS} onChange={(framing) => set({ framing })} />
      </CtField>
      <p className="self-end text-xs text-muted-foreground">Nửa người: master cắt ngang mọi người cùng một đường ở dưới; thêm phần trang trí “trước người” ở dưới (tấm biển) để che.</p>
      <CtField label="Ai có trong tranh">
        <CtSelect<"" | CtCharLineup["mode"]>
          value={mode}
          options={LINEUP_OPTIONS}
          onChange={(m) => set({ lineup: m ? { mode: m, label: brief.lineup?.mode === m ? brief.lineup.label : m === "one" ? "Choose character" : "Number of people" } : null })}
        />
      </CtField>
      {brief.lineup ? (
        <CtField label="Khách thấy (tiếng Anh)">
          <CtInput value={brief.lineup.label} onChange={(e) => set({ lineup: { ...brief.lineup!, label: e.target.value } })} />
        </CtField>
      ) : (
        <p className="self-end text-xs text-muted-foreground">Mọi nhân vật luôn có mặt.</p>
      )}
      {brief.lineup && (
        <p className="text-xs text-muted-foreground md:col-span-2">
          Master vẽ đủ {brief.subjects.length} nhân vật, không ai đứng trước ai; sản phẩm có 1 version cho mỗi lựa chọn ({brief.lineup.mode === "one" ? "mỗi nhân vật 1 version, đặt tên ở ô “Tên khách thấy”" : "version k = k người (người “Luôn có mặt” + những người cạnh họ), cùng cỡ, căn giữa"}).
        </p>
      )}
    </div>
  );
}

/** A box as shares of the safe area, typed in % (x, y, rộng, cao). */
function BoxInput({ label, value, disabled, onChange }: { label: string; value: CtCharBox | null; disabled?: boolean; onChange: (b: CtCharBox | null) => void }) {
  const b = value ?? { x: 0.3, y: 0.3, w: 0.4, h: 0.4 };
  const field = (k: keyof CtCharBox, name: string) => (
    <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
      {name}
      <input
        type="number"
        disabled={disabled}
        className="w-14 rounded border bg-background px-1 py-0.5 text-xs text-foreground"
        value={Math.round(b[k] * 100)}
        onChange={(e) => onChange({ ...b, [k]: Math.max(-20, Math.min(120, Number(e.target.value) || 0)) / 100 })}
      />
    </label>
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      {value ? (
        <>
          {field("x", "trái")}
          {field("y", "trên")}
          {field("w", "rộng")}
          {field("h", "cao")}
          <button type="button" disabled={disabled} className="text-[11px] text-muted-foreground underline" onClick={() => onChange(null)}>
            tự động
          </button>
        </>
      ) : (
        <button type="button" disabled={disabled} className="text-[11px] text-muted-foreground underline" onClick={() => onChange(b)}>
          tự động — đặt ô riêng
        </button>
      )}
    </div>
  );
}

/**
 * A bộ nhân vật's decorations (asked 2026-10-18: the "Class of" scroll, the ribbon banner, the year in glitter numbers,
 * trees beside a family): drawn alone in the master's look (step 4), never cut, placed around the characters. A
 * single option is simply drawn; several = a customer choice; one may follow another's choice (the right-hand tree
 * follows the left-hand one's theme). Editable after the master.
 */
function CharElementsSection({ brief, set, readOnly }: { brief: CtCharBrief; set: (patch: Partial<CtCharBrief>) => void; readOnly: boolean }) {
  const setElement = (i: number, e: CtCharElement) => set({ elements: brief.elements.map((x, j) => (j === i ? e : x)) });
  return (
    <Section
      title={`Phần tử trang trí (${brief.elements.length})`}
      hint="Không cắt từ master: mỗi lựa chọn AI vẽ riêng, nền trong suốt, theo phong cách master (bước 4). 1 lựa chọn = luôn có (ruy băng, cuộn giấy); nhiều lựa chọn = khách chọn (năm 2026…2030, chủ đề Giáng sinh / Halloween)."
      action={
        !readOnly && (
          <span className="flex flex-wrap gap-1">
            {(Object.keys(CHAR_ELEMENT_PLACE_LABEL) as CtCharElementPlace[]).map((place) => (
              <CtButton key={place} size="sm" variant="outline" onClick={() => set({ elements: [...brief.elements, { ...newElement("", place), perBackdrop: false }] })}>
                <Plus className="h-3.5 w-3.5" /> {CHAR_ELEMENT_PLACE_LABEL[place].split(" (")[0].split(",")[0]}
              </CtButton>
            ))}
          </span>
        )
      }
    >
      <div className="space-y-3">
        <BoxInput label="Vị trí nhân vật" value={brief.charactersBox ?? null} disabled={readOnly} onChange={(charactersBox) => set({ charactersBox })} />
        {brief.elements.map((e, i) => (
          <div key={e.id} className="rounded-md bg-muted/40 p-2.5">
            <div className="grid grid-cols-[1fr_200px_150px_auto] items-center gap-2">
              <CtInput value={e.name} placeholder="Year / Ribbon banner / Theme" onChange={(ev) => setElement(i, { ...e, name: ev.target.value })} />
              <CtSelect<CtCharElementPlace> value={e.place} options={(Object.keys(CHAR_ELEMENT_PLACE_LABEL) as CtCharElementPlace[]).map((value) => ({ value, label: CHAR_ELEMENT_PLACE_LABEL[value] }))} onChange={(place) => setElement(i, { ...e, place })} />
              <CtSelect<"shape" | "color">
                value={e.mode}
                options={[
                  { value: "shape", label: "Đổi kiểu" },
                  { value: "color", label: "Đổi màu" },
                ]}
                onChange={(mode) => setElement(i, { ...e, mode, options: e.options.map((o) => (mode === "color" && !/^#/.test(o.value) ? { ...o, value: "#d4af37" } : o)) })}
              />
              <CtButton size="icon" variant="ghost" onClick={() => set({ elements: brief.elements.filter((_, j) => j !== i) })} title="Xoá phần tử">
                <Trash2 className="h-4 w-4 text-destructive" />
              </CtButton>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-4">
              <CtCheckbox checked={e.front === true} onChange={(front) => setElement(i, { ...e, front })} label="Nằm trước nhân vật" />
              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                Đi theo lựa chọn của
                <select className="rounded border bg-background px-1 py-0.5 text-xs text-foreground" value={e.follows ?? ""} onChange={(ev) => setElement(i, { ...e, follows: ev.target.value || null })}>
                  <option value="">— (khách tự chọn)</option>
                  {brief.elements
                    .filter((x) => x.id !== e.id)
                    .map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name || "(chưa tên)"}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            {e.place === "free" && (
              <div className="mt-2">
                <BoxInput label="Ô vị trí (% vùng an toàn)" value={e.box} disabled={readOnly} onChange={(box) => setElement(i, { ...e, box })} />
              </div>
            )}
            <OptionList mode={e.mode} label={e.mode === "color" ? "Màu" : "Kiểu (mô tả cho AI)"} options={e.options} onChange={(options) => setElement(i, { ...e, options })} />
          </div>
        ))}
        {!brief.elements.length && <p className="text-xs text-muted-foreground">Không có — ví dụ: Ribbon banner (tự đặt, 1 kiểu), Year (tự đặt, trước nhân vật, 2026…2030), Theme trái / phải (Giáng sinh, Halloween, Phục sinh).</p>}
      </div>
    </Section>
  );
}

/** "Chỉ hiện khi": a chooser option a part / text / decoration exists for (brief.choosers). */
function ShownWhenSelect({ brief, value, onChange }: { brief: CtCharBrief; value: CtCharShownWhen | null; onChange: (w: CtCharShownWhen | null) => void }) {
  const choosers = brief.choosers ?? [];
  if (!choosers.length) return null;
  return (
    <label className="flex items-center gap-1 text-xs text-muted-foreground">
      Chỉ hiện khi
      <select
        className="rounded border bg-background px-1 py-0.5 text-xs text-foreground"
        value={value ? `${value.chooser}|${value.option}` : ""}
        onChange={(e) => {
          const [chooser, option] = e.target.value.split("|");
          onChange(chooser && option ? { chooser, option } : null);
        }}
      >
        <option value="">— (luôn có)</option>
        {choosers.flatMap((c) =>
          c.options.map((o) => (
            <option key={`${c.id}|${o.id}`} value={`${c.id}|${o.id}`}>
              {c.label}: {o.name}
            </option>
          )),
        )}
      </select>
    </label>
  );
}

/**
 * Choices that draw nothing and only decide which parts exist (asked 2026-10-18: each grandchild a boy or a girl, the
 * grandparent a grandma or a grandpa, hats or no hats). A part / text / decoration picks "Chỉ hiện khi" one option.
 */
function ChoosersRow({ brief, set }: { brief: CtCharBrief; set: (patch: Partial<CtCharBrief>) => void }) {
  const list = brief.choosers ?? [];
  const setOne = (i: number, c: CtCharChooser) => set({ choosers: list.map((x, j) => (j === i ? c : x)) });
  return (
    <div className="space-y-2 rounded-md bg-muted/40 p-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Ô chọn (nam / nữ, có / không nón…)</span>
        <button
          type="button"
          className="ml-auto rounded-md border border-dashed px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent"
          onClick={() => set({ choosers: [...list, { id: crypto.randomUUID(), label: "", options: [newCharOption("Boy", "Boy"), newCharOption("Girl", "Girl")], subject: null }] })}
        >
          + ô chọn
        </button>
      </div>
      {list.map((c, i) => (
        <div key={c.id} className="flex flex-wrap items-center gap-2">
          <CtInput className="h-8 w-44" value={c.label} placeholder="Grandchild 1 / Hats" onChange={(e) => setOne(i, { ...c, label: e.target.value })} />
          <select className="h-8 rounded border bg-background px-1 text-xs" value={c.subject ?? ""} onChange={(e) => setOne(i, { ...c, subject: e.target.value || null })}>
            <option value="">Chung cả tranh</option>
            {brief.subjects.map((sub, j) => (
              <option key={sub.id} value={sub.id}>
                Của nhân vật {j + 1}
              </option>
            ))}
          </select>
          <span className="flex flex-wrap gap-1">
            {c.options.map((o, j) => (
              <input key={o.id} className="h-7 w-24 rounded border bg-background px-1.5 text-xs" value={o.name} onChange={(e) => setOne(i, { ...c, options: c.options.map((x, k) => (k === j ? { ...x, name: e.target.value, value: e.target.value } : x)) })} />
            ))}
          </span>
          <button type="button" className="rounded p-1 hover:bg-accent" onClick={() => set({ choosers: list.filter((_, j) => j !== i) })} title="Xoá ô chọn">
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </button>
        </div>
      ))}
      {!list.length && <p className="text-xs text-muted-foreground">Không có.</p>}
    </div>
  );
}
