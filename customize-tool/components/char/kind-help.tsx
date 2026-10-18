"use client";

/**
 * "Hai loại bộ là gì?" (asked 2026-10-18: one "Bộ mới" button, the kind picked in the brief — with a button that
 * explains the two kinds with pictures). The pictures are real sets: the 2-friends ornament (bộ nhân vật) and the
 * angel pet ornament (bộ ảnh khách), in public/ct-guide.
 */

import { useState } from "react";
import { HelpCircle } from "lucide-react";
import type { CtCharSetKind } from "../../types";
import { CtButton, CtModal, cx } from "../ui";

export const KIND_INFO: Record<CtCharSetKind, { title: string; short: string; when: string; how: string[]; pictures: Array<{ src: string; caption: string }> }> = {
  character: {
    title: "Bộ nhân vật",
    short: "AI vẽ nhân vật, khách đổi tóc / áo / màu / phụ kiện",
    when: "Nhân vật chính do AI vẽ: gia đình, bạn thân, cô dâu chú rể, học sinh tốt nghiệp… Khách đổi được kiểu tóc, màu áo, kính, đồ cầm tay; chọn nam / nữ hay số người; có thể kèm vùng mặt / ảnh khách upload (elf mặt khách).",
    how: [
      "Master: AI vẽ đủ nhân vật trên nền trong suốt.",
      "Búp bê giấy: bỏ hết phần khách đổi được, rồi vẽ từng lựa chọn lên búp bê. Clipart = đúng phần pixel khác búp bê, nên ghép lại không lệch 1 pixel.",
      "Sản phẩm: các layer + chữ + nền + phần tử trang trí, khách tự phối.",
    ],
    pictures: [
      { src: "/ct-guide/v2-char-1-master.jpg", caption: "1. Master" },
      { src: "/ct-guide/v2-char-2-doll.jpg", caption: "2. Búp bê giấy (mỗi kiểu tóc / áo vẽ lên đây)" },
      { src: "/ct-guide/v2-char-3-product.jpg", caption: "3. Sản phẩm khách tự phối" },
    ],
  },
  photo: {
    title: "Bộ ảnh khách",
    short: "Ảnh khách là nhân vật chính, AI vẽ phần trang trí quanh ảnh",
    when: "Không có nhân vật vẽ sẵn: ảnh thú cưng / chân dung khách upload là trung tâm (AI vẽ lại theo style khách chọn hoặc giữ nguyên), quanh đó là cánh, vòng sáng, mây, nền, chữ.",
    how: [
      "Master: AI vẽ cả thiết kế với 1 thú cưng MẪU để chốt phong cách.",
      "Phần tử: mỗi lựa chọn (cánh, vòng sáng, dải mây…) AI vẽ riêng, nguyên vẹn, nền trong suốt. Không cắt.",
      "Sản phẩm: ảnh khách ở giữa, phần tử xếp quanh, khách chọn style ảnh + phần tử + nền.",
    ],
    pictures: [
      { src: "/ct-guide/v2-photo-1-master.jpg", caption: "1. Master (thú cưng mẫu)" },
      { src: "/ct-guide/v2-photo-2-elements.jpg", caption: "2. Phần tử vẽ riêng + ảnh mẫu" },
      { src: "/ct-guide/v2-photo-3-product.jpg", caption: "3. Sản phẩm với ảnh khách" },
    ],
  },
};

/** The "?" button + its dialog; `highlight` = the kind shown first / ringed. */
export function KindHelpButton({ highlight, label = "Hai loại bộ là gì?" }: { highlight?: CtCharSetKind; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <CtButton size="sm" variant="ghost" onClick={() => setOpen(true)} title="Giải thích bộ nhân vật và bộ ảnh khách, có hình minh hoạ">
        <HelpCircle className="h-4 w-4" /> {label}
      </CtButton>
      <CtModal open={open} onOpenChange={setOpen} title="Bộ nhân vật hay bộ ảnh khách?" wide>
        <div className="space-y-5">
          <p className="text-sm text-muted-foreground">
            Cả hai đều có thể có vùng ảnh khách upload. Khác nhau ở chỗ <b>ai là nhân vật chính</b>: nhân vật AI vẽ (khách đổi từng phần), hay chính ảnh của khách (AI chỉ vẽ phần trang trí xung quanh). Chọn
            loại ở bước 1 (Brief); khi đã có master thì không đổi loại được nữa.
          </p>
          {(["character", "photo"] as CtCharSetKind[]).map((k) => {
            const info = KIND_INFO[k];
            return (
              <section key={k} className={cx("rounded-xl border p-4", highlight === k && "border-orange-500 ring-1 ring-orange-500")}>
                <h3 className="text-base font-semibold">{info.title}</h3>
                <p className="mb-3 text-sm text-muted-foreground">{info.when}</p>
                <div className="grid grid-cols-3 gap-3">
                  {info.pictures.map((p) => (
                    <figure key={p.src}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- static guide picture */}
                      <img src={p.src} alt={p.caption} className="aspect-square w-full rounded-lg border object-cover" />
                      <figcaption className="mt-1 text-xs text-muted-foreground">{p.caption}</figcaption>
                    </figure>
                  ))}
                </div>
                <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm">
                  {info.how.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ol>
              </section>
            );
          })}
        </div>
      </CtModal>
    </>
  );
}
