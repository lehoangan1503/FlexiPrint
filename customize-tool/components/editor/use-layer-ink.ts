/** The ink box of every image layer (lib/ink-bounds), recomputed when layers / items / pictures change. */

import { useEffect, useState } from "react";
import type { CtAsset, CtBounds, CtRegion, CtRegionItem } from "../../types";
import { inkBoxOfPixels, regionInkBounds, type CtImageInk } from "../../lib/ink-bounds";
import { loadImage } from "../../lib/compositor";

/** region id → ink box (null = nothing visible); a missing id = not known (yet) → callers use the frame. */
export type CtLayerInk = Map<string, CtBounds | null>;

const READ_SIDE = 512;
const cache = new Map<string, Promise<CtImageInk | null>>();

async function readInk(url: string): Promise<CtImageInk | null> {
  try {
    const img = await loadImage(url);
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    if (!W || !H) return null;
    const k = Math.min(1, READ_SIDE / Math.max(W, H));
    const w = Math.max(1, Math.round(W * k));
    const h = Math.max(1, Math.round(H * k));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    return { width: W, height: H, box: inkBoxOfPixels(ctx.getImageData(0, 0, w, h).data, w, h, 4, 3) };
  } catch {
    // Unreadable (CORS, failed load): unknown — the frame is used.
    return null;
  }
}

/** One canvas read per picture url, kept for the session. */
function imageInk(url: string): Promise<CtImageInk | null> {
  let p = cache.get(url);
  if (!p) {
    p = readInk(url);
    cache.set(url, p);
  }
  return p;
}

export function useLayerInk(regions: CtRegion[], items: CtRegionItem[], assets: CtAsset[], enabled: boolean): CtLayerInk {
  const [ink, setInk] = useState<CtLayerInk>(() => new Map());
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const t = setTimeout(async () => {
      const next: CtLayerInk = new Map();
      await Promise.all(
        regions.map(async (r) => {
          const b = await regionInkBounds(r, items, assets, imageInk);
          if (b !== undefined) next.set(r.id, b);
        }),
      );
      if (alive) setInk(next);
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [regions, items, assets, enabled]);
  return ink;
}
