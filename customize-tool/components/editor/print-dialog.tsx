"use client";

/**
 * "File in": the physical product the design is printed on and its
 * production files.
 *
 *   Vật liệu    acrylic / ceramic / metal / wood — outline, size, border,
 *               thickness. Only production facts: how a material LOOKS is
 *               AI-rendered in the studio (ComfyUI) into clipart renditions.
 *   Hiển thị    storefront shows the flat cliparts, or their renditions.
 *   Xuất file   the current selection, full resolution, flat → services/material-render
 *               → print.png + white.png + cut.svg (mm) + meta.json.
 *
 * Settings live in the design (config.material) so they save / undo / publish with it.
 */

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import type { CtAsset, CtMaterialConfig, CtMaterialDisplay, CtMaterialShape, CtProduct, CtSelection } from "../../types";
import { CT_MATERIALS, applyMaterialPreset, materialPreset } from "../../lib/materials";
import { canvasToBlob, renderComposite } from "../../lib/compositor";
import { selectedMainId } from "../../lib/design";
import { ctApi } from "../../lib/api-client";
import { CtButton, CtField, CtModal, CtNumber, CtSelect, cx } from "../ui";
import type { DesignApi } from "./use-design";

export interface PrintDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** The shared design (base layout): material settings are product-wide. */
  design: DesignApi;
  product: CtProduct;
  main: CtAsset;
  assets: CtAsset[];
  selection: CtSelection;
}

export function PrintDialog(props: PrintDialogProps) {
  const { design, main, assets, selection } = props;
  const { regions, items, config } = design.state;
  const material = config.material;
  const preset = materialPreset(material.id);
  const [exporting, setExporting] = useState(false);
  const [dpi, setDpi] = useState("300");
  const [error, setError] = useState<string | null>(null);
  const renditions = assets.filter((a) => a.role === "rendition").length;

  const set = (patch: Partial<CtMaterialConfig>) => design.commit((s) => ({ ...s, config: { ...s.config, material: { ...s.config.material, ...patch } } }));

  /** Effective print resolution of the main asset at the chosen physical width. */
  const nativeDpi = Math.round(main.width / (material.widthMm / 25.4));

  const exportPack = async () => {
    setExporting(true);
    setError(null);
    try {
      // Always the flat art: renditions are for display only.
      const flat = await renderComposite({ main, assets: assets.filter((a) => a.role !== "rendition"), regions, items, selection, scale: 1, layouts: config.layouts });
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
    <CtModal open={props.open} onOpenChange={props.onOpenChange} title="File in">
      <div className="space-y-4 text-sm">
        <CtField label="Loại phôi in">
          <div className="grid grid-cols-2 gap-1.5">
            {CT_MATERIALS.map((m) => (
              <button
                key={m.id}
                type="button"
                title={m.hint}
                onClick={() => set(applyMaterialPreset(material, m.id))}
                className={cx("rounded-md border px-2 py-1.5 text-left text-xs", m.id === material.id ? "border-sky-500 bg-sky-500/10 ring-1 ring-sky-500/60" : "hover:bg-accent")}
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
                  ? "Cắt theo viền thiết kế + viền — kiểu kẹp xe / standee acrylic."
                  : "Main object chính là phôi (vd. đĩa sứ trắng): mọi layer in lên phôi, phần tràn ra ngoài bị cắt."
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
              {nativeDpi < 200 ? " — thấp, file in sẽ bị phóng to (mờ). Nên dùng main lớn hơn." : "."} Vd. 5.5 in = 139.7 mm.
            </p>
          </>
        )}

        <CtField
          label="Hiển thị trên storefront"
          hint={`Bản vật liệu = rendition AI của từng clipart (tạo trong Studio bằng preset vật liệu, giữ nguyên silhouette). Clipart chưa có rendition vẫn hiện bản phẳng. Sản phẩm này đang có ${renditions} rendition.`}
        >
          <CtSelect<CtMaterialDisplay>
            value={material.display}
            onChange={(display) => set({ display })}
            options={[
              { value: "flat", label: "Clipart phẳng (như thiết kế)" },
              { value: "rendition", label: "Bản vật liệu AI (acrylic, glitter…)" },
            ]}
          />
        </CtField>

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
              Tổ hợp đang chọn (art phẳng) → print.png · white.png (lớp mực trắng, acrylic) · cut.svg (đường cắt laser, mm) · meta.json. Cần service{" "}
              <code>material-render</code> (CT_MATERIAL_URL).
            </p>
          </div>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </CtModal>
  );
}
