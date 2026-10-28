"use client";

/**
 * "Thư viện" tab of the asset sidebar (rebuilt 2026-10-29: everything starts from a bộ nhân vật v2).
 *
 *   Bộ nhân vật  every finished v2 set (one with a product). A set is dragged WHOLE: dropped on the canvas its layers
 *                land on the shown version as one "bộ" layer (lib/char-set-layers.ts), pixel for pixel — a set's
 *                clipart fit only that set, so they are never dragged one by one. Dropped on the Version column it
 *                is a new version (a copy of the shown one) with that set.
 *   Artwork      finished designs saved from products (one per version), dragged as one picture.
 *
 * Sets and their clipart are made / fixed in /v2 and on /library — nothing is uploaded here.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ExternalLink, GripVertical, Layers, Library, Loader2, Palette } from "lucide-react";
import type { CtAsset, CtCharProject, CtClipartCategory, CtLibraryShelf } from "../../types";
import { charApi, ctApi } from "../../lib/api-client";
import { clipartBadges, clipartFamily, flattenCategories, isArtworkClipart, isMaterialClipart, isMulticolorClipart, libraryOrigins, renditionsOf, setMembers } from "../../lib/library";
import { CHECKER_STYLE, CtSelect, CtTooltip, cx } from "../ui";

/** dataTransfer type of a library drag onto the canvas / the Version column (payload: CtLibraryDrag JSON). */
export const CLIPART_DRAG = "application/x-flexiprint-clipart";

export interface CtClipartDrag {
  /** The picture dragged — the product uses exactly this one. */
  asset: CtAsset;
  /** It + what comes along: its vật liệu versions (the "rendition" display draws them) and, for a gốc, its đa sắc. */
  family: CtAsset[];
}

/** A whole bộ nhân vật v2: its product's layers are what lands. */
export interface CtCharSetDrag {
  charSet: { projectId: string; productId: string; name: string };
}

export type CtLibraryDrag = CtClipartDrag | CtCharSetDrag;

export const isCharSetDrag = (d: CtLibraryDrag): d is CtCharSetDrag => "charSet" in d;

/** What a dragged picture brings along (see CtClipartDrag.family). */
function dragFamily(list: CtAsset[], a: CtAsset): CtAsset[] {
  const members = a.parent_id === null && a.role === "sub" ? setMembers(list, a.id).filter((m) => m.role === "variant") : [];
  return [a, ...renditionsOf(list, a.id), ...members, ...members.flatMap((m) => renditionsOf(list, m.id))];
}

export interface LibraryPanelProps {
  /** Ids of assets this product already renders (marks "đang dùng"). */
  usedIds: Set<string>;
  /** Bộ nhân vật already on this product (CtRegionConfig.charSet). */
  usedSets: Set<string>;
  /** Changing it reloads the list. */
  version?: number;
}

export function LibraryPanel(props: LibraryPanelProps) {
  const [shelf, setShelf] = useState<CtLibraryShelf>("clipart");
  return (
    <div className="flex h-full flex-col text-sm">
      <div className="flex items-center gap-1.5 border-b px-2 py-1.5">
        <div className="flex flex-1 rounded-md border p-0.5 text-[11px]">
          {(
            [
              ["clipart", "Bộ nhân vật"],
              ["artwork", "Artwork"],
            ] as Array<[CtLibraryShelf, string]>
          ).map(([k, label]) => (
            <button key={k} onClick={() => setShelf(k)} className={cx("flex-1 rounded px-2 py-0.5 font-medium", shelf === k ? "bg-foreground text-background" : "hover:bg-accent")}>
              {label}
            </button>
          ))}
        </div>
        <CtTooltip label="Xem, sửa clipart từng bộ — trang Thư viện">
          <Link href="/library" target="_blank" className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-[11px] hover:bg-accent">
            <Library className="h-3.5 w-3.5" /> Quản lý
          </Link>
        </CtTooltip>
      </div>
      {shelf === "clipart" ? <CharSetShelf {...props} /> : <ArtworkShelf {...props} />}
    </div>
  );
}

/** Finished bộ nhân vật v2 — the ones with a product (its layers are what a drop copies). */
export function finishedSets(projects: CtCharProject[]): CtCharProject[] {
  return projects.filter((p) => p.product_ids.length > 0).sort((a, b) => a.name.localeCompare(b.name, "vi"));
}

function CharSetShelf(props: LibraryPanelProps) {
  const [sets, setSets] = useState<CtCharProject[] | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const load = useCallback(() => {
    charApi
      .list()
      .then((r) => {
        setSets(finishedSets(r.projects));
        setThumbs(r.thumbs);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    load();
  }, [load, props.version]);
  // Back from /v2 or /library: show what changed there.
  useEffect(() => {
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);
  const shown = (sets ?? []).filter((p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <div className="border-b p-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Tìm bộ…"
          className="h-7 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-sky-500/60"
        />
        <p className="mt-1.5 text-[10px] leading-snug text-muted-foreground">
          Kéo cả bộ lên canvas = layer bộ nhân vật của version đang mở (clipart giữ đúng pixel). Thả vào cột Version = thêm 1 version với bộ đó.
        </p>
      </div>
      {error && <p className="border-b px-2 py-1.5 text-[11px] text-destructive">{error}</p>}
      <div className="flex-1 space-y-2 overflow-y-auto p-2">
        {sets === null ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : shown.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">Chưa có bộ nhân vật hoàn chỉnh — làm bộ ở trang v2 (bộ có sản phẩm mới hiện ở đây).</p>
        ) : (
          shown.map((p) => <CharSetCard key={p.id} project={p} thumb={thumbs[p.id] ?? ""} used={props.usedSets.has(p.id)} />)
        )}
      </div>
    </>
  );
}

function CharSetCard({ project, thumb, used }: { project: CtCharProject; thumb: string; used: boolean }) {
  const slots = project.layers?.slots ?? [];
  const files = slots.reduce((n, s) => n + s.files.length, 0);
  const payload: CtCharSetDrag = { charSet: { projectId: project.id, productId: project.product_ids[0], name: project.name } };
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(CLIPART_DRAG, JSON.stringify(payload));
        e.dataTransfer.effectAllowed = "copy";
      }}
      title={`${project.name} — kéo lên canvas hoặc vào cột Version`}
      className={cx("flex cursor-grab select-none items-center gap-2 rounded-lg border p-2 hover:border-sky-500 active:cursor-grabbing", used && "border-emerald-500/60")}
    >
      <div className="relative aspect-square w-16 shrink-0 overflow-hidden rounded border" style={CHECKER_STYLE}>
        {thumb && <img src={thumb} alt={project.name} className="pointer-events-none h-full w-full object-contain" loading="lazy" draggable={false} />}
        <GripVertical className="pointer-events-none absolute right-0.5 top-0.5 h-3 w-3 text-white drop-shadow" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="line-clamp-2 text-xs font-medium">{project.name}</span>
        <span className="text-[11px] text-muted-foreground">
          {slots.length ? `${slots.filter((s) => !s.follows).length} hạng mục · ${files} clipart` : project.brief.kind === "photo" ? "bộ ảnh khách" : "bộ nhiều dáng"}
          {used && <span className="ml-1 text-emerald-600">· đang dùng</span>}
        </span>
        <Link href={`/v2/${project.id}`} target="_blank" onClick={(e) => e.stopPropagation()} className="inline-flex w-fit items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:underline">
          <ExternalLink className="h-2.5 w-2.5" /> Mở bộ
        </Link>
      </div>
    </div>
  );
}

const ALL = "__all";

function ArtworkShelf(props: LibraryPanelProps) {
  const [categories, setCategories] = useState<CtClipartCategory[]>([]);
  const [category, setCategory] = useState<string>(ALL);
  const [cliparts, setCliparts] = useState<CtAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ctApi
      .listCategories()
      .then((r) => setCategories(r.categories))
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

  const options = useMemo(
    () => [{ value: ALL, label: "Tất cả danh mục" }, ...flattenCategories(categories).map(({ category: c, depth }) => ({ value: c.id, label: `${"— ".repeat(depth)}${c.name}` }))],
    [categories],
  );
  const origins = libraryOrigins(cliparts).filter(isArtworkClipart);
  return (
    <>
      <div className="border-b p-2">
        <CtSelect<string> value={category} onChange={setCategory} options={options} />
      </div>
      {error && <p className="border-b px-2 py-1.5 text-[11px] text-destructive">{error}</p>}
      <div className="flex-1 space-y-2 overflow-y-auto p-2">
        {loading && origins.length === 0 ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : origins.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">Chưa có artwork — Lưu thiết kế để mỗi version thành 1 artwork (danh mục mang tên sản phẩm).</p>
        ) : (
          origins.map((o) => <OriginCard key={o.id} origin={o} family={clipartFamily(cliparts, o)} list={cliparts} usedIds={props.usedIds} />)
        )}
      </div>
    </>
  );
}

type Shelf = "multicolor" | "material";

function OriginCard({ origin, family, list, usedIds }: { origin: CtAsset; family: CtAsset[]; list: CtAsset[]; usedIds: Set<string> }) {
  const [open, setOpen] = useState<Shelf | null>(null);
  const multicolor = family.filter(isMulticolorClipart);
  const material = family.filter(isMaterialClipart);
  const shown = open === "multicolor" ? multicolor : open === "material" ? material : [];
  const used = family.some((a) => usedIds.has(a.id));
  return (
    <div className={cx("rounded-lg border transition-colors", used && "border-emerald-500/60")}>
      <div className="flex items-center gap-2 p-2">
        <DragThumb asset={origin} list={list} used={usedIds.has(origin.id)} className="w-20" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-xs font-medium" title={origin.spec || origin.name}>
            {origin.name || "(không tên)"}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {origin.width}×{origin.height}
            {used && <span className="ml-1 text-emerald-600">· đang dùng</span>}
          </span>
        </div>
      </div>
      {multicolor.length + material.length > 0 && (
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
      )}
      {shown.length > 0 && (
        <div className="grid grid-cols-3 gap-1.5 border-t p-2">
          {shown.map((a) => (
            <DragThumb key={a.id} asset={a} list={list} used={usedIds.has(a.id)} withName />
          ))}
        </div>
      )}
    </div>
  );
}

/** One artwork picture: dragged as it is (canvas = a layer, Version column = a version). */
function DragThumb({ asset, list, used, withName, className }: { asset: CtAsset; list: CtAsset[]; used: boolean; withName?: boolean; className?: string }) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        const payload: CtClipartDrag = { asset, family: dragFamily(list, asset) };
        e.dataTransfer.setData(CLIPART_DRAG, JSON.stringify(payload));
        e.dataTransfer.effectAllowed = "copy";
      }}
      title={`${asset.name || "(không tên)"} — kéo vào cột Version hoặc lên canvas`}
      className={cx("shrink-0 cursor-grab select-none active:cursor-grabbing", className)}
    >
      <div className={cx("relative aspect-square overflow-hidden rounded border hover:border-sky-500", used && "border-emerald-500")} style={CHECKER_STYLE}>
        <img src={asset.url} alt={asset.name} className="pointer-events-none h-full w-full object-contain" loading="lazy" draggable={false} />
        <ClipartBadges asset={asset} className="absolute inset-x-0.5 bottom-0.5" />
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
