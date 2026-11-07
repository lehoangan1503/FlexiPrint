"use client";

/**
 * Two parts of a product base page (2026-11-08: the base owns the physical piece, the artwork only the design):
 *
 *   Cắt + file in        fixed khuôn / along the art (+ border mm) / flat — and the silhouette in the print file
 *   Phôi / nền xem trước the photo the preview is drawn on: a phôi trơn (the sheet's box on it), or — cut along the
 *                        art — a background the clear plate made from the design is laid on
 *
 * Every artwork viewed on the base and every product made on it read these (lib/base-fit).
 */

import { useRef, useState } from "react";
import { ImageIcon, Loader2, Trash2, Upload } from "lucide-react";
import type { CtBaseCut, CtBaseCutMode, CtBaseProductConfig, CtProductScene } from "../../types";
import type { CtPrintTemplate } from "../../types/print";
import { printApi } from "../../lib/print-api";
import { CHECKER_STYLE, CtButton, CtField, CtInput, CtSelect } from "../ui";

const MODES: Array<{ value: CtBaseCutMode; label: string }> = [
  { value: "khuon", label: "Theo khuôn in cố định (tròn, vuông…)" },
  { value: "alpha", label: "Cắt theo viền thiết kế (acrylic)" },
  { value: "none", label: "In phẳng, không cắt (thú bông, áo)" },
];

export function BaseCutSection(props: { cfg: CtBaseProductConfig; template: CtPrintTemplate | null; onChange: (cut: CtBaseCut) => void }) {
  const { cut } = props.cfg;
  const set = (p: Partial<CtBaseCut>) => props.onChange({ ...cut, ...p });
  return (
    <div className="space-y-3 text-xs">
      <CtField label="Cách cắt">
        <CtSelect<CtBaseCutMode> value={cut.mode} onChange={(mode) => set({ mode })} options={MODES} />
      </CtField>
      {cut.mode === "khuon" && !props.template && <p className="text-amber-600">Chọn khuôn in ở mục “Khuôn in + phôi” — chưa có khuôn thì file in không cắt được.</p>}
      {cut.mode === "alpha" && (
        <CtField label="Viền acrylic quanh thiết kế (mm)">
          <CtInput className="h-8 w-28" inputMode="decimal" value={String(cut.borderMm)} onChange={(e) => set({ borderMm: Math.max(0, Math.min(20, Number(e.target.value) || 0)) })} />
        </CtField>
      )}
      <label className="flex items-center gap-2">
        <input type="checkbox" className="accent-sky-500" checked={cut.silhouette} onChange={(e) => set({ silhouette: e.target.checked })} />
        File in có silhouette full đen ở nửa trên (1 file cao gấp đôi — kiểu Merchize acrylic trên Teeinblue)
      </label>
      {cut.mode === "alpha" && cut.silhouette && (
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2">
            <input type="checkbox" className="accent-sky-500" checked={cut.hole} onChange={(e) => set({ hole: e.target.checked })} />
            Tai treo có lỗ ở mép trên
          </label>
          {cut.hole && (
            <label className="flex items-center gap-1.5 text-muted-foreground">
              Cỡ tai
              <CtInput className="h-7 w-16" inputMode="decimal" value={String(cut.holeSize)} onChange={(e) => set({ holeSize: Math.max(3, Math.min(30, Number(e.target.value) || 9)) })} />% bề rộng
            </label>
          )}
        </div>
      )}
      <p className="text-muted-foreground">
        {cut.mode === "khuon"
          ? "Mọi artwork xem trên base này được đặt vào khuôn: file in cắt theo đường khuôn, silhouette = hình khuôn."
          : cut.mode === "alpha"
            ? "Mỗi version tự có đường cắt + silhouette theo chính hình thiết kế (không vẽ tay từng version như Teeinblue)."
            : "File in = nguyên canvas artwork, không đường cắt."}
      </p>
    </div>
  );
}

/** The design's box on a photo: the middle `share` of its shorter side, `aspect` = width / height. */
function boxFor(width: number, height: number, aspect: number, share: number, cx: number, cy: number): CtProductScene["box"] {
  const side = Math.min(width, height) * share;
  const w = aspect >= 1 ? side : side * aspect;
  const h = aspect >= 1 ? side / aspect : side;
  return { x: cx * width - w / 2, y: cy * height - h / 2, w, h };
}

export function BasePreviewSection(props: { cfg: CtBaseProductConfig; template: CtPrintTemplate | null; onChange: (preview: CtProductScene) => void }) {
  const { preview, cut } = props.cfg;
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = props.cfg.printAreas[0];
  const sheet = props.template?.spec ?? (area ? { width: area.width, height: area.height } : { width: 1000, height: 1000 });
  const aspect = sheet.width / sheet.height;
  const blank = cut.mode === "khuon" ? props.template?.spec.blanks[0] : undefined;
  // What the preview uses now: the base's own photo, else (a khuôn) its first phôi.
  const shown = preview.url ? preview : blank ? { url: blank.url, width: blank.width, height: blank.height, box: blank.box } : null;
  const share = preview.url ? Math.max(preview.box.w, preview.box.h) / Math.min(preview.width, preview.height) : 0.7;
  const cx = preview.url ? (preview.box.x + preview.box.w / 2) / preview.width : 0.5;
  const cy = preview.url ? (preview.box.y + preview.box.h / 2) / preview.height : 0.5;

  const upload = async (f: File) => {
    setBusy(true);
    setError(null);
    try {
      const r = await printApi.uploadImage(f);
      props.onChange({ url: r.url, width: r.width, height: r.height, box: boxFor(r.width, r.height, aspect, 0.7, 0.5, 0.5) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tải được ảnh");
    } finally {
      setBusy(false);
    }
  };
  const move = (p: { share?: number; cx?: number; cy?: number }) => {
    if (!preview.url) return;
    props.onChange({ ...preview, box: boxFor(preview.width, preview.height, aspect, p.share ?? share, p.cx ?? cx, p.cy ?? cy) });
  };
  const slider = (label: string, v: number, min: number, max: number, on: (n: number) => void) => (
    <label className="flex items-center gap-1.5">
      <span className="w-20 text-muted-foreground">{label}</span>
      <input type="range" min={min} max={max} step={0.01} value={v} onChange={(e) => on(Number(e.target.value))} className="w-32 accent-sky-500" />
      <span className="w-10 tabular-nums">{Math.round(v * 100)}%</span>
    </label>
  );

  return (
    <div className="space-y-3 text-xs">
      <p className="text-muted-foreground">
        {cut.mode === "alpha"
          ? "Ảnh nền (cây thông, bàn…) — khi xem trước, thiết kế được đặt vào khung xanh và tự có tấm acrylic trong + viền sáng + bóng đổ theo đúng hình của từng version."
          : "Ảnh phôi trơn (sản phẩm trống) — khung xanh = chỗ tờ in nằm trên ảnh. Không đặt ảnh riêng thì dùng phôi đầu tiên của khuôn in."}
      </p>
      <div className="flex gap-3">
        <div className="relative w-56 shrink-0 overflow-hidden rounded-lg border" style={CHECKER_STYLE}>
          {shown?.url ? (
            <div className="relative" style={{ aspectRatio: `${shown.width} / ${shown.height}` }}>
              <img src={shown.url} alt="Nền xem trước" className="absolute inset-0 h-full w-full" />
              <div
                className="absolute border-2 border-dashed border-sky-400"
                style={{
                  left: `${(shown.box.x / shown.width) * 100}%`,
                  top: `${(shown.box.y / shown.height) * 100}%`,
                  width: `${(shown.box.w / shown.width) * 100}%`,
                  height: `${(shown.box.h / shown.height) * 100}%`,
                }}
              />
            </div>
          ) : (
            <div className="flex aspect-square flex-col items-center justify-center gap-1 text-muted-foreground">
              <ImageIcon className="h-6 w-6 opacity-50" />
              Chưa có ảnh
            </div>
          )}
        </div>
        <div className="space-y-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void upload(f);
            }}
          />
          <div className="flex gap-2">
            <CtButton size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} {preview.url ? "Đổi ảnh" : cut.mode === "alpha" ? "Tải ảnh nền" : "Tải ảnh phôi riêng"}
            </CtButton>
            {preview.url && (
              <CtButton size="sm" variant="ghost" onClick={() => props.onChange({ url: null, width: 0, height: 0, box: { x: 0, y: 0, w: 0, h: 0 } })}>
                <Trash2 className="h-3.5 w-3.5" /> Bỏ
              </CtButton>
            )}
          </div>
          {preview.url ? (
            <div className="space-y-1">
              {slider("Cỡ thiết kế", share, 0.2, 1, (v) => move({ share: v }))}
              {slider("Ngang", cx, 0, 1, (v) => move({ cx: v }))}
              {slider("Dọc", cy, 0, 1, (v) => move({ cy: v }))}
            </div>
          ) : blank ? (
            <p className="text-muted-foreground">Đang dùng phôi đầu tiên của khuôn “{props.template?.name}”.</p>
          ) : (
            <p className="text-amber-600">Chưa có — xem trước sẽ chỉ là thiết kế trơn.</p>
          )}
          {error && <p className="text-destructive">{error}</p>}
        </div>
      </div>
    </div>
  );
}
