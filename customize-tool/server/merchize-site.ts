/**
 * Merchize's public website (2026-11-11/12). Teeinblue holds no khuôn / phôi for Merchize (an imported base has one
 * photo layer, no print-area position) and the seller app needs a login; merchize.com shows, per product, its "Mockup
 * & Template" files: Google Drive folders of PSD templates (one per size group) and a "Mockup" sub-folder of PSD
 * mockups. server/merchize-khuon.ts reads them (services/layer-kit psd_kit.py).
 *
 *   GET merchize.com/products/products-v2.json?search=<SKU>  → [{ sku, slug, title }]   (the site's own search)
 *   GET merchize.com/product/<slug>/   → page JSON `link_mockup_and_templates` (a Drive folder, or a seller login)
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

export interface MerchizePage {
  /** merchize.com product page. */
  page: string;
  /** Every Drive link of the product (template / mockup folders, single files), labelled, page link last. */
  links: CtBaseSourceLink[];
  /** The Drive folder ids among them, the page's own `link_mockup_and_templates` first. */
  folders: string[];
}

/** The product's page + its template / mockup links on merchize.com; null when the SKU isn't on the site. */
export async function merchizePage(sku: string): Promise<MerchizePage | null> {
  const res = await fetch(`${SITE}/products/products-v2.json?search=${encodeURIComponent(sku)}`, { headers: UA, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return null;
  const body = (await res.json()) as { products?: Array<{ sku: string; slug: string }> };
  const hit = body.products?.find((p) => p.sku.toUpperCase() === sku.toUpperCase());
  if (!hit) return null;
  const page = `${SITE}/product/${hit.slug}/`;
  const [pageHtml, tabHtml] = await Promise.all(
    [page, `${page}description-tab/mockup_and_template/`].map((u) =>
      fetch(u, { headers: UA, signal: AbortSignal.timeout(30_000) })
        .then((r) => (r.ok ? r.text() : ""))
        .catch(() => ""),
    ),
  );
  const links: CtBaseSourceLink[] = [];
  const own = /"link_mockup_and_templates":"([^"]*)"/.exec(pageHtml)?.[1]?.replace(/\\\//g, "/") ?? "";
  if (/drive\.google\.com/.test(own)) links.push({ label: "Merchize: khuôn + mockup (PSD)", url: own });
  const html = tabHtml.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  for (const m of html.matchAll(/<a\s[^>]*href="(https:\/\/drive\.google\.com\/[^"]+)"[^>]*>/gi)) {
    if (links.some((l) => l.url === m[1])) continue;
    // What the link is: the words just before it ("… 2-side Printed Wood Ornament" here).
    const before = text(html.slice(Math.max(0, (m.index ?? 0) - 400), m.index ?? 0));
    const sentence = (before.split(/[.:]\s|here\s/i).pop() ?? "").replace(/^[\s,;–-]+/, "").trim();
    const label = sentence.length > 2 && !/^download\b/i.test(sentence) ? `${sentence.slice(-90)} (PSD)` : "khuôn + mockup (PSD)";
    links.push({ label: `Merchize: ${label}`, url: m[1] });
  }
  const folders = [...new Set(links.map((l) => /\/folders\/([\w-]+)/.exec(l.url)?.[1]).filter((x): x is string => !!x))];
  links.push({ label: "Trang sản phẩm Merchize", url: page });
  return { page, links: links.slice(0, 12), folders };
}

/** The product's template / mockup links off merchize.com; [] when the SKU isn't there. */
export async function merchizeTemplateLinks(sku: string): Promise<CtBaseSourceLink[]> {
  return (await merchizePage(sku))?.links ?? [];
}
