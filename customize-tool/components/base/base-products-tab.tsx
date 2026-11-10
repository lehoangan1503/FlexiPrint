"use client";

/**
 * /dashboard → Product base (asked 2026-11-07, Teeinblue's "Product Base"): the blank products sold, one card each —
 * the phôi, the name (= kind of product), the price range and number of variants from its Notion price table, how
 * many products are made on it and their mockups. A card opens the base product's page (/base-products/:id).
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download, Loader2, Plus } from "lucide-react";
import type { CtBaseProductRow } from "../../types";
import { ctApi } from "../../lib/api-client";
import { normalizeBaseConfig } from "../../lib/base-product";
import { formatUsd } from "../../lib/pricing";
import { priceSummary } from "../product-create";
import { ctPrompt } from "../dialogs";
import { CHECKER_STYLE, CtButton } from "../ui";
import { BaseImportDialog } from "./base-import-dialog";

/** " · giá vốn $4.50 – $6.20" of an imported base's fulfiller variants. */
function costRange(b: CtBaseProductRow): string {
  const c = b.config.variants.flatMap((v) => (v.cost !== null ? [v.cost] : []));
  if (!c.length) return "";
  const lo = Math.min(...c);
  const hi = Math.max(...c);
  return ` · giá vốn ${lo === hi ? formatUsd(lo) : `${formatUsd(lo)} – ${formatUsd(hi)}`}`;
}

export function BaseProductsTab({ admin }: { admin: boolean }) {
  const router = useRouter();
  const [bases, setBases] = useState<CtBaseProductRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    ctApi
      .listBaseProducts()
      .then(setBases)
      .catch((e: Error) => setError(e.message));
  }, []);

  const create = async () => {
    const name = await ctPrompt({ title: "Product base mới", label: "Loại sản phẩm (tên)", defaultValue: "Wooden Ornament 1 side", confirmLabel: "Tạo" });
    if (!name?.trim()) return;
    try {
      const b = await ctApi.createBaseProduct({ name: name.trim(), config: normalizeBaseConfig({}) });
      router.push(`/base-products/${b.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tạo được");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <p className="text-sm text-muted-foreground">Loại sản phẩm bán: biến thể + giá (bảng giá Notion), khuôn in + phôi. Mockup ở đây là mockup của các sản phẩm làm từ nó.</p>
        {admin && (
          <div className="ml-auto flex shrink-0 gap-2">
            <CtButton variant="outline" onClick={() => void create()}>
              <Plus className="h-4 w-4" /> Product base
            </CtButton>
            <CtButton variant="primary" onClick={() => setImportOpen(true)} title="Import từ Printbelle / Merchize">
              <Download className="h-4 w-4" /> Import
            </CtButton>
          </div>
        )}
      </div>
      {error && <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
      {!bases ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {bases.map((b) => {
            const pic = b.mockup_url ?? b.template?.blankUrl ?? b.config.preview.url ?? b.config.source?.photos[0] ?? null;
            return (
              <Link key={b.id} href={`/base-products/${b.id}`} className="overflow-hidden rounded-xl border bg-card hover:border-foreground/40">
                <div className="aspect-square" style={CHECKER_STYLE}>
                  {pic ? (
                    // eslint-disable-next-line @next/next/no-img-element -- our R2 picture
                    <img src={pic} alt={b.name} className={b.mockup_url ? "h-full w-full object-cover" : "h-full w-full object-contain p-3"} loading="lazy" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Chưa có phôi</div>
                  )}
                </div>
                <div className="space-y-0.5 p-2.5">
                  <div className="truncate text-sm font-medium">{b.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">{priceSummary(b)}</div>
                  {b.config.source && (
                    <div className="truncate text-[11px] text-muted-foreground">
                      {b.config.fulfillment.provider} {b.config.source.catalogId}
                      {costRange(b)}
                    </div>
                  )}
                  <div className="text-[11px] text-muted-foreground">
                    {b.products} sản phẩm · {b.mockups} mockup
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
      {admin && <BaseImportDialog open={importOpen} onOpenChange={setImportOpen} />}
    </div>
  );
}
