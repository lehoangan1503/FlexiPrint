"use client";

/**
 * A finished bộ nhân vật's clipart as the library shows them (/library → Clipart, asked 2026-10-29): the set's own
 * dress-up view of step 3c — layers stacked on the left, every option of each item on the right — without the
 * automatic checks, and every clipart fixed by hand right here with the same editors as the set's page (CutEditor).
 * A set drawn pose by pose shows each pose's files (VersionsPanel); a bộ ảnh khách has no cut files.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, Loader2 } from "lucide-react";
import type { CtCharImage, CtCharProject } from "../../types";
import { charApi } from "../../lib/api-client";
import { CT_CONFIG } from "../../config";
import type { CharCtx } from "./char-project";
import { useCharAgent } from "./char-agent";
import { CutEditor, LayerView, type CutEdit } from "./cut-panel";
import { VersionsPanel } from "./versions-panel";

export function CharSetFiles({ projectId, currentUserId, admin }: { projectId: string; currentUserId: string; admin: boolean }) {
  const [project, setProject] = useState<CtCharProject | null>(null);
  const [images, setImages] = useState<CtCharImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<CutEdit>(null);

  const reload = useCallback(async () => {
    try {
      const r = await charApi.get(projectId);
      setProject(r.project);
      setImages(r.images);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tải được bộ");
    }
  }, [projectId]);
  useEffect(() => {
    setProject(null);
    setEdit(null);
    void reload();
  }, [reload]);
  // A cut being rebuilt (after a region fix): follow it.
  const building = project?.layers?.status === "building";
  useEffect(() => {
    if (!building) return;
    const t = setInterval(() => void reload(), 3000);
    return () => clearInterval(t);
  }, [building, reload]);

  const agent = useCharAgent(projectId, reload, setError);

  if (!project)
    return error ? <p className="text-sm text-destructive">{error}</p> : <Loader2 className="h-5 w-5 animate-spin" />;

  const ctx: CharCtx = {
    project,
    images,
    editable: admin || project.user_id === currentUserId,
    setProject,
    // The brief is not changed from the library.
    setBrief: () => {},
    addImages: (list) => setImages((cur) => [...cur.filter((x) => !list.some((y) => y.id === x.id)), ...list]),
    reload,
    flush: async () => {},
    agent: agent.agent,
    goto: () => {},
    error: setError,
    setSection: () => {},
  };
  const set = project.layers;
  const total = set?.slots.reduce((n, s) => n + s.files.length, 0) ?? 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">{project.name}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {total ? `${total} clipart` : ""} — bộ nhân vật hoàn chỉnh: chọn kiểu ở cột phải để xem cả nhân vật, bấm bút chì trên 1 clipart để sửa tay (lưu là file, mọi sản phẩm dùng bộ đổi theo). Clipart của bộ chỉ khớp với bộ này nên không tách lẻ.
            {!ctx.editable && " Bộ của người khác — chỉ xem."}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Link href={`/v2/${project.id}`} target="_blank" className="inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs hover:bg-accent">
            <ExternalLink className="h-3.5 w-3.5" /> Mở bộ
          </Link>
          {project.product_ids[0] && (
            <Link href={`${CT_CONFIG.basePath}/${project.product_ids[0]}`} target="_blank" className="inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs hover:bg-accent">
              <ExternalLink className="h-3.5 w-3.5" /> Sản phẩm của bộ
            </Link>
          )}
        </div>
      </div>
      {error && <p className="rounded bg-destructive/10 p-2 text-xs text-destructive">{error}</p>}
      {project.brief.poses?.length ? (
        <VersionsPanel {...ctx} show="files" />
      ) : project.brief.kind === "photo" ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Bộ ảnh khách không có clipart cắt — phần tử của bộ xem ở trang bộ (Mở bộ).</p>
      ) : !set || set.status !== "done" || !set.slots.length ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{set?.status === "building" ? "Đang cắt clipart…" : "Bộ chưa có clipart."}</p>
      ) : (
        <LayerView ctx={ctx} set={set} plan={project.cut?.plan ?? null} onEdit={ctx.editable ? setEdit : null} checks={false} />
      )}
      {edit && <CutEditor {...ctx} edit={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}
