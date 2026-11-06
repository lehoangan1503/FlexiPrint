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
import { dominantFromPixels, suggestColorSync } from "../../lib/color-sync";
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
  return dominantFromPixels(ctx.getImageData(0, 0, c.width, c.height).data);
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

export interface ColorLayerTextsProps {
  /** The image layer being edited (the colour choice). */
  region: CtRegion;
  regions: CtRegion[];
  items: CtRegionItem[];
  assets: CtAsset[];
  /** Write colorBy on several texts at once (undefined = unlink). */
  onLink: (links: Array<{ textId: string; colorBy: CtTextColorBy | undefined }>) => void;
}

/**
 * On a colour layer (an image layer with ≥ 2 options): the text layers, each with a switch "đổi màu theo layer này",
 * and "Tự dò" — the rule an import uses (lib/color-sync.ts): texts drawn in the default option's colour get linked.
 */
export function ColorLayerTexts({ region, regions, items, assets, onLink }: ColorLayerTextsProps) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const options = regionGroups(normalizeRegion(region), items, assets).flatMap((g) => g.options);
  const texts = regions.filter((r) => r.kind === "text");
  if (options.length < 2 || !texts.length) return null;

  const colorsOf = async (list: CtAsset[]): Promise<Map<string, string>> => {
    const out = new Map<string, string>();
    for (const o of list) {
      const hex = await dominantColor(o.url).catch(() => null);
      if (hex) out.set(o.id, hex);
    }
    return out;
  };

  const toggle = async (t: CtRegion, on: boolean) => {
    if (!on) return onLink([{ textId: t.id, colorBy: undefined }]);
    setBusy(true);
    try {
      const m = await colorsOf(options);
      onLink([{ textId: t.id, colorBy: { regionId: region.id, colors: Object.fromEntries(m) } }]);
    } finally {
      setBusy(false);
    }
  };

  const auto = async () => {
    setBusy(true);
    setNote(null);
    try {
      // Every image layer with a choice, so the text goes to the layer it really matches.
      const all = regions
        .filter((r) => r.kind === "image")
        .flatMap((r) => regionGroups(normalizeRegion(r), items, assets).flatMap((g) => g.options));
      const links = suggestColorSync(
        regions.map((r) => (r.kind === "text" ? { ...r, config: { ...r.config, text: { ...r.config.text, colorBy: undefined } } } : r)),
        items,
        assets,
        await colorsOf(all),
      );
      onLink(links);
      setNote(links.length ? `Đã nối ${links.length} chữ` : "Không thấy chữ nào cùng màu với option mặc định của layer màu");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5 rounded-md border p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Chữ đổi màu theo layer này</span>
        <CtButton size="sm" variant="outline" disabled={busy} onClick={() => void auto()} title="Nối mọi chữ đang cùng màu với option mặc định của một layer màu (luật import dùng)">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pipette className="h-3.5 w-3.5" />} Tự dò
        </CtButton>
      </div>
      {texts.map((t) => {
        const by = t.config.text?.colorBy;
        const mine = by?.regionId === region.id;
        const other = by && !mine ? regions.find((r) => r.id === by.regionId) : undefined;
        return (
          <label key={t.id} className="flex cursor-pointer items-center gap-2 text-[11px]">
            <input type="checkbox" className="accent-sky-500" disabled={busy} checked={mine} onChange={(e) => void toggle(t, e.target.checked)} />
            <span className="min-w-0 flex-1 truncate">{t.name}</span>
            {other && <span className="truncate text-muted-foreground">theo “{other.name}”</span>}
          </label>
        );
      })}
      {note && <p className="text-[10px] text-muted-foreground">{note}</p>}
    </div>
  );
}
