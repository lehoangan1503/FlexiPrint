/**
 * Every value that ties this module to its host site lives here. Moving the
 * folder into its own Next.js app means editing this file (and the thin route
 * shims described in README.md) — nothing inside the module imports from `@/`.
 */

export const CT_CONFIG = {
  /** Page route the tool is mounted under. */
  basePath: "/products",
  /** API route prefix (served by the catch-all shim). */
  apiBase: "/api/customize-tool",
  /** Where an unauthenticated visitor is sent. */
  loginPath: "/login",
  /** Link shown as "back" in the editor header. */
  homePath: "/dashboard",

  /** Postgres schema holding the ct_* tables. */
  dbSchema: process.env.NEXT_PUBLIC_DB_SCHEMA || "flexiprint",

  /**
   * Object key prefix on Cloudflare R2 (server/storage.ts): editor assets go to
   * `<uid>/customize-tool/<product>/…`. The bucket comes from R2_BUCKET.
   */
  storagePrefix: "customize-tool",

  /** Public route that streams R2 objects (src/app/files/[...key]). */
  filesPath: "/files",

  /** Upload limit for a single asset (bytes). */
  maxUploadBytes: 500 * 1024 * 1024,

  /**
   * Storefront (public, unauthenticated) uploads — customer photos and cart
   * previews. Stored under `<storagePrefix>-orders/<product>/<day>/…` with the
   * service-role key, outside every user's `<uid>/` folder.
   */
  publicUploadBytes: 500 * 1024 * 1024,

  /**
   * Processed customer photos (AI styles, cut-outs) cached by content under
   * `<cachePrefix>/photo/…`; deleted CT_CACHE_TTL_HOURS (24) after upload by
   * the cleanup cron (server/photo-cache.ts).
   */
  cachePrefix: "customize-tool-cache",
} as const;

export const CT_TABLES = {
  products: "ct_products",
  assets: "ct_assets",
  regions: "ct_regions",
  items: "ct_region_items",
  generations: "ct_generations",
  templates: "ct_templates",
  aiStyles: "ct_ai_styles",
} as const;

/** Fonts offered for text regions (Google Fonts families). */
export const CT_FONTS: Array<{ label: string; family: string; weights: number[] }> = [
  { label: "Poppins", family: "Poppins", weights: [400, 600, 700, 800] },
  { label: "Courier Prime (typewriter)", family: "Courier Prime", weights: [400, 700] },
  { label: "Great Vibes (script)", family: "Great Vibes", weights: [400] },
  { label: "Playfair Display (serif)", family: "Playfair Display", weights: [400, 700] },
  { label: "Oswald (condensed)", family: "Oswald", weights: [400, 600, 700] },
  { label: "Pacifico (brush)", family: "Pacifico", weights: [400] },
  { label: "Bebas Neue (plate)", family: "Bebas Neue", weights: [400] },
  { label: "Rajdhani", family: "Rajdhani", weights: [500, 700] },
];

/** Stylesheet URL for `families` (default: every font the tool offers). */
export function ctGoogleFontsHref(families?: string[]): string {
  const wanted = families ? CT_FONTS.filter((f) => families.includes(f.family)) : CT_FONTS;
  const list = wanted.map(
    (f) => `family=${encodeURIComponent(f.family).replace(/%20/g, "+")}:wght@${f.weights.join(";")}`
  ).join("&");
  return `https://fonts.googleapis.com/css2?${list}&display=swap`;
}
