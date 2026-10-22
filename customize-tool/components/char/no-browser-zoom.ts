"use client";

import { useEffect, useRef } from "react";

/**
 * While an edit view is open the browser's own zoom is off (asked 2026-10-23): pinch / ⌘-wheel, Safari gestures and
 * ⌘ + / − / 0 do nothing to the page — ⌘ + / − go to the view's own zoom (`zoom(factor)`, 0 = fit) instead.
 */
export function useNoBrowserZoom(zoom?: (factor: number) => void): void {
  const ref = useRef(zoom);
  useEffect(() => {
    ref.current = zoom;
  });
  useEffect(() => {
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    };
    const gesture = (e: Event) => e.preventDefault();
    const key = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !["=", "+", "-", "_", "0"].includes(e.key)) return;
      e.preventDefault();
      ref.current?.(e.key === "0" ? 0 : e.key === "-" || e.key === "_" ? 1 / 1.3 : 1.3);
    };
    window.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keydown", key);
    document.addEventListener("gesturestart", gesture);
    document.addEventListener("gesturechange", gesture);
    return () => {
      window.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", key);
      document.removeEventListener("gesturestart", gesture);
      document.removeEventListener("gesturechange", gesture);
    };
  }, []);
}
