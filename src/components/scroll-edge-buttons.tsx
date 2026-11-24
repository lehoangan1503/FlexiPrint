"use client";

/**
 * Two floating buttons on the right edge (asked 2026-11-24 "thêm 1 nút lên trên cùng và xuống dưới cùng"): one near
 * the top jumps to the top of the page, one near the bottom jumps to its end. Each hides when the page is already there.
 */

import { useEffect, useState } from "react";
import { ArrowDownToLine, ArrowUpToLine } from "lucide-react";

/** How far from an edge (px) still counts as "already there". */
const EDGE = 200;

const BTN =
  "fixed right-3 z-40 flex h-10 w-10 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-lg transition-opacity hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:right-5";

export function ScrollEdgeButtons() {
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const check = () => {
      const doc = document.documentElement;
      setAtTop(window.scrollY < EDGE);
      setAtBottom(window.scrollY + window.innerHeight > doc.scrollHeight - EDGE);
    };
    check();
    window.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    // The list grows after load / "Tải thêm" without a scroll: look again when the page height changes.
    const ro = new ResizeObserver(check);
    ro.observe(document.body);
    return () => {
      window.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
      ro.disconnect();
    };
  }, []);

  return (
    <>
      <button
        type="button"
        aria-label="Lên trên cùng"
        title="Lên trên cùng"
        onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        className={`${BTN} top-16 ${atTop ? "pointer-events-none opacity-0" : "opacity-100"}`}
        tabIndex={atTop ? -1 : 0}
      >
        <ArrowUpToLine className="h-5 w-5" />
      </button>
      <button
        type="button"
        aria-label="Xuống dưới cùng"
        title="Xuống dưới cùng"
        onClick={() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" })}
        className={`${BTN} bottom-4 ${atBottom ? "pointer-events-none opacity-0" : "opacity-100"}`}
        tabIndex={atBottom ? -1 : 0}
      >
        <ArrowDownToLine className="h-5 w-5" />
      </button>
    </>
  );
}
