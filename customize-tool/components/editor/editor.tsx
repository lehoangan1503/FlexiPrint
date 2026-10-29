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
  Hand,
  Users,
  ImageIcon,
  Loader2,
  MousePointer2,
  Move,
  Redo2,
  Rocket,
  Save,
  Square,
  Type,
  Undo2,
  UserSquare,
} from "lucide-react";
import { CT_CONFIG, ctGoogleFontsHref } from "../../config";
import { CT_BASE_OPTION, CT_MAIN_KEY } from "../../types";
import type { CtAsset, CtProductCharSet, CtMainFrame, CtMainOptionConfig, CtPhotoSelection, CtPoint, CtProductScene, CtProduct, CtRegion, CtRegionItem, CtSelection } from "../../types";
import { charApi, ctApi } from "../../lib/api-client";
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
import { fitShapeToBounds, IDENTITY_PHOTO_FRAME, IDENTITY_TRANSFORM, newId, shapeBounds, translateShape } from "../../lib/geometry";
import { CtAutoWidthInput, CtButton, CtTooltip, CtTooltipProvider, cx } from "../ui";
import { Stage, type EditTarget, type StageTool } from "./stage";
import { Inspector } from "./inspector";
import { AssetPanel } from "./asset-panel";
import { AiMockupsPanel } from "./ai-mockups";
import { SceneDialog } from "./scene-dialog";
import { StorefrontPreview } from "./storefront-preview";
import { activeZoneOptions, updateItem, updateRegion, useDesign, versionView, zoneOptionView } from "./use-design";
import { PrintDialog } from "./print-dialog";
import { PrintPanel } from "./print-panel";
import { CLIPART_DRAG, isCharSetDrag, type CtCharSetDrag, type CtClipartDrag, type CtLibraryDrag } from "./library-panel";
import { ctConfirm } from "../dialogs";
import { asLayerClipart, asVersion } from "../../lib/library";
import { claimSharedLayers, cloneLayers, fitMainFrame, mainFrameFor, versionLayers } from "../../lib/layout";
import { charSetDrop } from "../../lib/char-set-layers";
import { useArtworkSaver } from "./artwork-saver";
import { frameRegionFor } from "../../lib/material-frame";

/**
 * Thiết kế = edit, flat (what is printed — no phôi) · File in = the flat print file · Xem trước = the real storefront
 * page, the artwork on the phôi trơn · Mockups = AI photos of the finished product on its phôi.
 */
type View = "design" | "preview" | "print" | "mockup";


/** Kinds drawn with a frame tool. A custom layer comes from a dropped clipart instead: its frame is the image itself. */
type DrawKind = "text" | "photo";
type CenterAxis = "x" | "y" | "xy";

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
  /** The layer the mouse is over in Layers: its frame shows on the canvas (other frames stay hidden). */
  const [hoverRegionId, setHoverRegionId] = useState<string | null>(null);
  const [materialOpen, setMaterialOpen] = useState(false);
  const [sceneOpen, setSceneOpen] = useState(false);

  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** The shown version's picture frame is selected (moved / resized on the canvas, numbers in the right column). */
  const [mainSelected, setMainSelected] = useState(false);
  /** A bộ nhân vật picked as a whole (its layers' ids): one frame on the canvas moves / scales them all. */
  const [setPick, setSetPick] = useState<string[] | null>(null);

  /** The bộ nhân vật this product uses (built from it first) — the header's "Bộ nhân vật" button opens it. */
  const [charSets, setCharSets] = useState<CtProductCharSet[]>([]);

  // ---------------------------------------------------------------- load
  useEffect(() => {
    ctApi
      .getBundle(productId)
      .then((b) => {
        setProduct(b.product);
        setNameDraft(b.product.name);
        setAssets(b.assets);
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
  /** The layers of the bộ nhân vật `id` belongs to on the shown version (null: not a set's). */
  const setOf = (id: string): string[] | null => {
    const set = regions.find((r) => r.id === id)?.config?.charSet?.projectId;
    return set ? regions.filter((r) => r.config?.charSet?.projectId === set).map((r) => r.id) : null;
  };
  const selectedSet = setPick && regions.some((r) => setPick.includes(r.id)) ? setPick.filter((id) => regions.some((r) => r.id === id)) : null;
  const selectSet = (ids: string[]) => {
    setSelectedRegionId(null);
    setActiveItemId(null);
    setEditTarget("region");
    setMainSelected(false);
    setSetPick(ids);
  };
  // The khuôn vật liệu the shown version is cut to: its own, else the default version's.
  const materialFrame = useMemo(
    () => (main ? frameRegionFor(design.state.regions.map(normalizeRegion), shownMainId, main.id) : null),
    [design.state.regions, shownMainId, main],
  );
  /** Bộ nhân vật the product's layers come from (CtRegionConfig.charSet). */
  const usedSets = useMemo(() => new Set(design.state.regions.flatMap((r) => (r.config?.charSet ? [r.config.charSet.projectId] : []))), [design.state.regions]);
  // Looked up again when a set is dropped in or taken out (the server reads the saved layers).
  const usedKey = [...usedSets].sort().join(",");
  useEffect(() => {
    charApi
      .ofProduct(productId)
      .then(setCharSets)
      .catch(() => setCharSets([]));
  }, [productId, usedKey]);
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
  /** Every version of the product as an artwork in its library folder (saved with the design). */
  const artworks = useArtworkSaver({ product, main, mains, assets, regions: allRegions, items: allItems, config, selection, onError: (m) => flash(m) });
  const saveArtworks = artworks.saveAll;
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
  // so the Mockups frames draw the finished artwork. Test photos are blob: URLs here — stored once on the way out.
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
      // Every version is an artwork in the product's folder of the library (in the background).
      saveArtworks();
      return true;
    } catch (e) {
      setNotice(e instanceof Error ? `Lỗi lưu: ${e.message}` : "Lỗi lưu");
      return false;
    } finally {
      setSaving(false);
    }
  }, [product, design, saveArtworks]);

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
      if (k === "t") startDraw("text");
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
        setSetPick(null);
      } else if ((e.key === "Delete" || e.key === "Backspace") && tool !== "polygon" && !selectedRegionId && selectedSet) {
        e.preventDefault();
        const gone = new Set(selectedSet.flatMap((id) => [...zoneSubtree(regions, id)]));
        ed.commit((s) => ({ ...s, regions: s.regions.filter((r) => !gone.has(r.id)), items: s.items.filter((i) => !gone.has(i.region_id)) }));
        setSetPick(null);
      } else if (e.key.startsWith("Arrow") && !selectedRegionId && selectedSet) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        ed.commit((s) => ({ ...s, regions: s.regions.map((r) => (selectedSet.includes(r.id) ? { ...r, shape: translateShape(r.shape, dx, dy) } : r)) }));
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

  /** A main version leaves the product: its own layers go with it. */
  const dropVersionLayers = (mainId: string) => {
    const gone = new Set(design.state.regions.filter((r) => r.config?.mainId === mainId).map((r) => r.id));
    if (!gone.size) return;
    design.commit((s) => ({ ...s, regions: s.regions.filter((r) => !gone.has(r.id)), items: s.items.filter((i) => !gone.has(i.region_id)) }));
    if (selectedRegionId && gone.has(selectedRegionId)) setSelectedRegionId(null);
  };

  /** Show (and edit) main version `id` on the canvas. */
  const showVersion = (id: string) => {
    setMainSelected(false);
    if (id === shownMainId) return;
    setSelection((sel) => ({ ...sel, [CT_MAIN_KEY]: { kind: "main", assetId: id } }));
    setSelectedRegionId(null);
    setActiveItemId(null);
    setEditTarget("region");
    setSetPick(null);
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
   * version; otherwise it is ALWAYS a new layer of its own (asked 2026-10-10: a clipart dropped on a layer must not
   * join it), its frame the picture's own outline centred where it was dropped. (A new version is dropped on the
   * Version column instead.)
   */
  const dropClipart = (drag: CtLibraryDrag, at: CtPoint | null) => {
    if (isCharSetDrag(drag)) {
      if (!main || !shownMainId) flash("Sản phẩm chưa có version — thêm version trước rồi kéo bộ vào");
      else void dropCharSet(drag.charSet, shownMainId);
      return;
    }
    if (!main) {
      void addLibraryMain(drag);
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
    const box = dropBox(head, at);
    const layer = makeRegion(product?.id ?? "", "image", { type: "rect", ...box, radius: 0 }, regions.length);
    placeInto({ ...layer, name: head.name || layer.name }, head, true, members.map((m) => m.id));
    setEditTarget("region");
    setTool("select");
  };

  /**
   * Where a dropped clipart's frame goes (artboard px): its own pixel size when it fits the artboard (a v2 layer file,
   * an artwork: exactly the frame), else contain-fitted into it — centred on the drop point, kept on the artboard.
   */
  const dropBox = (a: CtAsset, at: CtPoint | null): { x: number; y: number; w: number; h: number } => {
    if (!main) return { x: 0, y: 0, w: a.width, h: a.height };
    const k = Math.min(1, main.width / Math.max(1, a.width), main.height / Math.max(1, a.height));
    const w = Math.max(1, Math.round(a.width * k));
    const h = Math.max(1, Math.round(a.height * k));
    const p = at ?? { x: main.width / 2, y: main.height / 2 };
    // Full-size pictures land exactly on the artboard.
    const x = w >= main.width ? 0 : Math.round(Math.min(Math.max(p.x - w / 2, 0), main.width - w));
    const y = h >= main.height ? 0 : Math.round(Math.min(Math.max(p.y - h / 2, 0), main.height - h));
    return { x, y, w, h };
  };

  /** The buttons of a several-version set's chooser: empty pictures named after its versions (the first a gốc, the
   * others its đa sắc — the options), as server/char/product.ts makes a brief's choosers. */
  const uploadChooser = async (names: string[]): Promise<CtAsset[]> => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 8;
    const blank = await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("Không tạo được ảnh trống"))), "image/png"));
    const out: CtAsset[] = [];
    for (const name of names) out.push(await ctApi.uploadClipart(blank, { categoryId: null, parentId: out[0]?.id ?? null, name, source: "ai" }));
    return [asLayerClipart(out[0]), ...out.slice(1)];
  };

  /**
   * A bộ nhân vật v2 dropped on the canvas (asked 2026-10-29): its product's layers become the layers of version
   * `mainId`, tagged as one "bộ" layer (lib/char-set-layers.ts); a set of several versions (Boy / Girl) becomes options
   * of this version. A version holds one bộ: dropping another replaces the one there (a version copied with "+" swaps
   * its bộ this way) — ⌘Z brings it back.
   */
  const dropCharSet = async (set: CtCharSetDrag["charSet"], mainId: string) => {
    if (!product || !main) return;
    setNotice(`Đang lấy layer của bộ “${set.name}”…`);
    try {
      const bundle = await ctApi.getBundle(set.productId);
      const got = await charSetDrop(bundle, { productId: product.id, mainId, board: { w: main.width, h: main.height }, firstOrder: 0 }, { projectId: set.projectId, name: set.name }, uploadChooser);
      if (!got.regions.length) {
        flash(`Bộ “${set.name}” không có layer dùng được`);
        return;
      }
      setAssets((list) => {
        const have = new Set(list.map((a) => a.id));
        return [...list, ...got.assets.filter((a) => !have.has(a.id))];
      });
      // Read inside the commit: a version "+" just made is already in the state there.
      let old = new Set<string>();
      design.commit((s) => {
        old = new Set(s.regions.filter((r) => r.config?.mainId === mainId && r.config?.charSet).map((r) => r.id));
        const keep = s.regions.filter((r) => !old.has(r.id));
        return {
          ...s,
          regions: [...keep, ...got.regions.map((r, i) => ({ ...r, sort_order: keep.length + i }))],
          items: [...s.items.filter((i) => !old.has(i.region_id)), ...got.items],
        };
      });
      if (selectedRegionId && old.has(selectedRegionId)) setSelectedRegionId(null);
      setEditTarget("region");
      setTool("select");
      flash(
        `${old.size ? "Đã thay bằng" : "Đã thêm"} bộ “${set.name}”: ${got.regions.length} layer${got.skipped ? ` (bỏ ${got.skipped} layer dùng ảnh riêng của sản phẩm bộ)` : ""} — nhớ Lưu thiết kế`,
      );
    } catch (e) {
      flash(e instanceof Error ? e.message : "Không lấy được bộ");
    }
  };

  /**
   * "+" in the Version column: the shown version copied — its picture (uploaded again: a version is one asset) and
   * its layers — as a new version, shown at once. With `set` the copy gets that bộ nhân vật instead of the one it had.
   */
  const cloneVersion = async (set?: CtCharSetDrag["charSet"]) => {
    if (!product || !shownMainId) return;
    const src = assets.find((a) => a.id === shownMainId);
    if (!src) return;
    setNotice("Đang nhân bản version…");
    try {
      const res = await fetch(src.url, { mode: "cors" });
      if (!res.ok) throw new Error(`Không tải được ảnh version (HTTP ${res.status})`);
      const copy = await ctApi.uploadAsset(product.id, await res.blob(), { role: "main", name: set ? set.name : `${src.name || "Version"} (bản sao)` });
      setAssets((list) => [...list, copy]);
      design.commit((s) => {
        const own = versionLayers(s.regions, s.items, src.id);
        const cloned = cloneLayers(own.regions, own.items, copy.id);
        const frame = s.config.layouts[src.id]?.frame;
        return {
          ...s,
          regions: [...s.regions, ...cloned.regions.map((r, i) => ({ ...r, sort_order: s.regions.length + i }))],
          items: [...s.items, ...cloned.items],
          config: {
            ...s.config,
            // More than one version: the customer picks.
            main: { ...s.config.main, enabled: true },
            layouts: frame ? { ...s.config.layouts, [copy.id]: { regions: {}, items: {}, frame } } : s.config.layouts,
          },
        };
      });
      setSelection((sel) => ({ ...sel, [CT_MAIN_KEY]: { kind: "main", assetId: copy.id } }));
      setSelectedRegionId(null);
      setActiveItemId(null);
      setMainSelected(false);
      if (set) await dropCharSet(set, copy.id);
      else flash("Đã nhân bản version — kéo bộ nhân vật khác lên canvas để đổi bộ, nhớ Lưu thiết kế");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Không nhân bản được");
    }
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

  /** Dropped onto the version list: a bộ nhân vật = a copy of the shown version with that bộ; an artwork = a new
   * version as it is. Shown at once. */
  const addVersionFromDrop = async (drag: CtLibraryDrag) => {
    if (isCharSetDrag(drag)) {
      if (shownMainId) await cloneVersion(drag.charSet);
      else flash("Sản phẩm chưa có version — thêm version trước");
      return;
    }
    if (await addLibraryMain(drag)) showVersion(drag.asset.id);
  };

  /** The shown version's picture frame on the artboard (CtMainLayout.frame). */
  const setMainFrame = (frame: CtMainFrame) => {
    if (!shownMainId) return;
    design.commit((s) => ({ ...s, config: { ...s.config, layouts: { ...s.config.layouts, [shownMainId]: { ...(s.config.layouts[shownMainId] ?? { regions: {}, items: {} }), frame } } } }));
  };

  // A layer selected → the main frame / a set no longer is.
  useEffect(() => {
    if (selectedRegionId) {
      setMainSelected(false);
      setSetPick(null);
    }
  }, [selectedRegionId]);

  /** A version's sub-options ("Thêm option"), in order. */
  const setSubOptions = (mainId: string, ids: string[]) =>
    design.commit((s) => {
      const rest = s.config.main.subOptions.filter((e) => e.mainId !== mainId);
      const subOptions = ids.length ? [...rest, { mainId, ids }] : rest;
      return { ...s, config: { ...s.config, main: { ...s.config.main, subOptions } } };
    });

  const rename = async (asset: CtAsset, name: string) => {
    try {
      const updated = await ctApi.updateAsset(asset.id, { name });
      setAssets((a) => a.map((x) => (x.id === updated.id ? updated : x)));
    } catch (e) {
      flash(e instanceof Error ? e.message : "Lỗi");
    }
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
  const drawing = tool === "rect" || tool === "ellipse" || tool === "polygon";
  const kinds: Array<{ id: DrawKind; icon: typeof Square; label: string; keys: string[] }> = [
    { id: "text", icon: Type, label: "Thêm chữ — kéo khung trên canvas", keys: ["T"] },
    { id: "photo", icon: UserSquare, label: "Thêm ảnh khách — kéo khung trên canvas", keys: ["U"] },
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
              ["print", "File in"],
              ["mockup", "Mockups"],
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
        {charSets.map((cs) => (
          <CtTooltip key={cs.id} label={`${cs.own ? "Bộ nhân vật dựng sản phẩm này" : "Bộ nhân vật đã kéo vào"}: ${cs.name}`}>
            <Link
              href={`/v2/${cs.id}`}
              target="_blank"
              className="ml-2 inline-flex h-8 max-w-56 shrink-0 items-center gap-1.5 rounded-md bg-violet-600 px-3 text-xs font-semibold text-white shadow-sm hover:bg-violet-500"
            >
              <Users className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{charSets.length > 1 ? cs.name : "Bộ nhân vật"}</span>
            </Link>
          </CtTooltip>
        ))}
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
          <CtTooltip label="Đưa sản phẩm lên Shopify">
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
            onDelete={removeAsset}
            onSetMain={setMain}
            onRename={rename}
            onShow={(a) => showVersion(a.id)}
            layerCounts={layerCounts}
            shownMainId={shownMainId}
            onDropVersion={(drag) => void addVersionFromDrop(drag)}
            onCloneVersion={() => void cloneVersion()}
            usedSets={usedSets}
            versionLabel={config.main.enabled && config.main.label ? config.main.label : undefined}
          />
        </aside>

        {/* Center */}
        <main className="flex min-w-0 flex-1 flex-col">
          {view === "design" ? (
            <div className="flex min-h-0 flex-1">
              {/* Vertical tool rail */}
              <div className="flex w-11 shrink-0 flex-col items-stretch gap-0.5 overflow-y-auto border-r px-1 py-1.5">
                {navTools.map((t) => (
                  <RailButton key={t.id} label={t.label} keys={t.keys} active={tool === t.id} onClick={() => setTool(t.id)}>
                    <t.icon className="h-4 w-4" />
                  </RailButton>
                ))}
                <RailDivider />
                {kinds.map((k) => (
                  <RailButton key={k.id} label={k.label} keys={k.keys} active={drawing && drawKind === k.id} disabled={!main} onClick={() => startDraw(k.id)}>
                    <k.icon className="h-4 w-4" />
                  </RailButton>
                ))}
                <RailDivider />
                <RailButton
                  label={
                    selectedRegion?.kind === "photo" ? "Chỉnh khung ảnh khách bên trong vùng" : "Chỉnh vị trí / cỡ / xoay ảnh trong layer"
                  }
                  keys={["↵"]}
                  active={editTarget === "object"}
                  disabled={objectModeDisabled}
                  onClick={() => setEditTarget((t) => (t === "object" ? "region" : "object"))}
                >
                  <Move className="h-4 w-4" />
                </RailButton>
              </div>
              <div className="relative min-h-0 min-w-0 flex-1">
                {main ? (
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
                      setSetPick(null);
                      if (id !== selectedRegionId) setActiveItemId(items.find((i) => i.region_id === id)?.id ?? null);
                    }}
                    setOf={setOf}
                    selectedSet={selectedSet}
                    onSelectSet={selectSet}
                    activeItemId={activeItemId}
                    showOverlay={showOverlay}
                    hoverRegionId={hoverRegionId}
                    photoBusy={photoBusy}
                    onDropClipart={dropClipart}
                    versionId={shownMainId ?? main.id}
                    mainSelected={mainSelected}
                    onSelectMain={(on) => {
                      setMainSelected(on);
                      if (on) setEditTarget("region");
                    }}
                    materialFrame={materialFrame}
                    printSpec={config.print?.spec ?? null}
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
                      dropClipart(JSON.parse(raw) as CtLibraryDrag, null);
                    }}
                  >
                    <ImageIcon className="h-10 w-10 opacity-40" />
                    <p>Chưa có version nào.</p>
                    <p className="text-xs">Mở tab Thư viện bên trái, kéo 1 artwork thả vào đây làm version đầu.</p>
                  </div>
                )}
              </div>
            </div>
          ) : view === "print" && main ? (
            <PrintPanel
              product={product}
              main={main}
              assets={assets}
              regions={allRegions}
              items={allItems}
              layouts={config.layouts}
              material={config.material}
              selection={selection}
              onOpenSettings={() => setMaterialOpen(true)}
              print={config.print}
            />
          ) : view === "preview" ? (
            main ? null : <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Cần có version trước — kéo 1 clipart từ tab Thư viện vào canvas.</div>
          ) : main ? (
            <AiMockupsPanel
              product={product}
              main={main}
              assets={assets}
              regions={allRegions}
              items={allItems}
              selection={selection}
              config={config}
              onAssets={(created) => setAssets((a) => [...a.filter((x) => !created.some((c) => c.id === x.id)), ...created])}
              onDelete={deleteMockup}
              onProduct={(p) => {
                setProduct(p);
                const scene = normalizeProductConfig(p.config).scene;
                design.commit((st) => ({ ...st, config: { ...st.config, scene } }));
              }}
              onOpenScene={() => setSceneOpen(true)}
              flash={flash}
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
              }}
              onMainFrame={setMainFrame}
              onPreviewOption={(regionId, assetId) => setSelection((sel) => ({ ...sel, [regionId]: { kind: "image", assetId } }))}
              onSaveArtwork={artworks.saveExtra}
              artworkBusy={artworks.busy}
              artworkFolder={artworks.folderName}
              print={config.print}
              onSampleText={(regionId, text) =>
                setSelection((sel) => {
                  const cur = sel[regionId];
                  return cur?.kind === "text" ? { ...sel, [regionId]: { ...cur, text } } : sel;
                })
              }
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
              selectedSet={selectedSet}
              onSelectSet={selectSet}
              onSelectRegion={(id) => {
                setSelectedRegionId(id);
                setSetPick(null);
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
              onHoverRegion={setHoverRegionId}
            />
            </div>
          </aside>
        )}
      </div>

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
    </div>
    </CtTooltipProvider>
  );
}

/** One rail tool: an icon; its name and shortcut are in the tooltip (opens to the right). */
function RailButton(props: { label: string; keys: string[]; active?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <CtTooltip label={props.label} shortcut={props.keys} side="right">
      <span className="block">
        <button
          type="button"
          disabled={props.disabled}
          onClick={props.onClick}
          className={cx(
            "flex h-8 w-full items-center justify-center rounded-md text-foreground",
            props.active ? "bg-sky-500/15 text-sky-500 ring-1 ring-sky-500/60" : "hover:bg-accent",
            props.disabled && "pointer-events-none opacity-35",
          )}
        >
          {props.children}
        </button>
      </span>
    </CtTooltip>
  );
}

function RailDivider() {
  return <div className="mx-1.5 my-1 h-px bg-border" />;
}
