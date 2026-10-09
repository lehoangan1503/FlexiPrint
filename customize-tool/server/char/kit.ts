/**
 * services/layer-kit client. Its work takes minutes (registration, matting, upscale) — longer than fetch waits
 * for headers — so every step is a job: start it, ask until it is done, fetch the pictures it wrote, forget it.
 *
 * Env: CT_LAYER_KIT_URL (default http://127.0.0.1:7005), CT_LAYER_KIT_TOKEN.
 */

const kitUrl = () => (process.env.CT_LAYER_KIT_URL || "http://127.0.0.1:7005").replace(/\/+$/, "");

export const kitHeaders = (): Record<string, string> => ({
  "Content-Type": "application/json",
  ...(process.env.CT_LAYER_KIT_TOKEN ? { Authorization: `Bearer ${process.env.CT_LAYER_KIT_TOKEN}` } : {}),
});

export async function kitPost<T>(path: string, body: unknown, timeoutMs = 120_000): Promise<T> {
  const res = await fetch(`${kitUrl()}${path}`, { method: "POST", headers: kitHeaders(), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`layer-kit ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

interface KitJobState<T> {
  status: "running" | "done" | "failed";
  result?: T;
  error?: string;
}

/** Start a job and wait for its result (≤ 60 min: a plan of 40+ pictures is slow). The job stays on layer-kit (its files) until kitForget. */
export async function kitJob<T>(path: "/matte" | "/plan" | "/cut", body: unknown): Promise<{ job: string; result: T }> {
  const { job } = await kitPost<{ job: string }>(path, body, 60_000);
  const until = Date.now() + 60 * 60_000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 4_000));
    const st = await fetch(`${kitUrl()}/jobs/${job}`, { headers: kitHeaders(), signal: AbortSignal.timeout(120_000) }).catch(() => null);
    if (!st) continue;
    if (!st.ok) throw new Error(`layer-kit ${st.status}: ${(await st.text()).slice(0, 300)}`);
    const j = (await st.json()) as KitJobState<T>;
    if (j.status === "done" && j.result) return { job, result: j.result };
    if (j.status === "failed") throw new Error(`layer-kit: ${j.error ?? "lỗi"}`);
  }
  throw new Error("layer-kit: quá 60 phút");
}

/** A picture / mask a job wrote. */
export async function kitFile(job: string, name: string): Promise<Buffer> {
  const res = await fetch(`${kitUrl()}/jobs/${job}/files/${encodeURIComponent(name)}`, { headers: kitHeaders(), signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`layer-kit ${res.status}: không lấy được ${name}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function kitForget(job: string): Promise<void> {
  await fetch(`${kitUrl()}/jobs/${job}`, { method: "DELETE", headers: kitHeaders(), signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
}
