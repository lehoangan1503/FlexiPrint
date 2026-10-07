/**
 * "Tạo bằng AI" in the category dialog — a small agent on a vision LLM on fal.ai (any-llm):
 *   1. analysis: reads the editor's note, the name (if any) and up to 4 reference images, and drafts the whole
 *      category — name, spec, style pack, materials, chi tiết thành phẩm;
 *   2. library lookup: runs the library tools (server/ai/library-tools.ts — the same ones the MCP endpoint
 *      serves) for the existing style packs, materials and other categories' details;
 *   3. matching: a second pass compares each draft with the library and reuses what fits, so a new category
 *      does not mint yet another copy of the same style pack / acrylic / jump ring. Only the spec is per category.
 * The style pack / material dialogs use the same LLM for one prompt each (suggestPresetPrompt).
 *
 * The spec and the style pack are the two layers studio/context.py composes before the subject line
 * (style pack → category spec → subject → rules), so the system prompt keeps them apart: the spec says WHAT
 * the kind of object is, the style pack says HOW everything is drawn, and neither repeats the rules
 * (framing, background, no text) the studio already appends.
 *
 * The LLM and its helpers: server/ai/llm.ts. Every result that changes a category's prompts goes through the
 * review (server/ai/prompt-review.ts) before the editor sees it.
 */

import { NextResponse } from "next/server";
import { normalizeMaterialSpecs } from "../../lib/materials";
import { CT_TABLES } from "../../config";
import { normalizeCategoryRules } from "../../lib/library";
import { isOwnUploadUrl, recordCategoryHistory, recordPresetHistory } from "../library";
import { askLlm, clip, jsonError, jsonObject, MAX_IMAGE_BYTES, promptModel, readSavedRefs, record, str } from "./llm";
import type { CtSession } from "../supabase";
import { loadLibraryCatalog, type CtLibraryCatalog, type LibraryDb } from "./library-tools";
import { reviewCategory, reviewSummary, unfix, type ReviewInput, type ReviewMaterial } from "./prompt-review";
import type {
  CtCategoryRevision,
  CtCategoryRules,
  CtCategorySnapshot,
  CtDetailsSuggestion,
  CtPreset,
  CtReviseAction,
  CtRevisePreset,
  CtReviseRefRole,
  CtMaterialSpec,
  CtPresetPromptSuggestion,
  CtPromptSuggestion,
  CtRefineImagePlan,
  CtRefineSuggestion,
  CtReviewIssue,
  CtProductShape,
  CtRefRole,
  CtSuggestedPreset,
} from "../../types";

const MAX_IMAGES = 4;
/** A refine run edits up to 12 cliparts (services/comfy recipes.py): the analysis sees them all. */
const MAX_REFINE_IMAGES = 12;

/**
 * Chi tiết thành phẩm (CtCategoryRules.details): what the finished product of a category has besides its
 * material. Shared by the category assistant and the details analysis.
 */
export const DETAILS_RULES = `DETAILS — the finished product's parts besides the flat artwork and its material: holes, rings, jump rings, springs, chains, cords, ribbons, tassels, clasps, keyrings, clips, pins, magnets, stands, bases, charms, bells, handles… Products vary widely (ornaments, keychains, visor clips, stickers, pins, standees, magnets, mugs, patches…), so read what THIS product has from the photos and the note — never assume a hole, a cord or any part it does not show or ask for.
First study every photo of the finished product closely, part by part. The editor may have drawn marks over a photo (dots, circles, boxes, arrows, scribbles, numbers, handwriting): they point at a detail or at where it goes — read them with the note ("chấm đỏ = lỗ đục" → the hole goes where the red dot is). The marks are never part of the product.
ONE entry PER distinct detail — never merge two (a hole, the spring through it and the cord are three), never drop one, never invent one. A part only visible from the back (a clip on the back) is still a detail: say it is on the back. Each:
- "text": 1–3 sentences, English, literally as the photos show it: what it is, shape, material, colour, size relative to the piece (small and neat when the photos show it so), how it touches / passes through / hangs from the piece or another detail ("a thin gold jump ring through the hanging hole"), and WHERE it is, in words relative to the artwork's own shape — "at the top of the piece, centred above the artwork's highest point", "on the left edge, level with the face", or where the editor's mark puts it. Never mention the marks or the photos. Never describe the material itself (that is the material preset) nor the artwork.
  Every clipart of a category is a different model (a low sports car, a tall tractor…) and is edited ALONE, so the wording is all that keeps them alike: ONE anchor per position, on a part every member has — never two that can disagree ("at the top edge of the piece" + "above the roof" when another part is higher than the roof); sizes of small parts as fractions of the artwork's width (a hole's diameter ≈4%), and what joins them to the piece ("no neck or bridge of extra plate").
  A "version" detail names its OWN part first and what it attaches to only as a place ("a gold cord loops through the hole in the tab") — its text is also quoted as "not in this picture" on the base, so it must never read as the base's required parts.
- "mode": "always" when it is part of every version of the product; "version" when the editor wants a version with AND one without it, or when it is a loose accessory outside the piece (cord, ribbon, chain, tassel, keyring) — made as an extra version of the same picture.
- "label": for "version", the version's short name in the editor's language (e.g. "có dây"); "" otherwise.
Order them so a detail comes after the one it depends on (the hole before the ring, the ring before the cord). A scene, a background or props around the product (a tree, a table, a hand, a car dashboard) are not details.`;

export const SYSTEM = `You write prompts for an AI image pipeline that generates print-ready clipart sets.
The final prompt is assembled from layers, in this order:
  1. STYLE PACK — how everything in the set is drawn. Reused across many categories.
  2. CATEGORY SPEC — what kind of object every clipart in this category is.
  3. SUBJECT LINE — written per clipart later (e.g. "red sedan", "blue pickup").
  4. RULES — appended automatically: framing, size, white background, no text, no shadow, print quality.

Write layers 1 and 2 only, in English — plus MATERIALS when there are any (see below), the PRODUCT SHAPE and the category NAME.

PRODUCT SHAPE ("shape") — decide it first, from the editor's note and the product photos; it changes how everything below is written:
- "alpha": the product is cut along the artwork's own outline (a die-cut acrylic charm / keychain / standee, a sticker, a cut-out pin). The clipart is the object ALONE on an empty background, and its outline is the product's outline.
- "frame": the product has a FIXED shape of its own whatever is printed on it (a round or heart ceramic ornament, a mug, a framed print, a phone case, a pillow, a pair of printed trousers / pyjamas, a t-shirt all-over print). The clipart is a FULL-BLEED flat picture — the subject with its own background scene filling the whole square edge to edge; the product's shape (and any hole punched in it) is cut from that picture later by the product's khuôn, never drawn by the image model.
When unsure, the editor's words decide ("tròn", "ornament sứ", "khung", "cái quần" → frame; "cắt theo hình", "die-cut", "acrylic theo viền" → alpha).

NAME: the editor's name when given; otherwise a short name for the category (2–4 words, Title Case, e.g. "Chibi Car").

CATEGORY SPEC (30–70 words):
- The structure every member shares: body type, proportions, fixed parts and where they sit, viewing angle.
- Customisation areas that must stay empty, if the editor mentions them (e.g. "blank face area on the helmet, no facial features").
- Character traits seen in the references belong here (e.g. cartoon eyes on the windshield, a smiling mouth on the bumper).
- The viewing angle every clipart shares (e.g. "front 3/4 view from slightly above") — the rules do not set one.
- Only list things that must never appear if they are true for EVERY member (an origin set may have police lights, a driver…).
- Every clipart of the category is its own origin (a different model of the same kind): describe only what is common; leave model, colour and details to the subject line.
- NO drawing style, line work, shading or finish (that is the style pack).
- NO framing, background, size, text or watermark rules (appended automatically).
- shape "frame": the spec describes the whole picture — the subject AND the background scene behind it (sky, clouds, a rainbow, a pattern…), how it is laid out in the square, and the areas kept for customer content (a name, a photo); still no outline or shape of the product.

STYLE PACK (40–80 words) + a short name (2–4 words, Title Case):
- Rendering medium and look, read precisely from the references: outline thickness (thin / medium / thick) and colour, shading type (flat cel, soft gradient, airbrushed), palette character, lighting, surface finish (glossy, matte, glitter), level of detail (simple cartoon vs detailed) — never say "high detail" for a simple cartoon.
- Generic: it must work for any object, so never name the object or its parts.
- NO subject content, NO background / framing / text rules.

MATERIALS (0–3): the physical product the flat clipart is turned into afterwards (acrylic plate, glitter, wood, ceramic, enamel pin…). Each material is applied by an image-EDIT model to the finished flat clipart, which must stay identical.
- Write one ONLY when the references clearly show a physical finish (a printed acrylic charm, glitter, a wooden cut-out…) or the editor's note asks for one. Otherwise return an empty list — never invent one.
- Each: a short name (2–4 words, the editor's language when the note names it, e.g. "Acrylic trong") and a prompt (40–80 words): only the material's look as a real product photo-cutout — what it is, transparency / colour, thickness, how far it reaches past the artwork, the edge, surface finish and highlights, read from the references — ending with the defects to avoid as plain negatives (e.g. "no haze, no milky tint, no glow, no halo"). No "keep the artwork", background, framing or scene (the pipeline adds those); no details (holes, cords, clips…).
- The material never goes into the spec or the style pack, and the style pack describes the flat drawing (no glitter / acrylic there when it is the material).
- A material is reused by many categories and products: only the material's look — never a hole, a cord, a clip or any other part (those are DETAILS).
- shape "frame": the piece's outline is fixed by the khuôn, so the material is its SURFACE only — glaze / gloss / matte, highlights, the edge's thickness seen from the front — never a plate, border or margin reaching past the picture, never the outline's shape.

${DETAILS_RULES}
The flat clipart (spec, style pack) NEVER shows a detail: the flat file goes to the factory as is; details only appear on the material versions. Return [] when there is no finished product to read.
shape "frame": a hole punched through the piece is part of the khuôn (cut out of the picture before the material is drawn) — not a detail; what hangs from it (a ribbon, a gold cord) still is.

REF ROLES: for each attached image, in order, "product" when it shows the finished physical product (a photo of the acrylic piece, the clip, the cord…), "design" when it shows the artwork / object to draw. Product photos are sent with the material step, design photos with the flat drawing.

Use the reference images to read the style and the object's structure. Follow the editor's note; it may be in Vietnamese. Fix spelling mistakes from the current spec.
Reply with JSON only, no markdown: {"name": "...", "shape": "alpha", "spec": "...", "style": {"name": "...", "prompt": "..."}, "materials": [{"name": "...", "prompt": "..."}], "details": [{"text": "...", "mode": "always", "label": ""}], "refRoles": ["design", "product"]}`;

/** The analysis pass's draft: everything written new, before the library is checked. */
interface CategoryDraft {
  name: string;
  spec: string;
  style: { name: string; prompt: string };
  materials: Array<{ name: string; prompt: string }>;
  details: CtMaterialSpec[];
  refRoles: CtRefRole[];
  shape: CtProductShape;
}

function parseDraft(text: string, imageCount: number, givenName: string): CategoryDraft | null {
  const raw = jsonObject(text);
  const style = raw?.style && typeof raw.style === "object" ? (raw.style as Record<string, unknown>) : null;
  const spec = str(raw?.spec);
  const styleName = str(style?.name);
  const prompt = str(style?.prompt);
  const materials = (Array.isArray(raw?.materials) ? raw.materials : [])
    .map((m: unknown) => (m && typeof m === "object" ? (m as Record<string, unknown>) : {}))
    .map((m) => ({ name: str(m.name).slice(0, 80), prompt: str(m.prompt) }))
    .filter((m) => m.name && m.prompt)
    .slice(0, 3);
  const roles = Array.isArray(raw?.refRoles) ? raw.refRoles : [];
  const refRoles = Array.from({ length: imageCount }, (_, i): CtRefRole => (roles[i] === "product" ? "product" : "design"));
  const name = (givenName || str(raw?.name)).slice(0, 120);
  return spec && styleName && prompt ? { name, spec, style: { name: styleName, prompt }, materials, details: normalizeMaterialSpecs(raw?.details), refRoles, shape: raw?.shape === "frame" ? "frame" : "alpha" } : null;
}

/** Uploaded reference images → data URIs, or an error response. */
async function readImages(form: FormData, field: string): Promise<string[] | NextResponse> {
  const files = form.getAll(field).filter((f): f is File => f instanceof File).slice(0, MAX_IMAGES);
  const images: string[] = [];
  for (const f of files) {
    if (!f.type.startsWith("image/")) return jsonError(`${f.name}: không phải ảnh`, 400);
    if (f.size > MAX_IMAGE_BYTES) return jsonError(`${f.name}: ảnh quá lớn (tối đa 6MB)`, 400);
    images.push(`data:${f.type};base64,${Buffer.from(await f.arrayBuffer()).toString("base64")}`);
  }
  return images;
}

function categoryLines(name: string, usage: string, mode: string, spec: string): string[] {
  return [
    `Category name: ${name || "(none)"}`,
    `Used as: ${usage === "main" ? "main object (the product blank customers personalise)" : "element placed into a customisation zone"}`,
    `Set type: ${mode === "variant_set" ? "variant set — one shape in many colours / styles" : "origin set — many different models of one kind"}`,
    `Current spec: ${spec || "(empty)"}`,
  ];
}

/**
 * Library check (step 3): each draft against what the library already has. Handles (S1, M2, D3.1) instead of
 * ids — the LLM copies those reliably — mapped back in matchDraft.
 */
const MATCH_SYSTEM = `You keep a print-clipart library free of duplicates. A new category was just drafted from the editor's references; the library already has style packs, materials and other categories' product details. Decide, for each draft, whether an existing record is the SAME thing and should be reused instead of creating a new one.

STYLE PACK — reuse an existing pack only when it describes the same look: same outline (thickness, colour), same shading type (flat cel / soft gradient / airbrushed…), same finish (glossy / matte), same level of detail and palette character. Different wording for the same look is still the same. A clearly different look → null (a new pack is created).
MATERIALS — per draft material: reuse an existing material only when it is the same physical material and finish (clear acrylic vs white acrylic vs glitter vs wood are different; thickness / edge wording may differ). Otherwise null. Two drafts never reuse the same material.
DETAILS — per draft detail: the handle of an existing detail that is the SAME part in the same place (e.g. "a small hanging hole at the top" = "a round hole at the top centre"), so its wording is reused; null when none is.
EDITOR'S NOTE wins: when it asks for the look / material / details of an existing category or preset ("giống bộ Chibi Car", "dùng acrylic như cũ"), reuse that category's style pack (see "used by") / that record.
"reason": one short sentence IN VIETNAMESE (why it is the same / what differs). Name records by their name in quotes — never by handle (S1, M2…).

Reply with JSON only: {"style": {"reuse": "S1" | null, "reason": "..."}, "materials": [{"reuse": "M1" | null, "reason": "..."}], "details": [{"reuse": "D1.2" | null}]}`;

function matchPrompt(draft: CategoryDraft, cat: CtLibraryCatalog, note: string): string {
  const lines = [
    `EDITOR'S NOTE: ${note || "(none)"}`,
    "",
    "DRAFT",
    `style pack "${draft.style.name}": ${draft.style.prompt}`,
    ...draft.materials.map((m, i) => `material ${i + 1} "${m.name}": ${m.prompt}`),
    ...draft.details.map((d, i) => `detail ${i + 1} (${d.mode}${d.label ? ` "${d.label}"` : ""}): ${d.text}`),
    "",
    "LIBRARY — list_style_packs",
    ...(cat.stylePacks.length ? cat.stylePacks.map((p, i) => `S${i + 1} "${p.name}"${p.usedBy.length ? ` (used by ${p.usedBy.join(", ")})` : ""}: ${clip(p.prompt, 700)}`) : ["(none)"]),
    "LIBRARY — list_materials",
    ...(cat.materials.length ? cat.materials.map((m, i) => `M${i + 1} "${m.name}"${m.art ? ` [${m.art}]` : ""}: ${clip(m.prompt, 700)}`) : ["(none)"]),
    "LIBRARY — list_product_details",
    ...(cat.detailSets.length ? cat.detailSets.flatMap((d, i) => [`category "${d.category}":`, ...d.details.map((x, j) => `  D${i + 1}.${j + 1} (${x.mode}): ${clip(x.text, 300)}`)]) : ["(none)"]),
  ];
  return lines.join("\n");
}

interface MatchReply {
  style: { reuse: string | null; reason: string };
  materials: Array<{ reuse: string | null; reason: string }>;
  details: Array<string | null>;
}

function parseMatch(text: string): MatchReply {
  const raw = jsonObject(text);
  const pick = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const handle = (v: unknown) => (typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "null" ? v.trim().toUpperCase() : null);
  const style = pick(raw?.style);
  const reason = (v: unknown) => str(v).replace(/\b[SMD]\d+(\.\d+)?\b/g, "").replace(/\(\s*\)/g, "").replace(/\s{2,}/g, " ").replace(/\s+([.,])/g, "$1").trim();
  return {
    style: { reuse: handle(style.reuse), reason: reason(style.reason) },
    materials: (Array.isArray(raw?.materials) ? raw.materials : []).map((m: unknown) => ({ reuse: handle(pick(m).reuse), reason: reason(pick(m).reason) })),
    details: (Array.isArray(raw?.details) ? raw.details : []).map((d: unknown) => handle(pick(d).reuse)),
  };
}

/** Draft + the library's answer → the suggestion; handles that point nowhere fall back to the draft. */
function applyMatch(draft: CategoryDraft, cat: CtLibraryCatalog, m: MatchReply): CtPromptSuggestion {
  const byHandle = <T>(list: T[], prefix: string, h: string | null): T | null => {
    const n = h && h.startsWith(prefix) ? Number(h.slice(prefix.length)) : NaN;
    return Number.isInteger(n) && n >= 1 && n <= list.length ? list[n - 1] : null;
  };
  const packHit = byHandle(cat.stylePacks, "S", m.style.reuse);
  const style: CtSuggestedPreset = packHit
    ? { name: packHit.name, prompt: packHit.prompt, reuseId: packHit.id, reason: m.style.reason }
    : { ...draft.style, reuseId: null, reason: m.style.reason };
  const taken = new Set<string>();
  const materials = draft.materials.map((d, i): CtSuggestedPreset => {
    const hit = byHandle(cat.materials, "M", m.materials[i]?.reuse ?? null);
    const reason = m.materials[i]?.reason ?? "";
    if (!hit || taken.has(hit.id)) return { ...d, reuseId: null, reason };
    taken.add(hit.id);
    return { name: hit.name, prompt: hit.prompt, reuseId: hit.id, reason };
  });
  const detailSources: Array<string | null> = [];
  const details = draft.details.map((d, i) => {
    const h = m.details[i] ?? null;
    const [set, item] = h?.startsWith("D") ? h.slice(1).split(".").map(Number) : [NaN, NaN];
    const src = Number.isInteger(set) ? cat.detailSets[set - 1] : undefined;
    const hit = src && Number.isInteger(item) ? src.details[item - 1] : undefined;
    detailSources.push(hit && src ? src.category : null);
    // The library's wording; this category's own mode / label (one category may want it as a version, another always).
    return hit ? { ...d, text: hit.text } : d;
  });
  return {
    name: draft.name,
    spec: draft.spec,
    style,
    materials,
    details,
    shape: draft.shape,
    detailSources,
    refRoles: draft.refRoles,
    summary: summarize(style, materials, detailSources, draft.shape),
    review: null,
  };
}

function summarize(style: CtSuggestedPreset, materials: CtSuggestedPreset[], detailSources: Array<string | null>, shape: CtProductShape): string {
  const preset = (label: string, p: CtSuggestedPreset) => `${label}: ${p.reuseId ? `dùng lại “${p.name}”` : `tạo mới “${p.name}”`}${p.reason ? ` — ${p.reason}` : ""}`;
  const reused = detailSources.filter(Boolean).length;
  return [
    shape === "frame"
      ? "Hình dạng: theo khuôn — sản phẩm hình cố định, clipart là ảnh phẳng full nền; vẽ “Khuôn vật liệu” (K) trong sản phẩm"
      : "Hình dạng: theo alpha — cắt theo viền clipart",
    preset("Style pack", style),
    ...materials.map((m) => preset("Vật liệu", m)),
    ...(detailSources.length ? [`Chi tiết thành phẩm: ${detailSources.length} chi tiết${reused ? `, ${reused} dùng lại cách viết từ ${[...new Set(detailSources.filter(Boolean))].join(", ")}` : ""}`] : []),
  ].join("\n");
}

/**
 * A whole category drafted by the agent (submit_result of a "create" task, SYSTEM's JSON) → the suggestion the
 * dialog shows. Style pack / materials either reuse a library preset by id ({"reuseId": "<uuid>"}) or are new
 * ({"name", "prompt"}). Null when the draft is unusable.
 */
export function suggestionFromAgent(raw: Record<string, unknown>, catalog: CtLibraryCatalog, refCount: number, givenName: string): CtPromptSuggestion | null {
  const pick = <T extends { id: string; name: string; prompt: string }>(list: T[], v: unknown): CtSuggestedPreset | null => {
    const o = record(v);
    const hit = list.find((x) => x.id === str(o.reuseId)) ?? null;
    if (hit) return { name: hit.name, prompt: hit.prompt, reuseId: hit.id, reason: str(o.reason) };
    return str(o.name) && str(o.prompt) ? { name: str(o.name).slice(0, 80), prompt: str(o.prompt), reuseId: null, reason: str(o.reason) } : null;
  };
  const spec = str(raw.spec);
  const style = pick(catalog.stylePacks, raw.style);
  if (!spec || !style) return null;
  const materials = (Array.isArray(raw.materials) ? raw.materials : []).map((m) => pick(catalog.materials, m)).filter((m): m is CtSuggestedPreset => m !== null).slice(0, 3);
  const details = normalizeMaterialSpecs(raw.details);
  const roles = Array.isArray(raw.refRoles) ? raw.refRoles : [];
  const detailSources = details.map(() => null);
  const shape: CtProductShape = raw.shape === "frame" ? "frame" : "alpha";
  return {
    name: (givenName || str(raw.name)).slice(0, 120),
    spec,
    style,
    materials,
    details,
    shape,
    detailSources,
    refRoles: Array.from({ length: refCount }, (_, i): CtRefRole => (roles[i] === "product" ? "product" : "design")),
    summary: str(raw.summary) || summarize(style, materials, detailSources, shape),
    review: null,
  };
}

/** POST ai/prompt-suggest — multipart: name?, spec?, note?, file × ≤4 → CtPromptSuggestion. */
export async function suggestCategoryPrompts(session: CtSession, form: FormData): Promise<NextResponse> {
  const name = String(form.get("name") ?? "").trim();
  const spec = String(form.get("spec") ?? "").trim();
  const note = String(form.get("note") ?? "").trim();
  const images = await readImages(form, "file");
  if (images instanceof NextResponse) return images;
  if (!name && !note && !spec && images.length === 0) return jsonError("Nhập tên, ghi chú hoặc thả ảnh tham khảo", 400);

  // 1. Analysis.
  const prompt = [
    `Category name: ${name || "(none — write one)"}`,
    `Current spec: ${spec || "(empty)"}`,
    `Editor's note: ${note || "(none)"}`,
    images.length ? `${images.length} reference image(s) attached.` : "No reference images.",
  ].join("\n");
  const reply = await askLlm(SYSTEM, prompt, images);
  if (reply instanceof NextResponse) return reply;
  const draft = parseDraft(reply, images.length, name);
  if (!draft) return jsonError("AI trả về không đúng định dạng — thử lại", 502);

  // 2. Library lookup — the data behind the MCP tools list_style_packs / list_materials / list_product_details.
  let catalog: CtLibraryCatalog;
  try {
    catalog = await loadLibraryCatalog(session.supabase);
  } catch (e) {
    return jsonError(`Không đọc được thư viện: ${e instanceof Error ? e.message : String(e)}`, 500);
  }
  const nothingToMatch =
    !catalog.stylePacks.length && !(draft.materials.length && catalog.materials.length) && !(draft.details.length && catalog.detailSets.length);
  const empty: MatchReply = { style: { reuse: null, reason: "" }, materials: [], details: [] };
  let match = empty;
  if (!nothingToMatch) {
    // 3. Matching (text only: the draft already describes the references precisely).
    const matchReply = await askLlm(MATCH_SYSTEM, matchPrompt(draft, catalog, note), []);
    // A failed check never loses the draft: everything is then created new.
    if (!(matchReply instanceof NextResponse)) match = parseMatch(matchReply);
  }
  const suggestion = applyMatch(draft, catalog, match);

  // 4. Review of the assembled prompts; fixes go into what is written new (a reused preset stays as it is).
  const productPhotos = images.filter((_, i) => draft.refRoles[i] === "product");
  await reviewSuggestion(suggestion, catalog, productPhotos);
  return NextResponse.json(suggestion);
}

async function reviewSuggestion(sg: CtPromptSuggestion, catalog: CtLibraryCatalog, photos: string[]): Promise<void> {
  const usedBy = (id: string | null, list: Array<{ id: string; usedBy: string[] }>) => (id ? (list.find((x) => x.id === id)?.usedBy ?? []) : []);
  const input: ReviewInput = {
    name: sg.name,
    usage: "main",
    spec: sg.spec,
    style: { name: sg.style.name, prompt: sg.style.prompt, usedByOthers: usedBy(sg.style.reuseId, catalog.stylePacks) },
    materials: sg.materials.map((m, i) => ({
      key: `M${i + 1}`,
      name: m.name,
      prompt: m.prompt,
      art: catalog.materials.find((x) => x.id === m.reuseId)?.art === "surface" ? "surface" : "print",
      usedByOthers: usedBy(m.reuseId, catalog.materials),
    })),
    rules: { details: sg.details, productRefs: [], detailsNote: "", fill: 0.85, anchor: "center", shape: sg.shape },
    photos,
  };
  const r = await reviewCategory(input);
  sg.review = r?.review ?? null;
  if (!r) return;
  if (r.spec) sg.spec = r.spec;
  if (r.style && !sg.style.reuseId) sg.style = { ...sg.style, prompt: r.style };
  else unfix(r.review, "style");
  sg.materials = sg.materials.map((m, i) => {
    const fixed = r.materials[`M${i + 1}`];
    if (!fixed) return m;
    if (m.reuseId) {
      unfix(r.review, "material", `M${i + 1}`);
      return m;
    }
    return { ...m, prompt: fixed };
  });
  if (r.details) {
    sg.details = r.details;
    sg.detailSources = r.details.map(() => null);
  }
  sg.summary = [sg.summary, reviewSummary(r.review)].join("\n");
}

// ---------------------------------------------------------------------------
// Style pack / material dialog: description + references → one prompt
// ---------------------------------------------------------------------------

const PRESET_SYSTEM: Record<"style_pack" | "material", string> = {
  style_pack: `You write a STYLE PACK prompt for an AI image pipeline that generates print-ready clipart sets.
The final prompt is: STYLE PACK → category spec (what the object is) → subject line → fixed rules (framing, white background, no text). The style pack is reused across many categories, so it says only HOW everything is drawn.
Write 40–80 words, in English: rendering medium and look read precisely from the reference images and the editor's description — outline thickness (thin / medium / thick) and colour, shading type (flat cel, soft gradient, airbrushed), palette character, lighting, surface finish (glossy, matte), level of detail (simple cartoon vs detailed; never "high detail" for a simple cartoon).
- Generic: never name the object or its parts, never describe what is drawn.
- No background, framing, size or text rules (appended automatically). No physical material (acrylic, glitter plate, wood) — that is a separate material preset.
Also give a short name (2–4 words, Title Case, or the editor's own name for it).
The description may be in Vietnamese. Reply with JSON only, no markdown: {"name": "...", "prompt": "..."}`,
  material: `You write a MATERIAL preset for an AI image pipeline. It turns one finished flat print clipart into a photo-cutout of the physical product. A material is reused by many categories and products (the same clear acrylic makes ornaments, visor clips, keychains…), so it says ONLY how the material looks.
The pipeline already takes care of: keeping the printed artwork identical, the background, the framing, the editor's reference photos (the image model gets them too) and the product's details — holes, rings, cords, clips, stands… belong to each category, never to the material. Never write any of that, even when the photos show it.

Study the reference photos closely: the piece's material — transparency, colour, thickness, edge, finish. The editor may have drawn marks or notes over a photo; read them, never describe them.

Return:
1. "prompt" (40–80 words, English): the material's look as a real product photo-cutout — what it is, transparency / colour, thickness, how far it reaches past the artwork (e.g. "only a very thin 1–2 mm margin hugging the artwork"), the edge (a crisp polished line, a bevel), surface finish and highlights. End with the defects to avoid as plain negatives, e.g. "no frosting, no haze, no milky or grey tint, no glow, no halo, no shadow".
2. "art": "print" when the artwork is printed unchanged and the material is around / behind / under it (clear or white acrylic, wood, metal, ceramic); "surface" when the material changes the artwork's own surface (glitter, embroidery, holographic foil, enamel).
3. a short "name" (2–4 words, the editor's language when the description names it, e.g. "Acrylic trong").
The description may be in Vietnamese. Reply with JSON only, no markdown: {"name": "...", "prompt": "...", "art": "print"}`,
};

/** The preset dialog's photos (MAX_PRESET_REFS): the analysis sees them all. */
const MAX_PRESET_IMAGES = 6;

/**
 * POST ai/preset-prompt — multipart: kind (style_pack | material), preset_id?, name?, note, prompt? (current),
 * ref_url × ≤6 (the photos, uploaded first), file × ≤4 (photos not uploaded) → CtPresetPromptSuggestion.
 * Recorded in the preset's history (migration 008) with the photos' urls.
 */
export async function suggestPresetPrompt(session: CtSession, form: FormData): Promise<NextResponse> {
  const kind = String(form.get("kind") ?? "");
  if (kind !== "style_pack" && kind !== "material") return jsonError("Loại preset không hợp lệ", 400);
  const name = String(form.get("name") ?? "").trim();
  const note = String(form.get("note") ?? "").trim();
  const current = String(form.get("prompt") ?? "").trim();
  const uploaded = await readImages(form, "file");
  if (uploaded instanceof NextResponse) return uploaded;
  const refUrls = form.getAll("ref_url").map(String).filter(isOwnUploadUrl).slice(-MAX_PRESET_IMAGES);
  const images = [...(await readSavedRefs(refUrls)), ...uploaded].slice(-MAX_PRESET_IMAGES);
  if (!note && images.length === 0) return jsonError("Mô tả chi tiết hoặc thả ảnh tham khảo", 400);
  const prompt = [
    `Name given by the editor: ${name || "(none)"}`,
    `Editor's description: ${note || "(none)"}`,
    `Current prompt (improve it, keep what still fits): ${current || "(empty)"}`,
    images.length ? `${images.length} reference image(s) attached.` : "No reference images.",
  ].join("\n");
  const reply = await askLlm(PRESET_SYSTEM[kind], prompt, images);
  if (reply instanceof NextResponse) return reply;
  const raw = jsonObject(reply);
  const out: CtPresetPromptSuggestion = { name: str(raw?.name).slice(0, 80) || name, prompt: str(raw?.prompt) };
  if (kind === "material") out.art = raw?.art === "surface" ? "surface" : "print";
  if (!out.prompt || !out.name) return jsonError("AI trả về không đúng định dạng — thử lại", 502);
  const presetId = String(form.get("preset_id") ?? "");
  const history = await recordPresetHistory(session, {
    preset_id: /^[0-9a-f-]{36}$/i.test(presetId) ? presetId : null,
    kind,
    event: "analysis",
    note,
    ref_urls: refUrls,
    input: { name, prompt: current },
    result: { name: out.name, prompt: out.prompt, ...(out.art ? { art: out.art } : {}) },
    model: promptModel(),
  });
  if (history) out.history = history;
  return NextResponse.json(out);
}

// ---------------------------------------------------------------------------
// Category dialog: "Cập nhật bằng AI" — feedback on results → what to change in the category
// ---------------------------------------------------------------------------

export const REVISE_SYSTEM = `You maintain the prompts of one category of an AI print-clipart pipeline. The editor is not happy with what the category produces and says what is wrong (FEEDBACK), usually about the numbered result images attached, sometimes with new reference photos. Find WHERE the problem comes from and change only that.

HOW THE CATEGORY PRODUCES IMAGES — each layer only affects some steps:
- CLIPART GỐC (flat drawing, the file the factory prints): STYLE PACK (how it is drawn: outline, shading, palette, finish, detail level — shared with other categories) + CATEGORY SPEC (what every clipart of the category is: structure, proportions, fixed parts and where they sit, viewing angle, blank customisation areas) + the clipart's own subject line + fixed rules (framing, white background, no text). The image model also SEES the category's saved design references.
- ĐA SẮC: a recolour / restyle of a finished gốc — same shape. A problem visible only there is rarely a category problem.
- VẬT LIỆU versions: an image-EDIT of the flat gốc: MATERIAL prompt (only the material's look: acrylic, glitter, wood… — shared with other categories) + CHI TIẾT THÀNH PHẨM (this category's product parts: hole, ring, cord, clip… mode "always" = on every material version, "version" = one extra version with it) + saved product photos.
So: wrong shape / proportions / parts / angle on the gốc → SPEC. Wrong line work / shading / colours feel / finish everywhere → STYLE PACK. Wrong material look (cloudy acrylic, thick edge…) → MATERIAL. Wrong / missing / misplaced hole, cord, clip… → DETAILS. A single clipart's own identity (its model, livery) is its subject line, not the category — say so in the diagnosis and change nothing for it.

RULES
- Read the FEEDBACK closely; "hình 2" / "ảnh số 2" / "#2" means the image with badge #2. Look at the images and measure against what they show now (sizes as fractions of the object).
- Change ONLY the layers the feedback really points at. Everything else: keep. Never rewrite a layer just to polish it.
- SPEC: when changed, return the FULL spec as a MERGE: copy every sentence the feedback does not contradict WORD FOR WORD; replace the sentences it makes wrong; add new ones with literal, measured wording (sizes as fractions, orientation, positions). No drawing style (style pack), no material, no details, no framing / background rules. English. Otherwise null.
- STYLE PACK: "keep" unless the feedback is about how things are drawn. Then, FIRST look at the LIBRARY: if another style pack already has the wanted look, "switch" to it. Otherwise "edit": the FULL merged prompt (same MERGE rule; generic — never name the object). Use "new" only when the wanted look is a different style altogether (then name + full prompt). Note: an edit changes every category using that pack (listed as "used by").
- MATERIALS: one entry per CURRENT material ("keep" | "switch" to a better library material | "edit" with the full merged prompt — only the material's look, ending with plain negatives, never details | "remove"). Plus "add" entries when the feedback asks for a material the category does not have — reuse a library one ("switchTo") whenever one fits, else name + prompt.
- DETAILS: when the feedback is about the product's parts, the FULL new list (keep unchanged entries word for word): each {"text" (English, 1–3 sentences, literal, where it sits relative to the artwork), "mode": "always" | "version", "label" (version name in the editor's language, else "")}. Order dependencies first (hole before ring before cord). Otherwise null.
- REFERENCE PHOTOS the editor added: for each, "design" when it shows how the clipart itself should look (kept with the category, sent to the flat drawing), "product" when it shows the finished physical product (kept with the details, sent to the material step), "none" when it only illustrates the feedback.
- "why" fields and "diagnosis": IN VIETNAMESE, short and concrete. The diagnosis says what is wrong on which images (by number) and which layer causes it, and what stays as is.

Reply with JSON only:
{"diagnosis": "...",
 "spec": {"text": "...", "why": "..."} | null,
 "style": {"action": "keep" | "switch" | "edit" | "new", "switchTo": "S2" | null, "name": "...", "prompt": "...", "why": "..."},
 "materials": [{"handle": "M1", "action": "keep" | "switch" | "edit" | "remove", "switchTo": "M3" | null, "prompt": "...", "why": "..."}],
 "add": [{"switchTo": "M4" | null, "name": "...", "prompt": "...", "why": "..."}],
 "details": {"list": [{"text": "...", "mode": "always", "label": ""}], "why": "..."} | null,
 "refRoles": ["design"]}`;

const MAX_REVISE_RESULTS = 12;
const MAX_REVISE_REFS = 4;

function revisePrompt(cat: CtCategorySnapshot, style: CtPreset | null, current: CtPreset[], lib: CtLibraryCatalog, note: string, labels: string[], refCount: number, saved: { design: number; product: number }): string {
  const handleOf = (list: Array<{ id: string }>, prefix: string, id: string) => `${prefix}${list.findIndex((x) => x.id === id) + 1}`;
  return [
    `CATEGORY "${cat.name}"`,
    `SPEC: ${cat.spec || "(empty)"}`,
    `STYLE PACK: ${style ? `${handleOf(lib.stylePacks, "S", style.id)} "${style.name}": ${style.prompt}` : "(none)"}`,
    `MATERIALS: ${current.length ? "" : "(none)"}`,
    ...current.map((m) => `  ${handleOf(lib.materials, "M", m.id)} "${m.name}": ${m.prompt}`),
    `DETAILS: ${cat.rules.details.length ? "" : "(none)"}`,
    ...cat.rules.details.map((d, i) => `  ${i + 1}. (${d.mode}${d.label ? ` "${d.label}"` : ""}) ${d.text}`),
    "",
    "LIBRARY — style packs (list_style_packs)",
    ...(lib.stylePacks.length ? lib.stylePacks.map((p, i) => `S${i + 1} "${p.name}"${p.usedBy.length ? ` (used by ${p.usedBy.join(", ")})` : ""}: ${clip(p.prompt, 500)}`) : ["(none)"]),
    "LIBRARY — materials (list_materials)",
    ...(lib.materials.length ? lib.materials.map((m, i) => `M${i + 1} "${m.name}"${m.usedBy.length ? ` (used by ${m.usedBy.join(", ")})` : ""}: ${clip(m.prompt, 500)}`) : ["(none)"]),
    "",
    `FEEDBACK: ${note || "(none — judge from the images and the references)"}`,
    "",
    `ATTACHED IMAGES, in order:`,
    ...labels.map((l, i) => `  result #${i + 1} (badge #${i + 1} in its corner): ${l}`),
    ...(refCount ? [`  then ${refCount} new reference photo(s) from the editor (refRoles, in this order)`] : []),
    ...(saved.design ? [`  then ${saved.design} saved design reference(s) of the category (what the flat drawing already sees)`] : []),
    ...(saved.product ? [`  then ${saved.product} saved product photo(s) of the category (what the material step already sees)`] : []),
  ].join("\n");
}

const ACTIONS: CtReviseAction[] = ["keep", "switch", "edit", "new", "remove"];
const asAction = (v: unknown, allowed: CtReviseAction[], fallback: CtReviseAction): CtReviseAction =>
  typeof v === "string" && allowed.includes(v as CtReviseAction) && ACTIONS.includes(v as CtReviseAction) ? (v as CtReviseAction) : fallback;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a revision is measured against: the library and the category's own presets. */
export interface RevisionContext {
  lib: CtLibraryCatalog;
  style: CtPreset | null;
  current: CtPreset[];
}

export async function revisionContext(db: LibraryDb, cat: CtCategorySnapshot): Promise<RevisionContext> {
  const lib = await loadLibraryCatalog(db);
  const ids = [cat.rules.stylePackId, ...cat.rules.materialIds].filter((x): x is string => Boolean(x));
  const { data, error } = ids.length ? await db.from(CT_TABLES.presets).select("*").in("id", ids).returns<CtPreset[]>() : { data: [], error: null };
  if (error) throw new Error(error.message);
  const presets = data ?? [];
  return {
    lib,
    style: presets.find((p) => p.id === cat.rules.stylePackId) ?? null,
    current: cat.rules.materialIds.map((id) => presets.find((p) => p.id === id)).filter((p): p is CtPreset => Boolean(p)),
  };
}

/**
 * A revision plan (REVISE_SYSTEM's JSON: from the built-in LLM, or from the agent's submit_result) → the
 * CtCategoryRevision the dialog shows. Library presets are named by handle (S2, M3) or by id.
 */
export function buildRevision(out: Record<string, unknown>, cat: CtCategorySnapshot, ctx: RevisionContext, refUrls: string[]): CtCategoryRevision {
  const { lib, style, current } = ctx;
  const others = (usedBy: string[]) => usedBy.filter((n) => n !== cat.name);
  // A library preset by handle (S2 / M3 — the built-in LLM) or by id (the agent, which reads ids over the MCP).
  const byRef = <T extends { id: string }>(list: T[], prefix: string, h: unknown): T | null => {
    const v = typeof h === "string" ? h.trim() : "";
    if (UUID_RE.test(v)) return list.find((x) => x.id === v) ?? null;
    const n = new RegExp(`^${prefix}\\d+$`, "i").test(v) ? Number(v.slice(1)) : NaN;
    return Number.isInteger(n) ? (list[n - 1] ?? null) : null;
  };
  const libStyle = (h: unknown) => byRef(lib.stylePacks, "S", h);
  const libMaterial = (h: unknown) => byRef(lib.materials, "M", h);

  // Style pack.
  const so = record(out.style);
  let styleAction = asAction(so.action, ["keep", "switch", "edit", "new"], "keep");
  const styleTarget = styleAction === "switch" ? libStyle(so.switchTo) : null;
  if (styleAction === "switch" && (!styleTarget || styleTarget.id === style?.id)) styleAction = "keep";
  if ((styleAction === "edit" || styleAction === "new") && !str(so.prompt)) styleAction = "keep";
  if (styleAction === "edit" && !style) styleAction = "new";
  const styleUsed = style ? (lib.stylePacks.find((p) => p.id === style.id)?.usedBy ?? []) : [];
  const revStyle: CtRevisePreset = {
    action: styleAction,
    currentId: style?.id ?? null,
    targetId: styleTarget?.id ?? null,
    name: styleAction === "switch" ? styleTarget!.name : styleAction === "new" ? str(so.name).slice(0, 80) || `${cat.name} style` : (style?.name ?? ""),
    prompt: styleAction === "switch" ? styleTarget!.prompt : styleAction === "edit" || styleAction === "new" ? str(so.prompt) : (style?.prompt ?? ""),
    before: style?.prompt ?? "",
    why: str(so.why),
    usedByOthers: others(styleUsed),
  };

  // Materials: one per current, then additions.
  const entries = (Array.isArray(out.materials) ? out.materials : []).map(record);
  const taken = new Set(current.map((m) => m.id));
  const revMaterials: CtRevisePreset[] = current.map((m) => {
    const e = entries.find((x) => libMaterial(x.handle)?.id === m.id) ?? {};
    let action = asAction(e.action, ["keep", "switch", "edit", "remove"], "keep");
    const target = action === "switch" ? libMaterial(e.switchTo) : null;
    if (action === "switch" && (!target || target.id === m.id || taken.has(target.id))) action = "keep";
    if (action === "edit" && !str(e.prompt)) action = "keep";
    if (target && action === "switch") taken.add(target.id);
    return {
      action,
      currentId: m.id,
      targetId: action === "switch" ? target!.id : null,
      name: action === "switch" ? target!.name : m.name,
      prompt: action === "switch" ? target!.prompt : action === "edit" ? str(e.prompt) : m.prompt,
      before: m.prompt,
      why: str(e.why),
      usedByOthers: others(lib.materials.find((x) => x.id === m.id)?.usedBy ?? []),
    };
  });
  for (const a of (Array.isArray(out.add) ? out.add : []).map(record).slice(0, 3)) {
    const hit = libMaterial(a.switchTo);
    if (hit && !taken.has(hit.id)) {
      taken.add(hit.id);
      revMaterials.push({ action: "switch", currentId: null, targetId: hit.id, name: hit.name, prompt: hit.prompt, before: "", why: str(a.why), usedByOthers: [] });
    } else if (!hit && str(a.name) && str(a.prompt)) {
      revMaterials.push({ action: "new", currentId: null, targetId: null, name: str(a.name).slice(0, 80), prompt: str(a.prompt), before: "", why: str(a.why), usedByOthers: [] });
    }
  }

  const specOut = record(out.spec);
  const detailsOut = out.details && typeof out.details === "object" ? record(out.details) : null;
  const roles = Array.isArray(out.refRoles) ? out.refRoles : [];
  const revision: CtCategoryRevision = {
    diagnosis: str(out.diagnosis),
    spec: str(specOut.text) && str(specOut.text) !== cat.spec ? { text: str(specOut.text), why: str(specOut.why) } : null,
    style: revStyle,
    materials: revMaterials,
    details: detailsOut && Array.isArray(detailsOut.list) ? { list: normalizeMaterialSpecs(detailsOut.list), why: str(detailsOut.why) } : null,
    refRoles: refUrls.map((_, i): CtReviseRefRole => (roles[i] === "design" || roles[i] === "product" ? roles[i] : "none")),
    historyId: null,
    review: null,
  };
  return revision;
}

/**
 * POST ai/category-revise — multipart: category (JSON {id?, name, spec, rules} — the dialog's state, saved or not),
 * note, image_file / image_label / image_url × ≤12 (the results, numbered), ref_url × ≤4 (new photos, uploaded
 * first) → CtCategoryRevision. Recorded in the category's history (migration 010).
 */
export async function suggestCategoryRevision(session: CtSession, form: FormData): Promise<NextResponse> {
  let raw: Record<string, unknown>;
  try {
    raw = record(JSON.parse(String(form.get("category") ?? "null")));
  } catch {
    return jsonError("category không hợp lệ", 400);
  }
  const cat: CtCategorySnapshot = { name: str(raw.name), spec: str(raw.spec), rules: normalizeCategoryRules(record(raw.rules) as Partial<CtCategoryRules>) };
  const categoryId = typeof raw.id === "string" && /^[0-9a-f-]{36}$/i.test(raw.id) ? raw.id : null;
  const note = String(form.get("note") ?? "").trim();
  const labels = form.getAll("image_label").map(String);
  const imageUrls = form.getAll("image_url").map(String).filter(isOwnUploadUrl);
  const results: string[] = [];
  for (const [i, f] of form.getAll("image_file").filter((x): x is File => x instanceof File).slice(0, MAX_REVISE_RESULTS).entries()) {
    if (!f.type.startsWith("image/") || f.size > MAX_IMAGE_BYTES) return jsonError(`Ảnh #${i + 1} không hợp lệ`, 400);
    results.push(`data:${f.type};base64,${Buffer.from(await f.arrayBuffer()).toString("base64")}`);
  }
  const refUrls = form.getAll("ref_url").map(String).filter(isOwnUploadUrl).slice(0, MAX_REVISE_REFS);
  if (!note && !results.length && !refUrls.length) return jsonError("Mô tả điều chưa hài lòng hoặc thả ảnh", 400);

  let ctx: RevisionContext;
  try {
    ctx = await revisionContext(session.supabase, cat);
  } catch (e) {
    return jsonError(`Không đọc được thư viện: ${e instanceof Error ? e.message : String(e)}`, 500);
  }
  const { lib, style, current } = ctx;

  const newRefs = await readSavedRefs(refUrls);
  const savedDesign = await readSavedRefs(cat.rules.refs.slice(0, 3));
  const savedProduct = await readSavedRefs(cat.rules.productRefs.slice(0, 2));
  const prompt = revisePrompt(cat, style, current, lib, note, labels.slice(0, results.length), newRefs.length, { design: savedDesign.length, product: savedProduct.length });
  const reply = await askLlm(REVISE_SYSTEM, prompt, [...results, ...newRefs, ...savedDesign, ...savedProduct]);
  if (reply instanceof NextResponse) return reply;
  const out = jsonObject(reply);
  if (!out || !str(out.diagnosis)) return jsonError("AI trả về không đúng định dạng — thử lại", 502);
  const revision = buildRevision(out, cat, ctx, refUrls);
  // Last step: the prompts as they will be after this revision, read together.
  const newProduct = refUrls.filter((_, i) => revision.refRoles[i] === "product");
  await reviewRevision(revision, cat, lib, newProduct, str(raw.usage) === "element" ? "element" : "main");
  const history = await recordCategoryHistory(session, {
    category_id: categoryId,
    event: "revise",
    note,
    ref_urls: refUrls,
    image_urls: imageUrls,
    input: cat,
    result: revision,
    model: promptModel(),
  });
  revision.historyId = history?.id ?? null;
  return NextResponse.json(revision);
}

/**
 * The review of a revision's result (or of the category as it is: an all-"keep" plan). Its fixes are folded into
 * the plan as ordinary changes — the editor sees them before / after and ticks them like the others.
 */
async function reviewRevision(rev: CtCategoryRevision, cat: CtCategorySnapshot, lib: CtLibraryCatalog, newProductRefs: string[], usage: "main" | "element"): Promise<void> {
  const others = (list: string[]) => list.filter((n) => n !== cat.name);
  const libUsed = (id: string | null) => others(lib.materials.find((m) => m.id === id)?.usedBy ?? []);
  const live = rev.materials.map((m, i) => ({ m, i })).filter(({ m }) => m.action !== "remove");
  const materials: ReviewMaterial[] = live.map(({ m }, k) => {
    const id = m.action === "switch" ? m.targetId : m.currentId;
    return {
      key: `M${k + 1}`,
      name: m.name,
      prompt: m.prompt,
      art: lib.materials.find((x) => x.id === id)?.art === "surface" ? "surface" : "print",
      usedByOthers: m.action === "new" ? [] : m.action === "switch" ? libUsed(m.targetId) : m.usedByOthers,
    };
  });
  const styleUsed = rev.style.action === "switch" ? others(lib.stylePacks.find((p) => p.id === rev.style.targetId)?.usedBy ?? []) : rev.style.action === "new" ? [] : rev.style.usedByOthers;
  const input: ReviewInput = {
    name: cat.name,
    usage,
    spec: rev.spec?.text ?? cat.spec,
    style: rev.style.prompt ? { name: rev.style.name, prompt: rev.style.prompt, usedByOthers: styleUsed } : null,
    materials,
    rules: {
      details: rev.details?.list ?? cat.rules.details,
      productRefs: [...new Set([...cat.rules.productRefs, ...newProductRefs])],
      detailsNote: cat.rules.detailsNote,
      fill: cat.rules.fill,
      anchor: cat.rules.anchor,
      shape: cat.rules.shape,
    },
  };
  const r = await reviewCategory(input);
  rev.review = r?.review ?? null;
  if (!r) return;
  const tag = (why: string, layer: CtReviewIssue["layer"], target?: string) => {
    const found = r.review.issues.filter((i) => i.layer === layer && (target === undefined || !i.target || i.target.toUpperCase() === target)).map((i) => i.problem);
    return [why, found.length ? `Kiểm tra prompt: ${found.join("; ")}` : "Kiểm tra prompt: sửa xung đột"].filter(Boolean).join(" · ");
  };
  if (r.spec) rev.spec = { text: r.spec, why: tag(rev.spec?.why ?? "", "spec") };
  if (r.details) rev.details = { list: r.details, why: tag(rev.details?.why ?? "", "details") };
  if (r.style) {
    // A pack switched to as is stays as is (the review reports it); otherwise its prompt is the fixed one.
    if (rev.style.action === "switch" || (rev.style.action === "keep" && !rev.style.currentId)) unfix(r.review, "style");
    else rev.style = { ...rev.style, action: rev.style.action === "keep" ? "edit" : rev.style.action, prompt: r.style, why: tag(rev.style.why, "style") };
  }
  live.forEach(({ m, i }, k) => {
    const key = `M${k + 1}`;
    const fixed = r.materials[key];
    if (!fixed) return;
    if (m.action === "switch") return unfix(r.review, "material", key);
    rev.materials[i] = { ...m, action: m.action === "keep" ? "edit" : m.action, prompt: fixed, why: tag(m.why, "material", key) };
  });
  const summary = reviewSummary(r.review);
  rev.diagnosis = rev.diagnosis ? `${rev.diagnosis}\n\n${summary}` : summary;
}

/**
 * POST ai/category-review — multipart: category (JSON {id?, name, spec, rules, usage?}) → CtCategoryRevision: the
 * category's prompts checked as they are ("Kiểm tra prompt"); the fixes come as an ordinary plan to tick and apply.
 */
export async function reviewCategoryPrompts(session: CtSession, form: FormData): Promise<NextResponse> {
  let raw: Record<string, unknown>;
  try {
    raw = record(JSON.parse(String(form.get("category") ?? "null")));
  } catch {
    return jsonError("category không hợp lệ", 400);
  }
  const cat: CtCategorySnapshot = { name: str(raw.name), spec: str(raw.spec), rules: normalizeCategoryRules(record(raw.rules) as Partial<CtCategoryRules>) };
  if (!cat.spec && !cat.rules.details.length && !cat.rules.materialIds.length) return jsonError("Danh mục chưa có prompt để kiểm tra", 400);
  const categoryId = typeof raw.id === "string" && /^[0-9a-f-]{36}$/i.test(raw.id) ? raw.id : null;
  let lib: CtLibraryCatalog;
  let presets: CtPreset[];
  try {
    lib = await loadLibraryCatalog(session.supabase);
    const ids = [cat.rules.stylePackId, ...cat.rules.materialIds].filter((x): x is string => Boolean(x));
    const { data, error } = ids.length ? await session.supabase.from(CT_TABLES.presets).select("*").in("id", ids).returns<CtPreset[]>() : { data: [], error: null };
    if (error) throw new Error(error.message);
    presets = data ?? [];
  } catch (e) {
    return jsonError(`Không đọc được thư viện: ${e instanceof Error ? e.message : String(e)}`, 500);
  }
  const others = (list: string[]) => list.filter((n) => n !== cat.name);
  const keep = (p: CtPreset, usedBy: string[]): CtRevisePreset => ({ action: "keep", currentId: p.id, targetId: null, name: p.name, prompt: p.prompt, before: p.prompt, why: "", usedByOthers: others(usedBy) });
  const style = presets.find((p) => p.id === cat.rules.stylePackId) ?? null;
  const rev: CtCategoryRevision = {
    diagnosis: "",
    spec: null,
    style: style ? keep(style, lib.stylePacks.find((p) => p.id === style.id)?.usedBy ?? []) : { action: "keep", currentId: null, targetId: null, name: "", prompt: "", before: "", why: "", usedByOthers: [] },
    materials: cat.rules.materialIds
      .map((id) => presets.find((p) => p.id === id))
      .filter((p): p is CtPreset => Boolean(p))
      .map((p) => keep(p, lib.materials.find((m) => m.id === p.id)?.usedBy ?? [])),
    details: null,
    refRoles: [],
    historyId: null,
    review: null,
  };
  await reviewRevision(rev, cat, lib, [], str(raw.usage) === "element" ? "element" : "main");
  if (!rev.review) return jsonError("AI kiểm tra không phản hồi — thử lại", 502);
  const history = await recordCategoryHistory(session, { category_id: categoryId, event: "revise", note: "Kiểm tra prompt", ref_urls: [], image_urls: [], input: cat, result: rev, model: promptModel() });
  rev.historyId = history?.id ?? null;
  return NextResponse.json(rev);
}

// ---------------------------------------------------------------------------
// Category dialog: chi tiết thành phẩm from a description + photos of the product
// ---------------------------------------------------------------------------

const DETAILS_SYSTEM = `You read the finished physical product of a print clipart category for an AI image pipeline. The flat artwork is printed on a material (a separate, reusable preset) and the product has extra parts — those are what you list.

${DETAILS_RULES}

The description may be in Vietnamese. Reply with JSON only, no markdown: {"details": [{"text": "...", "mode": "always", "label": ""}]}`;

/**
 * POST ai/details-suggest — multipart: name, spec (the category), note, ref_url × ≤6 (photos of the product,
 * uploaded first), file × ≤4 → CtDetailsSuggestion.
 */
export async function suggestDetails(form: FormData): Promise<NextResponse> {
  const name = String(form.get("name") ?? "").trim();
  const spec = String(form.get("spec") ?? "").trim();
  const note = String(form.get("note") ?? "").trim();
  const uploaded = await readImages(form, "file");
  if (uploaded instanceof NextResponse) return uploaded;
  const refUrls = form.getAll("ref_url").map(String).filter(isOwnUploadUrl).slice(-MAX_PRESET_IMAGES);
  const images = [...(await readSavedRefs(refUrls)), ...uploaded].slice(-MAX_PRESET_IMAGES);
  if (!note && images.length === 0) return jsonError("Mô tả thành phẩm hoặc thả ảnh sản phẩm", 400);
  const prompt = [
    `Category: ${name || "(none)"}`,
    `What the flat clipart is (context only — not details): ${spec || "(empty)"}`,
    `Editor's description of the finished product: ${note || "(none)"}`,
    images.length ? `${images.length} photo(s) of the finished product attached.` : "No photos.",
  ].join("\n");
  const reply = await askLlm(DETAILS_SYSTEM, prompt, images);
  if (reply instanceof NextResponse) return reply;
  const raw = jsonObject(reply);
  if (!raw) return jsonError("AI trả về không đúng định dạng — thử lại", 502);
  const out: CtDetailsSuggestion = { details: normalizeMaterialSpecs(raw.details) };
  return NextResponse.json(out);
}

// ---------------------------------------------------------------------------
// Refine: feedback on generated cliparts → edit instruction (+ spec / style)
// ---------------------------------------------------------------------------

const REFINE_SYSTEM = `You help an editor fix a set of AI-generated print clipart.
The editor looked at the generated images and wrote only what is wrong (FIX), sometimes with photos of how a part should look instead. The feedback may be in Vietnamese, and may talk about the whole set ("all of them", "the helmet") or about single images ("the lamborghini", "the first 3 images").
DEFAULT RULE: everything the FIX does not mention is already right and must be kept. Your job is as much about protecting that as about the change.

HOW THE EDIT RUNS: an image-EDIT model edits each selected clipart ON ITS OWN, one image at a time. It gets the shared "edit" (identical for every image), that image's own "images[i].edit", its own "images[i].spec", the category spec as the set's rules, the reference photos and one already-edited clipart of the set to match. It never sees the other images, so:
- anything about ONE image (or some of them) goes ONLY into that image's own edit — never into the shared edit;
- SCOPE: a sentence of the FIX that names an image ("hình 1", "ảnh số 2", "the lamborghini", "3 tấm đầu") applies ONLY to those images — every part of that sentence, conditions included ("if it covers the car, tilt it"). Only what the FIX says without naming an image (or says of "all" / "cả bộ") is shared. When the FIX starts with an image number, assume the whole FIX is about that image unless a later sentence clearly widens it;
- the shared edit must read correctly for EVERY image: write it as the END STATE every clipart must have ("there is a clear gap of about <N>% of the car's height between the bottom of the helmet and the top of the suit collar" — <N> measured from the images / the editor's numbers, never copied from this example), so an image that already has it simply keeps it. Never write "add a gap" alone, never "make it shorter than before" without the target.

The prompt for this set is built from layers: STYLE PACK (how it is drawn) → CATEGORY SPEC (what every clipart of the category is) → per-clipart spec (what THIS clipart is) → fixed rules (framing, white background, no text).

The images are listed with their number, name and current own spec. Write, in English unless stated:
0. "keep": first, inventory the generated images and the current spec, and list concretely everything the FIX does not touch — the object's identity and model details, body shape and proportions, colours / liveries, character face (eyes, mouth), wheels, accessories, viewing angle, outline and shading style, customisation areas (blank face area…), framing. Short comma-separated items, generic enough for every image of the set. Do not list anything the FIX changes.
1. "edit": the SHARED change as the end state (see above), valid for every image. Empty string "" when the FIX only concerns single images.
   - Look at the images and measure against what they show NOW; give target sizes / spacing as fractions of the object's height, with the change ("about <N>% of the car's height — about twice the current size").
   - When the editor points at reference photos ("như mẫu", "like the reference"), describe the referenced part LITERALLY from the photos — only what is visible, never what such a part usually has: shape, sub-parts (e.g. goggles on top), surfaces (an open / empty / flat area is NOT a visor or glass: "open face opening filled flat with the helmet's own colour, no visor, no glass"), spacing between parts, how it sits on the object and its size relative to the object. Say "exactly as in the reference images".
   - Orientation (ALWAYS, one sentence per changed part): which way the part faces (e.g. "the helmet faces the viewer straight on, even though the vehicle is seen from a 3/4 angle").
   - Nested ratios computed: "helmet + suit = 1/3 of the car, helmet 2/3 of that" → "helmet about 2/9 (≈22%) of the car's height, suit about 1/9 (≈11%)".
   - A gap / opening between parts that must show what is behind the clipart: say it is empty background ("empty, pure white background shows through the gap — nothing drawn in it").
   - Customisation areas named in the current spec (e.g. a blank face area) stay blank, flat and empty.
   - Reference photos often show a different object: take the part's design from them, colours follow each clipart's own colour scheme unless the editor asks for a colour.
   - Keep every point of the FIX that is about the whole set; never soften or drop one. Number them (1., 2., …) when there are several.
2. "images": one entry PER IMAGE, in badge order #1, #2, …: {"index": <its badge number>, "edit": "...", "spec": "..."}. Before writing an image's edit, look at the image that carries that badge and check the FIX's numbers / names point at it.
   - "edit": what THIS image needs beyond the shared edit — what the FIX says about it by name / position ("the lamborghini's collar is too long — shorten it to the shared collar height"), or what this image specifically lacks compared with the shared end state when it differs visibly from the others (e.g. "this one has no gap yet: …"). Same literal, measured style. Write it about this image alone ("this clipart's collar …") — the model never sees the others, so never mention other images or positions. NEVER repeat the shared edit here (the model already gets it) — only what is different for this image; "" when the shared edit covers it, which is the usual case.
   - "spec": 1–2 sentences describing THIS clipart's own identity as it should look after the edit: the model / kind, colour scheme, livery, distinctive parts, the character's look — only what makes it THIS member, not the set's structure (that is the category spec). Start from its current own spec when it has one (keep its words), add what is visible.
3. "spec": ONLY if allowed AND the FIX states a structural rule for every clipart of the category (part size, part type, spacing, position, angle, character traits) — the FULL category spec as a MERGE, not a rewrite:
   - Copy every sentence of the current spec the FIX does not contradict WORD FOR WORD (spelling fixes only). Never drop or shorten a correct sentence.
   - Change only the sentences about the fixed part, or add new ones, with the same literal description, orientation and computed sizes as the shared edit. A sentence the FIX makes wrong is replaced, not deleted. Never put single-image fixes in the spec.
   Otherwise null.
4. "style": ONLY if allowed AND the FIX is about how things are drawn (outlines, shading, finish, palette, detail level) — the FULL style-pack prompt as the same kind of MERGE, never naming the object. Otherwise null.
5. "summary": 2–4 short sentences IN VIETNAMESE for the editor: what changes for the whole set, what changes for which image (say "hình 1 (tractor)" — number and name), what is kept, and whether / why the spec or style pack is updated.

Use the attached images: first the generated cliparts (numbered by their badge), then the editor's reference images (if any, no badge). The badge is only a label for you — never mention it in "edit" / "spec".
Reply with JSON only: {"summary": "...", "keep": "...", "edit": "...", "images": [{"index": 1, "edit": "...", "spec": "..."}], "spec": "..." | null, "style": "..." | null}`;

/**
 * POST ai/refine-suggest — multipart: fix, image_file / image_name / image_spec × n (generated cliparts, numbered), file × ≤4 (photos
 * of the part to change), category (JSON {name, usage, mode, spec}), style (JSON {name, prompt}),
 * update_spec, update_style ("1") → CtRefineSuggestion.
 */
export async function suggestRefine(form: FormData): Promise<NextResponse> {
  const fix = String(form.get("fix") ?? "").trim();
  if (!fix) return jsonError("Ghi điều cần sửa", 400);
  // Parallel lists (lib/api-client.ts): image (a copy with its number drawn in the corner), name, own spec of
  // each clipart, in the dialog's order — image #1 is the first card. The number on the picture is what keeps
  // "hình 1" on the right clipart: a vision model does not reliably map attachment order to a list.
  const names = form.getAll("image_name").map(String);
  const specs = form.getAll("image_spec").map(String);
  const files = form.getAll("image_file").filter((f): f is File => f instanceof File).slice(0, MAX_REFINE_IMAGES);
  const generated: Array<{ url: string; name: string; spec: string }> = [];
  for (const [i, f] of files.entries()) {
    if (!f.type.startsWith("image/") || f.size > MAX_IMAGE_BYTES) return jsonError(`Ảnh #${i + 1} không hợp lệ`, 400);
    generated.push({
      url: `data:${f.type};base64,${Buffer.from(await f.arrayBuffer()).toString("base64")}`,
      name: (names[i] ?? "").trim() || `image ${i + 1}`,
      spec: (specs[i] ?? "").trim(),
    });
  }
  if (!generated.length) return jsonError("Chưa có ảnh nào để phân tích", 400);
  const refs = await readImages(form, "file");
  if (refs instanceof NextResponse) return refs;
  const refNames = form.getAll("ref_name").map(String);
  const parse = <T>(field: string): T | null => {
    try {
      return JSON.parse(String(form.get(field) ?? "null")) as T | null;
    } catch {
      return null;
    }
  };
  const category = parse<{ name?: string; usage?: string; mode?: string; spec?: string }>("category");
  const style = parse<{ name?: string; prompt?: string }>("style");
  const allowSpec = form.get("update_spec") === "1" && category !== null;
  const allowStyle = form.get("update_style") === "1" && style !== null;

  const prompt = [
    ...(category ? categoryLines(category.name ?? "", category.usage ?? "", category.mode ?? "", category.spec ?? "") : ["No category."]),
    `Style pack: ${style ? `${style.name ?? ""} — ${style.prompt ?? ""}` : "(none)"}`,
    `FIX: ${fix}`,
    `Spec update allowed: ${allowSpec ? "yes" : "no — return null"}`,
    `Style update allowed: ${allowStyle ? "yes" : "no — return null"}`,
    `${generated.length} generated clipart image(s) attached first. Each carries its number in a black badge in its top-left corner — that number IS the image's number: "hình 1" / "ảnh 1" / "tấm 1" / "image 1" / "the first one" in the FIX means the image with badge #1, and so on. Identify images by the badge, never by attachment order:`,
    ...generated.map((g, i) => `  #${i + 1} "${g.name}" — own spec: ${g.spec || "(empty)"}`),
    `then ${refs.length} reference image(s) from the editor${refs.length ? ":" : "."}`,
    ...refs.map((_, i) => {
      const n = refNames[i]?.trim();
      return n
        ? `  ref ${i + 1}: the finished clipart "${n}" of THIS same set — the editor considers it right: the changed part must end up exactly like it (shape, size relative to the object, spacing, orientation); say "exactly as in the reference clipart" and describe what it shows`
        : `  ref ${i + 1}: a photo / image of how the changed part should look`;
    }),
  ].join("\n");
  const reply = await askLlm(REFINE_SYSTEM, prompt, [...generated.map((g) => g.url), ...refs]);
  if (reply instanceof NextResponse) return reply;
  const raw = jsonObject(reply);
  if (!raw) return jsonError("AI trả về không đúng định dạng — thử lại", 502);
  const edit = str(raw.edit);
  // Matched by the badge number each entry names ("index", 1-based); entries without one by position.
  const list = (Array.isArray(raw.images) ? raw.images : []).map((it: unknown) => (it && typeof it === "object" ? (it as Record<string, unknown>) : {}));
  const byIndex = new Map<number, Record<string, unknown>>();
  for (const o of list) {
    const n = typeof o.index === "number" ? o.index : Number(o.index);
    if (Number.isInteger(n) && n >= 1 && n <= generated.length && !byIndex.has(n)) byIndex.set(n, o);
  }
  const images: CtRefineImagePlan[] = generated.map((g, i) => {
    const o = byIndex.get(i + 1) ?? (byIndex.size ? {} : (list[i] ?? {}));
    return { name: g.name, edit: str(o.edit), spec: str(o.spec) || g.spec };
  });
  if (!edit && !images.some((im) => im.edit)) return jsonError("AI trả về không đúng định dạng — thử lại", 502);
  const suggestion: CtRefineSuggestion = {
    summary: str(raw.summary),
    keep: str(raw.keep),
    edit,
    images,
    spec: allowSpec ? str(raw.spec) || null : null,
    style: allowStyle ? str(raw.style) || null : null,
  };
  return NextResponse.json(suggestion);
}
