/**
 * The product's SKU = its name (asked 2026-11-24: "n06-POD-126 … đây là sku của sản phẩm luôn"). Every Shopify
 * variant carries it, and a name that is not n0x-POD-yyy (x one digit, yyy a number with no leading 0: n06-POD-56,
 * n06-POD-126) is never deployed — the Deploy page, bulk Deploy, MCP check_deploy / deploy_product and the server's
 * runDeploy all ask skuProblem.
 */

export const CT_SKU_RE = /^n0\d-POD-[1-9]\d*$/;

export const CT_SKU_FORMAT = "n0x-POD-yyy (x là 1 chữ số, yyy là số không có số 0 ở đầu — ví dụ n06-POD-56, n06-POD-126)";

/** The SKU a product is sold under: its name, trimmed. */
export function productSku(name: string | null | undefined): string {
  return (name ?? "").trim();
}

/** Why this name cannot be the SKU; null when it is fine. */
export function skuProblem(name: string | null | undefined): string | null {
  const sku = productSku(name);
  if (CT_SKU_RE.test(sku)) return null;
  return `Tên sản phẩm “${sku || "(trống)"}” không phải SKU đúng chuẩn ${CT_SKU_FORMAT} — đổi tên sản phẩm rồi deploy lại.`;
}
