"use client";

/**
 * Background cut-out + trim for one asset, previewed live over a checkerboard.
 * Saving replaces the asset's file IN PLACE (same id), so region items,
 * versions and main_asset_id keep pointing at it.
 */

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { CtAsset } from "../../types";
import { removeBackground, trimTransparent, trimUrl } from "../../lib/image-tools";
import { canvasToBlob } from "../../lib/compositor";
import { ctApi } from "../../lib/api-client";
import { CHECKER_STYLE, CtButton, CtCheckbox, CtField, CtModal } from "../ui";

export function CleanupDialog({
  asset,
  onClose,
  onSaved,
}: {
  asset: CtAsset | null;
  onClose: () => void;
  onSaved: (a: CtAsset) => void;
}) {
  const [tolerance, setTolerance] = useState(28);
  const [feather, setFeather] = useState(2);
  const [removeBg, setRemoveBg] = useState(true);
  const [trim, setTrim] = useState(true);
  const [result, setResult] = useState<HTMLCanvasElement | null>(null);
  const [working, setWorking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);

  // The main object keeps its canvas size: region coordinates are in its pixels.
  const isMain = asset?.role === "main";

  useEffect(() => {
    if (!asset) return;
    let cancelled = false;
    setWorking(true);
    setError(null);
    const t = setTimeout(async () => {
      try {
        let c = removeBg ? await removeBackground(asset.url, { tolerance, feather }) : await trimUrl(asset.url, 1_000_000);
        if (trim && !isMain) c = trimTransparent(c, 4);
        if (!cancelled) setResult(c);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Xử lý thất bại");
      } finally {
        if (!cancelled) setWorking(false);
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [asset, tolerance, feather, removeBg, trim, isMain]);

  useEffect(() => {
    const host = previewRef.current;
    if (!host) return;
    host.innerHTML = "";
    if (result) {
      result.style.maxWidth = "100%";
      result.style.maxHeight = "60vh";
      result.style.objectFit = "contain";
      host.appendChild(result);
    }
  }, [result]);

  const save = async () => {
    if (!asset || !result) return;
    setSaving(true);
    try {
      const blob = await canvasToBlob(result, "image/png");
      onSaved(await ctApi.replaceAssetFile(asset.id, blob));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lưu thất bại");
    } finally {
      setSaving(false);
    }
  };

  return (
    <CtModal open={asset !== null} onOpenChange={(o) => !o && !saving && onClose()} title="Xoá nền & cắt viền" wide>
      <div className="grid gap-4 md:grid-cols-[1fr_280px]">
        <div className="flex min-h-[300px] items-center justify-center rounded-lg border p-2" style={CHECKER_STYLE}>
          <div ref={previewRef} className="flex items-center justify-center" />
          {working && <Loader2 className="absolute h-6 w-6 animate-spin" />}
        </div>
        <div className="space-y-4">
          <CtCheckbox checked={removeBg} onChange={setRemoveBg} label="Xoá nền (từ viền ảnh vào trong)" />
          <CtField label={`Độ nhạy màu nền: ${tolerance}`} hint="Tăng nếu còn sót nền, giảm nếu ăn vào object">
            <input type="range" min={2} max={120} value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))} className="w-full accent-sky-500" />
          </CtField>
          <CtField label={`Làm mềm viền: ${feather}px`}>
            <input type="range" min={0} max={6} value={feather} onChange={(e) => setFeather(Number(e.target.value))} className="w-full accent-sky-500" />
          </CtField>
          {!isMain && <CtCheckbox checked={trim} onChange={setTrim} label="Cắt sát nội dung (trim)" />}
          {isMain && <p className="text-[11px] text-muted-foreground">Main object giữ nguyên kích thước canvas để vùng custom không lệch.</p>}
          {result && (
            <p className="text-[11px] text-muted-foreground">
              Kết quả: {result.width}×{result.height}px
            </p>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
          <CtButton variant="primary" className="w-full justify-center" onClick={save} disabled={!result || saving || working}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Lưu (thay ảnh gốc)
          </CtButton>
        </div>
      </div>
    </CtModal>
  );
}
