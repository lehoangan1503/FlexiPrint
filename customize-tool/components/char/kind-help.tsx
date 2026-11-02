"use client";

/**
 * "3 kiểu bộ" (asked 2026-11-03, replacing "Hai loại bộ là gì?"): the three kinds of clipart set (lib/set-kind.ts),
 * one real set's picture each — kiểu 1 the 2-friends set's clipart, kiểu 2 the angel pet product, kiểu 3 the elf with the
 * customer's face — in public/ct-guide.
 */

import { useState } from "react";
import { HelpCircle } from "lucide-react";
import { SET_KIND_INFO, SET_KINDS, type CtSetKind } from "../../lib/set-kind";
import { CtButton, CtModal } from "../ui";

const KIND_PICTURE: Record<CtSetKind, { src: string; text: string }> = {
  1: { src: "/ct-guide/kind-1-clipart.jpg", text: "Khách đổi từng phần trên nhân vật: tóc, váy, áo, đồ cầm tay… Mỗi lựa chọn là 1 clipart." },
  2: { src: "/ct-guide/v2-photo-3-product.jpg", text: "Không có clipart để chọn: các vùng là layer ghép lại, hoặc vùng nhận ảnh khách upload (thú cưng, chân dung)." },
  3: { src: "/ct-guide/kind-3-clipart-photo.jpg", text: "Vừa chọn clipart (nón, kiểu), vừa có vùng khách upload ảnh (mặt khách trên nhân vật)." },
};

export function KindHelpButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <CtButton size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <HelpCircle className="h-4 w-4" /> 3 kiểu bộ
      </CtButton>
      <CtModal open={open} onOpenChange={setOpen} title="3 kiểu bộ clipart" wide>
        <div className="grid gap-4 sm:grid-cols-3">
          {SET_KINDS.map((k) => (
            <figure key={k} className="space-y-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- static guide picture */}
              <img src={KIND_PICTURE[k].src} alt={SET_KIND_INFO[k].label} className="aspect-square w-full rounded-lg border bg-black object-contain" />
              <figcaption>
                <div className="text-sm font-semibold">
                  {SET_KIND_INFO[k].label} · {SET_KIND_INFO[k].short}
                </div>
                <p className="text-xs text-muted-foreground">{KIND_PICTURE[k].text}</p>
              </figcaption>
            </figure>
          ))}
        </div>
        <p className="mt-4 border-t pt-3 text-sm">Khi viết prompt cho bộ mới, nói rõ bộ thuộc kiểu 1, 2 hay 3 — @flexiprint làm đúng và nhanh hơn.</p>
      </CtModal>
    </>
  );
}
