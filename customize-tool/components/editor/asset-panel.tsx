"use client";

/**
 * Left sidebar: what the product uses — the editor only edits; every clipart
 * is made and fixed in the library (/library) or in a v2 bộ nhân vật.
 *
 *   Version    the product's VERSIONS (what the customer picks: a character, a
 *              number of people…), each with its own layers. Click one to
 *              edit it; the crown marks the default. "+" copies the shown
 *              version (picture + layers) into a new one — then drag another
 *              bộ nhân vật onto it. A bộ / artwork dropped on the list becomes
 *              one more version.
 *   Thư viện   bộ nhân vật v2 + artworks (library-panel.tsx): drag a whole set
 *              onto the canvas.
 */

import { useState } from "react";
import { Copy, Crown, Trash2, Unlink } from "lucide-react";
import type { CtAsset } from "../../types";
import { mainVersions } from "../../lib/design";
import { CHECKER_STYLE, CtInput, CtTooltip, cx } from "../ui";
import { CLIPART_DRAG, LibraryPanel, type CtLibraryDrag } from "./library-panel";

export type AssetTab = "main" | "library";

export interface AssetPanelProps {
  assets: CtAsset[];
  mainAssetId: string | null;
  /** Bumped so the library tab reloads. */
  libraryVersion?: number;
  onDelete: (asset: CtAsset) => void;
  onSetMain: (asset: CtAsset) => void;
  onRename: (asset: CtAsset, name: string) => void;
  /** Show (and edit) this version on the canvas. */
  onShow: (asset: CtAsset) => void;
  /** Main version id -> how many layers it has (every version has its own). */
  layerCounts: Record<string, number>;
  /** Main version currently on the canvas. */
  shownMainId: string | null;
  /** A bộ nhân vật / artwork dropped on the version list: one more version. */
  onDropVersion: (drag: CtLibraryDrag) => void;
  /** "+": a copy of the shown version (its picture and layers) as a new version, shown at once. */
  onCloneVersion: () => void;
  /** Bộ nhân vật on the product's layers (CtRegionConfig.charSet). */
  usedSets: Set<string>;
  /** What the customer is asked for a version ("Number of grandchildren"): each row says it, and its name is written
   * over its picture. */
  versionLabel?: string;
}

export function AssetPanel(props: AssetPanelProps) {
  const [tab, setTab] = useState<AssetTab>("main");
  const [over, setOver] = useState(false);
  const mains = mainVersions(props.assets, props.mainAssetId);

  return (
    <div className="flex h-full flex-col text-sm">
      <div className="flex border-b">
        {(
          [
            ["main", `Version (${mains.length})`],
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
          <LibraryPanel usedIds={new Set(props.assets.map((a) => a.id))} usedSets={props.usedSets} version={props.libraryVersion} />
        </div>
      ) : (
        <div
          className={cx("flex-1 space-y-1 overflow-y-auto p-2", over && "bg-sky-500/5 ring-2 ring-inset ring-sky-500/50")}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(CLIPART_DRAG)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setOver(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
          }}
          onDrop={(e) => {
            setOver(false);
            const raw = e.dataTransfer.getData(CLIPART_DRAG);
            if (!raw) return;
            e.preventDefault();
            props.onDropVersion(JSON.parse(raw) as CtLibraryDrag);
          }}
        >
          {mains.length === 0 ? (
            <p className="px-1 py-6 text-center text-xs text-muted-foreground">Chưa có version.</p>
          ) : (
            mains.map((a) => <VersionRow key={a.id} asset={a} {...props} />)
          )}
          {mains.length > 0 && props.shownMainId && (
            <CtTooltip label="Nhân bản version đang mở (ảnh + layer) thành 1 version mới — mở nó rồi kéo bộ nhân vật khác vào">
              <button
                onClick={props.onCloneVersion}
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed p-2 text-xs text-muted-foreground hover:border-sky-500 hover:bg-sky-500/5 hover:text-foreground"
              >
                <Copy className="h-3.5 w-3.5" /> + Version (nhân bản)
              </button>
            </CtTooltip>
          )}
        </div>
      )}
    </div>
  );
}

function VersionRow({ asset, ...props }: AssetPanelProps & { asset: CtAsset }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(asset.name);
  const isDefault = asset.id === props.mainAssetId;
  const shown = asset.id === props.shownMainId;
  const inLibrary = asset.product_id === null;
  const count = props.layerCounts[asset.id] ?? 0;
  return (
    <div
      onClick={() => props.onShow(asset)}
      className={cx("group flex cursor-pointer items-center gap-2 rounded-md border p-1.5", shown ? "border-sky-500 bg-sky-500/10" : "border-transparent hover:bg-accent")}
    >
      <span className="relative h-11 w-11 shrink-0 overflow-hidden rounded border" style={CHECKER_STYLE}>
        <img src={asset.url} alt={asset.name} className="h-full w-full object-contain" loading="lazy" draggable={false} />
        {/* A version of a lineup is often a blank sheet: its name over it says which one. */}
        {props.versionLabel && <span className="absolute inset-0 flex items-center justify-center text-base font-semibold text-foreground drop-shadow">{asset.name.slice(0, 3)}</span>}
      </span>
      <div className="min-w-0 flex-1">
        {editing ? (
          <CtInput
            autoFocus
            value={name}
            className="h-6 text-xs"
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              setEditing(false);
              if (name !== asset.name) props.onRename(asset, name);
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <span className="block truncate text-xs font-medium" onDoubleClick={() => setEditing(true)}>
            {props.versionLabel ? `${props.versionLabel}: ${asset.name}` : asset.name || "(không tên)"}
          </span>
        )}
        <span className="text-[11px] text-muted-foreground">{count} layer</span>
      </div>
      {isDefault ? (
        <CtTooltip label="Mặc định">
          <Crown className="h-3.5 w-3.5 shrink-0 text-amber-500" />
        </CtTooltip>
      ) : (
        <CtTooltip label="Đặt mặc định">
          <button
            className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-amber-500 group-hover:block"
            onClick={(e) => {
              e.stopPropagation();
              props.onSetMain(asset);
            }}
          >
            <Crown className="h-3.5 w-3.5" />
          </button>
        </CtTooltip>
      )}
      <CtTooltip label={inLibrary ? "Gỡ khỏi sản phẩm" : "Xoá"}>
        <button
          className="hidden shrink-0 rounded p-0.5 text-destructive hover:bg-background group-hover:block"
          onClick={(e) => {
            e.stopPropagation();
            props.onDelete(asset);
          }}
        >
          {inLibrary ? <Unlink className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
        </button>
      </CtTooltip>
    </div>
  );
}
