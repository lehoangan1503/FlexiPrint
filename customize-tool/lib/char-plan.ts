/**
 * KEY mode (brief.clips "key", asked 2026-10-10 — every new project): ONE AI picture per clipart, cut by its own
 * colours. The picture keeps the part as it is drawn and turns everything else of the figures into flat magenta
 * silhouettes on a transparent background; the clipart = its non-magenta pixels (layer-kit). The pixels and the
 * cut line come from the same picture, so nothing of a neighbour sticks to the edge. Tested 2026-10-10: asked to
 * keep "only the hair" on a transparent canvas the model invents a new one anywhere; the magenta silhouettes hold
 * it in place.
 *
 *   work                    the approved master
 *   base                    the paper doll: every part a slot changes removed (bald, plain bodysuit, empty hands,
 *                           bare arms / feet), transparent background — it IS the body file, nothing is cut from it
 *   clip:<slot>:<opt>       shape option, from work: the master's own part (first option) kept alone, or the part
 *                           replaced by the option and that kept alone (never drawn on the transparent paper doll:
 *                           the model re-frames it)
 *   clip:<slot>             colour / texture part as the master has it, kept alone (colours: recoloured by code)
 *   clip:<slot>:<opt>       texture option: the part in that material (from work), kept alone
 *   zone:<zone>             a customer-photo zone painted magenta on the base (a region, as in paint mode)
 *
 * PAINT mode (older projects) — the in-place edits a brief needs, derived — never typed by the editor. Every edit is made FROM the working master
 * (or from the base, itself an edit of the working master), with the same "keep everything else" sentence, so
 * every file lands on the same pixels (flexiprint://guide/layer-rules §5).
 *
 *   work                 the approved master (a copy: the print upscale happens in layer-kit, after registration)
 *   base                 every "shape" part removed (bald heads, no hats) — only when the brief has shape slots
 *   part:<slot>          a shape part painted magenta on the work master — the region the master's own part is cut by
 *                        (only with several shape slots: with one, base differs from work by that part alone)
 *   mask:<slot>          a colour / texture part painted magenta on the base
 *   texture:<slot>:<opt> the part in another material, on the base
 *   shape:<slot>:<opt>   another shape added back on the base
 *   zone:<zone>          a customer-photo zone painted magenta on the base
 */

import type { CtCharBrief, CtCharSlot } from "../types";
import { subjectRef } from "./char-brief";

export type CtCharEditSource = "master" | "work" | "base";

export interface CtCharEditPlan {
  role: string;
  /** Vietnamese label for the page. */
  label: string;
  source: CtCharEditSource;
  /** Empty for "work" (a copy, not a prompt). */
  prompt: string;
  /** Drawn on a transparent background (key mode: the base and every clip). */
  transparent?: boolean;
}

export const KEEP =
  " Keep EVERYTHING else pixel-identical: same faces, same poses, same bodies, same clothes, same position, same size, " +
  "same framing and canvas, same white background. Do not move, zoom, crop or re-draw anything else.";

const FLAT = " solid flat pure magenta #FF00FF, no shading, no texture, no outline change.";

/** Key mode: what every clip prompt ends with (the server appends it; the agent writes only the first part). */
export const KEY =
  " Everything else of every character — faces, skin, hair, bodies, clothes, shoes, anything held — becomes ONE flat " +
  "solid pure magenta #FF00FF fill per character with the same outline: no lines, no shading, no details inside the " +
  "magenta. The background is fully transparent. Do not move, scale, crop or re-frame anything: same canvas, same pose, " +
  "same position, same size.";

/** Key mode: the base keeps the figures, on a transparent background. */
export const KEEP_CLEAR =
  " Keep EVERYTHING else pixel-identical: same faces, same poses, same bodies, same position, same size, same framing " +
  "and canvas. The background is fully transparent. Do not move, zoom, crop or re-draw anything else.";

/** The sentence an edit of `role` ends with in this brief's mode. */
export function tailOf(brief: CtCharBrief, role: string): string {
  if (brief.clips !== "key" || role.startsWith("zone:")) return KEEP;
  return role === "base" ? KEEP_CLEAR : KEY;
}

const isHair = (part: string) => /hair|tóc/i.test(part);

export function slotLabel(brief: CtCharBrief, subjectIndex: number, slot: CtCharSlot): string {
  const kind = brief.subjects[subjectIndex]?.kind === "pet" ? "Thú" : brief.subjects[subjectIndex]?.kind === "object" ? "Vật" : "Người";
  return `${kind} ${subjectIndex + 1} — ${slot.part}`;
}

function removal(brief: CtCharBrief): string {
  const parts: string[] = [];
  brief.subjects.forEach((sub, i) => {
    for (const slot of sub.slots) {
      if (slot.mode !== "shape") continue;
      const who = subjectRef(brief, i);
      parts.push(
        isHair(slot.part)
          ? `remove ALL the hair of ${who}: a smooth bare bald scalp with natural skin, no hair at all on the head, shoulders or back`
          : `remove the ${slot.part} of ${who} and show what is naturally underneath`,
      );
    }
  });
  return parts.length ? `Make exactly these changes and nothing else: ${parts.join("; ")}.${KEEP}` : "";
}

/** Key mode: the base strips every part a slot changes — what is left is the body every clipart sits on. */
function paperDoll(brief: CtCharBrief): string {
  const parts: string[] = [];
  brief.subjects.forEach((sub, i) => {
    const who = subjectRef(brief, i);
    for (const slot of sub.slots) {
      const p = slot.part.toLowerCase();
      parts.push(
        isHair(slot.part)
          ? `remove ALL the hair of ${who}: a smooth bare bald scalp in her own skin tone, ears visible, no hair on the head, neck, shoulders or back`
          : /dress|outfit|skirt|shirt|top|pants|trousers|bộ|váy|áo|quần/i.test(p) && slot.mode === "shape"
            ? `replace the ${slot.part} of ${who} with a smooth plain one-piece bodysuit in her own skin tone, like a smooth paper-doll body for a dress-up game: no anatomical detail, modest high neckline, covering the torso and hips down to mid-thigh, no skirt, no belt, no bow`
            : /shoe|boot|heel|giày|dép/i.test(p)
              ? `remove the ${slot.part} of ${who}: bare feet in the same pose`
              : /held|hold|item|cầm|glass|cup|mug/i.test(p)
                ? `remove the ${slot.part} of ${who}: the same hand, empty, in the same loosely closed pose`
                : `remove the ${slot.part} of ${who}: what it covered shows the same smooth bodysuit / arms in her own skin tone`,
      );
    }
  });
  // Worded like a paper-doll dress-up base (asked plainly, "remove her dress" is refused by the safety filter).
  return parts.length ? `A family-friendly paper-doll dress-up base of this illustration. Make exactly these changes and nothing else: ${parts.join("; ")}.` : "Keep the picture as it is.";
}

function planKey(brief: CtCharBrief): CtCharEditPlan[] {
  const out: CtCharEditPlan[] = [
    { role: "work", label: "Master làm việc", source: "master", prompt: "" },
    { role: "base", label: "Thân (bỏ mọi phần đổi được — búp bê giấy)", source: "work", prompt: paperDoll(brief) + KEEP_CLEAR, transparent: true },
  ];
  brief.subjects.forEach((sub, i) => {
    const who = subjectRef(brief, i);
    for (const slot of sub.slots) {
      const label = slotLabel(brief, i, slot);
      // Named, not implied: asked to keep "the dress" the model also kept the cardigan and shoes over it (2026-10-10).
      // Each named as the master shows it ("mustard cardigan", "hairstyle (Top Bun)"): a generic "cardigan" was kept.
      const others = sub.slots
        .filter((x) => x !== slot)
        .map((x) => (x.mode === "color" && x.options[0] ? `${x.options[0].name.toLowerCase()} ${x.part.toLowerCase()}` : x.options[0] ? `${x.part.toLowerCase()} (${x.options[0].name.toLowerCase()})` : x.part.toLowerCase()));
      // Worded as "everything magenta EXCEPT …" — tested 2026-10-10: "keep only the dress" kept the cardigan, shoes and
      // face too; this kept the dress alone.
      const keepAs = (what: string) =>
        `Turn EVERYTHING magenta except the ${what} itself of ${who}. Her ${[...others, "face", "arms", "legs"].join(", ")} all become magenta, ` +
        `also where they lie over the ${what}; only the ${what} keeps its drawing and colours, exactly as it is drawn.`;
      if (slot.mode === "shape") {
        const colour = slot.colors[0];
        // Every option from the working master too (tested 2026-10-10: drawn on the transparent paper doll the model
        // re-framed the figures ~10 % bigger and moved the arms — a mug landed beside the hand).
        slot.options.forEach((o, j) =>
          out.push({
            role: `clip:${slot.id}:${o.id}`,
            label: `Clipart ${label}: ${o.name}`,
            source: "work",
            transparent: true,
            prompt:
              (j === 0
                ? keepAs(slot.part)
                : // "Replace" alone kept the master's wrap dress (belt, bow) under the name "skater dress": take it off, say what changes.
                  `Take OFF the ${slot.part} of ${who} (the ${slot.options[0].name.toLowerCase()}) and give her a completely DIFFERENT one: ${o.value || o.name}${colour ? ` in ${colour.name.toLowerCase()} colour (${colour.value})` : ""}. ` +
                  `Nothing of the ${slot.options[0].name.toLowerCase()} stays — not its shape, neckline, belt or details; the same art style, sitting naturally on her in the same pose. ` +
                  `Then turn EVERYTHING magenta except that new ${slot.part}: her ${[...others, "face", "arms", "legs"].join(", ")} all become magenta; only the new ${slot.part} keeps its colours, drawn completely.`) + KEY,
          }),
        );
      } else {
        out.push({ role: `clip:${slot.id}`, label: `Clipart ${label}`, source: "work", transparent: true, prompt: keepAs(slot.part) + KEY });
        if (slot.mode === "texture")
          slot.options.slice(1).forEach((o) =>
            out.push({
              role: `clip:${slot.id}:${o.id}`,
              label: `Clipart ${label}: ${o.name}`,
              source: "work",
              transparent: true,
              prompt: `Change ONLY the material of the ${slot.part} of ${who} to ${o.value || o.name}: the same outline, the same folds and shading. Keep ONLY that ${slot.part}.` + KEY,
            }),
          );
      }
    }
  });
  for (const z of brief.photoZones)
    out.push({ role: `zone:${z.id}`, label: `Vùng ảnh khách: ${z.label}`, source: "base", prompt: `Paint ONLY ${z.where}${FLAT}${KEEP}` });
  return out;
}

export function planEdits(brief: CtCharBrief): CtCharEditPlan[] {
  if (brief.clips === "key") return planKey(brief);
  const out: CtCharEditPlan[] = [{ role: "work", label: "Master làm việc", source: "master", prompt: "" }];
  const shapes = brief.subjects.flatMap((s) => s.slots.filter((sl) => sl.mode === "shape"));
  if (shapes.length) out.push({ role: "base", label: "Bản gốc bỏ các phần đổi kiểu", source: "work", prompt: removal(brief) });
  brief.subjects.forEach((sub, i) => {
    const who = subjectRef(brief, i);
    for (const slot of sub.slots) {
      const label = slotLabel(brief, i, slot);
      if (slot.mode === "shape") {
        if (shapes.length > 1)
          out.push({
            role: `part:${slot.id}`,
            label: `Tô ${label}`,
            source: "work",
            prompt: `Paint ONLY the ${slot.part} of ${who} (all of it that is visible)${FLAT} Everything of the other characters stays as it is.${KEEP}`,
          });
        const colour = slot.colors[0];
        slot.options.slice(1).forEach((o) =>
          out.push({
            role: `shape:${slot.id}:${o.id}`,
            label: `${label}: ${o.name}`,
            source: "base",
            prompt:
              `Give ${who} ${o.value || o.name}${colour ? ` in ${colour.name.toLowerCase()} colour (${colour.value})` : ""}, the same art style as the illustration. ` +
              `Only add the ${slot.part}; the face, ears, neck, clothes of ${who} and everyone else stay exactly as they are.${KEEP}`,
          }),
        );
      } else {
        out.push({
          role: `mask:${slot.id}`,
          label: `Tô ${label}`,
          source: "base",
          prompt: `Paint ONLY the ${slot.part} of ${who}${FLAT} Anything lying over it stays as it is; other characters stay as they are.${KEEP}`,
        });
        if (slot.mode === "texture")
          slot.options.slice(1).forEach((o) =>
            out.push({
              role: `texture:${slot.id}:${o.id}`,
              label: `${label}: ${o.name}`,
              source: "base",
              prompt: `Change ONLY the material of the ${slot.part} of ${who} to ${o.value || o.name}: the same outline, the same folds and shading, only the surface changes.${KEEP}`,
            }),
          );
      }
    }
  });
  for (const z of brief.photoZones)
    out.push({ role: `zone:${z.id}`, label: `Vùng ảnh khách: ${z.label}`, source: "base", prompt: `Paint ONLY ${z.where}${FLAT}${KEEP}` });
  return out;
}
