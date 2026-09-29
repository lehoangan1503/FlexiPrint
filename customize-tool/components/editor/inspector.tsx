"use client";

/**
 * Right sidebar: the layer list (regions, top = drawn last) and the selected
 * region's properties — geometry, kind-specific config, and for image zones
 * the option GROUPS placed in it (each group = one sub asset + its versions).
 */

import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Circle,
  Crown,
  Eye,
  EyeOff,
  GripVertical,
  ImageIcon,
  ImagePlus,
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
} from "lucide-react";
import { CT_FONTS } from "../../config";
import type {
  CtAsset,
  CtOptionDisplay,
  CtPhotoCapabilities,
  CtPhotoSelection,
  CtAiStyle,
  CtPhotoStyleRef,
  CtRegion,
  CtRegionItem,
  CtRegionKind,
  CtSelection,
  CtShape,
  CtTextAlign,
  CtTransform,
} from "../../types";
import { fitShapeToBounds, IDENTITY_TRANSFORM, shapeBounds } from "../../lib/geometry";
import { formOrder, normalizeRegion, variantsOf } from "../../lib/design";
import { CT_PHOTO_STYLES, aiStyleRef, isAiStyleRef, needsServer, styleEngine, styleLabel } from "../../lib/photo-styles";
import { aiStyleModel } from "../../lib/ai-style-models";
import { AiStyleDialog } from "./ai-style-dialog";
import { useAiStyles } from "./ai-styles-store";
import { processPhoto } from "../../lib/photo-process";
import { ctApi } from "../../lib/api-client";
import { CHECKER_STYLE, CtButton, CtCheckbox, CtField, CtInput, CtNumber, CtSelect, CtTextarea, CtTooltip, cx } from "../ui";
import type { DesignApi } from "./use-design";
import { setZoneHidden, updateItem, updateRegion } from "./use-design";
import { isHidden } from "../../lib/layout";

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
  /** Main version whose own layout is being edited (lib/layout.ts); null = the base layout. */
  layoutMain: CtAsset | null;
  assets: CtAsset[];
  selection: CtSelection;
  busy: string | null;
  selectedRegionId: string | null;
  onSelectRegion: (id: string | null) => void;
  activeItemId: string | null;
  onActiveItem: (id: string | null) => void;
  showOverlay: boolean;
  onToggleOverlay: () => void;
  /** New group in an image zone: first file = the group's sub asset, the rest its versions. */
  onUploadGroup: (regionId: string, files: File[]) => void;
  /** More options (versions) for a group. */
  onUploadOptions: (subId: string, files: File[]) => void;
  /** Show an option on the canvas. */
  onPreviewOption: (regionId: string, assetId: string) => void;
  onSetSwatch: (asset: CtAsset, color: string) => void;
  /** Customer-photo zones: try a local photo on the canvas (not saved). */
  onPhotoSelection: (regionId: string, sel: CtPhotoSelection) => void;
  /** A test photo is being processed (label for the canvas spinner); null = done. */
  onPhotoBusy: (regionId: string, label: string | null) => void;
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

  const remove = (id: string) => {
    design.commit((s) => ({ ...s, regions: s.regions.filter((r) => r.id !== id), items: s.items.filter((i) => i.region_id !== id) }));
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
      <div className="max-h-[32%] overflow-y-auto border-b">
        {ordered.length === 0 && (
          <p className="px-3 py-4 text-xs text-muted-foreground">Chưa có vùng nào. Chọn công cụ R / O / P rồi vẽ lên main object.</p>
        )}
        {ordered.map((r, index) => {
          const Icon = KIND_ICON[r.kind];
          const ShapeIcon = SHAPE_ICON[r.shape.type];
          return (
            <div
              key={r.id}
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
                r.id === selectedRegionId ? "bg-sky-500/15" : "hover:bg-accent",
                r.id === dragId && "opacity-40",
              )}
            >
              {dragId && dropAt === index && <span className="pointer-events-none absolute inset-x-1 top-0 h-0.5 -translate-y-1/2 rounded bg-sky-500" />}
              {dragId && dropAt === index + 1 && index === ordered.length - 1 && (
                <span className="pointer-events-none absolute inset-x-1 bottom-0 h-0.5 translate-y-1/2 rounded bg-sky-500" />
              )}
              <GripVertical className="-ml-2 h-3.5 w-3.5 shrink-0 cursor-grab text-muted-foreground/50 active:cursor-grabbing" />
              <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <ShapeIcon className="h-3 w-3 shrink-0 text-muted-foreground/70" />
              {props.layoutMain && isHidden(design.state.config.layouts[props.layoutMain.id], r.id) && (
                <CtTooltip label={`Ẩn ở version “${props.layoutMain.name}”`} side="left">
                  <EyeOff className="h-3 w-3 shrink-0 text-violet-500" />
                </CtTooltip>
              )}
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
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto">
        {region ? (
          <RegionProps {...props} region={normalizeRegion(region)} />
        ) : (
          <p className="px-3 py-4 text-xs text-muted-foreground">Chọn một vùng để chỉnh thuộc tính.</p>
        )}
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
  const setText = (patch: Partial<typeof cfg.text>) => set((r) => ({ ...r, config: { ...r.config, text: { ...r.config.text, ...patch } } }));

  const layoutMain = props.layoutMain;
  const hidden = layoutMain ? isHidden(design.state.config.layouts[layoutMain.id], region.id) : false;

  return (
    <div className="space-y-4 p-3">
      {layoutMain && (
        <div className="space-y-2 rounded-md border border-violet-500/40 bg-violet-500/5 p-2">
          <p className="text-[11px] leading-snug text-muted-foreground">
            Vị trí / kích thước sửa lúc này chỉ áp cho version <b className="text-foreground">{layoutMain.name || "main"}</b>. Tên, nội dung, style… vẫn dùng chung.
          </p>
          <CtCheckbox
            checked={hidden}
            onChange={(v) => design.commit((s) => setZoneHidden(s, layoutMain.id, region.id, v))}
            label="Ẩn vùng này ở version này"
            hint="Vd. version “1 người” ẩn ảnh khách 2, 3 — khách không thấy ô upload đó."
          />
        </div>
      )}
      <CtField label="Tên vùng">
        <CtInput value={region.name} onChange={(e) => set((r) => ({ ...r, name: e.target.value }))} />
      </CtField>

      <CtField label="Loại vùng">
        <CtSelect<CtRegionKind>
          value={region.kind}
          onChange={(kind) => set((r) => ({ ...r, kind }))}
          options={[
            { value: "image", label: "Custom layer — ảnh upload / AI tạo" },
            { value: "text", label: "Text — khách nhập / chọn chữ" },
            { value: "photo", label: "Ảnh khách — khách upload ảnh" },
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
      {region.shape.type === "rect" && (
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
          <CtField label="Nhãn cho khách">
            <CtInput value={cfg.text.label} onChange={(e) => setText({ label: e.target.value })} />
          </CtField>
          <CtField label="Lựa chọn có sẵn" hint="Mỗi dòng 1 lựa chọn → khách chọn từ dropdown (Choose Quote, Choose State). Để trống = khách tự nhập.">
            <CtTextarea
              rows={3}
              value={cfg.text.choices.join("\n")}
              placeholder={"New Driver\nBaby on Board"}
              onChange={(e) => setText({ choices: e.target.value.split("\n").map((l) => l.trimStart()).filter((l, i, all) => l !== "" || i === all.length - 1) })}
              onBlur={(e) => setText({ choices: e.target.value.split("\n").map((l) => l.trim()).filter(Boolean) })}
            />
          </CtField>
          {cfg.text.choices.length === 0 && (
            <>
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
  const fileRef = useRef<HTMLInputElement | null>(null);
  const setT = (patch: Partial<CtTransform>) => onPhotoSelection(region.id, { ...sel, transform: { ...sel.transform, ...patch } });
  const styles = cfg.photo.styles;
  const [caps, setCaps] = useState<CtPhotoCapabilities | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // AI is always the default mode: opening a zone lands on the AI tab, and the effect below
  // replaces any free filters with the AI style. Free only applies once the tab is clicked.
  const [tab, setTab] = useState<"free" | "ai">("ai");
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

  // The AI tab always has exactly one style: no "none → Real photo" state there.
  useEffect(() => {
    if (tab !== "ai" || !ai.loaded || selectedAi) return;
    const ref = defaultAi();
    if (ref) set({ styles: [ref], defaultStyle: ref });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, ai.loaded, ai.styles, selectedAi]);

  /** The tabs are the mode: Free = no-AI filters, AI = one generative style. */
  const switchTab = (t: "free" | "ai") => {
    setTab(t);
    if (t === "free" && styles.some(isAiStyleRef)) set({ styles: ["original"], defaultStyle: "original" });
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
    const free = styles.filter((s) => !isAiStyleRef(s));
    const next: CtPhotoStyleRef[] = CT_PHOTO_STYLES.map((s) => s.id).filter((s) => (s === ref ? on : free.includes(s)));
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
    caps && styles.includes("oil") && !caps.styleService && !caps.ai ? "Oil painting cần service photo-style (CT_PHOTO_STYLE_URL) hoặc GEMINI_API_KEY / OPENAI_API_KEY." : "",
    caps && styles.some(isAiStyleRef) && !caps.aiStyles ? "Style AI cần FAL_KEY trên server." : "",
    caps && cfg.photo.cutout && !caps.cutout ? "Tách nền cần CT_BG_REMOVER_URL, FAL_KEY hoặc 1 AI provider." : "",
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

      {/* Subject cut-out + cropped-edge fade are always applied (lib/design.ts normalizePhotoConfig). */}
      <div className="space-y-2.5 rounded-md border p-2.5">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Style cho khách chọn</div>
        <div className="grid grid-cols-2 rounded-md bg-muted p-0.5 text-xs">
          {(["free", "ai"] as const).map((t) => {
            const n = t === "free" ? styles.filter((s) => !isAiStyleRef(s)).length : styles.filter(isAiStyleRef).length;
            return (
              <button
                key={t}
                type="button"
                onClick={() => switchTab(t)}
                className={cx("rounded px-2 py-1 font-medium", tab === t ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}
              >
                {t === "free" ? "Free" : "AI tạo ảnh"}
                {n > 0 && <span className="ml-1 rounded-full bg-sky-500/15 px-1.5 text-[10px] text-sky-600">{n}</span>}
              </button>
            );
          })}
        </div>

        {tab === "free" ? (
          <div className="space-y-1.5">
            {CT_PHOTO_STYLES.map((s) => (
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

        {tab === "free" && styles.length > 1 && !styles.some(isAiStyleRef) && (
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
      <AiStyleDialog key={dialog === null ? "closed" : dialog === "new" ? "new" : dialog.id} target={dialog} onClose={() => setDialog(null)} onSaved={(st) => !styles.includes(aiStyleRef(st.id)) && dialog === "new" && toggleStyle(aiStyleRef(st.id), true)} />

      <div className="space-y-2 rounded-md border p-2.5">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Thử ảnh khách</div>
        <p className="text-[11px] leading-snug text-muted-foreground">Upload một ảnh mẫu để xem kết quả cuối trên canvas. Ảnh chỉ dùng để thử, không lưu vào thiết kế.</p>
        <div className="flex gap-1.5">
          <CtButton size="sm" variant="primary" disabled={working !== null} onClick={() => fileRef.current?.click()}>
            <Upload className="h-3.5 w-3.5" /> {sel.url ? "Đổi ảnh test" : "Upload ảnh test"}
          </CtButton>
          {(sel.url || sel.sourceUrl) && (
            <CtButton size="sm" variant="ghost" disabled={working !== null} onClick={() => onPhotoSelection(region.id, { kind: "photo", url: null, transform: { ...IDENTITY_TRANSFORM } })}>
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

function RangeField({ label, min, max, value, onChange }: { label: string; min: number; max: number; value: number; onChange: (v: number) => void }) {
  return (
    <CtField label={label}>
      <input type="range" min={min} max={max} value={value} className="w-full accent-sky-500" onChange={(e) => onChange(Number(e.target.value))} />
    </CtField>
  );
}

// ---------------------------------------------------------------------------
// Object zone: groups of options
// ---------------------------------------------------------------------------

function ImageProps(props: InspectorProps & { region: CtRegion }) {
  const { design, region, assets, busy } = props;
  const cfg = region.config.image;
  const set = (patch: Partial<typeof cfg>) =>
    design.commit((s) => updateRegion(s, region.id, (r) => { const n = normalizeRegion(r); return { ...n, config: { ...n.config, image: { ...n.config.image, ...patch } } }; }));
  const items = design.state.items.filter((i) => i.region_id === region.id).sort((a, c) => a.sort_order - c.sort_order);
  const byId = new Map(assets.map((a) => [a.id, a]));
  const fileRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="space-y-3 border-t pt-3">
      <div className="grid grid-cols-[1fr_120px] gap-2">
        <CtField label="Nhãn option">
          <CtInput value={cfg.label} placeholder="Choose Dumpling" onChange={(e) => set({ label: e.target.value })} />
        </CtField>
        <CtField label="Hiển thị">
          <CtSelect<CtOptionDisplay> value={cfg.display} onChange={(display) => set({ display })} options={DISPLAY_OPTIONS} />
        </CtField>
      </div>
      {items.length > 1 && (
        <div className="grid grid-cols-[1fr_120px] gap-2">
          <CtField label="Nhãn nhóm">
            <CtInput value={cfg.groupLabel} placeholder="Choose Style" onChange={(e) => set({ groupLabel: e.target.value })} />
          </CtField>
          <CtField label="Hiển thị nhóm">
            <CtSelect<CtOptionDisplay> value={cfg.groupDisplay} onChange={(groupDisplay) => set({ groupDisplay })} options={DISPLAY_OPTIONS} />
          </CtField>
        </div>
      )}
      <CtCheckbox checked={cfg.allowNone} onChange={(v) => set({ allowNone: v })} label='Cho phép "Không chọn"' hint="Thêm ô NO — khách có thể bỏ trống vùng này." />

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Nhóm option ({items.length})</span>
        </div>
        <p className="mb-2 text-[11px] leading-snug text-muted-foreground">
          Mỗi ảnh là 1 option. Một nhóm dùng chung vị trí/scale. Có 2+ nhóm thì khách chọn nhóm trước (vd. Glitter / No Glitter), đổi nhóm vẫn giữ đúng vị trí option.
        </p>
        <div className="space-y-2">
          {items.map((it) => (
            <GroupCard key={it.id} {...props} item={it} sub={byId.get(it.asset_id)} />
          ))}
        </div>
        <CtButton size="sm" variant="primary" className="mt-2 w-full justify-center" disabled={busy !== null} onClick={() => fileRef.current?.click()}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />} Thêm nhóm — upload nhiều ảnh
        </CtButton>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length) props.onUploadGroup(region.id, files);
          }}
        />
        <p className="mt-1.5 text-[11px] text-muted-foreground">Hoặc bấm “Đặt vào vùng” trên một sub object ở panel trái.</p>
      </div>
    </div>
  );
}

function GroupCard(props: InspectorProps & { region: CtRegion; item: CtRegionItem; sub: CtAsset | undefined }) {
  const { design, region, item, sub, assets, activeItemId, selection } = props;
  const cfg = region.config.image;
  const active = item.id === activeItemId;
  const fileRef = useRef<HTMLInputElement | null>(null);
  if (!sub) return null;
  const options = [sub, ...variantsOf(assets, sub.id)];
  const hidden = new Set(cfg.hiddenAssetIds);
  const cur = selection[region.id];
  const shown = cur?.kind === "image" ? cur.assetId : null;
  const t = item.transform;

  const setCfg = (patch: Partial<typeof cfg>) =>
    design.commit((s) => updateRegion(s, region.id, (r) => { const n = normalizeRegion(r); return { ...n, config: { ...n.config, image: { ...n.config.image, ...patch } } }; }));
  const setT = (patch: Partial<CtTransform>) => design.commit((s) => updateItem(s, item.id, (i) => ({ ...i, transform: { ...i.transform, ...patch } })));
  const toggleHidden = (id: string) =>
    setCfg({ hiddenAssetIds: hidden.has(id) ? cfg.hiddenAssetIds.filter((x) => x !== id) : [...cfg.hiddenAssetIds, id] });

  return (
    <div className={cx("rounded-md border p-2", active && "border-rose-500 ring-1 ring-rose-500")}>
      <div className="flex items-center gap-1.5">
        <CtInput
          className="h-7 flex-1 text-xs font-medium"
          value={cfg.groupNames[item.id] ?? sub.name}
          placeholder="Tên nhóm (vd. Glitter)"
          onChange={(e) => setCfg({ groupNames: { ...cfg.groupNames, [item.id]: e.target.value } })}
        />
        <CtTooltip label={item.is_default ? "Nhóm mặc định" : "Đặt làm nhóm mặc định"}>
          <button
            className={cx("rounded p-1 hover:bg-accent", item.is_default ? "text-amber-500" : "text-muted-foreground")}
            onClick={() => design.commit((s) => ({ ...s, items: s.items.map((i) => (i.region_id === region.id ? { ...i, is_default: i.id === item.id } : i)) }))}
          >
            <Crown className="h-3.5 w-3.5" />
          </button>
        </CtTooltip>
        <CtTooltip label="Chỉnh vị trí / scale / xoay trên canvas" shortcut={["Enter"]}>
          <button className={cx("rounded p-1 hover:bg-accent", active && "bg-rose-500/15 text-rose-500")} onClick={() => props.onActiveItem(active ? null : item.id)}>
            <Move className="h-3.5 w-3.5" />
          </button>
        </CtTooltip>
        <CtTooltip label="Gỡ nhóm khỏi vùng (ảnh vẫn còn trong tab Sub)">
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
                  className={cx("block aspect-square w-full overflow-hidden rounded border", shown === o.id && "ring-2 ring-orange-500", isHidden && "opacity-30")}
                  style={CHECKER_STYLE}
                  onClick={() => props.onPreviewOption(region.id, o.id)}
                >
                  <img src={o.url} alt="" className="h-full w-full object-contain" loading="lazy" />
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
        <CtTooltip label="Upload thêm option vào nhóm này">
          <button
            className="flex aspect-square items-center justify-center rounded border border-dashed text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
            disabled={props.busy !== null}
            onClick={() => fileRef.current?.click()}
          >
            <ImagePlus className="h-4 w-4" />
          </button>
        </CtTooltip>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length) props.onUploadOptions(sub.id, files);
          }}
        />
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
