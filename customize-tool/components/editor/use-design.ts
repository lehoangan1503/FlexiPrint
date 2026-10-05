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
import type { CtProductConfig, CtRegion, CtRegionItem } from "../../types";
import { versionLayers } from "../../lib/layout";

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
  /** Load a state (clears history); `dirty` when it already differs from what is saved. */
  reset: (s: DesignState, dirty?: boolean) => void;
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

  const reset = useCallback((s: DesignState, dirty = false) => {
    past.current = [];
    future.current = [];
    gestureStart.current = null;
    syncCounts();
    stateRef.current = s;
    setState(s);
    setDirty(dirty);
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
// Layers per main version
// ---------------------------------------------------------------------------

/**
 * A DesignApi that sees and edits only the layers of main version `mainId`
 * (CtRegionConfig.mainId; lib/layout.ts). The stage and inspector keep working
 * on plain regions / items: a zone they add belongs to this version, one they
 * delete or restack touches only this version's set. Every version's stack is
 * numbered from 0 on its own.
 */
const viewCache = new WeakMap<DesignState, Map<string, DesignState>>();

export function versionView(api: DesignApi, mainId: string | null): DesignApi {
  if (!mainId) return api;
  const view = (s: DesignState): DesignState => {
    // Same state + version → same object, so memo / effect deps downstream stay stable.
    let byMain = viewCache.get(s);
    if (!byMain) viewCache.set(s, (byMain = new Map()));
    const hit = byMain.get(mainId);
    if (hit) return hit;
    const own = versionLayers(s.regions, s.items, mainId);
    const regions = [...own.regions].sort((a, b) => a.sort_order - b.sort_order).map((r, k) => (r.sort_order === k ? r : { ...r, sort_order: k }));
    const made = { ...s, regions, items: own.items };
    byMain.set(mainId, made);
    return made;
  };
  const write = (s: DesignState, seen: DesignState, next: DesignState): DesignState => {
    if (next === seen) return s;
    const seenIds = new Set(seen.regions.map((r) => r.id));
    const others = s.regions.filter((r) => !seenIds.has(r.id));
    const otherIds = new Set(others.map((r) => r.id));
    // Untouched layers keep their stored object; new ones join this version.
    const stored = new Map(s.regions.map((r) => [r.id, r]));
    const seenById = new Map(seen.regions.map((r) => [r.id, r]));
    const mine = [...next.regions]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((r) => (seenById.get(r.id) === r ? (stored.get(r.id) ?? r) : r.config?.mainId === mainId ? r : { ...r, config: { ...r.config, mainId } }));
    // Stored bottom-first: the save RPC rewrites sort_order from array position.
    const regions = [...others, ...mine].map((r, k) => (r.sort_order === k ? r : { ...r, sort_order: k }));
    const items = [...s.items.filter((i) => otherIds.has(i.region_id)), ...next.items];
    return { regions, items, config: next.config };
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
