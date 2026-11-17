"use client";

/**
 * Deploy page · "Vị trí trên ảnh xem trước" (asked 2026-11-17): move / scale where the artwork sits on the product's
 * preview photo, for this product only — the store's preview and the front mockups follow, the print file does not
 * (it never reads config.scene). Saved as CtProductConfig.previewBox (POST products/:id/preview-box); the store gets
 * it at the next Deploy.
 *
 * Three pictures: the photo with the frame and the part of the product the photo shows (from the fulfiller's
 * overlay), the result exactly as the storefront draws it (same compositor + lib/scene drawOnScene), and the artwork
 * with what the photo hides in red and the khuôn's safe zone.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  Maximize2,
  Minimize2,
  RotateCcw,
  Save,
  ScanLine,
} from "lucide-react";
import type {
  CtProduct,
  CtProductScene,
  CtRenderAsset,
  CtSelection,
  CtTemplate,
} from "../../types";
import { ctApi } from "../../lib/api-client";
import {
  compositeBleed,
  loadImage,
  printFrame,
  renderComposite,
} from "../../lib/compositor";
import {
  defaultSelection,
  fontsUsed,
  normalizeProductConfig,
  normalizeRegion,
} from "../../lib/design";
import { drawOnScene } from "../../lib/scene";
import { materialPreset } from "../../lib/materials";
import { previewPieces } from "../../lib/assembly";
import { ctGoogleFontsHref } from "../../config";
import { CtButton, cx } from "../ui";

type Box = CtProductScene["box"];

/** Overlay alpha below this = the product shows there (the artwork is seen through). */
const SHOWS = 200;
/** Long side of the pictures drawn here (px). */
const SIDE = 1100;

interface Hole {
  /** White where the product shows, clear elsewhere — photo px scaled to SIDE. */
  mask: HTMLCanvasElement;
  /** The same area tinted, for the first picture. */
  tint: HTMLCanvasElement;
  /** Bounding box of where the product shows (photo px). */
  bounds: Box;
}

interface Hidden {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export function PreviewBoxCard({
  product,
  tpl,
  onSaved,
}: {
  product: CtProduct;
  tpl: CtTemplate;
  onSaved: (p: CtProduct) => void;
}) {
  const config = useMemo(
    () => normalizeProductConfig(product.config),
    [product.config],
  );
  const scene = config.scene;
  const saved = scene.box;
  const own = !!scene.url && config.previewBox?.url === scene.url;
  const [box, setBox] = useState<Box>(saved);
  const [busy, setBusy] = useState<"save" | "reset" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hole, setHole] = useState<Hole | null>(null);
  const [design, setDesign] = useState<{
    canvas: HTMLCanvasElement;
    bleed: { x: number; y: number };
  } | null>(null);
  const [hidden, setHidden] = useState<Hidden | null>(null);
  /** Full-screen view (asked 2026-11-17: "to thì full width màn hình cho dễ nhìn dễ chỉnh"). */
  const [big, setBig] = useState(false);
  const photoRef = useRef<HTMLCanvasElement>(null);
  const resultRef = useRef<HTMLCanvasElement>(null);
  const artRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => setBox(saved), [saved]);
  const dirty =
    Math.abs(box.x - saved.x) > 0.5 ||
    Math.abs(box.y - saved.y) > 0.5 ||
    Math.abs(box.w - saved.w) > 0.5;

  const main = useMemo((): CtRenderAsset | null => {
    const m = tpl.assets.find((a) => a.id === tpl.mainAssetId);
    return m ? { ...m, width: tpl.width, height: tpl.height } : null;
  }, [tpl]);
  const regions = useMemo(() => tpl.regions.map(normalizeRegion), [tpl]);
  const selection = useMemo(
    (): CtSelection =>
      defaultSelection(regions, tpl.items, tpl.assets, tpl.mainAssetId),
    [regions, tpl],
  );
  // The preview this card draws must be the storefront's: no AI phôi of the shown version, no pack / clothes mockup.
  const shownPhoi = (tpl.config.versionPhoi ?? []).some(
    (v) => v.mainId === tpl.mainAssetId,
  );
  const usable =
    !!scene.url &&
    !!main &&
    !shownPhoi &&
    !tpl.config.mockupEdit &&
    !(tpl.config.zoneMockups ?? []).length;

  // Esc leaves the full-screen view; the page behind does not scroll meanwhile.
  useEffect(() => {
    if (!big) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setBig(false);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [big]);

  // Text layers draw with their own fonts.
  useEffect(() => {
    const families = fontsUsed(regions);
    if (!families.length || document.getElementById("ct-fonts-deploy")) return;
    const link = document.createElement("link");
    link.id = "ct-fonts-deploy";
    link.rel = "stylesheet";
    link.href = ctGoogleFontsHref(families);
    document.head.append(link);
  }, [regions]);

  // Where the product shows on the photo: the fulfiller's overlay (see-through there).
  useEffect(() => {
    if (!scene.url || !scene.overlay) {
      setHole(null);
      return;
    }
    let cancelled = false;
    loadImage(scene.overlay)
      .then((ov) => {
        if (cancelled) return;
        setHole(holeOf(ov, scene));
      })
      .catch(() => !cancelled && setHole(null));
    return () => {
      cancelled = true;
    };
  }, [scene]);

  // The design as the storefront renders it for this photo (renderStage: cut to the khuôn, sewn pieces, bleed).
  useEffect(() => {
    if (!usable || !main) return;
    let cancelled = false;
    const run = async () => {
      if (document.fonts?.ready)
        await document.fonts.ready.catch(() => undefined);
      const input = {
        main,
        assets: tpl.assets,
        regions,
        items: tpl.items,
        selection,
        layouts: tpl.config.layouts,
        assembly: tpl.config.assembly,
      };
      const cut = !!printFrame({
        main,
        assets: tpl.assets,
        regions,
        selection,
      });
      const assembled = previewPieces(tpl.config.assembly);
      const b = cut ? { x: 0, y: 0 } : compositeBleed(input);
      const scale = Math.min(
        1,
        (SIDE * 2) / Math.max(main.width + 2 * b.x, main.height + 2 * b.y),
      );
      const canvas = await renderComposite({
        ...input,
        scale,
        bleed: !cut && !assembled,
        display: true,
        cutToFrame: cut,
        assembled,
      });
      if (!cancelled)
        setDesign({
          canvas,
          bleed: { x: b.x / main.width, y: b.y / main.height },
        });
    };
    run().catch(
      (e: Error) =>
        !cancelled && setError(`Không vẽ được artwork: ${e.message}`),
    );
    return () => {
      cancelled = true;
    };
  }, [usable, main, regions, selection, tpl]);

  // Redraw the three pictures when the frame moves.
  useEffect(() => {
    if (!design || !scene.url) return;
    let cancelled = false;
    const k = SIDE / Math.max(scene.width, scene.height);
    const W = Math.round(scene.width * k);
    const H = Math.round(scene.height * k);
    const shown: CtProductScene = { ...scene, box };
    void (async () => {
      const bg = await loadImage(scene.url as string).catch(() => null);
      const result = await drawOnScene(
        shown,
        design.canvas,
        SIDE,
        design.bleed,
        false,
        materialPreset(tpl.config.material.id).whiteInk,
      ).catch(() => null);
      if (cancelled) return;
      // 1. photo + frame
      const p = photoRef.current;
      const pg = p?.getContext("2d");
      if (p && pg) {
        p.width = W;
        p.height = H;
        if (bg) pg.drawImage(bg, 0, 0, W, H);
        if (hole) {
          pg.save();
          pg.globalAlpha = 0.3;
          pg.drawImage(hole.tint, 0, 0, W, H);
          pg.restore();
        }
        pg.save();
        pg.setLineDash([10, 7]);
        pg.lineWidth = 3;
        pg.strokeStyle = "#ec4899";
        pg.strokeRect(box.x * k, box.y * k, box.w * k, box.h * k);
        pg.restore();
      }
      // 2. the storefront's picture
      const r = resultRef.current;
      const rg = r?.getContext("2d");
      if (r && rg && result) {
        r.width = result.width;
        r.height = result.height;
        rg.drawImage(result, 0, 0);
      }
      // 3. the artwork, what the photo hides in red, the safe zone
      const a = artRef.current;
      const ag = a?.getContext("2d");
      if (a && ag && main) {
        const aw = Math.round(
          (SIDE * main.width) / Math.max(main.width, main.height),
        );
        const ah = Math.round(
          (SIDE * main.height) / Math.max(main.width, main.height),
        );
        a.width = aw;
        a.height = ah;
        ag.clearRect(0, 0, aw, ah);
        // the design canvas may carry bleed around the main: draw only the main's part
        const bx =
          (design.bleed.x * design.canvas.width) / (1 + 2 * design.bleed.x);
        const by =
          (design.bleed.y * design.canvas.height) / (1 + 2 * design.bleed.y);
        ag.drawImage(
          design.canvas,
          bx,
          by,
          design.canvas.width - 2 * bx,
          design.canvas.height - 2 * by,
          0,
          0,
          aw,
          ah,
        );
        if (hole) {
          const red = document.createElement("canvas");
          red.width = aw;
          red.height = ah;
          const g = red.getContext("2d");
          if (g) {
            g.fillStyle = "#000";
            g.fillRect(0, 0, aw, ah);
            g.globalCompositeOperation = "destination-out";
            const s = aw / box.w; // photo px → artwork px
            g.drawImage(
              hole.mask,
              -box.x * s,
              -box.y * s,
              scene.width * s,
              scene.height * s,
            );
            const md = g.getImageData(0, 0, aw, ah).data;
            setHidden(hiddenOf(md, aw, ah));
            g.globalCompositeOperation = "source-in";
            g.fillStyle = "#dc2626";
            g.fillRect(0, 0, aw, ah);
            ag.save();
            ag.globalAlpha = 0.6;
            ag.drawImage(red, 0, 0);
            ag.restore();
          }
        } else setHidden(null);
        const safe = tpl.config.print?.spec.safe ?? [];
        const sk = aw / main.width;
        ag.save();
        ag.setLineDash([aw / 40, aw / 60]);
        ag.lineWidth = Math.max(3, aw / 110);
        ag.strokeStyle = "#22c55e";
        for (const sh of safe)
          if ("w" in sh && "h" in sh)
            ag.strokeRect(sh.x * sk, sh.y * sk, sh.w * sk, sh.h * sk);
        ag.restore();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [design, box, hole, scene, main, tpl]);

  if (!usable) return null;

  // Sliders: the frame's centre and size, relative to the saved frame.
  const cx0 = saved.x + saved.w / 2;
  const cy0 = saved.y + saved.h / 2;
  const cxNow = box.x + box.w / 2;
  const cyNow = box.y + box.h / 2;
  const sizeNow = box.w / saved.w;
  const setFrame = (c: { cx?: number; cy?: number; size?: number }) => {
    const size = c.size ?? sizeNow;
    const w = saved.w * size;
    const h = saved.h * size;
    const x = (c.cx ?? cxNow) - w / 2;
    const y = (c.cy ?? cyNow) - h / 2;
    setBox({ x, y, w, h });
  };
  const cover = () => {
    if (!hole) return;
    const b = hole.bounds;
    const asp = saved.w / saved.h;
    const w = Math.max(b.w, b.h * asp);
    const h = w / asp;
    setBox({ x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w, h });
  };
  const save = async (next: Box | null) => {
    setBusy(next ? "save" : "reset");
    setError(null);
    try {
      onSaved(await ctApi.setPreviewBox(product.id, next));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không lưu được");
    } finally {
      setBusy(null);
    }
  };
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const range = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    show: string,
    on: (v: number) => void,
  ) => (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <input
        type="range"
        className="min-w-0 flex-1 accent-sky-500"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => on(Number(e.target.value))}
      />
      <span className="w-20 shrink-0 text-right font-mono tabular-nums">
        {show}
      </span>
    </label>
  );

  return (
    <section
      className={cx(
        "space-y-3 bg-card",
        big
          ? "fixed inset-0 z-50 overflow-auto bg-background px-6 py-5"
          : "rounded-xl border p-4",
      )}
      role={big ? "dialog" : undefined}
      aria-modal={big || undefined}
      aria-label={big ? "Vị trí trên ảnh xem trước" : undefined}
    >
      <div
        className={cx(
          "flex items-start gap-3",
          big && "mx-auto max-w-[1800px]",
        )}
      >
        <div className="min-w-0 flex-1">
          <h2 className={cx("font-semibold", big ? "text-base" : "text-sm")}>
            Vị trí trên ảnh xem trước
          </h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Chỉ đổi ảnh xem trước trên store và mockup mặt trước của sản phẩm
            này. File in gửi xưởng không đổi. Lưu xong bấm Deploy cập nhật để
            store nhận.
            {own
              ? " Đang dùng vị trí riêng của sản phẩm."
              : " Đang dùng khung của product base."}
          </p>
        </div>
        <CtButton
          size="icon"
          variant="ghost"
          onClick={() => setBig(!big)}
          title={big ? "Thu nhỏ (Esc)" : "Phóng to toàn màn hình"}
          aria-label={big ? "Thu nhỏ" : "Phóng to"}
        >
          {big ? (
            <Minimize2 className="h-4 w-4" />
          ) : (
            <Maximize2 className="h-4 w-4" />
          )}
        </CtButton>
      </div>
      <div className={cx("space-y-3", big && "mx-auto max-w-[1800px]")}>
        <div className={cx("grid grid-cols-3", big ? "gap-4" : "gap-2")}>
          <figure className="min-w-0 space-y-1">
            <canvas ref={photoRef} className="w-full rounded-md border" />
            <figcaption className="text-[11px] text-muted-foreground">
              Ảnh phôi + khung (hồng).{" "}
              {hole ? "Vùng xanh: phần sản phẩm thấy được." : ""}
            </figcaption>
          </figure>
          <figure className="min-w-0 space-y-1">
            <canvas ref={resultRef} className="w-full rounded-md border" />
            <figcaption className="text-[11px] text-muted-foreground">
              Khách thấy trên store.
            </figcaption>
          </figure>
          <figure className="min-w-0 space-y-1">
            <canvas ref={artRef} className="w-full rounded-md border" />
            <figcaption className="text-[11px] text-muted-foreground">
              Artwork: đỏ = bị ảnh che (vẫn in), nét đứt xanh lá = vùng an toàn.
            </figcaption>
          </figure>
        </div>
        {hidden && (
          <div className="grid grid-cols-4 gap-2 text-xs">
            {(
              [
                ["Mất trên", hidden.top],
                ["Mất dưới", hidden.bottom],
                ["Mất trái", hidden.left],
                ["Mất phải", hidden.right],
              ] as const
            ).map(([k, v]) => (
              <div
                key={k}
                className={cx(
                  "rounded-md border px-2 py-1.5",
                  v >= 0.08 && "border-red-500/60 bg-red-500/10",
                )}
              >
                <div className="text-[11px] text-muted-foreground">{k}</div>
                <div className="font-mono text-sm tabular-nums">{pct(v)}</div>
              </div>
            ))}
          </div>
        )}
        <div className="space-y-1.5">
          {range(
            "Dọc",
            cyNow,
            cy0 - saved.h * 0.3,
            cy0 + saved.h * 0.3,
            1,
            `y ${Math.round(box.y)}`,
            (v) => setFrame({ cy: v }),
          )}
          {range(
            "Ngang",
            cxNow,
            cx0 - saved.w * 0.3,
            cx0 + saved.w * 0.3,
            1,
            `x ${Math.round(box.x)}`,
            (v) => setFrame({ cx: v }),
          )}
          {range("Cỡ", sizeNow, 0.7, 1.4, 0.005, pct(sizeNow), (v) =>
            setFrame({ size: v }),
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {hole && (
            <CtButton
              size="sm"
              variant="outline"
              onClick={cover}
              disabled={!!busy}
            >
              <ScanLine className="h-3.5 w-3.5" /> Phủ vừa sản phẩm
            </CtButton>
          )}
          {dirty && (
            <CtButton
              size="sm"
              variant="ghost"
              onClick={() => setBox(saved)}
              disabled={!!busy}
            >
              Bỏ thay đổi
            </CtButton>
          )}
          {own && (
            <CtButton
              size="sm"
              variant="ghost"
              onClick={() => void save(null)}
              disabled={!!busy}
            >
              {busy === "reset" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}{" "}
              Về khung của base
            </CtButton>
          )}
          <span className="ml-auto" />
          <CtButton
            size="sm"
            variant="primary"
            onClick={() => void save(box)}
            disabled={!dirty || !!busy}
          >
            {busy === "save" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}{" "}
            Lưu vị trí
          </CtButton>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </section>
  );
}

/** Where the product shows on the photo, read off the overlay (photo px scaled to SIDE for the masks). */
function holeOf(ov: HTMLImageElement, scene: CtProductScene): Hole {
  const k = SIDE / Math.max(scene.width, scene.height);
  const W = Math.round(scene.width * k);
  const H = Math.round(scene.height * k);
  const mask = document.createElement("canvas");
  mask.width = W;
  mask.height = H;
  const g = mask.getContext("2d");
  let bounds: Box = { x: 0, y: 0, w: scene.width, h: scene.height };
  if (g) {
    g.drawImage(ov, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H);
    const rows = new Array<number>(H).fill(0);
    const cols = new Array<number>(W).fill(0);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = 4 * (y * W + x);
        const shows = d.data[i + 3] < SHOWS;
        d.data[i] = 255;
        d.data[i + 1] = 255;
        d.data[i + 2] = 255;
        d.data[i + 3] = shows ? 255 : 0;
        if (shows) {
          rows[y]++;
          cols[x]++;
        }
      }
    }
    g.putImageData(d, 0, 0);
    // Rows / columns with a real stretch of product (a stray see-through pixel is not the product).
    const minRow = W * 0.02;
    const minCol = H * 0.02;
    const ys = rows.map((n, y) => (n > minRow ? y : -1)).filter((y) => y >= 0);
    const xs = cols.map((n, x) => (n > minCol ? x : -1)).filter((x) => x >= 0);
    if (ys.length && xs.length) {
      const x0 = xs[0] / k;
      const x1 = (xs[xs.length - 1] + 1) / k;
      const y0 = ys[0] / k;
      const y1 = (ys[ys.length - 1] + 1) / k;
      bounds = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
  }
  const tint = document.createElement("canvas");
  tint.width = W;
  tint.height = H;
  const tg = tint.getContext("2d");
  if (tg) {
    tg.drawImage(mask, 0, 0);
    tg.globalCompositeOperation = "source-in";
    tg.fillStyle = "#14b8a6";
    tg.fillRect(0, 0, W, H);
  }
  return { mask, tint, bounds };
}

/** Share of the artwork hidden on each side, measured through its middle (mask alpha > 128 = hidden). */
function hiddenOf(md: Uint8ClampedArray, w: number, h: number): Hidden {
  const hid = (x: number, y: number) => md[4 * (y * w + x) + 3] > 128;
  const cx = Math.round(w / 2);
  const cy = Math.round(h / 2);
  let t = 0;
  while (t < h && hid(cx, t)) t++;
  let b = 0;
  while (b < h && hid(cx, h - 1 - b)) b++;
  let l = 0;
  while (l < w && hid(l, cy)) l++;
  let r = 0;
  while (r < w && hid(w - 1 - r, cy)) r++;
  return { top: t / h, bottom: b / h, left: l / w, right: r / w };
}
