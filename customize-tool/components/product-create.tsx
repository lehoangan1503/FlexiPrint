"use client";

/**
 * The two "create" dialogs of Product base · Artwork · Sản phẩm (asked 2026-11-07):
 *
 *   CreateProductDialog  a product (what is sold) = a finished artwork + a product base (variants + price). Opened
 *                        from an artwork (artwork fixed) or from the Sản phẩm tab (pick the artwork too). Title =
 *                        the artwork's name (the theme), editable.
 *   CreateArtworkDialog  a hand-made artwork: on a base product's khuôn in (its sheet, cut line, phôi) or on a blank
 *                        canvas of any width × height; layers are dragged in afterwards in the editor.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Search } from "lucide-react";
import { CT_CONFIG } from "../config";
import type { CtBaseProductRow, CtProductListRow } from "../types";
import { ctApi } from "../lib/api-client";
import { formatUsd, priceCells } from "../lib/pricing";
import { CHECKER_STYLE, CtButton, CtField, CtInput, CtModal, cx } from "./ui";

/** "$19.95 – $139.50 · 18 biến thể" */
export function priceSummary(b: CtBaseProductRow): string {
  if (!b.priceTable) return "Chưa gắn bảng giá";
  const cells = priceCells(b.priceTable.config);
  if (!cells.length) return "Bảng giá trống";
  const prices = cells.map((c) => c.price);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  return `${lo === hi ? formatUsd(lo) : `${formatUsd(lo)} – ${formatUsd(hi)}`} · ${cells.length} biến thể`;
}

function useBases(open: boolean): { bases: CtBaseProductRow[] | null; error: string | null } {
  const [bases, setBases] = useState<CtBaseProductRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || bases) return;
    ctApi
      .listBaseProducts()
      .then(setBases)
      .catch((e: Error) => setError(e.message));
  }, [open, bases]);
  return { bases, error };
}

/** One base product to pick: its phôi / mockup, name, price range. */
function BaseCard({ b, on, onPick }: { b: CtBaseProductRow; on: boolean; onPick: () => void }) {
  const pic = b.template?.blankUrl ?? b.mockup_url;
  return (
    <button
      type="button"
      onClick={onPick}
      className={cx("flex w-full items-center gap-3 rounded-lg border p-2 text-left hover:bg-accent", on && "border-sky-500 ring-2 ring-sky-500/40")}
    >
      <div className="h-14 w-14 shrink-0 overflow-hidden rounded-md border" style={CHECKER_STYLE}>
        {pic ? <img src={pic} alt="" className="h-full w-full object-contain" /> : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{b.name}</div>
        <div className="truncate text-[11px] text-muted-foreground">{priceSummary(b)}</div>
        <div className="truncate text-[11px] text-muted-foreground">{b.template ? `Khuôn ${b.template.width}×${b.template.height}px` : b.config.printAreas[0] ? `Print area ${b.config.printAreas[0].width}×${b.config.printAreas[0].height}px` : "Chưa có khuôn"}</div>
      </div>
      {on && <Check className="h-4 w-4 shrink-0 text-sky-500" />}
    </button>
  );
}

export function CreateProductDialog({
  open,
  onOpenChange,
  artwork,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Fixed artwork (opened from it); absent = picked here. */
  artwork?: { id: string; name: string } | null;
  /** Default: open the new product. */
  onCreated?: (productId: string) => void;
}) {
  const router = useRouter();
  const { bases, error: basesError } = useBases(open);
  const [artworks, setArtworks] = useState<CtProductListRow[] | null>(null);
  const [q, setQ] = useState("");
  const [artId, setArtId] = useState<string | null>(artwork?.id ?? null);
  const [baseId, setBaseId] = useState<string | null>(null);
  const [name, setName] = useState(artwork?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || artwork || artworks) return;
    ctApi
      .listProducts("", "artwork")
      .then(setArtworks)
      .catch((e: Error) => setError(e.message));
  }, [open, artwork, artworks]);
  const shownArtworks = useMemo(() => (artworks ?? []).filter((a) => !q.trim() || a.name.toLowerCase().includes(q.trim().toLowerCase())), [artworks, q]);

  const create = async () => {
    if (!artId || !baseId) return;
    setBusy(true);
    setError(null);
    try {
      const p = await ctApi.productFromArtwork(artId, { baseProductId: baseId, name: name.trim() || undefined });
      onOpenChange(false);
      if (onCreated) onCreated(p.id);
      else router.push(`${CT_CONFIG.basePath}/${p.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tạo được sản phẩm");
    } finally {
      setBusy(false);
    }
  };

  return (
    <CtModal open={open} onOpenChange={onOpenChange} title="Tạo sản phẩm" wide={!artwork}>
      <div className={cx("grid gap-4", !artwork && "md:grid-cols-2")}>
        {!artwork && (
          <div className="space-y-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">1 · Artwork hoàn chỉnh</div>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <CtInput className="h-8 pl-8" placeholder="Tìm artwork…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="grid max-h-[52vh] grid-cols-3 gap-2 overflow-auto pr-1">
              {!artworks ? (
                <Loader2 className="col-span-3 mx-auto my-8 h-5 w-5 animate-spin" />
              ) : (
                shownArtworks.map((a) => {
                  const pic = a.preview_url ?? a.thumbnail_url ?? a.main_asset?.url ?? null;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => {
                        setArtId(a.id);
                        setName(a.name);
                      }}
                      className={cx("overflow-hidden rounded-lg border text-left hover:bg-accent", artId === a.id && "border-sky-500 ring-2 ring-sky-500/40")}
                    >
                      <div className="aspect-square" style={CHECKER_STYLE}>
                        {pic && <img src={pic} alt="" className="h-full w-full object-contain p-1" loading="lazy" />}
                      </div>
                      <div className="truncate px-1.5 py-1 text-[11px]">{a.name}</div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}
        <div className="space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{artwork ? "Product base" : "2 · Product base"} — biến thể + giá</div>
          {basesError && <p className="text-xs text-destructive">{basesError}</p>}
          <div className="max-h-[44vh] space-y-2 overflow-auto pr-1">
            {!bases ? <Loader2 className="mx-auto my-8 h-5 w-5 animate-spin" /> : bases.map((b) => <BaseCard key={b.id} b={b} on={baseId === b.id} onPick={() => setBaseId(b.id)} />)}
          </div>
          <CtField label="Tên sản phẩm (theo chủ đề)">
            <CtInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Tên artwork" />
          </CtField>
        </div>
      </div>
      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <CtButton variant="outline" onClick={() => onOpenChange(false)}>
          Huỷ
        </CtButton>
        <CtButton variant="primary" disabled={!artId || !baseId || busy} onClick={() => void create()}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Tạo sản phẩm
        </CtButton>
      </div>
    </CtModal>
  );
}

export function CreateArtworkDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const { bases, error: basesError } = useBases(open);
  const [name, setName] = useState("");
  const [baseId, setBaseId] = useState<string | null>(null);
  const [w, setW] = useState("1000");
  const [h, setH] = useState("1000");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = bases?.find((b) => b.id === baseId) ?? null;

  const create = async () => {
    if (!name.trim()) return setError("Đặt tên artwork");
    setBusy(true);
    setError(null);
    try {
      const p = await ctApi.createArtwork(base ? { name: name.trim(), baseProductId: base.id } : { name: name.trim(), width: Number(w), height: Number(h) });
      onOpenChange(false);
      router.push(`${CT_CONFIG.basePath}/${p.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tạo được artwork");
      setBusy(false);
    }
  };

  return (
    <CtModal open={open} onOpenChange={onOpenChange} title="Tạo artwork thủ công">
      <div className="space-y-3">
        <CtField label="Tên artwork">
          <CtInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Gia đình bánh gừng — 2 đến 9 người" autoFocus />
        </CtField>
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Làm cho loại sản phẩm</div>
          {basesError && <p className="text-xs text-destructive">{basesError}</p>}
          <button type="button" onClick={() => setBaseId(null)} className={cx("w-full rounded-lg border p-2 text-left text-sm hover:bg-accent", !baseId && "border-sky-500 ring-2 ring-sky-500/40")}>
            Canvas trống — tự đặt kích thước
          </button>
          <div className="max-h-56 space-y-2 overflow-auto pr-1">{bases?.map((b) => <BaseCard key={b.id} b={b} on={baseId === b.id} onPick={() => setBaseId(b.id)} />)}</div>
        </div>
        {base?.template ? (
          <p className="rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
            Artwork dựng trên khuôn “{base.template.name}” ({base.template.width}×{base.template.height}px): đường cắt, vùng an toàn và phôi lấy theo khuôn.
          </p>
        ) : base?.config.printAreas[0] ? (
          <p className="rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
            Canvas = print area “{base.config.printAreas[0].name}” {base.config.printAreas[0].width}×{base.config.printAreas[0].height}px.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <CtField label="Rộng (px)">
              <CtInput inputMode="numeric" value={w} onChange={(e) => setW(e.target.value)} />
            </CtField>
            <CtField label="Cao (px)">
              <CtInput inputMode="numeric" value={h} onChange={(e) => setH(e.target.value)} />
            </CtField>
          </div>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <CtButton variant="outline" onClick={() => onOpenChange(false)}>
            Huỷ
          </CtButton>
          <CtButton variant="primary" disabled={busy} onClick={() => void create()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Tạo artwork
          </CtButton>
        </div>
      </div>
    </CtModal>
  );
}
