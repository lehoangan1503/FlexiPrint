/** Layers on a khuôn in product: a main element (not a fill / print-only / the khuôn) outside the safe zone. */

import type { CtBounds, CtRegion } from "../../types";
import type { CtProductPrint } from "../../types/print";
import { shapeBounds } from "../../lib/geometry";
import { boundsInSafe } from "../../lib/print-template";

/**
 * `ink` = where the layer's pictures really have pixels (lib/ink-bounds): a full-canvas clipart frame with the part
 * inside the safe zone is fine (2026-11-08). null = nothing visible; undefined = not known yet → the frame.
 */
export function outsideSafe(print: CtProductPrint | null, r: CtRegion, ink?: CtBounds | null): boolean {
  if (!print || r.config.materialFrame || r.config.fill || r.config.printOnly || r.config.previewOnly) return false;
  if (ink === null) return false;
  return !boundsInSafe(print.spec, ink ?? shapeBounds(r.shape));
}
