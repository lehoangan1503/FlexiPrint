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
import type { CtCharImage, CtCharProject, CtCharSetProduct, CtSetOptionField } from "../../types";
import { charApi } from "../../lib/api-client";
import { CT_CONFIG } from "../../config";
import { SET_KIND_INFO, setKind } from "../../lib/set-kind";
import { CHECKER_STYLE } from "../ui";
import type { CharCtx } from "./char-project";
import { useCharAgent } from "./char-agent";
import { CutEditor, LayerView, type CutEdit } from "./cut-panel";
import { VersionsPanel } from "./versions-panel";

export function CharSetFiles({ projectId, currentUserId, admin }: { projectId: string; currentUserId: string; admin: boolean }) {
  const [project, setProject] = useState<CtCharProject | null>(null);
  const [images, setImages] = useState<CtCharImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<CutEdit>(null);
  /** Products using the set: its own and every one it was dropped into (a set serves many products). */
  const [products, setProducts] = useState<CtCharSetProduct[] | null>(null);
  useEffect(() => {
    charApi
      .usedBy(projectId)
      .then(setProducts)
      .catch(() => setProducts([]));
  }, [projectId]);

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
            {[`${SET_KIND_INFO[setKind(project)].label} · ${SET_KIND_INFO[setKind(project)].short}`, total ? `${total} clipart` : "", !ctx.editable ? "chỉ xem" : ""].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Link href={`/v2/${project.id}`} target="_blank" className="inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs hover:bg-accent">
            <ExternalLink className="h-3.5 w-3.5" /> Mở bộ
          </Link>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="text-muted-foreground">Sản phẩm dùng bộ{products ? ` (${products.length})` : ""}:</span>
        {products === null ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : products.length === 0 ? (
          <span className="text-muted-foreground">chưa có</span>
        ) : (
          products.map((x) => (
            <Link
              key={x.id}
              href={`${CT_CONFIG.basePath}/${x.id}`}
              target="_blank"
              title={x.own ? "Sản phẩm dựng từ bộ" : "Sản phẩm đã kéo bộ vào"}
              className="inline-flex max-w-64 items-center gap-1 rounded-full border px-2 py-0.5 hover:bg-accent"
            >
              <ExternalLink className="h-3 w-3 shrink-0" />
              <span className="truncate">{x.name}</span>
              {x.own && <span className="shrink-0 text-[10px] text-muted-foreground">· gốc</span>}
            </Link>
          ))
        )}
      </div>
      {error && <p className="rounded bg-destructive/10 p-2 text-xs text-destructive">{error}</p>}
      {project.brief.extracted && (
        <p className="text-xs text-muted-foreground">
          Cụm clipart tách từ sản phẩm{" "}
          <Link href={`${CT_CONFIG.basePath}/${project.brief.extracted.productId}`} target="_blank" className="underline">
            {project.brief.extracted.productName || "gốc"}
          </Link>{" "}
          · {project.brief.extracted.layers} layer, giữ nguyên vị trí và mọi lựa chọn — kéo vào sản phẩm khác từ tab Thư viện của editor.
        </p>
      )}
      {project.brief.imported || project.brief.extracted ? (
        <ImportedOptions project={project} images={images} />
      ) : project.brief.poses?.length ? (
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

/**
 * An imported set (Teeinblue…) has no cut files: its clipart are its product's zone pictures (server/char/set-options.ts).
 * Shown like a drawn set: the sample on the left, every field with its option pictures on the right.
 */
function ImportedOptions({ project, images }: { project: CtCharProject; images: CtCharImage[] }) {
  const [fields, setFields] = useState<CtSetOptionField[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    charApi
      .options(project.id)
      .then(setFields)
      .catch((e: Error) => setError(e.message));
  }, [project.id]);
  const sample = images.find((im) => im.id === project.master_id);
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!fields) return <Loader2 className="h-5 w-5 animate-spin" />;
  if (!fields.length) return <p className="py-10 text-center text-sm text-muted-foreground">Sản phẩm của bộ chưa có lựa chọn clipart.</p>;
  return (
    <div className="flex flex-wrap items-start gap-6">
      {sample && (
        <div className="aspect-square w-full max-w-xl overflow-hidden rounded-lg border lg:sticky lg:top-4 lg:w-1/2" style={CHECKER_STYLE}>
          {/* eslint-disable-next-line @next/next/no-img-element -- our R2 preview */}
          <img src={sample.url} alt={project.name} className="h-full w-full object-contain" />
        </div>
      )}
      <div className="min-w-[280px] flex-1 space-y-4">
        {fields.map((f) => (
          <section key={f.label}>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {f.label} ({f.options.length})
            </h3>
            <div className="flex flex-wrap gap-2">
              {f.options.map((o) => (
                <figure key={o.name} className="w-20" title={o.name}>
                  <div className="aspect-square overflow-hidden rounded-md border bg-white">
                    {/* eslint-disable-next-line @next/next/no-img-element -- option thumbnail */}
                    <img src={o.thumb} alt={o.name} className="h-full w-full object-contain" loading="lazy" />
                  </div>
                  <figcaption className="mt-0.5 truncate text-[10px] text-muted-foreground">{o.name}</figcaption>
                </figure>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
