"use client";

/**
 * A khuôn in drawn as SVG in its own px (viewBox = the sheet): the guide sheet, the cut line, the safe zone, the
 * parts cut out, the named zones. The template page shows it; the editor lays it over the canvas (`overlay`).
 */

import type { CtShape } from "../../types";
import type { CtPrintSpec } from "../../types/print";
import { shapeBounds, shapeToSvgPath } from "../../lib/geometry";
import { printSize, safeShapes, scaleShape } from "../../lib/print-template";

export const ZONE_COLOURS = ["#f97316", "#2563eb", "#16a34a", "#a855f7", "#eab308", "#ec4899", "#06b6d4", "#dc2626", "#84cc16", "#4f46e5"];

export interface PrintSheetProps {
  spec: CtPrintSpec;
  sizeId?: string | null;
  /** Editor overlay: no backdrop / fill, lines only, the guide sheet faint. */
  overlay?: boolean;
  /** Zone ids to leave out (the one being redrawn). */
  hideZones?: string[];
  /** Points of a zone being drawn. */
  drawing?: Array<{ x: number; y: number }>;
  className?: string;
  /** A khuôn with faces: which one to show. */
  faceIndex?: number;
  onPointerDown?: (e: React.PointerEvent<SVGSVGElement>) => void;
}

export function PrintSheet({ spec, sizeId, overlay, hideZones = [], drawing, className, onPointerDown, faceIndex = 0 }: PrintSheetProps) {
  const size = printSize(spec, sizeId);
  const kx = size.width / spec.width;
  const ky = size.height / spec.height;
  const W = size.width;
  const H = size.height;
  const stroke = Math.max(2, Math.min(W, H) / 250);
  const scaled = (s: CtShape) => (kx === 1 && ky === 1 ? s : scaleShape(s, kx, ky));
  const outline = spec.outline ? scaled(spec.outline) : null;
  // A khuôn drawn as a picture: its face (the cut line + safe zone are in the picture).
  const face = spec.faces[faceIndex] ?? spec.faces[0];
  if (face) {
    const href = overlay ? (face.guideUrl ?? face.imageUrl) : (face.imageUrl ?? face.guideUrl);
    return (
      <svg viewBox={`0 0 ${spec.width} ${spec.height}`} className={className} onPointerDown={onPointerDown} preserveAspectRatio="xMidYMid meet">
        {!overlay && <rect x={0} y={0} width={spec.width} height={spec.height} fill="#ffffff" />}
        {href && <image href={href} x={0} y={0} width={spec.width} height={spec.height} opacity={overlay && !face.guideUrl ? 0.4 : 1} preserveAspectRatio="none" />}
      </svg>
    );
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={className} onPointerDown={onPointerDown} preserveAspectRatio="xMidYMid meet">
      {!overlay && <rect x={0} y={0} width={W} height={H} fill="#e5e7eb" />}
      {spec.frameUrl && <image href={spec.frameUrl} x={0} y={0} width={W} height={H} opacity={overlay ? 0.35 : 1} preserveAspectRatio="none" />}
      {!overlay && outline && <path d={shapeToSvgPath(outline)} fill="#ffffff" fillOpacity={spec.frameUrl ? 0 : 0.85} />}
      {spec.zones
        .filter((z) => !hideZones.includes(z.id))
        .map((z, i) => {
          const s = size.zones[z.id] ?? z.shape;
          const b = shapeBounds(s);
          return (
            <g key={z.id}>
              <path d={shapeToSvgPath(s)} fill={ZONE_COLOURS[i % ZONE_COLOURS.length]} fillOpacity={overlay ? 0.08 : 0.28} stroke={ZONE_COLOURS[i % ZONE_COLOURS.length]} strokeWidth={stroke} />
              <text x={b.x + b.w / 2} y={b.y + b.h / 2} fontSize={Math.max(18, Math.min(W, H) / 40)} textAnchor="middle" dominantBaseline="middle" fill="#111827" opacity={0.75}>
                {z.name}
              </text>
            </g>
          );
        })}
      {outline && <path d={shapeToSvgPath(outline)} fill="none" stroke="#15803d" strokeWidth={stroke} />}
      {(spec.safe.length || spec.outline ? safeShapes(spec) : []).map((s, i) => (
        <path key={`safe${i}`} d={shapeToSvgPath(scaled(s))} fill="none" stroke="#16a34a" strokeWidth={stroke} strokeDasharray={`${stroke * 6} ${stroke * 4}`} />
      ))}
      {spec.cuts.map((s, i) => (
        <path key={`cut${i}`} d={shapeToSvgPath(scaled(s))} fill={overlay ? "none" : "#9ca3af"} stroke="#dc2626" strokeWidth={stroke} strokeDasharray={`${stroke * 3} ${stroke * 3}`} />
      ))}
      {drawing && drawing.length > 0 && (
        <g>
          <polyline points={drawing.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="#0ea5e9" strokeWidth={stroke * 1.5} />
          {drawing.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={stroke * 3} fill="#0ea5e9" />
          ))}
        </g>
      )}
    </svg>
  );
}
