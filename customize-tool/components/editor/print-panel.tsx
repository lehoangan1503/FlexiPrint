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

import { useEffect, useRef, useState } from "react";
import { Download, Eye, EyeOff, Loader2, Package, Scissors, Settings2, Upload, X } from "lucide-react";
import type { CtAsset, CtMainLayout, CtMaterialConfig, CtPrintGuide, CtPrintSilhouette, CtProduct, CtRegion, CtRegionItem, CtSelection } from "../../types";
import type { CtProductPrint } from "../../types/print";
import { displayAssets } from "../../lib/library";
import { canvasToBlob, khuonPair, mirrorSheet, printFrame, renderComposite, silhouetteCutOf, withSilhouette } from "../../lib/compositor";
import { zip } from "../../lib/zip";
import { frameSvgPath } from "../../lib/material-frame";
import { printSize } from "../../lib/print-template";
import { printApi } from "../../lib/print-api";
import { GridLines, GridToggleButton, useGridToggle } from "./grid";
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
  /** The product base the artwork is viewed on: its khuôn / cut / silhouette rule the file (set on the base's page). */
  baseName?: string | null;
  /** The fulfiller's template laid over the print file (CtProductConfig.printGuide). */
  printGuide: CtPrintGuide | null;
  onPrintGuide: (g: CtPrintGuide | null) => void;
  /** Silhouette above the print (CtProductConfig.printSilhouette). */
  printSilhouette: CtPrintSilhouette | null;
  onPrintSilhouette: (s: CtPrintSilhouette | null) => void;
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
  const sil = props.printSilhouette?.enabled ? props.printSilhouette : null;
  /** The flat sheet — and, a khuôn made as one half (spec.mirror), its mirror image beside it. */
  const flatSheet = async (): Promise<HTMLCanvasElement> => {
    const sheet = await renderComposite({ main, assets: flat, regions, items, selection, scale: 1, layouts, ...sizeArgs });
    return mirror ? mirrorSheet(sheet) : sheet;
  };
  /** The print file: the flat sheet, with the silhouette above it when on. */
  const printCanvas = async (sheet?: HTMLCanvasElement): Promise<HTMLCanvasElement> =>
    // The silhouette follows the khuôn when the file is cut to one (its outline + holes), else the print's own shape.
    withSilhouette(sheet ?? (await flatSheet()), props.printSilhouette, silhouetteCutOf(cutFrame, mirror));
  /** The factory pair (asked 2026-11-07): the design inside its khuôn + the empty khuôn, same px. */
  const pairOf = (sheet: HTMLCanvasElement) =>
    khuonPair(sheet, {
      cut: silhouetteCutOf(cutFrame, mirror),
      alpha: !cutFrame && (props.print?.kind === "cut" || material.shape === "contour" || !!sil),
      offset: sil?.offset ?? 0,
      hole: sil?.hole ?? false,
      holeSize: sil?.holeSize ?? 9,
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
        // The cut line on the preview only (a copy; print.png stays clean): the khuôn's outline + holes, magenta.
        const small = k < 1 || cutPath ? shrink(full, k) : full;
        if (cutPath && !sil) drawCutLine(small, cutPath, k, mirror ? main.width : 0);
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
  }, [main, assets, regions, items, selection, layouts, sizeId, sil?.offset, sil?.hole, sil?.holeSize, !!sil]);

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
      if (sil) entries.push({ name: `${base}-print-khong-silhouette.png`, data: await bytes(sheet) });
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

  const mm = material.id !== "none" ? material.widthMm : 0;
  const dpi = shot && mm ? Math.round(shot.w / (mm / 25.4)) : 0;

  // ---- the template over the print file (never in print.png) ----
  const guideUrl = props.printGuide?.url ?? props.print?.spec.frameUrl ?? null;
  const guideOwn = !!props.printGuide;
  const [guideOn, setGuideOn] = useState(true);
  const [guideOpacity, setGuideOpacity] = useState(0.5);
  const [guideBusy, setGuideBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const uploadGuide = async (file: File) => {
    setGuideBusy(true);
    try {
      const r = await printApi.uploadImage(file);
      props.onPrintGuide({ url: r.url, width: r.width, height: r.height, name: file.name });
      setGuideOn(true);
      if (shot && r.width && r.height && Math.abs(r.width / r.height - shot.w / shot.h) > 0.02) {
        setError(null);
        setNotice(`Template ${r.width}×${r.height}px khác tỉ lệ file in ${shot.w}×${shot.h}px — được kéo giãn cho vừa khung file in`);
      } else setNotice(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tải được template");
    } finally {
      setGuideBusy(false);
    }
  };
  const [notice, setNotice] = useState<string | null>(null);
  const [showGrid, toggleGrid] = useGridToggle();

  // ---- where the preview sits in its box (for the rulers and the template over it) ----
  const viewRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [place, setPlace] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const measure = () => {
    const v = viewRef.current;
    const im = imgRef.current;
    if (!v || !im || !im.naturalWidth) return;
    const vr = v.getBoundingClientRect();
    const ir = im.getBoundingClientRect();
    setPlace({ x: ir.left - vr.left, y: ir.top - vr.top, w: ir.width, h: ir.height });
  };
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(v);
    return () => ro.disconnect();
  }, []);

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
          {frame ? `Toàn khung edit, cắt theo khuôn "${frame.name}"` : material.shape === "contour" ? "Cắt theo viền hình (alpha)" : "Toàn khung edit (không có khuôn)"}
          {cutPath && " · đường hồng = đường cắt (file cut.svg riêng, không in)"}
          {props.print?.spec.mirror && " · + nửa đối xứng"}
          {sil && " · nửa trên = silhouette, nửa dưới = bản in"}
          {shot && ` · ${shot.w}×${shot.h}px`}
          {dpi > 0 && ` · ${mm}mm ≈ ${dpi} dpi`}
        </span>
        <span className="text-muted-foreground">Bản phẳng + layer của khách đang chọn ở Thiết kế — đúng file gửi xưởng.</span>
        <div className="ml-auto flex items-center gap-2">
          {sizes.length > 0 && (
            <CtSelect<string> className="w-28" value={sizeId || sizes[0].id} options={sizes.map((s) => ({ value: s.id, label: `Cỡ ${s.name}` }))} onChange={setSizeId} />
          )}
          <CtButton size="sm" variant="outline" onClick={props.onOpenSettings}>
            <Settings2 className="h-3.5 w-3.5" /> Cài đặt in
          </CtButton>
          {cutFrame && (
            <CtButton size="sm" variant="outline" onClick={() => void downloadCut()} title={cutPath ? "Đường cắt theo khuôn (vector, cùng khung px với print.png, cỡ thật theo mm) — file riêng, không in" : "Mask cắt của khuôn (PNG cùng khung với print.png)"}>
              <Scissors className="h-3.5 w-3.5" /> {cutPath ? "Tải cut.svg" : "Tải mask cắt"}
            </CtButton>
          )}
          <CtButton size="sm" variant="outline" onClick={() => void download()} disabled={saving || !shot}>
            <Download className="h-3.5 w-3.5" /> Tải print.png
          </CtButton>
          <CtButton size="sm" onClick={() => void downloadPack()} disabled={saving || !shot} title="print.png + thiết kế trên khuôn + silhouette khuôn full đen (+ cut.svg, bản không silhouette) trong 1 file zip cho xưởng">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Package className="h-3.5 w-3.5" />} Tải gói file in
          </CtButton>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-1.5 text-xs">
        <span className="font-medium">Template fulfill</span>
        {guideUrl ? (
          <>
            <CtButton size="sm" variant={guideOn ? "primary" : "outline"} onClick={() => setGuideOn((v) => !v)} title="Chỉ để tham chiếu vùng — không bao giờ có trong print.png">
              {guideOn ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />} {guideOn ? "Đang hiện" : "Đang ẩn"}
            </CtButton>
            {guideOn && (
              <label className="flex items-center gap-1.5 text-muted-foreground">
                Độ rõ
                <input type="range" min={10} max={100} value={Math.round(guideOpacity * 100)} onChange={(e) => setGuideOpacity(Number(e.target.value) / 100)} className="w-24 accent-sky-500" />
              </label>
            )}
            <span className="max-w-64 truncate text-muted-foreground" title={props.printGuide?.name}>
              {guideOwn ? `${props.printGuide?.name || "template"}${props.printGuide?.width ? ` · ${props.printGuide.width}×${props.printGuide.height}px` : ""}` : "Khung hướng dẫn của khuôn in"}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">Chưa có — tải ảnh template của bên fulfill (PNG / JPEG / WebP, đúng kích thước file in) để đặt đè lên xem vùng.</span>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void uploadGuide(f);
          }}
        />
        <CtButton size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={guideBusy}>
          {guideBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} {guideOwn ? "Đổi template" : "Tải template"}
        </CtButton>
        {guideOwn && (
          <CtButton size="sm" variant="ghost" onClick={() => props.onPrintGuide(null)} title="Bỏ template của sản phẩm (nhớ Lưu thiết kế)">
            <X className="h-3.5 w-3.5" /> Bỏ
          </CtButton>
        )}
        {notice && <span className="text-amber-600">{notice}</span>}
        <span className="ml-auto flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 font-medium" title="Như file mica của Teeinblue / Merchize: hình khối đen của bản in ở nửa trên (lớp in trắng / đường cắt), bản in ở nửa dưới — một file cao gấp đôi. Áp dụng cả file in tạo lúc khách thêm vào giỏ (sau Publish).">
            <input
              type="checkbox"
              className="accent-sky-500"
              disabled={!!props.baseName}
              checked={!!sil}
              onChange={(e) => props.onPrintSilhouette(e.target.checked ? { enabled: true, offset: props.printSilhouette?.offset ?? 0, hole: props.printSilhouette?.hole ?? true, holeSize: props.printSilhouette?.holeSize ?? 9 } : null)}
            />
            Silhouette
          </label>
          {props.baseName && <span className="text-muted-foreground">theo base {props.baseName}</span>}
          {sil && (
            <span className="text-muted-foreground" title={cutFrame ? "Silhouette lấy đúng hình khuôn của sản phẩm (đường cắt + lỗ)" : "Không có khuôn: silhouette lấy theo viền bản in"}>
              {cutFrame ? `theo khuôn "${cutFrame.name}"` : "theo viền bản in"}
            </span>
          )}
          {sil && cutFrame && (cutFrame.config.cuts ?? []).length > 0 && <span className="text-muted-foreground">· lỗ treo lấy theo khuôn</span>}
          {sil && !(cutFrame && (cutFrame.config.cuts ?? []).length > 0) && (
            <label className="flex cursor-pointer items-center gap-1.5" title="Tai treo tròn có lỗ ở giữa mép trên của hình (ornament)">
              <input type="checkbox" className="accent-sky-500" disabled={!!props.baseName} checked={sil.hole} onChange={(e) => props.onPrintSilhouette({ ...sil, hole: e.target.checked })} />
              Lỗ treo
            </label>
          )}
          {sil?.hole && !(cutFrame && (cutFrame.config.cuts ?? []).length > 0) && (
            <label className="flex items-center gap-1.5 text-muted-foreground" title="Đường kính ngoài của tai treo, % chiều rộng của hình">
              Cỡ
              <input
                type="number"
                min={2}
                max={25}
                step={0.5}
                disabled={!!props.baseName}
                value={sil.holeSize}
                onChange={(e) => props.onPrintSilhouette({ ...sil, holeSize: Math.max(2, Math.min(25, Number(e.target.value) || 9)) })}
                className="w-14 rounded border bg-background px-1.5 py-0.5 tabular-nums"
              />
              %
            </label>
          )}
          {sil && !cutFrame && (
            <label className="flex items-center gap-1.5 text-muted-foreground" title="Nới hình khối ra ngoài mép bản in (px của file in)">
              Nới viền
              <input
                type="number"
                min={0}
                max={60}
                disabled={!!props.baseName}
                value={sil.offset}
                onChange={(e) => props.onPrintSilhouette({ ...sil, offset: Math.max(0, Math.min(60, Math.round(Number(e.target.value) || 0))) })}
                className="w-14 rounded border bg-background px-1.5 py-0.5 tabular-nums"
              />
              px
            </label>
          )}
          {shot && <GridToggleButton on={showGrid} onToggle={toggleGrid} />}
        </span>
      </div>
      {mode === "pair" && !error && (
        <div className="grid min-h-0 flex-1 grid-cols-2 gap-6 overflow-auto p-6">
          {(
            [
              ["onKhuon", "Thiết kế nằm trong khuôn", "Bản in đặt đúng trên khuôn, đường hồng = đường cắt"],
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
          {sil && (
            <p className="col-span-2 text-center text-[11px] text-muted-foreground">
              Silhouette đang bật: print.png = silhouette đen ở nửa trên + bản in ở nửa dưới (xem ở chế độ print.png); gói file in có thêm bản không silhouette.
            </p>
          )}
        </div>
      )}
      <div ref={viewRef} className={`relative min-h-0 flex-1 items-center justify-center overflow-hidden p-8 ${mode === "pair" && !error ? "hidden" : "flex"}`}>
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : shot ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element -- a local blob, not an optimizable remote image */}
            <img
              ref={imgRef}
              src={shot.url}
              alt="File in"
              onLoad={measure}
              className="max-h-full max-w-full object-contain shadow-sm"
              style={{ backgroundColor: "#fff", backgroundImage: "repeating-conic-gradient(#0000000f 0% 25%, transparent 0% 50%)", backgroundSize: "16px 16px" }}
            />
            {guideUrl && guideOn && place && (
              // The template stretched onto the print file's box — a picture over the preview, never drawn into it.
              // eslint-disable-next-line @next/next/no-img-element -- our R2 file
              <img
                src={guideUrl}
                alt=""
                className="pointer-events-none absolute max-w-none select-none"
                style={{ left: place.x, top: place.y, width: place.w, height: place.h, opacity: guideOpacity }}
              />
            )}
            {place && showGrid && (
              <svg
                className="pointer-events-none absolute overflow-visible"
                style={{ left: place.x, top: place.y, width: place.w, height: place.h }}
                viewBox={`0 0 ${shot.w} ${shot.h}`}
                preserveAspectRatio="none"
              >
                <GridLines width={shot.w} height={shot.h} zoom={place.w / shot.w} />
              </svg>
            )}
          </>
        ) : (
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        )}
      </div>
    </div>
  );
}
