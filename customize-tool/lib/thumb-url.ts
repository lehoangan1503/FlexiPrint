/**
 * Small picture for a grid card (asked 2026-11-20: lists loaded every full-size mockup — ~3 MB PNG each — and lagged).
 * Our own files (`…/files/<key>`, src/app/files/[...key]) answer `?w=<width>` with a WebP that size; any other url
 * (data:, blob:, outside sites, the storefront CDN) is returned as is.
 */

/** Widths the file route makes — a fixed few, so nobody can fill the cache with every number. */
export const THUMB_WIDTHS = [200, 400, 800] as const;

export function thumbUrl(url: string | null | undefined, width: (typeof THUMB_WIDTHS)[number] = 400): string | null {
  if (!url) return null;
  if (!/^(https?:\/\/[^/]+)?\/files\//.test(url) || url.includes("?")) return url;
  return `${url}?w=${width}`;
}
