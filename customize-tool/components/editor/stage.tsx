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
 *   The version's own picture is a frame too (CtMainLayout.frame): click it to
 *   select it, drag to move, handles resize it (corners keep the aspect, Shift =
 *   free). The artboard behind — the default main's size — never changes.
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
import type { CtAsset, CtBounds, CtMainFrame, CtProductScene, CtPhotoFrame, CtPoint, CtRegion, CtRegionItem, CtRegionKind, CtSelection, CtShape, CtTransform } from "../../types";
import { clamp, fitShapeToBounds, itemPlacement, photoFrameBox, resolvePhotoFrame, shapeBounds, shapeToSvgPath, SNAP_FRACTIONS, snapAxis, translateShape } from "../../lib/geometry";
import { drawComposite } from "../../lib/compositor";
import { activeRegions, hasTestPhoto, makeRegion } from "../../lib/design";
import { cx, CHECKER_STYLE } from "../ui";
import type { DesignApi } from "./use-design";
import { useImageSize } from "./use-image-size";
import { CLIPART_DRAG, type CtClipartDrag } from "./library-panel";
import { updateItem, updateRegion } from "./use-design";
import { mainFrameFor } from "../../lib/layout";
import { frameSvgPath } from "../../lib/material-frame";
import { safeShapes } from "../../lib/print-template";
import type { CtPrintSpec } from "../../types/print";

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);

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
/** ms after a click selects another zone during which dragging doesn't move it. */
const SELECT_HOLD_MS = 500;

type Gesture =
  | { kind: "pan"; startX: number; startY: number; panX: number; panY: number }
  | { kind: "draw"; shape: "rect" | "ellipse"; start: CtPoint; current: CtPoint }
  | { kind: "move-region"; id: string; start: CtPoint; shape: CtShape }
  | { kind: "resize-region"; id: string; handle: Handle; bounds: CtBounds; shape: CtShape }
  | { kind: "vertex"; id: string; index: number; shape: CtShape }
  | { kind: "move-item"; id: string; start: CtPoint; t: CtTransform; bounds: CtBounds; geom: ItemGeom | null }
  | { kind: "scale-item"; id: string; center: CtPoint; startDist: number; t: CtTransform }
  | { kind: "rotate-item"; id: string; center: CtPoint; startAngle: number; t: CtTransform }
  // A photo zone's child frame (CtPhotoFrame): id = the region.
  | { kind: "move-frame"; id: string; start: CtPoint; f: CtPhotoFrame; bounds: CtBounds }
  | { kind: "scale-frame"; id: string; center: CtPoint; startDist: number; f: CtPhotoFrame }
  | { kind: "stretch-frame"; id: string; axis: "x" | "y"; center: CtPoint; f: CtPhotoFrame; bounds: CtBounds }
  | { kind: "rotate-frame"; id: string; center: CtPoint; startAngle: number; f: CtPhotoFrame }
  // The shown version's picture frame (CtMainLayout.frame).
  | { kind: "move-main"; start: CtPoint; f: CtMainFrame }
  | { kind: "resize-main"; handle: Handle; f: CtMainFrame };

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
  /** The layer hovered in Layers: its frame shows (the canvas only outlines the selected layer otherwise). */
  hoverRegionId?: string | null;
  /** Photo zones whose test photo is being processed: regionId -> spinner label. */
  photoBusy?: Record<string, string>;
  /** A library clipart dropped on the canvas, at main-asset pixel coordinates. */
  onDropClipart?: (drag: CtClipartDrag, at: CtPoint) => void;
  /** Background photo drawn behind the design (Thiết kế → Nền). */
  scene?: CtProductScene;
  /** The version shown, whose picture frame can be selected / moved / resized. */
  versionId: string;
  mainSelected: boolean;
  onSelectMain: (on: boolean) => void;
  /** A click (not a drag) on a custom layer that has no picture yet: pick one (the thư viện ảnh tổ hợp). */
  onEmptyLayerClick?: (regionId: string) => void;
  /** The khuôn vật liệu the shown version is cut to (lib/material-frame): outside it is dimmed, its cuts hatched. */
  materialFrame?: CtRegion | null;
  /**
   * A shape drawn with the frame tools goes here instead of becoming a new zone (a khuôn vật liệu, or a part cut
   * out of one); its own label shows while drawing.
   */
  drawInto?: { label: string; onShape: (shape: CtShape) => void } | null;
  /** The khuôn in the product is made on (types/print.ts): its guide sheet, safe zone and zones over the canvas. */
  printSpec?: CtPrintSpec | null;
}

const MIN_ZOOM = 0.02;

const boundsArea = (b: { w: number; h: number }) => b.w * b.h;
const MAX_ZOOM = 32;

export function Stage(props: StageProps) {
  const { main, assets, design, selection, tool, drawKind, editTarget, selectedRegionId, activeItemId } = props;
  const { regions, items } = design.state;
  // Child zones show while their parent shows their option (the selected one always).
  const shownRegions = useMemo(() => {
    const active = new Set(activeRegions(regions, selection).map((r) => r.id));
    return regions.filter((r) => active.has(r.id) || r.id === selectedRegionId);
  }, [regions, selection, selectedRegionId]);
  const layouts = design.state.config.layouts;
  /** The layer under the mouse on the canvas; the Layers row hovered wins. */
  const [canvasHover, setCanvasHover] = useState<string | null>(null);
  const hoverId = props.hoverRegionId ?? canvasHover;
  const hovered = hoverId ? regions.find((r) => r.id === hoverId) ?? null : null;

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(0.5);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [draft, setDraft] = useState<CtPoint[]>([]);
  /** Points stepped back with Ctrl+Z while drawing, newest last; a new click clears them. */
  const draftRedo = useRef<CtPoint[]>([]);
  const [hover, setHover] = useState<CtPoint | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [guides, setGuides] = useState<Guides>(NO_GUIDES);
  const [dropping, setDropping] = useState(false);
  const gestureRef = useRef<Gesture | null>(null);
  gestureRef.current = gesture;
  // A click that SELECTS another zone doesn't move it: drags are held for SELECT_HOLD_MS after it.
  // (Zone ↔ its child frame is not held: inside a photo zone every click toggles between them.)
  const moveHeldUntil = useRef(0);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const panRef = useRef(pan);
  panRef.current = pan;

  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const mainFrame = mainFrameFor(layouts, props.versionId, main.width, main.height);
  const setMainFrame = (f: CtMainFrame) =>
    design.live((s) => {
      const cur = s.config.layouts[props.versionId] ?? { regions: {}, items: {} };
      return { ...s, config: { ...s.config, layouts: { ...s.config.layouts, [props.versionId]: { ...cur, frame: f } } } };
    });

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
  // Quantised so zooming does not re-render the composite on every wheel tick. Zoomed past 100 % it renders above
  // the main's own size (capped at ~4K px), so a customer photo — far sharper than the main's pixels — stays sharp.
  const renderScale = useMemo(() => {
    const max = Math.max(1, Math.min(4, 4096 / Math.max(main.width, main.height)));
    const want = clamp(zoom * dpr, 0.05, max);
    const steps = [0.125, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4].filter((s) => s <= max);
    return steps.find((s) => s >= want) ?? steps[steps.length - 1];
  }, [zoom, dpr, main.width, main.height]);

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
  const sceneRect = useMemo(() => {
    const sc = props.scene;
    if (!sc?.url || !sc.box.w) return null;
    const k = main.width / sc.box.w;
    return { x: -sc.box.x * k, y: -sc.box.y * k, w: sc.width * k, h: sc.height * k };
  }, [props.scene, main.width]);

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

  /** Object mode on a photo zone edits its child frame — where the customer's photo goes inside the zone. */
  // An auto frame is worked out for the test photo shown in the zone (its size), like the compositor does.
  const activeSel = activeRegion ? selection[activeRegion.id] : undefined;
  const testPhotoSize = useImageSize(activeSel?.kind === "photo" ? activeSel.url : null);
  const photoFrame = useMemo(
    () =>
      activeRegion?.kind === "photo" && activeRegion.config.photo && activeRegion.config.photo.frame?.enabled !== false && hasTestPhoto(activeSel)
        ? resolvePhotoFrame(activeRegion.config.photo, activeRegion.shape, testPhotoSize)
        : null,
    [activeRegion, activeSel, testPhotoSize],
  );
  const frameGeom = useMemo(
    () => (activeRegion && photoFrame ? photoFrameBox(shapeBounds(activeRegion.shape), photoFrame) : null),
    [activeRegion, photoFrame],
  );
  /** A frame moved by hand stays where it was put: auto off. */
  const setFrame = (id: string, f: CtPhotoFrame) =>
    design.live((s) => updateRegion(s, id, (r) => ({ ...r, config: { ...r.config, photo: { ...r.config.photo, frame: { ...f, auto: false } } } })));

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
      if (points.length >= 3 && props.drawInto) {
        props.drawInto.onShape({ type: "polygon", points });
        props.onToolChange("select");
      } else if (points.length >= 3) {
        const region = makeRegion(props.productId, drawKind, { type: "polygon", points }, regions.length);
        design.commit((s) => ({ ...s, regions: [...s.regions, region] }));
        props.onSelectRegion(region.id);
        props.onToolChange("select");
      }
      setDraft((d) => (d.length ? [] : d));
      draftRedo.current = [];
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
      draftRedo.current = [];
      return;
    }
    // select tool: on the version's picture → select its frame (and drag it); empty artboard → deselect
    props.onSelectRegion(null);
    if (insideFrame(w, mainFrame)) {
      props.onSelectMain(true);
      setGesture({ kind: "move-main", start: w, f: mainFrame });
    } else props.onSelectMain(false);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const w = toWorld(e.clientX, e.clientY);
    if (effectiveTool === "polygon") setHover(w);
    const g = gestureRef.current;
    if (!g) return;
    if ((g.kind === "move-region" || g.kind === "move-frame") && performance.now() < moveHeldUntil.current) {
      // Held: the drag starts from wherever the pointer is when the hold ends — no jump.
      gestureRef.current = { ...g, start: w };
      setGesture(gestureRef.current);
      return;
    }
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
      case "move-main": {
        let dx = w.x - g.start.x;
        let dy = w.y - g.start.y;
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        const snap = g.f.rotation ? { dx: 0, dy: 0 } : snapBox({ x: g.f.x + dx, y: g.f.y + dy, w: g.f.w, h: g.f.h }, e.altKey, false, false);
        setMainFrame({ ...g.f, x: g.f.x + dx + snap.dx, y: g.f.y + dy + snap.dy });
        break;
      }
      case "resize-main": {
        const b = g.f;
        let x0 = b.x;
        let y0 = b.y;
        let x1 = b.x + b.w;
        let y1 = b.y + b.h;
        const ex = g.handle.includes("w") || g.handle.includes("e") ? snapLine(w.x, "x", e.altKey) : null;
        const sx = ex?.line ?? w.x;
        setGuides({ x: ex ? [ex.line] : [], y: [] });
        if (g.handle.includes("w")) x0 = Math.min(sx, x1 - 4);
        if (g.handle.includes("e")) x1 = Math.max(sx, x0 + 4);
        if (g.handle.includes("n")) y0 = Math.min(w.y, y1 - 4);
        if (g.handle.includes("s")) y1 = Math.max(w.y, y0 + 4);
        // A picture keeps its aspect on a corner (Shift = free).
        if (g.handle.length === 2 && !e.shiftKey && b.w > 0 && b.h > 0) {
          const nh = (x1 - x0) * (b.h / b.w);
          if (g.handle.includes("n")) y0 = y1 - nh;
          else y1 = y0 + nh;
        }
        setMainFrame({ ...b, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
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
      case "move-frame": {
        const dx = (w.x - g.start.x) / Math.max(1, g.bounds.w);
        const dy = (w.y - g.start.y) / Math.max(1, g.bounds.h);
        setFrame(g.id, { ...g.f, offsetX: g.f.offsetX + dx, offsetY: g.f.offsetY + dy });
        break;
      }
      case "scale-frame": {
        const k = Math.hypot(w.x - g.center.x, w.y - g.center.y) / Math.max(1, g.startDist);
        setFrame(g.id, { ...g.f, scaleX: clamp(g.f.scaleX * k, 0.02, 20), scaleY: clamp(g.f.scaleY * k, 0.02, 20) });
        break;
      }
      case "stretch-frame": {
        // Distance from the centre along the frame's own (rotated) axis = half the new size.
        const t = (g.f.rotation * Math.PI) / 180;
        const vx = w.x - g.center.x;
        const vy = w.y - g.center.y;
        const along = g.axis === "x" ? vx * Math.cos(t) + vy * Math.sin(t) : -vx * Math.sin(t) + vy * Math.cos(t);
        const size = (2 * Math.abs(along)) / Math.max(1, g.axis === "x" ? g.bounds.w : g.bounds.h);
        setFrame(g.id, g.axis === "x" ? { ...g.f, scaleX: clamp(size, 0.02, 20) } : { ...g.f, scaleY: clamp(size, 0.02, 20) });
        break;
      }
      case "rotate-frame": {
        const a = (Math.atan2(w.y - g.center.y, w.x - g.center.x) * 180) / Math.PI;
        let rotation = g.f.rotation + a - g.startAngle;
        if (e.shiftKey) rotation = Math.round(rotation / 15) * 15;
        setFrame(g.id, { ...g.f, rotation: Math.round(rotation * 10) / 10 });
        break;
      }
    }
  };

  /** Pointer-down on an empty custom layer: a click there (no drag) asks for its picture. */
  const emptyPress = useRef<{ id: string; x: number; y: number } | null>(null);

  const onPointerUp = (e: React.PointerEvent) => {
    const press = emptyPress.current;
    emptyPress.current = null;
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 4) props.onEmptyLayerClick?.(press.id);
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
      if (props.drawInto) {
        props.drawInto.onShape(shape);
        props.onToolChange("select");
        return;
      }
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
    if (tool !== "polygon") {
      setDraft((d) => (d.length ? [] : d));
      draftRedo.current = [];
    }
  }, [tool]);

  // Keyboard for the polygon pen. Reads the latest draft/closer through refs
  // so the listener is bound once per pen session, not once per render.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const closePolygonRef = useRef(closePolygon);
  closePolygonRef.current = closePolygon;
  // Ctrl/Cmd+Z steps back one point, Ctrl/Cmd+Shift+Z (or Ctrl+Y) puts it back.
  // Bound in the capture phase so it runs before the editor's design undo, and
  // only swallows the key while there is a point to step through — otherwise
  // the shortcut falls through to the design history.
  useEffect(() => {
    if (tool !== "polygon") return;
    const undoPoint = () => {
      const d = draftRef.current;
      if (!d.length) return false;
      draftRedo.current = [...draftRedo.current, d[d.length - 1]];
      setDraft(d.slice(0, -1));
      return true;
    };
    const redoPoint = () => {
      const r = draftRedo.current;
      if (!r.length) return false;
      draftRedo.current = r.slice(0, -1);
      setDraft([...draftRef.current, r[r.length - 1]]);
      return true;
    };
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (e.metaKey || e.ctrlKey) {
        const handled = k === "z" ? (e.shiftKey ? redoPoint() : undoPoint()) : k === "y" ? redoPoint() : false;
        if (handled) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
        return;
      }
      if (e.key === "Enter") closePolygonRef.current(draftRef.current);
      if (e.key === "Escape") {
        setDraft((d) => (d.length ? [] : d));
        draftRedo.current = [];
      }
      if (e.key === "Backspace") undoPoint();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [tool]);

  // ------------------------------------------------------------------ region handlers
  const onRegionPointerDown = (e: React.PointerEvent, region: CtRegion) => {
    if (effectiveTool !== "select") return;
    e.stopPropagation();
    props.onSelectMain(false);
    viewportRef.current?.setPointerCapture(e.pointerId);
    if (region.id !== selectedRegionId) moveHeldUntil.current = performance.now() + SELECT_HOLD_MS;
    props.onSelectRegion(region.id);
    emptyPress.current = region.kind === "image" && !items.some((i) => i.region_id === region.id) ? { id: region.id, x: e.clientX, y: e.clientY } : null;
    // A photo zone's body (outside its child frame, which has its own handler) is the zone itself.
    if (region.kind === "photo" && editTarget === "object") props.onEditTargetChange("region");
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
    if (region.kind === "image" || region.kind === "photo") props.onEditTargetChange(editTarget === "object" ? "region" : "object");
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

  const onFrameBodyDown = (e: React.PointerEvent) => {
    if (effectiveTool !== "select" || !activeRegion || !photoFrame) return;
    e.stopPropagation();
    viewportRef.current?.setPointerCapture(e.pointerId);
    // Clicking the child frame selects it (its own row in Layers; Delete removes the frame, not the zone).
    props.onEditTargetChange("object");
    setGesture({ kind: "move-frame", id: activeRegion.id, start: toWorld(e.clientX, e.clientY), f: photoFrame, bounds: shapeBounds(activeRegion.shape) });
  };

  const onFrameHandleDown = (e: React.PointerEvent, mode: "scale" | "rotate" | "x" | "y") => {
    e.stopPropagation();
    if (!frameGeom || !photoFrame || !activeRegion) return;
    viewportRef.current?.setPointerCapture(e.pointerId);
    props.onEditTargetChange("object");
    const w = toWorld(e.clientX, e.clientY);
    const center = { x: frameGeom.cx, y: frameGeom.cy };
    const id = activeRegion.id;
    if (mode === "scale") setGesture({ kind: "scale-frame", id, center, startDist: Math.hypot(w.x - center.x, w.y - center.y), f: photoFrame });
    else if (mode === "rotate")
      setGesture({ kind: "rotate-frame", id, center, startAngle: (Math.atan2(w.y - center.y, w.x - center.x) * 180) / Math.PI, f: photoFrame });
    else setGesture({ kind: "stretch-frame", id, axis: mode, center, f: photoFrame, bounds: shapeBounds(activeRegion.shape) });
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
      onDragOver={(e) => {
        if (!props.onDropClipart || !e.dataTransfer.types.includes(CLIPART_DRAG)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => {
        setDropping(false);
        const raw = e.dataTransfer.getData(CLIPART_DRAG);
        if (!raw || !props.onDropClipart) return;
        e.preventDefault();
        props.onDropClipart(JSON.parse(raw) as CtClipartDrag, toWorld(e.clientX, e.clientY));
      }}
    >
      {dropping && <div className="pointer-events-none absolute inset-2 z-20 rounded-lg border-2 border-dashed border-sky-500 bg-sky-500/5" />}
      {sceneRect && props.scene?.url && (
        // The background in main px: the design box of the scene maps onto (0, 0, main.width, main.height).
        <img
          src={props.scene.url}
          alt=""
          draggable={false}
          className="pointer-events-none absolute left-0 top-0 max-w-none origin-top-left select-none"
          style={{
            width: sceneRect.w,
            height: sceneRect.h,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) translate(${sceneRect.x}px, ${sceneRect.y}px)`,
          }}
        />
      )}
      <div
        className={cx("absolute left-0 top-0 origin-top-left", !sceneRect && "shadow-2xl")}
        style={{
          width: main.width,
          height: main.height,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          ...(sceneRect ? { outline: `${px}px dashed rgba(125,125,125,0.6)` } : { ...CHECKER_STYLE, backgroundSize: `${16 * px}px ${16 * px}px` }),
        }}
      >
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
        <svg
          className="absolute inset-0 h-full w-full overflow-visible"
          viewBox={`0 0 ${main.width} ${main.height}`}
          style={{ pointerEvents: "none" }}
        >
          {/* Khuôn vật liệu: what is printed / made into the vật liệu — outside it dimmed, its cut-out parts hatched. */}
          {/* A khuôn drawn as a picture (khuôn in face): its own cut line + safe zone. */}
          {props.showOverlay && props.materialFrame?.config.guideUrl && (
            <image href={props.materialFrame.config.guideUrl} x={0} y={0} width={main.width} height={main.height} preserveAspectRatio="none" pointerEvents="none" />
          )}
          {props.showOverlay && props.materialFrame && !props.materialFrame.config.maskUrl && (
            <g pointerEvents="none">
              <defs>
                <pattern id="ct-cut-hatch" width={12 * px} height={12 * px} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width={12 * px} height={12 * px} fill="rgba(0,0,0,0.55)" />
                  <line x1={0} y1={0} x2={0} y2={12 * px} stroke="#f43f5e" strokeWidth={4 * px} />
                </pattern>
              </defs>
              <path
                d={`M${-main.width * 4},${-main.height * 4}h${main.width * 9}v${main.height * 9}h${-main.width * 9}Z${shapeToSvgPath(props.materialFrame.shape)}`}
                fill="rgba(0,0,0,0.45)"
                fillRule="evenodd"
              />
              {(props.materialFrame.config.cuts ?? []).map((c, i) => (
                <path key={i} d={shapeToSvgPath(c)} fill="url(#ct-cut-hatch)" stroke="#f43f5e" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
              ))}
              <path d={frameSvgPath(props.materialFrame)} fill="none" stroke="#f59e0b" strokeWidth={2} vectorEffect="non-scaling-stroke" />
            </g>
          )}
          {/* Khuôn in: the printer's guide sheet (faint), the safe zone (dashed green), the named zones. */}
          {props.showOverlay && props.printSpec && !props.printSpec.faces.length && (
            <g pointerEvents="none">
              {props.printSpec.frameUrl && <image href={props.printSpec.frameUrl} x={0} y={0} width={main.width} height={main.height} opacity={0.25} preserveAspectRatio="none" />}
              {safeShapes(props.printSpec).map((sh, i) => (
                <path key={`safe${i}`} d={shapeToSvgPath(sh)} fill="none" stroke="#16a34a" strokeWidth={2} strokeDasharray="10 7" vectorEffect="non-scaling-stroke" />
              ))}
              {props.printSpec.zones.map((z) => (
                <path key={z.id} d={shapeToSvgPath(z.shape)} fill="none" stroke="#6366f1" strokeWidth={1} strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
              ))}
            </g>
          )}
          {props.showOverlay &&
            // Only the selected layer's frame is drawn (big frames covering the whole artwork hid everything under
            // them, 2026-10-24); the others are invisible hit areas — smallest on top, so a small layer inside a big
            // frame is still clicked, and the selected one last so a press anywhere inside it drags IT (2026-10-12).
            [
              ...shownRegions
                .filter((r) => r.id !== selectedRegionId)
                .sort((a, b) => boundsArea(shapeBounds(b.shape)) - boundsArea(shapeBounds(a.shape))),
              ...shownRegions.filter((r) => r.id === selectedRegionId),
            ].map((r) => {
              const isSel = r.id === selectedRegionId;
              return (
                <path
                  key={r.id}
                  d={shapeToSvgPath(r.shape)}
                  // No tint: a coloured fill over the zone falsifies the colours of what's in it
                  // (a 13% purple film made every photo style look pink). The outline marks it;
                  // pointerEvents "all" still hit-tests the transparent interior.
                  fill="transparent"
                  stroke={isSel ? kindColor[r.kind] : "transparent"}
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                  style={{ pointerEvents: effectiveTool === "select" ? "all" : "none", cursor: "move" }}
                  onPointerEnter={() => setCanvasHover(r.id)}
                  onPointerLeave={() => setCanvasHover((h) => (h === r.id ? null : h))}
                  onPointerDown={(e) => onRegionPointerDown(e, r)}
                  onDoubleClick={(e) => onRegionDoubleClick(e, r)}
                />
              );
            })}
          {props.showOverlay && hovered && hovered.id !== selectedRegionId && (
            // The hovered layer (in Layers, else on the canvas): its frame, for show only.
            <path
              d={shapeToSvgPath(hovered.shape)}
              fill="none"
              stroke={kindColor[hovered.kind]}
              strokeWidth={1.5}
              strokeDasharray="6 4"
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          )}

          {/* An empty custom layer (not a khuôn): it waits for a picture — cliparts dropped on the canvas are layers of their own. */}
          {props.showOverlay &&
            shownRegions
              .filter((r) => r.kind === "image" && !r.config.materialFrame && !items.some((i) => i.region_id === r.id))
              .map((r) => {
                const b = shapeBounds(r.shape);
                const size = Math.min(14 * px, b.h / 4, b.w / 10);
                return (
                  <g key={`empty-${r.id}`} pointerEvents="none">
                    <text x={b.x + b.w / 2} y={b.y + b.h / 2 - size * 0.4} textAnchor="middle" fontSize={size * 2.2} fill={kindColor.image} fillOpacity={0.85}>
                      +
                    </text>
                    <text x={b.x + b.w / 2} y={b.y + b.h / 2 + size * 1.4} textAnchor="middle" fontSize={size} fill={kindColor.image} fillOpacity={0.85}>
                      Layer trống — xoá, hoặc kéo clipart lên canvas
                    </text>
                  </g>
                );
              })}

          {/* A photo zone's child frame: always there while the zone is selected, dragged on its own; the zone clips it. */}
          {props.showOverlay && effectiveTool === "select" && frameGeom && (
            <g transform={`rotate(${frameGeom.rotation} ${frameGeom.cx} ${frameGeom.cy})`}>
              <rect
                x={frameGeom.cx - frameGeom.w / 2}
                y={frameGeom.cy - frameGeom.h / 2}
                width={frameGeom.w}
                height={frameGeom.h}
                fill="transparent"
                stroke="#a855f7"
                strokeWidth={editTarget === "object" ? 2.5 : 1.5}
                vectorEffect="non-scaling-stroke"
                style={{ pointerEvents: "all", cursor: "move" }}
                onPointerDown={onFrameBodyDown}
              />
            </g>
          )}

          {props.showOverlay && effectiveTool === "select" && frameGeom && selected && (
            // The child frame covers the zone: its outline (a wide invisible stroke) still drags the zone itself.
            <path
              d={shapeToSvgPath(selected.shape)}
              fill="none"
              stroke="transparent"
              strokeWidth={14 * px}
              style={{ pointerEvents: "stroke", cursor: "move" }}
              onPointerDown={(e) => {
                if (effectiveTool !== "select") return;
                e.stopPropagation();
                viewportRef.current?.setPointerCapture(e.pointerId);
                // The zone itself is selected again (not its child frame).
                props.onEditTargetChange("region");
                setGesture({ kind: "move-region", id: selected.id, start: toWorld(e.clientX, e.clientY), shape: selected.shape });
              }}
            />
          )}

          {props.mainSelected && !selected && effectiveTool === "select" && (
            <g transform={mainFrame.rotation ? `rotate(${mainFrame.rotation} ${mainFrame.x + mainFrame.w / 2} ${mainFrame.y + mainFrame.h / 2})` : undefined}>
              <rect
                x={mainFrame.x}
                y={mainFrame.y}
                width={mainFrame.w}
                height={mainFrame.h}
                fill="none"
                stroke="#10b981"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
              />
              {HANDLES.map((h) => {
                const p = handlePos(mainFrame, h);
                return (
                  <rect
                    key={h}
                    x={p.x - hs / 2}
                    y={p.y - hs / 2}
                    width={hs}
                    height={hs}
                    fill="#fff"
                    stroke="#10b981"
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                    style={{ pointerEvents: "all", cursor: HANDLE_CURSOR[h] }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      viewportRef.current?.setPointerCapture(e.pointerId);
                      setGesture({ kind: "resize-main", handle: h, f: mainFrame });
                    }}
                  />
                );
              })}
            </g>
          )}

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

          {props.showOverlay && effectiveTool === "select" && frameGeom && (
            <g transform={`rotate(${frameGeom.rotation} ${frameGeom.cx} ${frameGeom.cy})`}>
              {frameGeom.margin > 0 && (
                // The photo's own box inside the frame's margin.
                <rect
                  x={frameGeom.cx - frameGeom.w / 2 + frameGeom.margin}
                  y={frameGeom.cy - frameGeom.h / 2 + frameGeom.margin}
                  width={Math.max(0, frameGeom.w - 2 * frameGeom.margin)}
                  height={Math.max(0, frameGeom.h - 2 * frameGeom.margin)}
                  fill="none"
                  stroke="#a855f7"
                  strokeOpacity={0.45}
                  strokeDasharray="3 3"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                  pointerEvents="none"
                />
              )}
              <line
                x1={frameGeom.cx}
                y1={frameGeom.cy - frameGeom.h / 2}
                x2={frameGeom.cx}
                y2={frameGeom.cy - frameGeom.h / 2 - 28 * px}
                stroke="#a855f7"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={frameGeom.cx}
                cy={frameGeom.cy - frameGeom.h / 2 - 28 * px}
                r={6 * px}
                fill="#fff"
                stroke="#a855f7"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
                style={{ pointerEvents: "all", cursor: "grab" }}
                onPointerDown={(e) => onFrameHandleDown(e, "rotate")}
              />
              {[
                [-1, -1],
                [1, -1],
                [1, 1],
                [-1, 1],
              ].map(([sx, sy]) => (
                <rect
                  key={`c${sx}${sy}`}
                  x={frameGeom.cx + (sx * frameGeom.w) / 2 - hs / 2}
                  y={frameGeom.cy + (sy * frameGeom.h) / 2 - hs / 2}
                  width={hs}
                  height={hs}
                  fill="#fff"
                  stroke="#a855f7"
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                  style={{ pointerEvents: "all", cursor: "nwse-resize" }}
                  onPointerDown={(e) => onFrameHandleDown(e, "scale")}
                />
              ))}
              {(
                [
                  [-1, 0, "x"],
                  [1, 0, "x"],
                  [0, -1, "y"],
                  [0, 1, "y"],
                ] as const
              ).map(([sx, sy, axis]) => (
                <circle
                  key={`s${sx}${sy}`}
                  cx={frameGeom.cx + (sx * frameGeom.w) / 2}
                  cy={frameGeom.cy + (sy * frameGeom.h) / 2}
                  r={hs / 2}
                  fill="#a855f7"
                  stroke="#fff"
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                  style={{ pointerEvents: "all", cursor: axis === "x" ? "ew-resize" : "ns-resize" }}
                  onPointerDown={(e) => onFrameHandleDown(e, axis)}
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

      {props.drawInto && (tool === "rect" || tool === "ellipse" || tool === "polygon") && (
        <div className="pointer-events-none absolute bottom-14 left-3 rounded bg-amber-600/90 px-2 py-1 text-xs text-white">{props.drawInto.label}</div>
      )}
      {tool === "polygon" && (
        <div className="pointer-events-none absolute left-3 top-3 rounded bg-black/70 px-2 py-1 text-xs text-white">
          Click để thêm điểm · click điểm đầu / double-click / Enter để đóng · Backspace / Ctrl+Z lùi điểm · Ctrl+Shift+Z tiến lại · Esc huỷ
        </div>
      )}
      {props.mainSelected && !selected && effectiveTool === "select" && !frameGeom && (
        <div className={cx("pointer-events-none absolute left-3 rounded bg-emerald-600/90 px-2 py-1 text-xs text-white", tool === "polygon" ? "top-10" : "top-3")}>
          Khung main (xanh): kéo = di chuyển · góc = resize giữ tỉ lệ (Shift = tự do) · cạnh = kéo dãn · thông số ở cột phải
        </div>
      )}
      {frameGeom && effectiveTool === "select" ? (
        <div className={cx("pointer-events-none absolute left-3 rounded bg-purple-600/90 px-2 py-1 text-xs text-white", tool === "polygon" ? "top-10" : "top-3")}>
          Khung ảnh (tím): kéo trong khung = di chuyển ảnh · góc = scale · chấm cạnh = kéo dãn · núm trên = xoay (Shift = 15°) · kéo viền vùng = di chuyển vùng
        </div>
      ) : (
        editTarget === "object" && (
          <div className={cx("pointer-events-none absolute left-3 rounded bg-rose-600/90 px-2 py-1 text-xs text-white", tool === "polygon" ? "top-10" : "top-3")}>
            Chế độ Object: kéo để di chuyển · góc để scale · núm trên để xoay (Shift = 15°)
          </div>
        )
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

/** Is `p` inside frame `f` (its rotation undone)? */
function insideFrame(p: CtPoint, f: CtMainFrame): boolean {
  const cx = f.x + f.w / 2;
  const cy = f.y + f.h / 2;
  const t = (-f.rotation * Math.PI) / 180;
  const dx = p.x - cx;
  const dy = p.y - cy;
  const x = dx * Math.cos(t) - dy * Math.sin(t);
  const y = dx * Math.sin(t) + dy * Math.cos(t);
  return Math.abs(x) <= f.w / 2 && Math.abs(y) <= f.h / 2;
}

function distToSegment(p: CtPoint, a: CtPoint, b: CtPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
