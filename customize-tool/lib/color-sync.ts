/**
 * Colour sync between a "colour" layer and the texts (asked 2026-11-06: an imported set must link them by itself).
 * A text follows an image layer's option colour (CtTextConfig.colorBy) when:
 *   - the layer offers ≥ 2 options whose main colours clearly differ (a colour choice, not 3 hairstyles of one colour),
 *   - and the text was designed in the colour of that layer's default option (its colour ≈ the option's), or the
 *     layer is named as a colour choice ("Text Color", "1st Christmas — màu", options "Red / Green / …").
 * Pure: the caller gives each option picture's main colour (client: text-color-by.tsx dominantColor, server: sharp).
 */

import type { CtRegion, CtRegionItem, CtRenderAsset, CtTextColorBy } from "../types";
import { normalizeRegion, regionGroups } from "./design";

const COLOR_WORDS =
  /\b(colou?rs?|màu|red|green|blue|pink|purple|violet|yellow|gold|golden|silver|black|white|grey|gray|orange|brown|beige|navy|teal|mint|peach|lavender|rose|burgundy|maroon|cream|ivory|coral|turquoise|đỏ|xanh|hồng|tím|vàng|bạc|đen|trắng|cam|nâu|do|xanh-la|xanh-duong|hong|tim|vang|bac|den|trang|nau)\b/i;

function rgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

/** Distance between two colours (0 = same, ~442 = black vs white). */
export function colorDistance(a: string, b: string): number {
  const x = rgb(a);
  const y = rgb(b);
  if (!x || !y) return Infinity;
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

export interface ColorLeader<A extends CtRenderAsset> {
  region: CtRegion;
  options: A[];
  /** option asset id → its main colour */
  colors: Record<string, string>;
  /** Named as a colour choice (layer / group / option names). */
  named: boolean;
}

/** Image layers that are a colour choice: ≥ 2 options with clearly different main colours. */
export function colorLeaders<A extends CtRenderAsset>(regions: CtRegion[], items: CtRegionItem[], assets: A[], colorOf: Map<string, string>): Array<ColorLeader<A>> {
  const out: Array<ColorLeader<A>> = [];
  for (const raw of regions) {
    if (raw.kind !== "image") continue;
    const region = normalizeRegion(raw);
    const groups = regionGroups(region, items, assets);
    const options = groups.flatMap((g) => g.options);
    if (options.length < 2) continue;
    const colors: Record<string, string> = {};
    for (const o of options) {
      const c = colorOf.get(o.id);
      if (c) colors[o.id] = c;
    }
    const hexes = Object.values(colors);
    if (hexes.length < 2) continue;
    // Most pairs clearly apart: a real colour choice.
    let apart = 0;
    let pairs = 0;
    for (let i = 0; i < hexes.length; i++)
      for (let j = i + 1; j < hexes.length; j++) {
        pairs++;
        if (colorDistance(hexes[i], hexes[j]) > 60) apart++;
      }
    if (apart / pairs < 0.75) continue;
    const names = [region.name, region.config.image.label, region.config.image.groupLabel, ...groups.map((g) => g.name), ...options.map((o) => o.name)].join(" ");
    out.push({ region, options, colors, named: COLOR_WORDS.test(names) });
  }
  return out;
}

/** The option a layer shows by default (its defaultAssetId, else its first option). */
function defaultOption<A extends CtRenderAsset>(l: ColorLeader<A>): A {
  const id = l.region.config.image.defaultAssetId;
  return l.options.find((o) => o.id === id) ?? l.options[0];
}

/** Same version (or one of them on every version). */
function sameVersion(a: CtRegion, b: CtRegion): boolean {
  const x = a.config.mainId ?? null;
  const y = b.config.mainId ?? null;
  return !x || !y || x === y;
}

/**
 * The texts that should follow a colour layer, with the colour per option. Texts that already have a colorBy are left
 * as they are.
 */
export function suggestColorSync<A extends CtRenderAsset>(regions: CtRegion[], items: CtRegionItem[], assets: A[], colorOf: Map<string, string>): Array<{ textId: string; colorBy: CtTextColorBy }> {
  const leaders = colorLeaders(regions, items, assets, colorOf);
  if (!leaders.length) return [];
  const out: Array<{ textId: string; colorBy: CtTextColorBy }> = [];
  for (const raw of regions) {
    if (raw.kind !== "text") continue;
    const t = normalizeRegion(raw);
    if (t.config.text.colorBy) continue;
    let best: { l: ColorLeader<A>; score: number } | null = null;
    for (const l of leaders) {
      if (!sameVersion(t, l.region)) continue;
      const def = l.colors[defaultOption(l).id];
      const d = def ? colorDistance(t.config.text.color, def) : Infinity;
      // Designed in the default option's colour, or the only named colour choice beside it.
      const score = d < 70 ? d : l.named && leaders.filter((x) => x.named && sameVersion(t, x.region)).length === 1 ? 200 : Infinity;
      if (score < (best?.score ?? Infinity)) best = { l, score };
    }
    if (best) out.push({ textId: t.id, colorBy: { regionId: best.l.region.id, colors: { ...best.l.colors } } });
  }
  return out;
}

/** The regions with the suggested colour links written in. */
export function applyColorSync(regions: CtRegion[], links: Array<{ textId: string; colorBy: CtTextColorBy }>): CtRegion[] {
  const by = new Map(links.map((l) => [l.textId, l.colorBy]));
  return regions.map((r) => (by.has(r.id) ? { ...r, config: { ...r.config, text: { ...r.config.text, colorBy: by.get(r.id) } } } : r));
}

/** The main colour of RGBA pixels: the most common saturated colour among the opaque ones (else their average). */
export function dominantFromPixels(d: ArrayLike<number>): string | null {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  let all = { n: 0, r: 0, g: 0, b: 0 };
  for (let i = 0; i + 3 < d.length; i += 4) {
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
