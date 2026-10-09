"use client";

/**
 * Inspector section of a layer on a khuôn in product: how it sits on the piece (placed in its box, or filling a
 * zone — one picture covering it / a repeated pattern), whether it is print-only (a background the product photo
 * already shows), and a warning when a main element leaves the safe zone.
 */

import { AlertTriangle } from "lucide-react";
import type { CtFillConfig, CtRegion, CtShape } from "../../types";
import type { CtProductPrint } from "../../types/print";
import { shapeBounds } from "../../lib/geometry";
import { boundsInSafe } from "../../lib/print-template";
import { CtCheckbox, CtField, CtNumber, CtSelect } from "../ui";

type Placement = "place" | "cover" | "tile";

/** The outline a fill of `zone` takes: that zone, else the cut line, else the whole sheet. */
export function fillShape(print: CtProductPrint, zone: string | undefined): CtShape {
  const z = zone ? print.spec.zones.find((x) => x.id === zone) : undefined;
  return z?.shape ?? print.spec.outline ?? { type: "rect", x: 0, y: 0, w: print.spec.width, h: print.spec.height, radius: 0 };
}

/** A main element (not a fill / print-only / the khuôn) outside the safe zone. */
export function outsideSafe(print: CtProductPrint | null, r: CtRegion): boolean {
  if (!print || r.config.materialFrame || r.config.fill || r.config.printOnly) return false;
  return !boundsInSafe(print.spec, shapeBounds(r.shape));
}

export function LayerPrintSection({ region, print, onChange }: { region: CtRegion; print: CtProductPrint; onChange: (r: CtRegion) => void }) {
  if (region.config.materialFrame) return null;
  const fill = region.config.fill;
  const placement: Placement = fill ? fill.mode : "place";
  const setFill = (next: CtFillConfig | undefined, shape?: CtShape) => {
    const config = { ...region.config };
    if (next) config.fill = next;
    else delete config.fill;
    onChange({ ...region, config, ...(shape ? { shape } : {}) });
  };
  const zones = [{ value: "", label: "Cả miếng (đường cắt / cả tờ)" }, ...print.spec.zones.map((z) => ({ value: z.id, label: z.name }))];
  return (
    <div className="space-y-3 rounded-md border border-dashed p-2.5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Trên khuôn in — {print.name}</div>
      {region.kind === "image" && (
        <>
          <CtField label="Cách đặt">
            <CtSelect<Placement>
              value={placement}
              options={[
                { value: "place", label: "Đặt trong khung (clipart, nhân vật)" },
                { value: "cover", label: "Phủ kín vùng (nền)" },
                { value: "tile", label: "Lặp hoa văn trong vùng (quần áo)" },
              ]}
              onChange={(p) => (p === "place" ? setFill(undefined) : setFill({ mode: p, tile: fill?.tile ?? Math.round(print.spec.width / 6), ...(fill?.zone ? { zone: fill.zone } : {}) }, fill ? undefined : fillShape(print, undefined)))}
            />
          </CtField>
          {fill && (
            <div className="grid grid-cols-[1fr_90px] gap-2">
              <CtField label="Vùng">
                <CtSelect<string>
                  value={fill.zone ?? ""}
                  placeholder="Cả miếng"
                  options={zones.filter((z) => z.value !== "")}
                  onChange={(zone) => setFill({ ...fill, zone }, fillShape(print, zone))}
                />
              </CtField>
              {fill.mode === "tile" && (
                <CtField label="Ô hoa văn px">
                  <CtNumber value={fill.tile} min={8} onChange={(tile) => setFill({ ...fill, tile })} />
                </CtField>
              )}
            </div>
          )}
          {fill?.zone && (
            <button className="text-[11px] text-sky-600 hover:underline" onClick={() => setFill({ mode: fill.mode, tile: fill.tile }, fillShape(print, undefined))}>
              Phủ cả miếng thay vì một vùng
            </button>
          )}
          <CtCheckbox
            checked={region.config.printOnly === true}
            onChange={(v) => {
              const config = { ...region.config };
              if (v) config.printOnly = true;
              else delete config.printOnly;
              onChange({ ...region, config });
            }}
            label="Chỉ in, không vẽ lên ảnh mockup"
            hint="Nền mà ảnh sản phẩm đã có sẵn: mỗi lựa chọn gắn ảnh mockup riêng ở tab Mockups."
          />
        </>
      )}
      {outsideSafe(print, region) && (
        <p className="flex items-start gap-1.5 rounded bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Layer nằm ngoài safe zone (nét đứt xanh) — có thể bị cắt mất khi in. Kéo vào trong.
        </p>
      )}
    </div>
  );
}
