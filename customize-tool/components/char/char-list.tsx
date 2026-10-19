"use client";

/**
 * /v2 — bộ nhân vật: one brief → one approved master → pixel-registered layers → products.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Plus, Sparkles, Trash2 } from "lucide-react";
import { CT_CONFIG } from "../../config";
import type { CtCharProject, CtCharStatus } from "../../types";
import { charApi } from "../../lib/api-client";
import { defaultCharBrief } from "../../lib/char-brief";
import { CHECKER_STYLE, CtButton, cx } from "../ui";
import { ctConfirm, ctPrompt } from "../dialogs";
import { KindHelpButton } from "./kind-help";

export const CHAR_STATUS_LABEL: Record<CtCharStatus, string> = { brief: "Brief", master: "Master đã duyệt", layers: "Đã cắt layer", product: "Có sản phẩm" };
const STATUS_CLASS: Record<CtCharStatus, string> = {
  brief: "bg-muted text-muted-foreground",
  master: "bg-sky-500/15 text-sky-600",
  layers: "bg-violet-500/15 text-violet-600",
  product: "bg-emerald-500/15 text-emerald-600",
};

export function CharList({ currentUserId, admin = false }: { currentUserId: string; admin?: boolean }) {
  const router = useRouter();
  const [projects, setProjects] = useState<CtCharProject[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await charApi.list();
      setProjects(r.projects);
      setThumbs(r.thumbs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tải được");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  /** One "Bộ mới" (asked 2026-10-18): the kind — drawn characters the customer dresses, or the customer's photo +
   * decorations around it — is picked in the brief (KindHelpButton explains them). */
  const create = async () => {
    const name = await ctPrompt({ title: "Bộ mới", label: "Tên bộ", defaultValue: "Ornament tốt nghiệp — nam / nữ", confirmLabel: "Tạo" });
    if (!name?.trim()) return;
    setCreating(true);
    try {
      const p = await charApi.create({ name: name.trim(), brief: defaultCharBrief("character") });
      router.push(`/v2/${p.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tạo được");
      setCreating(false);
    }
  };

  const remove = async (p: CtCharProject) => {
    if (!(await ctConfirm({ title: `Xoá “${p.name}”?`, message: "Xoá brief, mọi master, ảnh để cắt clipart và layer của bộ. Sản phẩm đã tạo từ bộ vẫn giữ.", tone: "danger", confirmLabel: "Xoá" }))) return;
    try {
      await charApi.remove(p.id);
      setProjects((list) => list.filter((x) => x.id !== p.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Xoá thất bại");
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b bg-card/80 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
          <Link href={CT_CONFIG.homePath} className="rounded p-1.5 hover:bg-accent">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <Sparkles className="h-5 w-5 text-orange-500" />
          <h1 className="text-lg font-semibold">Bộ nhân vật v2</h1>
          <div className="ml-auto flex items-center gap-2">
            <KindHelpButton />
            <CtButton variant="primary" onClick={() => void create()} disabled={creating} title="Một bộ mới — chọn Bộ nhân vật hay Bộ ảnh khách ở bước 1">
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Bộ mới
            </CtButton>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <ol className="mb-6 grid gap-2 text-xs text-muted-foreground sm:grid-cols-4">
          {[
            ["1. Mô tả bộ clipart", "Gõ mô tả + kéo ảnh mẫu vào ô chat → @flexiprint viết brief → bạn review option, tên khách gõ và nền."],
            ["2. Ảnh master", "Tấm gốc mọi clipart cắt ra từ đó. Duyệt kỹ — chưa ưng thì tạo lại / sửa."],
            ["3. Cắt clipart · tự động", "Tự chạy sau khi duyệt master. Xem nếu muốn; sửa tay hoặc nhờ @flexiprint ở ô chat."],
            ["4. Sản phẩm · tự động", "Tự dựng sản phẩm, file in, nền và mockup từ bộ clipart."],
          ].map(([t, d]) => (
            <li key={t} className="rounded-lg border bg-card p-3">
              <div className="font-semibold text-foreground">{t}</div>
              {d}
            </li>
          ))}
        </ol>
        {error && <div className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
        {loading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : projects.length === 0 ? (
          <div className="rounded-xl border border-dashed py-20 text-center text-sm text-muted-foreground">
            <Sparkles className="mx-auto mb-3 h-10 w-10 opacity-40" />
            Chưa có bộ nào — bấm “Bộ mới”.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {projects.map((p) => {
              const thumb = thumbs[p.id];
              const mine = admin || p.user_id === currentUserId;
              return (
                <div key={p.id} className="group overflow-hidden rounded-xl border bg-card">
                  <Link href={`/v2/${p.id}`} className="block aspect-square" style={CHECKER_STYLE}>
                    {thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element -- our R2 WebP preview
                      <img src={thumb} alt={p.name} className="h-full w-full object-contain p-2" loading="lazy" />
                    ) : (
                      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Chưa có master</div>
                    )}
                  </Link>
                  <div className="flex items-center gap-2 p-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{p.name}</div>
                      <div className={cx("text-[10px]", p.brief.kind === "photo" ? "text-sky-600" : "text-orange-600")}>{p.brief.kind === "photo" ? "Bộ ảnh khách" : "Bộ nhân vật"}</div>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <span className={cx("rounded px-1.5 py-0.5 text-[10px] font-medium", STATUS_CLASS[p.status])}>{CHAR_STATUS_LABEL[p.status]}</span>
                        <span className="text-[10px] text-muted-foreground">{new Date(p.updated_at).toLocaleDateString("vi-VN")}</span>
                      </div>
                    </div>
                    {mine && (
                      <button className="rounded p-1 text-destructive opacity-0 hover:bg-accent group-hover:opacity-100" onClick={() => remove(p)} title="Xoá">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
