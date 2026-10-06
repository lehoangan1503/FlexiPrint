/**
 * Price tables (Bảng giá) — pure helpers shared by the Deploy page, the server deploy (server/shopify.ts) and the
 * storefront. A table is Size × Pack: each cell is one Shopify variant priced at the pack's TOTAL.
 *
 *   cell price   = size.price × qty × (1 − pack.discountPct / 100)   (or the hand-set override)
 *   cell compare = size.compareAt × qty; with no compareAt, a discounted pack shows size.price × qty struck out
 */

import type { CtPriceCell, CtPricePack, CtPriceSize, CtPriceTableConfig, CtShopifyPricing } from "../types";
import { newId } from "./geometry";

export const round2 = (n: number): number => Math.round(n * 100) / 100;

function num(v: unknown, fallback: number, lo = 0, hi = 1e7): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

function str(v: unknown, fallback: string, max = 120): string {
  return typeof v === "string" ? v.slice(0, max) : fallback;
}

export function packLabelFor(qty: number): string {
  return qty === 1 ? "1 PC" : `${qty} PCS`;
}

/** The example table (Car Plate Ornament): 3 sizes, 1–6 pieces. */
export function defaultPriceTableConfig(): CtPriceTableConfig {
  const discounts = [0, 6, 10.7, 15, 19.25, 23.4];
  return {
    sizeLabel: "Size",
    packLabel: "Buy More Save More (Different Designs)",
    itemLabel: "Design",
    sizes: [
      { id: newId(), label: "3.5 inches", price: 24.95, compareAt: null },
      { id: newId(), label: "4.5 inches", price: 24.95, compareAt: null },
      { id: newId(), label: "5.5 inches", price: 24.95, compareAt: null },
    ],
    packs: discounts.map((d, i) => ({ id: newId(), qty: i + 1, label: packLabelFor(i + 1), discountPct: d })),
    overrides: {},
  };
}

/** Fill / clamp whatever was stored (or posted). Labels are trimmed and kept unique per dimension (Shopify needs that). */
export function normalizePriceTableConfig(raw: unknown): CtPriceTableConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<CtPriceTableConfig>;
  const seenSize = new Set<string>();
  const sizes: CtPriceSize[] = [];
  for (const s of Array.isArray(r.sizes) ? r.sizes : []) {
    if (!s || typeof s !== "object") continue;
    const label = str(s.label, "", 60).trim();
    const key = label.toLowerCase();
    if (seenSize.has(key)) continue;
    seenSize.add(key);
    sizes.push({
      id: str(s.id, "", 64) || newId(),
      label,
      price: round2(num(s.price, 0)),
      compareAt: s.compareAt === null || s.compareAt === undefined ? null : round2(num(s.compareAt, 0)),
    });
    if (sizes.length >= 30) break;
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
    sizeLabel: str(r.sizeLabel, "Size", 60).trim() || "Size",
    packLabel: str(r.packLabel, "Pack", 60).trim() || "Pack",
    itemLabel: str(r.itemLabel, "Design", 40).trim() || "Design",
    sizes,
    packs,
    overrides,
  };
}

export const cellKey = (size: CtPriceSize | null, pack: CtPricePack | null): string => `${size?.id ?? "-"}:${pack?.id ?? "-"}`;

/** Sizes become a Shopify option unless there is at most one, unnamed. */
export function usesSizes(cfg: CtPriceTableConfig): boolean {
  return cfg.sizes.length > 1 || (cfg.sizes.length === 1 && cfg.sizes[0].label !== "");
}

/** Packs become a Shopify option when there is more than one (or the only one holds several designs). */
export function usesPacks(cfg: CtPriceTableConfig): boolean {
  return cfg.packs.length > 1 || (cfg.packs.length === 1 && cfg.packs[0].qty > 1);
}

/** The computed price of one cell (size null = the table has no sizes; pack null = 1 piece). */
export function priceCell(cfg: CtPriceTableConfig, size: CtPriceSize | null, pack: CtPricePack | null): CtPriceCell {
  const qty = pack?.qty ?? 1;
  const base = size?.price ?? cfg.sizes[0]?.price ?? 0;
  const baseCompare = size ? size.compareAt : (cfg.sizes[0]?.compareAt ?? null);
  const discount = pack?.discountPct ?? 0;
  const computed = round2(base * qty * (1 - discount / 100));
  const computedCompare = baseCompare !== null ? round2(baseCompare * qty) : discount > 0 ? round2(base * qty) : null;
  const o = cfg.overrides[cellKey(size, pack)];
  const price = o?.price ?? computed;
  let compareAt = o && "compareAt" in o ? (o.compareAt ?? null) : computedCompare;
  // Shopify shows a compare-at price only above the price.
  if (compareAt !== null && compareAt <= price) compareAt = null;
  return { size, pack, qty, price, compareAt, unit: qty > 0 ? price / qty : price, overridden: Boolean(o) };
}

/** Every variant the table makes, size-major (the order Shopify lists them). */
export function priceCells(cfg: CtPriceTableConfig): CtPriceCell[] {
  const sizes: Array<CtPriceSize | null> = usesSizes(cfg) ? cfg.sizes : [cfg.sizes[0] ?? null];
  const packs: Array<CtPricePack | null> = usesPacks(cfg) ? cfg.packs : [cfg.packs[0] ?? null];
  return sizes.flatMap((s) => packs.map((p) => priceCell(cfg, s, p)));
}

/** What is wrong with a table before it can be deployed; empty = fine. */
export function priceTableProblems(cfg: CtPriceTableConfig): string[] {
  const out: string[] = [];
  if (cfg.sizes.length === 0) out.push("Bảng giá cần ít nhất 1 size (giá 1 cái).");
  if (cfg.sizes.length > 1 && cfg.sizes.some((s) => !s.label)) out.push("Mỗi size cần tên (vd. 3.5 inches).");
  if (usesSizes(cfg) && usesPacks(cfg) && cfg.sizeLabel.toLowerCase() === cfg.packLabel.toLowerCase()) out.push("Tên option Size và Pack phải khác nhau.");
  const cells = priceCells(cfg);
  if (cells.some((c) => c.price <= 0)) out.push("Có ô giá bằng 0.");
  if (cells.length > 2048) out.push("Quá 2048 variant (giới hạn Shopify).");
  return out;
}

/** The metafield customize_tool.pricing written on deploy. */
export function shopifyPricing(cfg: CtPriceTableConfig): CtShopifyPricing {
  const packs: Record<string, number> = {};
  if (usesPacks(cfg)) for (const p of cfg.packs) packs[p.label] = p.qty;
  return {
    schema: 1,
    sizeOption: usesSizes(cfg) ? cfg.sizeLabel : null,
    packOption: usesPacks(cfg) ? cfg.packLabel : null,
    itemLabel: cfg.itemLabel,
    packs,
  };
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}
