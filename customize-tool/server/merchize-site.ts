/**
 * Merchize's public website (asked 2026-11-11: "Merchize qua Teeinblue lấy khuôn + phôi"). Teeinblue holds nothing of
 * the kind for Merchize (an imported base has one photo layer, no print-area position), and the seller app needs a
 * login. merchize.com does show, per product, its "Mockup & Template" tab: Google Drive folders of PSD templates (the
 * guide drawn as layers) and PSD mockups (a smart object "Design"). They differ too much product to product to read
 * automatically — text baked into pictures, several shapes stacked in one template, warped / clipped smart objects in
 * the mockups (tested on 7 templates, 4 mockups) — so the base keeps the links and the team opens them by hand.
 *
 *   GET merchize.com/products/products-v2.json?search=<SKU>  → [{ sku, slug, title }]   (the site's own search)
 *   GET merchize.com/product/<slug>/description-tab/mockup_and_template/  → HTML with the Drive links + what each is
 */

import type { CtBaseSourceLink } from "../types";

const SITE = "https://merchize.com";
const UA = { "user-agent": "Mozilla/5.0 (compatible; flexi2)", accept: "text/html,application/json" };

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&#[0-9]+;|&[a-z]+;/gi, " ")
    .replace(/[​-‍﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The product's template / mockup links off merchize.com; [] when the SKU or the tab isn't there. */
export async function merchizeTemplateLinks(sku: string): Promise<CtBaseSourceLink[]> {
  const res = await fetch(`${SITE}/products/products-v2.json?search=${encodeURIComponent(sku)}`, { headers: UA, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return [];
  const body = (await res.json()) as { products?: Array<{ sku: string; slug: string }> };
  const hit = body.products?.find((p) => p.sku.toUpperCase() === sku.toUpperCase());
  if (!hit) return [];
  const page = `${SITE}/product/${hit.slug}/`;
  const tab = await fetch(`${page}description-tab/mockup_and_template/`, { headers: UA, signal: AbortSignal.timeout(30_000) });
  const html = tab.ok ? (await tab.text()).replace(/<(script|style)[\s\S]*?<\/\1>/gi, "") : "";
  const out: CtBaseSourceLink[] = [];
  for (const m of html.matchAll(/<a\s[^>]*href="(https:\/\/drive\.google\.com\/[^"]+)"[^>]*>/gi)) {
    // What the link is: the words just before it ("… 2-side Printed Wood Ornament" here).
    const before = text(html.slice(Math.max(0, (m.index ?? 0) - 400), m.index ?? 0));
    const sentence = (before.split(/[.:]\s|here\s/i).pop() ?? "").replace(/^[\s,;–-]+/, "").trim();
    const label = sentence.length > 2 && !/^download\b/i.test(sentence) ? `${sentence.slice(-90)} (PSD)` : "Template + mockup (PSD)";
    if (!out.some((l) => l.url === m[1])) out.push({ label: `Merchize: ${label}`, url: m[1] });
  }
  out.push({ label: "Trang sản phẩm Merchize", url: page });
  return out.slice(0, 10);
}
