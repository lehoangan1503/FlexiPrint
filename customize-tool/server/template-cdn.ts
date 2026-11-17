/**
 * The published template on the CDN (asked 2026-11-17, "tốc độ từ Mỹ"): the storefront read it from flexi2 on every
 * product page (US → tool-01 Hà Nội → an-vm, ~0,75 s measured from Oregon; cdn.teein.top ~0,05 s once cached).
 *
 *   publish / deploy   the template JSON (file urls already on the CDN, AI styles' askName read now) is written to R2
 *                      at `<prefix>-templates/<product>/v<N>-<hash>.json` (immutable: a new content = a new key) and
 *                      the Shopify product gets the metafield customize_tool.template_url = its CDN url
 *   flexi2-product.liquid  loads template_url when set, else (and when the CDN fails) the flexi2 endpoint as before
 *   cron/template-cdn  the same for every deployed product (the first run, and after an AI style changes)
 *
 * Without R2_STOREFRONT_URL nothing is written and the metafield is removed: the store reads flexi2 again.
 */

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { CT_CONFIG, CT_TABLES } from "../config";
import type { CtProduct, CtTemplate } from "../types";
import { publicAiStyles } from "./ai-styles";
import { r2Put, r2RewriteUrls, r2StorefrontUrl } from "./r2";
import { setTemplateUrlMetafield } from "./shopify";
import { storeOfProduct } from "./stores";
import { ctServiceClient, type CtServiceClient, type CtSession } from "./supabase";

type Db = CtSession["supabase"] | CtServiceClient;

/** Whether a style asks the customer's name is read now (its tick / a [NAME] in its prompt), not frozen at deploy. */
export async function withLiveAiStyles(db: Db, template: CtTemplate): Promise<CtTemplate> {
  if (!template.aiStyles?.length) return template;
  const asks = new Set((await publicAiStyles(db, template.aiStyles.map((x) => x.ref))).filter((x) => x.askName).map((x) => x.ref));
  return { ...template, aiStyles: template.aiStyles.map(({ askName: _was, ...x }) => (asks.has(x.ref) ? { ...x, askName: true } : x)) };
}

/** The template written to the CDN → its url; null when the CDN is not set up (or the write failed). */
export async function templateToCdn(db: Db, template: CtTemplate): Promise<string | null> {
  try {
    const text = r2RewriteUrls(JSON.stringify(await withLiveAiStyles(db, template)), "storefront");
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 10);
    const key = `${CT_CONFIG.storagePrefix}-templates/${template.productId}/v${template.version}-${hash}.json`;
    const url = r2StorefrontUrl(key);
    if (!url) return null;
    await r2Put(key, Buffer.from(text), "application/json; charset=utf-8");
    return url;
  } catch (e) {
    console.warn("[ct] template → CDN failed", template.productId, e instanceof Error ? e.message : e);
    return null;
  }
}

/** The product's latest template on the CDN, and its Shopify product pointed at it (a product on Shopify only). */
export async function syncTemplateCdn(db: Db, product: Pick<CtProduct, "id" | "store_id" | "shopify">): Promise<{ url: string | null; error?: string }> {
  if (!product.shopify?.productId) return { url: null };
  const { data } = await db.from(CT_TABLES.templates).select("template").eq("product_id", product.id).order("version", { ascending: false }).limit(1).maybeSingle<{ template: CtTemplate }>();
  if (!data) return { url: null };
  const url = await templateToCdn(db, data.template);
  try {
    await setTemplateUrlMetafield(await storeOfProduct(db, product), product.shopify.productId, url);
    return { url };
  } catch (e) {
    return { url, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Every deployed product (cron/template-cdn, an AI style changed): one at a time, Shopify's rate limit is low. */
export async function syncAllTemplateCdn(db: CtServiceClient): Promise<{ done: number; failed: Array<{ id: string; error: string }> }> {
  const { data } = await db.from(CT_TABLES.products).select("id, store_id, shopify").not("shopify", "is", null).not("published_version", "is", null).returns<Array<Pick<CtProduct, "id" | "store_id" | "shopify">>>();
  let done = 0;
  const failed: Array<{ id: string; error: string }> = [];
  for (const p of data ?? []) {
    const r = await syncTemplateCdn(db, p);
    if (r.error) failed.push({ id: p.id, error: r.error });
    else done++;
  }
  return { done, failed };
}

let running: Promise<unknown> | null = null;
/** Fire and forget (an AI style was saved): one run at a time. */
export function syncAllTemplateCdnLater(): void {
  const db = ctServiceClient();
  if (!db || running) return;
  running = syncAllTemplateCdn(db)
    .then((r) => console.info(`[ct] template CDN: ${r.done} ok, ${r.failed.length} failed`))
    .catch((e) => console.warn("[ct] template CDN sync failed", e))
    .finally(() => (running = null));
}

/** POST cron/template-cdn (Bearer CT_CRON_SECRET). */
export async function cronTemplateCdn(authorization: string | null): Promise<NextResponse> {
  const secret = process.env.CT_CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CT_CRON_SECRET chưa được cấu hình" }, { status: 503 });
  if (authorization !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = ctServiceClient();
  if (!db) return NextResponse.json({ error: "Thiếu service key" }, { status: 503 });
  return NextResponse.json(await syncAllTemplateCdn(db));
}
