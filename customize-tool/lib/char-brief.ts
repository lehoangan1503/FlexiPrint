/**
 * v2 brief helpers shared by the page and the server: defaults, a tolerant parser (briefs come from the editor,
 * the LLM and the agent), and the ONE master prompt assembled from a brief. Edit prompts live in server/char.
 */

import type {
  CtCharBrief,
  CtCharCut,
  CtCharOption,
  CtCharPhotoZone,
  CtCharRef,
  CtCharRefUse,
  CtCharSlot,
  CtCharSlotMode,
  CtCharSubject,
  CtCharSubjectKind,
} from "../types";

const uid = (): string => crypto.randomUUID();

export const REF_USES: CtCharRefUse[] = ["sample", "style", "character", "outfit", "pose", "product", "avoid"];

/** Vietnamese label + what the image model is told to take (null = not sent to the image model). */
export const REF_USE_INFO: Record<CtCharRefUse, { label: string; take: string | null }> = {
  sample: {
    label: "Mẫu hoàn chỉnh",
    take: "its drawing style, how its characters look, their outfits and their pose — drawn as a NEW clean illustration: no background scenery, no frame or product shape, no text, no decorations",
  },
  style: { label: "Phong cách", take: "ONLY its drawing style: rendering, line work, palette, proportions" },
  character: { label: "Nhân vật", take: "ONLY how the character looks (face, hair, body / breed, colours)" },
  outfit: { label: "Trang phục", take: "ONLY the clothes / accessories" },
  pose: { label: "Dáng / bố cục", take: "ONLY the pose and arrangement" },
  product: { label: "Sản phẩm", take: null },
  avoid: { label: "Tránh", take: null },
};

export function defaultCharBrief(): CtCharBrief {
  return {
    idea: "",
    product: { label: "", cut: "rect", widthMm: 0, heightMm: 0, blankId: null },
    style: "",
    refs: [],
    scene: "",
    subjects: [],
    photoZones: [],
    text: { enabled: false, defaultText: "", font: "Great Vibes", place: "" },
    decor: "",
    mockups: [],
    clips: "key",
  };
}

export function newCharOption(name = "", value = ""): CtCharOption {
  return { id: uid(), name, value };
}

export function newCharSlot(part = "", mode: CtCharSlotMode = "color"): CtCharSlot {
  return { id: uid(), part, mode, options: [], colors: [], wraps: /hair|tóc|scarf|khăn/i.test(part) };
}

export function newCharSubject(kind: CtCharSubjectKind = "person", description = ""): CtCharSubject {
  return { id: uid(), kind, description, slots: [] };
}

export function newPhotoZone(where = "", label = "Your photo"): CtCharPhotoZone {
  return { id: uid(), where, label };
}

// ---- tolerant parsing -------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const rec = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown, max = 2000): string => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "");
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n * 10) / 10, 5000) : 0;
};
const idOf = (v: unknown): string => (typeof v === "string" && /^[\w-]{1,64}$/.test(v) ? v : uid());
const uuidOrNull = (v: unknown): string | null => (typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v : null);

const CUTS: CtCharCut[] = ["rect", "alpha", "frame"];
const MODES: CtCharSlotMode[] = ["color", "texture", "shape"];
const KINDS: CtCharSubjectKind[] = ["person", "pet", "object"];

/** #rgb / #rrggbb → #rrggbb; anything else stays as written (a colour word is fine for the AI). */
function hexOr(v: string): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (!m) return v;
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return `#${h.toLowerCase()}`;
}

function parseOption(raw: unknown, mode: CtCharSlotMode | "color"): CtCharOption | null {
  const o = typeof raw === "string" ? { name: raw } : rec(raw);
  const name = s(o.name, 80);
  let value = s(o.value, 400) || s(o.hex, 20) || s(o.description, 400);
  if (mode === "color") value = hexOr(value);
  if (!name && !value) return null;
  return { id: idOf(o.id), name: name || value, value };
}

function parseSlot(raw: unknown): CtCharSlot | null {
  const o = rec(raw);
  const part = s(o.part, 80);
  if (!part) return null;
  const mode = MODES.includes(o.mode as CtCharSlotMode) ? (o.mode as CtCharSlotMode) : "color";
  return {
    id: idOf(o.id),
    part,
    mode,
    options: arr(o.options).map((x) => parseOption(x, mode)).filter((x): x is CtCharOption => x !== null).slice(0, 24),
    colors: mode === "shape" ? arr(o.colors).map((x) => parseOption(x, "color")).filter((x): x is CtCharOption => x !== null).slice(0, 16) : [],
    wraps: typeof o.wraps === "boolean" ? o.wraps : mode === "shape" && /hair|tóc|scarf|khăn/i.test(part),
  };
}

function parseSubject(raw: unknown): CtCharSubject | null {
  const o = rec(raw);
  const description = s(o.description, 600);
  if (!description) return null;
  return {
    id: idOf(o.id),
    kind: KINDS.includes(o.kind as CtCharSubjectKind) ? (o.kind as CtCharSubjectKind) : "person",
    description,
    slots: arr(o.slots).map(parseSlot).filter((x): x is CtCharSlot => x !== null).slice(0, 12),
  };
}

export function parseCharBrief(raw: unknown): CtCharBrief {
  const o = rec(raw);
  const d = defaultCharBrief();
  const p = rec(o.product);
  const t = rec(o.text);
  return {
    idea: s(o.idea, 4000),
    product: {
      label: s(p.label, 200),
      cut: CUTS.includes(p.cut as CtCharCut) ? (p.cut as CtCharCut) : d.product.cut,
      widthMm: num(p.widthMm),
      heightMm: num(p.heightMm),
      blankId: uuidOrNull(p.blankId),
      templateId: uuidOrNull(p.templateId),
      layout: s(p.layout, 600),
    },
    style: s(o.style, 1000),
    refs: arr(o.refs)
      .map((x): CtCharRef | null => {
        const r = rec(x);
        const id = uuidOrNull(r.id);
        return id ? { id, use: REF_USES.includes(r.use as CtCharRefUse) ? (r.use as CtCharRefUse) : "sample", note: s(r.note, 600) } : null;
      })
      .filter((x): x is CtCharRef => x !== null)
      .slice(0, 12),
    scene: s(o.scene, 1000),
    subjects: arr(o.subjects).map(parseSubject).filter((x): x is CtCharSubject => x !== null).slice(0, 8),
    photoZones: arr(o.photoZones)
      .map((z) => {
        const r = rec(z);
        const where = s(r.where, 300);
        return where ? { id: idOf(r.id), where, label: s(r.label, 80) || "Your photo" } : null;
      })
      .filter((x): x is CtCharPhotoZone => x !== null)
      .slice(0, 4),
    text: {
      enabled: t.enabled === true || (t.enabled === undefined && !!s(t.defaultText)),
      defaultText: s(t.defaultText, 80),
      font: s(t.font, 80) || d.text.font,
      place: s(t.place, 200),
    },
    decor: s(o.decor, 1000),
    mockups: arr(o.mockups).map((m) => s(m, 300)).filter(Boolean).slice(0, 6),
    // A brief saved before "key" existed keeps its painted regions.
    clips: o.clips === "key" ? "key" : "paint",
  };
}

// ---- the master prompt ------------------------------------------------------------------------------------

const ORDINAL = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];

const KIND_WORD: Record<CtCharSubject["kind"], string> = { person: "person", pet: "animal", object: "object" };

/**
 * How the AI is told which subject a sentence is about: its rank among subjects of the SAME kind (a pet sitting
 * between two people must not shift "the third from the left"), what it is, and what it wears in the master —
 * "the third person from the left (the Older daughter, in the green #32cd32 sweater)". Tested 2026-10-08: plain
 * "third character from the left" put an edit on the wrong girl when the dog sat between them.
 */
export function subjectRef(brief: CtCharBrief, index: number): string {
  const sub = brief.subjects[index];
  if (!sub) return "the character";
  const short = sub.description.split(/[,.;]/)[0].trim();
  const same = brief.subjects.filter((x) => x.kind === sub.kind);
  const rank = same.indexOf(sub);
  const wears = sub.slots
    .filter((sl) => sl.mode === "color" && sl.options[0])
    .map((sl) => `${sl.options[0].name.toLowerCase()}${/^#[0-9a-f]{6}$/i.test(sl.options[0].value) ? ` ${sl.options[0].value}` : ""} ${sl.part.replace(/\s*(colou?r|màu)\s*/gi, " ").trim().toLowerCase()}`)
    .slice(0, 2);
  const look = [short ? `the ${short}` : "", wears.length ? `in the ${wears.join(" and ")}` : ""].filter(Boolean).join(", ");
  if (brief.subjects.length <= 1) return look || "the character";
  const where =
    same.length === 1
      ? `the ${KIND_WORD[sub.kind]}`
      : rank === 0
        ? `the leftmost ${KIND_WORD[sub.kind]}`
        : rank === same.length - 1
          ? `the rightmost ${KIND_WORD[sub.kind]}`
          : `the ${ORDINAL[rank] ?? `#${rank + 1}`} ${KIND_WORD[sub.kind]} from the left`;
  return look ? `${where} (${look})` : where;
}

/** The look a slot has in the master: its first option (+ first colour for a shape). */
function slotLook(slot: CtCharSlot): string {
  const first = slot.options[0];
  if (!first) return "";
  if (slot.mode === "color") {
    const hex = /^#[0-9a-f]{6}$/.test(first.value) ? ` (${first.value})` : first.value && first.value !== first.name ? ` (${first.value})` : "";
    return `plain solid ${first.name.toLowerCase()}${hex} ${slot.part}, no pattern, no logo, no text`;
  }
  if (slot.mode === "texture") return `${slot.part}: ${first.value || first.name}`;
  const colour = slot.colors[0];
  return `${slot.part}: ${first.value || first.name}${colour ? `, ${colour.name.toLowerCase()}${/^#/.test(colour.value) ? ` (${colour.value})` : ""} colour` : ""}`;
}

/**
 * ONE prompt for the master, from the brief. Everything the layers need is asked here once: every subject full,
 * on flat white, customizable parts plain and readable, photo zones left empty — the later steps are in-place
 * edits of this picture, never new pictures.
 */
export function masterPrompt(brief: CtCharBrief): string {
  const lines: string[] = [];
  lines.push(brief.style ? `${brief.style.replace(/\.$/, "")}.` : "Cute stylized cartoon illustration, soft painterly 3D-cartoon rendering, premium personalized gift print.");
  if (brief.subjects.length > 1) {
    lines.push(`${brief.subjects.length} characters, from left to right:`);
  }
  brief.subjects.forEach((sub, i) => {
    const looks = sub.slots.map(slotLook).filter(Boolean);
    const head = brief.subjects.length > 1 ? `${i + 1}. ` : "";
    lines.push(`${head}${sub.description.replace(/\.$/, "")}${looks.length ? `; ${looks.join("; ")}` : ""}.`);
  });
  if (brief.scene) lines.push(`Arrangement: ${brief.scene.replace(/\.$/, "")}.`);
  if (brief.product.layout) lines.push(`On the product: ${brief.product.layout.replace(/\.$/, "")}.`);
  for (const z of brief.photoZones) lines.push(`${z.where}: an empty plain light-grey area with a clean edge (a photo goes there later).`);
  lines.push(
    brief.subjects.length > 1
      ? "Everyone fully visible head to toe, nobody cropped, the group centred with a generous empty margin all around; they may touch, but no one hides another one's clothes, hair or face."
      : "Full body, fully visible, not cropped, centred with a generous empty margin all around.",
  );
  lines.push("No accessories or props unless described. No text, no logo, no watermark.");
  lines.push(
    brief.clips === "key"
      ? "A fully transparent background (the characters alone, cut out), no floor, no cast shadow, no scenery."
      : "Pure flat white background (#FFFFFF), no floor, no cast shadow, no scenery.",
  );
  return lines.join("\n");
}

/** Problems that would make layers impossible or wrong — shown before the master is made. */
export function briefProblems(brief: CtCharBrief): string[] {
  const out: string[] = [];
  if (!brief.subjects.length) out.push("Chưa có nhân vật nào.");
  brief.subjects.forEach((sub, i) => {
    sub.slots.forEach((slot) => {
      if (!slot.options.length) out.push(`Nhân vật ${i + 1}: phần "${slot.part}" chưa có lựa chọn nào (lựa chọn đầu = như trong master).`);
      if (slot.mode === "color" && slot.options.some((o) => !/^#[0-9a-f]{6}$/.test(o.value)))
        out.push(`Nhân vật ${i + 1}: phần "${slot.part}" đổi màu — mỗi màu cần mã #rrggbb.`);
      if (slot.mode === "shape" && slot.colors.some((o) => !/^#[0-9a-f]{6}$/.test(o.value)))
        out.push(`Nhân vật ${i + 1}: màu của "${slot.part}" cần mã #rrggbb.`);
    });
  });
  if (brief.product.cut === "alpha" && brief.decor) out.push("Sản phẩm cắt viền (alpha): trang trí nền sẽ nằm trong đường cắt — chắc chắn muốn vậy?");
  return out;
}

/** Number of finished files the set will have (what the customer can combine). */
export function briefCombos(brief: CtCharBrief): number {
  let n = 1;
  for (const sub of brief.subjects)
    for (const slot of sub.slots) n *= Math.max(1, slot.options.length) * (slot.mode === "shape" ? Math.max(1, slot.colors.length) : 1);
  return n;
}
