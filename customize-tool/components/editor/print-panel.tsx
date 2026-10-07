"use client";

/**
 * "File in" tab: the final flat 2D artwork the Thiết kế tab makes — what the factory prints. One rule for every
 * product: the flat clipart (single, combined, with or without a khuôn) + the layers, full resolution. A product
 * with a khuôn vật liệu prints only the khuôn (its cut-out parts cleared); otherwise the version's own box.
 * Never a vật liệu: how the material looks is the Tổ hợp's job.
 */

import { useEffect, useState } from "react";
import { Download, Loader2, Settings2 } from "lucide-react";
import type { CtAsset, CtMainLayout, CtMaterialConfig, CtProduct, CtRegion, CtRegionItem, CtSelection } from "../../types";
import { displayAssets } from "../../lib/library";
import { canvasToBlob, printFrame, renderComposite } from "../../lib/compositor";
import { CtButton } from "../ui";

/** Preview render: longest side in px (the download is always full resolution). */
const PREVIEW_SIDE = 1400;

export interface PrintPanelProps {
  product: CtProduct;
  main: CtAsset;
  assets: CtAsset[];
  regions: CtRegion[];
  items: CtRegionItem[];
  layouts: Record<string, CtMainLayout>;
  material: CtMaterialConfig;
  selection: CtSelection;
  onOpenSettings: () => void;
}

function shrink(src: HTMLCanvasElement, k: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(src.width * k));
  c.height = Math.max(1, Math.round(src.height * k));
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D không khả dụng");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

interface Rendered {
  url: string;
  /** Full-resolution size of the print file. */
  w: number;
  h: number;
}

export function PrintPanel(props: PrintPanelProps) {
  const { product, main, assets, regions, items, layouts, material, selection } = props;
  const [shot, setShot] = useState<Rendered | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const flat = displayAssets(assets, "flat");
  const frame = printFrame({ main, assets: flat, regions, selection });

  useEffect(() => {
    let live = true;
    let url = "";
    const t = setTimeout(async () => {
      try {
        const full = await renderComposite({ main, assets: displayAssets(assets, "flat"), regions, items, selection, scale: 1, layouts, cutToFrame: true });
        const k = Math.min(1, PREVIEW_SIDE / Math.max(full.width, full.height));
        const small = k < 1 ? shrink(full, k) : full;
        url = URL.createObjectURL(await canvasToBlob(small, "image/png"));
        if (!live) return URL.revokeObjectURL(url);
        setShot({ url, w: full.width, h: full.height });
        setError(null);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "Không vẽ được file in");
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
      if (url) URL.revokeObjectURL(url);
    };
  }, [main, assets, regions, items, selection, layouts]);

  const download = async () => {
    setSaving(true);
    try {
      const full = await renderComposite({ main, assets: flat, regions, items, selection, scale: 1, layouts, cutToFrame: true });
      const href = URL.createObjectURL(await canvasToBlob(full, "image/png"));
      const a = document.createElement("a");
      a.href = href;
      a.download = `${product.name.replace(/[^\w-]+/g, "-") || "product"}-print.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Xuất file thất bại");
    } finally {
      setSaving(false);
    }
  };

  const mm = material.id !== "none" ? material.widthMm : 0;
  const dpi = shot && mm ? Math.round(shot.w / (mm / 25.4)) : 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-2 text-xs">
        <span className="font-semibold">File in</span>
        <span className="text-muted-foreground">
          {frame ? `Cắt theo khuôn "${frame.name}"` : "Khung version (không có khuôn)"}
          {shot && ` · ${shot.w}×${shot.h}px`}
          {dpi > 0 && ` · ${mm}mm ≈ ${dpi} dpi`}
        </span>
        <span className="text-muted-foreground">Bản phẳng + layer của khách đang chọn ở Thiết kế — đúng file gửi xưởng.</span>
        <div className="ml-auto flex gap-2">
          <CtButton size="sm" variant="outline" onClick={props.onOpenSettings}>
            <Settings2 className="h-3.5 w-3.5" /> Cài đặt in
          </CtButton>
          <CtButton size="sm" onClick={() => void download()} disabled={saving || !shot}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Tải print.png
          </CtButton>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : shot ? (
          // eslint-disable-next-line @next/next/no-img-element -- a local blob, not an optimizable remote image
          <img
            src={shot.url}
            alt="File in"
            className="max-h-full max-w-full object-contain shadow-sm"
            style={{ backgroundColor: "#fff", backgroundImage: "repeating-conic-gradient(#0000000f 0% 25%, transparent 0% 50%)", backgroundSize: "16px 16px" }}
          />
        ) : (
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        )}
      </div>
    </div>
  );
}
