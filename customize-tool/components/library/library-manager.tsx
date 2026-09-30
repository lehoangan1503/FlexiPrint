"use client";

/**
 * /library — manage the global clipart library (migration 006):
 *
 *   Clipart  category tree (usage, mode, shared spec + generation rules) and
 *            the cliparts in it: origins with their set members / renditions.
 *   Preset   reusable prompts: style packs, materials, scenes — what the
 *            ComfyUI studio nodes (services/comfy) offer in their dropdowns.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, FolderPlus, ImagePlus, Loader2, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import type {
  CtAsset,
  CtCategoryAnchor,
  CtCategoryBackground,
  CtCategoryBody,
  CtCategoryMode,
  CtCategoryUsage,
  CtClipartCategory,
  CtClipartUsage,
  CtPreset,
  CtPresetBody,
  CtPresetKind,
} from "../../types";
import { ctApi } from "../../lib/api-client";
import { defaultCategoryRules, flattenCategories, libraryOrigins, renditionOf, setMembers } from "../../lib/library";
import { CHECKER_STYLE, CtButton, CtCheckbox, CtField, CtInput, CtModal, CtNumber, CtSelect, CtTextarea, CtTooltipProvider, cx } from "../ui";

type Tab = "cliparts" | "presets";
const NONE = "none";

const USAGE_OPTIONS: Array<{ value: CtCategoryUsage; label: string }> = [
  { value: "element", label: "Element — đặt vào vùng (bánh bao, nón, hobby…)" },
  { value: "main", label: "Main object — phôi chính (xửng, xe, ornament…)" },
];
const MODE_OPTIONS: Array<{ value: CtCategoryMode; label: string }> = [
  { value: "origin_set", label: "Bộ gốc — nhiều clipart gốc cùng loại, khác hình" },
  { value: "variant_set", label: "Bộ biến thể — 1 hình, nhiều màu / style" },
];
const ANCHOR_OPTIONS: Array<{ value: CtCategoryAnchor; label: string }> = [
  { value: "center", label: "Giữa" },
  { value: "bottom", label: "Đáy (đứng trên mặt)" },
];
const BACKGROUND_OPTIONS: Array<{ value: CtCategoryBackground; label: string }> = [
  { value: "cutout", label: "Tách nền (BiRefNet)" },
  { value: "transparent", label: "Model trả nền trong suốt" },
  { value: "none", label: "Giữ nền" },
];
const KIND_LABEL: Record<CtPresetKind, string> = { style_pack: "Style pack", material: "Vật liệu", scene: "Scene mockup" };

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
                ["presets", "Preset (style / vật liệu / scene)"],
              ] as Array<[Tab, string]>
            ).map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)} className={cx("rounded px-3 py-1 text-xs font-medium", tab === k ? "bg-foreground text-background" : "hover:bg-accent")}>
                {label}
              </button>
            ))}
          </div>
          <Link href="/studio" className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs hover:bg-accent">
            <Sparkles className="h-3.5 w-3.5" /> Mở Studio (ComfyUI)
          </Link>
        </header>
        {tab === "cliparts" ? <ClipartsTab /> : <PresetsTab />}
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
  const [selected, setSelected] = useState<string>(NONE);
  const [cliparts, setCliparts] = useState<CtAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editCategory, setEditCategory] = useState<CtClipartCategory | "new" | null>(null);
  const [editClipart, setEditClipart] = useState<CtAsset | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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
      .listPresets("style_pack")
      .then((r) => setStylePacks(r.presets))
      .catch(() => setStylePacks([]));
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
              <span className={cx("rounded px-1 text-[10px]", c.usage === "main" ? "bg-amber-500/15 text-amber-600" : "bg-sky-500/15 text-sky-600")}>
                {c.usage === "main" ? "main" : "element"}
              </span>
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
                {current.usage === "main" ? "Main object" : "Element"} · {current.mode === "variant_set" ? "bộ biến thể" : "bộ gốc"} · canvas {current.rules.canvas.w}×
                {current.rules.canvas.h} · fill {Math.round(current.rules.fill * 100)}% · {current.rules.lockSilhouette ? "khoá silhouette" : "không khoá silhouette"}
                {current.rules.variantAxes.length > 0 && ` · trục: ${current.rules.variantAxes.join(", ")}`}
              </p>
            )}
            {current?.spec && <p className="mt-1 max-w-3xl whitespace-pre-line text-xs">{current.spec}</p>}
          </div>
          <UploadButton label="Upload clipart gốc" onFiles={(f) => void upload(f, null)} disabled={busy !== null} />
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
          <p className="py-10 text-center text-sm text-muted-foreground">Danh mục trống. Upload clipart, hoặc tạo trong Studio (ComfyUI) rồi lưu vào danh mục này.</p>
        ) : (
          <div className="space-y-3">
            {origins.map((o) => {
              const members = setMembers(cliparts, o.id);
              const rendition = renditionOf(cliparts, o.id);
              return (
                <div key={o.id} className="flex gap-3 rounded-lg border p-2">
                  <Thumb asset={o} big onClick={() => setEditClipart(o)} />
                  {rendition && <Thumb asset={rendition} big label="vật liệu" onClick={() => setEditClipart(rendition)} />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{o.name || "(không tên)"}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {o.width}×{o.height} · {o.source}
                      </span>
                      <span className="ml-auto" />
                      <UploadButton label="+ biến thể" small onFiles={(f) => void upload(f, o.id)} disabled={busy !== null} />
                    </div>
                    {o.spec && <p className="line-clamp-2 text-[11px] text-muted-foreground">{o.spec}</p>}
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {members.map((m) => (
                        <Thumb key={m.id} asset={m} onClick={() => setEditClipart(m)} />
                      ))}
                      {members.length === 0 && <span className="text-[11px] text-muted-foreground">Chưa có biến thể.</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {editCategory && (
        <CategoryDialog
          category={editCategory === "new" ? null : editCategory}
          categories={categories}
          stylePacks={stylePacks}
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

function Thumb({ asset, big, label, onClick }: { asset: CtAsset; big?: boolean; label?: string; onClick: () => void }) {
  return (
    <button
      className={cx("relative shrink-0 overflow-hidden rounded border hover:ring-2 hover:ring-sky-500", big ? "h-28 w-28" : "h-16 w-16")}
      style={CHECKER_STYLE}
      onClick={onClick}
      title={asset.name}
    >
      <img src={asset.url} alt={asset.name} className="h-full w-full object-contain" loading="lazy" />
      {label && <span className="absolute bottom-0.5 left-0.5 rounded bg-violet-600/90 px-1 text-[10px] text-white">{label}</span>}
      {asset.source === "ai" && <span className="absolute left-0.5 top-0.5 rounded bg-sky-600/90 px-1 text-[10px] text-white">AI</span>}
    </button>
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

function CategoryDialog(props: {
  category: CtClipartCategory | null;
  categories: CtClipartCategory[];
  stylePacks: CtPreset[];
  onClose: () => void;
  onSaved: (c: CtClipartCategory) => void;
  onDeleted: () => void;
}) {
  const c = props.category;
  const [body, setBody] = useState<CtCategoryBody>(() => ({
    name: c?.name ?? "",
    parent_id: c?.parent_id ?? null,
    usage: c?.usage ?? "element",
    mode: c?.mode ?? "origin_set",
    spec: c?.spec ?? "",
    rules: c?.rules ?? defaultCategoryRules(),
  }));
  const [axes, setAxes] = useState((c?.rules.variantAxes ?? []).join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<CtCategoryBody>) => setBody((b) => ({ ...b, ...patch }));
  const setRules = (patch: Partial<CtCategoryBody["rules"]>) => setBody((b) => ({ ...b, rules: { ...b.rules, ...patch } }));

  const parents = useMemo(
    () => [
      { value: NONE, label: "(gốc)" },
      ...flattenCategories(props.categories)
        .filter(({ category: x }) => x.id !== c?.id)
        .map(({ category: x, depth }) => ({ value: x.id, label: `${"— ".repeat(depth)}${x.name}` })),
    ],
    [props.categories, c],
  );

  const save = async () => {
    setBusy(true);
    setError(null);
    const payload: CtCategoryBody = { ...body, rules: { ...body.rules, variantAxes: axes.split(",").map((a) => a.trim()).filter(Boolean) } };
    try {
      const saved = c ? await ctApi.updateCategory(c.id, payload) : await ctApi.createCategory(payload);
      props.onSaved(saved);
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!c || !window.confirm(`Xoá danh mục “${c.name}”?`)) return;
    try {
      await ctApi.deleteCategory(c.id);
      props.onDeleted();
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi");
    }
  };

  return (
    <CtModal open onOpenChange={(o) => !o && props.onClose()} title={c ? `Danh mục: ${c.name}` : "Danh mục mới"} wide>
      <div className="grid grid-cols-2 gap-4 text-sm">
        <div className="space-y-3">
          <CtField label="Tên">
            <CtInput value={body.name} onChange={(e) => set({ name: e.target.value })} placeholder="vd. Dumpling glitter" />
          </CtField>
          <CtField label="Danh mục cha">
            <CtSelect<string> value={body.parent_id ?? NONE} onChange={(v) => set({ parent_id: v === NONE ? null : v })} options={parents} />
          </CtField>
          <CtField label="Dùng làm" hint="Main = phôi (mỗi clipart gốc là 1 version main). Element = đặt vào vùng custom.">
            <CtSelect<CtCategoryUsage> value={body.usage} onChange={(usage) => set({ usage })} options={USAGE_OPTIONS} />
          </CtField>
          <CtField label="Kiểu bộ" hint="Bộ gốc: mỗi clipart là 1 hình riêng cùng chủng loại (6 mẫu xe). Bộ biến thể: 1 clipart gốc + nhiều màu/style giữ nguyên hình.">
            <CtSelect<CtCategoryMode> value={body.mode} onChange={(mode) => set({ mode })} options={MODE_OPTIONS} />
          </CtField>
          <CtField label="Spec chung (prompt cho cả danh mục)" hint="Được ghép vào prompt của mọi clipart tạo trong danh mục này (Studio).">
            <CtTextarea rows={6} value={body.spec} onChange={(e) => set({ spec: e.target.value })} placeholder="vd. A round steamed bun (baozi) with pleated top, soft squishy body, kawaii face area left blank…" />
          </CtField>
        </div>
        <div className="space-y-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Rule tạo clipart</p>
          <div className="grid grid-cols-3 gap-2">
            <CtField label="Canvas W">
              <CtNumber value={body.rules.canvas.w} min={64} max={4096} onChange={(w) => setRules({ canvas: { ...body.rules.canvas, w } })} />
            </CtField>
            <CtField label="Canvas H">
              <CtNumber value={body.rules.canvas.h} min={64} max={4096} onChange={(h) => setRules({ canvas: { ...body.rules.canvas, h } })} />
            </CtField>
            <CtField label="Fill (0.1–1)">
              <CtNumber value={body.rules.fill} step={0.05} min={0.1} max={1} onChange={(fill) => setRules({ fill })} />
            </CtField>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <CtField label="Neo">
              <CtSelect<CtCategoryAnchor> value={body.rules.anchor} onChange={(anchor) => setRules({ anchor })} options={ANCHOR_OPTIONS} />
            </CtField>
            <CtField label="Nền">
              <CtSelect<CtCategoryBackground> value={body.rules.background} onChange={(background) => setRules({ background })} options={BACKGROUND_OPTIONS} />
            </CtField>
          </div>
          <CtCheckbox
            checked={body.rules.lockSilhouette}
            onChange={(lockSilhouette) => setRules({ lockSilhouette })}
            label="Khoá silhouette cho biến thể / vật liệu"
            hint="Biến thể và bản vật liệu AI được ép lại đúng alpha của clipart gốc — cùng đường viền, cùng kích thước, thay nhau được trong 1 vùng."
          />
          <CtField label="Trục biến thể" hint="Cách nhau bằng dấu phẩy, vd. color, style">
            <CtInput value={axes} onChange={(e) => setAxes(e.target.value)} />
          </CtField>
          <CtField label="Style pack mặc định">
            <CtSelect<string>
              value={body.rules.stylePackId ?? NONE}
              onChange={(v) => setRules({ stylePackId: v === NONE ? null : v })}
              options={[{ value: NONE, label: "(không)" }, ...props.stylePacks.map((p) => ({ value: p.id, label: p.name }))]}
            />
          </CtField>
        </div>
      </div>
      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
      <div className="mt-4 flex gap-2">
        {c?.can_edit && (
          <CtButton variant="ghost" className="text-destructive" onClick={() => void remove()}>
            <Trash2 className="h-3.5 w-3.5" /> Xoá
          </CtButton>
        )}
        <span className="flex-1" />
        <CtButton onClick={props.onClose}>Huỷ</CtButton>
        <CtButton variant="primary" onClick={() => void save()} disabled={busy || !body.name.trim()}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Lưu
        </CtButton>
      </div>
    </CtModal>
  );
}

function ClipartDialog(props: {
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
  const usageKind: CtCategoryUsage = a.role === "main" ? "main" : "element";

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
    if (!window.confirm(isOrigin ? `Xoá “${a.name}” và toàn bộ biến thể của nó khỏi thư viện?` : `Xoá “${a.name}” khỏi thư viện?`)) return;
    setBusy(true);
    try {
      await ctApi.deleteClipart(a.id);
      props.onDeleted(a.id);
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi");
    } finally {
      setBusy(false);
    }
  };

  return (
    <CtModal open onOpenChange={(o) => !o && props.onClose()} title={isOrigin ? "Clipart gốc" : a.role === "rendition" ? "Bản vật liệu" : "Biến thể"} wide>
      <div className="grid grid-cols-[320px_1fr] gap-4 text-sm">
        <div className="aspect-square overflow-hidden rounded-lg border" style={CHECKER_STYLE}>
          <img src={a.url} alt={a.name} className="h-full w-full object-contain" />
        </div>
        <div className="space-y-3">
          <p className="text-[11px] text-muted-foreground">
            {a.role} · {a.width}×{a.height} · nguồn {a.source}
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
            <CtField label="Danh mục" hint="Biến thể và bản vật liệu đi theo clipart gốc.">
              <CtSelect<string>
                value={category}
                onChange={setCategory}
                options={[
                  { value: NONE, label: "Chưa phân loại" },
                  ...flattenCategories(props.categories)
                    .filter(({ category: c }) => c.usage === usageKind)
                    .map(({ category: c, depth }) => ({ value: c.id, label: `${"— ".repeat(depth)}${c.name}` })),
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
            <CtButton variant="ghost" className="text-destructive" onClick={() => void remove()} disabled={busy || (usage?.length ?? 0) > 0}>
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
      <div className="grid gap-6 lg:grid-cols-3">
        {(Object.keys(KIND_LABEL) as CtPresetKind[]).map((kind) => (
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
                      {p.params.lockSilhouette && <span className="rounded bg-violet-500/15 px-1 text-[10px] text-violet-600">khoá silhouette</span>}
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

function PresetDialog(props: { preset: CtPreset | null; kind: CtPresetKind; onClose: () => void; onSaved: () => void }) {
  const p = props.preset;
  const [body, setBody] = useState<CtPresetBody>(() => ({
    kind: props.kind,
    name: p?.name ?? "",
    prompt: p?.prompt ?? "",
    reference_asset_ids: p?.reference_asset_ids ?? [],
    params: p?.params ?? { lockSilhouette: props.kind === "material" },
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readOnly = p !== null && !p.can_edit;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (p) await ctApi.updatePreset(p.id, body);
      else await ctApi.createPreset(body);
      props.onSaved();
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!p || !window.confirm(`Xoá preset “${p.name}”?`)) return;
    try {
      await ctApi.deletePreset(p.id);
      props.onSaved();
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi");
    }
  };

  return (
    <CtModal open onOpenChange={(o) => !o && props.onClose()} title={`${KIND_LABEL[props.kind]}${p ? `: ${p.name}` : " mới"}`}>
      <div className="space-y-3 text-sm">
        <CtField label="Tên">
          <CtInput value={body.name} disabled={readOnly} onChange={(e) => setBody({ ...body, name: e.target.value })} />
        </CtField>
        <CtField
          label="Prompt"
          hint={
            props.kind === "material"
              ? "Mô tả VẬT LIỆU thôi — luôn dặn giữ nguyên hình, màu, chữ, kích thước. Node FP Material ép lại alpha gốc khi bật khoá silhouette."
              : props.kind === "style_pack"
                ? "Cách vẽ chung cho cả bộ clipart (nét, màu, ánh sáng, độ bóng). Ghép trước prompt của danh mục và của từng clipart."
                : "Bối cảnh chụp mockup; dặn giữ nguyên sản phẩm."
          }
        >
          <CtTextarea rows={9} value={body.prompt} disabled={readOnly} onChange={(e) => setBody({ ...body, prompt: e.target.value })} />
        </CtField>
        {props.kind === "material" && (
          <CtCheckbox
            checked={Boolean(body.params.lockSilhouette)}
            onChange={(lockSilhouette) => setBody({ ...body, params: { ...body.params, lockSilhouette } })}
            label="Khoá silhouette"
            hint="Kết quả AI được resize về đúng kích thước và cắt theo alpha của ảnh gốc."
          />
        )}
        <CtField label="Model ưu tiên (tuỳ chọn)" hint="vd. gpt-image-2, fal-ai/nano-banana/edit — để trống thì node tự chọn.">
          <CtInput value={body.params.model ?? ""} disabled={readOnly} onChange={(e) => setBody({ ...body, params: { ...body.params, model: e.target.value } })} />
        </CtField>
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
            <CtButton variant="primary" onClick={() => void save()} disabled={busy || !body.name.trim() || !body.prompt.trim()}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Lưu
            </CtButton>
          )}
        </div>
      </div>
    </CtModal>
  );
}
