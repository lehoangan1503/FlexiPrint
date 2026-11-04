"use client";

/**
 * Photoshop-style rulers along the top and left edges of a view (asked 2026-11-04: "mép trên dưới của thiết kế và
 * file in để dạng thước kẻ"). The view maps world units (artwork px) to screen px as `screen = pan + world × zoom`;
 * the rulers follow it, number the ticks in px — or mm when the real size is known (click the corner to switch) —
 * and mark where the mouse is. They sit over the view's edges and never take its clicks, except the corner.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";

export const RULER_SIZE = 20;

export interface RulersProps {
  /** Screen px per world unit. */
  zoom: number;
  /** Screen position (px, inside the view) of world 0,0. */
  pan: { x: number; y: number };
  /** The artwork's size in world units: the ruler is shaded outside it. */
  width: number;
  height: number;
  /** mm per world unit when the real size is known: the corner switches the numbers to mm. */
  mmPerUnit?: number;
  /** The element whose mouse moves are marked on the rulers (default: the rulers' parent). */
  track?: React.RefObject<HTMLElement | null>;
}

type Unit = "px" | "mm";

/** Tick spacing in units: the smallest "nice" step at least `minPx` screen px apart. */
function niceStep(pxPerUnit: number, minPx: number): number {
  const raw = minPx / Math.max(1e-9, pxPerUnit);
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}

function readCss(el: HTMLElement, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

export function Rulers({ zoom, pan, width, height, mmPerUnit, track }: RulersProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const topRef = useRef<HTMLCanvasElement | null>(null);
  const leftRef = useRef<HTMLCanvasElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [mouse, setMouse] = useState<{ x: number; y: number } | null>(null);
  const [unit, setUnit] = useState<Unit>("px");
  const mm = unit === "mm" && mmPerUnit ? mmPerUnit : 0;

  useLayoutEffect(() => {
    const el = rootRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // The mouse over the view, marked on both rulers (listened to here, so only the rulers redraw).
  useEffect(() => {
    const el = track?.current ?? rootRef.current?.parentElement;
    if (!el) return;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      setMouse({ x: e.clientX - r.left, y: e.clientY - r.top });
    };
    const leave = () => setMouse(null);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
    };
  }, [track]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !box.w || !box.h) return;
    const dpr = window.devicePixelRatio || 1;
    const dark = document.documentElement.classList.contains("dark");
    const fg = readCss(root, "--ct-ruler-fg", dark ? "#d4d4d4" : "#525252");
    const back = readCss(root, "--ct-ruler-bg", dark ? "#262626" : "#f4f4f5");
    // One unit on screen, in the numbers shown (px, or mm).
    const perShown = mm ? zoom / mm : zoom;
    const step = niceStep(perShown, 64);
    const minor = step / (step / niceStep(perShown, 8) >= 10 ? 10 : 5);

    const draw = (c: HTMLCanvasElement | null, horizontal: boolean) => {
      if (!c) return;
      const len = horizontal ? box.w : box.h;
      const cw = horizontal ? len : RULER_SIZE;
      const ch = horizontal ? RULER_SIZE : len;
      c.width = Math.round(cw * dpr);
      c.height = Math.round(ch * dpr);
      c.style.width = `${cw}px`;
      c.style.height = `${ch}px`;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = back;
      ctx.fillRect(0, 0, cw, ch);
      // The artwork's own span, lighter.
      const origin = horizontal ? pan.x : pan.y;
      const span = (horizontal ? width : height) * zoom;
      ctx.fillStyle = dark ? "rgba(255,255,255,0.07)" : "rgba(255,255,255,0.9)";
      if (horizontal) ctx.fillRect(origin, 0, span, RULER_SIZE);
      else ctx.fillRect(0, origin, RULER_SIZE, span);
      ctx.strokeStyle = fg;
      ctx.fillStyle = fg;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 1;
      ctx.font = "9px ui-sans-serif, system-ui, sans-serif";
      ctx.textBaseline = "top";
      const toShown = (screen: number) => (screen - origin) / perShown;
      const first = Math.floor(toShown(0) / minor) * minor;
      const last = toShown(len);
      ctx.beginPath();
      for (let v = first; v <= last; v += minor) {
        const s = Math.round(origin + v * perShown) + 0.5;
        const major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
        const half = !major && Math.abs((v * 2) / step - Math.round((v * 2) / step)) < 1e-6;
        const t = major ? RULER_SIZE : half ? RULER_SIZE * 0.45 : RULER_SIZE * 0.25;
        if (horizontal) {
          ctx.moveTo(s, RULER_SIZE);
          ctx.lineTo(s, RULER_SIZE - t);
        } else {
          ctx.moveTo(RULER_SIZE, s);
          ctx.lineTo(RULER_SIZE - t, s);
        }
        if (major) {
          const label = String(Math.round(v * 100) / 100);
          if (horizontal) ctx.fillText(label, s + 3, 2);
          else {
            ctx.save();
            ctx.translate(2, s + 3);
            ctx.rotate(Math.PI / 2);
            ctx.fillText(label, 0, -RULER_SIZE + 4);
            ctx.restore();
          }
        }
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      // The edge next to the view.
      ctx.beginPath();
      if (horizontal) {
        ctx.moveTo(0, RULER_SIZE - 0.5);
        ctx.lineTo(len, RULER_SIZE - 0.5);
      } else {
        ctx.moveTo(RULER_SIZE - 0.5, 0);
        ctx.lineTo(RULER_SIZE - 0.5, len);
      }
      ctx.strokeStyle = "rgba(127,127,127,0.5)";
      ctx.stroke();
      // Where the mouse is.
      const m = mouse ? (horizontal ? mouse.x : mouse.y) : null;
      if (m !== null && m > RULER_SIZE) {
        ctx.beginPath();
        ctx.strokeStyle = "#0ea5e9";
        if (horizontal) {
          ctx.moveTo(Math.round(m) + 0.5, 0);
          ctx.lineTo(Math.round(m) + 0.5, RULER_SIZE);
        } else {
          ctx.moveTo(0, Math.round(m) + 0.5);
          ctx.lineTo(RULER_SIZE, Math.round(m) + 0.5);
        }
        ctx.stroke();
      }
    };
    draw(topRef.current, true);
    draw(leftRef.current, false);
  }, [box, zoom, pan.x, pan.y, width, height, mm, mouse]);

  const at = mouse && mouse.x > RULER_SIZE && mouse.y > RULER_SIZE ? { x: (mouse.x - pan.x) / zoom, y: (mouse.y - pan.y) / zoom } : null;
  const shown = (v: number) => (mm ? `${Math.round(v * mm * 10) / 10}` : `${Math.round(v)}`);

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 z-10">
      <canvas ref={topRef} className="absolute left-0 top-0" />
      <canvas ref={leftRef} className="absolute left-0 top-0" />
      <button
        type="button"
        className="pointer-events-auto absolute left-0 top-0 flex items-center justify-center border-b border-r border-neutral-400/50 bg-neutral-100 text-[8px] font-semibold text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
        style={{ width: RULER_SIZE, height: RULER_SIZE }}
        title={mmPerUnit ? `Đơn vị thước: ${unit} — bấm để đổi px / mm` : "Đơn vị thước: px"}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => mmPerUnit && setUnit((u) => (u === "px" ? "mm" : "px"))}
      >
        {unit === "mm" && mmPerUnit ? "mm" : "px"}
      </button>
      {at && (
        <span className="absolute bottom-2 left-7 rounded bg-background/85 px-1.5 py-0.5 text-[10px] tabular-nums text-foreground shadow-sm">
          {shown(at.x)}, {shown(at.y)} {mm ? "mm" : "px"}
        </span>
      )}
    </div>
  );
}
