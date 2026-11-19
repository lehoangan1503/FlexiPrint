"use client";

/**
 * Grid of ct_products rows of one kind (migration 031, asked 2026-11-07):
 *   product  the dashboard's Sản phẩm tab — what is sold (artwork + base product): mockup, base, artwork, Shopify.
 *            "Tạo sản phẩm" picks a finished artwork and a base product.
 *   artwork  the Artwork tab — one card per whole artwork (every version inside): its picture, how many products are
 *            made from it, "Tạo sản phẩm" on each card. "Tạo artwork" (by hand) sits on top with Import / bộ mới.
 * Also the /products index (no kind = both).
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Layers, Loader2, Plus, Rocket, Search, ShoppingBag, Sparkles, Trash2, X } from "lucide-react";
import { CT_CONFIG } from "../config";
import type { CtProductKind, CtProductListRow, CtProductStatus } from "../types";
import { ctApi } from "../lib/api-client";
import { CHECKER_STYLE, CtButton, CtInput, cx } from "./ui";
import { CreateArtworkDialog, CreateProductDialog } from "./product-create";
import { ctConfirm } from "./dialogs";
import { FilterChips, type CtFilterOption } from "./filter-chips";

/** The list's filters (asked 2026-11-03); a new one = one more entry here + its test in FILTER_TEST. */
type ProductFilter = "all" | "deployed" | "not-deployed" | "no-mockup";
const FILTERS: Array<CtFilterOption<ProductFilter>> = [
  { value: "all", label: "Tất cả" },
  { value: "deployed", label: "Đã deploy" },
  { value: "not-deployed", label: "Chưa deploy" },
  { value: "no-mockup", label: "Chưa có mockup" },
];
const FILTER_TEST: Record<ProductFilter, (p: CtProductListRow) => boolean> = {
  all: () => true,
  deployed: (p) => !!p.shopify,
  "not-deployed": (p) => !p.shopify,
  "no-mockup": (p) => !p.mockup_url,
};

/** Most products one bulk "Tạo mockup" takes (each makes 2–3 AI photos). */
const BULK_MOCKUP_MAX = 20;

/** One line of a bulk run's report. */
interface BulkLine {
  id: string;
  name: string;
  state: "wait" | "run" | "ok" | "skip" | "fail";
  text: string;
}

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
  kind,
  actions,
}: {
  tabs?: React.ReactNode;
  currentUserId?: string;
  admin?: boolean;
  kind?: CtProductKind;
  /** More buttons on top (the Artwork tab: Import bộ, Tạo bộ clipart mới). */
  actions?: React.ReactNode;
}) {
  const [creating, setCreating] = useState(false);
  /** The artwork a card's "Tạo sản phẩm" was clicked on. */
  const [fromArtwork, setFromArtwork] = useState<{ id: string; name: string } | null>(null);
  const word = kind === "artwork" ? "artwork" : "sản phẩm";
  const [products, setProducts] = useState<CtProductListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ProductFilter>("all");
  const shown = products.filter(FILTER_TEST[filter]);
  // Bulk (asked 2026-11-17): tick products, then "Tạo mockup" (each with its own prompts) or "Deploy".
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<{ title: string; lines: BulkLine[]; running: boolean } | null>(null);
  const pickedRows = shown.filter((p) => picked.has(p.id));
  const toggle = (id: string) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const listKind = kind;
  const runBulk = async (kind: "mockup" | "deploy") => {
    const rows = pickedRows;
    if (!rows.length) return;
    if (kind === "mockup" && rows.length > BULK_MOCKUP_MAX) {
      setError(`Tạo mockup tối đa ${BULK_MOCKUP_MAX} sản phẩm mỗi lần — đang chọn ${rows.length}.`);
      return;
    }
    const ok = await ctConfirm(
      kind === "mockup"
        ? { title: `Tạo mockup cho ${rows.length} sản phẩm?`, message: "Mỗi sản phẩm dùng prompt mockup riêng của nó (ô Mockups lần cuối dùng); chưa có thì dùng prompt của product base, base trống thì bối cảnh mặc định theo loại. Mỗi ảnh AI 1–2 phút, chạy nền.", confirmLabel: "Tạo mockup" }
        : { title: `Deploy ${rows.length} sản phẩm lên Shopify?`, message: "Sản phẩm đủ title, mô tả, bảng giá và mockup thì được deploy (đang bán). Sản phẩm thiếu thì bỏ qua và ghi rõ thiếu gì.", confirmLabel: "Deploy" },
    );
    if (!ok) return;
    const lines: BulkLine[] = rows.map((p) => ({ id: p.id, name: p.name, state: "wait", text: "Chờ…" }));
    const title = kind === "mockup" ? "Tạo mockup hàng loạt" : "Deploy hàng loạt";
    const set = (i: number, patch: Partial<BulkLine>) => {
      lines[i] = { ...lines[i], ...patch };
      setBulk({ title, lines: [...lines], running: true });
    };
    setBulk({ title, lines: [...lines], running: true });
    /** Mockup: the jobs each product started — the line says "Xong" only once they are drawn (2026-11-19: it said
     * "Xong" at the start, and photos that failed or were still queued never showed). */
    const started = new Map<number, string[]>();
    for (let i = 0; i < rows.length; i++) {
      set(i, { state: "run", text: kind === "mockup" ? "Đang đặt thiết kế lên phôi…" : "Đang deploy…" });
      try {
        if (kind === "mockup") {
          const r = await ctApi.autoMockups(rows[i].id);
          started.set(i, r.jobs.map((j) => j.id));
          set(i, { state: "run", text: `AI đang vẽ 0/${r.jobs.length} ảnh…` });
        } else {
          const r = await ctApi.autoDeploy(rows[i].id);
          if (r.ok) {
            set(i, { state: "ok", text: `Đã deploy${r.warnings?.length ? ` — ${r.warnings.join(" ")}` : ""}` });
            const shopify = r.product?.shopify;
            if (shopify) setProducts((list) => list.map((x) => (x.id === rows[i].id ? { ...x, shopify } : x)));
          } else if (r.error) set(i, { state: "fail", text: r.error });
          else set(i, { state: "skip", text: `Bỏ qua — thiếu: ${r.missing.join(" ")}` });
        }
      } catch (e) {
        set(i, { state: "fail", text: e instanceof Error ? e.message : "Lỗi" });
      }
    }
    // Wait for the photos themselves (the server draws 4 at a time for everyone; a photo takes 1–2 min).
    while (started.size) {
      await new Promise((r) => setTimeout(r, 15000));
      for (const [i, ids] of [...started]) {
        try {
          const jobs = (await ctApi.mockupJobs(rows[i].id)).filter((j) => ids.includes(j.id));
          const done = jobs.filter((j) => j.status === "done").length;
          const failed = jobs.filter((j) => j.status === "failed");
          const lost = ids.length - jobs.length;
          // The card shows the first photo as soon as there is one (2026-11-19: it stayed blank until a reload).
          const shot = jobs.filter((j) => j.status === "done" && j.url).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0]?.url;
          if (shot) setProducts((list) => list.map((x) => (x.id === rows[i].id && !x.mockup_url ? { ...x, mockup_url: shot } : x)));
          if (jobs.some((j) => j.status === "running")) {
            set(i, { state: "run", text: `AI đang vẽ ${done}/${ids.length} ảnh${failed.length ? ` · ${failed.length} hỏng` : ""}…` });
            continue;
          }
          started.delete(i);
          const bad = failed.length + lost;
          if (!bad) set(i, { state: "ok", text: `Đủ ${done}/${ids.length} ảnh` });
          else set(i, { state: "fail", text: `Được ${done}/${ids.length} ảnh — ${bad} hỏng: ${[...new Set(failed.map((j) => j.error || "lỗi không rõ"))].join(" · ").slice(0, 300) || "job bị xoá"} (mở sản phẩm → Mockups để vẽ lại)` });
        } catch {
          // a network blip: ask again next round
        }
      }
    }
    setBulk({ title, lines: [...lines], running: false });
    setPicked(new Set());
    // The list again, quietly: each card's picture as the server picks it (picture 1 of the Shopify order).
    if (kind === "mockup") ctApi.listProducts(search.trim(), listKind).then(setProducts).catch(() => undefined);
  };

  const load = useCallback(async (q: string) => {
    setLoading(true);
    try {
      setProducts(await ctApi.listProducts(q, kind));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tải được danh sách");
    } finally {
      setLoading(false);
    }
  }, [kind]);

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
          {kind !== "artwork" && <FilterChips value={filter} onChange={setFilter} options={FILTERS} />}
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <CtInput className="h-9 w-56 pl-8" placeholder={`Tìm ${word}…`} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {actions}
          {kind && (
            <CtButton variant="primary" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> {kind === "artwork" ? "Tạo artwork" : "Tạo sản phẩm"}
            </CtButton>
          )}
        </div>
      </div>
      {kind === "artwork" ? <CreateArtworkDialog open={creating} onOpenChange={setCreating} /> : <CreateProductDialog open={creating} onOpenChange={setCreating} />}
      {fromArtwork && (
        <CreateProductDialog
          key={fromArtwork.id}
          open
          onOpenChange={(o) => {
            if (!o) setFromArtwork(null);
          }}
          artwork={fromArtwork}
        />
      )}

      {kind === "product" && shown.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
          <button
            className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => setPicked(pickedRows.length === shown.length ? new Set() : new Set(shown.map((p) => p.id)))}
          >
            {pickedRows.length === shown.length ? "Bỏ chọn tất cả" : `Chọn tất cả (${shown.length})`}
          </button>
          <span className="text-xs text-muted-foreground">Đã chọn {pickedRows.length}</span>
          <div className="ml-auto flex gap-2">
            <CtButton size="sm" variant="outline" disabled={!pickedRows.length || !!bulk?.running} onClick={() => void runBulk("mockup")} title={`Prompt riêng của sản phẩm, không có thì prompt của product base — tối đa ${BULK_MOCKUP_MAX} sản phẩm mỗi lần`}>
              <Sparkles className="h-3.5 w-3.5" /> Tạo mockup
            </CtButton>
            <CtButton size="sm" variant="primary" disabled={!pickedRows.length || !!bulk?.running} onClick={() => void runBulk("deploy")} title="Sản phẩm đủ thì deploy, thiếu thì bỏ qua và báo thiếu gì">
              <Rocket className="h-3.5 w-3.5" /> Deploy
            </CtButton>
          </div>
        </div>
      )}
      {bulk && (
        <div className="mb-4 rounded-lg border bg-card p-3 text-sm">
          <div className="mb-2 flex items-center gap-2 font-medium">
            {bulk.running && <Loader2 className="h-4 w-4 animate-spin" />}
            {bulk.title}: {bulk.lines.filter((l) => l.state === "ok").length} xong · {bulk.lines.filter((l) => l.state === "skip").length} bỏ qua · {bulk.lines.filter((l) => l.state === "fail").length} lỗi / {bulk.lines.length}
            {!bulk.running && (
              <button className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent" onClick={() => setBulk(null)} aria-label="Đóng">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <ul className="max-h-64 space-y-1 overflow-y-auto text-xs">
            {bulk.lines.map((l) => (
              <li key={l.id} className="flex gap-2">
                <span className={cx("w-16 shrink-0 font-medium", l.state === "ok" ? "text-emerald-600" : l.state === "skip" ? "text-amber-600" : l.state === "fail" ? "text-destructive" : "text-muted-foreground")}>
                  {l.state === "ok" ? "Xong" : l.state === "skip" ? "Bỏ qua" : l.state === "fail" ? "Lỗi" : l.state === "run" ? "Đang chạy" : "Chờ"}
                </span>
                <Link href={`${CT_CONFIG.basePath}/${l.id}`} className="w-48 shrink-0 truncate hover:underline">
                  {l.name}
                </Link>
                <span className="min-w-0 flex-1 text-muted-foreground">{l.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

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
        <div className="rounded-xl border border-dashed py-20 text-center text-sm text-muted-foreground">Không có {word} nào khớp.</div>
      ) : products.length === 0 ? (
        <div className="rounded-xl border border-dashed py-20 text-center text-sm text-muted-foreground">
          <Layers className="mx-auto mb-3 h-10 w-10 opacity-40" />
          {kind === "artwork"
            ? "Chưa có artwork nào — tạo bộ clipart (tự ra artwork), import bộ, hoặc Tạo artwork thủ công."
            : "Chưa có sản phẩm nào — Tạo sản phẩm = 1 artwork hoàn chỉnh + 1 product base."}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {shown.map((p) => {
            const thumb = p.mockup_url ?? p.preview_url ?? p.thumbnail_url ?? p.main_asset?.url ?? null;
            const mine = admin || !currentUserId || p.user_id === currentUserId;
            return (
              <div key={p.id} className={cx("group relative overflow-hidden rounded-xl border bg-card", picked.has(p.id) && "ring-2 ring-sky-500")}>
                {kind === "product" && (
                  <label className="absolute left-2 top-2 z-10 flex h-6 w-6 cursor-pointer items-center justify-center rounded bg-white/90 shadow ring-1 ring-black/20" title="Chọn để tạo mockup / deploy hàng loạt">
                    <input type="checkbox" className="h-4 w-4 cursor-pointer accent-sky-500" checked={picked.has(p.id)} onChange={() => toggle(p.id)} />
                  </label>
                )}
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
                    {p.base_product && <div className="truncate text-[10px] text-muted-foreground">{p.base_product.name}</div>}
                    {p.artwork_from && <div className="truncate text-[10px] text-muted-foreground">artwork “{p.artwork_from.name}”</div>}
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 whitespace-nowrap">
                      <span className={cx("rounded px-1.5 py-0.5 text-[10px] font-medium", STATUS_CLASS[p.status])}>{STATUS_LABEL[p.status]}</span>
                      {kind !== "artwork" && p.shopify && <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-600">Đã deploy</span>}
                      {p.artwork_from?.outdated && (
                        <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600" title={`Artwork “${p.artwork_from.name}” đã có bản mới — mở sản phẩm để cập nhật`}>
                          Artwork mới
                        </span>
                      )}
                      {!!p.artwork_users && (
                        <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-600" title="Số sản phẩm làm từ artwork này">
                          {p.artwork_users} sản phẩm
                        </span>
                      )}
                      <span className="text-[10px] text-muted-foreground">{new Date(p.created_at).toLocaleDateString("vi-VN")}</span>
                    </div>
                  </div>
                  {kind === "artwork" && (
                    <button className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setFromArtwork({ id: p.id, name: p.name })} title="Tạo sản phẩm từ artwork này (chọn product base)">
                      <ShoppingBag className="h-4 w-4" />
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
