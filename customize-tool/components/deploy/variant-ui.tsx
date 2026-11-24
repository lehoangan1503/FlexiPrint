"use client";

/**
 * Variants + prices, the shared pieces (2026-11-24, boss: "việc tạo bảng giá là riêng, việc tạo variant của sản phẩm
 * là riêng"): OptionsEditor = the rows of choices a product base sells (Material × Size), ShopifyOptionsPreview =
 * the buttons the customer will see, PriceGrid = what each variant costs from a price table.
 */

import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import type { CtBaseOption, CtPriceTableConfig } from "../../types";
import { CT_SHOPIFY_OPTIONS_MAX, combinations, formatUsd, priceCells, rowFor, shopifyOptions, usesPacks, valueKey } from "../../lib/pricing";
import { newId } from "../../lib/geometry";
import { CtButton, CtInput, cx } from "../ui";

export interface CtOptionRename {
  index: number;
  from: string;
  to: string;
}

/** One value pill: typed in place, committed on blur / Enter (a rename), × removes it, dragged to reorder. */
function ValuePill({ value, onCommit, onRemove, onDragStart, onDrop }: { value: string; onCommit: (v: string) => void; onRemove: () => void; onDragStart: () => void; onDrop: () => void }) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  if (!editing && draft !== value) setDraft(value);
  const commit = () => {
    setEditing(false);
    const v = draft.trim();
    if (!v) return setDraft(value);
    if (v !== value) onCommit(v);
  };
  return (
    <span
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      className="inline-flex h-8 cursor-grab items-center rounded-md border bg-background pl-1 text-xs pointer-coarse:h-10"
      title="Kéo để đổi thứ tự · bấm vào chữ để sửa"
    >
      <input
        className="h-full min-w-[3ch] bg-transparent px-1 outline-none"
        style={{ width: `${Math.max(3, draft.length + 1)}ch` }}
        value={draft}
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
        }}
        aria-label={`Giá trị ${value}`}
      />
      <button type="button" className="flex h-full w-7 items-center justify-center rounded-r-md text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onRemove} aria-label={`Bỏ ${value}`}>
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

/** "Thêm giá trị" box: Enter or a comma adds what was typed (several at once when pasted with commas). */
function AddValue({ onAdd }: { onAdd: (values: string[]) => void }) {
  const [text, setText] = useState("");
  const flush = (t: string) => {
    const parts = t
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    if (parts.length) onAdd(parts);
    setText("");
  };
  return (
    <CtInput
      className="h-8 w-40 text-xs"
      value={text}
      placeholder="+ giá trị, Enter"
      onChange={(e) => {
        const v = e.target.value;
        if (v.includes(",")) flush(v);
        else setText(v);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          flush(text);
        }
      }}
      onBlur={() => flush(text)}
    />
  );
}

/**
 * The product base's rows of choices. `max` = how many rows fit (3 on Shopify, 2 when the price table adds a pack
 * row). `onRename` hears a value typed over (so the price table's rows can follow). `fromTable` = the rows the price
 * table already prices, offered when the base has none yet.
 */
export function OptionsEditor({
  options,
  onChange,
  onRename,
  max = CT_SHOPIFY_OPTIONS_MAX,
  fromTable,
}: {
  options: CtBaseOption[];
  onChange: (options: CtBaseOption[]) => void;
  onRename?: (r: CtOptionRename) => void;
  max?: number;
  fromTable?: CtBaseOption[] | null;
}) {
  const [drag, setDrag] = useState<{ row: number; index: number } | null>(null);
  const setRow = (i: number, p: Partial<CtBaseOption>) => onChange(options.map((o, j) => (j === i ? { ...o, ...p } : o)));
  const move = (i: number, d: number) => {
    const next = [...options];
    const [o] = next.splice(i, 1);
    next.splice(i + d, 0, o);
    onChange(next);
  };
  const tableUsable = !!fromTable && fromTable.some((o) => o.values.length > 0);

  return (
    <div className="space-y-2">
      {options.length === 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-2.5 text-xs text-foreground/80">
          <span>Chưa có biến thể — sản phẩm bán 1 giá.</span>
          {tableUsable && (
            <CtButton size="sm" variant="outline" onClick={() => onChange(fromTable!.map((o) => ({ ...o, id: newId() })))}>
              Lấy theo bảng giá ({fromTable!.map((o) => `${o.name}: ${o.values.length}`).join(" × ")})
            </CtButton>
          )}
        </div>
      )}
      {options.map((o, i) => (
        <div key={o.id} className="rounded-md border p-2">
          <div className="flex items-center gap-1.5">
            <CtInput className="h-8 w-36 text-xs font-medium" value={o.name} placeholder="Tên hàng (vd. Size)" onChange={(e) => setRow(i, { name: e.target.value })} aria-label="Tên hàng lựa chọn" />
            <span className="text-[11px] text-muted-foreground">{o.values.length} giá trị</span>
            <div className="ml-auto flex">
              <CtButton size="icon" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Đưa hàng lên">
                <ArrowUp className="h-3.5 w-3.5" />
              </CtButton>
              <CtButton size="icon" variant="ghost" disabled={i === options.length - 1} onClick={() => move(i, 1)} aria-label="Đưa hàng xuống">
                <ArrowDown className="h-3.5 w-3.5" />
              </CtButton>
              <CtButton size="icon" variant="ghost" onClick={() => onChange(options.filter((_, j) => j !== i))} aria-label="Xoá hàng lựa chọn">
                <Trash2 className="h-3.5 w-3.5" />
              </CtButton>
            </div>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {o.values.map((v, k) => (
              <ValuePill
                key={`${k}:${v}`}
                value={v}
                onCommit={(to) => {
                  if (o.values.some((x, j) => j !== k && valueKey(x) === valueKey(to))) return;
                  setRow(i, { values: o.values.map((x, j) => (j === k ? to : x)) });
                  onRename?.({ index: i, from: v, to });
                }}
                onRemove={() => setRow(i, { values: o.values.filter((_, j) => j !== k) })}
                onDragStart={() => setDrag({ row: i, index: k })}
                onDrop={() => {
                  if (!drag || drag.row !== i || drag.index === k) return setDrag(null);
                  const values = [...o.values];
                  const [x] = values.splice(drag.index, 1);
                  values.splice(k, 0, x);
                  setRow(i, { values });
                  setDrag(null);
                }}
              />
            ))}
            <AddValue
              onAdd={(add) => {
                const have = new Set(o.values.map(valueKey));
                const fresh = add.filter((v) => !have.has(valueKey(v)) && have.add(valueKey(v)));
                if (fresh.length) setRow(i, { values: [...o.values, ...fresh] });
              }}
            />
          </div>
        </div>
      ))}
      {options.length < max && (
        <CtButton size="sm" variant="subtle" onClick={() => onChange([...options, { id: newId(), name: options.length ? "" : "Size", values: [] }])}>
          <Plus className="h-3.5 w-3.5" /> Thêm hàng lựa chọn
        </CtButton>
      )}
      {options.length >= max && max < CT_SHOPIFY_OPTIONS_MAX && <p className="text-[11px] text-muted-foreground">Đã đủ {max} hàng: hàng thứ 3 là pack của bảng giá (Shopify cho tối đa 3).</p>}
    </div>
  );
}

/** "Khách trên Shopify sẽ thấy": one row of buttons per option, the pack last, and how many variants that makes. */
export function ShopifyOptionsPreview({ cfg, options }: { cfg: CtPriceTableConfig | null; options: CtBaseOption[] }) {
  const rows = cfg ? shopifyOptions(cfg, options) : options.map((o) => ({ name: o.name, values: o.values, pack: false }));
  const count = combinations(options).length * (cfg && usesPacks(cfg) ? cfg.packs.length : 1);
  return (
    <div className="rounded-md border bg-muted/30 p-2.5">
      <div className="mb-1.5 text-[11px] font-medium text-foreground/80">
        Khách trên Shopify sẽ thấy · {count} variant
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-foreground/80">Không có nút chọn — 1 variant.</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.name}>
              <div className="text-[11px] text-foreground/80">
                {r.name || "(chưa đặt tên)"}
                {r.pack && " · pack từ bảng giá"}
              </div>
              <div className="mt-0.5 flex flex-wrap gap-1">
                {r.values.map((v, i) => (
                  <span key={v} className={cx("rounded border px-2 py-0.5 text-xs", i === 0 ? "border-foreground bg-background font-medium" : "bg-background")}>
                    {v}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Money({ price, compareAt, missing }: { price: number; compareAt: number | null; missing: boolean }) {
  if (missing) return <span className="font-medium text-destructive">chưa có giá</span>;
  return (
    <span className="whitespace-nowrap">
      <span className="font-medium">{formatUsd(price)}</span>
      {compareAt !== null && <s className="ml-1 text-muted-foreground">{formatUsd(compareAt)}</s>}
    </span>
  );
}

/**
 * The price of every variant from a table. Two options and no packs: a grid (first option down, second across);
 * otherwise one line per combination × the packs (or one price + struck price).
 */
export function PriceGrid({ cfg, options }: { cfg: CtPriceTableConfig; options: CtBaseOption[] }) {
  const packs = usesPacks(cfg);
  const head = "sticky top-0 bg-muted px-2 py-1 text-left text-xs font-medium text-foreground/80";
  if (options.length === 2 && !packs) {
    const [a, b] = options;
    return (
      <div className="max-h-80 overflow-auto rounded-md border">
        <table className="w-full text-xs">
          <thead>
            <tr>
              <th className={head}>
                {a.name} \ {b.name}
              </th>
              {b.values.map((v) => (
                <th key={v} className={head}>
                  {v}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {a.values.map((va) => (
              <tr key={va} className="border-t">
                <td className="px-2 py-1 font-medium">{va}</td>
                {b.values.map((vb) => {
                  const c = priceCells(cfg, [{ ...a, values: [va] }, { ...b, values: [vb] }])[0];
                  return (
                    <td key={vb} className="px-2 py-1">
                      <Money price={c.price} compareAt={c.compareAt} missing={c.missing} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const combos = combinations(options);
  const packList = packs ? cfg.packs : [cfg.packs[0] ?? null];
  const cells = priceCells(cfg, options);
  return (
    <div className="max-h-80 overflow-auto rounded-md border">
      <table className="w-full text-xs">
        <thead>
          <tr>
            <th className={head}>{options.map((o) => o.name).join(" · ") || "Biến thể"}</th>
            {packs ? (
              cfg.packs.map((p) => (
                <th key={p.id} className={head}>
                  {p.label}
                </th>
              ))
            ) : (
              <th className={head}>Giá · giá gạch</th>
            )}
          </tr>
        </thead>
        <tbody>
          {combos.map((values, r) => (
            <tr key={values.join("|") || "one"} className="border-t">
              <td className="px-2 py-1 font-medium">{values.join(" · ") || "1 giá"}</td>
              {packList.map((p, k) => {
                const c = cells[r * packList.length + k];
                return (
                  <td key={p?.id ?? k} className="px-2 py-1">
                    <Money price={c.price} compareAt={c.compareAt} missing={c.missing} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** How many of the options' combinations the table has no price for. */
export function missingPrices(cfg: CtPriceTableConfig, options: CtBaseOption[]): number {
  return combinations(options).filter((v) => !rowFor(cfg, v)).length;
}
