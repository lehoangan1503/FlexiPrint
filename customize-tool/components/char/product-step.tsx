"use client";

/**
 * Step 4 — products from the layer set. One set → many products (each its own print size / blank photo is set in
 * the editor). Per product: open it in the editor, and make mockups: the print file is rendered here exactly as the
 * editor's "File in" tab does, then the product's mockups (server/product-mockups.ts — the same as the editor's
 * Mockups tab and @flexiprint's make_product_mockups) put it on the phôi (exact) and have AI make lifestyle scenes.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, ImageIcon, Loader2, Package, Plus } from "lucide-react";
import type { CtPackImage, CtProductBundle } from "../../types";
import { charApi, ctApi } from "../../lib/api-client";
import { canvasToBlob, renderComposite } from "../../lib/compositor";
import { defaultSelection } from "../../lib/design";
import { displayAssets } from "../../lib/library";
import { CT_CONFIG, ctGoogleFontsHref } from "../../config";
import { CtButton, CtInput } from "../ui";
import type { CharCtx } from "./char-project";
import { BackdropSection, BlankSection } from "./blank-section";

export function ProductStep(ctx: CharCtx) {
  const { project, editable } = ctx;
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

  // The phôi / khuôn and the backgrounds do not need the cut: they are made here any time.
  const waiting =
    project.brief.kind === "photo"
      ? project.product_ids.length
        ? null
        : "Vẽ đủ phần tử ở bước 3 rồi bấm “Tạo sản phẩm”."
      : project.layers?.status !== "done"
        ? "Cắt layer ở bước 3 trước — sản phẩm được tạo từ bộ file."
        : !project.layers.approved
          ? "Bấm “Tạo bộ custom” ở bước 3c — nó cắt clipart và tạo luôn sản phẩm."
          : null;
  if (waiting)
    return (
      <div className="space-y-6 p-6">
        <BlankSection {...ctx} />
        <BackdropSection {...ctx} />
        <p className="p-6 text-center text-sm text-muted-foreground">{waiting}</p>
      </div>
    );

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
      <BlankSection {...ctx} />
      <BackdropSection {...ctx} />
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
        <ProductCard key={pid} ctx={ctx} productId={pid} bundle={bundles[pid]} />
      ))}
    </div>
  );
}

function ProductCard({ ctx, productId, bundle }: { ctx: CharCtx; productId: string; bundle: CtProductBundle | undefined }) {
  const [busy, setBusy] = useState(false);
  const [print, setPrint] = useState<string | null>(null);
  const [mockups, setMockups] = useState<CtPackImage[]>([]);

  const load = useCallback(async () => {
    try {
      setMockups(await ctApi.mockupJobs(productId));
    } catch {
      // A product that is gone has no mockups.
    }
  }, [productId]);
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);
  // While AI photos are drawn, look again now and then.
  const drawing = mockups.some((m) => m.status === "running");
  useEffect(() => {
    if (!drawing) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [drawing, load]);

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
      await ctApi.makeMockups(productId, blob, ctx.project.brief.mockups.filter((x) => x.trim()).slice(0, 3));
      await load();
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
              {m.status === "done" && m.url ? (
                <a href={m.url} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element -- our R2 picture */}
                  <img src={m.url} alt={m.description} className="aspect-[4/5] w-full object-cover" />
                </a>
              ) : m.status === "running" ? (
                <div className="flex aspect-[4/5] items-center justify-center">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="flex aspect-[4/5] items-center justify-center p-2 text-[11px] text-destructive">{m.error}</div>
              )}
              <figcaption className="truncate p-1.5 text-[11px] text-muted-foreground" title={m.description}>
                {m.description}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </section>
  );
}
