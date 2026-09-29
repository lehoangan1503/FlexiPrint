/**
 * Customer-photo processing: AI styles (ct_ai_styles rows on fal.ai), the free
 * "oil" filter, and subject cut-out. Browser-side styles ("pixel") and the final trim happen in
 * lib/photo-process.ts; this file only does what needs a model.
 *
 * Cut-out, best first:
 *   CT_BG_REMOVER_URL  our own microservice (services/bg-remover: rembg +
 *                 BiRefNet). A segmentation model, so the photo's own pixels
 *                 survive (fur, hair) and it works on any backdrop. Free per call.
 *   FAL_KEY       the same BiRefNet, hosted by fal.ai (paid per call).
 *   otherwise     the image model redraws the subject on a flat backdrop:
 *                 OpenAI returns real alpha; Gemini returns pure white that
 *                 the browser keys out (backdrop: "white"). Good for painted
 *                 styles, but a "Real photo" gets subtly regenerated.
 *
 * Painted styles, best first:
 *   CT_PHOTO_STYLE_URL  services/photo-style — OpenCV filters, ~1 s, free, no AI
 *   otherwise           the AI image model repaints the photo (better art, costs per call)
 *
 * AI styles ("ai:<id>", server/ai/fal-style.ts): the stored prompt + model run
 * on fal.ai on the ORIGINAL photo, then the result is cut out — the same order
 * as a redraw needs. A model that can output alpha (GPT Image) is asked for a
 * transparent background instead, and when its result really is see-through
 * the bg-remover pass is skipped. Results and cut-outs are cached by
 * (photo hash, style id, style updated_at) in server/photo-cache.ts — memory +
 * Storage for 24 h — so re-asking never re-bills.
 *
 * Env: CT_PHOTO_STYLE_URL, CT_PHOTO_STYLE_TOKEN, CT_BG_REMOVER_URL, CT_BG_REMOVER_TOKEN, FAL_KEY, CT_CUTOUT_MODEL (BiRefNet variant, default "General Use (Heavy)"),
 *      CT_PHOTO_AI_PROVIDER (gemini|openai), CT_PHOTO_AI_MODEL — plus the
 *      provider keys from providers.ts.
 */

import type { CtAiProviderId, CtAiStyle, CtAspectRatio, CtPhotoCapabilities, CtPhotoStyleId, CtPhotoStyleRef } from "../../types";
import { isAiStyleRef, photoStyle } from "../../lib/photo-styles";
import { aiStyleModel, normalizeAiStyleParams } from "../../lib/ai-style-models";
import { cachedPhoto, peekPhotoCache, photoCacheKey } from "../photo-cache";
import { pngHasTransparency } from "../png-alpha";
import { falConfigured, runFalStyle } from "./fal-style";
import { readImageInfo } from "../image-size";
import { getProvider, type ProviderImage } from "./providers";

export interface PhotoJob {
  image: ProviderImage;
  style: CtPhotoStyleRef;
  cutout: boolean;
  /** The ct_ai_styles row, resolved by the caller when `style` is "ai:<id>". */
  aiStyle?: CtAiStyle;
}

export interface PhotoResult {
  image: ProviderImage;
  /** Flat backdrop the browser still has to key out; null = done (alpha already, or no cut-out asked). */
  backdrop: "white" | null;
}

export class PhotoConfigError extends Error {}

/** A microservice (services/*) could not be reached at all. */
class ServiceDownError extends Error {}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const KEEP_IDENTITY =
  "The reference is a customer's photo. Keep the subject unmistakably recognisable: same species/breed, face shape, eye colour, markings, fur or hair pattern, expression and pose. Do not add accessories, text, logos or extra subjects.";

const STYLE_PROMPTS: Record<Exclude<CtPhotoStyleId, "original" | "pixel">, string> = {
  oil: "Repaint it as a classical oil painting portrait: rich visible brush strokes, painterly texture, warm natural lighting, museum-quality fine art.",
};

function subjectFraming(cutout: boolean, transparent: boolean): string {
  if (!cutout) return "Keep the original composition and framing.";
  const backdrop = transparent
    ? "Use a fully transparent background."
    : "Place it on a perfectly flat, solid pure white (#FFFFFF) background: no gradient, no shadow, no floor, no paint splashes behind it.";
  return `Show ONLY the main subject, whole and centred, filling about 85% of the frame, with every other part of the photo removed. ${backdrop}`;
}

function stylePrompt(style: CtPhotoStyleId, cutout: boolean, transparent: boolean): string {
  const framing = subjectFraming(cutout, transparent);
  if (style === "original" || style === "pixel") {
    return [
      "Isolate the main subject (the pet or person) from this photo.",
      "Reproduce the subject EXACTLY as photographed — same pixels, colours, lighting and detail. Do not restyle, retouch, beautify or redraw it.",
      framing,
    ].join("\n");
  }
  return [KEEP_IDENTITY, STYLE_PROMPTS[style], framing, "High resolution, crisp edges, no watermark, no signature, no border."].join("\n");
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

function aspectOf(image: ProviderImage): CtAspectRatio {
  const info = readImageInfo(image.data);
  if (!info) return "1:1";
  const r = info.width / Math.max(1, info.height);
  const options: Array<[CtAspectRatio, number]> = [
    ["1:1", 1],
    ["3:4", 3 / 4],
    ["4:3", 4 / 3],
    ["9:16", 9 / 16],
    ["16:9", 16 / 9],
  ];
  return options.reduce((best, cur) => (Math.abs(Math.log(cur[1] / r)) < Math.abs(Math.log(best[1] / r)) ? cur : best))[0];
}

function aiProvider() {
  const wanted = process.env.CT_PHOTO_AI_PROVIDER as CtAiProviderId | undefined;
  const order: CtAiProviderId[] = wanted ? [wanted] : ["gemini", "openai"];
  for (const id of order) {
    const p = getProvider(id);
    if (p?.configured()) {
      const models = p.models();
      const model = models.find((m) => m.id === process.env.CT_PHOTO_AI_MODEL) ?? models[0];
      if (model) return { provider: p, model };
    }
  }
  return null;
}

/** POST an image to one of our microservices (services/*); they share the multipart + Bearer contract. */
async function callService(
  name: string,
  url: string,
  token: string | undefined,
  image: ProviderImage,
  fields: Record<string, string> = {},
): Promise<ProviderImage> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(image.data)], { type: image.mime }), "photo");
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    // Node reports a refused connection as a bare "fetch failed"; say which service is down.
    throw new ServiceDownError(`${name} không phản hồi (${url}) — service chưa chạy? (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = text.slice(0, 300);
    try {
      const j: { detail?: string; error?: string } = JSON.parse(text);
      message = j.detail ?? j.error ?? message;
    } catch {
      // plain-text error body
    }
    throw new Error(`${name} ${res.status}: ${message}`);
  }
  return { data: Buffer.from(await res.arrayBuffer()), mime: res.headers.get("content-type")?.split(";")[0] ?? "image/png" };
}

const serviceUrl = (base: string, path: string) => `${base.replace(/\/$/, "")}${path}`;

/** Painted styles without AI: services/photo-style (OpenCV). Keeps a cut-out's alpha. */
function styleService(): ((image: ProviderImage, style: CtPhotoStyleId) => Promise<ProviderImage>) | null {
  const url = process.env.CT_PHOTO_STYLE_URL;
  if (!url) return null;
  return (image, style) => callService("photo-style", serviceUrl(url, "/stylize"), process.env.CT_PHOTO_STYLE_TOKEN, image, { style });
}

async function falCutout(image: ProviderImage, key: string): Promise<ProviderImage> {
  const res = await fetch("https://fal.run/fal-ai/birefnet/v2", {
    method: "POST",
    headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      image_url: `data:${image.mime};base64,${image.data.toString("base64")}`,
      model: process.env.CT_CUTOUT_MODEL || "General Use (Heavy)",
      operating_resolution: "1024x1024",
      output_format: "png",
      refine_foreground: true,
    }),
  });
  if (!res.ok) throw new Error(`fal.ai ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  const json: { image?: { url?: string } } = await res.json();
  const url = json.image?.url;
  if (!url) throw new Error("fal.ai không trả ảnh");
  const out = await fetch(url);
  if (!out.ok) throw new Error(`fal.ai output ${out.status}`);
  return { data: Buffer.from(await out.arrayBuffer()), mime: "image/png" };
}

/**
 * A real matting model (keeps the photo's pixels), or null when only the AI
 * fallback is left. Cut-outs are cached by input hash (server/photo-cache.ts):
 * a customer flipping through styles sends the same photo each time; matting
 * takes ~15 s on CPU, the filters ~1 s, so the second style only pays for the filter.
 */
function matting(): ((image: ProviderImage) => Promise<ProviderImage>) | null {
  const url = process.env.CT_BG_REMOVER_URL;
  const fal = process.env.FAL_KEY;
  const viaFal = fal ? (image: ProviderImage) => cachedPhoto(photoCacheKey(image.data, "cutout", "fal", process.env.CT_CUTOUT_MODEL || ""), () => falCutout(image, fal)) : null;
  if (url) {
    return (image) =>
      cachedPhoto(photoCacheKey(image.data, "cutout", "bg-remover"), () =>
        callService("bg-remover", serviceUrl(url, "/remove"), process.env.CT_BG_REMOVER_TOKEN, image),
      ).catch((e: unknown) => {
        // Our service is down: the same BiRefNet on fal keeps customers going (paid per call).
        if (e instanceof ServiceDownError && viaFal) {
          console.warn(`[ct] ${e.message} — falling back to fal.ai BiRefNet`);
          return viaFal(image);
        }
        throw e;
      });
  }
  return viaFal;
}

// ---------------------------------------------------------------------------

export function photoCapabilities(): CtPhotoCapabilities {
  const ai = aiProvider() !== null;
  return { ai, styleService: styleService() !== null, cutout: matting() !== null || ai, aiStyles: falConfigured() };
}

/** AI results by (photo, style version, cut-out) — see server/photo-cache.ts. */
function aiCacheKey(job: PhotoJob, style: CtAiStyle): string {
  return photoCacheKey(job.image.data, "ai", style.id, style.updated_at, job.cutout ? 1 : 0);
}

/**
 * This exact job's finished result, if it was rendered before (memory or
 * Storage) — it costs nothing, so the caller serves it without touching the caps.
 */
export async function cachedAiResult(job: PhotoJob): Promise<PhotoResult | null> {
  if (!job.aiStyle || !isAiStyleRef(job.style)) return null;
  const image = await peekPhotoCache(aiCacheKey(job, job.aiStyle));
  return image ? { image, backdrop: null } : null;
}

async function runAiStyle(job: PhotoJob, style: CtAiStyle): Promise<PhotoResult> {
  const params = normalizeAiStyleParams(style.params);
  const wantCut = job.cutout || params.removeBackground;
  const transparent = wantCut && Boolean(aiStyleModel(style.model).transparent);
  let image = await runFalStyle(style, job.image, { transparent });
  let backdrop: PhotoResult["backdrop"] = null;
  // The model already removed the background: no second model pass.
  const alreadyCut = image.mime === "image/png" && pngHasTransparency(image.data);
  if (wantCut && !alreadyCut) {
    const matte = matting();
    if (matte) image = await matte(image);
    else if (params.whiteBackground) backdrop = "white"; // the browser keys out the flat white
  }
  return { image, backdrop };
}

/**
 * Order matters:
 *   service style   cut out first, then filter — the filter keeps the alpha,
 *                   and never paints the backdrop it would throw away
 *   AI style        restyle first on a flat backdrop, then matte (the model
 *                   redraws everything anyway)
 */
export async function processPhoto(job: PhotoJob): Promise<PhotoResult> {
  if (isAiStyleRef(job.style)) {
    const style = job.aiStyle;
    if (!style) throw new PhotoConfigError("Style AI không tồn tại");
    // Only finished results are cached. Without a matting model the browser still has to key out
    // a white backdrop, so that result is recomputed (AI styles need FAL_KEY, which also mattes,
    // so in practice this branch never runs).
    if (!matting()) return runAiStyle(job, style);
    const image = await cachedPhoto(aiCacheKey(job, style), async () => (await runAiStyle(job, style)).image);
    return { image, backdrop: null };
  }
  const def = photoStyle(job.style);
  const matte = matting();
  const stylize = styleService();
  const ai = aiProvider();
  let image = job.image;
  let backdrop: PhotoResult["backdrop"] = null;
  const aiStyled = def.engine === "server" && !stylize;

  if (aiStyled) {
    if (!ai) throw new PhotoConfigError("Chưa cấu hình CT_PHOTO_STYLE_URL hoặc AI provider cho style ảnh");
    // With a matting model on hand, the AI only needs a clean white backdrop to hand over.
    const transparent = job.cutout && !matte && ai.model.supportsTransparent;
    const [out] = await ai.provider.generate({
      model: ai.model.id,
      prompt: stylePrompt(job.style, job.cutout, transparent),
      references: [image],
      aspectRatio: aspectOf(image),
      count: 1,
      transparent,
    });
    image = out;
    if (job.cutout && !matte && !transparent) backdrop = "white";
    if (job.cutout && matte) image = await matte(image);
    return { image, backdrop };
  }

  if (job.cutout && matte) {
    image = await matte(image);
  } else if (job.cutout) {
    // No matting model: have the image model lift the subject out.
    if (!ai) throw new PhotoConfigError("Chưa cấu hình CT_BG_REMOVER_URL / FAL_KEY (hoặc AI provider) để tách nền");
    const transparent = ai.model.supportsTransparent;
    const [out] = await ai.provider.generate({
      model: ai.model.id,
      prompt: stylePrompt("original", true, transparent),
      references: [image],
      aspectRatio: aspectOf(image),
      count: 1,
      transparent,
    });
    image = out;
    // A white backdrop survives the filters as near-white, so the browser can still key it.
    backdrop = transparent ? null : "white";
  }

  if (def.engine === "server" && stylize) image = await stylize(image, job.style);
  return { image, backdrop };
}
