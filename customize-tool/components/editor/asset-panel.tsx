"use client";

/**
 * Left sidebar: the product's asset library.
 *
 *   Main       the main object and its VERSIONS (colour, material…). The crown
 *              marks the default; with "Khách chọn version" on, every main is
 *              an option the customer picks ("Choose Color").
 *   Sub        objects that go into image zones, each with its own versions.
 *   Tham chiếu style/subject references fed to AI requests.
 *   Thư viện   the global clipart library (library-panel.tsx): place shared
 *              cliparts into zones / add library mains as versions.
 *
 * Every asset can be uploaded or generated independently — one AI request
 * per main, per sub, per version — and cleaned up (background cut-out).
 */

import { useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Crown, Eraser, ImagePlus, Library, Loader2, MapPinned, Sparkles, Trash2, Unlink } from "lucide-react";
import type { CtAsset, CtAssetRole, CtMainLayout, CtMainOptionConfig, CtOptionDisplay } from "../../types";
import { mainVersions, variantsOf } from "../../lib/design";
import { CHECKER_STYLE, CtButton, CtCheckbox, CtField, CtInput, CtSelect, CtTooltip, cx } from "../ui";
import { DISPLAY_OPTIONS } from "./inspector";
import { LibraryBadge, LibraryPanel } from "./library-panel";

export type AssetTab = "main" | "sub" | "reference" | "library";

export interface AssetPanelProps {
  assets: CtAsset[];
  mainAssetId: string | null;
  canPlace: boolean;
  busy: string | null;
  onUpload: (role: CtAssetRole, files: File[], parentId: string | null) => void;
  /** AI plugin — omitted when no provider is configured, which hides every AI button. */
  onGenerate?: (role: CtAssetRole, parentId: string | null) => void;
  onDelete: (asset: CtAsset) => void;
  onSetMain: (asset: CtAsset) => void;
  onPlace: (sub: CtAsset) => void;
  onCleanup: (asset: CtAsset) => void;
  onRename: (asset: CtAsset, name: string) => void;
  onPreview: (asset: CtAsset) => void;
  mainConfig: CtMainOptionConfig;
  onMainConfig: (patch: Partial<CtMainOptionConfig>) => void;
  /** Main versions with their own zone layout (config.layouts). */
  layouts: Record<string, CtMainLayout>;
  onOwnLayout: (mainId: string, on: boolean) => void;
  /** Main version currently on the canvas. */
  shownMainId: string | null;
  onSetSwatch: (asset: CtAsset, color: string) => void;
  /** Library tab: element origin + its set → a new option group of the selected zone. */
  onPlaceLibrary: (origin: CtAsset, family: CtAsset[]) => void;
  onAddLibraryMain: (main: CtAsset) => void;
  /** Move a product clipart into the global library. */
  onPromote: (asset: CtAsset) => void;
}

export function AssetPanel(props: AssetPanelProps) {
  const [tab, setTab] = useState<AssetTab>("main");
  const [dragOver, setDragOver] = useState(false);
  const { assets } = props;
  const mains = mainVersions(assets, props.mainAssetId);
  const defaultMain = mains.find((m) => m.id === props.mainAssetId) ?? null;
  const subs = assets.filter((a) => a.role === "sub");
  const refs = assets.filter((a) => a.role === "reference");

  return (
    <div
      className={cx("flex h-full flex-col text-sm", dragOver && "ring-2 ring-inset ring-sky-500 bg-sky-500/5")}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const files = Array.from(e.dataTransfer.files).filter((f) => /^image\/(png|jpeg|webp)$/.test(f.type));
        if (files.length && props.busy === null && tab !== "library") props.onUpload(tab, files, null);
      }}
    >
      <div className="flex border-b">
        {(
          [
            ["main", `Main (${mains.length})`],
            ["sub", `Sub (${subs.length})`],
            // References only feed AI requests.
            ...(props.onGenerate || refs.length > 0 ? [["reference", `Tham chiếu (${refs.length})`]] : []),
            ["library", "Thư viện"],
          ] as Array<[AssetTab, string]>
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={cx("flex-1 px-2 py-2 text-xs font-medium", tab === k ? "border-b-2 border-sky-500 text-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "library" ? (
        <div className="min-h-0 flex-1">
          <LibraryPanel
            canPlace={props.canPlace}
            usedIds={new Set(assets.map((a) => a.id))}
            onPlace={props.onPlaceLibrary}
            onAddMain={props.onAddLibraryMain}
          />
        </div>
      ) : (
      <>
      <div className="flex gap-1.5 border-b p-2">
        <UploadButton label="Upload" multiple onFiles={(f) => props.onUpload(tab, f, null)} disabled={props.busy !== null} />
        {tab !== "reference" && props.onGenerate && (
          <CtButton size="sm" variant="primary" onClick={() => props.onGenerate?.(tab, null)} disabled={props.busy !== null}>
            <Sparkles className="h-3.5 w-3.5" /> Tạo bằng AI
          </CtButton>
        )}
        {props.busy && (
          <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> {props.busy}
          </span>
        )}
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto p-2">
        {tab === "main" &&
          (mains.length === 0 ? (
            <Empty text="Upload (hoặc kéo-thả ảnh vào đây) một main object — vd. xửng tre, biển số xe, ornament tròn." />
          ) : (
            <>
              <div className="space-y-2 rounded-md border p-2">
                <CtCheckbox
                  checked={props.mainConfig.enabled}
                  onChange={(enabled) => props.onMainConfig({ enabled })}
                  label="Khách chọn version main"
                  hint="Mỗi ảnh main là 1 option (vd. Choose Color: đen / xám / đỏ). Tên ảnh = tên option hiện cho khách."
                />
                {props.mainConfig.enabled && (
                  <div className="grid grid-cols-[1fr_110px] gap-1.5">
                    <CtField label="Nhãn">
                      <CtInput value={props.mainConfig.label} placeholder="Choose Color" onChange={(e) => props.onMainConfig({ label: e.target.value })} />
                    </CtField>
                    <CtField label="Hiển thị">
                      <CtSelect<CtOptionDisplay> value={props.mainConfig.display} onChange={(display) => props.onMainConfig({ display })} options={DISPLAY_OPTIONS} />
                    </CtField>
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {mains.map((a) => {
                  const mismatch = defaultMain && (a.width !== defaultMain.width || a.height !== defaultMain.height);
                  return (
                    <AssetCard key={a.id} asset={a} {...props} highlighted={a.id === props.shownMainId}>
                      {props.mainConfig.enabled && props.mainConfig.display === "swatch" && (
                        <label className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <input
                            type="color"
                            className="h-4 w-6 cursor-pointer rounded border-0 bg-transparent p-0"
                            value={a.meta.swatch ?? "#cccccc"}
                            onChange={(e) => props.onSetSwatch(a, e.target.value)}
                          />
                          Màu swatch
                        </label>
                      )}
                      {mismatch && (
                        <CtTooltip label={`${a.width}×${a.height} khác main mặc định ${defaultMain.width}×${defaultMain.height} — sẽ bị kéo giãn cho khớp vùng`}>
                          <span className="mb-1 flex items-center gap-1 text-[11px] text-amber-500">
                            <AlertTriangle className="h-3 w-3" /> Lệch kích thước
                          </span>
                        </CtTooltip>
                      )}
                      {props.mainConfig.enabled && a.id !== props.mainAssetId && (
                        <CtTooltip label="Version này có bố cục vùng riêng (vd. 1 người / 2 người, hoặc mũ ở chỗ khác): chọn version rồi kéo / ẩn vùng trên canvas — chỉ áp cho version này. Tắt = dùng lại bố cục của main mặc định.">
                          <label className="mb-1 flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
                            <input
                              type="checkbox"
                              className="accent-violet-500"
                              checked={Boolean(props.layouts[a.id])}
                              onChange={(e) => {
                                if (!e.target.checked && !window.confirm(`Bỏ bố cục riêng của “${a.name}”? Vị trí / vùng ẩn của version này sẽ mất.`)) return;
                                props.onOwnLayout(a.id, e.target.checked);
                              }}
                            />
                            <MapPinned className="h-3 w-3" /> Vị trí riêng
                          </label>
                        </CtTooltip>
                      )}
                      {a.id === props.mainAssetId ? (
                        <span className="flex items-center gap-1 text-[11px] font-medium text-amber-500">
                          <Crown className="h-3 w-3" /> Mặc định
                        </span>
                      ) : (
                        <CtButton size="sm" onClick={() => props.onSetMain(a)}>
                          <Crown className="h-3 w-3" /> Đặt mặc định
                        </CtButton>
                      )}
                    </AssetCard>
                  );
                })}
              </div>
            </>
          ))}

        {tab === "sub" &&
          (subs.length === 0 ? (
            <Empty text="Sub object là những thứ đặt vào vùng custom: mặt, kính, mũ, phụ kiện… Mỗi sub có nhiều version." />
          ) : (
            subs.map((s) => <SubGroup key={s.id} sub={s} variants={variantsOf(assets, s.id)} {...props} />)
          ))}

        {tab === "reference" &&
          (refs.length === 0 ? (
            <Empty text="Ảnh tham chiếu (style, nhân vật, sản phẩm đối thủ…) để đưa vào prompt AI." />
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {refs.map((a) => (
                <AssetCard key={a.id} asset={a} {...props} />
              ))}
            </div>
          ))}
      </div>
      </>
      )}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="px-1 py-6 text-center text-xs text-muted-foreground">{text}</p>;
}

function UploadButton({
  label,
  onFiles,
  multiple,
  disabled,
}: {
  label: string;
  onFiles: (files: File[]) => void;
  multiple?: boolean;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <CtButton size="sm" onClick={() => ref.current?.click()} disabled={disabled}>
        <ImagePlus className="h-3.5 w-3.5" /> {label}
      </CtButton>
      <input
        ref={ref}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple={multiple}
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

function AssetCard({
  asset,
  children,
  onDelete,
  onCleanup,
  onRename,
  onPreview,
  onPromote,
  highlighted,
}: AssetPanelProps & { asset: CtAsset; children?: React.ReactNode; compact?: boolean; highlighted?: boolean }) {
  const inLibrary = asset.product_id === null;
  const promotable = !inLibrary && asset.parent_id === null && (asset.role === "main" || asset.role === "sub");
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(asset.name);
  return (
    <div className={cx("group rounded-md border bg-card p-1.5", highlighted && "border-sky-500 ring-1 ring-sky-500")}>
      <button className="relative block aspect-square w-full overflow-hidden rounded" style={CHECKER_STYLE} onClick={() => onPreview(asset)}>
        <img src={asset.url} alt={asset.name} className="h-full w-full object-contain" loading="lazy" />
        <span className="absolute bottom-0.5 right-0.5 rounded bg-black/60 px-1 text-[10px] text-white">
          {asset.width}×{asset.height}
        </span>
        {(asset.generation_id || asset.source === "ai") && (
          <span className="absolute left-0.5 top-0.5 rounded bg-sky-600/90 px-1 text-[10px] text-white">AI</span>
        )}
        {inLibrary && <LibraryBadge />}
      </button>
      <div className="mt-1 flex items-center gap-1">
        {editing ? (
          <CtInput
            autoFocus
            value={name}
            className="h-6 text-xs"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              setEditing(false);
              if (name !== asset.name) onRename(asset, name);
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <CtTooltip label="Double-click để đổi tên">
            <span className="flex-1 cursor-text truncate text-[11px]" onDoubleClick={() => setEditing(true)}>
              {asset.name || "(không tên)"}
            </span>
          </CtTooltip>
        )}
        <CtTooltip label="Xoá nền / cắt viền">
          <button className="rounded p-0.5 opacity-60 hover:bg-accent hover:opacity-100" onClick={() => onCleanup(asset)}>
            <Eraser className="h-3 w-3" />
          </button>
        </CtTooltip>
        {promotable && (
          <CtTooltip label="Đưa vào thư viện — dùng lại cho sản phẩm khác">
            <button className="rounded p-0.5 opacity-60 hover:bg-accent hover:opacity-100" onClick={() => onPromote(asset)}>
              <Library className="h-3 w-3" />
            </button>
          </CtTooltip>
        )}
        <CtTooltip label={inLibrary ? "Gỡ khỏi sản phẩm (clipart vẫn trong thư viện)" : "Xoá"}>
          <button className="rounded p-0.5 text-destructive opacity-60 hover:bg-accent hover:opacity-100" onClick={() => onDelete(asset)}>
            {inLibrary ? <Unlink className="h-3 w-3" /> : <Trash2 className="h-3 w-3" />}
          </button>
        </CtTooltip>
      </div>
      {children && <div className="mt-1">{children}</div>}
    </div>
  );
}

function SubGroup(props: AssetPanelProps & { sub: CtAsset; variants: CtAsset[] }) {
  const { sub, variants } = props;
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-lg border">
      <div className="flex items-start gap-2 p-2">
        <div className="w-24 shrink-0">
          <AssetCard {...props} asset={sub} compact />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <CtTooltip label={props.canPlace ? "Thêm sub này làm 1 nhóm option của vùng đang chọn" : "Chọn một Custom layer trước"}>
            {/* span: disabled buttons swallow pointer events, which would suppress the tooltip */}
            <span className="flex">
              <CtButton size="sm" variant="primary" className="flex-1" onClick={() => props.onPlace(sub)} disabled={!props.canPlace}>
                <MapPinned className="h-3.5 w-3.5" /> Đặt vào vùng
              </CtButton>
            </span>
          </CtTooltip>
          {props.onGenerate && (
            <CtButton size="sm" onClick={() => props.onGenerate?.("variant", sub.id)} disabled={props.busy !== null}>
              <Sparkles className="h-3.5 w-3.5" /> Version AI
            </CtButton>
          )}
          <UploadButton label="Upload version" multiple onFiles={(f) => props.onUpload("variant", f, sub.id)} disabled={props.busy !== null} />
        </div>
      </div>
      <button className="flex w-full items-center gap-1 border-t px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {variants.length} version
      </button>
      {open && variants.length > 0 && (
        <div className="grid grid-cols-3 gap-1.5 p-2 pt-0">
          {variants.map((v) => (
            <AssetCard key={v.id} {...props} asset={v} compact />
          ))}
        </div>
      )}
    </div>
  );
}
