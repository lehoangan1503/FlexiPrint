/**
 * Prompt review — the last step of every AI change to a category (create, "Cập nhật bằng AI"), also run on its
 * own ("Kiểm tra prompt", MCP tool review_category).
 *
 * The writers each see one layer at a time; the image models see them glued together. So the review rebuilds the
 * prompts EXACTLY as the pipeline sends them — the flat drawing (studio context.py compose) and every material
 * pass (studio material.py render: base + one edit per "version" detail) — and has the LLM read them as the image
 * model would: contradictions between layers or sentences, places / sizes that can't hold for every clipart of an
 * origin set, a "leave out" that also cancels a required part, things in the wrong layer, product photos that
 * contradict the details. It fixes what it finds with the smallest merge (unchanged sentences word for word).
 *
 * Shared presets (style pack / material used by other categories) are only fixed when the problem is in the
 * preset itself; the editor still picks "bản chung" or "bản riêng" when applying.
 */

import type { CtCategoryRules, CtMaterialSpec, CtPromptReview, CtReviewIssue, CtReviewLayer } from "../../types";
import { normalizeMaterialSpecs } from "../../lib/materials";
import { askLlm, clip, jsonObject, readSavedRefs, record, reviewModel, str } from "./llm";

// ---------------------------------------------------------------------------
// The pipeline's own wording (keep in sync with services/comfy/custom_nodes/flexiprint/material.py / context.py)
// ---------------------------------------------------------------------------

const FRAME_PRINT =
  "Turn image 1 into a product photo-cutout of this artwork made as the physical product described below. " +
  "Keep the printed artwork exactly as in image 1 — every shape, colour, line, letter and face, same size and same position in the frame.";
const FRAME_SURFACE =
  "Turn image 1 into a product photo-cutout of this artwork made as the physical product described below. The material " +
  "covers the artwork's own surface, but every shape, line, face and letter stays exactly where it is — same size and same position in the frame.";
const FRAME_SHAPED =
  "Turn image 1 into a product photo-cutout of this piece made as the physical product described below. Image 1 is " +
  "already cut to the product's exact outline: keep that outline exactly — same shape, size and position, every hole " +
  "or cut-out stays open and where it is, nothing added past the edge. The material covers the piece's whole surface " +
  "(finish, gloss, light on it), but every shape, colour, line, letter and face of the artwork stays exactly where it is.";
const FULL_BLEED =
  "A full-bleed flat artwork filling the whole frame edge to edge: the subject with its own background scene behind it " +
  "(never a blank, white or transparent background), no outline, border, frame or cut-out shape — the product's shape is " +
  "cut from it later, so keep the subject and anything important well inside, away from the edges";
const REQUIRED = "Product details — every one of these MUST be clearly visible in this picture:";
const NOT_YET =
  "Added later in a separate step, so NOT in this picture: {what}. Leave out only that loose part itself — every required detail above is still drawn.";
const BLACK_BG = "Solid pure black (#000000) background, nothing else in the picture.";
const REFS_NOTE =
  "The other images are reference photos of the finished product: match how their material looks (clarity, thickness, edge, " +
  "finish) and how their details look (size, shape, material, colour) exactly. Never copy their artwork, background, scene or the " +
  "outline / shape of their piece: the outline always follows THIS artwork, as described. Dots, circles, arrows, boxes or " +
  "handwriting drawn over a reference photo are the editor's notes about where / what a detail is — never draw them.";
const ADD_ONE =
  "Add ONLY this to image 1: {what} Change nothing else — the material, every detail already there, the printed artwork and the black " +
  "background stay exactly as they are, same size and position.";

export interface ReviewMaterial {
  /** Handle the LLM answers with (M1, M2…). */
  key: string;
  name: string;
  prompt: string;
  art: "print" | "surface";
  /** Other categories using it — a fix to it changes them too. */
  usedByOthers: string[];
}

export interface ReviewInput {
  name: string;
  usage: "main" | "element";
  spec: string;
  style: { name: string; prompt: string; usedByOthers: string[] } | null;
  materials: ReviewMaterial[];
  rules: Pick<CtCategoryRules, "details" | "productRefs" | "detailsNote" | "fill" | "anchor"> & Partial<Pick<CtCategoryRules, "shape">>;
  /** Product photos not saved yet (data urls, create flow): sent instead of rules.productRefs, never dropped. */
  photos?: string[];
}

export interface ReviewResult {
  review: CtPromptReview;
  /** Full fixed texts, null = unchanged. */
  spec: string | null;
  style: string | null;
  materials: Record<string, string>;
  details: CtMaterialSpec[] | null;
}

export function flatPrompt(input: ReviewInput): string {
  const fill = Math.round(input.rules.fill * 100);
  const base = input.rules.anchor === "bottom" ? "resting on the bottom edge" : "centred";
  const view = "use the viewing angle described above, the same for every clipart of the set (front view if none is given)";
  const framing =
    input.rules.shape === "frame"
      ? null
      : input.usage === "main"
      ? `Show the whole object, ${base}, filling about ${fill}% of the frame; ${view}.`
      : `One single isolated element, ${base}, filling about ${fill}% of the frame; ${view}; no other objects, no scenery.`;
  return [
    input.style ? `Style: ${input.style.prompt}` : "",
    input.spec ? `Kind of object (${input.name}): ${input.spec}` : "",
    "<subject line of one clipart, e.g. \"red sedan\">",
    framing === null
      ? `${FULL_BLEED}; ${view}. No text, no watermark. Print quality.`
      : `${framing} No text, no watermark, no drop shadow, no floor. Flat, solid pure white (#FFFFFF) background. Crisp clean edges, print quality.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function materialPrompts(input: ReviewInput, m: ReviewMaterial): string[] {
  const always = input.rules.details.filter((d) => d.mode === "always");
  const versions = input.rules.details.filter((d) => d.mode === "version");
  const refs = photoCount(input) > 0;
  // Theo khuôn (a fixed-shape product): the clipart comes in cut to the product's khuôn, its outline kept exactly.
  const base = [
    input.rules.shape === "frame" ? FRAME_SHAPED : m.art === "surface" ? FRAME_SURFACE : FRAME_PRINT,
    m.prompt,
    input.style ? `The artwork is drawn in this style (keep it): ${input.style.prompt}` : "",
    always.length ? `${REQUIRED}\n${always.map((d) => `- ${d.text}`).join("\n")}` : "",
    versions.length ? NOT_YET.replace("{what}", versions.map((d) => d.text.replace(/\.$/, "")).join("; ")) : "",
    BLACK_BG,
    refs ? REFS_NOTE : "",
  ].filter(Boolean);
  const out = [`[${m.key} "${m.name}" — base version, an edit of the flat clipart${input.rules.shape === "frame" ? " cut to the product's khuôn" : ""}]\n${base.join("\n")}`];
  for (const v of versions) {
    out.push(`[${m.key} "${m.name}" — version "${v.label}", an edit of the base picture]\n${ADD_ONE.replace("{what}", v.text)}${refs ? `\n${REFS_NOTE}` : ""}`);
  }
  return out;
}

export const REVIEW_SYSTEM = `You are the final reviewer of the prompts of one category of an AI print-clipart pipeline. Several writers each edited one layer; you read the prompts EXACTLY as the image models receive them (assembled below) and catch what makes results wrong or inconsistent. Then you fix it.

THE PIPELINE
- Flat clipart (the file the factory prints): STYLE PACK + CATEGORY SPEC + one clipart's subject line + fixed rules (white background, framing). Never shows product details.
- Material versions: an image-EDIT model (nano-banana) turns the flat clipart into a photo-cutout of the physical product: MATERIAL prompt + the category's DETAILS ("always" = in the base picture; "version" = one extra picture, an edit of the base adding only that part) + the saved PRODUCT PHOTOS (attached images). Each clipart is edited ALONE, so nothing keeps cliparts consistent except the wording.
- An origin set: every clipart is a DIFFERENT model of the same kind (a sports car, a police car, a tractor…), with different heights, roofs and part positions.

CHECK, in this order:
1. CONTRADICTIONS — two sentences (in one layer or across layers) that cannot both hold: two anchors for one position ("at the top edge of the product" + "above the roof" when another part is higher than the roof), sizes that disagree, a detail vs the material's margin / outline, the spec vs the style pack.
2. CANCELLED PARTS — a negative / "leave out" sentence that also names a required part (e.g. a version detail "cord through the hanging hole" appearing in "NOT in this picture" can make the model drop the hole). Fix in the version detail's wording: name its own part first, the part it attaches to only as a place.
3. NOT REPEATABLE — positions anchored to parts not every member has / places that move between members; missing measurable sizes for small parts (a hole, a ring, a tab: give a fraction of the artwork's width), missing shape. Results vary from clipart to clipart because of this. Make them literal and measurable, anchored on something every member has.
4. WRONG LAYER — style in the spec, object names in the style pack, holes / cords in a material, material or background in the spec, details describing the material itself. Move or remove.
5. PRODUCT PHOTOS — each attached photo is sent to the edit model with every material pass, which copies their MATERIAL and DETAILS only (it is told never to copy their artwork, decorations, scene or outline). So judge a photo ONLY by its plate / edge / hole / tab / cord / clip: never drop one for its printed artwork. Drop a photo (dropProductRefs, 1-based) whose details contradict the DETAILS or the other photos — a blank piece of another shape with a differently made tab, another hole design, another cord — because the model averages them. Keep the photo that matches the details best.
6. Anything else in the assembled text that an image model would misread.

FIX RULES
- EDITOR'S INTENT (when given) is what the editor wants — fixes keep its positions, parts and versions; you only make the wording unambiguous and measurable.
- Only fix real problems; never polish. When there is nothing wrong, return "issues": [] and every field null.
- MERGE: copy every sentence that is fine WORD FOR WORD; replace only the faulty sentences. English for prompts.
- Spec / style / material: return the FULL new text. Details: the FULL new list (unchanged entries word for word), each {"text","mode","label"}; keep modes and labels unless they are the problem.
- A style pack / material used by other categories: fix it only when the problem is inside it (it changes them too); prefer fixing the category's own layers (spec, details).
- Sizes are always fractions of the artwork / object (the image model knows no millimetres or pixels): "about 4% of the artwork's width".
- "problem": IN VIETNAMESE, ONE short sentence (max ~30 words) saying what goes wrong in the picture, quoting only the few faulty words ("“at the top edge” và “above the car's roof” chỉ hai chỗ khác nhau…"). "fix": IN VIETNAMESE, one short sentence on what you changed. Never paste whole prompts there. "layer": spec | style | material | details | productRefs. "target": the material handle (M1…) / photo number / "".

Reply with JSON only:
{"issues": [{"layer": "details", "target": "", "severity": "high" | "low", "problem": "...", "fix": "..."}],
 "spec": "..." | null, "style": "..." | null, "materials": [{"handle": "M1", "prompt": "..."}],
 "details": [{"text": "...", "mode": "always", "label": ""}] | null,
 "dropProductRefs": [2]}`;

/** Small parts a "version" detail may hang from — named in its text, they also land in the base's "NOT in this picture". */
const PART_WORDS = ["hole", "tab", "ring", "jump ring", "eyelet", "grommet", "loop", "clip", "hook", "chain", "spring"];

/**
 * Cheap checks done in code, handed to the LLM as leads (it still judges them): the mistakes seen in real runs
 * that a quick read misses.
 */
export function lintCategory(input: ReviewInput): string[] {
  const out: string[] = [];
  const always = input.rules.details.filter((d) => d.mode === "always");
  const words = (t: string) => PART_WORDS.filter((w) => new RegExp(`\\b${w}s?\\b`, "i").test(t));
  const required = new Set(always.flatMap((d) => words(d.text)));
  for (const v of input.rules.details.filter((d) => d.mode === "version")) {
    const shared = words(v.text).filter((w) => required.has(w));
    if (shared.length) out.push(`Version detail "${v.label}" names the required ${shared.join(", ")} — its text is quoted on the base as "NOT in this picture" (check 2).`);
  }
  // A material's thickness in mm is a real description ("3 mm thick"); sizes / positions in units are not.
  const units = /\b\d+(?:[.,]\d+)?\s?(?:mm|cm|px|pixels?|inch(?:es)?)\b(?![\s-]*thick)/i;
  const texts: Array<[string, string]> = [
    ["spec", input.spec],
    ...input.materials.map((m): [string, string] => [`material ${m.key}`, m.prompt]),
    ...input.rules.details.map((d, i): [string, string] => [`detail ${i + 1}`, d.text]),
  ];
  for (const [where, t] of texts) {
    const m = t.match(units);
    if (m) out.push(`${where} sizes something in absolute units ("${m[0]}") — the image model only understands fractions of the artwork.`);
  }
  for (const [i, d] of input.rules.details.entries()) {
    if (/\b(hole|tab|ring|eyelet|loop)\b/i.test(d.text) && !/%|\bhalf\b|\bthird\b|\bquarter\b|\bfraction\b|\btimes\b/i.test(d.text)) {
      out.push(`detail ${i + 1} gives no measurable size for a small part (check 3).`);
    }
  }
  // One position, two anchors: "at the top edge of the piece" (the highest point — often another part) + "above the roof".
  const edge = /\b(top edge|highest point|top of the (?:piece|product|artwork|plate))\b/i;
  const rel = /\b(above|below|over|under|left of|right of|next to|beside)\s+(?:the\s+)?([a-z']+(?:\s[a-z']+)?)/i;
  for (const [i, d] of input.rules.details.entries()) {
    const a = d.text.match(edge);
    const b = d.text.match(rel);
    if (a && b) out.push(`detail ${i + 1} anchors one position twice: "${a[0]}" and "${b[0]}" — on members where they are not the same place the model picks either (check 1).`);
  }
  if (/\b(background|white|transparent)\b/i.test(input.spec)) out.push("spec talks about background / transparency — the rules layer owns that (check 4).");
  return out;
}

/** Product photos the material step gets (it reads at most 6; the review looks at 4). */
const MAX_PHOTOS = 4;
const photoCount = (input: ReviewInput) => (input.photos ?? input.rules.productRefs).slice(0, MAX_PHOTOS).length;

function reviewPrompt(input: ReviewInput): string {
  const d = input.rules.details;
  const leads = lintCategory(input);
  return [
    `CATEGORY "${input.name}" — ${input.usage === "main" ? "main object" : "element"}, origin set`,
    "",
    "LAYERS AS STORED",
    `SPEC: ${input.spec || "(empty)"}`,
    `STYLE PACK: ${input.style ? `"${input.style.name}"${input.style.usedByOthers.length ? ` (also used by ${input.style.usedByOthers.join(", ")})` : ""}: ${input.style.prompt}` : "(none)"}`,
    `MATERIALS: ${input.materials.length ? "" : "(none)"}`,
    ...input.materials.map((m) => `  ${m.key} "${m.name}" [${m.art}]${m.usedByOthers.length ? ` (also used by ${m.usedByOthers.join(", ")})` : ""}: ${m.prompt}`),
    `DETAILS: ${d.length ? "" : "(none)"}`,
    ...d.map((x, i) => `  ${i + 1}. (${x.mode}${x.label ? ` "${x.label}"` : ""}) ${x.text}`),
    `EDITOR'S INTENT for the details (their own words): ${input.rules.detailsNote.trim() || "(none)"}`,
    `PRODUCT PHOTOS: ${photoCount(input)} attached${photoCount(input) ? ` (photo 1…${photoCount(input)}, in order)` : ""}`,
    "",
    "LEADS FROM AUTOMATIC CHECKS (verify each; ignore one that is not a real problem):",
    ...(leads.length ? leads.map((l) => `- ${l}`) : ["(none)"]),
    "",
    "ASSEMBLED — flat clipart prompt",
    flatPrompt(input),
    "",
    "ASSEMBLED — material prompts (image 1 = the flat clipart, then the product photos)",
    ...(input.materials.length ? input.materials.flatMap((m) => materialPrompts(input, m)).map((p) => `${p}\n`) : ["(no material)"]),
  ].join("\n");
}

const LAYERS: CtReviewLayer[] = ["spec", "style", "material", "details", "productRefs"];

/** Reads the assembled prompts; null when the LLM is down (a review never blocks the change it checks). */
export async function reviewCategory(input: ReviewInput): Promise<ReviewResult | null> {
  const photos = input.photos?.slice(0, MAX_PHOTOS) ?? (await readSavedRefs(input.rules.productRefs.slice(0, MAX_PHOTOS)));
  const reply = await askLlm(REVIEW_SYSTEM, reviewPrompt(input), photos, reviewModel(), /-pro\b/.test(reviewModel()));
  if (typeof reply !== "string") {
    console.error("[prompt-review]", await reply.json().catch(() => reply.status));
    return null;
  }
  const raw = jsonObject(reply);
  if (!raw || !Array.isArray(raw.issues)) {
    console.error("[prompt-review] not JSON:", reply.slice(0, 300));
    return null;
  }

  const spec = str(raw.spec);
  const style = str(raw.style);
  const materials: Record<string, string> = {};
  for (const m of (Array.isArray(raw.materials) ? raw.materials : []).map(record)) {
    const key = str(m.handle).toUpperCase();
    const prompt = str(m.prompt);
    const cur = input.materials.find((x) => x.key === key);
    if (cur && prompt && prompt !== cur.prompt) materials[key] = prompt;
  }
  const details = Array.isArray(raw.details) ? normalizeMaterialSpecs(raw.details) : null;
  const sameDetails = details !== null && JSON.stringify(details) === JSON.stringify(input.rules.details);
  const drop = (Array.isArray(raw.dropProductRefs) ? raw.dropProductRefs : [])
    .map(Number)
    .filter((n) => !input.photos && Number.isInteger(n) && n >= 1 && n <= photoCount(input));
  // Never drop every photo.
  const dropProductRefs = drop.length < input.rules.productRefs.length ? [...new Set(drop)].map((n) => input.rules.productRefs[n - 1]) : [];

  const out: ReviewResult = {
    review: { issues: [], dropProductRefs, model: reviewModel() },
    spec: spec && spec !== input.spec ? spec : null,
    style: style && input.style && style !== input.style.prompt ? style : null,
    materials,
    details: details && details.length && !sameDetails ? details : null,
  };
  const fixedLayer = (layer: CtReviewLayer, target: string): boolean => {
    if (layer === "spec") return out.spec !== null;
    if (layer === "style") return out.style !== null;
    if (layer === "material") return target ? target.toUpperCase() in materials : Object.keys(materials).length > 0;
    if (layer === "details") return out.details !== null;
    return dropProductRefs.length > 0;
  };
  out.review.issues = raw.issues.map(record).flatMap((x): CtReviewIssue[] => {
    const layer = LAYERS.find((l) => l === str(x.layer)) ?? null;
    const problem = str(x.problem);
    if (!layer || !problem) return [];
    const target = str(x.target);
    return [{ layer, target, severity: x.severity === "low" ? "low" : "high", problem: clip(problem, 600), fix: clip(str(x.fix), 600), fixed: fixedLayer(layer, target) }];
  });
  return out;
}

/** The review keeps only what the caller could apply: a layer it could not change is reported, not "fixed". */
export function unfix(review: CtPromptReview, layer: CtReviewLayer, target?: string): void {
  for (const i of review.issues) if (i.layer === layer && (target === undefined || i.target.toUpperCase() === target)) i.fixed = false;
}

/** One line per issue, for a summary box (Vietnamese). */
export function reviewSummary(r: CtPromptReview): string {
  if (!r.issues.length) return "Kiểm tra prompt: không thấy xung đột.";
  const name: Record<CtReviewLayer, string> = { spec: "Spec", style: "Style pack", material: "Vật liệu", details: "Chi tiết", productRefs: "Ảnh thành phẩm" };
  return [
    `Kiểm tra prompt: ${r.issues.length} vấn đề`,
    ...r.issues.map((i) => `• [${name[i.layer]}${i.target ? ` ${i.target}` : ""}] ${i.problem}${i.fixed ? " → đã sửa" : i.fix ? ` → ${i.fix}` : ""}`),
  ].join("\n");
}
