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
  // Asked 2026-11-18: the greyed default inside an empty box read as filled — an empty box now says so in words.
  const state = (filled: boolean, what: string) => (
    <p className={filled ? "text-xs font-medium text-emerald-700 dark:text-emerald-400" : "rounded-md border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-xs font-medium text-foreground"}>
      {filled ? `Base đã có ${what} riêng (đang dùng chữ trong ô).` : `Ô đang TRỐNG — base chưa có ${what}; sản phẩm không có prompt riêng sẽ dùng ${what} mặc định của hệ thống (xem bên dưới).`}
    </p>
  );
  const shown = (text: string) => (
    <details className="rounded-md border bg-muted/30 px-2 py-1 text-xs">
      <summary className="cursor-pointer font-medium text-foreground">Xem câu mặc định của hệ thống</summary>
      <p className="mt-1 whitespace-pre-wrap text-foreground/80">{text}</p>
    </details>
  );

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
        Prompt chung cho mọi sản phẩm làm trên product base này. Sản phẩm có prompt riêng (ô Mockup bằng AI trong trang sản phẩm, hoặc gửi qua MCP) thì
        dùng prompt riêng, không dùng cảnh ở đây — nhưng vẫn dùng câu bọc và ảnh tham chiếu của base nếu sản phẩm không có ảnh riêng. Muốn mọi sản
        phẩm tự viết cảnh thì để trống ô Cảnh. Nhớ bấm Lưu.
      </p>

      <CtField
        label={`Cảnh — mỗi cảnh một ảnh${m.scenes.trim() ? ` · ${list.scenes.length} ảnh` : " · đang dùng mặc định"}`}
        hint="Mỗi dòng một cảnh; cảnh dài nhiều dòng thì ngăn bằng dòng trống hoặc dòng ---. Chỉ tả chỗ đặt sản phẩm và đồ xung quanh."
      >
        {state(!!m.scenes.trim(), "cảnh")}
        <CtTextarea rows={5} value={m.scenes} maxLength={CT_MOCKUP_TEXT_MAX} placeholder="(trống)" onChange={(e) => onChange({ ...m, scenes: e.target.value })} />
        <div className="flex flex-wrap gap-2">
          {m.scenes.trim() ? (
            <CtButton size="sm" onClick={() => onChange({ ...m, scenes: "" })}>
              Xoá hết, để trống
            </CtButton>
          ) : (
            <CtButton size="sm" onClick={() => onChange({ ...m, scenes: scenesDefault })}>
              Điền cảnh mặc định để sửa
            </CtButton>
          )}
        </div>
        {!m.scenes.trim() && shown(scenesDefault)}
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
        {state(!!m.wrap.trim(), "câu bọc")}
        <CtTextarea rows={m.wrap.trim() ? 6 : 2} value={m.wrap} maxLength={CT_MOCKUP_WRAP_MAX} placeholder="(trống)" onChange={(e) => onChange({ ...m, wrap: e.target.value })} />
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
        {!m.wrap.trim() && shown(wrapDefault)}
        {wrapNoScene && <p className="text-xs font-medium text-amber-700 dark:text-amber-400">Câu không có {"{scene}"} — cảnh sẽ được nối vào cuối câu.</p>}
      </CtField>

      <CtField
        label={`Ảnh tham chiếu (${m.refs.length}/${CT_MOCKUP_REFS_MAX})`}
        hint="Gửi kèm sau ảnh sản phẩm: ảnh 1 = sản phẩm, ảnh tham chiếu là ảnh 2, 3, 4, 5 theo thứ tự ở đây — prompt cảnh của sản phẩm gọi được tên đó (vd. “same room and light as picture 2”). AI được dặn không chép sản phẩm hay chữ trong ảnh này. Dùng cho mọi sản phẩm của base không có ảnh tham chiếu riêng."
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
