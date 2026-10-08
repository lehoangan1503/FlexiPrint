"use client";

/**
 * /v2/:id — one bộ nhân vật, four steps: Brief → Master → Layer → Sản phẩm. The brief saves itself; pictures are
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

type Step = "brief" | "master" | "layers" | "product";

const STEPS: Array<{ id: Step; label: string }> = [
  { id: "brief", label: "1. Brief" },
  { id: "master", label: "2. Master" },
  { id: "layers", label: "3. Layer" },
  { id: "product", label: "4. Sản phẩm" },
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
}

export function CharProjectView({ projectId, currentUserId }: { projectId: string; currentUserId: string }) {
  const [project, setProject] = useState<CtCharProject | null>(null);
  const [images, setImages] = useState<CtCharImage[]>([]);
  const [step, setStep] = useState<Step>("brief");
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
        setStep(r.project.status === "brief" ? (r.images.some((im) => im.kind === "master") ? "master" : "brief") : r.project.status === "master" ? "layers" : r.project.status === "layers" ? "layers" : "product");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tải được");
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Pictures being made: poll.
  const running = images.some((im) => im.status === "running") || project?.layers?.status === "building";
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

  const editable = project.user_id === currentUserId;
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
  };
  const done: Record<Step, boolean> = {
    brief: project.brief.subjects.length > 0,
    master: !!project.master_id,
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
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{CHAR_STATUS_LABEL[project.status]}</span>
          <nav className="ml-4 flex gap-1">
            {STEPS.map((s) => (
              <button
                key={s.id}
                onClick={() => setStep(s.id)}
                className={cx("flex items-center gap-1 rounded-md px-3 py-1.5 text-sm", step === s.id ? "bg-foreground text-background" : "hover:bg-accent")}
              >
                {done[s.id] && <Check className="h-3.5 w-3.5 text-emerald-500" />}
                {s.label}
              </button>
            ))}
          </nav>
          <span className="ml-auto text-xs text-muted-foreground">
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
      <CharAgentBar {...agentKit} />
      <main className="min-h-0 flex-1">
        {step === "brief" && <BriefPanel {...ctx} />}
        {step === "master" && <MasterPanel {...ctx} />}
        {(step === "layers" || step === "product") && <LayersPanel {...ctx} step={step} />}
      </main>
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
