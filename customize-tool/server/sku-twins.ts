/**
 * Two products never share an SKU (asked 2026-11-24: "kệ người dùng miễn k trùng là được"). The SKU is read from the
 * name (lib/sku.ts normalizeSku), so "N00 pod 02 Gift" and "n00-POD-02" are the same SKU; "n00-POD-2" is another.
 * Every product of every user and store is looked at (service client — an SKU is the fulfiller's code, not per
 * account), artworks are not (only a product is sold).
 */

import type { CtProduct } from "../types";
import { normalizeSku } from "../lib/sku";
import { CT_TABLES } from "../config";
import { ctServiceClient, type CtSession } from "./supabase";

export { twinProblem } from "../lib/sku";

/** The other products whose name holds the same SKU (none = free). */
export async function skuTwins(s: CtSession, product: Pick<CtProduct, "id" | "name">): Promise<Array<{ id: string; name: string }>> {
  const sku = normalizeSku(product.name);
  if (!sku) return [];
  const db = ctServiceClient() ?? s.supabase;
  const out: Array<{ id: string; name: string }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(CT_TABLES.products).select("id, name").eq("kind", "product").neq("id", product.id).range(from, from + 999).returns<Array<{ id: string; name: string }>>();
    if (error) throw new Error(`Không kiểm được trùng SKU: ${error.message}`);
    out.push(...(data ?? []).filter((p) => normalizeSku(p.name) === sku));
    if (!data || data.length < 1000) return out;
  }
}
