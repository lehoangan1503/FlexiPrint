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
import {
  ArrowLeft,
  Circle,
  Hand,
  ImageIcon,
  Loader2,
  MousePointer2,
  Move,
  Pentagon,
  Redo2,
  Layers,
  Rocket,
  Save,
  Square,
  Type,
  Undo2,
  UserSquare,
} from "lucide-react";
import { CT_CONFIG, ctGoogleFontsHref } from "../../config";
import { CT_MAIN_KEY } from "../../types";
import type { CtAsset, CtAssetRole, CtMainOptionConfig, CtPhotoSelection, CtProduct, CtRegion, CtRegionItem, CtSelection } from "../../types";
import { ctApi } from "../../lib/api-client";
import {
  defaultProductConfig,
  defaultRegionSelection,
  isSelectionValid,
  makeItem,
  makeRegion,
  mainVersions,
  normalizeProductConfig,
  normalizeRegion,
  selectedMainId,
} from "../../lib/design";
import { fitShapeToBounds, newId, shapeBounds, translateShape } from "../../lib/geometry";
import { materialPreset } from "../../lib/materials";
import { CtAutoWidthInput, CtButton, CtTooltip, CtTooltipProvider, cx } from "../ui";
import { Stage, type EditTarget, type StageTool } from "./stage";
import { Inspector } from "./inspector";
import { AssetPanel } from "./asset-panel";
import { GenerateDialog } from "./generate-dialog";
import { CleanupDialog } from "./cleanup-dialog";
import { PreviewPanel } from "./preview-panel";
import { StorefrontPreview } from "./storefront-preview";
import { PublishDialog } from "./publish-dialog";
import { layoutView, setOwnLayout, updateItem, updateRegion, useDesign } from "./use-design";
import { MaterialDialog } from "./material-dialog";

/** Thiết kế = edit · Xem trước = the real storefront page · Tổ hợp & Mockup = composites + AI mockups. */
type View = "design" | "preview" | "mockup";

interface GenState {
  role: CtAssetRole;
  parent: CtAsset | null;
  refIds: string[];
}

/** Kinds drawn with a frame tool. A custom layer is added at once instead: its frame is the image itself. */
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
  const [publishOpen, setPublishOpen] = useState(false);
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
  /** Render the product material (acrylic, ceramic…) on the design canvas too. */
  const [showMaterial, setShowMaterial] = useState(false);
  const [materialOpen, setMaterialOpen] = useState(false);

  const [busy, setBusy] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [gen, setGen] = useState<GenState | null>(null);
  const [cleanup, setCleanup] = useState<CtAsset | null>(null);
  /**
   * AI is a plugin: with no provider key configured the tool is upload-only
   * and every AI affordance is hidden. Turning it on is just adding an env key.
   */
  const [aiEnabled, setAiEnabled] = useState(false);

  useEffect(() => {
    ctApi
      .providers()
      .then((list) => setAiEnabled(list.some((p) => p.configured)))
      .catch(() => setAiEnabled(false));
  }, []);

  // ---------------------------------------------------------------- load
  useEffect(() => {
    ctApi
      .getBundle(productId)
      .then((b) => {
        setProduct(b.product);
        setNameDraft(b.product.name);
        setAssets(b.assets);
        design.reset({ regions: b.regions.map(normalizeRegion), items: b.items, config: normalizeProductConfig(b.product.config) });
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
  // A main version with its own layout: canvas + inspector edit THAT layout (lib/layout.ts).
  const layoutMainId = shownMainId && shownMainId !== main?.id && config.layouts[shownMainId] ? shownMainId : null;
  const layoutMain = layoutMainId ? (assets.find((a) => a.id === layoutMainId) ?? null) : null;
  const ed = layoutView(design, layoutMainId);
  const { regions, items } = ed.state;

  // Keep the preview selection valid as zones / items / assets change.
  useEffect(() => {
    setSelection((prev) => {
      const next: CtSelection = {};
      let changed = false;
      const curMain = prev[CT_MAIN_KEY];
      if (curMain?.kind === "main" && mains.some((m) => m.id === curMain.assetId)) next[CT_MAIN_KEY] = curMain;
      else if (curMain) changed = true;
      for (const r of regions) {
        const cur = prev[r.id];
        if (cur && isSelectionValid(r, cur, items, assets)) {
          next[r.id] = cur;
          continue;
        }
        next[r.id] = defaultRegionSelection(r, items, assets);
        changed = true;
      }
      if (Object.keys(prev).length !== Object.keys(next).length) changed = true;
      return changed ? next : prev;
    });
  }, [regions, items, assets, mains]);

  // Leaving object mode when the region/item context goes away.
  useEffect(() => {
    const item = items.find((i) => i.id === activeItemId);
    if (!item || item.region_id !== selectedRegionId) {
      if (activeItemId) setActiveItemId(null);
      if (editTarget === "object") {
        // Pick the first item of the newly selected image region automatically.
        const first = items.find((i) => i.region_id === selectedRegionId);
        if (first) setActiveItemId(first.id);
        else setEditTarget("region");
      }
    }
  }, [items, activeItemId, selectedRegionId, editTarget]);

  // ---------------------------------------------------------------- save
  const save = useCallback(async (): Promise<boolean> => {
    if (!product) return false;
    setSaving(true);
    try {
      await ctApi.saveDesign(product.id, { regions: design.state.regions, items: design.state.items, config: design.state.config });
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

  /** A custom layer is added straight away, centred on the main; uploading / generating its image sizes the frame. */
  const addCustomLayer = () => {
    if (!main) return;
    const size = Math.round(Math.min(main.width, main.height) * 0.4);
    const shape = { type: "rect" as const, x: Math.round((main.width - size) / 2), y: Math.round((main.height - size) / 2), w: size, h: size, radius: 0 };
    const region = makeRegion(product?.id ?? "", "image", shape, regions.length);
    ed.commit((s) => ({ ...s, regions: [...s.regions, region] }));
    setSelectedRegionId(region.id);
    setActiveItemId(null);
    setEditTarget("region");
    setTool("select");
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
      } else if (e.key === "Enter" && tool !== "polygon" && selectedRegionId) {
        const r = regions.find((x) => x.id === selectedRegionId);
        if (r?.kind === "image") setEditTarget((t) => (t === "object" ? "region" : "object"));
      } else if ((e.key === "Delete" || e.key === "Backspace") && tool !== "polygon" && selectedRegionId) {
        e.preventDefault();
        ed.commit((s) => ({
          ...s,
          regions: s.regions.filter((r) => r.id !== selectedRegionId),
          items: s.items.filter((i) => i.region_id !== selectedRegionId),
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

  const upload = async (role: CtAssetRole, files: File[], parentId: string | null): Promise<CtAsset[]> => {
    if (!product) return [];
    setBusy(`Đang upload ${files.length} ảnh…`);
    const created: CtAsset[] = [];
    try {
      for (const f of files) created.push(await ctApi.uploadAsset(product.id, f, { role, parentId }));
      if (role === "main" && !product.main_asset_id && created[0]) setProduct({ ...product, main_asset_id: created[0].id });
    } catch (e) {
      flash(e instanceof Error ? e.message : "Upload thất bại");
    } finally {
      setAssets((a) => [...a, ...created]);
      setBusy(null);
    }
    return created;
  };

  /** A new option group in an image zone: first file becomes the group's sub asset, the rest its versions. */
  const uploadGroup = async (regionId: string, files: File[]) => {
    if (!product || files.length === 0) return;
    setBusy(`Đang upload ${files.length} ảnh…`);
    const created: CtAsset[] = [];
    try {
      const sub = await ctApi.uploadAsset(product.id, files[0], { role: "sub" });
      created.push(sub);
      for (const f of files.slice(1)) created.push(await ctApi.uploadAsset(product.id, f, { role: "variant", parentId: sub.id }));
      const count = design.state.items.filter((i) => i.region_id === regionId).length;
      const item = makeItem(regionId, sub.id, count);
      design.commit((s) => ({ ...s, regions: fitLayerToFirstItem(s, regionId, sub), items: [...s.items, item] }));
      setSelection((sel) => ({ ...sel, [regionId]: { kind: "image", assetId: sub.id } }));
    } catch (e) {
      flash(e instanceof Error ? e.message : "Upload thất bại");
    } finally {
      setAssets((a) => [...a, ...created]);
      setBusy(null);
    }
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

  const setMainConfig = (patch: Partial<CtMainOptionConfig>) => ed.commit((s) => ({ ...s, config: { ...s.config, main: { ...s.config.main, ...patch } } }));

  const onGenerated = (created: CtAsset[]) => {
    setAssets((a) => [...a, ...created]);
    if (product && !product.main_asset_id) {
      const m = created.find((c) => c.role === "main");
      if (m) setProduct({ ...product, main_asset_id: m.id });
    }
    if (created[0]?.role === "mockup") setView("mockup");
  };

  const removeAsset = async (asset: CtAsset) => {
    const usedIn = items.filter((i) => i.asset_id === asset.id).length;
    const variants = assets.filter((a) => a.parent_id === asset.id).length;
    const warn = [
      asset.id === product?.main_asset_id ? "Đây là main object đang dùng." : "",
      usedIn ? `Đang được đặt trong ${usedIn} vùng.` : "",
      variants ? `Sẽ xoá kèm ${variants} version.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    if (!window.confirm(`Xoá "${asset.name || asset.role}"? ${warn}`)) return;
    try {
      await ctApi.deleteAsset(asset.id);
      setAssets((a) => a.filter((x) => x.id !== asset.id && x.parent_id !== asset.id));
      if (usedIn) ed.commit((s) => ({ ...s, items: s.items.filter((i) => i.asset_id !== asset.id) }));
      if (product && asset.id === product.main_asset_id) setProduct({ ...product, main_asset_id: null });
    } catch (e) {
      flash(e instanceof Error ? e.message : "Xoá thất bại");
    }
  };

  const setMain = async (asset: CtAsset) => {
    if (!product) return;
    if (main && regions.length > 0 && (main.width !== asset.width || main.height !== asset.height)) {
      if (!window.confirm(`Main mới có kích thước ${asset.width}×${asset.height} khác main hiện tại ${main.width}×${main.height}. Vùng custom tính theo pixel sẽ lệch. Tiếp tục?`)) return;
    }
    try {
      setProduct(await ctApi.updateProduct(product.id, { main_asset_id: asset.id, thumbnail_url: asset.url }));
      // The default main IS the base layout; an own layout it carried as a version no longer applies.
      if (config.layouts[asset.id]) design.commit((s) => setOwnLayout(s, asset.id, false));
    } catch (e) {
      flash(e instanceof Error ? e.message : "Lỗi");
    }
  };

  const place = (sub: CtAsset) => {
    const r = regions.find((x) => x.id === selectedRegionId);
    if (!r || r.kind !== "image") return;
    if (items.some((i) => i.region_id === r.id && i.asset_id === sub.id)) {
      flash("Sub object này đã có trong vùng");
      return;
    }
    const count = items.filter((i) => i.region_id === r.id).length;
    const item = makeItem(r.id, sub.id, count);
    design.commit((s) => ({ ...s, regions: fitLayerToFirstItem(s, r.id, sub), items: [...s.items, item] }));
    setActiveItemId(item.id);
    setSelection((sel) => ({ ...sel, [r.id]: { kind: "image", assetId: sub.id } }));
  };

  const previewAsset = (asset: CtAsset) => {
    if (asset.role === "main") {
      setSelection((sel) => ({ ...sel, [CT_MAIN_KEY]: { kind: "main", assetId: asset.id } }));
      return;
    }
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

  const saveComposites = async (list: Array<{ blob: Blob; selection: CtSelection }>) => {
    if (!product) return;
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
      flash(`Đã lưu ${created.length} tổ hợp`);
    } catch (e) {
      setAssets((a) => [...a, ...created]);
      flash(e instanceof Error ? e.message : "Lưu tổ hợp thất bại");
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
  const objectModeDisabled = selectedRegion?.kind !== "image" || !items.some((i) => i.region_id === selectedRegionId);

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
              ["mockup", "Tổ hợp & Mockup"],
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
          <CtTooltip label="Vật liệu render — acrylic, sứ, nhôm, gỗ… + ảnh nền + xuất file in">
            <CtButton size="sm" variant="outline" onClick={() => setMaterialOpen(true)} disabled={!main}>
              <Layers className="h-3.5 w-3.5" /> Vật liệu: {materialPreset(config.material.id).label.split(" (")[0]}
            </CtButton>
          </CtTooltip>
          <CtTooltip label="Publish lên Shopify (main-product.liquid)">
            <CtButton size="sm" variant="outline" onClick={() => setPublishOpen(true)} disabled={!main}>
              <Rocket className="h-3.5 w-3.5" /> Publish
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
            canPlace={selectedRegion?.kind === "image"}
            busy={busy}
            onUpload={(role, files, parentId) => void upload(role, files, parentId)}
            onGenerate={
              aiEnabled ? (role, parentId) => setGen({ role, parent: assets.find((a) => a.id === parentId) ?? null, refIds: [] }) : undefined
            }
            onDelete={removeAsset}
            onSetMain={setMain}
            onPlace={place}
            onCleanup={setCleanup}
            onRename={rename}
            onPreview={previewAsset}
            mainConfig={config.main}
            onMainConfig={setMainConfig}
            layouts={config.layouts}
            onOwnLayout={(mainId, on) => {
              design.commit((s) => setOwnLayout(s, mainId, on));
              // Show the version whose layout is being edited.
              if (on) setSelection((sel) => ({ ...sel, [CT_MAIN_KEY]: { kind: "main", assetId: mainId } }));
            }}
            shownMainId={shownMainId}
            onSetSwatch={setSwatch}
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
                <RailButton label="Custom layer — thêm 1 layer (ảnh upload / AI tạo), khung chính là vị trí ảnh" keys={["L"]} disabled={!main} onClick={addCustomLayer}>
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
                  label={objectModeDisabled ? "Chế độ Object — chọn Custom layer có ít nhất 1 ảnh" : "Chế độ Object — vị trí / scale / xoay ảnh trong layer"}
                  keys={["↵"]}
                  active={editTarget === "object"}
                  disabled={objectModeDisabled}
                  onClick={() => setEditTarget((t) => (t === "object" ? "region" : "object"))}
                >
                  <Move className="h-4 w-4" />
                </RailButton>
              </div>
              <div className="relative min-h-0 min-w-0 flex-1">
                {main && (
                  <div className="absolute right-3 top-2 z-10 flex items-center gap-2 whitespace-nowrap text-[11px] text-muted-foreground">
                    {layoutMain && (
                      <span className="rounded bg-violet-500/15 px-1.5 py-0.5 font-medium text-violet-500">
                        Đang sửa vị trí riêng của version “{layoutMain.name || "main"}”
                      </span>
                    )}
                    {config.material.id !== "none" && (
                      <label className="flex cursor-pointer items-center gap-1 rounded border bg-background/80 px-1.5 py-0.5">
                        <input type="checkbox" className="accent-sky-500" checked={showMaterial} onChange={(e) => setShowMaterial(e.target.checked)} />
                        Xem vật liệu
                      </label>
                    )}
                    <span className="pointer-events-none">
                      Main: {main.width}×{main.height}px · {regions.length} vùng
                    </span>
                  </div>
                )}
                {main ? (
                  <Stage
                    productId={product.id}
                    main={main}
                    assets={assets}
                    design={ed}
                    material={showMaterial ? config.material : null}
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
                  />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
                    <ImageIcon className="h-10 w-10 opacity-40" />
                    <p>Chưa có main object.</p>
                    <p className="text-xs">Upload ở tab Main bên trái — ảnh đầu tiên tự thành main.</p>
                  </div>
                )}
              </div>
            </div>
          ) : view === "preview" ? (
            main ? null : <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Cần main object trước.</div>
          ) : main ? (
            <PreviewPanel
              main={main}
              mains={config.main.enabled ? mains : []}
              mainConfig={config.main}
              layouts={config.layouts}
              material={config.material}
              assets={assets}
              regions={regions}
              items={items}
              selection={selection}
              onSelectionChange={setSelection}
              onSaveComposites={saveComposites}
              onMockup={aiEnabled ? (ids) => setGen({ role: "mockup", parent: null, refIds: ids }) : undefined}
              onDelete={removeAsset}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Cần main object trước.</div>
          )}
          {previewMounted && main && (
            <div className={cx("min-h-0 flex-1", view !== "preview" && "hidden")}>
              <StorefrontPreview product={product} assets={assets} regions={regions} items={items} config={config} />
            </div>
          )}
        </main>

        {/* Right: layers + properties */}
        {view === "design" && (
          <aside className="w-80 shrink-0 border-l">
            <Inspector
              design={ed}
              layoutMain={layoutMain}
              assets={assets}
              selection={selection}
              busy={busy}
              onUploadGroup={(regionId, files) => void uploadGroup(regionId, files)}
              onUploadOptions={(subId, files) => void upload("variant", files, subId)}
              onPreviewOption={(regionId, assetId) => setSelection((sel) => ({ ...sel, [regionId]: { kind: "image", assetId } }))}
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
              onSelectRegion={setSelectedRegionId}
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
          </aside>
        )}
      </div>

      {gen && (
        <GenerateDialog
          open
          onOpenChange={(o) => !o && setGen(null)}
          productId={product.id}
          role={gen.role}
          parent={gen.parent}
          assets={assets}
          initialRefIds={gen.refIds}
          onDone={onGenerated}
        />
      )}
      <CleanupDialog
        asset={cleanup}
        onClose={() => setCleanup(null)}
        onSaved={(a) => setAssets((list) => list.map((x) => (x.id === a.id ? a : x)))}
      />
      {main && (
        <MaterialDialog
          open={materialOpen}
          onOpenChange={setMaterialOpen}
          design={design}
          product={product}
          main={main}
          assets={assets}
          selection={selection}
          busy={busy}
          onUploadScene={(files) => upload("reference", files, null)}
        />
      )}
      <PublishDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        product={product}
        dirty={design.dirty}
        onSave={save}
        onPublished={(p) => setProduct(p)}
      />
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
