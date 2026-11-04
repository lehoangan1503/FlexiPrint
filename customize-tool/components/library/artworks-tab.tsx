"use client";

/**
 * /dashboard → Artwork (asked 2026-11-04: "Product → được trỏ đến artwork nào, trong artwork sẽ chứa các artwork đã
 * dựng trên phôi gồm preview và file in"). One block per product: its preview on the phôi (first mockup) and every
 * artwork saved from it — one per version, saved again with each Lưu thiết kế (server/artworks.ts), plus extras —
 * each the flat print file, downloadable. `?product=` (from a product card) shows that product only.
 * Every product is listed: one never saved in the editor (built by @flexiprint, imported) has no artwork until
 * "Tạo artwork" renders its versions here with the editor's own code (editor/artwork-saver buildProductArtworks).
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Download, ExternalLink, Loader2, RefreshCw, Search, Wand2, X } from "lucide-react";
import { CT_CONFIG } from "../../config";
import type { CtArtworkRow, CtProductListRow } from "../../types";
import { buildProductArtworks } from "../editor/artwork-saver";
import { ctApi } from "../../lib/api-client";
import { CHECKER_STYLE, CtButton, CtInput } from "../ui";

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
  /** Every product (a product never saved in the editor has no artwork yet: it is listed with "Tạo artwork"). */
  const [products, setProducts] = useState<CtProductListRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  /** Products whose artworks are being made: id → "2/9". */
  const [building, setBuilding] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [bulk, setBulk] = useState(false);

  useEffect(() => {
    // A new product filter remounts the tab (its key), so the list starts empty.
    let live = true;
    Promise.all([ctApi.listArtworks(productId ?? undefined), ctApi.listProducts("")])
      .then(([a, p]) => {
        if (!live) return;
        setRows(a);
        setProducts(productId ? p.filter((x) => x.id === productId) : p);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [productId]);

  const blocks = useMemo(() => {
    const words = q.trim().toLowerCase();
    const out = new Map<string, ProductBlock>();
    // Products first, newest first (as the Product tab), then artworks of products deleted since.
    for (const p of products ?? []) out.set(p.id, { id: p.id, name: p.name, preview: p.mockup_url ?? p.thumbnail_url ?? null, rows: [] });
    for (const r of rows ?? []) {
      const id = r.product?.id ?? r.artwork.meta.artwork?.productId ?? "none";
      const b = out.get(id) ?? { id, name: r.product?.name ?? "Sản phẩm đã xoá", preview: r.product?.mockup_url ?? r.product?.thumbnail_url ?? null, rows: [] };
      b.rows.push(r);
      out.set(id, b);
    }
    return [...out.values()].filter((b) => !words || b.name.toLowerCase().includes(words) || b.rows.some((r) => r.artwork.name.toLowerCase().includes(words)));
  }, [rows, products, q]);
  const missing = blocks.filter((b) => b.id !== "none" && !b.rows.length);

  /** Render every version of one product as its print file (the editor's own code, in this browser) and store it. */
  const build = async (id: string) => {
    setBuilding((m) => ({ ...m, [id]: "…" }));
    setFailed(({ [id]: _drop, ...rest }) => rest);
    try {
      await buildProductArtworks(id, (done, total) => setBuilding((m) => ({ ...m, [id]: `${done}/${total}` })));
      const fresh = await ctApi.listArtworks(id);
      setRows((list) => [...fresh, ...(list ?? []).filter((r) => (r.product?.id ?? r.artwork.meta.artwork?.productId) !== id)]);
    } catch (e) {
      setFailed((m) => ({ ...m, [id]: e instanceof Error ? e.message : "Không tạo được" }));
    } finally {
      setBuilding(({ [id]: _drop, ...rest }) => rest);
    }
  };
  const buildMissing = async () => {
    setBulk(true);
    for (const b of missing) await build(b.id);
    setBulk(false);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted-foreground">Mỗi sản phẩm: ảnh xem trước trên phôi và file in của từng version (tự lưu mỗi lần Lưu thiết kế).</p>
        {missing.length > 0 && (
          <CtButton size="sm" variant="primary" onClick={() => void buildMissing()} disabled={bulk} title="Vẽ file in từng version của các sản phẩm chưa có artwork (ngay trên trình duyệt này, như khi Lưu thiết kế) — giữ tab mở tới khi xong">
            {bulk ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />} Tạo artwork cho {missing.length} sản phẩm còn thiếu
          </CtButton>
        )}
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
        <div className="rounded-xl border border-dashed py-20 text-center text-sm text-muted-foreground">Không có sản phẩm nào khớp.</div>
      ) : (
        blocks.map((b) => (
          <section key={b.id} className="rounded-xl border bg-card">
            <header className="flex items-center gap-3 border-b px-3 py-2">
              <span className="text-sm font-semibold">{b.name}</span>
              <span className="text-xs text-muted-foreground">{b.rows.length} artwork</span>
              {failed[b.id] && <span className="truncate text-xs text-destructive">{failed[b.id]}</span>}
              {b.id !== "none" && (
                <span className="ml-auto flex items-center gap-3">
                  <button
                    onClick={() => void build(b.id)}
                    disabled={!!building[b.id] || bulk}
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline disabled:opacity-60"
                    title={b.rows.length ? "Vẽ lại file in các version đã đổi từ lần lưu trước" : "Vẽ file in từng version"}
                  >
                    {building[b.id] ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                    {building[b.id] ? `Đang tạo ${building[b.id]}` : b.rows.length ? "Cập nhật" : "Tạo artwork"}
                  </button>
                  <Link href={`${CT_CONFIG.basePath}/${b.id}`} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline">
                    <ExternalLink className="h-3 w-3" /> Mở sản phẩm
                  </Link>
                </span>
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
              {!b.rows.length && (
                <div className="flex w-44 shrink-0 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center text-xs text-muted-foreground">
                  Chưa có artwork
                  <CtButton size="sm" variant="outline" onClick={() => void build(b.id)} disabled={!!building[b.id] || bulk}>
                    {building[b.id] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />} {building[b.id] ? building[b.id] : "Tạo artwork"}
                  </CtButton>
                </div>
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
