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
import type { CtProductConfig, CtRegion, CtRegionItem, CtSelection, CtZoneTextStyle } from "../../types";
import { versionLayers } from "../../lib/layout";
import { normalizeRegion, withZoneOption, ZONE_TEXT_STYLE_KEYS } from "../../lib/design";

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

// ---------------------------------------------------------------------------
// Sub-options of customer zones ("Thêm option con")
// ---------------------------------------------------------------------------

/** Zone id → the sub-option the editor is showing (CtRegionConfig.options), from the design's selection. */
export function activeZoneOptions(regions: CtRegion[], selection: CtSelection): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of regions) {
    const sel = selection[r.id];
    if ((sel?.kind === "text" || sel?.kind === "photo") && sel.optionId && r.config?.options?.list.some((o) => o.id === sel.optionId)) out[r.id] = sel.optionId;
  }
  return out;
}

const optionCache = new WeakMap<DesignState, Map<string, DesignState>>();

/**
 * A DesignApi where a zone showing one of its sub-options looks like that option (its shape / lettering), and
 * edits made to it there land IN the option: a photo zone's outline, a text zone's font / colours / curve…
 * Everything else (label, choices, styles, the photo frame) stays the zone's own. Like versionView, so the stage
 * and inspector need no special case.
 */
export function zoneOptionView(api: DesignApi, active: Record<string, string>): DesignApi {
  const sig = Object.keys(active)
    .sort()
    .map((k) => `${k}=${active[k]}`)
    .join("|");
  if (!sig) return api;
  const view = (s: DesignState): DesignState => {
    let bySig = optionCache.get(s);
    if (!bySig) optionCache.set(s, (bySig = new Map()));
    const hit = bySig.get(sig);
    if (hit) return hit;
    const regions = s.regions.map((r) => {
      const id = active[r.id];
      const opt = id ? r.config?.options?.list.find((o) => o.id === id) : undefined;
      return opt ? withZoneOption(r, opt) : r;
    });
    const made = regions.every((r, i) => r === s.regions[i]) ? s : { ...s, regions };
    bySig.set(sig, made);
    return made;
  };
  const write = (s: DesignState, seen: DesignState, next: DesignState): DesignState => {
    if (next === seen) return s;
    const seenById = new Map(seen.regions.map((r) => [r.id, r]));
    const stored = new Map(s.regions.map((r) => [r.id, r]));
    const regions = next.regions.map((r) => {
      const optId = active[r.id];
      const before = seenById.get(r.id);
      const own = stored.get(r.id);
      if (!optId || !before || !own) return r;
      if (r === before) return own;
      const n = normalizeRegion(r);
      const b = normalizeRegion(before);
      const base = normalizeRegion(own);
      const opt = n.config.options.list.find((o) => o.id === optId);
      let list = n.config.options.list;
      let shape = r.shape;
      const text = { ...n.config.text };
      if (n.kind === "photo") {
        // The outline is the option's (its own frame shape); the zone keeps its own.
        shape = base.shape;
        if (opt && r.shape !== before.shape) list = list.map((o) => (o.id === optId ? { ...o, shape: r.shape } : o));
      } else if (n.kind === "text") {
        const style: CtZoneTextStyle = { ...opt?.text };
        for (const k of ZONE_TEXT_STYLE_KEYS) {
          (text as Record<string, unknown>)[k] = base.config.text[k];
          if (opt && n.config.text[k] !== b.config.text[k]) (style as Record<string, unknown>)[k] = n.config.text[k];
        }
        if (opt) list = list.map((o) => (o.id === optId ? { ...o, text: style } : o));
      }
      return { ...n, shape, config: { ...n.config, text, options: { ...n.config.options, list } } };
    });
    return { ...next, regions };
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
