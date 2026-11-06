/**
 * Server side of the text ↔ colour-layer sync (lib/color-sync.ts): each option picture's main colour with sharp, so an
 * import links its texts to the colour layer by itself (asked 2026-11-06).
 */

import sharp from "sharp";
import type { CtRegion, CtRegionItem, CtRenderAsset } from "../types";
import { applyColorSync, dominantFromPixels, suggestColorSync } from "../lib/color-sync";

async function mainColor(url: string): Promise<string | null> {
  const res = await fetch(url).catch(() => null);
  if (!res?.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  const { data } = await sharp(buf).resize(64, 64, { fit: "inside" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return dominantFromPixels(data);
}

/** The regions with every text that should follow a colour layer linked to it (others unchanged); never throws. */
export async function autoColorSync<A extends CtRenderAsset>(regions: CtRegion[], items: CtRegionItem[], assets: A[]): Promise<{ regions: CtRegion[]; linked: number }> {
  try {
    if (!regions.some((r) => r.kind === "text")) return { regions, linked: 0 };
    // Only the pictures of image layers with a choice are looked at.
    const ids = new Set(items.map((i) => i.asset_id));
    const wanted = assets.filter((a) => ids.has(a.id) || (a.parent_id && ids.has(a.parent_id)));
    const colorOf = new Map<string, string>();
    for (let i = 0; i < wanted.length; i += 8) {
      const chunk = wanted.slice(i, i + 8);
      const got = await Promise.all(chunk.map((a) => mainColor(a.url).catch(() => null)));
      chunk.forEach((a, k) => got[k] && colorOf.set(a.id, got[k] as string));
    }
    const links = suggestColorSync(regions, items, assets, colorOf);
    return { regions: links.length ? applyColorSync(regions, links) : regions, linked: links.length };
  } catch (e) {
    console.warn("[ct] color sync", e instanceof Error ? e.message : e);
    return { regions, linked: 0 };
  }
}
