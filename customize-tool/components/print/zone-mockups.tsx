"use client";

/**
 * Mockups tab — product photos that repaint the khuôn in's zones (clothes; lib/zone-mockup.ts): upload the photo of
 * the plain piece, draw each zone on it (click points round it), set how big the pattern looks and how much of the
 * photo's shading shows, and see it with the design's current choices. The storefront shows the first one.
 */

import { useEffect, useRef, useState } from "react";
import { Check, Eye, ImagePlus, Loader2, PenLine, Trash2, Undo2 } from "lucide-react";
import type { CtShape, CtZoneMockup } from "../../types";
import type { CtPrintSpec } from "../../types/print";
import { newId, shapeToSvgPath } from "../../lib/geometry";
import { printApi } from "../../lib/print-api";
import { renderZoneMockup, type CtZoneFill } from "../../lib/zone-mockup";
import { CtButton, CtInput, cx } from "../ui";
import { ZONE_COLOURS } from "./print-sheet";

export interface ZoneMockupsProps {
  spec: CtPrintSpec;
  mockups: CtZoneMockup[];
  /** What each zone shows now (the design's sample choices). */
  fills: CtZoneFill[];
  onChange: (m: CtZoneMockup[]) => void;
}

export function ZoneMockups({ spec, mockups, fills, onChange }: ZoneMockupsProps) {
  const [openId, setOpenId] = useState<string | null>(mockups[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const m = mockups.find((x) => x.id === openId) ?? null;

  const add = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const r = await printApi.uploadImage(file);
      const next: CtZoneMockup = { id: newId(), name: `Mockup ${mockups.length + 1}`, url: r.url, width: r.width, height: r.height, zones: {}, tile: Math.round(r.width / 12), shading: 0.85 };
      onChange([...mockups, next]);
      setOpenId(next.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload thất bại");
    } finally {
      setBusy(false);
    }
  };

  const update = (patch: Partial<CtZoneMockup>) => m && onChange(mockups.map((x) => (x.id === m.id ? { ...x, ...patch } : x)));

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Cho quần áo / đồ may: ảnh sản phẩm trơn, vẽ từng vùng của khuôn lên ảnh (ống quần, cạp, quần lót…). Trang sản phẩm tô hoa văn khách chọn vào đúng vùng và giữ nếp vải của ảnh — không cần uốn file in
        lên chỗ cong.
      </p>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {mockups.map((x) => (
          <button key={x.id} className={cx("flex items-center gap-1.5 rounded-md border p-1 pr-2 text-xs", x.id === openId && "border-foreground")} onClick={() => setOpenId(x.id)}>
            {/* eslint-disable-next-line @next/next/no-img-element -- mockup photo */}
            <img src={x.url} alt="" className="h-8 w-8 rounded object-cover" />
            {x.name}
          </button>
        ))}
        <label className="flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1.5 text-xs hover:bg-accent">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />} Ảnh mockup mới
          <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => void add(e.target.files?.[0])} />
        </label>
      </div>
      {m && <ZoneMockupEditor key={m.id} spec={spec} mockup={m} fills={fills} onUpdate={update} onRemove={() => onChange(mockups.filter((x) => x.id !== m.id))} />}
    </div>
  );
}

function ZoneMockupEditor({ spec, mockup, fills, onUpdate, onRemove }: { spec: CtPrintSpec; mockup: CtZoneMockup; fills: CtZoneFill[]; onUpdate: (p: Partial<CtZoneMockup>) => void; onRemove: () => void }) {
  const [drawing, setDrawing] = useState<{ zone: string; points: Array<{ x: number; y: number }> } | null>(null);
  const [preview, setPreview] = useState(false);
  const host = useRef<HTMLDivElement | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (!preview || !host.current) return;
    let live = true;
    const el = host.current;
    void renderZoneMockup(mockup, fills, 1400).then((c) => {
      if (!live) return;
      c.className = "mx-auto h-auto max-h-[560px] w-auto max-w-full";
      el.replaceChildren(c);
    });
    return () => {
      live = false;
    };
  }, [preview, mockup, fills]);

  const at = (e: React.PointerEvent) => {
    const el = svg.current;
    if (!el) return { x: 0, y: 0 };
    const pt = el.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = el.getScreenCTM();
    const p = ctm ? pt.matrixTransform(ctm.inverse()) : { x: 0, y: 0 };
    return { x: Math.round(p.x), y: Math.round(p.y) };
  };

  const finish = () => {
    if (!drawing || drawing.points.length < 3) return setDrawing(null);
    const shape: CtShape = { type: "polygon", points: drawing.points };
    onUpdate({ zones: { ...mockup.zones, [drawing.zone]: shape } });
    setDrawing(null);
  };

  const stroke = Math.max(2, Math.min(mockup.width, mockup.height) / 300);
  return (
    <div className="grid gap-3 lg:grid-cols-[280px_1fr]">
      <div className="space-y-3">
        <CtInput value={mockup.name} onChange={(e) => onUpdate({ name: e.target.value })} />
        <div className="space-y-1.5">
          {spec.zones.map((z, i) => (
            <div key={z.id} className="flex items-center gap-2 text-xs">
              <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: ZONE_COLOURS[i % ZONE_COLOURS.length] }} />
              <span className="min-w-0 flex-1 truncate">{z.name}</span>
              {mockup.zones[z.id] ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <span className="text-[10px] text-muted-foreground">chưa vẽ</span>}
              <button className="rounded p-1 hover:bg-accent" disabled={!!drawing} title="Vẽ vùng này trên ảnh" onClick={() => setDrawing({ zone: z.id, points: [] })}>
                <PenLine className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          {!spec.zones.length && <p className="text-[11px] text-muted-foreground">Khuôn in của sản phẩm chưa có vùng — thêm vùng ở trang Khuôn in.</p>}
        </div>
        <label className="block text-xs">
          Cỡ hoa văn trên ảnh: {mockup.tile}px
          <input type="range" min={10} max={Math.round(mockup.width / 2)} value={mockup.tile} onChange={(e) => onUpdate({ tile: Number(e.target.value) })} className="w-full" />
        </label>
        <label className="block text-xs">
          Nếp vải / đổ bóng: {Math.round(mockup.shading * 100)}%
          <input type="range" min={0} max={100} value={Math.round(mockup.shading * 100)} onChange={(e) => onUpdate({ shading: Number(e.target.value) / 100 })} className="w-full" />
        </label>
        <div className="flex gap-2">
          <CtButton size="sm" variant={preview ? "primary" : "outline"} onClick={() => setPreview((v) => !v)}>
            <Eye className="h-3.5 w-3.5" /> {preview ? "Đang xem thử" : "Xem thử"}
          </CtButton>
          <CtButton size="sm" onClick={onRemove}>
            <Trash2 className="h-3.5 w-3.5" /> Xoá
          </CtButton>
        </div>
      </div>
      <div className="relative rounded-lg border bg-muted/30 p-2">
        {drawing && (
          <div className="absolute left-1/2 top-2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs shadow">
            {spec.zones.find((z) => z.id === drawing.zone)?.name}: bấm quanh vùng ({drawing.points.length})
            <CtButton size="sm" disabled={!drawing.points.length} onClick={() => setDrawing({ ...drawing, points: drawing.points.slice(0, -1) })}>
              <Undo2 className="h-3.5 w-3.5" />
            </CtButton>
            <CtButton size="sm" variant="primary" disabled={drawing.points.length < 3} onClick={finish}>
              <Check className="h-3.5 w-3.5" /> Xong
            </CtButton>
            <CtButton size="sm" onClick={() => setDrawing(null)}>
              Huỷ
            </CtButton>
          </div>
        )}
        {preview && !drawing ? (
          <div ref={host} className="flex min-h-[200px] items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <svg
            ref={svg}
            viewBox={`0 0 ${mockup.width} ${mockup.height}`}
            className={cx("mx-auto max-h-[560px] w-full", drawing && "cursor-crosshair")}
            onPointerDown={(e) => drawing && setDrawing({ ...drawing, points: [...drawing.points, at(e)] })}
          >
            <image href={mockup.url} x={0} y={0} width={mockup.width} height={mockup.height} />
            {spec.zones.map((z, i) =>
              mockup.zones[z.id] && z.id !== drawing?.zone ? (
                <path key={z.id} d={shapeToSvgPath(mockup.zones[z.id])} fill={ZONE_COLOURS[i % ZONE_COLOURS.length]} fillOpacity={0.3} stroke={ZONE_COLOURS[i % ZONE_COLOURS.length]} strokeWidth={stroke} />
              ) : null,
            )}
            {drawing && (
              <g>
                <polyline points={drawing.points.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="#0ea5e9" strokeWidth={stroke * 1.5} />
                {drawing.points.map((p, i) => (
                  <circle key={i} cx={p.x} cy={p.y} r={stroke * 3} fill="#0ea5e9" />
                ))}
              </g>
            )}
          </svg>
        )}
      </div>
    </div>
  );
}
