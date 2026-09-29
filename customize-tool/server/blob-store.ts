/**
 * Object storage behind one small interface (Cloudflare R2, server/r2.ts).
 * Used by the photo-result cache (server/photo-cache.ts). An R2 lifecycle rule
 * on the cache prefix can expire objects by itself, which makes the cleanup
 * cron a no-op; the cron still works without one.
 */

import { r2Configured, r2Get, r2ListOlderThan, r2PublicUrl, r2Put, r2Remove } from "./r2";

export interface CtStoredObject {
  data: Buffer;
  mime: string;
}

export interface CtBlobStore {
  readonly driver: string;
  put(path: string, data: Buffer, mime: string): Promise<void>;
  /** null when the object does not exist. */
  get(path: string): Promise<CtStoredObject | null>;
  remove(paths: string[]): Promise<void>;
  /** Up to `limit` object paths directly under `prefix` created before `cutoff`, oldest first. */
  listOlderThan(prefix: string, cutoff: Date, limit: number): Promise<string[]>;
  publicUrl(path: string): string;
}

const r2Store: CtBlobStore = {
  driver: "r2",
  put: r2Put,
  async get(path) {
    const obj = await r2Get(path);
    if (!obj?.Body) return null;
    return { data: Buffer.from(await obj.Body.transformToByteArray()), mime: obj.ContentType || "application/octet-stream" };
  },
  remove: r2Remove,
  listOlderThan: r2ListOlderThan,
  publicUrl: r2PublicUrl,
};

/** The configured store, or null when R2 is not configured (cache disabled). */
export function ctBlobStore(): CtBlobStore | null {
  return r2Configured() ? r2Store : null;
}
