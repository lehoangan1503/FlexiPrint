/**
 * The one image model every AI picture uses (asked 2026-10-12: no Nano Banana, no fallback model): GPT Image 2.5 on
 * the company image API (server/pack-images.ts drawImage, "cpa:<model>").
 */

export const CT_IMAGE_MODEL = "cpa:gpt-image-2.5";

export function imageModelLabel(id: string): string {
  return id === CT_IMAGE_MODEL ? "GPT Image 2.5" : id;
}
