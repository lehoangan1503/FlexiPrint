"use client";

/**
 * Where a product's artwork sits in its base's khuôn (2026-11-08, Teeinblue's "Locate artwork"): size and offset, saved
 * on the product (CtProductConfig.placement) — the server lays the khuôn again (server/artwork-link applyBase). Only
 * for a base with a fixed khuôn: a cut-to-shape piece follows the art, a flat print is the whole canvas.
 */

import { useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import type { CtBasePlacement } from "../../types";
import { CtButton } from "../ui";

export interface PlacementBarProps {
  value: CtBasePlacement;
  onChange: (p: CtBasePlacement) => Promise<void>;
}

export function PlacementBar(props: PlacementBarProps) {
  const [draft, setDraft] = useState<CtBasePlacement>(props.value);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The saved placement came back (the product reloaded): show it.
  const [seen, setSeen] = useState(props.value);
  if (seen !== props.value) {
    setSeen(props.value);
    setDraft(props.value);
  }
  const commit = (next: CtBasePlacement) => {
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setBusy(true);
      void props.onChange(next).finally(() => setBusy(false));
    }, 600);
  };
  const slider = (label: string, key: keyof CtBasePlacement, min: number, max: number, step: number, show: (v: number) => string) => (
    <label className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <input type="range" min={min} max={max} step={step} value={draft[key]} onChange={(e) => commit({ ...draft, [key]: Number(e.target.value) })} className="w-24 accent-sky-500" />
      <span className="w-10 tabular-nums">{show(draft[key])}</span>
    </label>
  );
  const moved = draft.scale !== 1 || draft.x !== 0 || draft.y !== 0;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-1.5 text-xs" title="Như “Locate artwork” của Teeinblue: chỉnh artwork nằm trong khuôn của base — không đổi artwork gốc">
      <span className="font-semibold">Vị trí artwork trong khuôn</span>
      {slider("Cỡ", "scale", 0.5, 2, 0.01, (v) => `${Math.round(v * 100)}%`)}
      {slider("Ngang", "x", -0.5, 0.5, 0.01, (v) => `${Math.round(v * 100)}%`)}
      {slider("Dọc", "y", -0.5, 0.5, 0.01, (v) => `${Math.round(v * 100)}%`)}
      {moved && (
        <CtButton size="sm" variant="ghost" onClick={() => commit({ scale: 1, x: 0, y: 0 })}>
          <RotateCcw className="h-3.5 w-3.5" /> Vừa khuôn
        </CtButton>
      )}
      {busy && <span className="text-muted-foreground">Đang lưu…</span>}
    </div>
  );
}
