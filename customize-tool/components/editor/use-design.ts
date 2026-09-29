"use client";

/**
 * Editor design state: regions + region items + product-level option config
 * (main versions), with undo/redo and a dirty flag.
 *
 * Changes come in two flavours:
 *   commit(fn)  a discrete edit — pushes an undo step.
 *   live(fn)    a continuous edit (drag, slider) — mutates without a step; the
 *               caller ends the gesture with checkpoint() so a whole drag is
 *               ONE undo step instead of hundreds.
 */

import { useCallback, useRef, useState } from "react";
import type { CtMainLayout, CtProductConfig, CtRegion, CtRegionItem } from "../../types";
import { applyLayout, emptyLayout, pruneLayout } from "../../lib/layout";

export interface DesignState {
  regions: CtRegion[];
  items: CtRegionItem[];
  config: CtProductConfig;
}

const HISTORY_LIMIT = 100;

export interface DesignApi {
  state: DesignState;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  commit: (fn: (s: DesignState) => DesignState) => void;
  live: (fn: (s: DesignState) => DesignState) => void;
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;
  reset: (s: DesignState) => void;
  markSaved: () => void;
}

export function useDesign(initial: DesignState): DesignApi {
  const [state, setState] = useState<DesignState>(initial);
  const [dirty, setDirty] = useState(false);
  const past = useRef<DesignState[]>([]);
  const future = useRef<DesignState[]>([]);
  /** State before the current live gesture began (null = no gesture). */
  const gestureStart = useRef<DesignState | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [counts, setCounts] = useState({ past: 0, future: 0 });
  const syncCounts = () => setCounts({ past: past.current.length, future: future.current.length });

  const push = (prev: DesignState) => {
    past.current.push(prev);
    if (past.current.length > HISTORY_LIMIT) past.current.shift();
    future.current = [];
    syncCounts();
  };

  const commit = useCallback((fn: (s: DesignState) => DesignState) => {
    const prev = gestureStart.current ?? stateRef.current;
    gestureStart.current = null;
    const next = fn(stateRef.current);
    if (next === stateRef.current) return;
    push(prev);
    stateRef.current = next;
    setState(next);
    setDirty(true);
  }, []);

  const live = useCallback((fn: (s: DesignState) => DesignState) => {
    if (!gestureStart.current) gestureStart.current = stateRef.current;
    const next = fn(stateRef.current);
    stateRef.current = next;
    setState(next);
    setDirty(true);
  }, []);

  const checkpoint = useCallback(() => {
    if (!gestureStart.current) return;
    if (gestureStart.current !== stateRef.current) push(gestureStart.current);
    gestureStart.current = null;
  }, []);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(stateRef.current);
    syncCounts();
    stateRef.current = prev;
    setState(prev);
    setDirty(true);
  }, []);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(stateRef.current);
    syncCounts();
    stateRef.current = next;
    setState(next);
    setDirty(true);
  }, []);

  const reset = useCallback((s: DesignState) => {
    past.current = [];
    future.current = [];
    gestureStart.current = null;
    syncCounts();
    stateRef.current = s;
    setState(s);
    setDirty(false);
  }, []);

  const markSaved = useCallback(() => setDirty(false), []);

  return {
    state,
    dirty,
    canUndo: counts.past > 0,
    canRedo: counts.future > 0,
    commit,
    live,
    checkpoint,
    undo,
    redo,
    reset,
    markSaved,
  };
}

export function updateRegion(s: DesignState, id: string, fn: (r: CtRegion) => CtRegion): DesignState {
  return { ...s, regions: s.regions.map((r) => (r.id === id ? fn(r) : r)) };
}

export function updateItem(s: DesignState, id: string, fn: (i: CtRegionItem) => CtRegionItem): DesignState {
  return { ...s, items: s.items.map((i) => (i.id === id ? fn(i) : i)) };
}

// ---------------------------------------------------------------------------
// Per-main-version layouts
// ---------------------------------------------------------------------------

/**
 * A DesignApi that edits the layout of main version `mainId` (config.layouts).
 * The stage and inspector keep working on plain regions / items: they see the
 * version's overrides applied, and a geometry change they make (zone shape,
 * object transform) is written back as an override of that version instead
 * of into the base layout. Everything else — names, config, new or deleted
 * zones, restacking — goes to the shared design as usual.
 *
 * Returns `api` untouched when the version has no own layout.
 */
const viewCache = new WeakMap<DesignState, Map<string, DesignState>>();

export function layoutView(api: DesignApi, mainId: string | null): DesignApi {
  if (!mainId || !api.state.config.layouts[mainId]) return api;
  const view = (s: DesignState): DesignState => {
    const l = s.config.layouts[mainId];
    if (!l) return s;
    // Same state + version → same object, so memo / effect deps downstream stay stable.
    let byMain = viewCache.get(s);
    if (!byMain) viewCache.set(s, (byMain = new Map()));
    const hit = byMain.get(mainId);
    if (hit) return hit;
    const made = { ...s, ...applyLayout(s.regions, s.items, l) };
    byMain.set(mainId, made);
    return made;
  };
  const write = (s: DesignState, seen: DesignState, next: DesignState): DesignState => {
    if (next === seen) return s;
    // The mapper may have edited the config itself (e.g. hide a zone): start from that.
    const config = next.config;
    const cur = config.layouts[mainId];
    if (!cur) return next;
    const layout: CtMainLayout = { regions: { ...cur.regions }, items: { ...cur.items } };
    const baseRegions = new Map(s.regions.map((r) => [r.id, r]));
    const seenRegions = new Map(seen.regions.map((r) => [r.id, r]));
    const regions = next.regions.map((r) => {
      const base = baseRegions.get(r.id);
      if (!base) return r; // new zone: its shape is the base shape
      if (r.shape !== seenRegions.get(r.id)?.shape) layout.regions[r.id] = { ...layout.regions[r.id], shape: r.shape };
      return r.shape === base.shape ? r : { ...r, shape: base.shape };
    });
    const baseItems = new Map(s.items.map((i) => [i.id, i]));
    const seenItems = new Map(seen.items.map((i) => [i.id, i]));
    const items = next.items.map((i) => {
      const base = baseItems.get(i.id);
      if (!base) return i;
      if (i.transform !== seenItems.get(i.id)?.transform) layout.items[i.id] = i.transform;
      return i.transform === base.transform ? i : { ...i, transform: base.transform };
    });
    const pruned = pruneLayout(layout, new Set(regions.map((r) => r.id)), new Set(items.map((i) => i.id)));
    return { regions, items, config: { ...config, layouts: { ...config.layouts, [mainId]: pruned } } };
  };
  const through = (fn: (s: DesignState) => DesignState) => (s: DesignState) => {
    const seen = view(s);
    return write(s, seen, fn(seen));
  };
  return {
    ...api,
    state: view(api.state),
    commit: (fn) => api.commit(through(fn)),
    live: (fn) => api.live(through(fn)),
  };
}

/** Toggle a zone's visibility in one main version's layout. */
export function setZoneHidden(s: DesignState, mainId: string, regionId: string, hidden: boolean): DesignState {
  const cur = s.config.layouts[mainId];
  if (!cur) return s;
  const entry = { ...cur.regions[regionId] };
  if (hidden) entry.hidden = true;
  else delete entry.hidden;
  const regions = { ...cur.regions, [regionId]: entry };
  return { ...s, config: { ...s.config, layouts: { ...s.config.layouts, [mainId]: { ...cur, regions } } } };
}

/** Give a main version its own layout (starting as a copy of the base), or drop it. */
export function setOwnLayout(s: DesignState, mainId: string, on: boolean): DesignState {
  const layouts = { ...s.config.layouts };
  if (on) layouts[mainId] = layouts[mainId] ?? emptyLayout();
  else delete layouts[mainId];
  return { ...s, config: { ...s.config, layouts } };
}
