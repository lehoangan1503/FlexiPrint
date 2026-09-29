"use client";

/**
 * Create / edit one AI photo style of the global library. The prompt is the
 * main thing; "Nâng cao" holds the model and its params. Read-only unless the
 * user owns the style or is an admin (the server enforces the same).
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Trash2 } from "lucide-react";
import type { CtAiStyle, CtAiStyleBody, CtAiStyleModelId, CtAiStyleParams } from "../../types";
import { CT_AI_STYLE_DEFAULT_MODEL, CT_AI_STYLE_DEFAULT_PARAMS, CT_AI_STYLE_MODELS, aiStyleModel } from "../../lib/ai-style-models";
import { ctApi } from "../../lib/api-client";
import { CtButton, CtCheckbox, CtField, CtInput, CtModal, CtSelect, CtTextarea } from "../ui";
import { dropAiStyle, putAiStyle } from "./ai-styles-store";

export interface AiStyleDialogProps {
  /** Render with key={target id | "new"} so the form resets per style. null = closed; "new" = create; a style = edit (or view). */
  target: CtAiStyle | "new" | null;
  onClose: () => void;
  onSaved?: (style: CtAiStyle) => void;
}

const EMPTY: CtAiStyleBody = { name: "", prompt: "", model: CT_AI_STYLE_DEFAULT_MODEL, params: { ...CT_AI_STYLE_DEFAULT_PARAMS } };

export function AiStyleDialog({ target, onClose, onSaved }: AiStyleDialogProps) {
  // Mounted with key = target (see the caller), so this initial state is per style.
  const [body, setBody] = useState<CtAiStyleBody>(() =>
    target && target !== "new" ? { name: target.name, prompt: target.prompt, model: target.model, params: { ...target.params } } : { ...EMPTY, params: { ...CT_AI_STYLE_DEFAULT_PARAMS } },
  );
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = target && target !== "new" ? target : null;
  const readOnly = editing !== null && !editing.can_edit;

  const setParams = (patch: Partial<CtAiStyleParams>) => setBody((b) => ({ ...b, params: { ...b.params, ...patch } }));
  const model = aiStyleModel(body.model);

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
    if (!editing || !window.confirm(`Xoá style "${editing.name}"? Vùng ảnh đang dùng style này sẽ không còn hiện nó cho khách.`)) return;
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

        <button type="button" className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground" onClick={() => setAdvanced((v) => !v)}>
          {advanced ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />} Nâng cao — model, chất lượng, nền
        </button>
        {advanced && (
          <div className="space-y-3 rounded-md border p-3">
            <CtField label="Model (fal.ai)" hint={model.price}>
              <CtSelect<CtAiStyleModelId>
                value={body.model}
                disabled={readOnly}
                onChange={(m) => setBody({ ...body, model: m })}
                options={CT_AI_STYLE_MODELS.map((m) => ({ value: m.id, label: m.label }))}
              />
            </CtField>
            <div className="grid grid-cols-2 gap-2">
              {model.uses.includes("resolution") && (
                <CtField label="Độ phân giải">
                  <CtSelect<CtAiStyleParams["resolution"]>
                    value={body.params.resolution}
                    disabled={readOnly}
                    onChange={(resolution) => setParams({ resolution })}
                    options={[
                      { value: "0.5K", label: "0.5K — rẻ nhất, chỉ xem trước" },
                      { value: "1K", label: "1K — như shop mẫu" },
                      { value: "2K", label: "2K — in khổ lớn" },
                    ]}
                  />
                </CtField>
              )}
              {model.uses.includes("quality") && (
                <CtField label="Chất lượng">
                  <CtSelect<CtAiStyleParams["quality"]>
                    value={body.params.quality}
                    disabled={readOnly}
                    onChange={(quality) => setParams({ quality })}
                    options={[
                      { value: "low", label: "Low" },
                      { value: "medium", label: "Medium" },
                      { value: "high", label: "High (đắt)" },
                    ]}
                  />
                </CtField>
              )}
              {model.uses.includes("aspect") && (
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
              )}
              <CtField label="Định dạng">
                <CtSelect<CtAiStyleParams["outputFormat"]>
                  value={body.params.outputFormat}
                  disabled={readOnly}
                  onChange={(outputFormat) => setParams({ outputFormat })}
                  options={[
                    { value: "png", label: "PNG" },
                    { value: "jpeg", label: "JPEG (nhẹ hơn)" },
                  ]}
                />
              </CtField>
            </div>
            <CtCheckbox
              checked={body.params.whiteBackground}
              onChange={(v) => !readOnly && setParams({ whiteBackground: v })}
              label="Vẽ trên nền trắng"
              hint="Thêm câu 'nền trắng tinh' vào cuối prompt — tách nền sạch hơn (shop mẫu: keepWhiteBg)."
            />
            <CtCheckbox
              checked={body.params.removeBackground}
              onChange={(v) => !readOnly && setParams({ removeBackground: v })}
              label="Tách nền kết quả AI"
              hint="Chạy bg-remover trên ảnh AI trả về, kể cả khi vùng không bật tách nền (shop mẫu: removeAIBg)."
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
