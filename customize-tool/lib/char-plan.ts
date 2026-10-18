/**
 * The pictures a bộ nhân vật's clipart files are cut from, derived from the brief — never typed by the editor.
 * Rebuilt 2026-10-14 ("xoá mọi logic chắp vá"): a paper doll and every option drawn ON it, cut by difference.
 *
 *   work                 the approved master (a copy) — what the doll is drawn from
 *   base                 the paper doll: every part the customer changes taken off (bald, a flat magenta tank top and
 *                        shorts, empty hands) — the body file, and the canvas every option is drawn on
 *   shape:<slot>:<opt>   one option drawn on the doll, in place, on a transparent background: every option of a shape /
 *                        texture slot (the first too), the first option of a colour slot (its other colours are
 *                        recolours of that drawing)
 *   zone:<zone>          a customer-photo zone painted magenta on the doll
 *   thumb:<slot>:<opt>   a held item / accessory drawn ALONE and complete from its option picture (the hand that hides
 *                        part of it taken away) — ONLY the option's thumbnail in the shop, never cut, never a clipart
 *                        (asked 2026-10-15: a glass whose stem the hand hides showed as a floating bowl + foot)
 *
 * A file is its picture's pixels where they differ from the doll (services/layer-kit part_region): stacked on the doll
 * it is exactly that 3b picture, and the doll is never touched. The doll wears flat magenta where clothes go so that any
 * garment drawn over it differs clearly (a cream cardigan over a white tank top left holes, tested 2026-10-14).
 */

import type { CtCharBrief, CtCharSlot } from "../types";
import { shownByDefault, subjectRef } from "./char-brief";

export interface CtCharEditPlan {
  role: string;
  /** Vietnamese label for the page. */
  label: string;
  /** "master" | another role it is drawn from. */
  source: string;
  /** Empty for "work" (a copy, not a prompt). */
  prompt: string;
  /** Drawn on a transparent background (a picture files are cut from). */
  transparent?: boolean;
}

/** One option picture of the plan: the slot, its subject, the option index. */
export interface CtCharOptionPicture {
  slot: CtCharSlot;
  subject: number;
  index: number;
  role: string;
}

/** The ending of an edit that is drawn on white (zones). */
export const KEEP =
  " Keep EVERYTHING else pixel-identical: same faces, same poses, same bodies, same clothes, same position, same size, " +
  "same framing and canvas, same white background. Do not move, zoom, crop or re-draw anything else.";

/** The ending of an edit that comes cut out (the doll, an option on it). */
export const KEEP_CLEAR =
  " Keep EVERYTHING else pixel-identical: same faces, same poses, same bodies, same arms and hands, same position, same " +
  "size, same framing and canvas. The background is fully transparent. Do not move, zoom, crop or re-draw anything else.";

/** The ending of a thumbnail picture: the part alone, framed for a small tile (re-framing is fine — it is never cut). */
export const KEEP_ALONE =
  " Only that one object, alone and complete, centred and filling most of the square canvas, in exactly the same art " +
  "style, colours and details as in the picture. The background is fully transparent. No hand, no person, no text.";

/** The sentence an edit of `role` ends with (the server appends it; the agent writes only the change). */
export function tailOf(role: string): string {
  return role.startsWith("zone:") ? KEEP : role.startsWith("thumb:") ? KEEP_ALONE : KEEP_CLEAR;
}

/** A thumbnail-only picture: not needed to cut the set. */
export const isThumbRole = (role: string): boolean => role.startsWith("thumb:");

/** The doll's underwear: one flat colour no garment is likely to have, so whatever is drawn over it stands out, and a
 * chroma key: a pixel of its hue is never part of an option (layer-kit part_region). Magenta: every usual garment, hair
 * and skin colour is far from it in hue (teal was not: an emerald dress came too close, 2026-10-14). */
export const DOLL_COLOUR = { name: "flat bright magenta", hex: "#D81BD8" };

const isHair = (part: string) => /hair|tóc/i.test(part);
const isTop = (p: string) => /shirt|top|sweater|jumper|hoodie|cardigan|jacket|coat|blouse|tee|áo/i.test(p);
const isBottom = (p: string) => /pants|trousers|jeans|skirt|shorts|quần|váy ngắn/i.test(p);
const isDress = (p: string) => /dress|outfit|gown|bộ|váy/i.test(p);
const isOuter = (p: string) => /jacket|cardigan|coat|blazer|vest|shawl|cape|poncho|áo khoác/i.test(p);
const isShoes = (p: string) => /shoe|boot|heel|sneaker|sandal|giày|dép/i.test(p);
/** Worn on the head / face / neck (an elf hat, glasses, a scarf): taken off and put back where it is worn — not in a
 * hand (2026-10-15: an elf's hat colour option was drawn held in the hand). */
const isWorn = (p: string) => /hat|cap|beanie|crown|tiara|headband|hood|helmet|ear ?muffs|glasses|sunglasses|scarf|necklace|bow tie|tie|mũ|nón|khăn|kính|vòng cổ/i.test(p);
/** Clothes and shoes (a garment): anything else of a person (a held item, an accessory) is an object. */
const isGarment = (p: string) => isTop(p) || isBottom(p) || isDress(p) || isOuter(p) || isShoes(p);

export function slotLabel(brief: CtCharBrief, subjectIndex: number, slot: CtCharSlot): string {
  const kind = brief.subjects[subjectIndex]?.kind === "pet" ? "Thú" : brief.subjects[subjectIndex]?.kind === "object" ? "Vật" : "Người";
  return `${kind} ${subjectIndex + 1} — ${slot.part}`;
}

/** Every option picture drawn on the doll: all options of a shape / texture slot, the first of a colour slot. */
export function optionPictures(brief: CtCharBrief): CtCharOptionPicture[] {
  return brief.subjects.flatMap((sub, i) =>
    sub.slots.flatMap((slot) => (slot.mode === "color" ? slot.options.slice(0, 1) : slot.options).map((o, index) => ({ slot, subject: i, index, role: `shape:${slot.id}:${o.id}` }))),
  );
}

/** The doll: every part a slot changes taken off, said once per subject (worded as a dress-up base: plainly "remove
 * her dress" is refused by the safety filter). */
function basePrompt(brief: CtCharBrief): string {
  const lines: string[] = [];
  brief.subjects.forEach((sub, i) => {
    if (!sub.slots.length) return;
    const who = subjectRef(brief, i);
    // An optional part (glasses) is not in the master: nothing to take off.
    const parts = sub.slots.filter((x) => !x.optional && shownByDefault(brief, x.shownWhen)).map((x) => x.part);
    const clothes = parts.filter((p) => isGarment(p) && !isShoes(p));
    const out: string[] = [];
    if (clothes.length) {
      const top = clothes.some((p) => isTop(p) || isDress(p) || isOuter(p));
      const bottom = clothes.some((p) => isBottom(p) || isDress(p));
      const wear = [
        top ? `a plain snug sleeveless tank top in ${DOLL_COLOUR.name} (${DOLL_COLOUR.hex}) that ends at the waist, arms and shoulders bare` : "",
        bottom ? `plain snug shorts in the same ${DOLL_COLOUR.name} ending at the upper thigh, legs bare below` : "",
      ].filter(Boolean);
      out.push(`replace the ${clothes.join(" and the ")} of ${who} with ${wear.join(" and ")} — one solid flat colour, no pattern, no logo`);
    }
    for (const p of parts) {
      if (isHair(p)) out.push(`remove ALL the hair of ${who}: a smooth bald scalp in the same skin tone, ears visible`);
      else if (isShoes(p)) out.push(`remove the ${p} of ${who}: bare feet in the same pose`);
      else if (isWorn(p)) out.push(`remove the ${p} of ${who}: what it covered (the head, the hair, the neck) is drawn plainly in its place, nothing else changes`);
      else if (!isGarment(p)) out.push(`remove the ${p} of ${who}: the hand that held it stays exactly in the same pose and place, empty`);
    }
    lines.push(out.join("; "));
  });
  return (
    `A family-friendly paper-doll dress-up base of this illustration. Make exactly these changes and nothing else: ${lines.join("; ")}. ` +
    `The bodies keep exactly their shape, proportions and pose.${KEEP_CLEAR}`
  );
}

/** What one option looks like drawn on the doll. */
function optionPrompt(brief: CtCharBrief, slot: CtCharSlot, i: number, index: number): string {
  const who = subjectRef(brief, i);
  const o = slot.options[index];
  const colour = slot.mode === "shape" ? slot.colors[0] : undefined;
  const what = slot.mode === "color" ? `${/^[aeiou]/i.test(slot.part) ? "an" : "a"} ${slot.part} in ${o.name.toLowerCase()} (${o.value})` : `${o.value || o.name}${colour ? ` in ${colour.name.toLowerCase()} colour (${colour.value})` : ""}`;
  const style = "in the same art style as the illustration, with clean continuous outlines";
  if (isHair(slot.part))
    return (
      `Give ${who} this hairstyle on the bald head: ${what}, ${style}, drawn as smooth solid sculpted locks — no loose flyaway strands. ` +
      `Only add the hair; the face, ears, neck and body of ${who} and everyone else stay exactly as they are.${KEEP_CLEAR}`
    );
  if (isWorn(slot.part))
    return (
      `Put ${what} back on ${who}, worn exactly where a ${slot.part} is worn (on the head / face / neck, as in the original illustration), ${style}, a SOLID opaque shape. ` +
      `Only add the ${slot.part}; the face, the hair, the body and the hands of ${who} and everyone else stay exactly as they are.${KEEP_CLEAR}`
    );
  if (!isGarment(slot.part))
    return (
      `Put ${what} in the empty raised hand of ${who}, held naturally with the fingers around it exactly where the hand already is, ${style}, a simple shape. ` +
      `Only add the ${slot.part}; the hand stays in the same pose, and the face and body of ${who} and everyone else stay exactly as they are.${KEEP_CLEAR}`
    );
  const sub = brief.subjects[i];
  const underOuter = !isOuter(slot.part) && (isTop(slot.part) || isDress(slot.part)) && sub.slots.some((x) => x.id !== slot.id && isOuter(x.part));
  return (
    // "knit" alone was drawn as openwork mesh: the underwear showed through every hole (2026-10-14).
    `Dress ${who} in ${what}, ${style}, in a SOLID opaque fabric (not see-through: no holes, mesh, lace or openwork). ` +
    (isOuter(slot.part)
      ? `It is worn open at the front over the ${DOLL_COLOUR.name} tank top, which shows only in the opening; the sleeves cover the arms as far as they reach. `
      : `It covers the ${DOLL_COLOUR.name} tank top and shorts completely wherever it is worn — no ${DOLL_COLOUR.name} shows anywhere. `) +
    // Drawn on its own, a sleeve of the dress would stick out from under every jacket of the set.
    (underOuter ? "It has no sleeves (thin straps), since a jacket is worn over it. " : "") +
    `Only add the ${slot.part}; the face, head, arms, hands and legs of ${who} and everyone else stay exactly as they are.${KEEP_CLEAR}`
  );
}

export function planEdits(brief: CtCharBrief): CtCharEditPlan[] {
  const out: CtCharEditPlan[] = [
    { role: "work", label: "Master làm việc", source: "master", prompt: "" },
    { role: "base", label: "Búp bê giấy (bỏ mọi phần khách đổi)", source: "work", prompt: basePrompt(brief), transparent: true },
  ];
  for (const x of optionPictures(brief)) {
    const o = x.slot.options[x.index];
    const label = `${slotLabel(brief, x.subject, x.slot)}: ${x.slot.mode === "color" ? `${o.name} (màu khác = đổi màu file này)` : o.name}`;
    out.push({ role: x.role, label, source: "base", prompt: optionPrompt(brief, x.slot, x.subject, x.index), transparent: true });
  }
  // Thumbnails of the parts a hand partly hides (held items, accessories): drawn from each option's own picture.
  for (const x of optionPictures(brief)) {
    if (x.slot.mode !== "shape" || isHair(x.slot.part) || isGarment(x.slot.part) || isWorn(x.slot.part)) continue;
    const o = x.slot.options[x.index];
    out.push({
      role: `thumb:${x.slot.id}:${o.id}`,
      label: `${slotLabel(brief, x.subject, x.slot)}: ${o.name} — ảnh thumbnail (đầy đủ, chỉ để hiện ở lựa chọn)`,
      source: x.role,
      prompt: `Draw ONLY the ${x.slot.part} that ${subjectRef(brief, x.subject)} holds (${o.value || o.name}), as it really is: the part the hand hides drawn complete (the whole stem, handle, base).${KEEP_ALONE}`,
      transparent: true,
    });
  }
  for (const z of brief.photoZones)
    out.push({ role: `zone:${z.id}`, label: `Vùng ảnh khách: ${z.label}`, source: "base", prompt: `Paint ONLY ${z.where} solid flat pure magenta #FF00FF, no shading, no texture, no outline change.${KEEP}` });
  return out;
}

/** The 3b picture to draw again when a piece ("<slot>#<i>") is wrong. */
export function redoRoleOf(brief: CtCharBrief, pieceKey: string): string | null {
  const hash = pieceKey.lastIndexOf("#");
  if (hash < 0) return pieceKey === "body" ? "base" : null;
  const slotId = pieceKey.slice(0, hash);
  const index = Number(pieceKey.slice(hash + 1));
  return optionPictures(brief).find((x) => x.slot.id === slotId && x.index === index)?.role ?? null;
}
