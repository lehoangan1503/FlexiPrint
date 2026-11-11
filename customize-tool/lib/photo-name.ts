/**
 * The customer's name typed for an AI style that writes it in the picture ([NAME] in the prompt, or the style's
 * "Cho khách nhập tên" tick — lib/ai-style-models aiStyleAsksName). Its field on the product form is set per photo
 * zone (CtPhotoConfig.name, asked 2026-11-11). Pure data, shared by the editor and the storefront.
 */

import type { CtPhotoConfig, CtPhotoNameConfig } from "../types";
import { CT_AI_STYLE_NAME_MAX } from "./ai-style-models";

export const CT_PHOTO_NAME_DEFAULT: CtPhotoNameConfig = { label: "Name", placeholder: "Enter a name", maxChars: 12, required: false };

/** The zone's name field with defaults filled in and the length kept within what a prompt takes. */
export function photoNameConfig(photo: Pick<CtPhotoConfig, "name">): CtPhotoNameConfig {
  const n: Partial<CtPhotoNameConfig> = photo.name ?? {};
  const max = typeof n.maxChars === "number" && Number.isFinite(n.maxChars) ? Math.round(n.maxChars) : CT_PHOTO_NAME_DEFAULT.maxChars;
  return {
    label: typeof n.label === "string" ? n.label : CT_PHOTO_NAME_DEFAULT.label,
    placeholder: typeof n.placeholder === "string" ? n.placeholder : CT_PHOTO_NAME_DEFAULT.placeholder,
    maxChars: Math.min(CT_AI_STYLE_NAME_MAX, Math.max(1, max)),
    required: n.required === true,
  };
}
