"use client";

/**
 * /library — manage the global clipart library (migration 006):
 *
 *   Clipart  categories (mode, shared spec, style pack, materials) and the
 *            cliparts in it — every picture is a clipart: a gốc, its đa sắc
 *            (other colours / styles, of the gốc or of a vật liệu version) and
 *            its vật liệu versions. Each one has "Sửa nhanh"; fixing the gốc
 *            makes every other picture of the set again from the new gốc, with
 *            the category's settings (quick-fix-dialog.tsx).
 *   Preset   reusable prompts: style packs and materials — written by hand or
 *            by AI from a description + reference images.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, ChevronDown, ChevronRight, CircleCheck, CircleMinus, FolderPlus, History, ImagePlus, Loader2, Lock, Pencil, Plus, Sparkles, Trash2, Wand2, X } from "lucide-react";
import type {
  CtAsset,
  CtCategoryBody,
  CtCategoryRevision,
  CtRevisePreset,
  CtClipartCategory,
  CtCategoryRules,
  CtClipartUsage,
  CtMaterialArt,
  CtMaterialSpec,
  CtPreset,
  CtPresetBody,
  CtPresetHistoryEntry,
  CtPresetKind,
  CtPresetParams,
  CtPromptSuggestion,
} from "../../types";
import { ctApi } from "../../lib/api-client";
import { normalizeMaterialSpecs } from "../../lib/materials";
import { clipartFamily, defaultCategoryRules, flattenCategories, isMaterialClipart, isMulticolorClipart, libraryOrigins } from "../../lib/library";
import { CHECKER_STYLE, CtButton, CtCheckbox, CtField, CtInput, CtModal, CtNumber, CtSelect, CtTextarea, CtTooltip, CtTooltipProvider, cx } from "../ui";
import { ctConfirm } from "../dialogs";
import { CtAiDialog, type CtAiTarget } from "../studio/ai-dialog";
import { QuickFixDialog, quickFixKey, type CtQuickFixTarget } from "../studio/quick-fix-dialog";
import { ClipartBadges } from "../editor/library-panel";
import { PacksTab } from "./packs-tab";
import { RefNoteBox, refImage, type RefImage } from "./ref-note-box";
import { CategoryHistory, CategoryRevisePanel, type CtReviseChoice } from "./category-revise";
import { AgentBadge, AgentProgress, useAgentStatus, useAgentTask } from "./agent-brain";

export { refImage };

type Tab = "cliparts" | "presets" | "packs";
const NONE = "none";

const KIND_LABEL: Record<CtPresetKind, string> = { style_pack: "Style pack", material: "Vật liệu", scene: "Scene mockup" };
/** What the Preset tab lists (scenes are picked in the editor's mockup tab). */
const LIBRARY_KINDS: CtPresetKind[] = ["style_pack", "material"];
/** What a category is — a fixed picture (public/ct-guide), not library data, so it survives a wipe. */
const CATEGORY_PICTURE = { src: "/ct-guide/kind-origin-set.png", caption: "vd. Chibi Car — mỗi clipart gốc là 1 mẫu xe khác nhau, cùng kiểu vẽ, cùng góc nhìn. Đa sắc và vật liệu làm từ từng clipart gốc." };

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
                ["presets", "Preset (style / vật liệu)"],
                ["packs", "Bộ tổ hợp"],
              ] as Array<[Tab, string]>
            ).map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)} className={cx("rounded px-3 py-1 text-xs font-medium", tab === k ? "bg-foreground text-background" : "hover:bg-accent")}>
                {label}
              </button>
            ))}
          </div>
        </header>
        {tab === "cliparts" ? <ClipartsTab /> : tab === "presets" ? <PresetsTab /> : <PacksTab />}
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
  const [stylePacks, setStylePacks] = useState<CtPreset[]>([]);
  const [materials, setMaterials] = useState<CtPreset[]>([]);
  const [selected, setSelected] = useState<string>(NONE);
  const [cliparts, setCliparts] = useState<CtAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editCategory, setEditCategory] = useState<CtClipartCategory | "new" | null>(null);
  const [editClipart, setEditClipart] = useState<CtAsset | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [ai, setAi] = useState<CtAiTarget | null>(null);
  const [quickFix, setQuickFix] = useState<CtQuickFixTarget | null>(null);
  const [clipartsVersion, setClipartsVersion] = useState(0);

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

  const loadStylePacks = useCallback(() => {
    ctApi
      .listPresets()
      .then((r) => {
        setStylePacks(r.presets.filter((p) => p.kind === "style_pack"));
        setMaterials(r.presets.filter((p) => p.kind === "material"));
      })
      .catch(() => setStylePacks([]));
  }, []);

  useEffect(() => {
    loadCategories();
    loadStylePacks();
  }, [loadCategories, loadStylePacks]);

  useEffect(() => {
    setLoading(true);
    ctApi
      .listCliparts(selected)
      .then(setCliparts)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [selected, clipartsVersion]);

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

  const upload = async (files: File[], parentId: string | null) => {
    setBusy(`Đang upload ${files.length} ảnh…`);
    try {
      const created: CtAsset[] = [];
      for (const f of files) created.push(await ctApi.uploadClipart(f, { categoryId: current?.id ?? null, parentId }));
      setCliparts((list) => [...list, ...created]);
      if (!parentId) loadCategories();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload thất bại");
    } finally {
      setBusy(null);
    }
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
            {current && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                canvas {current.rules.canvas.w}×
                {current.rules.canvas.h} · {stylePacks.find((p) => p.id === current.rules.stylePackId)?.name ?? "chưa có style pack"} · vật liệu: clipart phẳng
                {current.rules.materialIds.map((id) => ` + ${materials.find((m) => m.id === id)?.name ?? "?"}`).join("")}
              </p>
            )}
            {current && <CategoryInfo category={current} stylePacks={stylePacks} materials={materials} onEdit={current.can_edit ? () => setEditCategory(current) : undefined} />}
          </div>
          <div className="flex shrink-0 gap-2">
            <CtButton size="sm" variant="primary" onClick={() => setAi({ recipe: "origin", categoryId: current?.id ?? null })}>
              <Sparkles className="h-3.5 w-3.5" /> Tạo bằng AI
            </CtButton>
            <UploadButton label="Upload clipart gốc" onFiles={(f) => void upload(f, null)} disabled={busy !== null} />
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
          <p className="py-10 text-center text-sm text-muted-foreground">Danh mục trống. Bấm “Tạo bằng AI” hoặc upload clipart gốc.</p>
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
                onQuickFix={(a) => setQuickFix({ assets: [a], origin: o })}
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
          stylePacks={stylePacks}
          materials={materials}
          onPresetsChanged={loadStylePacks}
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
      <CtAiDialog
        target={ai}
        onClose={() => setAi(null)}
        onSaved={() => {
          setClipartsVersion((v) => v + 1);
          loadCategories();
          loadStylePacks();
        }}
        onReplaced={() => setClipartsVersion((v) => v + 1)}
      />
      <QuickFixDialog key={quickFixKey(quickFix)} target={quickFix} onClose={() => setQuickFix(null)} onDone={() => setClipartsVersion((v) => v + 1)} />
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

type InfoTab = "spec" | "style" | "materials" | "details";

/** What a category's cliparts are made from, read-only: shared spec, style pack, materials, product details. */
function CategoryInfo(props: { category: CtClipartCategory; stylePacks: CtPreset[]; materials: CtPreset[]; onEdit?: () => void }) {
  const { category, stylePacks, materials } = props;
  const [tab, setTab] = useState<InfoTab>("spec");
  const { rules } = category;
  const pack = stylePacks.find((p) => p.id === rules.stylePackId) ?? null;
  const used = rules.materialIds.map((id) => ({ id, preset: materials.find((m) => m.id === id) ?? null }));
  const tabs: Array<[InfoTab, string, number | null]> = [
    ["spec", "Spec chung", null],
    ["style", "Style pack", null],
    ["materials", "Vật liệu", used.length + 1],
    ["details", "Chi tiết thành phẩm", rules.details.length],
  ];
  return (
    <div className="mt-3 max-w-3xl">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border bg-muted/40 p-0.5">
          {tabs.map(([k, label, count]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={cx(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                tab === k ? "bg-foreground text-background shadow-sm" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {label}
              {count !== null && (
                <span className={cx("rounded-full px-1.5 text-[10px] leading-4", tab === k ? "bg-background/20" : "bg-muted text-muted-foreground")}>{count}</span>
              )}
            </button>
          ))}
        </div>
        {props.onEdit && (
          <CtButton size="sm" onClick={props.onEdit}>
            <Pencil className="h-3.5 w-3.5" /> Chỉnh sửa
          </CtButton>
        )}
      </div>
      <div className="space-y-2 pt-2 text-xs">
        {tab === "spec" && (
          <>
            {category.spec ? <p className="whitespace-pre-line">{category.spec}</p> : <p className="text-muted-foreground">Chưa có spec chung.</p>}
            <InfoRefs label="Ảnh mẫu kiểu vẽ" urls={rules.refs} />
          </>
        )}
        {tab === "style" &&
          (pack ? (
            <>
              <p className="font-medium">{pack.name}</p>
              <p className="whitespace-pre-line">{pack.prompt}</p>
              <InfoRefs label="Ảnh mẫu" urls={pack.params.refs ?? []} />
            </>
          ) : (
            <p className="text-muted-foreground">Chưa có style pack.</p>
          ))}
        {tab === "materials" && (
          <>
            <div className="rounded-md border px-2 py-1.5">
              <p className="font-medium">Clipart phẳng</p>
              <p className="text-muted-foreground">Luôn có — file gửi xưởng, không có chi tiết thành phẩm.</p>
            </div>
            {used.map(({ id, preset }) => (
              <div key={id} className="space-y-1 rounded-md border px-2 py-1.5">
                <p className="font-medium">{preset?.name ?? "Vật liệu đã bị xoá"}</p>
                {preset && <p className="whitespace-pre-line">{preset.prompt}</p>}
                {preset && <InfoRefs label="Ảnh mẫu" urls={preset.params.refs ?? []} />}
              </div>
            ))}
          </>
        )}
        {tab === "details" && (
          <>
            {rules.details.length === 0 ? (
              <p className="text-muted-foreground">Chưa có chi tiết thành phẩm.</p>
            ) : (
              <SpecSummary specs={rules.details} disabled onRemove={() => undefined} />
            )}
            {rules.details.length > 0 && used.length === 0 && (
              <p className="text-amber-600">Danh mục chưa gắn vật liệu nào — chi tiết chỉ được vẽ trên các bản vật liệu.</p>
            )}
            {rules.detailsNote && <p className="whitespace-pre-line text-muted-foreground">{rules.detailsNote}</p>}
            <InfoRefs label="Ảnh thành phẩm" urls={rules.productRefs} />
          </>
        )}
      </div>
    </div>
  );
}

function InfoRefs({ label, urls }: { label: string; urls: string[] }) {
  if (!urls.length) return null;
  return (
    <div>
      <p className="mb-1 text-[11px] text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {urls.map((u) => (
          <a key={u} href={u} target="_blank" rel="noreferrer" className="block h-16 w-16 overflow-hidden rounded border">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={u} alt="" className="h-full w-full object-cover" />
          </a>
        ))}
      </div>
    </div>
  );
}

/**
 * One set of the category: its gốc, then its vật liệu versions and its đa sắc (of the gốc or of a vật liệu
 * version — those carry both badges). Every picture has its own "Sửa nhanh"; a click opens its details.
 */
interface TileActions {
  onOpen: (a: CtAsset) => void;
  onQuickFix: (a: CtAsset) => void;
  picked: Set<string>;
  /** shift = extend the range from the last picked one. */
  onPick: (a: CtAsset, shift: boolean) => void;
}

function SetCard(props: TileActions & { origin: CtAsset; family: CtAsset[]; materials: CtPreset[] }) {
  const { origin, family } = props;
  const material = family.filter((a) => isMaterialClipart(a) && !isMulticolorClipart(a));
  const multicolor = family.filter(isMulticolorClipart);
  const materialName = (a: CtAsset) => props.materials.find((m) => m.id === a.meta.material)?.name ?? null;
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
        {material.length + multicolor.length === 0 && (
          <span className="self-center text-[11px] text-muted-foreground">Chưa có đa sắc / vật liệu — tạo ở “Tạo bằng AI” (bước 2, 3).</span>
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
      <div className="flex">
        <CtTooltip
          label={
            asset.parent_id === null
              ? "Sửa ảnh gốc — xong thì mọi đa sắc và vật liệu của bộ tự tạo lại từ gốc mới, theo setting của danh mục"
              : "Sửa riêng ảnh này (đổi màu miễn phí, hoặc AI) — ảnh làm từ nó (vật liệu / đa sắc của nó) tạo lại theo"
          }
        >
          <span className="flex min-w-0 flex-1">
            <CtButton size="sm" className="h-6 flex-1 px-1 text-[11px]" onClick={() => props.onQuickFix(asset)}>
              <Wand2 className="h-3 w-3" /> Sửa nhanh
            </CtButton>
          </span>
        </CtTooltip>
      </div>
    </div>
  );
}

function UploadButton({ label, onFiles, disabled, small }: { label: string; onFiles: (files: File[]) => void; disabled?: boolean; small?: boolean }) {
  const ref = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <CtButton size="sm" variant={small ? "ghost" : "outline"} onClick={() => ref.current?.click()} disabled={disabled}>
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

type CategoryTab = "info" | "spec" | "style" | "materials" | "details";

/** The dialog's tabs — independent, open in any order. */
const CATEGORY_TABS: Array<{ id: CategoryTab; label: string }> = [
  { id: "info", label: "Thông tin chung" },
  { id: "spec", label: "Spec chung" },
  { id: "style", label: "Style pack" },
  { id: "materials", label: "Vật liệu" },
  { id: "details", label: "Chi tiết thành phẩm" },
];

const SPEC_DO = ["Hình dạng, tỉ lệ giữa các đối tượng (vd. mũ cao ~1/3 thân xe)", "Vị trí, góc nhìn chung của cả bộ", "Quy tắc chung: vùng để trống cho khách custom, thứ không được có", "Viết tiếng Anh"];
const SPEC_DONT = ["Cách vẽ, nét, đổ bóng (thuộc style pack)", "Vật liệu: acrylic, gỗ, glitter… (thuộc bước Vật liệu)", "Lỗ, dây, móc… (thuộc Chi tiết thành phẩm)", "Màu / chi tiết riêng của từng hình"];

/**
 * Why materials and product details are separate steps, and when they are used — shown on both steps:
 * they cost an AI call per image, so they only run once an origin is approved, never with every origin try.
 */
function ProductStepNote({ step }: { step: "materials" | "details" }) {
  return (
    <div className="space-y-1.5 rounded-lg border border-violet-500/30 bg-violet-500/5 p-3 text-xs leading-relaxed">
      <p className="font-medium">Vật liệu + Chi tiết thành phẩm = 1 ảnh sản phẩm hoàn chỉnh</p>
      <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
        <li>
          <b className="text-foreground">Vật liệu</b> quyết định chất liệu và chất lượng bề mặt của ảnh: acrylic trong, gỗ, glitter…
        </li>
        <li>
          <b className="text-foreground">Chi tiết thành phẩm</b> quyết định các chi tiết thêm của sản phẩm thật: lỗ treo, dây, móc… và <b className="text-foreground">số ảnh</b> được
          tạo — mỗi chi tiết “tạo thêm phiên bản” là 1 ảnh nữa (vd. bản không dây + bản có dây = 2 ảnh).
        </li>
        <li>
          <b className="text-foreground">Chỉ dùng sau khi clipart gốc đã xong</b> (spec chung + style pack): clipart gốc thường phải tạo / sửa nhiều lượt — lượt nào cũng làm vật liệu và
          thành phẩm thì rất tốn tiền. Duyệt clipart gốc trước, rồi mới tạo ở bước “Vật liệu & thành phẩm” của Tạo bằng AI.
        </li>
        <li>
          <b className="text-foreground">Tách riêng để tái sử dụng:</b> 1 vật liệu (vd. Acrylic trong) dùng chung cho nhiều danh mục; chi tiết thành phẩm thuộc riêng danh mục này
          {step === "details" ? " — chép được sang danh mục khác bằng “Lấy từ danh mục khác”." : "."}
        </li>
      </ul>
    </div>
  );
}

/**
 * Create / edit a category: independent tabs (a check turns green once the tab is complete; all green → it can be
 * saved), and "Tạo bằng AI" on top that fills every tab at once — reusing the library's style packs, materials
 * and details when they fit. Also used by the AI dialog (components/studio/ai-dialog.tsx).
 */
export function CategoryDialog(props: {
  category: CtClipartCategory | null;
  /** Kept for the callers; categories are independent (no parent any more). */
  categories?: CtClipartCategory[];
  stylePacks: CtPreset[];
  /** Material presets the category can add renditions with. */
  materials?: CtPreset[];
  onClose: () => void;
  onSaved: (c: CtClipartCategory) => void;
  onDeleted: () => void;
  /** A style pack was created / edited / deleted from inside the dialog — the parent reloads its list. */
  onPresetsChanged?: () => void;
  /**
   * Results the editor is not happy with (AI dialog "Chưa hài lòng kết quả"): the dialog opens on "Cập nhật bằng AI"
   * with them numbered.
   */
  review?: CtAsset[];
}) {
  const [c, setC] = useState(props.category);
  const [body, setBody] = useState<CtCategoryBody>(() => ({
    name: c?.name ?? "",
    parent_id: null,
    // Kept in the DB for older code paths; every clipart is just a clipart now, each gốc its own set.
    usage: c?.usage ?? "element",
    mode: c?.mode ?? "origin_set",
    spec: c?.spec ?? "",
    rules: c?.rules ?? defaultCategoryRules(),
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<CtCategoryBody>) => setBody((b) => ({ ...b, ...patch }));
  const setRules = (patch: Partial<CtCategoryBody["rules"]>) => setBody((b) => ({ ...b, rules: { ...b.rules, ...patch } }));

  // Style packs / materials created / edited here (null = deleted), on top of the props until the parent reloads.
  const [presetEdits, setPresetEdits] = useState<Record<string, CtPreset | null>>({});
  const presets = useMemo(() => {
    const byId = new Map([...props.stylePacks, ...(props.materials ?? [])].map((p) => [p.id, p]));
    for (const [id, p] of Object.entries(presetEdits)) {
      if (p) byId.set(id, p);
      else byId.delete(id);
    }
    return Array.from(byId.values());
  }, [props.stylePacks, props.materials, presetEdits]);
  const packs = presets.filter((p) => p.kind === "style_pack");
  const mats = presets.filter((p) => p.kind === "material");
  const pack = packs.find((p) => p.id === body.rules.stylePackId) ?? null;
  const chosen = body.rules.materialIds.map((id) => mats.find((m) => m.id === id)).filter((m): m is CtPreset => Boolean(m));
  const addable = mats.filter((m) => !body.rules.materialIds.includes(m.id));
  const [editPreset, setEditPreset] = useState<{ kind: "style_pack" | "material"; preset: CtPreset | null } | null>(null);
  const [assistant, setAssistant] = useState(Boolean(props.category && props.review?.length));
  const [historyOpen, setHistoryOpen] = useState(false);
  /** What the last "Tạo bằng AI" / "Cập nhật bằng AI" reused / created / changed. */
  const [aiReport, setAiReport] = useState<string | null>(null);

  const addMaterial = (id: string) => setBody((b) => ({ ...b, rules: { ...b.rules, materialIds: b.rules.materialIds.includes(id) ? b.rules.materialIds : [...b.rules.materialIds, id] } }));
  const dropMaterial = (id: string) => setBody((b) => ({ ...b, rules: { ...b.rules, materialIds: b.rules.materialIds.filter((x) => x !== id) } }));

  /** A preset saved here becomes the style pack / joins the materials; a deleted one leaves them. */
  const presetChanged = (kind: "style_pack" | "material", id: string, saved: CtPreset | null) => {
    setPresetEdits((m) => ({ ...m, [id]: saved }));
    if (kind === "style_pack") {
      if (saved) setRules({ stylePackId: saved.id });
      else if (body.rules.stylePackId === id) setRules({ stylePackId: null });
    } else if (saved) addMaterial(saved.id);
    else dropMaterial(id);
    props.onPresetsChanged?.();
  };

  /**
   * AI suggestion: name (when empty), spec and the product's details go into the form; a style pack / material the
   * library already has is picked, a new one is saved at once and picked. The reference photos are kept by what
   * they show: the artwork ("design" — sent with the flat drawing) or the finished product ("product" — sent
   * with the material step only).
   */
  const applySuggestion = async (s: CtPromptSuggestion, refBlobs: Array<Blob | string>) => {
    // The agent's task already uploaded the photos (urls); the built-in LLM's did not.
    const uploaded = await Promise.all(refBlobs.map((b) => (typeof b === "string" ? b : ctApi.uploadPresetRef(b))));
    const refs = uploaded.filter((_, i) => s.refRoles[i] !== "product");
    const productRefs = uploaded.filter((_, i) => s.refRoles[i] === "product");
    setBody((b) => ({
      ...b,
      name: b.name.trim() ? b.name : s.name,
      spec: s.spec,
      rules: {
        ...b.rules,
        refs: [...b.rules.refs, ...refs].slice(0, 6),
        productRefs: [...b.rules.productRefs, ...productRefs].slice(0, MAX_PRESET_REFS),
        details: s.details.length ? s.details : b.rules.details,
      },
    }));
    if (s.style.reuseId) setRules({ stylePackId: s.style.reuseId });
    else {
      const style = await ctApi.createPreset({ kind: "style_pack", name: s.style.name, prompt: s.style.prompt, reference_asset_ids: [], params: refs.length ? { refs } : {} });
      presetChanged("style_pack", style.id, style);
    }
    for (const m of s.materials) {
      if (m.reuseId) addMaterial(m.reuseId);
      else {
        const mat = await ctApi.createPreset({ kind: "material", name: m.name, prompt: m.prompt, reference_asset_ids: [], params: MATERIAL_PARAMS });
        presetChanged("material", mat.id, mat);
      }
    }
    setAiReport(s.summary);
  };

  /**
   * "Cập nhật bằng AI" applied: the ticked changes go into the category — library presets switched to, prompts
   * edited (the shared preset, or a copy for this category), new ones created — then it is saved at once, linked
   * to the revision in the history. The dialog stays open.
   */
  const applyRevision = async (plan: CtCategoryRevision, choice: CtReviseChoice, refUrls: string[]) => {
    if (!c) return;
    const rules = { ...body.rules, materialIds: [...body.rules.materialIds] };
    const lines: string[] = [];
    const remember = (p: CtPreset) => setPresetEdits((m) => ({ ...m, [p.id]: p }));
    /** The preset after an "edit" / "new": the shared one updated, or a copy for this category. */
    const written = async (item: CtRevisePreset, kind: "style_pack" | "material", shared: boolean): Promise<CtPreset> => {
      const cur = presets.find((p) => p.id === item.currentId) ?? null;
      if (item.action === "edit" && cur && shared) {
        const saved = await ctApi.updatePreset(cur.id, { kind, name: cur.name, prompt: item.prompt, reference_asset_ids: cur.reference_asset_ids, params: cur.params });
        remember(saved);
        return saved;
      }
      const name = item.action === "edit" && cur ? `${cur.name} · ${body.name}`.slice(0, 80) : item.name;
      const params = cur?.params ?? (kind === "material" ? MATERIAL_PARAMS : {});
      const made = await ctApi.createPreset({ kind, name, prompt: item.prompt, reference_asset_ids: cur?.reference_asset_ids ?? [], params });
      remember(made);
      return made;
    };
    if (choice.style.apply && plan.style.action !== "keep") {
      if (plan.style.action === "switch" && plan.style.targetId) rules.stylePackId = plan.style.targetId;
      else rules.stylePackId = (await written(plan.style, "style_pack", choice.style.shared)).id;
      lines.push(`Style pack: ${plan.style.action === "switch" ? `đổi sang “${plan.style.name}”` : plan.style.action === "new" ? `tạo mới “${plan.style.name}”` : choice.style.shared ? "sửa prompt (bản chung)" : "sửa prompt (bản riêng)"}`);
    }
    for (const [i, m] of plan.materials.entries()) {
      if (!choice.materials[i]?.apply || m.action === "keep") continue;
      const at = m.currentId ? rules.materialIds.indexOf(m.currentId) : -1;
      if (m.action === "remove") rules.materialIds = rules.materialIds.filter((id) => id !== m.currentId);
      else {
        const id = m.action === "switch" && m.targetId ? m.targetId : (await written(m, "material", choice.materials[i].shared)).id;
        if (at >= 0) rules.materialIds[at] = id;
        else if (!rules.materialIds.includes(id)) rules.materialIds.push(id);
      }
      lines.push(`Vật liệu “${m.name}”: ${m.action === "remove" ? "bỏ" : m.action === "switch" ? (m.currentId ? "đổi sang bản có sẵn" : "thêm (có sẵn)") : m.action === "new" ? "tạo mới" : "sửa prompt"}`);
    }
    rules.materialIds = [...new Set(rules.materialIds)];
    if (choice.details && plan.details) {
      rules.details = plan.details.list;
      lines.push(`Chi tiết thành phẩm: ${plan.details.list.length} chi tiết`);
    }
    const design = refUrls.filter((_, i) => plan.refRoles[i] === "design");
    const product = refUrls.filter((_, i) => plan.refRoles[i] === "product");
    rules.refs = [...new Set([...rules.refs, ...design])].slice(-6);
    rules.productRefs = [...new Set([...rules.productRefs, ...product])].slice(-MAX_PRESET_REFS);
    const dropped = choice.dropRefs ? (plan.review?.dropProductRefs ?? []) : [];
    if (dropped.length) {
      rules.productRefs = rules.productRefs.filter((u) => !dropped.includes(u));
      lines.push(`Bỏ ${dropped.length} ảnh thành phẩm mâu thuẫn`);
    }
    if (design.length + product.length) lines.push(`Lưu ${design.length + product.length} ảnh tham khảo mới`);
    const next: CtCategoryBody = { ...body, spec: choice.spec ?? body.spec, rules };
    if (choice.spec !== null) lines.unshift("Spec chung: cập nhật");
    const saved = await ctApi.updateCategory(c.id, { ...next, parent_id: null, revision_id: plan.historyId });
    setBody({ ...next, spec: saved.spec, rules: saved.rules });
    setC(saved);
    props.onSaved(saved);
    props.onPresetsChanged?.();
    setAiReport(["Đã áp dụng & lưu danh mục:", ...lines].join("\n"));
  };

  /** What a tab still needs (null = complete). Vật liệu / chi tiết are optional. */
  const tabMissing: Record<CategoryTab, string | null> = {
    info: !body.name.trim() ? "Nhập tên danh mục" : null,
    spec: !body.spec.trim() ? "Viết spec chung (hoặc bấm Tạo bằng AI)" : null,
    style: !pack ? "Chọn style pack (hoặc bấm + để tạo)" : null,
    materials: null,
    details: null,
  };
  const missing = CATEGORY_TABS.map((x) => tabMissing[x.id]).find((m) => m !== null) ?? null;
  const [tab, setTab] = useState<CategoryTab>("info");
  const save = async () => {
    if (missing) return setError(missing);
    setBusy(true);
    setError(null);
    try {
      const saved = c ? await ctApi.updateCategory(c.id, { ...body, parent_id: null }) : await ctApi.createCategory({ ...body, parent_id: null });
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

  const picture = CATEGORY_PICTURE;
  const extraVersions = body.rules.details.filter((d) => d.mode === "version");
  return (
    <CtModal open onOpenChange={(o) => !o && props.onClose()} title={c ? `Cập nhật danh mục: ${c.name}` : "Danh mục mới"} wide>
      <div className="mb-3 space-y-2">
        {assistant && c ? (
          <CategoryRevisePanel
            category={{ id: c.id, name: body.name, spec: body.spec, rules: body.rules }}
            review={props.review ?? []}
            materials={mats}
            onApply={applyRevision}
            onClose={() => setAssistant(false)}
          />
        ) : assistant ? (
          <PromptAssistant body={body} onResult={applySuggestion} onClose={() => setAssistant(false)} />
        ) : (
          <div className="flex items-center gap-3 rounded-lg border border-sky-500/30 bg-sky-500/5 p-2.5">
            <CtButton variant="primary" onClick={() => setAssistant(true)}>
              <Sparkles className="h-3.5 w-3.5" /> {c ? "Cập nhật bằng AI" : "Tạo bằng AI"}
            </CtButton>
            <span className="flex-1 text-[11px] leading-snug text-muted-foreground">
              {c
                ? "Mô tả chỗ chưa ưng (+ ảnh tham khảo) → AI xem prompt hiện tại, tìm sai ở spec chung, style pack, vật liệu hay chi tiết thành phẩm và chỉ sửa chỗ đó — đổi sang bản có sẵn trong thư viện nếu phù hợp hơn."
                : "Thả ảnh tham khảo / ghi vài dòng → AI đặt tên, viết spec chung, rồi tra thư viện: style pack, vật liệu, chi tiết thành phẩm nào đã có và phù hợp thì dùng lại, chỉ tạo mới khi không có."}
            </span>
            {c && (
              <CtButton size="sm" onClick={() => setHistoryOpen((v) => !v)}>
                <History className="h-3.5 w-3.5" /> Lịch sử
              </CtButton>
            )}
          </div>
        )}
        {historyOpen && c && <CategoryHistory key={c.updated_at ?? c.id} categoryId={c.id} onClose={() => setHistoryOpen(false)} />}
        {aiReport && (
          <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-2.5 text-[11px] leading-snug">
            <CircleCheck className="mt-px h-3.5 w-3.5 shrink-0 text-emerald-500" />
            <div className="flex-1 space-y-0.5">
              {aiReport.split("\n").map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
            <button className="rounded p-0.5 text-muted-foreground hover:bg-accent" onClick={() => setAiReport(null)} aria-label="Đóng">
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-1.5 text-xs">
        {CATEGORY_TABS.map((x) => {
          const done = tabMissing[x.id] === null;
          return (
            <CtTooltip key={x.id} label={tabMissing[x.id] ?? "Đã xong"}>
              <button
                onClick={() => setTab(x.id)}
                className={cx(
                  "flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium transition-colors",
                  x.id === tab ? "border-foreground bg-foreground text-background" : "hover:bg-accent",
                )}
              >
                <span className={cx("flex h-4 w-4 items-center justify-center rounded-full", done ? "bg-emerald-500 text-white" : "bg-muted-foreground/30 text-background")}>
                  <Check className="h-2.5 w-2.5" />
                </span>
                {x.label}
              </button>
            </CtTooltip>
          );
        })}
      </div>

      <div className="min-h-[340px] text-sm">
        {tab === "info" && (
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-3">
              <CtField label="Tên">
                <CtInput value={body.name} onChange={(e) => set({ name: e.target.value })} placeholder="vd. Chibi Car" autoFocus />
              </CtField>
              <div className="grid grid-cols-2 gap-2">
                <CtField label="Canvas W" hint="Kích thước ảnh kết quả (px).">
                  <CtNumber value={body.rules.canvas.w} min={64} max={4096} onChange={(w) => setRules({ canvas: { ...body.rules.canvas, w } })} />
                </CtField>
                <CtField label="Canvas H">
                  <CtNumber value={body.rules.canvas.h} min={64} max={4096} onChange={(h) => setRules({ canvas: { ...body.rules.canvas, h } })} />
                </CtField>
              </div>
            </div>
            <figure className="space-y-1">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={picture.src} alt="" className="w-full rounded-md border bg-white" />
              <figcaption className="text-[11px] leading-snug text-muted-foreground">{picture.caption}</figcaption>
            </figure>
          </div>
        )}

        {tab === "spec" && (
          <div className="space-y-3">
            <div className="grid gap-4 md:grid-cols-[1fr_280px]">
              <CtField label="Spec chung (prompt cho cả danh mục)">
                <CtTextarea
                  rows={12}
                  value={body.spec}
                  onChange={(e) => set({ spec: e.target.value })}
                  placeholder="vd. A chibi toy car, super-deformed: oversized rounded body, big wheels, short hood, seen from the front-left 3/4 angle. A round helmet sits on the top right of the roof; the helmet's face area is left completely blank (no eyes, no mouth). No driver, no license plate."
                />
              </CtField>
              <div className="space-y-3 text-xs">
                <div className="space-y-1.5">
                  <p className="font-medium">Nên viết</p>
                  {SPEC_DO.map((x) => (
                    <p key={x} className="flex gap-1.5 leading-snug">
                      <CircleCheck className="mt-px h-3.5 w-3.5 shrink-0 text-emerald-500" /> {x}
                    </p>
                  ))}
                </div>
                <div className="space-y-1.5">
                  <p className="font-medium">Không nên viết</p>
                  {SPEC_DONT.map((x) => (
                    <p key={x} className="flex gap-1.5 leading-snug text-muted-foreground">
                      <CircleMinus className="mt-px h-3.5 w-3.5 shrink-0 text-rose-500" /> {x}
                    </p>
                  ))}
                </div>
              </div>
            </div>
            <SavedRefs
              label="Ảnh mẫu của bộ — gửi kèm model vẽ clipart gốc"
              hint="Model vẽ nhìn thấy các ảnh này mỗi lần vẽ clipart gốc (học góc nhìn, tỉ lệ, bố cục, nét — không chép nội dung), nên ít phải đoán và cả bộ đồng đều hơn. Nên là 2–4 clipart đã ưng của chính bộ này. Tối đa 6, model nhận 4 (ưu tiên ảnh của bộ trước ảnh của style pack)."
              urls={body.rules.refs}
              pending={0}
              disabled={false}
              onRemove={(u) => setRules({ refs: body.rules.refs.filter((x) => x !== u) })}
              onAdd={async (files) => {
                const urls = await Promise.all(files.map(async (f) => ctApi.uploadPresetRef(await refImage(f))));
                setBody((b) => ({ ...b, rules: { ...b.rules, refs: [...b.rules.refs, ...urls].slice(-6) } }));
              }}
              onError={setError}
            />
          </div>
        )}

        {tab === "style" && (
          <div className="max-w-2xl space-y-3">
            <CtField label="Style pack (bắt buộc)" hint="Cách vẽ chung: nét, đổ bóng, màu, độ bóng. Ghép TRƯỚC spec chung trong prompt. 1 style pack dùng được cho nhiều danh mục.">
              <SelectWithEdit<string>
                value={body.rules.stylePackId ?? NONE}
                onChange={(v) => setRules({ stylePackId: v === NONE ? null : v })}
                options={[{ value: NONE, label: packs.length ? "— Chọn style pack —" : "— Chưa có, bấm + để tạo —" }, ...packs.map((p) => ({ value: p.id, label: p.name }))]}
                onNew={() => setEditPreset({ kind: "style_pack", preset: null })}
                onEdit={pack ? () => setEditPreset({ kind: "style_pack", preset: pack }) : undefined}
                newLabel="Style pack mới"
              />
            </CtField>
            {pack && <p className="whitespace-pre-line rounded-md border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">{pack.prompt}</p>}
            {pack && (
              <SavedRefs
                label="Ảnh mẫu của style pack — gửi kèm model vẽ"
                hint={(pack.params.refs ?? []).length ? "Dùng chung cho mọi danh mục chọn pack này; sửa ở nút bút chì. Model vẽ nhận ảnh mẫu của bộ trước, còn chỗ mới tới các ảnh này." : "Pack chưa có ảnh mẫu — thêm ở nút bút chì để model vẽ thấy đúng nét."}
                urls={pack.params.refs ?? []}
                pending={0}
                disabled
                always
                onRemove={() => undefined}
              />
            )}
            <p className="text-[11px] text-muted-foreground">Clipart gốc = spec chung + style pack. Đây là tất cả những gì bước “Clipart gốc” dùng.</p>
          </div>
        )}

        {tab === "materials" && (
          <div className="grid gap-4 md:grid-cols-[1fr_360px]">
            <CtField label="Vật liệu của danh mục (tuỳ chọn)">
              <div className="space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  <span className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs">
                    <Lock className="h-3 w-3 text-muted-foreground" /> Clipart phẳng
                  </span>
                  {chosen.map((m) => (
                    <span key={m.id} className="inline-flex items-center gap-0.5 rounded-full border border-violet-500/40 bg-violet-500/10 py-0.5 pl-2 pr-0.5 text-xs text-violet-700 dark:text-violet-300">
                      <button className="hover:underline" onClick={() => setEditPreset({ kind: "material", preset: m })} title="Xem / sửa">
                        {m.name}
                      </button>
                      <button className="rounded-full p-0.5 hover:bg-violet-500/20" onClick={() => dropMaterial(m.id)} aria-label={`Bỏ ${m.name}`}>
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
                <SelectWithEdit<string>
                  value=""
                  onChange={(v) => v && addMaterial(v)}
                  options={[{ value: "", label: addable.length ? "+ Thêm vật liệu…" : mats.length ? "Đã chọn hết vật liệu" : "Chưa có vật liệu, bấm + để tạo" }, ...addable.map((p) => ({ value: p.id, label: p.name }))]}
                  onNew={() => setEditPreset({ kind: "material", preset: null })}
                  newLabel="Vật liệu mới"
                />
                <p className="text-[11px] leading-snug text-muted-foreground">
                  Clipart phẳng luôn có (file gửi xưởng). Mỗi vật liệu chọn ở đây là 1 lựa chọn ở bước “Vật liệu & thành phẩm”
                  {chosen.length ? ` — mỗi clipart gốc × ${chosen.length} vật liệu × ${1 + extraVersions.length} ảnh (theo chi tiết thành phẩm).` : "."}
                </p>
                {chosen.map((m) => (
                  <div key={m.id} className="space-y-1 rounded-md border bg-muted/30 p-2">
                    <p className="line-clamp-3 text-[11px] leading-snug text-muted-foreground">
                      <b className="text-foreground">{m.name}:</b> {m.prompt}
                    </p>
                    {(m.params.refs ?? []).length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {(m.params.refs ?? []).map((u) => (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img key={u} src={u} alt="" className="h-10 w-10 rounded border object-cover" />
                        ))}
                      </div>
                    ) : (
                      <p className="text-[10px] text-amber-600">Chưa có ảnh mẫu vật liệu — model chỉ đọc chữ, dễ ra lệch (đục, viền dày…). Thêm ảnh ở tên vật liệu.</p>
                    )}
                  </div>
                ))}
              </div>
            </CtField>
            <ProductStepNote step="materials" />
          </div>
        )}

        {tab === "details" && (
          <div className="space-y-3">
            <ProductStepNote step="details" />
            <CategoryDetails categoryId={c?.id ?? null} name={body.name} spec={body.spec} rules={body.rules} hasMaterial={chosen.length > 0} onChange={setRules} onError={setError} />
          </div>
        )}
      </div>

      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
      <div className="mt-3 flex items-center gap-2 border-t pt-3">
        {c?.can_edit && (
          <CtButton variant="ghost" className="text-destructive" onClick={() => void remove()}>
            <Trash2 className="h-3.5 w-3.5" /> Xoá
          </CtButton>
        )}
        <span className="flex-1 text-center text-[11px] text-muted-foreground">{missing}</span>
        <CtButton onClick={props.onClose}>Huỷ</CtButton>
        <CtTooltip label={missing ?? (c ? "Lưu thay đổi" : "Tạo danh mục")}>
          <span>
            <CtButton variant="primary" onClick={() => void save()} disabled={busy || missing !== null}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} {c ? "Lưu" : "Tạo mới"}
            </CtButton>
          </span>
        </CtTooltip>
      </div>
      {editPreset && (
        <PresetDialog
          preset={editPreset.preset}
          kind={editPreset.kind}
          onClose={() => setEditPreset(null)}
          onSaved={(saved) => {
            const id = saved?.id ?? editPreset.preset?.id ?? null;
            if (id) presetChanged(editPreset.kind, id, saved);
          }}
        />
      )}
    </CtModal>
  );
}

/**
 * Chi tiết thành phẩm of a category (CtCategoryRules.details): what its finished product has besides the material —
 * a hole, a spring and a cord, a visor clip… Read by the AI from a description + photos of the product, or copied
 * from another category (a copy: editing it here never changes the other one; photos are copied as links).
 * Never on the flat clipart: only the material versions get them.
 */
function CategoryDetails(props: {
  categoryId: string | null;
  name: string;
  spec: string;
  rules: CtCategoryRules;
  hasMaterial: boolean;
  onChange: (patch: Partial<CtCategoryRules>) => void;
  onError: (msg: string | null) => void;
}) {
  const { details, productRefs, detailsNote } = props.rules;
  const [refs, setRefs] = useState<RefImage[]>([]);
  const [writing, setWriting] = useState(false);
  /** "Lấy từ danh mục khác": the other categories with details (loaded when opened). */
  const [others, setOthers] = useState<CtClipartCategory[] | null>(null);
  const [sourceId, setSourceId] = useState("");
  const source = others?.find((x) => x.id === sourceId) ?? null;
  const has = (t: string) => details.some((d) => d.text.trim() === t.trim());

  const analyse = async () => {
    setWriting(true);
    props.onError(null);
    try {
      const uploaded = await Promise.all(refs.map((r) => ctApi.uploadPresetRef(r.blob)));
      refs.forEach((r) => URL.revokeObjectURL(r.preview));
      setRefs([]);
      const urls = [...productRefs, ...uploaded].slice(0, MAX_PRESET_REFS);
      const s = await ctApi.suggestDetails({ name: props.name, spec: props.spec, note: detailsNote, refUrls: urls });
      props.onChange({ productRefs: urls, details: s.details });
    } catch (e) {
      props.onError(e instanceof Error ? e.message : "Lỗi");
    } finally {
      setWriting(false);
    }
  };

  const openPicker = () => {
    ctApi
      .listCategories()
      .then((r) => setOthers(r.categories.filter((x) => x.id !== props.categoryId && x.rules.details.length > 0)))
      .catch((e: Error) => props.onError(e.message));
  };

  const copy = (list: CtMaterialSpec[]) => props.onChange({ details: normalizeMaterialSpecs([...details, ...list.filter((d) => !has(d.text))]) });

  return (
    <div className="space-y-2 text-sm">
      <p className="text-[11px] text-muted-foreground">
        Lỗ, lò xo, dây, móc kẹp… của sản phẩm danh mục này ({details.length} chi tiết). Không vẽ vào clipart phẳng (file gửi xưởng) — chỉ có trên bản vật liệu
        {props.hasMaterial ? "." : " — danh mục chưa chọn vật liệu nào (tab Vật liệu), nên chi tiết chưa được dùng."}
      </p>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <RefNoteBox
            refs={refs}
            onRefs={setRefs}
            note={detailsNote}
            onNote={(v) => props.onChange({ detailsNote: v })}
            onError={(m) => props.onError(m)}
            placeholder="Mô tả thành phẩm + thả ảnh sản phẩm thật, vd. ornament có lỗ đục, lò xo xỏ dây vàng; có bản có dây và bản không dây. Muốn chỉ chỗ: vẽ chấm / khoanh lên ảnh rồi ghi “chấm đỏ = lỗ”."
            saved={productRefs}
            onRemoveSaved={(u) => props.onChange({ productRefs: productRefs.filter((x) => x !== u) })}
            max={MAX_PRESET_REFS}
          />
          <CtButton className="w-full justify-center" onClick={() => void analyse()} disabled={writing || (!detailsNote.trim() && refs.length + productRefs.length === 0)}>
            {writing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} {details.length ? "Phân tích lại chi tiết" : "Phân tích chi tiết bằng AI"}
          </CtButton>
          <p className="text-[11px] text-muted-foreground">Ảnh thành phẩm chỉ gửi kèm bước vật liệu (không gửi khi vẽ clipart phẳng).</p>
        </div>
        <div className="space-y-2">
          {details.length ? (
            <SpecSummary specs={details} disabled={false} onRemove={(i) => props.onChange({ details: details.filter((_, k) => k !== i) })} />
          ) : (
            <p className="rounded-md border border-dashed px-3 py-2 text-center text-[11px] text-muted-foreground">Chưa có — bản vật liệu chỉ có vật liệu.</p>
          )}
          {others === null ? (
            <CtButton size="sm" variant="ghost" onClick={openPicker}>
              <Plus className="h-3.5 w-3.5" /> Lấy từ danh mục khác
            </CtButton>
          ) : (
            <div className="space-y-1.5 rounded-md border p-2">
              <CtSelect<string>
                value={sourceId}
                onChange={setSourceId}
                options={[
                  { value: "", label: others.length ? "— Chọn danh mục để chép chi tiết —" : "Chưa danh mục nào có chi tiết" },
                  ...others.map((x) => ({ value: x.id, label: `${x.name} (${x.rules.details.length})` })),
                ]}
              />
              {source && (
                <>
                  {source.rules.details.map((d, i) => (
                    <div key={i} className="flex items-start gap-2 text-[11px]">
                      <span className="flex-1">
                        <b>{d.mode === "version" ? `Bản thêm “${d.label}”: ` : "Luôn có: "}</b>
                        {d.text}
                      </span>
                      <CtButton size="sm" variant="ghost" disabled={has(d.text)} onClick={() => copy([d])}>
                        {has(d.text) ? "Đã có" : "Chép"}
                      </CtButton>
                    </div>
                  ))}
                  <div className="flex gap-1.5">
                    <CtButton size="sm" onClick={() => copy(source.rules.details)}>
                      Chép tất cả
                    </CtButton>
                    {source.rules.productRefs.length > 0 && (
                      <CtButton
                        size="sm"
                        variant="ghost"
                        onClick={() => props.onChange({ productRefs: [...new Set([...productRefs, ...source.rules.productRefs])].slice(0, MAX_PRESET_REFS) })}
                      >
                        + Chép {source.rules.productRefs.length} ảnh thành phẩm
                      </CtButton>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Category dialog "Tạo bằng AI": reference images + a note → @flexiprint → name, spec, style pack, materials,
 * details — the library's own presets when they fit.
 */
function PromptAssistant(props: { body: CtCategoryBody; onResult: (s: CtPromptSuggestion, refs: Array<Blob | string>) => Promise<void>; onClose: () => void }) {
  const [refs, setRefs] = useState<RefImage[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = useAgentStatus();
  const agent = useAgentTask();

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const refUrls = await Promise.all(refs.map((r) => ctApi.uploadPresetRef(r.blob)));
      const category = { id: null, name: props.body.name, spec: props.body.spec, rules: props.body.rules };
      const s = await agent.run<CtPromptSuggestion>("create", { category, note, images: [], refUrls });
      await props.onResult(s, refUrls);
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <RefNoteBox
        refs={refs}
        onRefs={setRefs}
        note={note}
        onNote={setNote}
        onError={setError}
        placeholder="Mô tả (tiếng Việt được), vd. xe chibi, mũ bảo hiểm góc trên bên phải, mặt trên mũ để trống cho khách gắn ảnh; vẽ kiểu sticker bóng, viền trắng; làm thêm bản acrylic trong."
      >
        <div className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5" />
          <span className="font-medium">Tạo bằng AI</span>
          <span className="text-[11px] text-muted-foreground">Dùng Tên và Spec đang có (nếu có) — trống thì AI tự đặt.</span>
          <span className="ml-auto shrink-0">
            <AgentBadge status={status} />
          </span>
          <button className="rounded p-1 text-muted-foreground hover:bg-accent" onClick={props.onClose} aria-label="Đóng">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </RefNoteBox>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {agent.task && <AgentProgress task={agent.task} onCancel={agent.cancel} onAnswer={agent.answer} />}
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground">
          Điền tất cả các tab (chưa lưu danh mục). Style pack / vật liệu có sẵn trong thư viện mà phù hợp thì được chọn lại; chỉ cái chưa có mới được tạo.
        </span>
        <CtButton size="sm" variant="primary" className="ml-auto shrink-0" onClick={() => void run()} disabled={busy || !status?.configured}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} {busy ? "Đang gửi @flexiprint…" : "Tạo"}
        </CtButton>
      </div>
    </div>
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

/** Select + "+" (new) + pencil (edit current). Also used by the AI dialog. */
export function SelectWithEdit<T extends string>({
  value,
  onChange,
  options,
  onNew,
  onEdit,
  newLabel,
  disabled,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
  onNew: () => void;
  onEdit?: () => void;
  newLabel: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex gap-1.5">
      <div className="min-w-0 flex-1">
        <CtSelect<T> value={value} onChange={onChange} options={options} disabled={disabled} />
      </div>
      {onEdit && (
        <CtTooltip label="Xem / sửa">
          <CtButton size="icon" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
          </CtButton>
        </CtTooltip>
      )}
      <CtTooltip label={newLabel}>
        <CtButton size="icon" onClick={onNew}>
          <Plus className="h-3.5 w-3.5" />
        </CtButton>
      </CtTooltip>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

function PresetsTab() {
  const [presets, setPresets] = useState<CtPreset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<CtPreset | CtPresetKind | null>(null);

  const load = useCallback(() => {
    ctApi
      .listPresets()
      .then((r) => setPresets(r.presets))
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  return (
    <div className="flex-1 overflow-y-auto p-4">
      {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
      <div className="grid gap-6 lg:grid-cols-2">
        {LIBRARY_KINDS.map((kind) => (
          <section key={kind}>
            <div className="mb-2 flex items-center">
              <h2 className="text-sm font-semibold">{KIND_LABEL[kind]}</h2>
              <CtButton size="sm" variant="ghost" className="ml-auto" onClick={() => setEdit(kind)}>
                <Plus className="h-3.5 w-3.5" /> Thêm
              </CtButton>
            </div>
            <div className="space-y-2">
              {presets
                .filter((p) => p.kind === kind)
                .map((p) => (
                  <button key={p.id} className="block w-full rounded-lg border p-2 text-left hover:bg-accent/50" onClick={() => setEdit(p)}>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{p.name}</span>
                      {p.user_id === null && <span className="rounded bg-muted px-1 text-[10px]">built-in</span>}
                    </div>
                    <p className="mt-1 line-clamp-3 text-[11px] text-muted-foreground">{p.prompt}</p>
                  </button>
                ))}
            </div>
          </section>
        ))}
      </div>
      {edit && <PresetDialog preset={typeof edit === "string" ? null : edit} kind={typeof edit === "string" ? edit : edit.kind} onClose={() => setEdit(null)} onSaved={load} />}
    </div>
  );
}

/** A new material: printed artwork kept as is, details read from the description later. */
const MATERIAL_PARAMS: CtPresetParams = { art: "print", specs: [] };

const PROMPT_HINT: Record<CtPresetKind, string> = {
  material:
    "Chỉ VẺ NGOÀI của vật liệu (trong / màu, độ dày, viền, bề mặt, ánh phản chiếu) + những lỗi cần tránh (no haze, no glow…). Giữ nguyên artwork, nền do hệ thống tự lo — không cần ghi. Lỗ, dây, móc… thuộc danh mục, không ghi ở đây.",
  style_pack:
    "Cách VẼ chung cho cả bộ: nét (dày / màu viền), đổ bóng, bảng màu, ánh sáng, bề mặt, mức chi tiết. Không nhắc tên vật — 1 style pack dùng lại được cho nhiều danh mục. Không ghi nền / khung / không chữ (tự thêm). Viết tiếng Anh.",
  scene: "Bối cảnh chụp mockup; dặn giữ nguyên sản phẩm.",
};

/** Style pack / material description: the reference photos also go to the image model. */
const MAX_PRESET_REFS = 6;

const DESCRIPTION_HINT: Record<"style_pack" | "material", string> = {
  material:
    "Chỉ VẬT LIỆU — dùng lại cho nhiều danh mục / sản phẩm: trong / màu, độ dày, viền, bề mặt. Lỗ, dây, móc… không ghi ở đây: chúng thuộc từng danh mục (“Chi tiết thành phẩm”). Mọi ảnh ở đây (cả ảnh đã lưu từ lần trước) đều gửi kèm model vẽ — đổi kiểu sản phẩm thì bấm × bỏ ảnh cũ.",
  style_pack: "Thả ảnh mẫu nét vẽ muốn có + mô tả. Mọi ảnh ở đây (cả ảnh đã lưu từ lần trước) đều gửi kèm model vẽ mọi clipart dùng style pack này — đổi phong cách thì bấm × bỏ ảnh cũ.",
};

const NOTE_PLACEHOLDER: Record<"style_pack" | "material", string> = {
  style_pack: "Mô tả chi tiết cách vẽ muốn có (tiếng Việt được), vd. sticker kawaii, viền nâu đậm dày, tô bóng mềm, màu pastel kẹo ngọt, bề mặt bóng như nhựa…",
  material:
    "Mô tả vật liệu (tiếng Việt được) + thả ảnh mẫu, vd. acrylic trong suốt 3mm, viền mảnh sáng bóng, không mờ đục…",
};

/** What becomes of the printed artwork — the AI reads it from the description (shown, not picked). */
const ART_LABEL: Record<CtMaterialArt, string> = {
  print: "hình in giữ nguyên, vật liệu bao quanh",
  surface: "vật liệu phủ lên hình (glitter, thêu, foil…)",
};

/**
 * Product details (hole, cord, a clip, a handle…) as the AI read them — shown, not edited: change the description
 * and analyse again. Each is on every material version, or one more version of it.
 */
function SpecSummary(props: { specs: CtMaterialSpec[]; disabled: boolean; onRemove: (i: number) => void }) {
  return (
    <div className="space-y-1 text-xs">
      {props.specs.map((x, i) => (
        <div key={i} className="flex items-start gap-2 rounded-md border px-2 py-1.5">
          <span className={cx("mt-px shrink-0 rounded px-1 text-[10px]", x.mode === "version" ? "bg-violet-500/15 text-violet-600" : "bg-muted text-muted-foreground")}>
            {x.mode === "version" ? `bản thêm: ${x.label}` : "luôn có"}
          </span>
          <span className="flex-1">{x.text}</span>
          {!props.disabled && (
            <button className="rounded p-0.5 text-muted-foreground hover:bg-accent" onClick={() => props.onRemove(i)} title="Bỏ chi tiết này">
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** A preset's / category's saved reference photos: the image model gets them, not only the prompt writer. */
function SavedRefs(props: {
  label: string;
  hint: string;
  urls: string[];
  pending: number;
  disabled: boolean;
  onRemove: (url: string) => void;
  /** Adds photos (uploaded by the caller); shows an "add" tile. */
  onAdd?: (files: File[]) => Promise<void>;
  onError?: (msg: string) => void;
  /** Show the field even without photos. */
  always?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  if (!props.urls.length && !props.pending && !props.onAdd && !props.always) return null;
  const add = async (files: File[]) => {
    if (!props.onAdd) return;
    setAdding(true);
    try {
      await props.onAdd(files);
    } catch (e) {
      props.onError?.(e instanceof Error ? e.message : "Không tải được ảnh");
    } finally {
      setAdding(false);
    }
  };
  return (
    <CtField label={props.label} hint={props.hint}>
      <div className="flex flex-wrap gap-1.5">
        {props.urls.map((u) => (
          <div key={u} className="relative h-14 w-14 overflow-hidden rounded border">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={u} alt="" className="h-full w-full object-cover" />
            {!props.disabled && (
              <button className="absolute right-0.5 top-0.5 rounded bg-black/60 p-0.5 text-white" onClick={() => props.onRemove(u)} title="Bỏ ảnh mẫu">
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}
        {props.onAdd && props.urls.length < 6 && (
          <label className="flex h-14 w-14 cursor-pointer flex-col items-center justify-center gap-0.5 rounded border border-dashed text-[10px] text-muted-foreground hover:bg-accent">
            {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />} thêm
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              className="hidden"
              disabled={adding}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (files.length) void add(files);
              }}
            />
          </label>
        )}
        {props.always && !props.urls.length && !props.onAdd && <span className="text-[11px] text-muted-foreground">(không có)</span>}
        {props.pending > 0 && <span className="self-center text-[11px] text-muted-foreground">+ {props.pending} ảnh mới (lưu khi bấm Lưu)</span>}
      </div>
    </CtField>
  );
}

const HISTORY_TIME = new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short" });

/**
 * How a style pack / material came to be (ct_preset_history): every AI analysis — the description and photos it
 * read, what it wrote — and every save. Kept for people and for agents working on the preset later.
 */
function PresetHistory(props: { history: CtPresetHistoryEntry[]; disabled: boolean; onReuse: (h: CtPresetHistoryEntry) => void }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const analyses = props.history.filter((h) => h.event === "analysis").length;
  return (
    <div className="rounded-md border">
      <button className="flex w-full items-center gap-1 px-2 py-1.5 text-[11px] font-medium" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <History className="h-3 w-3" /> Lịch sử ({analyses} lần phân tích, {props.history.length - analyses} lần lưu)
      </button>
      {open && (
        <div className="max-h-80 space-y-1.5 overflow-y-auto border-t p-2">
          {props.history.map((h) => {
            const more = expanded === h.id;
            const specs = h.result.specs ?? h.result.params?.specs ?? [];
            return (
              <div key={h.id} className="space-y-1 rounded border p-2 text-[11px]">
                <div className="flex items-center gap-1.5">
                  <span className={cx("rounded px-1 text-[10px]", h.event === "analysis" ? "bg-sky-500/15 text-sky-600" : "bg-emerald-500/15 text-emerald-600")}>
                    {h.event === "analysis" ? "Phân tích AI" : "Đã lưu"}
                  </span>
                  <span className="text-muted-foreground">{HISTORY_TIME.format(new Date(h.created_at))}</span>
                  {!h.preset_id && <span className="text-muted-foreground">· chưa lưu</span>}
                  <span className="flex-1" />
                  <button className="text-muted-foreground hover:text-foreground" onClick={() => setExpanded(more ? null : h.id)}>
                    {more ? "Thu gọn" : "Chi tiết"}
                  </button>
                  {!props.disabled && h.event === "analysis" && (
                    <button className="font-medium text-sky-600 hover:underline" onClick={() => props.onReuse(h)} title="Lấy lại mô tả, ảnh và kết quả của lần này (bấm Lưu để giữ)">
                      Dùng lại
                    </button>
                  )}
                </div>
                {h.note && <p className={cx("whitespace-pre-line", !more && "line-clamp-2")}>{h.note}</p>}
                {h.ref_urls.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {h.ref_urls.map((u) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={u} src={u} alt="" className="h-9 w-9 rounded border object-cover" />
                    ))}
                  </div>
                )}
                {more && (
                  <div className="space-y-1 border-t pt-1 text-muted-foreground">
                    <p>
                      <span className="font-medium text-foreground">Prompt:</span> {h.result.prompt}
                    </p>
                    {specs.map((x, i) => (
                      <p key={i}>
                        <span className="font-medium text-foreground">{x.mode === "version" ? `Bản thêm “${x.label}”:` : "Luôn có:"}</span> {x.text}
                      </p>
                    ))}
                    {h.input.prompt && h.event === "analysis" && <p className="line-clamp-3">Prompt trước đó: {h.input.prompt}</p>}
                    {h.model && <p>Model: {h.model}</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Create / edit a preset. Style pack / material: one description (text + reference photos) the AI turns into the
 * prompt — and, for a material, its details (hole, cord…) and what becomes of the artwork. The prompt stays
 * editable. `onSaved` gets the saved preset, or null after a delete.
 */
export function PresetDialog(props: { preset: CtPreset | null; kind: CtPresetKind; onClose: () => void; onSaved: (saved: CtPreset | null) => void }) {
  const p = props.preset;
  const [body, setBody] = useState<CtPresetBody>(() => ({
    kind: props.kind,
    name: p?.name ?? "",
    prompt: p?.prompt ?? "",
    reference_asset_ids: p?.reference_asset_ids ?? [],
    // A material from before `art` moves to the current pipeline (artwork kept, details as versions) on save.
    params: p ? (p.kind === "material" && !p.params.art ? { ...p.params, art: "print" } : p.params) : props.kind === "material" ? MATERIAL_PARAMS : {},
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readOnly = p !== null && !p.can_edit;
  const kind = props.kind === "scene" ? null : props.kind;
  const [refs, setRefs] = useState<RefImage[]>([]);
  const [writing, setWriting] = useState(false);
  /** Analyses + saves of this preset (server), and analyses made here before it exists (preset_id null). */
  const [history, setHistory] = useState<CtPresetHistoryEntry[]>([]);
  const note = body.params.note ?? "";
  const savedRefs = body.params.refs ?? [];
  const setParams = (patch: Partial<CtPresetParams>) => setBody((b) => ({ ...b, params: { ...b.params, ...patch } }));

  useEffect(() => {
    if (!p || props.kind === "scene") return;
    ctApi
      .presetHistory(p.id)
      .then((h) => setHistory((cur) => [...cur, ...h.filter((x) => !cur.some((c) => c.id === x.id))]))
      .catch(() => undefined);
  }, [p, props.kind]);

  const write = async () => {
    if (!kind) return;
    setWriting(true);
    setError(null);
    try {
      // Photos are uploaded first: the analysis is recorded with their urls (history), and they are the preset's anyway.
      const uploaded = await Promise.all(refs.map((r) => ctApi.uploadPresetRef(r.blob)));
      refs.forEach((r) => URL.revokeObjectURL(r.preview));
      setRefs([]);
      const urls = [...savedRefs, ...uploaded].slice(0, MAX_PRESET_REFS);
      setParams({ refs: urls });
      const s = await ctApi.suggestPresetPrompt({ kind, presetId: p?.id ?? null, name: body.name, note, prompt: body.prompt, images: [], savedRefs: urls });
      setBody((b) => ({
        ...b,
        name: b.name.trim() || s.name,
        prompt: s.prompt,
        // Materials: the details and what becomes of the artwork come with the prompt.
        params: kind === "material" ? { ...b.params, art: s.art ?? b.params.art ?? "print" } : b.params,
      }));
      const entry = s.history;
      if (entry) setHistory((h) => [entry, ...h]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi");
    } finally {
      setWriting(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      let params: CtPresetParams = body.params;
      if (kind) {
        // The reference photos of the description go to the image model too: saved with the preset.
        const uploaded = await Promise.all(refs.map((r) => ctApi.uploadPresetRef(r.blob)));
        params = { ...params, refs: [...savedRefs, ...uploaded].slice(0, MAX_PRESET_REFS) };
      }
      if (kind === "material") params = { ...params, specs: normalizeMaterialSpecs(params.specs ?? []) };
      const next: CtPresetBody = { ...body, params, history_ids: p ? undefined : history.filter((h) => !h.preset_id).map((h) => h.id) };
      const saved = p ? await ctApi.updatePreset(p.id, next) : await ctApi.createPreset(next);
      props.onSaved(saved);
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!p || !(await ctConfirm({ title: `Xoá preset “${p.name}”?`, tone: "danger", confirmLabel: "Xoá" }))) return;
    try {
      await ctApi.deletePreset(p.id);
      props.onSaved(null);
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi");
    }
  };

  /** Back to an earlier analysis: its description, photos and result (saved only with Lưu). */
  const reuse = (h: CtPresetHistoryEntry) => {
    refs.forEach((r) => URL.revokeObjectURL(r.preview));
    setRefs([]);
    setBody((b) => ({
      ...b,
      prompt: h.result.prompt || b.prompt,
      params: {
        ...b.params,
        note: h.note,
        refs: h.ref_urls,
        ...(kind === "material" ? { art: h.result.art ?? h.result.params?.art ?? b.params.art } : {}),
      },
    }));
  };

  /** Details saved on the material by an older version — they belong to the category now (migration 009). */
  const legacySpecs = body.params.specs ?? [];
  return (
    <CtModal open onOpenChange={(o) => !o && props.onClose()} title={`${KIND_LABEL[props.kind]}${p ? `: ${p.name}` : " mới"}`}>
      <div className="space-y-3 text-sm">
        <CtField label="Tên">
          <CtInput value={body.name} disabled={readOnly} onChange={(e) => setBody({ ...body, name: e.target.value })} />
        </CtField>
        {kind && (
          <CtField
            label={`${kind === "material" ? "Mô tả vật liệu" : "Mô tả cách vẽ"} · ảnh tham khảo ${savedRefs.length + refs.length}/${MAX_PRESET_REFS}`}
            hint={DESCRIPTION_HINT[kind]}
          >
            <div className="space-y-2">
              <RefNoteBox
                refs={refs}
                onRefs={setRefs}
                note={note}
                onNote={(v) => setParams({ note: v })}
                onError={setError}
                placeholder={NOTE_PLACEHOLDER[kind]}
                saved={savedRefs}
                onRemoveSaved={(u) => setParams({ refs: savedRefs.filter((x) => x !== u) })}
                max={MAX_PRESET_REFS}
                disabled={readOnly}
              />
              {!readOnly && (
                <CtButton variant="primary" className="w-full justify-center" onClick={() => void write()} disabled={writing || (!note.trim() && refs.length + savedRefs.length === 0)}>
                  {writing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}{" "}
                  {body.prompt.trim() ? "Phân tích lại" : "Phân tích bằng AI"}
                </CtButton>
              )}
            </div>
          </CtField>
        )}
        {kind === "material" && body.params.art && <p className="text-xs text-muted-foreground">Hình in: {ART_LABEL[body.params.art]}.</p>}
        {kind === "material" && legacySpecs.length > 0 && (
          <CtField
            label={`Chi tiết cũ của vật liệu (${legacySpecs.length})`}
            hint="Chi tiết (lỗ, dây, móc…) giờ thuộc từng danh mục — mục “Chi tiết thành phẩm” trong dialog danh mục. Migration 009 chép các dòng này sang các danh mục đang dùng vật liệu này rồi xoá ở đây."
          >
            <SpecSummary specs={legacySpecs} disabled={readOnly} onRemove={(i) => setParams({ specs: legacySpecs.filter((_, k) => k !== i) })} />
          </CtField>
        )}
        <CtField label="Prompt" hint={PROMPT_HINT[props.kind]}>
          <CtTextarea
            rows={kind ? 5 : 9}
            value={body.prompt}
            disabled={readOnly}
            onChange={(e) => setBody({ ...body, prompt: e.target.value })}
            placeholder={kind ? "AI viết prompt ở đây sau khi phân tích — sửa tay được." : undefined}
          />
        </CtField>
        {kind && history.length > 0 && <PresetHistory history={history} disabled={readOnly} onReuse={reuse} />}
        {readOnly && <p className="text-xs text-muted-foreground">Preset built-in / của người khác — chỉ admin sửa được.</p>}
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex gap-2">
          {p?.can_edit && (
            <CtButton variant="ghost" className="text-destructive" onClick={() => void remove()}>
              <Trash2 className="h-3.5 w-3.5" /> Xoá
            </CtButton>
          )}
          <span className="flex-1" />
          <CtButton onClick={props.onClose}>Đóng</CtButton>
          {!readOnly && (
            <CtButton variant="primary" onClick={() => void save()} disabled={busy || writing || !body.name.trim() || !body.prompt.trim()}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Lưu
            </CtButton>
          )}
        </div>
      </div>
    </CtModal>
  );
}
