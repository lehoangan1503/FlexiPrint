/**
 * The Mockups box's scene prompts (asked 2026-11-17): one AI photo per prompt, the split found by itself —
 *   a line that is only "---"   splits there (a prompt may then run over many lines)
 *   else an empty line          splits there
 *   else                        one prompt per line (as before)
 * No limit on how many prompts or how long (asked 2026-11-18: "không giới hạn số lời dặn, số kí tự") — the editor shows how many photos it makes.
 * The material / print-keeping sentences are added on the server (server/product-mockups.ts) — a prompt only says
 * where the product is and what is around it.
 */

export type CtSceneSplit = "dash" | "blank" | "line";

/** The prompts in the box's text, whole (not cut), and how they were split. */
export function splitScenes(text: string): { scenes: string[]; split: CtSceneSplit } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const join = (groups: string[][]) => groups.map((g) => g.map((l) => l.trim()).filter(Boolean).join("\n")).filter(Boolean);
  if (lines.some((l) => /^\s*-{3,}\s*$/.test(l))) {
    const groups: string[][] = [[]];
    for (const l of lines) {
      if (/^\s*-{3,}\s*$/.test(l)) groups.push([]);
      else groups[groups.length - 1].push(l);
    }
    return { scenes: join(groups), split: "dash" };
  }
  const nonEmpty = lines.map((l) => l.trim());
  const firstText = nonEmpty.findIndex(Boolean);
  let lastText = -1;
  for (let i = nonEmpty.length - 1; i >= 0; i--) if (nonEmpty[i]) { lastText = i; break; }
  if (firstText >= 0 && nonEmpty.slice(firstText, lastText + 1).some((l) => !l)) {
    const groups: string[][] = [[]];
    for (const l of lines) {
      if (!l.trim()) groups.push([]);
      else groups[groups.length - 1].push(l);
    }
    return { scenes: join(groups), split: "blank" };
  }
  return { scenes: nonEmpty.filter(Boolean), split: "line" };
}

/** Scenes that suit the product, as a start (the editor rewrites them; a bulk "Tạo mockup" uses them when the box was never used). */
export function defaultScenes(name: string): string[] {
  const n = name.toLowerCase();
  if (/ornament/.test(n)) return ["hanging by a red satin ribbon on a decorated Christmas tree with warm fairy lights", "held in a hand in front of a cosy fireplace, soft bokeh", "flat lay on a wooden table with pine branches, pine cones and wrapped gifts"];
  if (/mug|cup|ly/.test(n)) return ["on a wooden breakfast table with coffee beans and morning light", "held in two hands by a window, cosy knit sweater"];
  if (/bag|túi|tote/.test(n)) return ["carried on the shoulder of a woman walking in a sunny street", "flat lay on a bed with a magazine and sunglasses"];
  return ["on a bright minimal table with soft daylight and a few matching props", "in a cosy home setting, warm natural light"];
}
