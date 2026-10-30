/**
 * The pictures a deploy sends to Shopify by default (2026-10-30: "ảnh đưa lên deploy mặc định là mockup sản phẩm,
 * không đưa mockup phôi trơn"): the product's scene mockups. The artwork laid flat on the phôi ("mockup_front…",
 * made as a mockup until that day; now only the AI's reference) never goes by default.
 */

import type { CtAsset } from "../types";

/** How many pictures a deploy takes when nobody picks. */
export const CT_DEPLOY_MEDIA = 8;

export const isFrontMockup = (a: Pick<CtAsset, "name">): boolean => a.name.startsWith("mockup_front");

/** The product's own mockups, scene photos first, the flat front ones last. */
export function productMockups<T extends Pick<CtAsset, "role" | "product_id" | "name">>(assets: T[], productId: string): T[] {
  const mine = assets.filter((a) => a.product_id === productId && a.role === "mockup");
  return [...mine.filter((a) => !isFrontMockup(a)), ...mine.filter(isFrontMockup)];
}

/** The default picks: up to CT_DEPLOY_MEDIA scene mockups (none when there are only front ones). */
export function defaultDeployMedia<T extends Pick<CtAsset, "id" | "name">>(mockups: T[]): string[] {
  return mockups.filter((a) => !isFrontMockup(a)).slice(0, CT_DEPLOY_MEDIA).map((a) => a.id);
}
