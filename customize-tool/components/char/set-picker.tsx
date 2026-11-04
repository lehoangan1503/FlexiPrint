"use client";

/**
 * A bộ clipart in the library, with its options — and a bộ con taken from it right here (asked 2026-11-04: "ngay trên
 * bộ clipart này … kéo chọn các option trên hình preview, hoặc chọn / shift chọn bên phải rồi tạo bộ clipart con",
 * without making a product first).
 *
 *   left   the set's product drawn live (its default choices; an option clicked on the right shows on it). Click a
 *          part = that character (every layer of it); drag = a selection box (layers with most of their pixels in
 *          it, lib/layer-groups layersInBox); Shift adds. What is picked shows bright, the rest dimmed.
 *   right  the characters (one click = all their layers), then every layer with its options (click a picture to see
 *          it on the left; click the layer's name to pick it, Shift-click a range, ⌘-click one more).
 *   button "Tạo bộ clipart con" → server/char/extract-set.ts (same canvas, same place, every option), its parent noted.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Scissors, Type, UserSquare, X } from "lucide-react";
import { CT_MAIN_KEY } from "../../types";
import type { CtAsset, CtCharProject, CtProductBundle, CtRegion, CtSelection } from "../../types";
import { charApi, ctApi } from "../../lib/api-client";
import { renderComposite, renderPickMap, pickAt, type CtPickMap } from "../../lib/compositor";
import { trimCanvas } from "../../lib/canvas-trim";
import { activeRegions, defaultRegionSelection, isSelectionValid, mainVersions, normalizeProductConfig, normalizeRegion, zoneSubtree } from "../../lib/design";
import { claimSharedLayers, resolveLayout } from "../../lib/layout";
import { displayAssets } from "../../lib/library";
import { layerGroupOf, layerGroups, layersInBox } from "../../lib/layer-groups";
import { OptionThumb } from "../editor/option-thumb";
import { CHECKER_STYLE, CtButton, cx } from "../ui";
import { ctConfirm, ctPrompt } from "../dialogs";

const BLANK = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
/** Preview: longest side in px. */
const SIDE = 1100;

/** A layer's name without the " [version]" tag every version's copy carries. */
const shortName = (n: string) => n.replace(/\s*\[[^\]]*\]\s*$/, "");

interface Loaded {
  bundle: CtProductBundle;
  main: CtAsset;
  versions: CtAsset[];
  layers: CtRegion[];
}

/** Where the pick map has pixels (canvas px), with a margin; the whole canvas when it is empty or nearly full. */
function contentBox(m: CtPickMap, W: number, H: number): { x: number; y: number; w: number; h: number } {
  let x0 = m.w;
  let y0 = m.h;
  let x1 = -1;
  let y1 = -1;
  for (const l of m.layers) {
    for (let i = 0; i < l.alpha.length; i++) {
      if (l.alpha[i] < 24) continue;
      const x = i % m.w;
      const y = (i - x) / m.w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return { x: 0, y: 0, w: W, h: H };
  const k = 1 / m.scale;
  const pad = Math.max(x1 - x0, y1 - y0) * k * 0.06;
  const x = Math.max(0, x0 * k - pad);
  const y = Math.max(0, y0 * k - pad);
  const w = Math.min(W, (x1 + 1) * k + pad) - x;
  const h = Math.min(H, (y1 + 1) * k + pad) - y;
  return w * h > W * H * 0.8 ? { x: 0, y: 0, w: W, h: H } : { x, y, w, h };
}

export function SetPicker({ project, editable }: { project: CtCharProject; editable: boolean }) {
  const productId = project.product_ids[0];
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [sel, setSel] = useState<CtSelection>({});
  const [picked, setPicked] = useState<string[]>([]);
  const [shot, setShot] = useState<{ url: string; pickedUrl: string | null } | null>(null);
  const pickMap = useRef<CtPickMap | null>(null);
  /** The part of the canvas that has something on it (canvas px): the preview shows only it — a bộ con of one
   * character on a wide canvas would be a speck otherwise. */
  const [view, setView] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const anchor = useRef<string | null>(null);

  useEffect(() => {
    if (!productId) return;
    let live = true;
    ctApi
      .getBundle(productId)
      .then((bundle) => {
        if (!live) return;
        const main = bundle.assets.find((a) => a.id === bundle.product.main_asset_id);
        if (!main) throw new Error("Sản phẩm của bộ chưa có version");
        const regions = bundle.regions.map(normalizeRegion);
        const layers = claimSharedLayers(regions, main.id) ?? regions;
        const config = normalizeProductConfig(bundle.product.config);
        // Every layer's choice: what the designer left, else its default (as the editor fills them).
        const start: CtSelection = {};
        for (const r of layers) {
          const cur = config.samples[r.id];
          start[r.id] = cur && isSelectionValid(r, cur, bundle.items, bundle.assets) ? cur : defaultRegionSelection(r, bundle.items, bundle.assets);
        }
        setSel(start);
        setData({ bundle, main, versions: mainVersions(bundle.assets, main.id), layers });
        setVersionId(main.id);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [productId]);

  const config = useMemo(() => (data ? normalizeProductConfig(data.bundle.product.config) : null), [data]);
  /** The version's layers, its layout applied. */
  const version = useMemo(() => (data && config && versionId ? resolveLayout(data.layers, data.bundle.items, config.layouts, versionId) : null), [data, config, versionId]);
  const selection = useMemo<CtSelection>(() => (versionId ? { ...sel, [CT_MAIN_KEY]: { kind: "main", assetId: versionId, optionId: null } } : sel), [sel, versionId]);
  /** The layers on show (a child layer only while its parent shows its option), topmost first. */
  const shown = useMemo(() => (version ? [...activeRegions(version.regions, selection)].sort((a, b) => b.sort_order - a.sort_order) : []), [version, selection]);
  const groups = useMemo(() => layerGroups(shown), [shown]);
  const groupOf = useMemo(() => layerGroupOf(shown), [shown]);
  const pickedSet = useMemo(() => new Set(picked), [picked]);

  // ---- the preview, and the pick map clicks / boxes are read from ----
  useEffect(() => {
    if (!data || !config || !version) return;
    let live = true;
    const urls: string[] = [];
    const t = setTimeout(async () => {
      const { main, bundle, layers } = data;
      const assets = displayAssets(bundle.assets, "flat");
      const base = { main, assets, regions: layers, items: bundle.items, selection, layouts: config.layouts };
      try {
        // The pick map first: it says which part of the canvas has something on it, and the preview is drawn sharp
        // for that part (a small character on a wide canvas would be blurry blown up from a whole-canvas picture).
        const map = await renderPickMap({ ...base, scale: 1 }, 700);
        const frame = view ?? contentBox(map, main.width, main.height);
        const k = Math.min(1, SIDE / Math.max(frame.w, frame.h), 4096 / Math.max(main.width, main.height));
        const full = await renderComposite({ ...base, scale: k });
        let pickedUrl: string | null = null;
        if (picked.length) {
          const blankAssets = assets.map((a) => (a.role === "main" ? { ...a, url: BLANK } : a));
          const only = await renderComposite({ ...base, scale: k, main: { ...main, url: BLANK }, assets: blankAssets, regions: layers.filter((r) => pickedSet.has(r.id)) });
          pickedUrl = only.toDataURL("image/png");
        }
        if (!live) return;
        pickMap.current = map;
        if (!view) setView(frame);
        const url = full.toDataURL("image/png");
        urls.push(url);
        setShot({ url, pickedUrl });
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "Không vẽ được bộ");
      }
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // `view` is set once from the first picture (the frame stays put while options change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, config, version, selection, picked, pickedSet]);

  // ---- picking ----
  const pickGroup = (id: string, add: boolean) => {
    const key = groupOf.get(id)?.key;
    const ids = key ? groups.find((g) => g.key === key)?.ids ?? [id] : [id];
    setPicked((cur) => (add ? (ids.every((x) => cur.includes(x)) ? cur.filter((x) => !ids.includes(x)) : [...new Set([...cur, ...ids])]) : ids));
  };
  const clickLayer = (e: React.MouseEvent, id: string) => {
    if (e.shiftKey && anchor.current) {
      const a = shown.findIndex((r) => r.id === anchor.current);
      const b = shown.findIndex((r) => r.id === id);
      if (a >= 0 && b >= 0) {
        const range = shown.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.id);
        setPicked((cur) => [...new Set([...cur, ...range])]);
        return;
      }
    }
    anchor.current = id;
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  };

  // Preview: click = that character, drag = a selection box.
  const box = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number; add: boolean; moved: boolean } | null>(null);
  const toCanvas = useCallback(
    (clientX: number, clientY: number) => {
      const el = box.current;
      if (!el || !data) return { x: 0, y: 0 };
      const r = el.getBoundingClientRect();
      const v = view ?? { x: 0, y: 0, w: data.main.width, h: data.main.height };
      return { x: v.x + ((clientX - r.left) / r.width) * v.w, y: v.y + ((clientY - r.top) / r.height) * v.h };
    },
    [data, view],
  );
  const onDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = toCanvas(e.clientX, e.clientY);
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y, add: e.shiftKey || e.metaKey || e.ctrlKey, moved: false });
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag || !data || !box.current) return;
    const p = toCanvas(e.clientX, e.clientY);
    const screen = ((view?.w ?? data.main.width) / box.current.getBoundingClientRect().width) * 4;
    setDrag({ ...drag, x1: p.x, y1: p.y, moved: drag.moved || Math.hypot(p.x - drag.x0, p.y - drag.y0) > screen });
  };
  const onUp = () => {
    const d = drag;
    setDrag(null);
    const m = pickMap.current;
    if (!d || !m) return;
    if (!d.moved) {
      const hit = pickAt(m, { x: d.x0, y: d.y0 }, 4);
      if (typeof hit === "string") pickGroup(hit, d.add);
      else if (!d.add) setPicked([]);
      return;
    }
    const inside = layersInBox(m, { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) }, shown);
    setPicked((cur) => (d.add ? [...new Set([...cur, ...inside])] : inside));
  };

  // ---- the bộ con ----
  const create = async () => {
    if (!data || !version || !config || !picked.length) return;
    const name = await ctPrompt({ title: "Tạo bộ clipart con", label: "Tên bộ", defaultValue: `${project.name} — ${groups.find((g) => g.ids.every((id) => pickedSet.has(id)))?.label ?? `${picked.length} layer`}`, confirmLabel: "Tạo bộ" });
    if (!name?.trim()) return;
    setBusy(true);
    try {
      const want = new Set(picked.flatMap((id) => [...zoneSubtree(version.regions, id)]));
      const regions = version.regions.filter((r) => want.has(r.id));
      const items = version.items.filter((i) => want.has(i.region_id));
      const { main, bundle } = data;
      const k = Math.min(1, 1200 / Math.max(main.width, main.height));
      const assets = displayAssets(bundle.assets, "flat").map((a) => (a.role === "main" ? { ...a, url: BLANK } : a));
      const pic = await renderComposite({ main: { ...main, url: BLANK }, assets, regions, items, selection, scale: k, layouts: config.layouts });
      const preview = trimCanvas(pic).toDataURL("image/png");
      const r = await charApi.extract({ name: name.trim(), productId: bundle.product.id, width: main.width, height: main.height, regions, items, preview, fromSetId: project.id });
      const open = await ctConfirm({
        title: `Đã tạo bộ clipart con “${r.project.name}”`,
        message: (
          <div className="space-y-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- a local data URL */}
            <img src={preview} alt="" className="mx-auto max-h-48 rounded border object-contain" style={CHECKER_STYLE} />
            <p>
              {r.layers} layer, giữ nguyên vị trí và mọi lựa chọn{r.skipped ? ` (bỏ ${r.skipped} layer dùng ảnh riêng của sản phẩm)` : ""}. Nằm ở Thư viện → Clipart → Cụm clipart, ghi là con của “{project.name}”.
            </p>
          </div>
        ),
        confirmLabel: "Xem bộ con",
        cancelLabel: "Ở lại bộ này",
        tone: "info",
      });
      setPicked([]);
      if (open) window.location.href = `/dashboard?tab=library&set=${r.project.id}`;
    } catch (e) {
      await ctConfirm({ title: "Không tạo được bộ con", message: e instanceof Error ? e.message : String(e), confirmLabel: "Đóng", tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  if (!productId) return <p className="py-10 text-center text-sm text-muted-foreground">Bộ chưa có sản phẩm — chưa xem được clipart.</p>;
  if (error) return <p className="rounded bg-destructive/10 p-2 text-sm text-destructive">{error}</p>;
  if (!data || !version) return <Loader2 className="h-5 w-5 animate-spin" />;

  const { main, bundle } = data;
  const optionsOf = (r: CtRegion): CtAsset[] =>
    bundle.items
      .filter((i) => i.region_id === r.id)
      .sort((a, b) => a.sort_order - b.sort_order)
      .flatMap((i) => {
        const sub = bundle.assets.find((a) => a.id === i.asset_id);
        return sub ? [sub, ...bundle.assets.filter((a) => a.parent_id === sub.id && a.role === "variant").sort((a, b) => a.sort_order - b.sort_order)] : [];
      });
  const v = view ?? { x: 0, y: 0, w: main.width, h: main.height };
  /** The whole canvas picture, placed so that `v` fills the preview box. */
  const picStyle: React.CSSProperties = { left: `${(-v.x / v.w) * 100}%`, top: `${(-v.y / v.h) * 100}%`, width: `${(main.width / v.w) * 100}%`, height: `${(main.height / v.h) * 100}%` };
  const dragBox = drag?.moved ? { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) } : null;

  return (
    <div className="space-y-3">
      {data.versions.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Phiên bản:</span>
          {data.versions.map((v) => (
            <button
              key={v.id}
              onClick={() => {
                setVersionId(v.id);
                setPicked([]);
                setView(null);
              }}
              className={cx("rounded-full border px-2.5 py-0.5 text-xs", v.id === versionId ? "border-foreground bg-foreground text-background" : "hover:bg-accent")}
            >
              {v.name || "version"}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-start gap-6">
        {/* ---- preview ---- */}
        <div className="w-full lg:sticky lg:top-4 lg:w-[55%]">
          <div
            ref={box}
            className="relative w-full cursor-crosshair touch-none select-none overflow-hidden rounded-lg border"
            style={{ ...CHECKER_STYLE, aspectRatio: `${v.w} / ${v.h}`, width: `min(100%, calc(70vh * ${v.w / v.h}))` }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
          >
            {shot ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element -- a local data URL */}
                <img src={shot.url} alt={project.name} className="pointer-events-none absolute max-w-none" style={picStyle} draggable={false} />
                {shot.pickedUrl && (
                  <>
                    <div className="pointer-events-none absolute inset-0 bg-black/60" />
                    {/* eslint-disable-next-line @next/next/no-img-element -- a local data URL */}
                    <img src={shot.pickedUrl} alt="" className="pointer-events-none absolute max-w-none" style={picStyle} draggable={false} />
                  </>
                )}
              </>
            ) : (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            )}
            {dragBox && (
              <div
                className="pointer-events-none absolute border-2 border-dashed border-sky-400 bg-sky-400/15"
                style={{ left: `${((dragBox.x - v.x) / v.w) * 100}%`, top: `${((dragBox.y - v.y) / v.h) * 100}%`, width: `${(dragBox.w / v.w) * 100}%`, height: `${(dragBox.h / v.h) * 100}%` }}
              />
            )}
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">Bấm vào 1 nhân vật để chọn cả nhân vật · nhấn giữ kéo khung để gom · Shift: chọn thêm</p>
        </div>

        {/* ---- characters, layers, options ---- */}
        <div className="min-w-[300px] flex-1 space-y-4">
          <div className="sticky top-0 z-10 space-y-2 rounded-lg border bg-card p-2.5">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold">{picked.length ? `${picked.length} layer đã chọn` : "Chọn phần muốn tách"}</span>
              {picked.length > 0 && (
                <button onClick={() => setPicked([])} className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground">
                  <X className="h-3 w-3" /> Bỏ chọn
                </button>
              )}
              {editable && (
                <CtButton size="sm" variant="primary" className="ml-auto" disabled={!picked.length || busy} onClick={() => void create()}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Scissors className="h-3.5 w-3.5" />} Tạo bộ clipart con
                </CtButton>
              )}
            </div>
            {groups.length > 1 && (
              <div className="flex flex-wrap gap-1">
                {groups.map((g) => {
                  const on = g.ids.every((id) => pickedSet.has(id));
                  return (
                    <button
                      key={g.key}
                      onClick={(e) => pickGroup(g.ids[0], e.shiftKey || e.metaKey || e.ctrlKey)}
                      title={`${g.label} — ${g.ids.length} layer · Shift / ⌘: chọn thêm`}
                      className={cx("max-w-full truncate rounded-full border px-2 py-0.5 text-[11px]", on ? "border-sky-500 bg-sky-500 font-medium text-white" : "bg-background hover:bg-accent")}
                    >
                      {g.label} <span className={on ? "opacity-80" : "text-muted-foreground"}>({g.ids.length})</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {shown.map((r) => {
            const on = pickedSet.has(r.id);
            const options = r.kind === "image" ? optionsOf(r) : [];
            const cur = selection[r.id];
            const follows = r.kind === "image" && r.config.image.follows;
            return (
              <section key={r.id} className={cx("rounded-lg border p-2", on ? "border-sky-500 bg-sky-500/5" : "border-transparent")}>
                <button onClick={(e) => clickLayer(e, r.id)} className="mb-1.5 flex w-full items-center gap-1.5 text-left" title="Bấm để chọn / bỏ layer này · Shift-click: chọn liền một dải">
                  <span className={cx("flex h-4 w-4 shrink-0 items-center justify-center rounded border", on ? "border-sky-500 bg-sky-500 text-white" : "border-muted-foreground/40")}>{on && <Check className="h-3 w-3" />}</span>
                  {r.kind === "text" ? <Type className="h-3.5 w-3.5 text-muted-foreground" /> : r.kind === "photo" ? <UserSquare className="h-3.5 w-3.5 text-muted-foreground" /> : null}
                  <span className="truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {shortName(r.kind === "image" ? r.config.image.label || r.name : r.name)}
                    {options.length > 1 ? ` (${options.length})` : ""}
                  </span>
                  {follows && <span className="text-[10px] text-muted-foreground">· đổi theo layer khác</span>}
                </button>
                {r.kind === "image" && options.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pl-5">
                    {options.slice(0, 40).map((a) => {
                      const active = cur?.kind === "image" && cur.assetId === a.id;
                      return (
                        <button
                          key={a.id}
                          disabled={!!follows}
                          onClick={() => setSel((s) => ({ ...s, [r.id]: { kind: "image", assetId: a.id } }))}
                          title={a.name}
                          className={cx("h-14 w-14 overflow-hidden rounded-md border-2", active ? "border-orange-500" : "border-transparent hover:border-muted-foreground/40")}
                          style={CHECKER_STYLE}
                        >
                          {a.meta?.thumb ? (
                            // eslint-disable-next-line @next/next/no-img-element -- our R2 thumb
                            <img src={a.meta.thumb} alt="" className="h-full w-full object-contain" loading="lazy" />
                          ) : (
                            <OptionThumb url={a.url} label={a.name} className="h-full w-full object-contain" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
                {r.kind === "text" && <p className="pl-5 text-xs text-muted-foreground">Chữ: {r.config.text.defaultText || "(khách nhập)"}</p>}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
