"use client";

/**
 * A version's "Thêm option": pick its sub-options among ITS OWN clipart set
 * only — the gốc it comes from, that gốc's đa sắc and vật liệu versions (and
 * the đa sắc of those). Never another clipart's pictures.
 */

import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import type { CtAsset } from "../../types";
import { ctApi } from "../../lib/api-client";
import { clipartFamily } from "../../lib/library";
import { CHECKER_STYLE, CtButton, CtModal, cx } from "../ui";
import { ClipartBadges } from "./library-panel";

export function ClipartPickerDialog(props: {
  /** The version the options are for; null = closed. */
  version: CtAsset | null;
  /** Can't be picked (already in the product there). */
  disabledIds: Set<string>;
  onClose: () => void;
  onPick: (picks: CtAsset[]) => void;
}) {
  const { version } = props;
  const [family, setFamily] = useState<CtAsset[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!version) return;
    let live = true;
    setChosen([]);
    setFamily(null);
    setError(null);
    ctApi
      .listCliparts(version.category_id ?? "none")
      .then((list) => {
        if (!live) return;
        // Up from the version's library row to its gốc (the product may read it as a version, not as what it is).
        let root = list.find((a) => a.id === version.id) ?? null;
        for (let i = 0; root?.parent_id && i < 4; i++) root = list.find((a) => a.id === root?.parent_id) ?? root;
        setFamily(root ? clipartFamily(list, root) : []);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [version]);

  const toggle = (a: CtAsset) => {
    if (props.disabledIds.has(a.id) || a.id === version?.id) return;
    setChosen((cur) => (cur.includes(a.id) ? cur.filter((x) => x !== a.id) : [...cur, a.id]));
  };
  const confirm = () => {
    const picks = chosen.map((id) => family?.find((a) => a.id === id)).filter((a): a is CtAsset => a !== undefined);
    if (picks.length) props.onPick(picks);
  };

  return (
    <CtModal open={version !== null} onOpenChange={(o) => !o && props.onClose()} title={`Thêm option cho “${version?.name || "version"}”`}>
      <div className="space-y-3 text-sm">
        <p className="text-[11px] text-muted-foreground">
          Chỉ các ảnh trong bộ của clipart này (gốc, đa sắc, vật liệu). Khách chọn version rồi chọn tiếp 1 ảnh — dùng chung layer & config của version.
        </p>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {family === null ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : family.length <= 1 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">Clipart này chưa có đa sắc / vật liệu nào — tạo ở trang Thư viện.</p>
        ) : (
          <div className="grid max-h-[60vh] grid-cols-4 gap-1.5 overflow-y-auto pr-1">
            {family.map((a) => {
              const on = chosen.includes(a.id);
              const self = a.id === version?.id;
              const off = self || props.disabledIds.has(a.id);
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => toggle(a)}
                  disabled={off}
                  title={self ? `${a.name} — chính version này` : off ? `${a.name} — đã có trong sản phẩm` : a.name}
                  className={cx("relative rounded border p-0.5 text-left disabled:opacity-35", on ? "border-sky-500 ring-1 ring-sky-500" : "hover:border-sky-500")}
                >
                  <div className="relative aspect-square overflow-hidden rounded" style={CHECKER_STYLE}>
                    <img src={a.url} alt={a.name} className="h-full w-full object-contain" loading="lazy" />
                    <ClipartBadges asset={a} origin className="absolute inset-x-0.5 bottom-0.5" />
                  </div>
                  <div className="truncate px-0.5 text-[10px]">{a.name}</div>
                  {on && (
                    <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded bg-sky-500 text-white">
                      <Check className="h-3 w-3" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          {chosen.length > 0 && <span className="mr-auto text-[11px] text-muted-foreground">Đã chọn {chosen.length} — theo thứ tự bấm</span>}
          <CtButton onClick={props.onClose}>Huỷ</CtButton>
          <CtButton variant="primary" onClick={confirm} disabled={chosen.length === 0}>
            Thêm option
          </CtButton>
        </div>
      </div>
    </CtModal>
  );
}
