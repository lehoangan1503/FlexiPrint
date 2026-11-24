/**
 * The product's SKU = its name (asked 2026-11-24: "n06-POD-126 … đây là sku của sản phẩm luôn"). The standard is
 * n0x-POD-yyy (x one digit, yyy a number: n06-POD-56, n06-POD-126, n00-POD-02 — a leading 0 is kept as typed, asked
 * 2026-11-24 "n00-POD-02 thì cứ giữ nguyên … miễn k trùng là được"), no diacritics. Whatever the
 * user types is brought to it (asked 2026-11-24: "người dùng nhập gì vào cũng được mày tự chuyển về"): case, accents,
 * spaces / _ / . instead of -, "n6" for "n06", text around it ("n02-POD-23 Monster Truck Ornament")
 * — normalizeSku reads it, skuName writes the name back with that part in the standard form. A name with no SKU in
 * it is never deployed: the Deploy page, bulk Deploy, MCP check_deploy / deploy_product and the server's runDeploy
 * all ask skuProblem, and two products never share an SKU (server/sku-twins.ts). Each Shopify variant gets the SKU + its size / pack (variantSku: n06-POD-126-4IN-2-PCS).
 */

export const CT_SKU_RE = /^n0\d-POD-\d+$/;

export const CT_SKU_FORMAT = "n0x-POD-yyy (x là 1 chữ số, yyy là số — ví dụ n06-POD-56, n06-POD-126, n00-POD-02)";

/** Accents off (đ → d), for SKUs and their parts. */
export function unaccent(s: string): string {
  return s.normalize("NFD").replace(/\p{M}+/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D");
}

// An SKU anywhere in the name ("n02-POD-23 Monster Truck Ornament"), not glued to other letters / digits.
const LOOSE = /(?<![a-z0-9])n\s*0?\s*(\d)[\s\-_./]*p\s*o\s*d[\s\-_./]*(\d*[1-9]\d*)(?!\d)/i;

/** The name's characters (NFC) without accents, and which character each one came from. */
function flat(name: string): { chars: string[]; text: string; from: number[] } {
  const chars = [...name.normalize("NFC")];
  let text = "";
  const from: number[] = [];
  chars.forEach((c, i) => {
    for (const u of unaccent(c)) {
      text += u;
      from.push(i);
    }
  });
  return { chars, text, from };
}

/** The SKU in the name, in the standard form ("N6 pód_056 Gift" → "n06-POD-056"); null when there is none. */
export function normalizeSku(name: string | null | undefined): string | null {
  const m = LOOSE.exec(unaccent(name ?? ""));
  return m ? `n0${m[1]}-POD-${m[2]}` : null;
}

/** A name to store: its SKU part in the standard form, the rest (and accents) as typed; trimmed. */
export function skuName(name: string): string {
  const f = flat(name.trim());
  const m = LOOSE.exec(f.text);
  if (!m) return name.trim();
  const a = f.from[m.index];
  const b = f.from[m.index + m[0].length - 1] + 1;
  return `${f.chars.slice(0, a).join("")}n0${m[1]}-POD-${m[2]}${f.chars.slice(b).join("")}`.trim();
}

/** Why this name cannot be the SKU; null when it is fine (after normalizeSku). */
export function skuProblem(name: string | null | undefined): string | null {
  if (normalizeSku(name)) return null;
  const typed = (name ?? "").trim();
  return `Tên sản phẩm “${typed || "(trống)"}” không có SKU chuẩn ${CT_SKU_FORMAT} — thêm SKU vào tên sản phẩm rồi deploy lại.`;
}

/** One part of a variant SKU: no accents, upper case, anything but letters / digits / "." → "-". */
export function skuPart(label: string): string {
  return unaccent(label).toUpperCase().replace(/[^A-Z0-9.]+/g, "-").replace(/^-+|-+$/g, "");
}

/** A variant's SKU: the product's + its option values (size, pack) — the plain product SKU when it has none. */
export function variantSku(sku: string, values: string[]): string {
  return [sku, ...values.map(skuPart).filter(Boolean)].join("-");
}

/** Why the product's SKU cannot go up because of twins; null when it is its own. */
export function twinProblem(name: string, twins: Array<{ name: string }>): string | null {
  if (!twins.length) return null;
  const sku = normalizeSku(name);
  return `SKU ${sku} trùng với ${twins.length} sản phẩm khác (${twins.slice(0, 3).map((t) => `“${t.name}”`).join(", ")}${twins.length > 3 ? "…" : ""}) — đổi SKU trong tên cho khác rồi deploy lại.`;
}
