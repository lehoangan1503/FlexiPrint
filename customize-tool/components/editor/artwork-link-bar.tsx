"use client";

/**
 * Artwork ↔ products in the editor's header (asked 2026-11-06, server/artwork-link.ts):
 *   - a product made from an artwork: "Từ artwork X · bản N", an amber "Có bản artwork mới" with Cập nhật when the
 *     artwork moved on (the product keeps its design until then), and a link to the artwork;
 *   - an artwork: "Sản phẩm từ artwork (k)" — the products made from it, which are behind, update the chosen ones,
 *     and "+ Tạo sản phẩm" (a new product holding this design; photos / price / Shopify are its own).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpCircle, ExternalLink, Layers, Loader2, Plus } from "lucide-react";
import type { CtArtworkProductRow, CtArtworkSource } from "../../types";
import { ctApi } from "../../lib/api-client";
import { CT_CONFIG } from "../../config";
import { CtButton, cx } from "../ui";
import { CreateProductDialog } from "../product-create";

interface Status {
  revision: number;
  source: (CtArtworkSource & { linkedRevision: number }) | null;
  products: CtArtworkProductRow[];
}

export interface ArtworkLinkBarProps {
  productId: string;
  productName: string;
  /** Unsaved edits: an update would throw them away, and a new product is made from the saved artwork. */
  dirty: boolean;
  /** Changes when the artwork is saved (its revision moved). */
  savedTick: number;
  onFlash: (text: string) => void;
}

export function ArtworkLinkBar({ productId, productName, dirty, savedTick, onFlash }: ArtworkLinkBarProps) {
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(() => {
    ctApi.artworkStatus(productId).then(setStatus).catch(() => setStatus(null));
  }, [productId]);
  useEffect(load, [load, savedTick]);

  // Close the panel on an outside click.
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", down);
    return () => window.removeEventListener("mousedown", down);
  }, [open]);

  if (!status) return null;
  const href = (id: string) => `${CT_CONFIG.basePath}/${id}`;

  // ---- a product made from an artwork ----
  if (status.source) {
    const src = status.source;
    const behind = src.revision > src.linkedRevision;
    const update = async () => {
      if (dirty && !window.confirm("Thiết kế đang có thay đổi chưa lưu — cập nhật sẽ thay toàn bộ thiết kế bằng bản artwork mới. Tiếp tục?")) return;
      if (!window.confirm(`Lấy thiết kế bản ${src.revision} của artwork “${src.name}” cho sản phẩm này? Ảnh, mockup, giá, Shopify giữ nguyên; muốn khách thấy thì Deploy lại.`)) return;
      setBusy("sync");
      try {
        await ctApi.syncFromArtwork(productId);
        window.location.reload();
      } catch (e) {
        onFlash(e instanceof Error ? e.message : "Không cập nhật được");
        setBusy(null);
      }
    };
    return (
      <div className="ml-2 flex shrink-0 items-center gap-1.5 text-[11px]">
        <Link href={href(src.id)} target="_blank" className="flex max-w-56 items-center gap-1 rounded-md border px-2 py-1 hover:bg-accent" title="Mở artwork gốc (tab mới)">
          <Layers className="h-3 w-3 shrink-0" />
          <span className="truncate">Từ artwork “{src.name}” · bản {src.linkedRevision}</span>
          <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
        </Link>
        {behind && (
          <button
            onClick={() => void update()}
            disabled={!!busy}
            className="flex items-center gap-1 rounded-md bg-amber-500 px-2 py-1 font-semibold text-white hover:bg-amber-400 disabled:opacity-60"
            title={`Artwork đã có bản ${src.revision} — sản phẩm này đang giữ bản ${src.linkedRevision}`}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowUpCircle className="h-3 w-3" />} Có bản artwork mới · Cập nhật
          </button>
        )}
      </div>
    );
  }

  // ---- an artwork ----
  const rows = status.products;
  const behindRows = rows.filter((r) => r.revision < status.revision);
  const create = () => {
    if (dirty) return onFlash("Lưu artwork trước — sản phẩm mới lấy bản đã lưu");
    setOpen(false);
    setCreating(true);
  };
  const syncPicked = async () => {
    const ids = [...picked];
    if (!ids.length) return;
    if (!window.confirm(`Cập nhật ${ids.length} sản phẩm lên bản ${status.revision} của artwork này? Thiết kế cũ của chúng bị thay; ảnh, giá, Shopify giữ nguyên — Deploy lại để khách thấy.`)) return;
    setBusy("sync");
    try {
      const r = await ctApi.syncManyFromArtwork(productId, ids);
      onFlash(`Đã cập nhật ${r.updated.length} sản phẩm${r.failed.length ? ` · lỗi ${r.failed.length}: ${r.failed[0].error}` : ""}`);
      setPicked(new Set());
      load();
    } catch (e) {
      onFlash(e instanceof Error ? e.message : "Không cập nhật được");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div ref={boxRef} className="relative ml-2 shrink-0">
      <CreateProductDialog
        open={creating}
        onOpenChange={setCreating}
        artwork={{ id: productId, name: productName }}
        onCreated={(id) => {
          window.open(href(id), "_blank");
          load();
        }}
      />
      <button
        onClick={() => setOpen((v) => !v)}
        className={cx("flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent", open && "bg-accent")}
        title="Sản phẩm làm từ artwork này — tạo thêm, cập nhật lên bản mới"
      >
        <Layers className="h-3 w-3" /> Sản phẩm từ artwork ({rows.length})
        {behindRows.length > 0 && <span className="rounded-full bg-amber-500 px-1.5 text-[10px] font-semibold text-white">{behindRows.length} cũ</span>}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-96 space-y-2 rounded-lg border bg-background p-3 text-xs shadow-xl">
          <div className="text-[11px] text-muted-foreground">
            Artwork “{productName}” · bản {status.revision}. Sửa artwork không đổi sản phẩm đã làm — chọn sản phẩm để cập nhật khi muốn.
          </div>
          {rows.length === 0 ? (
            <p className="rounded border border-dashed p-2 text-center text-muted-foreground">Chưa có sản phẩm nào làm từ artwork này.</p>
          ) : (
            <div className="max-h-64 space-y-1 overflow-auto">
              {rows.map((r) => {
                const old = r.revision < status.revision;
                return (
                  <label key={r.id} className="flex items-center gap-2 rounded px-1 py-1 hover:bg-accent">
                    <input
                      type="checkbox"
                      className="accent-sky-500"
                      disabled={!old}
                      checked={picked.has(r.id)}
                      onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n; })}
                    />
                    <Link href={href(r.id)} target="_blank" className="min-w-0 flex-1 truncate hover:underline">
                      {r.name}
                    </Link>
                    {r.shopify && <span className="rounded bg-sky-500/15 px-1 text-[10px] text-sky-600">Shopify</span>}
                    <span className={cx("shrink-0 rounded px-1 text-[10px]", old ? "bg-amber-500/20 text-amber-600" : "bg-emerald-500/15 text-emerald-600")}>
                      {old ? `bản ${r.revision} · cũ` : "mới nhất"}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          {behindRows.length > 0 && (
            <div className="flex items-center gap-2">
              <button className="text-[11px] text-sky-600 hover:underline" onClick={() => setPicked(new Set(behindRows.map((r) => r.id)))}>
                Chọn tất cả bản cũ ({behindRows.length})
              </button>
              <CtButton size="sm" className="ml-auto" disabled={!picked.size || !!busy} onClick={() => void syncPicked()}>
                {busy === "sync" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpCircle className="h-3.5 w-3.5" />} Cập nhật {picked.size || ""} sản phẩm
              </CtButton>
            </div>
          )}
          <div className="flex items-center gap-2 border-t pt-2">
            <span className="text-[11px] text-muted-foreground">Sản phẩm = artwork này + 1 product base (biến thể, giá).</span>
            <CtButton size="sm" variant="primary" className="ml-auto shrink-0" disabled={!!busy} onClick={create}>
              <Plus className="h-3.5 w-3.5" /> Tạo sản phẩm
            </CtButton>
          </div>
        </div>
      )}
    </div>
  );
}
