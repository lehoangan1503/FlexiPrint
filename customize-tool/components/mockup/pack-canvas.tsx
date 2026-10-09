"use client";

/**
 * One mockup scene, rendered live by lib/mockup.ts, with a move / resize /
 * rotate frame on the selected layer (editor "Mockups", Thiết kế → Nền).
 *
 *   drag inside a layer   inside the selection = move it, even under the
 *                         layers on top; elsewhere select the topmost one
 *                         + move (Shift = one axis)
 *   corner / edge handle  resize along the layer's OWN axes, so a rotated
 *                         layer keeps its opposite edge (Shift on a corner =
 *                         keep the aspect)
 *   round knob            rotate (Shift = 15° steps)
 *   Alt                   no snapping (centre / edges of the canvas)
 *
 * View (as the Thiết kế stage): ⌘ / Ctrl + wheel or pinch = zoom at the
 * pointer, two-finger scroll = pan, Space-drag / middle button / the hand
 * tool = pan; − % + · Vừa khung · 100% bottom right. Fits again when the
 * edit frame changes size, or when the host resizes until zoomed by hand.
 *
 * Tools (`tool`, the editor's vertical toolbar):
 *   crop    the selected image / product frame: edge + corner handles crop
 *           it, drag inside = move the crop window; the content stays put and
 *           its cropped-away part shows faintly
 *   cut     polygon lasso on the selected layer (or the one under the pointer):
 *           click point by point; click the first point, double-click or
 *           Enter closes it → onCut with the outline. Backspace / ⌘Z takes
 *           the last point off, Esc drops it
 *   brush   paint a stroke (onStroke) — the editor turns it into blur
 *   erase   the same, as an eraser stroke
 *
 * Boxes are in scene px; the canvas is drawn at the size that fits the host.
 * Things dragged in (a main version) land through `onDropAt` in scene px.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CtPackBox, CtPackBrushStroke, CtPackCrop, CtPackLayer, CtPackSlide } from "../../types";
import { cropFull, drawSlide, withCrop, type CtSlotArt } from "../../lib/mockup";

export type CtPackTool = "select" | "hand" | "crop" | "cut" | "brush" | "erase";

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 8;
/** Longest side the scene is rendered at, device px — zoomed further it is upscaled. */
const MAX_RENDER = 4096;

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

/** Layers the crop tool works on. */
export function canCrop(l: CtPackLayer): boolean {
  return l.type === "image" || l.type === "frame";
}
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
  /** Active tool; omitted = "select". */
  tool?: CtPackTool;
  /** Brush diameter, scene px. */
  brushSize?: number;
  /** Crop tool: the layer's new shown box + crop (null = all of it). */
  onCrop?: (layerId: string, patch: { box: CtPackBox; crop: CtPackCrop | null }, done: boolean) => void;
  /** Brush / erase tool: the stroke so far. */
  onStroke?: (stroke: CtPackBrushStroke, done: boolean) => void;
  /** Cut tool: the closed outline drawn on a layer, scene px (x0, y0, x1, y1…). */
  onCut?: (layerId: string, points: number[]) => void;
}

type Drag =
  | { kind: "move"; id: string; start: { x: number; y: number }; box: CtPackBox }
  | { kind: "resize"; id: string; hx: number; hy: number; start: { x: number; y: number }; box: CtPackBox }
  | { kind: "rotate"; id: string; box: CtPackBox }
  | { kind: "crop"; id: string; hx: number; hy: number; start: { x: number; y: number }; full: CtPackBox; crop: CtPackCrop }
  | { kind: "pan"; id: string; start: { x: number; y: number }; full: CtPackBox; crop: CtPackCrop }
  | { kind: "paint"; points: number[]; erase: boolean }
  | { kind: "view"; startX: number; startY: number; pan: { x: number; y: number } };

/** (x, y) turned by `deg`. */
function turn(x: number, y: number, deg: number): { x: number; y: number } {
  const a = (deg * Math.PI) / 180;
  return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

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
  /** Screen px per scene px, and where the scene's top-left sits in the host. */
  const [view, setView] = useState(0.3);
  const [pan, setPan] = useState({ x: 16, y: 16 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dropping, setDropping] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  /** Zoomed / panned by hand: a host resize no longer refits. */
  const userView = useRef(false);
  const viewRef = useRef(view);
  const panRef = useRef(pan);

  const fit = useCallback(() => {
    const el = hostRef.current;
    if (!el) return;
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((el.clientWidth - 32) / width, (el.clientHeight - 32) / height)));
    setView(z);
    setPan({ x: (el.clientWidth - width * z) / 2, y: (el.clientHeight - height * z) / 2 });
    userView.current = false;
  }, [width, height]);
  /** Zoom by `k` keeping host point (mx, my) still (default: the host's centre). */
  const zoomBy = (k: number, mx?: number, my?: number) => {
    const el = hostRef.current;
    const x = mx ?? (el?.clientWidth ?? 0) / 2;
    const y = my ?? (el?.clientHeight ?? 0) / 2;
    const old = viewRef.current;
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, old * k));
    const p = panRef.current;
    setView(z);
    setPan({ x: x - ((x - p.x) * z) / old, y: y - ((y - p.y) * z) / old });
    userView.current = true;
  };
  const zoomByRef = useRef(zoomBy);
  // Latest values for the wheel listener and zoomBy (set after render, not during it).
  useLayoutEffect(() => {
    viewRef.current = view;
    panRef.current = pan;
    zoomByRef.current = zoomBy;
  });

  // Fit on a new edit-frame size; on a host resize only while not zoomed by hand.
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    fit();
    const ro = new ResizeObserver(() => !userView.current && fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  // Wheel: pinch / ⌘ / Ctrl (or a mouse wheel's big steps) zooms at the pointer; trackpad scroll pans.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const isZoom = e.ctrlKey || e.metaKey || (Math.abs(e.deltaY) >= 50 && e.deltaX === 0 && !e.shiftKey);
      if (!isZoom) {
        setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
        userView.current = true;
        return;
      }
      zoomByRef.current(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Space = the hand while held.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !isTyping(e.target)) {
        e.preventDefault();
        setSpaceHeld(true);
      }
    };
    const up = (e: KeyboardEvent) => e.code === "Space" && setSpaceHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  /** Scene px per output px for the render: quantised (zooming doesn't redraw every tick) and capped. */
  const dpr = typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1);
  const renderScale = Math.min(MAX_RENDER / Math.max(width, height), 2 ** (Math.round(Math.log2(view * dpr) * 4) / 4));

  // Redraw on every change; only the newest draw lands.
  const seq = useRef(0);
  const { arts, placeholders } = props;
  /** The layer being cropped shows its cropped-away part faintly. */
  const ghost = props.tool === "crop" ? selectedId : null;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const n = ++seq.current;
    const off = document.createElement("canvas");
    off.width = Math.max(1, Math.round(width * renderScale));
    off.height = Math.max(1, Math.round(height * renderScale));
    const ctx = off.getContext("2d");
    if (!ctx) return;
    void drawSlide(ctx, { slide, arts, scale: renderScale, placeholders: placeholders !== false, ghost }).then(() => {
      if (n !== seq.current) return;
      canvas.width = off.width;
      canvas.height = off.height;
      canvas.getContext("2d")?.drawImage(off, 0, 0);
    });
  }, [slide, arts, width, height, renderScale, placeholders, ghost]);

  // The blur brush layer covers everything: never picked on the canvas.
  const canEdit = (l: CtPackLayer) => !l.hidden && l.type !== "blur" && (props.editable ? props.editable(l) : true);
  const selected = slide.layers.find((l) => l.id === selectedId && canEdit(l)) ?? null;
  const tool = spaceHeld ? "hand" : (props.tool ?? "select");
  const cropping = tool === "crop" && selected && canCrop(selected) ? selected : null;
  const painting = tool === "brush" || tool === "erase";
  const brushSize = props.brushSize ?? 80;
  /** Pointer over the canvas, scene px (the brush outline). */
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  /** The polygon lasso being clicked out, scene px. */
  const [lasso, setLasso] = useState<{ id: string; points: number[] } | null>(null);
  /** Pointer over the canvas while cutting: the rubber band to the next point. */
  const [aim, setAim] = useState<{ x: number; y: number } | null>(null);
  // Leaving the cut tool drops it (Space for the hand doesn't).
  if (lasso && props.tool !== "cut") setLasso(null);
  const closeLasso = (l: { id: string; points: number[] }) => {
    setLasso(null);
    if (l.points.length >= 6) props.onCut?.(l.id, l.points);
  };
  // While a lasso is open its keys win over the editor's (Enter would leave the tool).
  const lassoKeys = useRef<(e: KeyboardEvent) => void>(() => {});
  useLayoutEffect(() => {
    lassoKeys.current = (e) => {
      if (!lasso || isTyping(e.target)) return;
      const undo = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey;
      if (e.key === "Enter") closeLasso(lasso);
      else if (e.key === "Escape") setLasso(null);
      else if (e.key === "Backspace" || e.key === "Delete" || undo) setLasso(lasso.points.length > 2 ? { ...lasso, points: lasso.points.slice(0, -2) } : null);
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => lassoKeys.current(e);
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const toPack = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: (e.clientX - r.left) / view, y: (e.clientY - r.top) / view };
  };

  /** Pan: the hand (tool or Space) or the middle button, anywhere in the host. */
  const onHostDown = (e: React.PointerEvent) => {
    if (e.button !== 1 && !(e.button === 0 && tool === "hand")) return;
    e.preventDefault();
    hostRef.current?.setPointerCapture(e.pointerId);
    setDrag({ kind: "view", startX: e.clientX, startY: e.clientY, pan });
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || tool === "hand") return;
    const p = toPack(e);
    if (painting) {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const d: Drag = { kind: "paint", points: [Math.round(p.x), Math.round(p.y)], erase: tool === "erase" };
      setDrag(d);
      props.onStroke?.({ points: d.points, size: brushSize, erase: d.erase }, false);
      return;
    }
    if (tool === "cut") {
      if (lasso) {
        const near = Math.hypot(p.x - lasso.points[0], p.y - lasso.points[1]) * view <= 10;
        // The second click of a double-click closes it (the first one already set its point).
        if (e.detail >= 2 || (near && lasso.points.length >= 6)) closeLasso(lasso);
        else setLasso({ ...lasso, points: [...lasso.points, p.x, p.y] });
        return;
      }
      // On the selected layer, else the one under the pointer.
      const target = selected ?? [...slide.layers].reverse().find((l) => canEdit(l) && inside(l.box, p.x, p.y));
      if (!target) return;
      if (target !== selected) props.onSelect(target.id);
      setLasso({ id: target.id, points: [p.x, p.y] });
      return;
    }
    if (cropping && inside(cropping.box, p.x, p.y)) {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setDrag({ kind: "pan", id: cropping.id, start: p, full: cropFull(cropping), crop: cropping.crop ?? { x: 0, y: 0, w: 1, h: 1 } });
      return;
    }
    const hit = [...slide.layers].reverse().find((l) => canEdit(l) && inside(l.box, p.x, p.y));
    // Inside the selected frame's box it stays the one worked on, even under others; elsewhere the topmost under the pointer.
    const target = selected && inside(selected.box, p.x, p.y) ? selected : hit;
    props.onSelect(target?.id ?? null);
    // The crop tool only picks; moving is the select tool's.
    if (!target || tool === "crop") return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ kind: "move", id: target.id, start: p, box: target.box });
  };

  /** Crop / pan drag → the layer's new crop, in its full content's px (the content stays where it is). */
  const cropNext = (e: React.PointerEvent, d: Extract<Drag, { kind: "crop" | "pan" }>) => {
    const p = toPack(e);
    const F = d.full;
    const c = d.crop;
    const dl = turn(p.x - d.start.x, p.y - d.start.y, -F.rotation);
    let l = c.x * F.w;
    let t = c.y * F.h;
    let r = (c.x + c.w) * F.w;
    let b = (c.y + c.h) * F.h;
    const min = 8;
    if (d.kind === "crop") {
      if (d.hx < 0) l = clamp(l + dl.x, 0, r - min);
      if (d.hx > 0) r = clamp(r + dl.x, l + min, F.w);
      if (d.hy < 0) t = clamp(t + dl.y, 0, b - min);
      if (d.hy > 0) b = clamp(b + dl.y, t + min, F.h);
    } else {
      // The crop window moves over the content.
      const w = r - l;
      const h = b - t;
      l = clamp(l + dl.x, 0, F.w - w);
      t = clamp(t + dl.y, 0, F.h - h);
      r = l + w;
      b = t + h;
    }
    const layer = slide.layers.find((x) => x.id === d.id);
    if (!layer) return null;
    const next = withCrop(layer, F, { x: l / F.w, y: t / F.h, w: (r - l) / F.w, h: (b - t) / F.h });
    return { box: next.box, crop: next.crop ?? null };
  };

  const onHandleDown = (e: React.PointerEvent, hx: number, hy: number) => {
    if (!selected) return;
    e.stopPropagation();
    hostRef.current?.setPointerCapture(e.pointerId);
    if (cropping) {
      setDrag({ kind: "crop", id: cropping.id, hx, hy, start: toPack(e), full: cropFull(cropping), crop: cropping.crop ?? { x: 0, y: 0, w: 1, h: 1 } });
      return;
    }
    setDrag({ kind: "resize", id: selected.id, hx, hy, start: toPack(e), box: selected.box });
  };

  const onRotateDown = (e: React.PointerEvent) => {
    if (!selected) return;
    e.stopPropagation();
    hostRef.current?.setPointerCapture(e.pointerId);
    setDrag({ kind: "rotate", id: selected.id, box: selected.box });
  };

  const next = (e: React.PointerEvent, d: Extract<Drag, { kind: "move" | "resize" | "rotate" }>): CtPackBox => {
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

  const emit = (e: React.PointerEvent, d: Drag, done: boolean) => {
    if (d.kind === "view") {
      setPan({ x: d.pan.x + e.clientX - d.startX, y: d.pan.y + e.clientY - d.startY });
      userView.current = true;
      return;
    }
    if (d.kind === "paint") {
      const p = toPack(e);
      const n = d.points.length;
      // A new point every few px keeps strokes light.
      if (Math.hypot(p.x - d.points[n - 2], p.y - d.points[n - 1]) > Math.max(2, brushSize * 0.08)) d.points.push(Math.round(p.x), Math.round(p.y));
      props.onStroke?.({ points: [...d.points], size: brushSize, erase: d.erase }, done);
      return;
    }
    if (d.kind === "crop" || d.kind === "pan") {
      const patch = cropNext(e, d);
      if (patch) props.onCrop?.(d.id, patch, done);
      return;
    }
    props.onBox(d.id, next(e, d), done);
  };
  const onMove = (e: React.PointerEvent) => {
    if (painting) setHover(toPack(e));
    if (tool === "cut") setAim(toPack(e));
    if (drag) emit(e, drag, false);
  };
  const onUp = (e: React.PointerEvent) => {
    if (!drag) return;
    emit(e, drag, true);
    setDrag(null);
  };

  const sb = selected?.box;
  const full = cropping ? cropFull(cropping) : null;
  const tone = cropping ? "border-amber-500" : "border-sky-500";
  return (
    <div
      ref={hostRef}
      className={cx("relative overflow-hidden", tool === "hand" && (drag?.kind === "view" ? "cursor-grabbing" : "cursor-grab"), props.className)}
      onPointerDown={onHostDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={() => {
        setHover(null);
        setAim(null);
      }}
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
      <div className="absolute shadow-lg" style={{ left: pan.x, top: pan.y, width: width * view, height: height * view, ...CHECKER_STYLE }}>
        <canvas
          ref={canvasRef}
          className={cx("absolute inset-0 h-full w-full touch-none", painting && "cursor-none", cropping && "cursor-move", tool === "cut" && "cursor-crosshair")}
          onPointerDown={onDown}
        />
        {painting && hover && (
          <div
            className={cx("pointer-events-none absolute rounded-full border", tool === "erase" ? "border-rose-400" : "border-white")}
            style={{
              left: (hover.x - brushSize / 2) * view,
              top: (hover.y - brushSize / 2) * view,
              width: brushSize * view,
              height: brushSize * view,
              boxShadow: "0 0 0 1px rgba(0,0,0,0.5)",
            }}
          />
        )}
        {lasso && (
          <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
            <polygon points={[...lasso.points, ...(aim ? [aim.x, aim.y] : [])].map((v) => v * view).join(" ")} fill="rgba(244,63,94,0.15)" />
            <polyline
              points={[...lasso.points, ...(aim ? [aim.x, aim.y] : [])].map((v) => v * view).join(" ")}
              fill="none"
              stroke="#f43f5e"
              strokeWidth={1.5}
              strokeDasharray="5 4"
            />
            {Array.from({ length: lasso.points.length / 2 }, (_, i) => (
              <circle
                key={i}
                cx={lasso.points[i * 2] * view}
                cy={lasso.points[i * 2 + 1] * view}
                r={i === 0 && lasso.points.length >= 6 ? 6 : 3.5}
                fill={i === 0 ? "#f43f5e" : "white"}
                stroke="#f43f5e"
                strokeWidth={1.5}
              />
            ))}
          </svg>
        )}
        {full && (
          <div
            className="pointer-events-none absolute border border-dashed border-amber-500/70"
            style={{ left: full.x * view, top: full.y * view, width: full.w * view, height: full.h * view, transform: `rotate(${full.rotation}deg)` }}
          />
        )}
        {sb && !painting && (
          <div
            className={cx("pointer-events-none absolute border", tone)}
            style={{
              left: sb.x * view,
              top: sb.y * view,
              width: sb.w * view,
              height: sb.h * view,
              transform: `rotate(${sb.rotation}deg)`,
            }}
          >
            {!cropping && tool !== "crop" && (
              <>
                <div className="absolute left-1/2 -top-6 h-6 w-px bg-sky-500" />
                <div
                  className="pointer-events-auto absolute left-1/2 -top-8 h-3 w-3 -translate-x-1/2 cursor-grab rounded-full border border-sky-500 bg-white"
                  onPointerDown={onRotateDown}
                />
              </>
            )}
            {HANDLES.map(([hx, hy]) => (
              <div
                key={`${hx}${hy}`}
                className={cx(
                  "absolute -translate-x-1/2 -translate-y-1/2 border bg-white",
                  cropping ? "h-3 w-3 border-amber-500" : "h-2.5 w-2.5 border-sky-500",
                  tool === "crop" && !cropping ? "pointer-events-none opacity-40" : "pointer-events-auto",
                )}
                style={{ left: `${(hx + 1) * 50}%`, top: `${(hy + 1) * 50}%`, cursor: hx && hy ? (hx === hy ? "nwse-resize" : "nesw-resize") : hx ? "ew-resize" : "ns-resize" }}
                onPointerDown={(e) => onHandleDown(e, hx, hy)}
              />
            ))}
          </div>
        )}
      </div>
      <div
        className="absolute bottom-3 right-3 z-10 flex items-center gap-1 rounded-md border bg-background/90 px-1 py-1 text-xs shadow"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button className="rounded px-2 py-1 hover:bg-accent" onClick={() => zoomBy(1 / 1.25)}>
          −
        </button>
        <span className="w-12 text-center tabular-nums">{Math.round(view * 100)}%</span>
        <button className="rounded px-2 py-1 hover:bg-accent" onClick={() => zoomBy(1.25)}>
          +
        </button>
        <button className="rounded px-2 py-1 hover:bg-accent" onClick={fit}>
          Vừa khung
        </button>
        <button className="rounded px-2 py-1 hover:bg-accent" onClick={() => zoomBy(1 / view)}>
          100%
        </button>
      </div>
    </div>
  );
}
