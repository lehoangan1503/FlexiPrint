"use client";

/**
 * "File in" tab: the final flat 2D artwork the Thiết kế tab makes — what the factory prints. One rule for every
 * product: the flat clipart (single, combined, with or without a khuôn) + the layers, full resolution. A product
 * with a khuôn vật liệu prints only the khuôn (its cut-out parts cleared); otherwise the version's own box.
 * Never a vật liệu: how the material looks is the Mockups tab's job.
 *
 * The khuôn's cut line (asked 2026-10-29) goes into the pack as its own cut.svg — never into print.png, or the
 * printer would print it: same px box as print.png (real size in mm when the material has one), outline + holes as
 * vector paths, mirrored too when the sheet is.
 *
 * 2026-11-10: "Thiết kế nằm trong khuôn" shows the khuôn itself — solid line = the cut (all content lies inside it),
 * dashed line = the safe zone of custom options / customers' photos; every print file has its silhouette (no
 * switch); only two downloads (print.png, the pack). The fulfiller-template row, the grid and "Cài đặt in" are gone.
 */

import { useEffect, useState } from "react";
import { Download, Loader2, Package } from "lucide-react";
import type { CtAsset, CtMainLayout, CtMaterialConfig, CtPrintSilhouette, CtProduct, CtRegion, CtRegionItem, CtSelection } from "../../types";
import type { CtProductPrint } from "../../types/print";
import { displayAssets } from "../../lib/library";
import { canvasToBlob, khuonPair, mirrorSheet, printFrame, renderComposite, silhouetteCutOf, withSilhouette, type KhuonLines } from "../../lib/compositor";
import { zip } from "../../lib/zip";
import { frameSvgPath } from "../../lib/material-frame";
import { printSize, safeShapes } from "../../lib/print-template";
import { shapeBounds, shapeToSvgPath } from "../../lib/geometry";
import { CtButton, CtSelect } from "../ui";

/** Preview render: longest side in px (the download is always full resolution). */
const PREVIEW_SIDE = 1400;

/** Every print file has its silhouette (2026-11-10); an artwork with no base of its own: the print's outline. */
const DEFAULT_SILHOUETTE: CtPrintSilhouette = { enabled: true, offset: 0, hole: false, holeSize: 9 };

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
  /** The khuôn in the product is made on: its sizes (a print file per size). */
  print?: CtProductPrint | null;
  /** The product base the artwork is viewed on: its khuôn / cut / silhouette rule the file (set on the base's page). */
  baseName?: string | null;
  /** How the silhouette above the print is made (CtProductConfig.printSilhouette; always on). */
  printSilhouette: CtPrintSilhouette | null;
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
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const flat = displayAssets(assets, "flat");
  const frame = printFrame({ main, assets: flat, regions, selection });
  // The cut line follows the khuôn only when the file is cut to it (not a khuôn in size's own sheet).
  const cutFrame = frame && !size?.id ? frame : null;
  const cutPath = cutFrame && !cutFrame.config.maskUrl ? frameSvgPath(cutFrame) : "";
  const mirror = !!props.print?.spec.mirror;
  const sil = props.printSilhouette?.enabled ? props.printSilhouette : DEFAULT_SILHOUETTE;
  const spec = props.print?.spec ?? null;
  /** The khuôn's own lines on the design (solid = cut, dashed = safe zone) — on a sheet cut to the khuôn only. */
  const lines: KhuonLines | null = (() => {
    if (!cutFrame || mirror) return null;
    if (cutFrame.config.guideUrl) return { picture: { url: cutFrame.config.guideUrl, ...shapeBounds(cutFrame.shape) } };
    if (cutFrame.config.maskUrl) return null;
    if (spec?.outline && !spec.faces.length) {
      return { cut: shapeToSvgPath(spec.outline), safe: safeShapes(spec).map(shapeToSvgPath), holes: spec.cuts.map(shapeToSvgPath) };
    }
    return cutPath ? { cut: cutPath } : null;
  })();
  /** The flat sheet — and, a khuôn made as one half (spec.mirror), its mirror image beside it. */
  const flatSheet = async (): Promise<HTMLCanvasElement> => {
    const sheet = await renderComposite({ main, assets: flat, regions, items, selection, scale: 1, layouts, ...sizeArgs });
    return mirror ? mirrorSheet(sheet) : sheet;
  };
  /** The print file: the flat sheet, with the silhouette above it when on. */
  const printCanvas = async (sheet?: HTMLCanvasElement): Promise<HTMLCanvasElement> =>
    // The silhouette follows the khuôn when the file is cut to one (its outline + holes), else the print's own shape.
    withSilhouette(sheet ?? (await flatSheet()), sil, silhouetteCutOf(cutFrame, mirror));
  /** The factory pair (asked 2026-11-07): the design inside its khuôn + the empty khuôn, same px. */
  const pairOf = (sheet: HTMLCanvasElement) =>
    khuonPair(sheet, {
      cut: silhouetteCutOf(cutFrame, mirror),
      alpha: !cutFrame,
      offset: sil.offset,
      hole: sil.hole,
      holeSize: sil.holeSize,
      lines,
    });
  /** Shown: the pair for the factory (default) or the print file alone. */
  const [mode, setMode] = useState<"pair" | "file">("pair");
  const [pair, setPair] = useState<{ onKhuon: string; blank: string } | null>(null);

  useEffect(() => {
    let live = true;
    let url = "";
    const t = setTimeout(async () => {
      try {
        const sheet = await flatSheet();
        const full = await printCanvas(sheet);
        const k = Math.min(1, PREVIEW_SIDE / Math.max(full.width, full.height));
        // The pair, at preview size too.
        const p = await pairOf(sheet);
        const kp = Math.min(1, (PREVIEW_SIDE * 0.7) / Math.max(sheet.width, sheet.height));
        const pairUrls = {
          onKhuon: URL.createObjectURL(await canvasToBlob(kp < 1 ? shrink(p.onKhuon, kp) : p.onKhuon, "image/png")),
          blank: URL.createObjectURL(await canvasToBlob(kp < 1 ? shrink(p.blank, kp) : p.blank, "image/png")),
        };
        if (!live) {
          URL.revokeObjectURL(pairUrls.onKhuon);
          URL.revokeObjectURL(pairUrls.blank);
          return;
        }
        setPair((old) => {
          if (old) {
            URL.revokeObjectURL(old.onKhuon);
            URL.revokeObjectURL(old.blank);
          }
          return pairUrls;
        });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sizeArgs follows sizeId
  }, [main, assets, regions, items, selection, layouts, sizeId, sil.offset, sil.hole, sil.holeSize]);

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

  /** Everything the factory gets in one zip: print file, design in the khuôn, empty khuôn, cut line. */
  const downloadPack = async () => {
    setSaving(true);
    try {
      const sheet = await flatSheet();
      const full = await printCanvas(sheet);
      const p = await pairOf(sheet);
      const bytes = async (c: HTMLCanvasElement) => new Uint8Array(await (await canvasToBlob(c, "image/png")).arrayBuffer());
      const base = `${product.name.replace(/[^\w-]+/g, "-") || "artwork"}${size?.name ? `-${size.name}` : ""}`;
      const entries = [
        { name: `${base}-print.png`, data: await bytes(full) },
        { name: `${base}-thiet-ke-tren-khuon.png`, data: await bytes(p.onKhuon) },
        { name: `${base}-silhouette-khuon.png`, data: await bytes(p.blank) },
      ];
      entries.push({ name: `${base}-print-khong-silhouette.png`, data: await bytes(sheet) });
      if (cutPath) entries.push({ name: `${base}-cut.svg`, data: new TextEncoder().encode(cutSvg(cutPath, main.width, main.height, mirror, material.id !== "none" ? material.widthMm : 0)) });
      const href = URL.createObjectURL(zip(entries));
      const a = document.createElement("a");
      a.href = href;
      a.download = `${base}-file-in.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Xuất gói file in thất bại");
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
        <div className="flex rounded-md border p-0.5">
          {(
            [
              ["pair", "Thiết kế trong khuôn + silhouette"],
              ["file", "print.png"],
            ] as Array<["pair" | "file", string]>
          ).map(([k, label]) => (
            <button key={k} onClick={() => setMode(k)} className={`rounded px-2 py-0.5 font-medium ${mode === k ? "bg-foreground text-background" : "hover:bg-accent"}`}>
              {label}
            </button>
          ))}
        </div>
        <span className="text-muted-foreground">
          {props.baseName && `Trên base ${props.baseName} · `}
          {frame ? `Khuôn "${frame.name}"` : material.shape === "contour" ? "Cắt theo viền hình (alpha)" : "Toàn khung (không có khuôn)"}
          {props.print?.spec.mirror && " · + nửa đối xứng"}
          {" · print.png: nửa trên = silhouette, nửa dưới = bản in"}
          {shot && ` · ${shot.w}×${shot.h}px`}
          {dpi > 0 && ` · ${mm}mm ≈ ${dpi} dpi`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {sizes.length > 0 && (
            <CtSelect<string> className="w-28" value={sizeId || sizes[0].id} options={sizes.map((s) => ({ value: s.id, label: `Cỡ ${s.name}` }))} onChange={setSizeId} />
          )}
          <CtButton size="sm" variant="outline" onClick={() => void download()} disabled={saving || !shot}>
            <Download className="h-3.5 w-3.5" /> Tải print.png
          </CtButton>
          <CtButton size="sm" onClick={() => void downloadPack()} disabled={saving || !shot} title="print.png (silhouette + bản in) + thiết kế trên khuôn + silhouette khuôn + bản không silhouette (+ cut.svg) trong 1 file zip cho xưởng">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Package className="h-3.5 w-3.5" />} Tải gói file in
          </CtButton>
        </div>
      </div>
      {error ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-8">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      ) : mode === "pair" ? (
        <div className="grid min-h-0 flex-1 grid-cols-2 gap-6 overflow-auto p-6">
          {(
            [
              ["onKhuon", "Thiết kế nằm trong khuôn", lines ? "Nét liền = đường cắt (mọi nội dung nằm trong) · nét đứt = vùng an toàn cho option / ảnh khách" : "Bản in đặt đúng trên khuôn, đường hồng = đường cắt"],
              ["blank", "Silhouette khuôn (full đen)", "Như Teeinblue — cùng kích thước px, đặt bản bên trái chồng lên là ra sản phẩm"],
            ] as Array<["onKhuon" | "blank", string, string]>
          ).map(([k, title, hint]) => (
            <figure key={k} className="flex min-h-0 flex-col items-center gap-2">
              <figcaption className="text-center text-xs">
                <div className="font-semibold">{title}</div>
                <div className="text-muted-foreground">{hint}</div>
              </figcaption>
              {pair ? (
                // eslint-disable-next-line @next/next/no-img-element -- a local blob
                <img src={pair[k]} alt={title} className="max-h-[70vh] max-w-full object-contain shadow-sm" style={{ backgroundColor: "#e8e8e8", backgroundImage: "repeating-conic-gradient(#0000000f 0% 25%, transparent 0% 50%)", backgroundSize: "16px 16px" }} />
              ) : (
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              )}
            </figure>
          ))}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-8">
          {shot ? (
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
      )}
    </div>
  );
}
