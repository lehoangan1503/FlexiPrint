"use client";

/**
 * Every file of the cut layer set, by slot (read only). A wrong file is fixed where it comes from — its region in
 * the plan (or the master's backdrop) — then the set is cut again: one fix there fixes every colour / option of it.
 */

import { useState } from "react";
import { Scissors } from "lucide-react";
import type { CtCharLayerFile, CtCharLayerSet } from "../../types";
import { CHECKER_STYLE, CtButton, CtModal } from "../ui";

export function LayerFiles({ set, onFix }: { set: CtCharLayerSet; onFix: ((piece: string) => void) | null }) {
  const [open, setOpen] = useState<CtCharLayerFile | null>(null);
  const total = set.slots.reduce((n, s) => n + s.files.length, 0);
  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-sm font-semibold">Tất cả file ({total})</h4>
        <p className="text-xs text-muted-foreground">Bấm 1 file để xem lớn. File sai thì sửa ở gốc của nó (vùng lớp hoặc nền master) rồi cắt lại — mọi màu / kiểu của lớp đó được sửa cùng lúc.</p>
      </div>
      {set.slots.map((s) => (
        <div key={s.key}>
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {s.label} ({s.files.length})
          </div>
          <div className="flex flex-wrap gap-2">
            {s.files.map((f) => (
              <button key={f.imageId} onClick={() => setOpen(f)} className="w-24 overflow-hidden rounded-md border text-left hover:ring-2 hover:ring-orange-400">
                <div className="aspect-square" style={CHECKER_STYLE}>
                  <Thumb set={set} file={f} />
                </div>
                <div className="truncate px-1 py-0.5 text-[10px]">{[f.option, f.color].filter(Boolean).join(" · ")}</div>
              </button>
            ))}
          </div>
        </div>
      ))}
      <CtModal open={!!open} onOpenChange={(o) => !o && setOpen(null)} title={open ? [set.slots.find((s) => s.files.includes(open))?.label, open.option, open.color].filter(Boolean).join(" · ") : ""} wide>
        {open && (
          <div className="space-y-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- the file itself */}
            <img src={open.url} alt={open.option} className="mx-auto max-h-[70vh] w-auto object-contain" style={CHECKER_STYLE} />
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {set.width}×{set.height}px ·{" "}
                <a href={open.url} target="_blank" rel="noreferrer" className="underline">
                  mở PNG gốc
                </a>
              </span>
              {onFix && open.piece && (
                <CtButton
                  onClick={() => {
                    const piece = open.piece!;
                    setOpen(null);
                    onFix(piece);
                  }}
                >
                  <Scissors className="h-4 w-4" />
                  Sửa vùng của lớp này
                </CtButton>
              )}
            </div>
          </div>
        )}
      </CtModal>
    </div>
  );
}

/** The file's preview zoomed onto its visible pixels (a hair layer is a small part of the canvas). */
export function Thumb({ set, file }: { set: CtCharLayerSet; file: CtCharLayerFile }) {
  const [x, y, w, h] = file.bbox ?? [0, 0, set.width, set.height];
  const pad = Math.max(w, h) * 0.08;
  const side = Math.max(w, h) + pad * 2;
  const cx = x + w / 2;
  const cy = y + h / 2;
  // The square [cx ± side/2, cy ± side/2] of the canvas fills the tile.
  return (
    <div
      className="h-full w-full bg-no-repeat"
      style={{
        backgroundImage: `url(${file.thumbUrl || file.url})`,
        backgroundSize: `${(set.width / side) * 100}% ${(set.height / side) * 100}%`,
        backgroundPosition: `${((cx - side / 2) / (set.width - side || 1)) * 100}% ${((cy - side / 2) / (set.height - side || 1)) * 100}%`,
      }}
      role="img"
      aria-label={file.option}
    />
  );
}
