/**
 * Which design a customer's phôi (CtPhotoTask.phoi, server/photo-tasks.ts) shows: the version, where the photo sits in
 * its zone, and every picture picked — not the texts (the storefront lays those on the phôi, so typing never needs a
 * new picture). The storefront and the server compute it the same way to know when the phôi still fits the preview.
 */

import type { CtSelection, CtTransform } from "../types";
import { CT_MAIN_KEY } from "../types";

const round = (n: number) => Math.round(n * 1000) / 1000;

/** The picks that change the phôi, as a plain selection (main + image picks + the photo zone's sub-option). */
export function phoiPicks(selection: CtSelection): CtSelection {
  const out: CtSelection = {};
  for (const [id, sel] of Object.entries(selection)) {
    if (id === CT_MAIN_KEY && sel.kind === "main") out[id] = { kind: "main", assetId: sel.assetId };
    else if (sel.kind === "image") out[id] = { kind: "image", assetId: sel.assetId };
  }
  return out;
}

export function phoiTaskKey(mainId: string, regionId: string, transform: CtTransform, selection: CtSelection, optionId: string | null = null): string {
  const picks = phoiPicks(selection);
  const images = Object.keys(picks)
    .filter((id) => id !== CT_MAIN_KEY)
    .sort()
    .map((id) => {
      const s = picks[id];
      return `${id}=${s.kind === "image" ? (s.assetId ?? "-") : "-"}`;
    });
  const t = [transform.offsetX, transform.offsetY, transform.scale, transform.rotation].map(round).join(",");
  return [mainId, regionId, optionId ?? "-", t, ...images].join("|");
}
