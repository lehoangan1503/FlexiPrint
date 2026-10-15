/**
 * Run an AI photo style (a ct_ai_styles row) on the team's image model — GPT Image 2.5 on the company API
 * (server/pack-images.ts drawImage, quality high; asked 2026-10-15: no fal, no fallback model). The prompt comes
 * from the stored row only — the caller supplies the customer's photo, never a prompt or a model.
 *
 * Env: CPA_API_KEY (CPA_BASE_URL).
 */

import type { CtAiStyle } from "../../types";
import { CT_IMAGE_MODEL } from "../../lib/image-models";
import { normalizeAiStyleParams } from "../../lib/ai-style-models";
import { drawImage } from "../pack-images";
import { readImageInfo } from "../image-size";
import type { ProviderImage } from "./providers";

const WHITE_BG = " Show only the subject, whole and centred, on a perfectly flat, solid pure white (#FFFFFF) background: no scenery, no shadow, no frame, no text.";
const CLEAR_BG = " Show only the subject, whole and centred, on a fully transparent background: no scenery, no shadow, no frame, no text.";

export function aiStylesConfigured(): boolean {
  return Boolean(process.env.CPA_API_KEY);
}

/** drawCpa refuses a picture asked transparent that came back with a painted backdrop (its own message). */
export function isNotTransparentError(e: unknown): boolean {
  return e instanceof Error && /nền trong suốt/.test(e.message);
}

/** The style on `image`: transparent (a cut-out, refused when the model paints a backdrop) or on flat white. */
export async function runStyleModel(style: CtAiStyle, image: ProviderImage, transparent: boolean): Promise<ProviderImage> {
  const p = normalizeAiStyleParams(style.params);
  const info = readImageInfo(image.data);
  const aspect = p.aspect === "auto" && info ? `${info.width}:${info.height}` : "1:1";
  // The browser already shrinks photos to ~1600 px: a data URI is fine as the reference (Node's fetch reads data: URLs).
  const uri = `data:${image.mime};base64,${image.data.toString("base64")}`;
  const out = await drawImage(CT_IMAGE_MODEL, style.prompt.trim() + (transparent ? CLEAR_BG : WHITE_BG), [uri], aspect, "pad", transparent);
  return { data: out.data, mime: out.mime };
}
