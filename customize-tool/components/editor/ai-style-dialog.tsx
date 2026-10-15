"use client";

/**
 * Create / edit one AI photo style of the global library. The prompt is the
 * main thing; every style runs on GPT Image 2.5 (no model picker). "Ảnh demo"
 * runs the saved style on a sample photo — the picture editors and customers
 * pick the style by. Read-only unless the user owns the style or is an admin
 * (the server enforces the same).
 */

import { useRef, useState } from "react";
import { ChevronDown, ChevronRight, ImagePlus, Loader2, Sparkles, Trash2 } from "lucide-react";
import type { CtAiStyle, CtAiStyleBody, CtAiStyleParams } from "../../types";
import { CT_AI_STYLE_DEFAULT_PARAMS, CT_AI_STYLE_MODEL } from "../../lib/ai-style-models";
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
  const [advanced, setAdvanced] = useState(false);
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
      const dirty = body.name !== editing.name || body.prompt !== editing.prompt || body.params.aspect !== editing.params.aspect || body.params.removeBackground !== editing.params.removeBackground;
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
        <CtField label="Prompt" hint="Gửi kèm ảnh khách làm ảnh tham chiếu. Chỉ server đọc prompt — khách và storefront không bao giờ thấy.">
          <CtTextarea value={body.prompt} disabled={readOnly} rows={9} maxLength={4000} className="font-mono text-xs leading-relaxed" onChange={(e) => setBody({ ...body, prompt: e.target.value })} />
        </CtField>

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
          {editing ? (
            !readOnly && (
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
            )
          ) : (
            <p className="text-[11px] text-muted-foreground">Tạo style xong, mở lại để tạo ảnh demo (khách chọn style theo ảnh này).</p>
          )}
        </div>

        <button type="button" className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground" onClick={() => setAdvanced((v) => !v)}>
          {advanced ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />} Nâng cao — khung ảnh, nền
        </button>
        {advanced && (
          <div className="space-y-3 rounded-md border p-3">
            <CtField label="Khung ảnh">
              <CtSelect<CtAiStyleParams["aspect"]>
                value={body.params.aspect}
                disabled={readOnly}
                onChange={(aspect) => setParams({ aspect })}
                options={[
                  { value: "1:1", label: "Vuông 1:1" },
                  { value: "auto", label: "Theo ảnh khách" },
                ]}
              />
            </CtField>
            <CtCheckbox
              checked={body.params.removeBackground}
              onChange={(v) => !readOnly && setParams({ removeBackground: v })}
              label="Tách nền kết quả AI"
              hint="Model vẽ thẳng trên nền trong suốt; nếu nó vẽ nền thì bg-remover tách — kể cả khi vùng không bật tách nền."
            />
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
              <CtButton size="sm" variant="primary" disabled={saving || !body.name.trim() || !body.prompt.trim()} onClick={save}>
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} {editing ? "Lưu" : "Tạo style"}
              </CtButton>
            )}
          </div>
        </div>
      </div>
    </CtModal>
  );
}
