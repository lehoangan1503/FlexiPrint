/**
 * Processed customer photos (AI styles, subject cut-outs), cached by content
 * so the same photo + style is never billed or matted twice — across server
 * restarts and instances, not just inside one process.
 *
 *   L1  in-process LRU of promises (also merges concurrent identical requests)
 *   L2  object storage (server/blob-store.ts) at <cachePrefix>/photo/<sha256>.png
 *
 * Keys are sha256 over the photo bytes + everything that changes the output
 * (style id and its updated_at, cut-out flag, model), so "same photo" means
 * byte-identical upload — the storefront and editor send the browser-shrunk
 * file, which is deterministic for one source file.
 *
 * Retention: objects live CT_CACHE_TTL_HOURS (default 24) after upload.
 * sweepPhotoCache() deletes the expired ones; it runs from the cron route
 * (POST cron/cleanup, scripts/cleanup-cache.sh) and, as a backstop, at most
 * once an hour from the write path.
 */

import { createHash } from "node:crypto";
import { CT_CONFIG } from "../config";
import { ctBlobStore } from "./blob-store";
import type { ProviderImage } from "./ai/providers";

export const CT_CACHE_TTL_HOURS = Number(process.env.CT_CACHE_TTL_HOURS) > 0 ? Number(process.env.CT_CACHE_TTL_HOURS) : 24;

const PREFIX = `${CT_CONFIG.cachePrefix}/photo`;
const L1_MAX = 64;
const l1 = new Map<string, Promise<ProviderImage>>();

export function photoCacheKey(image: Buffer, ...parts: Array<string | number | boolean>): string {
  return createHash("sha256").update(image).update(`|${parts.join("|")}`).digest("hex");
}

const pathOf = (key: string) => `${PREFIX}/${key}.png`;

function remember(key: string, p: Promise<ProviderImage>): Promise<ProviderImage> {
  l1.set(key, p);
  p.catch(() => l1.delete(key));
  while (l1.size > L1_MAX) l1.delete(l1.keys().next().value as string);
  return p;
}

function touch(key: string): Promise<ProviderImage> | undefined {
  const hit = l1.get(key);
  if (hit) {
    l1.delete(key);
    l1.set(key, hit);
  }
  return hit;
}

/** A cached result, or null. Never runs anything. */
export async function peekPhotoCache(key: string): Promise<ProviderImage | null> {
  const hit = touch(key);
  if (hit) return hit.catch(() => null);
  const store = ctBlobStore();
  if (!store) return null;
  const obj = await store.get(pathOf(key)).catch(() => null);
  if (!obj) return null;
  const image: ProviderImage = { data: obj.data, mime: "image/png" };
  void remember(key, Promise.resolve(image));
  return image;
}

/**
 * The cached result for `key`, or `run()`'s — then stored. Only PNGs are
 * persisted (every cut-out is one); anything else stays in L1.
 */
export function cachedPhoto(key: string, run: () => Promise<ProviderImage>): Promise<ProviderImage> {
  const hit = touch(key);
  if (hit) return hit;
  return remember(
    key,
    (async () => {
      const stored = await peekPhotoCache(key);
      if (stored) return stored;
      const image = await run();
      const store = ctBlobStore();
      if (store && image.mime === "image/png") {
        // Not awaited: the customer shouldn't wait on the cache write.
        void store.put(pathOf(key), image.data, image.mime).catch((e: unknown) => console.warn("[ct] photo cache write failed", e));
        maybeSweepInBackground();
      }
      return image;
    })(),
  );
}

export interface CtSweepResult {
  deleted: number;
  /** More expired objects remain (the batch limit was hit). */
  more: boolean;
  ttlHours: number;
  driver: string | null;
}

/** Delete cached photos uploaded more than CT_CACHE_TTL_HOURS ago. */
export async function sweepPhotoCache(limit = 1000): Promise<CtSweepResult> {
  const store = ctBlobStore();
  if (!store) return { deleted: 0, more: false, ttlHours: CT_CACHE_TTL_HOURS, driver: null };
  const cutoff = new Date(Date.now() - CT_CACHE_TTL_HOURS * 3600_000);
  const paths = await store.listOlderThan(PREFIX, cutoff, limit);
  await store.remove(paths);
  lastSweep = Date.now();
  return { deleted: paths.length, more: paths.length >= limit, ttlHours: CT_CACHE_TTL_HOURS, driver: store.driver };
}

let lastSweep = 0;
let sweeping = false;

/** Backstop for a missing / broken cron: at most one sweep an hour per process, fired from writes. */
function maybeSweepInBackground(): void {
  if (sweeping || Date.now() - lastSweep < 3600_000) return;
  sweeping = true;
  lastSweep = Date.now();
  sweepPhotoCache()
    .then((r) => r.deleted && console.log(`[ct] photo cache sweep: deleted ${r.deleted}${r.more ? " (more remaining)" : ""}`))
    .catch((e: unknown) => console.warn("[ct] photo cache sweep failed", e))
    .finally(() => (sweeping = false));
}
