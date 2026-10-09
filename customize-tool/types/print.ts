/**
 * Khuôn in (print templates, ct_print_templates — migration 024, lib/print-template.ts). What the printer needs,
 * independent of any design; every product printed on the same piece reuses it.
 */

import type { CtBounds, CtShape } from "./index";

/** POST print-templates/ai — what the AI is asked to make (a new khuôn, or a change of `templateId`'s). */
export interface CtPrintAiRequest {
  templateId: string | null;
  prompt: string;
  /** Sample product photos / pattern drawings (public urls). */
  refs: string[];
  /** Face names ("Mặt trước", "Mặt sau"); empty = one face. */
  faces: string[];
  mirror: boolean;
  /** Sheet size wanted (px); 0 = from the drawing's shape. */
  width: number;
  height: number;
  dpi: number;
}

/** The AI's khuôn, not saved yet: the editor looks, asks again or keeps it. */
export interface CtPrintAiResult {
  width: number;
  height: number;
  faces: CtPrintFace[];
}

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
  /** LEGACY single blank photo — read into `blanks` (normalizePrintSpec). */
  blankUrl: string | null;
  /** LEGACY: where the sheet sits on `blankUrl`. */
  blankBox: CtBounds | null;
  notes: string;
  /**
   * The faces printed separately (trousers: Mặt trước / Mặt sau), each its own sheet of width × height with its
   * khuôn as a picture. Empty = one face drawn by the shapes above (outline / safe / cuts — a round ornament).
   */
  faces: CtPrintFace[];
  /**
   * The sheet is ONE half of a symmetric piece (one trouser leg): the artwork is made for it, the print file adds
   * its mirror image beside it for the other half.
   */
  mirror: boolean;
  /** Phôi trơn of the piece — reused by every product, the v2 brief and the mockups (server/print-blanks.ts). */
  blanks: CtPrintBlank[];
  /** What the khuôn was made / last changed from (the AI's brief): prompts and reference pictures, newest last. */
  history: CtPrintHistoryEntry[];
}

/** One printed face of the piece, at the sheet's size. */
export interface CtPrintFace {
  id: string;
  name: string;
  /** The khuôn as it was given or drawn (an uploaded drawing, the AI's colour-coded drawing). */
  imageUrl: string | null;
  /** Where ink goes: alpha 255 = printed, 0 = not (outside the piece, holes) — sheet size. null = the whole sheet. */
  maskUrl: string | null;
  /** The cut line (solid) and the safe zone (dashed band) drawn for the editor, transparent, sheet size. */
  guideUrl: string | null;
}

export interface CtPrintBlank {
  id: string;
  name: string;
  url: string;
  width: number;
  height: number;
  /** Where the sheet sits on the photo (photo px). */
  box: CtBounds;
  /** Made by AI from the khuôn. */
  ai: boolean;
}

export interface CtPrintHistoryEntry {
  at: string;
  prompt: string;
  refs: string[];
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
