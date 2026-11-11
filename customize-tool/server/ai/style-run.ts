/**
 * Run an AI photo style (a ct_ai_styles row) on the team's image model — GPT Image 2.5 on the company API
 * (server/pack-images.ts drawImage, quality high; asked 2026-10-15: no fal, no fallback model). The prompt comes
 * from the stored row only — the caller supplies the customer's photo, never a prompt or a model. The row's style
 * reference pictures (params.refUrls) follow the photo as images 2, 3… (asked 2026-10-28, like the team's studio page).
 *
 * Env: CPA_API_KEY (CPA_BASE_URL).
 */

import type { CtAiStyle } from "../../types";
import { CT_IMAGE_MODEL } from "../../lib/image-models";
import { CT_AI_STYLE_CLEAR_BG_LINE, aiStyleAspectLine, aiStyleNameLine, normalizeAiStyleParams } from "../../lib/ai-style-models";
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

/**
 * What the prompt says about the background:
 *   clear  transparent output (a cut-out, refused when the model paints a backdrop) — with the "Remove background"
 *          tick on, the user's own line (CT_AI_STYLE_CLEAR_BG_LINE) ends the prompt
 *   white  flat white, for the bg-remover to lift the subject out
 *   none   the prompt as written (tick off, zone cut-out off)
 */
export type StyleBackground = "clear" | "white" | "none";

/** `name`: the customer's typed name, added as "Name: …" at the very end when the style asks for it (params.askName). */
export async function runStyleModel(style: CtAiStyle, image: ProviderImage, bg: StyleBackground, name?: string): Promise<ProviderImage> {
  const p = normalizeAiStyleParams(style.params);
  const info = readImageInfo(image.data);
  // A fixed ratio is said in the prompt (the image API picks its canvas from the prompt, not from `size`) and the
  // answer padded to it exactly (drawCpa fit "pad"), so the picture fits the artwork / print area it was made for.
  const aspect = p.aspect === "auto" ? (info ? `${info.width}:${info.height}` : "1:1") : p.aspect;
  // The browser already shrinks photos to ~1600 px: a data URI is fine as the reference (Node's fetch reads data: URLs).
  const uri = `data:${image.mime};base64,${image.data.toString("base64")}`;
  // Style reference pictures go after the photo (image 2, 3…); a prompt that does not number them gets the order said.
  const refs = p.refUrls;
  const numbered = /\bimage\s*1\b/i.test(style.prompt);
  const head = refs.length && !numbered ? `Image 1 is the customer's photo; image${refs.length > 1 ? `s 2–${refs.length + 1} are` : " 2 is"} the style reference. ` : "";
  const body = style.prompt.trim();
  const tail =
    bg === "white" ? WHITE_BG
    : bg === "none" ? ""
    : !p.removeBackground ? CLEAR_BG
    : body.includes(CT_AI_STYLE_CLEAR_BG_LINE) ? ""
    : `\n\n${CT_AI_STYLE_CLEAR_BG_LINE}`;
  const shape = aiStyleAspectLine(p.aspect);
  const who = p.askName ? aiStyleNameLine(name) : "";
  const prompt = [head + body + tail, shape, who].filter(Boolean).join("\n\n");
  const out = await drawImage(CT_IMAGE_MODEL, prompt, [uri, ...refs], aspect, "pad", bg === "clear");
  return { data: out.data, mime: out.mime };
}
