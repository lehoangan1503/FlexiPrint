/**
 * fetch for POSTs that may take minutes (AI pictures, print packs): sent with `?async=1`, so the server answers a slow
 * one with a 202 CtJobPending at once and this asks its `poll` url every POLL_MS until the real response comes
 * (server/jobs.ts). No request stays open long enough for a proxy (Cloudflare 100 s, nginx 120 s) to cut it.
 * Other methods go straight to fetch.
 */

import type { CtJobPending } from "../types";

const POLL_MS = 3_000;

function isPending(body: unknown): body is CtJobPending {
  return typeof body === "object" && body !== null && typeof (body as CtJobPending).ctJob === "string" && typeof (body as CtJobPending).poll === "string";
}

function wait(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });
}

/** The pending job a 202 announces, or null (a 202 that is the route's own answer). */
async function pendingOf(res: Response): Promise<CtJobPending | null> {
  if (res.status !== 202) return null;
  const body: unknown = await res.clone().json().catch(() => null);
  return isPending(body) ? body : null;
}

export async function jobFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if ((init.method ?? "GET").toUpperCase() !== "POST") return fetch(url, init);
  const target = new URL(url, globalThis.location?.href);
  target.searchParams.set("async", "1");
  let res = await fetch(target, init);
  let job = await pendingOf(res);
  while (job) {
    await wait(POLL_MS, init.signal);
    res = await fetch(new URL(job.poll, target), { mode: init.mode, credentials: init.credentials, signal: init.signal });
    job = await pendingOf(res);
  }
  return res;
}
