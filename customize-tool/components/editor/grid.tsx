"use client";

/**
 * Edit grid over the artwork, like Teeinblue's artwork editor (asked 2026-11-05: "lưới edit như hình chụp của
 * teeinblue chứ không phải cái thước kẻ 2 bên góc"). Since 2026-11-12: always 7 lines each way (the artwork in 8 ×
 * 8 cells, whatever the zoom), the middle one the centre. Drawn in world units inside an
 * SVG whose viewBox is the artwork, so it pans and zooms with it; it never takes clicks.
 * Shown in Thiết kế and File in; the toggle is remembered per browser.
 */

import { useCallback, useEffect, useState } from "react";
import type React from "react";
import { Grid3x3, Scissors } from "lucide-react";

const STORE_KEY = "ct-editor-grid";

/** Lines across the artwork in each direction (asked 2026-11-12: fixed 7 × 7, not by zoom) — the 4th is the centre. */
export const GRID_LINES = 7;

/** An on/off switch remembered in this browser (on by default). */
export function useStoredToggle(key: string): [boolean, () => void] {
  const [on, setOn] = useState(true);
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(key);
      if (v !== null) setOn(v === "1");
    } catch {
      /* storage blocked: keep the default */
    }
  }, [key]);
  const toggle = useCallback(() => {
    setOn((v) => {
      try {
        window.localStorage.setItem(key, v ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !v;
    });
  }, [key]);
  return [on, toggle];
}

/** The grid on/off switch. */
export function useGridToggle(): [boolean, () => void] {
  return useStoredToggle(STORE_KEY);
}

export interface GridLinesProps {
  /** Artwork size in world units. */
  width: number;
  height: number;
}

/** The grid as an SVG group, in world units — put it inside an SVG whose viewBox is the artwork. */
export function GridLines({ width, height }: GridLinesProps) {
  if (!(width > 0 && height > 0)) return null;
  const at = Array.from({ length: GRID_LINES }, (_, i) => (i + 1) / (GRID_LINES + 1));
  return (
    // Each line = a dark halo under a light line (2026-11-12 "mờ quá"), so it shows on dark pictures, the checker and
    // white alike. The middle line of the 7 is the centre: no separate centre lines.
    <g pointerEvents="none" shapeRendering="crispEdges">
      {at.map((f) => (
        <g key={`x${f}`}>
          <line x1={f * width} y1={0} x2={f * width} y2={height} stroke="rgba(0,0,0,0.55)" strokeWidth={3} vectorEffect="non-scaling-stroke" />
          <line x1={f * width} y1={0} x2={f * width} y2={height} stroke="rgba(255,255,255,0.85)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        </g>
      ))}
      {at.map((f) => (
        <g key={`y${f}`}>
          <line x1={0} y1={f * height} x2={width} y2={f * height} stroke="rgba(0,0,0,0.55)" strokeWidth={3} vectorEffect="non-scaling-stroke" />
          <line x1={0} y1={f * height} x2={width} y2={f * height} stroke="rgba(255,255,255,0.85)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        </g>
      ))}
      <rect x={0} y={0} width={width} height={height} fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </g>
  );
}

/** Small toolbar switch (Lưới, Khuôn). */
export function ToolbarToggle({ on, onToggle, label, icon, title }: { on: boolean; onToggle: () => void; label: string; icon: React.ReactNode; title: string }) {
  return (
    <button
      type="button"
      title={title}
      className={`flex items-center gap-1 rounded px-2 py-1 ${on ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent"}`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {icon}
      {label}
    </button>
  );
}

/** Small toolbar button for the grid switch. */
export function GridToggleButton({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return <ToolbarToggle on={on} onToggle={onToggle} label="Lưới" title={on ? "Tắt lưới" : "Bật lưới"} icon={<Grid3x3 className="h-3.5 w-3.5" />} />;
}

/** The khuôn in's lines / safe zone over the design on or off (asked 2026-11-12). */
export function KhuonToggleButton({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return <ToolbarToggle on={on} onToggle={onToggle} label="Khuôn" title={on ? "Ẩn khuôn in" : "Hiện khuôn in"} icon={<Scissors className="h-3.5 w-3.5" />} />;
}
