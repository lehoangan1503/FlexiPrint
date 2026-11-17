/**
 * POST products/:id/deploy/auto (the product list's bulk "Deploy", asked 2026-11-17): deploy one product with what it
 * already has — the same checks as check_deploy / deploy_product (server/mcp/deploy-tools.ts) and the same deploy as
 * the Deploy page (handlers runDeploy). Nothing is written for it: a product missing its title, description (≥ 200
 * characters of text), price table or mockups is skipped with the list of what it lacks. The list sends one product
 * at a time.
 *
 * What it takes: title / description / tags / type / vendor / collections / status of the linked Shopify product,
 * else the last @flexiprint content (title + description), the base's description and product type, the collections
 * that fit the title, ACTIVE.
 */

import { NextResponse } from "next/server";
import type { CtAutoDeployResult, CtShopifyCollection } from "../types";
import { suggestCollections } from "../lib/collections";
import { jsonError, ownedProduct, readDeployBody, runDeploy } from "./handlers";
import { listCollections } from "./shopify";
import { storeOfProduct } from "./stores";
import { blockers, defaultMedia, defaultTable, deployState } from "./mcp/deploy-tools";
import type { CtSession } from "./supabase";

export async function autoDeploy(s: CtSession, productId: string, origin: string): Promise<NextResponse> {
  const product = await ownedProduct(s, productId);
  if (!product) return jsonError("Không có quyền deploy sản phẩm này", 403);
  const st = await deployState(s.supabase, s, product);
  const linked = st.info.product;
  const tableId = defaultTable(st, product);
  const mediaIds = defaultMedia(st, product);
  const title = linked?.title || st.content?.title || product.shopify?.title || "";
  const descriptionHtml = linked?.descriptionHtml || st.content?.descriptionHtml || st.base?.config.description || "";
  // The agent's wording names its tools: the editor reads plain words.
  const missing = blockers(st, { kind: product.kind ?? "artwork", tableId, title, descriptionHtml, mediaIds }).map((m) =>
    m.replace(" — make_product_mockups trước.", " — bấm Tạo mockup trước.").replace(" (price_table_id)", " — gắn bảng giá cho product base"),
  );
  if (missing.length) return NextResponse.json({ ok: false, missing } satisfies CtAutoDeployResult);
  const collectionIds = linked?.collectionIds.length
    ? linked.collectionIds
    : suggestCollections(await listCollections(await storeOfProduct(s.supabase, product)).catch((): CtShopifyCollection[] => []), { title, description: descriptionHtml }).map((c) => c.id);
  const body = readDeployBody({
    priceTableId: tableId ?? "",
    title,
    descriptionHtml,
    status: linked?.status === "DRAFT" ? "DRAFT" : "ACTIVE",
    vendor: linked?.vendor ?? "",
    productType: linked?.productType || st.base?.config.productType || "",
    tags: linked?.tags ?? [],
    mediaAssetIds: mediaIds,
    collectionIds,
    primaryCollectionId: linked?.primaryCollectionId && collectionIds.includes(linked.primaryCollectionId) ? linked.primaryCollectionId : (collectionIds[0] ?? null),
    shopifyProductId: null,
  });
  if (!body) return NextResponse.json({ ok: false, missing: ["Thiếu title hoặc bảng giá."] } satisfies CtAutoDeployResult);
  const r = await runDeploy(s, product, body, origin);
  if ("error" in r) return NextResponse.json({ ok: false, missing: [], error: r.error } satisfies CtAutoDeployResult);
  return NextResponse.json({ ok: true, missing: [], url: r.shopify.url || r.shopify.adminUrl, warnings: r.warnings, product: r.product } satisfies CtAutoDeployResult);
}
