"use client";

/**
 * "Hướng dẫn" of a photo zone's style tabs: one sample photo run through each
 * family — Free (its 3 filters), AI (the default Watercolor + Ink style) and
 * Face (crop + colour filters) — so the editor sees what each tab gives the
 * customer before picking one.
 *
 * Nothing is faked: every result is the real pipeline (lib/photo-process.ts →
 * products/:id/photo), exactly what the storefront would show. The server
 * caches cut-outs, face crops and AI results by photo hash, so the AI sample
 * is paid once; this module keeps the rendered blobs for the session.
 */

import { useEffect, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import type { CtPhotoStyleRef } from "../../types";
import { CT_FACE_STYLES, CT_FREE_STYLES, isAiStyleRef } from "../../lib/photo-styles";
import { processPhoto } from "../../lib/photo-process";
import { ctApi } from "../../lib/api-client";
import { CHECKER_STYLE, CtModal, cx } from "../ui";

const SAMPLE_URL = "/ct-guide/sample-cat.jpg";

/** style → rendered blob URL (or the failure), shared by every open of the dialog. */
const rendered = new Map<string, Promise<string>>();

function render(productId: string, style: CtPhotoStyleRef): Promise<string> {
  const key = style;
  let p = rendered.get(key);
  if (!p) {
    p = fetch(SAMPLE_URL)
      .then((r) => r.blob())
      .then((source) => processPhoto({ source, style, cutout: true, fadeCrop: true, endpoint: ctApi.photoEndpoint(productId) }))
      .then((blob) => URL.createObjectURL(blob));
    // A failure (service down…) is retried on the next open.
    p.catch(() => rendered.delete(key));
    rendered.set(key, p);
  }
  return p;
}

interface Row {
  title: string;
  hint: string;
  styles: Array<{ ref: CtPhotoStyleRef; label: string }>;
}

export function PhotoGuideDialog(props: {
  open: boolean;
  onClose: () => void;
  productId: string;
  /** The AI tab's default style (built-in Watercolor + Ink), if the library has one. */
  aiStyle: { ref: CtPhotoStyleRef; name: string } | null;
}) {
  const rows: Row[] = [
    {
      title: "Free",
      hint: "Không tốn phí AI. Khách chọn 1 trong các style bạn bật. Tách nền + làm mờ mép cắt luôn áp dụng.",
      styles: CT_FREE_STYLES.map((s) => ({ ref: s.id, label: s.label })),
    },
    {
      title: "AI tạo ảnh",
      hint: "1 style AI cho cả vùng — khách upload rồi đợi ~10–20 giây. Tính phí mỗi ảnh mới (ảnh trùng lấy từ cache).",
      styles: props.aiStyle && isAiStyleRef(props.aiStyle.ref) ? [{ ref: props.aiStyle.ref, label: props.aiStyle.name }] : [],
    },
    {
      title: "Face",
      hint: "Không tốn phí AI. Tách nền, tự tìm khuôn mặt (người, mèo; chó / khác nhờ AI tìm), chỉ giữ phần đầu — không cổ, không thân — rồi bộ 5 màu mặc định.",
      styles: CT_FACE_STYLES.map((s) => ({ ref: s.id, label: s.label.replace(/^Face · /, "") })),
    },
  ];

  return (
    <CtModal open={props.open} onOpenChange={(o) => !o && props.onClose()} title="Hướng dẫn: style ảnh khách" wide>
      <div className="space-y-4 text-sm">
        <p className="text-xs text-muted-foreground">
          Cùng 1 ảnh khách, mỗi tab cho ra kết quả thế này (render thật qua đúng pipeline của storefront). Chọn tab phù hợp sản phẩm, rồi bật style cho khách chọn.
        </p>
        {rows.map((row) => (
          <section key={row.title} className="rounded-lg border p-3">
            <div className="mb-2 flex items-baseline gap-2">
              <h3 className="text-sm font-semibold">{row.title}</h3>
              <span className="text-[11px] text-muted-foreground">{row.hint}</span>
            </div>
            <div className="flex items-center gap-3">
              <figure className="w-36 shrink-0 space-y-1">
                <img src={SAMPLE_URL} alt="Ảnh gốc" className="aspect-square w-full rounded-md object-cover" />
                <figcaption className="text-center text-[11px] text-muted-foreground">Ảnh gốc</figcaption>
              </figure>
              <ArrowRight className="h-6 w-6 shrink-0 text-muted-foreground" />
              {row.styles.length ? (
                <div className="grid flex-1 grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-2">
                  {row.styles.map((s) => (
                    <Result key={s.ref} productId={props.productId} style={s.ref} label={s.label} active={props.open} />
                  ))}
                </div>
              ) : (
                <p className="flex-1 text-xs text-muted-foreground">Chưa có style AI trong thư viện — bấm “Thêm mới” ở tab AI tạo ảnh.</p>
              )}
            </div>
          </section>
        ))}
      </div>
    </CtModal>
  );
}

function Result({ productId, style, label, active }: { productId: string; style: CtPhotoStyleRef; label: string; active: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    render(productId, style).then(
      (u) => live && setUrl(u),
      (e: unknown) => live && setError(e instanceof Error ? e.message : "Lỗi"),
    );
    return () => {
      live = false;
    };
  }, [productId, style, active]);
  return (
    <figure className="space-y-1">
      <div className={cx("flex aspect-square items-center justify-center overflow-hidden rounded-md border")} style={CHECKER_STYLE}>
        {url ? (
          <img src={url} alt={label} className="h-full w-full object-contain" />
        ) : error ? (
          <p className="p-2 text-center text-[10px] text-destructive">{error}</p>
        ) : (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        )}
      </div>
      <figcaption className="text-center text-[11px]">{label}</figcaption>
    </figure>
  );
}
