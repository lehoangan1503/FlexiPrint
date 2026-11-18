"use client";

/**
 * Thumbnails that open full screen (asked 2026-11-18: "component này nên đặt riêng để dùng chung cho mọi chỗ có ảnh
 * thumbnail. Click có popup ảnh, zoom bằng cuộn chuột"). The popup is CtLightbox (components/ui.tsx: mouse-wheel zoom
 * at the pointer, drag to pan, ← → between the pictures of the same list, Esc closes).
 *
 *   <ZoomThumbs images={[{ url, name }]} />                         a grid of square thumbnails
 *   const zoom = useZoom(images); … onClick={() => zoom.open(i)} … {zoom.lightbox}   your own layout
 */

import { useState, type ReactNode } from "react";
import { CHECKER_STYLE, CtLightbox, cx } from "./ui";

export interface CtZoomImage {
  url: string;
  name?: string;
}

/** A lightbox over `images`: open(i) shows picture i; render `lightbox` once anywhere. */
export function useZoom(images: CtZoomImage[]): { open: (i: number) => void; lightbox: ReactNode } {
  const [at, setAt] = useState<number | null>(null);
  return { open: setAt, lightbox: <CtLightbox images={images} index={at} onIndex={setAt} /> };
}

export function ZoomThumbs({
  images,
  className,
  thumbClassName,
  fit = "cover",
  checker = false,
  caption,
  overlay,
}: {
  images: CtZoomImage[];
  /** The grid (default: wraps 80 px squares). */
  className?: string;
  /** One thumbnail's box (default: a square filling its grid cell). */
  thumbClassName?: string;
  fit?: "cover" | "contain";
  /** Checkerboard behind (transparent pictures). */
  checker?: boolean;
  /** A line under each thumbnail. */
  caption?: (img: CtZoomImage, i: number) => ReactNode;
  /** Something drawn over a thumbnail (a number, a remove button…). Clicks on it do not open the popup. */
  overlay?: (img: CtZoomImage, i: number) => ReactNode;
}) {
  const zoom = useZoom(images);
  return (
    <>
      <div className={className ?? "flex flex-wrap gap-2"}>
        {images.map((img, i) => (
          <figure key={`${img.url}-${i}`} className="min-w-0">
            <div className={cx("relative overflow-hidden rounded-md border bg-white", thumbClassName ?? (className ? "aspect-square w-full" : "h-20 w-20"))} style={checker ? CHECKER_STYLE : undefined}>
              <button type="button" className="block h-full w-full cursor-zoom-in" title="Bấm để phóng to (cuộn chuột để zoom)" onClick={() => zoom.open(i)}>
                {/* eslint-disable-next-line @next/next/no-img-element -- our own files */}
                <img src={img.url} alt={img.name ?? ""} loading="lazy" className={cx("h-full w-full", fit === "cover" ? "object-cover" : "object-contain")} />
              </button>
              {overlay?.(img, i)}
            </div>
            {caption && <figcaption className="mt-0.5 truncate text-[11px] text-foreground/80">{caption(img, i)}</figcaption>}
          </figure>
        ))}
      </div>
      {zoom.lightbox}
    </>
  );
}
