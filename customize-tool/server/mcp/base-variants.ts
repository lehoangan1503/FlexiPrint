/**
 * The variants + price table arguments of create_base_product / update_base_product (2026-11-24, boss: "việc tạo
 * bảng giá là riêng, việc tạo variant của sản phẩm là riêng, và phải hỏi lại user khi tạo một product base khác"):
 *
 *   options      the base's Shopify options [{name, values}] — "Material" × "Size", never two kinds glued into one
 *                size label ("30 x 40 inches - Fleece")
 *   price_table  prices only: {option_names?, rows: [{values, price, compare_at?}], pack_label?, packs?, item_label?}
 *
 * Nothing is saved on the first call: it answers a preview (Shopify option rows, variant count, every price, what is
 * wrong) and a confirm_token. The agent shows the preview to the user, asks, and calls again with the same arguments
 * + confirm_token. Different arguments = a different token (the old one is refused).
 */

import { createHash, randomBytes } from "node:crypto";
import type { CtBaseOption, CtPriceTableConfig } from "../../types";
import { normalizeBaseOptions } from "../../lib/base-product";
import { effectiveOptions, formatUsd, normalizePriceTableConfig, optionProblems, priceCells, shopifyOptions, usesPacks, variantProblems } from "../../lib/pricing";

const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const list = (v: unknown) => (Array.isArray(v) ? v.map(obj).filter((x): x is Record<string, unknown> => !!x) : []);

export const OPTIONS_ARG = {
  type: "array",
  items: { type: "object" },
  description:
    'The variants the customer picks on Shopify, one entry per row of buttons (max 3 with the pack row): [{"name": "Material", "values": ["Plush Blanket", "Sherpa Blanket"]}, {"name": "Size", "values": ["30 x 40 inches", "50 x 60 inches", "60 x 80 inches"]}] → 2 × 3 = 6 variants. Each kind of difference is its OWN row — never glue two into one value ("30 x 40 inches - Fleece"). Omitted: taken from price_table\'s rows.',
};

export const PRICE_TABLE_ARG = {
  type: "object",
  description:
    'PRICES only, one row per combination of option values in the options\' order: {rows: [{"values": ["Plush Blanket", "30 x 40 inches"], "price": 48.97, "compare_at": 69.95}, …], option_names?: [names of the rows\' values, default the options\' names], pack_label?: "Buy More Save More (Different Designs)", packs?: [{qty, label?, discount_pct}] (no packs = one piece only; packs become the last option row), item_label?: "Design"}. A product without options: rows: [{"values": [], "price": …}].',
};

export const CONFIRM_ARG = {
  type: "string",
  description: "From the preview this tool answered first (nothing is saved without it): show the preview to the user, ask, then call again with the SAME arguments + this token.",
};

/** The `options` argument; undefined when not given. */
export function readOptions(v: unknown): CtBaseOption[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new Error('options: a list [{"name": "Size", "values": ["…"]}]');
  const out = normalizeBaseOptions(list(v).map((o) => ({ name: o.name, values: o.values })));
  const bad = optionProblems(out);
  if (bad.length) throw new Error(`options: ${bad.join(" ")}`);
  if (out.some((o) => !o.name || !o.values.length)) throw new Error("options: each row needs a name and at least one value");
  return out;
}

/** The `price_table` argument (the old {size_label, sizes} shape still read); undefined when not given. */
export function readPriceTable(v: unknown, options: CtBaseOption[] | undefined): CtPriceTableConfig | undefined {
  const pt = obj(v);
  if (!pt) return undefined;
  const packs = list(pt.packs);
  const common = {
    packLabel: pt.pack_label,
    itemLabel: pt.item_label,
    packs: packs.length ? packs.map((x) => ({ qty: x.qty, label: x.label, discountPct: x.discount_pct })) : [{ qty: 1, label: "1 PC", discountPct: 0 }],
    overrides: {},
  };
  const cfg = Array.isArray(pt.rows)
    ? normalizePriceTableConfig({
        ...common,
        optionNames: Array.isArray(pt.option_names) ? pt.option_names : (options ?? []).map((o) => o.name),
        rows: list(pt.rows).map((x) => ({ values: x.values, price: x.price, compareAt: x.compare_at ?? null })),
      })
    : normalizePriceTableConfig({ ...common, sizeLabel: pt.size_label, sizes: list(pt.sizes).map((x) => ({ label: x.label, price: x.price, compareAt: x.compare_at ?? null })) });
  if (!cfg.rows.length) throw new Error("price_table: rows [{values, price, compare_at?}] is needed");
  return cfg;
}

/** What the products on the base will look like on Shopify, in words the user reads. */
export function variantPreview(cfg: CtPriceTableConfig | null, baseOptions: CtBaseOption[]) {
  const options = effectiveOptions(cfg, baseOptions);
  const rows = cfg ? shopifyOptions(cfg, options) : options.map((o) => ({ name: o.name, values: o.values, pack: false }));
  const cells = cfg ? priceCells(cfg, options) : [];
  return {
    shopify_option_rows: rows.map((o) => `${o.name}: ${o.values.join(" | ")}`),
    variant_count: cfg ? cells.length : rows.reduce((n, o) => n * o.values.length, 1),
    prices: cfg
      ? cells.slice(0, 80).map((c) => `${[...c.values, ...(usesPacks(cfg) && c.pack ? [c.pack.label] : [])].join(" · ") || "(one price)"}: ${c.missing ? "NO PRICE" : `${formatUsd(c.price)}${c.compareAt !== null ? ` (was ${formatUsd(c.compareAt)})` : ""}`}`)
      : ["No price table yet — the base's products cannot be deployed until one is set."],
    problems: cfg ? variantProblems(cfg, baseOptions) : [],
  };
}

const SECRET = process.env.CT_MCP_CONFIRM_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || randomBytes(24).toString("hex");

/** The token of a preview: the same arguments (ids aside) give the same token. */
export function confirmToken(kind: string, what: { name: string; options: CtBaseOption[]; table: CtPriceTableConfig | null; tableId: string | null }): string {
  const canon = {
    kind,
    name: what.name,
    options: what.options.map((o) => [o.name, o.values]),
    tableId: what.tableId,
    table: what.table && {
      n: what.table.optionNames,
      r: what.table.rows.map((r) => [r.values, r.price, r.compareAt]),
      p: what.table.packs.map((p) => [p.qty, p.label, p.discountPct]),
      pl: what.table.packLabel,
      il: what.table.itemLabel,
    },
  };
  return createHash("sha256").update(SECRET).update(JSON.stringify(canon)).digest("hex").slice(0, 20);
}

/** The first call's answer: the preview + the token, nothing saved. */
export function previewAnswer(token: string, preview: ReturnType<typeof variantPreview>, extra: Record<string, unknown> = {}) {
  return {
    saved: false,
    preview,
    ...extra,
    confirm_token: token,
    next:
      "NOTHING IS SAVED YET. Show the user the preview above (the Shopify option rows, the variant count, the prices, the problems) and ASK whether the variants and prices are right. Only when they say yes, call this tool again with the SAME arguments + confirm_token. Something to change → change the arguments and call without confirm_token for a new preview.",
  };
}
