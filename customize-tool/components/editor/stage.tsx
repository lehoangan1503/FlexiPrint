"use client";

/**
 * The design canvas — Photoshop-style pan/zoom workspace over the main asset.
 *
 *   V  select / move         drag a region to move it, handles resize it;
 *                            polygons show draggable vertices (double-click an
 *                            edge to insert one, Alt+click a vertex to delete)
 *   H  hand (or hold Space)  pan
 *   R  rectangle zone        drag to draw
 *   O  ellipse zone          drag to draw
 *   P  polygon pen           click points; click the first point, double-click
 *                            or Enter to close; Esc cancels
 *   Object mode (toolbar or double-click a region) edits the selected object
 *   INSIDE its zone: drag = move, corner = scale, top knob = rotate.
 *   Moving / resizing snaps edges + centre to the main's edges, quarters and
 *   centre (an invisible grid; blue guides show the snapped line). Alt = no snap.
 *
 * Geometry is stored in main-asset pixels; `zoom` is screen px per asset px.
 * The composite underneath is the real compositor output, so what you see here
 * is exactly what the storefront and exports render.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CtAsset, CtBounds, CtPoint, CtRegion, CtRegionItem, CtRegionKind, CtSelection, CtShape, CtTransform } from "../../types";
import { clamp, fitShapeToBounds, itemPlacement, shapeBounds, shapeToSvgPath, SNAP_FRACTIONS, snapAxis, translateShape } from "../../lib/geometry";
import { drawComposite } from "../../lib/compositor";
import { makeRegion } from "../../lib/design";
import { cx, CHECKER_STYLE } from "../ui";
import type { DesignApi } from "./use-design";
import { updateItem, updateRegion } from "./use-design";

export type StageTool = "select" | "hand" | "rect" | "ellipse" | "polygon";
export type EditTarget = "region" | "object";

type ItemGeom = ReturnType<typeof itemPlacement>;

/** Snap guides being shown, in main-asset px. */
interface Guides {
  x: number[];
  y: number[];
}
const NO_GUIDES: Guides = { x: [], y: [] };
/** Snap distance in screen px — a light pull, easy to drag past. */
const SNAP_PX = 6;

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

type Gesture =
  | { kind: "pan"; startX: number; startY: number; panX: number; panY: number }
  | { kind: "draw"; shape: "rect" | "ellipse"; start: CtPoint; current: CtPoint }
  | { kind: "move-region"; id: string; start: CtPoint; shape: CtShape }
  | { kind: "resize-region"; id: string; handle: Handle; bounds: CtBounds; shape: CtShape }
  | { kind: "vertex"; id: string; index: number; shape: CtShape }
  | { kind: "move-item"; id: string; start: CtPoint; t: CtTransform; bounds: CtBounds; geom: ItemGeom | null }
  | { kind: "scale-item"; id: string; center: CtPoint; startDist: number; t: CtTransform }
  | { kind: "rotate-item"; id: string; center: CtPoint; startAngle: number; t: CtTransform };

export interface StageProps {
  productId: string;
  main: CtAsset;
  assets: CtAsset[];
  design: DesignApi;
  selection: CtSelection;
  tool: StageTool;
  onToolChange: (t: StageTool) => void;
  drawKind: CtRegionKind;
  editTarget: EditTarget;
  onEditTargetChange: (t: EditTarget) => void;
  selectedRegionId: string | null;
  onSelectRegion: (id: string | null) => void;
  activeItemId: string | null;
  showOverlay: boolean;
  /** Photo zones whose test photo is being processed: regionId -> spinner label. */
  photoBusy?: Record<string, string>;
}

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 32;

export function Stage(props: StageProps) {
  const { main, assets, design, selection, tool, drawKind, editTarget, selectedRegionId, activeItemId } = props;
  const { regions, items } = design.state;
  const layouts = design.state.config.layouts;

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(0.5);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [draft, setDraft] = useState<CtPoint[]>([]);
  const [hover, setHover] = useState<CtPoint | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [guides, setGuides] = useState<Guides>(NO_GUIDES);
  const gestureRef = useRef<Gesture | null>(null);
  gestureRef.current = gesture;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const panRef = useRef(pan);
  panRef.current = pan;

  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);

  // ------------------------------------------------------------------ view
  const fit = useCallback(() => {
    const el = viewportRef.current;
    if (!el || !main.width) return;
    const z = Math.min((el.clientWidth - 48) / main.width, (el.clientHeight - 48) / main.height);
    const nz = clamp(z, MIN_ZOOM, MAX_ZOOM);
    setZoom(nz);
    setPan({ x: (el.clientWidth - main.width * nz) / 2, y: (el.clientHeight - main.height * nz) / 2 });
  }, [main.width, main.height]);

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setViewport({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    if (viewport.w > 0 && fittedFor.current !== main.id) {
      fittedFor.current = main.id;
      fit();
    }
  }, [viewport.w, main.id, fit]);

  // Wheel: zoom pinned to cursor; with no modifier on a trackpad, two-finger
  // scroll pans (like Figma) — ctrlKey is what pinch gestures report.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = el!.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const isZoom = e.ctrlKey || e.metaKey || Math.abs(e.deltaY) >= 50 && e.deltaX === 0 && !e.shiftKey;
      if (!isZoom) {
        setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
        return;
      }
      const old = zoomRef.current;
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      const nz = clamp(old * factor, MIN_ZOOM, MAX_ZOOM);
      const p = panRef.current;
      setZoom(nz);
      setPan({ x: mx - ((mx - p.x) * nz) / old, y: my - ((my - p.y) * nz) / old });
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Space = temporary hand tool.
  useEffect(() => {
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !isTyping(e.target)) {
        e.preventDefault();
        setSpaceHeld(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // ------------------------------------------------------------------ render
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  // Quantised so zooming does not re-render the composite on every wheel tick.
  const renderScale = useMemo(() => {
    const want = clamp(zoom * dpr, 0.05, 1);
    const steps = [0.125, 0.25, 0.5, 0.75, 1];
    return steps.find((s) => s >= want) ?? 1;
  }, [zoom, dpr]);

  const renderToken = useRef(0);
  useEffect(() => {
    const token = ++renderToken.current;
    const raf = requestAnimationFrame(async () => {
      const off = document.createElement("canvas");
      off.width = Math.max(1, Math.round(main.width * renderScale));
      off.height = Math.max(1, Math.round(main.height * renderScale));
      const ctx = off.getContext("2d");
      if (!ctx) return;
      const shown: HTMLCanvasElement = off;
      try {
        await drawComposite(ctx, { main, assets, regions, items, selection, scale: renderScale, layouts });
      } catch {
        return;
      }
      if (token !== renderToken.current) return;
      const vis = canvasRef.current;
      if (!vis) return;
      vis.width = shown.width;
      vis.height = shown.height;
      vis.getContext("2d")?.drawImage(shown, 0, 0);
    });
    return () => cancelAnimationFrame(raf);
  }, [main, assets, regions, items, selection, renderScale, layouts]);

  // ------------------------------------------------------------------ coords
  const toWorld = useCallback((clientX: number, clientY: number): CtPoint => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const p = panRef.current;
    const z = zoomRef.current;
    return { x: (clientX - (rect?.left ?? 0) - p.x) / z, y: (clientY - (rect?.top ?? 0) - p.y) / z };
  }, []);

  const px = 1 / zoom; // one screen pixel in world units

  // ------------------------------------------------------------------ item geometry
  /** Asset currently rendered for an item (the selected variant if it belongs to it). */
  const shownAssetFor = useCallback(
    (item: CtRegionItem): CtAsset | undefined => {
      const sel = selection[item.region_id];
      if (sel?.kind === "image" && sel.assetId) {
        const a = byId.get(sel.assetId);
        if (a && (a.id === item.asset_id || a.parent_id === item.asset_id)) return a;
      }
      return byId.get(item.asset_id);
    },
    [selection, byId],
  );

  const activeItem = items.find((i) => i.id === activeItemId) ?? null;
  const activeRegion = regions.find((r) => r.id === selectedRegionId) ?? null;
  const itemGeom = useMemo(() => {
    if (!activeItem || !activeRegion || activeItem.region_id !== activeRegion.id) return null;
    const a = shownAssetFor(activeItem);
    if (!a) return null;
    return itemPlacement(shapeBounds(activeRegion.shape), a.width, a.height, activeItem.transform);
  }, [activeItem, activeRegion, shownAssetFor]);

  // ------------------------------------------------------------------ pointer
  const effectiveTool: StageTool = spaceHeld ? "hand" : tool;

  const startPan = (e: React.PointerEvent) => {
    setGesture({ kind: "pan", startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y });
  };

  // ------------------------------------------------------------------ snapping
  const snapLines = useMemo(
    () => ({ x: SNAP_FRACTIONS.map((f) => f * main.width), y: SNAP_FRACTIONS.map((f) => f * main.height) }),
    [main.width, main.height],
  );

  /** Snap one coordinate (a dragged edge) to the grid; null when nothing is close. */
  const snapLine = (v: number, axis: "x" | "y", off: boolean) => (off ? null : snapAxis([v], snapLines[axis], SNAP_PX / zoomRef.current));

  /** Snap a box's edges + centre to the grid, set the guides, return the correction. */
  const snapBox = (b: CtBounds, off: boolean, lockX: boolean, lockY: boolean): { dx: number; dy: number } => {
    const t = SNAP_PX / zoomRef.current;
    const sx = off || lockX ? null : snapAxis([b.x, b.x + b.w / 2, b.x + b.w], snapLines.x, t);
    const sy = off || lockY ? null : snapAxis([b.y, b.y + b.h / 2, b.y + b.h], snapLines.y, t);
    setGuides({ x: sx ? [sx.line] : [], y: sy ? [sy.line] : [] });
    return { dx: sx?.delta ?? 0, dy: sy?.delta ?? 0 };
  };

  const closePolygon = useCallback(
    (raw: CtPoint[]) => {
      // A double-click to close also lands two clicks on the same spot.
      const points = raw.filter((p, i) => i === 0 || Math.hypot(p.x - raw[i - 1].x, p.y - raw[i - 1].y) * zoomRef.current > 3);
      if (points.length >= 3) {
        const region = makeRegion(props.productId, drawKind, { type: "polygon", points }, regions.length);
        design.commit((s) => ({ ...s, regions: [...s.regions, region] }));
        props.onSelectRegion(region.id);
        props.onToolChange("select");
      }
      setDraft((d) => (d.length ? [] : d));
    },
    [design, drawKind, props, regions.length],
  );

  const onViewportPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    if (e.button === 1 || effectiveTool === "hand") {
      startPan(e);
      return;
    }
    if (e.button !== 0) return;
    const w = toWorld(e.clientX, e.clientY);
    if (effectiveTool === "rect" || effectiveTool === "ellipse") {
      setGesture({ kind: "draw", shape: effectiveTool, start: w, current: w });
      return;
    }
    if (effectiveTool === "polygon") {
      if (draft.length >= 3) {
        const first = draft[0];
        if (Math.hypot((first.x - w.x) * zoom, (first.y - w.y) * zoom) < 10) {
          closePolygon(draft);
          return;
        }
      }
      setDraft((d) => [...d, w]);
      return;
    }
    // select tool on empty canvas → deselect
    props.onSelectRegion(null);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const w = toWorld(e.clientX, e.clientY);
    if (effectiveTool === "polygon") setHover(w);
    const g = gestureRef.current;
    if (!g) return;
    switch (g.kind) {
      case "pan":
        setPan({ x: g.panX + e.clientX - g.startX, y: g.panY + e.clientY - g.startY });
        break;
      case "draw":
        setGesture({ ...g, current: w });
        break;
      case "move-region": {
        let dx = w.x - g.start.x;
        let dy = w.y - g.start.y;
        let lockX = false;
        let lockY = false;
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) {
            dy = 0;
            lockY = true;
          } else {
            dx = 0;
            lockX = true;
          }
        }
        const b = shapeBounds(g.shape);
        const snap = snapBox({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h }, e.altKey, lockX, lockY);
        design.live((s) => updateRegion(s, g.id, (r) => ({ ...r, shape: translateShape(g.shape, dx + snap.dx, dy + snap.dy) })));
        break;
      }
      case "resize-region": {
        const b = g.bounds;
        let x0 = b.x;
        let y0 = b.y;
        let x1 = b.x + b.w;
        let y1 = b.y + b.h;
        const aspectLock = e.shiftKey && g.handle.length === 2 && b.w > 0 && b.h > 0;
        const ex = g.handle.includes("w") || g.handle.includes("e") ? snapLine(w.x, "x", e.altKey) : null;
        // With the aspect locked the height follows the width, so only x snaps.
        const ey = !aspectLock && (g.handle.includes("n") || g.handle.includes("s")) ? snapLine(w.y, "y", e.altKey) : null;
        const sx = ex?.line ?? w.x;
        const sy = ey?.line ?? w.y;
        setGuides({ x: ex ? [ex.line] : [], y: ey ? [ey.line] : [] });
        if (g.handle.includes("w")) x0 = Math.min(sx, x1 - 2);
        if (g.handle.includes("e")) x1 = Math.max(sx, x0 + 2);
        if (g.handle.includes("n")) y0 = Math.min(sy, y1 - 2);
        if (g.handle.includes("s")) y1 = Math.max(sy, y0 + 2);
        // Shift on a corner keeps the aspect ratio.
        if (aspectLock) {
          const ratio = b.w / b.h;
          const nw = x1 - x0;
          const nh = nw / ratio;
          if (g.handle.includes("n")) y0 = y1 - nh;
          else y1 = y0 + nh;
        }
        const next = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        design.live((s) => updateRegion(s, g.id, (r) => ({ ...r, shape: fitShapeToBounds(g.shape, next) })));
        break;
      }
      case "vertex": {
        if (g.shape.type !== "polygon") break;
        const points = g.shape.points.map((p, i) => (i === g.index ? w : p));
        design.live((s) => updateRegion(s, g.id, (r) => ({ ...r, shape: { type: "polygon", points } })));
        break;
      }
      case "move-item": {
        let mx = w.x - g.start.x;
        let my = w.y - g.start.y;
        if (g.geom) {
          // A rotated image snaps by its centre only; its bbox edges are not its outline.
          const flat = Math.abs(g.geom.rotation % 90) < 0.5;
          const cxNew = g.geom.cx + mx;
          const cyNew = g.geom.cy + my;
          const snap = flat
            ? snapBox({ x: cxNew - g.geom.w / 2, y: cyNew - g.geom.h / 2, w: g.geom.w, h: g.geom.h }, e.altKey, false, false)
            : snapBox({ x: cxNew, y: cyNew, w: 0, h: 0 }, e.altKey, false, false);
          mx += snap.dx;
          my += snap.dy;
        }
        const dx = mx / Math.max(1, g.bounds.w);
        const dy = my / Math.max(1, g.bounds.h);
        design.live((s) =>
          updateItem(s, g.id, (it) => ({ ...it, transform: { ...g.t, offsetX: g.t.offsetX + dx, offsetY: g.t.offsetY + dy } })),
        );
        break;
      }
      case "scale-item": {
        const d = Math.hypot(w.x - g.center.x, w.y - g.center.y);
        const scale = clamp((g.t.scale * d) / Math.max(1, g.startDist), 0.02, 20);
        design.live((s) => updateItem(s, g.id, (it) => ({ ...it, transform: { ...g.t, scale } })));
        break;
      }
      case "rotate-item": {
        const a = (Math.atan2(w.y - g.center.y, w.x - g.center.x) * 180) / Math.PI;
        let rotation = g.t.rotation + a - g.startAngle;
        if (e.shiftKey) rotation = Math.round(rotation / 15) * 15;
        design.live((s) => updateItem(s, g.id, (it) => ({ ...it, transform: { ...g.t, rotation } })));
        break;
      }
    }
  };

  const onPointerUp = () => {
    const g = gestureRef.current;
    setGesture(null);
    setGuides(NO_GUIDES);
    if (!g) return;
    if (g.kind === "draw") {
      const x = Math.min(g.start.x, g.current.x);
      const y = Math.min(g.start.y, g.current.y);
      const w = Math.abs(g.current.x - g.start.x);
      const h = Math.abs(g.current.y - g.start.y);
      if (w * zoom < 4 || h * zoom < 4) return;
      const shape: CtShape =
        g.shape === "rect"
          ? { type: "rect", x, y, w, h, radius: 0 }
          : { type: "ellipse", cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 };
      const region = makeRegion(props.productId, drawKind, shape, regions.length);
      design.commit((s) => ({ ...s, regions: [...s.regions, region] }));
      props.onSelectRegion(region.id);
      props.onToolChange("select");
      return;
    }
    if (g.kind !== "pan") design.checkpoint();
  };

  // Leaving the pen drops an unfinished outline. Functional update returning
  // the same array when already empty: `setDraft([])` makes a new array every
  // time, and with an effect that re-runs each render (closePolygon depends on
  // `props`) that was an infinite render loop.
  useEffect(() => {
    if (tool !== "polygon") setDraft((d) => (d.length ? [] : d));
  }, [tool]);

  // Keyboard for the polygon pen. Reads the latest draft/closer through refs
  // so the listener is bound once per pen session, not once per render.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const closePolygonRef = useRef(closePolygon);
  closePolygonRef.current = closePolygon;
  useEffect(() => {
    if (tool !== "polygon") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") closePolygonRef.current(draftRef.current);
      if (e.key === "Escape") setDraft((d) => (d.length ? [] : d));
      if (e.key === "Backspace") setDraft((d) => (d.length ? d.slice(0, -1) : d));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool]);

  // ------------------------------------------------------------------ region handlers
  const onRegionPointerDown = (e: React.PointerEvent, region: CtRegion) => {
    if (effectiveTool !== "select") return;
    e.stopPropagation();
    viewportRef.current?.setPointerCapture(e.pointerId);
    props.onSelectRegion(region.id);
    if (editTarget === "object" && region.id === selectedRegionId && itemGeom && activeItem) {
      setGesture({
        kind: "move-item",
        id: activeItem.id,
        start: toWorld(e.clientX, e.clientY),
        t: activeItem.transform,
        bounds: shapeBounds(region.shape),
        geom: itemGeom,
      });
      return;
    }
    setGesture({ kind: "move-region", id: region.id, start: toWorld(e.clientX, e.clientY), shape: region.shape });
  };

  const onRegionDoubleClick = (e: React.MouseEvent, region: CtRegion) => {
    e.stopPropagation();
    if (region.shape.type === "polygon" && editTarget === "region") {
      // Insert a vertex on the nearest edge.
      const w = toWorld(e.clientX, e.clientY);
      const pts = region.shape.points;
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        const d = distToSegment(w, a, b);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (bestD * zoom < 12) {
        const points = [...pts.slice(0, best + 1), w, ...pts.slice(best + 1)];
        design.commit((s) => updateRegion(s, region.id, (r) => ({ ...r, shape: { type: "polygon", points } })));
        return;
      }
    }
    if (region.kind === "image") props.onEditTargetChange(editTarget === "object" ? "region" : "object");
  };

  const onHandleDown = (e: React.PointerEvent, region: CtRegion, handle: Handle) => {
    e.stopPropagation();
    viewportRef.current?.setPointerCapture(e.pointerId);
    setGesture({ kind: "resize-region", id: region.id, handle, bounds: shapeBounds(region.shape), shape: region.shape });
  };

  const onVertexDown = (e: React.PointerEvent, region: CtRegion, index: number) => {
    e.stopPropagation();
    if (region.shape.type !== "polygon") return;
    if (e.altKey) {
      if (region.shape.points.length > 3) {
        const points = region.shape.points.filter((_, i) => i !== index);
        design.commit((s) => updateRegion(s, region.id, (r) => ({ ...r, shape: { type: "polygon", points } })));
      }
      return;
    }
    viewportRef.current?.setPointerCapture(e.pointerId);
    setGesture({ kind: "vertex", id: region.id, index, shape: region.shape });
  };

  const onItemHandleDown = (e: React.PointerEvent, mode: "scale" | "rotate") => {
    e.stopPropagation();
    if (!itemGeom || !activeItem) return;
    viewportRef.current?.setPointerCapture(e.pointerId);
    const w = toWorld(e.clientX, e.clientY);
    const center = { x: itemGeom.cx, y: itemGeom.cy };
    if (mode === "scale") {
      setGesture({ kind: "scale-item", id: activeItem.id, center, startDist: Math.hypot(w.x - center.x, w.y - center.y), t: activeItem.transform });
    } else {
      setGesture({
        kind: "rotate-item",
        id: activeItem.id,
        center,
        startAngle: (Math.atan2(w.y - center.y, w.x - center.x) * 180) / Math.PI,
        t: activeItem.transform,
      });
    }
  };

  // ------------------------------------------------------------------ draw
  const kindColor: Record<CtRegionKind, string> = { image: "#0ea5e9", text: "#f59e0b", photo: "#a855f7" };
  const cursor =
    gesture?.kind === "pan" || effectiveTool === "hand"
      ? gesture?.kind === "pan"
        ? "grabbing"
        : "grab"
      : effectiveTool === "select"
        ? "default"
        : "crosshair";

  const draftShape: CtShape | null =
    gesture?.kind === "draw"
      ? (() => {
          const x = Math.min(gesture.start.x, gesture.current.x);
          const y = Math.min(gesture.start.y, gesture.current.y);
          const w = Math.abs(gesture.current.x - gesture.start.x);
          const h = Math.abs(gesture.current.y - gesture.start.y);
          return gesture.shape === "rect"
            ? { type: "rect", x, y, w, h, radius: 0 }
            : { type: "ellipse", cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 };
        })()
      : null;

  const selected = activeRegion;
  const selBounds = selected ? shapeBounds(selected.shape) : null;
  const hs = 8 * px; // handle size

  return (
    <div
      ref={viewportRef}
      className="relative h-full w-full overflow-hidden bg-neutral-200 dark:bg-neutral-900 select-none touch-none"
      style={{ cursor }}
      onPointerDown={onViewportPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setHover(null)}
      onDoubleClick={() => tool === "polygon" && closePolygon(draft)}
    >
      <div
        className="absolute left-0 top-0 origin-top-left shadow-2xl"
        style={{
          width: main.width,
          height: main.height,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          ...CHECKER_STYLE,
          backgroundSize: `${16 * px}px ${16 * px}px`,
        }}
      >
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
        <svg
          className="absolute inset-0 h-full w-full overflow-visible"
          viewBox={`0 0 ${main.width} ${main.height}`}
          style={{ pointerEvents: "none" }}
        >
          {props.showOverlay &&
            regions.map((r) => {
              const isSel = r.id === selectedRegionId;
              return (
                <path
                  key={r.id}
                  d={shapeToSvgPath(r.shape)}
                  // No tint: a coloured fill over the zone falsifies the colours of what's in it
                  // (a 13% purple film made every photo style look pink). The outline marks it;
                  // pointerEvents "all" still hit-tests the transparent interior.
                  fill="transparent"
                  stroke={kindColor[r.kind]}
                  strokeWidth={isSel ? 2 : 1.25}
                  strokeDasharray={isSel ? undefined : "6 4"}
                  vectorEffect="non-scaling-stroke"
                  style={{ pointerEvents: effectiveTool === "select" ? "all" : "none", cursor: "move" }}
                  onPointerDown={(e) => onRegionPointerDown(e, r)}
                  onDoubleClick={(e) => onRegionDoubleClick(e, r)}
                />
              );
            })}

          {props.showOverlay && selected && selBounds && effectiveTool === "select" && editTarget === "region" && (
            <g>
              <rect
                x={selBounds.x}
                y={selBounds.y}
                width={selBounds.w}
                height={selBounds.h}
                fill="none"
                stroke="#0ea5e9"
                strokeWidth={1}
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
              />
              {HANDLES.map((h) => {
                const p = handlePos(selBounds, h);
                return (
                  <rect
                    key={h}
                    x={p.x - hs / 2}
                    y={p.y - hs / 2}
                    width={hs}
                    height={hs}
                    fill="#fff"
                    stroke="#0ea5e9"
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                    style={{ pointerEvents: "all", cursor: HANDLE_CURSOR[h] }}
                    onPointerDown={(e) => onHandleDown(e, selected, h)}
                  />
                );
              })}
              {selected.shape.type === "polygon" &&
                selected.shape.points.map((p, i) => (
                  <circle
                    key={i}
                    cx={p.x}
                    cy={p.y}
                    r={5 * px}
                    fill="#0ea5e9"
                    stroke="#fff"
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                    style={{ pointerEvents: "all", cursor: "pointer" }}
                    onPointerDown={(e) => onVertexDown(e, selected, i)}
                  />
                ))}
            </g>
          )}

          {props.showOverlay && editTarget === "object" && itemGeom && (
            <g transform={`rotate(${itemGeom.rotation} ${itemGeom.cx} ${itemGeom.cy})`}>
              <rect
                x={itemGeom.cx - itemGeom.w / 2}
                y={itemGeom.cy - itemGeom.h / 2}
                width={itemGeom.w}
                height={itemGeom.h}
                fill="#f43f5e11"
                stroke="#f43f5e"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
                style={{ pointerEvents: "all", cursor: "move" }}
                onPointerDown={(e) => selected && onRegionPointerDown(e, selected)}
              />
              <line
                x1={itemGeom.cx}
                y1={itemGeom.cy - itemGeom.h / 2}
                x2={itemGeom.cx}
                y2={itemGeom.cy - itemGeom.h / 2 - 28 * px}
                stroke="#f43f5e"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={itemGeom.cx}
                cy={itemGeom.cy - itemGeom.h / 2 - 28 * px}
                r={6 * px}
                fill="#fff"
                stroke="#f43f5e"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
                style={{ pointerEvents: "all", cursor: "grab" }}
                onPointerDown={(e) => onItemHandleDown(e, "rotate")}
              />
              {[
                [-1, -1],
                [1, -1],
                [1, 1],
                [-1, 1],
              ].map(([sx, sy]) => (
                <rect
                  key={`${sx}${sy}`}
                  x={itemGeom.cx + (sx * itemGeom.w) / 2 - hs / 2}
                  y={itemGeom.cy + (sy * itemGeom.h) / 2 - hs / 2}
                  width={hs}
                  height={hs}
                  fill="#fff"
                  stroke="#f43f5e"
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                  style={{ pointerEvents: "all", cursor: "nwse-resize" }}
                  onPointerDown={(e) => onItemHandleDown(e, "scale")}
                />
              ))}
            </g>
          )}

          {draftShape && (
            <path
              d={shapeToSvgPath(draftShape)}
              fill={`${kindColor[drawKind]}22`}
              stroke={kindColor[drawKind]}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          )}

          {draft.length > 0 && (
            <g>
              <polyline
                points={[...draft, ...(hover ? [hover] : [])].map((p) => `${p.x},${p.y}`).join(" ")}
                fill={`${kindColor[drawKind]}18`}
                stroke={kindColor[drawKind]}
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
              />
              {draft.map((p, i) => (
                <circle
                  key={i}
                  cx={p.x}
                  cy={p.y}
                  r={(i === 0 ? 6 : 4) * px}
                  fill={i === 0 ? "#fff" : kindColor[drawKind]}
                  stroke={kindColor[drawKind]}
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </g>
          )}

          {guides.x.map((x) => (
            <line key={`gx${x}`} x1={x} y1={-40 * px} x2={x} y2={main.height + 40 * px} stroke="#3b82f6" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          {guides.y.map((y) => (
            <line key={`gy${y}`} x1={-40 * px} y1={y} x2={main.width + 40 * px} y2={y} stroke="#3b82f6" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
        {Object.entries(props.photoBusy ?? {}).map(([regionId, text]) => {
          const r = regions.find((x) => x.id === regionId);
          if (!r) return null;
          const b = shapeBounds(r.shape);
          return (
            <div
              key={regionId}
              className="pointer-events-none absolute flex items-center justify-center"
              style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
            >
              {/* Counter-scaled so the spinner stays a constant screen size at any zoom. */}
              <div className="flex items-center gap-2 whitespace-nowrap rounded-full bg-neutral-950/90 px-3 py-1.5 text-xs font-medium text-white shadow-lg ring-1 ring-white/10" style={{ transform: `scale(${px})` }}>
                {/* Colours inline: globals.css's unlayered `* { border-color }` beats Tailwind's border-* utilities. */}
                <span
                  className="h-4 w-4 shrink-0 animate-spin rounded-full border-2"
                  style={{ borderColor: "rgba(255,255,255,0.25)", borderTopColor: "#fff" }}
                />
                {text}
              </div>
            </div>
          );
        })}
      </div>

      <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-md border bg-background/90 px-1 py-1 text-xs shadow">
        <button className="rounded px-2 py-1 hover:bg-accent" onClick={(e) => { e.stopPropagation(); setZoom((z) => clamp(z / 1.25, MIN_ZOOM, MAX_ZOOM)); }} onPointerDown={(e) => e.stopPropagation()}>
          −
        </button>
        <span className="w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
        <button className="rounded px-2 py-1 hover:bg-accent" onClick={(e) => { e.stopPropagation(); setZoom((z) => clamp(z * 1.25, MIN_ZOOM, MAX_ZOOM)); }} onPointerDown={(e) => e.stopPropagation()}>
          +
        </button>
        <button className="rounded px-2 py-1 hover:bg-accent" onClick={(e) => { e.stopPropagation(); fit(); }} onPointerDown={(e) => e.stopPropagation()}>
          Vừa khung
        </button>
        <button className="rounded px-2 py-1 hover:bg-accent" onClick={(e) => { e.stopPropagation(); setZoom(1); }} onPointerDown={(e) => e.stopPropagation()}>
          100%
        </button>
      </div>

      {tool === "polygon" && (
        <div className="pointer-events-none absolute left-3 top-3 rounded bg-black/70 px-2 py-1 text-xs text-white">
          Click để thêm điểm · click điểm đầu / double-click / Enter để đóng · Backspace xoá điểm · Esc huỷ
        </div>
      )}
      {editTarget === "object" && (
        <div className={cx("pointer-events-none absolute left-3 rounded bg-rose-600/90 px-2 py-1 text-xs text-white", tool === "polygon" ? "top-10" : "top-3")}>
          Chế độ Object: kéo để di chuyển · góc để scale · núm trên để xoay (Shift = 15°)
        </div>
      )}
    </div>
  );
}

const HANDLE_CURSOR: Record<Handle, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
};

function handlePos(b: CtBounds, h: Handle): CtPoint {
  const x = h.includes("w") ? b.x : h.includes("e") ? b.x + b.w : b.x + b.w / 2;
  const y = h.includes("n") ? b.y : h.includes("s") ? b.y + b.h : b.y + b.h / 2;
  return { x, y };
}

function distToSegment(p: CtPoint, a: CtPoint, b: CtPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
