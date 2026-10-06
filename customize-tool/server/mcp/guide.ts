/**
 * The FlexiPrint system as MCP resources — what an agent has to know to work on the clipart library like the
 * built-in prompt writer does. The writing rules are the SAME texts the built-in LLM gets (one source:
 * server/ai/prompt-writer.ts, server/ai/prompt-review.ts), so a rule changed there reaches the agent too.
 */

import { DETAILS_RULES, REVISE_SYSTEM, SYSTEM } from "../ai/prompt-writer";
import { REVIEW_SYSTEM } from "../ai/prompt-review";

export interface CtMcpResource {
  uri: string;
  name: string;
  description: string;
  text: () => string;
}

const OVERVIEW = `# FlexiPrint — clipart library for print-on-demand products

FlexiPrint makes print-ready clipart sets with AI and turns them into physical products (clear acrylic ornaments,
keychains, visor clips…). Editors work in the web app; you (the @flexiprint agent) work on the same data through
this MCP. Everything you read here is live production data.

## Records
- CATEGORY (ct_clipart_categories): one kind of clipart, e.g. "Chibi Car". It holds:
  - spec — WHAT every clipart of the category is (structure, proportions, fixed parts, viewing angle). English.
  - rules.stylePackId — the STYLE PACK (preset kind style_pack): HOW everything is drawn. Shared by categories.
  - rules.materialIds — MATERIAL presets (kind material): the physical product look (acrylic, glitter…). Shared.
  - rules.details — CHI TIẾT THÀNH PHẨM: the product's parts (hole, cord, clip…), mode "always" | "version".
    Per category, copied (never shared) between categories.
  - rules.refs — design reference photos (sent with the flat drawing).
  - rules.productRefs — photos of the finished product (sent with every material pass).
  - rules.detailsNote — the editor's own words about the product (their intent).
- CLIPART (ct_assets, library = product_id null): an ORIGIN ("gốc", role main/sub) of a category; its children
  are variants ("đa sắc", recolours) and renditions (material versions, meta.material = the material id,
  meta.materialVersion = the "version" detail's label, e.g. "có dây").

## How images are made (studio = ComfyUI, models on fal.ai)
1. Flat clipart (the file the factory prints): STYLE PACK → CATEGORY SPEC → the clipart's subject line → fixed
   rules (framing, white background, no text). Never shows product details.
2. Đa sắc: recolour / edit of a finished origin, same silhouette.
3. Material versions: nano-banana EDITS the flat clipart into a product photo-cutout: MATERIAL prompt + the
   "always" DETAILS (base picture) + one extra edit of the base per "version" detail + the product photos.
   Every clipart is edited ALONE — only the wording keeps a set consistent. The base pass is checked for ghosts,
   excess plate and (when a detail names a hole) a missing hole, and redrawn.
Use the tool assemble_prompts to see the exact text the image models receive.

## Origin sets
Every clipart of a category is a DIFFERENT model of the same kind (a low sports car, a police car, a tall
tractor). A sentence must hold for all of them: anchor positions on parts every member has, give sizes as
fractions of the artwork / object (never mm or px for sizes), one anchor per position.

## Working rules
- Read before you write: get_category, list_cliparts, view_image on the results, get_history (what was tried).
- Reuse the library: style packs and materials are shared (list_style_packs / list_materials, "usedBy");
  details wording from other categories (list_product_details). Only the spec is per category.
- Photos for mockups (backgrounds, scenes, hands, props): look in the tổ hợp photo library first
  (list_pack_images, then view_image); only search the web or generate one when nothing fits.
- A shared preset edited changes every category using it — say so in your result.
- Before you submit, check your draft with assemble_prompts (pass your draft) and fix conflicts
  (flexiprint://guide/review-rules).
- Make test images (run_studio) whenever they help decide (they run on fal.ai and are billed). To test a change you
  propose to a material prompt / the details / product photos, pass it as the material run's "draft" — nothing is saved.
- A run takes minutes: after run_studio call wait_run (the server waits for you; "still running" → call it again),
  then view_image the results. On a web-app task pass task_id to run_studio: the editor watches the run, and
  submit_result is refused while any run of the task is unfinished.
- The editor approves: your task result is a PLAN they tick and apply in the web app. You never save a category.
- Write the editor-facing fields (diagnosis, why, summary, reasons) in Vietnamese; prompts in English.

## Tasks from the web app
The editor pressed "Tạo" (Tạo bằng AI) or "Gửi @flexiprint review" (Cập nhật bằng AI — the only button there:
with no note and no images it means "just check the prompts"). You are the only AI behind these buttons.
You get a message with a task id. Then: get_task → work (report_progress now and then, in Vietnamese, one
short line each) → submit_result with the JSON described in flexiprint://guide/task-results, or fail_task
with the reason. Always finish with one of the two — and only when the work is COMPLETELY over: every test run
waited for and looked at, nothing left in the background. Your result is the final answer, not a status update;
its "summary" tells the editor what you did and what the tests showed.
A choice that is the editor's (two good directions, a taste call, missing information): ask_user with options, then
END YOUR TURN. Their answer comes back as a new message in the same session — continue the task from there. Don't ask
what you can decide yourself or check with a test image.
`;

const TASK_RESULTS = `# Task result formats (submit_result.result)

## kind "revise" — the editor's feedback on a category (an empty note = only check the prompts)
The same JSON the built-in reviser returns. Library presets are named by their id (from list_style_packs /
list_materials / get_category); "M1"-style handles are not available to you.
{"diagnosis": "VI: what is wrong, on which images (#n), which layer causes it, what stays",
 "summary": "VI, REQUIRED: what you did — test images you made (run_studio) and what they showed, what you asked the editor, what is still uncertain",
 "spec": {"text": "FULL merged spec (unchanged sentences word for word)", "why": "VI"} | null,
 "style": {"action": "keep" | "switch" | "edit" | "new", "switchTo": "<style pack id>" | null, "name": "...", "prompt": "FULL prompt", "why": "VI"},
 "materials": [{"handle": "<current material id>", "action": "keep" | "switch" | "edit" | "remove", "switchTo": "<material id>" | null, "prompt": "FULL prompt when edit", "why": "VI"}],
 "add": [{"switchTo": "<library material id>" | null, "name": "...", "prompt": "...", "why": "VI"}],
 "details": {"list": [{"text": "English", "mode": "always" | "version", "label": "VI version name or \\"\\""}], "why": "VI"} | null,
 "refRoles": ["design" | "product" | "none"]   // one per task input refUrls, in order
}
One entry in "materials" per CURRENT material of the category (keep the rest as "keep").
Short forms are accepted too: "spec": "<full text>", "details": [{text, mode, label}], "materials": [{"id": "<current
material id>", "prompt": "<full new prompt>"}] (a changed prompt = edit). A change that cannot be read is refused with
the reason — fix it and submit again (the task stays open).

## kind "create" — a new category from the editor's note and photos
{"name": "Title Case", "spec": "English, 30–70 words",
 "style": {"reuseId": "<style pack id>"} | {"name": "...", "prompt": "..."},
 "materials": [{"reuseId": "<material id>"} | {"name": "...", "prompt": "..."}],
 "details": [{"text": "...", "mode": "always", "label": ""}],
 "refRoles": ["design" | "product"],   // one per task input refUrls, in order
 "summary": "VI, REQUIRED: what you reused, what is new and why, test images and what they showed"}
`;

export const CT_MCP_RESOURCES: CtMcpResource[] = [
  { uri: "flexiprint://guide/overview", name: "FlexiPrint — how the system works", description: "Records, the image pipeline, origin sets, working rules, tasks. Read first.", text: () => OVERVIEW },
  { uri: "flexiprint://guide/task-results", name: "Task result formats", description: "The JSON submit_result expects for create / revise tasks.", text: () => TASK_RESULTS },
  { uri: "flexiprint://guide/category-rules", name: "Writing a category", description: "Rules for name, spec, style pack, materials, details (the built-in writer's own rules).", text: () => SYSTEM },
  { uri: "flexiprint://guide/details-rules", name: "Writing product details", description: "Chi tiết thành phẩm: one entry per part, positions, sizes, modes.", text: () => DETAILS_RULES },
  { uri: "flexiprint://guide/revise-rules", name: "Revising a category from feedback", description: "Which layer causes which problem; merge rules.", text: () => REVISE_SYSTEM },
  { uri: "flexiprint://guide/review-rules", name: "Reviewing assembled prompts", description: "Checklist for conflicts between layers before submitting.", text: () => REVIEW_SYSTEM },
];
