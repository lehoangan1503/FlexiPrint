"use client";

/**
 * Step 4 — products from the layer set. One set → many products (each its own print size / blank photo is set in
 * the editor). Per product: open it in the editor, and make mockups: the print file is rendered here exactly as the
 * editor's "File in" tab does, then the server puts it on the blank photo (exact) and has AI make lifestyle scenes.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, ImageIcon, Loader2, Package, Plus } from "lucide-react";
import type { CtCharImage, CtProductBundle } from "../../types";
import { charApi, ctApi } from "../../lib/api-client";
import { canvasToBlob, renderComposite } from "../../lib/compositor";
import { defaultSelection } from "../../lib/design";
import { displayAssets } from "../../lib/library";
import { CT_CONFIG, ctGoogleFontsHref } from "../../config";
import { CtButton, CtInput } from "../ui";
import type { CharCtx } from "./char-project";

export function ProductStep(ctx: CharCtx) {
  const { project, images, editable } = ctx;
  const [name, setName] = useState(project.name);
  const [busy, setBusy] = useState(false);
  const [bundles, setBundles] = useState<Record<string, CtProductBundle>>({});

  const loadBundles = useCallback(async () => {
    const out: Record<string, CtProductBundle> = {};
    await Promise.all(
      project.product_ids.map(async (pid) => {
        try {
          out[pid] = await ctApi.getBundle(pid);
        } catch {
          // A deleted product just isn't listed.
        }
      }),
    );
    setBundles(out);
  }, [project.product_ids]);

  useEffect(() => {
    const t = setTimeout(() => void loadBundles(), 0);
    return () => clearTimeout(t);
  }, [loadBundles]);

  if (project.layers?.status !== "done") return <div className="p-10 text-center text-sm text-muted-foreground">Cắt layer ở bước 3 trước.</div>;
  if (!project.layers.approved) return <div className="p-10 text-center text-sm text-muted-foreground">Duyệt bộ file cuối ở bước 3d trước — sản phẩm chỉ làm từ bộ file đã duyệt.</div>;

  const create = async () => {
    setBusy(true);
    ctx.error(null);
    try {
      await charApi.createProduct(project.id, name.trim() || project.name);
      await ctx.reload();
    } catch (e) {
      ctx.error(e instanceof Error ? e.message : "Không tạo được sản phẩm");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6 p-6">
      {/* The text layer is drawn with the product's font. */}
      <link rel="stylesheet" href={ctGoogleFontsHref()} />
      <section className="rounded-xl border bg-card p-4">
        <h3 className="text-sm font-semibold">Tạo sản phẩm từ bộ layer</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          Mọi layer cùng 1 ô (đúng tỉ lệ khung file), thứ tự cố định, tóc sau đi theo tóc trước, có chữ và vùng ảnh khách nếu brief có. Một bộ dùng được cho nhiều sản phẩm — tạo thêm rồi chỉnh cỡ in / ảnh phôi trong editor.
        </p>
        <div className="flex gap-2">
          <CtInput className="max-w-md" value={name} onChange={(e) => setName(e.target.value)} placeholder="Tên sản phẩm" />
          <CtButton variant="primary" disabled={!editable || busy} onClick={() => void create()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} {busy ? "Đang tạo (~30 giây)…" : "Tạo sản phẩm"}
          </CtButton>
        </div>
      </section>
      {project.product_ids.map((pid) => (
        <ProductCard key={pid} ctx={ctx} productId={pid} bundle={bundles[pid]} mockups={images.filter((im) => im.kind === "mockup" && im.role.endsWith(pid))} />
      ))}
    </div>
  );
}

function ProductCard({ ctx, productId, bundle, mockups }: { ctx: CharCtx; productId: string; bundle: CtProductBundle | undefined; mockups: CtCharImage[] }) {
  const [busy, setBusy] = useState(false);
  const [print, setPrint] = useState<string | null>(null);

  const make = async () => {
    if (!bundle) return;
    setBusy(true);
    ctx.error(null);
    try {
      const { product, assets, regions, items } = bundle;
      const main = assets.find((a) => a.id === product.main_asset_id) ?? assets.find((a) => a.role === "main");
      if (!main) throw new Error("Sản phẩm chưa có vùng in");
      const flat = displayAssets(assets, "flat");
      const selection = defaultSelection(regions, items, flat, main.id);
      const canvas = await renderComposite({ main, assets: flat, regions, items, selection, scale: 1, layouts: product.config?.layouts ?? {}, cutToFrame: true });
      const blob = await canvasToBlob(canvas, "image/png");
      setPrint(URL.createObjectURL(blob));
      ctx.addImages(await charApi.mockups(ctx.project.id, productId, blob));
    } catch (e) {
      ctx.error(e instanceof Error ? e.message : "Không tạo được mockup");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-center gap-3">
        <Package className="h-4 w-4 text-muted-foreground" />
        <div className="flex-1">
          <div className="text-sm font-semibold">{bundle?.product.name ?? "…"}</div>
          <div className="text-xs text-muted-foreground">{bundle ? `${bundle.regions.length} layer · ${bundle.assets.length} file` : "Đang tải…"}</div>
        </div>
        <Link href={`${CT_CONFIG.basePath}/${productId}`} target="_blank" className="inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs hover:bg-accent">
          <ExternalLink className="h-3.5 w-3.5" /> Mở trong editor
        </Link>
        <CtButton size="sm" variant="primary" disabled={!ctx.editable || busy || !bundle} onClick={() => void make()}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImageIcon className="h-3.5 w-3.5" />} Tạo mockup
        </CtButton>
      </div>
      {(mockups.length > 0 || print) && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {print && (
            <figure className="overflow-hidden rounded-lg border bg-white">
              {/* eslint-disable-next-line @next/next/no-img-element -- local blob */}
              <img src={print} alt="file in" className="aspect-[4/5] w-full object-contain" />
              <figcaption className="p-1.5 text-[11px] text-muted-foreground">File in (mặc định)</figcaption>
            </figure>
          )}
          {mockups.map((m) => (
            <figure key={m.id} className="overflow-hidden rounded-lg border bg-white">
              {m.status === "done" ? (
                <a href={m.url} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element -- WebP preview */}
                  <img src={m.thumb_url || m.url} alt={m.note} className="aspect-[4/5] w-full object-cover" />
                </a>
              ) : m.status === "running" ? (
                <div className="flex aspect-[4/5] items-center justify-center">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="flex aspect-[4/5] items-center justify-center p-2 text-[11px] text-destructive">{m.error}</div>
              )}
              <figcaption className="truncate p-1.5 text-[11px] text-muted-foreground" title={m.note}>
                {m.note}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </section>
  );
}
