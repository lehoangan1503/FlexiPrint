/**
 * The Deploy page's saved draft and the customer note box (asked 2026-11-20).
 *
 * Draft: title / description / tags / type / vendor / status / collections written ahead (by hand on the Deploy page,
 * or by an agent through MCP save_deploy_draft / make_product_from_artwork) so that once the mockups are made the
 * product only needs Deploy. A draft wins over the Shopify product's text while it is newer than the last deploy —
 * after a deploy the Shopify product (= what went up, maybe edited on Shopify since) wins again.
 *
 * Customer note: a text box on the Shopify product page (sections/flexi2-product.liquid, metafield
 * customize_tool.customer_note); the order line gets what the customer typed under the box's label. Not printed.
 */

import type { CtCustomerNote, CtDeployDraft, CtProduct, CtShopifyStatus } from "../types";

export const DEFAULT_CUSTOMER_NOTE: CtCustomerNote = { enabled: false, label: "Note", placeholder: "", required: false, maxChars: 250 };

const STATUSES: CtShopifyStatus[] = ["ACTIVE", "DRAFT", "ARCHIVED"];
const COLLECTION = /^gid:\/\/shopify\/Collection\/\d+$/;

function strs(v: unknown, max: number, test?: RegExp): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "" && (!test || test.test(x.trim()))).map((x) => x.trim()).slice(0, max) : [];
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function normalizeDeployDraft(raw: unknown): CtDeployDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Partial<CtDeployDraft>;
  const collectionIds = strs(d.collectionIds, 50, COLLECTION);
  const draft: CtDeployDraft = {
    title: text(d.title, 255),
    descriptionHtml: typeof d.descriptionHtml === "string" ? d.descriptionHtml.slice(0, 60000) : "",
    tags: strs(d.tags, 60),
    productType: text(d.productType, 255),
    vendor: text(d.vendor, 255),
    status: STATUSES.includes(d.status as CtShopifyStatus) ? (d.status as CtShopifyStatus) : "ACTIVE",
    collectionIds,
    primaryCollectionId: typeof d.primaryCollectionId === "string" && collectionIds.includes(d.primaryCollectionId) ? d.primaryCollectionId : null,
    savedAt: typeof d.savedAt === "string" && !Number.isNaN(Date.parse(d.savedAt)) ? d.savedAt : new Date(0).toISOString(),
  };
  return draft.title || draft.descriptionHtml ? draft : null;
}

export function normalizeCustomerNote(raw: unknown): CtCustomerNote {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CUSTOMER_NOTE };
  const n = raw as Partial<CtCustomerNote>;
  // The label is the order line's property name: a leading "_" would hide it from the order.
  const label = text(n.label, 60).replace(/^_+/, "").replace(/[[\]]/g, "") || DEFAULT_CUSTOMER_NOTE.label;
  const maxChars = typeof n.maxChars === "number" && Number.isFinite(n.maxChars) ? Math.min(2000, Math.max(1, Math.round(n.maxChars))) : DEFAULT_CUSTOMER_NOTE.maxChars;
  return { enabled: n.enabled === true, label, placeholder: text(n.placeholder, 200), required: n.required === true, maxChars };
}

/** The product's draft while it is newer than its last deploy; null = use the Shopify product / the defaults. */
export function liveDraft(product: Pick<CtProduct, "config" | "shopify">): CtDeployDraft | null {
  const draft = normalizeDeployDraft(product.config?.deployDraft);
  if (!draft) return null;
  const deployed = product.shopify?.deployedAt ? Date.parse(product.shopify.deployedAt) : 0;
  return Date.parse(draft.savedAt) > deployed ? draft : null;
}
