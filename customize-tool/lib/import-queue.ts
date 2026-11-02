/**
 * Import bộ uploads that outlive the page they started on (asked 2026-11-02: an upload stood at "0 / 1031 file" for
 * minutes — each 8 MB request only counted when it ended and had no timeout, so one stuck request froze the page, and
 * nothing else could be done meanwhile).
 *
 * One store for the whole app (a module, so moving between pages inside the app keeps it; a reload or a closed tab
 * does not — the server keeps what came, and picking the same folder again sends only the rest):
 *
 *   - several folders at once: MAX_JOBS upload side by side, the others wait their turn;
 *   - small requests (BATCH_BYTES), sent with XMLHttpRequest so every byte counts in the progress bar;
 *   - a request with no progress for STALL_MS is dropped and sent again, a failed one too (RETRIES, waiting longer each
 *     time); a batch that still fails stops its folder with the reason and a "Thử lại" that goes on from there;
 *   - the server's side (đọc folder → dựng bộ → Shopify nháp) is polled from GET char/projects/imports, and an import
 *     that finishes while the app is open says so (toast + the header's status).
 */

import { useSyncExternalStore } from "react";
import { CT_CONFIG } from "../config";
import type { CtCharImportFile, CtCharImportRow } from "../types";
import { charApi } from "./api-client";

/** One request: about this many bytes, at most this many files (a single bigger file goes alone). */
const BATCH_BYTES = 3 * 1024 * 1024;
const BATCH_FILES = 16;
/** Requests of one folder at once. */
const PARALLEL = 3;
/** Folders uploading at once. */
const MAX_JOBS = 2;
/** No byte sent (or no answer after the last byte) for this long = the request is stuck. */
const STALL_MS = 45_000;
const ANSWER_MS = 120_000;
const RETRIES = 6;
/** Poll while something runs on the server; slower when nothing does. */
const POLL_BUSY_MS = 4000;
const POLL_IDLE_MS = 60_000;
/** A build with no sign of life for this long was cut off (as import-panel.tsx). */
const STALE_MS = 3 * 60 * 1000;

const JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX)(\/|$)|(^|\/)\._/i;
const KEEP = /\.(png|jpe?g|webp|json|csv|md|txt|ttf|otf)$/i;

export interface CtPickedFile {
  file: File;
  /** Path inside the folder (without the folder's own name). */
  path: string;
}

export type CtImportJobPhase = "queued" | "uploading" | "starting" | "failed";

/** A folder being sent from this tab. */
export interface CtImportJob {
  key: string;
  name: string;
  /** The set it goes to ("" until made). */
  projectId: string;
  /** Files still to send. */
  files: CtPickedFile[];
  /** Files picked from the folder / left out (cut copies, system files). */
  total: number;
  skipped: number;
  totalBytes: number;
  /** Sent and stored. */
  doneFiles: number;
  doneBytes: number;
  /** Bytes of requests on the way (not stored yet). */
  liveBytes: number;
  /** Bytes per second, smoothed. */
  speed: number;
  phase: CtImportJobPhase;
  error: string;
  /** A short line about the line: "mạng chậm — gửi lại lần 2…". */
  note: string;
  /** Found on the server already (a cut-off upload picked again). */
  resumed: number;
}

export interface CtImportToast {
  id: number;
  kind: "success" | "error" | "info";
  title: string;
  body: string;
  href: string;
}

interface State {
  jobs: CtImportJob[];
  /** The user's imports on the server (null = not asked yet). */
  rows: CtCharImportRow[] | null;
  toasts: CtImportToast[];
  /** Imports that finished while the app was open and were not looked at yet (the header keeps a mark). */
  fresh: string[];
}

let state: State = { jobs: [], rows: null, toasts: [], fresh: [] };
const listeners = new Set<() => void>();

function set(patch: Partial<State>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function patchJob(key: string, patch: Partial<CtImportJob> | ((j: CtImportJob) => Partial<CtImportJob>)): void {
  set({ jobs: state.jobs.map((j) => (j.key === key ? { ...j, ...(typeof patch === "function" ? patch(j) : patch) } : j)) });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useImports(): State {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

// ---------------------------------------------------------------- what an import is doing

export type CtImportStage = "uploading" | "interrupted" | "reading" | "agent" | "building" | "stale" | "deploying" | "done" | "deploy-failed" | "failed";

/** The stage of a server row, in words a person reads. */
export function importStage(row: CtCharImportRow, uploadingHere: boolean): CtImportStage {
  const imp = row.imported;
  if (imp.status === "uploading") return uploadingHere ? "uploading" : "interrupted";
  if (imp.status === "analyzing") return "reading";
  if (imp.status === "agent") return "agent";
  if (imp.status === "building") return !imp.beat || Date.now() - Date.parse(imp.beat) > STALE_MS ? "stale" : "building";
  if (imp.status === "failed") return "failed";
  if (imp.shopify?.status === "deploying") return "deploying";
  if (imp.shopify?.status === "failed") return "deploy-failed";
  return "done";
}

export const STAGE_TEXT: Record<CtImportStage, string> = {
  uploading: "Đang tải lên",
  interrupted: "Tải lên bị ngắt — chọn lại đúng folder để tải tiếp",
  reading: "Đang đọc folder",
  agent: "@flexiprint đang phân tích folder (định dạng lạ)",
  building: "Đang dựng bộ + sản phẩm",
  stale: "Lần dựng bị ngắt (app khởi động lại) — mở bộ, bấm Dựng lại",
  deploying: "Đang đưa lên Shopify (nháp)",
  done: "Xong — đã lên Shopify nháp",
  "deploy-failed": "Đã dựng xong, chưa lên được Shopify",
  failed: "Import lỗi",
};

/** Still working on the server (polled; the header spins). */
export const RUNNING: ReadonlySet<CtImportStage> = new Set<CtImportStage>(["reading", "agent", "building", "deploying"]);

// ---------------------------------------------------------------- picking

/**
 * What is sent: every image / note / font of the folder. A Teeinblue hand-off (folders with teeinblue.json) brings its
 * layers there whole-canvas, so its other copies (cut clipart, print files per case) stay home — only those folders,
 * the files at the top (mockups, the sample, the sales text) and the notes go.
 */
export function selectFiles(all: CtPickedFile[]): CtPickedFile[] {
  const files = all.filter((f) => !JUNK.test(f.path) && KEEP.test(f.path));
  const cases = files.filter((f) => /(^|\/)teeinblue\.json$/i.test(f.path)).map((f) => f.path.split("/").slice(0, -1).join("/"));
  if (!cases.length) return files;
  return files.filter((f) => !f.path.includes("/") || /\.(json|csv|md|txt)$/i.test(f.path) || cases.some((d) => f.path.startsWith(`${d}/`)));
}

/** An <input webkitdirectory> pick → its folder name and files. */
export function pickedFromInput(list: FileList): { name: string; files: CtPickedFile[] } {
  const files = [...list].map((file) => {
    const rel = file.webkitRelativePath || file.name;
    return { file, path: rel.split("/").slice(1).join("/") || file.name };
  });
  return { name: (list[0]?.webkitRelativePath || "").split("/")[0] || "Bộ import", files };
}

/** Folders dropped on the page (each its own import); loose files dropped are ignored. */
export async function pickedFromDrop(items: DataTransferItemList): Promise<Array<{ name: string; files: CtPickedFile[] }>> {
  const dirs: FileSystemDirectoryEntry[] = [];
  for (const it of [...items]) {
    const e = it.kind === "file" ? it.webkitGetAsEntry() : null;
    if (e?.isDirectory) dirs.push(e as FileSystemDirectoryEntry);
  }
  const readAll = async (dir: FileSystemDirectoryEntry, prefix: string, out: CtPickedFile[]): Promise<void> => {
    const reader = dir.createReader();
    // readEntries gives at most ~100 a call: called until empty.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((ok, no) => reader.readEntries(ok, no));
      if (!batch.length) break;
      for (const e of batch) {
        const path = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory) await readAll(e as FileSystemDirectoryEntry, path, out);
        else out.push({ file: await new Promise<File>((ok, no) => (e as FileSystemFileEntry).file(ok, no)), path });
      }
    }
  };
  const out: Array<{ name: string; files: CtPickedFile[] }> = [];
  for (const d of dirs) {
    const files: CtPickedFile[] = [];
    await readAll(d, "", files);
    out.push({ name: d.name, files });
  }
  return out;
}

// ---------------------------------------------------------------- uploading

let seq = 0;
/** In-flight requests per job (cancel aborts them). */
const inflight = new Map<string, Set<XMLHttpRequest>>();
/** What each job got back so far (the list import/start takes). */
const uploaded = new Map<string, CtCharImportFile[]>();
const cancelled = new Set<string>();

/**
 * A folder into the queue. `resumeId` = a set whose upload was cut off: only files not on the server yet are sent.
 * Returns a line for the page when nothing can be sent.
 */
export function enqueueImport(name: string, all: CtPickedFile[], resumeId = ""): string {
  const files = selectFiles(all);
  if (!files.length) return `“${name}”: folder không có ảnh / ghi chú nào để import`;
  const key = `j${++seq}`;
  set({
    jobs: [
      ...state.jobs,
      {
        key,
        name,
        projectId: resumeId,
        files,
        total: files.length,
        skipped: all.length - files.length,
        totalBytes: files.reduce((n, f) => n + f.file.size, 0),
        doneFiles: 0,
        doneBytes: 0,
        liveBytes: 0,
        speed: 0,
        phase: "queued",
        error: "",
        note: "",
        resumed: 0,
      },
    ],
  });
  uploaded.set(key, []);
  pump();
  return "";
}

function pump(): void {
  const active = state.jobs.filter((j) => j.phase === "uploading" || j.phase === "starting").length;
  for (const j of state.jobs.filter((x) => x.phase === "queued").slice(0, Math.max(0, MAX_JOBS - active))) {
    patchJob(j.key, { phase: "uploading", error: "", note: "" });
    void runJob(j.key);
  }
}

const jobOf = (key: string) => state.jobs.find((j) => j.key === key);

async function runJob(key: string): Promise<void> {
  try {
    let job = jobOf(key);
    if (!job) return;
    if (!job.projectId) {
      const project = await charApi.createImport(job.name);
      patchJob(key, { projectId: project.id });
      void refreshImports();
    } else if (!uploaded.get(key)?.length) {
      // A cut-off upload picked again: what the server has already is not sent again.
      const have = await charApi.importUploaded(job.projectId);
      const byPath = new Map(have.map((f) => [f.path, f]));
      const got = job.files.flatMap((f) => {
        const h = byPath.get(f.path);
        return h && h.size === f.file.size ? [h] : [];
      });
      if (got.length) {
        const sent = new Set(got.map((f) => f.path));
        uploaded.set(key, [...(uploaded.get(key) ?? []).filter((f) => !sent.has(f.path)), ...got]);
        patchJob(key, (j) => ({
          files: j.files.filter((f) => !sent.has(f.path)),
          resumed: got.length,
          doneFiles: got.length,
          doneBytes: got.reduce((n, f) => n + f.size, 0),
        }));
      }
    }
    job = jobOf(key);
    if (!job || cancelled.has(key)) return;
    const projectId = job.projectId;

    // Batches by size; a few requests at once.
    const batches: CtPickedFile[][] = [];
    let cur: CtPickedFile[] = [];
    let size = 0;
    for (const f of job.files) {
      if (cur.length && (cur.length >= BATCH_FILES || size + f.file.size > BATCH_BYTES)) {
        batches.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(f);
      size += f.file.size;
    }
    if (cur.length) batches.push(cur);

    const live = new Map<number, number>();
    const speed = { at: Date.now(), bytes: 0, value: 0 };
    const showLive = () => {
      const now = Date.now();
      const j = jobOf(key);
      if (!j) return;
      const total = j.doneBytes + [...live.values()].reduce((n, x) => n + x, 0);
      if (now - speed.at >= 1000) {
        const v = ((total - speed.bytes) * 1000) / (now - speed.at);
        speed.value = speed.value ? speed.value * 0.6 + v * 0.4 : v;
        speed.at = now;
        speed.bytes = total;
      }
      patchJob(key, { liveBytes: total - j.doneBytes, speed: Math.max(0, speed.value) });
    };
    speed.bytes = job.doneBytes;

    let next = 0;
    let failure: Error | null = null;
    const worker = async () => {
      for (let i = next++; i < batches.length && !failure && !cancelled.has(key); i = next++) {
        const b = batches[i];
        const bytes = b.reduce((n, f) => n + f.file.size, 0);
        let got: CtCharImportFile[] | null = null;
        for (let attempt = 0; !got; attempt++) {
          try {
            got = await sendBatch(key, projectId, b, (sent) => {
              live.set(i, Math.min(sent, bytes));
              showLive();
            });
          } catch (e) {
            live.delete(i);
            if (cancelled.has(key)) return;
            const msg = e instanceof Error ? e.message : String(e);
            // The server said no (not a dropped line): sending again does not help.
            if (attempt >= RETRIES || /^HTTP 4\d\d|^4\d\d /.test(msg)) {
              failure = new Error(`${msg} (${b.length} file, ví dụ ${b[0].path})`);
              return;
            }
            patchJob(key, { note: `Mạng chập chờn (${msg}) — gửi lại lần ${attempt + 1}/${RETRIES}…` });
            await new Promise((ok) => setTimeout(ok, Math.min(30_000, 2000 * 2 ** attempt)));
          }
        }
        live.delete(i);
        const sent = new Set(b.map((f) => f.path));
        uploaded.set(key, [...(uploaded.get(key) ?? []), ...got]);
        patchJob(key, (j) => ({ files: j.files.filter((f) => !sent.has(f.path)), doneFiles: j.doneFiles + b.length, doneBytes: j.doneBytes + bytes, note: "" }));
        showLive();
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    if (cancelled.has(key)) return;
    if (failure) throw failure;

    patchJob(key, { phase: "starting", liveBytes: 0, note: "" });
    await charApi.importStart(projectId, uploaded.get(key) ?? []);
    // From here the server's row tells the story.
    watchStarted.add(projectId);
    await refreshImports();
    set({ jobs: state.jobs.filter((j) => j.key !== key) });
    uploaded.delete(key);
    toast({ kind: "info", title: `Đã tải xong “${job.name}”`, body: "Server đang đọc folder và dựng bộ — sẽ báo khi xong.", href: `/v2/${projectId}` });
  } catch (e) {
    if (!cancelled.has(key)) patchJob(key, { phase: "failed", error: e instanceof Error ? e.message : "Tải lên thất bại", liveBytes: 0, note: "" });
  } finally {
    inflight.delete(key);
    pump();
  }
}

/** One request with byte progress; dropped when it stalls. */
function sendBatch(key: string, projectId: string, files: CtPickedFile[], progress: (sent: number) => void): Promise<CtCharImportFile[]> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const f of files) {
      form.append("file", f.file, f.file.name);
      form.append("path", f.path);
    }
    const xhr = new XMLHttpRequest();
    const mine = inflight.get(key) ?? new Set<XMLHttpRequest>();
    inflight.set(key, mine);
    mine.add(xhr);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let why = "";
    const arm = (ms: number, reason: string) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        why = reason;
        xhr.abort();
      }, ms);
    };
    const end = () => {
      clearTimeout(timer);
      mine.delete(xhr);
    };
    xhr.open("POST", `${CT_CONFIG.apiBase}/char/projects/${projectId}/import/files`);
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      progress(e.loaded);
      arm(STALL_MS, `không gửi được byte nào trong ${STALL_MS / 1000} s`);
    };
    xhr.upload.onload = () => arm(ANSWER_MS, `server không trả lời sau ${ANSWER_MS / 1000} s`);
    xhr.onload = () => {
      end();
      const body = xhr.response as { files?: CtCharImportFile[]; error?: string } | null;
      if (xhr.status >= 200 && xhr.status < 300 && body?.files) resolve(body.files);
      else reject(new Error(`HTTP ${xhr.status}${body?.error ? ` ${body.error}` : ""}`));
    };
    xhr.onerror = () => {
      end();
      reject(new Error("mất kết nối"));
    };
    xhr.onabort = () => {
      end();
      reject(new Error(why || "đã huỷ"));
    };
    arm(STALL_MS, `không gửi được byte nào trong ${STALL_MS / 1000} s`);
    xhr.send(form);
  });
}

/** A stopped folder goes on from where it stopped (the files it still has to send). */
export function retryImport(key: string): void {
  patchJob(key, { phase: "queued", error: "", note: "" });
  pump();
}

/** Stops a folder here (the set stays on the server — the page offers to delete it). */
export function cancelImport(key: string): void {
  cancelled.add(key);
  for (const x of inflight.get(key) ?? []) x.abort();
  inflight.delete(key);
  uploaded.delete(key);
  set({ jobs: state.jobs.filter((j) => j.key !== key) });
  pump();
}

export const uploadingHere = (projectId: string) => state.jobs.some((j) => j.projectId === projectId);

// ---------------------------------------------------------------- the server side

/** Sets started from this tab: a toast when they end even if their row was first seen already running. */
const watchStarted = new Set<string>();
const lastStage = new Map<string, CtImportStage>();

export async function refreshImports(): Promise<void> {
  let rows: CtCharImportRow[];
  try {
    rows = await charApi.listImports();
  } catch {
    return;
  }
  const fresh = [...state.fresh];
  for (const r of rows) {
    const stage = importStage(r, uploadingHere(r.id));
    const before = lastStage.get(r.id);
    lastStage.set(r.id, stage);
    const wasRunning = (before && (RUNNING.has(before) || before === "uploading")) || (watchStarted.has(r.id) && before === undefined);
    if (!wasRunning || RUNNING.has(stage) || stage === "uploading") continue;
    watchStarted.delete(r.id);
    if (!fresh.includes(r.id)) fresh.push(r.id);
    const href = `/v2/${r.id}`;
    if (stage === "done") toast({ kind: "success", title: `Import xong “${r.name}”`, body: "Bộ + sản phẩm đã dựng và lên Shopify (nháp). Mở để kiểm tra.", href });
    else if (stage === "deploy-failed") toast({ kind: "error", title: `“${r.name}” dựng xong, Shopify lỗi`, body: r.imported.shopify?.error || "Mở bộ để đưa lên Shopify lại.", href });
    else if (stage === "failed") toast({ kind: "error", title: `Import lỗi “${r.name}”`, body: r.imported.error || "Mở bộ để xem.", href });
    else if (stage === "stale") toast({ kind: "error", title: `“${r.name}” bị ngắt khi đang dựng`, body: "Mở bộ, bấm Dựng lại.", href });
  }
  set({ rows, fresh });
}

/** Header / import page saw the finished ones. */
export function markSeen(): void {
  if (state.fresh.length) set({ fresh: [] });
}

let toastSeq = 0;
export function toast(t: Omit<CtImportToast, "id">): void {
  const id = ++toastSeq;
  set({ toasts: [...state.toasts, { ...t, id }] });
  setTimeout(() => dismissToast(id), t.kind === "error" ? 20_000 : 10_000);
}

export function dismissToast(id: number): void {
  if (state.toasts.some((t) => t.id === id)) set({ toasts: state.toasts.filter((t) => t.id !== id) });
}

let polling = false;
/** Started once by the app-wide watcher: polls while anything runs. */
export function startImportPolling(): void {
  if (polling || typeof window === "undefined") return;
  polling = true;
  const tick = async () => {
    await refreshImports();
    const busy = state.jobs.length > 0 || (state.rows ?? []).some((r) => RUNNING.has(importStage(r, uploadingHere(r.id))));
    setTimeout(() => void tick(), busy ? POLL_BUSY_MS : POLL_IDLE_MS);
  };
  void tick();
  window.addEventListener("beforeunload", (e) => {
    // A reload / closed tab ends the upload (the server keeps what came).
    if (state.jobs.some((j) => j.phase === "uploading" || j.phase === "queued")) e.preventDefault();
  });
}

/** Header summary: folders uploading here + imports running on the server, one percentage over the uploads. */
export function importSummary(s: State): { running: number; percent: number | null; failed: number } {
  const rows = s.rows ?? [];
  const server = rows.filter((r) => !uploadingHere(r.id) && RUNNING.has(importStage(r, false))).length;
  const up = s.jobs.filter((j) => j.phase !== "failed");
  const all = up.reduce((n, j) => n + j.totalBytes, 0);
  const done = up.reduce((n, j) => n + j.doneBytes + j.liveBytes, 0);
  return { running: up.length + server, percent: up.length && all ? Math.round((done / all) * 100) : null, failed: s.jobs.filter((j) => j.phase === "failed").length };
}
