/**
 * AI photo styles run on ONE model: the team's GPT Image 2.5 on the company image API (lib/image-models
 * CT_IMAGE_MODEL — asked 2026-10-12, and for customer photos 2026-10-15: no fal, no Nano Banana, no picker, no
 * fallback). Pure data, shared by the editor and the server (server/ai/photo.ts runAiStyle).
 */

import type { CtAiStyleAspect, CtAiStyleModelId, CtAiStyleParams } from "../types";
import { CT_IMAGE_MODEL } from "./image-models";

export const CT_AI_STYLE_MODEL: CtAiStyleModelId = CT_IMAGE_MODEL;

/** Style reference pictures sent with every customer photo (asked 2026-11-04: up to 4). */
export const CT_AI_STYLE_MAX_REFS = 4;

/** A style's prompt (asked 2026-11-11: the team's studio prompts run ~5 000 characters, 4 000 was too short). */
export const CT_AI_STYLE_PROMPT_MAX = 12000;

/** The customer's name sent with a photo (params.askName). */
export const CT_AI_STYLE_NAME_MAX = 40;

/** Output shapes the editor picks from (asked 2026-11-11: "có cả 3:2, 16:9…"), with how the prompt says it. */
export const CT_AI_STYLE_ASPECTS: ReadonlyArray<{ id: CtAiStyleAspect; label: string }> = [
  { id: "1:1", label: "1:1 vuông" },
  { id: "auto", label: "Theo ảnh khách" },
  { id: "3:2", label: "3:2 ngang" },
  { id: "2:3", label: "2:3 dọc" },
  { id: "4:3", label: "4:3 ngang" },
  { id: "3:4", label: "3:4 dọc" },
  { id: "5:4", label: "5:4 ngang" },
  { id: "4:5", label: "4:5 dọc" },
  { id: "16:9", label: "16:9 ngang" },
  { id: "9:16", label: "9:16 dọc" },
  { id: "2:1", label: "2:1 ngang" },
  { id: "1:2", label: "1:2 dọc" },
  { id: "21:9", label: "21:9 ngang" },
  { id: "3:1", label: "3:1 ngang" },
];

const ASPECT_IDS = new Set<string>(CT_AI_STYLE_ASPECTS.map((a) => a.id));

export function isAiStyleAspect(v: unknown): v is CtAiStyleAspect {
  return typeof v === "string" && ASPECT_IDS.has(v);
}

/**
 * The line that asks the model for a fixed shape (the company image API does not keep the size it is sent — tested
 * 2026-11-11: 2048×1024 asked, 1312×1199 / 1774×887 came back — the model picks the canvas from the prompt).
 * "" for square / the photo's shape.
 */
export function aiStyleAspectLine(aspect: CtAiStyleAspect): string {
  if (aspect === "1:1" || aspect === "auto") return "";
  const [w, h] = aspect.split(":").map(Number);
  return `Output format: a ${w > h ? "landscape" : "portrait"} picture with aspect ratio ${w}:${h} (width:height). Compose for that exact shape and use the whole canvas.`;
}

/** "Name: …" for the end of the prompt (params.askName); "" when the customer left it empty. */
export function aiStyleNameLine(name: string | undefined): string {
  const n = cleanCustomerName(name);
  return n ? `Name: ${n}` : "";
}

/** A typed name made safe for a prompt: one line, no control characters, ≤ CT_AI_STYLE_NAME_MAX. */
export function cleanCustomerName(name: unknown): string {
  return typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, CT_AI_STYLE_NAME_MAX) : "";
}

export const CT_AI_STYLE_DEFAULT_PARAMS: CtAiStyleParams = {
  aspect: "1:1",
  keepFrame: false,
  askName: false,
  removeBackground: true,
  demoUrl: "",
  thumbUrl: "",
  demoSourceUrl: "",
  refUrls: [],
  setId: "",
};

/** Added at the end of the prompt while "Remove background" is ticked (asked 2026-11-10, wording from the user). */
export const CT_AI_STYLE_CLEAR_BG_LINE =
  "Output: the artwork only on a FULLY TRANSPARENT background (real alpha channel, no checkerboard, no shadow, no glow, no frame).";

/** The picture on the style's tile (editor + storefront): the uploaded thumbnail, else the demo ("" = none). */
export function aiStyleTileUrl(p: Pick<CtAiStyleParams, "thumbUrl" | "demoUrl">): string {
  return p.thumbUrl || p.demoUrl;
}

/** Fill missing / invalid params (rows written by older code — fal-era resolution / quality / format are dropped). */
export function normalizeAiStyleParams(raw: Partial<CtAiStyleParams> | null | undefined): CtAiStyleParams {
  const p = { ...CT_AI_STYLE_DEFAULT_PARAMS, ...(raw ?? {}) };
  const url = (v: unknown) => (typeof v === "string" && /^https?:\/\//.test(v) ? v : "");
  return {
    aspect: isAiStyleAspect(p.aspect) ? p.aspect : "1:1",
    keepFrame: p.keepFrame === true,
    askName: p.askName === true,
    removeBackground: p.removeBackground !== false,
    demoUrl: url(p.demoUrl),
    thumbUrl: url(p.thumbUrl),
    demoSourceUrl: url(p.demoSourceUrl),
    refUrls: (Array.isArray(p.refUrls) ? p.refUrls : []).map(url).filter(Boolean).slice(0, CT_AI_STYLE_MAX_REFS),
    setId: typeof p.setId === "string" && /^[0-9a-f-]{36}$/i.test(p.setId) ? p.setId : "",
  };
}
