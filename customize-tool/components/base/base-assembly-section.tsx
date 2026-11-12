"use client";

/**
 * Product base → "Ráp mảnh (nón + thân)" (2026-11-12, lib/assembly + server/base-assembly.ts): a print sheet of sewn
 * pieces (Wearable Hooded Blanket) — the design is the product as the preview shows it, the file in takes from it
 * what each piece shows. Two pictures: the khuôn's lines where the pieces show on the design, and the sheet itself.
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
        Tờ khuôn gồm nhiều mảnh may lại (thân + 2 mảnh nón + túi). Thiết kế = sản phẩm như trên preview (nón nằm trên mép thân); file in tự lấy phần preview hiện trên nón đặt vào 2 mảnh nón, phần hiện trên thân chăn đặt vào ô thân. Túi + vùng dư giữ thiết kế nằm tại chỗ.
      </p>
      {a ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <figure className="space-y-1">
              <div className="overflow-hidden rounded-md border" style={{ ...CHECKER_STYLE, aspectRatio: ratio }}>
                {a.guideUrl && <img src={a.guideUrl} alt="" className="h-full w-full object-contain" />}
              </div>
              <figcaption className="text-center text-muted-foreground">Trên thiết kế (như preview)</figcaption>
            </figure>
            <figure className="space-y-1">
              <div className="overflow-hidden rounded-md border" style={{ ...CHECKER_STYLE, aspectRatio: ratio }}>
                {sheetGuide && <img src={sheetGuide} alt="" className="h-full w-full object-contain" />}
              </div>
              <figcaption className="text-center text-muted-foreground">Trên tờ in gửi nhà in</figcaption>
            </figure>
          </div>
          <ul className="space-y-0.5">
            {a.pieces.map((p, i) => (
              <li key={i}>
                <span className="font-medium">{p.name}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · thiết kế {Math.round(p.from.w)}×{Math.round(p.from.h)} tại ({Math.round(p.from.x)}, {Math.round(p.from.y)}) → tờ in ({Math.round(p.to.x)}, {Math.round(p.to.y)}) ×{(p.to.w / p.from.w).toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground">{a.swap ? "Nửa trái của nón in ở mảnh nón bên phải (đã đổi)." : "Nửa trái của nón in ở mảnh nón bên trái."} Nếu mẫu may thật bị ngược, bấm “Đổi nửa nón”.</p>
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
