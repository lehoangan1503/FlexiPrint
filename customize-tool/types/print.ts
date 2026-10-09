/**
 * Khuôn in (print templates, ct_print_templates — migration 024, lib/print-template.ts). What the printer needs,
 * independent of any design; every product printed on the same piece reuses it.
 */

import type { CtBounds, CtShape } from "./index";

/**
 *   flat    one piece cut to a geometric outline (ornament, tile, poster, mug wrap)
 *   cut     the outline is the artwork's own alpha + a margin (sticker, acrylic, a customer's cut-out photo)
 *   panels  several named zones on one sheet, often in sizes (all-over-print trousers, pillow faces)
 */
export type CtPrintKind = "flat" | "cut" | "panels";

/** A named area of the sheet a layer can fill ("Ống quần", "Cạp", "Quần lót"); base-size px. */
export interface CtPrintZone {
  id: string;
  name: string;
  shape: CtShape;
}

/**
 * One size of the piece (S…4XL): its own sheet. Zones absent here are the base zones scaled by the size's
 * width / height ratio (a straight grade); a real grade gives them per size.
 */
export interface CtPrintSize {
  id: string;
  name: string;
  width: number;
  height: number;
  zones?: Record<string, CtShape>;
}

/** Everything is in the base sheet's px (width × height). */
export interface CtPrintSpec {
  width: number;
  height: number;
  dpi: number;
  widthMm: number;
  heightMm: number;
  /** The cut line (what is left after cutting); null = the whole sheet. Artwork must cover it (+ bleed). */
  outline: CtShape | null;
  /** How far past the cut line the artwork must reach (px). */
  bleed: number;
  /** Main elements (pictures, text) must stay inside one of these. Empty = the outline inset by `bleed` × 2. */
  safe: CtShape[];
  /** Cut out of the piece and kept empty (a hanging hole). */
  cuts: CtShape[];
  /** Named areas a layer can fill (panels kind; optional on the others). */
  zones: CtPrintZone[];
  /** Sizes with their own sheet; empty = one size. */
  sizes: CtPrintSize[];
  /** The printer's guide sheet (drawn over the editor canvas, never printed). */
  frameUrl: string | null;
  /** A straight photo of the blank piece (mockups start from it). */
  blankUrl: string | null;
  /** Where the sheet sits on `blankUrl`, in its px (null = not placed yet). */
  blankBox: CtBounds | null;
  notes: string;
}

export interface CtPrintTemplate {
  id: string;
  user_id: string | null;
  name: string;
  kind: CtPrintKind;
  spec: CtPrintSpec;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** A product made from a template keeps a copy (CtProductConfig.print). */
export interface CtProductPrint {
  templateId: string | null;
  name: string;
  kind: CtPrintKind;
  spec: CtPrintSpec;
}
