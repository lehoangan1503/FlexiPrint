"use client";

/**
 * /library — manage the global clipart library (migration 006):
 *
 *   Clipart     categories (name, parent, sort order) and the cliparts in them — every picture is a clipart:
 *               a gốc, its đa sắc (other colours / styles, of the gốc or of a vật liệu version) and its vật liệu
 *               versions. All uploaded by hand: "Upload clipart gốc" (several files = several gốc), and on each
 *               gốc "Upload đa sắc" / "Upload vật liệu".
 *   Bộ mockup   mockup templates saved from a product's Mockups tab (packs-tab.tsx).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, FolderPlus, ImagePlus, Layers, Loader2, Pencil, Trash2 } from "lucide-react";
import type { CtAsset, CtAssetMeta, CtCategoryBody, CtClipartCategory, CtClipartUsage, CtPreset } from "../../types";
import { ctApi } from "../../lib/api-client";
import { clipartFamily, defaultCategoryRules, flattenCategories, isMaterialClipart, isMulticolorClipart, libraryOrigins, materialVersions } from "../../lib/library";
import { CHECKER_STYLE, CtButton, CtCheckbox, CtField, CtInput, CtModal, CtNumber, CtSelect, CtTextarea, CtTooltipProvider, cx } from "../ui";
import { ctConfirm } from "../dialogs";
import { ClipartBadges } from "../editor/library-panel";
import { PacksTab } from "./packs-tab";

type Tab = "cliparts" | "packs";
const NONE = "none";

/** What a manual vật liệu upload is: which material preset (optional) and which version ("có dây", optional). */
interface CtUploadMaterial {
  materialId: string | null;
  version: string;
}

export function LibraryManager() {
  const [tab, setTab] = useState<Tab>("cliparts");
  return (
    <CtTooltipProvider>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
          <Link href="/dashboard" className="rounded p-1.5 hover:bg-accent">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <h1 className="text-sm font-semibold">Thư viện clipart</h1>
          <div className="ml-3 flex rounded-md border p-0.5">
            {(
              [
                ["cliparts", "Clipart"],
                ["packs", "Bộ mockup"],
              ] as Array<[Tab, string]>
            ).map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)} className={cx("rounded px-3 py-1 text-xs font-medium", tab === k ? "bg-foreground text-background" : "hover:bg-accent")}>
                {label}
              </button>
            ))}
          </div>
        </header>
        {tab === "cliparts" ? <ClipartsTab /> : <PacksTab />}
      </div>
    </CtTooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Cliparts
// ---------------------------------------------------------------------------

function ClipartsTab() {
  const [categories, setCategories] = useState<CtClipartCategory[]>([]);
  const [uncategorized, setUncategorized] = useState(0);
  /** Material presets: they name the vật liệu versions (meta.material). */
  const [materials, setMaterials] = useState<CtPreset[]>([]);
  const [selected, setSelected] = useState<string>(NONE);
  const [cliparts, setCliparts] = useState<CtAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editCategory, setEditCategory] = useState<CtClipartCategory | "new" | null>(null);
  const [editClipart, setEditClipart] = useState<CtAsset | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** "Upload vật liệu" open for this gốc. */
  const [materialFor, setMaterialFor] = useState<CtAsset | null>(null);

  const loadCategories = useCallback(() => {
    ctApi
      .listCategories()
      .then((r) => {
        setCategories(r.categories);
        setUncategorized(r.uncategorized);
        setSelected((cur) => (cur === NONE && r.categories.length && !r.uncategorized ? r.categories[0].id : cur));
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
    setLoading(true);
    ctApi
      .listCliparts(selected)
      .then(setCliparts)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [selected]);

  const current = categories.find((c) => c.id === selected) ?? null;
  const origins = libraryOrigins(cliparts);
  /** Every picture in the order it is shown (gốc, its vật liệu, its đa sắc) — the range of a shift-click. */
  const shownOrder = useMemo(
    () =>
      libraryOrigins(cliparts).flatMap((o) => {
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

  /**
   * Upload pictures one by one: with no parent each file is a new clipart gốc; with a gốc as parent each is a đa sắc
   * of it, or (`material`) a vật liệu version of it — meta.material / meta.materialVersion name it.
   */
  const upload = async (files: File[], parentId: string | null, material?: CtUploadMaterial) => {
    setError(null);
    const created: CtAsset[] = [];
    const failed: string[] = [];
    for (const [i, f] of files.entries()) {
      setBusy(`Đang upload ${i + 1}/${files.length} ảnh…`);
      try {
        const meta: CtAssetMeta = {
          ...(material?.materialId ? { material: material.materialId } : {}),
          ...(material?.version ? { materialVersion: material.version } : {}),
        };
        created.push(await ctApi.uploadClipart(f, { categoryId: current?.id ?? null, parentId, rendition: Boolean(material), meta }));
      } catch (e) {
        failed.push(`${f.name}: ${e instanceof Error ? e.message : "lỗi"}`);
      }
    }
    setBusy(null);
    setCliparts((list) => [...list, ...created]);
    if (failed.length) setError(`Không upload được: ${failed.join("; ")}`);
    if (!parentId && created.length) loadCategories();
  };

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-72 shrink-0 flex-col border-r">
        <div className="border-b p-2">
          <CtButton size="sm" className="w-full" onClick={() => setEditCategory("new")}>
            <FolderPlus className="h-3.5 w-3.5" /> Danh mục mới
          </CtButton>
        </div>
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
          <div
            className={cx("flex cursor-pointer items-center rounded px-2 py-1.5 text-sm text-muted-foreground", selected === NONE ? "bg-accent" : "hover:bg-accent/60")}
            onClick={() => setSelected(NONE)}
          >
            <span className="flex-1">Chưa phân loại</span>
            <span className="text-[11px]">{uncategorized}</span>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto p-4">
        <div className="mb-4 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">{current ? current.name : "Chưa phân loại"}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Mỗi ảnh upload là 1 clipart gốc (chọn được nhiều ảnh cùng lúc). Trên từng gốc: “Upload đa sắc” (màu / kiểu khác) và “Upload vật liệu” (bản vật liệu
              cho mockup và storefront).
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            {current?.can_edit && (
              <CtButton size="sm" onClick={() => setEditCategory(current)}>
                <Pencil className="h-3.5 w-3.5" /> Sửa danh mục
              </CtButton>
            )}
            <UploadButton label="Upload clipart gốc" primary onFiles={(f) => void upload(f, null)} disabled={busy !== null} />
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
          <p className="py-10 text-center text-sm text-muted-foreground">Danh mục trống. Bấm “Upload clipart gốc” (chọn được nhiều ảnh PNG cùng lúc, mỗi ảnh 1 gốc).</p>
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
                busy={busy !== null}
                onUploadVariants={(files) => void upload(files, o.id)}
                onUploadMaterial={() => setMaterialFor(o)}
                picked={picked}
                onPick={togglePick}
              />
            ))}
          </div>
        )}
      </main>

      {editCategory && (
        <CategoryDialog
          category={editCategory === "new" ? null : editCategory}
          categories={categories}
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
      {materialFor && (
        <MaterialUploadDialog
          origin={materialFor}
          materials={materials}
          versions={materialVersions(clipartFamily(cliparts, materialFor))}
          onClose={() => setMaterialFor(null)}
          onUpload={(files, material) => {
            const parentId = materialFor.id;
            setMaterialFor(null);
            void upload(files, parentId, material);
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

function SetCard(
  props: TileActions & { origin: CtAsset; family: CtAsset[]; materials: CtPreset[]; busy: boolean; onUploadVariants: (files: File[]) => void; onUploadMaterial: () => void },
) {
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
        <span className="ml-auto flex shrink-0 gap-1">
          <UploadButton label="Upload đa sắc" small onFiles={props.onUploadVariants} disabled={props.busy} />
          <CtButton size="sm" variant="ghost" onClick={props.onUploadMaterial} disabled={props.busy}>
            <Layers className="h-3.5 w-3.5" /> Upload vật liệu
          </CtButton>
        </span>
      </div>
      {origin.spec && <p className="mb-2 line-clamp-2 text-[11px] text-muted-foreground">{origin.spec}</p>}
      <div className="flex flex-wrap items-start gap-3">
        <Tile asset={origin} big caption="Gốc" {...props} />
        {material.length > 0 && <TileGroup label="Vật liệu" list={material} sub={materialName} {...props} />}
        {multicolor.length > 0 && <TileGroup label="Đa sắc" list={multicolor} sub={(a) => (isMaterialClipart(a) ? materialName(a) : null)} {...props} />}
        {material.length + multicolor.length === 0 && (
          <span className="self-center text-[11px] text-muted-foreground">Chưa có đa sắc / vật liệu — bấm “Upload đa sắc” / “Upload vật liệu” ở trên.</span>
        )}
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

function UploadButton({ label, onFiles, disabled, small, primary }: { label: string; onFiles: (files: File[]) => void; disabled?: boolean; small?: boolean; primary?: boolean }) {
  const ref = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <CtButton size="sm" variant={primary ? "primary" : small ? "ghost" : "outline"} onClick={() => ref.current?.click()} disabled={disabled}>
        <ImagePlus className="h-3.5 w-3.5" /> {label}
      </CtButton>
      <input
        ref={ref}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}

/** The category and its descendants — none of them can be its parent. */
function subtreeIds(list: CtClipartCategory[], id: string): Set<string> {
  const out = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of list) {
      if (c.parent_id && out.has(c.parent_id) && !out.has(c.id)) {
        out.add(c.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Create / edit a category: name, parent, sort order. Its older spec / rules (from AI generation) are kept as they are. */
export function CategoryDialog(props: {
  category: CtClipartCategory | null;
  categories: CtClipartCategory[];
  onClose: () => void;
  onSaved: (c: CtClipartCategory) => void;
  onDeleted: () => void;
}) {
  const c = props.category;
  const [name, setName] = useState(c?.name ?? "");
  const [parentId, setParentId] = useState(c?.parent_id ?? NONE);
  const [sortOrder, setSortOrder] = useState(c?.sort_order ?? 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = useMemo(() => (c ? subtreeIds(props.categories, c.id) : new Set<string>()), [c, props.categories]);
  const parents = flattenCategories(props.categories).filter(({ category }) => !blocked.has(category.id));

  const save = async () => {
    if (!name.trim()) return setError("Nhập tên danh mục");
    setBusy(true);
    setError(null);
    const body: CtCategoryBody = {
      name: name.trim(),
      parent_id: parentId === NONE ? null : parentId,
      usage: c?.usage ?? "element",
      mode: c?.mode ?? "origin_set",
      spec: c?.spec ?? "",
      rules: c?.rules ?? defaultCategoryRules(),
      sort_order: sortOrder,
    };
    try {
      const saved = c ? await ctApi.updateCategory(c.id, body) : await ctApi.createCategory(body);
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
    <CtModal open onOpenChange={(o) => !o && props.onClose()} title={c ? `Sửa danh mục: ${c.name}` : "Danh mục mới"}>
      <div className="space-y-3 text-sm">
        <CtField label="Tên">
          <CtInput value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} placeholder="vd. Chibi Car" autoFocus />
        </CtField>
        <CtField label="Danh mục cha">
          <CtSelect<string>
            value={parentId}
            onChange={setParentId}
            options={[{ value: NONE, label: "— Không có (cấp gốc) —" }, ...parents.map(({ category: x, depth }) => ({ value: x.id, label: `${"— ".repeat(depth)}${x.name}` }))]}
          />
        </CtField>
        <CtField label="Thứ tự" hint="Số nhỏ đứng trước; bằng nhau thì theo tên.">
          <CtNumber value={sortOrder} min={-9999} max={9999} onChange={setSortOrder} />
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

/**
 * "Upload vật liệu" on a gốc: one or more pictures, each a vật liệu version of it (role rendition). The material
 * preset names it (meta.material — mockup hanger rules come from it); the version label ("có dây") makes it an
 * extra version next to the base one (meta.materialVersion). Best drawn on the gốc's canvas size.
 */
function MaterialUploadDialog(props: {
  origin: CtAsset;
  materials: CtPreset[];
  /** Version labels the set already uses. */
  versions: string[];
  onClose: () => void;
  onUpload: (files: File[], material: CtUploadMaterial) => void;
}) {
  const [materialId, setMaterialId] = useState(props.materials[0]?.id ?? NONE);
  const [version, setVersion] = useState("");
  const ref = useRef<HTMLInputElement | null>(null);
  const { origin } = props;
  return (
    <CtModal open onOpenChange={(o) => !o && props.onClose()} title={`Upload vật liệu: ${origin.name || "clipart gốc"}`}>
      <div className="space-y-3 text-sm">
        <CtField label="Vật liệu" hint="Đặt tên cho bản vật liệu; mockup lấy dây treo / lỗ theo vật liệu này.">
          <CtSelect<string>
            value={materialId}
            onChange={setMaterialId}
            options={[{ value: NONE, label: "— Không gắn vật liệu —" }, ...props.materials.map((m) => ({ value: m.id, label: m.name }))]}
          />
        </CtField>
        <CtField label="Phiên bản (tuỳ chọn)" hint={`Để trống = bản chính. Ghi tên (vd. “có dây”) để thành 1 phiên bản thêm.${props.versions.length ? ` Đang có: ${props.versions.join(", ")}.` : ""}`}>
          <CtInput value={version} onChange={(e) => setVersion(e.target.value)} placeholder="vd. có dây" />
        </CtField>
        <p className="text-[11px] text-muted-foreground">
          Mỗi ảnh chọn là 1 bản vật liệu của gốc này ({origin.width}×{origin.height}) — nên cùng kích thước và vị trí với ảnh gốc để thay vào đúng chỗ.
        </p>
        <div className="flex justify-end gap-2 border-t pt-3">
          <CtButton onClick={props.onClose}>Huỷ</CtButton>
          <CtButton variant="primary" onClick={() => ref.current?.click()}>
            <ImagePlus className="h-3.5 w-3.5" /> Chọn ảnh…
          </CtButton>
          <input
            ref={ref}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (files.length) props.onUpload(files, { materialId: materialId === NONE ? null : materialId, version: version.trim() });
            }}
          />
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
