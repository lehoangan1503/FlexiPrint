"use client";

/**
 * /v2/import — the Import bộ page (asked 2026-11-02): drop or pick one folder or many, watch each go through its steps
 * (tải lên → đọc folder → dựng bộ → Shopify nháp), see why one stopped and go on from there. The uploads run in
 * lib/import-queue.ts, so leaving this page for another one of the app keeps them going (the header shows them).
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, CheckCircle2, ExternalLink, FileArchive, FolderUp, Loader2, MessageSquare, RefreshCw, Trash2, Upload, X } from "lucide-react";
import type { CtCharImportRow } from "../../types";
import { charApi, ctApi } from "../../lib/api-client";
import {
  RUNNING,
  STAGE_TEXT,
  cancelImport,
  enqueueImport,
  enqueueZip,
  importStage,
  markSeen,
  pickedFromDrop,
  pickedFromInput,
  refreshImports,
  retryImport,
  uploadingHere,
  useImports,
  type CtImportJob,
  type CtImportStage,
  type CtPickedFile,
} from "../../lib/import-queue";
import { CtButton } from "../ui";
import { ctConfirm } from "../dialogs";

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
const STEPS = ["Tải lên", "Đọc folder", "Dựng bộ + sản phẩm", "Shopify nháp"];

/** Zip files (several at once). */
function ZipInput({ onPick, inputRef }: { onPick: (files: File[]) => void; inputRef: (el: HTMLInputElement | null) => void }) {
  return (
    <input
      type="file"
      multiple
      accept=".zip,application/zip"
      className="hidden"
      ref={inputRef}
      onChange={(e) => {
        if (e.target.files?.length) onPick([...e.target.files]);
        e.target.value = "";
      }}
    />
  );
}

/** A folder input (React has no typed prop for webkitdirectory). */
function FolderInput({ onPick, inputRef }: { onPick: (name: string, files: CtPickedFile[]) => void; inputRef: (el: HTMLInputElement | null) => void }) {
  return (
    <input
      type="file"
      multiple
      className="hidden"
      ref={(el) => {
        inputRef(el);
        el?.setAttribute("webkitdirectory", "");
      }}
      onChange={(e) => {
        if (e.target.files?.length) {
          const p = pickedFromInput(e.target.files);
          onPick(p.name, p.files);
        }
        e.target.value = "";
      }}
    />
  );
}

export function ImportPage() {
  const s = useImports();
  const [error, setError] = useState("");
  const [drag, setDrag] = useState(false);
  const picker = useRef<HTMLInputElement | null>(null);
  const resumeInput = useRef<HTMLInputElement | null>(null);
  const zipPicker = useRef<HTMLInputElement | null>(null);
  const resumeZipInput = useRef<HTMLInputElement | null>(null);
  const [resumeRow, setResumeRow] = useState<CtCharImportRow | null>(null);

  useEffect(() => {
    void refreshImports();
  }, []);
  // Looking at this page = the finished ones were seen.
  useEffect(() => {
    if (s.fresh.length) markSeen();
  }, [s.fresh.length]);

  const add = (name: string, files: CtPickedFile[], resumeId = "") => {
    const msg = enqueueImport(name, files, resumeId);
    setError(msg);
  };

  const addZips = (files: File[], resumeId = "") => {
    const msgs = files.map((f) => enqueueZip(f, resumeId)).filter(Boolean);
    setError(msgs.join("\n"));
  };

  const resume = async (name: string, files: CtPickedFile[]) => {
    const row = resumeRow;
    setResumeRow(null);
    if (!row) return;
    if (name !== row.name && !(await ctConfirm({ title: "Folder khác tên", message: `Bộ đang dở là “${row.name}”, folder vừa chọn là “${name}”. Vẫn tải tiếp vào bộ này?`, confirmLabel: "Tải tiếp" }))) return;
    add(row.name, files, row.id);
  };

  const resumeZip = async (files: File[]) => {
    const row = resumeRow;
    setResumeRow(null);
    const zip = files[0];
    if (!row || !zip) return;
    const name = zip.name.replace(/\.zip$/i, "");
    if (name !== row.name && !(await ctConfirm({ title: "File zip khác tên", message: `Bộ đang dở là “${row.name}”, file vừa chọn là “${zip.name}”. Vẫn tải tiếp vào bộ này?`, confirmLabel: "Tải tiếp" }))) return;
    addZips([zip], row.id);
  };

  const remove = async (row: CtCharImportRow) => {
    if (!(await ctConfirm({ title: `Xoá “${row.name}”?`, message: "Xoá bộ import này cùng các file đã tải lên.", confirmLabel: "Xoá", tone: "danger" }))) return;
    try {
      await charApi.remove(row.id);
      await refreshImports();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Xoá thất bại");
    }
  };

  const cancel = async (job: CtImportJob) => {
    if (!(await ctConfirm({ title: `Dừng tải “${job.name}”?`, message: job.projectId ? "Phần đã tải vẫn giữ trên server — chọn lại folder để tải tiếp, hoặc xoá bộ ở danh sách bên dưới." : "Folder chưa gửi gì lên.", confirmLabel: "Dừng" }))) return;
    cancelImport(job.key);
    void refreshImports();
  };

  const rows = (s.rows ?? []).filter((r) => !s.jobs.some((j) => j.projectId === r.id));

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b bg-card/80 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4 sm:px-6">
          <Link href="/dashboard?tab=library" className="rounded p-1.5 hover:bg-accent" aria-label="Về thư viện">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <FolderUp className="h-5 w-5 text-sky-500" />
          <h1 className="text-lg font-semibold">Import bộ</h1>
          <CtButton className="ml-auto" onClick={() => zipPicker.current?.click()} title="Một hoặc nhiều file .zip — mỗi file là một bộ, server tự giải nén">
            <FileArchive className="h-4 w-4" /> Chọn file zip
          </CtButton>
          <CtButton variant="primary" onClick={() => picker.current?.click()}>
            <Upload className="h-4 w-4" /> Chọn folder
          </CtButton>
        </div>
      </header>
      <FolderInput inputRef={(el) => (picker.current = el)} onPick={(name, files) => add(name, files)} />
      <FolderInput inputRef={(el) => (resumeInput.current = el)} onPick={(name, files) => void resume(name, files)} />
      <ZipInput inputRef={(el) => (zipPicker.current = el)} onPick={(files) => addZips(files)} />
      <ZipInput inputRef={(el) => (resumeZipInput.current = el)} onPick={(files) => void resumeZip(files)} />

      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            void pickedFromDrop(e.dataTransfer.items).then(({ folders, zips }) => {
              if (!folders.length && !zips.length) setError("Kéo thả cả folder hoặc file .zip (không phải từng file ảnh)");
              for (const f of folders) add(f.name, f.files);
              if (zips.length) addZips(zips);
            });
          }}
          onClick={() => picker.current?.click()}
          className={`cursor-pointer rounded-xl border-2 border-dashed p-6 text-center transition-colors ${drag ? "border-sky-500 bg-sky-500/10" : "hover:border-sky-500/60 hover:bg-accent/40"}`}
        >
          <FolderUp className="mx-auto mb-2 h-8 w-8 text-sky-500" />
          <div className="text-sm font-medium">Kéo thả một hoặc nhiều folder bộ / file .zip vào đây — hoặc bấm để chọn folder (chọn tiếp được trong lúc đang tải)</div>
          <p className="mx-auto mt-1 max-w-2xl text-xs text-muted-foreground">
            Mỗi folder / file zip là một bộ (zip thì server tự giải nén): 2 bộ tải cùng lúc, các bộ khác xếp hàng. Chuyển sang trang khác trong app vẫn tải tiếp (góc header báo tiến độ) — chỉ đừng tải lại / đóng tab. Bị ngắt thì chọn lại đúng folder, chỉ phần còn thiếu được gửi.
          </p>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError("")} aria-label="Đóng">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {s.jobs.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold">Đang tải lên ({s.jobs.length})</h2>
            {s.jobs.map((j) => (
              <JobCard key={j.key} job={j} onCancel={() => void cancel(j)} />
            ))}
          </section>
        )}

        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">Các bộ đã import</h2>
            <button onClick={() => void refreshImports()} className="rounded p-1 text-muted-foreground hover:bg-accent" title="Tải lại trạng thái">
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
          {s.rows === null ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Đang tải…
            </div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Chưa có bộ nào.</p>
          ) : (
            rows.map((r) => (
              <RowCard
                key={r.id}
                row={r}
                onResume={(zip) => {
                  setResumeRow(r);
                  (zip ? resumeZipInput : resumeInput).current?.click();
                }}
                onRemove={() => void remove(r)}
              />
            ))
          )}
        </section>
      </main>
    </div>
  );
}

function Steps({ at, failed, done }: { at: number; failed: boolean; done: boolean }) {
  return (
    <ol className="flex flex-wrap items-center gap-1 text-[11px]">
      {STEPS.map((label, i) => {
        const state = done || i < at ? "done" : i === at ? (failed ? "failed" : "now") : "later";
        return (
          <li key={label} className="flex items-center gap-1">
            {i > 0 && <span className={`h-px w-4 ${state === "later" ? "bg-border" : "bg-sky-500/60"}`} />}
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${
                state === "done" ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" : state === "now" ? "border-sky-500/60 bg-sky-500/10 text-sky-600 dark:text-sky-400" : state === "failed" ? "border-destructive/50 bg-destructive/10 text-destructive" : "text-muted-foreground"
              }`}
            >
              {state === "done" ? <CheckCircle2 className="h-3 w-3" /> : state === "now" ? <Loader2 className="h-3 w-3 animate-spin" /> : state === "failed" ? <AlertTriangle className="h-3 w-3" /> : null}
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Bar({ value, tone = "bg-sky-500" }: { value: number; tone?: string }) {
  return (
    <div className="h-2 overflow-hidden rounded bg-muted">
      <div className={`h-full ${tone} transition-all`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

function eta(left: number, speed: number): string {
  if (speed < 1) return "";
  const sec = Math.round(left / speed);
  return sec < 60 ? `còn ~${sec} s` : `còn ~${Math.round(sec / 60)} phút`;
}

function JobCard({ job, onCancel }: { job: CtImportJob; onCancel: () => void }) {
  const sent = job.doneBytes + job.liveBytes;
  const pct = job.totalBytes ? (sent / job.totalBytes) * 100 : 0;
  const failed = job.phase === "failed";
  return (
    <div className={`space-y-2 rounded-xl border p-4 ${failed ? "border-destructive/40 bg-destructive/5" : "bg-card"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1 truncate text-sm font-semibold">{job.name}</div>
        {failed && (
          <CtButton onClick={() => retryImport(job.key)}>
            <RefreshCw className="h-4 w-4" /> Thử lại (tải tiếp)
          </CtButton>
        )}
        <CtButton onClick={onCancel} title="Dừng tải folder này">
          <X className="h-4 w-4" /> {failed ? "Bỏ" : "Dừng"}
        </CtButton>
      </div>
      {/* Every file sent = the upload is done (a stop after it was telling the server to read the folder). */}
      <Steps at={job.phase === "starting" || job.doneFiles >= job.total ? 1 : 0} failed={failed} done={false} />
      <Bar value={pct} tone={failed ? "bg-destructive" : "bg-sky-500"} />
      <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        <span>
          {job.phase === "queued" ? "Đang chờ lượt (2 bộ tải cùng lúc)" : job.phase === "starting" ? (job.zip ? "Đã tải xong — đang báo server giải nén…" : "Đã tải xong — đang báo server đọc folder…") : failed ? "Đã dừng" : "Đang tải lên"}
        </span>
        <span>
          {job.zip ? "file zip" : `${job.doneFiles} / ${job.total} file`} · {mb(sent)} / {mb(job.totalBytes)} · {Math.floor(pct)}%
        </span>
        {job.phase === "uploading" && job.speed > 0 && (
          <span>
            {mb(job.speed)}/s · {eta(job.totalBytes - sent, job.speed)}
          </span>
        )}
        {job.skipped > 0 && <span>bỏ {job.skipped} file không cần</span>}
        {job.resumed > 0 && <span>{job.resumed} {job.zip ? "mảnh" : "file"} đã có trên server — không gửi lại</span>}
      </div>
      {job.note && <p className="text-xs text-amber-600 dark:text-amber-400">{job.note}</p>}
      {job.error && <p className="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{job.error}</p>}
    </div>
  );
}

const STEP_OF: Record<CtImportStage, number> = { uploading: 0, interrupted: 0, unpacking: 1, reading: 1, agent: 1, "agent-stopped": 1, building: 2, stale: 2, deploying: 3, "deploy-failed": 3, done: 4, failed: 1 };

function RowCard({ row, onResume, onRemove }: { row: CtCharImportRow; onResume: (zip: boolean) => void; onRemove: () => void }) {
  const imp = row.imported;
  const stage = importStage(row, uploadingHere(row.id));
  const bad = stage === "failed" || stage === "stale" || stage === "deploy-failed" || stage === "interrupted" || stage === "agent-stopped";
  const chat = row.agent;
  const at = stage === "failed" && imp.total > 0 ? 2 : STEP_OF[stage];
  const shop = imp.shopify;
  return (
    <div className={`space-y-2 rounded-xl border p-4 ${bad ? "border-amber-500/40 bg-amber-500/5" : "bg-card"}`}>
      <div className="flex flex-wrap items-center gap-2">
        {RUNNING.has(stage) ? <Loader2 className="h-4 w-4 animate-spin text-sky-500" /> : stage === "done" ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <AlertTriangle className={`h-4 w-4 ${stage === "failed" ? "text-destructive" : "text-amber-500"}`} />}
        <Link href={`/v2/${row.id}`} className="min-w-0 flex-1 truncate text-sm font-semibold hover:underline">
          {row.name}
        </Link>
        <span className="text-[11px] text-muted-foreground">{new Date(row.created_at).toLocaleString()}</span>
      </div>
      <Steps at={at} failed={bad} done={stage === "done"} />
      <div className="text-xs">{STAGE_TEXT[stage]}</div>
      {stage === "agent" && chat?.now && <div className="text-xs text-muted-foreground">↳ {chat.now}</div>}
      {(stage === "building" || stage === "unpacking") && imp.total > 0 && (
        <div className="space-y-1">
          <Bar value={(imp.done / imp.total) * 100} />
          <div className="text-xs text-muted-foreground">
            {imp.done} / {imp.total} {stage === "unpacking" ? "file đã giải nén" : "file layer"}
          </div>
        </div>
      )}
      {imp.error && <p className="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{imp.error}</p>}
      {stage === "agent-stopped" && chat?.summary && (
        <details className="rounded-md border bg-background/60 p-2 text-xs">
          <summary className="cursor-pointer select-none font-medium">Lời nhắn của @flexiprint</summary>
          <p className="mt-2 whitespace-pre-wrap text-muted-foreground">{chat.summary}</p>
        </details>
      )}
      {shop?.status === "failed" && shop.error && <p className="whitespace-pre-wrap text-xs text-destructive">{shop.error}</p>}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Link href={`/v2/${row.id}`} className="inline-flex items-center gap-1 rounded-md border bg-background px-3 py-1.5 text-xs hover:bg-accent">
          Mở bộ
        </Link>
        {chat?.url && (
          <a
            href={chat.url}
            target="_blank"
            rel="noreferrer"
            title="Mở phiên chat của @flexiprint trên agent_ide (cửa sổ mới)"
            className="inline-flex items-center gap-1 rounded-md border bg-background px-3 py-1.5 text-xs hover:bg-accent"
          >
            <MessageSquare className="h-3.5 w-3.5" /> Chat @flexiprint
          </a>
        )}
        {shop?.status === "done" && shop.previewUrl && (
          <a href={imp.productId ? ctApi.shopifyOpenUrl(imp.productId) : shop.previewUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90">
            <ExternalLink className="h-3.5 w-3.5" /> Xem thử trên store
          </a>
        )}
        {stage === "interrupted" && (
          <>
            <CtButton onClick={() => onResume(false)} title="Chọn lại đúng folder này — file đã có trên server không gửi lại">
              <Upload className="h-4 w-4" /> Chọn lại folder để tải tiếp
            </CtButton>
            <CtButton onClick={() => onResume(true)} title="Chọn lại đúng file zip này — phần đã có trên server không gửi lại">
              <FileArchive className="h-4 w-4" /> Chọn lại file zip
            </CtButton>
          </>
        )}
        {imp.files > 0 && <span className="text-[11px] text-muted-foreground">{imp.files} file · {mb(imp.bytes)}</span>}
        {!RUNNING.has(stage) && stage !== "done" && (
          <button onClick={onRemove} className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
            <Trash2 className="h-3.5 w-3.5" /> Xoá
          </button>
        )}
      </div>
    </div>
  );
}
