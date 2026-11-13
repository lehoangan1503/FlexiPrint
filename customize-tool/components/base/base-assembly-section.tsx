"use client";

/**
 * Product base → "Ráp mảnh" (2026-11-12, lib/assembly + server/base-assembly.ts): a print sheet of sewn pieces
 * (Wearable Hooded Blanket, other garments) — the factory's khuôn as it is; the preview is sewn from it (hooded
 * blanket). Since 2026-11-13 the overflow rule is picked here (CtSheetOverflow): "wrap" (general) or "hood".
 */

import { useState } from "react";
import { ArrowLeftRight, Loader2, Scissors, X } from "lucide-react";
import type { CtBaseProduct, CtBaseProductConfig, CtSheetOverflow } from "../../types";
import type { CtPrintTemplate } from "../../types/print";
import { ctApi } from "../../lib/api-client";
import { CHECKER_STYLE, CtButton } from "../ui";

export function BaseAssemblySection(props: {
  baseId: string;
  cfg: CtBaseProductConfig;
  template: CtPrintTemplate | null;
  /** Unsaved changes on the page: reading needs the saved khuôn + phôi. */
  dirty: boolean;
  onDone: (base: CtBaseProduct, note: string) => void;
  onError: (message: string) => void;
}) {
  const { cfg, template } = props;
  const a = cfg.assembly;
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (label: string, body: { swap?: boolean; off?: boolean; overflow?: CtSheetOverflow }) => {
    setBusy(label);
    try {
      const r = await ctApi.baseAssembly(props.baseId, body);
      props.onDone(r.base, `${r.note}${r.reapplied ? ` · ${r.reapplied} sản phẩm cập nhật` : ""}`);
    } catch (e) {
      props.onError(e instanceof Error ? e.message : "Không đọc được mảnh");
    } finally {
      setBusy(null);
    }
  };
  const sheetGuide = template?.spec.faces[0]?.guideUrl ?? null;
  const ratio = template ? `${template.spec.width} / ${template.spec.height}` : "1 / 1";
  const off = props.dirty ? "Lưu thay đổi trước" : undefined;

  return (
    <div className="space-y-3 text-xs">
      <p className="text-muted-foreground">
        Tờ khuôn của xưởng gồm nhiều mảnh may (vd. thân + 2 mảnh nón + 2 túi) — khuôn giữ nguyên, không mảnh nào bị bỏ. Thiết kế và file in là chính tờ đó; trong editor kéo thả tự do. Xem trước ráp các mảnh lại như khi may (chăn có nón: ô thân → thân chăn, 2 mảnh nón → nón; túi không thấy khi nhìn từ sau).
      </p>
      {a ? (
        <>
          <div className="overflow-hidden rounded-md border" style={{ ...CHECKER_STYLE, aspectRatio: ratio }}>
            {sheetGuide && <img src={sheetGuide} alt="" className="h-full w-full object-contain" />}
          </div>
          <div className="space-y-1">
            <div className="font-medium">Phần layer tràn lên trên mép khuôn</div>
            {(
              [
                ["wrap", "Hiện ở dưới tờ, đúng vị trí ngang (chung mọi khuôn)", "Tràn qua mép trên bao nhiêu thì hiện lại từ mép dưới tờ lên bấy nhiêu, thẳng dưới chỗ nó tràn — rơi vào mảnh nào (nón, túi…) in ở mảnh đó, không ép vào mảnh nào."],
                ["hood", "Chăn có nón: dồn vào 2 mảnh nón", "Luật riêng của chăn có nón: phần tràn quanh giữa thân được dời xuống 2 mảnh nón (mỗi mảnh nửa nón), túi không nhận."],
              ] as const
            ).map(([value, label, hint]) => (
              <label key={value} className="flex items-start gap-2" title={hint}>
                <input
                  type="radio"
                  className="mt-0.5 accent-sky-500"
                  checked={a.overflow === value}
                  disabled={!!busy || props.dirty || (value === "hood" && a.kind !== "hooded-blanket")}
                  onChange={() => void run(value, { swap: a.swap, overflow: value })}
                />
                <span>
                  {label}
                  {busy === value && <Loader2 className="ml-1 inline h-3 w-3 animate-spin" />}
                  <span className="block text-muted-foreground">{hint}</span>
                </span>
              </label>
            ))}
          </div>
          <ul className="space-y-0.5">
            {a.pieces.map((p, i) => (
              <li key={i}>
                <span className="font-medium">{p.name}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · trên tờ ({Math.round(p.to.x)}, {Math.round(p.to.y)}) {Math.round(p.to.w)}×{Math.round(p.to.h)}
                  {p.role === "other" || a.kind !== "hooded-blanket" ? " · in theo tờ, không ráp lên ảnh xem trước" : ` → hiện trên sản phẩm ×${(p.from.w / p.to.w).toFixed(2)}`}
                </span>
              </li>
            ))}
          </ul>
          {a.kind === "hooded-blanket" && <p className="text-muted-foreground">
            {a.swap ? "Đã đổi: nửa trái nón (nhìn từ sau) ở mảnh nón bên trái." : "Nửa trái nón (nhìn từ sau) ở mảnh nón có góc cong bên phải — góc cong là đường may qua đỉnh đầu xuống gáy."} Vì vậy trên tờ in 2 vòm nằm ngược thứ tự so với nón thật (vòm trái tờ = nửa phải nón). Nếu mẫu may thật khác, bấm “Đổi nửa nón”.
          </p>}
          <div className="flex flex-wrap gap-2">
            {a.kind === "hooded-blanket" && <CtButton size="sm" variant="outline" disabled={!!busy || props.dirty} title={off} onClick={() => void run("swap", { swap: !a.swap })}>
              {busy === "swap" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowLeftRight className="h-3.5 w-3.5" />} Đổi nửa nón trái ↔ phải
            </CtButton>}
            <CtButton size="sm" variant="outline" disabled={!!busy || props.dirty} title={off} onClick={() => void run("read", { swap: a.swap })}>
              {busy === "read" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Scissors className="h-3.5 w-3.5" />} Đọc lại
            </CtButton>
            <CtButton size="sm" variant="ghost" disabled={!!busy || props.dirty} title={off} onClick={() => void run("off", { off: true })}>
              {busy === "off" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />} Bỏ ráp mảnh
            </CtButton>
          </div>
        </>
      ) : (
        <div className="flex items-center gap-2">
          <CtButton size="sm" variant="outline" disabled={!!busy || props.dirty || !template} title={off ?? (!template ? "Chọn khuôn in trước" : undefined)} onClick={() => void run("read", {})}>
            {busy === "read" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Scissors className="h-3.5 w-3.5" />} Đọc mảnh từ khuôn + phôi
          </CtButton>
          <span className="text-muted-foreground">Chưa ráp: file in = thiết kế nằm nguyên trên tờ khuôn.</span>
        </div>
      )}
    </div>
  );
}
