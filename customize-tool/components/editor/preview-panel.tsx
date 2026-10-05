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
 *   centre   the edit frame: move / resize / rotate the selected frame.
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
  AlignLeft,
  AlignRight,
  Check,
  Download,
  Eye,
  EyeOff,
  GripVertical,
  ImagePlus,
  Layers,
  Loader2,
  Maximize,
  Package,
  PaintBucket,
  Redo2,
  Save,
  Sparkles,
  Trash2,
  Type,
  Undo2,
} from "lucide-react";
import { CT_FONTS } from "../../config";
import type {
  CtAsset,
  CtMainLayout,
  CtMockupPack,
  CtPackBlend,
  CtPackBox,
  CtPackFillLayer,
  CtPackFrameLayer,
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
  frameMissing,
  frameSelection,
  gradientCss,
  LAYER_LABEL,
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
import { PackCanvas } from "../mockup/pack-canvas";
import { pickImageFile } from "./scene-dialog";
import { EnhanceDialog, type EnhanceItem } from "./enhance-dialog";

/** dataTransfer type of a main version dragged from the strip. */
const VERSION_DRAG = "application/x-ct-version";
/** dataTransfer type of a layer row being restacked. */
const LAYER_DRAG = "application/x-ct-layer";
/** Longest side a saved tổ hợp is rendered at. */
const SAVE_MAX_SIDE = 3000;

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
  flash: (msg: string) => void;
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
  const [scene, setSceneState] = useState<CtPackSlide>(() => draft?.scene ?? newSlide("Tổ hợp 1"));
  const [openedId, setOpenedId] = useState<string | null>(() => draft?.openedId ?? null);
  const [past, setPast] = useState<CtPackSlide[]>([]);
  const [future, setFuture] = useState<CtPackSlide[]>([]);
  const [layerId, setLayerId] = useState<string | null>(null);
  const dragBase = useRef<CtPackSlide | null>(null);
  useEffect(() => {
    drafts.set(props.productId, { scene, openedId });
  }, [props.productId, scene, openedId]);

  const commit = (next: CtPackSlide) => {
    setPast((p) => [...p.slice(-60), dragBase.current ?? scene]);
    setFuture([]);
    dragBase.current = null;
    setSceneState(next);
  };
  const live = (next: CtPackSlide) => {
    if (!dragBase.current) dragBase.current = scene;
    setSceneState(next);
  };
  const undo = () => {
    const prev = past[past.length - 1];
    if (!prev) return;
    setPast(past.slice(0, -1));
    setFuture([scene, ...future]);
    setSceneState(prev);
  };
  const redo = () => {
    const next = future[0];
    if (!next) return;
    setPast([...past, scene]);
    setFuture(future.slice(1));
    setSceneState(next);
  };
  const keys = useRef({ undo, redo, remove: () => {} });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable || t.closest('[role="dialog"]'))) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) keys.current.redo();
        else keys.current.undo();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        keys.current.remove();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const layer = scene.layers.find((l) => l.id === layerId) ?? null;
  const patchLayer = (id: string, patch: Partial<CtPackLayer>, how: "commit" | "live" = "commit") => {
    const next = { ...scene, layers: scene.layers.map((l) => (l.id === id ? ({ ...l, ...patch } as CtPackLayer) : l)) };
    if (how === "live") live(next);
    else commit(next);
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
    commit({ ...scene, layers: l.type === "fill" ? [l, ...scene.layers] : [...scene.layers, l] });
    setLayerId(l.id);
  };
  useEffect(() => {
    keys.current = { undo, redo, remove: () => layerId && removeLayer(layerId) };
  });

  // ---------------------------------------------------------------- frames
  const ctx = useMemo<CtFrameContext>(
    () => ({ samples, main, mains: versions, assets, regions, items, layouts, presets }),
    [samples, main, versions, assets, regions, items, layouts, presets],
  );
  const frames = scene.layers.filter((l): l is CtPackFrameLayer => l.type === "frame");
  /** Only what changes a frame's picture — not its box. */
  const framesKey = JSON.stringify(frames.map((f) => [f.id, f.mainIndex, f.artworkId, f.hidden]));
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

  const addFrame = (versionId: string, at: { x: number; y: number } | null) => {
    const index = Math.max(0, versions.findIndex((v) => v.id === versionId));
    const v = versions[index] ?? main;
    const f = newFrame(scene, index, at, main.width / main.height);
    f.name = v.name || `Version ${index + 1}`;
    addLayer(f);
  };

  // ---------------------------------------------------------------- image frames, background, text
  const upload = async (): Promise<{ url: string; w: number; h: number } | null> => {
    const file = await pickImageFile();
    if (!file) return null;
    setBusy("Đang upload ảnh…");
    setError(null);
    try {
      const r = await ctApi.uploadPackImage(file);
      return { url: r.url, w: r.width, h: r.height };
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload thất bại");
      return null;
    } finally {
      setBusy(null);
    }
  };

  /** An image frame fills the edit frame (cover); its size is typed in on the right. */
  const addImageFrame = async () => {
    const img = await upload();
    if (img) addLayer(newLayer("image", scene.width, scene.height, { url: img.url }));
  };

  const replaceImage = async (l: CtPackImageLayer) => {
    const img = await upload();
    if (img) patchLayer(l.id, { url: img.url });
  };

  /** The edit frame takes the photo's proportions (same area); the photo then fills it. */
  const frameToImage = async (l: CtPackImageLayer) => {
    const { w, h } = await imageSize(l.url);
    if (w < 2 || h < 2) return;
    const area = scene.width * scene.height;
    const width = Math.sqrt((area * w) / h);
    const resized = resizeSlide(scene, width, (width * h) / w);
    commit({ ...resized, layers: resized.layers.map((x) => (x.id === l.id ? { ...x, box: { x: 0, y: 0, w: resized.width, h: resized.height, rotation: 0 } } : x)) });
  };

  // ---------------------------------------------------------------- save / templates
  const saved = useMemo(() => assets.filter((a) => a.role === "mockup").sort((a, b) => a.created_at.localeCompare(b.created_at)), [assets]);
  const savedScenes = saved.filter((m) => m.meta.scene);
  /** "#n" of a saved tổ hợp: its place in the list. */
  const numbered: EnhanceItem[] = saved.map((asset, i) => ({ asset, number: i + 1 }));

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
      setSceneState({ ...scene, name });
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
        slides: list.map((m) => ({ ...normalizeSlide(m.meta.scene ?? {}), name: m.name })),
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
      const canvas = await renderComposite({ main, assets, regions, items, selection: sel, scale: 1, layouts });
      const [artwork] = await props.onSaveComposites([{ blob: await canvasToBlob(canvas, "image/png"), selection: sel }]);
      if (!artwork) throw new Error("Không lưu được artwork");
      setBusy("AI đang tạo vật liệu cho artwork…");
      const runId = await ctApi.studioRun({
        recipe: "artwork_material",
        params: { artwork_id: artwork.id, material_id: materialId, edge_px: 0, extra: "", model: "", name: `${f.name} · vật liệu AI` },
      });
      for (;;) {
        await new Promise((r) => window.setTimeout(r, 2500));
        const st = await ctApi.studioRunStatus(runId);
        if (st.status === "error") throw new Error(st.error ?? "AI lỗi");
        if (st.status === "done") {
          props.onAdded(st.assets);
          patchLayer(f.id, { artworkId: artwork.id } as Partial<CtPackFrameLayer>);
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
    return <Type className="m-auto h-3.5 w-3.5" />;
  };

  const shown = [...scene.layers].reverse();
  const [dragRow, setDragRow] = useState<string | null>(null);
  const [overRow, setOverRow] = useState<string | null>(null);

  return (
    <div className="grid h-full grid-cols-[1fr_320px] overflow-hidden">
      <div className="flex min-h-0 flex-col">
        {/* Toolbar: what can go in — each becomes its own frame */}
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b bg-background px-3 py-2">
          <span className="text-[11px] text-muted-foreground">Kéo vào:</span>
          {versions.map((v) => (
            <CtTooltip key={v.id} label={`${v.name} — artwork hoàn chỉnh, kéo vào vùng edit (hoặc click)`}>
              <button
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(VERSION_DRAG, v.id);
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onClick={() => addFrame(v.id, null)}
                className="relative h-10 w-10 cursor-grab overflow-hidden rounded-md border hover:border-sky-500"
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
          <CtTooltip label="Ảnh (nền, tay cầm, sticker…) — mặc định phủ kín khung edit">
            <CtButton size="sm" onClick={() => void addImageFrame()} disabled={!!busy}>
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

        <div className="relative min-h-0 flex-1">
          <PackCanvas
            className="h-full w-full bg-muted/40"
            slide={scene}
            arts={arts}
            selectedId={layerId}
            onSelect={setLayerId}
            onBox={(id, box, done) => patchLayer(id, { box }, done ? "commit" : "live")}
            dropType={VERSION_DRAG}
            onDropAt={(id, at) => addFrame(id, at)}
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
              <CtTooltip label={picked.length ? "Lưu các tổ hợp đã tick làm template" : "Lưu tất cả tổ hợp làm template (tick để chọn bớt)"}>
                <span>
                  <CtButton size="sm" disabled={!savedScenes.length} onClick={() => void saveTemplate()}>
                    <Layers className="h-3.5 w-3.5" /> Lưu làm template ({picked.length || savedScenes.length})
                  </CtButton>
                </span>
              </CtTooltip>
              {packs.length > 0 && (
                <CtSelect className="h-8 w-52" value="" placeholder="Dùng template…" onChange={(id) => void applyTemplate(id)} options={packs.map((p) => ({ value: p.id, label: `${p.name} (${p.slides.length})` }))} />
              )}
            </span>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
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
                    <img src={m.url} alt="" className="h-full w-full object-cover" loading="lazy" />
                  </button>
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
                      if (await ctConfirm({ title: `Xoá “${m.name}”?`, tone: "danger", confirmLabel: "Xoá" })) await props.onDelete(m);
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
              onCommit={() => commit(scene)}
              onReplaceImage={(l) => void replaceImage(l)}
              onFrameToImage={(l) => void frameToImage(l)}
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
  onAiMaterial: (f: CtPackFrameLayer) => void;
}

function LayerSettings(p: LayerSettingsProps) {
  const { layer, scene } = p;
  const b = layer.box;
  const setBox = (patch: Partial<CtPackBox>) => p.onPatch({ box: { ...b, ...patch } });
  return (
    <>
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold">{LAYER_LABEL[layer.type]}</p>
        <CtTooltip label="Phủ kín khung edit">
          <CtButton size="sm" variant="ghost" onClick={() => setBox({ x: 0, y: 0, w: scene.width, h: scene.height, rotation: 0 })}>
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
              <CtSelect
                value={layer.fit}
                onChange={(fit) => p.onPatch({ fit })}
                options={[
                  { value: "cover", label: "Phủ kín (cắt)" },
                  { value: "contain", label: "Vừa (không cắt)" },
                  { value: "stretch", label: "Kéo giãn" },
                ]}
              />
            </CtField>
            <CtField label="Hoà trộn">
              <CtSelect value={layer.blend} onChange={(blend) => p.onPatch({ blend })} options={BLENDS.map((x) => ({ value: x, label: x }))} />
            </CtField>
          </div>
        </>
      )}
      {layer.type === "text" && <TextSettings layer={layer} onPatch={p.onPatch} onCommit={p.onCommit} />}
      {layer.type === "frame" && (
        <>
          {p.versions.length > 1 && (
            <CtField label="Version">
              <CtSelect
                value={String(Math.min(layer.mainIndex, p.versions.length - 1))}
                onChange={(v) => p.onPatch({ mainIndex: Number(v), artworkId: null, name: p.versions[Number(v)]?.name || layer.name } as Partial<CtPackFrameLayer>)}
                options={p.versions.map((v, i) => ({ value: String(i), label: v.name || `Version ${i + 1}` }))}
              />
            </CtField>
          )}
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
                  onChange={(v) => p.onPatch({ shadow: { ...layer.shadow, opacity: Math.min(1, Math.max(0, v / 100)) } })}
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
          onClick={() => !g && onPatch({ gradient: { name: CT_GRADIENTS[0].name, colors: CT_GRADIENTS[0].colors, angle: 90 } })}
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
                style={{ background: gradientCss({ colors: x.colors, angle: g.angle }) }}
                onClick={() => onPatch({ gradient: { name: x.name, colors: x.colors, angle: g.angle } })}
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
                onChange={(e) => onPatch({ gradient: { ...g, name: "", colors: g.colors.map((x, j) => (j === i ? e.target.value : x)) } }, "live")}
                onBlur={onCommit}
              />
            ))}
          </div>
        </>
      )}
    </>
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
              onPatch({ fontFamily, fontWeight: w.includes(layer.fontWeight) ? layer.fontWeight : (w[w.length - 1] ?? 400) });
            }}
            options={CT_FONTS.map((f) => ({ value: f.family, label: f.label }))}
          />
        </CtField>
        <CtField label="Độ đậm">
          <CtSelect value={String(layer.fontWeight)} onChange={(v) => onPatch({ fontWeight: Number(v) })} options={weights.map((w) => ({ value: String(w), label: String(w) }))} />
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
