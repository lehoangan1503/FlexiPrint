"use client";

/**
 * Thư viện ảnh mockup — where a Mockups Image frame (or a custom layer) gets its photo (server/pack-images.ts).
 *
 *   "Tải lên ảnh mới": pick a file, rename it, "Tải lên" → saved to the library as <name>_<timestamp>.<ext> and
 *   used right away. Tabs Tất cả / Ảnh bạn tải lên, search by name; click a photo to use it.
 *
 * Everything saved here can be reused in later edits.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Search, Trash2, Upload, X } from "lucide-react";
import type { CtPackImage } from "../../types";
import { ctApi } from "../../lib/api-client";
import { fileStem, IMAGE_EXT } from "../../lib/file-name";
import { CHECKER_STYLE, CtButton, CtInput, CtModal, cx } from "../ui";
import { ctConfirm } from "../dialogs";
import { toUploadable } from "./scene-dialog";

type Scope = "all" | "mine";

function pickFile(): Promise<File | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,.avif,.heic,.heif";
    input.onchange = () => resolve(input.files?.[0]);
    input.click();
  });
}

/** A chosen file, converted to PNG / JPEG / WebP, with its preview and the name it will be saved under. */
interface Pending {
  blob: Blob;
  preview: string;
  name: string;
}

export interface PackImageLibraryProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The photo picked (or just uploaded and clicked). */
  onPick: (image: CtPackImage) => void;
}

export function PackImageLibrary(props: PackImageLibraryProps) {
  const { open } = props;
  const [scope, setScope] = useState<Scope>("all");
  const [query, setQuery] = useState("");
  const [images, setImages] = useState<CtPackImage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [uploading, setUploading] = useState(false);

  // The grid: reload on scope / search (debounced).
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const t = setTimeout(() => {
      setLoading(true);
      ctApi
        .listPackImages(scope, query.trim())
        .then((list) => !cancelled && setImages(list))
        .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Không tải được thư viện"))
        .finally(() => !cancelled && setLoading(false));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, scope, query, reload]);

  // Mounted per opening (PreviewPanel): everything resets with it; previews are freed when it goes.
  const previews = useRef<string[]>([]);
  useEffect(() => {
    const list = previews.current;
    return () => list.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  const chooseFile = async () => {
    const file = await pickFile();
    if (!file) return;
    setError(null);
    try {
      const blob = await toUploadable(file);
      const url = URL.createObjectURL(blob);
      previews.current.push(url);
      setPending({ blob, preview: url, name: file.name.replace(/\.[^.]+$/, "") });
    } catch {
      setError("Không mở được ảnh này");
    }
  };

  const upload = async () => {
    if (!pending) return;
    setUploading(true);
    setError(null);
    try {
      const image = await ctApi.uploadPackLibraryImage(pending.blob, pending.name.trim() || "Ảnh");
      setPending(null);
      setReload((n) => n + 1);
      props.onPick(image);
      props.onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload thất bại");
    } finally {
      setUploading(false);
    }
  };

  const pick = (image: CtPackImage) => {
    if (image.status !== "done" || !image.url) return;
    props.onPick(image);
    props.onOpenChange(false);
  };

  const remove = async (image: CtPackImage) => {
    if (!(await ctConfirm({ title: `Xoá “${image.name}”?`, message: "Ảnh bị xoá khỏi thư viện. Các mockup đã dùng ảnh này sẽ mất ảnh.", confirmLabel: "Xoá" }))) return;
    try {
      await ctApi.deletePackImage(image.id);
      setReload((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Xoá thất bại");
    }
  };

  const savedAs = useMemo(() => (pending ? `${fileStem(pending.name)}_{timestamp}.${IMAGE_EXT[pending.blob.type] ?? "png"}` : ""), [pending]);
  const shown = images.filter((i) => i.status === "done" && i.url);

  return (
    <CtModal open={open} onOpenChange={props.onOpenChange} title="Thư viện ảnh mockup" wide>
      <div className="min-h-[60vh]">
        {/* Library */}
        <div className="flex min-w-0 flex-col gap-3">
          {pending ? (
            <div className="flex flex-wrap items-end gap-2 rounded-lg border p-2">
              <span className="h-14 w-14 shrink-0 overflow-hidden rounded border" style={CHECKER_STYLE}>
                <img src={pending.preview} alt="" className="h-full w-full object-cover" />
              </span>
              <CtButton size="sm" onClick={() => void chooseFile()} disabled={uploading}>
                <Upload className="h-3.5 w-3.5" /> Đổi tệp
              </CtButton>
              <label className="min-w-48 flex-1 text-[11px] text-muted-foreground">
                Tên tệp <span className="opacity-70">(đổi tên trước khi tải lên)</span>
                <CtInput
                  value={pending.name}
                  onChange={(e) => setPending({ ...pending, name: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && void upload()}
                  autoFocus
                />
              </label>
              <CtButton variant="primary" size="sm" onClick={() => void upload()} disabled={uploading || !pending.name.trim()}>
                {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Tải lên
              </CtButton>
              <CtButton size="icon" variant="ghost" onClick={() => setPending(null)} disabled={uploading} aria-label="Huỷ">
                <X className="h-4 w-4" />
              </CtButton>
              <p className="w-full text-[11px] text-muted-foreground">
                Sẽ lưu thành: <code>{savedAs}</code>
              </p>
            </div>
          ) : (
            <div className="flex gap-2">
              <CtButton variant="primary" onClick={() => void chooseFile()}>
                <Upload className="h-4 w-4" /> Tải lên ảnh mới
              </CtButton>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-md border p-0.5 text-xs">
              {(
                [
                  ["all", "Tất cả"],
                  ["mine", "Ảnh bạn tải lên"],
                ] as Array<[Scope, string]>
              ).map(([id, label]) => (
                <button
                  key={id}
                  className={cx("rounded px-3 py-1", scope === id ? "bg-foreground text-background" : "hover:bg-accent")}
                  onClick={() => setScope(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="relative min-w-48 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <CtInput className="pl-8" placeholder="Tìm kiếm ảnh theo tên…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="grid max-h-[65vh] grid-cols-[repeat(auto-fill,minmax(160px,1fr))] content-start gap-3 overflow-y-auto pr-1">
            {shown.map((img) => {
              return (
                <div key={img.id} className="group relative">
                  <button
                    className="block w-full overflow-hidden rounded-lg border text-left hover:border-sky-500"
                    onClick={() => pick(img)}
                    title={img.name}
                  >
                    <span className="block aspect-square" style={CHECKER_STYLE}>
                      <img src={img.url ?? ""} alt="" className="h-full w-full object-cover" loading="lazy" />
                    </span>
                    <span className="block truncate border-t bg-background px-2 py-1 text-[11px]">{img.name}</span>
                  </button>
                  <button
                    className="absolute right-1.5 top-1.5 hidden rounded bg-black/70 p-1 text-white hover:bg-destructive group-hover:block"
                    onClick={() => void remove(img)}
                    title="Xoá khỏi thư viện"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
            {!loading && !shown.length && <p className="col-span-full py-10 text-center text-xs text-muted-foreground">Chưa có ảnh nào.</p>}
            {loading && !shown.length && <Loader2 className="col-span-full mx-auto my-10 h-5 w-5 animate-spin text-muted-foreground" />}
          </div>
        </div>

      </div>
    </CtModal>
  );
}
