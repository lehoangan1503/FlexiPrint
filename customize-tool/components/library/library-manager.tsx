"use client";

/**
 * /library — what products are made from. Since 2026-10-29 everything starts from a bộ nhân vật v2, so nothing is
 * uploaded or filed by hand here:
 *
 *   Clipart   the finished bộ nhân vật, one per row: a set's clipart are shown — and fixed by hand — as the set's own
 *             step 3c view (components/char/set-files.tsx). They fit only their set, so they are never listed alone.
 *   Artwork   finished designs saved from a product: every version of a product is saved here when the design is
 *             saved (meta.artwork) — a clipart of many layers, flattened. A product's folder is the category named
 *             after it (rules.productId): renaming the product renames it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Loader2, Pencil, Trash2 } from "lucide-react";
import type { CtAsset, CtCharProject, CtClipartCategory, CtClipartUsage, CtLibraryShelf, CtPreset } from "../../types";
import { charApi, ctApi } from "../../lib/api-client";
import { categoryBody, clipartFamily, flattenCategories, isArtworkClipart, isMaterialClipart, isMulticolorClipart, libraryOrigins } from "../../lib/library";
import { CHECKER_STYLE, CtButton, CtCheckbox, CtField, CtInput, CtModal, CtSelect, CtTextarea, CtTooltipProvider, cx } from "../ui";
import { ctConfirm } from "../dialogs";
import { ClipartBadges, finishedSets } from "../editor/library-panel";
import { CharSetFiles } from "../char/set-files";
import { KhuonTab } from "../print/khuon-tab";
import { PhoiTab } from "../print/phoi-tab";

const NONE = "none";


/** The library's sections: one place for everything a product is made from (asked 2026-10-10). */
export type CtLibraryTab = CtLibraryShelf | "phoi" | "khuon";

const TABS: Array<[CtLibraryTab, string]> = [
  ["clipart", "Clipart"],
  ["artwork", "Artwork"],
  ["phoi", "Phôi"],
  ["khuon", "Khuôn in"],
];

export function LibraryManager({ initialTab = "clipart", currentUserId, admin }: { initialTab?: CtLibraryTab; currentUserId: string; admin: boolean }) {
  const [tab, setTab] = useState<CtLibraryTab>(initialTab);
  // The tab is in the address (?tab=…), so a link / a reload opens it again.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t && TABS.some(([k]) => k === t)) setTab(t as CtLibraryTab);
  }, []);
  const open = (t: CtLibraryTab) => {
    setTab(t);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", t);
    window.history.replaceState(null, "", url);
  };
  return (
    <CtTooltipProvider>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
          <Link href="/dashboard" className="rounded p-1.5 hover:bg-accent">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <h1 className="text-sm font-semibold">Thư viện</h1>
          <div className="ml-3 flex rounded-md border p-0.5">
            {TABS.map(([k, label]) => (
              <button key={k} onClick={() => open(k)} className={cx("rounded px-3 py-1 text-xs font-medium", tab === k ? "bg-foreground text-background" : "hover:bg-accent")}>
                {label}
              </button>
            ))}
          </div>
        </header>
        {tab === "khuon" ? <KhuonTab /> : tab === "phoi" ? <PhoiTab /> : tab === "clipart" ? <SetsTab currentUserId={currentUserId} admin={admin} /> : <ArtworkTab />}
      </div>
    </CtTooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Clipart = bộ nhân vật
// ---------------------------------------------------------------------------

function SetsTab({ currentUserId, admin }: { currentUserId: string; admin: boolean }) {
  const [sets, setSets] = useState<CtCharProject[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    charApi
      .list()
      .then((r) => {
        const list = finishedSets(r.projects);
        setSets(list);
        const asked = new URLSearchParams(window.location.search).get("set");
        setSelected((cur) => cur ?? (asked && list.some((p) => p.id === asked) ? asked : (list[0]?.id ?? null)));
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  const open = (id: string) => {
    setSelected(id);
    const url = new URL(window.location.href);
    url.searchParams.set("set", id);
    window.history.replaceState(null, "", url);
  };
  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-72 shrink-0 flex-col border-r">
        <div className="flex-1 overflow-y-auto p-1">
          {sets === null && !error && <Loader2 className="m-3 h-4 w-4 animate-spin" />}
          {error && <p className="p-2 text-xs text-destructive">{error}</p>}
          {sets?.length === 0 && <p className="p-3 text-xs text-muted-foreground">Chưa có bộ nhân vật hoàn chỉnh — làm bộ ở trang v2.</p>}
          {sets?.map((p) => (
            <div
              key={p.id}
              className={cx("flex cursor-pointer items-center gap-1 rounded px-2 py-1.5 text-sm", selected === p.id ? "bg-accent" : "hover:bg-accent/60")}
              onClick={() => open(p.id)}
              title={p.name}
            >
              <span className="flex-1 truncate">{p.name}</span>
              <span className="w-8 text-right text-[11px] text-muted-foreground">{p.layers?.slots.reduce((n, sl) => n + sl.files.length, 0) || ""}</span>
            </div>
          ))}
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto p-4">
        {selected ? <CharSetFiles key={selected} projectId={selected} currentUserId={currentUserId} admin={admin} /> : null}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Artwork
// ---------------------------------------------------------------------------

function ArtworkTab() {
  const [categories, setCategories] = useState<CtClipartCategory[]>([]);
  /** Material presets: they name the vật liệu versions (meta.material). */
  const [materials, setMaterials] = useState<CtPreset[]>([]);
  const [selected, setSelected] = useState<string>(NONE);
  const [cliparts, setCliparts] = useState<CtAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editCategory, setEditCategory] = useState<CtClipartCategory | null>(null);
  const [editClipart, setEditClipart] = useState<CtAsset | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadCategories = useCallback(() => {
    ctApi
      .listCategories()
      .then((r) => {
        setCategories(r.categories);
        setSelected((cur) => (cur === NONE && r.categories.length ? r.categories[0].id : cur));
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    loadCategories();
    ctApi
      .listPresets("material")
      .then((r) => setMaterials(r.presets))
      .catch(() => setMaterials([]));
  }, [loadCategories]);

  useEffect(() => {
    // Nothing picked yet (the first category comes with the list).
    if (selected === NONE) return;
    setLoading(true);
    ctApi
      .listCliparts(selected)
      .then(setCliparts)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [selected]);

  const current = categories.find((c) => c.id === selected) ?? null;
  const allOrigins = libraryOrigins(cliparts);
  const origins = allOrigins.filter(isArtworkClipart);
  /** Every picture in the order it is shown (gốc, its vật liệu, its đa sắc) — the range of a shift-click. */
  const shownOrder = useMemo(
    () =>
      libraryOrigins(cliparts)
        .filter(isArtworkClipart)
        .flatMap((o) => {
          const fam = clipartFamily(cliparts, o);
          return [o, ...fam.filter((a) => isMaterialClipart(a) && !isMulticolorClipart(a)), ...fam.filter(isMulticolorClipart)];
        }),
    [cliparts],
  );

  // Multi-select: click the box, shift-click (box or picture) for a range, or "Chọn tất cả".
  // Kept per category: another category starts with nothing picked.
  const [pickState, setPickState] = useState<{ category: string; ids: Set<string> }>({ category: selected, ids: new Set() });
  const picked = useMemo(() => (pickState.category === selected ? pickState.ids : new Set<string>()), [pickState, selected]);
  const setPicked = (next: Set<string> | ((cur: Set<string>) => Set<string>)) =>
    setPickState((st) => {
      const cur = st.category === selected ? st.ids : new Set<string>();
      return { category: selected, ids: typeof next === "function" ? next(cur) : next };
    });
  const anchor = useRef<string | null>(null);
  const togglePick = (a: CtAsset, shift: boolean) => {
    // Read now: the updater runs later, after the anchor moved to this picture.
    const last = anchor.current;
    setPicked((cur) => {
      const next = new Set(cur);
      const from = last ? shownOrder.findIndex((x) => x.id === last) : -1;
      const to = shownOrder.findIndex((x) => x.id === a.id);
      if (shift && from >= 0 && to >= 0) {
        // The range takes the anchor's state (picked → pick all of it).
        const on = cur.has(last ?? "");
        for (const x of shownOrder.slice(Math.min(from, to), Math.max(from, to) + 1)) {
          if (on) next.add(x.id);
          else next.delete(x.id);
        }
      } else if (next.has(a.id)) next.delete(a.id);
      else next.add(a.id);
      return next;
    });
    anchor.current = a.id;
  };
  const allPicked = shownOrder.length > 0 && shownOrder.every((a) => picked.has(a.id));
  /** Quick picks for clearing out a category: every vật liệu version, or every đa sắc. A second press unticks them. */
  const pickGroups = [
    { key: "material", label: "vật liệu", list: shownOrder.filter((a) => isMaterialClipart(a) && !isMulticolorClipart(a)) },
    { key: "multicolor", label: "đa sắc", list: shownOrder.filter(isMulticolorClipart) },
  ];
  const togglePickGroup = (list: CtAsset[]) => {
    const on = !list.every((a) => picked.has(a.id));
    setPicked((cur) => {
      const next = new Set(cur);
      for (const a of list) {
        if (on) next.add(a.id);
        else next.delete(a.id);
      }
      return next;
    });
  };

  /**
   * Delete pictures. A gốc takes its whole set with it, so a picked member of a picked gốc is not deleted twice.
   * Pictures used in products are listed first; confirming removes them from those products too.
   */
  const removeCliparts = async (list: CtAsset[]) => {
    const ids = new Set(list.map((a) => a.id));
    const byId = new Map(cliparts.map((a) => [a.id, a]));
    const covered = (a: CtAsset): boolean => {
      for (let p = a.parent_id; p; p = byId.get(p)?.parent_id ?? null) if (ids.has(p)) return true;
      return false;
    };
    const targets = list.filter((a) => !covered(a));
    if (!targets.length) return;
    setBusy("Đang kiểm tra sản phẩm đang dùng…");
    let usage: Array<{ asset: CtAsset; products: string[] }>;
    try {
      usage = await Promise.all(targets.map(async (a) => ({ asset: a, products: (await ctApi.clipartUsage(a.id).catch(() => [])).map((u) => u.productName) })));
    } finally {
      setBusy(null);
    }
    const used = usage.filter((u) => u.products.length);
    const sets = targets.filter((a) => a.parent_id === null).length;
    const what =
      targets.length === 1
        ? `“${targets[0].name}”${targets[0].parent_id === null ? " và toàn bộ đa sắc / vật liệu của nó" : ""}`
        : `${targets.length} ảnh${sets ? ` (${sets} clipart gốc — kèm toàn bộ đa sắc / vật liệu của chúng)` : ""}`;
    const ok = await ctConfirm(
      used.length
        ? {
            title: "Có ảnh đang được dùng trong sản phẩm",
            message: `${used.map((u) => `• ${u.asset.name}: ${u.products.join(", ")}`).join("\n")}\n\nXoá ${what} sẽ gỡ luôn các ảnh này khỏi những sản phẩm trên (layer, version, option). Sản phẩm đã publish cần publish lại.`,
            tone: "danger",
            confirmLabel: "Xoá & gỡ khỏi sản phẩm",
          }
        : { title: `Xoá ${what} khỏi thư viện?`, tone: "danger", confirmLabel: "Xoá" },
    );
    if (!ok) return;
    const done: string[] = [];
    const failed: string[] = [];
    for (const [i, u] of usage.entries()) {
      setBusy(`Đang xoá ${i + 1}/${usage.length}…`);
      try {
        await ctApi.deleteClipart(u.asset.id, u.products.length > 0);
        done.push(u.asset.id);
      } catch (e) {
        failed.push(`${u.asset.name}: ${e instanceof Error ? e.message : "lỗi"}`);
      }
    }
    setBusy(null);
    const gone = new Set(done);
    setCliparts((cur) => {
      const map = new Map(cur.map((a) => [a.id, a]));
      const dead = (a: CtAsset): boolean => {
        for (let x: CtAsset | undefined = a; x; x = x.parent_id ? map.get(x.parent_id) : undefined) if (gone.has(x.id)) return true;
        return false;
      };
      return cur.filter((a) => !dead(a));
    });
    setPicked((cur) => new Set([...cur].filter((id) => !gone.has(id) && cliparts.some((a) => a.id === id))));
    if (failed.length) setError(`Không xoá được: ${failed.join("; ")}`);
    loadCategories();
  };

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-72 shrink-0 flex-col border-r">
        <div className="flex-1 overflow-y-auto p-1">
          {flattenCategories(categories).map(({ category: c, depth }) => (
            <div
              key={c.id}
              className={cx("group flex cursor-pointer items-center gap-1 rounded px-2 py-1.5 text-sm", selected === c.id ? "bg-accent" : "hover:bg-accent/60")}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => setSelected(c.id)}
            >
              <span className="flex-1 truncate">{c.name}</span>
              <span className="w-6 text-right text-[11px] text-muted-foreground">{c.count ?? 0}</span>
              {c.can_edit && (
                <button
                  className="rounded p-0.5 opacity-0 hover:bg-background group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditCategory(c);
                  }}
                >
                  <Pencil className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto p-4">
        <div className="mb-4 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">{current?.name ?? ""}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">Artwork = thiết kế hoàn chỉnh lưu từ sản phẩm (mỗi version 1 artwork, tự cập nhật khi Lưu thiết kế).</p>
          </div>
          <div className="flex shrink-0 gap-2">
            {current?.can_edit && (
              <CtButton size="sm" onClick={() => setEditCategory(current)}>
                <Pencil className="h-3.5 w-3.5" /> Đổi tên
              </CtButton>
            )}
          </div>
        </div>
        {busy && (
          <p className="mb-2 flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> {busy}
          </p>
        )}
        {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : origins.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Chưa có artwork — mở sản phẩm, chọn option rồi Lưu thiết kế: mỗi version thành 1 artwork ở danh mục mang tên sản phẩm.</p>
        ) : (
          <div className="space-y-3">
            <div className="sticky top-0 z-10 -mx-1 flex items-center gap-2 rounded-md border bg-background/95 px-2 py-1.5 text-xs backdrop-blur">
              <CtCheckbox checked={allPicked} onChange={(on) => setPicked(on ? new Set(shownOrder.map((a) => a.id)) : new Set())} label="Chọn tất cả" />
              {pickGroups.map((g) =>
                g.list.length > 0 ? (
                  <CtCheckbox key={g.key} checked={g.list.every((a) => picked.has(a.id))} onChange={() => togglePickGroup(g.list)} label={`Tất cả ${g.label} (${g.list.length})`} />
                ) : null,
              )}
              <span className="text-muted-foreground">
                {picked.size ? `Đã chọn ${picked.size}/${shownOrder.length} ảnh` : "Tick ô ở góc ảnh để chọn — giữ Shift để chọn cả dải"}
              </span>
              {picked.size > 0 && (
                <span className="ml-auto flex gap-1.5">
                  <CtButton size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
                    Bỏ chọn
                  </CtButton>
                  <CtButton size="sm" className="text-destructive" onClick={() => void removeCliparts(shownOrder.filter((a) => picked.has(a.id)))} disabled={busy !== null}>
                    <Trash2 className="h-3.5 w-3.5" /> Xoá {picked.size} ảnh
                  </CtButton>
                </span>
              )}
            </div>
            {origins.map((o) => (
              <SetCard
                key={o.id}
                origin={o}
                family={clipartFamily(cliparts, o)}
                materials={materials}
                onOpen={setEditClipart}
                picked={picked}
                onPick={togglePick}
              />
            ))}
          </div>
        )}
      </main>

      {editCategory && (
        <CategoryDialog
          category={editCategory}
          onClose={() => setEditCategory(null)}
          onSaved={(c) => {
            loadCategories();
            setSelected(c.id);
          }}
          onDeleted={() => {
            loadCategories();
            setSelected(NONE);
          }}
        />
      )}
      {editClipart && (
        <ClipartDialog
          asset={editClipart}
          categories={categories}
          onClose={() => setEditClipart(null)}
          onSaved={(a) => {
            setCliparts((list) => (a.category_id === editClipart.category_id ? list.map((x) => (x.id === a.id ? a : x)) : list.filter((x) => x.id !== a.id && x.parent_id !== a.id)));
            if (a.category_id !== editClipart.category_id) loadCategories();
          }}
          onDeleted={(id) => {
            setCliparts((list) => list.filter((x) => x.id !== id && x.parent_id !== id));
            loadCategories();
          }}
        />
      )}
    </div>
  );
}

/**
 * One set of the category: its gốc, then its vật liệu versions and its đa sắc (of the gốc or of a vật liệu
 * version — those carry both badges). A click opens a picture's details; the gốc's own buttons upload more.
 */
interface TileActions {
  onOpen: (a: CtAsset) => void;
  picked: Set<string>;
  /** shift = extend the range from the last picked one. */
  onPick: (a: CtAsset, shift: boolean) => void;
}

function SetCard(props: TileActions & { origin: CtAsset; family: CtAsset[]; materials: CtPreset[] }) {
  const { origin, family } = props;
  const material = family.filter((a) => isMaterialClipart(a) && !isMulticolorClipart(a));
  const multicolor = family.filter(isMulticolorClipart);
  const materialName = (a: CtAsset) => {
    const name = props.materials.find((m) => m.id === a.meta.material)?.name ?? null;
    const version = a.meta.materialVersion ?? "";
    return name && version ? `${name} · ${version}` : (name ?? (version || null));
  };
  return (
    <div className="rounded-lg border p-2">
      <div className="mb-2 flex items-center gap-2">
        <span className="truncate text-sm font-medium">{origin.name || "(không tên)"}</span>
        <span className="text-[11px] text-muted-foreground">
          {origin.width}×{origin.height} · {origin.source} · {material.length} vật liệu · {multicolor.length} đa sắc
        </span>
      </div>
      {origin.spec && <p className="mb-2 line-clamp-2 text-[11px] text-muted-foreground">{origin.spec}</p>}
      <div className="flex flex-wrap items-start gap-3">
        <Tile asset={origin} big caption="Gốc" {...props} />
        {material.length > 0 && <TileGroup label="Vật liệu" list={material} sub={materialName} {...props} />}
        {multicolor.length > 0 && <TileGroup label="Đa sắc" list={multicolor} sub={(a) => (isMaterialClipart(a) ? materialName(a) : null)} {...props} />}
      </div>
    </div>
  );
}

function TileGroup(props: TileActions & { label: string; list: CtAsset[]; sub: (a: CtAsset) => string | null }) {
  return (
    <div className="space-y-1 border-l pl-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {props.label} ({props.list.length})
      </div>
      <div className="flex flex-wrap gap-2">
        {props.list.map((a) => (
          <Tile key={a.id} {...props} asset={a} caption={props.sub(a) ?? a.name} />
        ))}
      </div>
    </div>
  );
}

function Tile(props: TileActions & { asset: CtAsset; big?: boolean; caption: string }) {
  const { asset, big, caption } = props;
  const on = props.picked.has(asset.id);
  const selecting = props.picked.size > 0;
  return (
    <div className={cx("group shrink-0 space-y-1", big ? "w-28" : "w-24")}>
      <div className="relative">
        <button
          className={cx("relative block aspect-square w-full overflow-hidden rounded border hover:ring-2 hover:ring-sky-500", on && "ring-2 ring-sky-500")}
          style={CHECKER_STYLE}
          onClick={(e) => (e.shiftKey || selecting ? props.onPick(asset, e.shiftKey) : props.onOpen(asset))}
          title={selecting ? "Chọn / bỏ chọn (Shift: cả dải)" : `${asset.name} — chi tiết (Shift+click: chọn)`}
        >
          <img src={asset.url} alt={asset.name} className={cx("h-full w-full object-contain", selecting && !on && "opacity-60")} loading="lazy" />
          {asset.source === "ai" && <span className="absolute left-0.5 top-0.5 rounded bg-sky-600/90 px-1 text-[10px] text-white">AI</span>}
          <ClipartBadges asset={asset} origin className="absolute inset-x-0.5 bottom-0.5" />
        </button>
        <button
          className={cx(
            "absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded border transition-opacity",
            on ? "border-sky-500 bg-sky-500 text-white" : "border-white/80 bg-black/40",
            !on && !selecting && "opacity-0 group-hover:opacity-100",
          )}
          onClick={(e) => props.onPick(asset, e.shiftKey)}
          aria-label={on ? "Bỏ chọn" : "Chọn"}
        >
          {on && <Check className="h-3 w-3" />}
        </button>
      </div>
      <div className="truncate text-[10px] text-muted-foreground" title={caption}>
        {caption}
      </div>
    </div>
  );
}

/** Create / rename a category: a name only (its parent, order and older spec / rules are kept as they are). */
export function CategoryDialog(props: { category: CtClipartCategory | null; onClose: () => void; onSaved: (c: CtClipartCategory) => void; onDeleted: () => void }) {
  const c = props.category;
  const [name, setName] = useState(c?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim()) return setError("Nhập tên danh mục");
    setBusy(true);
    setError(null);
    try {
      const saved = c ? await ctApi.updateCategory(c.id, categoryBody(name, c)) : await ctApi.createCategory(categoryBody(name, null));
      props.onSaved(saved);
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!c || !(await ctConfirm({ title: `Xoá danh mục “${c.name}”?`, tone: "danger", confirmLabel: "Xoá" }))) return;
    try {
      await ctApi.deleteCategory(c.id);
      props.onDeleted();
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi");
    }
  };

  return (
    <CtModal open onOpenChange={(o) => !o && props.onClose()} title={c ? `Đổi tên danh mục: ${c.name}` : "Danh mục mới"}>
      <div className="space-y-3 text-sm">
        <CtField label="Tên">
          <CtInput value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} placeholder="vd. Chibi Car" autoFocus />
        </CtField>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex items-center gap-2 border-t pt-3">
          {c?.can_edit && (
            <CtButton variant="ghost" className="text-destructive" onClick={() => void remove()}>
              <Trash2 className="h-3.5 w-3.5" /> Xoá
            </CtButton>
          )}
          <span className="flex-1" />
          <CtButton onClick={props.onClose}>Huỷ</CtButton>
          <CtButton variant="primary" onClick={() => void save()} disabled={busy || !name.trim()}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} {c ? "Lưu" : "Tạo mới"}
          </CtButton>
        </div>
      </div>
    </CtModal>
  );
}


/** A library clipart's details (name, spec, tags, category, usage, delete) — also opened from the editor's library panel. */
export function ClipartDialog(props: {
  asset: CtAsset;
  categories: CtClipartCategory[];
  onClose: () => void;
  onSaved: (a: CtAsset) => void;
  onDeleted: (id: string) => void;
}) {
  const a = props.asset;
  const [name, setName] = useState(a.name);
  const [spec, setSpec] = useState(a.spec);
  const [tags, setTags] = useState(a.tags.join(", "));
  const [license, setLicense] = useState(a.license);
  const [category, setCategory] = useState(a.category_id ?? NONE);
  const [usage, setUsage] = useState<CtClipartUsage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isOrigin = a.parent_id === null;

  useEffect(() => {
    ctApi
      .clipartUsage(a.id)
      .then(setUsage)
      .catch(() => setUsage([]));
  }, [a.id]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await ctApi.updateClipart(a.id, {
        name,
        spec,
        license,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        ...(isOrigin && category !== (a.category_id ?? NONE) ? { category_id: category === NONE ? null : category } : {}),
      });
      props.onSaved(saved);
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    // Still loading → ask the server (a used clipart answers with its products).
    const used = usage ?? (await ctApi.clipartUsage(a.id).catch(() => []));
    const what = isOrigin ? `“${a.name}” và toàn bộ đa sắc / vật liệu của nó` : `“${a.name}”`;
    const ok = await ctConfirm(
      used.length
        ? {
            title: "Clipart đang được dùng trong sản phẩm",
            message: `${what} đang được dùng trong ${used.length} sản phẩm: ${used.map((u) => u.productName).join(", ")}.\n\nXoá sẽ gỡ luôn clipart này khỏi các sản phẩm đó (layer, version, option). Sản phẩm đã publish cần publish lại.\n\nChắc chắn muốn xoá?`,
            tone: "danger",
            confirmLabel: "Xoá & gỡ khỏi sản phẩm",
          }
        : { title: `Xoá ${what} khỏi thư viện?`, tone: "danger", confirmLabel: "Xoá" },
    );
    if (!ok) return;
    setBusy(true);
    try {
      await ctApi.deleteClipart(a.id, used.length > 0);
      props.onDeleted(a.id);
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi");
    } finally {
      setBusy(false);
    }
  };

  return (
    <CtModal open onOpenChange={(o) => !o && props.onClose()} title={isOrigin ? "Clipart gốc" : isMulticolorClipart(a) ? (isMaterialClipart(a) ? "Đa sắc · vật liệu" : "Đa sắc") : "Vật liệu"} wide>
      <div className="grid grid-cols-[320px_1fr] gap-4 text-sm">
        <div className="aspect-square overflow-hidden rounded-lg border" style={CHECKER_STYLE}>
          <img src={a.url} alt={a.name} className="h-full w-full object-contain" />
        </div>
        <div className="space-y-3">
          <p className="text-[11px] text-muted-foreground">
            {a.width}×{a.height} · nguồn {a.source}
            {typeof a.meta.iou === "number" && ` · khớp silhouette ${(a.meta.iou * 100).toFixed(1)}%`}
            {a.meta.material && ` · vật liệu ${a.meta.material}`}
          </p>
          <CtField label="Tên">
            <CtInput value={name} onChange={(e) => setName(e.target.value)} />
          </CtField>
          <CtField label="Spec / prompt riêng">
            <CtTextarea rows={4} value={spec} onChange={(e) => setSpec(e.target.value)} />
          </CtField>
          <div className="grid grid-cols-2 gap-2">
            <CtField label="Tags (phẩy)">
              <CtInput value={tags} onChange={(e) => setTags(e.target.value)} />
            </CtField>
            <CtField label="License / nguồn stock">
              <CtInput value={license} onChange={(e) => setLicense(e.target.value)} />
            </CtField>
          </div>
          {isOrigin && (
            <CtField label="Danh mục" hint="Đa sắc và vật liệu đi theo clipart gốc.">
              <CtSelect<string>
                value={category}
                onChange={setCategory}
                options={[
                  { value: NONE, label: "Chưa phân loại" },
                  ...flattenCategories(props.categories).map(({ category: c, depth }) => ({ value: c.id, label: `${"— ".repeat(depth)}${c.name}` })),
                ]}
              />
            </CtField>
          )}
          <div className="text-xs">
            <span className="font-medium">Đang dùng trong: </span>
            {usage === null ? "…" : usage.length === 0 ? <span className="text-muted-foreground">chưa sản phẩm nào</span> : usage.map((u, i) => (
              <span key={u.productId}>
                {i > 0 && ", "}
                <Link className="underline" href={`/products/${u.productId}`} target="_blank">
                  {u.productName}
                </Link>
              </span>
            ))}
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex gap-2 pt-2">
            <CtButton variant="ghost" className="text-destructive" onClick={() => void remove()} disabled={busy}>
              <Trash2 className="h-3.5 w-3.5" /> Xoá
            </CtButton>
            <span className="flex-1" />
            <CtButton onClick={props.onClose}>Huỷ</CtButton>
            <CtButton variant="primary" onClick={() => void save()} disabled={busy}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Lưu
            </CtButton>
          </div>
        </div>
      </div>
    </CtModal>
  );
}
