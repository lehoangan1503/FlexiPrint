"use client";

/**
 * Thư viện → Phôi (asked 2026-10-10): the phôi trơn of every khuôn in one place — a straight photo of the blank piece
 * with where the sheet sits on it. Products made on the khuôn, the v2 brief and the mockups reuse them (the first one
 * is the default). Upload a photo (its box is found on it) or have AI draw one from the khuôn.
 */

import { useEffect, useRef, useState } from "react";
import { Loader2, Sparkles, Trash2, Upload } from "lucide-react";
import type { CtPrintTemplate } from "../../types/print";
import { printApi } from "../../lib/print-api";
import { ctConfirm } from "../dialogs";
import { CHECKER_STYLE, CtButton } from "../ui";
import { KhuonPreview } from "./khuon-tab";

export function PhoiTab() {
  const [templates, setTemplates] = useState<CtPrintTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, string>>({});

  useEffect(() => {
    printApi
      .list()
      .then(setTemplates)
      .catch((e: Error) => setError(e.message));
  }, []);

  const replace = (t: CtPrintTemplate) => setTemplates((cur) => (cur ?? []).map((x) => (x.id === t.id ? t : x)));
  const work = async (t: CtPrintTemplate, label: string, job: () => Promise<CtPrintTemplate>) => {
    setBusy((b) => ({ ...b, [t.id]: label }));
    setError(null);
    try {
      replace(await job());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi");
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[t.id];
        return next;
      });
    }
  };

  const remove = async (t: CtPrintTemplate, id: string) => {
    if (!(await ctConfirm({ title: "Xoá phôi này?", message: "Sản phẩm đã dùng nó vẫn giữ ảnh.", tone: "danger", confirmLabel: "Xoá" }))) return;
    await work(t, "Đang xoá…", () => printApi.update(t.id, { spec: { ...t.spec, blanks: t.spec.blanks.filter((b) => b.id !== id) } }));
  };

  const first = async (t: CtPrintTemplate, id: string) => {
    const pick = t.spec.blanks.find((b) => b.id === id);
    if (!pick) return;
    await work(t, "Đang lưu…", () => printApi.update(t.id, { spec: { ...t.spec, blanks: [pick, ...t.spec.blanks.filter((b) => b.id !== id)] } }));
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mb-4">
        <h2 className="text-base font-semibold">Phôi trơn</h2>
        <p className="text-xs text-muted-foreground">
          Ảnh sản phẩm chưa in, chụp thẳng — theo từng khuôn. Xem trước, storefront và mockup đặt artwork lên phôi (giữ bóng, độ sáng của chất liệu). Phôi đầu tiên là phôi mặc định của khuôn.
        </p>
      </div>
      {error && <p className="mb-3 text-xs text-destructive">{error}</p>}
      {!templates ? (
        <Loader2 className="h-5 w-5 animate-spin" />
      ) : (
        <div className="space-y-4">
          {templates.map((t) => (
            <PhoiRow key={t.id} template={t} busy={busy[t.id] ?? null} onUpload={(f) => void work(t, "Đang upload…", () => printApi.uploadBlank(t.id, f))} onAi={() => void work(t, "AI đang vẽ phôi (~1 phút)…", () => printApi.aiBlank(t.id))} onRemove={(id) => void remove(t, id)} onFirst={(id) => void first(t, id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function PhoiRow(props: { template: CtPrintTemplate; busy: string | null; onUpload: (f: File) => void; onAi: () => void; onRemove: (id: string) => void; onFirst: (id: string) => void }) {
  const { template: t } = props;
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <section className="rounded-xl border bg-card p-3">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="h-12 w-12 shrink-0 overflow-hidden rounded border bg-muted/40 p-1">
          <KhuonPreview spec={t.spec} className="h-full w-full" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{t.name}</div>
          <div className="text-[11px] text-muted-foreground">{t.spec.blanks.length} phôi</div>
        </div>
        {props.busy && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {props.busy}
          </span>
        )}
        <CtButton size="sm" onClick={() => input.current?.click()} disabled={!!props.busy}>
          <Upload className="h-3.5 w-3.5" /> Upload phôi
        </CtButton>
        <CtButton size="sm" variant="primary" onClick={props.onAi} disabled={!!props.busy}>
          <Sparkles className="h-3.5 w-3.5" /> Tạo phôi bằng AI
        </CtButton>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) props.onUpload(f);
          }}
        />
      </div>
      {t.spec.blanks.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">Chưa có phôi.</p>
      ) : (
        <div className="flex flex-wrap gap-3">
          {t.spec.blanks.map((b, i) => (
            <figure key={b.id} className="group relative w-40">
              <div className="aspect-square overflow-hidden rounded-lg border" style={CHECKER_STYLE}>
                {/* eslint-disable-next-line @next/next/no-img-element -- our R2 picture */}
                <img src={b.url} alt={b.name} className="h-full w-full object-contain" loading="lazy" />
              </div>
              <figcaption className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                <span className="truncate">{b.name}</span>
                {i === 0 ? <span className="rounded bg-emerald-600/90 px-1 text-[9px] text-white">mặc định</span> : (
                  <button className="rounded px-1 text-[10px] hover:bg-accent" onClick={() => props.onFirst(b.id)}>
                    đặt mặc định
                  </button>
                )}
              </figcaption>
              <button className="absolute right-1 top-1 hidden rounded bg-black/60 p-1 text-white group-hover:block" onClick={() => props.onRemove(b.id)} aria-label="Xoá phôi">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </figure>
          ))}
        </div>
      )}
    </section>
  );
}
