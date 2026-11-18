"use client";

/**
 * The base page's "Prompt mockup" section (asked 2026-11-17: the mockup prompts out of the code, one set per product
 * base): the scene prompts, the sentence wrapped around each one, and the reference pictures for the setting. Saved
 * with the page's Lưu (CtBaseProductConfig.mockup). Empty = empty (asked 2026-11-18): a mockup with no wrap / no scene
 * is refused; the sample texts are only pasted into a box when its button is pressed.
 */

import { useRef, useState } from "react";
import { ImagePlus, Loader2, X } from "lucide-react";
import type { CtBaseMockup, CtBaseProductConfig } from "../../types";
import type { CtPrintTemplate } from "../../types/print";
import { ctApi } from "../../lib/api-client";
import { defaultScenes, splitScenes } from "../../lib/mockup-scenes";
import { CT_MOCKUP_REFS_MAX, defaultMockupWrap } from "../../lib/mockup-prompt";
import { CtButton, CtField, CtTextarea } from "../ui";
import { ZoomThumbs } from "../zoom-thumbs";

export function BaseMockupSection({
  name,
  cfg,
  template,
  onChange,
}: {
  name: string;
  cfg: CtBaseProductConfig;
  template: CtPrintTemplate | null;
  onChange: (mockup: CtBaseMockup) => void;
}) {
  const m = cfg.mockup;
  const piece = template?.name || name;

  // The look the default wrap is written for — as the server decides it (server/product-mockups.ts productMockups).
  const dieCut = template?.kind === "cut" || cfg.cut.mode === "alpha";
  const fromPhoi = !!cfg.preview.url || (!!template?.spec.blanks.length && cfg.cut.mode !== "alpha");
  const wrapDefault = defaultMockupWrap({ piece, materialId: cfg.material, dieCut, fromPhoi });
  const scenesDefault = defaultScenes(piece).join("\n");

  const list = splitScenes(m.scenes);
  const wrapNoScene = !!m.wrap.trim() && !m.wrap.includes("{scene}");
  // Asked 2026-11-18: no hidden prompt — an empty box is empty, and a mockup with nothing to draw from is refused.
  const state = (filled: boolean, empty: string) => (
    <p className={filled ? "text-xs font-medium text-emerald-700 dark:text-emerald-400" : "rounded-md border border-red-500/60 bg-red-500/10 px-2 py-1 text-xs font-medium text-foreground"}>
      {filled ? "Đang dùng đúng chữ trong ô, không thêm gì khác." : empty}
    </p>
  );

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Prompt chung cho mọi sản phẩm làm trên product base này. Prompt gửi cho AI = đúng câu bọc dưới đây, thay {"{product}"} bằng tên sản phẩm và
        {"{scene}"} bằng từng cảnh — hệ thống không thêm câu nào khác. Sản phẩm có cảnh riêng (ô Mockup bằng AI trong trang sản phẩm, hoặc gửi qua MCP) thì
        dùng cảnh riêng, vẫn dùng câu bọc của base. Ô trống là trống: không có câu bọc, hoặc không có cảnh nào, thì Tạo mockup báo lỗi. Nhớ bấm Lưu.
      </p>

      <CtField
        label={`Cảnh — mỗi cảnh một ảnh${m.scenes.trim() ? ` · ${list.scenes.length} ảnh` : " · trống"}`}
        hint="Mỗi dòng một cảnh; cảnh dài nhiều dòng thì ngăn bằng dòng trống hoặc dòng ---. Chỉ tả chỗ đặt sản phẩm và đồ xung quanh."
      >
        {state(!!m.scenes.trim(), "Ô TRỐNG — sản phẩm không có cảnh riêng sẽ báo lỗi khi Tạo mockup.")}
        <CtTextarea rows={5} value={m.scenes} placeholder="(trống)" onChange={(e) => onChange({ ...m, scenes: e.target.value })} />
        <div className="flex flex-wrap gap-2">
          {m.scenes.trim() ? (
            <CtButton size="sm" onClick={() => onChange({ ...m, scenes: "" })}>
              Xoá hết, để trống
            </CtButton>
          ) : (
            <CtButton size="sm" onClick={() => onChange({ ...m, scenes: scenesDefault })}>
              Điền cảnh mẫu để sửa
            </CtButton>
          )}
        </div>
      </CtField>

      <CtField
        label={`Câu bọc quanh mỗi cảnh${m.wrap.trim() ? "" : " · trống"}`}
        hint="{product} = tên sản phẩm, {scene} = một cảnh ở trên. Câu này dặn AI giữ nguyên hình in, chất liệu, khung hình."
      >
        {state(!!m.wrap.trim(), "Ô TRỐNG — mọi sản phẩm của base này sẽ báo lỗi khi Tạo mockup.")}
        <CtTextarea rows={m.wrap.trim() ? 6 : 2} value={m.wrap} placeholder="(trống)" onChange={(e) => onChange({ ...m, wrap: e.target.value })} />
        <div className="flex flex-wrap gap-2">
          {m.wrap.trim() ? (
            <CtButton size="sm" onClick={() => onChange({ ...m, wrap: "" })}>
              Xoá hết, để trống
            </CtButton>
          ) : (
            <CtButton size="sm" onClick={() => onChange({ ...m, wrap: wrapDefault })}>
              Điền câu mẫu để sửa
            </CtButton>
          )}
        </div>
        {wrapNoScene && <p className="text-xs font-medium text-red-700 dark:text-red-400">Câu không có {"{scene}"} — Tạo mockup sẽ báo lỗi. Thêm {"{scene}"} vào chỗ đặt cảnh.</p>}
      </CtField>

      <CtField
        label={`Ảnh tham chiếu (${m.refs.length}/${CT_MOCKUP_REFS_MAX})`}
        hint="Gửi kèm sau ảnh sản phẩm: ảnh 1 = sản phẩm, ảnh tham chiếu là ảnh 2, 3, 4, 5 theo thứ tự ở đây — prompt cảnh của sản phẩm gọi được tên đó (vd. “same room and light as picture 2”). Hệ thống không tự dặn gì về ảnh này: muốn AI không chép sản phẩm hay chữ trong ảnh thì viết vào câu bọc. Dùng cho mọi sản phẩm của base không có ảnh tham chiếu riêng. Bấm ảnh để phóng to."
      >
        <MockupPics urls={m.refs} max={CT_MOCKUP_REFS_MAX} first={2} onChange={(refs) => onChange({ ...m, refs })} />
      </CtField>
    </div>
  );
}

/**
 * A short list of pictures (mockup reference pictures, size charts): upload (≤ max), remove, click to zoom. `first` = the
 * number the first one has in the mockup prompt ("Ảnh 2"); 0 = not numbered. readOnly: shown, not changed here.
 */
export function MockupPics({ urls, onChange, max, first, readOnly }: { urls: string[]; onChange: (urls: string[]) => void; max: number; first: number; readOnly?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const label = (i: number) => (first > 0 ? `Ảnh ${first + i}` : `Ảnh ${i + 1}`);
  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      const room = Math.max(0, max - urls.length);
      const up: string[] = [];
      for (const f of Array.from(files).slice(0, room)) up.push((await ctApi.uploadPackImage(f)).url);
      onChange([...urls, ...up].slice(0, max));
      if (files.length > room) setError(`Tối đa ${max} ảnh — bỏ qua ${files.length - room} ảnh.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tải ảnh lên được");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <ZoomThumbs
          images={urls.map((url, i) => ({ url, name: label(i) }))}
          overlay={(img, i) => (
            <>
              {first > 0 && <span className="pointer-events-none absolute bottom-0 left-0 bg-black/75 px-1 text-[10px] font-medium text-white">{label(i)}</span>}
              {!readOnly && (
                <button
                  type="button"
                  title="Bỏ ảnh này"
                  className="absolute right-0.5 top-0.5 rounded-full bg-black/70 p-0.5 text-white hover:bg-black"
                  onClick={() => onChange(urls.filter((u) => u !== img.url))}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </>
          )}
        />
        {!readOnly && urls.length < max && (
          <button
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-md border border-dashed text-xs text-foreground/80 hover:bg-accent disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
            Thêm ảnh
          </button>
        )}
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => void add(e.target.files)} />
      </div>
      {error && <p className="mt-1 text-xs font-medium text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

/** The base's "Ảnh kèm sản phẩm" (CtBaseMockup.sizeCharts): size chart, material sample… — up with every deploy, after the mockups. */
export function BaseExtraPics({ cfg, onChange }: { cfg: CtBaseProductConfig; onChange: (mockup: CtBaseMockup) => void }) {
  const m = cfg.mockup;
  return (
    <div className="space-y-2">
      <p className="text-xs text-foreground/80">
        Ảnh size chart, ảnh mẫu chất liệu… Mỗi lần deploy sản phẩm của base này, các ảnh này được đưa lên Shopify ngay sau các mockup. Không gửi cho AI. Tối
        đa {CT_MOCKUP_REFS_MAX} ảnh, bấm ảnh để phóng to. Nhớ bấm Lưu.
      </p>
      <MockupPics urls={m.sizeCharts} max={CT_MOCKUP_REFS_MAX} first={0} onChange={(sizeCharts) => onChange({ ...m, sizeCharts })} />
    </div>
  );
}
