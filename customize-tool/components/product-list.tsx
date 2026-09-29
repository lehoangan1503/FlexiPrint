"use client";

/**
 * Grid of customizable products. Rendered both as the /customize-tool index
 * and inside the host dashboard's "Customize" tab (`tabs` slot).
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Layers, Loader2, Plus, Search, Trash2 } from "lucide-react";
import { CT_CONFIG } from "../config";
import type { CtProductListRow, CtProductStatus } from "../types";
import { ctApi } from "../lib/api-client";
import { CHECKER_STYLE, CtButton, CtInput, cx } from "./ui";

const STATUS_LABEL: Record<CtProductStatus, string> = { draft: "Nháp", ready: "Sẵn sàng", archived: "Lưu trữ" };
const STATUS_CLASS: Record<CtProductStatus, string> = {
  draft: "bg-muted text-muted-foreground",
  ready: "bg-emerald-500/15 text-emerald-600",
  archived: "bg-neutral-500/15 text-neutral-500",
};

export function CustomizeProductList({ tabs, currentUserId }: { tabs?: React.ReactNode; currentUserId?: string }) {
  const router = useRouter();
  const [products, setProducts] = useState<CtProductListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);

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

  const create = async () => {
    const name = window.prompt("Tên sản phẩm custom mới", "New custom ornament");
    if (!name?.trim()) return;
    setCreating(true);
    try {
      const p = await ctApi.createProduct(name.trim());
      router.push(`${CT_CONFIG.basePath}/${p.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tạo được");
      setCreating(false);
    }
  };

  const remove = async (p: CtProductListRow) => {
    if (!window.confirm(`Xoá "${p.name}" cùng toàn bộ asset, vùng custom và mockup?`)) return;
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
        <h2 className="shrink-0 text-2xl font-bold">Customize 2D</h2>
        {tabs}
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <CtInput className="h-9 w-56 pl-8" placeholder="Tìm sản phẩm…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <CtButton variant="primary" onClick={create} disabled={creating}>
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Tạo sản phẩm custom
          </CtButton>
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
      ) : products.length === 0 ? (
        <div className="rounded-xl border border-dashed py-20 text-center text-sm text-muted-foreground">
          <Layers className="mx-auto mb-3 h-10 w-10 opacity-40" />
          Chưa có sản phẩm custom nào.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {products.map((p) => {
            const thumb = p.thumbnail_url ?? p.main_asset?.url ?? null;
            const mine = !currentUserId || p.user_id === currentUserId;
            return (
              <div key={p.id} className="group overflow-hidden rounded-xl border bg-card">
                <Link href={`${CT_CONFIG.basePath}/${p.id}`} className="block aspect-square" style={CHECKER_STYLE}>
                  {thumb ? (
                    <img src={thumb} alt={p.name} className="h-full w-full object-contain p-2" loading="lazy" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Chưa có main object</div>
                  )}
                </Link>
                <div className="flex items-center gap-2 p-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{p.name}</div>
                    <div className="mt-0.5 flex items-center gap-1.5">
                      <span className={cx("rounded px-1.5 py-0.5 text-[10px] font-medium", STATUS_CLASS[p.status])}>{STATUS_LABEL[p.status]}</span>
                      <span className="text-[10px] text-muted-foreground">{new Date(p.updated_at).toLocaleDateString("vi-VN")}</span>
                    </div>
                  </div>
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
