"use client";

/**
 * Grid of customizable products. Rendered both as the /customize-tool index
 * and inside the host dashboard's "Customize" tab (`tabs` slot). No "new product" button (2026-10-29): a product is
 * made from a bộ nhân vật, asked in its chat.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Images, Layers, Loader2, Search, Trash2 } from "lucide-react";
import { CT_CONFIG } from "../config";
import type { CtProductListRow, CtProductStatus } from "../types";
import { ctApi } from "../lib/api-client";
import { CHECKER_STYLE, CtInput, cx } from "./ui";
import { ctConfirm } from "./dialogs";
import { FilterChips, type CtFilterOption } from "./filter-chips";

/** The list's filters (asked 2026-11-03); a new one = one more entry here + its test in FILTER_TEST. */
type ProductFilter = "all" | "deployed" | "not-deployed";
const FILTERS: Array<CtFilterOption<ProductFilter>> = [
  { value: "all", label: "Tất cả" },
  { value: "deployed", label: "Đã deploy" },
  { value: "not-deployed", label: "Chưa deploy" },
];
const FILTER_TEST: Record<ProductFilter, (p: CtProductListRow) => boolean> = {
  all: () => true,
  deployed: (p) => !!p.shopify,
  "not-deployed": (p) => !p.shopify,
};

const STATUS_LABEL: Record<CtProductStatus, string> = { draft: "Nháp", ready: "Sẵn sàng", archived: "Lưu trữ" };
const STATUS_CLASS: Record<CtProductStatus, string> = {
  draft: "bg-muted text-muted-foreground",
  ready: "bg-emerald-500/15 text-emerald-600",
  archived: "bg-neutral-500/15 text-neutral-500",
};

export function CustomizeProductList({
  tabs,
  currentUserId,
  admin = false,
  onShowArtworks,
}: {
  tabs?: React.ReactNode;
  currentUserId?: string;
  admin?: boolean;
  /** The product's artworks (preview + print files) on the dashboard's Artwork tab. */
  onShowArtworks?: (productId: string) => void;
}) {
  const [products, setProducts] = useState<CtProductListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ProductFilter>("all");
  const shown = products.filter(FILTER_TEST[filter]);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    try {
      setProducts(await ctApi.listProducts(q));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tải được danh sách");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search, load]);

  const remove = async (p: CtProductListRow) => {
    if (!(await ctConfirm({ title: `Xoá “${p.name}”?`, message: "Xoá cùng toàn bộ asset, vùng custom và mockup của sản phẩm. Không hoàn tác được.", tone: "danger", confirmLabel: "Xoá" }))) return;
    try {
      await ctApi.deleteProduct(p.id);
      setProducts((list) => list.filter((x) => x.id !== p.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Xoá thất bại");
    }
  };

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        {tabs}
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <FilterChips value={filter} onChange={setFilter} options={FILTERS} />
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <CtInput className="h-9 w-56 pl-8" placeholder="Tìm sản phẩm…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
          {error.includes("ct_products") && (
            <div className="mt-1 text-xs">Có vẻ chưa chạy migration <code>customize-tool/migrations/001_customize_tool.sql</code>.</div>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : shown.length === 0 && products.length > 0 ? (
        <div className="rounded-xl border border-dashed py-20 text-center text-sm text-muted-foreground">Không có sản phẩm nào khớp.</div>
      ) : products.length === 0 ? (
        <div className="rounded-xl border border-dashed py-20 text-center text-sm text-muted-foreground">
          <Layers className="mx-auto mb-3 h-10 w-10 opacity-40" />
          Chưa có sản phẩm custom nào — sản phẩm mới được tạo trong bộ nhân vật (gõ ở chat).
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {shown.map((p) => {
            const thumb = p.mockup_url ?? p.thumbnail_url ?? p.main_asset?.url ?? null;
            const mine = admin || !currentUserId || p.user_id === currentUserId;
            return (
              <div key={p.id} className="group overflow-hidden rounded-xl border bg-card">
                <Link href={`${CT_CONFIG.basePath}/${p.id}`} className="block aspect-square" style={CHECKER_STYLE}>
                  {thumb ? (
                    <img src={thumb} alt={p.name} className={p.mockup_url ? "h-full w-full object-cover" : "h-full w-full object-contain p-2"} loading="lazy" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Chưa có mockup</div>
                  )}
                </Link>
                <div className="flex items-center gap-2 p-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{p.name}</div>
                    {p.artwork_from && <div className="truncate text-[10px] text-muted-foreground">từ artwork “{p.artwork_from.name}”</div>}
                    <div className="mt-0.5 flex items-center gap-1.5 whitespace-nowrap">
                      <span className={cx("rounded px-1.5 py-0.5 text-[10px] font-medium", STATUS_CLASS[p.status])}>{STATUS_LABEL[p.status]}</span>
                      {p.shopify && <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-600">Đã deploy</span>}
                      {p.artwork_from?.outdated && (
                        <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600" title={`Artwork “${p.artwork_from.name}” đã có bản mới — mở sản phẩm để cập nhật`}>
                          Artwork mới
                        </span>
                      )}
                      {!!p.artwork_users && (
                        <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-600" title="Số sản phẩm làm từ artwork này">
                          Artwork · {p.artwork_users} SP
                        </span>
                      )}
                      <span className="text-[10px] text-muted-foreground">{new Date(p.created_at).toLocaleDateString("vi-VN")}</span>
                    </div>
                  </div>
                  {onShowArtworks && (
                    <button className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => onShowArtworks(p.id)} title="Artwork của sản phẩm: preview trên phôi + file in từng version">
                      <Images className="h-4 w-4" />
                    </button>
                  )}
                  {mine && (
                    <button className="rounded p-1 text-destructive opacity-0 hover:bg-accent group-hover:opacity-100" onClick={() => remove(p)} title="Xoá">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
