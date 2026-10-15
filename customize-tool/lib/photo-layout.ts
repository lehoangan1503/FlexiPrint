/**
 * Where a bộ ảnh khách's parts go on its product (server/char/photo-product.ts), pure: the customer's photo in the
 * middle (above the texts), each decoration placed from it — wings behind it, a halo over its top, a band of clouds
 * over its bottom and the piece's bottom edge (the texts lie on it). A box in the brief (shares of the safe area)
 * wins over these defaults; the editor moves any of them afterwards, and a rebuild keeps those hand moves.
 */

import type { CtCharBox, CtCharElement, CtCharTextField } from "../types";
import { charLayout, type CtCharLayoutText, type CtLayoutBox } from "./char-layout";

export interface CtPhotoLayoutInput {
  /** The safe zone bounds (else the frame). */
  area: CtLayoutBox;
  /** The whole piece (the khuôn outline bounds, else the frame): a band reaches its edges, the khuôn cuts it. */
  piece: CtLayoutBox;
  round: boolean;
  holes: CtLayoutBox[];
  texts: CtCharTextField[];
  /** The photo zone's box from the brief (null = laid out here). */
  zone: CtCharBox | null;
  elements: CtCharElement[];
}

export interface CtPhotoLayout {
  photo: CtLayoutBox;
  /** element id → its box. */
  elements: Record<string, CtLayoutBox>;
  texts: CtCharLayoutText[];
}

/** The photo's shape when nothing says otherwise: a little taller than wide (a sitting pet, a head and shoulders). */
const PHOTO_ASPECT = 0.9;

export function photoLayout({ area, piece, round, holes, texts, zone, elements }: CtPhotoLayoutInput): CtPhotoLayout {
  const D = Math.min(area.w, area.h);
  const fromShares = (b: CtCharBox): CtLayoutBox => ({ x: area.x + b.x * area.w, y: area.y + b.y * area.h, w: b.w * area.w, h: b.h * area.h });
  // The texts as around characters (lib/char-layout); the photo takes the characters' place.
  const base = charLayout({ area, round, holes, set: { width: PHOTO_ASPECT * 1000, height: 1000 }, texts });
  let photo: CtLayoutBox = base.characters;
  if (zone) photo = fromShares(zone);
  else if (elements.some((e) => e.place === "above" && !e.box)) {
    // Room over the head for a halo: the photo a little lower and smaller.
    const room = 0.07 * D;
    const h = Math.max(1, photo.h - room);
    const w = (h * photo.w) / Math.max(1, photo.h);
    photo = { x: photo.x + (photo.w - w) / 2, y: photo.y + room, w, h };
  }
  const cx = photo.x + photo.w / 2;
  const out: Record<string, CtLayoutBox> = {};
  for (const e of elements) {
    if (e.box) {
      out[e.id] = fromShares(e.box);
      continue;
    }
    if (e.place === "behind") {
      const w = Math.min(piece.w, photo.w * 1.75);
      const h = photo.h * 0.78;
      out[e.id] = { x: cx - w / 2, y: photo.y + photo.h * 0.04, w, h };
    } else if (e.place === "above") {
      const w = photo.w * 0.42;
      const h = w * 0.36;
      out[e.id] = { x: cx - w / 2, y: photo.y - h * 0.55, w, h };
    } else if (e.place === "bottom") {
      // From the lower part of the photo to the piece's bottom edge, the piece's whole width (the khuôn cuts it).
      const y = photo.y + photo.h * 0.52;
      out[e.id] = { x: piece.x, y, w: piece.w, h: Math.max(1, piece.y + piece.h - y) };
    } else {
      out[e.id] = { x: area.x + area.w * 0.35, y: area.y + area.h * 0.35, w: area.w * 0.3, h: area.h * 0.3 };
    }
  }
  return { photo, elements: out, texts: base.texts };
}
