/**
 * v2 picture helpers shared by the page and the server.
 */

import type { CtCharImage } from "../types";

/** The latest edit of each role (lib/char-plan.ts roles). */
export function latestEditsOf(images: CtCharImage[]): Map<string, CtCharImage> {
  const out = new Map<string, CtCharImage>();
  for (const im of images) {
    if (im.kind !== "edit") continue;
    const cur = out.get(im.role);
    if (!cur || im.created_at >= cur.created_at) out.set(im.role, im);
  }
  return out;
}
