/**
 * Our own stored files read straight from R2, with a small in-process cache (found 2026-11-27 on flexi2: the app
 * fetched its own pictures through https://flexi2.next.lc/files/… — nginx → the app → R2 — one 0.9 MB phôi 310 times
 * an hour; while the app was busy those calls back into itself failed ("fetch image again … fetch failed") and were
 * tried again, adding load). Keys never change once written (unique per upload), so a cached copy never goes stale.
 */

import { r2Configured, r2Get, r2KeyOfUrl } from "./r2";

/** Total bytes kept; a file bigger than ITEM_MAX is read but not kept (a 100 MB print file). */
const CACHE_MAX = 256 * 1024 * 1024;
const ITEM_MAX = 24 * 1024 * 1024;

const cache = new Map<string, Buffer>();
let cached = 0;
const reading = new Map<string, Promise<Buffer | null>>();

function keep(key: string, buf: Buffer): void {
  if (buf.length > ITEM_MAX || cache.has(key)) return;
  cache.set(key, buf);
  cached += buf.length;
  while (cached > CACHE_MAX && cache.size) {
    const [k, b] = cache.entries().next().value as [string, Buffer];
    cache.delete(k);
    cached -= b.length;
  }
}

/**
 * The bytes of one of our own file urls (/files/… or the CDN form): `undefined` = not ours (fetch it over the
 * network), `null` = ours but missing. A failed R2 read throws (the caller may try again).
 */
export async function readOwnFile(url: string): Promise<Buffer | null | undefined> {
  if (!r2Configured()) return undefined;
  const key = r2KeyOfUrl(url);
  if (!key) return undefined;
  const hit = cache.get(key);
  if (hit) {
    // Most recently used goes last (the oldest is dropped first).
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  let p = reading.get(key);
  if (!p) {
    p = (async () => {
      const obj = await r2Get(key);
      if (!obj?.Body) return null;
      const buf = Buffer.from(await obj.Body.transformToByteArray());
      keep(key, buf);
      return buf;
    })().finally(() => reading.delete(key));
    reading.set(key, p);
  }
  return p;
}
