"use client";

/**
 * Step 4 — products from the layer set (asked 2026-10-18: no buttons — @flexiprint makes the product and its mockups
 * on its own after the master is approved; another product from the same set — a rug, a bag, a t-shirt — is asked in
 * the chat). One set → many products. Per product: open it in the editor, see its mockups: the print file is rendered as the
 * editor's "File in" tab does, then the product's mockups (server/product-mockups.ts — the same as the editor's
 * Mockups tab and @flexiprint's make_product_mockups) put it on the phôi (exact) and have AI make lifestyle scenes.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, Loader2, Package } from "lucide-react";
import type { CtPackImage, CtProductBundle } from "../../types";
import { ctApi } from "../../lib/api-client";
import { CT_CONFIG, ctGoogleFontsHref } from "../../config";
import type { CharCtx } from "./char-project";
import { BackdropSection, BlankSection } from "./blank-section";
import { ElementGallery } from "./elements-panel";
import { AutoStepGuide } from "./step-guide";

export function ProductStep(ctx: CharCtx) {
  const { project } = ctx;
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
        : "@flexiprint đang vẽ phần tử — sản phẩm sẽ hiện ở đây."
      : project.layers?.status !== "done" || !project.layers.approved
        ? "@flexiprint đang làm bước 3 — sản phẩm được dựng từ bộ clipart, sẽ hiện ở đây."
        : null;
  if (waiting)
    return (
      <div className="space-y-6 p-6">
        <AutoStepGuide what="@flexiprint dựng sản phẩm, nền và mockup" />
        <BlankSection {...ctx} />
        <BackdropSection {...ctx} />
        {project.brief.kind !== "photo" && project.brief.elements.length > 0 && project.master_id && <ElementGallery {...ctx} />}
        <p className="p-6 text-center text-sm text-muted-foreground">{waiting}</p>
      </div>
    );

  return (
    <div className="space-y-6 p-6">
      {/* The text layer is drawn with the product's font. */}
      <link rel="stylesheet" href={ctGoogleFontsHref()} />
      <AutoStepGuide what="@flexiprint dựng sản phẩm, nền và mockup" />
      <BlankSection {...ctx} />
      <BackdropSection {...ctx} />
      {project.brief.kind !== "photo" && project.brief.elements.length > 0 && <ElementGallery {...ctx} />}
      {project.product_ids.map((pid) => (
        <ProductCard key={pid} productId={pid} bundle={bundles[pid]} />
      ))}
    </div>
  );
}

function ProductCard({ productId, bundle }: { productId: string; bundle: CtProductBundle | undefined }) {
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
      </div>
      {mockups.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
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
