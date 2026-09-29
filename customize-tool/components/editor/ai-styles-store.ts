"use client";

/**
 * The global AI style library, loaded once per editor tab and shared by the
 * inspector (style cards) and the preview panel (style picker).
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { CtAiStyle, CtPublicAiStyle } from "../../types";
import { ctApi } from "../../lib/api-client";
import { aiStyleRef } from "../../lib/photo-styles";

interface AiStylesState {
  styles: CtAiStyle[];
  admin: boolean;
  loading: boolean;
  error: string | null;
  loaded: boolean;
}

let state: AiStylesState = { styles: [], admin: false, loading: false, error: null, loaded: false };
const listeners = new Set<() => void>();

function set(patch: Partial<AiStylesState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export async function reloadAiStyles(): Promise<void> {
  set({ loading: true, error: null });
  try {
    const r = await ctApi.listAiStyles();
    set({ styles: r.styles, admin: r.admin, loading: false, loaded: true });
  } catch (e) {
    set({ loading: false, loaded: true, error: e instanceof Error ? e.message : "Không tải được style AI" });
  }
}

export function putAiStyle(style: CtAiStyle) {
  const has = state.styles.some((s) => s.id === style.id);
  set({ styles: has ? state.styles.map((s) => (s.id === style.id ? style : s)) : [...state.styles, style] });
}

export function dropAiStyle(id: string) {
  set({ styles: state.styles.filter((s) => s.id !== id) });
}

export function useAiStyles(): AiStylesState & { reload: () => Promise<void>; names: CtPublicAiStyle[] } {
  const snap = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
  useEffect(() => {
    if (!state.loaded && !state.loading) void reloadAiStyles();
  }, []);
  const reload = useCallback(() => reloadAiStyles(), []);
  return { ...snap, reload, names: snap.styles.map((s) => ({ ref: aiStyleRef(s.id), name: s.name })) };
}
