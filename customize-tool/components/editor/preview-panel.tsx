"use client";

/**
 * "Tổ hợp & Mockup": pick combinations, save them as composite images, then
 * hand those composites to AI for a professional multi-product mockup — no
 * download/re-upload round trip. (The customer-facing page is the "Xem trước"
 * tab, storefront-preview.tsx.)
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Download, Loader2, Shuffle, Sparkles, Trash2, Save } from "lucide-react";
import { CT_MAIN_KEY } from "../../types";
import type { CtAsset, CtMainLayout, CtMaterialConfig, CtMainOptionConfig, CtOptionDisplay, CtPhotoSelection, CtPhotoStyleRef, CtRegion, CtRegionItem, CtSelection } from "../../types";
import {
  enumerateCombinations,
  formOrder,
  locateOption,
  normalizeRegion,
  optionInGroup,
  randomSelection,
  regionGroups,
  selectedMainId,
} from "../../lib/design";
import { canvasToBlob, renderComposite } from "../../lib/compositor";
import { withRenditions } from "../../lib/library";
import { IDENTITY_TRANSFORM } from "../../lib/geometry";
import { aiStyleRef, isAiStyleRef, needsServer, styleEngine, styleLabel } from "../../lib/photo-styles";
import { processPhoto } from "../../lib/photo-process";
import { ctApi } from "../../lib/api-client";
import { useAiStyles } from "./ai-styles-store";
import { CHECKER_STYLE, CtButton, CtField, CtInput, CtSelect, cx } from "../ui";

export interface PreviewPanelProps {
  main: CtAsset;
  /** Main versions offered to the customer; empty when the option is off. */
  mains: CtAsset[];
  mainConfig: CtMainOptionConfig;
  /** Per-main-version layouts (config.layouts). */
  layouts: Record<string, CtMainLayout>;
  material: CtMaterialConfig;
  assets: CtAsset[];
  regions: CtRegion[];
  items: CtRegionItem[];
  selection: CtSelection;
  onSelectionChange: (s: CtSelection) => void;
  onSaveComposites: (blobs: Array<{ blob: Blob; selection: CtSelection }>) => Promise<void>;
  /** AI plugin — omitted when no provider is configured. */
  onMockup?: (compositeIds: string[]) => void;
  onDelete: (a: CtAsset) => void;
}

export function PreviewPanel(props: PreviewPanelProps) {
  const { main, assets, items, selection, layouts, material } = props;
  /** Show / download with the AI material renditions (what the storefront shows) instead of the flat art. */
  const [withMaterial, setWithMaterial] = useState(true);
  const hasRenditions = assets.some((a) => a.role === "rendition");
  const showMaterial = withMaterial && hasRenditions && material.display === "rendition";
  const shownAssets = useMemo(() => (showMaterial ? withRenditions(assets) : assets), [assets, showMaterial]);
  const regions = useMemo(() => props.regions.map(normalizeRegion).sort((a, b) => a.sort_order - b.sort_order), [props.regions]);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [bulk, setBulk] = useState(6);
  const composites = assets.filter((a) => a.role === "composite");
  const mockups = assets.filter((a) => a.role === "mockup");

  // Live preview at a size that fits the panel.
  useEffect(() => {
    let cancelled = false;
    const scale = Math.min(1, 1400 / Math.max(main.width, main.height));
    renderComposite({ main, assets: shownAssets, regions, items, selection, scale, layouts })
      .then((c) => {
        if (cancelled || !hostRef.current) return;
        c.className = "max-h-full max-w-full object-contain";
        hostRef.current.replaceChildren(c);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [main, shownAssets, regions, items, selection, layouts]);

  const render = async (sel: CtSelection) => {
    const canvas = await renderComposite({ main, assets, regions, items, selection: sel, scale: 1, layouts });
    return canvasToBlob(canvas, "image/png");
  };

  const saveCurrent = async () => {
    setBusy("Đang lưu tổ hợp…");
    try {
      await props.onSaveComposites([{ blob: await render(selection), selection }]);
    } finally {
      setBusy(null);
    }
  };

  const saveBulk = async (mode: "all" | "random") => {
    const combos =
      mode === "all"
        ? enumerateCombinations(regions, items, assets, selection, bulk, props.mains)
        : Array.from({ length: bulk }, () => randomSelection(regions, items, assets, selection, props.mains));
    setBusy(`Đang render ${combos.length} tổ hợp…`);
    try {
      const out: Array<{ blob: Blob; selection: CtSelection }> = [];
      for (const c of combos) out.push({ blob: await render(c), selection: c });
      await props.onSaveComposites(out);
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    const blob = showMaterial
      ? await canvasToBlob(await renderComposite({ main, assets: shownAssets, regions, items, selection, scale: 1, layouts }), "image/png")
      : await render(selection);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "design.png";
    a.click();
    URL.revokeObjectURL(url);
  };

  const setSel = (regionId: string, value: CtSelection[string]) => props.onSelectionChange({ ...selection, [regionId]: value });

  // Customer photo, rendered exactly like the storefront does (style + cut-out + fade), cached per style.
  const { names: aiNames, styles: aiLib } = useAiStyles();
  const photoRenders = useRef(new Map<string, Promise<string>>());
  const [photoBusy, setPhotoBusy] = useState<Record<string, string>>({});
  const [photoError, setPhotoError] = useState<Record<string, string>>({});
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const renderPhoto = (r: CtRegion, sourceUrl: string, style: CtPhotoStyleRef): Promise<string> => {
    const cfg = r.config.photo;
    const ver = isAiStyleRef(style) ? aiLib.find((x) => aiStyleRef(x.id) === style)?.updated_at ?? "" : "";
    const key = `${sourceUrl}|${style}|${cfg.cutout}|${cfg.fadeCrop}|${ver}`;
    const hit = photoRenders.current.get(key);
    if (hit) return hit;
    const endpoint = ctApi.photoEndpoint(r.product_id);
    const job = (async () => {
      const engine = styleEngine(style);
      if (engine === "none" && !cfg.cutout) return sourceUrl;
      if (engine === "local" && cfg.cutout) {
        const base = await fetch(await renderPhoto(r, sourceUrl, "original")).then((x) => x.blob());
        return URL.createObjectURL(await processPhoto({ source: base, style, cutout: false, endpoint }));
      }
      const source = await fetch(sourceUrl).then((x) => x.blob());
      return URL.createObjectURL(await processPhoto({ source, style, cutout: cfg.cutout, fadeCrop: cfg.fadeCrop, endpoint }));
    })();
    photoRenders.current.set(key, job);
    job.catch(() => photoRenders.current.delete(key));
    return job;
  };

  const applyStyle = async (r: CtRegion, base: CtPhotoSelection, style: CtPhotoStyleRef) => {
    if (!base.sourceUrl) return;
    setPhotoError((e) => ({ ...e, [r.id]: "" }));
    if (needsServer(style, r.config.photo.cutout)) {
      setPhotoBusy((b) => ({ ...b, [r.id]: `Đang tạo ${styleLabel(style, aiNames)}${isAiStyleRef(style) ? " (AI)" : ""}…` }));
    }
    try {
      const url = await renderPhoto(r, base.sourceUrl, style);
      const now = selectionRef.current[r.id];
      const transform = now?.kind === "photo" ? now.transform : base.transform;
      props.onSelectionChange({ ...selectionRef.current, [r.id]: { ...base, transform, url, style } });
    } catch (e) {
      setPhotoError((x) => ({ ...x, [r.id]: e instanceof Error ? e.message : "Xử lý ảnh thất bại" }));
    } finally {
      setPhotoBusy((b) => {
        const rest = { ...b };
        delete rest[r.id];
        return rest;
      });
    }
  };

  return (
    <div className="grid h-full grid-cols-[1fr_320px] overflow-hidden">
      <div className="flex min-h-0 flex-col">
        <div className="flex min-h-0 flex-1 items-center justify-center p-6" style={CHECKER_STYLE}>
          <div ref={hostRef} className="flex h-full w-full items-center justify-center" />
        </div>
        <div className="border-t bg-background p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold">Tổ hợp đã lưu ({composites.length})</span>
            {props.onMockup ? (
              <>
                <span className="text-[11px] text-muted-foreground">Chọn nhiều ảnh → Tạo mockup (nhiều sản phẩm trong 1 ảnh)</span>
                <CtButton size="sm" variant="primary" className="ml-auto" disabled={picked.length === 0} onClick={() => props.onMockup?.(picked)}>
                  <Sparkles className="h-3.5 w-3.5" /> Tạo mockup AI ({picked.length})
                </CtButton>
              </>
            ) : (
              <span className="text-[11px] text-muted-foreground">Click ảnh để mở trong tab mới · double-click để mở lại tổ hợp</span>
            )}
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {composites.map((c) => {
              const on = picked.includes(c.id);
              return (
                <div key={c.id} className="group relative shrink-0">
                  <button
                    className={cx("h-24 w-24 overflow-hidden rounded border", on && "ring-2 ring-sky-500")}
                    style={CHECKER_STYLE}
                    onClick={() =>
                      props.onMockup ? setPicked((p) => (on ? p.filter((x) => x !== c.id) : [...p, c.id])) : window.open(c.url, "_blank", "noopener")
                    }
                    onDoubleClick={() => c.meta.selection && props.onSelectionChange(c.meta.selection)}
                    title="Click để chọn · double-click để mở lại tổ hợp"
                  >
                    <img src={c.url} alt="" className="h-full w-full object-contain" loading="lazy" />
                    {on && (
                      <span className="absolute right-1 top-1 rounded-full bg-sky-500 p-0.5 text-white">
                        <Check className="h-3 w-3" />
                      </span>
                    )}
                  </button>
                  <button className="absolute left-1 top-1 hidden rounded bg-black/60 p-0.5 text-white group-hover:block" onClick={() => props.onDelete(c)}>
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
            {composites.length === 0 && <p className="py-6 text-xs text-muted-foreground">Chưa có — bấm “Lưu tổ hợp này” ở bên phải.</p>}
          </div>
          {mockups.length > 0 && (
            <>
              <div className="mb-2 mt-3 text-xs font-semibold">Mockup ({mockups.length})</div>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {mockups.map((m) => (
                  <div key={m.id} className="group relative shrink-0">
                    <a href={m.url} target="_blank" rel="noreferrer" className="block h-32 w-32 overflow-hidden rounded border">
                      <img src={m.url} alt="" className="h-full w-full object-cover" loading="lazy" />
                    </a>
                    <button className="absolute left-1 top-1 hidden rounded bg-black/60 p-0.5 text-white group-hover:block" onClick={() => props.onDelete(m)}>
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-col border-l">
        <div className="border-b px-3 py-2 text-sm font-semibold">Tuỳ chọn khách hàng</div>
        <div className="flex-1 space-y-4 overflow-y-auto p-3">
          {regions.length === 0 && props.mains.length < 2 && <p className="text-xs text-muted-foreground">Chưa có vùng custom nào.</p>}
          {props.mains.length > 1 && (
            <CtField label={props.mainConfig.label || "Main"}>
              <OptionPicker
                display={props.mainConfig.display}
                value={selectedMainId(selection, assets, main.id)}
                options={props.mains.map((m) => ({ id: m.id, label: m.name, image: m.url, swatch: m.meta.swatch }))}
                onChange={(id) => id && props.onSelectionChange({ ...selection, [CT_MAIN_KEY]: { kind: "main", assetId: id } })}
              />
            </CtField>
          )}
          {formOrder(regions).map((r) => {
            const sel = selection[r.id];
            if (r.kind === "image") {
              const groups = regionGroups(r, items, assets);
              const current = sel?.kind === "image" ? sel.assetId : null;
              const at = locateOption(groups, current);
              const group = groups[Math.max(0, at.group)];
              return (
                <div key={r.id} className="space-y-3">
                  {groups.length > 1 && (
                    <CtField label={r.config.image.groupLabel || "Style"}>
                      <OptionPicker
                        display={r.config.image.groupDisplay}
                        value={group?.item.id ?? null}
                        options={groups.map((g) => ({ id: g.item.id, label: g.name, image: g.options[0].url, swatch: g.options[0].meta.swatch }))}
                        onChange={(id) => {
                          const gi = groups.findIndex((g) => g.item.id === id);
                          setSel(r.id, { kind: "image", assetId: optionInGroup(groups, gi, current) });
                        }}
                      />
                    </CtField>
                  )}
                  <CtField label={r.config.image.label || r.name}>
                    {group ? (
                      <OptionPicker
                        display={r.config.image.display}
                        allowNone={r.config.image.allowNone}
                        value={current}
                        options={group.options.map((o) => ({ id: o.id, label: o.name, image: o.url, swatch: o.meta.swatch }))}
                        onChange={(id) => setSel(r.id, { kind: "image", assetId: id })}
                      />
                    ) : (
                      <span className="text-[11px] text-muted-foreground">Vùng chưa có option.</span>
                    )}
                  </CtField>
                </div>
              );
            }
            if (r.kind === "text") {
              const text = sel?.kind === "text" ? sel.text : "";
              const choices = r.config.text.choices.filter(Boolean);
              if (choices.length > 0) {
                return (
                  <CtField key={r.id} label={r.config.text.label}>
                    <CtSelect value={text} onChange={(v) => setSel(r.id, { kind: "text", text: v })} options={choices.map((c) => ({ value: c, label: c }))} />
                  </CtField>
                );
              }
              return (
                <CtField key={r.id} label={`${r.config.text.label} (${text.length}/${r.config.text.maxChars})`}>
                  <CtInput
                    value={text}
                    maxLength={r.config.text.maxChars}
                    placeholder={r.config.text.placeholder}
                    onChange={(e) => setSel(r.id, { kind: "text", text: e.target.value })}
                  />
                </CtField>
              );
            }
            const photoUrl = sel?.kind === "photo" ? sel.url : null;
            const pcfg = r.config.photo;
            return (
              <CtField key={r.id} label={r.config.photo.label}>
                <label className="flex h-8 cursor-pointer items-center justify-center rounded-md border border-dashed text-xs hover:bg-accent">
                  {photoUrl ? "Đổi ảnh" : "Upload ảnh"}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (!f) return;
                      const sourceUrl = URL.createObjectURL(f);
                      // Not drawn until processed (cut-out + style): the zone stays empty meanwhile.
                      const base: CtPhotoSelection = { kind: "photo", url: null, transform: { ...IDENTITY_TRANSFORM }, style: pcfg.defaultStyle, sourceUrl };
                      setSel(r.id, base);
                      void applyStyle(r, base, pcfg.defaultStyle);
                    }}
                  />
                </label>
                {/* Same picker the storefront's Edit photo dialog shows (free + AI styles of this zone). */}
                {sel?.kind === "photo" && sel.sourceUrl && pcfg.styles.length > 1 && (
                  <CtField label={pcfg.styleLabel || "Choose style"}>
                    <CtSelect<CtPhotoStyleRef>
                      value={sel.style ?? "original"}
                      disabled={photoBusy[r.id] !== undefined}
                      onChange={(style) => void applyStyle(r, sel, style)}
                      options={pcfg.styles.map((id) => ({ value: id, label: styleLabel(id, aiNames) }))}
                    />
                  </CtField>
                )}
                {photoBusy[r.id] && (
                  <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> {photoBusy[r.id]}
                  </p>
                )}
                {photoError[r.id] && <p className="text-[11px] text-destructive">{photoError[r.id]}</p>}
                {photoUrl && sel?.kind === "photo" && (
                  <div className="grid grid-cols-2 gap-1.5 pt-1">
                    <CtField label="Zoom">
                      <input type="range" min={20} max={400} value={sel.transform.scale * 100} className="w-full accent-sky-500"
                        onChange={(e) => setSel(r.id, { ...sel, transform: { ...sel.transform, scale: Number(e.target.value) / 100 } })} />
                    </CtField>
                    <CtField label="Xoay">
                      <input type="range" min={-180} max={180} value={sel.transform.rotation} className="w-full accent-sky-500"
                        onChange={(e) => setSel(r.id, { ...sel, transform: { ...sel.transform, rotation: Number(e.target.value) } })} />
                    </CtField>
                    <CtField label="X">
                      <input type="range" min={-100} max={100} value={sel.transform.offsetX * 100} className="w-full accent-sky-500"
                        onChange={(e) => setSel(r.id, { ...sel, transform: { ...sel.transform, offsetX: Number(e.target.value) / 100 } })} />
                    </CtField>
                    <CtField label="Y">
                      <input type="range" min={-100} max={100} value={sel.transform.offsetY * 100} className="w-full accent-sky-500"
                        onChange={(e) => setSel(r.id, { ...sel, transform: { ...sel.transform, offsetY: Number(e.target.value) / 100 } })} />
                    </CtField>
                  </div>
                )}
              </CtField>
            );
          })}
        </div>
        <div className="space-y-2 border-t p-3">
          {hasRenditions && material.display === "rendition" && (
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" className="accent-sky-500" checked={withMaterial} onChange={(e) => setWithMaterial(e.target.checked)} />
              Xem / tải bằng bản vật liệu AI (tổ hợp lưu vẫn là art phẳng)
            </label>
          )}
          <div className="flex gap-1.5">
            <CtButton size="sm" className="flex-1 justify-center" onClick={() => props.onSelectionChange(randomSelection(regions, items, assets, selection, props.mains))}>
              <Shuffle className="h-3.5 w-3.5" /> Random
            </CtButton>
            <CtButton size="sm" className="flex-1 justify-center" onClick={download}>
              <Download className="h-3.5 w-3.5" /> Tải PNG
            </CtButton>
          </div>
          <CtButton variant="primary" className="w-full justify-center" onClick={saveCurrent} disabled={busy !== null}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Lưu tổ hợp này
          </CtButton>
          <div className="flex items-center gap-1.5">
            <CtInput type="number" min={1} max={50} value={bulk} className="w-16" onChange={(e) => setBulk(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} />
            <CtButton size="sm" className="flex-1 justify-center" onClick={() => saveBulk("random")} disabled={busy !== null}>
              Lưu N random
            </CtButton>
            <CtButton size="sm" className="flex-1 justify-center" onClick={() => saveBulk("all")} disabled={busy !== null}>
              Lưu N tổ hợp
            </CtButton>
          </div>
          {busy && <p className="text-[11px] text-muted-foreground">{busy}</p>}
        </div>
      </div>
    </div>
  );
}

interface PickerOption {
  id: string;
  label: string;
  image?: string;
  swatch?: string;
}

const NONE = "__none__";

/** One option group the way the storefront shows it (tiles, swatches, chips or a dropdown). */
function OptionPicker({
  display,
  options,
  value,
  onChange,
  allowNone,
}: {
  display: CtOptionDisplay;
  options: PickerOption[];
  value: string | null;
  onChange: (id: string | null) => void;
  allowNone?: boolean;
}) {
  if (display === "dropdown") {
    return (
      <CtSelect<string>
        value={value ?? (allowNone ? NONE : "")}
        onChange={(v) => onChange(v === NONE ? null : v)}
        options={[...(allowNone ? [{ value: NONE, label: "None" }] : []), ...options.map((o) => ({ value: o.id, label: o.label || "(không tên)" }))]}
      />
    );
  }
  const ring = (on: boolean) => (on ? "ring-2 ring-orange-500 border-orange-500" : "");
  return (
    <div className={cx("flex flex-wrap gap-1.5", display === "image" && "grid grid-cols-4")}>
      {allowNone && (
        <button
          className={cx("flex items-center justify-center rounded border text-xs font-bold", display === "image" ? "aspect-square" : "h-8 px-3", ring(value === null))}
          onClick={() => onChange(null)}
        >
          NO
        </button>
      )}
      {options.map((o) =>
        display === "button" ? (
          <button key={o.id} className={cx("h-8 rounded border px-3 text-xs font-medium", ring(value === o.id))} onClick={() => onChange(o.id)}>
            {o.label || "(không tên)"}
          </button>
        ) : display === "swatch" ? (
          <button
            key={o.id}
            className={cx("h-9 w-9 overflow-hidden rounded-full border", ring(value === o.id))}
            style={o.swatch ? { background: o.swatch } : CHECKER_STYLE}
            onClick={() => onChange(o.id)}
            aria-label={o.label}
          >
            {!o.swatch && o.image && <img src={o.image} alt="" className="h-full w-full object-cover" />}
          </button>
        ) : (
          <button
            key={o.id}
            className={cx("aspect-square overflow-hidden rounded border", ring(value === o.id))}
            style={CHECKER_STYLE}
            onClick={() => onChange(o.id)}
            aria-label={o.label}
          >
            {o.image && <img src={o.image} alt="" className="h-full w-full object-contain" />}
          </button>
        ),
      )}
    </div>
  );
}
