"use client";

/**
 * Left sidebar: what the product uses — the editor only edits; every clipart
 * is made and fixed in the library (/library).
 *
 *   Version    the main object's VERSIONS (colour, material…), each with its
 *              own layers. The crown marks the default; with "Khách chọn
 *              version" on, every version is an option the customer picks
 *              ("Choose Color"). "Thêm option" gives a version sub-options
 *              (đa sắc): a second row on the storefront, the version itself
 *              first, sharing its layers and config.
 *   Tham chiếu style/subject references fed to AI requests (older products).
 *   Thư viện   the global clipart library (library-panel.tsx): drag any
 *              picture onto the Version column or the canvas.
 */

import { useState } from "react";
import { AlertTriangle, Crown, Layers, Plus, Trash2, Unlink, X } from "lucide-react";
import type { CtAsset, CtMainOptionConfig, CtOptionDisplay } from "../../types";
import { mainSubOptions, mainVersions } from "../../lib/design";
import { CHECKER_STYLE, CtButton, CtCheckbox, CtField, CtInput, CtSelect, CtTooltip, cx } from "../ui";
import { DISPLAY_OPTIONS } from "./inspector";
import { LibraryBadge, LibraryPanel } from "./library-panel";

export type AssetTab = "main" | "reference" | "library";

export interface AssetPanelProps {
  assets: CtAsset[];
  mainAssetId: string | null;
  /** Bumped so the library tab reloads. */
  libraryVersion?: number;
  onDelete: (asset: CtAsset) => void;
  onSetMain: (asset: CtAsset) => void;
  onRename: (asset: CtAsset, name: string) => void;
  onPreview: (asset: CtAsset) => void;
  mainConfig: CtMainOptionConfig;
  onMainConfig: (patch: Partial<CtMainOptionConfig>) => void;
  /** Main version id -> how many layers it has (every version has its own). */
  layerCounts: Record<string, number>;
  /** Main version currently on the canvas, and the picture it shows (a sub-option of it, or itself). */
  shownMainId: string | null;
  shownMainImageId: string | null;
  /** "Thêm option": pick library cliparts as sub-options of this version. */
  onAddOptions: (version: CtAsset) => void;
  onRemoveOption: (version: CtAsset, option: CtAsset) => void;
  /** Show this picture of the version on the canvas (null = the version itself). */
  onShowOption: (version: CtAsset, optionId: string | null) => void;
}

export function AssetPanel(props: AssetPanelProps) {
  const [tab, setTab] = useState<AssetTab>("main");
  const { assets } = props;
  const mains = mainVersions(assets, props.mainAssetId);
  const defaultMain = mains.find((m) => m.id === props.mainAssetId) ?? null;
  const refs = assets.filter((a) => a.role === "reference");

  return (
    <div className="flex h-full flex-col text-sm">
      <div className="flex border-b">
        {(
          [
            ["main", `Version (${mains.length})`],
            // References only fed AI requests (older products).
            ...(refs.length > 0 ? [["reference", `Tham chiếu (${refs.length})`]] : []),
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
          <LibraryPanel usedIds={new Set(assets.map((a) => a.id))} version={props.libraryVersion} />
        </div>
      ) : (
        <div className="flex-1 space-y-2 overflow-y-auto p-2">
          {tab === "main" &&
            (mains.length === 0 ? (
              <Empty text="Chưa có version. Mở tab Thư viện, kéo 1 clipart (gốc, đa sắc hay vật liệu) thả vào canvas." />
            ) : (
              <>
                <div className="space-y-2 rounded-md border p-2">
                  <CtCheckbox
                    checked={props.mainConfig.enabled}
                    onChange={(enabled) => props.onMainConfig({ enabled })}
                    label="Khách chọn version"
                    hint="Mỗi version là 1 option (vd. Choose Color: đen / xám / đỏ). Tên ảnh = tên option hiện cho khách."
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
                        {mismatch && (
                          <CtTooltip label={`${a.width}×${a.height} khác version mặc định ${defaultMain.width}×${defaultMain.height} — sẽ bị kéo giãn cho khớp vùng`}>
                            <span className="mb-1 flex items-center gap-1 text-[11px] text-amber-500">
                              <AlertTriangle className="h-3 w-3" /> Lệch kích thước
                            </span>
                          </CtTooltip>
                        )}
                        <span className="mb-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Layers className="h-3 w-3" /> {props.layerCounts[a.id] ?? 0} layer
                        </span>
                        {a.id === props.mainAssetId ? (
                          <span className="mb-1 flex items-center gap-1 text-[11px] font-medium text-amber-500">
                            <Crown className="h-3 w-3" /> Mặc định
                          </span>
                        ) : (
                          <CtButton size="sm" className="mb-1" onClick={() => props.onSetMain(a)}>
                            <Crown className="h-3 w-3" /> Đặt mặc định
                          </CtButton>
                        )}
                        <SubOptions version={a} {...props} />
                      </AssetCard>
                    );
                  })}
                </div>
              </>
            ))}

          {tab === "reference" && (
            <div className="grid grid-cols-2 gap-2">
              {refs.map((a) => (
                <AssetCard key={a.id} asset={a} {...props} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="px-1 py-6 text-center text-xs text-muted-foreground">{text}</p>;
}

/**
 * A version's sub-options: the version itself first (n° 1), then the pictures added with "Thêm option". Clicking
 * one shows it on the canvas — the layers stay the version's.
 */
function SubOptions(props: AssetPanelProps & { version: CtAsset }) {
  const { version } = props;
  const options = mainSubOptions(props.assets, props.mainConfig, version.id);
  const shown = props.shownMainId === version.id ? props.shownMainImageId : null;
  return (
    <div className="space-y-1 border-t pt-1">
      {options.length > 0 && (
        <div className="grid grid-cols-4 gap-1">
          {[version, ...options].map((o, i) => (
            <div key={o.id} className="group relative">
              <CtTooltip label={i === 0 ? `${o.name || "Version"} — chính nó, option số 1` : `${o.name} — dùng chung layer & config của version`}>
                <button
                  type="button"
                  onClick={() => props.onShowOption(version, i === 0 ? null : o.id)}
                  className={cx("relative block aspect-square w-full overflow-hidden rounded border", shown === o.id && "ring-2 ring-sky-500")}
                  style={CHECKER_STYLE}
                >
                  <img src={o.url} alt={o.name} className="h-full w-full object-contain" loading="lazy" />
                  <span className="absolute bottom-0 left-0 rounded-tr bg-black/60 px-0.5 text-[8px] leading-tight text-white">{i + 1}</span>
                </button>
              </CtTooltip>
              {i > 0 && (
                <button
                  type="button"
                  className="absolute -right-1 -top-1 hidden rounded-full bg-black/70 p-0.5 text-white group-hover:block"
                  onClick={() => props.onRemoveOption(version, o)}
                  aria-label="Bỏ option"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <CtTooltip label="Thêm option con (đa sắc) cho version này: khách chọn version rồi chọn tiếp 1 trong các ảnh — dùng chung layer & config">
        <span className="flex">
          <CtButton size="sm" className="h-6 flex-1 px-1.5 text-[11px]" onClick={() => props.onAddOptions(version)}>
            <Plus className="h-3 w-3" /> Thêm option
          </CtButton>
        </span>
      </CtTooltip>
    </div>
  );
}

function AssetCard({
  asset,
  children,
  onDelete,
  onRename,
  onPreview,
  highlighted,
}: AssetPanelProps & { asset: CtAsset; children?: React.ReactNode; highlighted?: boolean }) {
  const inLibrary = asset.product_id === null;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(asset.name);
  return (
    <div className={cx("group rounded-md border bg-card p-1.5", highlighted && "border-sky-500 ring-1 ring-sky-500")}>
      <button className="relative block aspect-square w-full overflow-hidden rounded" style={CHECKER_STYLE} onClick={() => onPreview(asset)}>
        <img src={asset.url} alt={asset.name} className="h-full w-full object-contain" loading="lazy" />
        <span className="absolute bottom-0.5 right-0.5 rounded bg-black/60 px-1 text-[10px] text-white">
          {asset.width}×{asset.height}
        </span>
        {(asset.generation_id || asset.source === "ai") && <span className="absolute left-0.5 top-0.5 rounded bg-sky-600/90 px-1 text-[10px] text-white">AI</span>}
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
