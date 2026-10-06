/**
 * The image models the team can pick on the home page (ct_settings 'image_model'). Every AI picture uses the
 * picked one: studio clipart gốc / đa sắc / vật liệu / sửa (services/comfy providers: "cpa:<model>" = the company
 * image API, "fal:<endpoint>" = fal.ai) and the ảnh tổ hợp library.
 */

export interface CtImageModel {
  id: string;
  label: string;
  note: string;
}

export const CT_IMAGE_MODELS: readonly CtImageModel[] = [
  { id: "cpa:gpt-image-2.5", label: "GPT Image 2.5", note: "API ảnh công ty (cpa) — model cao nhất" },
  { id: "fal:fal-ai/nano-banana-2/edit", label: "Nano Banana 2", note: "fal.ai — tính tiền theo ảnh" },
  { id: "fal:fal-ai/nano-banana/edit", label: "Nano Banana", note: "fal.ai — tính tiền theo ảnh" },
];

export const CT_DEFAULT_IMAGE_MODEL = CT_IMAGE_MODELS[0].id;

export function isImageModel(id: unknown): id is string {
  return typeof id === "string" && CT_IMAGE_MODELS.some((m) => m.id === id);
}

export function imageModelLabel(id: string): string {
  return CT_IMAGE_MODELS.find((m) => m.id === id)?.label ?? id;
}
