"use client";

/**
 * Phôi AI theo version (2026-11-08, asked: "riêng bước này phải dùng ảnh AI gen thì vật liệu mới thật được"): for every
 * version of the artwork, a real-looking photo of the piece on the base — what Teeinblue's designers draw by hand as
 * one "Preview scene" per version. Made here, sent to the AI (server/version-phoi.ts):
 *
 *   the reference  the base's background (1024²), a rough clear plate along the WHOLE version (its default picks
 *                  included, so the plate reaches under them), then only the version's FIXED parts printed on it —
 *                  the picks / texts the customer changes are left out: they are laid on the photo live
 *   the answer     the AI's real photo, put back on the reference's pixels by layer-kit — so the canvas box is known
 *
 * Preview only: the print file is the design itself, never this photo.
 */

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import type { CtAsset, CtBaseProductRow, CtMainLayout, CtProduct, CtProductScene, CtRegion, CtRegionItem, CtSelection, CtVersionPhoi, CtVersionPhoiStatus } from "../../types";
import { CT_MAIN_KEY } from "../../types";
import { canvasToBlob, loadImage, renderComposite } from "../../lib/compositor";
import { drawPlate } from "../../lib/scene";
import { ctApi } from "../../lib/api-client";
import { CHECKER_STYLE, CtButton, CtModal } from "../ui";

/** The AI's square. */
const SIDE = 1024;

export interface VersionPhoiDialogProps {
  open: boolean;
  onClose: () => void;
  product: CtProduct;
  main: CtAsset;
  /** The versions (main assets), in order. */
  mains: CtAsset[];
  assets: CtAsset[];
  regions: CtRegion[];
  items: CtRegionItem[];
  layouts: Record<string, CtMainLayout>;
  /** The design's samples (default picks / texts). */
  selection: CtSelection;
  base: CtBaseProductRow;
  /** The base's preview photo laid for this artwork (withBase: background + where the canvas goes + the plate). */
  scene: CtProductScene;
  status: CtVersionPhoiStatus;
  onStatus: (s: CtVersionPhoiStatus) => void;
}

/** The reference picture of one version: background, clear plate along everything, fixed parts printed. */
async function referenceOf(p: VersionPhoiDialogProps, version: CtAsset): Promise<{ blob: Blob; box: CtVersionPhoi["box"] }> {
  const scene = p.scene;
  if (!scene.url) throw new Error("Base chưa có ảnh nền xem trước");
  const bg = await loadImage(scene.url);
  // Cover the AI's square with the photo, centred.
  const k = SIDE / Math.min(scene.width, scene.height);
  const ox = (SIDE - scene.width * k) / 2;
  const oy = (SIDE - scene.height * k) / 2;
  const box = { x: ox + scene.box.x * k, y: oy + scene.box.y * k, w: scene.box.w * k, h: scene.box.h * k };
  const selection: CtSelection = { ...p.selection, [CT_MAIN_KEY]: { kind: "main", assetId: version.id } };
  const input = { main: p.main, assets: p.assets, regions: p.regions, items: p.items, selection, layouts: p.layouts, display: true };
  const scale = Math.min(1, box.w / p.main.width);
  const [whole, fixed] = await Promise.all([renderComposite({ ...input, scale }), renderComposite({ ...input, scale, part: "static" })]);
  const c = document.createElement("canvas");
  c.width = SIDE;
  c.height = SIDE;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D không khả dụng");
  ctx.drawImage(bg, ox, oy, scene.width * k, scene.height * k);
  drawPlate(ctx, whole, box.x, box.y, box.w, box.h, (scene.plate?.border ?? 0.025) * box.w);
  ctx.drawImage(fixed, box.x, box.y, box.w, box.h);
  return { blob: await canvasToBlob(c, "image/png"), box };
}

export function VersionPhoiDialog(props: VersionPhoiDialogProps) {
  const { product, mains, base, status } = props;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refs, setRefs] = useState<Record<string, string>>({});
  const phoiOf = (id: string) => status.phoi.find((v) => v.mainId === id && v.baseId === base.id) ?? null;
  // The newest job of each version (status.jobs is newest first).
  const jobOf = (id: string) => status.jobs.find((j) => j.description === id) ?? null;
  const running = mains.some((m) => jobOf(m.id)?.status === "running");

  // While a job runs, ask again every 6 s.
  const onStatus = useRef(props.onStatus);
  onStatus.current = props.onStatus;
  useEffect(() => {
    if (!props.open || !running) return;
    const t = setInterval(() => {
      ctApi
        .versionPhoi(product.id)
        .then((s) => onStatus.current(s))
        .catch(() => undefined);
    }, 6000);
    return () => clearInterval(t);
  }, [props.open, running, product.id]);

  const make = async (list: CtAsset[]) => {
    setError(null);
    for (const v of list) {
      setBusy(`Đang dựng ảnh mẫu ${v.name || "version"}…`);
      try {
        const ref = await referenceOf(props, v);
        setRefs((r) => ({ ...r, [v.id]: URL.createObjectURL(ref.blob) }));
        await ctApi.makeVersionPhoi(product.id, ref.blob, v.id, base.id, ref.box);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Không gửi được");
        break;
      }
    }
    setBusy(null);
    props.onStatus(await ctApi.versionPhoi(product.id));
  };
  const missing = mains.filter((m) => !phoiOf(m.id) && jobOf(m.id)?.status !== "running");
  const done = mains.filter((m) => phoiOf(m.id)).length;

  return (
    <CtModal open={props.open} onOpenChange={(o) => !o && props.onClose()} title={`Phôi AI theo version · base ${base.name}`} wide>
      <div className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          Mỗi version 1 ảnh AI: phần cố định của version thành sản phẩm thật trên nền của base (như “Preview scene” Teeinblue vẽ tay). Khách chọn nhân vật / gõ chữ → đặt lên ảnh này. Chỉ để
          preview — <b>file in vẫn là thiết kế gốc + khuôn</b>, không có vật liệu.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <CtButton size="sm" onClick={() => void make(missing)} disabled={!!busy || missing.length === 0}>
            <Sparkles className="h-3.5 w-3.5" /> Vẽ {missing.length} version chưa có
          </CtButton>
          <CtButton size="sm" variant="outline" onClick={() => void make(mains.filter((m) => jobOf(m.id)?.status !== "running"))} disabled={!!busy || running}>
            <RefreshCw className="h-3.5 w-3.5" /> Vẽ lại tất cả
          </CtButton>
          <span className="text-xs text-muted-foreground">
            {done}/{mains.length} version có phôi AI{running ? " · đang vẽ (~2 phút / ảnh)…" : ""}
          </span>
          {busy && (
            <span className="flex items-center gap-1 text-xs">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {busy}
            </span>
          )}
        </div>
        {error && (
          <p className="flex items-center gap-1 text-xs text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" /> {error}
          </p>
        )}
        <div className="grid max-h-[60vh] grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-4">
          {mains.map((m) => {
            const ph = phoiOf(m.id);
            const job = jobOf(m.id);
            const shown = ph?.url ?? refs[m.id] ?? null;
            return (
              <div key={m.id} className="overflow-hidden rounded-lg border">
                <div className="relative aspect-square" style={CHECKER_STYLE}>
                  {shown ? <img src={shown} alt={m.name} className={`h-full w-full object-cover ${ph ? "" : "opacity-50"}`} /> : null}
                  {job?.status === "running" && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/30 text-xs font-medium text-white">
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" /> Đang vẽ…
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 px-2 py-1.5 text-xs">
                  {ph ? <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" /> : job?.status === "failed" ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" /> : null}
                  <span className="min-w-0 flex-1 truncate" title={job?.status === "failed" ? job.error : m.name}>
                    {m.name || "Version"}
                  </span>
                  <button className="rounded p-1 hover:bg-accent disabled:opacity-40" title="Vẽ lại version này" disabled={!!busy || job?.status === "running"} onClick={() => void make([m])}>
                    <RefreshCw className="h-3 w-3" />
                  </button>
                  {ph && (
                    <button
                      className="rounded p-1 hover:bg-accent"
                      title="Bỏ phôi AI (preview dùng tấm acrylic tạm vẽ bằng code)"
                      onClick={() =>
                        void ctApi
                          .deleteVersionPhoi(product.id, m.id, base.id)
                          .then(() => ctApi.versionPhoi(product.id))
                          .then(props.onStatus)
                      }
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </CtModal>
  );
}
