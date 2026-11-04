"use client";

/**
 * /dashboard → Artwork (asked 2026-11-04: "Product → được trỏ đến artwork nào, trong artwork sẽ chứa các artwork đã
 * dựng trên phôi gồm preview và file in"). One block per product: its preview on the phôi (first mockup) and every
 * artwork saved from it — one per version, saved again with each Lưu thiết kế (server/artworks.ts), plus extras —
 * each the flat print file, downloadable. `?product=` (from a product card) shows that product only.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Download, ExternalLink, Loader2, Search, X } from "lucide-react";
import { CT_CONFIG } from "../../config";
import type { CtArtworkRow } from "../../types";
import { ctApi } from "../../lib/api-client";
import { CHECKER_STYLE, CtInput } from "../ui";

interface ProductBlock {
  id: string;
  name: string;
  preview: string | null;
  rows: CtArtworkRow[];
}

function download(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name.replace(/[^\p{L}\p{N}_-]+/gu, "-") || "artwork"}.png`;
  a.target = "_blank";
  a.click();
}

export function ArtworksTab({ productId, onClearProduct }: { productId: string | null; onClearProduct: () => void }) {
  const [rows, setRows] = useState<CtArtworkRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    // A new product filter remounts the tab (its key), so the list starts empty.
    let live = true;
    ctApi
      .listArtworks(productId ?? undefined)
      .then((r) => live && setRows(r))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [productId]);

  const blocks = useMemo(() => {
    const words = q.trim().toLowerCase();
    const out = new Map<string, ProductBlock>();
    for (const r of rows ?? []) {
      const id = r.product?.id ?? r.artwork.meta.artwork?.productId ?? "none";
      const name = r.product?.name ?? "Sản phẩm đã xoá";
      if (words && !name.toLowerCase().includes(words) && !r.artwork.name.toLowerCase().includes(words)) continue;
      const b = out.get(id) ?? { id, name, preview: r.product?.mockup_url ?? r.product?.thumbnail_url ?? null, rows: [] };
      b.rows.push(r);
      out.set(id, b);
    }
    return [...out.values()];
  }, [rows, q]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted-foreground">Mỗi sản phẩm: ảnh xem trước trên phôi và file in của từng version (tự lưu mỗi lần Lưu thiết kế).</p>
        {productId && (
          <button onClick={onClearProduct} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs hover:bg-accent">
            1 sản phẩm <X className="h-3 w-3" />
          </button>
        )}
        <div className="relative ml-auto">
          <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <CtInput className="h-9 w-56 pl-8" placeholder="Tìm artwork / sản phẩm…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {error && <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
      {rows === null && !error ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : blocks.length === 0 ? (
        <div className="rounded-xl border border-dashed py-20 text-center text-sm text-muted-foreground">Chưa có artwork — mở 1 sản phẩm và Lưu thiết kế, mỗi version thành 1 artwork.</div>
      ) : (
        blocks.map((b) => (
          <section key={b.id} className="rounded-xl border bg-card">
            <header className="flex items-center gap-3 border-b px-3 py-2">
              <span className="text-sm font-semibold">{b.name}</span>
              <span className="text-xs text-muted-foreground">{b.rows.length} artwork</span>
              {b.id !== "none" && (
                <Link href={`${CT_CONFIG.basePath}/${b.id}`} className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline">
                  <ExternalLink className="h-3 w-3" /> Mở sản phẩm
                </Link>
              )}
            </header>
            <div className="flex gap-3 overflow-x-auto p-3">
              {b.preview && (
                <figure className="w-44 shrink-0">
                  <div className="aspect-square overflow-hidden rounded-lg border bg-white">
                    {/* eslint-disable-next-line @next/next/no-img-element -- our R2 mockup */}
                    <img src={b.preview} alt={`${b.name} — preview`} className="h-full w-full object-cover" loading="lazy" />
                  </div>
                  <figcaption className="mt-1 text-[11px] font-medium text-muted-foreground">Preview trên phôi</figcaption>
                </figure>
              )}
              {b.rows.map((r) => (
                <figure key={r.artwork.id} className="group w-44 shrink-0">
                  <div className="relative aspect-square overflow-hidden rounded-lg border" style={CHECKER_STYLE}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- our R2 artwork */}
                    <img src={r.artwork.url} alt={r.artwork.name} className="h-full w-full object-contain p-1" loading="lazy" />
                    <button
                      className="absolute right-1.5 top-1.5 rounded bg-background/90 p-1 opacity-0 shadow hover:bg-background group-hover:opacity-100"
                      title={`Tải file in ${r.artwork.width}×${r.artwork.height}px`}
                      onClick={() => download(r.artwork.url, `${b.name}-${r.versionName ?? r.artwork.name}`)}
                    >
                      <Download className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <figcaption className="mt-1 space-y-0.5">
                    <div className="truncate text-xs font-medium" title={r.artwork.name}>
                      {r.versionName ? `Version: ${r.versionName}` : r.artwork.name}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      File in · {r.artwork.width}×{r.artwork.height}px
                    </div>
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
