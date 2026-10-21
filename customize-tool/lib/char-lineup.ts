/**
 * Who is in the picture, and where everything else goes around them — a bộ nhân vật's product (server/char/product.ts),
 * pure. Asked 2026-10-18: a graduation ornament the customer makes of a boy OR a girl, a family rug of 1–5 people,
 * each version laid out on its own; decorations (a ribbon banner, the year, trees beside the family) placed around
 * the characters; each person's name under them.
 *
 *   versions   brief.lineup "one" → a version per subject · "count" → version k = the first k subjects · none → one
 *   placement  a version's subjects (their crop on the set's canvas) fitted into the characters' area: "one" each fills
 *              it, "count" all at the size the whole row has (one person is as big as in the row of five), centred,
 *              standing on the area's bottom
 */

import type { CtCharBox, CtCharBrief, CtCharComposeVersion, CtCharElement, CtCharTextField } from "../types";
import type { CtCharLayoutText, CtLayoutBox } from "./char-layout";

export interface CtCharVersion {
  /** The customer's word for it ("Boy", "3 People"); "" = the only version. */
  name: string;
  /** Subject indexes in it, left → right. */
  subjects: number[];
}

/** A subject's customer name: its own, else what the brief calls it elsewhere — its chooser ("Grandchild 1"), its name
 * field ("Grandma's name" → "Grandma") — else the first words of its description (2026-10-21: a brief without names
 * put "A cute grandchild with a gender-neutral small child…" on every layer the customer sees). */
export function subjectName(brief: CtCharBrief, i: number): string {
  const sub = brief.subjects[i];
  if (!sub) return "Character";
  if (sub.name?.trim()) return sub.name.trim();
  const chooser = brief.choosers?.find((c) => c.subject === sub.id)?.label.trim();
  if (chooser) return chooser;
  const field = brief.texts.find((t) => t.subject === sub.id && (t.place === "on" || t.place === "under"))?.label.replace(/[’']s\s+name$|\s+name$/i, "").trim();
  if (field) return field;
  const x = sub.description.split(/[,.;]/)[0].trim();
  return x ? x[0].toUpperCase() + x.slice(1) : `Character ${i + 1}`;
}

export function charVersions(brief: CtCharBrief): CtCharVersion[] {
  const all = brief.subjects.map((_, i) => i);
  const lineup = brief.lineup;
  if (!lineup || brief.subjects.length < 2) return [{ name: "", subjects: all }];
  // Characters always there (the grandma the grandchildren gather round) are in every version and not counted.
  const always = all.filter((i) => brief.subjects[i].always);
  const rest = all.filter((i) => !brief.subjects[i].always);
  if (lineup.mode === "one") return rest.map((i) => ({ name: subjectName(brief, i), subjects: [...always, i].sort((a, b) => a - b) }));
  // Counted from the ones beside the "always" characters outwards, left and right in turn (1 = beside the grandma,
  // 2 = one each side…); without any, from the left.
  const centre = always.length ? always.reduce((a, b) => a + b, 0) / always.length : -1;
  const order = centre < 0 ? rest : [...rest].sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre) || a - b);
  // With characters always there the count is just a number ("Number of Grandchildren": 1 2 3 4).
  const word = rest.every((i) => brief.subjects[i].kind === "pet") ? ["Pet", "Pets"] : ["Person", "People"];
  return order.map((_, k) => ({ name: always.length ? String(k + 1) : `${k + 1} ${k === 0 ? word[0] : word[1]}`, subjects: [...always, ...order.slice(0, k + 1)].sort((a, b) => a - b) }));
}

/** The order a "count" lineup adds its characters in (subject indexes) — the customer's "#1, #2…". */
export function countOrder(brief: CtCharBrief): number[] {
  const v = charVersions(brief);
  return v[v.length - 1]?.subjects.filter((i) => !brief.subjects[i].always).sort((a, b) => v.findIndex((x) => x.subjects.includes(a)) - v.findIndex((x) => x.subjects.includes(b))) ?? [];
}

export const unionBox = (boxes: CtLayoutBox[]): CtLayoutBox | null => {
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

/**
 * Where the set's canvas goes for one version (the box every image layer of it gets — files land 1:1): `crop` (the
 * version's subjects on the canvas, px) fitted in `area` at scale `k` (null = its own fit), centred, on the bottom.
 */
export function placeCrop(set: { width: number; height: number }, crop: CtLayoutBox, area: CtLayoutBox, k: number | null): { box: CtLayoutBox; k: number } {
  const s = k ?? Math.min(area.w / crop.w, area.h / crop.h);
  const x = area.x + (area.w - crop.w * s) / 2 - crop.x * s;
  const y = area.y + area.h - crop.h * s - crop.y * s;
  return { box: { x, y, w: set.width * s, h: set.height * s }, k: s };
}

/** A box of shares of the safe area. */
export const fromShares = (area: CtLayoutBox, b: CtCharBox): CtLayoutBox => ({ x: area.x + b.x * area.w, y: area.y + b.y * area.h, w: b.w * area.w, h: b.h * area.h });

/** Each decoration's box around the characters' area (a box in the brief wins). */
export function charElementBoxes(elements: CtCharElement[], chars: CtLayoutBox, area: CtLayoutBox, piece: CtLayoutBox): Record<string, CtLayoutBox> {
  const out: Record<string, CtLayoutBox> = {};
  const cx = chars.x + chars.w / 2;
  for (const e of elements) {
    if (e.box) out[e.id] = fromShares(area, e.box);
    else if (e.place === "behind") {
      const w = Math.min(piece.w, chars.w * 1.6);
      out[e.id] = { x: cx - w / 2, y: chars.y + chars.h * 0.05, w, h: chars.h * 0.9 };
    } else if (e.place === "above") {
      const w = chars.w * 0.4;
      const h = w * 0.36;
      out[e.id] = { x: cx - w / 2, y: chars.y - h * 0.6, w, h };
    } else if (e.place === "bottom") {
      // The ground the characters stand / sit on: from their lower part to the piece's bottom, its whole width.
      const y = chars.y + chars.h * 0.7;
      out[e.id] = { x: piece.x, y, w: piece.w, h: Math.max(1, piece.y + piece.h - y) };
    } else out[e.id] = { x: area.x + area.w * 0.35, y: area.y + area.h * 0.35, w: area.w * 0.3, h: area.h * 0.3 };
  }
  return out;
}

/** Room kept under the characters for the names under each of them (shares of the area's shorter side). */
export const UNDER_BAND = 0.1;

/** A name under one character: centred under its feet, in the band kept for it. */
export function underText(t: CtCharTextField, subjectBox: CtLayoutBox, area: CtLayoutBox, D: number): CtCharLayoutText {
  const h = UNDER_BAND * D * 0.8;
  const w = Math.max(subjectBox.w * 1.15, D * 0.18);
  const y = Math.min(subjectBox.y + subjectBox.h + 0.01 * D, area.y + area.h - h);
  return { id: t.id, box: { x: subjectBox.x + subjectBox.w / 2 - w / 2, y, w, h }, fontSize: Math.round(h * 0.72), curve: 0, align: "center" };
}

/** The option each chooser shows (chooser id → option id): its first (the master's) unless picked. */
export type CtChooserPicks = Record<string, string>;

/** Is a layer-set slot (key "c1_hair_boy:front") there with these chooser picks? Only a part with shownWhen comes and
 * goes (asked 2026-10-20: a grandchild's boy and girl hair stacked in step 3 — show one of them). */
export function slotShown(brief: CtCharBrief, slotKey: string, picks: CtChooserPicks): boolean {
  const id = slotKey.split(":")[0];
  const w = brief.subjects.flatMap((s) => s.slots).find((s) => s.id === id)?.shownWhen;
  if (!w) return true;
  const c = brief.choosers?.find((x) => x.id === w.chooser);
  return !c || (picks[c.id] ?? c.options[0]?.id) === w.option;
}

/** The choosers that make parts come and go (a grandchild's Boy / Girl), in the brief's order. */
export function partChoosers(brief: CtCharBrief): NonNullable<CtCharBrief["choosers"]> {
  const used = new Set(brief.subjects.flatMap((s) => s.slots).flatMap((s) => (s.shownWhen ? [s.shownWhen.chooser] : [])));
  return (brief.choosers ?? []).filter((c) => used.has(c.id));
}

/** The picks that show `slotKey` (its chooser on the slot's option), the others kept. */
export function picksShowing(brief: CtCharBrief, slotKey: string, picks: CtChooserPicks): CtChooserPicks {
  const id = slotKey.split(":")[0];
  const w = brief.subjects.flatMap((s) => s.slots).find((s) => s.id === id)?.shownWhen;
  return w ? { ...picks, [w.chooser]: w.option } : picks;
}

/** Each version of a posed set: as @flexiprint composed it, else everyone side by side in the brief's order (the
 * ones that stand behind — the always-there grandma — a little bigger, in the middle of the row). */
export function composedVersions(brief: CtCharBrief): CtCharComposeVersion[] {
  return charVersions(brief).map((v) => {
    const own = brief.compose?.find((c) => c.name === v.name);
    const subjectIds = v.subjects.map((i) => brief.subjects[i].id);
    if (own && own.people.every((x) => subjectIds.includes(x.subject)) && subjectIds.every((id) => own.people.some((x) => x.subject === id))) return own;
    return {
      name: v.name,
      people: v.subjects.map((i, k) => {
        const sub = brief.subjects[i];
        return { subject: sub.id, x: k * 0.8, y: 0, h: sub.always ? 1.15 : 1 };
      }),
    };
  });
}
