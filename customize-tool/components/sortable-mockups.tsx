"use client";

/**
 * A product's mockups as they go to Shopify (asked 2026-11-19): drag the grip to change the order, tick / untick to
 * send it or not, click the picture to see it full screen. The number on a ticked picture is its place on Shopify
 * (1 = the main image). Used by the editor's "Ảnh sản phẩm" and the Deploy page — both read and write the product's
 * one order (CtProductConfig.mockupOrder / mockupOff, lib/deploy-media.ts).
 *
 * Dragging uses pointer events (mouse and touch alike): the picture under the finger takes the dragged one's place.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, GripVertical } from "lucide-react";
import { CHECKER_STYLE, cx } from "./ui";
import { useZoom } from "./zoom-thumbs";

export interface CtSortableImage {
  id: string;
  url: string;
  name?: string;
}

export function SortableMockups({
  images,
  off,
  onChange,
  className,
  fit = "cover",
  caption,
  overlay,
  disabled,
}: {
  /** In their order. */
  images: CtSortableImage[];
  /** Ids not ticked. */
  off: string[];
  onChange: (order: string[], off: string[]) => void;
  className?: string;
  fit?: "cover" | "contain";
  caption?: (img: CtSortableImage) => ReactNode;
  /** Drawn over a picture's top right corner (a delete button…). */
  overlay?: (img: CtSortableImage) => ReactNode;
  disabled?: boolean;
}) {
  const zoom = useZoom(images);
  const offSet = new Set(off);
  // While dragging: the order shown (committed on release).
  const [live, setLive] = useState<string[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const moved = useRef(false);
  const byId = new Map(images.map((i) => [i.id, i]));
  const order = (live ?? images.map((i) => i.id)).filter((id) => byId.has(id));
  let n = 0;
  const place = new Map(order.map((id) => [id, offSet.has(id) ? 0 : ++n]));

  const start = (id: string, e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    moved.current = false;
    liveRef.current = images.map((i) => i.id);
    setDragId(id);
    setLive(liveRef.current);
  };
  // The pointer is followed on the window: the tiles move in the page while dragging (a capture on one would drop).
  const liveRef = useRef<string[]>([]);
  const changeRef = useRef(onChange);
  const offRef = useRef(off);
  useEffect(() => {
    changeRef.current = onChange;
    offRef.current = off;
  });
  useEffect(() => {
    if (!dragId) return;
    const move = (e: PointerEvent) => {
      const el = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest<HTMLElement>("[data-mockup-id]");
      const over = el?.dataset.mockupId;
      const cur = liveRef.current;
      if (!over || over === dragId) return;
      const from = cur.indexOf(dragId);
      const to = cur.indexOf(over);
      if (from < 0 || to < 0) return;
      const next = [...cur];
      next.splice(from, 1);
      next.splice(to, 0, dragId);
      moved.current = true;
      liveRef.current = next;
      setLive(next);
    };
    const end = () => {
      if (moved.current) changeRef.current(liveRef.current, offRef.current);
      setLive(null);
      setDragId(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [dragId]);
  const toggle = (id: string) =>
    onChange(
      order,
      offSet.has(id) ? off.filter((x) => x !== id) : [...off, id],
    );

  return (
    <>
      <div className={className ?? "grid grid-cols-4 gap-2 sm:grid-cols-6"}>
        {order.map((id) => {
          const img = byId.get(id)!;
          const on = !offSet.has(id);
          return (
            <figure
              key={id}
              data-mockup-id={id}
              className={cx("min-w-0", dragId === id && "opacity-50")}
            >
              <div
                className={cx(
                  "relative aspect-square w-full overflow-hidden rounded-md border bg-white",
                  on ? "ring-2 ring-sky-500" : "",
                )}
                style={fit === "contain" ? CHECKER_STYLE : undefined}
              >
                <button
                  type="button"
                  className="block h-full w-full cursor-zoom-in"
                  title="Bấm để phóng to"
                  onClick={() =>
                    zoom.open(images.findIndex((i) => i.id === id))
                  }
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- our own files */}
                  <img
                    src={img.url}
                    alt={img.name ?? ""}
                    loading="lazy"
                    draggable={false}
                    className={cx(
                      "h-full w-full",
                      fit === "cover" ? "object-cover" : "object-contain",
                      !on && "opacity-40",
                    )}
                  />
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => toggle(id)}
                  className={cx(
                    "absolute left-1 top-1 flex h-6 min-w-6 items-center justify-center rounded px-1 text-[11px] font-bold shadow ring-1",
                    on
                      ? "bg-sky-600 text-white ring-sky-700"
                      : "bg-white text-slate-700 ring-black/30",
                  )}
                  title={
                    on
                      ? "Đang đưa lên Shopify — bấm để bỏ"
                      : "Không đưa lên Shopify — bấm để chọn"
                  }
                  aria-label={on ? "Bỏ chọn ảnh" : "Chọn ảnh"}
                >
                  {on ? (
                    place.get(id)
                  ) : (
                    <Check className="h-3.5 w-3.5 opacity-30" />
                  )}
                </button>
                <span
                  onPointerDown={(e) => start(id, e)}
                  className={cx(
                    "absolute bottom-1 left-1 flex h-7 w-7 items-center justify-center rounded bg-black/60 text-white",
                    disabled
                      ? "cursor-not-allowed"
                      : "cursor-grab active:cursor-grabbing",
                  )}
                  style={{ touchAction: "none" }}
                  title="Kéo để đổi thứ tự"
                  aria-label="Kéo để đổi thứ tự"
                >
                  <GripVertical className="h-4 w-4" />
                </span>
                {overlay?.(img)}
              </div>
              {caption && (
                <figcaption className="mt-0.5 truncate text-[11px] text-foreground/80">
                  {caption(img)}
                </figcaption>
              )}
            </figure>
          );
        })}
      </div>
      {zoom.lightbox}
    </>
  );
}
