/**
 * The 3b pictures of a bộ nhân vật as @flexiprint plans them (brief.pictures, asked 2026-10-19: "giao cho agent phân
 * tích nên vẽ gì ở 3b — không dựa vào char-plan được vì phạm vi rất rộng"). The agent decides WHICH pictures exist and
 * what each says; the server only checks the plan (checkPictures), draws it in order (server/char/layers.ts) and cuts
 * it the one way it always cuts (services/layer-kit, pixel lock): a clipart file = the picture's pixels that differ from
 * the doll — or from `against` — on its subject's own side of the canvas.
 *
 * A set without a plan keeps the older built-in one (lib/char-plan.ts). A version set (brief.versionOf) uses its
 * parent's plan as it is: covers and lines of characters it does not have are dropped (activePictures).
 */

import type { CtCharBrief, CtCharPlanPicture, CtCharPictureCover, CtCharPictureLine } from "../types";
import { subjectRef } from "./char-brief";
import { tailOf, type CtCharEditPlan, type CtCharOptionPicture } from "./char-plan";

/** A plan picture's role: the server's own names (base, zone:, thumb:) or the agent's. */
const ROLE = /^[a-z0-9][a-z0-9:._-]{0,79}$/i;
const MAX_PICTURES = 120;

type Obj = Record<string, unknown>;
const rec = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** brief.pictures from JSON (null = no plan of its own). */
export function parsePictures(raw: unknown): CtCharPlanPicture[] | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  const out = raw.slice(0, MAX_PICTURES).map((x): CtCharPlanPicture => {
    const r = rec(x);
    const lines = arr(r.lines)
      .map((l): CtCharPictureLine => ({ subject: s(rec(l).subject, 64), text: s(rec(l).text, 2000) }))
      .filter((l) => l.subject && l.text);
    return {
      role: s(r.role, 80),
      label: s(r.label, 200),
      source: s(r.source, 80) || "base",
      prompt: s(r.prompt, 6000),
      ...(lines.length ? { lines } : {}),
      covers: arr(r.covers)
        .map((c): CtCharPictureCover => ({ slot: s(rec(c).slot, 64), option: s(rec(c).option, 64) }))
        .filter((c) => c.slot && c.option),
      ...(s(r.against, 80) ? { against: s(r.against, 80) } : {}),
      ...(r.fine === true ? { fine: true } : {}),
    };
  });
  return out.length ? out : null;
}

/** Where a slot is: its subject's index and the slot. */
function slotOf(brief: CtCharBrief, slotId: string) {
  for (let i = 0; i < brief.subjects.length; i++) {
    const slot = brief.subjects[i].slots.find((x) => x.id === slotId);
    if (slot) return { subject: i, slot };
  }
  return null;
}

/** The options a set needs a picture for: every option of a shape / texture slot, the first of a colour slot (its
 * other colours are recolours of that file). */
export function neededCovers(brief: CtCharBrief): CtCharPictureCover[] {
  return brief.subjects.flatMap((sub) => sub.slots.flatMap((slot) => (slot.mode === "color" ? slot.options.slice(0, 1) : slot.options).map((o) => ({ slot: slot.id, option: o.id }))));
}

/**
 * The plan's pictures this set uses: covers / lines of characters it does not have dropped (a version set uses its
 * parent's plan), then a picture left with nothing to draw, or whose source / `against` is gone, dropped too.
 */
export function activePictures(brief: CtCharBrief): CtCharPlanPicture[] {
  const subjects = new Set(brief.subjects.map((x) => x.id));
  let list = (brief.pictures ?? []).map((p) => {
    const covers = p.covers.filter((c) => slotOf(brief, c.slot)?.slot.options.some((o) => o.id === c.option));
    const lines = p.lines?.filter((l) => subjects.has(l.subject));
    const empty = (p.covers.length > 0 && !covers.length) || (!!p.lines?.length && !lines?.length && !covers.length && p.role !== "base");
    return empty ? null : { ...p, covers, ...(p.lines ? { lines } : {}) };
  }).filter((p): p is CtCharPlanPicture => p !== null);
  // A thumbnail of an option the set does not have, a zone the set does not have.
  list = list.filter((p) => {
    if (p.role.startsWith("zone:")) return brief.photoZones.some((z) => `zone:${z.id}` === p.role);
    if (p.role.startsWith("thumb:")) {
      const [, slot, option] = p.role.split(":");
      return !!slotOf(brief, slot)?.slot.options.some((o) => o.id === option);
    }
    return true;
  });
  for (let changed = true; changed; ) {
    const roles = new Set(["work", ...list.map((p) => p.role)]);
    const next = list.filter((p) => roles.has(p.source) && (!p.against || roles.has(p.against)));
    changed = next.length !== list.length;
    list = next;
  }
  return list;
}

/** The prompt a picture is drawn with: the change, one line per character ("{who}" filled in), the server's ending. */
export function picturePrompt(brief: CtCharBrief, p: CtCharPlanPicture): string {
  const lines = (p.lines ?? []).map((l) => {
    const i = brief.subjects.findIndex((x) => x.id === l.subject);
    return `- ${l.text.replaceAll("{who}", subjectRef(brief, i))}`;
  });
  // A part drawn in its cut colour (slot cutColor): said by the server, whatever the agent wrote of its real colour.
  const cutColours = new Map<string, string>();
  for (const c of p.covers) {
    const slot = slotOf(brief, c.slot)?.slot;
    if (slot?.cutColor) cutColours.set(slot.part.replace(/\s*\(.*?\)/g, ""), slot.cutColor);
  }
  const cut = [...cutColours].map(([part, hex]) => `Draw the ${part} in solid ${hex} (a cut colour, recoloured later — not its real colour), with all its shading, highlights and strand detail; nothing else in the picture takes that colour.`);
  const body = [p.prompt.replaceAll("{who}", "the character"), ...lines, ...cut].filter(Boolean).join("\n");
  const tail = tailOf(p.role);
  return body.includes(tail.trim()) ? body : body.replace(/\.?\s*$/, ".") + tail;
}

/** The agent's plan as the edits the server draws (lib/char-plan CtCharEditPlan): "work" first. */
export function agentEdits(brief: CtCharBrief): CtCharEditPlan[] {
  return [
    { role: "work", label: "Master làm việc", source: "master", prompt: "" },
    ...activePictures(brief).map((p) => ({ role: p.role, label: p.label || p.role, source: p.source, prompt: picturePrompt(brief, p), ...(p.role.startsWith("zone:") ? {} : { transparent: true }) })),
  ];
}

/** Every option a picture of the plan draws (layer-kit cuts each one's file from it, on its subject's side). */
export function agentOptionPictures(brief: CtCharBrief): CtCharOptionPicture[] {
  return activePictures(brief).flatMap((p) =>
    p.covers.flatMap((c) => {
      const at = slotOf(brief, c.slot);
      const index = at ? at.slot.options.findIndex((o) => o.id === c.option) : -1;
      if (!at || index < 0) return [];
      return [{ slot: at.slot, subject: at.subject, index, role: p.role, pictureId: `pic.${p.role}`, fine: p.fine === true, ...(p.against ? { against: p.against } : {}) }];
    }),
  );
}

/** What is wrong with a plan for this set (empty = it can be drawn and cut). `strict` = it is the set's own (written
 * for it): every cover, line and role must exist; a version set's copy of its parent's plan is filtered instead. */
export function checkPictures(brief: CtCharBrief, list: CtCharPlanPicture[], strict = true): string[] {
  const errors: string[] = [];
  const roles = new Map<string, CtCharPlanPicture>();
  if (list.length > MAX_PICTURES) errors.push(`At most ${MAX_PICTURES} pictures (one is ~1 min of the image API) — group options into fewer pictures.`);
  for (const p of list) {
    if (!ROLE.test(p.role) || p.role === "work" || p.role === "master") errors.push(`role "${p.role}": letters, digits and : . _ - only (not "work" / "master")`);
    else if (roles.has(p.role)) errors.push(`role "${p.role}" twice`);
    roles.set(p.role, p);
  }
  const base = roles.get("base");
  if (!base) errors.push('No "base" picture — the paper doll (the body file, drawn from "work") is required');
  else if (base.source !== "work") errors.push('"base" must be drawn from "work" (the approved master)');
  if (base?.covers.length) errors.push('"base" is the doll: it covers no option');
  const subjects = new Set(brief.subjects.map((x) => x.id));
  for (const p of list) {
    const at = `"${p.role}"`;
    if (!p.prompt && !p.lines?.length) errors.push(`${at}: no prompt`);
    if (p.source !== "work" && !roles.has(p.source)) errors.push(`${at}: source "${p.source}" is not a picture of the plan (or "work")`);
    if (p.role !== "base" && p.source === "work") errors.push(`${at}: only "base" is drawn from "work" — draw it from the doll or another picture`);
    if (p.against) {
      const host = roles.get(p.against);
      if (!host || p.against === p.role) errors.push(`${at}: against "${p.against}" is not another picture of the plan`);
      else if (!host.covers.length) errors.push(`${at}: against "${p.against}" — cut against a picture that itself draws options`);
    }
    if (p.role.startsWith("zone:")) {
      if (!brief.photoZones.some((z) => `zone:${z.id}` === p.role)) errors.push(`${at}: no photo zone "${p.role.slice(5)}" in the brief`);
      if (p.covers.length) errors.push(`${at}: a zone picture covers no option`);
    }
    if (p.role.startsWith("thumb:")) {
      const [, slot, option] = p.role.split(":");
      if (!slotOf(brief, slot)?.slot.options.some((o) => o.id === option)) errors.push(`${at}: thumb:<slot id>:<option id> — no such option`);
      if (p.covers.length) errors.push(`${at}: a thumbnail is never cut — it covers no option`);
    }
    if (strict) for (const l of p.lines ?? []) if (!subjects.has(l.subject)) errors.push(`${at}: line for subject "${l.subject}" — not a subject id of the brief`);
    // One slot per subject: two parts of one character in one picture would both be cut as everything it added there.
    const bySubject = new Map<number, string>();
    for (const c of p.covers) {
      const where = slotOf(brief, c.slot);
      if (!where) {
        if (strict) errors.push(`${at}: covers slot "${c.slot}" — not a slot id of the brief`);
        continue;
      }
      if (!where.slot.options.some((o) => o.id === c.option)) {
        if (strict) errors.push(`${at}: slot "${c.slot}" has no option "${c.option}"`);
        continue;
      }
      if (bySubject.has(where.subject)) errors.push(`${at}: covers two parts of subject ${where.subject + 1} ("${bySubject.get(where.subject)}" and "${c.slot}") — a picture draws ONE part per character; split it`);
      bySubject.set(where.subject, c.slot);
    }
  }
  // Every option the set needs: drawn by exactly one picture.
  const count = new Map<string, number>();
  for (const p of list) for (const c of p.covers) count.set(`${c.slot}#${c.option}`, (count.get(`${c.slot}#${c.option}`) ?? 0) + 1);
  const needed = neededCovers(brief);
  const need = new Set(needed.map((c) => `${c.slot}#${c.option}`));
  const missing = needed.filter((c) => !count.has(`${c.slot}#${c.option}`)).map((c) => `${c.slot}/${c.option}`);
  if (missing.length) errors.push(`No picture draws: ${missing.join(", ")}`);
  const twice = [...count].filter(([k, n]) => n > 1 && need.has(k)).map(([k]) => k.replace("#", "/"));
  if (twice.length) errors.push(`Drawn by more than one picture: ${twice.join(", ")}`);
  const recolours = [...count.keys()].filter((k) => !need.has(k) && slotOf(brief, k.split("#")[0])?.slot.mode === "color").map((k) => k.replace("#", "/"));
  if (recolours.length) errors.push(`Colour slots draw only their FIRST option (the others are recolours of it): ${recolours.join(", ")}`);
  for (const z of brief.photoZones) if (!roles.has(`zone:${z.id}`)) errors.push(`No "zone:${z.id}" picture (photo zone "${z.label}" painted magenta on the doll)`);
  // Drawn in order: no picture waits for itself.
  const state = new Map<string, 1 | 2>();
  const visit = (role: string, path: string[]): void => {
    if (role === "work" || state.get(role) === 2) return;
    if (state.get(role) === 1) {
      errors.push(`Loop: ${[...path, role].join(" → ")}`);
      return;
    }
    const p = roles.get(role);
    if (!p) return;
    state.set(role, 1);
    visit(p.source, [...path, role]);
    if (p.against) visit(p.against, [...path, role]);
    state.set(role, 2);
  };
  for (const role of roles.keys()) visit(role, []);
  return [...new Set(errors)];
}

/**
 * How @flexiprint plans the 3b pictures (get_task "picturePlan.rules", the MCP char_plan_pictures). English: it goes
 * to the agent.
 */
export const PICTURE_PLAN_RULES = [
  "YOU decide which 3b pictures a set needs (char_plan_pictures) — no rule in the code does: read the brief, the approved master, the references, then plan the pictures that give every option a clean cut. Each picture is ~1 min of the image API. Since 2026-10-21 a set with several characters is drawn pose by pose (brief.poses): each pose set has ONE character, so each picture draws that one character's option — never several characters in one picture (their hair and hats stuck together when cut).",
  "How the server cuts (fixed, pixel lock — never ask for another way): the doll (role \"base\") is the body file. Every other picture is an IN-PLACE edit; a clipart file of an option = that picture's pixels that differ from the doll (or from its `against` picture), only on that option's subject's own side of the canvas (the subjects must stand apart), only the main piece and what is near it; nothing in the doll's magenta (a chroma key). So: stacked on the doll a file IS exactly what the picture added — what you see in a picture is what the customer gets.",
  "A picture: {role, label (Vietnamese), source, prompt, lines?, covers, against?, fine?}.",
  "- base (required): drawn from \"work\" (the approved master): the paper doll = every part any option replaces taken off — bald where hair is an option, a flat bright magenta (#D81BD8) snug tank top / shorts where clothes are, blank face where expressions are, empty hands where held items are, nothing on the head where hats are. Word it as a family-friendly paper-doll dress-up base (\"remove her dress\" is refused). Bodies keep exactly their shape and pose. Parts nobody changes stay as in the master.",
  "- covers: [{slot, option}] (slot id, option id from the brief) = the options this picture draws. EVERY option of a shape / texture slot needs exactly one picture; a colour slot only its FIRST option (the other colours are recolours of that file); a shape slot's `colors` are recolours too. At most ONE slot per subject in one picture (two parts of one character in one picture are cut as one blob) — but one picture may draw the same kind of part for EVERY character (option k of each grandchild's hair: one picture, a line per character). Options of a slot are matched by id, not position.",
  "- source: what it is drawn on — \"base\" for most; another picture when the part must sit on something drawn there (hair drawn UNDER the hats of the outfit picture: source = the outfit picture, against = it too; the other themes' hats drawn from the Christmas ones so their band is the same: source = the Christmas outfit picture, cut against the doll).",
  "- against: cut against that picture instead of the doll (only what this picture adds over it is the option). It must be a picture that itself covers options.",
  "- hats and hair: the hair is drawn UNDER each theme's hat — the hair slot of a theme (sameAs the first) draws its options on THAT theme's outfit picture (source = against = it), the SAME styles in the same order and colours, so the customer's pick looks the same under every hat.",
  "- prompt: English, the change said once (\"Give each listed character the hairstyle written for them, drawn UNDER their hat …\"); lines: [{subject: subject id, text}] — one per character (\"{who}: long wavy hair\"; {who} is filled with how the image model is told which character it is). Lines of a character a version does not have are dropped automatically, so ALWAYS put per-character wording in lines, never in the prompt. Do not write the keep-everything ending: the server adds it (transparent background, nothing else moves).",
  "- cut colour: a slot with cutColor (its real colours too close to what it lies on) is drawn in that colour — the server adds the sentence to every picture that covers it; do not name its real colour in that prompt (\"short curly hair\", not \"silver-grey curly hair\"). Its files are recoloured to every colour the customer picks.",
  "- fine: true for thin features on a blank face (eyes, brows, mouth): small pieces kept.",
  "- zone:<photo zone id> (one per brief.photoZones, required): drawn from base, \"Paint ONLY <where> solid flat pure magenta #FF00FF …\" (drawn on white).",
  "- thumb:<slot id>:<option id> (optional): a held item drawn ALONE and complete from the picture that covers it (source = that picture) — only the option's thumbnail in the shop, never cut.",
  "- any other role you like for a picture that is only a source / against (covers [] allowed).",
  "Check yourself: does every option's picture ADD it to what it is drawn on without moving the doll? Would two options of one picture touch on the same character? Is a part that hides another (a hat over hair, a jacket over a top) drawn so the hidden part is cut against the right picture? A lineup drawn version by version: plan the biggest set; each version set uses that plan (its missing characters' covers / lines dropped) — plan BEFORE approving the version masters.",
].join("\n");
