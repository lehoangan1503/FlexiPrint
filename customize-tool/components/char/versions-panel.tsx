"use client";

/**
 * The versions of a lineup drawn version by version (brief.lineup.drawn, asked 2026-10-19): this set is the biggest
 * version, each smaller one is its own set (server/char/versions.ts) — its own master, doll, 3b pictures and cut. Shown
 * on the parent's steps 2 and 3: each version's masters (the approved one ringed) and how far it is; a click opens it.
 * A set drawn pose by pose shows each pose WHOLE here (asked 2026-10-22: the parent is the one page of the set): every
 * master of the pose (zoom, approve) on step 2, every clipart file it was cut into on step 3.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, ExternalLink, Loader2 } from "lucide-react";
import type { CtCharVersionCard } from "../../types";
import { LayerFiles } from "./layer-files";
import { charVersions } from "../../lib/char-lineup";
import { charApi } from "../../lib/api-client";
import { CHECKER_STYLE, CtButton, CtModal, cx } from "../ui";
import type { CharCtx } from "./char-project";

function stage(v: CtCharVersionCard): { text: string; busy: boolean; ok: boolean } {
  const p = v.project;
  if (p.layers?.status === "done") return { text: "Cắt xong", busy: false, ok: true };
  if (p.layers?.status === "building" || p.cut?.plan?.status === "running") return { text: "Đang cắt clipart (3c)", busy: true, ok: false };
  if (p.cut?.plan?.status === "failed") return { text: `3c lỗi: ${p.cut.plan.error}`, busy: false, ok: false };
  if (p.master_id && v.edits.total) return { text: `3b: ${v.edits.done}/${v.edits.total} ảnh${v.edits.failed ? ` · ${v.edits.failed} lỗi` : ""}`, busy: v.edits.running > 0 || p.cut?.matte?.status === "running", ok: false };
  if (p.master_id) return { text: "Đã duyệt master", busy: true, ok: false };
  if (v.masters.some((m) => m.status === "running")) return { text: "Đang vẽ master", busy: true, ok: false };
  return { text: "Chờ chọn master", busy: false, ok: false };
}

/** `show`: what each pose shows — its masters (step 2) or its clipart files (step 3). */
export function VersionsPanel({ show = "masters", ...ctx }: CharCtx & { show?: "masters" | "files" }) {
  const { project } = ctx;
  const [list, setList] = useState<CtCharVersionCard[] | null>(null);
  const load = useCallback(async () => {
    try {
      setList(await charApi.versions(project.id));
    } catch {
      /* the panel is a view */
    }
  }, [project.id]);
  useEffect(() => {
    void load();
  }, [load, project.updated_at]);
  const busy = (list ?? []).some((v) => stage(v).busy);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [busy, load]);
  const poses = project.brief.poses ?? [];
  if (!project.brief.lineup?.drawn && !poses.length) return null;
  const names = charVersions(project.brief);
  const biggest = names[names.length - 1]?.name ?? "";
  /** Who a pose is drawn as and placed as ("(lật)" = mirrored). */
  const whoIn = (poseId: string | undefined) => {
    const pose = poses.find((x) => x.id === poseId);
    return (pose?.subjects ?? []).map((id) => `${project.brief.subjects.find((x) => x.id === id)?.name || id}${pose?.mirrored.includes(id) ? " (lật)" : ""}`).join(", ");
  };
  return (
    <section className="rounded-xl border bg-card p-4">
      <h3 className="text-sm font-semibold">{poses.length ? `Dáng — mỗi nhân vật vẽ riêng (${poses.length})` : `Phiên bản — ${project.brief.lineup?.label} (${names.length})`}</h3>
      <p className="mb-3 text-xs text-muted-foreground">
        {poses.length ? (
          <>
            Mỗi dáng là một nhân vật vẽ một mình, to, trên khung vuông riêng: master, búp bê, ảnh 3b và clipart riêng. Nhân vật cùng dáng dùng chung (bên kia lật gương). Khi mọi dáng cắt xong, @flexiprint ghép thành {names.length > 1 ? `${names.length} phiên bản` : "sản phẩm"} giống mẫu.
          </>
        ) : (
          <>
            Mỗi phiên bản là một ảnh riêng (không cắt từ ảnh đông người): bản <b>{biggest}</b> là chính bộ này; các bản nhỏ hơn có bộ riêng, master vẽ lại từ master đã duyệt, rồi tự cắt clipart. @flexiprint chọn master cho từng bản; sản phẩm gom mọi bản khi tất cả cắt xong.
          </>
        )}
      </p>
      {!list ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : poses.length && list.length ? (
        <div className="space-y-4">
          {list.map((v) => (
            <PoseSet key={v.project.id} ctx={ctx} card={v} who={whoIn(v.project.brief.versionOf?.pose)} show={show} onChange={load} />
          ))}
        </div>
      ) : !list.length ? (
        <p className="text-xs text-muted-foreground">{poses.length ? "Chưa có dáng nào — nhắn @flexiprint “vẽ các dáng” ở ô chat." : project.master_id ? "Đang tạo các phiên bản…" : "Duyệt master xong, các phiên bản nhỏ hơn được tạo và vẽ ở đây."}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((v) => {
            const st = stage(v);
            return (
              <Link key={v.project.id} href={`/v2/${v.project.id}`} className="block rounded-lg border p-3 hover:bg-accent/40">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {v.project.brief.versionOf?.pose ? v.project.brief.versionOf.name : `${project.brief.lineup?.label}: ${v.project.brief.versionOf?.name}`}
                  <ExternalLink className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
                </div>
                {v.project.brief.versionOf?.pose && <div className="truncate text-[11px] text-muted-foreground">{whoIn(v.project.brief.versionOf.pose)}</div>}
                <div className="mt-2 flex gap-2">
                  {v.masters.length ? (
                    v.masters.slice(-3).map((m) => (
                      <div key={m.id} className={cx("relative h-20 flex-1 overflow-hidden rounded border bg-[repeating-conic-gradient(#eee_0%_25%,#fff_0%_50%)] bg-[length:12px_12px]", m.id === v.project.master_id && "ring-2 ring-emerald-500")}>
                        {m.status === "done" ? (
                          // eslint-disable-next-line @next/next/no-img-element -- our R2 preview
                          <img src={m.thumbUrl} alt="" className="h-full w-full object-contain" />
                        ) : (
                          <Loader2 className="absolute inset-0 m-auto h-4 w-4 animate-spin text-muted-foreground" />
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="h-20 flex-1 rounded border border-dashed" />
                  )}
                </div>
                <div className={cx("mt-2 flex items-center gap-1 text-xs", st.ok ? "text-emerald-600" : "text-muted-foreground")}>
                  {st.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : st.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  {st.text}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** One pose of the parent, whole: its masters (zoom, approve while none is) and its clipart files once cut. */
function PoseSet({ ctx, card, who, show, onChange }: { ctx: CharCtx; card: CtCharVersionCard; who: string; show: "masters" | "files"; onChange: () => Promise<void> }) {
  const p = card.project;
  const st = stage(card);
  const [zoom, setZoom] = useState<CtCharVersionCard["masters"][number] | null>(null);
  const approve = async (imageId: string) => {
    try {
      await charApi.approve(p.id, imageId);
      await onChange();
    } catch (e) {
      ctx.error(e instanceof Error ? e.message : "Không duyệt được");
    }
  };
  const number = (id: string) => card.masters.findIndex((m) => m.id === id) + 1;
  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{p.brief.versionOf?.name}</span>
        <span className="text-xs text-muted-foreground">{who}</span>
        <span className={cx("flex items-center gap-1 text-xs", st.ok ? "text-emerald-600" : "text-muted-foreground")}>
          {st.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : st.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {st.text}
        </span>
        <Link href={`/v2/${p.id}`} className="ml-auto flex items-center gap-1 text-xs text-muted-foreground underline">
          Trang riêng của dáng <ExternalLink className="h-3 w-3" />
        </Link>
      </div>
      {show === "masters" && (
        <>
          <div className="mt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Master ({card.masters.length})</div>
          <div className="mt-1 flex flex-wrap gap-2">
            {card.masters.length ? (
              card.masters.map((m) => (
                <div key={m.id} className={cx("w-40 overflow-hidden rounded-md border", m.id === p.master_id && "ring-2 ring-emerald-500")}>
                  <button className="block aspect-square w-full" style={CHECKER_STYLE} disabled={m.status !== "done"} onClick={() => setZoom(m)}>
                    {m.status === "done" ? (
                      // eslint-disable-next-line @next/next/no-img-element -- our R2 preview
                      <img src={m.thumbUrl} alt="" className="h-full w-full object-contain" />
                    ) : m.status === "running" ? (
                      <Loader2 className="m-auto h-4 w-4 animate-spin text-muted-foreground" />
                    ) : (
                      <span className="p-2 text-[11px] text-destructive">Lỗi</span>
                    )}
                  </button>
                  <div className="flex items-center gap-1 px-1.5 py-1 text-[11px]">
                    #{number(m.id)}
                    {m.id === p.master_id && <span className="ml-auto rounded bg-emerald-500 px-1 text-[10px] text-white">Đã duyệt</span>}
                    {!p.master_id && ctx.editable && m.status === "done" && (
                      <CtButton size="sm" variant="primary" className="ml-auto h-6 px-2 text-[11px]" onClick={() => void approve(m.id)}>
                        Duyệt
                      </CtButton>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <div className="h-40 w-40 rounded-md border border-dashed" />
            )}
          </div>
        </>
      )}
      {show === "files" &&
        (p.layers?.status === "done" && p.layers.slots.length > 0 ? (
          <div className="mt-3">
            <LayerFiles set={p.layers} onFix={null} />
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">Chưa có file — {st.text.toLowerCase()}.</p>
        ))}
      <CtModal open={!!zoom} onOpenChange={(o) => !o && setZoom(null)} title={zoom ? `${p.brief.versionOf?.name} — master #${number(zoom.id)}` : ""} wide>
        {zoom && (
          // eslint-disable-next-line @next/next/no-img-element -- the original
          <img src={zoom.url} alt="master" className="mx-auto max-h-[78vh] w-auto object-contain" style={CHECKER_STYLE} />
        )}
      </CtModal>
    </div>
  );
}
