"use client";

/**
 * Dashboard → Product base → "Import" (asked 2026-11-11, like Teeinblue's "Import products from API-integrated
 * Fulfillment"): pick a fulfiller on the left, search its catalog, Import one → a new product base (server/
 * base-import.ts) and its page opens. Printbelle is read from its own API; Merchize through Teeinblue, which needs
 * flexi2 to hold a Teeinblue login (the connect box shows when it does not). Filter (2026-11-12): Tất cả (products
 * that already have a base go to the bottom of each page, marked "Đã import") · Chưa import · Đã import (flexi2's own
 * bases from this fulfiller).
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download, ExternalLink, Loader2, Search } from "lucide-react";
import type { CtFulfillCatalogFilter, CtFulfillCatalogPage, CtFulfillProvider, CtTeeinblueStatus } from "../../types";
import { ctApi } from "../../lib/api-client";
import { formatUsd } from "../../lib/pricing";
import { CHECKER_STYLE, CtButton, CtInput, CtModal, CtTextarea } from "../ui";

const PROVIDERS: Array<{ id: CtFulfillProvider; name: string; via: string }> = [
  { id: "printbelle", name: "Printbelle", via: "API Printbelle" },
  { id: "merchize", name: "Merchize", via: "qua Teeinblue" },
];

function TeeinblueConnect({ status, onDone }: { status: CtTeeinblueStatus | null; onDone: (s: CtTeeinblueStatus) => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await ctApi.connectTeeinblue(code));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không kết nối được");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-4 text-sm">
      <p className="font-medium">{status?.error ?? "Merchize lấy qua Teeinblue — flexi2 cần phiên đăng nhập Teeinblue."}</p>
      <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
        <li>Mở Teeinblue trên Chrome (Shopify admin Cherivia → Apps → Teeinblue) để chắc đang đăng nhập.</li>
        <li>
          Trên máy Mac chạy <code className="rounded bg-muted px-1">node customize-tool/scripts/teeinblue-connect.mjs</code> — mã kết nối được chép sẵn.
        </li>
        <li>Dán vào ô dưới, bấm Kết nối. Sau đó flexi2 tự giữ phiên.</li>
      </ol>
      <CtTextarea rows={3} value={code} onChange={(e) => setCode(e.target.value)} placeholder="Mã kết nối Teeinblue" />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <CtButton variant="primary" size="sm" onClick={() => void connect()} disabled={busy || !code.trim()}>
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Kết nối
      </CtButton>
    </div>
  );
}

export function BaseImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const [provider, setProvider] = useState<CtFulfillProvider>("printbelle");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<CtFulfillCatalogPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [tib, setTib] = useState<CtTeeinblueStatus | null>(null);
  const [filter, setFilter] = useState<CtFulfillCatalogFilter>("all");

  // The imported list is flexi2's own bases: no Teeinblue login needed for it.
  const needsLogin = provider === "merchize" && !!tib && !tib.connected && filter !== "imported";

  useEffect(() => {
    if (open) ctApi.teeinblueStatus().then(setTib).catch(() => undefined);
  }, [open]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await ctApi.baseImportCatalog(provider, query, page, filter));
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "Không tải được catalog");
      if (provider === "merchize") ctApi.teeinblueStatus().then(setTib).catch(() => undefined);
    } finally {
      setLoading(false);
    }
  }, [provider, query, page, filter]);

  useEffect(() => {
    if (!open || (provider === "merchize" && filter !== "imported" && (!tib || !tib.connected))) return;
    void load();
  }, [open, load, provider, tib, filter]);

  const pick = (p: CtFulfillProvider) => {
    setProvider(p);
    setPage(1);
    setData(null);
    setError(null);
  };

  const doImport = async (catalogId: string, title: string) => {
    setImporting(catalogId);
    setError(null);
    try {
      const base = await ctApi.importBase({ provider, catalogId, title });
      router.push(`/base-products/${base.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không import được");
      setImporting(null);
    }
  };

  const pages = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1;

  return (
    <CtModal open={open} onOpenChange={onOpenChange} title="Import product base từ fulfillment" full>
      <div className="flex min-h-0 flex-1 gap-4">
        <aside className="w-44 shrink-0 space-y-1">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Nhà in</p>
          {PROVIDERS.map((p) => (
            <button key={p.id} type="button" onClick={() => pick(p.id)} className={`w-full rounded-md px-3 py-2 text-left text-sm ${provider === p.id ? "bg-accent font-medium" : "hover:bg-accent/60"}`}>
              <div>{p.name}</div>
              <div className="text-[11px] text-muted-foreground">{p.via}</div>
            </button>
          ))}
          {tib?.connected && (
            <p className="px-3 pt-3 text-[11px] text-muted-foreground">
              Teeinblue: đã kết nối{tib.account ? ` (${tib.account})` : ""}
            </p>
          )}
        </aside>
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {needsLogin ? (
            <TeeinblueConnect status={tib} onDone={setTib} />
          ) : (
            <>
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  setPage(1);
                  setQuery(q.trim());
                }}
              >
                <div className="relative w-80">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <CtInput className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm theo tên hoặc mã (ornament, URGOP…)" />
                </div>
                <CtButton type="submit" size="sm" variant="outline">
                  Tìm
                </CtButton>
                {data && <span className="text-xs text-muted-foreground">{data.total} sản phẩm</span>}
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                <div className="ml-auto flex overflow-hidden rounded-md border text-xs">
                  {(
                    [
                      ["all", "Tất cả"],
                      ["new", "Chưa import"],
                      ["imported", `Đã import${data ? ` (${data.importedCount})` : ""}`],
                    ] as Array<[CtFulfillCatalogFilter, string]>
                  ).map(([f, label]) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => {
                        setFilter(f);
                        setPage(1);
                      }}
                      className={`px-3 py-1.5 ${filter === f ? "bg-accent font-medium" : "hover:bg-accent/60"}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </form>
              {filter === "all" && data && data.items.some((it) => it.existing) && (
                <p className="text-[11px] text-muted-foreground">Sản phẩm đã có product base nằm cuối mỗi trang, gắn nhãn “Đã import”.</p>
              )}
              {error && <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-sm text-destructive">{error}</div>}
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                  {(data?.items ?? []).map((it) => (
                    <div key={it.catalogId} className={`flex flex-col overflow-hidden rounded-lg border bg-card ${it.existing && filter !== "imported" ? "opacity-60" : ""}`}>
                      <div className="relative aspect-square bg-white" style={it.image ? undefined : CHECKER_STYLE}>
                        {it.existing && <span className="absolute left-1.5 top-1.5 z-10 rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">Đã import</span>}
                        {it.image && (
                          // eslint-disable-next-line @next/next/no-img-element -- the fulfiller's catalog picture
                          <img src={it.image} alt={it.title} className="h-full w-full object-contain" loading="lazy" />
                        )}
                      </div>
                      <div className="flex flex-1 flex-col gap-1 p-2.5 text-xs">
                        <div className="line-clamp-2 text-sm font-medium leading-snug">{it.title}</div>
                        <div className="text-muted-foreground">
                          {it.catalogId}
                          {it.cost !== null && ` · từ ${formatUsd(it.cost)}`}
                        </div>
                        {(it.variants !== null || it.printArea) && (
                          <div className="text-muted-foreground">
                            {it.variants !== null && `${it.variants} biến thể`}
                            {it.printArea && ` · in ${it.printArea.width}×${it.printArea.height}px`}
                          </div>
                        )}
                        <div className={it.priceTable ? "text-emerald-600" : "text-muted-foreground"}>{it.priceTable ? `Bảng giá: ${it.priceTable.name.split("·")[0].trim()}` : "Chưa có bảng giá"}</div>
                        <div className="mt-auto pt-1.5">
                          {it.existing ? (
                            <div className="space-y-1">
                              <p className="text-[11px] text-emerald-700 dark:text-emerald-400">Đã có product base này — không import lại.</p>
                              <Link href={`/base-products/${it.existing.id}`} className="inline-flex items-center gap-1 text-xs text-sky-600 hover:underline">
                                Mở: {it.existing.name} <ExternalLink className="h-3 w-3" />
                              </Link>
                            </div>
                          ) : (
                            <CtButton size="sm" variant="outline" disabled={!!importing} onClick={() => void doImport(it.catalogId, it.title)}>
                              {importing === it.catalogId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Import
                            </CtButton>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                {data && data.items.length === 0 && !loading && (
                  <p className="py-10 text-center text-sm text-muted-foreground">
                    {filter === "imported" ? "Chưa import sản phẩm nào từ nhà in này." : filter === "new" ? "Trang này toàn sản phẩm đã import — sang trang sau." : "Không có sản phẩm nào."}
                  </p>
                )}
              </div>
              {data && pages > 1 && (
                <div className="flex items-center justify-end gap-2 text-xs">
                  <CtButton size="sm" variant="outline" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>
                    Trước
                  </CtButton>
                  <span>
                    Trang {page} / {pages}
                  </span>
                  <CtButton size="sm" variant="outline" disabled={page >= pages || loading} onClick={() => setPage((p) => p + 1)}>
                    Sau
                  </CtButton>
                </div>
              )}
              {importing && <p className="text-xs text-muted-foreground">Đang import {importing} — đọc biến thể, vùng in, tải ảnh…{provider === "merchize" ? " (Merchize qua Teeinblue có thể mất ~30 giây)" : ""}</p>}
            </>
          )}
        </div>
      </div>
    </CtModal>
  );
}
