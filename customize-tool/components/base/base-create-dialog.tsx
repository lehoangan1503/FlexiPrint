"use client";

/**
 * "+ Product base" (asked 2026-11-23: "ảnh product base là cố định, người dùng phải up lên khi tạo"): the name AND the
 * base's picture are asked together — no base is made without its picture. The picture is CtBaseProductConfig.image:
 * the card in the Product base tab and the base picker show it, a product's mockups never replace it.
 */

import { useRef, useState } from "react";
import { ImagePlus, Loader2 } from "lucide-react";
import { ctApi } from "../../lib/api-client";
import { normalizeBaseConfig } from "../../lib/base-product";
import { CHECKER_STYLE, CtButton, CtField, CtInput, CtModal } from "../ui";

export function BaseCreateDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [seen, setSeen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const pick = (f: File | null) => {
    if (seen) URL.revokeObjectURL(seen);
    setFile(f);
    setSeen(f ? URL.createObjectURL(f) : null);
  };
  const close = (o: boolean) => {
    if (!o) {
      pick(null);
      setName("");
      setError(null);
    }
    onOpenChange(o);
  };

  const ready = !!name.trim() && !!file && !busy;
  const create = async () => {
    if (!file || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { url } = await ctApi.uploadPackImage(file);
      const b = await ctApi.createBaseProduct({ name: name.trim(), config: normalizeBaseConfig({ image: url }) });
      close(false);
      onCreated(b.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tạo được");
    } finally {
      setBusy(false);
    }
  };

  return (
    <CtModal open={open} onOpenChange={close} title="Product base mới">
      <div className="space-y-3">
        <CtField label="Loại sản phẩm (tên)">
          <CtInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Wooden Ornament 1 side" autoFocus />
        </CtField>
        <CtField label="Ảnh product base (bắt buộc)" hint="Ảnh cố định của base: hiện ở thẻ trong tab Product base và khi chọn base. Mockup của sản phẩm không thay ảnh này.">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex h-40 w-40 items-center justify-center overflow-hidden rounded-lg border border-dashed text-xs text-foreground/80 hover:bg-accent"
            style={seen ? CHECKER_STYLE : undefined}
          >
            {seen ? (
              // eslint-disable-next-line @next/next/no-img-element -- a local picture before upload
              <img src={seen} alt="" className="h-full w-full object-contain" />
            ) : (
              <span className="flex flex-col items-center gap-1">
                <ImagePlus className="h-5 w-5" /> Chọn ảnh
              </span>
            )}
          </button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0] ?? null)} />
        </CtField>
        {error && <p className="text-xs font-medium text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <CtButton variant="outline" onClick={() => close(false)} disabled={busy}>
            Huỷ
          </CtButton>
          <CtButton variant="primary" onClick={() => void create()} disabled={!ready} title={!file ? "Chọn ảnh product base trước" : undefined}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Tạo
          </CtButton>
        </div>
      </div>
    </CtModal>
  );
}
