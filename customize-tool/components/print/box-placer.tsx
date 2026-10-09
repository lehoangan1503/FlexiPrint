"use client";

/**
 * Place the design's box on a product photo by hand: drag it to move, drag its corner to resize (keeping the
 * design's proportions). Photo px in and out (CtProductScene.box).
 */

import { useRef } from "react";
import type { CtBounds } from "../../types";

export function BoxPlacer({ url, width, height, box, aspect, onChange, className }: { url: string; width: number; height: number; box: CtBounds; aspect: number; onChange: (b: CtBounds) => void; className?: string }) {
  const svg = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ mode: "move" | "size"; sx: number; sy: number; start: CtBounds } | null>(null);

  const at = (e: React.PointerEvent) => {
    const el = svg.current;
    if (!el) return { x: 0, y: 0 };
    const pt = el.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const m = el.getScreenCTM();
    const p = m ? pt.matrixTransform(m.inverse()) : { x: 0, y: 0 };
    return { x: p.x, y: p.y };
  };

  const down = (e: React.PointerEvent, mode: "move" | "size") => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const p = at(e);
    drag.current = { mode, sx: p.x, sy: p.y, start: box };
  };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = at(e);
    const dx = p.x - d.sx;
    const dy = p.y - d.sy;
    if (d.mode === "move") onChange({ ...d.start, x: d.start.x + dx, y: d.start.y + dy });
    else {
      const w = Math.max(8, d.start.w + Math.max(dx, dy * aspect));
      onChange({ ...d.start, w, h: w / aspect });
    }
  };

  const handle = Math.max(10, Math.min(width, height) / 40);
  return (
    <svg ref={svg} viewBox={`0 0 ${width} ${height}`} className={className} onPointerMove={move} onPointerUp={() => (drag.current = null)}>
      <image href={url} x={0} y={0} width={width} height={height} />
      <rect x={box.x} y={box.y} width={box.w} height={box.h} fill="#0ea5e9" fillOpacity={0.15} stroke="#0ea5e9" strokeWidth={handle / 4} className="cursor-move" onPointerDown={(e) => down(e, "move")} />
      <rect x={box.x + box.w - handle} y={box.y + box.h - handle} width={handle * 2} height={handle * 2} fill="#0ea5e9" className="cursor-nwse-resize" onPointerDown={(e) => down(e, "size")} />
    </svg>
  );
}
