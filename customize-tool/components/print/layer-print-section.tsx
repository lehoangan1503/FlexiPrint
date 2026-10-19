/** Layers on a khuôn in product: a main element (not a fill / print-only / the khuôn) outside the safe zone. */

import type { CtRegion } from "../../types";
import type { CtProductPrint } from "../../types/print";
import { shapeBounds } from "../../lib/geometry";
import { boundsInSafe } from "../../lib/print-template";

export function outsideSafe(print: CtProductPrint | null, r: CtRegion): boolean {
  if (!print || r.config.materialFrame || r.config.fill || r.config.printOnly) return false;
  return !boundsInSafe(print.spec, shapeBounds(r.shape));
}
