/**
 * v2 brief helpers shared by the page and the server: defaults, a tolerant parser (briefs come from the editor,
 * the LLM and the agent), and the ONE master prompt assembled from a brief. Edit prompts live in server/char.
 */

import { CT_FONTS } from "../config";
import type {
  CtCharBackdrop,
  CtCharBox,
  CtCharBrief,
  CtCharImported,
  CtCharChooser,
  CtCharShownWhen,
  CtCharElement,
  CtCharElementPlace,
  CtCharLineup,
  CtCharVersionOf,
  CtCharPose,
  CtCharComposePerson,
  CtCharComposeVersion,
  CtCharPhotoTreat,
  CtCharSetKind,
  CtCharCut,
  CtCharOption,
  CtCharPhotoZone,
  CtCharRef,
  CtCharRefUse,
  CtCharSlot,
  CtCharSlotMode,
  CtCharSubject,
  CtCharSubjectKind,
  CtCharTextField,
  CtCharTextPlace,
} from "../types";
import { parsePictures } from "./char-pictures";

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

export function defaultCharBrief(kind: CtCharSetKind = "character"): CtCharBrief {
  return {
    kind,
    idea: "",
    product: { label: "", cut: "rect", widthMm: 0, heightMm: 0, blankId: null },
    style: "",
    refs: [],
    scene: "",
    subjects: [],
    photoZones: [],
    elements: [],
    lineup: null,
    framing: "full",
    texts: [],
    backdrops: [],
    mockups: [],
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

export function newTextField(place: CtCharTextPlace = "bottom", kind: CtCharTextField["kind"] = "input"): CtCharTextField {
  return { id: uid(), label: kind === "choice" ? "Choose your text" : "Enter name", kind, defaultText: kind === "input" ? "Jessica" : "", choices: [], font: "Great Vibes", color: "#1d1d1f", place, maxChars: 20 };
}

export function newBackdrop(name = "", value = ""): CtCharBackdrop {
  return { id: uid(), name, value };
}

export function newPhotoZone(where = "", label = "Your photo", treat: CtCharPhotoTreat = "photo"): CtCharPhotoZone {
  return { id: uid(), where, label, treat, styles: [], box: null };
}

export function newElement(name = "", place: CtCharElementPlace = "behind"): CtCharElement {
  return { id: uid(), name, place, mode: "shape", options: [], perBackdrop: place === "bottom", box: null, follows: null, front: false };
}

/** Vietnamese labels of a bộ nhân vật's element places (around the characters, not a customer photo). */
export const CHAR_ELEMENT_PLACE_LABEL: Record<CtCharElementPlace, string> = {
  behind: "Sau nhân vật, toả 2 bên",
  above: "Trên đầu nhân vật",
  bottom: "Dải dưới (nền đất, mây)",
  free: "Tự đặt (ô vị trí)",
  plaque: "Biển trước nhân vật (tay tì lên)",
};

/** Vietnamese labels of a bộ ảnh khách's element places. */
export const ELEMENT_PLACE_LABEL: Record<CtCharElementPlace, string> = {
  behind: "Sau ảnh khách (cánh)",
  above: "Trên đầu (vòng sáng, vương miện)",
  bottom: "Dải dưới che phần cắt (mây, hoa)",
  free: "Tự đặt",
  plaque: "Biển phía trước",
};

/** Vietnamese labels of how a zone shows the customer's photo. */
export const PHOTO_TREAT_LABEL: Record<CtCharPhotoTreat, string> = {
  ai: "AI vẽ lại theo style khách chọn",
  face: "Chỉ lấy khuôn mặt (tự tìm mặt)",
  photo: "Giữ nguyên ảnh",
};

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
const ELEMENT_PLACES: CtCharElementPlace[] = ["behind", "above", "bottom", "free", "plaque"];
const TREATS: CtCharPhotoTreat[] = ["ai", "face", "photo"];
const AI_REF = /^ai:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A chooser condition (brief.choosers), else null. */
function parseShownWhen(raw: unknown): CtCharShownWhen | null {
  const o = rec(raw);
  return typeof o.chooser === "string" && o.chooser && typeof o.option === "string" && o.option ? { chooser: o.chooser, option: o.option } : null;
}

function parseChooser(raw: unknown): CtCharChooser | null {
  const o = rec(raw);
  const label = s(o.label, 80);
  const options = arr(o.options).map((x) => parseOption(x, "shape")).filter((x): x is CtCharOption => x !== null).slice(0, 8);
  if (!label || options.length < 2) return null;
  return { id: idOf(o.id), label, options, subject: typeof o.subject === "string" && o.subject ? o.subject : null };
}

/** Does a part / text / decoration exist while each chooser shows its first (default) option — is it in the master? */
export function shownByDefault(brief: CtCharBrief, w: CtCharShownWhen | null | undefined): boolean {
  if (!w) return true;
  const c = (brief.choosers ?? []).find((x) => x.id === w.chooser);
  return !c || c.options[0]?.id === w.option;
}

/** A box of shares (0–1), clamped; null when it is not a usable one. */
function parseBox(raw: unknown): CtCharBox | null {
  const o = rec(raw);
  const f = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1.2, Math.max(-0.2, v)) : NaN);
  const b = { x: f(o.x), y: f(o.y), w: f(o.w), h: f(o.h) };
  return [b.x, b.y, b.w, b.h].every(Number.isFinite) && b.w > 0.02 && b.h > 0.02 ? b : null;
}

function parsePhotoZone(raw: unknown): CtCharPhotoZone | null {
  const r = rec(raw);
  const where = s(r.where, 300);
  if (!where) return null;
  const treat = TREATS.includes(r.treat as CtCharPhotoTreat) ? (r.treat as CtCharPhotoTreat) : "photo";
  const styles = arr(r.styles).filter((x): x is string => typeof x === "string" && AI_REF.test(x)).slice(0, 12);
  const testPhotos = arr(r.testPhotos).filter((x): x is string => typeof x === "string" && /^https?:\/\//.test(x)).slice(0, 6);
  return { id: idOf(r.id), where, label: s(r.label, 80) || "Your photo", treat, styles: treat === "ai" ? styles : [], ...(testPhotos.length ? { testPhotos } : {}), box: parseBox(r.box) };
}

function parseElement(raw: unknown): CtCharElement | null {
  const o = rec(raw);
  const name = s(o.name, 80);
  if (!name) return null;
  const place = ELEMENT_PLACES.includes(o.place as CtCharElementPlace) ? (o.place as CtCharElementPlace) : "free";
  const mode = o.mode === "color" ? "color" : "shape";
  const perBackdrop = o.perBackdrop === true;
  return {
    id: idOf(o.id),
    name,
    place,
    mode: perBackdrop ? "shape" : mode,
    options: arr(o.options).map((x) => parseOption(x, mode)).filter((x): x is CtCharOption => x !== null).slice(0, 12),
    perBackdrop,
    box: parseBox(o.box),
    follows: typeof o.follows === "string" && o.follows ? o.follows : null,
    front: o.front === true,
    shownWhen: parseShownWhen(o.shownWhen),
  };
}
const PLACES: CtCharTextPlace[] = ["top", "bottom", "left", "right", "under", "free", "on", "plaque"];

function parseTextField(raw: unknown): CtCharTextField | null {
  const o = rec(raw);
  const choices = arr(o.choices).map((c) => s(c, 120)).filter(Boolean).slice(0, 30);
  const kind = o.kind === "fixed" ? "fixed" : o.kind === "choice" || (o.kind === undefined && choices.length > 0) ? "choice" : "input";
  const defaultText = s(o.defaultText, 120) || (kind === "choice" ? (choices[0] ?? "") : "");
  if (kind === "choice" ? !choices.length : !defaultText && !s(o.label)) return null;
  const font = s(o.font, 80);
  const color = hexOr(s(o.color, 20));
  return {
    id: idOf(o.id),
    label: s(o.label, 80) || (kind === "choice" ? "Choose your text" : "Enter name"),
    kind,
    defaultText,
    choices: kind === "choice" ? choices : [],
    font: CT_FONTS.some((f) => f.family === font) ? font : "Great Vibes",
    color: /^#[0-9a-f]{6}$/.test(color) ? color : "#1d1d1f",
    place: PLACES.includes(o.place as CtCharTextPlace) ? (o.place as CtCharTextPlace) : "bottom",
    maxChars: Math.min(60, Math.max(1, Math.round(num(o.maxChars)) || Math.max(20, ...choices.map((c) => c.length)))),
    subject: typeof o.subject === "string" && o.subject ? o.subject : null,
    box: parseBox(o.box),
    uppercase: o.uppercase === true,
    shownWhen: parseShownWhen(o.shownWhen),
    curve: typeof o.curve === "number" && Number.isFinite(o.curve) ? Math.max(-100, Math.min(100, Math.round(o.curve))) : 0,
    ...(o.band === true ? { band: true } : {}),
  };
}
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
    optional: o.optional === true,
    follows: typeof o.follows === "string" && o.follows ? o.follows : null,
    shownWhen: parseShownWhen(o.shownWhen),
    group: typeof o.group === "string" && /^[\w-]{1,40}$/.test(o.group) ? o.group : null,
    on: typeof o.on === "string" && /^[\w-]{1,40}$/.test(o.on) ? o.on : null,
    restyle: o.restyle === true,
    headwear: o.headwear === true,
    sameAs: typeof o.sameAs === "string" && /^[\w-]{1,40}$/.test(o.sameAs) ? o.sameAs : null,
    cutColor: typeof o.cutColor === "string" && o.cutColor ? hexOr(o.cutColor) : null,
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
    name: s(o.name, 40),
    always: o.always === true,
  };
}

function parseLineup(raw: unknown): CtCharLineup | null {
  const o = rec(raw);
  if (o.mode !== "one" && o.mode !== "count") return null;
  return { mode: o.mode, label: s(o.label, 80) || (o.mode === "one" ? "Choose character" : "Number of people"), ...(o.drawn === true ? { drawn: true } : {}) };
}

function parseVersionOf(raw: unknown): CtCharVersionOf | null {
  const o = rec(raw);
  const id = uuidOrNull(o.id);
  const pose = typeof o.pose === "string" && /^[\w-]{1,40}$/.test(o.pose) ? o.pose : "";
  return id ? { id, name: s(o.name, 40), index: Math.max(0, Math.round(typeof o.index === "number" ? o.index : 0)), ...(o.ownPictures === true ? { ownPictures: true } : {}), ...(pose ? { pose } : {}) } : null;
}

const ids = (v: unknown): string[] => [...new Set(arr(v).filter((x): x is string => typeof x === "string" && /^[\w-]{1,64}$/.test(x)))];

function parsePoses(raw: unknown): CtCharPose[] | null {
  const list = arr(raw)
    .map((x): CtCharPose | null => {
      const o = rec(x);
      const subjects = ids(o.subjects);
      if (!subjects.length) return null;
      return { id: typeof o.id === "string" && /^[\w-]{1,40}$/.test(o.id) ? o.id : crypto.randomUUID().slice(0, 8), name: s(o.name, 60), description: s(o.description, 600), subjects, mirrored: ids(o.mirrored).filter((m) => subjects.includes(m)) };
    })
    .filter((x): x is CtCharPose => x !== null)
    .slice(0, 8);
  return list.length ? list : null;
}

const real = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

function parseCompose(raw: unknown): CtCharComposeVersion[] | null {
  const list = arr(raw)
    .map((x): CtCharComposeVersion | null => {
      const o = rec(x);
      const people = arr(o.people)
        .map((y): CtCharComposePerson | null => {
          const r = rec(y);
          const h = real(r.h);
          if (typeof r.subject !== "string" || !r.subject || !(h > 0)) return null;
          return { subject: r.subject.slice(0, 64), x: real(r.x), y: real(r.y), h, ...(typeof r.flip === "boolean" ? { flip: r.flip } : {}) };
        })
        .filter((y): y is CtCharComposePerson => y !== null)
        .slice(0, 8);
      return people.length ? { name: s(o.name, 40), people } : null;
    })
    .filter((x): x is CtCharComposeVersion => x !== null)
    .slice(0, 12);
  return list.length ? list : null;
}

const IMPORT_STATUSES: CtCharImported["status"][] = ["uploading", "analyzing", "agent", "building", "done", "failed"];

/** An imported set's state (types/char.ts CtCharImported); null = a set drawn by AI. */
function parseImported(raw: unknown): CtCharImported | null {
  const o = rec(raw);
  if (!Object.keys(o).length) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
  return {
    status: IMPORT_STATUSES.includes(o.status as CtCharImported["status"]) ? (o.status as CtCharImported["status"]) : "failed",
    format: s(o.format, 40),
    files: n(o.files),
    bytes: n(o.bytes),
    indexUrl: s(o.indexUrl, 1000),
    manifestUrl: s(o.manifestUrl, 1000),
    done: n(o.done),
    total: n(o.total),
    error: s(o.error, 2000),
    summary: arr(o.summary).map((x) => s(x, 400)).filter(Boolean).slice(0, 40),
    problems: arr(o.problems).map((x) => s(x, 400)).filter(Boolean).slice(0, 60),
    ...(s(o.productId, 60) ? { productId: s(o.productId, 60) } : {}),
    ...(s(o.beat, 40) ? { beat: s(o.beat, 40) } : {}),
  };
}

export function parseCharBrief(raw: unknown): CtCharBrief {
  const o = rec(raw);
  const d = defaultCharBrief();
  const p = rec(o.product);
  const t = rec(o.text);
  return {
    kind: o.kind === "photo" ? "photo" : "character",
    idea: s(o.idea, 4000),
    product: {
      label: s(p.label, 200),
      cut: CUTS.includes(p.cut as CtCharCut) ? (p.cut as CtCharCut) : d.product.cut,
      widthMm: num(p.widthMm),
      heightMm: num(p.heightMm),
      blankId: uuidOrNull(p.blankId),
      templateId: uuidOrNull(p.templateId),
      layout: s(p.layout, 600),
      material: s(p.material, 40),
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
      .map(parsePhotoZone)
      .filter((x): x is CtCharPhotoZone => x !== null)
      .slice(0, 4),
    elements: arr(o.elements).map(parseElement).filter((x): x is CtCharElement => x !== null).slice(0, 10),
    lineup: parseLineup(o.lineup),
    versionOf: parseVersionOf(o.versionOf),
    poses: parsePoses(o.poses),
    imported: parseImported(o.imported),
    compose: parseCompose(o.compose),
    framing: o.framing === "bust" ? "bust" : "full",
    choosers: arr(o.choosers).map(parseChooser).filter((x): x is CtCharChooser => x !== null).slice(0, 24),
    charactersBox: parseBox(o.charactersBox),
    // Older briefs had one name ("text") and a decor sentence: read as one text field / one backdrop.
    texts: (Array.isArray(o.texts)
      ? arr(o.texts).map(parseTextField)
      : t.enabled === true || (t.enabled === undefined && !!s(t.defaultText))
        ? [parseTextField({ label: "Enter name", kind: "input", defaultText: s(t.defaultText) || "Jessica", font: t.font, place: "bottom" })]
        : []
    )
      .filter((x): x is CtCharTextField => x !== null)
      // A name per character on each hat style's brim or (no hat) on the top: up to 4 fields × 6 subjects.
      .slice(0, 24),
    backdrops: (Array.isArray(o.backdrops) ? arr(o.backdrops) : s(o.decor) ? [{ name: "Background", value: s(o.decor, 1000) }] : [])
      .map((x) => {
        const r = rec(x);
        const name = s(r.name, 80);
        const value = s(r.value, 1000);
        return name || value ? { id: idOf(r.id), name: name || "Background", value: value || name, ...(r.tile === true ? { tile: true } : {}) } : null;
      })
      .filter((x): x is CtCharBackdrop => x !== null)
      .slice(0, 8),
    mockups: arr(o.mockups).map((m) => s(m, 300)).filter(Boolean).slice(0, 6),
    pictures: parsePictures(o.pictures),
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
  // "a little girl about 6, …" → "little girl about 6" (said after "the").
  const short = sub.description.split(/[,.;]/)[0].trim().replace(/^(a|an|the)\s+/i, "");
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
 * Every part must cut clean (asked 2026-10-10: loose strands and fussy garments are what made the cut files dirty).
 * Hair is sculpted solid locks with a clean outline; clothes are simple shapes with continuous outlines.
 */
export const CLEAN_PARTS =
  "Clean cut-out-friendly drawing: hair is drawn as smooth, solid, sculpted locks with one clean continuous outline — " +
  "no loose flyaway strands, no single hairs or wisps sticking out or floating apart from the hair mass, no see-through hair ends. " +
  "Clothes are simple shapes with clean continuous outlines: no lace, fringe, ruffles, see-through fabric, dangling straps, " +
  "tassels or tiny loose details. Every part (hair, top, bottoms, shoes) is clearly separated from its neighbours.";

/**
 * The canvas every picture of a set is drawn on: a square, or a wide one for a row of 4+ characters (a family rug of
 * five — in a square each would be tiny). Set by the brief before the master, never changed after.
 */
export function setAspect(brief: CtCharBrief): "1:1" | "3:2" {
  // Half figures in a row (behind a sign) are wide already at three.
  return brief.kind !== "photo" && brief.subjects.length >= (brief.framing === "bust" ? 3 : 4) ? "3:2" : "1:1";
}

/** The characters of a lineup are apart: each one's own pixels are its body file (server/char/product.ts splits
 * touching ones at the middle between them, so shoulders may touch — nobody may be in front of another). */
const LINEUP_LINE: Record<CtCharLineup["mode"], string> = {
  one: "These are ALTERNATIVE characters (the customer picks ONE of them): draw them side by side as separate figures with a wide empty gap between them — they never touch, overlap or interact — the same scale, the same pose style, each complete on its own.",
  count:
    "The customer picks how many of them are in the picture (versions with fewer people leave some out): draw them in ONE row, the same scale, side by side close together — shoulders may just touch, but NOBODY overlaps or stands in front of another, every head, hat and hand fully visible — each one complete on its own.",
};

/** Every version drawn as its own picture (lineup.drawn, a version set): nobody is ever cut out of it, but each
 * character is cut from its own side — a small gap keeps the sides apart. */
const DRAWN_LINE =
  "Side by side in ONE row, close together like the reference, with a small clear gap between neighbours (nobody touches or overlaps another one — no hat, hair or hand over a neighbour), every head, hat and hand fully visible, each one complete on its own.";

/**
 * ONE prompt for the master, from the brief. Everything the layers need is asked here once: every subject full,
 * on flat white, customizable parts plain and readable, photo zones left empty — the later steps are in-place
 * edits of this picture, never new pictures.
 */
export function masterPrompt(brief: CtCharBrief): string {
  if (brief.kind === "photo") return photoMasterPrompt(brief);
  const lines: string[] = [];
  lines.push(brief.style ? `${brief.style.replace(/\.$/, "")}.` : "Cute stylized cartoon illustration, soft painterly 3D-cartoon rendering, premium personalized gift print.");
  if (brief.subjects.length > 1) {
    lines.push(`${brief.subjects.length} characters, from left to right:`);
  }
  brief.subjects.forEach((sub, i) => {
    // An optional part (glasses) is not in the master: the customer starts on "NO".
    const looks = sub.slots.filter((sl) => !sl.optional && shownByDefault(brief, sl.shownWhen)).map(slotLook).filter(Boolean);
    const head = brief.subjects.length > 1 ? `${i + 1}. ` : "";
    lines.push(`${head}${sub.description.replace(/\.$/, "")}${looks.length ? `; ${looks.join("; ")}` : ""}.`);
  });
  if (brief.scene) lines.push(`Arrangement: ${brief.scene.replace(/\.$/, "")}.`);
  const drawn = brief.lineup?.drawn === true || !!brief.versionOf;
  if (drawn && brief.subjects.length > 1) lines.push(DRAWN_LINE);
  else if (brief.lineup && brief.subjects.length > 1) lines.push(LINEUP_LINE[brief.lineup.mode]);
  if (brief.product.layout) lines.push(`On the product: ${brief.product.layout.replace(/\.$/, "")}.`);
  for (const z of brief.photoZones)
    lines.push(
      z.treat === "face"
        ? `${z.where}: no face drawn — an empty plain light-grey oval with a clean edge where the face is (the customer's own face photo goes there later); the hat, the hair edge and the collar are drawn around it, slightly over its edge.`
        : `${z.where}: an empty plain light-grey area with a clean edge (a photo goes there later).`,
    );
  const frame = setAspect(brief) === "3:2" ? "A wide landscape picture" : "A square picture";
  const touch = brief.lineup || brief.versionOf ? "" : "; they may touch, but no one hides another one's clothes, hair or face";
  lines.push(
    brief.framing === "bust"
      ? `${frame}: ${brief.subjects.length > 1 ? "everyone" : "the character"} shown from the chest up (half figure, like leaning on a counter: the elbows rest on it), all cut off by the SAME straight horizontal line at the elbows near the bottom of the picture (a sign is placed in front of it later — it covers only that edge, the arms and hands stay fully visible above it); heads, hats and hands fully inside the picture with a generous empty margin above and at the sides${brief.subjects.length > 1 ? touch : ""}.`
      : brief.subjects.length > 1
        ? `${frame}: everyone fully visible head to toe INSIDE the picture, nobody cropped, the group centred with a generous empty margin all around (scale the group down to fit)${touch}.`
        : `${frame}: the full body fully visible head to toe INSIDE the picture, not cropped, centred with a generous empty margin all around (scale the figure down to fit).`,
  );
  lines.push("No accessories or props unless described. No text, no logo, no watermark.");
  lines.push(CLEAN_PARTS);
  lines.push(
    "A fully transparent background (the characters alone, cut out), no floor, no cast shadow, no scenery.",
  );
  return lines.join("\n");
}

/**
 * What the master, the 3b pictures and the cut hang on — frozen once a master is approved. The texts, backgrounds,
 * mockup scenes and the material are made in step 4 (the product) and stay editable.
 */
export function masterBriefKey(brief: CtCharBrief): string {
  // A bộ nhân vật's decorations are drawn alone after the master (like the backgrounds): never frozen either.
  const { texts: _t, backdrops: _b, mockups: _m, elements: _e, charactersBox: _c, compose: _co, product, ...rest } = brief;
  const { material: _mat, ...piece } = product;
  // A bộ ảnh khách's pieces are each drawn on their own from the master's look: only the look is frozen — the
  // photo zone, the decorations and their options stay editable after the master (adding a wing style later).
  if (brief.kind === "photo") return JSON.stringify({ kind: brief.kind, style: brief.style, refs: brief.refs, product: piece });
  return JSON.stringify({ ...rest, product: piece });
}

// ---- bộ ảnh khách (kind "photo") ------------------------------------------------------------------------------

/** What the customer's photo shows, in the prompts ("the customer's pet"). */
export function photoSubject(brief: CtCharBrief): string {
  // The words before the first comma outside brackets: "the customer's pet (a Shih Tzu), sitting" → "the customer's pet (a Shih Tzu)".
  return (brief.photoZones[0]?.where || "the customer's pet").split(/,(?![^(]*\))/)[0].replace(/\.$/, "").trim();
}

/** Where an element sits, said to the image model. */
function elementPlaceLine(brief: CtCharBrief, e: CtCharElement, look: string): string {
  const who = photoSubject(brief);
  switch (e.place) {
    case "behind":
      return `Behind ${who}: ${look}, spread wide to both sides and partly hidden behind ${who}.`;
    case "above":
      return `Above the head of ${who}: ${look}.`;
    case "bottom":
      return `Across the bottom of the picture, over the lower part of the body of ${who}: ${look} — a soft band that hides where the body ends; the lettering sits on it.`;
    default:
      return `${e.name}: ${look}.`;
  }
}

/** The look of an element's first option. */
function elementLook(e: CtCharElement): string {
  const o = e.options[0];
  if (!o) return e.name.toLowerCase();
  if (e.mode === "color") return `${e.name.toLowerCase()} in ${o.name.toLowerCase()}${/^#[0-9a-f]{6}$/i.test(o.value) ? ` (${o.value})` : ""}`;
  return o.value || o.name;
}

/**
 * The master of a bộ ảnh khách: the finished product's whole flat design drawn once — with a sample of what the
 * customer's photo will show — so every piece drawn after it has its look. Opaque, the background included.
 */
export function photoMasterPrompt(brief: CtCharBrief): string {
  const who = photoSubject(brief);
  const lines: string[] = [];
  lines.push(brief.style ? `${brief.style.replace(/\.$/, "")}.` : "Soft dreamy watercolor illustration, premium personalized memorial gift print.");
  lines.push(`The finished flat printable design of a ${brief.product.label || "personalised gift"}, filling the whole square picture edge to edge.`);
  if (brief.product.layout) lines.push(`On the product: ${brief.product.layout.replace(/\.$/, "")}.`);
  if (brief.backdrops[0]) lines.push(`Background: ${(brief.backdrops[0].value || brief.backdrops[0].name).replace(/\.$/, "")}.`);
  lines.push(`In the middle: ${(brief.photoZones[0]?.where || who).replace(/\.$/, "")} — drawn as a sample in the same style (the customer's own photo replaces it later), centred, a little above the middle.`);
  for (const e of brief.elements) lines.push(elementPlaceLine(brief, e, elementLook(e)));
  const words = brief.texts.map((t) => (t.kind === "choice" ? t.choices[0] : t.defaultText)).filter(Boolean);
  if (words.length) lines.push(`Lettering at the bottom, centred, elegant: ${words.map((w) => `"${w}"`).join(" / ")}.`);
  lines.push("No frame, no border, no product shape, no hanging hole, no mockup, no watermark — only the flat artwork.");
  return lines.join("\n");
}

/**
 * The sign in front of the characters (place "plaque") — asked 2026-10-22: never pieced together (the product stretched
 * it by repeating its middle and the seams showed): ONE whole picture, as wide as the artwork frame, and every theme's
 * sign of the same proportions (only the theme changes). Its height: this share of the frame's height.
 */
export const PLAQUE_FRAME_H = 0.3;

/** The sign's width / height on a piece whose artwork frame (safe area) is `areaRatio` wide for 1 tall. */
export function plaqueAspect(areaRatio: number): number {
  return Math.round(Math.max(3, Math.min(8, areaRatio / PLAQUE_FRAME_H)) * 10) / 10;
}

/** How a sign is drawn: whole, edge to edge, at exactly the shared proportions; plain middle for the lettering. */
export function plaqueShape(aspect: number): string {
  return (
    `ONE long low horizontal sign seen straight from the front, EXACTLY ${aspect} times as wide as it is tall, spanning the picture's ` +
    "whole width from edge to edge, vertically centred — one continuous piece (never two planks joined, no seam, no repeated pattern). " +
    "The decorations ONLY at its two ends (each within the outer fifth of the sign) and within the sign's own height (nothing rising far above or hanging below it); " +
    "the whole middle is plain surface for lettering — no decoration, no text, no knots or marks crossing it, an even grain running straight along the sign. " +
    "Every theme of this sign is drawn at these same proportions."
  );
}

/** The aspect an element's picture is drawn at; a placed one (box) by its box's shape on the piece (`areaRatio` = the
 * safe area's width / height): a ribbon banner wide, a tree tall. */
export function elementAspect(e: CtCharElement, areaRatio = 1): string {
  if (e.box) {
    const r = (e.box.w / e.box.h) * areaRatio;
    return r > 1.25 ? "3:2" : r < 0.8 ? "2:3" : "1:1";
  }
  return e.place === "behind" || e.place === "bottom" || e.place === "above" || e.place === "plaque" ? "3:2" : "1:1";
}

/**
 * The prompt of one element picture: the decoration ALONE, whole, on transparency, in the master's look
 * (reference picture 1 = the approved master; a per-background band also gets that background as picture 2).
 */
export function elementPrompt(brief: CtCharBrief, e: CtCharElement, look: string, backdrop?: CtCharBackdrop, areaRatio = 1): string {
  if (brief.kind !== "photo") return charElementPrompt(brief, e, look, backdrop, areaRatio);
  const who = photoSubject(brief);
  const shape: Record<CtCharElementPlace, string> = {
    behind: `Draw it as it is seen behind ${who}: symmetric, spread wide to the left and right, with the empty middle where ${who} sits (the middle part may be simple — it is hidden). Both sides complete.`,
    above: "Seen slightly from the front, flat and wide, floating.",
    bottom: `A wide horizontal band filling the whole width of the picture edge to edge: its top edge soft and organic, its bottom straight along the picture's bottom edge, about half of the picture tall — it is laid over the bottom of the body of ${who} and over the piece's bottom edge, the lettering is printed on it, so it is solid and calm (no holes, no gaps) with nothing busy in it.`,
    free: "",
    plaque: plaqueShape(plaqueAspect(areaRatio)),
  };
  return [
    `Reference picture 1 is the finished design: match its drawing style, colours, line work and lighting exactly.`,
    backdrop ? `Reference picture 2 is the background it lies on (${backdrop.name}): use ITS colours so the two blend.` : "",
    `Draw ONLY this one element: ${look}.`,
    shape[e.place],
    "It is alone, complete and whole — nothing cut off by the picture's edge (except a band's sides and bottom), nothing in front of it — centred, as large as fits.",
    `No ${who}, no people, no animals, no background, no text, no frame. A fully transparent background around it.`,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * A decoration of a bộ nhân vật (asked 2026-10-18): drawn ALONE on transparency in the look of the approved master
 * (reference picture 1 — the characters, cut out), never cut; the product places it in its box around the characters.
 */
function charElementPrompt(brief: CtCharBrief, e: CtCharElement, look: string, backdrop: CtCharBackdrop | undefined, areaRatio: number): string {
  const shape: Record<CtCharElementPlace, string> = {
    behind: "It stands behind the characters: symmetric, spread wide to the left and right, the middle simple (it is hidden). Both sides complete.",
    above: "Seen slightly from the front, flat and wide, floating.",
    bottom: "A wide horizontal band filling the whole width of the picture edge to edge: its top edge soft and organic, its bottom straight along the picture's bottom edge — the characters stand / sit on it, so it is calm, with nothing tall in it.",
    free: "",
    plaque: plaqueShape(plaqueAspect(areaRatio)),
  };
  return [
    "Reference picture 1 shows the characters of this design: match their drawing style, colours, line work, rendering and lighting exactly.",
    backdrop ? `Reference picture 2 is the background it lies on (${backdrop.name}): use ITS colours so the two blend.` : "",
    `Draw ONLY this one element: ${look}.`,
    shape[e.place],
    "It is alone, complete and whole — nothing cut off by the picture's edge (except a band's sides and bottom), nothing in front of it — centred, filling the picture as much as it can.",
    "No characters, no people, no background, no frame; no text or letters unless the element itself is lettering. A fully transparent background around it.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** What a bộ ảnh khách lacks before its master (shown on the master step). */
function photoBriefProblems(brief: CtCharBrief): string[] {
  const out: string[] = [];
  if (!brief.photoZones.length) out.push("Chưa có vùng ảnh khách.");
  brief.photoZones.forEach((z) => {
    if (z.treat === "ai" && !(z.styles ?? []).length) out.push(`Vùng "${z.label}": AI vẽ lại nhưng chưa chọn style nào.`);
  });
  brief.elements.forEach((e) => {
    if (e.perBackdrop && !brief.backdrops.length) out.push(`"${e.name}" vẽ theo từng nền nhưng chưa có nền nào.`);
    if (!e.perBackdrop && !e.options.length) out.push(`"${e.name}" chưa có lựa chọn nào.`);
    if (e.mode === "color" && e.options.some((o) => !/^#[0-9a-f]{6}$/.test(o.value))) out.push(`"${e.name}" đổi màu — mỗi màu cần mã #rrggbb.`);
  });
  return out;
}

/** Problems that would make layers impossible or wrong — shown before the master is made. */
export function briefProblems(brief: CtCharBrief): string[] {
  if (brief.kind === "photo") return photoBriefProblems(brief);
  const out: string[] = [];
  if (!brief.subjects.length) out.push("Chưa có nhân vật nào.");
  brief.subjects.forEach((sub, i) => {
    sub.slots.forEach((slot) => {
      if (!slot.options.length) out.push(`Nhân vật ${i + 1}: phần "${slot.part}" chưa có lựa chọn nào (lựa chọn đầu = như trong master).`);
      if (slot.mode === "color" && slot.options.some((o) => !/^#[0-9a-f]{6}$/.test(o.value)))
        out.push(`Nhân vật ${i + 1}: phần "${slot.part}" đổi màu — mỗi màu cần mã #rrggbb.`);
      if (slot.mode === "shape" && slot.colors.some((o) => !/^#[0-9a-f]{6}$/.test(o.value)))
        out.push(`Nhân vật ${i + 1}: màu của "${slot.part}" cần mã #rrggbb.`);
      if (slot.sameAs) {
        const lead = sub.slots.find((x) => x !== slot && x.id === slot.sameAs);
        const names = (sl: CtCharSlot) => [sl.options.map((o) => o.name).join("|"), sl.colors.map((c) => c.name).join("|")].join("/");
        if (!lead) out.push(`Nhân vật ${i + 1}: "${slot.part}" cùng lựa chọn với "${slot.sameAs}" nhưng nhân vật này không có phần đó.`);
        else if (lead.sameAs) out.push(`Nhân vật ${i + 1}: "${slot.part}" phải cùng lựa chọn với phần gốc, không phải "${lead.part}" (đã cùng lựa chọn với phần khác).`);
        else if (names(lead) !== names(slot)) out.push(`Nhân vật ${i + 1}: "${slot.part}" cùng lựa chọn với "${lead.part}" nhưng khác kiểu / màu hoặc thứ tự.`);
      }
      if (slot.cutColor && !/^#[0-9a-f]{6}$/.test(slot.cutColor)) out.push(`Nhân vật ${i + 1}: màu cắt của "${slot.part}" cần mã #rrggbb.`);
      if (slot.cutColor && (slot.mode === "texture" || (slot.mode === "shape" && !slot.colors.length)))
        out.push(`Nhân vật ${i + 1}: "${slot.part}" vẽ bằng màu cắt nhưng không có màu nào cho khách (colors) — khách sẽ thấy màu cắt.`);
      if (slot.on && !sub.slots.some((x) => x !== slot && (x.id === slot.on || x.group === slot.on)))
        out.push(`Nhân vật ${i + 1}: "${slot.part}" vẽ trên "${slot.on}" nhưng nhân vật này không có phần nào có id / group đó.`);
    });
  });
  if (brief.product.cut === "alpha" && brief.backdrops.length) out.push("Sản phẩm cắt viền (alpha): nền sẽ nằm trong đường cắt — chắc chắn muốn vậy?");
  if (brief.lineup && brief.subjects.length < 2) out.push("Khách chọn nhân vật / số người nhưng brief chỉ có 1 nhân vật.");
  out.push(...poseProblems(brief));
  brief.texts.forEach((t, i) => {
    if (t.place === "under" && !brief.subjects.some((x) => x.id === t.subject)) out.push(`Chữ ${i + 1} (${t.label}): "dưới nhân vật" nhưng chưa chọn nhân vật nào.`);
  });
  brief.texts.forEach((t, i) => {
    if (t.kind === "choice" && !t.choices.length) out.push(`Chữ ${i + 1} (${t.label}): chưa có câu nào cho khách chọn.`);
  });
  return out;
}

/** The pose a subject is drawn in (brief.poses), and whether it is placed mirrored. */
export function poseOf(brief: CtCharBrief, subjectId: string): { pose: CtCharPose; mirrored: boolean } | null {
  const pose = brief.poses?.find((p) => p.subjects.includes(subjectId));
  return pose ? { pose, mirrored: pose.mirrored.includes(subjectId) } : null;
}

/** A pose's subjects must be interchangeable (one is drawn, the others take its files): same parts, modes, option and
 * colour counts, in the same order. */
const slotShape = (sub: CtCharSubject) => sub.slots.map((sl) => `${sl.mode}:${sl.options.length}:${sl.colors.length}:${sl.wraps}:${sl.headwear === true}`).join("|");

export function poseProblems(brief: CtCharBrief): string[] {
  if (!brief.poses?.length) return [];
  const out: string[] = [];
  const seen = new Map<string, string>();
  for (const p of brief.poses) {
    for (const id of p.subjects) {
      if (!brief.subjects.some((x) => x.id === id)) out.push(`Dáng "${p.name || p.id}": không có nhân vật "${id}".`);
      else if (seen.has(id)) out.push(`Nhân vật "${id}" nằm ở 2 dáng ("${seen.get(id)}" và "${p.name || p.id}").`);
      seen.set(id, p.name || p.id);
    }
    if (!p.description) out.push(`Dáng "${p.name || p.id}": chưa tả dáng (description).`);
    const subs = p.subjects.map((id) => brief.subjects.find((x) => x.id === id)).filter((x): x is CtCharSubject => !!x);
    for (const sub of subs.slice(1))
      if (slotShape(sub) !== slotShape(subs[0])) out.push(`Dáng "${p.name || p.id}": "${sub.name || sub.id}" khác phần / số lựa chọn với "${subs[0].name || subs[0].id}" — cùng dáng phải cùng các phần và lựa chọn theo đúng thứ tự.`);
  }
  for (const sub of brief.subjects) if (!seen.has(sub.id)) out.push(`Nhân vật "${sub.name || sub.id}" chưa có dáng nào.`);
  return out;
}

/** Number of finished files the set will have (what the customer can combine). */
export function briefCombos(brief: CtCharBrief): number {
  let n = 1;
  if (brief.kind === "photo") {
    for (const e of brief.elements) n *= e.perBackdrop ? 1 : Math.max(1, e.options.length);
    return n * Math.max(1, brief.backdrops.length);
  }
  for (const sub of brief.subjects)
    for (const slot of sub.slots) n *= (Math.max(1, slot.options.length) + (slot.optional ? 1 : 0)) * (slot.mode === "shape" ? Math.max(1, slot.colors.length) : 1);
  for (const e of brief.elements) if (!e.follows && !e.perBackdrop) n *= Math.max(1, e.options.length);
  return n * Math.max(1, brief.backdrops.length);
}
