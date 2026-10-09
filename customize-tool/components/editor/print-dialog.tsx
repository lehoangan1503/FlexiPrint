"use client";

/**
 * "File in": the physical product the design is printed on and its
 * production files.
 *
 *   Vật liệu    acrylic / ceramic / metal / wood — outline, size, border,
 *               thickness. Only production facts: how a material LOOKS is
 *               the clipart renditions uploaded in /library.
 *   Hiển thị    the product is drawn with the flat cliparts, or their renditions
 *               (one of their material versions: "có dây"…).
 *   Gửi xưởng   print.png — the current selection FLAT, full resolution (what is
 *               printed) + mockup.png — the same drawn with a material version, so
 *               the factory sees where the hole / cord / details go. No service.
 *   Xuất file   the flat selection → services/material-render
 *               → print.png + white.png + cut.svg (mm) + meta.json.
 *
 * Settings live in the design (config.material) so they save / undo / publish with it.
 */

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import type { CtAsset, CtMaterialConfig, CtMaterialDisplay, CtMaterialShape, CtProduct, CtSelection } from "../../types";
import { CT_MATERIALS, applyMaterialPreset, materialPreset } from "../../lib/materials";
import { displayAssets, materialVersions } from "../../lib/library";
import { canvasToBlob, renderComposite } from "../../lib/compositor";
import { selectedMainImageId } from "../../lib/design";
import { ctApi } from "../../lib/api-client";
import { CtButton, CtField, CtModal, CtNumber, CtSelect, cx } from "../ui";
import type { DesignApi } from "./use-design";

/** The select can't hold "" — the base material version. */
const BASE = "__base";

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

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
  const versions = materialVersions(assets);
  /** The material version the factory mockup shows: the one with the details (cord…) by default. */
  const [mockupVersion, setMockupVersion] = useState<string>(versions[0] ?? BASE);
  const [sending, setSending] = useState(false);

  const set = (patch: Partial<CtMaterialConfig>) => design.commit((s) => ({ ...s, config: { ...s.config, material: { ...s.config.material, ...patch } } }));

  /** Effective print resolution of the main asset at the chosen physical width. */
  const nativeDpi = Math.round(main.width / (material.widthMm / 25.4));

  const exportPack = async () => {
    setExporting(true);
    setError(null);
    try {
      // What is printed is the flat artwork: a material version is how the finished product looks, not ink. A product
      // with a khuôn vật liệu prints only the khuôn (its cut-out parts cleared).
      const shownAssets = displayAssets(assets, "flat");
      const art = await renderComposite({ main, assets: shownAssets, regions, items, selection, scale: 1, layouts: config.layouts, cutToFrame: true });
      const designBlob = await canvasToBlob(art, "image/png");
      let mainBlob: Blob | null = null;
      if (material.shape === "main") {
        const shown = shownAssets.find((a) => a.id === selectedMainImageId(selection, shownAssets, main.id)) ?? main;
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

  /** print.png (flat, full resolution) + mockup.png (a material version, its plate / hole / cord included). */
  const sendToFactory = async () => {
    setSending(true);
    setError(null);
    try {
      const base = props.product.name.replace(/[^\w-]+/g, "-") || "product";
      const flat = displayAssets(assets, "flat");
      const print = await renderComposite({ main, assets: flat, regions, items, selection, scale: 1, layouts: config.layouts, cutToFrame: true });
      download(await canvasToBlob(print, "image/png"), `${base}-print.png`);
      const look = displayAssets(assets, "rendition", material.flatIds, mockupVersion === BASE ? "" : mockupVersion);
      const mock = await renderComposite({ main, assets: look, regions, items, selection, scale: 1, layouts: config.layouts, bleed: true });
      download(await canvasToBlob(mock, "image/png"), `${base}-mockup.png`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Xuất file thất bại");
    } finally {
      setSending(false);
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
          hint={`Bản vật liệu = bản AI của từng clipart (tạo bằng preset vật liệu). Clipart chưa có bản vật liệu dùng bản phẳng. Storefront và ảnh giỏ hàng dùng bản chọn ở đây; file in luôn là bản phẳng. Sản phẩm này đang có ${renditions} bản vật liệu.`}
        >
          <CtSelect<CtMaterialDisplay>
            value={material.display}
            onChange={(display) => set({ display })}
            options={[
              { value: "flat", label: "Clipart phẳng (như thiết kế)" },
              { value: "rendition", label: "Bản vật liệu AI (acrylic, glitter…)" },
            ]}
          />
          {material.display === "rendition" && versions.length > 0 && (
            <CtSelect<string>
              value={material.version || BASE}
              onChange={(v) => set({ version: v === BASE ? "" : v })}
              options={[{ value: BASE, label: "Phiên bản: bản gốc" }, ...versions.map((v) => ({ value: v, label: `Phiên bản: ${v}` }))]}
            />
          )}
        </CtField>

        <div className="space-y-2 rounded-md border p-3">
          <div className="text-xs font-semibold">Gửi xưởng</div>
          <p className="text-[11px] leading-snug text-muted-foreground">
            print.png = tổ hợp đang chọn, bản phẳng, full độ phân giải (file in). mockup.png = cùng tổ hợp vẽ bằng bản vật liệu — xưởng thấy vị trí lỗ, dây, chi tiết.
          </p>
          <div className="flex items-end gap-2">
            {renditions > 0 && (
              <CtField label="Mockup dùng">
                <CtSelect<string>
                  value={mockupVersion}
                  onChange={setMockupVersion}
                  options={[{ value: BASE, label: "Bản gốc" }, ...versions.map((v) => ({ value: v, label: v }))]}
                />
              </CtField>
            )}
            <CtButton className="flex-1 justify-center" onClick={() => void sendToFactory()} disabled={sending}>
              {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Tải file gửi xưởng (print.png + mockup.png)
            </CtButton>
          </div>
        </div>

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
              Tổ hợp đang chọn (bản phẳng) → print.png · white.png (lớp mực trắng, acrylic) · cut.svg (đường cắt laser, mm) · meta.json. Cần service{" "}
              <code>material-render</code> (CT_MATERIAL_URL).
            </p>
          </div>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </CtModal>
  );
}
