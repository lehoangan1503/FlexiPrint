/**
 * fal.ai image-edit models an AI photo style can use. Pure data, shared by the
 * editor (model picker, price hints) and the server (server/ai/fal-style.ts
 * builds each model's input).
 *
 * Prices are fal's list prices per output image, checked 2026-09-29. Every
 * customer preview is one call.
 * Default = fal-ai/nano-banana/edit (Gemini 2.5 Flash Image): the model the
 * competitor store runs, and with the same prompt it matches their look (Nano
 * Banana 2 draws heavier ink, a red nose, flatter colour). Google lists
 * 2026-10-02 as the EARLIEST Gemini-API shutdown (Vertex: 2027-03-15), so
 * server/ai/fal-style.ts falls back to Nano Banana 2 whenever it fails.
 */

import type { CtAiStyleModelId, CtAiStyleParams } from "../types";

export interface CtAiStyleModel {
  id: CtAiStyleModelId;
  label: string;
  /** Short price / speed hint for the picker. */
  price: string;
  /** Which params the model understands (the dialog hides the rest). */
  uses: Array<keyof Pick<CtAiStyleParams, "resolution" | "quality" | "aspect">>;
  /**
   * Can return a real transparent background. When the style wants the subject
   * cut out, such a model is asked for alpha and the bg-remover pass is skipped
   * (faster, and nothing is lost to a second model).
   */
  transparent?: boolean;
}

export const CT_AI_STYLE_MODELS: CtAiStyleModel[] = [
  { id: "fal-ai/nano-banana/edit", label: "Nano Banana (Gemini 2.5 Flash Image)", price: "$0.039 — ~5–10 s, giống store; lỗi thì tự chuyển Nano Banana 2", uses: ["aspect"] },
  { id: "fal-ai/nano-banana-2/edit", label: "Nano Banana 2 (Gemini 3.1 Flash Image)", price: "$0.06 · 0.5K / $0.08 · 1K / $0.12 · 2K — ~5–15 s", uses: ["resolution", "aspect"] },
  { id: "fal-ai/bytedance/seedream/v4.5/edit", label: "Seedream 4.5", price: "$0.04 — painterly, always 2048² square", uses: [] },
  { id: "fal-ai/flux-pro/kontext", label: "FLUX.1 Kontext pro", price: "$0.04 — ~5–10 s", uses: ["aspect"] },
  { id: "fal-ai/qwen-image-edit-2511", label: "Qwen Image Edit 2511", price: "$0.03 / MP", uses: ["aspect"] },
  { id: "fal-ai/gpt-image-1.5/edit", label: "GPT Image 1.5", price: "$0.009 low / $0.034 medium / $0.13 high — slow (20–60 s), nền trong suốt sẵn", uses: ["quality", "aspect"], transparent: true },
];

export const CT_AI_STYLE_DEFAULT_MODEL: CtAiStyleModelId = "fal-ai/nano-banana/edit";

export const CT_AI_STYLE_DEFAULT_PARAMS: CtAiStyleParams = {
  resolution: "1K",
  quality: "medium",
  aspect: "1:1",
  whiteBackground: true,
  removeBackground: true,
  outputFormat: "png",
};

const BY_ID = new Map(CT_AI_STYLE_MODELS.map((m) => [m.id, m]));

export function isAiStyleModel(id: string): id is CtAiStyleModelId {
  return BY_ID.has(id as CtAiStyleModelId);
}

export function aiStyleModel(id: CtAiStyleModelId): CtAiStyleModel {
  return BY_ID.get(id) ?? CT_AI_STYLE_MODELS[0];
}

/** Fill missing / invalid params (rows written by older code, hand-edited JSON). */
export function normalizeAiStyleParams(raw: Partial<CtAiStyleParams> | null | undefined): CtAiStyleParams {
  const p = { ...CT_AI_STYLE_DEFAULT_PARAMS, ...(raw ?? {}) };
  return {
    resolution: p.resolution === "0.5K" || p.resolution === "2K" ? p.resolution : "1K",
    quality: p.quality === "low" || p.quality === "high" ? p.quality : "medium",
    aspect: p.aspect === "auto" ? "auto" : "1:1",
    whiteBackground: p.whiteBackground !== false,
    removeBackground: p.removeBackground !== false,
    outputFormat: p.outputFormat === "jpeg" ? "jpeg" : "png",
  };
}
