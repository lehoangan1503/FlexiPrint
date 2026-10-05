"use client";

/**
 * "Cập nhật bằng AI" of a category, and its history (migration 010).
 *
 * The editor says what they dislike — about the numbered result images (opened from the AI dialog's "Chưa hài
 * lòng kết quả") and / or new reference photos. The AI (server/ai/prompt-writer.ts suggestCategoryRevision) reads
 * the category's current prompts, the library and the images, finds which layer causes the problem — spec,
 * style pack, material, chi tiết thành phẩm — and proposes changes to that layer only: switch to another
 * library preset, edit the prompt, or add one. Each change is shown before / after and applied only if ticked.
 */

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, History, Loader2, RefreshCw, ShieldCheck, Sparkles, X } from "lucide-react";
import type { CtAsset, CtCategoryHistoryEntry, CtCategoryRevision, CtCategorySnapshot, CtMaterialSpec, CtPreset, CtPromptReview, CtRevisePreset, CtReviseRefRole } from "../../types";
import { ctApi } from "../../lib/api-client";
import { isMaterialClipart, isMulticolorClipart } from "../../lib/library";
import { CHECKER_STYLE, CtButton, CtCheckbox, CtTextarea, cx } from "../ui";
import { numberedImage } from "../studio/refine-shared";
import { SentenceDiff } from "../studio/sentence-diff";
import { RefNoteBox, type RefImage } from "./ref-note-box";
import { AgentProgress, BrainToggle, useAgentTask, useAiBrain } from "./agent-brain";

/** What the editor ticked in a revision. */
export interface CtReviseChoice {
  /** The spec to save (editable), or null to keep it. */
  spec: string | null;
  style: CtPresetChoice;
  /** Same order as revision.materials. */
  materials: CtPresetChoice[];
  details: boolean;
  /** Remove the product photos the review found contradicting the details. */
  dropRefs: boolean;
}

export interface CtPresetChoice {
  apply: boolean;
  /** "edit" of a preset other categories use: true = edit the shared one, false = a copy for this category. */
  shared: boolean;
}

/** One result image the revision looks at, in its numbered order. */
export function reviewLabel(a: CtAsset, materials: CtPreset[]): string {
  const mat = materials.find((m) => m.id === a.meta.material)?.name ?? "vật liệu";
  const kind = a.parent_id === null ? "clipart gốc" : isMulticolorClipart(a) ? (isMaterialClipart(a) ? `đa sắc của bản ${mat}` : "đa sắc") : `bản vật liệu ${mat}`;
  return `"${a.name}" — ${kind}`;
}

const ACTION_LABEL: Record<CtRevisePreset["action"], string> = { keep: "Giữ nguyên", switch: "Đổi sang", edit: "Sửa prompt", new: "Tạo mới", remove: "Bỏ khỏi danh mục" };
const ROLE_LABEL: Record<CtReviseRefRole, string> = { design: "ảnh mẫu của bộ", product: "ảnh thành phẩm", none: "chỉ để giải thích" };

export function CategoryRevisePanel(props: {
  category: CtCategorySnapshot & { id: string | null };
  /** Results to review (numbered #1…). */
  review: CtAsset[];
  materials: CtPreset[];
  onApply: (plan: CtCategoryRevision, choice: CtReviseChoice, refUrls: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  const [refs, setRefs] = useState<RefImage[]>([]);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<"analyse" | "review" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<CtCategoryRevision | null>(null);
  const [refUrls, setRefUrls] = useState<string[]>([]);
  const [choice, setChoice] = useState<CtReviseChoice | null>(null);
  const shown = props.review.filter((a) => !off.has(a.id));
  const { status, brain, setBrain } = useAiBrain();
  const agent = useAgentTask();

  const analyse = async () => {
    setBusy("analyse");
    setError(null);
    try {
      const uploaded = await Promise.all(refs.map((r) => ctApi.uploadPresetRef(r.blob)));
      const urls = [...refUrls, ...uploaded].slice(-4);
      refs.forEach((r) => URL.revokeObjectURL(r.preview));
      setRefs([]);
      setRefUrls(urls);
      if (brain === "agent") {
        const images = shown.map((a) => ({ url: a.url, label: reviewLabel(a, props.materials) }));
        show(await agent.run<CtCategoryRevision>("revise", { category: props.category, note, images, refUrls: urls }));
        return;
      }
      const images = await Promise.all(shown.map(async (a, i) => ({ image: await numberedImage(a.url, i + 1), label: reviewLabel(a, props.materials), url: a.url })));
      show(await ctApi.suggestCategoryRevision({ category: props.category, note, images, refUrls: urls }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi");
    } finally {
      setBusy(null);
    }
  };

  const show = (p: CtCategoryRevision) => {
    setPlan(p);
    setChoice({
      spec: p.spec?.text ?? null,
      style: { apply: p.style.action !== "keep", shared: p.style.usedByOthers.length === 0 },
      materials: p.materials.map((m) => ({ apply: m.action !== "keep", shared: m.usedByOthers.length === 0 })),
      details: p.details !== null,
      dropRefs: (p.review?.dropProductRefs.length ?? 0) > 0,
    });
  };

  /** The category's prompts as they are now, read together — no feedback needed. */
  const check = async () => {
    setBusy("review");
    setError(null);
    try {
      show(brain === "agent" ? await agent.run<CtCategoryRevision>("revise", { category: props.category, note: "", images: [], refUrls: [] }) : await ctApi.reviewCategory(props.category));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi");
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!plan || !choice) return;
    setBusy("apply");
    setError(null);
    try {
      await props.onApply(plan, choice, refUrls);
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi");
    } finally {
      setBusy(null);
    }
  };

  const dropRefs = plan?.review?.dropProductRefs ?? [];
  const changes = choice
    ? Number(choice.spec !== null) + Number(choice.style.apply) + choice.materials.filter((m) => m.apply).length + Number(choice.details) + Number(choice.dropRefs && dropRefs.length > 0)
    : 0;

  return (
    <div className="space-y-3 rounded-lg border border-sky-500/30 bg-sky-500/5 p-3">
      <div className="flex items-center gap-2">
        <Sparkles className="h-3.5 w-3.5" />
        <span className="text-sm font-medium">Cập nhật bằng AI</span>
        <span className="text-[11px] text-muted-foreground">
          AI xem prompt hiện tại, ảnh tham khảo{props.review.length ? ", ảnh kết quả" : ""} và mô tả của bạn → tìm sai ở lớp nào (spec chung, style pack, vật liệu, chi tiết thành phẩm) và chỉ sửa lớp đó.
        </span>
        <span className="ml-auto shrink-0">
          <BrainToggle status={status} brain={brain} onBrain={setBrain} disabled={busy !== null} />
        </span>
        <button className="rounded p-1 text-muted-foreground hover:bg-accent" onClick={props.onClose} aria-label="Đóng">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {props.review.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] text-muted-foreground">Ảnh kết quả gửi kèm — gọi theo số (vd. “hình 2 mũ quá nhỏ”). Bấm để bỏ / thêm ảnh.</p>
          <div className="flex flex-wrap gap-1.5">
            {props.review.map((a) => {
              const n = shown.indexOf(a) + 1;
              return (
                <button
                  key={a.id}
                  onClick={() => setOff((cur) => {
                    const next = new Set(cur);
                    if (next.has(a.id)) next.delete(a.id);
                    else next.add(a.id);
                    return next;
                  })}
                  className={cx("relative h-20 w-20 overflow-hidden rounded border", n > 0 ? "border-sky-500" : "opacity-40")}
                  style={CHECKER_STYLE}
                  title={reviewLabel(a, props.materials)}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={a.url} alt={a.name} className="h-full w-full object-contain" />
                  {n > 0 && <span className="absolute left-0.5 top-0.5 rounded-full bg-black/80 px-1.5 text-[11px] font-bold leading-5 text-white">#{n}</span>}
                  <span className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 text-[9px] text-white">{a.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <RefNoteBox
        refs={refs}
        onRefs={setRefs}
        note={note}
        onNote={setNote}
        onError={setError}
        saved={refUrls}
        onRemoveSaved={(u) => setRefUrls((list) => list.filter((x) => x !== u))}
        max={4}
        placeholder="Chưa hài lòng chỗ nào? vd. hình 1, 3 mũ bảo hiểm quá nhỏ — phải cao ~1/3 xe; nét vẽ nhìn mờ, muốn viền đen dày hơn; acrylic bị đục, lỗ treo đè lên mũ. Thả thêm ảnh mẫu nếu có."
      />

      {error && <p className="text-xs text-destructive">{error}</p>}
      {agent.task && <AgentProgress task={agent.task} onCancel={agent.cancel} />}

      {plan && choice && (
        <div className="space-y-2">
          <div className="rounded-md border bg-background/60 p-2 text-xs leading-relaxed">
            <p className="mb-0.5 font-medium">Chẩn đoán</p>
            <p className="whitespace-pre-line">{plan.diagnosis}</p>
          </div>
          {plan.review && <ReviewBox review={plan.review} />}

          <LayerCard title="Spec chung" changed={plan.spec !== null} apply={choice.spec !== null} onApply={(on) => setChoice({ ...choice, spec: on ? (plan.spec?.text ?? null) : null })} why={plan.spec?.why ?? ""}>
            {plan.spec && (
              <>
                <SentenceDiff before={props.category.spec} after={choice.spec ?? plan.spec.text} />
                {choice.spec !== null && (
                  <details>
                    <summary className="cursor-pointer text-[11px] text-sky-600">Sửa tay spec mới</summary>
                    <CtTextarea rows={6} className="mt-1 text-xs" value={choice.spec} onChange={(e) => setChoice({ ...choice, spec: e.target.value })} />
                  </details>
                )}
              </>
            )}
          </LayerCard>

          <PresetCard title="Style pack" item={plan.style} choice={choice.style} onChoice={(style) => setChoice({ ...choice, style })} />
          {plan.materials.length === 0 && <LayerCard title="Vật liệu" changed={false} apply={false} onApply={() => undefined} why="" />}
          {plan.materials.map((m, i) => (
            <PresetCard
              key={`${m.currentId ?? "add"}-${i}`}
              title={m.currentId ? "Vật liệu" : "Vật liệu (thêm)"}
              item={m}
              choice={choice.materials[i]}
              onChoice={(c) => setChoice({ ...choice, materials: choice.materials.map((x, k) => (k === i ? c : x)) })}
            />
          ))}

          <LayerCard title="Chi tiết thành phẩm" changed={plan.details !== null} apply={choice.details} onApply={(details) => setChoice({ ...choice, details })} why={plan.details?.why ?? ""}>
            {plan.details && <DetailsDiff before={props.category.rules.details} after={plan.details.list} />}
          </LayerCard>

          {dropRefs.length > 0 && (
            <LayerCard title="Ảnh thành phẩm" changed apply={choice.dropRefs} onApply={(on) => setChoice({ ...choice, dropRefs: on })} why="Ảnh mâu thuẫn với chi tiết thành phẩm — model sẽ chép theo nó. Bỏ khỏi danh mục:">
              <div className="flex flex-wrap gap-1.5">
                {dropRefs.map((u) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={u} src={u} alt="" className="h-16 w-16 rounded border border-rose-500/50 object-cover" />
                ))}
              </div>
            </LayerCard>
          )}

          {refUrls.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              Ảnh bạn thêm sẽ lưu thành:
              {refUrls.map((u, i) => (
                <span key={u} className="inline-flex items-center gap-1 rounded border px-1 py-0.5">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={u} alt="" className="h-6 w-6 rounded object-cover" />
                  {ROLE_LABEL[plan.refRoles[i] ?? "none"]}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground">
          {plan ? `${changes} thay đổi được chọn. Áp dụng = lưu danh mục ngay (có lịch sử); style pack / vật liệu sửa chung sẽ đổi cả các danh mục đang dùng.` : "Chưa lưu gì cho tới khi bấm Áp dụng."}
        </span>
        <CtButton size="sm" className="ml-auto shrink-0" onClick={() => void check()} disabled={busy !== null} title="Đọc toàn bộ prompt như model ảnh nhận (spec + style + vật liệu + chi tiết + ảnh thành phẩm) → tìm chỗ mâu thuẫn và đề xuất sửa">
          {busy === "review" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
          {busy === "review" ? "Đang kiểm tra…" : "Kiểm tra prompt"}
        </CtButton>
        <CtButton size="sm" className="shrink-0" onClick={() => void analyse()} disabled={busy !== null || (!note.trim() && !shown.length && !refs.length && !refUrls.length)}>
          {busy === "analyse" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : plan ? <RefreshCw className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
          {busy === "analyse" ? "Đang phân tích…" : plan ? "Phân tích lại" : "Phân tích"}
        </CtButton>
        {plan && (
          <CtButton size="sm" variant="primary" className="shrink-0" onClick={() => void apply()} disabled={busy !== null || changes === 0}>
            {busy === "apply" && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Áp dụng & lưu
          </CtButton>
        )}
      </div>
    </div>
  );
}

function LayerCard(props: { title: string; changed: boolean; apply: boolean; onApply: (on: boolean) => void; why: string; children?: React.ReactNode }) {
  return (
    <div className={cx("space-y-1.5 rounded-md border p-2 text-xs", props.changed ? "border-amber-500/40 bg-amber-500/5" : "opacity-70")}>
      <div className="flex items-center gap-2">
        <span className="font-medium">{props.title}</span>
        {props.changed ? (
          <span className="ml-auto">
            <CtCheckbox checked={props.apply} onChange={props.onApply} label="Áp dụng" />
          </span>
        ) : (
          <span className="ml-auto text-[11px] text-muted-foreground">Giữ nguyên</span>
        )}
      </div>
      {props.why && <p className="text-[11px] text-muted-foreground">{props.why}</p>}
      {props.changed && props.children}
    </div>
  );
}

function PresetCard(props: { title: string; item: CtRevisePreset; choice: CtPresetChoice; onChoice: (c: CtPresetChoice) => void }) {
  const { item, choice } = props;
  const changed = item.action !== "keep";
  return (
    <LayerCard title={`${props.title}${item.name ? ` · ${item.name}` : ""}`} changed={changed} apply={choice.apply} onApply={(apply) => props.onChoice({ ...choice, apply })} why={item.why}>
      <p className="text-[11px] font-medium">
        {ACTION_LABEL[item.action]}
        {item.action === "switch" && ` “${item.name}” (có sẵn trong thư viện)`}
      </p>
      {item.action === "edit" && <SentenceDiff before={item.before} after={item.prompt} />}
      {(item.action === "new" || item.action === "switch") && <p className="line-clamp-4 whitespace-pre-line rounded border bg-background/60 p-1.5 text-[11px] text-muted-foreground">{item.prompt}</p>}
      {item.action === "edit" && item.usedByOthers.length > 0 && (
        <div className="flex flex-col gap-1 rounded border border-amber-500/40 p-1.5 text-[11px]">
          <span>Đang dùng chung với: {item.usedByOthers.join(", ")}</span>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={!choice.shared} onChange={() => props.onChoice({ ...choice, shared: false })} /> Tạo bản riêng cho danh mục này (các danh mục kia không đổi)
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={choice.shared} onChange={() => props.onChoice({ ...choice, shared: true })} /> Sửa bản chung (đổi cả {item.usedByOthers.length} danh mục kia)
          </label>
        </div>
      )}
    </LayerCard>
  );
}

const LAYER_LABEL: Record<CtPromptReview["issues"][number]["layer"], string> = { spec: "Spec", style: "Style pack", material: "Vật liệu", details: "Chi tiết", productRefs: "Ảnh thành phẩm" };

/** What the final check of the assembled prompts found; fixed ones are in the cards below. */
function ReviewBox({ review }: { review: CtPromptReview }) {
  return (
    <div className={cx("rounded-md border p-2 text-xs leading-relaxed", review.issues.length ? "border-amber-500/40 bg-amber-500/5" : "border-emerald-500/40 bg-emerald-500/5")}>
      <p className="mb-0.5 flex items-center gap-1 font-medium">
        <ShieldCheck className="h-3.5 w-3.5" /> Kiểm tra prompt {review.issues.length ? `— ${review.issues.length} vấn đề` : "— không thấy xung đột"}
      </p>
      {review.issues.map((i, k) => (
        <p key={k} className="text-[11px]">
          <span className={cx("mr-1 rounded px-1", i.severity === "high" ? "bg-rose-500/15 text-rose-600" : "bg-muted text-muted-foreground")}>
            {LAYER_LABEL[i.layer]}
            {i.target ? ` ${i.target}` : ""}
          </span>
          {i.problem}
          {i.fixed ? <span className="ml-1 text-emerald-600">→ đã đưa vào đề xuất bên dưới</span> : i.fix ? <span className="ml-1 text-muted-foreground">→ {i.fix}</span> : null}
        </p>
      ))}
    </div>
  );
}

function DetailsDiff({ before, after }: { before: CtMaterialSpec[]; after: CtMaterialSpec[] }) {
  const key = (d: CtMaterialSpec) => `${d.mode}|${d.label}|${d.text.trim()}`;
  const old = new Set(before.map(key));
  const next = new Set(after.map(key));
  const line = (d: CtMaterialSpec) => `${d.mode === "version" ? `Bản thêm “${d.label}”` : "Luôn có"}: ${d.text}`;
  return (
    <div className="space-y-0.5 rounded border bg-background/60 p-1.5 text-[11px] leading-snug">
      {before.filter((d) => !next.has(key(d))).map((d, i) => (
        <p key={`-${i}`} className="text-rose-500 line-through decoration-rose-500/60">− {line(d)}</p>
      ))}
      {after.map((d, i) => (
        <p key={`+${i}`} className={old.has(key(d)) ? "text-muted-foreground" : "text-emerald-600"}>
          {old.has(key(d)) ? "  " : "+ "}
          {line(d)}
        </p>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const TIME = new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short" });

const isRevision = (h: CtCategoryHistoryEntry): h is CtCategoryHistoryEntry & { result: CtCategoryRevision } => h.event === "revise";

/** How the category's prompts came to be: every AI revision (what was asked, what it found) and every save. */
export function CategoryHistory(props: { categoryId: string; onClose: () => void }) {
  const [history, setHistory] = useState<CtCategoryHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => {
    ctApi
      .categoryHistory(props.categoryId)
      .then(setHistory)
      .catch((e: Error) => setError(e.message));
  }, [props.categoryId]);

  /** The save before this one, for the spec diff. */
  const previousSave = (i: number) => (history ?? []).slice(i + 1).find((h) => h.event === "save") ?? null;

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <History className="h-3.5 w-3.5" /> Lịch sử chỉnh sửa
        <button className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent" onClick={props.onClose} aria-label="Đóng">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {history === null && !error && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      {history?.length === 0 && <p className="text-[11px] text-muted-foreground">Chưa có — lịch sử bắt đầu từ lần lưu / cập nhật bằng AI tiếp theo.</p>}
      <div className="max-h-80 space-y-1.5 overflow-y-auto">
        {history?.map((h, i) => {
          const more = expanded === h.id;
          const prev = h.event === "save" ? previousSave(i) : null;
          const r = isRevision(h) ? h.result : null;
          const changed = r
            ? [r.spec && "spec chung", r.style?.action !== "keep" && "style pack", r.materials?.some((m) => m.action !== "keep") && "vật liệu", r.details && "chi tiết thành phẩm"].filter(Boolean).join(", ")
            : "";
          return (
            <div key={h.id} className="space-y-1 rounded border p-2 text-[11px]">
              <button className="flex w-full items-center gap-1.5 text-left" onClick={() => setExpanded(more ? null : h.id)}>
                {more ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                <span className={cx("rounded px-1", h.event === "revise" ? "bg-sky-500/15 text-sky-600" : "bg-emerald-500/15 text-emerald-600")}>{h.event === "revise" ? "AI phân tích" : h.input.revision_id ? "Lưu (áp dụng AI)" : "Lưu"}</span>
                <span className="text-muted-foreground">{TIME.format(new Date(h.created_at))}</span>
                <span className="truncate">{h.event === "revise" ? h.note || "(không ghi chú)" : changed}</span>
                {r && <span className="ml-auto shrink-0 text-muted-foreground">{changed ? `đề xuất: ${changed}` : "không đổi gì"}</span>}
              </button>
              {more && r && (
                <div className="space-y-1 pl-4">
                  {h.image_urls.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {h.image_urls.map((u, k) => (
                        <a key={u} href={u} target="_blank" rel="noreferrer" className="relative block h-12 w-12 overflow-hidden rounded border" style={CHECKER_STYLE}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={u} alt="" className="h-full w-full object-contain" />
                          <span className="absolute left-0 top-0 rounded-br bg-black/70 px-0.5 text-[9px] text-white">#{k + 1}</span>
                        </a>
                      ))}
                      {h.ref_urls.map((u) => (
                        <a key={u} href={u} target="_blank" rel="noreferrer" className="block h-12 w-12 overflow-hidden rounded border border-sky-500/50">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={u} alt="" className="h-full w-full object-cover" />
                        </a>
                      ))}
                    </div>
                  )}
                  <p className="whitespace-pre-line">{r.diagnosis}</p>
                  {r.spec && <SentenceDiff before={h.input.spec ?? ""} after={r.spec.text} />}
                  {r.style && r.style.action !== "keep" && <p>Style pack: {ACTION_LABEL[r.style.action]} “{r.style.name}” — {r.style.why}</p>}
                  {r.materials?.filter((m) => m.action !== "keep").map((m, k) => (
                    <p key={k}>Vật liệu: {ACTION_LABEL[m.action]} “{m.name}” — {m.why}</p>
                  ))}
                  {r.details && <p>Chi tiết thành phẩm: {r.details.why}</p>}
                  <p className="text-muted-foreground">{h.model}</p>
                </div>
              )}
              {more && h.event === "save" && !isRevision(h) && "spec" in h.result && (
                <div className="space-y-1 pl-4">
                  {prev && "spec" in prev.result ? <SentenceDiff before={String(prev.result.spec ?? "")} after={String(h.result.spec ?? "")} /> : <p className="whitespace-pre-line text-muted-foreground">{String(h.result.spec ?? "")}</p>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
