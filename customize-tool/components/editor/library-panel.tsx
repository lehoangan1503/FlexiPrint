"use client";

/**
 * "Thư viện" tab of the asset sidebar: browse the global clipart library
 * (migration 006) and use cliparts in this product.
 *
 *   element origin  → "Đặt vào vùng": becomes an option group of the selected
 *                     custom layer (its set members are the options)
 *   main origin     → "Thêm làm version": a main version of this product
 *
 * Nothing is copied: the product references the library clipart, so a colour
 * added to the set later shows up here too (after the next Publish on the
 * storefront). Managing categories / presets lives on /library.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Crown, ExternalLink, ImagePlus, Library, Loader2, MapPinned, Search, Sparkles } from "lucide-react";
import type { CtAsset, CtClipartCategory } from "../../types";
import { ctApi } from "../../lib/api-client";
import { flattenCategories, libraryOrigins, renditionOf, setMembers } from "../../lib/library";
import { openStudio } from "../../lib/studio-link";
import { CHECKER_STYLE, CtButton, CtInput, CtSelect, CtTooltip, cx } from "../ui";

export interface LibraryPanelProps {
  canPlace: boolean;
  /** Ids of assets this product already renders (marks "đang dùng"). */
  usedIds: Set<string>;
  onPlace: (origin: CtAsset, family: CtAsset[]) => void;
  onAddMain: (main: CtAsset) => void;
}

const ALL = "__all";
const NONE = "none";

export function LibraryPanel(props: LibraryPanelProps) {
  const [categories, setCategories] = useState<CtClipartCategory[]>([]);
  const [uncategorized, setUncategorized] = useState(0);
  const [category, setCategory] = useState<string>(ALL);
  const [q, setQ] = useState("");
  const [cliparts, setCliparts] = useState<CtAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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
      .listCliparts(category === ALL ? null : category, q.trim())
      .then(setCliparts)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [category, q]);

  // Debounced so typing a search doesn't fire a request per key.
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  // Back from the studio tab: show what it just saved.
  useEffect(() => {
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  const options = useMemo(
    () => [
      { value: ALL, label: "Tất cả danh mục" },
      ...flattenCategories(categories).map(({ category: c, depth }) => ({
        value: c.id,
        label: `${"— ".repeat(depth)}${c.name} (${c.count ?? 0})${c.usage === "main" ? " · main" : ""}`,
      })),
      ...(uncategorized ? [{ value: NONE, label: `Chưa phân loại (${uncategorized})` }] : []),
    ],
    [categories, uncategorized],
  );
  const current = categories.find((c) => c.id === category) ?? null;
  const origins = libraryOrigins(cliparts);

  const uploadOrigins = async (files: File[]) => {
    setBusy(`Đang upload ${files.length} ảnh…`);
    try {
      const created: CtAsset[] = [];
      for (const f of files) created.push(await ctApi.uploadClipart(f, { categoryId: current?.id ?? null }));
      setCliparts((list) => [...list, ...created]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload thất bại");
    } finally {
      setBusy(null);
    }
  };

  const uploadMembers = async (origin: CtAsset, files: File[]) => {
    setBusy(`Đang upload ${files.length} biến thể…`);
    try {
      const created: CtAsset[] = [];
      for (const f of files) created.push(await ctApi.uploadClipart(f, { categoryId: origin.category_id, parentId: origin.id }));
      setCliparts((list) => [...list, ...created]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload thất bại");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex h-full flex-col text-sm">
      <div className="space-y-1.5 border-b p-2">
        <CtSelect<string> value={category} onChange={setCategory} options={options} />
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
          <CtInput className="pl-7" placeholder="Tìm tên, mô tả, tag…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="flex items-center gap-1.5">
          <UploadButton label={current ? "Upload vào danh mục" : "Upload"} onFiles={(f) => void uploadOrigins(f)} disabled={busy !== null} />
          <CtTooltip label="Quản lý danh mục, rule, preset">
            <Link href="/library" target="_blank" className="inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs hover:bg-accent">
              <Library className="h-3.5 w-3.5" /> Quản lý
            </Link>
          </CtTooltip>
          <CtTooltip label="Tạo clipart mới bằng AI trong Studio (vào đúng danh mục đang chọn)">
            <CtButton
              size="sm"
              onClick={() => openStudio({ template: current?.usage === "main" ? "01-origin-set" : current ? "03-element-pack" : "01-origin-set", category: current?.id ?? null })}
            >
              <Sparkles className="h-3.5 w-3.5" /> Tạo AI
            </CtButton>
          </CtTooltip>
        </div>
        {current && (current.spec || current.mode === "variant_set") && (
          <p className="line-clamp-3 text-[11px] leading-snug text-muted-foreground">
            {current.mode === "variant_set" ? "Bộ biến thể: 1 silhouette nhiều màu/style. " : "Bộ clipart gốc cùng loại. "}
            {current.spec}
          </p>
        )}
        {busy && (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> {busy}
          </span>
        )}
        {error && <p className="text-[11px] text-destructive">{error}</p>}
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto p-2">
        {loading && origins.length === 0 ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : origins.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">
            Chưa có clipart. Upload vào danh mục, tạo trong Studio, hoặc bấm “Đưa vào thư viện” trên clipart của sản phẩm.
          </p>
        ) : (
          origins.map((o) => (
            <OriginCard
              key={o.id}
              origin={o}
              members={setMembers(cliparts, o.id)}
              rendition={renditionOf(cliparts, o.id)}
              family={cliparts.filter((c) => c.id === o.id || c.parent_id === o.id || (c.parent_id !== null && cliparts.some((m) => m.id === c.parent_id && m.parent_id === o.id)))}
              used={props.usedIds.has(o.id)}
              canPlace={props.canPlace}
              busy={busy !== null}
              onPlace={props.onPlace}
              onAddMain={props.onAddMain}
              onUploadMembers={(files) => void uploadMembers(o, files)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function OriginCard(props: {
  origin: CtAsset;
  members: CtAsset[];
  rendition: CtAsset | null;
  family: CtAsset[];
  used: boolean;
  canPlace: boolean;
  busy: boolean;
  onPlace: (origin: CtAsset, family: CtAsset[]) => void;
  onAddMain: (main: CtAsset) => void;
  onUploadMembers: (files: File[]) => void;
}) {
  const { origin, members } = props;
  const [open, setOpen] = useState(false);
  const isMain = origin.role === "main";
  return (
    <div className={cx("rounded-lg border", props.used && "border-emerald-500/60")}>
      <div className="flex items-start gap-2 p-2">
        <div className="relative aspect-square w-20 shrink-0 overflow-hidden rounded" style={CHECKER_STYLE}>
          <img src={(props.rendition ?? origin).url} alt={origin.name} className="h-full w-full object-contain" loading="lazy" />
          {origin.source === "ai" && <span className="absolute left-0.5 top-0.5 rounded bg-sky-600/90 px-1 text-[10px] text-white">AI</span>}
          {props.rendition && <span className="absolute bottom-0.5 left-0.5 rounded bg-violet-600/90 px-1 text-[10px] text-white">vật liệu</span>}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-xs font-medium" title={origin.spec || origin.name}>
            {origin.name || "(không tên)"}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {isMain ? "Main" : "Element"} · {origin.width}×{origin.height}
            {props.used && <span className="ml-1 text-emerald-600">· đang dùng</span>}
          </span>
          {isMain ? (
            <CtButton size="sm" variant="primary" onClick={() => props.onAddMain(origin)} disabled={props.used}>
              <Crown className="h-3.5 w-3.5" /> Thêm làm version
            </CtButton>
          ) : (
            <CtTooltip label={props.canPlace ? "Thêm clipart này (và bộ biến thể) làm 1 nhóm option của vùng đang chọn" : "Chọn một Custom layer trước"}>
              <span className="flex">
                <CtButton size="sm" variant="primary" className="flex-1" onClick={() => props.onPlace(origin, props.family)} disabled={!props.canPlace}>
                  <MapPinned className="h-3.5 w-3.5" /> Đặt vào vùng
                </CtButton>
              </span>
            </CtTooltip>
          )}
        </div>
      </div>
      <div className="flex border-t text-[11px]">
        <button className="flex flex-1 items-center justify-center gap-1 py-1 hover:bg-accent" onClick={() => openStudio({ template: "02-variant-set", clipart: origin.id })} title="Mở Studio: tạo thêm màu / style cho clipart này (giữ nguyên hình)">
          <Sparkles className="h-3 w-3" /> Biến thể AI
        </button>
        <button className="flex flex-1 items-center justify-center gap-1 border-l py-1 hover:bg-accent" onClick={() => openStudio({ template: "04-clipart-material", clipart: origin.id })} title="Mở Studio: tạo bản vật liệu (acrylic, glitter…) cho clipart này">
          <Sparkles className="h-3 w-3" /> Vật liệu AI
        </button>
      </div>
      <div className="flex items-center border-t">
        <button className="flex flex-1 items-center gap-1 px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent" onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {members.length} biến thể
        </button>
        <UploadButton label="+ biến thể" compact onFiles={props.onUploadMembers} disabled={props.busy} />
      </div>
      {open && members.length > 0 && (
        <div className="grid grid-cols-4 gap-1 p-2 pt-0">
          {members.map((m) => (
            <div key={m.id} className="relative aspect-square overflow-hidden rounded border" style={CHECKER_STYLE} title={m.name}>
              <img src={m.url} alt={m.name} className="h-full w-full object-contain" loading="lazy" />
              {isMain && (
                <button
                  className="absolute inset-x-0 bottom-0 bg-black/60 py-0.5 text-[9px] text-white opacity-0 hover:opacity-100"
                  onClick={() => props.onAddMain(m)}
                >
                  + version
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {open && isMain && members.length > 0 && (
        <p className="px-2 pb-2 text-[10px] text-muted-foreground">
          Mỗi màu của main là 1 version riêng — bấm “+ version” trên ảnh để thêm.
        </p>
      )}
    </div>
  );
}

function UploadButton({ label, onFiles, disabled, compact }: { label: string; onFiles: (files: File[]) => void; disabled?: boolean; compact?: boolean }) {
  const ref = useRef<HTMLInputElement | null>(null);
  return (
    <>
      {compact ? (
        <button className="border-l px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent disabled:opacity-40" onClick={() => ref.current?.click()} disabled={disabled}>
          {label}
        </button>
      ) : (
        <CtButton size="sm" onClick={() => ref.current?.click()} disabled={disabled}>
          <ImagePlus className="h-3.5 w-3.5" /> {label}
        </CtButton>
      )}
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

/** Small link-out used by the product asset cards. */
export function LibraryBadge() {
  return (
    <span className="absolute right-0.5 top-0.5 flex items-center gap-0.5 rounded bg-emerald-600/90 px-1 text-[10px] text-white">
      <ExternalLink className="h-2.5 w-2.5" /> thư viện
    </span>
  );
}
