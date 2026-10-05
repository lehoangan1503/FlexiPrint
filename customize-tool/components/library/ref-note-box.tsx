"use client";

/** Reference photos + a description, droppable anywhere on the box — the input of every "… bằng AI" in the library. */

import { useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { CtTextarea, cx } from "../ui";

const REF_MAX_SIDE = 1024;

/** A reference image, downscaled to a white-backed JPEG (keeps the LLM request small). Also used by the AI dialog. */
export async function refImage(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, REF_MAX_SIDE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bmp.width * k));
  canvas.height = Math.max(1, Math.round(bmp.height * k));
  const g = canvas.getContext("2d");
  if (!g) throw new Error("Canvas không khả dụng");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Không đọc được ảnh"))), "image/jpeg", 0.88));
}

export interface RefImage {
  blob: Blob;
  preview: string;
}

export const MAX_PROMPT_REFS = 4;

/** Reference images + a description, droppable anywhere on the box — the input of every "Tạo prompt bằng AI". */
export function RefNoteBox(props: {
  refs: RefImage[];
  onRefs: (fn: (list: RefImage[]) => RefImage[]) => void;
  note: string;
  onNote: (v: string) => void;
  placeholder: string;
  onError: (msg: string) => void;
  /** Photos already saved with the preset: shown with the new ones, removable. */
  saved?: string[];
  onRemoveSaved?: (url: string) => void;
  /** Total photos the box takes (saved + new). */
  max?: number;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  const saved = props.saved ?? [];
  const max = props.max ?? MAX_PROMPT_REFS;
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const add = async (files: File[]) => {
    try {
      const blobs = await Promise.all(files.filter((f) => f.type.startsWith("image/")).map(refImage));
      props.onRefs((list) => [...list, ...blobs.map((blob) => ({ blob, preview: URL.createObjectURL(blob) }))].slice(0, Math.max(0, max - saved.length)));
    } catch (e) {
      props.onError(e instanceof Error ? e.message : "Không đọc được ảnh");
    }
  };
  return (
    <div
      className={cx("space-y-2 rounded-lg border p-3", over && "border-sky-500 bg-sky-500/5")}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void add(Array.from(e.dataTransfer.files));
      }}
    >
      {props.children}
      <div className="flex gap-3">
        <div className="flex w-[140px] shrink-0 flex-wrap content-start gap-1.5">
          {saved.map((u) => (
            <div key={u} className="relative h-16 w-16 overflow-hidden rounded border">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={u} alt="" className="h-full w-full object-cover" />
              {!props.disabled && props.onRemoveSaved && (
                <button className="absolute right-0.5 top-0.5 rounded bg-black/60 p-0.5 text-white" onClick={() => props.onRemoveSaved?.(u)} title="Bỏ ảnh mẫu">
                  <X className="h-2.5 w-2.5" />
                </button>
              )}
            </div>
          ))}
          {props.refs.map((r) => (
            <div key={r.preview} className="relative h-16 w-16 overflow-hidden rounded border">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={r.preview} alt="" className="h-full w-full object-cover" />
              {saved.length > 0 && <span className="absolute bottom-0.5 left-0.5 rounded bg-sky-600/90 px-1 text-[9px] text-white">mới</span>}
              <button
                className="absolute right-0.5 top-0.5 rounded bg-black/60 p-0.5 text-white"
                onClick={() => {
                  URL.revokeObjectURL(r.preview);
                  props.onRefs((list) => list.filter((x) => x.preview !== r.preview));
                }}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          ))}
          {!props.disabled && saved.length + props.refs.length < max && (
            <button
              onClick={() => input.current?.click()}
              className="flex h-16 w-16 flex-col items-center justify-center gap-0.5 rounded border border-dashed text-[10px] leading-tight text-muted-foreground hover:bg-accent"
            >
              <ImagePlus className="h-4 w-4" /> ảnh tham khảo
            </button>
          )}
          <input
            ref={input}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (files.length) void add(files);
            }}
          />
        </div>
        <CtTextarea rows={4} className="flex-1" value={props.note} disabled={props.disabled} onChange={(e) => props.onNote(e.target.value)} placeholder={props.placeholder} />
      </div>
    </div>
  );
}

