/**
 * Run an AI photo style (a ct_ai_styles row) on fal.ai. Every input field is
 * built here from the stored record — the caller only supplies the customer's
 * photo, so a client can't pick a pricier model, raise the quality or swap the
 * prompt.
 *
 * Env: FAL_KEY.
 */

import type { CtAiStyle, CtAiStyleModelId } from "../../types";
import { aiStyleModel, normalizeAiStyleParams } from "../../lib/ai-style-models";
import type { ProviderImage } from "./providers";

const WHITE_BG = " Place the subject on a perfectly flat, solid pure white (#FFFFFF) background: no scenery, no shadow, no frame, no text.";
const CLEAR_BG = " Show only the subject on a fully transparent background: no scenery, no shadow, no frame, no text.";

export interface FalStyleOptions {
  /** Ask a model that supports it (lib/ai-style-models `transparent`) for a transparent background. */
  transparent?: boolean;
}

interface FalImage {
  url?: string;
  content_type?: string;
}

interface FalResponse {
  images?: FalImage[];
  image?: FalImage;
  detail?: string | Array<{ msg?: string }>;
}

export function falConfigured(): boolean {
  return Boolean(process.env.FAL_KEY);
}

function falInput(style: CtAiStyle, imageUri: string, transparent: boolean): Record<string, unknown> {
  const p = normalizeAiStyleParams(style.params);
  const prompt = style.prompt.trim() + (transparent ? CLEAR_BG : p.whiteBackground ? WHITE_BG : "");
  const square = p.aspect === "1:1";
  switch (style.model) {
    case "fal-ai/nano-banana/edit":
      return { prompt, image_urls: [imageUri], num_images: 1, aspect_ratio: square ? "1:1" : "auto", output_format: p.outputFormat };
    case "fal-ai/nano-banana-2/edit":
      return { prompt, image_urls: [imageUri], num_images: 1, resolution: p.resolution, aspect_ratio: square ? "1:1" : "auto", output_format: p.outputFormat };
    case "fal-ai/bytedance/seedream/v4.5/edit":
      // Its default output is already a 2048² square (min side 1920), so size is left to the model.
      return { prompt, image_urls: [imageUri], num_images: 1 };
    case "fal-ai/flux-pro/kontext":
      return { prompt, image_url: imageUri, num_images: 1, output_format: p.outputFormat === "png" ? "png" : "jpeg", ...(square ? { aspect_ratio: "1:1" } : {}) };
    case "fal-ai/qwen-image-edit-2511":
      return { prompt, image_urls: [imageUri], num_images: 1, output_format: p.outputFormat, ...(square ? { image_size: "square_hd" } : {}) };
    case "fal-ai/gpt-image-1.5/edit":
      return {
        prompt,
        image_urls: [imageUri],
        num_images: 1,
        quality: p.quality,
        image_size: square ? "1024x1024" : "auto",
        // Alpha needs PNG.
        ...(transparent ? { background: "transparent", output_format: "png" } : { output_format: p.outputFormat }),
      };
  }
}

function falError(json: FalResponse, status: number): string {
  const d = json.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((x) => x.msg ?? "").filter(Boolean).join("; ") || `HTTP ${status}`;
  return `HTTP ${status}`;
}

/** Gemini 2.5 Flash Image may be retired any day from 2026-10-02: its successor keeps customers going. */
const FALLBACK_MODEL: Partial<Record<CtAiStyleModelId, CtAiStyleModelId>> = {
  "fal-ai/nano-banana/edit": "fal-ai/nano-banana-2/edit",
};

export async function runFalStyle(style: CtAiStyle, image: ProviderImage, opts: FalStyleOptions = {}): Promise<ProviderImage> {
  const fallback = FALLBACK_MODEL[style.model];
  if (!fallback) return runFalModel(style, image, opts);
  return runFalModel(style, image, opts).catch((e: unknown) => {
    console.warn(`[ct] ${style.model} failed (${e instanceof Error ? e.message : String(e)}) — retrying with ${fallback}`);
    return runFalModel({ ...style, model: fallback }, image, opts);
  });
}

async function runFalModel(style: CtAiStyle, image: ProviderImage, opts: FalStyleOptions): Promise<ProviderImage> {
  const key = process.env.FAL_KEY;
  if (!key) throw new Error("Chưa cấu hình FAL_KEY");
  // The browser already shrinks photos to ~1600 px, so a data URI stays small enough for fal.
  const uri = `data:${image.mime};base64,${image.data.toString("base64")}`;
  const res = await fetch(`https://fal.run/${style.model}`, {
    method: "POST",
    headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(falInput(style, uri, Boolean(opts.transparent) && Boolean(aiStyleModel(style.model).transparent))),
    signal: AbortSignal.timeout(150_000),
  });
  const json: FalResponse = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`fal.ai ${res.status}: ${falError(json, res.status).slice(0, 300)}`);
  const out = json.images?.[0] ?? json.image;
  if (!out?.url) throw new Error("fal.ai không trả ảnh");
  if (out.url.startsWith("data:")) {
    const [head, b64] = out.url.split(",", 2);
    return { data: Buffer.from(b64 ?? "", "base64"), mime: head.slice(5).split(";")[0] || "image/png" };
  }
  const file = await fetch(out.url, { signal: AbortSignal.timeout(60_000) });
  if (!file.ok) throw new Error(`fal.ai output ${file.status}`);
  return { data: Buffer.from(await file.arrayBuffer()), mime: file.headers.get("content-type")?.split(";")[0] ?? out.content_type ?? "image/png" };
}
