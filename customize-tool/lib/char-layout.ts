/**
 * Where a bộ nhân vật's parts go on its product (server/char/product.ts), pure: the characters' box (the set's canvas
 * fitted, aspect kept exactly), and each personalised text's box around it (asked 2026-10-14: a slogan along the top
 * of a round ornament, the names left and right of the two characters).
 *
 *   top     a band under the hanging hole; on a round piece it follows the circle (text curve from the chord)
 *   bottom  a band at the bottom
 *   left /  columns beside the characters, at their waist; on a round piece they start where the circle does
 *   right
 *
 *   under   a band kept under the characters — each name is placed under its character (lib/char-lineup underText)
 *   free    the text's own box (shares of the area) — placed by the product, not here
 *
 * Several texts in one place share it (stacked). Sizes are shares of the area, so a 1000 px ornament and a 3600 px
 * poster come out alike.
 */

import type { CtCharTextField, CtCharTextPlace } from "../types";
import { UNDER_BAND } from "./char-lineup";

export interface CtLayoutBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CtCharLayoutText {
  id: string;
  box: CtLayoutBox;
  fontSize: number;
  /** compositor text curve (-100..100): positive bows up (∩). */
  curve: number;
  align: "left" | "center" | "right";
  /** A name on a hat's brim: the brim's circle (share of the box's width) and tilt (CtTextConfig arcRadius / arcTilt). */
  arcRadius?: number;
  arcTilt?: number;
}

export interface CtCharLayout {
  characters: CtLayoutBox;
  texts: CtCharLayoutText[];
}

export interface CtCharLayoutInput {
  /** Where everything must stay (the khuôn's safe zone bounds, else the frame). */
  area: CtLayoutBox;
  /** The safe zone is a circle / ellipse (an ornament). */
  round: boolean;
  /** Holes cut in the piece (a hanging hole): nothing goes over them. */
  holes: CtLayoutBox[];
  set: { width: number; height: number };
  texts: CtCharTextField[];
}

/** Shares of the area. */
const TOP_BAND = 0.12;
const BOTTOM_BAND = 0.1;
const SIDE = 0.19;
/** A text along the rim of a round piece: its letter height. */
const TOP_FONT = 0.075;
const GAP = 0.015;

export function charLayout({ area, round, holes, set, texts }: CtCharLayoutInput): CtCharLayout {
  const D = Math.min(area.w, area.h);
  const cx = area.x + area.w / 2;
  const cy = area.y + area.h / 2;
  const r = D / 2;
  const at = (p: CtCharTextPlace) => texts.filter((t) => t.place === p);
  const tops = at("top");
  const bottoms = at("bottom");
  const sides = at("left").length > 0 || at("right").length > 0;

  // Vertical room: below the hole (and the narrow top of a circle), above the narrow bottom.
  const holeBottom = Math.max(0, ...holes.filter((h) => h.y + h.h / 2 < cy).map((h) => h.y + h.h));
  let top = Math.max(area.y + (round ? 0.1 * D : 0), holeBottom ? holeBottom + GAP * D : area.y);
  let bottom = area.y + area.h - (round ? 0.06 * D : 0);
  const out: CtCharLayoutText[] = [];
  /** Half the width of the piece at height y. */
  const halfWidth = (y: number) => (round ? Math.sqrt(Math.max(0, r * r - (y - cy) ** 2)) * (area.w / D) : area.w / 2);

  /** Straight lines stacked from y0, each `each` high. */
  const band = (list: CtCharTextField[], y0: number, each: number) =>
    list.forEach((t, i) => {
      const y = y0 + i * each;
      const hw = halfWidth(y + each / 2) * 0.9;
      out.push({ id: t.id, box: { x: cx - hw, y, w: 2 * hw, h: each }, fontSize: Math.round(each * 0.78), curve: 0, align: "center" });
    });
  if (tops.length) {
    let rest = tops;
    if (round) {
      // The first top text along the rim: its top letters just under the hole, bowed like the circle (radius ≈ the
      // rim's), so its ends sag — the characters start below the sag (lib/compositor: sweep = text length / radius).
      const f = TOP_FONT * D;
      const apex = top + f / 2;
      const hw = halfWidth(apex) * 0.88;
      const R = r * 0.95;
      const typical = 0.6 * 2 * hw;
      const curve = Math.max(0, Math.min(60, Math.round((100 * typical) / (R * Math.PI))));
      const sag = R * (1 - Math.cos(typical / (2 * R)));
      out.push({ id: tops[0].id, box: { x: cx - hw, y: apex - f / 2, w: 2 * hw, h: f }, fontSize: Math.round(f), curve, align: "center" });
      top += f + sag + GAP * D;
      rest = tops.slice(1);
    }
    if (rest.length) {
      const each = (TOP_BAND * D) / 1.4;
      band(rest, top, each);
      top += each * rest.length + GAP * D;
    }
  }
  // Names under each character (lib/char-lineup underText): a band kept under them.
  if (texts.some((t) => t.place === "under")) bottom -= UNDER_BAND * D;
  if (bottoms.length) {
    const each = (BOTTOM_BAND * D) / 1.2;
    band(bottoms, bottom - each * bottoms.length, each);
    bottom -= each * bottoms.length + GAP * D;
  }

  // The characters: what is left, minus the side columns.
  const side = sides ? SIDE * area.w : 0;
  const availW = area.w - 2 * side;
  const availH = Math.max(1, bottom - top);
  const k = Math.min(availW / set.width, availH / set.height);
  const characters = { w: set.width * k, h: set.height * k, x: 0, y: 0 };
  characters.x = cx - characters.w / 2;
  characters.y = top + (availH - characters.h) / 2;

  // Names beside the characters at their waist; on a circle the column starts where the piece does.
  const nameH = 0.11 * D;
  const waist = characters.y + characters.h * 0.48;
  for (const p of ["left", "right"] as const) {
    const list = at(p);
    list.forEach((t, i) => {
      const y = waist - (nameH * list.length) / 2 + i * nameH;
      const edge = halfWidth(y + nameH / 2) * 0.94;
      const x0 = p === "left" ? cx - edge : characters.x + characters.w;
      const x1 = p === "left" ? characters.x : cx + edge;
      out.push({ id: t.id, box: { x: x0, y, w: Math.max(1, x1 - x0), h: nameH }, fontSize: Math.round(nameH * 0.7), curve: 0, align: "center" });
    });
  }
  return { characters, texts: out };
}
