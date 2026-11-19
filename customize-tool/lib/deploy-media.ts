/**
 * The pictures a deploy sends to Shopify.
 *
 * 2026-10-30 ("ảnh đưa lên deploy mặc định là mockup sản phẩm, không đưa mockup phôi trơn"): the product's scene
 * mockups. The artwork laid flat on the phôi ("mockup_front…", made as a mockup until that day; now only the AI's
 * reference) never goes by default.
 *
 * 2026-11-19 (asked: "kéo thả thứ tự ảnh… kéo theo thẳng vào phần deploy", "deploy hàng loạt đưa thẳng tất cả ảnh"):
 * the product keeps ONE order of its mockups (CtProductConfig.mockupOrder) and the ones it does not send
 * (mockupOff). The editor's "Ảnh sản phẩm", the Deploy page and every deploy (bulk, MCP, import) read the same two
 * lists; a deploy writes them back with what it sent. No cap on how many go (was 8).
 */

import type { CtAsset } from "../types";

/** Most pictures one deploy sends (Shopify reads back 100 media; size charts come after these). */
export const CT_DEPLOY_MEDIA_MAX = 90;

export const isFrontMockup = (a: Pick<CtAsset, "name">): boolean =>
  a.name.startsWith("mockup_front");

type Mock = Pick<CtAsset, "id" | "name">;

/** What a product keeps of its mockups' order / picks (CtProductConfig, already normalized). */
export interface CtMockupPicks {
  mockupOrder: string[];
  mockupOff: string[];
}

/**
 * The product's own mockups in its order: the saved order first, then the ones never placed (scene photos before
 * the flat front ones, oldest first — as they come from the DB).
 */
export function productMockups<
  T extends Pick<CtAsset, "role" | "product_id" | "name" | "id">,
>(assets: T[], productId: string, picks?: CtMockupPicks | null): T[] {
  const at = (a: T) => String((a as { created_at?: string }).created_at ?? "");
  const mine = assets
    .filter((a) => a.product_id === productId && a.role === "mockup")
    .sort((a, b) => at(a).localeCompare(at(b)));
  return orderMockups(mine, picks?.mockupOrder ?? []);
}

/** `mockups` in the saved order; the ones not in it after, scene before front. */
export function orderMockups<T extends Mock>(
  mockups: T[],
  order: string[],
): T[] {
  const byId = new Map(mockups.map((a) => [a.id, a]));
  const placed = order
    .map((id) => byId.get(id))
    .filter((a): a is T => Boolean(a));
  const seen = new Set(placed.map((a) => a.id));
  const rest = mockups.filter((a) => !seen.has(a.id));
  return [
    ...placed,
    ...rest.filter((a) => !isFrontMockup(a)),
    ...rest.filter(isFrontMockup),
  ];
}

/** Which of the (ordered) mockups go to Shopify: all but the ones switched off — a front one never placed is off. */
export function pickedMockups<T extends Mock>(
  ordered: T[],
  picks: CtMockupPicks,
): string[] {
  const off = new Set(picks.mockupOff);
  const placed = new Set(picks.mockupOrder);
  return ordered
    .filter((a) => !off.has(a.id) && (placed.has(a.id) || !isFrontMockup(a)))
    .map((a) => a.id);
}

/** The pictures a deploy sends when nobody picks: the product's picked mockups, in its order. */
export function defaultDeployMedia<T extends Mock>(
  mockups: T[],
  picks?: CtMockupPicks | null,
): string[] {
  const p = picks ?? { mockupOrder: [], mockupOff: [] };
  return pickedMockups(orderMockups(mockups, p.mockupOrder), p).slice(
    0,
    CT_DEPLOY_MEDIA_MAX,
  );
}

/** The order + picks to keep after `sent` went up (in that order): sent first, the rest after, off. */
export function picksAfterDeploy<T extends Mock>(
  mockups: T[],
  picks: CtMockupPicks,
  sent: string[],
): CtMockupPicks {
  const ids = new Set(mockups.map((a) => a.id));
  const first = sent.filter((id) => ids.has(id));
  const set = new Set(first);
  const rest = orderMockups(mockups, picks.mockupOrder)
    .filter((a) => !set.has(a.id))
    .map((a) => a.id);
  return { mockupOrder: [...first, ...rest], mockupOff: rest };
}

/**
 * The product's picks as they stand: its saved lists, else — deployed before 2026-11-19, nothing saved — what is on
 * Shopify now (link.media, in the order sent) ticked first and the rest unticked; else nothing saved = all scene
 * mockups ticked in their default order.
 */
export function effectivePicks<T extends Mock>(
  mockups: T[],
  config: CtMockupPicks,
  linkMedia?: Record<string, string> | null,
): CtMockupPicks {
  if (config.mockupOrder.length || config.mockupOff.length)
    return { mockupOrder: config.mockupOrder, mockupOff: config.mockupOff };
  const ids = new Set(mockups.map((a) => a.id));
  const sent = Object.keys(linkMedia ?? {}).filter((id) => ids.has(id));
  return sent.length
    ? picksAfterDeploy(mockups, { mockupOrder: [], mockupOff: [] }, sent)
    : { mockupOrder: [], mockupOff: [] };
}

/** Clean lists from a request / stored config: unique non-empty strings. */
export function idList(raw: unknown, max = 500): string[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw.filter(
        (x): x is string =>
          typeof x === "string" && x.length > 0 && x.length < 100,
      ),
    ),
  ].slice(0, max);
}
