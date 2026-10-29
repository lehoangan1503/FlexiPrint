"use client";

/**
 * Step 3 of a bộ ảnh khách (asked 2026-10-15) — the pieces around the customer's photo. The backgrounds first (a band
 * that follows each background is drawn in its colours), then every element option alone on transparency in the
 * master's look, and the photo zone's sample (the master's pet alone — shown until the customer uploads). A picture
 * that is off is drawn again, with its prompt changed if needed. "Tạo sản phẩm" puts it all on the product. A zone redrawn
 * by AI has its own styles on step 1 ("Style ảnh khách", photo-styles-panel.tsx — asked 2026-10-28).
 */

import { Loader2 } from "lucide-react";
import type { CtCharImage } from "../../types";
import { CHECKER_STYLE, cx } from "../ui";
import type { CharCtx } from "./char-project";

interface Row {
  role: string;
  group: string;
  name: string;
  /** Recoloured from the element's first picture (not drawn). */
  recolor: boolean;
}

/** Every picture the brief needs, grouped by element (mirrors server/char/elements.ts elementPictures). */
function rowsOf(ctx: CharCtx): Row[] {
  const b = ctx.project.brief;
  const out: Row[] = [];
  if (b.kind === "photo") for (const z of b.photoZones) out.push({ role: `sample:${z.id}`, group: `Ảnh mẫu — ${z.label}`, name: "Mẫu (hiện khi khách chưa upload)", recolor: false });
  for (const e of b.elements) {
    if (e.perBackdrop) for (const bd of b.backdrops) out.push({ role: `el:${e.id}:bd:${bd.id}`, group: e.name, name: bd.name, recolor: false });
    else e.options.forEach((o, i) => out.push({ role: `el:${e.id}:${o.id}`, group: e.name, name: o.name, recolor: e.mode === "color" && i > 0 }));
  }
  return out;
}

export function ElementsPanel(ctx: CharCtx) {
  // The customer-photo styles live on step 1 (brief-panel.tsx), under the brief.
  if (!ctx.project.master_id) return <p className="p-6 text-center text-sm text-muted-foreground">Duyệt master ở bước 2 trước — mọi phần tử được vẽ theo phong cách của nó.</p>;
  return (
    <div className="space-y-6 p-6">
      <ElementGallery {...ctx} />
    </div>
  );
}

/**
 * The decorations' pictures (a bộ ảnh khách's step 3; a bộ nhân vật's step 4 — asked 2026-10-18: the ribbon banner,
 * the year, the trees beside the family), each drawn alone by @flexiprint with the rest of steps 3–4 (asked
 * 2026-10-18: no buttons — a picture to redo is asked in the chat).
 */
export function ElementGallery(ctx: CharCtx) {
  const { images } = ctx;
  const rows = rowsOf(ctx);
  const latest = (role: string): CtCharImage | null => [...images].reverse().find((im) => im.role === role) ?? null;

  const groups = [...new Set(rows.map((r) => r.group))];
  return (
    <>
      <section className="space-y-4 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex-1">
            <h3 className="text-sm font-semibold">Phần tử trang trí</h3>
            <p className="text-xs text-muted-foreground">Mỗi ô là 1 lựa chọn của khách, AI vẽ riêng trên nền trong suốt theo master. Ảnh nào chưa ưng thì nhắn @flexiprint ở ô chat.</p>
          </div>
        </div>
        {groups.map((g) => (
          <div key={g}>
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{g}</div>
            <div className="flex flex-wrap gap-3">
              {rows
                .filter((r) => r.group === g)
                .map((r) => {
                  const im = latest(r.role);
                  return (
                    <figure key={r.role} className="w-44 shrink-0">
                      <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg border" style={CHECKER_STYLE}>
                        {im?.status === "done" ? (
                          // eslint-disable-next-line @next/next/no-img-element -- our R2 preview
                          <img src={im.thumb_url || im.url} alt={r.name} className="h-full w-full object-contain" />
                        ) : im?.status === "running" ? (
                          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                        ) : (
                          <span className={cx("px-2 text-center text-[11px]", im?.status === "failed" ? "text-destructive" : "text-muted-foreground")}>{im?.status === "failed" ? im.error.slice(0, 120) : r.recolor ? "đổi màu từ ảnh đầu" : "chưa vẽ"}</span>
                        )}
                      </div>
                      <figcaption className="mt-1 flex items-center gap-1 text-xs">
                        <span className="flex-1 truncate" title={r.name}>
                          {r.name}
                          {r.recolor && <span className="text-muted-foreground"> · đổi màu</span>}
                        </span>
                      </figcaption>
                    </figure>
                  );
                })}
            </div>
          </div>
        ))}
        {!rows.length && <p className="text-sm text-muted-foreground">Brief chưa có vùng ảnh khách / phần tử nào (bước 1).</p>}
      </section>
    </>
  );
}
