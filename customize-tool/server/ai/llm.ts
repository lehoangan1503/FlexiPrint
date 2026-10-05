/**
 * The prompt writers' LLM: a vision model on fal.ai any-llm, and the small helpers its callers share
 * (server/ai/prompt-writer.ts, server/ai/prompt-review.ts).
 *
 * Env: FAL_KEY, CT_PROMPT_MODEL (default google/gemini-2.5-flash — the OpenAI models on fal's any-llm are
 * refused for this account), CT_REVIEW_MODEL (default google/gemini-2.5-flash).
 */

import { NextResponse } from "next/server";
import { isOwnUploadUrl } from "../library";

export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

export function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

interface FalLlmResponse {
  output?: string;
  error?: string | null;
  detail?: string | Array<{ msg?: string }>;
}

function detailText(d: FalLlmResponse["detail"]): string {
  if (!d) return "";
  return typeof d === "string" ? d : d.map((x) => x.msg ?? "").join("; ");
}

/** The first {...} in an LLM reply (it sometimes wraps JSON in a markdown fence). */
export function jsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const raw: unknown = JSON.parse(text.slice(start, end + 1));
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);

export const promptModel = (): string => process.env.CT_PROMPT_MODEL || "google/gemini-2.5-flash";
/**
 * The prompt review reads everything at once. Flash (no reasoning) answers in ~20 s, helped by the code checks'
 * leads; a "-pro" model runs with reasoning — reads better but on fal often takes 2+ minutes (or times out).
 */
export const reviewModel = (): string => process.env.CT_REVIEW_MODEL || "google/gemini-2.5-flash";

/** One fal any-llm call (vision when images are given) → the reply text, or an error response. */
export async function askLlm(system: string, prompt: string, images: string[], model: string = promptModel(), reasoning = false): Promise<string | NextResponse> {
  const key = process.env.FAL_KEY;
  if (!key) return jsonError("Chưa cấu hình FAL_KEY", 501);
  const endpoint = images.length ? "https://fal.run/fal-ai/any-llm/vision" : "https://fal.run/fal-ai/any-llm";
  const body: Record<string, unknown> = { model, system_prompt: system, prompt };
  // Thinking models (gemini-2.5-pro) refuse reasoning=false.
  if (reasoning) body.reasoning = true;
  if (images.length) body.image_urls = images;
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(150_000),
    });
  } catch (e) {
    return jsonError(`fal.ai không phản hồi: ${e instanceof Error ? e.message : String(e)}`, 502);
  }
  const json = (await res.json().catch(() => ({}))) as FalLlmResponse;
  if (!res.ok) return jsonError(`fal.ai ${res.status}: ${detailText(json.detail) || "lỗi"}`, 502);
  if (json.error) return jsonError(`fal.ai: ${json.error}`, 502);
  return json.output ?? "";
}

/** Saved reference photos (our own uploads) as data urls, for the LLM. */
export async function readSavedRefs(urls: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const u of urls.filter(isOwnUploadUrl)) {
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(20_000) });
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || !type.startsWith("image/")) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length <= MAX_IMAGE_BYTES) out.push(`data:${type};base64,${buf.toString("base64")}`);
    } catch {
      // A photo that can't be read is skipped — the description still goes through.
    }
  }
  return out;
}
