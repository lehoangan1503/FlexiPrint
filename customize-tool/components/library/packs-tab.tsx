"use client";

/**
 * Library → Bộ mockup: the named sets of mockup scenes saved from a product's
 * "Mockups" tab (types CtMockupPack). They are made and used in the editor;
 * here they are only listed, renamed and deleted.
 */

import { useCallback, useEffect, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import type { CtMockupPack } from "../../types";
import { ctApi } from "../../lib/api-client";
import { CtButton } from "../ui";
import { ctConfirm, ctPrompt } from "../dialogs";

export function PacksTab() {
  const [packs, setPacks] = useState<CtMockupPack[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    ctApi
      .listPacks()
      .then((r) => setPacks(r.packs))
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const rename = async (p: CtMockupPack) => {
    const name = await ctPrompt({ title: "Đổi tên bộ mockup", defaultValue: p.name, confirmLabel: "Lưu" });
    if (!name?.trim() || name.trim() === p.name) return;
    try {
      const saved = await ctApi.updatePack(p.id, { name: name.trim(), notes: p.notes, slides: p.slides, thumbnail_url: p.thumbnail_url });
      setPacks((list) => list.map((x) => (x.id === saved.id ? saved : x)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi");
    }
  };

  const remove = async (p: CtMockupPack) => {
    if (!(await ctConfirm({ title: `Xoá bộ “${p.name}”?`, message: "Mockup đã lưu trong các sản phẩm vẫn giữ nguyên.", tone: "danger", confirmLabel: "Xoá" }))) return;
    try {
      await ctApi.deletePack(p.id);
      setPacks((list) => list.filter((x) => x.id !== p.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi");
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <h2 className="text-sm font-semibold">Bộ mockup</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Tạo trong editor sản phẩm → tab Mockups: làm vài mockup (nền, image frame, kéo version vào, chữ), tick chúng rồi “Lưu làm template”. Sản phẩm cùng loại chỉ cần “Dùng template” — version và thiết kế của nó tự vào đúng các frame.
      </p>
      {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
        {packs.map((p) => (
          <div key={p.id} className="overflow-hidden rounded-lg border">
            <div className="aspect-square bg-muted">{p.thumbnail_url && <img src={p.thumbnail_url} alt="" className="h-full w-full object-cover" />}</div>
            <div className="flex items-center gap-1 p-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{p.name}</p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {p.slides.length} mockup · {p.slides.map((s) => s.name).join(", ")}
                </p>
              </div>
              {p.can_edit && (
                <>
                  <CtButton size="icon" variant="ghost" onClick={() => void rename(p)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </CtButton>
                  <CtButton size="icon" variant="ghost" className="text-destructive" onClick={() => void remove(p)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </CtButton>
                </>
              )}
            </div>
          </div>
        ))}
        {packs.length === 0 && !error && <p className="text-xs text-muted-foreground">Chưa có bộ nào.</p>}
      </div>
    </div>
  );
}
