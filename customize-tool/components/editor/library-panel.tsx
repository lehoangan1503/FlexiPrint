"use client";

/**
 * "Thư viện" tab of the asset sidebar: browse the global clipart library
 * (migration 006) and drag cliparts into this product. Making and fixing
 * cliparts happens on /library ("Quản lý") — the editor only uses them.
 *
 * Every picture is a clipart: a card shows a gốc, its two buttons open its
 * đa sắc and vật liệu versions. Whichever picture is dragged is used exactly
 * as it is: dropped on the Version column it is a version, on the canvas a
 * layer (on a custom layer: another option group of it).
 *
 * Nothing is copied: the product references the library clipart, so a fix
 * made in the library shows up here too (after the next Publish on the
 * storefront).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CheckSquare, ExternalLink, GripVertical, Layers, Library, Loader2, Palette, Square, X } from "lucide-react";
import type { CtAsset, CtClipartCategory } from "../../types";
import { ctApi } from "../../lib/api-client";
import { clipartBadges, clipartFamily, flattenCategories, isMaterialClipart, isMulticolorClipart, libraryOrigins, renditionsOf, setMembers } from "../../lib/library";
import { CHECKER_STYLE, CtSelect, CtTooltip, cx } from "../ui";

/** dataTransfer type of a library clipart dragged onto the canvas / the Version column (payload: CtClipartDrag JSON). */
export const CLIPART_DRAG = "application/x-flexiprint-clipart";

export interface CtClipartDrag {
  /** The picture dragged — the product uses exactly this one. */
  asset: CtAsset;
  /**
   * It + what comes along: its vật liệu versions (the "rendition" display draws them) and, for a gốc, its đa sắc
   * (options of the layer's group, hidden until switched on in the inspector).
   */
  family: CtAsset[];
  /**
   * Several pictures picked together (click / Shift+click / "Chọn hết") and dragged as one: they become ONE
   * custom layer whose options are these pictures, the first shown by default. Absent = just `asset`.
   */
  set?: Array<{ asset: CtAsset; family: CtAsset[] }>;
}

/** What a dragged picture brings along (see CtClipartDrag.family). */
export function dragFamily(list: CtAsset[], a: CtAsset): CtAsset[] {
  const members = a.parent_id === null && a.role === "sub" ? setMembers(list, a.id).filter((m) => m.role === "variant") : [];
  return [a, ...renditionsOf(list, a.id), ...members, ...members.flatMap((m) => renditionsOf(list, m.id))];
}

export interface LibraryPanelProps {
  /** Ids of assets this product already renders (marks "đang dùng"). */
  usedIds: Set<string>;
  /** Changing it reloads the list. */
  version?: number;
}

const ALL = "__all";
const NONE = "none";

export function LibraryPanel(props: LibraryPanelProps) {
  const [categories, setCategories] = useState<CtClipartCategory[]>([]);
  const [uncategorized, setUncategorized] = useState(0);
  const [category, setCategory] = useState<string>(ALL);
  const [cliparts, setCliparts] = useState<CtAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Pictures picked to drag as one set (ids, any order — the set follows the list order). */
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);

  useEffect(() => {
    ctApi
      .listCategories()
      .then((r) => {
        setCategories(r.categories);
        setUncategorized(r.uncategorized);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    ctApi
      .listCliparts(category === ALL ? null : category)
      .then(setCliparts)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [category]);

  useEffect(() => {
    load();
  }, [load, props.version]);

  // Back from the library tab: show what it just made.
  useEffect(() => {
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  const options = useMemo(
    () => [
      { value: ALL, label: "Tất cả danh mục" },
      ...flattenCategories(categories).map(({ category: c, depth }) => ({ value: c.id, label: `${"— ".repeat(depth)}${c.name} (${c.count ?? 0})` })),
      ...(uncategorized ? [{ value: NONE, label: `Chưa phân loại (${uncategorized})` }] : []),
    ],
    [categories, uncategorized],
  );
  const origins = libraryOrigins(cliparts);
  /** Every picture in list order: each gốc, then its đa sắc and vật liệu. */
  const order = useMemo(() => {
    const out: CtAsset[] = [];
    for (const o of libraryOrigins(cliparts)) out.push(o, ...clipartFamily(cliparts, o).filter((a) => a.id !== o.id && (isMulticolorClipart(a) || isMaterialClipart(a))));
    return out;
  }, [cliparts]);
  // A new category / list: the picked set starts over.
  useEffect(() => {
    setSelected([]);
    setAnchor(null);
  }, [category]);

  const sel: Selecting = {
    selected,
    /** Click = pick / unpick; Shift+click = everything between the last click and this one (origins in view). */
    toggle: (a, shift) => {
      if (shift && anchor) {
        const ids = origins.map((o) => o.id);
        const i = ids.indexOf(anchor);
        const j = ids.indexOf(a.id);
        if (i >= 0 && j >= 0) {
          const range = ids.slice(Math.min(i, j), Math.max(i, j) + 1);
          setSelected((cur) => [...new Set([...cur, ...range])]);
          setAnchor(a.id);
          return;
        }
      }
      setSelected((cur) => (cur.includes(a.id) ? cur.filter((x) => x !== a.id) : [...cur, a.id]));
      setAnchor(a.id);
    },
    /** The drag payload: the set when the dragged picture is part of a set of 2+, else just it. */
    payload: (a) => {
      const base: CtClipartDrag = { asset: a, family: dragFamily(cliparts, a) };
      if (selected.length < 2 || !selected.includes(a.id)) return base;
      const set = order.filter((x) => selected.includes(x.id)).map((x) => ({ asset: x, family: dragFamily(cliparts, x) }));
      return { asset: set[0].asset, family: set[0].family, set };
    },
  };

  return (
    <div className="flex h-full flex-col text-sm">
      <div className="flex items-center gap-1.5 border-b p-2">
        <div className="min-w-0 flex-1">
          <CtSelect<string> value={category} onChange={setCategory} options={options} />
        </div>
        <CtTooltip label="Tạo, sửa clipart · danh mục · preset — trang Thư viện">
          <Link href="/library" target="_blank" className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border px-2 text-xs hover:bg-accent">
            <Library className="h-3.5 w-3.5" /> Quản lý
          </Link>
        </CtTooltip>
      </div>
      {error && <p className="border-b px-2 py-1.5 text-[11px] text-destructive">{error}</p>}
      <div className="flex items-center gap-1.5 border-b px-2 py-1 text-[11px]">
        {selected.length ? (
          <>
            <span className="font-medium text-sky-600">Đã chọn {selected.length}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">— kéo 1 ảnh đã chọn lên canvas = 1 custom layer, các ảnh là option</span>
            <button className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 hover:bg-accent" onClick={() => setSelected([])}>
              <X className="h-3 w-3" /> Bỏ chọn
            </button>
          </>
        ) : (
          <span className="flex-1 text-muted-foreground">Click để chọn nhiều · Shift+click chọn dải</span>
        )}
        <button
          className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 hover:bg-accent"
          onClick={() => setSelected(origins.map((o) => o.id))}
          disabled={!origins.length}
          title="Chọn hết clipart gốc đang hiện"
        >
          <CheckSquare className="h-3 w-3" /> Chọn hết
        </button>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto p-2">
        {loading && origins.length === 0 ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : origins.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">Chưa có clipart. Tạo hoặc upload ở trang Thư viện (nút Quản lý).</p>
        ) : (
          origins.map((o) => <OriginCard key={o.id} origin={o} family={clipartFamily(cliparts, o)} usedIds={props.usedIds} sel={sel} />)
        )}
      </div>
    </div>
  );
}

type Shelf = "multicolor" | "material";

/** Picking several pictures to drag as one custom layer. */
interface Selecting {
  selected: string[];
  toggle: (a: CtAsset, shift: boolean) => void;
  payload: (a: CtAsset) => CtClipartDrag;
}

function OriginCard({ origin, family, usedIds, sel }: { origin: CtAsset; family: CtAsset[]; usedIds: Set<string>; sel: Selecting }) {
  const [open, setOpen] = useState<Shelf | null>(null);
  const multicolor = family.filter(isMulticolorClipart);
  const material = family.filter(isMaterialClipart);
  const shown = open === "multicolor" ? multicolor : open === "material" ? material : [];
  const used = family.some((a) => usedIds.has(a.id));
  return (
    <div className={cx("rounded-lg border transition-colors", used && "border-emerald-500/60")}>
      <div className="flex items-center gap-2 p-2">
        <DragThumb asset={origin} sel={sel} used={usedIds.has(origin.id)} className="w-20" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-xs font-medium" title={origin.spec || origin.name}>
            {origin.name || "(không tên)"}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {origin.width}×{origin.height}
            {used && <span className="ml-1 text-emerald-600">· đang dùng</span>}
          </span>
          <span className="text-[10px] leading-snug text-muted-foreground">Kéo ảnh nào thì dùng đúng ảnh đó: thả vào cột Version = version, thả lên canvas = layer.</span>
        </div>
      </div>
      <div className="flex border-t text-[11px]">
        {(
          [
            ["multicolor", "Đa sắc", multicolor.length, Palette],
            ["material", "Vật liệu", material.length, Layers],
          ] as const
        ).map(([k, label, count, Icon], i) => (
          <button
            key={k}
            type="button"
            disabled={count === 0}
            onClick={() => setOpen((cur) => (cur === k ? null : k))}
            className={cx(
              "flex flex-1 items-center justify-center gap-1 py-1.5 hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent",
              i > 0 && "border-l",
              open === k && "bg-accent font-medium",
            )}
          >
            <Icon className="h-3 w-3" /> {label} ({count})
          </button>
        ))}
      </div>
      {shown.length > 0 && (
        <div className="grid grid-cols-3 gap-1.5 border-t p-2">
          {shown.map((a) => (
            <DragThumb key={a.id} asset={a} sel={sel} used={usedIds.has(a.id)} withName />
          ))}
        </div>
      )}
    </div>
  );
}

/** One picture of the library: click picks it (Shift = a range), drag takes it — or the whole picked set. */
function DragThumb({ asset, sel, used, withName, className }: { asset: CtAsset; sel: Selecting; used: boolean; withName?: boolean; className?: string }) {
  const picked = sel.selected.includes(asset.id);
  return (
    <div
      draggable
      onDragStart={(e) => {
        const payload = sel.payload(asset);
        e.dataTransfer.setData(CLIPART_DRAG, JSON.stringify(payload));
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={(e) => sel.toggle(asset, e.shiftKey)}
      title={`${asset.name || "(không tên)"} — click để chọn (Shift: chọn dải), kéo vào cột Version hoặc lên canvas`}
      className={cx("shrink-0 cursor-grab select-none active:cursor-grabbing", className)}
    >
      <div className={cx("relative aspect-square overflow-hidden rounded border hover:border-sky-500", used && "border-emerald-500", picked && "border-sky-500 ring-2 ring-sky-500")} style={CHECKER_STYLE}>
        <img src={asset.url} alt={asset.name} className="pointer-events-none h-full w-full object-contain" loading="lazy" draggable={false} />
        <ClipartBadges asset={asset} className="absolute inset-x-0.5 bottom-0.5" />
        {picked ? (
          <span className="pointer-events-none absolute left-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-sky-500 px-1 text-[9px] font-bold text-white">✓</span>
        ) : (
          <Square className="pointer-events-none absolute left-0.5 top-0.5 h-3 w-3 text-white/80 drop-shadow" />
        )}
        <GripVertical className="pointer-events-none absolute right-0.5 top-0.5 h-3 w-3 text-white drop-shadow" />
      </div>
      {withName && <div className="mt-0.5 truncate text-[10px]">{asset.name}</div>}
    </div>
  );
}

/** "gốc" / "đa sắc" / "vật liệu" — a đa sắc made from a vật liệu version carries both of its badges. */
export function ClipartBadges({ asset, className, origin = false }: { asset: Pick<CtAsset, "role" | "parent_id" | "meta">; className?: string; origin?: boolean }) {
  const b = clipartBadges(asset);
  if (!b.multicolor && !b.material && !(origin && b.origin)) return null;
  return (
    <span className={cx("pointer-events-none flex flex-wrap gap-0.5", className)}>
      {origin && b.origin && <span className="rounded bg-slate-700/90 px-1 text-[9px] leading-4 text-white">gốc</span>}
      {b.multicolor && <span className="rounded bg-pink-600/90 px-1 text-[9px] leading-4 text-white">đa sắc</span>}
      {b.material && <span className="rounded bg-violet-600/90 px-1 text-[9px] leading-4 text-white">vật liệu</span>}
    </span>
  );
}

/** Small link-out used by the product asset cards. */
export function LibraryBadge() {
  return (
    <span className="absolute right-0.5 top-0.5 flex items-center gap-0.5 rounded bg-emerald-600/90 px-1 text-[10px] text-white">
      <ExternalLink className="h-2.5 w-2.5" /> thư viện
    </span>
  );
}
