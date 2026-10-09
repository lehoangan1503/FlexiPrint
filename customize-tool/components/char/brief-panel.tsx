"use client";

/**
 * Step 1 — the brief. First a full-width brainstorm chat (@flexiprint proposes 3 directions, each a full brief with a
 * master drawn from it); taking one opens the brief itself — product, style, characters and what the customer may
 * change, photo zones, text, decor, mockups. Everything the later steps need comes from here; nothing else is asked.
 */

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Bot, ImagePlus, Loader2, MessagesSquare, Plus, Send, Trash2, X } from "lucide-react";
import type { CtCharBrief, CtCharIdea, CtCharImage, CtCharOption, CtCharSlot, CtCharSlotMode, CtCharSubject, CtCharSubjectKind } from "../../types";
import { briefCombos, newCharOption, newCharSlot, newCharSubject, newPhotoZone } from "../../lib/char-brief";
import { charApi } from "../../lib/api-client";
import { CtButton, CtCheckbox, CtField, CtInput, CtModal, CtSelect, CtTextarea, cx } from "../ui";
import type { CharCtx } from "./char-project";
import { RefPictures } from "./ref-pictures";
import type { CtPrintTemplate } from "../../types/print";
import { layoutHint } from "../../lib/print-template";
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
  const locked = !!all.project.master_id;
  const ctx: CharCtx = locked ? { ...all, editable: false } : all;
  // Brainstorm first (a full-width chat); the brief opens once a direction is taken (or there is one already).
  const chosen = ctx.project.brief.subjects.length > 0;
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
        {locked && (
          <p className="rounded-md bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
            Master đã duyệt — brief bị khoá, chỉ xem. Muốn đổi brief: về bước Master, bỏ duyệt master (các ảnh tô vùng clipart theo brief cũ sẽ không còn khớp).
          </p>
        )}
        <BriefForm {...ctx} />
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

function BriefForm(ctx: CharCtx) {
  const { project, editable } = ctx;
  const brief = project.brief;
  const [optionView, setOptionView] = useState<OptionView>("edit");
  const set = (patch: Partial<CtCharBrief>) => ctx.setBrief({ ...brief, ...patch });
  const setSubject = (i: number, sub: CtCharSubject) => set({ subjects: brief.subjects.map((s, j) => (j === i ? sub : s)) });
  const ro = !editable;

  return (
    <div className="space-y-6">
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
            <CtField label="Bố cục / tư thế chung">
              <CtTextarea rows={2} value={brief.scene} placeholder="Sitting side by side on the floor, the dog in front of the girls" onChange={(e) => set({ scene: e.target.value })} />
            </CtField>
          </div>
        </div>
      </Section>
    </fieldset>

      {/* Outside the read-only fieldset: the Nội dung / Xem trước switch works on a locked brief too. */}
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
          {brief.subjects.map((sub, i) => (
            <SubjectCard
              key={sub.id}
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
            <div key={z.id} className="grid grid-cols-[1fr_200px_auto] gap-2">
              <CtInput value={z.where} placeholder="a round photo frame she holds in both hands" onChange={(e) => set({ photoZones: brief.photoZones.map((x, j) => (j === i ? { ...x, where: e.target.value } : x)) })} />
              <CtInput value={z.label} placeholder="Upload your photo" onChange={(e) => set({ photoZones: brief.photoZones.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
              <CtButton size="icon" variant="ghost" onClick={() => set({ photoZones: brief.photoZones.filter((_, j) => j !== i) })}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </CtButton>
            </div>
          ))}
          {!brief.photoZones.length && <p className="text-xs text-muted-foreground">Không có.</p>}
        </div>
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Chữ / tên">
          <CtCheckbox checked={brief.text.enabled} onChange={(enabled) => set({ text: { ...brief.text, enabled } })} label="Có chữ cá nhân hoá" />
          {brief.text.enabled && (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <CtField label="Chữ mặc định">
                <CtInput value={brief.text.defaultText} placeholder="Jessica" onChange={(e) => set({ text: { ...brief.text, defaultText: e.target.value } })} />
              </CtField>
              <CtField label="Font (Google Fonts)">
                <CtInput value={brief.text.font} placeholder="Great Vibes" onChange={(e) => set({ text: { ...brief.text, font: e.target.value } })} />
              </CtField>
              <div className="sm:col-span-2">
                <CtField label="Đặt ở đâu">
                  <CtInput value={brief.text.place} placeholder="under the characters, centred" onChange={(e) => set({ text: { ...brief.text, place: e.target.value } })} />
                </CtField>
              </div>
            </div>
          )}
        </Section>
        <Section title="Trang trí nền & mockup">
          <CtField label="Trang trí quanh nhân vật (không bắt buộc)">
            <CtInput value={brief.decor} placeholder="small butterflies and a peach peony" onChange={(e) => set({ decor: e.target.value })} />
          </CtField>
          <div className="mt-3">
            <CtField label="Cảnh mockup (mỗi dòng 1 cảnh)">
              <CtTextarea rows={3} value={brief.mockups.join("\n")} placeholder={"on a marble vanity with makeup brushes\nflat lay with flowers and a mirror"} onChange={(e) => set({ mockups: e.target.value.split("\n").slice(0, 6) })} />
            </CtField>
          </div>
        </Section>
      </div>

      <div className="flex justify-end">
        <CtButton variant="primary" disabled={!brief.subjects.length} onClick={() => ctx.goto("master")}>
          Sang bước Master <ArrowRight className="h-4 w-4" />
        </CtButton>
      </div>
    </fieldset>
    </div>
  );
}

function SubjectCard({ index, subject, onChange, onRemove, onMove }: { index: number; subject: CtCharSubject; onChange: (s: CtCharSubject) => void; onRemove: () => void; onMove: (d: number) => void }) {
  const setSlot = (i: number, slot: CtCharSlot) => onChange({ ...subject, slots: subject.slots.map((s, j) => (j === i ? slot : s)) });
  return (
    <div className="rounded-lg border p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">{index + 1}</span>
        <div className="w-32">
          <CtSelect<CtCharSubjectKind> value={subject.kind} options={KINDS} onChange={(kind) => onChange({ ...subject, kind })} />
        </div>
        <span className="text-xs text-muted-foreground">từ trái sang</span>
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
          <SlotRow key={slot.id} slot={slot} onChange={(s) => setSlot(i, s)} onRemove={() => onChange({ ...subject, slots: subject.slots.filter((_, j) => j !== i) })} />
        ))}
        <CtButton size="sm" variant="subtle" onClick={() => onChange({ ...subject, slots: [...subject.slots, newCharSlot()] })}>
          <Plus className="h-3.5 w-3.5" /> Phần khách đổi được (tóc, áo, giày, vòng cổ…)
        </CtButton>
      </div>
    </div>
  );
}

function SlotRow({ slot, onChange, onRemove }: { slot: CtCharSlot; onChange: (s: CtCharSlot) => void; onRemove: () => void }) {
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
 * option the customer will pick, laid out like the product page — only to see it, nothing works yet.
 */
function OptionsPreview({ ctx }: { ctx: CharCtx }) {
  const { project, images } = ctx;
  const brief = project.brief;
  const masters = images.filter((im) => im.kind === "master" && im.status === "done");
  const master = masters.find((im) => im.id === project.master_id) ?? [...masters].reverse().find((im) => im.role === "master") ?? [...masters].reverse()[0] ?? null;
  const short = (d: string) => {
    const t = d.split(/[,.;]/)[0].trim();
    return t ? t[0].toUpperCase() + t.slice(1) : "";
  };
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex aspect-square items-center justify-center self-start overflow-hidden rounded-xl border bg-white lg:sticky lg:top-20">
        {master ? (
          // eslint-disable-next-line @next/next/no-img-element -- our R2 preview
          <img src={master.thumb_url || master.url} alt="master" className="h-full w-full object-contain" />
        ) : (
          <span className="p-6 text-center text-sm text-muted-foreground">Chưa có master — sang bước 2 để vẽ.</span>
        )}
      </div>
      <div className="space-y-4 rounded-xl border bg-[#f6f3ee] p-4 text-[#1d1d1f]">
        <div className="rounded-md bg-gradient-to-r from-[#d9814a] to-transparent px-3 py-2 text-sm font-semibold text-white">Personalized</div>
        {brief.subjects.map((sub, i) => (
          <div key={sub.id} className="space-y-3">
            {sub.slots.length > 0 && <div className="text-xs font-semibold uppercase tracking-wide text-[#8a7f73]">{short(sub.description) || `Option ${i + 1}`}</div>}
            {sub.slots.map((slot) => (
              <div key={slot.id} className="space-y-1.5">
                <div className="text-sm font-medium">
                  Choose {slot.part || "option"} <span className="text-[#c0392b]">*</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
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
        {brief.photoZones.map((z) => (
          <div key={z.id} className="space-y-1.5">
            <div className="text-sm font-medium">{z.label || "Upload your photo"}</div>
            <span className="inline-flex rounded-md border border-dashed bg-white px-3 py-2 text-xs text-[#8a7f73]">Upload photo</span>
          </div>
        ))}
        {brief.text.enabled && (
          <div className="space-y-1.5">
            <div className="text-sm font-medium">
              Enter name <span className="text-[#c0392b]">*</span>
            </div>
            <div className="rounded-md border bg-white px-3 py-2 text-sm" style={{ fontFamily: brief.text.font || undefined }}>
              {brief.text.defaultText || "Jessica"}
            </div>
          </div>
        )}
        {!brief.subjects.some((x) => x.slots.length) && !brief.text.enabled && !brief.photoZones.length && <p className="text-xs text-[#8a7f73]">Chưa có option nào cho khách.</p>}
        <div className="rounded-md bg-[#d9814a] py-2 text-center text-sm font-semibold text-white opacity-80">Add to cart</div>
        <p className="text-[11px] text-[#8a7f73]">Chỉ để nhìn trực quan — chưa bấm chọn được.</p>
      </div>
    </div>
  );
}
