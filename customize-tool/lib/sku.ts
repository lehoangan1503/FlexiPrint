/**
 * The product's SKU: its own field (ct_products.sku, migration 040), nothing to do with the name or the Shopify title
 * (asked 2026-11-24: "sku là sku, k liên quan đến title"). The standard is n0x-POD-yyy (x one digit, yyy a number:
 * n06-POD-56, n06-POD-126, n00-POD-02 — a leading 0 is kept as typed, "miễn k trùng là được"), no diacritics.
 * Whatever the user types in the SKU box is brought to it ("người dùng nhập gì vào cũng được mày tự chuyển về"):
 * case, accents, spaces / _ / . instead of -, "n6" for "n06". A product with no SKU is never deployed: the Deploy page,
 * bulk Deploy, MCP check_deploy / deploy_product and the server's runDeploy all ask skuProblem, and two products never
 * share an SKU (server/sku-twins.ts). Each Shopify variant gets the SKU + its size / pack (variantSku:
 * n06-POD-126-4IN-2-PCS); the Shopify handle is the title's + the SKU at the end (shopifyHandle).
 */

export const CT_SKU_RE = /^n0\d-POD-\d+$/;

export const CT_SKU_FORMAT = "n0x-POD-yyy (x là 1 chữ số, yyy là số — ví dụ n06-POD-56, n06-POD-126, n00-POD-02)";

/** Accents off (đ → d), for SKUs and their parts. */
export function unaccent(s: string): string {
  return s.normalize("NFD").replace(/\p{M}+/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D");
}

// The whole box is the SKU, written loosely ("N6 pód_056").
const LOOSE = /^\s*n\s*0?\s*(\d)[\s\-_./]*p\s*o\s*d[\s\-_./]*(\d*[1-9]\d*)\s*$/i;

/** The typed SKU in the standard form ("N6 pód_056" → "n06-POD-056"); null when it is not one. */
export function normalizeSku(typed: string | null | undefined): string | null {
  const m = LOOSE.exec(unaccent(typed ?? ""));
  return m ? `n0${m[1]}-POD-${m[2]}` : null;
}

/** Why this product's SKU cannot go to Shopify; null when it is fine. */
export function skuProblem(sku: string | null | undefined): string | null {
  const typed = (sku ?? "").trim();
  if (!typed) return `Sản phẩm chưa có SKU — điền ô SKU theo chuẩn ${CT_SKU_FORMAT} rồi deploy.`;
  if (normalizeSku(typed)) return null;
  return `SKU “${typed}” không đúng chuẩn ${CT_SKU_FORMAT} — sửa ô SKU rồi deploy.`;
}

/** One part of a variant SKU: no accents, upper case, anything but letters / digits / "." → "-". */
export function skuPart(label: string): string {
  return unaccent(label).toUpperCase().replace(/[^A-Z0-9.]+/g, "-").replace(/^-+|-+$/g, "");
}

/** A variant's SKU: the product's + its option values (size, pack) — the plain product SKU when it has none. */
export function variantSku(sku: string, values: string[]): string {
  return [sku, ...values.map(skuPart).filter(Boolean)].join("-");
}

/** Text → a Shopify handle piece: no accents, lower case, anything but letters / digits → "-". */
function slug(s: string): string {
  return unaccent(s).toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The Shopify handle (asked 2026-11-24): the title's handle + the SKU at the end — once, max 255 characters. */
export function shopifyHandle(title: string, sku: string): string {
  const tail = slug(sku);
  let head = slug(title);
  if (head === tail || head.endsWith(`-${tail}`)) head = head.slice(0, head.length - tail.length).replace(/-+$/, "");
  head = head.slice(0, 254 - tail.length).replace(/-+$/, "");
  return head ? `${head}-${tail}` : tail;
}

/** Why the product's SKU cannot go up because of twins; null when it is its own. */
export function twinProblem(sku: string | null | undefined, twins: Array<{ name: string }>): string | null {
  if (!twins.length) return null;
  return `SKU ${normalizeSku(sku) ?? sku ?? ""} trùng với ${twins.length} sản phẩm khác (${twins.slice(0, 3).map((t) => `“${t.name}”`).join(", ")}${twins.length > 3 ? "…" : ""}) — đổi SKU cho khác rồi deploy lại.`;
}
