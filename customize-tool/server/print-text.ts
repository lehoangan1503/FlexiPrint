/**
 * Text of a product drawn on the server exactly like lib/compositor drawText (asked 2026-10-14: the @flexiprint agent
 * makes mockups over MCP, so the server must render the print with the real lettering — a name in Great Vibes, a
 * slogan along the circle). The font is the Google font the zone uses (TTF, cached per process); each letter becomes an
 * SVG path, measured and placed letter by letter as the canvas does (shrink-to-fit, letter spacing, align, arc,
 * stroke), so sharp renders it without any font installed.
 */

import opentype from "opentype.js";
import type { CtTextConfig } from "../types";

const fonts = new Map<string, Promise<opentype.Font | null>>();

async function fetchFont(family: string, weight: number): Promise<opentype.Font | null> {
  // Without a browser user agent Google Fonts serves TrueType (opentype.js does not read WOFF2).
  const css = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@${weight}`, { signal: AbortSignal.timeout(20_000) })
    .then((r) => (r.ok ? r.text() : ""))
    .catch(() => "");
  const url = /url\((https:[^)]+\.ttf)\)/.exec(css)?.[1];
  if (!url) return null;
  const buf = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .catch(() => null);
  return buf ? opentype.parse(buf) : null;
}

/** The zone's font (the nearest weight Google has), or null when it cannot be read. */
export function loadFont(family: string, weight: number): Promise<opentype.Font | null> {
  const key = `${family}|${weight}`;
  let hit = fonts.get(key);
  if (!hit) {
    hit = fetchFont(family, weight).then((f) => f ?? (weight !== 400 ? fetchFont(family, 400) : null));
    fonts.set(key, hit);
    // A failed load is tried again next time.
    void hit.then((f) => {
      if (!f) fonts.delete(key);
    });
  }
  return hit;
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * SVG elements for `raw` in `cfg` inside `bounds` (sheet px) — the same layout as lib/compositor drawText; "" when
 * there is nothing to draw. The canvas's "middle" baseline is the middle of the font's ascent / descent.
 */
export function textSvg(font: opentype.Font, raw: string, cfg: CtTextConfig, bounds: { x: number; y: number; w: number; h: number }): string {
  const text = (cfg.uppercase ? raw.toUpperCase() : raw).slice(0, Math.max(1, cfg.maxChars));
  if (!text.trim()) return "";
  const chars = [...text];
  const adv = (ch: string, size: number) => font.getAdvanceWidth(ch, size);
  const spaced = (size: number) => {
    const spacing = (cfg.letterSpacing * size) / 100;
    return Math.max(0, chars.reduce((w, ch) => w + adv(ch, size) + spacing, 0) - spacing);
  };
  let size = Math.min(cfg.fontSize, bounds.h);
  const arcFactor = cfg.curve === 0 || cfg.arcRadius ? 1 : 1 + Math.abs(cfg.curve) / 400;
  while (size > 6 && spaced(size) * arcFactor > bounds.w) size -= 1;
  const spacing = (cfg.letterSpacing * size) / 100;
  const scale = size / font.unitsPerEm;
  // textBaseline "middle": the baseline sits half the em box (ascender − descender) below the line's centre.
  const middle = ((font.ascender + font.descender) / 2) * scale;
  const total = spaced(size);
  const cy = bounds.y + bounds.h / 2;
  const paint = cfg.strokeWidth > 0 ? ` stroke="${esc(cfg.strokeColor)}" stroke-width="${cfg.strokeWidth}" stroke-linejoin="round" paint-order="stroke"` : "";
  const glyph = (ch: string, x: number, y: number, transform = "") => {
    const d = font.getPath(ch, x, y + middle, size).toPathData(2);
    return d ? `<path d="${d}" fill="${esc(cfg.color)}"${paint}${transform}/>` : "";
  };
  const out: string[] = [];
  if (cfg.curve === 0) {
    let x = cfg.align === "left" ? bounds.x : cfg.align === "right" ? bounds.x + bounds.w - total : bounds.x + (bounds.w - total) / 2;
    for (const ch of chars) {
      out.push(glyph(ch, x, cy));
      x += adv(ch, size) + spacing;
    }
    return out.join("");
  }
  // Arc: positive curve bows upward (∩), negative downward (∪); each letter centred on its point of the arc.
  const radius = cfg.arcRadius ? cfg.arcRadius * bounds.w : total / ((Math.abs(cfg.curve) / 100) * Math.PI);
  const sweep = total / radius;
  const up = cfg.curve > 0;
  const cx = bounds.x + bounds.w / 2;
  // The circle's centre: under (∩) or over (∪) the zone's centre, turned by the tilt.
  const tilt = ((cfg.arcTilt ?? 0) * Math.PI) / 180;
  const centerX = up ? cx - radius * Math.sin(tilt) : cx + radius * Math.sin(tilt);
  const centerY = up ? cy + radius * Math.cos(tilt) : cy - radius * Math.cos(tilt);
  let travelled = 0;
  for (const ch of chars) {
    const w = adv(ch, size);
    const theta = ((travelled + w / 2) / total - 0.5) * sweep;
    const a = up ? theta + tilt : theta - tilt;
    const px = centerX + radius * Math.sin(a);
    const py = up ? centerY - radius * Math.cos(a) : centerY + radius * Math.cos(a);
    const deg = ((up ? a : -a) * 180) / Math.PI;
    out.push(glyph(ch, -w / 2, 0, ` transform="translate(${px.toFixed(2)} ${py.toFixed(2)}) rotate(${deg.toFixed(3)})"`));
    travelled += w + spacing;
  }
  return out.join("");
}
