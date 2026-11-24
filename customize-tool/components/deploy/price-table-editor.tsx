"use client";

/**
 * Bảng giá: create / edit a named price table (ct_price_tables) — PRICES only (2026-11-24). Opened from a product
 * base, it lists that base's variants (its options' combinations) and takes one price + struck price per variant;
 * opened alone (Deploy page, no base options), it edits its own option names / values. Packs ("Buy More Save More")
 * stay here: each (variant, pack) cell = one Shopify variant priced at the pack's total, computed from the % off
 * unless typed in by hand.
 */

import { useMemo, useState } from "react";
import { Loader2, Plus, RotateCcw, Trash2 } from "lucide-react";
import type { CtBaseOption, CtPriceCellOverride, CtPricePack, CtPriceRow, CtPriceTable, CtPriceTableConfig } from "../../types";
import { CT_SHOPIFY_OPTIONS_MAX, cellKey, cleanOptions, combinations, defaultPriceTableConfig, formatUsd, normalizePriceTableConfig, optionsFromTable, packLabelFor, priceCell, round2, rowFor, usesPacks, valueKey, variantProblems } from "../../lib/pricing";
import { newId } from "../../lib/geometry";
import { ctApi } from "../../lib/api-client";
import { ctConfirm } from "../dialogs";
import { CtButton, CtField, CtInput, CtModal, CtNumber, cx } from "../ui";
import { OptionsEditor, ShopifyOptionsPreview } from "./variant-ui";

const sameValues = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => valueKey(v) === valueKey(b[i]));

export function PriceTableEditor({
  table,
  options,
  defaultName,
  onClose,
  onSaved,
  onDeleted,
}: {
  /** null = a new table. */
  table: CtPriceTable | null;
  /** The product base's own options: the variants to price (null / [] = the table edits its own). */
  options?: CtBaseOption[] | null;
  /** Name of a new table (the base's). */
  defaultName?: string;
  onClose: () => void;
  onSaved: (t: CtPriceTable) => void;
  onDeleted: (id: string) => void;
}) {
  const baseOptions = useMemo(() => cleanOptions(options), [options]);
  const baseMode = baseOptions.length > 0;
  const [name, setName] = useState(table?.name ?? defaultName ?? "Bảng giá mới");
  const [cfg, setCfg] = useState<CtPriceTableConfig>(() => (table ? normalizePriceTableConfig(table.config) : defaultPriceTableConfig(baseOptions)));
  /** Standalone: the table's own options, read once from its rows. */
  const [ownOptions, setOwnOptions] = useState<CtBaseOption[]>(() => (table ? optionsFromTable(normalizePriceTableConfig(table.config)) : []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const opts = baseMode ? baseOptions : cleanOptions(ownOptions);
  const combos = useMemo(() => combinations(opts), [opts]);
  const packs = usesPacks(cfg) ? cfg.packs : cfg.packs.slice(0, 1);
  const orphans = cfg.rows.filter((r) => !combos.some((v) => sameValues(v, r.values)) && !(combos.length === 1 && combos[0].length === 0 && cfg.rows.length === 1));
  const problems = useMemo(() => variantProblems(normalizePriceTableConfig(cfg), opts), [cfg, opts]);

  const patch = (p: Partial<CtPriceTableConfig>) => setCfg((c) => ({ ...c, ...p }));
  /** Set the price of the variant `values`: its row, or a new one. */
  const setRow = (values: string[], p: Partial<CtPriceRow>) =>
    setCfg((c) => {
      const row = rowFor(c, values);
      return row ? { ...c, rows: c.rows.map((r) => (r.id === row.id ? { ...r, ...p } : r)) } : { ...c, rows: [...c.rows, { id: newId(), values, price: 0, compareAt: null, ...p }] };
    });
  const setPack = (id: string, p: Partial<CtPricePack>) => patch({ packs: cfg.packs.map((x) => (x.id === id ? { ...x, ...p } : x)) });
  const setCell = (key: string, o: CtPriceCellOverride | null) => {
    const overrides = { ...cfg.overrides };
    if (o) overrides[key] = { ...overrides[key], ...o };
    else delete overrides[key];
    patch({ overrides });
  };

  const save = async () => {
    const clean = name.trim();
    if (!clean) return setError("Đặt tên cho bảng giá");
    setBusy(true);
    setError(null);
    try {
      const body = { name: clean, config: normalizePriceTableConfig({ ...cfg, optionNames: opts.map((o) => o.name) }) };
      onSaved(table ? await ctApi.updatePriceTable(table.id, body) : await ctApi.createPriceTable(body));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lưu thất bại");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!table || !(await ctConfirm({ title: `Xoá bảng giá “${table.name}”?`, message: "Sản phẩm đã deploy giữ nguyên giá trên Shopify; lần deploy sau phải chọn bảng giá khác.", confirmLabel: "Xoá", tone: "danger" }))) return;
    setBusy(true);
    try {
      await ctApi.deletePriceTable(table.id);
      onDeleted(table.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Xoá thất bại");
      setBusy(false);
    }
  };

  const compareInput = (row: CtPriceRow | null, values: string[]) => (
    <CtInput
      className="h-8"
      inputMode="decimal"
      placeholder="—"
      defaultValue={row?.compareAt ?? ""}
      key={`${row?.id ?? values.join("|")}:${row?.compareAt ?? ""}`}
      onBlur={(e) => {
        const t = e.target.value.trim().replace(",", ".");
        const n = Number(t);
        const compareAt = t === "" || !Number.isFinite(n) ? null : round2(Math.max(0, n));
        if (compareAt !== (row?.compareAt ?? null)) setRow(values, { compareAt });
      }}
      aria-label="Giá gạch"
    />
  );

  return (
    <CtModal open onOpenChange={(o) => !o && !busy && onClose()} title={table ? `Sửa bảng giá — ${table.name}` : "Tạo bảng giá"} wide>
      <div className="space-y-5 text-sm">
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
          <CtField label="Tên bảng giá">
            <CtInput value={name} onChange={(e) => setName(e.target.value)} placeholder="vd. Ornament 3 size · Buy more save more" autoFocus />
          </CtField>
          <CtField label="Tên 1 thiết kế trong pack" hint="Tab trên store: Ornament 1, Ornament 2…">
            <CtInput value={cfg.itemLabel} onChange={(e) => patch({ itemLabel: e.target.value })} placeholder="Ornament" />
          </CtField>
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          {/* Variants */}
          <section className="space-y-2 rounded-lg border p-3">
            <div className="text-xs font-medium">Biến thể</div>
            {baseMode ? (
              <p className="text-xs text-foreground/80">Biến thể do product base quyết định (sửa ở trang base). Bảng này chỉ giữ giá cho từng biến thể.</p>
            ) : (
              <OptionsEditor
                options={ownOptions}
                onChange={setOwnOptions}
                max={usesPacks(cfg) ? CT_SHOPIFY_OPTIONS_MAX - 1 : CT_SHOPIFY_OPTIONS_MAX}
                onRename={({ index, from, to }) => setCfg((c) => ({ ...c, rows: c.rows.map((r) => (valueKey(r.values[index] ?? "") === valueKey(from) ? { ...r, values: r.values.map((v, i) => (i === index ? to : v)) } : r)) }))}
              />
            )}
            <ShopifyOptionsPreview cfg={cfg} options={opts} />
          </section>

          {/* Packs */}
          <section className="space-y-2 rounded-lg border p-3">
            <CtField label="Tên option pack (Shopify)">
              <CtInput value={cfg.packLabel} onChange={(e) => patch({ packLabel: e.target.value })} placeholder="Buy More Save More (Different Designs)" />
            </CtField>
            <div className="grid grid-cols-[64px_1fr_80px_28px] gap-1.5 text-[11px] font-medium uppercase tracking-wide text-foreground/70">
              <span>Số cái</span>
              <span>Nhãn</span>
              <span>Giảm %</span>
              <span />
            </div>
            {cfg.packs.map((p) => (
              <div key={p.id} className="grid grid-cols-[64px_1fr_80px_28px] items-center gap-1.5">
                <CtNumber
                  className="h-8"
                  value={p.qty}
                  min={1}
                  onChange={(v) => {
                    const qty = Math.max(1, Math.min(50, Math.round(v)));
                    // A label that was the default for the old count follows the new one.
                    setPack(p.id, { qty, label: p.label === packLabelFor(p.qty) ? packLabelFor(qty) : p.label });
                  }}
                />
                <CtInput className="h-8" value={p.label} onChange={(e) => setPack(p.id, { label: e.target.value })} />
                <CtNumber className="h-8" value={p.discountPct} step={0.5} min={0} max={95} onChange={(v) => setPack(p.id, { discountPct: Math.max(0, Math.min(95, v)) })} />
                <CtButton size="icon" variant="ghost" aria-label="Xoá pack" disabled={cfg.packs.length <= 1} onClick={() => patch({ packs: cfg.packs.filter((x) => x.id !== p.id) })}>
                  <Trash2 className="h-3.5 w-3.5" />
                </CtButton>
              </div>
            ))}
            <CtButton
              size="sm"
              variant="subtle"
              onClick={() => {
                const qty = Math.min(50, (cfg.packs[cfg.packs.length - 1]?.qty ?? 0) + 1);
                patch({ packs: [...cfg.packs, { id: newId(), qty, label: packLabelFor(qty), discountPct: cfg.packs[cfg.packs.length - 1]?.discountPct ?? 0 }] });
              }}
            >
              <Plus className="h-3.5 w-3.5" /> Thêm pack
            </CtButton>
            <p className="text-[11px] text-foreground/70">Pack N cái = N thiết kế độc lập trên store (Different Designs). Chỉ 1 pack 1 cái = không có hàng pack.</p>
          </section>
        </div>

        {/* Prices */}
        <section className="space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-foreground/70">
            Giá từng biến thể · {combos.length * packs.length} variant
          </div>
          <div className="max-h-[50vh] overflow-auto rounded-lg border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10 bg-muted">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium">{opts.map((o) => o.name).join(" · ") || "Biến thể"}</th>
                  <th className="px-2 py-1.5 text-left font-medium">Giá 1 cái</th>
                  <th className="px-2 py-1.5 text-left font-medium">Giá gạch 1 cái</th>
                  {usesPacks(cfg) &&
                    packs.map((p) => (
                      <th key={p.id} className="px-2 py-1.5 text-left font-medium">
                        {p.label}
                      </th>
                    ))}
                </tr>
              </thead>
              <tbody>
                {combos.map((values) => {
                  const row = rowFor(cfg, values);
                  return (
                    <tr key={values.join("|") || "one"} className={cx("border-t align-top", !row && "bg-destructive/5")}>
                      <td className="whitespace-nowrap px-2 py-1.5 font-medium">
                        {values.join(" · ") || "1 giá"}
                        {!row && <div className="text-[11px] font-normal text-destructive">chưa có giá</div>}
                      </td>
                      <td className="px-2 py-1.5">
                        <CtNumber className="h-8 w-[88px]" value={row?.price ?? 0} step={0.01} min={0} onChange={(v) => setRow(values, { price: round2(Math.max(0, v)) })} />
                      </td>
                      <td className="w-[100px] px-2 py-1.5">{compareInput(row, values)}</td>
                      {usesPacks(cfg) &&
                        packs.map((p) => {
                          if (!row) return <td key={p.id} className="px-2 py-1.5 text-muted-foreground">—</td>;
                          const c = priceCell(cfg, values, row, p);
                          const key = cellKey(row, p);
                          return (
                            <td key={p.id} className={cx("min-w-[118px] px-2 py-1.5", c.overridden && "bg-amber-500/10")}>
                              <div className="flex items-center gap-1">
                                <CtNumber className="h-8 w-[84px] text-xs" value={c.price} step={0.01} min={0} onChange={(v) => setCell(key, { price: round2(Math.max(0, v)) })} />
                                {c.overridden && (
                                  <button className="rounded p-0.5 text-muted-foreground hover:bg-accent" title="Về giá tự tính" onClick={() => setCell(key, null)}>
                                    <RotateCcw className="h-3 w-3" />
                                  </button>
                                )}
                              </div>
                              <div className="mt-0.5 text-[11px] text-foreground/70">
                                {formatUsd(c.unit)}/pc{c.compareAt !== null && <s className="ml-1">{formatUsd(c.compareAt)}</s>}
                              </div>
                            </td>
                          );
                        })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {usesPacks(cfg) && <p className="text-[11px] text-foreground/70">Cột pack = tổng tiền cả pack. Ô vàng = giá gõ tay (không theo % giảm).</p>}
        </section>

        {orphans.length > 0 && (
          <section className="space-y-1.5 rounded-lg border border-dashed p-3">
            <div className="text-xs font-medium">Giá không thuộc biến thể {baseMode ? "của base này" : "nào ở trên"} ({orphans.length})</div>
            <p className="text-[11px] text-foreground/70">{baseMode ? "Có thể base khác dùng chung bảng này cần chúng — chỉ xoá khi chắc không ai dùng." : "Thường là giá của giá trị đã bỏ."}</p>
            <div className="flex flex-wrap gap-1.5">
              {orphans.map((r) => (
                <span key={r.id} className="inline-flex items-center gap-1 rounded-md border bg-background pl-2 text-xs">
                  {r.values.join(" · ") || "1 giá"} · {formatUsd(r.price)}
                  <button type="button" className="flex h-7 w-7 items-center justify-center rounded-r-md text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => patch({ rows: cfg.rows.filter((x) => x.id !== r.id) })} aria-label="Xoá giá này">
                    <Trash2 className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          </section>
        )}

        {problems.length > 0 && <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-300">{problems.join(" ")}</div>}
        {error && <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">{error}</div>}

        <div className="flex items-center gap-2 border-t pt-3">
          {table && (
            <CtButton variant="ghost" className="text-destructive" onClick={() => void remove()} disabled={busy}>
              <Trash2 className="h-4 w-4" /> Xoá bảng giá
            </CtButton>
          )}
          <div className="ml-auto flex gap-2">
            <CtButton onClick={onClose} disabled={busy}>
              Huỷ
            </CtButton>
            <CtButton variant="primary" onClick={() => void save()} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {table ? "Lưu bảng giá" : "Tạo bảng giá"}
            </CtButton>
          </div>
        </div>
      </div>
    </CtModal>
  );
}
