"use client";

/**
 * ‹ › in the editor's top bar (asked 2026-11-24): ‹ = the product made just before this one, › = the one made just
 * after — the list's order, same store, same kind, and the "Người đăng" people ticked (GET products/:id/neighbors).
 * Unsaved design → asks before leaving.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { ctApi } from "../../lib/api-client";
import { CT_CONFIG } from "../../config";
import { CtTooltip, cx } from "../ui";

type Side = { id: string; name: string } | null;

export function ProductNav({ productId, dirty }: { productId: string; dirty: boolean }) {
  const router = useRouter();
  const [got, setGot] = useState<{ of: string; older: Side; newer: Side } | null>(null);
  const nb = got?.of === productId ? got : null;

  useEffect(() => {
    let alive = true;
    ctApi
      .productNeighbors(productId)
      .then((r) => alive && setGot({ of: productId, ...r }))
      .catch(() => alive && setGot({ of: productId, older: null, newer: null }));
    return () => {
      alive = false;
    };
  }, [productId]);

  const go = (to: Side) => {
    if (!to) return;
    if (dirty && !window.confirm("Thiết kế chưa lưu sẽ mất. Vẫn chuyển sang sản phẩm khác?")) return;
    router.push(`${CT_CONFIG.basePath}/${to.id}`);
  };

  const btn = (to: Side, label: string, empty: string, Icon: typeof ChevronLeft) => (
    <CtTooltip label={to ? `${label}: ${to.name}` : nb ? empty : "Đang tìm…"}>
      <button
        type="button"
        aria-label={label}
        disabled={!to}
        onClick={() => go(to)}
        className={cx("rounded p-1.5", to ? "hover:bg-accent" : "cursor-not-allowed opacity-30")}
      >
        <Icon className="h-4 w-4" />
      </button>
    </CtTooltip>
  );

  return (
    <div className="flex shrink-0 items-center rounded-md border">
      {btn(nb?.older ?? null, "Sản phẩm trước", "Đây là sản phẩm cũ nhất", ChevronLeft)}
      <span className="h-5 w-px bg-border" />
      {btn(nb?.newer ?? null, "Sản phẩm mới hơn", "Đây là sản phẩm mới nhất", ChevronRight)}
    </div>
  );
}
