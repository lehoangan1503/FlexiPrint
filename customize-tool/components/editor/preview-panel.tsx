"use client";

/**
 * "Tổ hợp": make the product's mockups by hand, Photoshop-style — a stack of
 * independent frames.
 *
 *   toolbar  what can go in: the main versions — each the FINISHED artwork,
 *            drawn with the design's own content (config.samples: texts,
 *            choices, test photos from the Thiết kế tab) and the MATERIAL
 *            version of every clipart (lib/mockup.ts frameArt) — dragged or
 *            clicked in as a product frame; an Image frame (a photo, the
 *            size of the edit frame); a background (colour or gradient,
 *            lib/gradients.ts); text.
 *   centre   the edit frame: move / resize / rotate the selected frame; a
 *            vertical toolbar (EditTools): chọn (V), crop the active frame
 *            (C), cắt = lasso an area off it (L), cọ làm mờ (B) / tẩy (E) — a blur layer over everything
 *            under it, merged — lật, nhân bản (⌘D), ⌘Z / ⇧⌘Z.
 *   right    the frames, top first: drag to restack, eye, delete; the
 *            selected frame's settings (size typed in, …) or, with none
 *            selected, the edit frame's size.
 *   bottom   "Lưu tổ hợp" saves the picture + its scene (meta.scene) as a
 *            product mockup, numbered #1, #2… Pick some → "Lưu làm template"
 *            (a named set in the library); another product of the kind →
 *            "Dùng template": its own versions + design go in the frames.
 *            "Tăng chất lượng với AI" remakes them photoreal (enhance-dialog).
 *
 * A frame needs the material of every clipart it shows ("Tạo vật liệu").
 * Designs whose custom parts reach outside the main can get an AI material
 * of the whole artwork instead ("Vật liệu AI cho artwork").
 * (The customer-facing page is the "Xem trước" tab, storefront-preview.tsx.)
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlignCenter,
  Brush,
  Copy,
  Crop,
  Eraser,
  Lasso,
  FlipHorizontal2,
  FlipVertical2,
  MousePointer2,
  AlignLeft,
  AlignRight,
  Check,
  Download,
  Eye,
  EyeOff,
  Frame,
  GripVertical,
  Hand,
  ImagePlus,
  Layers,
  Loader2,
  Lock,
  Maximize,
  Package,
  PaintBucket,
  Plus,
  Redo2,
  Save,
  Sparkles,
  Trash2,
  Type,
  Undo2,
} from "lucide-react";
import { CT_FONTS } from "../../config";
import type {
  CtMockupEdit,
  CtAsset,
  CtMainLayout,
  CtMockupPack,
  CtPackBlend,
  CtPackBlurLayer,
  CtPackBox,
  CtPackBrushStroke,
  CtPackFillLayer,
  CtPackFrameLayer,
  CtPackImage,
  CtPackImageLayer,
  CtPackLayer,
  CtPackSlide,
  CtPackTextLayer,
  CtPreset,
  CtRegion,
  CtRegionItem,
  CtSelection,
} from "../../types";
import { normalizeRegion } from "../../lib/design";
import { canvasToBlob, renderComposite } from "../../lib/compositor";
import { renditionOf } from "../../lib/library";
import { CT_GRADIENTS } from "../../lib/gradients";
import {
  fillCss,
  frameArt,
  frameMain,
  frameRules,
  frameMissing,
  frameSelection,
  gradientCss,
  LAYER_LABEL,
  cropFull,
  newBlurLayer,
  sceneToContent,
  newFrame,
  newLayer,
  newSlide,
  normalizeSlide,
  renderSlide,
  resizeSlide,
  sceneArts,
  sceneForProduct,
  sceneIsOpaque,
  type CtFrameContext,
  type CtSlotArt,
} from "../../lib/mockup";
import { ctApi } from "../../lib/api-client";
import { CHECKER_STYLE, CtButton, CtCheckbox, CtField, CtInput, CtNumber, CtSelect, CtTextarea, CtTooltip, cx } from "../ui";
import { ctConfirm, ctPrompt } from "../dialogs";
import { canCrop, PackCanvas, type CtPackTool } from "../mockup/pack-canvas";
import { newId } from "../../lib/geometry";
import { EnhanceDialog, type EnhanceItem } from "./enhance-dialog";
import { nearestAspect, PackImageLibrary } from "./pack-image-library";

/** dataTransfer type of a main version dragged from the strip. */
const VERSION_DRAG = "application/x-ct-version";
/** dataTransfer type of a layer row being restacked. */
const LAYER_DRAG = "application/x-ct-layer";
/** Longest side a saved tổ hợp is rendered at. */
const SAVE_MAX_SIDE = 3000;

const TOOL_KEYS: Record<string, CtPackTool> = {
  v: "select",
  h: "hand",
  c: "crop",
  l: "cut",
  b: "brush",
  e: "erase",
};

const BLENDS: CtPackBlend[] = ["normal", "multiply", "screen", "overlay", "soft-light", "darken", "lighten"];

const SIZE_PRESETS: Array<{ label: string; w: number; h: number }> = [
  { label: "1:1", w: 2000, h: 2000 },
  { label: "4:5", w: 1600, h: 2000 },
  { label: "3:4", w: 1500, h: 2000 },
  { label: "4:3", w: 2000, h: 1500 },
  { label: "16:9", w: 2400, h: 1350 },
  { label: "9:16", w: 1350, h: 2400 },
];

/** The scene being edited, per product — survives switching tabs. */
const drafts = new Map<string, { scene: CtPackSlide; openedId: string | null }>();

/** Undo / redo of the edit frame: `past` oldest first, `future` next first. */
interface SceneHistory {
  past: CtPackSlide[];
  scene: CtPackSlide;
  future: CtPackSlide[];
}

const sameScene = (a: CtPackSlide, b: CtPackSlide) => a === b || JSON.stringify(a) === JSON.stringify(b);

export interface PreviewPanelProps {
  productId: string;
  main: CtAsset;
  /** Main versions offered to the customer, default first; empty when the option is off. */
  mains: CtAsset[];
  /** Per-main-version layouts (config.layouts). */
  layouts: Record<string, CtMainLayout>;
  assets: CtAsset[];
  regions: CtRegion[];
  items: CtRegionItem[];
  /** The design's own content (Thiết kế tab) — every product frame draws it. */
  samples: CtSelection;
  /** Save flat artworks (composites) — the AI artwork material starts from one. */
  onSaveComposites: (blobs: Array<{ blob: Blob; selection: CtSelection }>) => Promise<CtAsset[]>;
  /** New product assets (mockups, AI artwork materials). */
  onAdded: (assets: CtAsset[]) => void;
  /** Open the AI material recipe for these cliparts (one family). */
  onCreateMaterial: (cliparts: CtAsset[]) => void;
  /** Delete without asking (the panel asks first). */
  onDelete: (a: CtAsset) => Promise<void>;
  /** The tổ hợp the storefront edits on (config.mockupEdit), and setting it (null = none). */
  mockupEdit: CtMockupEdit | null;
  onMockupEdit: (m: CtMockupEdit | null) => void;
  flash: (msg: string) => void;
}

/** The box at another aspect (w / h): same area, same centre. */
function boxToRatio(b: CtPackBox, aspect: number): CtPackBox {
  const w = Math.sqrt(b.w * b.h * aspect);
  const h = w / aspect;
  return {
    ...b,
    x: Math.round(b.x + (b.w - w) / 2),
    y: Math.round(b.y + (b.h - h) / 2),
    w: Math.round(w),
    h: Math.round(h),
  };
}

/** The box at w×h, same centre. */
function boxAtSize(b: CtPackBox, w: number, h: number): CtPackBox {
  return {
    ...b,
    x: Math.round(b.x + (b.w - w) / 2),
    y: Math.round(b.y + (b.h - h) / 2),
    w: Math.round(w),
    h: Math.round(h),
  };
}

/**
 * A version's material pictures in picker order: each vật liệu version followed by its đa sắc, then the vật liệu
 * of the version's own đa sắc.
 */
function orderMaterials(list: CtAsset[], versionId: string): CtAsset[] {
  const byTime = (a: CtAsset, b: CtAsset) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at);
  const own = list.filter((a) => a.parent_id === versionId && !a.meta?.variant).sort(byTime);
  const ownIds = new Set(own.map((a) => a.id));
  return [
    ...own.flatMap((r) => [r, ...list.filter((a) => a.parent_id === r.id && a.meta?.variant).sort(byTime)]),
    ...list.filter((a) => a.parent_id !== versionId && !ownIds.has(a.parent_id ?? "")).sort(byTime),
  ];
}

/** Short label of a material picture: "đa sắc" (of a vật liệu, or vật liệu of a đa sắc), its material version ("có dây"), or "vật liệu". */
function materialLabel(pic: CtAsset, versionId: string): string {
  const version = typeof pic.meta?.materialVersion === "string" ? pic.meta.materialVersion : "";
  if (pic.meta?.variant || pic.parent_id !== versionId) return version ? `đa sắc · ${version}` : "đa sắc";
  return version || "vật liệu";
}

/** Which material picture of its version a product frame shows. */
function FramePicture({
  layer,
  versions,
  materials,
  onPatch,
}: {
  layer: CtPackFrameLayer;
  versions: CtAsset[];
  materials: Record<string, CtAsset[]>;
  onPatch: LayerSettingsProps["onPatch"];
}) {
  const v = versions[Math.min(layer.mainIndex, versions.length - 1)];
  const list = v ? (materials[v.id] ?? []) : [];
  if (!v || list.length < 2) return null;
  return (
    <CtField label="Vật liệu / đa sắc">
      <CtSelect
        value={layer.pictureId ?? ""}
        onChange={(id) =>
          onPatch({
            pictureId: id || null,
            artworkId: null,
          } as Partial<CtPackFrameLayer>)
        }
        options={[
          { value: "", label: "Mặc định" },
          ...list.map((a, i) => ({
            value: a.id,
            label: `${i + 1}. ${materialLabel(a, v.id)}${a.name ? ` — ${a.name}` : ""}`,
          })),
        ]}
      />
    </CtField>
  );
}

function imageSize(url: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 1, h: 1 });
    img.src = url;
  });
}

export function PreviewPanel(props: PreviewPanelProps) {
  const { main, assets, items, layouts, samples } = props;
  const regions = useMemo(() => props.regions.map(normalizeRegion).sort((a, b) => a.sort_order - b.sort_order), [props.regions]);
  const versions = useMemo(() => (props.mains.length ? props.mains : [main]), [props.mains, main]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [presets, setPresets] = useState<CtPreset[]>([]);
  const [packs, setPacks] = useState<CtMockupPack[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [enhanceOpen, setEnhanceOpen] = useState(false);

  useEffect(() => {
    ctApi
      .listPresets("material")
      .then((r) => setPresets(r.presets))
      .catch(() => undefined);
    ctApi
      .listPacks()
      .then((r) => setPacks(r.packs))
      .catch(() => undefined);
  }, []);

  // ---------------------------------------------------------------- scene + history
  const draft = drafts.get(props.productId);
  const [hist, setHist] = useState<SceneHistory>(() => ({ past: [], scene: draft?.scene ?? newSlide("Tổ hợp 1"), future: [] }));
  const { scene, past, future } = hist;
  /** The history as of the last change, for handlers that run after an await or several in one tick. */
  const histRef = useRef(hist);
  const setHistory = (next: SceneHistory) => {
    histRef.current = next;
    setHist(next);
  };
  const [openedId, setOpenedId] = useState<string | null>(() => draft?.openedId ?? null);
  const [layerId, setLayerId] = useState<string | null>(null);
  /** The scene before the live changes not committed yet (a drag, a slider). */
  const dragBase = useRef<CtPackSlide | null>(null);
  /** The last commit that may fold into the next (typing a number = one step). */
  const lastMerge = useRef<{ key: string; at: number } | null>(null);
  useEffect(() => {
    drafts.set(props.productId, { scene, openedId });
  }, [props.productId, scene, openedId]);

  /**
   * One undo step: every change goes through here. A commit that changes nothing (a click, a blur) leaves the
   * history alone, so it never wipes the redo steps; `merge` folds quick repeats of the same edit into one step.
   */
  const commit = (next: CtPackSlide, merge?: string) => {
    const h = histRef.current;
    const base = dragBase.current ?? h.scene;
    dragBase.current = null;
    if (sameScene(base, next)) {
      if (next !== h.scene) setHistory({ ...h, scene: next });
      return;
    }
    const now = Date.now();
    const folds = !!merge && lastMerge.current?.key === merge && now - lastMerge.current.at < 800 && h.past.length > 0;
    lastMerge.current = merge ? { key: merge, at: now } : null;
    // Folded back to where the step started (a toggle clicked twice): the step is gone.
    if (folds && sameScene(h.past[h.past.length - 1], next)) return setHistory({ past: h.past.slice(0, -1), scene: next, future: [] });
    setHistory({ past: folds ? h.past : [...h.past.slice(-100), base], scene: next, future: [] });
  };
  /** A change still in progress: shows now, becomes one step on the commit that ends it. */
  const live = (next: CtPackSlide) => {
    const h = histRef.current;
    if (!dragBase.current) dragBase.current = h.scene;
    setHistory({ ...h, scene: next });
  };
  /** Swaps the scene without a step (the name it was saved under). */
  const replaceScene = (next: CtPackSlide) => setHistory({ ...histRef.current, scene: next });
  const undo = () => {
    const h = histRef.current;
    lastMerge.current = null;
    // A change still in progress counts as the newest step: undo goes back to before it, redo brings it back.
    const pending = dragBase.current;
    dragBase.current = null;
    if (pending && !sameScene(pending, h.scene)) return setHistory({ past: h.past, scene: pending, future: [h.scene, ...h.future] });
    const prev = h.past[h.past.length - 1];
    if (!prev) return;
    setHistory({ past: h.past.slice(0, -1), scene: prev, future: [h.scene, ...h.future] });
  };
  const redo = () => {
    const h = histRef.current;
    lastMerge.current = null;
    dragBase.current = null;
    const next = h.future[0];
    if (!next) return;
    setHistory({ past: [...h.past, h.scene], scene: next, future: h.future.slice(1) });
  };
  // Vertical toolbar state (EditTools).
  const [tool, setTool] = useState<CtPackTool>("select");
  const [brushSize, setBrushSize] = useState(120);
  const [blurStrength, setBlurStrength] = useState(20);
  const keys = useRef({
    undo,
    redo,
    remove: () => {},
    duplicate: () => {},
    tool: (_t: CtPackTool) => {},
    brush: (_k: number) => {},
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable || t.closest('[role="dialog"]'))) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) keys.current.redo();
        else keys.current.undo();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        keys.current.duplicate();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        keys.current.remove();
      } else if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        const tool = TOOL_KEYS[e.key.toLowerCase()];
        if (tool) keys.current.tool(tool);
        else if (e.key === "Escape" || e.key === "Enter") keys.current.tool("select");
        else if (e.key === "[" || e.key === "]") keys.current.brush(e.key === "]" ? 1.25 : 0.8);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const layer = scene.layers.find((l) => l.id === layerId) ?? null;
  const patchLayer = (id: string, patch: Partial<CtPackLayer>, how: "commit" | "live" = "commit") => {
    const cur = histRef.current.scene;
    const next = {
      ...cur,
      layers: cur.layers.map((l) => (l.id === id ? ({ ...l, ...patch } as CtPackLayer) : l)),
    };
    if (how === "live") live(next);
    // Repeats of the same field on the same frame (typing a number) are one step; a drag already is.
    else commit(next, dragBase.current ? undefined : `${id}:${Object.keys(patch).sort().join(",")}`);
  };
  const removeLayer = (id: string) => {
    commit({ ...scene, layers: scene.layers.filter((l) => l.id !== id) });
    if (layerId === id) setLayerId(null);
  };
  /** Restack: `id` goes where `targetId` is (both in scene order, bottom first). */
  const restack = (id: string, targetId: string) => {
    const from = scene.layers.findIndex((l) => l.id === id);
    const to = scene.layers.findIndex((l) => l.id === targetId);
    if (from < 0 || to < 0 || from === to) return;
    const list = [...scene.layers];
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    commit({ ...scene, layers: list });
  };
  /** New frames go on top — a background goes to the bottom. */
  const addLayer = (l: CtPackLayer) => {
    commit({
      ...scene,
      layers: l.type === "fill" ? [l, ...scene.layers] : [...scene.layers, l],
    });
    setLayerId(l.id);
  };
  useEffect(() => {
    keys.current = {
      undo,
      redo,
      remove: () => layerId && removeLayer(layerId),
      duplicate: () => layer && duplicate(layer),
      tool: (t) => setTool(t),
      brush: (k) => setBrushSize((v) => Math.round(Math.min(1000, Math.max(4, v * k)))),
    };
  });

  // ---------------------------------------------------------------- tools (vertical toolbar)
  /** Layer + stroke index the stroke being painted lives at. */
  const painting = useRef<{ layerId: string; index: number } | null>(null);
  /** The blur layer strokes go on: the selected one, else the topmost layer when it is one. */
  const blurTarget = (): CtPackBlurLayer | null => {
    const sel = scene.layers.find((l): l is CtPackBlurLayer => l.id === layerId && l.type === "blur");
    const top = scene.layers[scene.layers.length - 1];
    return sel ?? (top?.type === "blur" ? top : null);
  };
  const onStroke = (stroke: CtPackBrushStroke, done: boolean) => {
    const scene = histRef.current.scene;
    let layers = scene.layers;
    let at = painting.current;
    if (!at) {
      const target = blurTarget();
      if (!target && stroke.erase) return;
      const l = target ?? newBlurLayer(scene.width, scene.height, blurStrength);
      if (!target) layers = [...layers, l];
      at = { layerId: l.id, index: l.strokes.length };
      painting.current = at;
      setLayerId(l.id);
    }
    const { layerId: id, index } = at;
    const next = {
      ...scene,
      layers: layers.map((l) => (l.id === id && l.type === "blur" ? { ...l, strokes: [...l.strokes.slice(0, index), stroke] } : l)),
    };
    if (done) {
      painting.current = null;
      commit(next);
    } else live(next);
  };
  const setStrength = (strength: number, how: "commit" | "live") => {
    setBlurStrength(strength);
    const target = blurTarget();
    if (target) patchLayer(target.id, { strength } as Partial<CtPackBlurLayer>, how);
  };

  /** Lasso: cut the circled area away, keep only it, or lift it onto a new frame above. */
  const [cutMode, setCutMode] = useState<CutMode>("remove");
  const onCut = (id: string, points: number[]) => {
    const l = scene.layers.find((x) => x.id === id);
    if (!l || l.type === "blur") return;
    const uv: number[] = [];
    for (let i = 0; i + 1 < points.length; i += 2) {
      const q = sceneToContent(l, points[i], points[i + 1]);
      uv.push(Math.round(q.u * 10000) / 10000, Math.round(q.v * 10000) / 10000);
    }
    if (cutMode !== "layer") {
      patchLayer(id, { cuts: [...(l.cuts ?? []), { points: uv, keep: cutMode === "keep" }] });
      return;
    }
    const part = { ...l, id: newId(), name: `${l.name} (vùng cắt)`, cuts: [...(l.cuts ?? []), { points: uv, keep: true }] };
    const i = scene.layers.findIndex((x) => x.id === id);
    commit({ ...scene, layers: [...scene.layers.slice(0, i + 1), part, ...scene.layers.slice(i + 1)] });
    setLayerId(part.id);
  };

  /** A copy just above it, nudged so it shows. */
  const duplicate = (l: CtPackLayer) => {
    if (l.type === "blur") return;
    const copy = {
      ...l,
      id: newId(),
      name: `${l.name} (copy)`,
      box: { ...l.box, x: l.box.x + 40, y: l.box.y + 40 },
    };
    const i = scene.layers.findIndex((x) => x.id === l.id);
    commit({
      ...scene,
      layers: [...scene.layers.slice(0, i + 1), copy, ...scene.layers.slice(i + 1)],
    });
    setLayerId(copy.id);
  };

  // ---------------------------------------------------------------- frames
  /** Every material picture of each version (vật liệu, their đa sắc, vật liệu of its đa sắc), by version id. */
  const [materials, setMaterials] = useState<Record<string, CtAsset[]>>({});
  const versionIds = versions.map((v) => v.id).join(",");
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      versions.map((v) =>
        ctApi
          .clipartMaterials(v.id)
          .then((list): [string, CtAsset[]] => [v.id, orderMaterials(list, v.id)])
          .catch((): [string, CtAsset[]] => [v.id, []]),
      ),
    ).then((list) => !cancelled && setMaterials(Object.fromEntries(list)));
    return () => {
      cancelled = true;
    };
    // versions is read through versionIds: a new array with the same versions must not refetch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionIds]);
  /** The product's assets + those pictures, so a frame can draw the one it picked. */
  const frameAssets = useMemo(() => {
    const have = new Set(assets.map((a) => a.id));
    return [
      ...assets,
      ...Object.values(materials)
        .flat()
        .filter((a) => !have.has(a.id) && have.add(a.id)),
    ];
  }, [assets, materials]);
  const ctx = useMemo<CtFrameContext>(
    () => ({
      samples,
      main,
      mains: versions,
      assets: frameAssets,
      regions,
      items,
      layouts,
      presets,
    }),
    [samples, main, versions, frameAssets, regions, items, layouts, presets],
  );
  const frames = scene.layers.filter((l): l is CtPackFrameLayer => l.type === "frame");
  /** Only what changes a frame's picture — not its box. */
  const framesKey = JSON.stringify(frames.map((f) => [f.id, f.mainIndex, f.artworkId, f.pictureId, f.hidden]));
  const [arts, setArts] = useState<Record<string, CtSlotArt>>({});
  useEffect(() => {
    let cancelled = false;
    void sceneArts(scene, ctx).then((a) => !cancelled && setArts(a));
    return () => {
      cancelled = true;
    };
    // scene is read through framesKey: moving a frame must not re-render pictures
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [framesKey, ctx]);

  /** Every version as the finished artwork (same render a frame uses, so dragging one in is instant). */
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      versions.map((v, i) =>
        frameArt(newFrame({ width: 1000, height: 1000 }, i, null, 1), ctx)
          .then((a): [string, string] => [v.id, a.url])
          .catch(() => null),
      ),
    ).then((list) => {
      if (!cancelled) setThumbs(Object.fromEntries(list.filter((x): x is [string, string] => x !== null)));
    });
    return () => {
      cancelled = true;
    };
  }, [versions, ctx]);

  const missing = useMemo(() => {
    const map = new Map<string, CtAsset>();
    for (const f of frames) if (!f.hidden) for (const m of frameMissing(f, ctx)) map.set(m.id, m);
    return [...map.values()];
    // frames is derived from scene; framesKey tracks what matters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [framesKey, ctx]);

  const createMaterial = (list: CtAsset[]) => {
    const own = list.find((a) => a.product_id !== null);
    if (own) return props.flash(`“${own.name}” là clipart riêng của sản phẩm — đưa vào thư viện trước rồi tạo vật liệu`);
    const origin = (a: CtAsset) => a.parent_id ?? a.id;
    const first = list[0];
    if (first) props.onCreateMaterial(list.filter((a) => origin(a) === origin(first)));
  };

  /** `pictureId`: one of the version's material pictures; null = its default material. */
  const addFrame = (versionId: string, at: { x: number; y: number } | null, pictureId: string | null = null) => {
    const index = Math.max(0, versions.findIndex((v) => v.id === versionId));
    const v = versions[index] ?? main;
    const f = newFrame(scene, index, at, main.width / main.height);
    const pic = pictureId ? materials[v.id]?.find((a) => a.id === pictureId) : undefined;
    f.name = [v.name || `Version ${index + 1}`, pic && materialLabel(pic, v.id)].filter(Boolean).join(" · ");
    f.pictureId = pic?.id ?? null;
    addLayer(f);
  };

  /** Version whose material pictures show under the toolbar. */
  const [openVersion, setOpenVersion] = useState<string | null>(null);
  const openList = openVersion ? (materials[openVersion] ?? []) : [];
  /** Finished artwork of each picture of the open version (same render its frame uses). */
  const [picThumbs, setPicThumbs] = useState<Record<string, string>>({});
  useEffect(() => {
    const index = versions.findIndex((v) => v.id === openVersion);
    if (index < 0) return;
    let cancelled = false;
    for (const pic of materials[versions[index].id] ?? []) {
      const f = { ...newFrame({ width: 1000, height: 1000 }, index, null, 1), pictureId: pic.id };
      void frameArt(f, ctx)
        .then((a) => !cancelled && setPicThumbs((t) => ({ ...t, [pic.id]: a.url })))
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [openVersion, versions, materials, ctx]);

  // ---------------------------------------------------------------- image frames, background, text
  /** The photo library is open for a new image frame, or to change one's photo. */
  const [libraryFor, setLibraryFor] = useState<{
    replace: string | null;
  } | null>(null);
  /** An image frame fills the edit frame (cover); its size is typed in on the right. */
  const addImageFrame = () => setLibraryFor({ replace: null });
  const replaceImage = (l: CtPackImageLayer) => setLibraryFor({ replace: l.id });
  const usePhoto = (img: CtPackImage) => {
    if (!img.url) return;
    const target = libraryFor?.replace ? scene.layers.find((x): x is CtPackImageLayer => x.id === libraryFor.replace && x.type === "image") : undefined;
    if (!target) return addLayer(newLayer("image", scene.width, scene.height, { url: img.url }));
    const w = img.width ?? 0;
    const h = img.height ?? 0;
    patchLayer(target.id, target.fit === "original" && w > 1 && h > 1 ? { url: img.url, box: boxAtSize(target.box, w, h) } : { url: img.url });
  };

  /** Photo fit; "original" makes the frame the photo's real pixel size (the edit frame stays, overflow is cut). */
  const setFit = async (l: CtPackImageLayer, fit: CtPackImageLayer["fit"]) => {
    // Leaving "original": cover / contain work against the edit frame again, so the frame fills it.
    if (fit !== "original")
      return patchLayer(
        l.id,
        l.fit === "original"
          ? {
              fit,
              box: { x: 0, y: 0, w: scene.width, h: scene.height, rotation: 0 },
            }
          : { fit },
      );
    const { w, h } = await imageSize(l.url);
    patchLayer(l.id, w > 1 && h > 1 ? { fit, box: boxAtSize(l.box, w, h), crop: null } : { fit });
  };

  /** The edit frame takes the photo's proportions (same area); the photo then fills it. */
  const frameToImage = async (l: CtPackImageLayer) => {
    const { w, h } = await imageSize(l.url);
    if (w < 2 || h < 2) return;
    const cur = histRef.current.scene;
    const area = cur.width * cur.height;
    const width = Math.sqrt((area * w) / h);
    const resized = resizeSlide(cur, width, (width * h) / w);
    commit({
      ...resized,
      layers: resized.layers.map((x) =>
        x.id === l.id
          ? {
              ...x,
              box: {
                x: 0,
                y: 0,
                w: resized.width,
                h: resized.height,
                rotation: 0,
              },
            }
          : x,
      ),
    });
  };

  // ---------------------------------------------------------------- save / templates
  const saved = useMemo(() => assets.filter((a) => a.role === "mockup").sort((a, b) => a.created_at.localeCompare(b.created_at)), [assets]);

  // ---------------------------------------------------------------- mockup edit
  /**
   * One saved tổ hợp becomes the customer's editing canvas on the storefront: its scene, every product frame
   * showing the live design. Its frames keep box / shadow / cord; the material rules give the hanger.
   */
  const chooseMockupEdit = (id: string) => {
    const m = saved.find((a) => a.id === id);
    if (!m?.meta.scene) {
      props.onMockupEdit(null);
      setEye(false);
      return;
    }
    const slide = sceneForProduct(normalizeSlide(m.meta.scene));
    const frames: CtMockupEdit["frames"] = {};
    for (const l of slide.layers) {
      if (l.type !== "frame") continue;
      const rules = frameRules(l, ctx);
      frames[l.id] = { hole: rules.hole, cord: rules.cord };
    }
    props.onMockupEdit({ assetId: m.id, slide, frames });
    props.flash("Mockup edit: khách sẽ chỉnh thiết kế trên tổ hợp này — nhớ Lưu thiết kế");
  };
  /** 👁: the chosen tổ hợp with its rendered product taken out — only the custom area (dashed) is left. */
  const [eye, setEye] = useState(false);
  const [eyeUrl, setEyeUrl] = useState<string | null>(null);
  const mockupEdit = props.mockupEdit;
  useEffect(() => {
    if (!eye || !mockupEdit) {
      setEyeUrl(null);
      return;
    }
    let cancelled = false;
    const s = mockupEdit.slide;
    void renderSlide({ slide: s, arts: {}, scale: Math.min(1, 900 / Math.max(s.width, s.height)), placeholders: true, placeholderLabel: "Custom" })
      .then((c) => !cancelled && setEyeUrl(c.toDataURL("image/png")))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [eye, mockupEdit]);
  const savedScenes = saved.filter((m) => m.meta.scene);
  /** "#n" of a saved tổ hợp: its place in the list. */
  const numbered: EnhanceItem[] = saved.map((asset, i) => ({
    asset,
    number: i + 1,
  }));

  const renderScene = async (s: CtPackSlide, a: Record<string, CtSlotArt>) => {
    const scale = Math.min(1, SAVE_MAX_SIDE / Math.max(s.width, s.height));
    const canvas = await renderSlide({ slide: s, arts: a, scale });
    return canvasToBlob(canvas, sceneIsOpaque(s) ? "image/jpeg" : "image/png", 0.92);
  };

  const saveScene = async () => {
    if (missing.length) return setError("Còn clipart chưa có vật liệu — tạo vật liệu trước khi lưu");
    if (!scene.layers.some((l) => !l.hidden)) return setError("Vùng edit đang trống");
    setBusy("Đang lưu tổ hợp…");
    setError(null);
    try {
      const old = openedId ? saved.find((m) => m.id === openedId) : undefined;
      const replace =
        old &&
        (await ctConfirm({ title: `Ghi đè “${old.name}”?`, message: "Không = lưu thành tổ hợp mới.", confirmLabel: "Ghi đè", cancelLabel: "Lưu mới" }));
      const name = replace && old ? old.name : `Tổ hợp ${saved.length + 1}`;
      const blob = await renderScene(scene, arts);
      const asset = await ctApi.uploadAsset(props.productId, blob, { role: "mockup", name, meta: { scene: { ...scene, name } } });
      if (replace && old) await props.onDelete(old);
      props.onAdded([asset]);
      setOpenedId(asset.id);
      replaceScene({ ...histRef.current.scene, name });
      props.flash(`Đã lưu “${name}”`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lưu thất bại");
    } finally {
      setBusy(null);
    }
  };

  const openSaved = (m: CtAsset) => {
    if (!m.meta.scene) return;
    commit(normalizeSlide(m.meta.scene));
    setOpenedId(m.id);
    setLayerId(null);
  };

  /** A blank edit frame of the same size; asks first when the current one has changes not saved. */
  const newScene = async () => {
    const savedScene = openedId ? saved.find((m) => m.id === openedId)?.meta.scene : undefined;
    const dirty = scene.layers.length > 0 && (!savedScene || JSON.stringify(normalizeSlide(savedScene).layers) !== JSON.stringify(scene.layers));
    if (
      dirty &&
      !(await ctConfirm({
        title: "Bỏ tổ hợp đang làm?",
        message: "Có thay đổi chưa lưu. Bấm “Lưu tổ hợp” trước nếu muốn giữ.",
        confirmLabel: "Mở tổ hợp mới",
        cancelLabel: "Ở lại",
      }))
    )
      return;
    commit(newSlide(`Tổ hợp ${saved.length + 1}`, scene.width, scene.height));
    setOpenedId(null);
    setLayerId(null);
  };

  const download = async () => {
    const blob = await renderScene(scene, arts);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${scene.name || "to-hop"}.${blob.type === "image/png" ? "png" : "jpg"}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /** The ticked tổ hợp (none ticked = all of them) as a template other products reuse. */
  const saveTemplate = async () => {
    const list = picked.length ? savedScenes.filter((m) => picked.includes(m.id)) : savedScenes;
    if (!list.length) return setError("Chưa có tổ hợp nào để lưu làm template");
    const name = await ctPrompt({
      title: `Lưu template (${list.length} tổ hợp)`,
      message: "Sản phẩm khác cùng loại chọn “Dùng template” — version và thiết kế của nó tự vào đúng các frame.",
      label: "Tên template",
      placeholder: "vd. Ornament acrylic · Christmas",
      confirmLabel: "Lưu template",
    });
    if (!name?.trim()) return;
    try {
      const pack = await ctApi.createPack({
        name: name.trim(),
        notes: "",
        slides: list.map((m) => ({
          ...normalizeSlide(m.meta.scene ?? {}),
          name: m.name,
        })),
        thumbnail_url: list[0].url,
      });
      setPacks((p) => [...p, pack]);
      setPicked([]);
      props.flash(`Đã lưu template “${pack.name}”`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lưu template thất bại");
    }
  };

  const applyTemplate = async (packId: string) => {
    const pack = packs.find((p) => p.id === packId);
    if (!pack) return;
    // The frames take this product's versions (same positions) with this product's design.
    const scenes = pack.slides.map((s) => sceneForProduct(normalizeSlide(s)));
    const lacking = new Map<string, CtAsset>();
    for (const s of scenes) for (const l of s.layers) if (l.type === "frame") for (const m of frameMissing(l, ctx)) lacking.set(m.id, m);
    if (lacking.size) {
      setError(`Template cần vật liệu cho: ${[...lacking.values()].map((m) => m.name).join(", ")}`);
      createMaterial([...lacking.values()]);
      return;
    }
    if (!(await ctConfirm({ title: `Dùng template “${pack.name}”?`, message: `Tạo ${scenes.length} tổ hợp với các version + thiết kế của sản phẩm này.`, confirmLabel: "Tạo" }))) return;
    const created: CtAsset[] = [];
    try {
      for (const [i, s] of scenes.entries()) {
        setBusy(`Render ${i + 1}/${scenes.length}…`);
        const blob = await renderScene(s, await sceneArts(s, ctx));
        created.push(await ctApi.uploadAsset(props.productId, blob, { role: "mockup", name: s.name, meta: { scene: s } }));
      }
      props.flash(`Đã tạo ${created.length} tổ hợp từ template “${pack.name}”`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Render thất bại");
    } finally {
      props.onAdded(created);
      setBusy(null);
    }
  };

  /** AI material of the whole artwork (custom parts outside the main get the material too). */
  const aiMaterial = async (f: CtPackFrameLayer) => {
    const v = frameMain(f, ctx);
    const materialId = renditionOf(assets, v.id)?.meta.material;
    if (!materialId) return setError("Version này chưa có vật liệu — tạo vật liệu cho nó trước (để biết dùng vật liệu nào)");
    setBusy("Lưu artwork phẳng…");
    setError(null);
    try {
      const sel = frameSelection(f, ctx);
      const canvas = await renderComposite({
        main,
        assets,
        regions,
        items,
        selection: sel,
        scale: 1,
        layouts,
      });
      const [artwork] = await props.onSaveComposites([{ blob: await canvasToBlob(canvas, "image/png"), selection: sel }]);
      if (!artwork) throw new Error("Không lưu được artwork");
      setBusy("AI đang tạo vật liệu cho artwork…");
      const runId = await ctApi.studioRun({
        recipe: "artwork_material",
        params: {
          artwork_id: artwork.id,
          material_id: materialId,
          edge_px: 0,
          extra: "",
          model: "",
          name: `${f.name} · vật liệu AI`,
        },
      });
      for (;;) {
        await new Promise((r) => window.setTimeout(r, 2500));
        const st = await ctApi.studioRunStatus(runId);
        if (st.status === "error") throw new Error(st.error ?? "AI lỗi");
        if (st.status === "done") {
          props.onAdded(st.assets);
          patchLayer(f.id, {
            artworkId: artwork.id,
          } as Partial<CtPackFrameLayer>);
          props.flash("Đã có vật liệu AI cho artwork — frame dùng bản này");
          break;
        }
        setBusy(st.status === "queued" ? `AI: đang chờ${st.position ? ` (#${st.position})` : ""}…` : `AI: ${st.node ?? "đang chạy"}…`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "AI thất bại");
    } finally {
      setBusy(null);
    }
  };

  /** Small picture of a layer for the list. */
  const layerThumb = (l: CtPackLayer) => {
    if (l.type === "fill") return <span className="block h-full w-full" style={{ background: fillCss(l) }} />;
    if (l.type === "image") return l.url ? <img src={l.url} alt="" className="h-full w-full object-cover" /> : null;
    if (l.type === "frame") {
      const url = arts[l.id]?.url;
      return url ? <img src={url} alt="" className="h-full w-full object-contain" /> : <Package className="m-auto h-3.5 w-3.5" />;
    }
    if (l.type === "blur") return <Brush className="m-auto h-3.5 w-3.5" />;
    return <Type className="m-auto h-3.5 w-3.5" />;
  };

  const shown = [...scene.layers].reverse();
  const [dragRow, setDragRow] = useState<string | null>(null);
  const [overRow, setOverRow] = useState<string | null>(null);

  return (
    <div className="grid h-full grid-cols-[72px_1fr_320px] overflow-hidden">
      {/* Saved tổ hợp, like the Version column: click = open it, + = a new blank one */}
      <div className="flex min-h-0 flex-col items-center gap-1.5 overflow-y-auto overflow-x-hidden border-r bg-background p-1.5">
        <span className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground">Tổ hợp</span>
        {numbered
          .filter(({ asset: m }) => m.meta.scene)
          .map(({ asset: m, number }) => (
            <CtTooltip key={m.id} label={`#${number} ${m.name} — click để mở lại`} side="right">
              <button
                type="button"
                onClick={() => openSaved(m)}
                className={cx("relative block h-14 w-14 shrink-0 overflow-hidden rounded-md border", m.id === openedId ? "ring-2 ring-sky-500" : "opacity-75 hover:opacity-100")}
                style={CHECKER_STYLE}
              >
                <img src={m.url} alt={m.name} className="h-full w-full object-cover" draggable={false} />
                <span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 text-[9px] font-semibold leading-tight text-white">#{number}</span>
              </button>
            </CtTooltip>
          ))}
        {!openedId && (
          <CtTooltip label={`${scene.name} — đang làm, chưa lưu`} side="right">
            <div className="h-14 w-14 shrink-0 rounded-md border border-dashed bg-muted/40 ring-2 ring-sky-500" />
          </CtTooltip>
        )}
        <CtTooltip label="Tổ hợp mới: mở 1 vùng edit trống (cùng kích thước)" side="right">
          <button
            type="button"
            onClick={() => void newScene()}
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md border border-dashed text-muted-foreground hover:border-sky-500 hover:bg-sky-500/10 hover:text-sky-500"
          >
            <Plus className="h-4 w-4" />
          </button>
        </CtTooltip>
      </div>
      <div className="flex min-h-0 flex-col">
        {/* Toolbar: what can go in — each becomes its own frame */}
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b bg-background px-3 py-2">
          <span className="text-[11px] text-muted-foreground">Kéo vào:</span>
          {versions.map((v) => (
            <CtTooltip key={v.id} label={`${v.name} — kéo vào vùng edit; click để xem mọi vật liệu, đa sắc của nó`}>
              <button
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(VERSION_DRAG, v.id);
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onClick={() => setOpenVersion(openVersion === v.id ? null : v.id)}
                className={cx("relative h-10 w-10 cursor-grab overflow-hidden rounded-md border hover:border-sky-500", openVersion === v.id && "ring-2 ring-sky-500")}
                style={CHECKER_STYLE}
              >
                {thumbs[v.id] ? (
                  <img src={thumbs[v.id]} alt="" className="h-full w-full object-contain" draggable={false} />
                ) : (
                  <Loader2 className="m-auto h-3.5 w-3.5 animate-spin text-muted-foreground" />
                )}
                {!renditionOf(assets, v.id) && <span className="absolute inset-x-0 bottom-0 bg-amber-500 text-[8px] font-medium leading-tight text-white">chưa VL</span>}
              </button>
            </CtTooltip>
          ))}
          <span className="mx-1 h-6 w-px bg-border" />
          <CtTooltip label="Ảnh (nền, tay cầm, sticker…) từ thư viện ảnh tổ hợp — tải lên hoặc tạo bằng AI; mặc định phủ kín khung edit">
            <CtButton size="sm" onClick={addImageFrame} disabled={!!busy}>
              <ImagePlus className="h-3.5 w-3.5" /> Image frame
            </CtButton>
          </CtTooltip>
          <CtTooltip label="Nền màu hoặc gradient, phủ kín khung edit (luôn vào dưới cùng)">
            <CtButton size="sm" onClick={() => addLayer(newLayer("fill", scene.width, scene.height))}>
              <PaintBucket className="h-3.5 w-3.5" /> Nền
            </CtButton>
          </CtTooltip>
          <CtButton size="sm" onClick={() => addLayer(newLayer("text", scene.width, scene.height))}>
            <Type className="h-3.5 w-3.5" /> Chữ
          </CtButton>
          <span className="ml-auto flex items-center gap-0.5">
            <CtTooltip label="Hoàn tác (⌘Z)">
              <CtButton size="icon" variant="ghost" disabled={!past.length} onClick={undo}>
                <Undo2 className="h-4 w-4" />
              </CtButton>
            </CtTooltip>
            <CtTooltip label="Làm lại (⇧⌘Z)">
              <CtButton size="icon" variant="ghost" disabled={!future.length} onClick={redo}>
                <Redo2 className="h-4 w-4" />
              </CtButton>
            </CtTooltip>
            <button className="ml-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setLayerId(null)} title="Kích thước khung edit">
              {scene.width}×{scene.height}
            </button>
          </span>
        </div>

        {openVersion && (
          <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b bg-muted/30 px-3 py-2">
            <span className="shrink-0 text-[11px] text-muted-foreground">{versions.find((v) => v.id === openVersion)?.name || "Version"} — vật liệu, đa sắc:</span>
            {openList.map((pic) => {
              const label = materialLabel(pic, openVersion);
              return (
                <CtTooltip key={pic.id} label={`${pic.name || label} — kéo vào vùng edit (hoặc click)`}>
                  <button
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(VERSION_DRAG, `${openVersion}|${pic.id}`);
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    onClick={() => addFrame(openVersion, null, pic.id)}
                    className="relative h-14 w-14 shrink-0 cursor-grab overflow-hidden rounded-md border hover:border-sky-500"
                    style={CHECKER_STYLE}
                  >
                    {picThumbs[pic.id] ? (
                      <img src={picThumbs[pic.id]} alt="" className="h-full w-full object-contain" draggable={false} />
                    ) : (
                      <Loader2 className="m-auto h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    )}
                    <span className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-0.5 text-[8px] leading-tight text-white">{label}</span>
                  </button>
                </CtTooltip>
              );
            })}
            {!openList.length && <span className="text-[11px] text-muted-foreground">Chưa có vật liệu — tạo trong thư viện.</span>}
          </div>
        )}

        <div className="relative min-h-0 flex-1">
          <EditTools
            tool={tool}
            onTool={setTool}
            layer={layer}
            brushSize={brushSize}
            onBrushSize={setBrushSize}
            strength={blurStrength}
            onStrength={setStrength}
            onFlip={(axis) => layer && layer.type !== "blur" && patchLayer(layer.id, axis === "x" ? { flipX: !layer.flipX } : { flipY: !layer.flipY })}
            onDuplicate={() => layer && duplicate(layer)}
            onUncrop={() => layer && patchLayer(layer.id, { box: cropFull(layer), crop: null })}
            cutMode={cutMode}
            onCutMode={setCutMode}
            canUndo={past.length > 0}
            canRedo={future.length > 0}
            onUndo={undo}
            onRedo={redo}
          />
          <PackCanvas
            className="h-full w-full bg-muted/40"
            slide={scene}
            arts={arts}
            selectedId={layerId}
            onSelect={setLayerId}
            onBox={(id, box, done) => patchLayer(id, { box }, done ? "commit" : "live")}
            tool={tool}
            brushSize={brushSize}
            onCrop={(id, patch, done) => patchLayer(id, patch, done ? "commit" : "live")}
            onStroke={onStroke}
            onCut={onCut}
            dropType={VERSION_DRAG}
            onDropAt={(data, at) => {
              const [id, pictureId] = data.split("|");
              addFrame(id, at, pictureId || null);
            }}
          />
          {scene.layers.length === 0 && (
            <div className="pointer-events-none absolute inset-x-0 top-6 text-center text-xs text-muted-foreground">
              Kéo các version ở trên vào (artwork đã có nội dung thiết kế) — thêm Nền, Image frame, Chữ → Lưu tổ hợp.
            </div>
          )}
        </div>

        {missing.length > 0 && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-t bg-amber-500/10 px-3 py-2 text-xs">
            <span>
              Chưa có vật liệu: <b>{missing.map((m) => m.name || "clipart").join(", ")}</b> — mockup luôn dùng bản vật liệu.
            </span>
            <CtButton size="sm" onClick={() => createMaterial(missing)}>
              <Sparkles className="h-3.5 w-3.5" /> Tạo vật liệu
            </CtButton>
          </div>
        )}

        {/* Saved tổ hợp + templates + AI */}
        <div className="shrink-0 border-t bg-background p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold">Tổ hợp đã lưu ({saved.length})</span>
            <span className="text-[11px] text-muted-foreground">Click để mở lại · tick để chọn</span>
            <span className="ml-auto flex items-center gap-1.5">
              {/* Templates ("Lưu làm template" / "Dùng template") are hidden for now. */}
              <CtTooltip label="Mockup edit: khách chỉnh thiết kế ngay trên tổ hợp này (ảnh sản phẩm thay bằng thiết kế live)">
                <span className="text-xs font-medium">Mockup edit</span>
              </CtTooltip>
              <CtSelect
                className="h-8 w-48"
                value={mockupEdit && saved.some((m) => m.id === mockupEdit.assetId) ? mockupEdit.assetId : "__none"}
                onChange={chooseMockupEdit}
                options={[{ value: "__none", label: "Không dùng" }, ...numbered.filter((n) => n.asset.meta.scene).map((n) => ({ value: n.asset.id, label: `#${n.number} ${n.asset.name}` }))]}
              />
              <CtTooltip label={eye ? "Tắt xem trước" : "Xem trước mockup edit: ảnh sản phẩm bị xoá, chỉ còn vùng custom"}>
                <span>
                  <CtButton size="icon" variant={eye ? "primary" : "ghost"} disabled={!mockupEdit} onClick={() => setEye((v) => !v)}>
                    {eye ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                  </CtButton>
                </span>
              </CtTooltip>
            </span>
          </div>
          {/* p-1: room for the opened one's ring, which the scroller would clip. */}
          <div className="flex gap-2 overflow-x-auto p-1">
            {numbered.map(({ asset: m, number }) => {
              const on = picked.includes(m.id);
              return (
                <div key={m.id} className="group relative shrink-0">
                  <button
                    className={cx("block h-24 w-24 overflow-hidden rounded border", m.id === openedId && "ring-2 ring-sky-500")}
                    style={CHECKER_STYLE}
                    onClick={() => (m.meta.scene ? openSaved(m) : window.open(m.url, "_blank", "noopener"))}
                    title={m.meta.scene ? `${m.name} — click để mở lại` : `${m.name} (ảnh AI)`}
                  >
                    <img src={eye && eyeUrl && mockupEdit?.assetId === m.id ? eyeUrl : m.url} alt="" className="h-full w-full object-cover" loading="lazy" />
                  </button>
                  {mockupEdit?.assetId === m.id && <span className="absolute right-1 bottom-5 rounded bg-orange-500 px-1 text-[9px] font-semibold text-white">EDIT</span>}
                  <span className="absolute bottom-5 left-1 rounded bg-black/70 px-1 text-[10px] font-semibold text-white">#{number}</span>
                  <button
                    className={cx("absolute right-1 top-1 rounded-full border bg-background/90 p-0.5", on ? "border-sky-500 bg-sky-500 text-white" : "text-transparent hover:text-muted-foreground")}
                    onClick={() => setPicked((p) => (on ? p.filter((x) => x !== m.id) : [...p, m.id]))}
                    title="Chọn"
                  >
                    <Check className="h-3 w-3" />
                  </button>
                  <button
                    className="absolute left-1 top-1 hidden rounded bg-black/60 p-0.5 text-white group-hover:block"
                    onClick={async () => {
                      if (
                        await ctConfirm({
                          title: `Xoá “${m.name}”?`,
                          tone: "danger",
                          confirmLabel: "Xoá",
                        })
                      )
                        await props.onDelete(m);
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                  <p className="w-24 truncate text-[10px] text-muted-foreground">{m.name}</p>
                </div>
              );
            })}
            {saved.length === 0 && <p className="py-6 text-xs text-muted-foreground">Chưa có — làm xong vùng edit thì bấm “Lưu tổ hợp”.</p>}
          </div>
          {eye && eyeUrl && (
            <div className="mt-2 flex items-start gap-3 rounded-md border p-2">
              <img src={eyeUrl} alt="" className="max-h-64 rounded border" style={CHECKER_STYLE} />
              <p className="text-[11px] leading-snug text-muted-foreground">
                Mockup edit trên store: ảnh sản phẩm trong tổ hợp được xoá, vùng “Custom” là chỗ thiết kế live của khách (đổi option, nhập chữ, upload ảnh là thấy ngay). Pack nhiều thiết kế: mỗi khung hiện 1 thiết kế.
              </p>
            </div>
          )}
          {saved.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-dashed px-3 py-2">
              <span className="text-xs text-muted-foreground">Chưa hài lòng về chất lượng?</span>
              <CtButton size="sm" variant="primary" onClick={() => setEnhanceOpen(true)}>
                <Sparkles className="h-3.5 w-3.5" /> Tăng chất lượng với AI tạo ảnh
              </CtButton>
              <span className="text-[11px] text-muted-foreground">AI làm lại từng tổ hợp thành ảnh thật, lấy các tổ hợp khác (#1, #2…) làm tham khảo.</span>
            </div>
          )}
        </div>
      </div>

      {/* Right: the frames, then the selected one's settings */}
      <div className="flex min-h-0 flex-col border-l">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold">Layers</span>
          <span className="text-[11px] text-muted-foreground">kéo để đổi thứ tự</span>
        </div>
        <div className="max-h-[40%] shrink-0 overflow-y-auto border-b">
          {shown.map((l) => (
            <div
              key={l.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(LAYER_DRAG, l.id);
                e.dataTransfer.effectAllowed = "move";
                setDragRow(l.id);
              }}
              onDragEnd={() => {
                setDragRow(null);
                setOverRow(null);
              }}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(LAYER_DRAG)) return;
                e.preventDefault();
                setOverRow(l.id);
              }}
              onDrop={(e) => {
                const id = e.dataTransfer.getData(LAYER_DRAG);
                setDragRow(null);
                setOverRow(null);
                if (id) restack(id, l.id);
              }}
              onClick={() => setLayerId(l.id)}
              className={cx(
                "group flex cursor-pointer items-center gap-1.5 border-b px-2 py-1.5 text-xs last:border-b-0",
                l.id === layerId ? "bg-sky-500/15" : "hover:bg-accent",
                overRow === l.id && dragRow !== l.id && "border-t-2 border-t-sky-500",
                dragRow === l.id && "opacity-40",
                l.hidden && "text-muted-foreground",
              )}
            >
              <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-muted-foreground" />
              <span className="flex h-7 w-7 shrink-0 overflow-hidden rounded border" style={CHECKER_STYLE}>
                {layerThumb(l)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{l.name || LAYER_LABEL[l.type]}</span>
                <span className="block text-[10px] text-muted-foreground">{LAYER_LABEL[l.type]}</span>
              </span>
              <button
                className="rounded p-1 hover:bg-background"
                title={l.hidden ? "Hiện" : "Ẩn"}
                onClick={(e) => {
                  e.stopPropagation();
                  patchLayer(l.id, { hidden: !l.hidden });
                }}
              >
                {l.hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
              <button
                className="rounded p-1 text-destructive hover:bg-background"
                title="Xoá frame"
                onClick={(e) => {
                  e.stopPropagation();
                  removeLayer(l.id);
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          {shown.length === 0 && <p className="px-3 py-4 text-xs text-muted-foreground">Chưa có frame nào.</p>}
          {/* The edit frame itself: always the bottom row, fixed — not draggable, never hidden or deleted. */}
          <div
            onClick={() => setLayerId(null)}
            className={cx("flex cursor-pointer items-center gap-1.5 border-t px-2 py-1.5 text-xs", layerId === null ? "bg-sky-500/15" : "hover:bg-accent")}
          >
            <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded border" style={CHECKER_STYLE}>
              <Frame className="h-3.5 w-3.5 text-muted-foreground" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate">Khung edit</span>
              <span className="block text-[10px] text-muted-foreground">
                {scene.width}×{scene.height} · khung gốc
              </span>
            </span>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          {layer ? (
            <LayerSettings
              key={layer.id}
              layer={layer}
              scene={scene}
              versions={versions}
              assets={assets}
              busy={!!busy}
              onPatch={(patch, how) => patchLayer(layer.id, patch, how)}
              onCommit={() => commit(histRef.current.scene)}
              onReplaceImage={replaceImage}
              onFrameToImage={(l) => void frameToImage(l)}
              onFit={(l, fit) => void setFit(l, fit)}
              materials={materials}
              onAiMaterial={(f) => void aiMaterial(f)}
            />
          ) : (
            <SceneSettings scene={scene} onRename={(name) => commit({ ...scene, name })} onResize={(w, h) => commit(resizeSlide(scene, w, h))} />
          )}
        </div>

        <div className="space-y-2 border-t p-3">
          <CtButton size="sm" className="w-full justify-center" onClick={() => void download()} disabled={!scene.layers.length}>
            <Download className="h-3.5 w-3.5" /> Tải ảnh
          </CtButton>
          <CtButton variant="primary" className="w-full justify-center" onClick={() => void saveScene()} disabled={busy !== null || !scene.layers.length || missing.length > 0}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Lưu tổ hợp
          </CtButton>
          {busy && <p className="text-[11px] text-muted-foreground">{busy}</p>}
          {error && <p className="text-[11px] text-destructive">{error}</p>}
        </div>
      </div>

      {/* Mounted per opening, so it starts fresh each time. */}
      {libraryFor && <PackImageLibrary open onOpenChange={(o) => !o && setLibraryFor(null)} onPick={usePhoto} aspect={nearestAspect(scene.width, scene.height)} />}
      <EnhanceDialog
        open={enhanceOpen}
        onOpenChange={setEnhanceOpen}
        productId={props.productId}
        items={numbered}
        initial={picked.length ? picked : savedScenes.map((m) => m.id)}
        onAdded={props.onAdded}
        flash={props.flash}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings column
// ---------------------------------------------------------------------------

function SceneSettings({ scene, onRename, onResize }: { scene: CtPackSlide; onRename: (name: string) => void; onResize: (w: number, h: number) => void }) {
  return (
    <>
      <p className="text-xs font-semibold">Khung edit</p>
      <CtField label="Tên tổ hợp">
        <CtInput key={scene.id} defaultValue={scene.name} onBlur={(e) => e.target.value.trim() && e.target.value !== scene.name && onRename(e.target.value.trim())} />
      </CtField>
      <div className="grid grid-cols-2 gap-2">
        <CtField label="Rộng (px)">
          <CtNumber value={scene.width} min={64} max={8192} onChange={(w) => w >= 64 && onResize(w, scene.height)} />
        </CtField>
        <CtField label="Cao (px)">
          <CtNumber value={scene.height} min={64} max={8192} onChange={(h) => h >= 64 && onResize(scene.width, h)} />
        </CtField>
      </div>
      <div className="flex flex-wrap gap-1">
        {SIZE_PRESETS.map((p) => (
          <CtButton key={p.label} size="sm" variant={scene.width === p.w && scene.height === p.h ? "primary" : "outline"} onClick={() => onResize(p.w, p.h)}>
            {p.label}
          </CtButton>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">Chọn 1 frame (trong vùng edit hoặc danh sách Layers) để chỉnh kích thước, vị trí và thông số của nó.</p>
    </>
  );
}

interface LayerSettingsProps {
  layer: CtPackLayer;
  scene: CtPackSlide;
  versions: CtAsset[];
  assets: CtAsset[];
  busy: boolean;
  onPatch: (patch: Partial<CtPackLayer>, how?: "commit" | "live") => void;
  /** End of a live gesture (slider, colour picker). */
  onCommit: () => void;
  onReplaceImage: (l: CtPackImageLayer) => void;
  onFrameToImage: (l: CtPackImageLayer) => void;
  onFit: (l: CtPackImageLayer, fit: CtPackImageLayer["fit"]) => void;
  /** Material pictures of each version, by version id. */
  materials: Record<string, CtAsset[]>;
  onAiMaterial: (f: CtPackFrameLayer) => void;
}

function LayerSettings(p: LayerSettingsProps) {
  const { layer, scene } = p;
  const b = layer.box;
  const setBox = (patch: Partial<CtPackBox>) => p.onPatch({ box: { ...b, ...patch } });
  if (layer.type === "blur") return <BlurSettings layer={layer} onPatch={p.onPatch} onCommit={p.onCommit} />;
  return (
    <>
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold">{LAYER_LABEL[layer.type]}</p>
        <CtTooltip label="Phủ kín khung edit">
          <CtButton
            size="sm"
            variant="ghost"
            onClick={() =>
              setBox({
                x: 0,
                y: 0,
                w: scene.width,
                h: scene.height,
                rotation: 0,
              })
            }
          >
            <Maximize className="h-3.5 w-3.5" /> Vừa khung
          </CtButton>
        </CtTooltip>
      </div>
      <CtField label="Tên">
        <CtInput key={layer.id} defaultValue={layer.name} onBlur={(e) => e.target.value !== layer.name && p.onPatch({ name: e.target.value })} />
      </CtField>
      <div className="grid grid-cols-2 gap-2">
        <CtField label="Rộng">
          <CtNumber value={Math.round(b.w)} min={1} onChange={(w) => w >= 1 && setBox({ w })} />
        </CtField>
        <CtField label="Cao">
          <CtNumber value={Math.round(b.h)} min={1} onChange={(h) => h >= 1 && setBox({ h })} />
        </CtField>
        <CtField label="X">
          <CtNumber value={Math.round(b.x)} onChange={(x) => setBox({ x })} />
        </CtField>
        <CtField label="Y">
          <CtNumber value={Math.round(b.y)} onChange={(y) => setBox({ y })} />
        </CtField>
        <CtField label="Xoay (°)">
          <CtNumber value={b.rotation} min={-360} max={360} onChange={(rotation) => setBox({ rotation })} />
        </CtField>
        <CtField label="Độ mờ (%)">
          <CtNumber value={Math.round(layer.opacity * 100)} min={0} max={100} onChange={(v) => p.onPatch({ opacity: Math.min(1, Math.max(0, v / 100)) })} />
        </CtField>
      </div>

      {layer.type === "fill" && <FillSettings layer={layer} onPatch={p.onPatch} onCommit={p.onCommit} />}
      {layer.type === "image" && (
        <>
          <div className="flex gap-1.5">
            <CtButton size="sm" className="flex-1 justify-center" onClick={() => p.onReplaceImage(layer)} disabled={p.busy}>
              <ImagePlus className="h-3.5 w-3.5" /> Đổi ảnh
            </CtButton>
            <CtTooltip label="Khung edit theo tỉ lệ ảnh này, ảnh phủ kín khung">
              <CtButton size="sm" className="flex-1 justify-center" onClick={() => p.onFrameToImage(layer)}>
                Khung theo ảnh
              </CtButton>
            </CtTooltip>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <CtField label="Ảnh trong frame">
              <CtSelect<CtPackImageLayer["fit"]>
                value={layer.fit}
                onChange={(fit) => p.onFit(layer, fit)}
                options={[
                  { value: "cover", label: "Phủ kín (cắt)" },
                  { value: "contain", label: "Vừa (không cắt)" },
                  { value: "original", label: "Tỉ lệ gốc của ảnh" },
                  // Old frames keep showing their stretch until changed.
                  ...(layer.fit === "stretch" ? [{ value: "stretch" as const, label: "Kéo giãn" }] : []),
                ]}
              />
            </CtField>
            <CtField label="Hoà trộn">
              <CtSelect value={layer.blend} onChange={(blend) => p.onPatch({ blend })} options={BLENDS.map((x) => ({ value: x, label: x }))} />
            </CtField>
          </div>
          <CtField label={`Làm nhoè (blur) — ${layer.blur}px`}>
            <input
              type="range"
              className="w-full accent-sky-500"
              min={0}
              max={100}
              value={layer.blur}
              onChange={(e) => p.onPatch({ blur: Number(e.target.value) }, "live")}
              onPointerUp={p.onCommit}
              onKeyUp={p.onCommit}
            />
          </CtField>
          <CtField label="Tỉ lệ frame">
            <div className="flex flex-wrap gap-1">
              {SIZE_PRESETS.map((r) => {
                const on = layer.fit !== "original" && Math.abs(b.w / b.h - r.w / r.h) < 0.01;
                return (
                  <CtButton
                    key={r.label}
                    size="sm"
                    variant={on ? "primary" : "outline"}
                    // A preset shape is no longer the photo's own: it fills it (cover).
                    onClick={() =>
                      p.onPatch({
                        box: boxToRatio(b, r.w / r.h),
                        ...(layer.fit === "original" ? { fit: "cover" as const } : {}),
                      })
                    }
                  >
                    {r.label}
                  </CtButton>
                );
              })}
            </div>
          </CtField>
        </>
      )}
      {layer.type === "text" && <TextSettings layer={layer} onPatch={p.onPatch} onCommit={p.onCommit} />}
      {layer.type === "frame" && (
        <>
          {p.versions.length > 1 && (
            <CtField label="Version">
              <CtSelect
                value={String(Math.min(layer.mainIndex, p.versions.length - 1))}
                onChange={(v) =>
                  p.onPatch({
                    mainIndex: Number(v),
                    artworkId: null,
                    pictureId: null,
                    name: p.versions[Number(v)]?.name || layer.name,
                  } as Partial<CtPackFrameLayer>)
                }
                options={p.versions.map((v, i) => ({
                  value: String(i),
                  label: v.name || `Version ${i + 1}`,
                }))}
              />
            </CtField>
          )}
          <FramePicture layer={layer} versions={p.versions} materials={p.materials} onPatch={p.onPatch} />
          <CtCheckbox checked={layer.shadow.enabled} onChange={(enabled) => p.onPatch({ shadow: { ...layer.shadow, enabled } })} label="Đổ bóng" />
          {layer.shadow.enabled && (
            <div className="grid grid-cols-3 gap-2">
              <CtField label="Mờ bóng">
                <CtNumber value={layer.shadow.blur} min={0} max={400} onChange={(blur) => p.onPatch({ shadow: { ...layer.shadow, blur } })} />
              </CtField>
              <CtField label="Lệch Y">
                <CtNumber value={layer.shadow.dy} min={-400} max={400} onChange={(dy) => p.onPatch({ shadow: { ...layer.shadow, dy } })} />
              </CtField>
              <CtField label="Đậm (%)">
                <CtNumber
                  value={Math.round(layer.shadow.opacity * 100)}
                  min={0}
                  max={100}
                  onChange={(v) =>
                    p.onPatch({
                      shadow: {
                        ...layer.shadow,
                        opacity: Math.min(1, Math.max(0, v / 100)),
                      },
                    })
                  }
                />
              </CtField>
            </div>
          )}
          <CtField label="Dây treo">
            <CtSelect
              value={layer.hanger}
              onChange={(hanger) => p.onPatch({ hanger })}
              options={[
                { value: "auto", label: "Theo vật liệu" },
                { value: "on", label: "Luôn có" },
                { value: "off", label: "Không" },
              ]}
            />
          </CtField>
          {layer.hanger !== "off" && (
            <div className="grid grid-cols-2 gap-2">
              <CtField label="Dài dây">
                <CtNumber value={Math.round(layer.cordLength)} min={0} onChange={(cordLength) => p.onPatch({ cordLength })} />
              </CtField>
              <CtField label="Nghiêng (°)">
                <CtNumber value={layer.cordAngle} min={-80} max={80} onChange={(cordAngle) => p.onPatch({ cordAngle })} />
              </CtField>
            </div>
          )}
          {layer.artworkId && renditionOf(p.assets, layer.artworkId) ? (
            <CtButton size="sm" variant="ghost" className="w-full justify-center" onClick={() => p.onPatch({ artworkId: null } as Partial<CtPackFrameLayer>)}>
              Đang dùng vật liệu AI · bỏ
            </CtButton>
          ) : (
            <CtTooltip label="Khi phần custom vượt ra ngoài main: AI làm vật liệu cho cả artwork để viền / độ dày ôm đúng hình">
              <span className="block">
                <CtButton size="sm" className="w-full justify-center" onClick={() => p.onAiMaterial(layer)} disabled={p.busy}>
                  <Sparkles className="h-3.5 w-3.5" /> Vật liệu AI cho artwork
                </CtButton>
              </span>
            </CtTooltip>
          )}
          <p className="text-[11px] text-muted-foreground">Nội dung (chữ, ảnh, option) lấy từ tab Thiết kế — sửa ở đó, frame tự đổi theo.</p>
        </>
      )}
    </>
  );
}

function FillSettings({ layer, onPatch, onCommit }: { layer: CtPackFillLayer; onPatch: LayerSettingsProps["onPatch"]; onCommit: () => void }) {
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? CT_GRADIENTS.filter((g) => g.name.toLowerCase().includes(s)) : CT_GRADIENTS;
  }, [q]);
  const g = layer.gradient;
  return (
    <>
      <div className="flex gap-1">
        <CtButton size="sm" className="flex-1 justify-center" variant={g ? "outline" : "primary"} onClick={() => g && onPatch({ gradient: null })}>
          Màu thường
        </CtButton>
        <CtButton
          size="sm"
          className="flex-1 justify-center"
          variant={g ? "primary" : "outline"}
          onClick={() =>
            !g &&
            onPatch({
              gradient: {
                name: CT_GRADIENTS[0].name,
                colors: CT_GRADIENTS[0].colors,
                angle: 90,
              },
            })
          }
        >
          Gradient
        </CtButton>
      </div>
      {!g ? (
        <CtField label="Màu">
          <input
            type="color"
            className="h-9 w-full cursor-pointer rounded border"
            value={/^#[0-9a-f]{6}$/i.test(layer.color) ? layer.color : "#ffffff"}
            onChange={(e) => onPatch({ color: e.target.value }, "live")}
            onBlur={onCommit}
          />
        </CtField>
      ) : (
        <>
          <div className="h-10 w-full rounded border" style={{ background: gradientCss(g) }} title={g.name} />
          <div className="grid grid-cols-[1fr_auto] items-end gap-2">
            <CtField label={`Gradient · ${g.name || "tuỳ chỉnh"}`}>
              <CtInput placeholder={`Tìm trong ${CT_GRADIENTS.length} gradient…`} value={q} onChange={(e) => setQ(e.target.value)} />
            </CtField>
            <CtField label="Góc (°)">
              <CtNumber className="w-20" value={g.angle} min={-360} max={360} onChange={(angle) => onPatch({ gradient: { ...g, angle } })} />
            </CtField>
          </div>
          <div className="grid max-h-56 grid-cols-6 gap-1 overflow-y-auto pr-1">
            {list.map((x) => (
              <button
                key={x.name}
                title={x.name}
                className={cx("aspect-square rounded border", x.name === g.name && "ring-2 ring-sky-500")}
                style={{
                  background: gradientCss({ colors: x.colors, angle: g.angle }),
                }}
                onClick={() =>
                  onPatch({
                    gradient: {
                      name: x.name,
                      colors: x.colors,
                      angle: g.angle,
                    },
                  })
                }
              />
            ))}
            {list.length === 0 && <p className="col-span-6 text-[11px] text-muted-foreground">Không có gradient nào khớp.</p>}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {g.colors.map((c, i) => (
              <input
                key={i}
                type="color"
                className="h-7 w-8 cursor-pointer rounded border"
                value={/^#[0-9a-f]{6}$/i.test(c) ? c : "#ffffff"}
                onChange={(e) =>
                  onPatch(
                    {
                      gradient: {
                        ...g,
                        name: "",
                        colors: g.colors.map((x, j) => (j === i ? e.target.value : x)),
                      },
                    },
                    "live",
                  )
                }
                onBlur={onCommit}
              />
            ))}
          </div>
        </>
      )}
    </>
  );
}

/** Cọ làm mờ layer: how strong, and its strokes. */
function BlurSettings({ layer, onPatch, onCommit }: { layer: CtPackBlurLayer; onPatch: LayerSettingsProps["onPatch"]; onCommit: () => void }) {
  const painted = layer.strokes.filter((st) => !st.erase).length;
  return (
    <>
      <p className="text-xs font-semibold">Cọ làm mờ</p>
      <CtField label="Tên">
        <CtInput key={layer.id} defaultValue={layer.name} onBlur={(e) => e.target.value !== layer.name && onPatch({ name: e.target.value })} />
      </CtField>
      <CtField label={`Độ nhoè — ${layer.strength}px`}>
        <input
          type="range"
          className="w-full accent-sky-500"
          min={1}
          max={80}
          value={layer.strength}
          onChange={(e) => onPatch({ strength: Number(e.target.value) } as Partial<CtPackBlurLayer>, "live")}
          onPointerUp={onCommit}
          onKeyUp={onCommit}
        />
      </CtField>
      <CtField label="Độ đậm (%)">
        <CtNumber value={Math.round(layer.opacity * 100)} min={0} max={100} onChange={(v) => onPatch({ opacity: Math.min(1, Math.max(0, v / 100)) })} />
      </CtField>
      <p className="text-[11px] text-muted-foreground">
        {painted} nét cọ
        {layer.strokes.length > painted ? ` · ${layer.strokes.length - painted} nét tẩy` : ""} — làm mờ mọi thứ nằm dưới layer này (đã gộp).
      </p>
      <div className="flex gap-1.5">
        <CtButton
          size="sm"
          className="flex-1 justify-center"
          disabled={!layer.strokes.length}
          onClick={() =>
            onPatch({
              strokes: layer.strokes.slice(0, -1),
            } as Partial<CtPackBlurLayer>)
          }
        >
          Bỏ nét cuối
        </CtButton>
        <CtButton size="sm" className="flex-1 justify-center" disabled={!layer.strokes.length} onClick={() => onPatch({ strokes: [] } as Partial<CtPackBlurLayer>)}>
          Xoá hết nét
        </CtButton>
      </div>
    </>
  );
}

/** What a lasso does on release. */
type CutMode = "remove" | "keep" | "layer";
const CUT_MODES: [CutMode, string][] = [
  ["remove", "Bỏ vùng khoanh"],
  ["keep", "Giữ vùng khoanh"],
  ["layer", "Tạo thành layer mới"],
];

interface EditToolsProps {
  tool: CtPackTool;
  onTool: (t: CtPackTool) => void;
  /** The active frame. */
  layer: CtPackLayer | null;
  brushSize: number;
  onBrushSize: (v: number) => void;
  strength: number;
  onStrength: (v: number, how: "commit" | "live") => void;
  onFlip: (axis: "x" | "y") => void;
  onDuplicate: () => void;
  onUncrop: () => void;
  cutMode: CutMode;
  onCutMode: (mode: CutMode) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

const TOOLS: Array<{ id: CtPackTool; icon: typeof Crop; label: string }> = [
  { id: "select", icon: MousePointer2, label: "Chọn / di chuyển (V)" },
  {
    id: "hand",
    icon: Hand,
    label: "Kéo vùng edit (H, hoặc giữ Space) — ⌘ + cuộn / pinch để zoom",
  },
  {
    id: "crop",
    icon: Crop,
    label: "Crop frame đang chọn (C) — kéo cạnh / góc, kéo bên trong để dời khung crop; Enter / Esc xong",
  },
  {
    id: "cut",
    icon: Lasso,
    label: "Cắt (L) — khoanh một vùng trên frame đang chọn, thả tay là cắt",
  },
  {
    id: "brush",
    icon: Brush,
    label: "Cọ làm mờ (B) — làm mờ mọi thứ bên dưới; [ ] đổi cỡ cọ",
  },
  { id: "erase", icon: Eraser, label: "Tẩy vùng mờ (E)" },
];

/** The vertical toolbar on the edit frame + the active tool's options beside it. */
function EditTools(p: EditToolsProps) {
  const l = p.layer && p.layer.type !== "blur" ? p.layer : null;
  const btn = (on: boolean) =>
    cx("flex h-8 w-8 items-center justify-center rounded-md", on ? "bg-sky-500 text-white" : "hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent");
  const tip = (label: string, node: React.ReactElement) => (
    <CtTooltip key={label} label={label} side="right">
      {node}
    </CtTooltip>
  );
  return (
    <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-start gap-2">
      <div className="pointer-events-auto flex flex-col gap-0.5 rounded-lg border bg-background/95 p-1 shadow-md">
        {TOOLS.map((t) =>
          tip(
            t.label,
            <button className={btn(p.tool === t.id)} onClick={() => p.onTool(t.id)}>
              <t.icon className="h-4 w-4" />
            </button>,
          ),
        )}
        <span className="mx-1 my-0.5 h-px bg-border" />
        {tip(
          "Lật ngang frame đang chọn",
          <button className={btn(!!l?.flipX)} disabled={!l} onClick={() => p.onFlip("x")}>
            <FlipHorizontal2 className="h-4 w-4" />
          </button>,
        )}
        {tip(
          "Lật dọc frame đang chọn",
          <button className={btn(!!l?.flipY)} disabled={!l} onClick={() => p.onFlip("y")}>
            <FlipVertical2 className="h-4 w-4" />
          </button>,
        )}
        {tip(
          "Nhân bản frame (⌘D)",
          <button className={btn(false)} disabled={!l} onClick={p.onDuplicate}>
            <Copy className="h-4 w-4" />
          </button>,
        )}
        <span className="mx-1 my-0.5 h-px bg-border" />
        {tip(
          "Hoàn tác (⌘Z)",
          <button className={btn(false)} disabled={!p.canUndo} onClick={p.onUndo}>
            <Undo2 className="h-4 w-4" />
          </button>,
        )}
        {tip(
          "Làm lại (⇧⌘Z)",
          <button className={btn(false)} disabled={!p.canRedo} onClick={p.onRedo}>
            <Redo2 className="h-4 w-4" />
          </button>,
        )}
      </div>

      {(p.tool === "brush" || p.tool === "erase") && (
        <div className="pointer-events-auto w-48 space-y-2 rounded-lg border bg-background/95 p-2 text-[11px] shadow-md">
          <label className="block">
            Cỡ cọ — {p.brushSize}px
            <input type="range" className="w-full accent-sky-500" min={4} max={1000} value={p.brushSize} onChange={(e) => p.onBrushSize(Number(e.target.value))} />
          </label>
          {p.tool === "brush" && (
            <label className="block">
              Độ nhoè — {p.strength}px
              <input
                type="range"
                className="w-full accent-sky-500"
                min={1}
                max={80}
                value={p.strength}
                onChange={(e) => p.onStrength(Number(e.target.value), "live")}
                onPointerUp={(e) => p.onStrength(Number(e.currentTarget.value), "commit")}
              />
            </label>
          )}
          <p className="text-muted-foreground">{p.tool === "brush" ? "Cọ lên ảnh: mọi layer bên dưới được gộp lại rồi làm mờ chỗ cọ." : "Cọ để bỏ mờ ở chỗ đã cọ."}</p>
        </div>
      )}
      {p.tool === "cut" && (
        <div className="pointer-events-auto w-48 space-y-2 rounded-lg border bg-background/95 p-2 text-[11px] shadow-md">
          <p>{l ? <>Chấm từng điểm quanh vùng trên “{l.name}”; bấm lại điểm đầu, double-click hoặc Enter để cắt. ⌫ bỏ điểm cuối, Esc bỏ vùng.</> : "Chọn một frame rồi chấm điểm quanh vùng cần cắt."}</p>
          <div className="grid gap-1">
            {CUT_MODES.map(([mode, label]) => (
              <CtButton key={mode} size="sm" variant={p.cutMode === mode ? "primary" : "outline"} className="justify-center" onClick={() => p.onCutMode(mode)}>
                {label}
              </CtButton>
            ))}
          </div>
          <CtButton size="sm" variant="primary" className="w-full justify-center" onClick={() => p.onTool("select")}>
            <Check className="h-3.5 w-3.5" /> Xong (Enter)
          </CtButton>
        </div>
      )}
      {p.tool === "crop" && (
        <div className="pointer-events-auto w-48 space-y-2 rounded-lg border bg-background/95 p-2 text-[11px] shadow-md">
          {l && canCrop(l) ? (
            <>
              <p>Kéo cạnh / góc để crop “{l.name}”. Kéo bên trong để dời khung crop tới chỗ muốn; phần mờ là phần bị crop.</p>
              <CtButton size="sm" className="w-full justify-center" disabled={!l.crop} onClick={p.onUncrop}>
                Bỏ crop
              </CtButton>
            </>
          ) : (
            <p className="text-muted-foreground">Chọn một Image frame hoặc frame sản phẩm để crop.</p>
          )}
          <CtButton size="sm" variant="primary" className="w-full justify-center" onClick={() => p.onTool("select")}>
            <Check className="h-3.5 w-3.5" /> Xong (Enter)
          </CtButton>
        </div>
      )}
    </div>
  );
}

function TextSettings({ layer, onPatch, onCommit }: { layer: CtPackTextLayer; onPatch: LayerSettingsProps["onPatch"]; onCommit: () => void }) {
  const font = CT_FONTS.find((f) => f.family === layer.fontFamily);
  const weights = font?.weights ?? [400, 600, 700];
  return (
    <>
      <CtField label="Nội dung">
        <CtTextarea rows={2} value={layer.text} onChange={(e) => onPatch({ text: e.target.value }, "live")} onBlur={onCommit} />
      </CtField>
      <div className="grid grid-cols-2 gap-2">
        <CtField label="Font">
          <CtSelect
            value={layer.fontFamily}
            onChange={(fontFamily) => {
              const w = CT_FONTS.find((f) => f.family === fontFamily)?.weights ?? [];
              onPatch({
                fontFamily,
                fontWeight: w.includes(layer.fontWeight) ? layer.fontWeight : (w[w.length - 1] ?? 400),
              });
            }}
            options={CT_FONTS.map((f) => ({ value: f.family, label: f.label }))}
          />
        </CtField>
        <CtField label="Độ đậm">
          <CtSelect
            value={String(layer.fontWeight)}
            onChange={(v) => onPatch({ fontWeight: Number(v) })}
            options={weights.map((w) => ({
              value: String(w),
              label: String(w),
            }))}
          />
        </CtField>
        <CtField label="Cỡ chữ">
          <CtNumber value={Math.round(layer.fontSize)} min={6} max={1000} onChange={(fontSize) => fontSize >= 6 && onPatch({ fontSize })} />
        </CtField>
        <CtField label="Màu">
          <input
            type="color"
            className="h-8 w-full cursor-pointer rounded border"
            value={/^#[0-9a-f]{6}$/i.test(layer.color) ? layer.color : "#ffffff"}
            onChange={(e) => onPatch({ color: e.target.value }, "live")}
            onBlur={onCommit}
          />
        </CtField>
      </div>
      <div className="flex items-center gap-1">
        {(
          [
            ["left", AlignLeft],
            ["center", AlignCenter],
            ["right", AlignRight],
          ] as const
        ).map(([align, Icon]) => (
          <CtButton key={align} size="icon" variant={layer.align === align ? "primary" : "ghost"} onClick={() => onPatch({ align })}>
            <Icon className="h-3.5 w-3.5" />
          </CtButton>
        ))}
        <span className="ml-2">
          <CtCheckbox checked={layer.shadow} onChange={(shadow) => onPatch({ shadow })} label="Bóng chữ" />
        </span>
      </div>
    </>
  );
}
