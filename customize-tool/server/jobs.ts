/**
 * "Nhận ngay, chạy nền, hỏi lại" for any POST: a request sent with `?async=1` that is not done after FAST_MS gets a
 * 202 CtJobPending at once and keeps running here; GET jobs/:id (public/jobs/:id for the storefront) answers 202 again
 * while it runs, then the POST's own response (status, headers, body) as it would have come. No request stays open
 * long — Cloudflare Tunnel cuts one silent for 100 s, nginx at 120 s, and an AI picture can take minutes.
 *
 * Jobs live in this process's memory (one app container): a restart loses the running ones (the poll gets 404 and the
 * client shows the error). A finished one is kept KEEP_MS for the poll that fetches it.
 */

import { NextResponse } from "next/server";
import { CT_CONFIG } from "../config";
import type { CtJobPending } from "../types";

const FAST_MS = 20_000;
const KEEP_MS = 15 * 60_000;

interface StoredResponse {
  status: number;
  headers: Array<[string, string]>;
  body: ArrayBuffer;
}

interface Job {
  isPublic: boolean;
  done: StoredResponse | null;
  /** Dropped after this (set when it finishes). */
  expires: number;
}

const jobs = new Map<string, Job>();

function sweep(): void {
  const now = Date.now();
  for (const [id, job] of jobs) if (job.done && job.expires < now) jobs.delete(id);
}

async function store(res: NextResponse): Promise<StoredResponse> {
  return { status: res.status, headers: [...res.headers.entries()], body: await res.arrayBuffer() };
}

function failed(e: unknown): StoredResponse {
  const body = new TextEncoder().encode(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  return { status: 500, headers: [["content-type", "application/json"]], body: body.buffer };
}

function pending(id: string, isPublic: boolean, headers: Record<string, string>): NextResponse {
  const body: CtJobPending = { ctJob: id, poll: `${CT_CONFIG.apiBase}/${isPublic ? "public/" : ""}jobs/${id}` };
  return NextResponse.json(body, { status: 202, headers });
}

/** Run `work`: its response when it is quick, else a job to poll. `headers` go on the 202s (CORS for public ones). */
export async function asJob(work: () => Promise<NextResponse>, isPublic: boolean, headers: Record<string, string> = {}): Promise<NextResponse> {
  sweep();
  const running = work();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), FAST_MS);
  });
  const first = await Promise.race([running, slow]).finally(() => clearTimeout(timer));
  if (first) return first;
  const id = crypto.randomUUID();
  const job: Job = { isPublic, done: null, expires: Infinity };
  jobs.set(id, job);
  void running
    .then(store, (e: unknown) => failed(e))
    .then((done) => {
      job.done = done;
      job.expires = Date.now() + KEEP_MS;
    });
  return pending(id, isPublic, headers);
}

/** GET jobs/:id — 202 while it runs, then the stored response; 404 when unknown (expired, or the server restarted). */
export function pollJob(id: string, isPublic: boolean, headers: Record<string, string> = {}): NextResponse {
  sweep();
  const job = jobs.get(id);
  if (!job || job.isPublic !== isPublic) {
    return NextResponse.json({ error: "Việc này không còn trên server (đã khởi động lại?) — chạy lại" }, { status: 404, headers });
  }
  if (!job.done) return pending(id, isPublic, headers);
  const out = new Headers(job.done.headers);
  for (const [k, v] of Object.entries(headers)) out.set(k, v);
  return new NextResponse(job.done.body, { status: job.done.status, headers: out });
}
