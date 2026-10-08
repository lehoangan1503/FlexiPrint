/**
 * The in-place edits a brief needs, derived — never typed by the editor. Every edit is made FROM the working master
 * (or from the base, itself an edit of the working master), with the same "keep everything else" sentence, so
 * every file lands on the same pixels (flexiprint://guide/layer-rules §5).
 *
 *   work                 the approved master (a copy: the print upscale happens in layer-kit, after registration)
 *   base                 every "shape" part removed (bald heads, no hats) — only when the brief has shape slots
 *   part:<slot>          a shape part painted magenta on the work master (splits the master's parts between slots)
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
}

export const KEEP =
  " Keep EVERYTHING else pixel-identical: same faces, same poses, same bodies, same clothes, same position, same size, " +
  "same framing and canvas, same white background. Do not move, zoom, crop or re-draw anything else.";

const FLAT = " solid flat pure magenta #FF00FF, no shading, no texture, no outline change.";

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

export function planEdits(brief: CtCharBrief): CtCharEditPlan[] {
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
