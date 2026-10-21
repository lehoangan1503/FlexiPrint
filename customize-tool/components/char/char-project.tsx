"use client";

/**
 * /v2/:id — one bộ nhân vật, four steps: mô tả → ảnh master → cắt clipart → sản phẩm (3 and 4 run by themselves). The brief saves itself; pictures are
 * made in the background (the page polls while one is running).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Loader2 } from "lucide-react";
import type { CtCharBrief, CtCharImage, CtCharProject } from "../../types";
import { charApi } from "../../lib/api-client";
import { CtAutoWidthInput, cx } from "../ui";
import { CHAR_STATUS_LABEL } from "./char-list";
import { BriefPanel } from "./brief-panel";
import { MasterPanel } from "./master-panel";
import { LayersPanel } from "./layers-panel";
import { CharAgentBar, useCharAgent, type CharAgent } from "./char-agent";
import { CharChat } from "./char-chat";
import { ElementsPanel } from "./elements-panel";
import { ProductStep } from "./product-step";

type Step = "brief" | "master" | "layers" | "product";

// Named for the editor (asked 2026-10-19): 1 and 2 are theirs to review, 3 and 4 run by themselves.
const STEPS: Array<{ id: Step; label: string }> = [
  { id: "brief", label: "1. Mô tả bộ clipart" },
  { id: "master", label: "2. Ảnh master" },
  { id: "layers", label: "3. Cắt clipart · tự động" },
  { id: "product", label: "4. Sản phẩm · tự động" },
];

/** A bộ ảnh khách (brief.kind "photo"): no cut — step 3 draws the pieces around the customer's photo. */
const PHOTO_STEPS: Array<{ id: Step; label: string }> = [
  { id: "brief", label: "1. Mô tả bộ ảnh" },
  { id: "master", label: "2. Ảnh master" },
  { id: "layers", label: "3. Phần tử · tự động" },
  { id: "product", label: "4. Sản phẩm · tự động" },
];

export interface CharCtx {
  project: CtCharProject;
  images: CtCharImage[];
  editable: boolean;
  /** Replace the project (after a server answer). */
  setProject: (p: CtCharProject) => void;
  /** Change the brief (saved after a short pause). */
  setBrief: (b: CtCharBrief) => void;
  addImages: (list: CtCharImage[]) => void;
  reload: () => Promise<void>;
  /** Save a brief still being typed now (the agent reads it from the DB). */
  flush: () => Promise<void>;
  /** @flexiprint working on this bộ (brainstorm, master, edit prompts). */
  agent: CharAgent;
  goto: (s: Step) => void;
  error: (msg: string | null) => void;
  /** The open section of the step ("3a" | "3b" | "3c"): the sticky chat says where a request was written. */
  setSection: (s: string) => void;
}

export function CharProjectView({ projectId, currentUserId, admin = false }: { projectId: string; currentUserId: string; admin?: boolean }) {
  const [project, setProject] = useState<CtCharProject | null>(null);
  const [images, setImages] = useState<CtCharImage[]>([]);
  const [step, setStep] = useState<Step>("brief");
  const [section, setSection] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<"idle" | "pending" | "saved">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingBrief = useRef<CtCharBrief | null>(null);
  const first = useRef(true);

  const reload = useCallback(async () => {
    try {
      const r = await charApi.get(projectId);
      // A brief still being typed wins over the server copy.
      setProject((cur) => (pendingBrief.current && cur ? { ...r.project, brief: cur.brief } : r.project));
      setImages(r.images);
      if (first.current) {
        first.current = false;
        setStep(r.project.status === "brief" ? (r.images.some((im) => im.kind === "master" && !im.role.startsWith("idea:")) ? "master" : "brief") : r.project.status === "master" ? "layers" : r.project.status === "layers" ? "layers" : "product");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tải được");
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Pictures / cut jobs being made: poll.
  const running =
    images.some((im) => im.status === "running") ||
    project?.layers?.status === "building" ||
    project?.cut?.matte?.status === "running" ||
    project?.cut?.plan?.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void reload(), 3000);
    return () => clearInterval(t);
  }, [running, reload]);

  const flush = useCallback(async () => {
    const brief = pendingBrief.current;
    if (!brief) return;
    pendingBrief.current = null;
    try {
      await charApi.update(projectId, { brief });
      setSaving("saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không lưu được brief");
    }
  }, [projectId]);

  const setBrief = useCallback(
    (brief: CtCharBrief) => {
      setProject((p) => (p ? { ...p, brief } : p));
      pendingBrief.current = brief;
      setSaving("pending");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 700);
    },
    [flush],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      void flush();
    },
    [flush],
  );

  const agentKit = useCharAgent(projectId, reload, setError);

  if (!project)
    return (
      <div className="flex min-h-screen items-center justify-center">
        {error ? <p className="text-sm text-destructive">{error}</p> : <Loader2 className="h-6 w-6 animate-spin" />}
      </div>
    );

  // Admins change any set (the server lets them too: server/char/projects.ts canEditProject).
  const editable = admin || project.user_id === currentUserId;
  const ctx: CharCtx = {
    project,
    images,
    editable,
    setProject: (p) => setProject((cur) => (cur && pendingBrief.current ? { ...p, brief: cur.brief } : p)),
    setBrief,
    addImages: (list) => setImages((cur) => [...cur.filter((x) => !list.some((y) => y.id === x.id)), ...list]),
    reload,
    flush: async () => {
      if (timer.current) clearTimeout(timer.current);
      await flush();
    },
    agent: agentKit.agent,
    goto: setStep,
    error: setError,
    setSection,
  };
  const photoSet = project.brief.kind === "photo";
  const done: Record<Step, boolean> = {
    brief: photoSet ? project.brief.photoZones.length > 0 : project.brief.subjects.length > 0,
    // A set drawn pose by pose has no master of its own: done once its poses are on (approved, cut).
    master: !!project.master_id || (!!project.brief.poses?.length && (project.status === "layers" || project.status === "product")),
    layers: project.status === "layers" || project.status === "product",
    product: project.product_ids.length > 0,
  };

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-20 border-b bg-card/80 backdrop-blur-sm">
        <div className="flex h-14 items-center gap-3 px-4">
          <Link href="/v2" className="rounded p-1.5 hover:bg-accent">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <NameField
            key={project.name}
            name={project.name}
            disabled={!editable}
            onCommit={async (name) => {
              try {
                setProject(await charApi.update(projectId, { name }));
              } catch (e) {
                setError(e instanceof Error ? e.message : "Không đổi được tên");
              }
            }}
          />
          <span className="shrink-0 whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{CHAR_STATUS_LABEL[project.status]}</span>
          <nav className="ml-4 flex shrink-0 gap-1">
            {(photoSet ? PHOTO_STEPS : STEPS).map((s) => (
              <button
                key={s.id}
                onClick={() => setStep(s.id)}
                className={cx("flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-3 py-1.5 text-sm", step === s.id ? "bg-foreground text-background" : "hover:bg-accent")}
              >
                {done[s.id] && <Check className="h-3.5 w-3.5 text-emerald-500" />}
                {s.label}
              </button>
            ))}
          </nav>
          <span className="ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground">
            {!editable ? "Chỉ xem (bộ của người khác)" : saving === "pending" ? "Đang lưu…" : saving === "saved" ? "Đã lưu" : ""}
          </span>
        </div>
      </header>
      {error && (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          <span className="flex-1">{error}</span>
          <button className="text-xs underline" onClick={() => setError(null)}>
            Đóng
          </button>
        </div>
      )}
      {project.brief.versionOf && (
        <div className="mx-4 mt-3 rounded-md border border-sky-500/40 bg-sky-500/5 p-3 text-sm">
          {project.brief.versionOf.pose ? (
            <>
              Dáng <b>{project.brief.versionOf.name}</b> của một bộ nhiều nhân vật — nhân vật này vẽ riêng, to, một mình; duyệt master xong tự cắt clipart, sản phẩm ghép các dáng lại.{" "}
            </>
          ) : (
            <>
              Phiên bản <b>{project.brief.versionOf.name}</b> của một bộ vẽ riêng từng phiên bản — master vẽ lại từ master đã duyệt của bộ chính, duyệt xong tự cắt clipart.{" "}
            </>
          )}
          <Link href={`/v2/${project.brief.versionOf.id}`} className="underline">
            Mở bộ chính
          </Link>
        </div>
      )}
      <CharAgentBar {...agentKit} />
      <main className="min-h-0 flex-1">
        {step === "brief" && <BriefPanel {...ctx} />}
        {step === "master" && <MasterPanel {...ctx} />}
        {photoSet && step === "layers" && <ElementsPanel {...ctx} />}
        {photoSet && step === "product" && <ProductStep {...ctx} />}
        {!photoSet && (step === "layers" || step === "product") && <LayersPanel {...ctx} step={step} />}
      </main>
      <CharChat project={project} images={images} tab={step} section={step === "layers" ? section : ""} editable={editable} kit={agentKit} flush={ctx.flush} />
    </div>
  );
}

function NameField({ name, disabled, onCommit }: { name: string; disabled: boolean; onCommit: (name: string) => void }) {
  const [draft, setDraft] = useState(name);
  if (disabled) return <h1 className="truncate text-base font-semibold">{name}</h1>;
  return (
    <CtAutoWidthInput
      className="text-base font-semibold"
      value={draft}
      maxWidth={420}
      onChange={setDraft}
      onCommit={(v) => {
        if (v.trim() && v.trim() !== name) onCommit(v.trim());
      }}
    />
  );
}
