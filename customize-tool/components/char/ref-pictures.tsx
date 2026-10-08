"use client";

/**
 * Reference pictures of a brief (asked 2026-10-09): drop / paste / pick pictures, say what each is for and what to
 * take from it. @flexiprint looks at every one when it brainstorms and draws; style / character / outfit / pose
 * ones are attached to the master drawing with a line saying what to take (server/char/projects.ts modelRefs).
 */

import { useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2, X } from "lucide-react";
import type { CtCharRef, CtCharRefUse } from "../../types";
import { REF_USES, REF_USE_INFO } from "../../lib/char-brief";
import { charApi } from "../../lib/api-client";
import { CtTextarea, cx } from "../ui";
import type { CharCtx } from "./char-project";

const PLACEHOLDER: Record<CtCharRefUse, string> = {
  sample: "VD: làm giống mẫu này — 2 bà bạn thân nhảy múa, khách đổi tóc, màu da, màu váy, tên dưới chân; câu chữ giữ nguyên; nền đổi sang màu xanh…",
  style: "VD: lấy nét vẽ mảnh, màu pastel, má hồng như ảnh này",
  character: "VD: người mẹ giống ảnh này — tóc nâu xoăn ngang vai, mặt tròn",
  outfit: "VD: áo len cổ tròn như ảnh này cho cả 3 mẹ con",
  pose: "VD: đứng cạnh nhau, tay đan trước bụng như ảnh này",
  product: "VD: hình nằm giữa mặt trước túi, chừa lề như ảnh này",
  avoid: "VD: không vẽ kiểu mắt to quá như ảnh này",
};

export function RefPictures(ctx: CharCtx) {
  const { project, images, editable } = ctx;
  const refs = project.brief.refs;
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(0);
  const [over, setOver] = useState(false);
  // Uploads finish one after another while the editor keeps typing: always write onto the newest brief.
  const latest = useRef(project.brief);
  useEffect(() => {
    latest.current = project.brief;
  }, [project.brief]);
  const setRefs = (next: CtCharRef[]) => {
    latest.current = { ...latest.current, refs: next };
    ctx.setBrief(latest.current);
  };

  const add = async (files: File[]) => {
    const pics = files.filter((f) => /^image\/(png|jpeg|webp)$/.test(f.type)).slice(0, 12 - refs.length);
    if (!pics.length) return;
    setBusy((n) => n + pics.length);
    for (const f of pics) {
      try {
        const im = await charApi.upload(project.id, f, "ref");
        ctx.addImages([im]);
        setRefs([...latest.current.refs, { id: im.id, use: latest.current.refs.length ? "character" : "sample", note: "" }]);
      } catch (e) {
        ctx.error(e instanceof Error ? e.message : "Upload thất bại");
      } finally {
        setBusy((n) => n - 1);
      }
    }
  };

  const patch = (i: number, p: Partial<CtCharRef>) => setRefs(refs.map((r, j) => (j === i ? { ...r, ...p } : r)));

  return (
    <div className="space-y-2">
      <div className="text-xs font-medium">Ảnh tham khảo</div>
      <p className="text-[11px] text-muted-foreground">
        Kéo thả, dán (Ctrl+V) hoặc chọn ảnh. Mỗi ảnh chọn dùng để làm gì và ghi rõ muốn lấy gì — @flexiprint xem hết khi gợi ý và vẽ. “Mẫu hoàn chỉnh” = 1 sản phẩm bạn muốn làm giống: agent đọc hết (kiểu sản phẩm, phong cách, nhân vật, dáng, chữ, trang trí) — ghi chú điều gì giữ, điều gì đổi, khách được đổi gì. Mẫu / phong cách / nhân vật / trang phục / dáng được gửi kèm khi vẽ master (tối đa 4 ảnh); sản phẩm / tránh chỉ để agent đọc.
      </p>
      {refs.map((r, i) => {
        const im = images.find((x) => x.id === r.id);
        return (
          <div key={r.id} className="flex gap-2 rounded-lg border bg-card p-2">
            <a href={im?.url} target="_blank" rel="noreferrer" className="h-20 w-20 shrink-0 overflow-hidden rounded border bg-muted/30">
              {/* eslint-disable-next-line @next/next/no-img-element -- our R2 WebP preview */}
              {im && <img src={im.thumb_url || im.url} alt={REF_USE_INFO[r.use].label} className="h-full w-full object-contain" />}
            </a>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-1">
                {REF_USES.map((u) => (
                  <button
                    key={u}
                    type="button"
                    disabled={!editable}
                    onClick={() => patch(i, { use: u })}
                    className={cx("rounded px-1.5 py-0.5 text-[10px]", r.use === u ? (u === "avoid" ? "bg-red-600 text-white" : "bg-foreground text-background") : "bg-muted hover:bg-accent")}
                  >
                    {REF_USE_INFO[u].label}
                  </button>
                ))}
                {editable && (
                  <button type="button" className="ml-auto rounded p-0.5 text-muted-foreground hover:text-foreground" title="Bỏ ảnh" onClick={() => setRefs(refs.filter((_, j) => j !== i))}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <CtTextarea rows={2} className="text-xs" value={r.note} disabled={!editable} placeholder={PLACEHOLDER[r.use]} onChange={(e) => patch(i, { note: e.target.value })} />
            </div>
          </div>
        );
      })}
      {editable && refs.length < 12 && (
        <button
          type="button"
          tabIndex={0}
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            void add(Array.from(e.dataTransfer.files));
          }}
          onPaste={(e) => void add(Array.from(e.clipboardData.files))}
          className={cx("flex w-full flex-col items-center gap-1 rounded-lg border border-dashed px-3 py-4 text-xs text-muted-foreground hover:bg-accent", over && "border-orange-500 bg-orange-500/10")}
        >
          {busy > 0 ? <Loader2 className="h-5 w-5 animate-spin" /> : <ImagePlus className="h-5 w-5" />}
          {busy > 0 ? `Đang tải ${busy} ảnh…` : "Thả ảnh vào đây, bấm để chọn, hoặc bấm rồi Ctrl+V"}
        </button>
      )}
      <input
        ref={input}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const fs = Array.from(e.target.files ?? []);
          e.target.value = "";
          void add(fs);
        }}
      />
    </div>
  );
}
