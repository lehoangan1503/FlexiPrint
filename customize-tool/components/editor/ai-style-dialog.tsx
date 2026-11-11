"use client";

/**
 * Create / edit one AI photo style of the global library. The prompt is the
 * main thing, with up to 4 style reference pictures sent after the customer's photo on every run (asked
 * 2026-11-04); every style runs on GPT Image 2.5 (no model picker). 2026-11-11: output ratio (3:2, 16:9, 2:1…), "keep the
 * whole frame" (no trim) and "the customer's name at the end of the prompt" are back as plain fields. Frame / background stay on their defaults
 * (square, cut out — the "Nâng cao" section was removed 2026-11-04). "Ảnh demo"
 * (only when editing — hidden when adding a new style, 2026-11-04) runs the saved style on a sample photo — the picture editors and customers
 * pick the style by. "Ảnh thumbnail" (asked 2026-11-10) is an uploaded picture shown on the customer's style tile
 * instead of the demo. "Remove background" (ticked by default, 2026-11-10) adds CT_AI_STYLE_CLEAR_BG_LINE at the end
 * of the prompt when the style runs (server/ai/style-run.ts). Read-only unless the user owns the style or is an admin
 * (the server enforces the same).
 */

import { useRef, useState } from "react";
import { ImagePlus, Loader2, Sparkles, Trash2, X } from "lucide-react";
import type { CtAiStyle, CtAiStyleAspect, CtAiStyleBody, CtAiStyleParams } from "../../types";
import { CT_AI_STYLE_ASPECTS, CT_AI_STYLE_CLEAR_BG_LINE, CT_AI_STYLE_DEFAULT_PARAMS, CT_AI_STYLE_MAX_REFS, CT_AI_STYLE_MODEL, CT_AI_STYLE_PROMPT_MAX, aiStyleAspectLine } from "../../lib/ai-style-models";
import { imageModelLabel } from "../../lib/image-models";
import { ctApi } from "../../lib/api-client";
import { CtButton, CtCheckbox, CtField, CtInput, CtModal, CtSelect, CtTextarea } from "../ui";
import { dropAiStyle, putAiStyle } from "./ai-styles-store";
import { ctConfirm } from "../dialogs";

export interface AiStyleDialogProps {
  /** Render with key={target id | "new"} so the form resets per style. null = closed; "new" = create; a style = edit (or view). */
  target: CtAiStyle | "new" | null;
  onClose: () => void;
  onSaved?: (style: CtAiStyle) => void;
}

const EMPTY: CtAiStyleBody = { name: "", prompt: "", model: CT_AI_STYLE_MODEL, params: { ...CT_AI_STYLE_DEFAULT_PARAMS } };

export function AiStyleDialog({ target, onClose, onSaved }: AiStyleDialogProps) {
  // Mounted with key = target (see the caller), so this initial state is per style.
  const [body, setBody] = useState<CtAiStyleBody>(() =>
    target && target !== "new" ? { name: target.name, prompt: target.prompt, model: target.model, params: { ...target.params } } : { ...EMPTY, params: { ...CT_AI_STYLE_DEFAULT_PARAMS } },
  );
  const [refBusy, setRefBusy] = useState(false);
  const refInput = useRef<HTMLInputElement>(null);
  const [thumbBusy, setThumbBusy] = useState(false);
  const thumbInput = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  const sampleInput = useRef<HTMLInputElement>(null);
  const editing = target && target !== "new" ? target : null;
  const readOnly = editing !== null && !editing.can_edit;

  const setParams = (patch: Partial<CtAiStyleParams>) => setBody((b) => ({ ...b, params: { ...b.params, ...patch } }));

  // The demo runs the SAVED style (server side): unsaved prompt edits are saved first.
  const makeDemo = async (sample?: File) => {
    if (!editing) return;
    setDemoBusy(true);
    setError(null);
    try {
      const dirty =
        body.name !== editing.name ||
        body.prompt !== editing.prompt ||
        body.params.removeBackground !== editing.params.removeBackground ||
        body.params.aspect !== editing.params.aspect ||
        body.params.keepFrame !== editing.params.keepFrame ||
        body.params.askName !== editing.params.askName ||
        body.params.thumbUrl !== editing.params.thumbUrl ||
        body.params.refUrls.join("|") !== editing.params.refUrls.join("|");
      if (dirty) putAiStyle(await ctApi.updateAiStyle(editing.id, body));
      const style = await ctApi.makeAiStyleDemo(editing.id, sample);
      putAiStyle(style);
      setBody((b) => ({ ...b, params: { ...b.params, demoUrl: style.params.demoUrl, demoSourceUrl: style.params.demoSourceUrl } }));
      onSaved?.(style);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tạo được ảnh demo");
    } finally {
      setDemoBusy(false);
    }
  };

  const addRefs = async (list: FileList | null) => {
    const room = CT_AI_STYLE_MAX_REFS - body.params.refUrls.length;
    const files = [...(list ?? [])].filter((f) => f.type.startsWith("image/")).slice(0, room);
    if (!files.length) return;
    setRefBusy(true);
    setError(null);
    try {
      const urls = await ctApi.uploadAiStyleRefs(files);
      setBody((b) => ({ ...b, params: { ...b.params, refUrls: [...b.params.refUrls, ...urls].slice(0, CT_AI_STYLE_MAX_REFS) } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tải được ảnh tham chiếu");
    } finally {
      setRefBusy(false);
    }
  };

  const setThumb = async (file: File | undefined) => {
    if (!file || !file.type.startsWith("image/")) return;
    setThumbBusy(true);
    setError(null);
    try {
      const [url] = await ctApi.uploadAiStyleRefs([file]);
      if (url) setParams({ thumbUrl: url });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tải được ảnh thumbnail");
    } finally {
      setThumbBusy(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const style = editing ? await ctApi.updateAiStyle(editing.id, body) : await ctApi.createAiStyle(body);
      putAiStyle(style);
      onSaved?.(style);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lưu thất bại");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!editing) return;
    const ok = await ctConfirm({ title: `Xoá style “${editing.name}”?`, message: "Vùng ảnh đang dùng style này sẽ không còn hiện nó cho khách.", tone: "danger", confirmLabel: "Xoá" });
    if (!ok) return;
    setSaving(true);
    try {
      await ctApi.deleteAiStyle(editing.id);
      dropAiStyle(editing.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Xoá thất bại");
    } finally {
      setSaving(false);
    }
  };

  return (
    <CtModal open={target !== null} onOpenChange={(o) => !o && onClose()} title={editing ? (readOnly ? `Style: ${editing.name}` : `Sửa style: ${editing.name}`) : "Thêm style AI"}>
      <div className="space-y-3">
        {editing && (
          <p className="text-[11px] text-muted-foreground">
            Tạo bởi <span className="font-medium text-foreground">{editing.owner}</span>
            {readOnly ? " — chỉ người tạo hoặc admin được sửa." : ""}
          </p>
        )}
        <CtField label="Tên hiển thị cho khách">
          <CtInput value={body.name} disabled={readOnly} maxLength={80} placeholder="Watercolor + Ink" onChange={(e) => setBody({ ...body, name: e.target.value })} />
        </CtField>
        <CtField label={`Prompt (${body.prompt.length}/${CT_AI_STYLE_PROMPT_MAX})`} hint="Khi khách upload ảnh, AI nhận: ảnh khách + ảnh tham chiếu bên dưới + prompt này. Khách không thấy prompt.">
          <CtTextarea value={body.prompt} disabled={readOnly} rows={8} maxLength={CT_AI_STYLE_PROMPT_MAX} className="font-mono text-xs leading-relaxed" onChange={(e) => setBody({ ...body, prompt: e.target.value })} />
        </CtField>
        <div className="space-y-1">
          <CtCheckbox checked={body.params.removeBackground} disabled={readOnly} onChange={(v) => setParams({ removeBackground: v })} label="Remove background" />
          {body.params.removeBackground && (
            <p className="pl-6 font-mono text-[10px] leading-snug text-muted-foreground">Thêm vào cuối prompt: “{CT_AI_STYLE_CLEAR_BG_LINE}”</p>
          )}
        </div>
        <CtField label="Tỉ lệ ảnh AI" hint="Chọn đúng tỉ lệ vùng artwork / file in mà ảnh sẽ lấp. Tỉ lệ được ghi vào prompt, ảnh trả về được bù nền trong suốt cho khớp tỉ lệ.">
          <div className="space-y-1">
            <CtSelect<CtAiStyleAspect>
              value={body.params.aspect}
              disabled={readOnly}
              onChange={(v) => setParams({ aspect: v })}
              options={CT_AI_STYLE_ASPECTS.map((a) => ({ value: a.id, label: a.label }))}
            />
            {aiStyleAspectLine(body.params.aspect) && <p className="font-mono text-[10px] leading-snug text-muted-foreground">Thêm vào cuối prompt: “{aiStyleAspectLine(body.params.aspect)}”</p>}
          </div>
        </CtField>
        <div className="space-y-1">
          <CtCheckbox checked={body.params.keepFrame} disabled={readOnly} onChange={(v) => setParams({ keepFrame: v })} label="Giữ nguyên khung ảnh (không cắt sát hình)" />
          <p className="pl-6 text-[10px] leading-snug text-muted-foreground">Ảnh đặt vào vùng đúng như AI vẽ — vd mặt trước + mặt sau búp bê nằm đúng 2 vùng in.</p>
        </div>
        <div className="space-y-1">
          <CtCheckbox checked={body.params.askName} disabled={readOnly} onChange={(v) => setParams({ askName: v })} label="Cho khách nhập tên, ghép vào cuối prompt" />
          <p className="pl-6 font-mono text-[10px] leading-snug text-muted-foreground">«Name: …» — khách không nhập tên thì không ghép.</p>
        </div>
        <CtField label={`Ảnh tham chiếu (tối đa ${CT_AI_STYLE_MAX_REFS})`}>
          <div className="flex flex-wrap gap-2">
            {body.params.refUrls.map((u) => (
              <div key={u} className="group relative h-16 w-16 overflow-hidden rounded border bg-[repeating-conic-gradient(#f1f1f1_0_25%,#fff_0_50%)] bg-[length:12px_12px]">
                <img src={u} alt="" className="h-full w-full object-contain" />
                {!readOnly && (
                  <button
                    type="button"
                    title="Bỏ ảnh này"
                    className="absolute right-0.5 top-0.5 hidden rounded-full bg-black/60 p-0.5 text-white group-hover:block"
                    onClick={() => setParams({ refUrls: body.params.refUrls.filter((x) => x !== u) })}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
            {!readOnly && body.params.refUrls.length < CT_AI_STYLE_MAX_REFS && (
              <button
                type="button"
                title="Thêm ảnh tham chiếu"
                disabled={refBusy}
                className="flex h-16 w-16 items-center justify-center rounded border border-dashed text-muted-foreground hover:bg-accent"
                onClick={() => refInput.current?.click()}
              >
                {refBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
              </button>
            )}
            {readOnly && body.params.refUrls.length === 0 && <span className="text-[11px] text-muted-foreground">Không có</span>}
            <input
              ref={refInput}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const list = e.target.files;
                void addRefs(list).finally(() => {
                  if (refInput.current) refInput.current.value = "";
                });
              }}
            />
          </div>
        </CtField>

        <CtField label="Ảnh thumbnail cho khách" hint="Hiện ở ô chọn style cho khách (thay ảnh demo). Để trống = dùng ảnh demo.">
          <div className="flex items-center gap-2">
            <div className="group relative flex h-16 w-16 items-center justify-center overflow-hidden rounded border bg-[repeating-conic-gradient(#f1f1f1_0_25%,#fff_0_50%)] bg-[length:12px_12px]">
              {body.params.thumbUrl ? (
                <img src={body.params.thumbUrl} alt="" className="h-full w-full object-contain" />
              ) : body.params.demoUrl ? (
                <img src={body.params.demoUrl} alt="" className="h-full w-full object-contain opacity-40" />
              ) : (
                <span className="text-[9px] text-muted-foreground">chưa có</span>
              )}
              {!readOnly && body.params.thumbUrl && (
                <button
                  type="button"
                  title="Bỏ thumbnail (dùng ảnh demo)"
                  className="absolute right-0.5 top-0.5 hidden rounded-full bg-black/60 p-0.5 text-white group-hover:block"
                  onClick={() => setParams({ thumbUrl: "" })}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            {!readOnly && (
              <CtButton size="sm" variant="ghost" disabled={thumbBusy} onClick={() => thumbInput.current?.click()}>
                {thumbBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />} {body.params.thumbUrl ? "Đổi ảnh" : "Upload thumbnail"}
              </CtButton>
            )}
            {readOnly && !body.params.thumbUrl && <span className="text-[11px] text-muted-foreground">Dùng ảnh demo</span>}
            <input
              ref={thumbInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                void setThumb(f);
              }}
            />
          </div>
        </CtField>

        {editing && (
        <div className="space-y-1.5 rounded-md border p-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">Ảnh demo</span>
            <span className="text-[10px] text-muted-foreground">{imageModelLabel(CT_AI_STYLE_MODEL)} · ~30–60 s</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {[
              { url: body.params.demoSourceUrl, label: "Ảnh mẫu" },
              { url: body.params.demoUrl, label: "Kết quả" },
            ].map((x) => (
              <div key={x.label} className="space-y-0.5">
                <div className="flex aspect-square items-center justify-center overflow-hidden rounded border bg-[repeating-conic-gradient(#f1f1f1_0_25%,#fff_0_50%)] bg-[length:16px_16px]">
                  {x.url ? <img src={x.url} alt={x.label} className="h-full w-full object-contain" /> : <span className="text-[10px] text-muted-foreground">chưa có</span>}
                </div>
                <div className="text-center text-[10px] text-muted-foreground">{x.label}</div>
              </div>
            ))}
          </div>
          {!readOnly && (
              <div className="flex flex-wrap gap-1">
                <CtButton size="sm" variant="primary" disabled={demoBusy || saving || !body.prompt.trim()} onClick={() => makeDemo()}>
                  {demoBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} Tạo ảnh demo
                </CtButton>
                <CtButton size="sm" variant="ghost" disabled={demoBusy || saving} onClick={() => sampleInput.current?.click()}>
                  <ImagePlus className="h-3.5 w-3.5" /> Demo với ảnh của tôi
                </CtButton>
                <input
                  ref={sampleInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) void makeDemo(f);
                  }}
                />
              </div>
          )}
        </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex items-center justify-between pt-1">
          <div>
            {editing?.can_edit && (
              <CtButton size="sm" variant="ghost" disabled={saving} onClick={remove}>
                <Trash2 className="h-3.5 w-3.5" /> Xoá
              </CtButton>
            )}
          </div>
          <div className="flex gap-2">
            <CtButton size="sm" variant="ghost" onClick={onClose}>
              {readOnly ? "Đóng" : "Huỷ"}
            </CtButton>
            {!readOnly && (
              <CtButton size="sm" variant="primary" disabled={saving || refBusy || thumbBusy || !body.name.trim() || !body.prompt.trim()} onClick={save}>
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} {editing ? "Lưu" : "Tạo style"}
              </CtButton>
            )}
          </div>
        </div>
      </div>
    </CtModal>
  );
}
