"use client";

/**
 * "Vật liệu": how the finished design is rendered as a physical product —
 * acrylic (white / clear), ceramic (gloss / matte), metal, wood — plus the
 * scene photo it sits on, with a live preview of the current selection.
 *
 * Settings live in the design (config.material) so they save / undo / publish
 * with it; the storefront renders them with the same lib/material-render.ts.
 * "Xuất file in" sends the full-resolution flat design to services/material-render
 * for print.png + white.png + cut.svg (mm) + meta.json.
 */

import { useEffect, useRef, useState } from "react";
import { Download, ImagePlus, Loader2, X } from "lucide-react";
import type { CtAsset, CtMaterialConfig, CtMaterialShape, CtProduct, CtScenePlacement, CtSelection } from "../../types";
import { CT_MATERIALS, applyMaterialPreset, materialPreset } from "../../lib/materials";
import { renderProduct } from "../../lib/material-render";
import { canvasToBlob, renderComposite } from "../../lib/compositor";
import { selectedMainId } from "../../lib/design";
import { ctApi } from "../../lib/api-client";
import { CHECKER_STYLE, CtButton, CtField, CtModal, CtNumber, CtSelect, cx } from "../ui";
import type { DesignApi } from "./use-design";

export interface MaterialDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** The shared design (base layout): material settings are product-wide. */
  design: DesignApi;
  product: CtProduct;
  main: CtAsset;
  assets: CtAsset[];
  selection: CtSelection;
  busy: string | null;
  /** Upload scene photos (stored as "reference" assets). */
  onUploadScene: (files: File[]) => Promise<CtAsset[]>;
}

const PREVIEW_PX = 900;

export function MaterialDialog(props: MaterialDialogProps) {
  const { design, main, assets, selection } = props;
  const { regions, items, config } = design.state;
  const material = config.material;
  const preset = materialPreset(material.id);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [rendering, setRendering] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [dpi, setDpi] = useState("300");
  const [error, setError] = useState<string | null>(null);
  const scenes = assets.filter((a) => a.role === "reference");

  const set = (patch: Partial<CtMaterialConfig>) => design.commit((s) => ({ ...s, config: { ...s.config, material: { ...s.config.material, ...patch } } }));
  /** Sliders: live while dragging, one undo step on release. */
  const slide = (patch: Partial<CtMaterialConfig>) => design.live((s) => ({ ...s, config: { ...s.config, material: { ...s.config.material, ...patch } } }));
  const slideScene = (patch: Partial<CtScenePlacement>) => slide({ scene: { ...material.scene, ...patch } });

  // Live preview of the current selection.
  const token = useRef(0);
  useEffect(() => {
    if (!props.open) return;
    const t = ++token.current;
    const raf = requestAnimationFrame(() => {
      setRendering(true);
      renderProduct({ main, assets, regions, items, selection, layouts: config.layouts, material, maxSide: PREVIEW_PX })
        .then((c) => {
          if (t !== token.current || !hostRef.current) return;
          c.className = "max-h-full max-w-full object-contain";
          hostRef.current.replaceChildren(c);
        })
        .catch((e: Error) => t === token.current && setError(e.message))
        .finally(() => t === token.current && setRendering(false));
    });
    return () => cancelAnimationFrame(raf);
  }, [props.open, main, assets, regions, items, selection, config.layouts, material]);

  /** Effective print resolution of the main asset at the chosen physical width. */
  const nativeDpi = Math.round(main.width / (material.widthMm / 25.4));

  const exportPack = async () => {
    setExporting(true);
    setError(null);
    try {
      const flat = await renderComposite({ main, assets, regions, items, selection, scale: 1, layouts: config.layouts });
      const designBlob = await canvasToBlob(flat, "image/png");
      let mainBlob: Blob | null = null;
      if (material.shape === "main") {
        const shown = assets.find((a) => a.id === selectedMainId(selection, assets, main.id)) ?? main;
        mainBlob = await fetch(shown.url).then((r) => r.blob());
      }
      const zip = await ctApi.printPack(props.product.id, { design: designBlob, main: mainBlob, material, dpi: Number(dpi) });
      const url = URL.createObjectURL(zip);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${props.product.name.replace(/[^\w-]+/g, "-") || "product"}-${material.id}-print.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Xuất file thất bại");
    } finally {
      setExporting(false);
    }
  };

  return (
    <CtModal open={props.open} onOpenChange={props.onOpenChange} title="Vật liệu render" wide>
      <div className="grid gap-4 md:grid-cols-[360px_1fr]">
        <div className="max-h-[72vh] space-y-4 overflow-y-auto pr-1 text-sm">
          <CtField label="Loại vật liệu">
            <div className="grid grid-cols-2 gap-1.5">
              {CT_MATERIALS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  title={m.hint}
                  onClick={() => set(applyMaterialPreset(material, m.id))}
                  className={cx(
                    "rounded-md border px-2 py-1.5 text-left text-xs",
                    m.id === material.id ? "border-sky-500 bg-sky-500/10 ring-1 ring-sky-500/60" : "hover:bg-accent",
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <span className="block text-[11px] leading-snug text-muted-foreground">{preset.hint}</span>
          </CtField>

          {material.id !== "none" && (
            <>
              <CtField
                label="Viền plate"
                hint={
                  material.shape === "contour"
                    ? "Cắt theo viền thiết kế + viền trắng — kiểu kẹp xe / standee acrylic (main có thể là bất kỳ hình gì)."
                    : "Main object chính là phôi (vd. đĩa sứ trắng + dây): mọi layer in lên phôi, phần tràn ra ngoài bị cắt."
                }
              >
                <CtSelect<CtMaterialShape>
                  value={material.shape}
                  onChange={(shape) => set({ shape })}
                  options={[
                    { value: "contour", label: "Cắt theo hình thiết kế" },
                    { value: "main", label: "Theo phôi = main object" },
                  ]}
                />
              </CtField>

              <div className="grid grid-cols-3 gap-2">
                <CtField label="Rộng (mm)">
                  <CtNumber value={material.widthMm} min={5} onChange={(v) => set({ widthMm: Math.max(5, v) })} />
                </CtField>
                {material.shape === "contour" && (
                  <CtField label="Viền (mm)">
                    <CtNumber value={material.borderMm} min={0} step={0.5} onChange={(v) => set({ borderMm: Math.max(0, v) })} />
                  </CtField>
                )}
                <CtField label="Dày (mm)">
                  <CtNumber value={material.thicknessMm} min={0} step={0.5} onChange={(v) => set({ thicknessMm: Math.max(0, v) })} />
                </CtField>
              </div>
              <p className={cx("text-[11px] leading-snug", nativeDpi < 200 ? "text-amber-500" : "text-muted-foreground")}>
                Main {main.width}px trên {material.widthMm}mm ≈ {nativeDpi} dpi
                {nativeDpi < 200 ? " — thấp, file in sẽ bị phóng to (mờ). Nên upload main lớn hơn." : "."} Vd. 5.5 in = 139.7 mm.
              </p>

              <Slider label="Bóng đổ" value={material.shadow} onChange={(shadow) => slide({ shadow })} onDone={design.checkpoint} />
              <Slider label="Độ bóng / ánh" value={material.gloss} onChange={(gloss) => slide({ gloss })} onDone={design.checkpoint} />
            </>
          )}

          <CtField label="Ảnh nền (mockup)" hint="Sản phẩm được đặt lên ảnh này trên trang Shopify (vd. tấm che nắng xe, cây thông). Ảnh lưu ở tab Tham chiếu.">
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => set({ sceneAssetId: null })}
                className={cx("flex h-14 w-14 items-center justify-center rounded border text-[10px]", !material.sceneAssetId && "ring-2 ring-sky-500")}
                style={CHECKER_STYLE}
              >
                <X className="h-4 w-4" />
              </button>
              {scenes.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  title={a.name}
                  onClick={() => set({ sceneAssetId: a.id })}
                  className={cx("h-14 w-14 overflow-hidden rounded border", material.sceneAssetId === a.id && "ring-2 ring-sky-500")}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={a.url} alt={a.name} className="h-full w-full object-cover" />
                </button>
              ))}
              <button
                type="button"
                disabled={props.busy !== null}
                onClick={() => fileRef.current?.click()}
                className="flex h-14 w-14 items-center justify-center rounded border border-dashed hover:bg-accent disabled:opacity-40"
              >
                {props.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={async (e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  const created = await props.onUploadScene(files);
                  if (created[0]) set({ sceneAssetId: created[0].id });
                }}
              />
            </div>
          </CtField>

          {material.sceneAssetId && (
            <div className="space-y-2 rounded-md border p-2">
              <Slider label="Vị trí X" value={material.scene.x} onChange={(x) => slideScene({ x })} onDone={design.checkpoint} />
              <Slider label="Vị trí Y" value={material.scene.y} onChange={(y) => slideScene({ y })} onDone={design.checkpoint} />
              <Slider label="Kích thước" min={0.05} max={1.2} value={material.scene.width} onChange={(width) => slideScene({ width })} onDone={design.checkpoint} />
              <Slider label="Xoay" min={-45} max={45} step={1} value={material.scene.rotation} format={(v) => `${v}°`} onChange={(rotation) => slideScene({ rotation })} onDone={design.checkpoint} />
            </div>
          )}

          {material.id !== "none" && (
            <div className="space-y-2 border-t pt-3">
              <div className="flex items-end gap-2">
                <CtField label="DPI">
                  <CtSelect value={dpi} onChange={setDpi} options={["150", "300", "600"].map((v) => ({ value: v, label: v }))} />
                </CtField>
                <CtButton className="flex-1 justify-center" onClick={() => void exportPack()} disabled={exporting}>
                  {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Xuất file in (.zip)
                </CtButton>
              </div>
              <p className="text-[11px] leading-snug text-muted-foreground">
                Tổ hợp đang chọn → print.png · white.png (lớp mực trắng, acrylic) · cut.svg (đường cắt laser, mm) · meta.json (kích thước, chiều dài đường cắt, cảnh báo).
                Cần service <code>material-render</code> (CT_MATERIAL_URL).
              </p>
            </div>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="relative flex min-h-[420px] items-center justify-center overflow-hidden rounded-lg border" style={CHECKER_STYLE}>
          <div ref={hostRef} className="flex h-full max-h-[72vh] w-full items-center justify-center p-3" />
          {rendering && <Loader2 className="absolute right-3 top-3 h-4 w-4 animate-spin text-muted-foreground" />}
          <span className="absolute bottom-2 left-3 text-[11px] text-muted-foreground">Xem trước tổ hợp đang chọn — giống trang Shopify</span>
        </div>
      </div>
    </CtModal>
  );
}

function Slider(props: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  onDone: () => void;
}) {
  const { min = 0, max = 1, step = 0.01 } = props;
  return (
    <label className="block space-y-0.5">
      <span className="flex justify-between text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {props.label}
        <span className="normal-case">{props.format ? props.format(props.value) : props.value.toFixed(2)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={props.value}
        className="w-full accent-sky-500"
        onChange={(e) => props.onChange(Number(e.target.value))}
        onPointerUp={props.onDone}
        onKeyUp={props.onDone}
      />
    </label>
  );
}
