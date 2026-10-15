/**
 * AI photo styles run on ONE model: the team's GPT Image 2.5 on the company image API (lib/image-models
 * CT_IMAGE_MODEL — asked 2026-10-12, and for customer photos 2026-10-15: no fal, no Nano Banana, no picker, no
 * fallback). Pure data, shared by the editor and the server (server/ai/photo.ts runAiStyle).
 */

import type { CtAiStyleModelId, CtAiStyleParams } from "../types";
import { CT_IMAGE_MODEL } from "./image-models";

export const CT_AI_STYLE_MODEL: CtAiStyleModelId = CT_IMAGE_MODEL;

export const CT_AI_STYLE_DEFAULT_PARAMS: CtAiStyleParams = {
  aspect: "1:1",
  removeBackground: true,
  demoUrl: "",
  demoSourceUrl: "",
};

/** Fill missing / invalid params (rows written by older code — fal-era resolution / quality / format are dropped). */
export function normalizeAiStyleParams(raw: Partial<CtAiStyleParams> | null | undefined): CtAiStyleParams {
  const p = { ...CT_AI_STYLE_DEFAULT_PARAMS, ...(raw ?? {}) };
  const url = (v: unknown) => (typeof v === "string" && /^https?:\/\//.test(v) ? v : "");
  return {
    aspect: p.aspect === "auto" ? "auto" : "1:1",
    removeBackground: p.removeBackground !== false,
    demoUrl: url(p.demoUrl),
    demoSourceUrl: url(p.demoSourceUrl),
  };
}
