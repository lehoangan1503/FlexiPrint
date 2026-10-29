"use client";

/**
 * Step 4 — the products of the layer set (asked 2026-10-18: no buttons — @flexiprint makes the product and its mockups
 * on its own after the master is approved; another product from the same set — a ceramic ornament, a rug, a bag — is
 * asked in the chat: char_add_product). Listed: every product using the set (asked 2026-10-29) — its own and every
 * product the set was dragged into in the editor (char/projects/:id/used-by). One box per product (asked 2026-10-29):
 * its khuôn in, its phôi and its mockups together — the print file put on the phôi (exact) and AI lifestyle scenes
 * (server/product-mockups.ts — the same as the editor's Mockups tab and @flexiprint's make_product_mockups).
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, Loader2, Package } from "lucide-react";
import type { CtCharSetProduct, CtPackImage, CtProductBundle } from "../../types";
import { charApi, ctApi } from "../../lib/api-client";
import { normalizeProductConfig } from "../../lib/design";
import { CT_CONFIG, ctGoogleFontsHref } from "../../config";
import { CHECKER_STYLE } from "../ui";
import { PrintSheet } from "../print/print-sheet";
import type { CharCtx } from "./char-project";
import { BlankSection } from "./blank-section";
import { ElementGallery } from "./elements-panel";
import { AutoStepGuide } from "./step-guide";

/** A product made from the chat (char_add_product) shows up without a reload. */
const POLL_MS = 20_000;

export function ProductStep(ctx: CharCtx) {
  const { project } = ctx;
  const [products, setProducts] = useState<CtCharSetProduct[] | null>(null);

  const ownKey = project.product_ids.join(",");
  useEffect(() => {
    let live = true;
    const load = () =>
      charApi
        .usedBy(project.id)
        .then((list) => live && setProducts(list))
        .catch(() => live && setProducts((x) => x ?? []));
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [project.id, ownKey]);

  // The phôi / khuôn and the backgrounds do not need the cut: they are made here any time.
  // A set drawn pose by pose has no files of its own: its product is built from the poses' files.
  const waiting =
    project.brief.kind === "photo" || project.brief.poses?.length
      ? project.product_ids.length
        ? null
        : project.brief.poses?.length
          ? "@flexiprint đang cắt từng dáng — sản phẩm được ghép từ các dáng, sẽ hiện ở đây."
          : "@flexiprint đang vẽ phần tử — sản phẩm sẽ hiện ở đây."
      : project.layers?.status !== "done" || !project.layers.approved
        ? "@flexiprint đang làm bước 3 — sản phẩm được dựng từ bộ clipart, sẽ hiện ở đây."
        : null;
  if (waiting)
    return (
      <div className="space-y-6 p-6">
        <AutoStepGuide what="@flexiprint dựng sản phẩm, nền và mockup" />
        {/* No product yet: the set's khuôn / phôi being made. */}
        <BlankSection {...ctx} />
        {project.brief.kind !== "photo" && project.brief.elements.length > 0 && project.master_id && <ElementGallery {...ctx} />}
        <p className="p-6 text-center text-sm text-muted-foreground">{waiting}</p>
      </div>
    );

  return (
    <div className="space-y-6 p-6">
      {/* The text layer is drawn with the product's font. */}
      <link rel="stylesheet" href={ctGoogleFontsHref()} />
      <AutoStepGuide what="@flexiprint dựng sản phẩm, nền và mockup" />
      {products === null ? (
        <div className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        products.map((p) => <ProductCard key={p.id} product={p} />)
      )}
      <p className="text-xs text-muted-foreground">Muốn thêm sản phẩm từ bộ này (ornament sứ, thảm, túi…) thì nhắn ở ô chat bên dưới.</p>
      {project.brief.kind !== "photo" && project.brief.elements.length > 0 && <ElementGallery {...ctx} />}
    </div>
  );
}

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <figure className="w-40 shrink-0">
      <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg border" style={CHECKER_STYLE}>
        {children}
      </div>
      <figcaption className="mt-1 text-[11px] text-muted-foreground">{label}</figcaption>
    </figure>
  );
}

function ProductCard({ product }: { product: CtCharSetProduct }) {
  const productId = product.id;
  const [bundle, setBundle] = useState<CtProductBundle | null>(null);
  const [mockups, setMockups] = useState<CtPackImage[]>([]);

  const load = useCallback(async () => {
    try {
      setMockups(await ctApi.mockupJobs(productId));
    } catch {
      // A product that is gone has no mockups.
    }
  }, [productId]);
  useEffect(() => {
    const t = setTimeout(() => {
      void load();
      ctApi
        .getBundle(productId)
        .then(setBundle)
        .catch(() => setBundle(null));
    }, 0);
    return () => clearTimeout(t);
  }, [load, productId]);
  // While AI photos are drawn, look again now and then.
  const drawing = mockups.some((m) => m.status === "running");
  useEffect(() => {
    if (!drawing) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [drawing, load]);

  const config = bundle ? normalizeProductConfig(bundle.product.config) : null;
  const print = config?.print ?? null;
  const blank = config?.scene.url || null;

  return (
    <section className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-center gap-3">
        <Package className="h-4 w-4 text-muted-foreground" />
        <div className="flex-1">
          <div className="flex items-center gap-2 text-sm font-semibold">
            {product.name}
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{product.own ? "Sản phẩm của bộ" : "Dùng bộ"}</span>
          </div>
          <div className="text-xs text-muted-foreground">{bundle ? `${bundle.regions.length} layer · ${bundle.assets.length} file` : "Đang tải…"}</div>
        </div>
        <Link href={`${CT_CONFIG.basePath}/${productId}`} target="_blank" className="inline-flex h-9 items-center gap-1.5 rounded-md bg-foreground px-3 text-sm font-medium text-background hover:opacity-90">
          <ExternalLink className="h-4 w-4" /> Mở sản phẩm
        </Link>
      </div>
      <div className="flex flex-wrap items-start gap-3">
        {/* What the product is printed on: its khuôn in and its phôi trơn (Xem trước and the mockups use it). */}
        {bundle && (
          <>
            <Tile label={print ? `Khuôn in: ${print.name}` : "Chưa có khuôn in"}>{print ? <PrintSheet spec={print.spec} className="h-full w-full" /> : <span className="text-[11px] text-muted-foreground">—</span>}</Tile>
            <Tile label={blank ? "Phôi trơn" : "Chưa có phôi"}>
              {blank ? (
                // eslint-disable-next-line @next/next/no-img-element -- our R2 picture
                <img src={blank} alt="Phôi trơn" className="h-full w-full object-contain" />
              ) : (
                <span className="text-[11px] text-muted-foreground">—</span>
              )}
            </Tile>
            {mockups.length > 0 && <div className="mx-1 w-px self-stretch bg-border" />}
          </>
        )}
        {/* In the order they were made: each print's front photo, then its scenes — a theme's pictures side by side. */}
        {[...mockups]
          .sort((a, b) => a.created_at.localeCompare(b.created_at))
          .map((m) => (
            <figure key={m.id} className="w-40 shrink-0 overflow-hidden rounded-lg border bg-white">
              {m.status === "done" && m.url ? (
                <a href={m.url} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element -- our R2 picture */}
                  <img src={m.url} alt={m.description} className="aspect-square w-full object-contain" />
                </a>
              ) : m.status === "running" ? (
                <div className="flex aspect-square items-center justify-center">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="flex aspect-square items-center justify-center p-2 text-[11px] text-destructive">{m.error}</div>
              )}
              <figcaption className="truncate p-1.5 text-[11px] text-muted-foreground" title={m.description}>
                {m.description}
              </figcaption>
            </figure>
          ))}
      </div>
    </section>
  );
}
