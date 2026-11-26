/**
 * The Shopify tags FlexiPrint puts on a product by itself at every deploy (asked 2026-11-26), all lower case:
 *   - the SKU: n06-pod-126
 *   - the staff code = the SKU's first part: n06
 *   - one per collection the product is put in: col_<collection handle> (col_ornaments)
 * Customer options (names, photos, notes) are NOT tags: they reach the store as metafields (template_url, pricing,
 * customer_note). A tag typed by hand is kept; an auto tag of the last deploy that no longer fits (SKU changed,
 * collection taken off) is taken off — the last deploy's auto tags are kept on the Shopify link (CtShopifyLink.autoTags),
 * with the tags a smart collection's rules made the deploy add (server/shopify.ts smartNeeds).
 * Server (server/shopify.ts deployToShopify), Deploy page and MCP check_deploy all use this file.
 */

import { normalizeSku } from "./sku";

/** SKU-shaped and staff-code-shaped tags are always ours (n06-pod-126, n06), even from before autoTags was kept. */
const OURS = /^n0\d(-pod-\d+)?$/i;

/** The auto tags for this SKU + these collection handles (deduped, lower case). */
export function autoTags(sku: string | null | undefined, collectionHandles: string[]): string[] {
  const out: string[] = [];
  const std = normalizeSku(sku);
  if (std) out.push(std.toLowerCase(), std.split("-")[0].toLowerCase());
  for (const h of collectionHandles) if (h.trim()) out.push(`col_${h.trim().toLowerCase()}`);
  return [...new Set(out)];
}

/** The hand-typed tags among a product's tags: minus the last deploy's auto tags and anything SKU-shaped. */
export function manualTags(tags: string[], lastAuto: string[] | null | undefined): string[] {
  const auto = new Set((lastAuto ?? []).map((t) => t.toLowerCase()));
  return tags.map((t) => t.trim()).filter((t) => t && !auto.has(t.toLowerCase()) && !OURS.test(t));
}

/** Tags to send: hand-typed ones + this deploy's auto tags (case-insensitive dedupe, hand-typed spelling first). */
export function mergeTags(manual: string[], auto: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...manual, ...auto]) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}
