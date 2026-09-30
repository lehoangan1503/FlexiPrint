"use client";

/**
 * "Đưa vào thư viện": move one of the product's cliparts (with its versions)
 * into the global library, under a category of the matching usage (a main
 * object into a "main" category, a sub into an "element" category).
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import type { CtAsset, CtClipartCategory } from "../../types";
import { ctApi } from "../../lib/api-client";
import { flattenCategories } from "../../lib/library";
import { CtButton, CtField, CtModal, CtSelect } from "../ui";

const NONE = "none";

export function PromoteDialog({ asset, onClose, onDone }: { asset: CtAsset | null; onClose: () => void; onDone: (assets: CtAsset[]) => void }) {
  const [categories, setCategories] = useState<CtClipartCategory[]>([]);
  const [category, setCategory] = useState<string>(NONE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!asset) return;
    setError(null);
    ctApi
      .listCategories()
      .then((r) => setCategories(r.categories))
      .catch((e: Error) => setError(e.message));
  }, [asset]);

  const usage = asset?.role === "main" ? "main" : "element";
  const options = useMemo(
    () => [
      { value: NONE, label: "Chưa phân loại" },
      ...flattenCategories(categories)
        .filter(({ category: c }) => c.usage === usage)
        .map(({ category: c, depth }) => ({ value: c.id, label: `${"— ".repeat(depth)}${c.name}` })),
    ],
    [categories, usage],
  );

  const submit = async () => {
    if (!asset) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await ctApi.promoteAsset(asset.id, category === NONE ? null : category));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi");
    } finally {
      setBusy(false);
    }
  };

  return (
    <CtModal open={asset !== null} onOpenChange={(o) => !o && onClose()} title="Đưa vào thư viện clipart">
      {asset && (
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            “{asset.name || asset.role}” và các version của nó sẽ chuyển vào thư viện chung. Sản phẩm này vẫn dùng như cũ, và sản phẩm khác cũng dùng lại được.
          </p>
          <CtField label={usage === "main" ? "Danh mục (main object)" : "Danh mục (element)"} hint="Chỉ hiện danh mục cùng loại. Tạo danh mục mới ở trang Quản lý thư viện.">
            <CtSelect<string> value={category} onChange={setCategory} options={options} />
          </CtField>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <CtButton onClick={onClose}>Huỷ</CtButton>
            <CtButton variant="primary" onClick={() => void submit()} disabled={busy}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Đưa vào thư viện
            </CtButton>
          </div>
        </div>
      )}
    </CtModal>
  );
}
