"use client";

/**
 * "Màu theo option" for a text layer (asked 2026-11-05): the text takes the colour of the option another image layer
 * shows — pick red "1st Christmas" and the customer's name turns red too. Teeinblue does this with one hidden input
 * and a copy of the text per colour; here it is one text layer with a colour per option (CtTextConfig.colorBy),
 * applied by every renderer (lib/design.ts textColorFromOption).
 */

import { useState } from "react";
import { Loader2, Pipette } from "lucide-react";
import type { CtAsset, CtRegion, CtRegionItem, CtTextColorBy } from "../../types";
import { normalizeRegion, regionGroups } from "../../lib/design";
import { CtButton, CtField, CtSelect } from "../ui";
import { OptionThumb } from "./option-thumb";

/** The main colour of a picture: the most common saturated colour among its opaque pixels (else their average). */
export async function dominantColor(url: string): Promise<string | null> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;
  await img.decode();
  const side = 64;
  const k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.naturalWidth * k));
  c.height = Math.max(1, Math.round(img.naturalHeight * k));
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  let all = { n: 0, r: 0, g: 0, b: 0 };
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 200) continue;
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    all = { n: all.n + 1, r: all.r + r, g: all.g + g, b: all.b + b };
    if (Math.max(r, g, b) - Math.min(r, g, b) < 40) continue; // greys, white, black
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const cur = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    buckets.set(key, { n: cur.n + 1, r: cur.r + r, g: cur.g + g, b: cur.b + b });
  }
  let best = all;
  for (const v of buckets.values()) if (best === all || v.n > best.n) best = v;
  if (!best.n) return null;
  const hex = (v: number) => Math.round(v / best.n).toString(16).padStart(2, "0");
  return `#${hex(best.r)}${hex(best.g)}${hex(best.b)}`;
}

/** The "no leader" choice (Radix Select takes no empty value). */
const NONE = "none";

export interface TextColorByProps {
  region: CtRegion;
  regions: CtRegion[];
  items: CtRegionItem[];
  assets: CtAsset[];
  value: CtTextColorBy | undefined;
  onChange: (v: CtTextColorBy | undefined) => void;
}

export function TextColorBy({ region, regions, items, assets, value, onChange }: TextColorByProps) {
  const [busy, setBusy] = useState(false);
  // Image layers with a choice (≥ 2 options) can lead the colour.
  const leaders = regions
    .filter((r) => r.id !== region.id && r.kind === "image")
    .map((r) => ({ r, options: regionGroups(normalizeRegion(r), items, assets).flatMap((g) => g.options) }))
    .filter((x) => x.options.length >= 2);
  const lead = value ? leaders.find((x) => x.r.id === value.regionId) : undefined;

  const fill = async (regionId: string, keep: Record<string, string>) => {
    const target = leaders.find((x) => x.r.id === regionId);
    if (!target) return;
    setBusy(true);
    const colors: Record<string, string> = { ...keep };
    try {
      for (const o of target.options) {
        if (colors[o.id]) continue;
        const hex = await dominantColor(o.url).catch(() => null);
        if (hex) colors[o.id] = hex;
      }
    } finally {
      setBusy(false);
    }
    onChange({ regionId, colors });
  };

  if (!leaders.length && !value) return null;
  return (
    <div className="space-y-2 rounded-md border p-2.5">
      <CtField label="Màu theo option của layer">
        <CtSelect<string>
          value={value?.regionId ?? NONE}
          onChange={(id) => (id !== NONE ? void fill(id, {}) : onChange(undefined))}
          options={[{ value: NONE, label: "Không — màu cố định" }, ...leaders.map((x) => ({ value: x.r.id, label: x.r.name }))]}
        />
      </CtField>
      {value && lead && (
        <>
          <div className="space-y-1">
            {lead.options.map((o) => (
              <div key={o.id} className="flex items-center gap-2">
                <OptionThumb url={o.url} label={o.name} className="h-8 w-8 shrink-0 rounded border" />
                <span className="min-w-0 flex-1 truncate text-[11px]">{o.name}</span>
                <input
                  type="color"
                  className="h-7 w-12 rounded border border-input bg-transparent"
                  value={value.colors[o.id] ?? "#000000"}
                  onChange={(e) => onChange({ ...value, colors: { ...value.colors, [o.id]: e.target.value } })}
                />
              </div>
            ))}
          </div>
          <CtButton size="sm" variant="outline" className="w-full" disabled={busy} onClick={() => void fill(value.regionId, {})} title="Lấy lại màu chính của từng ảnh option">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pipette className="h-3.5 w-3.5" />} Lấy màu từ ảnh option
          </CtButton>
          <p className="text-[10px] text-muted-foreground">Khách chọn option nào, chữ đổi sang màu đó (cả xem trước và file in).</p>
        </>
      )}
      {value && !lead && <p className="text-[11px] text-amber-600">Layer dẫn màu không còn — chọn layer khác.</p>}
    </div>
  );
}
