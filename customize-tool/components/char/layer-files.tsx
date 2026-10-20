"use client";

/**
 * Every file of the cut layer set, by slot (read only). A wrong file is fixed where it comes from — its region in
 * the plan (or the master's backdrop) — then the set is cut again: one fix there fixes every colour / option of it.
 */

import { useState } from "react";
import { Pencil, Scissors } from "lucide-react";
import type { CtCharLayerFile, CtCharLayerSet, CtCharLayerSlot } from "../../types";
import { CHECKER_STYLE, CtButton, CtModal, FLOAT_BTN, cx } from "../ui";

export function LayerFiles({ set, onFix }: { set: CtCharLayerSet; onFix: ((file: CtCharLayerFile) => void) | null }) {
  const [open, setOpen] = useState<CtCharLayerFile | null>(null);
  const [colour, setColour] = useState<Record<string, string>>({});
  // A part made of a back + a front layer (hair) is listed once, by its front: the back is the whole part as drawn
  // (its thumbnail), only the front is edited (asked 2026-10-13).
  const slots = set.slots.filter((s) => !s.follows);
  const total = slots.reduce((n, s) => n + s.files.length, 0);
  const colourOf = (key: string, files: CtCharLayerFile[]) => colour[key] ?? colourGroups(files)[0] ?? "";
  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-sm font-semibold">Tất cả file ({total})</h4>
        <p className="text-xs text-muted-foreground">Bấm 1 file để xem lớn. File sai thì sửa ở gốc của nó (vùng lớp hoặc nền master) rồi cắt lại — mọi màu / kiểu của lớp đó được sửa cùng lúc.</p>
      </div>
      {slots.map((s) => {
        const back = set.slots.find((x) => x.follows === s.key);
        return (
          <div key={s.key}>
            <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {s.label} ({s.files.length}){back && <span className="font-normal normal-case tracking-normal">— ảnh: cả bộ (lớp sau đi kèm) · bút: sửa lớp trước</span>}
              <ColourPick colours={colourGroups(s.files)} value={colourOf(s.key, s.files)} onChange={(c) => setColour((cur) => ({ ...cur, [s.key]: c }))} />
            </div>
            <div className="flex flex-wrap gap-2">
              {s.files.filter((f) => colourGroups(s.files).length < 2 || f.color === colourOf(s.key, s.files)).map((f) => (
                <div key={f.imageId} className="relative">
                  <button onClick={() => setOpen(f)} className="w-24 overflow-hidden rounded-md border text-left hover:ring-2 hover:ring-orange-400">
                    <div className="aspect-square" style={CHECKER_STYLE}>
                      <Thumb set={set} file={backFile(back, f)} />
                    </div>
                    <div className="truncate px-1 py-0.5 text-[10px]">{[f.option, f.color].filter(Boolean).join(" · ")}</div>
                  </button>
                  {onFix && (
                    <button title="Sửa clipart này (mọi màu của kiểu)" onClick={() => onFix(f)} className={`absolute right-1 top-1 p-1.5 ${FLOAT_BTN}`}>
                      <Pencil className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
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
              {onFix && (
                <CtButton
                  onClick={() => {
                    const f = open;
                    setOpen(null);
                    onFix(f);
                  }}
                >
                  <Scissors className="h-4 w-4" />
                  Sửa clipart này
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
        backgroundImage: `url(${file.viewThumbUrl || file.thumbUrl || file.url})`,
        backgroundSize: `${(set.width / side) * 100}% ${(set.height / side) * 100}%`,
        backgroundPosition: `${((cx - side / 2) / (set.width - side || 1)) * 100}% ${((cy - side / 2) / (set.height - side || 1)) * 100}%`,
      }}
      role="img"
      aria-label={file.option}
      // Dragged into the sticky chat (char-chat.tsx reads data-chat-url).
      draggable
      data-chat-url={file.url}
    />
  );
}

/** The file to show for an option of a part made of a back + a front layer: its back (the whole part). */
export function backFile(back: CtCharLayerSlot | null | undefined, f: CtCharLayerFile): CtCharLayerFile {
  return back?.files.find((x) => x.option === f.option && x.color === f.color) ?? f;
}

/** The colours a slot's files come in (a shape part × its colours), in order; empty or one = no colour sets. */
export function colourGroups(files: CtCharLayerFile[]): string[] {
  return [...new Set(files.map((f) => f.color).filter(Boolean))];
}

/** One radio per colour (only when the slot has colour sets). */
function ColourPick({ colours, value, onChange }: { colours: string[]; value: string; onChange: (c: string) => void }) {
  if (colours.length < 2) return null;
  return (
    <span role="radiogroup" className="flex flex-wrap gap-1 normal-case tracking-normal">
      {colours.map((c) => (
        <button key={c} role="radio" aria-checked={c === value} onClick={() => onChange(c)} className={cx("rounded-full border px-2 py-0.5 text-[10px] font-normal", c === value ? "border-orange-500 bg-orange-500/10 text-foreground" : "hover:bg-accent")}>
          {c}
        </button>
      ))}
    </span>
  );
}
