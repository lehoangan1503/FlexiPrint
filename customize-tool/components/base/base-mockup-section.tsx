"use client";

/**
 * The base page's "Prompt mockup" section (asked 2026-11-17: the mockup prompts out of the code, one set per product
 * base): the scene prompts, the sentence wrapped around each one, and the reference pictures for the setting. Saved
 * with the page's Lưu (CtBaseProductConfig.mockup). Empty = the code's default, shown greyed as the placeholder.
 */

import { useRef, useState } from "react";
import { ImagePlus, Loader2, X } from "lucide-react";
import type { CtBaseMockup, CtBaseProductConfig } from "../../types";
import type { CtPrintTemplate } from "../../types/print";
import { ctApi } from "../../lib/api-client";
import { CT_MOCKUP_TEXT_MAX, defaultScenes, sceneProblems, splitScenes } from "../../lib/mockup-scenes";
import { CT_MOCKUP_REFS_MAX, CT_MOCKUP_WRAP_MAX, defaultMockupWrap } from "../../lib/mockup-prompt";
import { CtButton, CtField, CtTextarea } from "../ui";

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // The look the default wrap is written for — as the server decides it (server/product-mockups.ts productMockups).
  const dieCut = template?.kind === "cut" || cfg.cut.mode === "alpha";
  const fromPhoi = !!cfg.preview.url || (!!template?.spec.blanks.length && cfg.cut.mode !== "alpha");
  const wrapDefault = defaultMockupWrap({ piece, materialId: cfg.material, dieCut, fromPhoi });
  const scenesDefault = defaultScenes(piece).join("\n");

  const list = splitScenes(m.scenes);
  const problems = m.scenes.trim() ? sceneProblems(list.scenes) : [];
  const wrapNoScene = !!m.wrap.trim() && !m.wrap.includes("{scene}");

  const addRefs = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      const room = CT_MOCKUP_REFS_MAX - m.refs.length;
      const urls: string[] = [];
      for (const f of Array.from(files).slice(0, Math.max(0, room))) urls.push((await ctApi.uploadPackImage(f)).url);
      onChange({ ...m, refs: [...m.refs, ...urls].slice(0, CT_MOCKUP_REFS_MAX) });
      if (files.length > room) setError(`Tối đa ${CT_MOCKUP_REFS_MAX} ảnh tham chiếu — bỏ qua ${files.length - room} ảnh.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tải ảnh lên được");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Dùng cho mọi sản phẩm làm trên product base này khi bấm Tạo mockup. Sản phẩm có prompt riêng (ô Mockups trong editor, hoặc gửi qua MCP) thì dùng
        prompt riêng. Ô để trống = dùng câu mặc định (chữ mờ trong ô). Nhớ bấm Lưu.
      </p>

      <CtField
        label={`Cảnh — mỗi cảnh một ảnh${m.scenes.trim() ? ` · ${list.scenes.length} ảnh` : " · đang dùng mặc định"}`}
        hint="Mỗi dòng một cảnh; cảnh dài nhiều dòng thì ngăn bằng dòng trống hoặc dòng ---. Chỉ tả chỗ đặt sản phẩm và đồ xung quanh."
      >
        <CtTextarea rows={5} value={m.scenes} maxLength={CT_MOCKUP_TEXT_MAX} placeholder={scenesDefault} onChange={(e) => onChange({ ...m, scenes: e.target.value })} />
        <div className="flex flex-wrap gap-2">
          {!m.scenes.trim() && (
            <CtButton size="sm" onClick={() => onChange({ ...m, scenes: scenesDefault })}>
              Điền cảnh mặc định để sửa
            </CtButton>
          )}
        </div>
        {problems.map((p) => (
          <p key={p} className="text-xs font-medium text-red-600 dark:text-red-400">
            {p}
          </p>
        ))}
      </CtField>

      <CtField
        label={`Câu bọc quanh mỗi cảnh${m.wrap.trim() ? "" : " · đang dùng mặc định"}`}
        hint="{product} = tên sản phẩm, {scene} = một cảnh ở trên. Câu này dặn AI giữ nguyên hình in, chất liệu, khung hình."
      >
        <CtTextarea rows={6} value={m.wrap} maxLength={CT_MOCKUP_WRAP_MAX} placeholder={wrapDefault} onChange={(e) => onChange({ ...m, wrap: e.target.value })} />
        <div className="flex flex-wrap gap-2">
          {m.wrap.trim() ? (
            <CtButton size="sm" onClick={() => onChange({ ...m, wrap: "" })}>
              Bỏ, dùng câu mặc định
            </CtButton>
          ) : (
            <CtButton size="sm" onClick={() => onChange({ ...m, wrap: wrapDefault })}>
              Điền câu mặc định để sửa
            </CtButton>
          )}
        </div>
        {wrapNoScene && <p className="text-xs font-medium text-amber-700 dark:text-amber-400">Câu không có {"{scene}"} — cảnh sẽ được nối vào cuối câu.</p>}
      </CtField>

      <CtField
        label={`Ảnh tham chiếu (${m.refs.length}/${CT_MOCKUP_REFS_MAX})`}
        hint="Gửi kèm sau ảnh sản phẩm để AI theo bối cảnh, ánh sáng, phong cách — AI được dặn không chép sản phẩm hay chữ trong ảnh này."
      >
        <div className="flex flex-wrap gap-2">
          {m.refs.map((url) => (
            <div key={url} className="relative h-20 w-20 overflow-hidden rounded-md border">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt="" className="h-full w-full object-cover" />
              <button
                type="button"
                title="Bỏ ảnh này"
                className="absolute right-0.5 top-0.5 rounded-full bg-black/70 p-0.5 text-white hover:bg-black"
                onClick={() => onChange({ ...m, refs: m.refs.filter((u) => u !== url) })}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          {m.refs.length < CT_MOCKUP_REFS_MAX && (
            <button
              type="button"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
              className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-md border border-dashed text-xs text-muted-foreground hover:bg-accent disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
              Thêm ảnh
            </button>
          )}
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => void addRefs(e.target.files)} />
        </div>
        {error && <p className="text-xs font-medium text-red-600 dark:text-red-400">{error}</p>}
      </CtField>
    </div>
  );
}
