"use client";

/**
 * "File in" tab: the final flat 2D artwork the Thiết kế tab makes — what the factory prints. One rule for every
 * product: the flat clipart (single, combined, with or without a khuôn) + the layers, full resolution. A product
 * with a khuôn vật liệu prints only the khuôn (its cut-out parts cleared); otherwise the version's own box.
 * Never a vật liệu: how the material looks is the Mockups tab's job.
 *
 * The khuôn's cut line (asked 2026-10-29) is drawn over the preview and downloaded as its own cut.svg — never into
 * print.png, or the printer would print it: same px box as print.png (real size in mm when the material has one),
 * outline + holes as vector paths, mirrored too when the sheet is. A khuôn cut by an AI mask has no vector outline:
 * its mask PNG is the cut file.
 */

import { useEffect, useState } from "react";
import { BookmarkPlus, Download, Loader2, Scissors, Settings2 } from "lucide-react";
import type { CtAsset, CtMainLayout, CtMaterialConfig, CtProduct, CtRegion, CtRegionItem, CtSelection } from "../../types";
import type { CtProductPrint } from "../../types/print";
import { displayAssets } from "../../lib/library";
import { canvasToBlob, mirrorSheet, printFrame, renderComposite } from "../../lib/compositor";
import { frameSvgPath } from "../../lib/material-frame";
import { normalizeSamples } from "../../lib/design";
import { printSize } from "../../lib/print-template";
import { ctApi } from "../../lib/api-client";
import { CtButton, CtSelect } from "../ui";

/** Preview render: longest side in px (the download is always full resolution). */
const PREVIEW_SIDE = 1400;

/** Colour of the cut line: magenta, the usual cut-contour colour of print shops. */
const CUT_COLOR = "#ff00ff";

/** The cut line's paths on a sheet of `w` × `h` px (the half and, mirrored, its other half beside it). */
function cutPaths(d: string, w: number, mirror: boolean, stroke: string): string {
  const path = `<path d="${d}" fill="none" fill-rule="evenodd" stroke="${CUT_COLOR}" stroke-width="${stroke}"/>`;
  return mirror ? `${path}<g transform="translate(${2 * w} 0) scale(-1 1)">${path}</g>` : path;
}

/** cut.svg: the khuôn's outline + holes in the print file's px box, sized in mm when the piece's width is known. */
function cutSvg(d: string, w: number, h: number, mirror: boolean, mm: number): string {
  const W = mirror ? 2 * w : w;
  const size = mm > 0 ? ` width="${round2((mm * W) / w)}mm" height="${round2((mm * h) / w)}mm"` : ` width="${W}" height="${h}"`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"${size} viewBox="0 0 ${W} ${h}">${cutPaths(d, w, mirror, "1")}</svg>\n`;
}

/** Stroke the cut line on a preview canvas scaled by `k` from the print file (and its mirror at `mirrorW` px). */
function drawCutLine(c: HTMLCanvasElement, d: string, k: number, mirrorW: number): void {
  const ctx = c.getContext("2d");
  if (!ctx) return;
  const path = new Path2D(d);
  ctx.save();
  ctx.strokeStyle = CUT_COLOR;
  ctx.lineWidth = Math.max(1.5, c.width / 600);
  for (const flip of mirrorW ? [false, true] : [false]) {
    ctx.setTransform(flip ? -k : k, 0, 0, k, flip ? 2 * mirrorW * k : 0, 0);
    ctx.lineWidth = Math.max(1.5, c.width / 600) / k;
    ctx.stroke(path);
  }
  ctx.restore();
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

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
  /** The khuôn in the product is made on: its sizes (a print file per size). */
  print?: CtProductPrint | null;
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
  const sizes = props.print?.spec.sizes ?? [];
  const [sizeId, setSizeId] = useState<string>(sizes[0]?.id ?? "");
  // A khuôn in with sizes: that size's sheet (its zones), else the product's own canvas cut to the khuôn.
  const size = props.print && sizes.length ? printSize(props.print.spec, sizeId || sizes[0].id) : null;
  const sizeArgs = size?.id ? { size, cutToFrame: false } : { cutToFrame: true };
  const [shot, setShot] = useState<Rendered | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const flat = displayAssets(assets, "flat");
  const frame = printFrame({ main, assets: flat, regions, selection });
  // The cut line follows the khuôn only when the file is cut to it (not a khuôn in size's own sheet).
  const cutFrame = frame && !size?.id ? frame : null;
  const cutPath = cutFrame && !cutFrame.config.maskUrl ? frameSvgPath(cutFrame) : "";
  const mirror = !!props.print?.spec.mirror;
  /** The print file: the sheet — and, a khuôn made as one half (spec.mirror), its mirror image beside it. */
  const printCanvas = async (): Promise<HTMLCanvasElement> => {
    const sheet = await renderComposite({ main, assets: flat, regions, items, selection, scale: 1, layouts, ...sizeArgs });
    return props.print?.spec.mirror ? mirrorSheet(sheet) : sheet;
  };

  useEffect(() => {
    let live = true;
    let url = "";
    const t = setTimeout(async () => {
      try {
        const full = await printCanvas();
        const k = Math.min(1, PREVIEW_SIDE / Math.max(full.width, full.height));
        // The cut line on the preview only (a copy; print.png stays clean): the khuôn's outline + holes, magenta.
        const small = k < 1 || cutPath ? shrink(full, k) : full;
        if (cutPath) drawCutLine(small, cutPath, k, mirror ? main.width : 0);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sizeArgs follows sizeId
  }, [main, assets, regions, items, selection, layouts, sizeId]);

  const download = async () => {
    setSaving(true);
    try {
      const full = await printCanvas();
      const href = URL.createObjectURL(await canvasToBlob(full, "image/png"));
      const a = document.createElement("a");
      a.href = href;
      a.download = `${product.name.replace(/[^\w-]+/g, "-") || "product"}${size?.name ? `-${size.name}` : ""}-print.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Xuất file thất bại");
    } finally {
      setSaving(false);
    }
  };

  const downloadCut = async () => {
    if (!cutFrame) return;
    const base = `${product.name.replace(/[^\w-]+/g, "-") || "product"}-cut`;
    let blob: Blob;
    let name: string;
    if (cutPath) {
      blob = new Blob([cutSvg(cutPath, main.width, main.height, mirror, material.id !== "none" ? material.widthMm : 0)], { type: "image/svg+xml" });
      name = `${base}.svg`;
    } else {
      blob = await (await fetch(cutFrame.config.maskUrl!)).blob();
      name = `${base}-mask.png`;
    }
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  };

  /** The finished artwork (this choice) as one more artwork in the product's library folder (server/artworks.ts). */
  const saveArtwork = async () => {
    setSaving(true);
    setSaved(null);
    try {
      const full = await renderComposite({ main, assets: flat, regions, items, selection, scale: 1, layouts, cutToFrame: true });
      const r = await ctApi.saveProductArtwork(product.id, await canvasToBlob(full, "image/png"), { name: `${product.name} — artwork`, selection: normalizeSamples(selection) });
      setSaved(r.artwork.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không lưu được artwork");
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
          {frame ? `Toàn khung edit, cắt theo khuôn "${frame.name}"` : "Toàn khung edit (không có khuôn)"}
          {cutPath && " · đường hồng = đường cắt (file cut.svg riêng, không in)"}
          {props.print?.spec.mirror && " · + nửa đối xứng"}
          {shot && ` · ${shot.w}×${shot.h}px`}
          {dpi > 0 && ` · ${mm}mm ≈ ${dpi} dpi`}
        </span>
        <span className="text-muted-foreground">Bản phẳng + layer của khách đang chọn ở Thiết kế — đúng file gửi xưởng.</span>
        <div className="ml-auto flex items-center gap-2">
          {saved && <span className="text-emerald-600">Đã lưu “{saved}” vào thư viện</span>}
          {sizes.length > 0 && (
            <CtSelect<string> className="w-28" value={sizeId || sizes[0].id} options={sizes.map((s) => ({ value: s.id, label: `Cỡ ${s.name}` }))} onChange={setSizeId} />
          )}
          <CtButton size="sm" variant="outline" onClick={() => void saveArtwork()} disabled={saving || !shot} title="Lưu artwork hoàn chỉnh (lựa chọn đang xem) vào danh mục mang tên sản phẩm (tab Artwork) — Lưu thiết kế cũng tự lưu mỗi version">
            <BookmarkPlus className="h-3.5 w-3.5" /> Lưu artwork vào thư viện
          </CtButton>
          <CtButton size="sm" variant="outline" onClick={props.onOpenSettings}>
            <Settings2 className="h-3.5 w-3.5" /> Cài đặt in
          </CtButton>
          {cutFrame && (
            <CtButton size="sm" variant="outline" onClick={() => void downloadCut()} title={cutPath ? "Đường cắt theo khuôn (vector, cùng khung px với print.png, cỡ thật theo mm) — file riêng, không in" : "Mask cắt của khuôn (PNG cùng khung với print.png)"}>
              <Scissors className="h-3.5 w-3.5" /> {cutPath ? "Tải cut.svg" : "Tải mask cắt"}
            </CtButton>
          )}
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
