"use client";

/**
 * Right sidebar: the layer list (regions, top = drawn last) and the selected
 * region's properties — geometry, kind-specific config, and for image zones
 * the option GROUPS placed in it (each group = one sub asset + its versions).
 */

import { Fragment, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CornerDownRight,
  Eye,
  EyeOff,
  Frame,
  GripVertical,
  ImageIcon,
  Loader2,
  Move,
  Plus,
  Trash2,
  Type,
  Upload,
  UserSquare,
  X,
  HelpCircle,
} from "lucide-react";
import { CT_FONTS } from "../../config";
import type { CtProductPrint } from "../../types/print";
import { outsideSafe } from "../print/layer-print-section";
import type {
  CtAsset,
  CtTextFormat,
  CtMainFrame,
  CtPhotoCapabilities,
  CtPhotoSelection,
  CtAiStyle,
  CtPhotoFrame,
  CtPhotoMode,
  CtPhotoStyleRef,
  CtRegion,
  CtRegionItem,
  CtRegionKind,
  CtSelection,
  CtTextAlign,
  CtTransform,
  CtTextMode,
} from "../../types";
import { CT_BASE_OPTION } from "../../types";
import { fitShapeToBounds, IDENTITY_PHOTO_FRAME, IDENTITY_TRANSFORM, orientedBox, resolvePhotoFrame, shapeBounds } from "../../lib/geometry";
import { useImageSize } from "./use-image-size";
import { defaultRegionSelection, formOrder, hasTestPhoto, isLinkedLayer, isValidDate, normalizeRegion, textMode, variantsOf, zoneSubtree } from "../../lib/design";
import { CT_FACE_STYLES, CT_FREE_STYLES, aiStyleRef, isAiStyleRef, needsServer, photoMode, styleEngine, styleFamily, styleLabel } from "../../lib/photo-styles";
import { PhotoGuideDialog } from "./photo-guide-dialog";
import { AiStyleDialog } from "./ai-style-dialog";
import { useAiStyles } from "./ai-styles-store";
import { processPhoto } from "../../lib/photo-process";
import { ctApi } from "../../lib/api-client";
import { OptionThumb } from "./option-thumb";
import { CHECKER_STYLE, CtButton, CtCheckbox, CtField, CtInput, CtNumber, CtSelect, CtTextarea, CtTooltip, cx } from "../ui";
import type { DesignApi } from "./use-design";
import { updateItem, updateRegion } from "./use-design";

const KIND_ICON: Record<CtRegionKind, typeof ImageIcon> = { image: ImageIcon, text: Type, photo: UserSquare };

export interface InspectorProps {
  design: DesignApi;
  assets: CtAsset[];
  selection: CtSelection;
  selectedRegionId: string | null;
  onSelectRegion: (id: string | null) => void;
  activeItemId: string | null;
  onActiveItem: (id: string | null) => void;
  /** The selected photo zone's child frame is selected (its Layers sub-row), not the zone. */
  frameSelected: boolean;
  onSelectFrame: (regionId: string) => void;
  /** Delete a photo zone's child frame; the zone stays. */
  onRemoveFrame: (regionId: string) => void;
  showOverlay: boolean;
  onToggleOverlay: () => void;
  /** Show an option on the canvas. */
  onPreviewOption: (regionId: string, assetId: string) => void;
  /** The text a text zone shows on the canvas (and in the Mockups samples). */
  onSampleText: (regionId: string, text: string) => void;
  onSetSwatch: (asset: CtAsset, color: string) => void;
  /** Customer-photo zones: try a local photo on the canvas (not saved). */
  onPhotoSelection: (regionId: string, sel: CtPhotoSelection) => void;
  /** A test photo is being processed (label for the canvas spinner); null = done. */
  onPhotoBusy: (regionId: string, label: string | null) => void;
  /** The shown version's picture, as the bottom row of Layers: a frame moved / resized like a layer. */
  mainLayer: { asset: CtAsset; frame: CtMainFrame; board: { w: number; h: number } } | null;
  mainSelected: boolean;
  onSelectMain: () => void;
  onMainFrame: (f: CtMainFrame) => void;
  /** Save what is shown now as one more artwork in the product's library folder. */
  onSaveArtwork: (name: string) => Promise<void>;
  /** An artwork is being saved (also the versions' own ones after Lưu thiết kế). */
  artworkBusy: boolean;
  /** The product's library folder, once it has one. */
  artworkFolder: string | null;
  /** Show (and edit) a text / photo zone as one of its sub-options; null = its own look. */
  onZoneOption: (regionId: string, optionId: string | null) => void;
  /** The khuôn in the product is made on: placement / fill / print-only per layer, the safe zone check. */
  print?: CtProductPrint | null;
}

/** "Choose state: Texas" — the option a child zone belongs to. */

/** A layer's name as listed: without the " [4]" its version adds (the list only shows the version on the canvas). */
const layerLabel = (name: string) => name.replace(/ \[[^\]]*\]$/, "");

function parentLabel(regions: CtRegion[], assets: CtAsset[], r: CtRegion): string {
  const p = r.config.parent;
  const parent = p ? regions.find((x) => x.id === p.regionId) : undefined;
  if (!p || !parent) return "?";
  if (parent.kind === "image") return `${parent.name}: ${assets.find((a) => a.id === p.optionId)?.name ?? "ảnh"}`;
  const o = normalizeRegion(parent).config.options;
  return `${parent.name}: ${p.optionId === CT_BASE_OPTION ? o.baseName || "Mặc định" : (o.list.find((x) => x.id === p.optionId)?.name ?? "?")}`;
}

export function Inspector(props: InspectorProps) {
  const { design, selectedRegionId } = props;
  const regions = design.state.regions;
  // Layers panel lists topmost first, like Photoshop. This is also the order
  // customers see the options in.
  const ordered = formOrder(regions);
  const region = regions.find((r) => r.id === selectedRegionId);
  const [renaming, setRenaming] = useState<string | null>(null);
  // Drag-to-restack: the dragged layer and where it would land (index in `ordered`, 0..n).
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  /** Move a layer to slot `at` of the topmost-first list; sort_order is its mirror. */
  const restack = (id: string, at: number) =>
    design.commit((s) => {
      const list = formOrder(s.regions);
      const from = list.findIndex((r) => r.id === id);
      if (from < 0) return s;
      const to = at > from ? at - 1 : at;
      if (to === from) return s;
      const [moved] = list.splice(from, 1);
      list.splice(to, 0, moved);
      // Stored bottom-first: the save RPC rewrites sort_order from array position.
      const bottomFirst = list.reverse();
      return { ...s, regions: bottomFirst.map((r, k) => ({ ...r, sort_order: k })) };
    });

  const endDrag = () => {
    setDragId(null);
    setDropAt(null);
  };

  const remove = (id: string) => {
    // Its child zones go with it.
    const gone = zoneSubtree(regions, id);
    design.commit((s) => ({ ...s, regions: s.regions.filter((r) => !gone.has(r.id)), items: s.items.filter((i) => !gone.has(i.region_id)) }));
    props.onSelectRegion(null);
  };

  const rename = (id: string, name: string) => {
    setRenaming(null);
    const clean = name.trim();
    if (!clean) return;
    design.commit((s) => updateRegion(s, id, (r) => (r.name === clean ? r : { ...r, name: clean })));
  };

  return (
    <div className="flex h-full flex-col text-sm">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="font-semibold">Layers</span>
        <CtTooltip label={props.showOverlay ? "Ẩn khung vùng" : "Hiện khung vùng"} side="left">
          <button className="rounded p-1 hover:bg-accent" onClick={props.onToggleOverlay}>
            {props.showOverlay ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </button>
        </CtTooltip>
      </div>
      <div className="max-h-[40%] overflow-y-auto border-b">
        {ordered.length === 0 && (
          <p className="px-3 py-4 text-xs text-muted-foreground">Chưa có layer.</p>
        )}
        {ordered.map((r, index) => {
          const Icon = KIND_ICON[r.kind];
          const hasFrame = r.kind === "photo" && r.config.photo?.frame?.enabled !== false && hasTestPhoto(props.selection[r.id]);
          const frameActive = hasFrame && r.id === selectedRegionId && props.frameSelected;
          return (
            <Fragment key={r.id}>
            <div
              draggable={renaming !== r.id}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                // Firefox refuses to start a drag without data.
                e.dataTransfer.setData("text/plain", r.id);
                setDragId(r.id);
              }}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const box = e.currentTarget.getBoundingClientRect();
                setDropAt(e.clientY < box.top + box.height / 2 ? index : index + 1);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId && dropAt !== null) restack(dragId, dropAt);
                endDrag();
              }}
              onDragEnd={endDrag}
              onClick={() => props.onSelectRegion(r.id)}
              className={cx(
                "group relative flex cursor-pointer items-center gap-2 px-3 py-1.5",
                r.id === selectedRegionId && !frameActive ? "bg-sky-500/15" : "hover:bg-accent",
                r.id === dragId && "opacity-40",
              )}
            >
              {dragId && dropAt === index && <span className="pointer-events-none absolute inset-x-1 top-0 h-0.5 -translate-y-1/2 rounded bg-sky-500" />}
              {dragId && dropAt === index + 1 && index === ordered.length - 1 && (
                <span className="pointer-events-none absolute inset-x-1 bottom-0 h-0.5 translate-y-1/2 rounded bg-sky-500" />
              )}
              <GripVertical className="-ml-2 h-3.5 w-3.5 shrink-0 cursor-grab text-muted-foreground/50 active:cursor-grabbing" />
              {r.config.parent && (
                <CtTooltip label={`Option con của “${parentLabel(regions, props.assets, r)}”`}>
                  <CornerDownRight className="h-3 w-3 shrink-0 text-orange-500" />
                </CtTooltip>
              )}
              <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              {renaming === r.id ? (
                <input
                  autoFocus
                  defaultValue={r.name}
                  className="h-6 min-w-0 flex-1 rounded border border-input bg-background px-1.5 text-sm outline-none focus:ring-2 focus:ring-sky-500/60"
                  onClick={(e) => e.stopPropagation()}
                  onFocus={(e) => e.target.select()}
                  onBlur={(e) => rename(r.id, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setRenaming(null);
                  }}
                />
              ) : (
                <span className="flex-1 truncate" title={r.name} onDoubleClick={(e) => { e.stopPropagation(); setRenaming(r.id); }}>
                  {layerLabel(r.name)}
                  {outsideSafe(props.print ?? null, r) && (
                    <span title="Ngoài safe zone — có thể bị cắt khi in">
                      <AlertTriangle className="ml-1 inline h-3 w-3 text-amber-500" />
                    </span>
                  )}
                  {r.config.fill && <span className="ml-1 text-[10px] text-muted-foreground">{r.config.fill.mode === "tile" ? "hoa văn" : "phủ"}</span>}
                  {r.config.printOnly && <span className="ml-1 text-[10px] text-muted-foreground">chỉ in</span>}
                </span>
              )}
              {renaming !== r.id && (
                <span className="hidden gap-0.5 group-hover:flex">
                  <LayerButton label="Xoá layer" shortcut={["Del"]} danger onClick={() => remove(r.id)}>
                    <Trash2 className="h-3 w-3" />
                  </LayerButton>
                </span>
              )}
            </div>
            {hasFrame && (
              // The child frame: its own row under the zone — select it to move / turn it, delete it without the zone.
              <div
                onClick={() => props.onSelectFrame(r.id)}
                className={cx("group flex cursor-pointer items-center gap-2 py-1 pl-9 pr-3 text-xs", frameActive ? "bg-purple-500/15" : "hover:bg-accent")}
              >
                <Frame className="h-3.5 w-3.5 shrink-0 text-purple-500" />
                <span className="flex-1 truncate text-muted-foreground">
                  Khung ảnh{r.config.photo.frame.auto ? " · tự khớp" : ""}
                </span>
                <span className="hidden gap-0.5 group-hover:flex">
                  <LayerButton label="Xoá khung ảnh (giữ vùng)" shortcut={["Del"]} danger onClick={() => props.onRemoveFrame(r.id)}>
                    <Trash2 className="h-3 w-3" />
                  </LayerButton>
                </span>
              </div>
            )}
            </Fragment>
          );
        })}
        {props.mainLayer && (
          // The version's own picture: always the bottom row (layers marked "dưới main" are drawn behind it).
          <div
            onClick={props.onSelectMain}
            className={cx("flex cursor-pointer items-center gap-2 border-t px-3 py-1.5 text-xs", props.mainSelected && !region ? "bg-emerald-500/15" : "hover:bg-accent")}
          >
            <span className="h-5 w-5 shrink-0 overflow-hidden rounded border" style={CHECKER_STYLE}>
              <img src={props.mainLayer.asset.url} alt="" className="h-full w-full object-contain" />
            </span>
            <span className="flex-1 truncate">
              Nền · <span className="text-muted-foreground">{props.mainLayer.asset.name || "version"}</span>
            </span>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {region ? (
          <RegionProps {...props} region={normalizeRegion(region)} />
        ) : props.mainSelected && props.mainLayer ? (
          <MainFrameProps layer={props.mainLayer} onChange={props.onMainFrame} />
        ) : (
          <ArtworkOptions {...props} />
        )}
      </div>
    </div>
  );
}

/** The version's picture frame on the artboard: position, size, turn; fit / fill the artboard. */
function MainFrameProps({ layer, onChange }: { layer: NonNullable<InspectorProps["mainLayer"]>; onChange: (f: CtMainFrame) => void }) {
  const f = layer.frame;
  const { w: bw, h: bh } = layer.board;
  const aspect = layer.asset.width / Math.max(1, layer.asset.height);
  const [lock, setLock] = useState(true);
  const set = (patch: Partial<CtMainFrame>) => onChange({ ...f, ...patch });
  const round = (v: number) => Math.round(v * 10) / 10;
  const fit = (cover: boolean) => {
    const s = cover ? Math.max(bw / layer.asset.width, bh / layer.asset.height) : Math.min(bw / layer.asset.width, bh / layer.asset.height);
    const w = layer.asset.width * s;
    const h = layer.asset.height * s;
    onChange({ x: (bw - w) / 2, y: (bh - h) / 2, w, h, rotation: 0 });
  };
  return (
    <div className="space-y-3 p-3">
      <div>
        <div className="text-xs font-semibold">Ảnh nền của version</div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <CtField label="X">
          <CtNumber value={round(f.x)} onChange={(x) => set({ x })} />
        </CtField>
        <CtField label="Y">
          <CtNumber value={round(f.y)} onChange={(y) => set({ y })} />
        </CtField>
        <CtField label="Rộng">
          <CtNumber value={round(f.w)} min={4} onChange={(w) => set(lock ? { w, h: w / aspect } : { w })} />
        </CtField>
        <CtField label="Cao">
          <CtNumber value={round(f.h)} min={4} onChange={(h) => set(lock ? { h, w: h * aspect } : { h })} />
        </CtField>
        <CtField label="Xoay °">
          <CtNumber value={round(f.rotation)} onChange={(rotation) => set({ rotation })} />
        </CtField>
        <CtField label="Tỉ lệ">
          <CtNumber value={Math.round((f.w / Math.max(1, layer.asset.width)) * 1000) / 10} onChange={(pct) => set({ w: (layer.asset.width * pct) / 100, h: (layer.asset.height * pct) / 100 })} />
        </CtField>
      </div>
      <CtCheckbox checked={lock} onChange={setLock} label="Giữ tỉ lệ ảnh" />
      <div className="flex flex-wrap gap-1.5">
        <CtButton size="sm" onClick={() => fit(false)}>
          Vừa khung
        </CtButton>
        <CtButton size="sm" onClick={() => fit(true)}>
          Phủ kín khung
        </CtButton>
        <CtButton size="sm" onClick={() => set({ x: (bw - f.w) / 2, y: (bh - f.h) / 2 })}>
          Canh giữa
        </CtButton>
        <CtButton size="sm" variant="ghost" onClick={() => onChange({ x: 0, y: 0, w: bw, h: bh, rotation: 0 })}>
          Reset
        </CtButton>
      </div>
    </div>
  );
}

function LayerButton({
  label,
  shortcut,
  danger,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string[];
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <CtTooltip label={label} shortcut={shortcut} side="left">
      <button
        className={cx("rounded p-0.5 hover:bg-background", danger && "text-destructive")}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
      >
        {children}
      </button>
    </CtTooltip>
  );
}

function RegionProps(props: InspectorProps & { region: CtRegion }) {
  const { design, region } = props;
  const b = shapeBounds(region.shape);
  const set = (fn: (r: CtRegion) => CtRegion) => design.commit((s) => updateRegion(s, region.id, (r) => fn(normalizeRegion(r))));
  const setBounds = (patch: Partial<typeof b>) => set((r) => ({ ...r, shape: fitShapeToBounds(r.shape, { ...b, ...patch }) }));
  const cfg = region.config;
  const setText = (patch: Partial<typeof cfg.text>) => {
    set((r) => ({ ...r, config: { ...r.config, text: { ...r.config.text, ...patch } } }));
    // A sample still showing the old default text follows the new one (e.g. "SOPHIA" → "25/12/2026" on a date zone).
    const sample = props.selection[region.id];
    const isDate = (patch.format ?? cfg.text.format) === "date";
    if (patch.defaultText !== undefined && sample?.kind === "text" && (sample.text === cfg.text.defaultText || !sample.text || (isDate && !isValidDate(sample.text)))) {
      props.onSampleText(region.id, patch.defaultText);
    }
  };

  return (
    <div className="space-y-4 p-3">
      <CtField label="Tên layer">
        <CtInput value={region.name} onChange={(e) => set((r) => ({ ...r, name: e.target.value }))} />
      </CtField>

      <div className="grid grid-cols-4 gap-1.5">
        {(["x", "y", "w", "h"] as const).map((k) => (
          <CtField key={k} label={k.toUpperCase()}>
            <CtNumber value={Math.round(b[k])} onChange={(v) => setBounds({ [k]: v })} />
          </CtField>
        ))}
      </div>
      {outsideSafe(props.print ?? null, region) && (
        <p className="flex items-start gap-1.5 rounded bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Ngoài vùng in an toàn — có thể bị cắt khi in.
        </p>
      )}
      {region.kind === "photo" && region.config.photo.frame.enabled && (
        <ZoneTiltField
          region={region}
          onChange={(tilt) =>
            set((r) => {
              const f = r.config.photo.frame;
              // An auto frame follows the tilt by itself; a frame placed by hand is turned to it, where it is.
              const frame = f.auto ? { ...f, tilt } : { ...f, tilt, rotation: tilt ?? orientedBox(r.shape).rotation };
              return { ...r, config: { ...r.config, photo: { ...r.config.photo, frame } } };
            })
          }
        />
      )}
      {region.shape.type === "rect" && region.kind === "photo" && (
        <CtField label="Bo góc (px)">
          <CtNumber
            value={region.shape.radius}
            min={0}
            onChange={(v) => set((r) => (r.shape.type === "rect" ? { ...r, shape: { ...r.shape, radius: Math.max(0, v) } } : r))}
          />
        </CtField>
      )}

      {region.kind === "text" && (
        <div className="space-y-3 border-t pt-3">
          <CtField label="Chữ này">
            <CtSelect<CtTextMode>
              value={textMode(region)}
              onChange={(mode) => setText({ mode })}
              options={[
                { value: "input", label: "Khách nhập" },
                { value: "fixed", label: "Cố định" },
                { value: "list", label: "Khách chọn trong danh sách" },
                // Older designs only.
                ...(textMode(region) === "options" ? [{ value: "options" as const, label: "Khách chọn option" }] : []),
              ]}
            />
          </CtField>
          {textMode(region) !== "fixed" && (
            <CtField label="Nhãn cho khách">
              <CtInput value={cfg.text.label} onChange={(e) => setText({ label: e.target.value })} />
            </CtField>
          )}
          {textMode(region) === "fixed" && (
            <CtField label="Chữ (cố định)">
              <CtInput value={cfg.text.defaultText} onChange={(e) => setText({ defaultText: e.target.value })} />
            </CtField>
          )}
          {textMode(region) === "list" && (
            <CtField label="Danh sách chữ (mỗi dòng 1 lựa chọn)">
              <CtTextarea
                rows={3}
                value={cfg.text.choices.join("\n")}
                placeholder={"New Driver\nBaby on Board"}
                onChange={(e) => setText({ choices: e.target.value.split("\n").map((l) => l.trimStart()).filter((l, i, all) => l !== "" || i === all.length - 1) })}
                onBlur={(e) => setText({ choices: e.target.value.split("\n").map((l) => l.trim()).filter(Boolean) })}
              />
            </CtField>
          )}
          {textMode(region) === "input" && (
            <>
              <CtField label="Kiểu nhập">
                <CtSelect<CtTextFormat>
                  value={cfg.text.format ?? "text"}
                  onChange={(format) =>
                    setText(format === "date" ? { format, maxChars: 10, placeholder: "dd/mm/yyyy", defaultText: /^\d{2}\/\d{2}\/\d{4}$/.test(cfg.text.defaultText) ? cfg.text.defaultText : "25/12/2026" } : { format })
                  }
                  options={[
                    { value: "text", label: "Chữ tự do" },
                    { value: "date", label: "Ngày (dd/mm/yyyy)" },
                  ]}
                />
              </CtField>
              <div className="grid grid-cols-2 gap-2">
                <CtField label="Chữ mặc định">
                  <CtInput value={cfg.text.defaultText} onChange={(e) => setText({ defaultText: e.target.value })} />
                </CtField>
                <CtField label="Tối đa ký tự">
                  <CtNumber value={cfg.text.maxChars} min={1} onChange={(v) => setText({ maxChars: Math.max(1, Math.round(v)) })} />
                </CtField>
              </div>
              <CtField label="Placeholder">
                <CtInput value={cfg.text.placeholder} onChange={(e) => setText({ placeholder: e.target.value })} />
              </CtField>
            </>
          )}
          <CtField label="Font">
            <CtSelect value={cfg.text.fontFamily} onChange={(fontFamily) => setText({ fontFamily })} options={CT_FONTS.map((f) => ({ value: f.family, label: f.label }))} />
          </CtField>
          <div className="grid grid-cols-3 gap-2">
            <CtField label="Cỡ (px)">
              <CtNumber value={cfg.text.fontSize} min={4} onChange={(v) => setText({ fontSize: v })} />
            </CtField>
            <CtField label="Độ đậm">
              <CtNumber value={cfg.text.fontWeight} step={100} min={100} max={900} onChange={(v) => setText({ fontWeight: v })} />
            </CtField>
            <CtField label="Giãn chữ %">
              <CtNumber value={cfg.text.letterSpacing} onChange={(v) => setText({ letterSpacing: v })} />
            </CtField>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <CtField label="Màu">
              <input type="color" className="h-8 w-full rounded border border-input bg-transparent" value={cfg.text.color} onChange={(e) => setText({ color: e.target.value })} />
            </CtField>
            <CtField label="Viền">
              <input type="color" className="h-8 w-full rounded border border-input bg-transparent" value={cfg.text.strokeColor} onChange={(e) => setText({ strokeColor: e.target.value })} />
            </CtField>
            <CtField label="Dày viền">
              <CtNumber value={cfg.text.strokeWidth} min={0} onChange={(v) => setText({ strokeWidth: Math.max(0, v) })} />
            </CtField>
          </div>
          <CtField label={`Uốn cong: ${cfg.text.curve}`}>
            <input
              type="range"
              min={-100}
              max={100}
              className="w-full accent-sky-500"
              value={cfg.text.curve}
              onChange={(e) =>
                design.live((s) =>
                  updateRegion(s, region.id, (r) => {
                    const n = normalizeRegion(r);
                    // Bent by hand: the brim's fixed circle (arcRadius, arcTilt) gives way to the slider.
                    return { ...n, config: { ...n.config, text: { ...n.config.text, curve: Number(e.target.value), arcRadius: undefined, arcTilt: undefined } } };
                  }),
                )
              }
              onPointerUp={() => design.checkpoint()}
            />
          </CtField>
          <div className="grid grid-cols-2 gap-2">
            <CtField label="Căn lề">
              <CtSelect<CtTextAlign>
                value={cfg.text.align}
                onChange={(align) => setText({ align })}
                options={[{ value: "left", label: "Trái" }, { value: "center", label: "Giữa" }, { value: "right", label: "Phải" }]}
              />
            </CtField>
            <div className="flex items-end pb-1.5">
              <CtCheckbox checked={cfg.text.uppercase} onChange={(v) => setText({ uppercase: v })} label="IN HOA" />
            </div>
          </div>
        </div>
      )}

      {region.kind === "photo" && <PhotoProps key={region.id} {...props} />}
      {region.kind === "image" && <ImageProps {...props} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Customer photo zone
// ---------------------------------------------------------------------------

function PhotoProps({ design, region, selection, onPhotoSelection, onPhotoBusy }: InspectorProps & { region: CtRegion }) {
  const cfg = region.config;
  const set = (patch: Partial<typeof cfg.photo>) =>
    design.commit((s) => updateRegion(s, region.id, (r) => { const n = normalizeRegion(r); return { ...n, config: { ...n.config, photo: { ...n.config.photo, ...patch } } }; }));
  const cur = selection[region.id];
  const sel: CtPhotoSelection = cur?.kind === "photo" ? cur : { kind: "photo", url: null, transform: { ...IDENTITY_TRANSFORM } };
  /** The test photo's size: an auto frame takes its shape. */
  const photoSize = useImageSize(sel.url);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const setT = (patch: Partial<CtTransform>) => onPhotoSelection(region.id, { ...sel, transform: { ...sel.transform, ...patch } });
  const styles = cfg.photo.styles;
  const [caps, setCaps] = useState<CtPhotoCapabilities | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What customers get (CtPhotoConfig.mode / styles) vs the tab open here. The tab last picked is saved as the
  // zone's `mode` and opens again next time; a zone never given a tab opens with none (pick one first).
  const configured = photoMode(cfg.photo);
  const [tab, setTab] = useState<CtPhotoMode | null>(cfg.photo.mode ?? null);
  const [guide, setGuide] = useState(false);
  const [dialog, setDialog] = useState<CtAiStyle | "new" | null>(null);
  const ai = useAiStyles();
  /** `${sourceUrl}|${style}|${cutout}|${fadeCrop}|${version}` → rendered blob URL, so flipping styles doesn't re-bill the AI. */
  const renders = useRef(new Map<string, string>());
  const label = (ref: CtPhotoStyleRef) => styleLabel(ref, ai.names);

  useEffect(() => {
    ctApi.photoCapabilities().then(setCaps).catch(() => setCaps(null));
  }, []);

  /** The zone's AI styles still in the library (the first = the default one when none is set). */
  const pickedAi: CtPhotoStyleRef[] = styles.filter((s) => isAiStyleRef(s) && ai.styles.some((x) => aiStyleRef(x.id) === s));
  const selectedAi = pickedAi.includes(cfg.photo.defaultStyle) ? cfg.photo.defaultStyle : pickedAi[0];
  /** Built-in "Watercolor + Ink" first, then any built-in, then the first in the library. */
  const defaultAi = (): CtPhotoStyleRef | null => {
    const pick =
      ai.styles.find((s) => !s.user_id && /watercolor/i.test(s.name)) ?? ai.styles.find((s) => !s.user_id) ?? ai.styles[0];
    return pick ? aiStyleRef(pick.id) : null;
  };

  // The AI tab always has at least one style: the default one as soon as the tab is picked.
  useEffect(() => {
    if (tab !== "ai" || !ai.loaded || selectedAi) return;
    const ref = defaultAi();
    if (ref) set({ styles: [ref], defaultStyle: ref });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, ai.loaded, ai.styles, selectedAi]);

  /** The tabs are the mode: Free = no-AI filters, AI = one generative style, Face = face crop + colour filters. */
  const switchTab = (t: CtPhotoMode) => {
    setTab(t);
    if (t === configured) {
      // An older zone's family was only implied by its styles: save the pick.
      if (cfg.photo.mode !== t) set({ mode: t });
      return;
    }
    const same = styles.filter((s) => styleFamily(s) === t);
    if (t === "ai") {
      const ref = selectedAi ?? defaultAi();
      set(ref ? { mode: t, styles: pickedAi.length ? pickedAi : [ref], defaultStyle: ref } : { mode: t });
    } else {
      const list: CtPhotoStyleRef[] = t === "face" ? CT_FACE_STYLES.map((s) => s.id) : same.length ? same : ["original"];
      // A face is a trimmed head cut-out: "contain" keeps its ears / chin inside the frame, which fits itself to the head.
      set({ mode: t, styles: list, defaultStyle: list[0], ...(t === "face" ? { fit: "contain" as const, frame: { ...IDENTITY_PHOTO_FRAME, auto: true } } : {}) });
    }
  };

  /**
   * Free styles: any number, customer picks from a dropdown (catalog order).
   * AI styles: any number (≥ 1, library order), customer picks by demo picture.
   * The families don't mix (lib/design.ts normalizePhotoConfig enforces it too).
   */
  const toggleStyle = (ref: CtPhotoStyleRef, on: boolean) => {
    if (isAiStyleRef(ref)) {
      const next: CtPhotoStyleRef[] = ai.styles.map((x) => aiStyleRef(x.id)).filter((s) => (s === ref ? on : pickedAi.includes(s)));
      if (next.length === 0) return;
      set({ mode: "ai", styles: next, defaultStyle: next.includes(cfg.photo.defaultStyle) ? cfg.photo.defaultStyle : next[0] });
      return;
    }
    const family = styleFamily(ref);
    const catalog = family === "face" ? CT_FACE_STYLES : CT_FREE_STYLES;
    const next: CtPhotoStyleRef[] = catalog.map((s) => s.id).filter((s) => (s === ref ? on : styles.includes(s)));
    if (next.length === 0) return;
    set({ styles: next, defaultStyle: next.includes(cfg.photo.defaultStyle) ? cfg.photo.defaultStyle : next[0] });
  };

  const version = (ref: CtPhotoStyleRef) => (isAiStyleRef(ref) ? ai.styles.find((s) => aiStyleRef(s.id) === ref)?.updated_at ?? "" : "");

  /** Render the test photo in `style` exactly like the storefront would (same caching rules). */
  const getRender = async (sourceUrl: string, style: CtPhotoStyleRef): Promise<string> => {
    const key = `${sourceUrl}|${style}|${cfg.photo.cutout}|${cfg.photo.fadeCrop}|${version(style)}`;
    const cached = renders.current.get(key);
    if (cached) return cached;
    const engine = styleEngine(style);
    let url: string;
    if (engine === "none" && !cfg.photo.cutout) url = sourceUrl;
    else if (engine === "local" && cfg.photo.cutout) {
      // Filter the cut-out "Real photo" instead of cutting out again.
      const base = await fetch(await getRender(sourceUrl, "original")).then((r) => r.blob());
      url = URL.createObjectURL(await processPhoto({ source: base, style, cutout: false, endpoint: ctApi.photoEndpoint(region.product_id) }));
    } else {
      const source = await fetch(sourceUrl).then((r) => r.blob());
      url = URL.createObjectURL(await processPhoto({ source, style, cutout: cfg.photo.cutout, fadeCrop: cfg.photo.fadeCrop, endpoint: ctApi.photoEndpoint(region.product_id) }));
    }
    renders.current.set(key, url);
    return url;
  };

  const renderTest = async (sourceUrl: string, style: CtPhotoStyleRef, base: CtPhotoSelection) => {
    setError(null);
    const text = needsServer(style, cfg.photo.cutout) ? `Đang xử lý ${label(style)}${isAiStyleRef(style) ? " (AI, ~30–60 giây)" : ""}…` : "Đang lọc…";
    setWorking(text);
    onPhotoBusy(region.id, text);
    try {
      const url = await getRender(sourceUrl, style);
      onPhotoSelection(region.id, { ...base, url, style, sourceUrl });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Xử lý ảnh thất bại");
    } finally {
      setWorking(null);
      onPhotoBusy(region.id, null);
    }
  };

  const warn = [
    caps && styles.some(isAiStyleRef) && !caps.aiStyles ? "Style AI chưa dùng được trên server này." : "",
    caps && cfg.photo.cutout && !caps.cutout ? "Tách nền chưa dùng được trên server này." : "",
    caps && tab === "face" && !caps.faceDetect ? "Tìm khuôn mặt chưa dùng được trên server này." : "",
    ai.error ?? "",
  ].filter(Boolean);

  return (
    <div className="space-y-3 border-t pt-3">
      <CtField label="Nhãn cho khách">
        <CtInput value={cfg.photo.label} onChange={(e) => set({ label: e.target.value })} />
      </CtField>
      <CtField label="Fit ảnh">
        <CtSelect<"cover" | "contain">
          value={cfg.photo.fit}
          onChange={(fit) => set({ fit })}
          options={[{ value: "cover", label: "Cover — phủ kín vùng" }, { value: "contain", label: "Contain — thấy toàn ảnh" }]}
        />
      </CtField>
      <CtCheckbox checked={cfg.photo.required} onChange={(v) => set({ required: v })} label="Bắt buộc upload trước khi thêm vào giỏ" />

      {!hasTestPhoto(cur) ? null : cfg.photo.frame?.enabled !== false ? (
        <PhotoFrameFields
          frame={resolvePhotoFrame(cfg.photo, region.shape, photoSize)}
          auto={cfg.photo.frame?.auto ?? false}
          onChange={(frame) => set({ frame })}
        />
      ) : (
        <CtButton size="sm" variant="outline" className="w-full" onClick={() => set({ frame: { ...IDENTITY_PHOTO_FRAME, auto: true } })}>
          <Frame className="h-3.5 w-3.5" /> Thêm khung ảnh
        </CtButton>
      )}

      {/* Subject cut-out + cropped-edge fade are always applied (lib/design.ts normalizePhotoConfig). */}
      <div className="space-y-2.5 rounded-md border p-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Style cho khách chọn</span>
          <button type="button" className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-sky-600 hover:bg-sky-500/10" onClick={() => setGuide(true)}>
            <HelpCircle className="h-3.5 w-3.5" /> Hướng dẫn
          </button>
        </div>
        <div className="grid grid-cols-3 rounded-md bg-muted p-0.5 text-xs">
          {(["free", "ai", "face"] as const).map((t) => {
            // The badge marks the family customers get, even while no tab is open.
            const n = configured === t ? styles.length : 0;
            return (
              <button
                key={t}
                type="button"
                onClick={() => switchTab(t)}
                className={cx("rounded px-2 py-1 font-medium", tab === t ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}
              >
                {t === "free" ? "Free" : t === "ai" ? "AI tạo ảnh" : "Face"}
                {n > 0 && <span className="ml-1 rounded-full bg-sky-500/15 px-1.5 text-[10px] text-sky-600">{n}</span>}
              </button>
            );
          })}
        </div>

        {tab === null ? (
          <p className="rounded border border-dashed p-2 text-center text-[11px] text-muted-foreground">
            Khách đang thấy: {configured ? styles.map(label).join(", ") : "ảnh gốc"}
          </p>
        ) : tab === "face" ? (
          <div className="space-y-1.5">
            <div className="flex flex-wrap gap-1">
              {CT_FACE_STYLES.map((s) => (
                <span key={s.id} className="rounded-full border px-2 py-0.5 text-[11px]" title={s.hint}>
                  {s.label.replace(/^Face · /, "")}
                </span>
              ))}
            </div>
          </div>
        ) : tab === "free" ? (
          <div className="space-y-1.5">
            {CT_FREE_STYLES.map((s) => (
              <CtCheckbox key={s.id} checked={styles.includes(s.id)} onChange={(v) => toggleStyle(s.id, v)} label={s.label} hint={s.hint} />
            ))}
          </div>
        ) : (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground">Thư viện chung · {ai.styles.length} style</span>
              <div className="flex gap-1">
                <CtButton size="sm" variant="primary" onClick={() => setDialog("new")}>
                  <Plus className="h-3.5 w-3.5" /> Thêm mới
                </CtButton>
              </div>
            </div>
            {ai.styles.length === 0 && !ai.loading && <p className="rounded border border-dashed p-2 text-center text-[11px] text-muted-foreground">Chưa có style AI nào.</p>}
            {ai.styles.length > 0 && (
              <div className="grid grid-cols-3 gap-1.5">
                {ai.styles.map((st) => {
                  const ref = aiStyleRef(st.id);
                  const on = pickedAi.includes(ref);
                  return (
                    <div key={st.id} className={cx("relative overflow-hidden rounded-md border text-left", on ? "border-sky-500 ring-1 ring-sky-500" : "opacity-70 hover:opacity-100")}>
                      <button type="button" className="block w-full" title={on ? "Bỏ style này" : "Cho khách chọn style này"} onClick={() => toggleStyle(ref, !on)}>
                        <div className="flex aspect-square items-center justify-center bg-[repeating-conic-gradient(#f1f1f1_0_25%,#fff_0_50%)] bg-[length:12px_12px]">
                          {st.params.demoUrl ? <img src={st.params.demoUrl} alt={st.name} className="h-full w-full object-contain" /> : <span className="px-1 text-center text-[10px] text-muted-foreground">chưa có demo</span>}
                        </div>
                        <div className="truncate px-1 py-0.5 text-[10px] font-medium">{st.name}</div>
                      </button>
                      {on && <span className="absolute left-1 top-1 rounded bg-sky-500 px-1 text-[9px] font-semibold text-white">{ref === selectedAi ? "Mặc định" : "Bật"}</span>}
                      <button type="button" className="absolute right-1 top-1 rounded bg-background/80 px-1 text-[9px] hover:bg-background" title={st.can_edit ? "Sửa prompt / tạo ảnh demo" : "Xem style"} onClick={() => setDialog(st)}>
                        {st.can_edit ? "Sửa" : "Xem"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {pickedAi.length > 1 && (
              <div className="grid grid-cols-2 gap-2">
                <CtField label="Nhãn cho khách">
                  <CtInput value={cfg.photo.styleLabel} placeholder="Choose style" onChange={(e) => set({ styleLabel: e.target.value })} />
                </CtField>
                <CtField label="Mặc định">
                  <CtSelect<CtPhotoStyleRef> value={selectedAi ?? pickedAi[0]} onChange={(defaultStyle) => set({ defaultStyle })} options={pickedAi.map((id) => ({ value: id, label: label(id) }))} />
                </CtField>
              </div>
            )}
          </div>
        )}

        {(tab === "free" || tab === "face") && styles.length > 1 && !styles.some(isAiStyleRef) && (
          <div className="grid grid-cols-2 gap-2">
            <CtField label="Nhãn dropdown">
              <CtInput value={cfg.photo.styleLabel} placeholder="Choose style" onChange={(e) => set({ styleLabel: e.target.value })} />
            </CtField>
            <CtField label="Mặc định">
              <CtSelect<CtPhotoStyleRef>
                value={cfg.photo.defaultStyle}
                onChange={(defaultStyle) => set({ defaultStyle })}
                options={styles.map((id) => ({ value: id, label: label(id) }))}
              />
            </CtField>
          </div>
        )}
        {warn.map((w) => (
          <p key={w} className="rounded bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400">{w}</p>
        ))}
      </div>
      <PhotoGuideDialog
        open={guide}
        onClose={() => setGuide(false)}
        productId={region.product_id}
        aiStyle={(() => {
          const ref = selectedAi ?? defaultAi();
          return ref ? { ref, name: label(ref) } : null;
        })()}
      />
      <AiStyleDialog key={dialog === null ? "closed" : dialog === "new" ? "new" : dialog.id} target={dialog} onClose={() => setDialog(null)} onSaved={(st) => !styles.includes(aiStyleRef(st.id)) && dialog === "new" && toggleStyle(aiStyleRef(st.id), true)} />

      <div className="space-y-2 rounded-md border p-2.5">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Thử ảnh khách</div>
        <div className="flex gap-1.5">
          <CtButton
            size="sm"
            variant="primary"
            disabled={working !== null}
            onClick={() => (tab === null ? setError("Chọn 1 style trước.") : fileRef.current?.click())}
          >
            <Upload className="h-3.5 w-3.5" /> {sel.url ? "Đổi ảnh test" : "Upload ảnh test"}
          </CtButton>
          {(sel.url || sel.sourceUrl) && (
            <CtButton size="sm" variant="ghost" disabled={working !== null} onClick={() => {
                // The frame goes with the photo; the next upload works out a new one. Customers get the auto frame.
                if (!cfg.photo.frame.auto || !cfg.photo.frame.enabled) set({ frame: { ...IDENTITY_PHOTO_FRAME, auto: true, tilt: cfg.photo.frame.tilt } });
                onPhotoSelection(region.id, { kind: "photo", url: null, transform: { ...IDENTITY_TRANSFORM } });
              }}>
              <X className="h-3.5 w-3.5" /> Bỏ
            </CtButton>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            const sourceUrl = URL.createObjectURL(f);
            // A new photo always gets a fresh child frame — also after the frame was deleted: worked out again from the
            // zone (its outline, tilt) and this photo. The zone's tilt is the zone's: it stays.
            const fr = cfg.photo.frame;
            if (!fr.enabled || !fr.auto) set({ frame: { ...IDENTITY_PHOTO_FRAME, auto: true, tilt: fr.tilt } });
            // The raw upload never goes into the frame: the zone stays empty (with a spinner) until the processed photo is ready.
            const base: CtPhotoSelection = { kind: "photo", url: null, transform: { ...IDENTITY_TRANSFORM }, style: cfg.photo.defaultStyle, sourceUrl };
            onPhotoSelection(region.id, base);
            void renderTest(sourceUrl, cfg.photo.defaultStyle, base);
          }}
        />
        {sel.sourceUrl && styles.length > 1 && (
          <CtField label="Style">
            <CtSelect<CtPhotoStyleRef>
              value={sel.style ?? "original"}
              disabled={working !== null}
              onChange={(style) => sel.sourceUrl && void renderTest(sel.sourceUrl, style, sel)}
              options={styles.map((id) => ({ value: id, label: label(id) }))}
            />
          </CtField>
        )}
        {working && (
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> {working}
          </p>
        )}
        {error && <p className="text-[11px] text-destructive">{error}</p>}
        {sel.url && (
          <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 pt-1">
            <RangeField label={`Zoom ${Math.round(sel.transform.scale * 100)}%`} min={20} max={400} value={sel.transform.scale * 100} onChange={(v) => setT({ scale: v / 100 })} />
            <RangeField label={`Xoay ${Math.round(sel.transform.rotation)}°`} min={-180} max={180} value={sel.transform.rotation} onChange={(v) => setT({ rotation: v })} />
            <RangeField label="Ngang" min={-100} max={100} value={sel.transform.offsetX * 100} onChange={(v) => setT({ offsetX: v / 100 })} />
            <RangeField label="Dọc" min={-100} max={100} value={sel.transform.offsetY * 100} onChange={(v) => setT({ offsetY: v / 100 })} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The zone's child frame (CtPhotoFrame) as numbers — the same frame Object mode (↵ / double-click) drags on the canvas.
 * `frame` is the frame in use (worked out for the test photo when auto); editing a number pins it (auto off).
 */
function PhotoFrameFields({ frame, auto, onChange }: { frame: CtPhotoFrame; auto: boolean; onChange: (f: CtPhotoFrame) => void }) {
  const set = (patch: Partial<CtPhotoFrame>) => onChange({ ...frame, ...patch, auto: false });
  const pct = (v: number) => Math.round(v * 1000) / 10;
  const moved = frame.offsetX !== 0 || frame.offsetY !== 0 || frame.scaleX !== 1 || frame.scaleY !== 1 || frame.rotation !== 0;
  return (
    <div className="space-y-2 rounded-md border p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Khung ảnh</span>
        {!auto && moved && (
          <button type="button" className="text-[11px] text-sky-600 hover:underline" onClick={() => onChange({ ...IDENTITY_PHOTO_FRAME, auto: true, tilt: frame.tilt })}>
            Đặt lại
          </button>
        )}
      </div>
      <CtCheckbox
        checked={auto}
        onChange={(v) => onChange(v ? { ...frame, auto: true } : { ...frame, auto: false })}
        label="Tự khớp theo vùng & ảnh"
      />
      <div className="grid grid-cols-3 gap-2">
        <CtField label="Độ nghiêng °">
          <CtNumber value={frame.rotation} step={1} min={-180} max={180} onChange={(rotation) => set({ rotation })} />
        </CtField>
        <CtField label="Rộng %">
          <CtNumber value={pct(frame.scaleX)} step={1} min={2} max={2000} onChange={(v) => set({ scaleX: v / 100 })} />
        </CtField>
        <CtField label="Cao %">
          <CtNumber value={pct(frame.scaleY)} step={1} min={2} max={2000} onChange={(v) => set({ scaleY: v / 100 })} />
        </CtField>
        <CtField label="Ngang %">
          <CtNumber value={pct(frame.offsetX)} step={1} min={-500} max={500} onChange={(v) => set({ offsetX: v / 100 })} />
        </CtField>
        <CtField label="Dọc %">
          <CtNumber value={pct(frame.offsetY)} step={1} min={-500} max={500} onChange={(v) => set({ offsetY: v / 100 })} />
        </CtField>
        <CtField label="Lề %">
          <CtNumber value={pct(frame.padding)} step={1} min={0} max={45} onChange={(v) => set({ padding: Math.min(0.45, Math.max(0, v / 100)) })} />
        </CtField>
      </div>
    </div>
  );
}

/**
 * The zone's own tilt (CtPhotoFrame.tilt) — what the child frame turns by. Empty = read from the outline
 * (a quad drawn on a tilted helmet); the value read is shown as the placeholder.
 */
function ZoneTiltField({ region, onChange }: { region: CtRegion; onChange: (tilt: number | null) => void }) {
  const tilt = region.config.photo.frame.tilt;
  const detected = orientedBox(region.shape).rotation;
  return (
    <CtField label="Độ nghiêng vùng °">
      <div className="flex gap-1.5">
        <CtNumber value={tilt ?? detected} step={1} min={-180} max={180} onChange={(v) => onChange(Math.round(v * 10) / 10)} />
        {tilt !== null && (
          <CtButton size="sm" variant="ghost" onClick={() => onChange(null)}>
            Tự động
          </CtButton>
        )}
      </div>
    </CtField>
  );
}

function RangeField({ label, min, max, value, onChange }: { label: string; min: number; max: number; value: number; onChange: (v: number) => void }) {
  return (
    <CtField label={label}>
      <input type="range" min={min} max={max} value={value} className="w-full accent-sky-500" onChange={(e) => onChange(Number(e.target.value))} />
    </CtField>
  );
}

// ---------------------------------------------------------------------------
// Custom layer: the pictures in it
// ---------------------------------------------------------------------------

function ImageProps(props: InspectorProps & { region: CtRegion }) {
  const { design, region, assets } = props;
  const cfg = region.config.image;
  const items = design.state.items.filter((i) => i.region_id === region.id).sort((a, c) => a.sort_order - c.sort_order);
  const byId = new Map(assets.map((a) => [a.id, a]));
  const leader = cfg.follows ? design.state.regions.find((r) => r.id === cfg.follows) : undefined;
  return (
    <div className="space-y-2 border-t pt-3">
      {leader && <p className="text-[11px] text-muted-foreground">Đổi theo layer “{leader.name}”</p>}
      {items.length > 0 && (
        <>
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Ảnh ({items.length})</div>
          {items.map((it) => (
            <GroupCard key={it.id} {...props} item={it} sub={byId.get(it.asset_id)} />
          ))}
        </>
      )}
    </div>
  );
}

function GroupCard(props: InspectorProps & { region: CtRegion; item: CtRegionItem; sub: CtAsset | undefined }) {
  const { design, region, item, sub, assets, activeItemId, selection } = props;
  const active = item.id === activeItemId;
  if (!sub) return null;
  const options = [sub, ...variantsOf(assets, sub.id)];
  const cur = selection[region.id];
  const shown = cur?.kind === "image" ? cur.assetId : null;
  const t = item.transform;
  const cfg = region.config.image;
  const hidden = new Set(cfg.hiddenAssetIds);
  const offered = options.filter((o) => !hidden.has(o.id));
  const def = defaultRegionSelection(region, design.state.items, assets);
  const defId = def.kind === "image" ? def.assetId : null;
  const isDefault = options.some((o) => o.id === defId);
  /** This option is what customers see first (and what the canvas shows). */
  const makeDefault = (id: string) => {
    if (id !== defId) design.commit((s) => updateRegion(s, region.id, (r) => { const n = normalizeRegion(r); return { ...n, config: { ...n.config, image: { ...n.config.image, defaultAssetId: id } } }; }));
    props.onPreviewOption(region.id, id);
  };

  const setT = (patch: Partial<CtTransform>) => design.commit((s) => updateItem(s, item.id, (i) => ({ ...i, transform: { ...i.transform, ...patch } })));
  const toggleHidden = (id: string) =>
    design.commit((s) =>
      updateRegion(s, region.id, (r) => {
        const n = normalizeRegion(r);
        const list = n.config.image.hiddenAssetIds;
        return { ...n, config: { ...n.config, image: { ...n.config.image, hiddenAssetIds: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] } } };
      }),
    );

  return (
    <div
      className={cx(
        "cursor-pointer rounded-md border p-2 transition-colors hover:border-orange-400/70",
        isDefault && "border-orange-500 bg-orange-500/5 ring-1 ring-orange-500",
        active && "border-rose-500 ring-1 ring-rose-500",
      )}
      onClick={(e) => {
        // The whole card picks this group as the default (its shown option, else its first offered one).
        if ((e.target as HTMLElement).closest("button,input,label")) return;
        if (!isDefault) makeDefault((offered.find((o) => o.id === shown) ?? offered[0] ?? sub).id);
      }}
    >
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={sub.name}>
          {cfg.groupNames[item.id]?.trim() || sub.name || "(không tên)"}
        </span>
        {isDefault && <span className="shrink-0 rounded bg-orange-500 px-1.5 text-[10px] font-medium leading-4 text-white">Mặc định</span>}
        <CtTooltip label="Chỉnh vị trí / scale / xoay trên canvas" shortcut={["Enter"]}>
          <button className={cx("rounded p-1 hover:bg-accent", active && "bg-rose-500/15 text-rose-500")} onClick={() => props.onActiveItem(active ? null : item.id)}>
            <Move className="h-3.5 w-3.5" />
          </button>
        </CtTooltip>
        <CtTooltip label="Gỡ ảnh khỏi layer (clipart vẫn trong thư viện)">
          <button className="rounded p-1 text-destructive hover:bg-accent" onClick={() => design.commit((s) => ({ ...s, items: s.items.filter((i) => i.id !== item.id) }))}>
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </CtTooltip>
      </div>

      <div className="mt-2 grid grid-cols-5 gap-1">
        {options.map((o) => {
          const isHidden = hidden.has(o.id);
          return (
            <div key={o.id} className="group relative">
              <CtTooltip label={o.name || "(không tên)"}>
                <button
                  className={cx("block aspect-square w-full overflow-hidden rounded border", defId === o.id && "ring-2 ring-orange-500", shown === o.id && defId !== o.id && "ring-2 ring-sky-500", isHidden && "opacity-30")}
                  style={CHECKER_STYLE}
                  onClick={() => (isHidden ? props.onPreviewOption(region.id, o.id) : makeDefault(o.id))}
                >
                  <OptionThumb url={o.meta.thumb ?? o.url} className="h-full w-full object-contain" />
                </button>
              </CtTooltip>
              <button
                className="absolute right-0 top-0 hidden rounded bg-black/60 p-0.5 text-white group-hover:block"
                onClick={() => toggleHidden(o.id)}
                aria-label={isHidden ? "Hiện với khách" : "Ẩn với khách"}
              >
                {isHidden ? <EyeOff className="h-2.5 w-2.5" /> : <Eye className="h-2.5 w-2.5" />}
              </button>
              {cfg.display === "swatch" && (
                <input
                  type="color"
                  className="mt-0.5 h-3 w-full cursor-pointer rounded-sm border-0 bg-transparent p-0"
                  value={o.meta.swatch ?? "#cccccc"}
                  onChange={(e) => props.onSetSwatch(o, e.target.value)}
                  aria-label="Màu swatch"
                />
              )}
            </div>
          );
        })}
      </div>

      {active && (
        <div className="mt-2 space-y-2 border-t pt-2">
          <div className="grid grid-cols-4 gap-1.5">
            <CtField label="X %">
              <CtNumber value={t.offsetX * 100} onChange={(v) => setT({ offsetX: v / 100 })} />
            </CtField>
            <CtField label="Y %">
              <CtNumber value={t.offsetY * 100} onChange={(v) => setT({ offsetY: v / 100 })} />
            </CtField>
            <CtField label="Scale">
              <CtNumber value={t.scale} step={0.05} onChange={(v) => setT({ scale: Math.max(0.01, v) })} />
            </CtField>
            <CtField label="Xoay °">
              <CtNumber value={t.rotation} onChange={(v) => setT({ rotation: v })} />
            </CtField>
          </div>
          <CtButton size="sm" onClick={() => setT({ ...IDENTITY_TRANSFORM })}>
            Reset vị trí
          </CtButton>
        </div>
      )}
    </div>
  );
}

/**
 * Nothing selected: every layer the customer can change, its options as chips — pick them to make an artwork (asked
 * 2026-10-10: a v2 set's options work from the right sidebar). Picking only changes what the editor shows (the
 * design content), never the product's defaults. Lưu thiết kế saves each version as an artwork; "Lưu thành artwork
 * mới" keeps this combination as one more.
 */
function ArtworkOptions(props: InspectorProps) {
  const { design, assets, selection } = props;
  const [name, setName] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const regions = formOrder(design.state.regions).filter((r) => !r.config.materialFrame && !isLinkedLayer(r, design.state.regions));
  const rows = regions
    .map((raw) => {
      const r = normalizeRegion(raw);
      if (r.kind === "text") return { r, options: [] as CtAsset[] };
      if (r.kind !== "image") return null;
      const hidden = new Set(r.config.image.hiddenAssetIds);
      const options = design.state.items
        .filter((i) => i.region_id === r.id)
        .sort((a, b) => a.sort_order - b.sort_order)
        .flatMap((i) => {
          const sub = assets.find((a) => a.id === i.asset_id);
          return sub ? [sub, ...variantsOf(assets, sub.id)] : [];
        })
        .filter((o) => !hidden.has(o.id));
      return options.length >= 2 ? { r, options } : null;
    })
    .filter((x): x is { r: CtRegion; options: CtAsset[] } => x !== null);

  const save = async () => {
    setError(null);
    try {
      await props.onSaveArtwork(name);
      setSaved(name.trim() || "artwork");
      setName("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không lưu được artwork");
    }
  };

  return (
    <div className="space-y-3 p-3">
      <div>
        <div className="text-xs font-semibold">Chọn option để xem</div>
      </div>
      {rows.length === 0 && <p className="text-[11px] text-muted-foreground">Chưa có option.</p>}
      {rows.map(({ r, options }) => {
        const cur = selection[r.id];
        if (r.kind === "text")
          return (
            <CtField key={r.id} label={layerLabel(r.name)}>
              <CtInput value={cur?.kind === "text" ? cur.text : ""} placeholder={r.config.text.placeholder} onChange={(e) => props.onSampleText(r.id, e.target.value)} />
            </CtField>
          );
        const shown = cur?.kind === "image" ? cur.assetId : null;
        return (
          <div key={r.id}>
            <div className="mb-1 flex items-center gap-1 text-[11px]">
              <span className="truncate font-medium">{layerLabel(r.name)}</span>
              <span className="text-muted-foreground">({options.length})</span>
            </div>
            <div className="grid grid-cols-6 gap-1">
              {options.map((o) => (
                <CtTooltip key={o.id} label={o.name || "(không tên)"}>
                  <button className={cx("block aspect-square w-full overflow-hidden rounded border", shown === o.id && "ring-2 ring-sky-500")} style={CHECKER_STYLE} onClick={() => props.onPreviewOption(r.id, o.id)}>
                    <OptionThumb url={o.meta.thumb ?? o.url} className="h-full w-full object-contain" />
                  </button>
                </CtTooltip>
              ))}
            </div>
          </div>
        );
      })}
      <div className="space-y-1.5 border-t pt-3">
        <CtInput value={name} placeholder="Tên artwork (tuỳ chọn)" onChange={(e) => setName(e.target.value)} />
        <CtButton size="sm" className="w-full" disabled={props.artworkBusy} onClick={() => void save()}>
          {props.artworkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImageIcon className="h-3.5 w-3.5" />} Lưu thành artwork mới
        </CtButton>
        {saved && <p className="text-[11px] text-emerald-600">Đã lưu “{saved}” vào thư viện (tab Artwork).</p>}
        {error && <p className="text-[11px] text-destructive">{error}</p>}
      </div>
    </div>
  );
}
