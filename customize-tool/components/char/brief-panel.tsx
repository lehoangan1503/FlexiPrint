"use client";

/**
 * Step 1 — the brief. Left: the idea + brainstorm (@flexiprint proposes 3 directions, each a full brief). Right: the brief
 * itself — product, style, characters and what the customer may change, photo zones, text, decor, mockups.
 * Everything the later steps need comes from here; nothing else is asked.
 */

import { useRef, useState } from "react";
import { ArrowRight, Bot, ImagePlus, Loader2, Plus, Trash2, X } from "lucide-react";
import type { CtCharBrief, CtCharCut, CtCharIdea, CtCharImage, CtCharOption, CtCharSlot, CtCharSlotMode, CtCharSubject, CtCharSubjectKind } from "../../types";
import { briefCombos, newCharOption, newCharSlot, newCharSubject, newPhotoZone } from "../../lib/char-brief";
import { charApi } from "../../lib/api-client";
import { CtButton, CtCheckbox, CtField, CtInput, CtSelect, CtTextarea, cx } from "../ui";
import type { CharCtx } from "./char-project";
import { RefPictures } from "./ref-pictures";

const CUTS: Array<{ value: CtCharCut; label: string }> = [
  { value: "rect", label: "In trong ô (túi, ly, áo…)" },
  { value: "alpha", label: "Cắt viền theo hình (sticker, acrylic)" },
  { value: "frame", label: "Khuôn cố định" },
];
const MODES: Array<{ value: CtCharSlotMode; label: string }> = [
  { value: "color", label: "Đổi màu" },
  { value: "texture", label: "Đổi chất liệu" },
  { value: "shape", label: "Đổi kiểu (hình dạng)" },
];
const KINDS: Array<{ value: CtCharSubjectKind; label: string }> = [
  { value: "person", label: "Người" },
  { value: "pet", label: "Thú cưng" },
  { value: "object", label: "Vật" },
];

export function BriefPanel(all: CharCtx) {
  // The edits, the plan and the layers hang on the brief's ids: with a master approved the brief is read-only
  // (the server refuses a changed brief too).
  const locked = !!all.project.master_id;
  const ctx: CharCtx = locked ? { ...all, editable: false } : all;
  return (
    <div className="grid min-h-0 gap-0 lg:grid-cols-[400px_1fr]">
      <IdeaColumn {...ctx} />
      <div className="min-w-0 space-y-6 p-6">
        {locked && (
          <p className="rounded-md bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
            Master đã duyệt — brief bị khoá, chỉ xem. Muốn đổi brief: về bước Master, bỏ duyệt master (các bản sửa theo brief cũ sẽ không còn khớp).
          </p>
        )}
        <BriefForm {...ctx} />
      </div>
    </div>
  );
}

// ---- idea + brainstorm -------------------------------------------------------------------------------------

function IdeaColumn(ctx: CharCtx) {
  const { project, editable } = ctx;
  const brief = project.brief;
  const [request, setRequest] = useState("");
  const rounds = [...project.ideas].reverse();
  const busy = ctx.agent.busy;
  const thinking = ctx.agent.task?.input.char?.step === "brainstorm";

  const ask = async () => {
    await ctx.flush();
    await ctx.agent.start("brainstorm", request.trim());
    setRequest("");
  };

  const take = (idea: CtCharIdea) => {
    ctx.setBrief({ ...idea.brief, idea: brief.idea || idea.brief.idea, product: { ...idea.brief.product, blankId: brief.product.blankId }, refs: brief.refs });
  };

  return (
    <aside className="space-y-4 border-r bg-muted/20 p-5 lg:sticky lg:top-14 lg:h-[calc(100vh-3.5rem)] lg:overflow-y-auto">
      <CtField label="Ý tưởng của bạn" hint="Viết tự nhiên, mơ hồ cũng được: cho ai, dịp gì, sản phẩm gì, mấy người / mấy con thú, cảm giác muốn có.">
        <CtTextarea
          rows={5}
          value={brief.idea}
          disabled={!editable}
          placeholder="VD: túi mỹ phẩm tặng mẹ, mẹ + 2 con gái + 1 con cún, khách đổi được tóc, màu áo, tên…"
          onChange={(e) => ctx.setBrief({ ...brief, idea: e.target.value })}
        />
      </CtField>
      <RefPictures {...ctx} />
      {rounds.length > 0 && (
        <CtField label="Yêu cầu thêm cho @flexiprint (không bắt buộc)">
          <CtTextarea rows={2} value={request} disabled={!editable} placeholder="VD: thêm hướng phong cách màu nước; bỏ con mèo…" onChange={(e) => setRequest(e.target.value)} />
        </CtField>
      )}
      <CtButton variant="primary" className="w-full justify-center" disabled={!editable || busy || !(brief.idea.trim() || request.trim())} onClick={() => void ask()}>
        {thinking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
        {thinking ? "@flexiprint đang nghĩ…" : rounds.length ? "@flexiprint gợi ý thêm" : "@flexiprint gợi ý 3 hướng"}
      </CtButton>
      {busy && !thinking && <p className="text-[11px] text-muted-foreground">@flexiprint đang làm bước khác của bộ này — chờ xong.</p>}

      {rounds.map((r) => (
        <div key={r.id} className="space-y-3 rounded-lg border bg-card p-3">
          {r.request && <p className="text-xs italic text-muted-foreground">“{r.request}”</p>}
          {r.summary && <p className="text-sm">{r.summary}</p>}
          {r.questions.length > 0 && (
            <div className="rounded-md bg-amber-500/10 p-2 text-xs">
              <div className="mb-1 font-medium text-amber-700 dark:text-amber-400">Nên trả lời trước khi tạo master:</div>
              <ul className="list-disc space-y-0.5 pl-4">
                {r.questions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </div>
          )}
          {r.ideas.map((idea) => (
            <div key={idea.id} className="rounded-md border p-2.5">
              <div className="text-sm font-semibold">{idea.title}</div>
              {idea.why && <p className="mt-0.5 text-xs text-muted-foreground">{idea.why}</p>}
              <p className="mt-1.5 text-xs">
                <span className="text-muted-foreground">Phong cách:</span> {idea.brief.style}
              </p>
              <ul className="mt-1 space-y-0.5 text-xs">
                {idea.brief.subjects.map((sub) => (
                  <li key={sub.id}>
                    • {sub.description}
                    {sub.slots.length > 0 && <span className="text-muted-foreground"> — {sub.slots.map((sl) => `${sl.part} (${sl.options.length}${sl.colors.length ? `×${sl.colors.length} màu` : ""})`).join(", ")}</span>}
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground">{briefCombos(idea.brief).toLocaleString("vi-VN")} tổ hợp</span>
                <CtButton size="sm" className="ml-auto" disabled={!editable} onClick={() => take(idea)}>
                  Dùng hướng này <ArrowRight className="h-3.5 w-3.5" />
                </CtButton>
              </div>
            </div>
          ))}
        </div>
      ))}
    </aside>
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

function BriefForm(ctx: CharCtx) {
  const { project, images, editable } = ctx;
  const brief = project.brief;
  const set = (patch: Partial<CtCharBrief>) => ctx.setBrief({ ...brief, ...patch });
  const setSubject = (i: number, sub: CtCharSubject) => set({ subjects: brief.subjects.map((s, j) => (j === i ? sub : s)) });
  const ro = !editable;

  return (
    <fieldset disabled={ro} className="space-y-6">
      <Section title="Sản phẩm" hint="In lên đâu, cỡ vùng in. Ảnh phôi trơn chụp thẳng giúp xem trước chính xác (không có thì để AI tạo sau).">
        <div className="grid gap-3 sm:grid-cols-[1fr_220px_100px_100px]">
          <CtField label="Sản phẩm">
            <CtInput value={brief.product.label} placeholder="Túi mỹ phẩm vải seersucker" onChange={(e) => set({ product: { ...brief.product, label: e.target.value } })} />
          </CtField>
          <CtField label="Kiểu in / cắt">
            <CtSelect<CtCharCut> value={brief.product.cut} options={CUTS} onChange={(cut) => set({ product: { ...brief.product, cut } })} />
          </CtField>
          <CtField label="Rộng (mm)">
            <CtInput type="number" min={0} value={brief.product.widthMm || ""} onChange={(e) => set({ product: { ...brief.product, widthMm: Number(e.target.value) || 0 } })} />
          </CtField>
          <CtField label="Cao (mm)">
            <CtInput type="number" min={0} value={brief.product.heightMm || ""} onChange={(e) => set({ product: { ...brief.product, heightMm: Number(e.target.value) || 0 } })} />
          </CtField>
        </div>
        <div className="mt-3">
          <PictureSlot ctx={ctx} kind="blank" label="Ảnh phôi trơn (chụp thẳng)" id={brief.product.blankId} onPick={(id) => set({ product: { ...brief.product, blankId: id } })} />
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

      <Section
        title={`Nhân vật (${brief.subjects.length})`}
        hint="Thứ tự = từ trái sang phải trong tranh. Mô tả người/thú (dáng, tuổi, giống chó…); phần khách đổi được ghi ở bên dưới, lựa chọn ĐẦU TIÊN = như trong master."
        action={
          <div className="flex gap-1">
            <CtButton size="sm" onClick={() => set({ subjects: [...brief.subjects, newCharSubject("person")] })}>
              <Plus className="h-3.5 w-3.5" /> Người
            </CtButton>
            <CtButton size="sm" onClick={() => set({ subjects: [...brief.subjects, newCharSubject("pet")] })}>
              <Plus className="h-3.5 w-3.5" /> Thú
            </CtButton>
          </div>
        }
      >
        <div className="space-y-4">
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
          {!brief.subjects.length && <p className="text-sm text-muted-foreground">Chưa có — thêm tay, hoặc bấm “Gợi ý 3 hướng” bên trái rồi chọn một hướng.</p>}
        </div>
      </Section>

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
