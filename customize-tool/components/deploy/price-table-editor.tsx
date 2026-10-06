"use client";

/**
 * Bảng giá: create / edit a named Size × Pack price table (ct_price_tables). Each cell is one Shopify variant
 * priced at the pack's total; cells follow size price × qty − pack discount unless typed in by hand.
 */

import { useMemo, useState } from "react";
import { Loader2, Plus, RotateCcw, Trash2 } from "lucide-react";
import type { CtPriceCellOverride, CtPricePack, CtPriceSize, CtPriceTable, CtPriceTableConfig } from "../../types";
import { cellKey, defaultPriceTableConfig, formatUsd, normalizePriceTableConfig, packLabelFor, priceCell, priceTableProblems, round2, usesPacks, usesSizes } from "../../lib/pricing";
import { newId } from "../../lib/geometry";
import { ctApi } from "../../lib/api-client";
import { ctConfirm } from "../dialogs";
import { CtButton, CtField, CtInput, CtModal, CtNumber, cx } from "../ui";

export function PriceTableEditor({
  table,
  onClose,
  onSaved,
  onDeleted,
}: {
  /** null = a new table. */
  table: CtPriceTable | null;
  onClose: () => void;
  onSaved: (t: CtPriceTable) => void;
  onDeleted: (id: string) => void;
}) {
  const [name, setName] = useState(table?.name ?? "Bảng giá mới");
  const [cfg, setCfg] = useState<CtPriceTableConfig>(() => (table ? normalizePriceTableConfig(table.config) : defaultPriceTableConfig()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problems = useMemo(() => priceTableProblems(normalizePriceTableConfig(cfg)), [cfg]);

  const patch = (p: Partial<CtPriceTableConfig>) => setCfg((c) => ({ ...c, ...p }));
  const setSize = (id: string, p: Partial<CtPriceSize>) => patch({ sizes: cfg.sizes.map((s) => (s.id === id ? { ...s, ...p } : s)) });
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
      const body = { name: clean, config: normalizePriceTableConfig(cfg) };
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

  const sizes = usesSizes(cfg) ? cfg.sizes : cfg.sizes.slice(0, 1);
  const packs = usesPacks(cfg) ? cfg.packs : cfg.packs.slice(0, 1);

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
          {/* Sizes */}
          <section className="space-y-2 rounded-lg border p-3">
            <CtField label="Tên option size (Shopify)">
              <CtInput value={cfg.sizeLabel} onChange={(e) => patch({ sizeLabel: e.target.value })} placeholder="Size" />
            </CtField>
            <div className="grid grid-cols-[1fr_92px_92px_28px] gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              <span>Size</span>
              <span>Giá 1 cái</span>
              <span>Giá gạch</span>
              <span />
            </div>
            {cfg.sizes.map((s) => (
              <div key={s.id} className="grid grid-cols-[1fr_92px_92px_28px] items-center gap-1.5">
                <CtInput className="h-8" value={s.label} placeholder="3.5 inches" onChange={(e) => setSize(s.id, { label: e.target.value })} />
                <CtNumber className="h-8" value={s.price} step={0.01} min={0} onChange={(v) => setSize(s.id, { price: Math.max(0, v) })} />
                <CtInput
                  className="h-8"
                  type="number"
                  step={0.01}
                  min={0}
                  placeholder="—"
                  value={s.compareAt ?? ""}
                  onChange={(e) => setSize(s.id, { compareAt: e.target.value === "" ? null : Math.max(0, Number(e.target.value)) })}
                />
                <CtButton size="icon" variant="ghost" aria-label="Xoá size" disabled={cfg.sizes.length <= 1} onClick={() => patch({ sizes: cfg.sizes.filter((x) => x.id !== s.id) })}>
                  <Trash2 className="h-3.5 w-3.5" />
                </CtButton>
              </div>
            ))}
            <CtButton
              size="sm"
              variant="subtle"
              onClick={() => {
                const last = cfg.sizes[cfg.sizes.length - 1];
                patch({ sizes: [...cfg.sizes, { id: newId(), label: "", price: last?.price ?? 0, compareAt: last?.compareAt ?? null }] });
              }}
            >
              <Plus className="h-3.5 w-3.5" /> Thêm size
            </CtButton>
            <p className="text-[11px] text-muted-foreground">Chỉ 1 size để trống tên = sản phẩm không có option size.</p>
          </section>

          {/* Packs */}
          <section className="space-y-2 rounded-lg border p-3">
            <CtField label="Tên option pack (Shopify)">
              <CtInput value={cfg.packLabel} onChange={(e) => patch({ packLabel: e.target.value })} placeholder="Buy More Save More (Different Designs)" />
            </CtField>
            <div className="grid grid-cols-[64px_1fr_80px_28px] gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
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
            <p className="text-[11px] text-muted-foreground">Pack N cái = N thiết kế độc lập trên store (Different Designs). Chỉ 1 pack 1 cái = không có option pack.</p>
          </section>
        </div>

        {/* Grid */}
        <section className="space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Giá từng variant (tổng của pack) · {sizes.length * packs.length} variant
          </div>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-xs">
              <thead className="bg-muted/40">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium">{usesSizes(cfg) ? cfg.sizeLabel : ""}</th>
                  {packs.map((p) => (
                    <th key={p.id} className="px-2 py-1.5 text-left font-medium">
                      {usesPacks(cfg) ? p.label : "Giá"}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sizes.map((s) => (
                  <tr key={s.id} className="border-t align-top">
                    <td className="whitespace-nowrap px-2 py-1.5 font-medium">{usesSizes(cfg) ? s.label || "(chưa đặt tên)" : "1 giá"}</td>
                    {packs.map((p) => {
                      const c = priceCell(cfg, s, p);
                      const key = cellKey(s, p);
                      return (
                        <td key={p.id} className={cx("min-w-[118px] px-2 py-1.5", c.overridden && "bg-amber-500/10")}>
                          <div className="flex items-center gap-1">
                            <CtNumber className="h-7 w-[84px] text-xs" value={c.price} step={0.01} min={0} onChange={(v) => setCell(key, { price: round2(Math.max(0, v)) })} />
                            {c.overridden && (
                              <button className="rounded p-0.5 text-muted-foreground hover:bg-accent" title="Về giá tự tính" onClick={() => setCell(key, null)}>
                                <RotateCcw className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                          <div className="mt-0.5 text-[11px] text-muted-foreground">
                            {formatUsd(c.unit)}/pc{c.compareAt !== null && <s className="ml-1">{formatUsd(c.compareAt)}</s>}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-muted-foreground">Ô vàng = giá gõ tay (không theo % giảm). Giá gạch = giá gạch 1 cái × số cái, hoặc giá chưa giảm khi pack có giảm %.</p>
        </section>

        {problems.length > 0 && <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">{problems.join(" ")}</div>}
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
