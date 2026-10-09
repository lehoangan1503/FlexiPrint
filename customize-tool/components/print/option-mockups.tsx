"use client";

/**
 * Mockups tab — the product photo per option of a print-only layer (a background colour): every option gets its
 * own photo (an ornament in that colour on the tree), the design (minus the print-only layer) is placed on it. The
 * storefront swaps the photo when the customer picks the option (CtProductConfig.mockupsByOption).
 */

import { useState } from "react";
import { ImagePlus, Loader2, Trash2 } from "lucide-react";
import type { CtProductScene, CtRegion, CtRenderAsset } from "../../types";
import { sceneFor } from "../../lib/scene";
import { printApi } from "../../lib/print-api";
import { CtButton } from "../ui";
import { BoxPlacer } from "./box-placer";

export interface OptionMockupsProps {
  layer: CtRegion;
  /** The layer's options (pictures), in order. */
  options: CtRenderAsset[];
  scenes: Record<string, CtProductScene>;
  /** The design canvas (main px): new photos get the design contain-fitted into their middle. */
  design: { width: number; height: number };
  onChange: (scenes: Record<string, CtProductScene>) => void;
}

export function OptionMockups({ layer, options, scenes, design, onChange }: OptionMockupsProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(options[0]?.id ?? null);

  const upload = async (optionId: string, file: File | undefined) => {
    if (!file) return;
    setBusy(optionId);
    setError(null);
    try {
      const r = await printApi.uploadImage(file);
      const prev = scenes[optionId];
      onChange({ ...scenes, [optionId]: prev ? { ...prev, url: r.url, width: r.width, height: r.height } : sceneFor(r.url, r.width, r.height, design) });
      setOpen(optionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload thất bại");
    } finally {
      setBusy(null);
    }
  };

  const copyBox = (from: string) => {
    const src = scenes[from];
    if (!src) return;
    const next = { ...scenes };
    for (const id of Object.keys(next)) if (id !== from && next[id].width === src.width && next[id].height === src.height) next[id] = { ...next[id], box: { ...src.box } };
    onChange(next);
  };

  const shown = open ? scenes[open] : undefined;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Layer <b>{layer.name}</b> chỉ in, không vẽ lên ảnh: mỗi lựa chọn có ảnh sản phẩm riêng (vd. ornament nền xanh trên cây thông). Khách chọn nền nào, trang sản phẩm đổi sang ảnh đó và đặt phần còn lại của
        thiết kế (chó, chữ…) lên khung xanh. Không có ảnh riêng = dùng ảnh nền chung của sản phẩm.
      </p>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="grid gap-3 lg:grid-cols-[260px_1fr]">
        <div className="space-y-1.5">
          {options.map((o) => (
            <div key={o.id} className={`flex items-center gap-2 rounded-md border p-1.5 ${open === o.id ? "border-foreground" : ""}`}>
              <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(o.id)}>
                {/* eslint-disable-next-line @next/next/no-img-element -- option thumbnail */}
                <img src={o.meta?.thumb ?? o.url} alt="" className="h-9 w-9 shrink-0 rounded object-cover" />
                <span className="min-w-0 flex-1 truncate text-xs">{o.name}</span>
                {scenes[o.id] && (
                  /* eslint-disable-next-line @next/next/no-img-element -- its mockup photo */
                  <img src={scenes[o.id].url ?? undefined} alt="" className="h-9 w-9 shrink-0 rounded object-cover" />
                )}
              </button>
              <label className="cursor-pointer rounded p-1 hover:bg-accent" title="Tải ảnh mockup cho lựa chọn này">
                {busy === o.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
                <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => void upload(o.id, e.target.files?.[0])} />
              </label>
              {scenes[o.id] && (
                <button
                  className="rounded p-1 hover:bg-accent"
                  title="Bỏ ảnh"
                  onClick={() => {
                    const next = { ...scenes };
                    delete next[o.id];
                    onChange(next);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="rounded-lg border bg-muted/30 p-2">
          {open && shown ? (
            <div className="space-y-2">
              <BoxPlacer
                url={shown.url ?? ""}
                width={shown.width}
                height={shown.height}
                box={shown.box}
                aspect={design.width / design.height}
                onChange={(box) => onChange({ ...scenes, [open]: { ...shown, box } })}
                className="mx-auto max-h-[520px] w-full"
              />
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                Kéo khung xanh để đặt thiết kế đúng lên sản phẩm trong ảnh; kéo góc để phóng to / thu nhỏ.
                <CtButton size="sm" className="ml-auto" onClick={() => copyBox(open)}>
                  Dùng khung này cho mọi ảnh cùng cỡ
                </CtButton>
              </div>
            </div>
          ) : (
            <p className="p-6 text-center text-xs text-muted-foreground">Chọn một lựa chọn và tải ảnh mockup của nó.</p>
          )}
        </div>
      </div>
    </div>
  );
}
