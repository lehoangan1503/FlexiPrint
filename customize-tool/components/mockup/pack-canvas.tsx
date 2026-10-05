"use client";

/**
 * One tổ hợp scene, rendered live by lib/mockup.ts, with a move / resize /
 * rotate frame on the selected layer (editor "Tổ hợp", Thiết kế → Nền).
 *
 *   drag inside a layer   select + move (Shift = one axis)
 *   corner / edge handle  resize along the layer's OWN axes, so a rotated
 *                         layer keeps its opposite edge (Shift on a corner =
 *                         keep the aspect)
 *   round knob            rotate (Shift = 15° steps)
 *   Alt                   no snapping (centre / edges of the canvas)
 *
 * Boxes are in scene px; the canvas is drawn at the size that fits the host.
 * Things dragged in (a main version) land through `onDropAt` in scene px.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CtPackBox, CtPackLayer, CtPackSlide } from "../../types";
import { drawSlide, type CtSlotArt } from "../../lib/mockup";
import { CHECKER_STYLE, cx } from "../ui";

export interface PackCanvasProps {
  slide: CtPackSlide;
  arts: Record<string, CtSlotArt | null | undefined>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** `done` = the drag ended (commit to undo history). */
  onBox: (layerId: string, box: CtPackBox, done: boolean) => void;
  /** Layers that may be picked / moved; omitted = every visible one. */
  editable?: (layer: CtPackLayer) => boolean;
  placeholders?: boolean;
  className?: string;
  /** dataTransfer type accepted on drop. */
  dropType?: string;
  onDropAt?: (data: string, at: { x: number; y: number }) => void;
}

type Drag =
  | { kind: "move"; id: string; start: { x: number; y: number }; box: CtPackBox }
  | { kind: "resize"; id: string; hx: number; hy: number; start: { x: number; y: number }; box: CtPackBox }
  | { kind: "rotate"; id: string; box: CtPackBox };

const HANDLES: Array<[number, number]> = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
];

/** Is pack point (x, y) inside the (rotated) box? */
function inside(b: CtPackBox, x: number, y: number): boolean {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const a = (-b.rotation * Math.PI) / 180;
  const dx = x - cx;
  const dy = y - cy;
  const lx = dx * Math.cos(a) - dy * Math.sin(a);
  const ly = dx * Math.sin(a) + dy * Math.cos(a);
  return Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2;
}

/** Snap a value to the nearest target within `tol`. */
function snap(v: number, targets: number[], tol: number): number {
  let best = v;
  let d = tol;
  for (const t of targets) {
    if (Math.abs(v - t) < d) {
      d = Math.abs(v - t);
      best = t;
    }
  }
  return best;
}

export function PackCanvas(props: PackCanvasProps) {
  const { slide, selectedId } = props;
  const { width, height } = slide;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [view, setView] = useState(0.3);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dropping, setDropping] = useState(false);

  // Fit the canvas into the host.
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      setView(Math.max(0.02, Math.min((r.width - 32) / width, (r.height - 32) / height)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width, height]);

  // Redraw on every change; only the newest draw lands.
  const seq = useRef(0);
  const { arts, placeholders } = props;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const n = ++seq.current;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const off = document.createElement("canvas");
    off.width = Math.max(1, Math.round(width * view * dpr));
    off.height = Math.max(1, Math.round(height * view * dpr));
    const ctx = off.getContext("2d");
    if (!ctx) return;
    void drawSlide(ctx, { slide, arts, scale: view * dpr, placeholders: placeholders !== false }).then(() => {
      if (n !== seq.current) return;
      canvas.width = off.width;
      canvas.height = off.height;
      canvas.getContext("2d")?.drawImage(off, 0, 0);
    });
  }, [slide, arts, width, height, view, placeholders]);

  const canEdit = (l: CtPackLayer) => !l.hidden && (props.editable ? props.editable(l) : true);
  const selected = slide.layers.find((l) => l.id === selectedId && canEdit(l)) ?? null;

  const toPack = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: (e.clientX - r.left) / view, y: (e.clientY - r.top) / view };
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const p = toPack(e);
    const hit = [...slide.layers].reverse().find((l) => canEdit(l) && inside(l.box, p.x, p.y));
    // Keep the selection when clicking inside it even if another layer is on top (move what is selected).
    const target = selected && inside(selected.box, p.x, p.y) ? selected : hit;
    props.onSelect(target?.id ?? null);
    if (!target) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ kind: "move", id: target.id, start: p, box: target.box });
  };

  const onHandleDown = (e: React.PointerEvent, hx: number, hy: number) => {
    if (!selected) return;
    e.stopPropagation();
    hostRef.current?.setPointerCapture(e.pointerId);
    setDrag({ kind: "resize", id: selected.id, hx, hy, start: toPack(e), box: selected.box });
  };

  const onRotateDown = (e: React.PointerEvent) => {
    if (!selected) return;
    e.stopPropagation();
    hostRef.current?.setPointerCapture(e.pointerId);
    setDrag({ kind: "rotate", id: selected.id, box: selected.box });
  };

  const next = (e: React.PointerEvent, d: Drag): CtPackBox => {
    const p = toPack(e);
    const b = d.box;
    const tol = 8 / view;
    if (d.kind === "move") {
      let dx = p.x - d.start.x;
      let dy = p.y - d.start.y;
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      let x = b.x + dx;
      let y = b.y + dy;
      if (!e.altKey && !b.rotation) {
        // Centre and edges onto the canvas centre / edges.
        const cx = snap(x + b.w / 2, [width / 2], tol);
        x = cx - b.w / 2;
        const left = snap(x, [0], tol);
        x = left !== x ? left : snap(x + b.w, [width], tol) - b.w;
        const cy = snap(y + b.h / 2, [height / 2], tol);
        y = cy - b.h / 2;
        const top = snap(y, [0], tol);
        y = top !== y ? top : snap(y + b.h, [height], tol) - b.h;
      }
      return { ...b, x: Math.round(x), y: Math.round(y) };
    }
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    if (d.kind === "rotate") {
      let deg = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI + 90;
      if (deg > 180) deg -= 360;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      else if (!e.altKey) deg = snap(deg, [-180, -90, 0, 90, 180], 3);
      return { ...b, rotation: Math.round(deg * 10) / 10 };
    }
    // Resize in the layer's own axes: the pointer delta, un-rotated.
    const a = (b.rotation * Math.PI) / 180;
    const dx = p.x - d.start.x;
    const dy = p.y - d.start.y;
    const lx = dx * Math.cos(-a) - dy * Math.sin(-a);
    const ly = dx * Math.sin(-a) + dy * Math.cos(-a);
    let w = d.hx ? Math.max(8, b.w + d.hx * lx) : b.w;
    let h = d.hy ? Math.max(8, b.h + d.hy * ly) : b.h;
    if (e.shiftKey && d.hx && d.hy) {
      const k = Math.max(w / b.w, h / b.h);
      w = b.w * k;
      h = b.h * k;
    }
    // The opposite edge stays put: move the centre by half the growth, along the layer's axes.
    const sx = (d.hx * (w - b.w)) / 2;
    const sy = (d.hy * (h - b.h)) / 2;
    const ncx = cx + sx * Math.cos(a) - sy * Math.sin(a);
    const ncy = cy + sx * Math.sin(a) + sy * Math.cos(a);
    return { ...b, x: Math.round(ncx - w / 2), y: Math.round(ncy - h / 2), w: Math.round(w), h: Math.round(h) };
  };

  const onMove = (e: React.PointerEvent) => {
    if (drag) props.onBox(drag.id, next(e, drag), false);
  };
  const onUp = (e: React.PointerEvent) => {
    if (!drag) return;
    props.onBox(drag.id, next(e, drag), true);
    setDrag(null);
  };

  const sb = selected?.box;
  return (
    <div
      ref={hostRef}
      className={cx("relative flex items-center justify-center overflow-hidden", props.className)}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onDragOver={(e) => {
        if (!props.dropType || !e.dataTransfer.types.includes(props.dropType)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => {
        setDropping(false);
        const data = props.dropType ? e.dataTransfer.getData(props.dropType) : "";
        if (!data || !props.onDropAt) return;
        e.preventDefault();
        props.onDropAt(data, toPack(e));
      }}
    >
      {dropping && <div className="pointer-events-none absolute inset-2 z-20 rounded-lg border-2 border-dashed border-sky-500 bg-sky-500/5" />}
      <div className="relative shadow-lg" style={{ width: width * view, height: height * view, ...CHECKER_STYLE }}>
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none" onPointerDown={onDown} />
        {sb && (
          <div
            className="pointer-events-none absolute border border-sky-500"
            style={{
              left: sb.x * view,
              top: sb.y * view,
              width: sb.w * view,
              height: sb.h * view,
              transform: `rotate(${sb.rotation}deg)`,
            }}
          >
            <div className="absolute left-1/2 -top-6 h-6 w-px bg-sky-500" />
            <div
              className="pointer-events-auto absolute left-1/2 -top-8 h-3 w-3 -translate-x-1/2 cursor-grab rounded-full border border-sky-500 bg-white"
              onPointerDown={onRotateDown}
            />
            {HANDLES.map(([hx, hy]) => (
              <div
                key={`${hx}${hy}`}
                className="pointer-events-auto absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 border border-sky-500 bg-white"
                style={{ left: `${(hx + 1) * 50}%`, top: `${(hy + 1) * 50}%`, cursor: hx && hy ? (hx === hy ? "nwse-resize" : "nesw-resize") : hx ? "ew-resize" : "ns-resize" }}
                onPointerDown={(e) => onHandleDown(e, hx, hy)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
