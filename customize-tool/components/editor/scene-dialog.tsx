"use client";

/**
 * Thiết kế → Nền: a background photo behind the design. The design (main +
 * its layers) is one frame on it — drag to place, corners to resize (keeps
 * its aspect). Storefront and "Xem trước" draw the product this way; print
 * files never include the background (CtProductScene, lib/mockup.ts).
 */

import { useEffect, useMemo, useState } from "react";
import { ImagePlus, Loader2, Maximize, Trash2 } from "lucide-react";
import type { CtAsset, CtMainLayout, CtPackBox, CtPackSlide, CtProductScene, CtRegion, CtRegionItem, CtSelection } from "../../types";
import { ctApi } from "../../lib/api-client";
import { canvasToBlob, renderComposite } from "../../lib/compositor";
import { sceneFor } from "../../lib/scene";
import { CtButton, CtModal } from "../ui";
import { PackCanvas } from "../mockup/pack-canvas";

const BG_ID = "bg";
const DESIGN_ID = "design";

export interface SceneDialogProps {
  open: boolean;
  onClose: () => void;
  scene: CtProductScene;
  onChange: (scene: CtProductScene) => void;
  main: CtAsset;
  assets: CtAsset[];
  regions: CtRegion[];
  items: CtRegionItem[];
  selection: CtSelection;
  layouts: Record<string, CtMainLayout>;
}

/** Pick an image file from disk. */
/** Any image the browser can open (AVIF, GIF, BMP, SVG, HEIC on Safari…); see toUploadable. */
export function pickImageFile(): Promise<Blob | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,.avif,.heic,.heif";
    input.onchange = () => {
      const file = input.files?.[0];
      // Undecodable here: send it as is, the server says what is wrong.
      resolve(file ? toUploadable(file).catch(() => file) : null);
    };
    input.click();
  });
}

export const UPLOADABLE = ["image/png", "image/jpeg", "image/webp"];

/**
 * The server takes PNG / JPEG / WebP: anything else is decoded by the
 * browser and re-encoded as WebP (PNG where WebP can't be written), alpha kept.
 */
export async function toUploadable(file: File): Promise<Blob> {
  if (UPLOADABLE.includes(file.type)) return file;
  const src = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode"));
      el.src = src;
    });
    const canvas = document.createElement("canvas");
    // SVGs without a size report 0: give them one.
    canvas.width = img.naturalWidth || 2000;
    canvas.height = img.naturalHeight || 2000;
    canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
    const webp = await canvasToBlob(canvas, "image/webp", 0.95);
    return webp.type === "image/webp" ? webp : canvasToBlob(canvas, "image/png");
  } finally {
    URL.revokeObjectURL(src);
  }
}

export function SceneDialog(props: SceneDialogProps) {
  const { scene, main } = props;
  const [designUrl, setDesignUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(DESIGN_ID);
  /** The frame while it is dragged. */
  const [live, setLive] = useState<CtProductScene["box"] | null>(null);

  // The design as it looks now, as one picture.
  const { open, assets, regions, items, selection, layouts } = props;
  useEffect(() => {
    if (!open) return;
    let url: string | null = null;
    let cancelled = false;
    const scale = Math.min(1, 1200 / Math.max(main.width, main.height));
    renderComposite({ main, assets, regions, items, selection, scale, layouts })
      .then((c) => canvasToBlob(c, "image/png"))
      .then((b) => {
        if (cancelled) return;
        url = URL.createObjectURL(b);
        setDesignUrl(url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [open, main, assets, regions, items, selection, layouts]);

  const box = live ?? scene.box;
  const slide = useMemo<CtPackSlide | null>(() => {
    if (!scene.url) return null;
    return {
      id: "scene",
      name: "Nền",
      width: scene.width,
      height: scene.height,
      background: "",
      layers: [
        { id: BG_ID, name: "Nền", type: "image", box: { x: 0, y: 0, w: scene.width, h: scene.height, rotation: 0 }, opacity: 1, hidden: false, url: scene.url, fit: "stretch", blend: "normal", blur: 0 },
        { id: DESIGN_ID, name: "Thiết kế", type: "image", box: { ...box, rotation: 0 }, opacity: 1, hidden: !designUrl, url: designUrl ?? "", fit: "stretch", blend: "normal", blur: 0 },
      ],
    };
  }, [scene, box, designUrl]);

  const upload = async () => {
    const file = await pickImageFile();
    if (!file) return;
    setBusy("Đang upload nền…");
    setError(null);
    try {
      const r = await ctApi.uploadPackImage(file);
      // Keep the frame where it was (relative to the canvas) when only the photo changes.
      if (scene.url && scene.width && scene.height) {
        const kx = r.width / scene.width;
        const ky = r.height / scene.height;
        props.onChange({ url: r.url, width: r.width, height: r.height, box: { x: scene.box.x * kx, y: scene.box.y * ky, w: scene.box.w * kx, h: scene.box.h * kx } });
      } else {
        props.onChange(sceneFor(r.url, r.width, r.height, main));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload thất bại");
    } finally {
      setBusy(null);
    }
  };

  /** The design keeps its aspect: the height follows the width, around the dragged box's centre. */
  const onBox = (id: string, b: CtPackBox, done: boolean) => {
    if (id !== DESIGN_ID) return;
    const h = (b.w * main.height) / main.width;
    const next = { x: b.x, y: b.y + (b.h - h) / 2, w: b.w, h };
    if (!done) return setLive(next);
    setLive(null);
    props.onChange({ ...scene, box: next });
  };

  return (
    <CtModal open={props.open} onOpenChange={(o) => !o && props.onClose()} title="Nền & khung main" wide>
      <div className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          Ảnh nền nằm sau thiết kế trên storefront và tab Xem trước. Kéo khung thiết kế để đặt vị trí, kéo góc để to / nhỏ. File in không có nền.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <CtButton size="sm" variant="primary" onClick={() => void upload()} disabled={!!busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />} {scene.url ? "Đổi ảnh nền" : "Chọn ảnh nền"}
          </CtButton>
          {scene.url && (
            <>
              <CtButton size="sm" onClick={() => props.onChange(sceneFor(scene.url ?? "", scene.width, scene.height, main))}>
                <Maximize className="h-3.5 w-3.5" /> Căn giữa
              </CtButton>
              <CtButton size="sm" variant="ghost" className="text-destructive" onClick={() => props.onChange({ url: null, width: 0, height: 0, box: { x: 0, y: 0, w: 0, h: 0 } })}>
                <Trash2 className="h-3.5 w-3.5" /> Bỏ nền
              </CtButton>
              <span className="text-xs text-muted-foreground">
                Nền {scene.width}×{scene.height} · thiết kế {Math.round(box.w)}×{Math.round(box.h)}
              </span>
            </>
          )}
          {error && <span className="text-xs text-destructive">{error}</span>}
        </div>
        {slide ? (
          <PackCanvas
            className="h-[65vh] rounded-lg border bg-muted/40"
            slide={slide}
            arts={{}}
            selectedId={selected}
            onSelect={(id) => setSelected(id ?? DESIGN_ID)}
            onBox={onBox}
            editable={(l) => l.id === DESIGN_ID}
          />
        ) : (
          <div className="flex h-60 items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">Chưa có nền — thiết kế hiện trên nền trong suốt.</div>
        )}
        <div className="flex justify-end">
          <CtButton onClick={props.onClose}>Xong</CtButton>
        </div>
      </div>
    </CtModal>
  );
}
