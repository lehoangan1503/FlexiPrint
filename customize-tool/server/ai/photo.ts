/**
 * Customer-photo processing: AI styles (ct_ai_styles rows on fal.ai), face
 * crops, and subject cut-out. Browser-side styles ("pixel") and the final trim happen in
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
 * AI styles ("ai:<id>", server/ai/fal-style.ts): the stored prompt + model run
 * on fal.ai on the ORIGINAL photo, then the result is cut out — the same order
 * as a redraw needs. A model that can output alpha (GPT Image) is asked for a
 * transparent background instead, and when its result really is see-through
 * the bg-remover pass is skipped. Results and cut-outs are cached by
 * (photo hash, style id, style updated_at) in server/photo-cache.ts — memory +
 * Storage for 24 h — so re-asking never re-bills.
 *
 * Env: CT_BG_REMOVER_URL, CT_BG_REMOVER_TOKEN, CT_FACE_DETECT_URL, CT_FACE_DETECT_TOKEN, FAL_KEY, CT_CUTOUT_MODEL (BiRefNet variant, default "General Use (Heavy)"),
 *      CT_PHOTO_AI_PROVIDER (gemini|openai), CT_PHOTO_AI_MODEL — plus the
 *      provider keys from providers.ts.
 */

import type { CtAiProviderId, CtAiStyle, CtAspectRatio, CtPhotoCapabilities, CtPhotoStyleRef } from "../../types";
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

/** A microservice answered with an error status. */
class ServiceHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function subjectFraming(transparent: boolean): string {
  const backdrop = transparent
    ? "Use a fully transparent background."
    : "Place it on a perfectly flat, solid pure white (#FFFFFF) background: no gradient, no shadow, no floor, no paint splashes behind it.";
  return `Show ONLY the main subject, whole and centred, filling about 85% of the frame, with every other part of the photo removed. ${backdrop}`;
}

/** The cut-out fallback without a matting model: the image model lifts the subject out, unchanged. */
function cutoutPrompt(transparent: boolean): string {
  return [
    "Isolate the main subject (the pet or person) from this photo.",
    "Reproduce the subject EXACTLY as photographed — same pixels, colours, lighting and detail. Do not restyle, retouch, beautify or redraw it.",
    subjectFraming(transparent),
  ].join("\n");
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
    throw new ServiceHttpError(`${name} ${res.status}: ${message}`, res.status);
  }
  return { data: Buffer.from(await res.arrayBuffer()), mime: res.headers.get("content-type")?.split(";")[0] ?? "image/png" };
}

const serviceUrl = (base: string, path: string) => `${base.replace(/\/$/, "")}${path}`;

/**
 * Face styles: services/face-detect cuts the head out of `image` (the cut-out,
 * so the outline follows the subject's own edge — ears and fur whole), turned
 * upright, down to the chin — no neck, no body, no background. Gemini on
 * fal.ai names the species and locates the eyes and chin in `photo` (the
 * opaque original; fractions, so a resized cut-out still matches): OpenCV's
 * cat cascade misses most pets, and YuNet (people) fires on pets too. A person
 * keeps YuNet's own landmarks and is cut by face parsing (hair kept, neck and
 * clothes dropped). The cascade's head is the last resort (no FAL_KEY / no
 * answer). The original photo goes along: the head is cut from ITS pixels at
 * full resolution, under the cut-out's alpha (matting may return a smaller
 * image). Cached by input hash like the cut-out.
 */
function faceCrop(): ((image: ProviderImage, photo: ProviderImage) => Promise<ProviderImage>) | null {
  const base = process.env.CT_FACE_DETECT_URL;
  if (!base) return null;
  const url = serviceUrl(base, "/crop");
  const token = process.env.CT_FACE_DETECT_TOKEN;
  const post = async (image: ProviderImage, photo: ProviderImage, fields: Record<string, string>) => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(image.data)], { type: image.mime }), "photo");
    form.append("photo", new Blob([new Uint8Array(photo.data)], { type: photo.mime }), "original");
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form, signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      throw new ServiceDownError(`face-detect không phản hồi (${url}) — service chưa chạy? (${e instanceof Error ? e.message : String(e)})`);
    }
    if (res.status === 422) return null;
    if (!res.ok) throw new ServiceHttpError(`face-detect ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`, res.status);
    return { image: { data: Buffer.from(await res.arrayBuffer()), mime: "image/png" }, kind: res.headers.get("x-face-kind") };
  };
  return (image, photo) =>
    // Bump with services/face-detect HEAD changes: a result cut by an older service must not come back.
    cachedPhoto(photoCacheKey(image.data, "face", 11), async () => {
      const found = await post(image, photo, {});
      const located = await llmLocateFace(photo);
      // YuNet's landmarks beat the LLM's on a person — but it also fires on cats and dogs, and a pet cut with
      // human proportions comes back with its chest. The LLM names the species.
      if (found?.kind === "face" && (!located || located.kind === "face")) return found.image;
      if (located) {
        const again = await post(image, photo, located);
        if (again) return again.image;
      }
      if (found) return found.image;
      throw new PhotoConfigError("No face found in the photo — try a clear, front-facing photo.");
    });
}

/**
 * Face box, eyes and chin from Gemini (fal any-llm), as the face-detect /crop
 * fields (0–1 fractions), or null (no FAL_KEY / no face).
 */
async function llmLocateFace(image: ProviderImage): Promise<CtLocatedFace | null> {
  // One retry: the model now and then answers {"box": null} for a face it finds on the next call.
  return (await llmLocateOnce(image)) ?? llmLocateOnce(image);
}

/** The face-detect /crop form fields for a face the LLM located. */
interface CtLocatedFace extends Record<string, string> {
  box: string;
  eyes: string;
  chin: string;
  /** cat | dog | face (a person) | given (anything else): picks the head proportions. */
  kind: string;
}

async function llmLocateOnce(image: ProviderImage): Promise<CtLocatedFace | null> {
  const key = process.env.FAL_KEY;
  if (!key) return null;
  const res = await fetch("https://fal.run/fal-ai/any-llm/vision", {
    method: "POST",
    headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.CT_PROMPT_MODEL || "google/gemini-2.5-flash",
      system_prompt:
        "You locate the main subject's face (person or animal) in a photo. Coordinates are [y, x] on a 0–1000 scale. " +
        'Reply with JSON only: {"species": "cat" | "dog" | "person" | "other", "box": [ymin, xmin, ymax, xmax], "left_eye": [y, x], "right_eye": [y, x], "chin": [y, x]} — ' +
        "box = eyes, nose, mouth, cheeks (not ears or hair); chin = the lowest point of the chin / lower jaw. " +
        "Use exactly these keys, numbers only. " +
        'Or {"box": null} if there is no face.',
      prompt: "Locate the main subject's face, both eye centres and the chin.",
      image_urls: [`data:${image.mime};base64,${image.data.toString("base64")}`],
    }),
    signal: AbortSignal.timeout(60_000),
  }).catch(() => null);
  if (!res?.ok) return null;
  const json: { output?: string } = await res.json().catch(() => ({}));
  const text = json.output ?? "";
  // Read each field on its own: Gemini now and then answers malformed JSON
  // ({"box": [...], "label": "face"}, "left_eye": ...) or its native "box_2d" key.
  const field = (key: string): number[] | null => {
    const m = new RegExp(`"${key}(?:_2d)?"\\s*:\\s*\\[([^\\]]*)\\]`).exec(text);
    if (!m) return null;
    const v = m[1].split(",").map((x) => Number(x.trim()));
    return v.every(Number.isFinite) ? v : null;
  };
  const species = /"species"\s*:\s*"(\w+)"/.exec(text)?.[1]?.toLowerCase();
  const raw = { box: field("box"), left_eye: field("left_eye"), right_eye: field("right_eye"), chin: field("chin") };
  const nums = (v: number[] | null, n: number): number[] | null =>
    v && v.length === n ? v.map((x) => Math.min(1000, Math.max(0, x)) / 1000) : null;
  const box = nums(raw.box, 4);
  if (!box) return null;
  const [ymin, xmin, ymax, xmax] = box;
  if (xmax - xmin < 0.02 || ymax - ymin < 0.02) return null;
  // A point [y, x] — or a box [ymin, xmin, ymax, xmax], which the model sometimes gives for an eye: its centre.
  const point = (v: number[] | null): number[] | null => {
    const b = nums(v, 4);
    return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : nums(v, 2);
  };
  const le = point(raw.left_eye);
  const re = point(raw.right_eye);
  const chin = point(raw.chin);
  const f = (v: number) => v.toFixed(4);
  return {
    box: [xmin, ymin, xmax - xmin, ymax - ymin].map(f).join(","),
    eyes: le && re ? [le[1], le[0], re[1], re[0]].map(f).join(",") : "",
    chin: chin && le && re ? [chin[1], chin[0]].map(f).join(",") : "",
    kind: species === "cat" || species === "dog" ? species : species === "person" ? "face" : "given",
  };
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
  return { ai, cutout: matting() !== null || ai, aiStyles: falConfigured(), faceDetect: faceCrop() !== null };
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
 *   free / face     cut out first; the browser applies its filter after
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
  if (def.family === "face") {
    // Cut out the whole photo first (shared cache with "Real photo"), then the service keeps only the head;
    // the browser applies the colour filter.
    const crop = faceCrop();
    if (!crop) throw new PhotoConfigError("Chưa cấu hình CT_FACE_DETECT_URL (services/face-detect)");
    // Always on the cut-out when there is a matting model: the head comes back on transparency, whatever `cutout` says.
    const cut = matte ? await matte(job.image) : job.image;
    return { image: await crop(cut, job.image), backdrop: null };
  }
  const ai = aiProvider();
  let image = job.image;
  let backdrop: PhotoResult["backdrop"] = null;
  if (job.cutout && matte) {
    image = await matte(image);
  } else if (job.cutout) {
    // No matting model: have the image model lift the subject out.
    if (!ai) throw new PhotoConfigError("Chưa cấu hình CT_BG_REMOVER_URL / FAL_KEY (hoặc AI provider) để tách nền");
    const transparent = ai.model.supportsTransparent;
    const [out] = await ai.provider.generate({
      model: ai.model.id,
      prompt: cutoutPrompt(transparent),
      references: [image],
      aspectRatio: aspectOf(image),
      count: 1,
      transparent,
    });
    image = out;
    // A white backdrop survives the filters as near-white, so the browser can still key it.
    backdrop = transparent ? null : "white";
  }

  return { image, backdrop };
}
