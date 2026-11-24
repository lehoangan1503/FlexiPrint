/**
 * Two products never share an SKU (asked 2026-11-24: "kệ người dùng miễn k trùng là được"). The SKU is its own column
 * (ct_products.sku, migration 040), stored in the standard form (lib/sku.ts normalizeSku), so "N00 pod 02" and
 * "n00-POD-02" are the same SKU; "n00-POD-2" is another. Every product of every user and store is looked at (service
 * client — an SKU is the fulfiller's code, not per account), artworks are not (only a product is sold).
 */

import type { CtProduct } from "../types";
import { normalizeSku } from "../lib/sku";
import { CT_TABLES } from "../config";
import { ctServiceClient, type CtSession } from "./supabase";

export { twinProblem } from "../lib/sku";

/** The other products with this SKU (none = free). `sku` defaults to the product's own. */
export async function skuTwins(s: CtSession, product: Pick<CtProduct, "id" | "sku">, sku: string | null = normalizeSku(product.sku)): Promise<Array<{ id: string; name: string }>> {
  if (!sku) return [];
  const db = ctServiceClient() ?? s.supabase;
  const { data, error } = await db.from(CT_TABLES.products).select("id, name").eq("kind", "product").eq("sku", sku).neq("id", product.id).limit(20).returns<Array<{ id: string; name: string }>>();
  if (error) throw new Error(`Không kiểm được trùng SKU: ${error.message}`);
  return data ?? [];
}
