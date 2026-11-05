"use client";

/**
 * Edit grid over the artwork, like Teeinblue's artwork editor (asked 2026-11-05: "lưới edit như hình chụp của
 * teeinblue chứ không phải cái thước kẻ 2 bên góc"). Thin lines across the artwork only, a "nice" spacing that
 * keeps cells readable at the current zoom, the two centre lines a little stronger. Drawn in world units inside an
 * SVG whose viewBox is the artwork, so it pans and zooms with it; it never takes clicks.
 * Shown in Thiết kế and File in; the toggle is remembered per browser.
 */

import { useCallback, useEffect, useState } from "react";
import { Grid3x3 } from "lucide-react";

const STORE_KEY = "ct-editor-grid";

/** Grid step in world units: the smallest nice step at least `minPx` screen px apart. */
export function gridStep(pxPerUnit: number, minPx = 72): number {
  const raw = minPx / Math.max(1e-9, pxPerUnit);
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}

/** The grid on/off switch, remembered in this browser (on by default). */
export function useGridToggle(): [boolean, () => void] {
  const [on, setOn] = useState(true);
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(STORE_KEY);
      if (v !== null) setOn(v === "1");
    } catch {
      /* storage blocked: keep the default */
    }
  }, []);
  const toggle = useCallback(() => {
    setOn((v) => {
      try {
        window.localStorage.setItem(STORE_KEY, v ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !v;
    });
  }, []);
  return [on, toggle];
}

export interface GridLinesProps {
  /** Artwork size in world units. */
  width: number;
  height: number;
  /** Screen px per world unit (decides the spacing). */
  zoom: number;
}

/** The grid as an SVG group, in world units — put it inside an SVG whose viewBox is the artwork. */
export function GridLines({ width, height, zoom }: GridLinesProps) {
  if (!(width > 0 && height > 0)) return null;
  const step = gridStep(zoom);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let x = step; x < width - step * 0.01; x += step) xs.push(x);
  for (let y = step; y < height - step * 0.01; y += step) ys.push(y);
  const cx = width / 2;
  const cy = height / 2;
  return (
    <g pointerEvents="none" shapeRendering="crispEdges">
      {xs.map((x) => (
        <line key={`x${x}`} x1={x} y1={0} x2={x} y2={height} stroke="rgba(150,150,150,0.6)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      ))}
      {ys.map((y) => (
        <line key={`y${y}`} x1={0} y1={y} x2={width} y2={y} stroke="rgba(150,150,150,0.6)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      ))}
      <line x1={cx} y1={0} x2={cx} y2={height} stroke="rgba(14,165,233,0.7)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      <line x1={0} y1={cy} x2={width} y2={cy} stroke="rgba(14,165,233,0.7)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      <rect x={0} y={0} width={width} height={height} fill="none" stroke="rgba(150,150,150,0.8)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
    </g>
  );
}

/** Small toolbar button for the grid switch. */
export function GridToggleButton({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      title={on ? "Tắt lưới" : "Bật lưới"}
      className={`flex items-center gap-1 rounded px-2 py-1 ${on ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent"}`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Grid3x3 className="h-3.5 w-3.5" />
      Lưới
    </button>
  );
}
