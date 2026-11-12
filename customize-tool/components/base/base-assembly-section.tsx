"use client";

/**
 * Product base → "Ráp mảnh (nón + thân)" (2026-11-12, lib/assembly + server/base-assembly.ts): a print sheet of sewn
 * pieces (Wearable Hooded Blanket) — the factory's khuôn as it is; the preview is sewn from it.
 */

import { useState } from "react";
import { ArrowLeftRight, Loader2, Scissors, X } from "lucide-react";
import type { CtBaseProduct, CtBaseProductConfig } from "../../types";
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
  const run = async (label: string, body: { swap?: boolean; off?: boolean }) => {
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
        Tờ khuôn của xưởng gồm nhiều mảnh may (thân + 2 mảnh nón + túi) — khuôn giữ nguyên. Thiết kế và file in là chính tờ đó; xem trước ráp các mảnh lại như khi may (ô thân → thân chăn, 2 mảnh nón → nón). Trong editor, “Cắt artwork theo khuôn” cắt clipart nằm trên nón xuống 2 mảnh nón.
      </p>
      {a ? (
        <>
          <div className="overflow-hidden rounded-md border" style={{ ...CHECKER_STYLE, aspectRatio: ratio }}>
            {sheetGuide && <img src={sheetGuide} alt="" className="h-full w-full object-contain" />}
          </div>
          <ul className="space-y-0.5">
            {a.pieces.map((p, i) => (
              <li key={i}>
                <span className="font-medium">{p.name}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · trên tờ ({Math.round(p.to.x)}, {Math.round(p.to.y)}) {Math.round(p.to.w)}×{Math.round(p.to.h)} → hiện trên sản phẩm ×{(p.from.w / p.to.w).toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground">
            {a.swap ? "Đã đổi: nửa trái nón (nhìn từ sau) ở mảnh nón bên trái." : "Nửa trái nón (nhìn từ sau) ở mảnh nón có góc cong bên phải — góc cong là đường may qua đỉnh đầu xuống gáy."} Nếu mẫu may thật ngược, bấm “Đổi nửa nón”.
          </p>
          <div className="flex flex-wrap gap-2">
            <CtButton size="sm" variant="outline" disabled={!!busy || props.dirty} title={off} onClick={() => void run("swap", { swap: !a.swap })}>
              {busy === "swap" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowLeftRight className="h-3.5 w-3.5" />} Đổi nửa nón trái ↔ phải
            </CtButton>
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
