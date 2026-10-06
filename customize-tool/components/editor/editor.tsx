"use client";

/**
 * Customize Tool editor shell. Owns the loaded product bundle, the design
 * (regions/items, with undo), the preview selection, and every dialog.
 *
 * Shortcuts: V select · H hand (Space) · R rect · O ellipse · P polygon ·
 * L add custom layer · T text zone · U customer-photo zone · C then X / Y / C
 * centre the selected zone on the main (x / y / both) ·
 * Enter/double-click region = object mode · ⌘Z / ⇧⌘Z undo/redo · ⌘S save ·
 * ⌘D duplicate zone · Delete remove zone · arrows nudge (Shift = 10px).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Wallpaper,
  Circle,
  Copy,
  Crown,
  Hand,
  ImageIcon,
  Loader2,
  MousePointer2,
  Move,
  Pentagon,
  Plus,
  Redo2,
  Printer,
  Rocket,
  Save,
  Square,
  Type,
  Undo2,
  UserSquare,
  X,
} from "lucide-react";
import { CT_CONFIG, ctGoogleFontsHref } from "../../config";
import { CT_BASE_OPTION, CT_MAIN_KEY } from "../../types";
import type { CtAsset, CtMainFrame, CtMainOptionConfig, CtPackImage, CtPhotoSelection, CtPoint, CtProductScene, CtProduct, CtRegion, CtRegionItem, CtSelection, CtStudioRecipe, CtZoneParent, CtRegionKind } from "../../types";
import { ctApi } from "../../lib/api-client";
import {
  defaultProductConfig,
  defaultRegionSelection,
  hasTestPhoto,
  isSelectionValid,
  makeItem,
  makeRegion,
  mainVersions,
  normalizeProductConfig,
  normalizeRegion,
  selectedMainId,
  selectedMainImageId,
  zoneSubtree,
} from "../../lib/design";
import { fitShapeToBounds, IDENTITY_PHOTO_FRAME, IDENTITY_TRANSFORM, newId, pointInShape, shapeBounds, translateShape } from "../../lib/geometry";
import { CHECKER_STYLE, CtAutoWidthInput, CtButton, CtTooltip, CtTooltipProvider, cx } from "../ui";
import { Stage, type EditTarget, type StageTool } from "./stage";
import { Inspector } from "./inspector";
import { AssetPanel } from "./asset-panel";
import { PreviewPanel } from "./preview-panel";
import { SceneDialog } from "./scene-dialog";
import { StorefrontPreview } from "./storefront-preview";
import { activeZoneOptions, updateItem, updateRegion, useDesign, versionView, zoneOptionView } from "./use-design";
import { nearestAspect, PackImageLibrary } from "./pack-image-library";
import { PrintDialog } from "./print-dialog";
import { CLIPART_DRAG, type CtClipartDrag } from "./library-panel";
import { ClipartPickerDialog } from "./clipart-picker";
import { CtAiDialog, type CtAiTarget } from "../studio/ai-dialog";
import { ctConfirm } from "../dialogs";
import { asLayerClipart, asMainOption, asVersion } from "../../lib/library";
import { claimSharedLayers, cloneLayers, fitMainFrame, mainFrameFor, versionLayers } from "../../lib/layout";

/** Thiết kế = edit · Xem trước = the real storefront page · Tổ hợp & Mockup = composites + AI mockups. */
type View = "design" | "preview" | "mockup";


/** Kinds drawn with a frame tool. A custom layer is added at once instead: its frame is the image itself. */
type DrawKind = "text" | "photo";
type CenterAxis = "x" | "y" | "xy";

/** localStorage: the "copy layers from version" list was folded for this product. */
const COPY_PANEL_KEY = "ct-copy-layers-off:";

function readCopyPanelOff(productId: string): boolean {
  try {
    return localStorage.getItem(COPY_PANEL_KEY + productId) === "1";
  } catch {
    return false;
  }
}

function writeCopyPanelOff(productId: string, off: boolean): void {
  try {
    if (off) localStorage.setItem(COPY_PANEL_KEY + productId, "1");
    else localStorage.removeItem(COPY_PANEL_KEY + productId);
  } catch {
    // Storage blocked: the list just opens again next time.
  }
}

/** How long "C" waits for its second key (X / Y / C). */
const CENTER_CHORD_MS = 900;

/**
 * Contain-fit a w×h box into `b`, keeping b's centre — a custom layer's frame
 * takes the aspect of the image it holds, so the frame IS the image outline.
 */
function fitAspect(b: { x: number; y: number; w: number; h: number }, w: number, h: number) {
  if (w <= 0 || h <= 0 || b.w <= 0 || b.h <= 0) return b;
  const s = Math.min(b.w / w, b.h / h);
  const nw = w * s;
  const nh = h * s;
  return { x: b.x + (b.w - nw) / 2, y: b.y + (b.h - nh) / 2, w: nw, h: nh };
}

/**
 * Keys that belong to something else: text fields, and open popups (a Radix
 * select list, a dialog) — Esc there closes the popup and must not also
 * deselect the zone.
 */
function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable) return true;
  return t.closest('[role="listbox"], [role="dialog"], [data-radix-popper-content-wrapper]') !== null;
}

export function CustomizeEditor({ productId }: { productId: string }) {
  const [product, setProduct] = useState<CtProduct | null>(null);
  const [assets, setAssets] = useState<CtAsset[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const design = useDesign({ regions: [], items: [], config: defaultProductConfig() });
  const [nameDraft, setNameDraft] = useState("");
  const router = useRouter();
  /**
   * The thư viện ảnh tổ hợp is open for a custom layer: `regionId` null = a new layer (tool L), else that layer's
   * picture (an empty layer clicked, or "Đổi ảnh").
   */
  const [layerLibrary, setLayerLibrary] = useState<{ regionId: string | null } | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [selection, setSelection] = useState<CtSelection>({});
  /** Photo zones whose test photo is being processed (spinner on the canvas). */
  const [photoBusy, setPhotoBusy] = useState<Record<string, string>>({});

  const [view, setView] = useState<View>("design");
  /** The storefront preview stays mounted once opened, so its choices (text, photo) survive tab switches. */
  const [previewMounted, setPreviewMounted] = useState(false);
  const openView = (v: View) => {
    setView(v);
    if (v === "preview") setPreviewMounted(true);
  };
  const [tool, setTool] = useState<StageTool>("select");
  const [drawKind, setDrawKind] = useState<DrawKind>("text");
  /** "C" pressed: waiting for X / Y / C to centre the selected zone. */
  const centerChord = useRef<number>(0);
  const [editTarget, setEditTarget] = useState<EditTarget>("region");
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [showOverlay, setShowOverlay] = useState(true);
  const [materialOpen, setMaterialOpen] = useState(false);
  const [sceneOpen, setSceneOpen] = useState(false);

  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** Tổ hợp → "tạo bản vật liệu" (components/studio/ai-dialog.tsx) and a bump that reloads the Thư viện tab. */
  const [ai, setAi] = useState<CtAiTarget | null>(null);
  const [libraryVersion, setLibraryVersion] = useState(0);
  /** The "copy layers from version" list (right column) is folded for this product. */
  const [copyPanelOff, setCopyPanelOff] = useState(false);
  /** "Thêm option": pick sub-options of this version among its own clipart set. */
  const [optionsFor, setOptionsFor] = useState<CtAsset | null>(null);
  /** Version column "+": one blank version slot (null = none); shown on the canvas while `blankShown`. */
  const [blank, setBlank] = useState(false);
  const [blankShown, setBlankShown] = useState(false);
  /** The shown version's picture frame is selected (moved / resized on the canvas, numbers in the right column). */
  const [mainSelected, setMainSelected] = useState(false);

  // ---------------------------------------------------------------- load
  useEffect(() => {
    ctApi
      .getBundle(productId)
      .then((b) => {
        setProduct(b.product);
        setNameDraft(b.product.name);
        setAssets(b.assets);
        setCopyPanelOff(readCopyPanelOff(b.product.id));
        const config = normalizeProductConfig(b.product.config);
        // The design's own content (texts, choices, test photos) comes back as it was left.
        setSelection(config.samples);
        savedSamples.current = { json: JSON.stringify(config.samples), samples: config.samples };
        samplesLoaded.current = true;
        const regions = b.regions.map(normalizeRegion);
        // Every main version has its own layers: an older design's shared layers belong to the default main.
        const claimed = b.product.main_asset_id ? claimSharedLayers(regions, b.product.main_asset_id) : null;
        if (claimed) {
          // The default main never carried a layout of its own; other versions' old layouts no longer apply.
          design.reset({ regions: claimed, items: b.items, config: { ...config, layouts: {} } }, true);
          setNotice("Mỗi version main giờ có bộ layer riêng — layer cũ thuộc main mặc định, nhớ Lưu thiết kế");
        } else {
          design.reset({ regions, items: b.items, config });
        }
      })
      .catch((e: Error) => setLoadError(e.message));
    // design.reset is stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  useEffect(() => {
    const id = "ct-google-fonts";
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = ctGoogleFontsHref();
    document.head.appendChild(link);
  }, []);

  const config = design.state.config;
  const main = useMemo(() => assets.find((a) => a.id === product?.main_asset_id) ?? null, [assets, product]);
  const mains = useMemo(() => mainVersions(assets, product?.main_asset_id ?? null), [assets, product]);
  const shownMainId = main ? selectedMainId(selection, assets, main.id) : null;
  const shownMainImageId = main ? selectedMainImageId(selection, assets, main.id) : null;
  // Every main version has its own layers: canvas + inspector see and edit the shown version's (lib/layout.ts).
  // A text / photo zone showing one of its sub-options is edited as that option (use-design zoneOptionView).
  const versionApi = versionView(design, shownMainId);
  const ed = zoneOptionView(versionApi, activeZoneOptions(versionApi.state.regions, selection));
  const { regions, items } = ed.state;
  /** Main version id -> its layer count. */
  const layerCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const m of mains) out[m.id] = versionLayers(design.state.regions, design.state.items, m.id).regions.length;
    return out;
  }, [mains, design.state.regions, design.state.items]);

  // Keep the preview selection valid as zones / items / assets change. Checked against the current selection
  // first: dragging a zone changes `regions` every frame, and a setSelection per frame (even one returning the
  // same object) piled up into React's "Maximum update depth exceeded".
  // Checked against every version's layers, so choices survive switching versions.
  const allRegions = design.state.regions;
  const allItems = design.state.items;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  useEffect(() => {
    const reconcile = (prev: CtSelection): CtSelection => {
      const next: CtSelection = {};
      let changed = false;
      const curMain = prev[CT_MAIN_KEY];
      if (curMain?.kind === "main" && mains.some((m) => m.id === curMain.assetId)) next[CT_MAIN_KEY] = curMain;
      else if (curMain) changed = true;
      for (const r of allRegions) {
        const cur = prev[r.id];
        if (cur && isSelectionValid(r, cur, allItems, assets)) {
          next[r.id] = cur;
          continue;
        }
        next[r.id] = defaultRegionSelection(r, allItems, assets);
        changed = true;
      }
      if (Object.keys(prev).length !== Object.keys(next).length) changed = true;
      return changed ? next : prev;
    };
    if (reconcile(selectionRef.current) !== selectionRef.current) setSelection(reconcile);
  }, [allRegions, allItems, assets, mains]);

  // Leaving object mode when the region/item context goes away.
  useEffect(() => {
    const item = items.find((i) => i.id === activeItemId);
    if (!item || item.region_id !== selectedRegionId) {
      if (activeItemId) setActiveItemId(null);
      if (editTarget === "object") {
        // Pick the first item of the newly selected image region automatically.
        const first = items.find((i) => i.region_id === selectedRegionId);
        if (first) setActiveItemId(first.id);
        // A photo zone's object is its child frame, not an item.
        else if (regions.find((r) => r.id === selectedRegionId)?.kind !== "photo") setEditTarget("region");
      }
    }
  }, [items, regions, activeItemId, selectedRegionId, editTarget]);

  // ---------------------------------------------------------------- design samples (config.samples)
  // What the designer chose / typed / uploaded in every version's layers is kept on the product (never published),
  // so the Tổ hợp frames draw the finished artwork. Test photos are blob: URLs here — stored once on the way out.
  const samplesLoaded = useRef(false);
  const savedSamples = useRef<{ json: string; samples: CtSelection }>({ json: "{}", samples: {} });
  const samplesJob = useRef<Promise<void>>(Promise.resolve());
  const storedUrls = useRef(new Map<string, Promise<string>>());
  const storedUrl = (u: string | null | undefined): Promise<string | null> => {
    if (!u) return Promise.resolve(null);
    if (!u.startsWith("blob:")) return Promise.resolve(u);
    let job = storedUrls.current.get(u);
    if (!job) {
      job = fetch(u)
        .then((r) => r.blob())
        .then((b) => ctApi.uploadPackImage(b))
        .then((r) => r.url);
      job.catch(() => storedUrls.current.delete(u));
      storedUrls.current.set(u, job);
    }
    return job;
  };
  /** Write the samples (queued: one write at a time, in order). */
  const persistSamples = (productId: string, sel: CtSelection): Promise<void> => {
    samplesJob.current = samplesJob.current.then(async () => {
      const out: CtSelection = {};
      for (const [k, v] of Object.entries(sel)) {
        if (v.kind !== "photo") {
          out[k] = v;
          continue;
        }
        const [url, sourceUrl] = await Promise.all([storedUrl(v.url), storedUrl(v.sourceUrl)]);
        out[k] = { ...v, url, sourceUrl };
      }
      const json = JSON.stringify(out);
      if (json === savedSamples.current.json) return;
      try {
        await ctApi.updateProduct(productId, { samples: out });
        savedSamples.current = { json, samples: out };
      } catch (e) {
        flash(e instanceof Error ? `Không lưu được nội dung thiết kế: ${e.message}` : "Không lưu được nội dung thiết kế");
      }
    });
    return samplesJob.current;
  };
  const persistRef = useRef(persistSamples);
  useEffect(() => {
    persistRef.current = persistSamples;
  });
  useEffect(() => {
    if (!product || !samplesLoaded.current) return;
    const t = window.setTimeout(() => void persistRef.current(product.id, selection), 1200);
    return () => window.clearTimeout(t);
  }, [product, selection]);

  // ---------------------------------------------------------------- save
  const save = useCallback(async (): Promise<boolean> => {
    if (!product) return false;
    setSaving(true);
    try {
      // Samples go their own way (above); the design save carries the stored ones so it never rolls them back.
      await persistRef.current(product.id, selectionRef.current);
      const config = { ...design.state.config, samples: savedSamples.current.samples };
      await ctApi.saveDesign(product.id, { regions: design.state.regions, items: design.state.items, config });
      design.markSaved();
      setNotice("Đã lưu");
      setTimeout(() => setNotice(null), 1500);
      return true;
    } catch (e) {
      setNotice(e instanceof Error ? `Lỗi lưu: ${e.message}` : "Lỗi lưu");
      return false;
    } finally {
      setSaving(false);
    }
  }, [product, design]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (design.dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [design.dirty]);

  // ---------------------------------------------------------------- zones
  /** Text / customer-photo: arm the frame tool (rect by default); the user drags the frame. */
  const startDraw = (kind: DrawKind) => {
    setDrawKind(kind);
    setTool((t) => (t === "rect" || t === "ellipse" || t === "polygon" ? t : "rect"));
    setEditTarget("region");
  };

  /**
   * Custom layer (tool L) — like an image frame: pick its picture in the thư viện ảnh tổ hợp (upload a new one
   * there, or AI); the layer is made around it, centred. A library clipart can be dragged onto the canvas instead.
   */
  const addCustomLayer = () => {
    if (!main) return;
    setLayerLibrary({ regionId: null });
    setTool("select");
  };

  /**
   * "+ con" on an option: a child zone shown only while its parent shows that option — a text, an empty custom
   * layer (click it to pick its picture) or a photo upload — inside the parent's box, selected for editing.
   */
  const addChildZone = (parent: CtZoneParent, kind: CtRegionKind) => {
    const p = regions.find((r) => r.id === parent.regionId);
    if (!p || !product) return;
    const b = shapeBounds(p.shape);
    const w = Math.round(b.w * 0.6);
    const h = Math.round(kind === "text" ? Math.max(40, b.h * 0.3) : b.h * 0.6);
    const shape = { type: "rect" as const, x: Math.round(b.x + (b.w - w) / 2), y: Math.round(b.y + (b.h - h) / 2), w, h, radius: 0 };
    const made = makeRegion(product.id, kind, shape, regions.length);
    const region: CtRegion = { ...made, name: `${made.name} ↳ ${p.name}`, config: { ...made.config, parent } };
    ed.commit((s) => ({ ...s, regions: [...s.regions, region] }));
    revealZone(region.id, [...regions, region]);
    setSelectedRegionId(region.id);
    setActiveItemId(null);
    setEditTarget("region");
    flash("Đã thêm option con — chỉ hiện khi khách chọn option đó");
  };

  /** Show a (child) zone on the canvas: every parent above it switched to the option it belongs to. */
  const revealZone = (id: string, list: CtRegion[] = regions) => {
    const byId = new Map(list.map((r) => [r.id, r]));
    setSelection((cur) => {
      let next = cur;
      for (let r = byId.get(id), d = 0; r?.config.parent && d < 12; r = byId.get(r.config.parent.regionId), d++) {
        const { regionId, optionId } = r.config.parent;
        const parent = byId.get(regionId);
        if (!parent) break;
        const sel = next[regionId];
        if (parent.kind === "image") next = { ...next, [regionId]: { kind: "image", assetId: optionId } };
        else if (parent.kind === "text") next = { ...next, [regionId]: { ...(sel?.kind === "text" ? sel : { kind: "text" as const, text: normalizeRegion(parent).config.text.defaultText }), optionId: optionId === CT_BASE_OPTION ? null : optionId } };
        else if (sel?.kind === "photo") next = { ...next, [regionId]: { ...sel, optionId: optionId === CT_BASE_OPTION ? null : optionId } };
      }
      return next;
    });
  };

  /** Deploy sản phẩm (its own page): the design is saved first, so the deploy ships what is on screen. */
  const openDeploy = async () => {
    if (!product) return;
    setDeploying(true);
    if (design.dirty && !(await save())) {
      setDeploying(false);
      return;
    }
    router.push(`${CT_CONFIG.basePath}/${product.id}/deploy`);
  };

  /** A photo of the thư viện ảnh tổ hợp becomes this product's picture (a sub asset) in a custom layer. */
  const applyLayerImage = async (img: CtPackImage) => {
    const target = layerLibrary;
    setLayerLibrary(null);
    if (!product || !main || !img.url || !target) return;
    try {
      flash("Đang thêm ảnh vào layer…");
      const blob = await fetch(img.url).then((r) => {
        if (!r.ok) throw new Error(`Không tải được ảnh (HTTP ${r.status})`);
        return r.blob();
      });
      const sub = await ctApi.uploadAsset(product.id, blob, { role: "sub", name: img.name || "Ảnh" });
      setAssets((list) => [...list, sub]);
      const layer = target.regionId ? regions.find((r) => r.id === target.regionId) : undefined;
      if (layer) {
        // "Đổi ảnh" / an empty layer: it now holds only this picture (its frame refits to it, centred where it was).
        const item = makeItem(layer.id, sub.id, 0);
        ed.commit((s) => {
          const rest = { ...s, items: s.items.filter((i) => i.region_id !== layer.id) };
          return { ...rest, regions: fitLayerToFirstItem(rest, layer.id, sub), items: [...rest.items, item] };
        });
        setSelectedRegionId(layer.id);
        setActiveItemId(item.id);
        setSelection((sel) => ({ ...sel, [layer.id]: { kind: "image", assetId: sub.id } }));
      } else {
        const size = Math.round(Math.min(main.width, main.height) * 0.4);
        const box = fitAspect({ x: (main.width - size) / 2, y: (main.height - size) / 2, w: size, h: size }, sub.width, sub.height);
        const region = makeRegion(product.id, "image", { type: "rect", x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h), radius: 0 }, regions.length);
        placeInto({ ...region, name: img.name || region.name }, sub, true);
      }
      setEditTarget("region");
      flash("Đã thêm ảnh — nhớ Lưu thiết kế");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Không thêm được ảnh");
    }
  };

  /**
   * Snap the selected zone onto the main's centre axis: "x" = onto the
   * horizontal centre line (moves up/down), "y" = onto the vertical centre
   * line (moves left/right), "xy" = both.
   */
  const centerSelected = (axis: CenterAxis) => {
    if (!main || !selectedRegionId) return;
    ed.commit((s) =>
      updateRegion(s, selectedRegionId, (r) => {
        const b = shapeBounds(r.shape);
        const dx = axis === "x" ? 0 : (main.width - b.w) / 2 - b.x;
        const dy = axis === "y" ? 0 : (main.height - b.h) / 2 - b.y;
        return { ...r, shape: translateShape(r.shape, dx, dy) };
      }),
    );
  };

  /** Delete a photo zone's child frame (its Layers sub-row) and the test photo rendered in it. The zone stays. */
  const removePhotoFrame = (regionId: string) => {
    ed.commit((s) =>
      updateRegion(s, regionId, (r) => {
        const n = normalizeRegion(r);
        return { ...n, config: { ...n.config, photo: { ...n.config.photo, frame: { ...IDENTITY_PHOTO_FRAME, enabled: false, tilt: n.config.photo.frame?.tilt ?? null } } } };
      }),
    );
    setSelection((cur) => {
      const prev = cur[regionId];
      if (prev?.kind !== "photo" || (!prev.url && !prev.sourceUrl)) return cur;
      // The upload is freed; styled renders stay cached in the inspector (per source + style).
      if (prev.sourceUrl?.startsWith("blob:")) URL.revokeObjectURL(prev.sourceUrl);
      return { ...cur, [regionId]: { kind: "photo", url: null, transform: { ...IDENTITY_TRANSFORM } } };
    });
    setEditTarget("region");
  };

  /** The first image placed in a custom layer reshapes the frame to that image's aspect. */
  const fitLayerToFirstItem = (s: { regions: CtRegion[]; items: CtRegionItem[] }, regionId: string, asset: CtAsset) => {
    if (s.items.some((i) => i.region_id === regionId)) return s.regions;
    return s.regions.map((r) => (r.id === regionId ? { ...r, shape: fitShapeToBounds(r.shape, fitAspect(shapeBounds(r.shape), asset.width, asset.height)) } : r));
  };

  // ---------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
        return;
      }
      if (isTyping(e.target) || view !== "design") return;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) design.redo();
        else design.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        design.redo();
        return;
      }
      if (mod && e.key.toLowerCase() === "d" && selectedRegionId) {
        e.preventDefault();
        const src = regions.find((r) => r.id === selectedRegionId);
        if (!src) return;
        const n = normalizeRegion(src);
        const idMap = new Map(items.filter((i) => i.region_id === src.id).map((i) => [i.id, newId()]));
        const groupNames: Record<string, string> = {};
        for (const [from, to] of idMap) if (n.config.image.groupNames[from]) groupNames[to] = n.config.image.groupNames[from];
        const copy = {
          ...n,
          id: newId(),
          name: `${src.name} copy`,
          shape: translateShape(src.shape, 20, 20),
          sort_order: regions.length,
          config: { ...n.config, image: { ...n.config.image, groupNames } },
        };
        const copiedItems = items.filter((i) => i.region_id === src.id).map((i) => ({ ...i, id: idMap.get(i.id) ?? newId(), region_id: copy.id }));
        ed.commit((s) => ({ ...s, regions: [...s.regions, copy], items: [...s.items, ...copiedItems] }));
        setSelectedRegionId(copy.id);
        return;
      }
      if (mod) return;
      const k = e.key.toLowerCase();
      if (Date.now() - centerChord.current < CENTER_CHORD_MS && (k === "x" || k === "y" || k === "c")) {
        centerChord.current = 0;
        centerSelected(k === "x" ? "x" : k === "y" ? "y" : "xy");
        return;
      }
      if (k === "c") {
        if (selectedRegionId) centerChord.current = Date.now();
        return;
      }
      if (k === "l") addCustomLayer();
      else if (k === "t") startDraw("text");
      else if (k === "u") startDraw("photo");
      else if (k === "v") setTool("select");
      else if (k === "h") setTool("hand");
      else if (k === "r") setTool("rect");
      else if (k === "o") setTool("ellipse");
      else if (k === "p") setTool("polygon");
      else if (e.key === "Escape") {
        if (editTarget === "object") setEditTarget("region");
        else setSelectedRegionId(null);
        setMainSelected(false);
      } else if (e.key === "Enter" && tool !== "polygon" && selectedRegionId) {
        const r = regions.find((x) => x.id === selectedRegionId);
        if (r?.kind === "image" || (r?.kind === "photo" && hasTestPhoto(selection[r.id]))) setEditTarget((t) => (t === "object" ? "region" : "object"));
      } else if ((e.key === "Delete" || e.key === "Backspace") && tool !== "polygon" && selectedRegionId) {
        e.preventDefault();
        // A photo zone's child frame is selected: remove the frame, keep the zone.
        const r = regions.find((x) => x.id === selectedRegionId);
        if (r?.kind === "photo" && editTarget === "object") {
          removePhotoFrame(r.id);
          return;
        }
        // Its child zones go with it.
        const gone = zoneSubtree(regions, selectedRegionId);
        ed.commit((s) => ({
          ...s,
          regions: s.regions.filter((r) => !gone.has(r.id)),
          items: s.items.filter((i) => !gone.has(i.region_id)),
        }));
        setSelectedRegionId(null);
      } else if (e.key.startsWith("Arrow") && selectedRegionId) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        if (editTarget === "object" && activeItemId) {
          const r = regions.find((x) => x.id === selectedRegionId);
          if (!r) return;
          const b = shapeBounds(r.shape);
          ed.commit((s) =>
            updateItem(s, activeItemId, (i) => ({
              ...i,
              transform: { ...i.transform, offsetX: i.transform.offsetX + dx / Math.max(1, b.w), offsetY: i.transform.offsetY + dy / Math.max(1, b.h) },
            })),
          );
        } else {
          ed.commit((s) => updateRegion(s, selectedRegionId, (r) => ({ ...r, shape: translateShape(r.shape, dx, dy) })));
        }
      } else if (e.key.startsWith("Arrow") && mainSelected && main && shownMainId) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const f = mainFrameFor(config.layouts, shownMainId, main.width, main.height);
        setMainFrame({ ...f, x: f.x + (e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0), y: f.y + (e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0) });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---------------------------------------------------------------- asset actions
  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 3000);
  };

  // Swatch colour pickers fire on every drag step: update locally at once,
  // write to the server once the colour settles.
  const swatchTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const setSwatch = (asset: CtAsset, color: string) => {
    setAssets((list) => list.map((x) => (x.id === asset.id ? { ...x, meta: { ...x.meta, swatch: color } } : x)));
    const timers = swatchTimers.current;
    clearTimeout(timers.get(asset.id));
    timers.set(
      asset.id,
      setTimeout(() => {
        timers.delete(asset.id);
        ctApi.updateAsset(asset.id, { meta: { swatch: color } }).catch((e: Error) => flash(e.message));
      }, 400),
    );
  };

  const setScene = (scene: CtProductScene) => ed.commit((s) => ({ ...s, config: { ...s.config, scene } }));

  /** Mockup pack view: open the material recipe on the cliparts a mockup still lacks (one family). */
  const createMaterialFor = (cliparts: CtAsset[]) => {
    const first = cliparts[0];
    if (!first) return;
    const originId = first.parent_id ?? first.id;
    const origin = assets.find((a) => a.id === originId) ?? first;
    setAi({
      recipe: "material",
      clipart: origin,
      family: assets.filter((a) => a.id === originId || a.parent_id === originId),
      targetIds: cliparts.map((c) => c.id),
    });
  };

  /** Mockups are deleted without the usage checks of removeAsset (the panel asks first). */
  const deleteMockup = async (asset: CtAsset) => {
    try {
      await ctApi.deleteAsset(asset.id);
      setAssets((a) => a.filter((x) => x.id !== asset.id));
    } catch (e) {
      flash(e instanceof Error ? e.message : "Xoá thất bại");
    }
  };

  const setMainConfig = (patch: Partial<CtMainOptionConfig>) => ed.commit((s) => ({ ...s, config: { ...s.config, main: { ...s.config.main, ...patch } } }));

  /** Members / renditions of cliparts this product uses join its bundle at once; mockups too. */
  const onAiSaved = (saved: CtAsset[], recipe: CtStudioRecipe) => {
    setLibraryVersion((v) => v + 1);
    flash(`AI: đã lưu ${saved.length} ảnh${recipe === "mockup" ? " vào sản phẩm" : " vào thư viện"}`);
    setAssets((list) => {
      const have = new Set(list.map((a) => a.id));
      const join = saved.filter((a) => !have.has(a.id) && (recipe === "mockup" || (a.parent_id !== null && have.has(a.parent_id))));
      return join.length ? [...list, ...join] : list;
    });
  };

  /** A library clipart is never deleted from here: the product just stops using it. */
  const unlinkLibraryAsset = async (asset: CtAsset) => {
    if (!product) return;
    const family = new Set(assets.filter((a) => a.id === asset.id || a.parent_id === asset.id).map((a) => a.id));
    const usedIn = items.filter((i) => family.has(i.asset_id)).length;
    const what = asset.role === "main" ? "version này (cùng layer và option con của nó)" : `nhóm option (${usedIn} vùng)`;
    if (!(await ctConfirm({ title: `Gỡ “${asset.name || asset.role}” khỏi sản phẩm này?`, message: `Bỏ ${what}. Clipart vẫn còn trong thư viện.`, confirmLabel: "Gỡ" }))) return;
    try {
      if (asset.role === "main") {
        await ctApi.unlinkMain(product.id, asset.id);
        if (asset.id === product.main_asset_id) setProduct({ ...product, main_asset_id: null });
        dropVersionLayers(asset.id);
        setSubOptions(asset.id, []);
      }
      if (usedIn) design.commit((s) => ({ ...s, items: s.items.filter((i) => !family.has(i.asset_id)) }));
      setAssets((a) => a.filter((x) => !family.has(x.id)));
      if (usedIn) flash("Đã gỡ — nhớ Lưu thiết kế");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Gỡ thất bại");
    }
  };

  /**
   * A library clipart this product may use was replaced by its edited version (refine / "Sửa nhanh" → "Thay bản
   * cũ"). The server already re-pointed the saved product; the open design follows, so the next save keeps it.
   */
  const swapLibraryAsset = (old: CtAsset, next: CtAsset) => {
    if (!assets.some((a) => a.id === old.id)) return;
    // Its material versions were drawn from the old art and are gone; its set members now belong to the new one.
    setAssets((list) =>
      list
        .filter((a) => !(a.parent_id === old.id && a.role === "rendition"))
        .map((a) => (a.id === old.id ? next : a.parent_id === old.id ? { ...a, parent_id: next.id } : a)),
    );
    design.commit((s) => {
      const layouts = { ...s.config.layouts };
      if (layouts[old.id]) {
        layouts[next.id] = layouts[old.id];
        delete layouts[old.id];
      }
      return {
        ...s,
        items: s.items.map((i) => (i.asset_id === old.id ? { ...i, asset_id: next.id } : i)),
        regions: s.regions.map((r) => {
          const hidden = r.config?.image?.hiddenAssetIds;
          let out = hidden?.includes(old.id) ? { ...r, config: { ...r.config, image: { ...r.config.image, hiddenAssetIds: hidden.map((x) => (x === old.id ? next.id : x)) } } } : r;
          // A layer of the replaced main version follows it.
          if (out.config?.mainId === old.id) out = { ...out, config: { ...out.config, mainId: next.id } };
          return out;
        }),
        config: { ...s.config, layouts },
      };
    });
    if (product?.main_asset_id === old.id) setProduct({ ...product, main_asset_id: next.id, thumbnail_url: next.url });
    setSelection((sel) => {
      const out: CtSelection = {};
      for (const [k, v] of Object.entries(sel)) out[k] = (v.kind === "image" || v.kind === "main") && v.assetId === old.id ? { ...v, assetId: next.id } : v;
      return out;
    });
  };

  /** A main version leaves the product: its own layers go with it. */
  const dropVersionLayers = (mainId: string) => {
    const gone = new Set(design.state.regions.filter((r) => r.config?.mainId === mainId).map((r) => r.id));
    if (!gone.size) return;
    design.commit((s) => ({ ...s, regions: s.regions.filter((r) => !gone.has(r.id)), items: s.items.filter((i) => !gone.has(i.region_id)) }));
    if (selectedRegionId && gone.has(selectedRegionId)) setSelectedRegionId(null);
  };

  /** Show (and edit) main version `id` on the canvas. */
  const showVersion = (id: string) => {
    setBlankShown(false);
    setMainSelected(false);
    if (id === shownMainId) return;
    setSelection((sel) => ({ ...sel, [CT_MAIN_KEY]: { kind: "main", assetId: id } }));
    setSelectedRegionId(null);
    setActiveItemId(null);
    setEditTarget("region");
  };

  /** The shown version's layers become copies of version `from`'s (one click; replacing asks first, ⌘Z undoes). */
  const copyLayersFrom = async (from: CtAsset) => {
    if (!shownMainId || from.id === shownMainId) return;
    const src = versionLayers(design.state.regions, design.state.items, from.id);
    if (!src.regions.length) return;
    const target = mains.find((m) => m.id === shownMainId);
    if (
      regions.length > 0 &&
      !(await ctConfirm({
        title: `Thay ${regions.length} layer của “${target?.name || "version này"}”?`,
        message: `Layer hiện có của version này được thay bằng bản sao ${src.regions.length} layer của “${from.name || "version"}”. Hoàn tác được bằng ⌘Z.`,
        confirmLabel: "Thay",
      }))
    )
      return;
    const ordered = [...src.regions].sort((a, b) => a.sort_order - b.sort_order).map((r, k) => ({ ...r, sort_order: k }));
    const copy = cloneLayers(ordered, src.items, shownMainId);
    ed.commit((s) => ({ ...s, regions: copy.regions, items: copy.items }));
    // Object / text choices come along; a test photo stays with its own zone.
    setSelection((sel) => {
      const next = { ...sel };
      for (const [from, to] of copy.idMap) {
        const v = sel[from];
        if (v && v.kind !== "photo") next[to] = v;
      }
      return next;
    });
    setSelectedRegionId(null);
    setActiveItemId(null);
    setEditTarget("region");
    flash(`Đã sao chép ${copy.regions.length} layer từ “${from.name || "version"}”`);
  };

  const removeAsset = async (asset: CtAsset) => {
    if (asset.product_id === null && asset.parent_id === null) return unlinkLibraryAsset(asset);
    if (asset.product_id === null) {
      // Other products may offer this colour: hide it here (Inspector → option), delete it on /library.
      flash("Biến thể thuộc thư viện: ẩn option ở Inspector, hoặc xoá ở trang Thư viện");
      return;
    }
    const usedIn = items.filter((i) => i.asset_id === asset.id).length;
    const variants = assets.filter((a) => a.parent_id === asset.id).length;
    const warn = [
      asset.id === product?.main_asset_id ? "Đây là version mặc định." : "",
      usedIn ? `Đang được đặt trong ${usedIn} vùng.` : "",
      variants ? `Sẽ xoá kèm ${variants} version.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    if (!(await ctConfirm({ title: `Xoá “${asset.name || asset.role}”?`, message: warn || undefined, tone: "danger", confirmLabel: "Xoá" }))) return;
    try {
      await ctApi.deleteAsset(asset.id);
      setAssets((a) => a.filter((x) => x.id !== asset.id && x.parent_id !== asset.id));
      if (usedIn) ed.commit((s) => ({ ...s, items: s.items.filter((i) => i.asset_id !== asset.id) }));
      if (asset.role === "main") dropVersionLayers(asset.id);
      if (product && asset.id === product.main_asset_id) setProduct({ ...product, main_asset_id: null });
    } catch (e) {
      flash(e instanceof Error ? e.message : "Xoá thất bại");
    }
  };

  const setMain = async (asset: CtAsset) => {
    if (!product) return;
    if (main && regions.length > 0 && (main.width !== asset.width || main.height !== asset.height)) {
      const ok = await ctConfirm({
        title: "Kích thước main khác nhau",
        message: `Main mới ${asset.width}×${asset.height} khác main hiện tại ${main.width}×${main.height}. Vùng custom tính theo pixel sẽ lệch. Tiếp tục?`,
        confirmLabel: "Tiếp tục",
      });
      if (!ok) return;
    }
    try {
      setProduct(await ctApi.updateProduct(product.id, { main_asset_id: asset.id, thumbnail_url: asset.url }));
    } catch (e) {
      flash(e instanceof Error ? e.message : "Lỗi");
    }
  };

  /**
   * `sub` becomes an option group of custom layer `r` (`isNew`: the layer is added in the same undo step);
   * `hide`: its options the customer doesn't see until switched on (a gốc's đa sắc).
   */
  const placeInto = (r: CtRegion, sub: CtAsset, isNew: boolean, hide: string[] = []) => {
    if (items.some((i) => i.region_id === r.id && i.asset_id === sub.id)) {
      flash("Clipart này đã có trong layer");
      return;
    }
    const count = items.filter((i) => i.region_id === r.id).length;
    const item = makeItem(r.id, sub.id, count);
    ed.commit((s) => {
      const withLayer = isNew ? { ...s, regions: [...s.regions, r] } : s;
      const fitted = fitLayerToFirstItem(withLayer, r.id, sub);
      const regions = hide.length
        ? fitted.map((x) => {
            if (x.id !== r.id) return x;
            const n = normalizeRegion(x);
            return { ...n, config: { ...n.config, image: { ...n.config.image, hiddenAssetIds: [...new Set([...n.config.image.hiddenAssetIds, ...hide])] } } };
          })
        : fitted;
      return { ...withLayer, regions, items: [...s.items, item] };
    });
    setSelectedRegionId(r.id);
    setActiveItemId(item.id);
    setSelection((sel) => ({ ...sel, [r.id]: { kind: "image", assetId: sub.id } }));
  };

  /**
   * Library picture dropped on the canvas — used exactly as it is. With no main yet it becomes the first
   * version; otherwise it is a layer clipart: it drops into the custom layer under the cursor (another option
   * group), or becomes a new layer centred there. (A new version is dropped on the Version column instead.)
   */
  const dropClipart = (drag: CtClipartDrag, at: CtPoint | null) => {
    if (!main) {
      void addLibraryMain(drag);
      return;
    }
    if (drag.set && drag.set.length > 1) {
      dropSet(drag.set, at);
      return;
    }
    const head = asLayerClipart(drag.asset);
    // A gốc brings its đa sắc as the group's options, hidden: the customer sees exactly the dragged picture
    // until they are switched on in the inspector. Its vật liệu versions come along for the "rendition" display.
    const members = drag.asset.parent_id === null ? drag.family.filter((a) => a.role === "variant" && a.parent_id === drag.asset.id) : [];
    const family = [head, ...drag.family.filter((a) => a.id !== head.id && (a.role === "rendition" || members.includes(a)))];
    setAssets((list) => {
      const have = new Set(list.map((a) => a.id));
      return [...list, ...family.filter((a) => !have.has(a.id))];
    });
    keepAsDragged([head.id]);
    const p = at ?? { x: main.width / 2, y: main.height / 2 };
    const hit = [...regions].reverse().find((r) => r.kind === "image" && pointInShape(p, r.shape));
    if (hit) {
      placeInto(hit, head, false, members.map((m) => m.id));
      return;
    }
    const size = Math.round(Math.min(main.width, main.height) * 0.3);
    const x = Math.round(Math.min(Math.max(p.x - size / 2, 0), main.width - size));
    const y = Math.round(Math.min(Math.max(p.y - size / 2, 0), main.height - size));
    const layer = makeRegion(product?.id ?? "", "image", { type: "rect", x, y, w: size, h: size, radius: 0 }, regions.length);
    placeInto({ ...layer, name: head.name || layer.name }, head, true, members.map((m) => m.id));
    setEditTarget("region");
    setTool("select");
  };

  /**
   * A set of pictures dragged together: ONE custom layer whose options are the pictures (each a group of the
   * layer, its đa sắc hidden), the first shown by default. Dropped on a custom layer, they join it.
   */
  const dropSet = (set: NonNullable<CtClipartDrag["set"]>, at: CtPoint | null) => {
    if (!main || !product) return;
    const heads = set.map((d) => asLayerClipart(d.asset));
    const extra = set.flatMap((d) => {
      const members = d.asset.parent_id === null ? d.family.filter((a) => a.role === "variant" && a.parent_id === d.asset.id) : [];
      return d.family.filter((a) => a.id !== d.asset.id && (a.role === "rendition" || members.includes(a)));
    });
    const hidden = set.flatMap((d) => (d.asset.parent_id === null ? d.family.filter((a) => a.role === "variant" && a.parent_id === d.asset.id).map((a) => a.id) : []));
    setAssets((list) => {
      const have = new Set(list.map((a) => a.id));
      return [...list, ...[...heads, ...extra].filter((a) => !have.has(a.id) && have.add(a.id))];
    });
    keepAsDragged(heads.map((h) => h.id));
    const p = at ?? { x: main.width / 2, y: main.height / 2 };
    const hit = [...regions].reverse().find((r) => r.kind === "image" && pointInShape(p, r.shape));
    const size = Math.round(Math.min(main.width, main.height) * 0.3);
    const first = heads[0];
    const box = fitAspect(
      { x: Math.min(Math.max(p.x - size / 2, 0), main.width - size), y: Math.min(Math.max(p.y - size / 2, 0), main.height - size), w: size, h: size },
      first.width,
      first.height,
    );
    const layer = hit ?? { ...makeRegion(product.id, "image", { type: "rect", x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h), radius: 0 }, regions.length), name: `Bộ ${heads.length} ảnh` };
    const have = new Set(items.filter((i) => i.region_id === layer.id).map((i) => i.asset_id));
    const start = items.filter((i) => i.region_id === layer.id).length;
    const fresh = heads.filter((h) => !have.has(h.id));
    const newItems = fresh.map((h, i) => makeItem(layer.id, h.id, start + i));
    ed.commit((s) => {
      const regionsNow = hit ? s.regions : [...s.regions, layer];
      return {
        ...s,
        regions: regionsNow.map((x) => {
          if (x.id !== layer.id) return x;
          const n = normalizeRegion(x);
          return { ...n, config: { ...n.config, image: { ...n.config.image, label: hit ? n.config.image.label : "Choose style", hiddenAssetIds: [...new Set([...n.config.image.hiddenAssetIds, ...hidden])] } } };
        }),
        items: [...s.items, ...newItems],
      };
    });
    setSelectedRegionId(layer.id);
    setActiveItemId(newItems[0]?.id ?? null);
    if (!hit) setSelection((sel) => ({ ...sel, [layer.id]: { kind: "image", assetId: first.id } }));
    setEditTarget("region");
    setTool("select");
    flash(`${hit ? "Thêm" : "Tạo custom layer với"} ${fresh.length} ảnh — khách chọn 1 trong bộ (không sửa). Nhớ Lưu thiết kế`);
  };

  /**
   * Material display "rendition" swaps a clipart for its vật liệu version — not one dragged in: the product shows
   * exactly the picture that was picked (config.material.flatIds).
   */
  const keepAsDragged = (ids: string[]) => {
    if (!ids.length) return;
    design.commit((s) => {
      const m = s.config.material;
      if (m.display !== "rendition" || ids.every((id) => m.flatIds.includes(id))) return s;
      return { ...s, config: { ...s.config, material: { ...m, flatIds: [...new Set([...m.flatIds, ...ids])] } } };
    });
  };

  /** A library picture becomes a version of this product, as it is (dropped on the Version column, or picked with "+"). */
  const addLibraryMain = async (pick: CtClipartDrag): Promise<boolean> => {
    if (!product) return false;
    const { asset } = pick;
    if (assets.some((a) => a.id === asset.id && a.role === "main")) {
      flash("Version này đã có trong sản phẩm");
      return false;
    }
    if (assets.some((a) => a.id === asset.id && a.role === "variant" && mains.some((m) => m.id === a.parent_id))) {
      flash("Ảnh này đang là option con của 1 version — bỏ option đó trước");
      return false;
    }
    try {
      const res = await ctApi.linkMain(product.id, asset.id);
      // Already used as a layer clipart: it now reads as the version it also is.
      setAssets((list) => {
        const fresh = new Map(res.assets.map((a) => [a.id, a]));
        const have = new Set(list.map((a) => a.id));
        const extra = [asVersion(asset), ...pick.family.filter((a) => a.role === "rendition" && a.parent_id === asset.id)];
        const added = [...res.assets, ...extra.filter((a) => !fresh.has(a.id))];
        return [...list.map((a) => fresh.get(a.id) ?? a), ...added.filter((a) => !have.has(a.id))];
      });
      keepAsDragged([asset.id]);
      // Another shape than the artboard: its frame starts contain-fitted (no stretching) — move / resize it after.
      const board = assets.find((a) => a.id === product.main_asset_id);
      if (board && Math.abs(asset.width / asset.height - board.width / board.height) > 0.01) {
        const frame = fitMainFrame(asset.width, asset.height, board.width, board.height);
        design.commit((s) => ({ ...s, config: { ...s.config, layouts: { ...s.config.layouts, [asset.id]: { ...(s.config.layouts[asset.id] ?? { regions: {}, items: {} }), frame } } } }));
      }
      if (!product.main_asset_id) setProduct({ ...product, main_asset_id: res.main_asset_id, thumbnail_url: asset.url });
      // More than one version: let the customer pick.
      else if (!config.main.enabled) setMainConfig({ enabled: true });
      flash("Đã thêm version từ thư viện");
      return true;
    } catch (e) {
      flash(e instanceof Error ? e.message : "Lỗi");
      return false;
    }
  };

  /** A clipart dropped into the blank version slot (or onto the column): a new version, shown at once. */
  const addVersionFromDrop = async (drag: CtClipartDrag) => {
    if (!(await addLibraryMain(drag))) return;
    setBlank(false);
    setBlankShown(false);
    showVersion(drag.asset.id);
  };

  /** The shown version's picture frame on the artboard (CtMainLayout.frame). */
  const setMainFrame = (frame: CtMainFrame) => {
    if (!shownMainId) return;
    design.commit((s) => ({ ...s, config: { ...s.config, layouts: { ...s.config.layouts, [shownMainId]: { ...(s.config.layouts[shownMainId] ?? { regions: {}, items: {} }), frame } } } }));
  };

  // A layer selected → the main frame no longer is.
  useEffect(() => {
    if (selectedRegionId) setMainSelected(false);
  }, [selectedRegionId]);

  /** A version's sub-options ("Thêm option"), in order. */
  const setSubOptions = (mainId: string, ids: string[]) =>
    design.commit((s) => {
      const rest = s.config.main.subOptions.filter((e) => e.mainId !== mainId);
      const subOptions = ids.length ? [...rest, { mainId, ids }] : rest;
      return { ...s, config: { ...s.config, main: { ...s.config.main, subOptions } } };
    });

  const addSubOptions = (version: CtAsset, picks: CtAsset[]) => {
    setOptionsFor(null);
    // One role per picture in a product: not a version, another version's option, or a layer's clipart already.
    const taken = new Set([...mains.map((m) => m.id), ...config.main.subOptions.flatMap((e) => e.ids), ...design.state.items.map((i) => i.asset_id)]);
    const fresh = picks.filter((a) => !taken.has(a.id));
    if (!fresh.length) return flash("Các ảnh này đã có trong sản phẩm (version, option khác hoặc layer)");
    const current = config.main.subOptions.find((e) => e.mainId === version.id)?.ids ?? [];
    setSubOptions(version.id, [...current, ...fresh.map((a) => a.id)]);
    setAssets((list) => [...list.filter((a) => !fresh.some((f) => f.id === a.id)), ...fresh.map((a) => asMainOption(a, version.id))]);
    keepAsDragged(fresh.map((a) => a.id));
    if (!config.main.enabled) setMainConfig({ enabled: true });
    flash(`Đã thêm ${fresh.length} option cho “${version.name || "version"}” — nhớ Lưu thiết kế`);
  };

  const removeSubOption = (version: CtAsset, option: CtAsset) => {
    const current = config.main.subOptions.find((e) => e.mainId === version.id)?.ids ?? [];
    setSubOptions(version.id, current.filter((id) => id !== option.id));
    // Still used elsewhere in the product (a layer clipart): keep it, as that.
    if (!items.some((i) => i.asset_id === option.id)) setAssets((list) => list.filter((a) => a.id !== option.id));
    setSelection((sel) => {
      const m = sel[CT_MAIN_KEY];
      return m?.kind === "main" && m.optionId === option.id ? { ...sel, [CT_MAIN_KEY]: { ...m, optionId: null } } : sel;
    });
  };

  /** Show version `version` on the canvas with one of its pictures (null = itself). */
  const showOption = (version: CtAsset, optionId: string | null) => {
    if (version.id !== shownMainId) showVersion(version.id);
    setSelection((sel) => ({ ...sel, [CT_MAIN_KEY]: { kind: "main", assetId: version.id, optionId } }));
  };

  const previewAsset = (asset: CtAsset) => {
    if (asset.role === "main") {
      setSelection((sel) => ({ ...sel, [CT_MAIN_KEY]: { kind: "main", assetId: asset.id } }));
      return;
    }
    const version = asset.role === "variant" ? mains.find((m) => m.id === asset.parent_id) : undefined;
    if (version) return showOption(version, asset.id);
    const subId = asset.role === "variant" ? asset.parent_id : asset.id;
    const hits = items.filter((i) => i.asset_id === subId);
    if (hits.length === 0) return;
    setSelection((sel) => {
      const next = { ...sel };
      for (const h of hits) next[h.region_id] = { kind: "image", assetId: asset.id };
      return next;
    });
  };

  const rename = async (asset: CtAsset, name: string) => {
    try {
      const updated = await ctApi.updateAsset(asset.id, { name });
      setAssets((a) => a.map((x) => (x.id === updated.id ? updated : x)));
    } catch (e) {
      flash(e instanceof Error ? e.message : "Lỗi");
    }
  };

  const saveComposites = async (list: Array<{ blob: Blob; selection: CtSelection }>): Promise<CtAsset[]> => {
    if (!product) return [];
    const created: CtAsset[] = [];
    try {
      for (const [i, c] of list.entries()) {
        // Customer photo blob: URLs mean nothing outside this tab.
        const sel: CtSelection = {};
        for (const [k, v] of Object.entries(c.selection)) sel[k] = v.kind === "photo" ? { ...v, url: null } : v;
        created.push(
          await ctApi.uploadAsset(product.id, c.blob, { role: "composite", name: `Tổ hợp ${assets.filter((a) => a.role === "composite").length + i + 1}`, meta: { selection: sel } }),
        );
      }
      setAssets((a) => [...a, ...created]);
    } catch (e) {
      setAssets((a) => [...a, ...created]);
      flash(e instanceof Error ? e.message : "Lưu artwork thất bại");
    }
    return created;
  };

  const renameProduct = async (name: string) => {
    if (!product) return;
    const clean = name.trim();
    if (!clean || clean === product.name) {
      setNameDraft(product.name);
      return;
    }
    setProduct({ ...product, name: clean });
    try {
      setProduct(await ctApi.updateProduct(product.id, { name: clean }));
    } catch (e) {
      flash(e instanceof Error ? e.message : "Lỗi");
    }
  };

  // ---------------------------------------------------------------- render
  if (loadError) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <p className="text-sm text-destructive">{loadError}</p>
        <Link href={CT_CONFIG.basePath} className="text-sm underline">
          Quay lại danh sách
        </Link>
      </div>
    );
  }
  if (!product) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  const selectedRegion = regions.find((r) => r.id === selectedRegionId);
  const navTools: Array<{ id: StageTool; icon: typeof Square; label: string; keys: string[] }> = [
    { id: "select", icon: MousePointer2, label: "Chọn / di chuyển", keys: ["V"] },
    { id: "hand", icon: Hand, label: "Kéo khung nhìn", keys: ["H"] },
  ];
  const frameTools: Array<{ id: StageTool; icon: typeof Square; label: string; keys: string[] }> = [
    { id: "rect", icon: Square, label: "Khung chữ nhật", keys: ["R"] },
    { id: "ellipse", icon: Circle, label: "Khung tròn / ellipse", keys: ["O"] },
    { id: "polygon", icon: Pentagon, label: "Khung đa giác — chấm điểm", keys: ["P"] },
  ];
  const drawing = tool === "rect" || tool === "ellipse" || tool === "polygon";
  const kinds: Array<{ id: DrawKind; icon: typeof Square; label: string; keys: string[] }> = [
    { id: "text", icon: Type, label: "Text — khách nhập / chọn chữ · kéo để tạo khung", keys: ["T"] },
    { id: "photo", icon: UserSquare, label: "Ảnh khách — khách upload ảnh · kéo để tạo khung", keys: ["U"] },
  ];
  const centers: Array<{ axis: CenterAxis; text: string; label: string; keys: string[] }> = [
    { axis: "x", text: "CX", label: "Canh vào trục X giữa main (dịch lên / xuống)", keys: ["C", "X"] },
    { axis: "y", text: "CY", label: "Canh vào trục Y giữa main (dịch trái / phải)", keys: ["C", "Y"] },
    { axis: "xy", text: "CC", label: "Canh giữa main theo cả X và Y", keys: ["C", "C"] },
  ];
  // Image layer: its items. Photo zone: the child frame the customer's photo goes in.
  const objectModeDisabled = selectedRegion?.kind === "photo" ? false : selectedRegion?.kind !== "image" || !items.some((i) => i.region_id === selectedRegionId);

  return (
    <CtTooltipProvider>
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Header */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <CtTooltip label="Danh sách sản phẩm">
          <Link href={CT_CONFIG.basePath} className="shrink-0 rounded p-1.5 hover:bg-accent">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </CtTooltip>
        <CtAutoWidthInput
          className="text-sm font-semibold"
          value={nameDraft}
          maxWidth={380}
          onChange={setNameDraft}
          onCommit={(v) => void renameProduct(v)}
        />
        {product.published_version ? (
          <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-medium text-emerald-600">v{product.published_version}</span>
        ) : (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">Chưa publish</span>
        )}
        <div className="ml-3 flex shrink-0 rounded-md border p-0.5">
          {(
            [
              ["design", "Thiết kế"],
              ["preview", "Xem trước"],
              ["mockup", "Tổ hợp"],
            ] as Array<[View, string]>
          ).map(([v, label]) => (
            <button
              key={v}
              onClick={() => openView(v)}
              className={cx("whitespace-nowrap rounded px-3 py-1 text-xs font-medium", view === v ? "bg-foreground text-background" : "hover:bg-accent")}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {notice && <span className="max-w-60 truncate text-xs text-muted-foreground">{notice}</span>}
          <CtTooltip label="Hoàn tác" shortcut={["⌘", "Z"]}>
            <span>
              <CtButton size="icon" variant="ghost" onClick={design.undo} disabled={!design.canUndo}>
                <Undo2 className="h-4 w-4" />
              </CtButton>
            </span>
          </CtTooltip>
          <CtTooltip label="Làm lại" shortcut={["⇧", "⌘", "Z"]}>
            <span>
              <CtButton size="icon" variant="ghost" onClick={design.redo} disabled={!design.canRedo}>
                <Redo2 className="h-4 w-4" />
              </CtButton>
            </span>
          </CtTooltip>
          <CtTooltip label="Lưu thiết kế" shortcut={["⌘", "S"]}>
            <CtButton variant={design.dirty ? "primary" : "outline"} size="sm" onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              {design.dirty ? "Lưu thiết kế" : "Đã lưu"}
            </CtButton>
          </CtTooltip>
          <CtTooltip label="Thông số phôi in (acrylic, sứ, nhôm, gỗ…) + xuất file in và đường cắt laser">
            <CtButton size="sm" variant="outline" onClick={() => setMaterialOpen(true)} disabled={!main}>
              <Printer className="h-3.5 w-3.5" /> File in
            </CtButton>
          </CtTooltip>
          <CtTooltip label="Deploy sản phẩm lên Shopify: bảng giá (Size / Pack), variants, ảnh + template custom">
            <CtButton size="sm" variant="outline" onClick={() => void openDeploy()} disabled={!main || deploying}>
              {deploying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />} Deploy sản phẩm
            </CtButton>
          </CtTooltip>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Left: assets */}
        <aside className="w-72 shrink-0 border-r">
          <AssetPanel
            assets={assets}
            mainAssetId={product.main_asset_id}
            libraryVersion={libraryVersion}
            onDelete={removeAsset}
            onSetMain={setMain}
            onRename={rename}
            onPreview={previewAsset}
            mainConfig={config.main}
            onMainConfig={setMainConfig}
            layerCounts={layerCounts}
            shownMainId={shownMainId}
            shownMainImageId={shownMainImageId}
            onAddOptions={setOptionsFor}
            onRemoveOption={removeSubOption}
            onShowOption={showOption}
          />
        </aside>

        {/* Center */}
        <main className="flex min-w-0 flex-1 flex-col">
          {view === "design" ? (
            <div className="flex min-h-0 flex-1">
              {/* Vertical tool rail */}
              <div className="flex w-14 shrink-0 flex-col items-stretch gap-0.5 overflow-y-auto border-r px-1 py-1.5">
                {navTools.map((t) => (
                  <RailButton key={t.id} label={t.label} keys={t.keys} active={tool === t.id} onClick={() => setTool(t.id)}>
                    <t.icon className="h-4 w-4" />
                  </RailButton>
                ))}
                <RailDivider />
                <RailButton label="Custom layer — thêm 1 layer trống (kéo clipart từ tab Thư viện vào), khung chính là vị trí ảnh" keys={["L"]} disabled={!main} onClick={addCustomLayer}>
                  <ImageIcon className="h-4 w-4" />
                </RailButton>
                {kinds.map((k) => (
                  <RailButton key={k.id} label={k.label} keys={k.keys} active={drawing && drawKind === k.id} disabled={!main} onClick={() => startDraw(k.id)}>
                    <k.icon className="h-4 w-4" />
                  </RailButton>
                ))}
                <RailDivider />
                {frameTools.map((t) => (
                  <RailButton key={t.id} label={t.label} keys={t.keys} active={tool === t.id} disabled={!main} onClick={() => { setTool(t.id); setEditTarget("region"); }}>
                    <t.icon className="h-4 w-4" />
                  </RailButton>
                ))}
                <RailDivider />
                {centers.map((c) => (
                  <RailButton key={c.axis} label={c.label} keys={c.keys} inlineKeys={false} disabled={!selectedRegion} onClick={() => centerSelected(c.axis)}>
                    <span className="text-[11px] font-semibold">{c.text}</span>
                  </RailButton>
                ))}
                <RailDivider />
                <RailButton
                  label={
                    objectModeDisabled
                      ? "Chế độ Object — chọn Custom layer có ít nhất 1 ảnh, hoặc 1 vùng Ảnh khách"
                      : selectedRegion?.kind === "photo"
                        ? "Chế độ Object — khung ảnh khách bên trong vùng: vị trí / kích thước / độ nghiêng"
                        : "Chế độ Object — vị trí / scale / xoay ảnh trong layer"
                  }
                  keys={["↵"]}
                  active={editTarget === "object"}
                  disabled={objectModeDisabled}
                  onClick={() => setEditTarget((t) => (t === "object" ? "region" : "object"))}
                >
                  <Move className="h-4 w-4" />
                </RailButton>
                <RailDivider />
                <RailButton label="Nền & khung main — ảnh nền phía sau, kéo / resize thiết kế trên nền" keys={[]} active={!!config.scene.url} disabled={!main} onClick={() => setSceneOpen(true)}>
                  <Wallpaper className="h-4 w-4" />
                </RailButton>
              </div>
              <div className="relative min-h-0 min-w-0 flex-1">
                {main && (
                  <div className="pointer-events-none absolute right-3 top-2 z-10 whitespace-nowrap text-[11px] text-muted-foreground">
                    Main: {main.width}×{main.height}px · {regions.length} vùng
                  </div>
                )}
                {main && (
                  <VersionRail
                    mains={mains}
                    defaultId={main.id}
                    shownId={shownMainId}
                    layerCounts={layerCounts}
                    onShow={showVersion}
                    onDropClipart={(drag) => void addVersionFromDrop(drag)}
                    blank={blank}
                    blankShown={blankShown}
                    onAdd={() => {
                      // One blank slot at most: "+" again only shows it.
                      setBlank(true);
                      setBlankShown(true);
                      setMainSelected(false);
                      setSelectedRegionId(null);
                    }}
                    onShowBlank={() => setBlankShown(true)}
                    onRemoveBlank={() => {
                      setBlank(false);
                      setBlankShown(false);
                    }}
                  />
                )}
                {main && blankShown ? (
                  // The blank version slot: an empty artboard waiting for a clipart.
                  <div
                    className="flex h-full items-center justify-center p-10"
                    onDragOver={(e) => {
                      if (!e.dataTransfer.types.includes(CLIPART_DRAG)) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "copy";
                    }}
                    onDrop={(e) => {
                      const raw = e.dataTransfer.getData(CLIPART_DRAG);
                      if (!raw) return;
                      e.preventDefault();
                      void addVersionFromDrop(JSON.parse(raw) as CtClipartDrag);
                    }}
                  >
                    <div
                      className="flex max-h-full w-full max-w-xl flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed text-center text-sm text-muted-foreground"
                      style={{ ...CHECKER_STYLE, aspectRatio: `${main.width} / ${main.height}` }}
                    >
                      <span className="rounded-md bg-background/90 px-3 py-2">
                        <b className="text-foreground">Version mới</b> — kéo 1 clipart từ tab Thư viện thả vào đây
                      </span>
                    </div>
                  </div>
                ) : main ? (
                  <Stage
                    productId={product.id}
                    main={main}
                    assets={assets}
                    design={ed}
                    selection={selection}
                    tool={tool}
                    onToolChange={setTool}
                    drawKind={drawKind}
                    editTarget={editTarget}
                    onEditTargetChange={(t) => {
                      setEditTarget(t);
                      if (t === "object" && !activeItemId) {
                        const first = items.find((i) => i.region_id === selectedRegionId);
                        if (first) setActiveItemId(first.id);
                      }
                    }}
                    selectedRegionId={selectedRegionId}
                    onSelectRegion={(id) => {
                      setSelectedRegionId(id);
                      if (id !== selectedRegionId) setActiveItemId(items.find((i) => i.region_id === id)?.id ?? null);
                    }}
                    activeItemId={activeItemId}
                    showOverlay={showOverlay}
                    photoBusy={photoBusy}
                    onDropClipart={dropClipart}
                    scene={config.scene}
                    versionId={shownMainId ?? main.id}
                    mainSelected={mainSelected}
                    onSelectMain={(on) => {
                      setMainSelected(on);
                      if (on) setEditTarget("region");
                    }}
                    onEmptyLayerClick={(regionId) => setLayerLibrary({ regionId })}
                  />
                ) : (
                  <div
                    className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground"
                    onDragOver={(e) => {
                      if (!e.dataTransfer.types.includes(CLIPART_DRAG)) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "copy";
                    }}
                    onDrop={(e) => {
                      const raw = e.dataTransfer.getData(CLIPART_DRAG);
                      if (!raw) return;
                      e.preventDefault();
                      dropClipart(JSON.parse(raw) as CtClipartDrag, null);
                    }}
                  >
                    <ImageIcon className="h-10 w-10 opacity-40" />
                    <p>Chưa có version nào.</p>
                    <p className="text-xs">Mở tab Thư viện bên trái, kéo 1 clipart (gốc, đa sắc hay vật liệu) thả vào đây.</p>
                  </div>
                )}
              </div>
            </div>
          ) : view === "preview" ? (
            main ? null : <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Cần có version trước — kéo 1 clipart từ tab Thư viện vào canvas.</div>
          ) : main ? (
            <PreviewPanel
              productId={product.id}
              main={main}
              mains={config.main.enabled ? mains : []}
              layouts={config.layouts}
              assets={assets}
              regions={allRegions}
              items={allItems}
              samples={selection}
              onSaveComposites={saveComposites}
              onAdded={(created) => setAssets((a) => [...a, ...created.filter((c) => !a.some((x) => x.id === c.id))])}
              onCreateMaterial={createMaterialFor}
              onDelete={deleteMockup}
              flash={flash}
              mockupEdit={config.mockupEdit}
              onMockupEdit={(mockupEdit) => design.commit((s) => ({ ...s, config: { ...s.config, mockupEdit } }))}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Cần có version trước — kéo 1 clipart từ tab Thư viện vào canvas.</div>
          )}
          {previewMounted && main && (
            <div className={cx("min-h-0 flex-1", view !== "preview" && "hidden")}>
              <StorefrontPreview product={product} assets={assets} regions={allRegions} items={allItems} config={config} />
            </div>
          )}
        </main>

        {/* Right: layers + properties */}
        {view === "design" && (
          <aside className="flex w-80 shrink-0 flex-col border-l">
            {main && mains.length > 1 && (
              <CopyLayersPanel
                sources={mains.filter((m) => m.id !== shownMainId && (layerCounts[m.id] ?? 0) > 0)}
                layerCounts={layerCounts}
                onCopy={(m) => void copyLayersFrom(m)}
                folded={copyPanelOff}
                onFold={(off) => {
                  setCopyPanelOff(off);
                  writeCopyPanelOff(product.id, off);
                }}
              />
            )}
            <div className="min-h-0 flex-1">
            <Inspector
              design={ed}
              assets={assets}
              selection={selection}
              mainLayer={
                main && shownMainId
                  ? {
                      asset: assets.find((a) => a.id === shownMainImageId) ?? main,
                      frame: mainFrameFor(config.layouts, shownMainId, main.width, main.height),
                      board: { w: main.width, h: main.height },
                    }
                  : null
              }
              mainSelected={mainSelected}
              onSelectMain={() => {
                setSelectedRegionId(null);
                setMainSelected(true);
                setBlankShown(false);
              }}
              onMainFrame={setMainFrame}
              onPreviewOption={(regionId, assetId) => setSelection((sel) => ({ ...sel, [regionId]: { kind: "image", assetId } }))}
              onPickLayerImage={(regionId) => setLayerLibrary({ regionId })}
              onAddChild={addChildZone}
              onZoneOption={(regionId, optionId) =>
                setSelection((sel) => {
                  const cur = sel[regionId];
                  return cur?.kind === "text" || cur?.kind === "photo" ? { ...sel, [regionId]: { ...cur, optionId } } : sel;
                })
              }
              onSetSwatch={setSwatch}
              onPhotoSelection={(regionId, sel: CtPhotoSelection) =>
                setSelection((cur) => {
                  // Free the old test photo once a new one replaces it. Styled renders
                  // stay alive: the inspector caches them per style.
                  const prev = cur[regionId];
                  const prevSource = prev?.kind === "photo" ? (prev.sourceUrl ?? prev.url) : null;
                  if (prevSource?.startsWith("blob:") && prevSource !== (sel.sourceUrl ?? sel.url)) URL.revokeObjectURL(prevSource);
                  return { ...cur, [regionId]: sel };
                })
              }
              onPhotoBusy={(regionId, label) =>
                setPhotoBusy((cur) => {
                  const next = { ...cur };
                  if (label) next[regionId] = label;
                  else delete next[regionId];
                  return next;
                })
              }
              selectedRegionId={selectedRegionId}
              onSelectRegion={(id) => {
                setSelectedRegionId(id);
                setEditTarget("region");
                // A child zone picked in Layers: show its parents on the option it belongs to.
                if (id) revealZone(id);
              }}
              frameSelected={editTarget === "object" && regions.find((r) => r.id === selectedRegionId)?.kind === "photo"}
              onSelectFrame={(id) => {
                setSelectedRegionId(id);
                setEditTarget("object");
              }}
              onRemoveFrame={removePhotoFrame}
              activeItemId={activeItemId}
              onActiveItem={(id) => {
                setActiveItemId(id);
                setEditTarget(id ? "object" : "region");
                const item = items.find((i) => i.id === id);
                if (item) setSelection((s) => ({ ...s, [item.region_id]: { kind: "image", assetId: item.asset_id } }));
              }}
              showOverlay={showOverlay}
              onToggleOverlay={() => setShowOverlay((v) => !v)}
            />
            </div>
          </aside>
        )}
      </div>

      <CtAiDialog target={ai} onClose={() => setAi(null)} onSaved={onAiSaved} onReplaced={swapLibraryAsset} />
      <ClipartPickerDialog
        version={optionsFor}
        disabledIds={new Set([...mains.map((m) => m.id), ...config.main.subOptions.flatMap((e) => e.ids), ...allItems.map((i) => i.asset_id)])}
        onClose={() => setOptionsFor(null)}
        onPick={(picks) => optionsFor && addSubOptions(optionsFor, picks)}
      />
      {main && (
        <>
          <SceneDialog
            open={sceneOpen}
            onClose={() => setSceneOpen(false)}
            scene={config.scene}
            onChange={setScene}
            main={main}
            assets={assets}
            regions={allRegions}
            items={allItems}
            selection={selection}
            layouts={config.layouts}
          />
          <PrintDialog open={materialOpen} onOpenChange={setMaterialOpen} design={design} product={product} main={main} assets={assets} selection={selection} />
        </>
      )}
      {layerLibrary && main && (
        <PackImageLibrary
          open
          onOpenChange={(o) => !o && setLayerLibrary(null)}
          onPick={(img) => void applyLayerImage(img)}
          aspect={nearestAspect(main.width, main.height)}
        />
      )}
    </div>
    </CtTooltipProvider>
  );
}

/** One rail tool: icon with its shortcut beside it; the tooltip opens to the right. */
function RailButton(props: { label: string; keys: string[]; inlineKeys?: boolean; active?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <CtTooltip label={props.label} shortcut={props.keys} side="right">
      <span className="block">
        <button
          type="button"
          disabled={props.disabled}
          onClick={props.onClick}
          className={cx(
            "flex h-8 w-full items-center justify-between gap-1 rounded-md px-1.5 text-foreground",
            props.active ? "bg-sky-500/15 text-sky-500 ring-1 ring-sky-500/60" : "hover:bg-accent",
            props.disabled && "pointer-events-none opacity-35",
          )}
        >
          {props.inlineKeys === false ? (
            <span className="flex w-full justify-center">{props.children}</span>
          ) : (
            <>
              <span className="flex w-5 justify-center">{props.children}</span>
              <span className="text-[9px] leading-none text-muted-foreground">{props.keys.join("")}</span>
            </>
          )}
        </button>
      </span>
    </CtTooltip>
  );
}

function RailDivider() {
  return <div className="mx-1.5 my-1 h-px bg-border" />;
}

/**
 * Main versions, top-left of the canvas beside the tool rail: click one to show
 * it — the canvas, Layers and properties then edit that version's own layers.
 * "+" opens ONE blank version slot (pressing it again just shows that slot): an
 * empty artboard where a clipart dragged from the library becomes the new
 * version. A clipart dropped on the column does the same.
 */
function VersionRail(props: {
  mains: CtAsset[];
  defaultId: string;
  shownId: string | null;
  layerCounts: Record<string, number>;
  onShow: (id: string) => void;
  onDropClipart: (drag: CtClipartDrag) => void;
  /** A blank version slot exists / is on the canvas. */
  blank: boolean;
  blankShown: boolean;
  onAdd: () => void;
  onShowBlank: () => void;
  onRemoveBlank: () => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={cx(
        // overflow-x hidden: 48 px tiles + padding + border are a hair wider than w-14 — no horizontal scrollbar.
        "absolute left-2 top-2 z-10 flex max-h-[calc(100%-1rem)] w-[60px] flex-col items-center gap-1.5 overflow-y-auto overflow-x-hidden rounded-lg border bg-background/90 p-1 shadow-sm backdrop-blur",
        over && "border-sky-500 ring-2 ring-sky-500/40",
      )}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(CLIPART_DRAG)) return;
        // The canvas below must not take it as a layer.
        e.preventDefault();
        e.stopPropagation();
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
        e.stopPropagation();
        props.onDropClipart(JSON.parse(raw) as CtClipartDrag);
      }}
    >
      <span className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground">Version</span>
      {props.mains.map((m) => {
        const count = props.layerCounts[m.id] ?? 0;
        return (
          <CtTooltip key={m.id} label={`${m.name || "Version"} · ${count ? `${count} layer` : "chưa có layer"}`} side="right">
            <button
              type="button"
              onClick={() => props.onShow(m.id)}
              className={cx(
                "relative block h-12 w-12 shrink-0 overflow-hidden rounded-md border",
                m.id === props.shownId && !props.blankShown ? "ring-2 ring-sky-500" : "opacity-75 hover:opacity-100",
              )}
              style={CHECKER_STYLE}
            >
              <img src={m.url} alt={m.name} className="h-full w-full object-contain" draggable={false} />
              {m.id === props.defaultId && <Crown className="absolute left-0.5 top-0.5 h-3 w-3 text-amber-500 drop-shadow" />}
              <span
                className={cx(
                  "absolute bottom-0.5 right-0.5 rounded px-1 text-[9px] font-semibold leading-tight",
                  count ? "bg-foreground/80 text-background" : "bg-muted text-muted-foreground",
                )}
              >
                {count}
              </span>
            </button>
          </CtTooltip>
        );
      })}
{props.blank && (
        <div className="group relative shrink-0">
          <CtTooltip label="Version mới (trống) — kéo 1 clipart từ tab Thư viện vào canvas" side="right">
            <button
              type="button"
              onClick={props.onShowBlank}
              className={cx("block h-12 w-12 rounded-md border border-dashed bg-muted/40", props.blankShown ? "ring-2 ring-sky-500" : "opacity-75 hover:opacity-100")}
            />
          </CtTooltip>
          <button
            type="button"
            onClick={props.onRemoveBlank}
            className="absolute -right-1 -top-1 hidden rounded-full bg-black/70 p-0.5 text-white group-hover:block"
            aria-label="Bỏ version trống"
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </div>
      )}
      <CtTooltip label="Thêm version: mở 1 ô trống, kéo clipart từ tab Thư viện vào (hoặc kéo thả thẳng vào cột này)" side="right">
        <button
          type="button"
          onClick={props.onAdd}
          className={cx(
            "flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-dashed text-muted-foreground hover:border-sky-500 hover:bg-sky-500/10 hover:text-sky-500",
            over && "border-sky-500 bg-sky-500/10 text-sky-500",
          )}
        >
          <Plus className="h-4 w-4" />
        </button>
      </CtTooltip>
    </div>
  );
}

/** Right column: copy every layer of another version into the shown one — one click per card. Foldable. */
function CopyLayersPanel(props: { sources: CtAsset[]; layerCounts: Record<string, number>; onCopy: (m: CtAsset) => void; folded: boolean; onFold: (folded: boolean) => void }) {
  return (
    <div className="shrink-0 border-b px-3 py-2">
      <button type="button" onClick={() => props.onFold(!props.folded)} className="flex w-full items-center gap-1.5 text-left">
        {props.folded ? <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
        <Copy className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-semibold">Sao chép layer từ version</span>
      </button>
      {props.folded ? null : props.sources.length === 0 ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">Version khác chưa có layer nào để sao chép.</p>
      ) : (
        <div className="mt-1.5 grid max-h-44 grid-cols-3 gap-1.5 overflow-y-auto">
          {props.sources.map((m) => (
            <CtTooltip key={m.id} label={`Sao chép ${props.layerCounts[m.id] ?? 0} layer của “${m.name || "version"}” vào version đang sửa`}>
              <button type="button" onClick={() => props.onCopy(m)} className="group rounded-md border p-1 text-left hover:border-sky-500 hover:bg-sky-500/5">
                <span className="block aspect-square overflow-hidden rounded" style={CHECKER_STYLE}>
                  <img src={m.url} alt={m.name} className="h-full w-full object-contain" draggable={false} />
                </span>
                <span className="mt-0.5 block truncate text-[11px] font-medium">{m.name || "Version"}</span>
                <span className="block text-[10px] text-muted-foreground">{props.layerCounts[m.id] ?? 0} layer</span>
              </button>
            </CtTooltip>
          ))}
        </div>
      )}
    </div>
  );
}
