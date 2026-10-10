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
  ArrowDown,
  ArrowUp,
  Circle,
  Crown,
  Eye,
  EyeOff,
  Frame,
  GripVertical,
  ImageIcon,
  Loader2,
  Move,
  Pentagon,
  Plus,
  Square,
  Trash2,
  Type,
  Upload,
  UserSquare,
  X,
  HelpCircle,
} from "lucide-react";
import { CT_FONTS } from "../../config";
import type { CtProductPrint } from "../../types/print";
import { fillShape, LayerPrintSection, outsideSafe } from "../print/layer-print-section";
import type {
  CtAsset,
  CtTextFormat,
  CtMainFrame,
  CtOptionDisplay,
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
  CtShape,
  CtTextAlign,
  CtTransform,
  CtTextMode,
  CtZoneOption,
  CtZoneOptions,
  CtZoneParent,
  CtZoneTextStyle,
} from "../../types";
import { CT_BASE_OPTION } from "../../types";
import { fitShapeToBounds, IDENTITY_PHOTO_FRAME, IDENTITY_TRANSFORM, newId, orientedBox, resolvePhotoFrame, shapeBounds } from "../../lib/geometry";
import { useImageSize } from "./use-image-size";
import { defaultRegionSelection, formOrder, hasTestPhoto, isLinkedLayer, isValidDate, linkMismatches, makeRegion, normalizeRegion, textMode, variantsOf, ZONE_TEXT_STYLE_KEYS, zoneSubtree } from "../../lib/design";
import { CT_FACE_STYLES, CT_FREE_STYLES, aiStyleRef, isAiStyleRef, needsServer, photoMode, styleEngine, styleFamily, styleLabel } from "../../lib/photo-styles";
import { PhotoGuideDialog } from "./photo-guide-dialog";
import { aiStyleModel } from "../../lib/ai-style-models";
import { AiStyleDialog } from "./ai-style-dialog";
import { useAiStyles } from "./ai-styles-store";
import { processPhoto } from "../../lib/photo-process";
import { ctApi } from "../../lib/api-client";
import { OptionThumb } from "./option-thumb";
import { CHECKER_STYLE, CtButton, CtCheckbox, CtField, CtInput, CtNumber, CtSelect, CtTextarea, CtTooltip, cx } from "../ui";
import type { DesignApi } from "./use-design";
import { updateItem, updateRegion } from "./use-design";

const KIND_ICON: Record<CtRegionKind, typeof ImageIcon> = { image: ImageIcon, text: Type, photo: UserSquare };
const SHAPE_ICON: Record<CtShape["type"], typeof Square> = { rect: Square, ellipse: Circle, polygon: Pentagon };

export const DISPLAY_OPTIONS: Array<{ value: CtOptionDisplay; label: string }> = [
  { value: "image", label: "Ảnh (tile)" },
  { value: "swatch", label: "Ô màu (swatch)" },
  { value: "button", label: "Nút chữ" },
  { value: "dropdown", label: "Dropdown" },
];

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
  /** A child zone for one option of a zone (text / custom layer / photo upload) — shown while that option is. */
  onAddChild: (parent: CtZoneParent, kind: CtRegionKind) => void;
  /** Draw a part cut out of khuôn vật liệu `regionId` (a hanging hole) with a frame tool. */
  onDrawCut: (regionId: string, tool: "rect" | "ellipse" | "polygon") => void;
  /** The khuôn in the product is made on: placement / fill / print-only per layer, the safe zone check. */
  print?: CtProductPrint | null;
}

/** "Choose state: Texas" — the option a child zone belongs to. */
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

  const move = (id: string, dir: 1 | -1) =>
    design.commit((s) => {
      const list = [...s.regions].sort((a, b) => a.sort_order - b.sort_order);
      const i = list.findIndex((r) => r.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= list.length) return s;
      [list[i], list[j]] = [list[j], list[i]];
      return { ...s, regions: list.map((r, k) => ({ ...r, sort_order: k })) };
    });

  /** A new fill layer on the khuôn in: a background covering the piece, or a pattern in its first zone. */
  const addFill = (mode: "cover" | "tile") => {
    const print = props.print;
    if (!print) return;
    const zone = mode === "tile" ? print.spec.zones[0]?.id : undefined;
    const base = makeRegion(regions[0]?.product_id ?? "", "image", fillShape(print, zone), regions.length);
    const mainId = regions.find((r) => r.config.mainId)?.config.mainId;
    const r: CtRegion = {
      ...base,
      name: mode === "cover" ? "Nền" : `Hoa văn ${print.spec.zones[0]?.name ?? ""}`.trim(),
      config: { ...base.config, ...(mainId ? { mainId } : {}), aboveMain: true, fill: { mode, tile: Math.round(print.spec.width / 6), ...(zone ? { zone } : {}) } },
    };
    // A background goes under everything; a pattern on top of the other fills.
    design.commit((st) => {
      const list = [...st.regions].sort((a, b) => a.sort_order - b.sort_order);
      const at = mode === "cover" ? list.findIndex((x) => !x.config.materialFrame) : list.length;
      list.splice(at < 0 ? list.length : at, 0, r);
      return { ...st, regions: list.map((x, k) => ({ ...x, sort_order: k })) };
    });
    props.onSelectRegion(r.id);
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
      {props.print && (
        <div className="flex flex-wrap gap-1 border-b px-2 py-1.5">
          <button className="rounded border px-2 py-0.5 text-[11px] hover:bg-accent" title="Layer phủ kín cả miếng (nền) — chọn ảnh nền ở bên dưới" onClick={() => addFill("cover")}>
            + Nền phủ
          </button>
          <button className="rounded border px-2 py-0.5 text-[11px] hover:bg-accent" title="Layer hoa văn lặp trong một vùng của khuôn (quần áo)" onClick={() => addFill("tile")}>
            + Hoa văn vùng
          </button>
        </div>
      )}
      <div className="max-h-[32%] overflow-y-auto border-b">
        {ordered.length === 0 && (
          <p className="px-3 py-4 text-xs text-muted-foreground">Chưa có vùng nào. Chọn công cụ R / O / P rồi vẽ lên version.</p>
        )}
        {ordered.map((r, index) => {
          const Icon = KIND_ICON[r.kind];
          const ShapeIcon = SHAPE_ICON[r.shape.type];
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
              <ShapeIcon className="h-3 w-3 shrink-0 text-muted-foreground/70" />
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
                <span className="flex-1 truncate" onDoubleClick={(e) => { e.stopPropagation(); setRenaming(r.id); }}>
                  {r.name}
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
                  <LayerButton label="Đổi tên (double-click)" onClick={() => setRenaming(r.id)}>
                    <Type className="h-3 w-3" />
                  </LayerButton>
                  <LayerButton label="Lên trên" onClick={() => move(r.id, 1)}>
                    <ArrowUp className="h-3 w-3" />
                  </LayerButton>
                  <LayerButton label="Xuống dưới" onClick={() => move(r.id, -1)}>
                    <ArrowDown className="h-3 w-3" />
                  </LayerButton>
                  <LayerButton label="Xoá vùng" shortcut={["Del"]} danger onClick={() => remove(r.id)}>
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
              Main · <span className="text-muted-foreground">{props.mainLayer.asset.name || "version"}</span>
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
        <div className="text-xs font-semibold">Khung main</div>
        <p className="text-[11px] text-muted-foreground">
          Ảnh của version này trên khung edit {bw}×{bh}px (khung edit không đổi). Kéo trên canvas, hoặc nhập số.
        </p>
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
      <CtField label="Tên vùng">
        <CtInput value={region.name} onChange={(e) => set((r) => ({ ...r, name: e.target.value }))} />
      </CtField>

      <CtField label="Loại vùng">
        <CtSelect<CtRegionKind>
          value={region.kind}
          onChange={(kind) => set((r) => ({ ...r, kind }))}
          options={[
            { value: "image", label: "Custom layer — ảnh (≥2 ảnh: khách chọn, không sửa)" },
            { value: "text", label: "Text — option: khách nhập / chọn chữ" },
            { value: "photo", label: "Ảnh khách — option: khách upload ảnh" },
          ]}
        />
      </CtField>

      <div className="grid grid-cols-4 gap-1.5">
        {(["x", "y", "w", "h"] as const).map((k) => (
          <CtField key={k} label={k.toUpperCase()}>
            <CtNumber value={b[k]} onChange={(v) => setBounds({ [k]: v })} />
          </CtField>
        ))}
      </div>
      {props.print && <LayerPrintSection region={region} print={props.print} onChange={(next) => set(() => next)} />}
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
      {region.shape.type === "rect" && (
        <CtField label="Bo góc (px)">
          <CtNumber
            value={region.shape.radius}
            min={0}
            onChange={(v) => set((r) => (r.shape.type === "rect" ? { ...r, shape: { ...r.shape, radius: Math.max(0, v) } } : r))}
          />
        </CtField>
      )}

      {region.kind === "image" && <MaterialFrameProps {...props} region={region} />}

      {region.kind === "text" && (
        <div className="space-y-3 border-t pt-3">
          <CtField label="Khách làm gì với chữ này">
            <CtSelect<CtTextMode>
              value={textMode(region)}
              onChange={(mode) => setText({ mode })}
              options={[
                { value: "input", label: "Khách nhập chữ" },
                { value: "fixed", label: "Chữ cố định (khách không sửa)" },
                { value: "list", label: "Khách chọn từ danh sách chữ" },
                { value: "options", label: "Khách chọn option (swatch) — có option con" },
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
            <CtField label="Danh sách chữ" hint="Mỗi dòng 1 lựa chọn → khách chọn từ dropdown (Choose Quote, Choose State).">
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
          {textMode(region) === "options" && (
            <p className="rounded-md bg-orange-500/10 px-2 py-1.5 text-[11px] leading-snug text-orange-700 dark:text-orange-300">
              Khách chọn 1 option bên dưới (swatch / nút / dropdown). Mỗi option có chữ hiện, kiểu chữ riêng và có thể có option con (Text / Custom layer / Upload ảnh) — option con cũng có thể có option con.
            </p>
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
          <CtField label={`Uốn cong: ${cfg.text.curve}`} hint="Dương = cong lên (∩), âm = cong xuống (∪)">
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
                    return { ...n, config: { ...n.config, text: { ...n.config.text, curve: Number(e.target.value) } } };
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
      {(region.kind === "text" || region.kind === "photo") && <ZoneOptionsProps {...props} />}
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

  const selectedAi = styles.find((s) => isAiStyleRef(s) && ai.styles.some((x) => aiStyleRef(x.id) === s));
  /** Built-in "Watercolor + Ink" first, then any built-in, then the first in the library. */
  const defaultAi = (): CtPhotoStyleRef | null => {
    const pick =
      ai.styles.find((s) => !s.user_id && /watercolor/i.test(s.name)) ?? ai.styles.find((s) => !s.user_id) ?? ai.styles[0];
    return pick ? aiStyleRef(pick.id) : null;
  };

  // The AI tab always has exactly one style: the default one as soon as the tab is picked.
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
      set(ref ? { mode: t, styles: [ref], defaultStyle: ref } : { mode: t });
    } else {
      const list: CtPhotoStyleRef[] = t === "face" ? CT_FACE_STYLES.map((s) => s.id) : same.length ? same : ["original"];
      // A face is a trimmed head cut-out: "contain" keeps its ears / chin inside the frame, which fits itself to the head.
      set({ mode: t, styles: list, defaultStyle: list[0], ...(t === "face" ? { fit: "contain" as const, frame: { ...IDENTITY_PHOTO_FRAME, auto: true } } : {}) });
    }
  };

  /**
   * Free styles: any number, customer picks from a dropdown (catalog order).
   * AI style: exactly one (picked in the AI tab's select), no dropdown for the customer — they upload and wait.
   * The two modes don't mix (lib/design.ts normalizePhotoConfig enforces it too).
   */
  const toggleStyle = (ref: CtPhotoStyleRef, on: boolean) => {
    if (isAiStyleRef(ref)) {
      set(on ? { styles: [ref], defaultStyle: ref } : { styles: ["original"], defaultStyle: "original" });
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
    const text = needsServer(style, cfg.photo.cutout) ? `Đang xử lý ${label(style)}${isAiStyleRef(style) ? " (AI, ~10–20 giây)" : ""}…` : "Đang lọc…";
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
    caps && styles.some(isAiStyleRef) && !caps.aiStyles ? "Style AI cần FAL_KEY trên server." : "",
    caps && cfg.photo.cutout && !caps.cutout ? "Tách nền cần CT_BG_REMOVER_URL, FAL_KEY hoặc 1 AI provider." : "",
    caps && tab === "face" && !caps.faceDetect ? "Face cần service face-detect (CT_FACE_DETECT_URL)." : "",
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
          <Frame className="h-3.5 w-3.5" /> Thêm khung ảnh (frame con)
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
          <div className="space-y-1 rounded border border-dashed p-2 text-center text-[11px] text-muted-foreground">
            <p>Chọn 1 tab để chỉnh / thử ảnh: Free (lọc ảnh), AI tạo ảnh (tính phí), hoặc Face (cắt khuôn mặt). Chưa rõ? Bấm “Hướng dẫn”.</p>
            <p className="text-foreground">
              Khách đang thấy:{" "}
              {configured ? `${configured === "free" ? "Free" : configured === "ai" ? "AI" : "Face"} — ${styles.map(label).join(", ")}` : "Real photo (chưa chọn tab nào)"}
            </p>
          </div>
        ) : tab === "face" ? (
          <div className="space-y-1.5">
            <div className="flex flex-wrap gap-1">
              {CT_FACE_STYLES.map((s) => (
                <span key={s.id} className="rounded-full border px-2 py-0.5 text-[11px]" title={s.hint}>
                  {s.label.replace(/^Face · /, "")}
                </span>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Bộ 5 màu mặc định — khách chọn 1. Không tốn phí AI: tách nền, tự tìm khuôn mặt (người, mèo — chó / khác nhờ AI tìm, rất rẻ), chỉ giữ phần đầu (không cổ, không thân), rồi lọc màu.
            </p>
          </div>
        ) : tab === "free" ? (
          <div className="space-y-1.5">
            {CT_FREE_STYLES.map((s) => (
              <CtCheckbox key={s.id} checked={styles.includes(s.id)} onChange={(v) => toggleStyle(s.id, v)} label={s.label} hint={s.hint} />
            ))}
            <p className="text-[11px] text-muted-foreground">Không tốn phí AI.</p>
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
              <CtSelect<CtPhotoStyleRef>
                value={selectedAi ?? "original"}
                onChange={(ref) => set({ styles: [ref], defaultStyle: ref })}
                options={ai.styles.map((st) => ({ value: aiStyleRef(st.id), label: st.name }))}
              />
            )}
            {(() => {
              const st = ai.styles.find((x) => aiStyleRef(x.id) === selectedAi);
              if (!st) return null;
              return (
                <button type="button" className="w-full rounded-md border border-sky-500/60 bg-sky-500/5 p-2 text-left" onClick={() => setDialog(st)}>
                  <div className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">{st.prompt}</div>
                  <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-muted-foreground">
                    <span className="rounded bg-muted px-1">{aiStyleModel(st.model).label}</span>
                    <span className="rounded bg-muted px-1">{st.owner}</span>
                    {!st.can_edit && <span className="rounded bg-muted px-1">chỉ xem</span>}
                  </div>
                </button>
              );
            })()}
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
        <p className="text-[11px] leading-snug text-muted-foreground">Upload một ảnh mẫu để xem kết quả cuối trên canvas. Ảnh chỉ dùng để thử, không lưu vào thiết kế.</p>
        <div className="flex gap-1.5">
          <CtButton
            size="sm"
            variant="primary"
            disabled={working !== null}
            onClick={() => (tab === null ? setError("Chọn 1 style trước (Free / AI tạo ảnh / Face) — rồi mới thử ảnh.") : fileRef.current?.click())}
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
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Khung ảnh (frame con)</span>
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
        hint="Mặt khách được dựng thẳng (0°) theo đường mắt, rồi khung xoay theo độ nghiêng của vùng. Khung đặt ở tâm vòng tròn bao trọn viền vùng; ảnh mặt nằm vừa trong hình vuông của vòng tròn đó, nới thêm 15% mỗi cạnh để mặt phủ kín vùng, cộng 1 lề nhỏ quanh mặt. Tính lại cho từng ảnh mới."
      />
      <p className="text-[11px] leading-snug text-muted-foreground">
        Ảnh khách nằm trong khung này (giữ đúng tỉ lệ, chỉ scale 1 lần khi render); vùng bên ngoài vẫn là mặt nạ. Chỉnh trên canvas: chọn vùng rồi ↵ (hoặc double-click) — kéo tay sẽ tắt tự khớp. Mỗi ảnh test mới luôn được tính lại khung mới.
      </p>
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
    <CtField label="Độ nghiêng vùng °" hint={tilt === null ? `Tự đọc từ viền vùng: ${detected}°. Nhập số để đặt tay — khung ảnh (frame con) xoay theo.` : "Khung ảnh (frame con) xoay theo độ nghiêng này."}>
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
// Customer zones: sub-options ("Thêm option con", like a main version's)
// ---------------------------------------------------------------------------

function ZoneOptionsProps({ design, region, selection, onZoneOption, onAddChild }: InspectorProps & { region: CtRegion }) {
  const o = region.config.options;
  const sel = selection[region.id];
  const activeId = (sel?.kind === "text" || sel?.kind === "photo") && sel.optionId && o.list.some((x) => x.id === sel.optionId) ? sel.optionId : null;
  const isText = region.kind === "text";
  /** Text mode "options": the options ARE the customer's field (each draws its own text). */
  const primary = isText && textMode(region) === "options";
  const set = (patch: Partial<CtZoneOptions>) =>
    design.commit((s) =>
      updateRegion(s, region.id, (r) => {
        const n = normalizeRegion(r);
        return { ...n, config: { ...n.config, options: { ...n.config.options, ...patch } } };
      }),
    );
  const setOption = (id: string, patch: Partial<CtZoneOption>) => set({ list: o.list.map((x) => (x.id === id ? { ...x, ...patch } : x)) });
  const children = design.state.regions.filter((r) => r.config.parent?.regionId === region.id);
  const childCount = (optionId: string) => children.filter((c) => c.config.parent?.optionId === optionId).length;

  /** A new option starts as the look on screen (its lettering / its outline) and is shown, so edits go into it. */
  const add = () => {
    const id = newId();
    const look = normalizeRegion(region);
    const text: CtZoneTextStyle = {};
    for (const k of ZONE_TEXT_STYLE_KEYS) (text as Record<string, unknown>)[k] = look.config.text[k];
    const name = `Option ${o.list.length + 2}`;
    const option: CtZoneOption = { id, name, ...(isText ? { text } : { shape: look.shape }), ...(primary ? { value: name } : {}) };
    set({ list: [...o.list, option] });
    onZoneOption(region.id, id);
  };
  const remove = (id: string) => {
    if (activeId === id) onZoneOption(region.id, null);
    // Its child zones go with it.
    const gone = new Set(children.filter((c) => c.config.parent?.optionId === id).flatMap((c) => [...zoneSubtree(design.state.regions, c.id)]));
    design.commit((s) => {
      const next = updateRegion(s, region.id, (r) => {
        const n = normalizeRegion(r);
        return { ...n, config: { ...n.config, options: { ...n.config.options, list: n.config.options.list.filter((x) => x.id !== id) } } };
      });
      return { ...next, regions: next.regions.filter((r) => !gone.has(r.id)), items: next.items.filter((i) => !gone.has(i.region_id)) };
    });
  };
  const childMenu = (optionId: string) => (kind: CtRegionKind) => {
    onZoneOption(region.id, optionId === CT_BASE_OPTION ? null : optionId);
    onAddChild({ regionId: region.id, optionId }, kind);
  };

  return (
    <div className="space-y-2 border-t pt-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {primary ? "Option cho khách" : "Option con cho khách"} ({o.list.length || primary ? o.list.length + 1 : 0})
        </span>
        <CtButton size="sm" variant="subtle" onClick={add}>
          <Plus className="h-3.5 w-3.5" /> {primary ? "Thêm option" : "Thêm option con"}
        </CtButton>
      </div>
      {o.list.length === 0 && !primary ? (
        <p className="text-[11px] leading-snug text-muted-foreground">
          {isText
            ? "Như option của version: khách chọn thêm 1 kiểu cho chữ này (vd. Gold / Silver / Black) — mỗi option con có font, màu, viền, uốn cong riêng."
            : "Như option của version: khách chọn thêm khung cho ảnh (vd. Tròn / Vuông / Trái tim) — mỗi option con có hình khung riêng (vẽ lại trên canvas)."}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-[1fr_120px] gap-2">
            {!primary && (
              <CtField label="Nhãn cho khách">
                <CtInput value={o.label} placeholder={isText ? "Choose color" : "Choose shape"} onChange={(e) => set({ label: e.target.value })} />
              </CtField>
            )}
            <div className={primary ? "col-span-2" : undefined}>
              <CtField label="Hiển thị">
                <CtSelect<CtOptionDisplay> value={o.display === "image" ? "button" : o.display} onChange={(display) => set({ display })} options={DISPLAY_OPTIONS.filter((d) => d.value !== "image")} />
              </CtField>
            </div>
          </div>
          <div className="space-y-1">
            <ZoneOptionRow
              active={activeId === null}
              name={o.baseName}
              placeholder="Mặc định"
              swatch={o.display === "swatch" ? (o.baseSwatch ?? "#cccccc") : undefined}
              value={primary ? (o.baseValue ?? o.baseName) : undefined}
              note="gốc"
              kids={childCount(CT_BASE_OPTION)}
              onShow={() => onZoneOption(region.id, null)}
              onName={(baseName) => set(primary && (o.baseValue === undefined || o.baseValue === o.baseName) ? { baseName, baseValue: baseName } : { baseName })}
              onSwatch={(baseSwatch) => set({ baseSwatch })}
              onValue={(baseValue) => set({ baseValue })}
              onAddChild={childMenu(CT_BASE_OPTION)}
            />
            {o.list.map((x) => (
              <ZoneOptionRow
                key={x.id}
                active={activeId === x.id}
                name={x.name}
                placeholder="Tên option"
                swatch={o.display === "swatch" ? (x.swatch ?? "#cccccc") : undefined}
                value={primary ? (x.value ?? x.name) : undefined}
                kids={childCount(x.id)}
                onShow={() => onZoneOption(region.id, x.id)}
                onName={(name) => setOption(x.id, primary && (x.value === undefined || x.value === x.name) ? { name, value: name } : { name })}
                onSwatch={(swatch) => setOption(x.id, { swatch })}
                onValue={(value) => setOption(x.id, { value })}
                onAddChild={childMenu(x.id)}
                onRemove={() => remove(x.id)}
              />
            ))}
          </div>
          <p className="text-[11px] leading-snug text-muted-foreground">
            Bấm 👁 để xem / sửa option đó: {isText ? "font, cỡ, màu, viền, uốn cong" : "hình / vị trí khung trên canvas"} lúc đó ghi vào option. “+ con” thêm Text / Custom layer / Upload ảnh chỉ hiện khi khách chọn option đó.
          </p>
        </>
      )}
    </div>
  );
}

const CHILD_KINDS: Array<{ kind: CtRegionKind; label: string }> = [
  { kind: "text", label: "Text" },
  { kind: "image", label: "Custom layer" },
  { kind: "photo", label: "Upload ảnh" },
];

function ZoneOptionRow(props: {
  active: boolean;
  name: string;
  placeholder: string;
  swatch?: string;
  /** Text mode "options": what the option draws. */
  value?: string;
  note?: string;
  /** Child zones it has. */
  kids: number;
  onShow: () => void;
  onName: (v: string) => void;
  onSwatch: (v: string) => void;
  onValue: (v: string) => void;
  onAddChild: (kind: CtRegionKind) => void;
  onRemove?: () => void;
}) {
  const [menu, setMenu] = useState(false);
  return (
    <div className={cx("rounded-md border px-1.5 py-1", props.active && "border-orange-500 ring-1 ring-orange-500")}>
      <div className="flex items-center gap-1.5">
        <CtTooltip label={props.active ? "Đang xem / sửa" : "Xem / sửa option này"}>
          <button className={cx("rounded p-1 hover:bg-accent", props.active ? "text-orange-500" : "text-muted-foreground")} onClick={props.onShow}>
            {props.active ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          </button>
        </CtTooltip>
        {props.swatch !== undefined && (
          <input type="color" className="h-6 w-6 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0" value={props.swatch} onChange={(e) => props.onSwatch(e.target.value)} aria-label="Màu swatch" />
        )}
        <CtInput className="h-7 flex-1 text-xs" value={props.name} placeholder={props.placeholder} onChange={(e) => props.onName(e.target.value)} onFocus={props.onShow} />
        {props.note && <span className="text-[10px] uppercase text-muted-foreground">{props.note}</span>}
        <CtTooltip label="Thêm option con (Text / Custom layer / Upload ảnh) — chỉ hiện khi khách chọn option này">
          <button className={cx("rounded px-1 py-0.5 text-[10px] hover:bg-accent", props.kids ? "text-orange-600" : "text-muted-foreground")} onClick={() => setMenu((v) => !v)}>
            + con{props.kids ? ` (${props.kids})` : ""}
          </button>
        </CtTooltip>
        {props.onRemove && (
          <button className="rounded p-1 text-destructive hover:bg-accent" onClick={props.onRemove} aria-label="Xoá option">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {props.value !== undefined && (
        <div className="mt-1 flex items-center gap-1.5 pl-7">
          <span className="shrink-0 text-[10px] text-muted-foreground">Chữ hiện</span>
          <CtInput className="h-6 flex-1 text-xs" value={props.value} placeholder="(không vẽ chữ)" onChange={(e) => props.onValue(e.target.value)} onFocus={props.onShow} />
        </div>
      )}
      {menu && (
        <div className="mt-1 flex gap-1 pl-7">
          {CHILD_KINDS.map((k) => (
            <CtButton
              key={k.kind}
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => {
                setMenu(false);
                props.onAddChild(k.kind);
              }}
            >
              <Plus className="h-3 w-3" /> {k.label}
            </CtButton>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Object zone: groups of options
// ---------------------------------------------------------------------------

/**
 * Khuôn vật liệu (lib/material-frame): this custom layer's outline is the product's shape (a round ornament, a pair
 * of trousers) — the print file is cut to it, and vật liệu made "theo khuôn" are the clipart cut to it. Its cuts are
 * parts cut out of the piece (a hanging hole).
 */
function MaterialFrameProps({ design, region, onDrawCut }: InspectorProps & { region: CtRegion }) {
  const on = region.config.materialFrame === true;
  const cuts = region.config.cuts ?? [];
  const setOn = (v: boolean) =>
    design.commit((s) => ({
      ...s,
      // One khuôn per version.
      regions: s.regions.map((r) =>
        r.id === region.id ? { ...r, config: { ...r.config, materialFrame: v } } : v && r.config.materialFrame ? { ...r, config: { ...r.config, materialFrame: false } } : r,
      ),
    }));
  const removeCut = (i: number) => design.commit((s) => updateRegion(s, region.id, (r) => ({ ...r, config: { ...r.config, cuts: (r.config.cuts ?? []).filter((_, k) => k !== i) } })));
  return (
    <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2">
      <CtCheckbox
        checked={on}
        onChange={setOn}
        label="Khuôn vật liệu (hình dạng sản phẩm)"
        hint="Sản phẩm có hình cố định (ornament tròn, cái quần…): file in cắt theo viền layer này; bản vật liệu “theo khuôn” = clipart cắt theo khuôn (upload ở Thư viện → “Upload vật liệu”), mọi clipart cùng kích thước. Không bật = vật liệu theo alpha của clipart (acrylic cắt theo hình)."
      />
      {on && (
        <>
          <div className="flex items-center gap-1 text-[11px]">
            <span className="flex-1 text-muted-foreground">Vùng cắt bỏ (lỗ đục…){cuts.length ? ` (${cuts.length})` : ""}</span>
            {(["ellipse", "rect", "polygon"] as const).map((t) => {
              const Icon = SHAPE_ICON[t];
              return (
                <CtTooltip key={t} label={t === "polygon" ? "Vẽ vùng cắt đa giác (chấm điểm)" : t === "ellipse" ? "Vẽ lỗ tròn" : "Vẽ vùng cắt chữ nhật"}>
                  <button className="rounded p-1 text-amber-700 hover:bg-accent dark:text-amber-300" onClick={() => onDrawCut(region.id, t)}>
                    <Icon className="h-3.5 w-3.5" />
                  </button>
                </CtTooltip>
              );
            })}
          </div>
          {cuts.map((c, i) => {
            const b = shapeBounds(c);
            const Icon = SHAPE_ICON[c.type];
            return (
              <div key={i} className="flex items-center gap-1.5 text-[11px]">
                <Icon className="h-3 w-3 text-rose-500" />
                <span className="flex-1 tabular-nums text-muted-foreground">
                  {Math.round(b.w)}×{Math.round(b.h)} tại {Math.round(b.x)}, {Math.round(b.y)}
                </span>
                <button className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => removeCut(i)} aria-label="Xoá vùng cắt">
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

/**
 * Linked layer (layer-rules §6): the back half of a hairstyle follows the front half's choice by group / option
 * position. Lists the other image layers of the same version; warns while the two option trees differ.
 */
function LinkedLayerField(props: InspectorProps & { region: CtRegion }) {
  const { design, region, assets } = props;
  const regions = design.state.regions;
  const cfg = normalizeRegion(region).config.image;
  const leaders = regions.filter((r) => r.id !== region.id && r.kind === "image" && r.config.mainId === region.config.mainId && normalizeRegion(r).config.image.follows !== region.id);
  const set = (follows: string) =>
    design.commit((s) =>
      updateRegion(s, region.id, (r) => {
        const n = normalizeRegion(r);
        const { follows: _old, ...image } = n.config.image;
        return { ...n, config: { ...n.config, image: follows ? { ...image, follows } : image } };
      }),
    );
  const issues = linkMismatches(region, regions, design.state.items, assets);
  if (!leaders.length && !cfg.follows) return null;
  return (
    <CtField label="Liên kết theo layer" hint="Tóc 2 lớp: layer tóc SAU theo layer tóc TRƯỚC — cùng nhóm, cùng thứ tự ảnh, khách chỉ chọn 1 lần.">
      <CtSelect<string>
        value={cfg.follows ?? ""}
        onChange={set}
        options={[{ value: "", label: "Không — khách tự chọn" }, ...leaders.map((r) => ({ value: r.id, label: `Theo “${r.name}”` }))]}
      />
      {issues.length > 0 && (
        <p className="mt-1 text-[11px] leading-snug text-amber-600">Chưa khớp layer gốc: {issues.join(" · ")}</p>
      )}
    </CtField>
  );
}

function ImageProps(props: InspectorProps & { region: CtRegion }) {
  const { design, region, assets, selection } = props;
  const cfg = region.config.image;
  const set = (patch: Partial<typeof cfg>) =>
    design.commit((s) => updateRegion(s, region.id, (r) => { const n = normalizeRegion(r); return { ...n, config: { ...n.config, image: { ...n.config.image, ...patch } } }; }));
  const items = design.state.items.filter((i) => i.region_id === region.id).sort((a, c) => a.sort_order - c.sort_order);
  const byId = new Map(assets.map((a) => [a.id, a]));
  const hidden = new Set(cfg.hiddenAssetIds);
  const offered = items.reduce((n, it) => n + [it.asset_id, ...variantsOf(assets, it.asset_id).map((v) => v.id)].filter((id) => !hidden.has(id)).length, 0);
  const shown = selection[region.id]?.kind === "image" ? (selection[region.id] as { assetId: string | null }).assetId : null;
  const kids = design.state.regions.filter((r) => r.config.parent?.regionId === region.id && r.config.parent.optionId === shown).length;
  const [menu, setMenu] = useState(false);
  const linked = isLinkedLayer(region, design.state.regions);

  return (
    <div className="space-y-3 border-t pt-3">
      <p className="rounded-md bg-sky-500/10 px-2 py-1.5 text-[11px] leading-snug text-sky-700 dark:text-sky-300">
        {linked
          ? "Layer liên kết: khách không chọn — layer này hiện ảnh cùng vị trí (nhóm, thứ tự) với layer nó theo."
          : offered >= 2
          ? `Khách chọn 1 trong ${offered} ảnh (chỉ chọn, không sửa) — vd. bộ kiểu tóc. Mặc định = card / ảnh viền cam (bấm để đổi).`
          : "1 ảnh = layer cố định (khách không chọn). Thêm ảnh (kéo cả bộ từ tab Thư viện, hoặc bật ảnh ẩn) để khách chọn."}
      </p>

      <LinkedLayerField {...props} region={region} />

      {offered >= 2 && !linked && (
        <>
          <div className="grid grid-cols-[1fr_120px] gap-2">
            <CtField label="Nhãn cho khách">
              <CtInput value={cfg.label} placeholder="Choose hairstyle" onChange={(e) => set({ label: e.target.value })} />
            </CtField>
            <CtField label="Hiển thị">
              <CtSelect<CtOptionDisplay> value={cfg.display} onChange={(display) => set({ display })} options={DISPLAY_OPTIONS} />
            </CtField>
          </div>
          {items.length > 1 && items.some((it) => variantsOf(assets, it.asset_id).some((v) => !hidden.has(v.id))) && (
            <div className="grid grid-cols-[1fr_120px] gap-2">
              <CtField label="Nhãn nhóm">
                <CtInput value={cfg.groupLabel} placeholder="Choose style" onChange={(e) => set({ groupLabel: e.target.value })} />
              </CtField>
              <CtField label="Hiển thị nhóm">
                <CtSelect<CtOptionDisplay> value={cfg.groupDisplay} onChange={(groupDisplay) => set({ groupDisplay })} options={DISPLAY_OPTIONS} />
              </CtField>
            </div>
          )}
          <CtCheckbox checked={cfg.allowNone} onChange={(v) => set({ allowNone: v })} label='Cho phép "Không chọn"' hint="Thêm ô NO — khách có thể bỏ trống layer này." />
        </>
      )}

      {items.length > 0 && (
        <div>
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Ảnh trong layer ({items.length})</div>
          <div className="space-y-2">
            {items.map((it) => (
              <GroupCard key={it.id} {...props} item={it} sub={byId.get(it.asset_id)} />
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">Bấm 1 card / 1 ảnh = mặc định (viền cam). Ảnh mờ = ẩn với khách (con mắt để bật). Kéo clipart / cả bộ từ tab Thư viện lên layer để thêm.</p>
        </div>
      )}

      {shown && (
        <div className="rounded-md border p-2">
          <div className="flex items-center gap-1.5 text-[11px]">
            <span className="flex-1 text-muted-foreground">
              Option con của ảnh “{byId.get(shown)?.name || "đang chọn"}”{kids ? ` (${kids})` : ""} — hiện khi khách chọn ảnh này
            </span>
            <button className="rounded px-1 py-0.5 text-[11px] text-orange-600 hover:bg-accent" onClick={() => setMenu((v) => !v)}>
              + con
            </button>
          </div>
          {menu && (
            <div className="mt-1 flex gap-1">
              {CHILD_KINDS.map((k) => (
                <CtButton
                  key={k.kind}
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => {
                    setMenu(false);
                    props.onAddChild({ regionId: region.id, optionId: shown }, k.kind);
                  }}
                >
                  <Plus className="h-3 w-3" /> {k.label}
                </CtButton>
              ))}
            </div>
          )}
        </div>
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
        <div className="text-xs font-semibold">Tạo artwork — chọn option</div>
        <p className="text-[11px] leading-snug text-muted-foreground">
          Chọn option từng layer để ra 1 artwork (chỉ đổi nội dung đang xem, không đổi mặc định của khách). Lưu thiết kế = mỗi version thành 1 artwork trong thư viện
          {props.artworkFolder ? ` (danh mục “${props.artworkFolder}” → tab Artwork)` : " (danh mục mang tên sản phẩm → tab Artwork)"}. Bấm 1 layer ở trên để chỉnh thuộc tính.
        </p>
      </div>
      {rows.length === 0 && <p className="text-[11px] text-muted-foreground">Chưa có layer nào có từ 2 option.</p>}
      {rows.map(({ r, options }) => {
        const cur = selection[r.id];
        if (r.kind === "text")
          return (
            <CtField key={r.id} label={r.name}>
              <CtInput value={cur?.kind === "text" ? cur.text : ""} placeholder={r.config.text.placeholder} onChange={(e) => props.onSampleText(r.id, e.target.value)} />
            </CtField>
          );
        const shown = cur?.kind === "image" ? cur.assetId : null;
        return (
          <div key={r.id}>
            <div className="mb-1 flex items-center gap-1 text-[11px]">
              <span className="truncate font-medium">{r.name}</span>
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
