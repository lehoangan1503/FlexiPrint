/**
 * Variants + price tables — pure helpers shared by the base page, the Deploy page, the server deploy
 * (server/shopify.ts), the MCP tools and the storefront preview.
 *
 * 2026-11-24 (boss: "việc tạo bảng giá là riêng, việc tạo variant của sản phẩm là riêng"): the PRODUCT BASE says
 * which variants exist (config.options, e.g. Material × Size → 2 rows of buttons on Shopify, 6 variants); the PRICE
 * TABLE only prices them — one row per combination of option values, plus the packs ("Buy More Save More", the last
 * Shopify option). Rows match by their values, so one table can serve several bases.
 *
 *   cell price   = row.price × qty × (1 − pack.discountPct / 100)   (or the hand-set override)
 *   cell compare = row.compareAt × qty; with no compareAt, a discounted pack shows row.price × qty struck out
 */

import type { CtBaseOption, CtMaterialId, CtPriceCell, CtPricePack, CtPriceRow, CtPriceTable, CtPriceTableConfig, CtShopifyPricing } from "../types";
import { newId } from "./geometry";

export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Shopify: at most 3 options per product (the pack counts as one) and 2048 variants. */
export const CT_SHOPIFY_OPTIONS_MAX = 3;
export const CT_SHOPIFY_VARIANTS_MAX = 2048;

function num(v: unknown, fallback: number, lo = 0, hi = 1e7): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

function str(v: unknown, fallback: string, max = 120): string {
  return typeof v === "string" ? v.slice(0, max) : fallback;
}

export function packLabelFor(qty: number): string {
  return qty === 1 ? "1 PC" : `${qty} PCS`;
}

/** How option values compare (Shopify itself ignores case): trimmed, lower case. */
export const valueKey = (v: string): string => v.trim().toLowerCase();
const rowKey = (values: string[]): string => values.map(valueKey).join("\u0001");

/** A new table: one price per piece, one pack of 1. `options` (a base's) pre-fill one row per variant. */
export function defaultPriceTableConfig(options: CtBaseOption[] = []): CtPriceTableConfig {
  const opts = cleanOptions(options);
  return {
    optionNames: opts.map((o) => o.name),
    packLabel: "Buy More Save More (Different Designs)",
    itemLabel: "Design",
    rows: combinations(opts).map((values) => ({ id: newId(), values, price: 0, compareAt: null })),
    packs: [{ id: newId(), qty: 1, label: packLabelFor(1), discountPct: 0 }],
    overrides: {},
  };
}

function money(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? round2(num(v, 0)) : null;
}

/**
 * Fill / clamp whatever was stored (or posted). Reads the old Size × Pack shape too ({sizeLabel, sizes}: each size
 * = a row of one value, or of none when the table had a single unnamed size) — migration 039 rewrote the stored ones.
 */
export function normalizePriceTableConfig(raw: unknown): CtPriceTableConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<CtPriceTableConfig> & { sizeLabel?: unknown; sizes?: unknown };
  let optionNames: string[];
  let rawRows: unknown[];
  if (Array.isArray(r.rows)) {
    optionNames = (Array.isArray(r.optionNames) ? r.optionNames : []).map((n) => str(n, "", 60).trim()).slice(0, CT_SHOPIFY_OPTIONS_MAX);
    rawRows = r.rows;
  } else {
    const sizes = (Array.isArray(r.sizes) ? r.sizes : []).filter((s): s is Record<string, unknown> => !!s && typeof s === "object");
    const named = sizes.length > 1 || (sizes.length === 1 && str(sizes[0].label, "").trim() !== "");
    optionNames = named ? [str(r.sizeLabel, "Size", 60).trim() || "Size"] : [];
    rawRows = (named ? sizes : sizes.slice(0, 1)).map((s) => ({ id: s.id, values: named ? [s.label] : [], price: s.price, compareAt: s.compareAt }));
  }
  const seenRow = new Set<string>();
  const rows: CtPriceRow[] = [];
  for (const x of rawRows) {
    if (!x || typeof x !== "object") continue;
    const o = x as Partial<Record<keyof CtPriceRow, unknown>>;
    const values = (Array.isArray(o.values) ? o.values : []).map((v) => str(v, "", 120).trim()).slice(0, CT_SHOPIFY_OPTIONS_MAX);
    if (values.some((v) => !v)) continue;
    const key = rowKey(values);
    if (seenRow.has(key)) continue;
    seenRow.add(key);
    rows.push({ id: str(o.id, "", 64) || newId(), values, price: round2(num(o.price, 0)), compareAt: money(o.compareAt) });
    if (rows.length >= 1000) break;
  }
  const seenPack = new Set<string>();
  const packs: CtPricePack[] = [];
  for (const p of Array.isArray(r.packs) ? r.packs : []) {
    if (!p || typeof p !== "object") continue;
    const qty = Math.round(num(p.qty, 1, 1, 50));
    const label = str(p.label, "", 60).trim() || packLabelFor(qty);
    const key = label.toLowerCase();
    if (seenPack.has(key)) continue;
    seenPack.add(key);
    packs.push({ id: str(p.id, "", 64) || newId(), qty, label, discountPct: round2(num(p.discountPct, 0, 0, 95)) });
    if (packs.length >= 20) break;
  }
  if (!packs.length) packs.push({ id: newId(), qty: 1, label: packLabelFor(1), discountPct: 0 });
  const overrides: CtPriceTableConfig["overrides"] = {};
  if (r.overrides && typeof r.overrides === "object") {
    for (const [k, o] of Object.entries(r.overrides)) {
      if (!o || typeof o !== "object" || k.length > 140) continue;
      const cell: CtPriceTableConfig["overrides"][string] = {};
      if (typeof o.price === "number" && Number.isFinite(o.price)) cell.price = round2(num(o.price, 0));
      if (o.compareAt === null) cell.compareAt = null;
      else if (typeof o.compareAt === "number" && Number.isFinite(o.compareAt)) cell.compareAt = round2(num(o.compareAt, 0));
      if (Object.keys(cell).length) overrides[k] = cell;
    }
  }
  return {
    optionNames,
    rows,
    packLabel: str(r.packLabel, "Pack", 60).trim() || "Pack",
    itemLabel: str(r.itemLabel, "Design", 40).trim() || "Design",
    packs,
    overrides,
  };
}

/** Options with a name and at least one value, values trimmed and unique (what goes to Shopify). */
export function cleanOptions(options: CtBaseOption[] | null | undefined): CtBaseOption[] {
  const out: CtBaseOption[] = [];
  for (const o of options ?? []) {
    const seen = new Set<string>();
    const values = o.values.map((v) => v.trim()).filter((v) => v && !seen.has(valueKey(v)) && seen.add(valueKey(v)));
    if (values.length) out.push({ ...o, name: o.name.trim(), values });
  }
  return out;
}

/** The options a table's rows are for (a base without options of its own, an old product): names from the table. */
export function optionsFromTable(cfg: CtPriceTableConfig): CtBaseOption[] {
  const n = Math.max(0, ...cfg.rows.map((r) => r.values.length));
  const out: CtBaseOption[] = [];
  for (let i = 0; i < n; i++) {
    const seen = new Set<string>();
    const values: string[] = [];
    for (const r of cfg.rows) {
      const v = r.values[i];
      if (v && !seen.has(valueKey(v))) {
        seen.add(valueKey(v));
        values.push(v);
      }
    }
    out.push({ id: `table-${i}`, name: cfg.optionNames[i] || (i === 0 ? "Size" : `Option ${i + 1}`), values });
  }
  return out;
}

/** The variants' options: the base's own; a base without any takes the table's (what it was before 2026-11-24). */
export function effectiveOptions(cfg: CtPriceTableConfig | null, baseOptions: CtBaseOption[] | null | undefined): CtBaseOption[] {
  const own = cleanOptions(baseOptions);
  if (own.length || !cfg) return own;
  return cleanOptions(optionsFromTable(cfg));
}

/** Every combination of the options' values, the first option outermost (the order Shopify lists variants). */
export function combinations(options: CtBaseOption[]): string[][] {
  return options.reduce<string[][]>((acc, o) => acc.flatMap((head) => o.values.map((v) => [...head, v])), [[]]);
}

/** The row that prices these values; a product without options takes a table's only row whatever it names. */
export function rowFor(cfg: CtPriceTableConfig, values: string[]): CtPriceRow | null {
  const key = rowKey(values);
  return cfg.rows.find((r) => rowKey(r.values) === key) ?? (values.length === 0 && cfg.rows.length === 1 ? cfg.rows[0] : null);
}

export const cellKey = (row: CtPriceRow | null, pack: CtPricePack | null): string => `${row?.id ?? "-"}:${pack?.id ?? "-"}`;

/** Packs become a Shopify option when there is more than one (or the only one holds several designs). */
export function usesPacks(cfg: CtPriceTableConfig): boolean {
  return cfg.packs.length > 1 || (cfg.packs.length === 1 && cfg.packs[0].qty > 1);
}

/** The computed price of one cell (row null = the table has no price for these values). */
export function priceCell(cfg: CtPriceTableConfig, values: string[], row: CtPriceRow | null, pack: CtPricePack | null): CtPriceCell {
  const qty = pack?.qty ?? 1;
  const base = row?.price ?? 0;
  const baseCompare = row?.compareAt ?? null;
  const discount = pack?.discountPct ?? 0;
  const computed = round2(base * qty * (1 - discount / 100));
  const computedCompare = baseCompare !== null ? round2(baseCompare * qty) : discount > 0 ? round2(base * qty) : null;
  const o = row ? cfg.overrides[cellKey(row, pack)] : undefined;
  const price = o?.price ?? computed;
  let compareAt = o && "compareAt" in o ? (o.compareAt ?? null) : computedCompare;
  // Shopify shows a compare-at price only above the price.
  if (compareAt !== null && compareAt <= price) compareAt = null;
  return { values, row, pack, qty, price, compareAt, unit: qty > 0 ? price / qty : price, overridden: Boolean(o), missing: !row };
}

/** Every variant: the options' combinations (first option outermost) × the packs. `options` already effective. */
export function priceCells(cfg: CtPriceTableConfig, options: CtBaseOption[]): CtPriceCell[] {
  const packs: Array<CtPricePack | null> = usesPacks(cfg) ? cfg.packs : [cfg.packs[0] ?? null];
  return combinations(options).flatMap((values) => {
    const row = rowFor(cfg, values);
    return packs.map((p) => priceCell(cfg, values, row, p));
  });
}

/** The Shopify options in order: the base's, then the pack. */
export function shopifyOptions(cfg: CtPriceTableConfig, options: CtBaseOption[]): Array<{ name: string; values: string[]; pack: boolean }> {
  return [...options.map((o) => ({ name: o.name, values: o.values, pack: false })), ...(usesPacks(cfg) ? [{ name: cfg.packLabel, values: cfg.packs.map((p) => p.label), pack: true }] : [])];
}

/** One variant's option values as Shopify takes them ({optionName, value}), pack last. */
export function cellOptionValues(cfg: CtPriceTableConfig, options: CtBaseOption[], cell: CtPriceCell): Array<{ name: string; value: string }> {
  const out = options.map((o, i) => ({ name: o.name, value: cell.values[i] ?? "" }));
  if (usesPacks(cfg) && cell.pack) out.push({ name: cfg.packLabel, value: cell.pack.label });
  return out;
}

/** What is wrong with the base's options alone (names, repeats, how many). */
export function optionProblems(options: CtBaseOption[] | null | undefined): string[] {
  const out: string[] = [];
  const list = options ?? [];
  if (list.length > CT_SHOPIFY_OPTIONS_MAX) out.push(`Tối đa ${CT_SHOPIFY_OPTIONS_MAX} hàng lựa chọn (giới hạn Shopify).`);
  const names = new Set<string>();
  for (const o of list) {
    const name = o.name.trim();
    if (!name && o.values.some((v) => v.trim())) out.push("Mỗi hàng lựa chọn cần tên (vd. Size, Material).");
    if (name && names.has(name.toLowerCase())) out.push(`Hai hàng lựa chọn cùng tên “${name}”.`);
    names.add(name.toLowerCase());
    const seen = new Set<string>();
    for (const v of o.values.map((x) => x.trim()).filter(Boolean)) {
      if (seen.has(valueKey(v))) out.push(`“${name || "?"}” có giá trị lặp: ${v}.`);
      seen.add(valueKey(v));
    }
  }
  return out;
}

/**
 * What stops a deploy of these options with this table; empty = fine. `options` = the base's own (null / [] = the
 * table's own, as effectiveOptions).
 */
export function variantProblems(cfg: CtPriceTableConfig, baseOptions: CtBaseOption[] | null | undefined): string[] {
  const out = optionProblems(baseOptions);
  const options = effectiveOptions(cfg, baseOptions);
  const packs = usesPacks(cfg);
  if (options.length + (packs ? 1 : 0) > CT_SHOPIFY_OPTIONS_MAX) out.push(`Shopify cho tối đa ${CT_SHOPIFY_OPTIONS_MAX} hàng lựa chọn: ${options.length} hàng biến thể${packs ? " + 1 hàng pack" : ""}.`);
  if (packs && options.some((o) => o.name.toLowerCase() === cfg.packLabel.toLowerCase())) out.push("Tên option pack trùng tên một hàng lựa chọn.");
  const cells = priceCells(cfg, options);
  const missing = [...new Set(cells.filter((c) => c.missing).map((c) => c.values.join(" · ") || "(1 giá)"))];
  if (missing.length) out.push(`Bảng giá chưa có giá cho ${missing.length} biến thể: ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? "…" : ""}.`);
  if (cells.some((c) => !c.missing && c.price <= 0)) out.push("Có biến thể giá bằng 0.");
  if (cells.length > CT_SHOPIFY_VARIANTS_MAX) out.push(`Quá ${CT_SHOPIFY_VARIANTS_MAX} variant (giới hạn Shopify).`);
  return out;
}

/** What is wrong with a table on its own (no base given): its own rows + packs. */
export function priceTableProblems(cfg: CtPriceTableConfig): string[] {
  if (!cfg.rows.length) return ["Bảng giá cần ít nhất 1 giá."];
  return variantProblems(cfg, null);
}

/** The metafield customize_tool.pricing written on deploy. */
export function shopifyPricing(cfg: CtPriceTableConfig, options: CtBaseOption[]): CtShopifyPricing {
  const packs: Record<string, number> = {};
  if (usesPacks(cfg)) for (const p of cfg.packs) packs[p.label] = p.qty;
  return {
    schema: 1,
    sizeOption: options.find((o) => /size/i.test(o.name))?.name ?? options[0]?.name ?? null,
    packOption: usesPacks(cfg) ? cfg.packLabel : null,
    itemLabel: cfg.itemLabel,
    packs,
  };
}

/** "$19.95 – $139.50" over the cells that have a price. */
export function priceRange(cells: CtPriceCell[]): string {
  const prices = cells.filter((c) => !c.missing).map((c) => c.price);
  if (!prices.length) return "—";
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  return lo === hi ? formatUsd(lo) : `${formatUsd(lo)} – ${formatUsd(hi)}`;
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * The word a price table's name carries for a material ("Acrylic Ornament 1 side · Cherivia"): the store keeps one
 * table per kind of piece (2026-10-30: the Notion price list — updated, never one more per product).
 */
const MATERIAL_WORD: Partial<Record<CtMaterialId, { find: RegExp; name: string }>> = {
  acrylic_clear: { find: /acrylic/i, name: "Acrylic" },
  acrylic_white: { find: /acrylic/i, name: "Acrylic" },
  glass_clear: { find: /glass/i, name: "Glass" },
  ceramic_gloss: { find: /ceramic/i, name: "Ceramic" },
  ceramic_matte: { find: /ceramic/i, name: "Ceramic" },
  aluminum: { find: /alumin|metal/i, name: "Aluminum" },
  wood: { find: /wood/i, name: "Wooden" },
};

export function materialWord(material: string): { find: RegExp; name: string } | null {
  return MATERIAL_WORD[material as CtMaterialId] ?? null;
}

/** The price table of a product's material, or null when no table names it. */
export function priceTableFor<T extends Pick<CtPriceTable, "name">>(tables: T[], material: string): T | null {
  const word = materialWord(material);
  return (word && tables.find((t) => word.find.test(t.name))) || null;
}

/**
 * The base product of a material (an import, an agent's product): the one made of it, else the one whose name
 * carries the material's word. A doll / unknown material: null — the editor picks.
 */
export function baseProductFor<T extends { name: string; config: { material: string } }>(bases: T[], material: string): T | null {
  if (!material || material === "none") return null;
  const same = bases.find((b) => b.config.material === material);
  if (same) return same;
  const word = materialWord(material);
  return (word && bases.find((b) => word.find.test(b.name))) || null;
}

/** Words of a name, lower case, plural "s" dropped ("Ornaments-2 Side" → ornament, 2, side). */
function nameWords(name: string): string[] {
  return (name.toLowerCase().match(/[a-z0-9]+/g) ?? []).map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
}

/**
 * The Notion price table an imported fulfiller product fits (2026-11-11: "đã có bảng giá thì lấy luôn, chưa có thì
 * để trống"): the table whose own name — before " · " — has every word in the product's title ("Glass Ornament 1
 * side · Cherivia" ↔ "Round Glass Ornament-1 Side Print"). Strict on purpose: no fit = null, picked later by hand.
 */
export function priceTableForTitle<T extends Pick<CtPriceTable, "id" | "name">>(tables: T[], title: string): T | null {
  const have = new Set(nameWords(title));
  const fits = tables
    .map((t) => ({ t, words: nameWords(t.name.split("·")[0] ?? "") }))
    .filter((x) => x.words.length > 0 && x.words.every((w) => have.has(w)))
    .sort((a, b) => b.words.length - a.words.length);
  return fits[0]?.t ?? null;
}
