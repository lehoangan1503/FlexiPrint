/**
 * flexiprint-mcp — v2 bộ nhân vật (agent task kind "char", migration 022). Asked 2026-10-08: every suggestion and
 * prompt of v2 is written by @flexiprint, which reads the DB and this code; the server only runs what it asks:
 *
 *   brainstorm  get_task gives the brief rules → submit_result {summary, questions, ideas} → a new idea round
 *   master      char_draw_masters (the agent's own prompt) → char_wait → view_image → char_refine_master … →
 *               submit_result {summary, image_ids: recommended, best first}; the editor approves one
 *   edits       the agent plans the 3b pictures itself (char_plan_pictures → brief.pictures, lib/char-pictures.ts;
 *               a set without a plan keeps lib/char-plan.ts) → char_run_edits → char_wait → view_image → redo the
 *               wrong ones → submit_result
 *
 * Every picture uses the team's image model (server/char/projects.ts). A bộ nhân vật's tasks are one agent_ide
 * session (server/agent/tasks.ts), so "như lần trước" refers to the earlier steps.
 */

import { CT_CONFIG, CT_TABLES } from "../../config";
import type { CtPrintTemplate } from "../../types/print";
import { templateRow } from "../print-templates";
import { addSetProduct } from "../char/set-users";
import { buildFromAgent, importFiles, importText } from "../char/import";
import { siteUrl } from "../site-url";
import type { CtAgentTask, CtAgentTaskProgress, CtCharBrief, CtCharImage, CtCharPhotoStyle, CtCharProject, CtCharRefUse, CtCharTaskResult } from "../../types";
import { REF_USES, REF_USE_INFO, masterPrompt, parseCharBrief, shownByDefault } from "../../lib/char-brief";
import { saveCharFile } from "../char/files";
import { KEEP, KEEP_CLEAR, optionPictures, planEdits, tailOf } from "../../lib/char-plan";
import { PICTURE_PLAN_RULES, checkPictures, parsePictures } from "../../lib/char-pictures";
import { latestEditsOf } from "../../lib/char-images";
import { CT_IMAGE_MODEL, imageModelLabel } from "../../lib/image-models";
import type { CtServiceClient } from "../supabase";
import { clip, record, str } from "../ai/llm";
import { CHAR_BRIEF_RULES, ideaRoundFrom } from "../char/brainstorm";
import { KEEP_REFINE, drawIdeaPreviews, drawMasters, loadImages, loadProject, projectRow, refineMasterImage, setApprovedMaster } from "../char/projects";
import { startBackdrops } from "../char/backdrops";
import { briefTemplate, projectBlank, startCharBlank, withTemplateProduct } from "../char/blank";
import { remakeSetProduct, versionSetsOf } from "../char/product";
import { followParentPlan, remakeDrawnProduct, runVersionChain, startVersionSets } from "../char/versions";
import { startPoseSets } from "../char/poses";
import { polygonMask, setBehind } from "../char/behind";
import { charVersions } from "../../lib/char-lineup";
import { runEditRoles, startBuild } from "../char/layers";
import { failLostPlan, startMatte, startPlan } from "../char/cut";
import { SAMPLE_ROLE, elementPictures, latestElementImages, startElements } from "../char/elements";
import { CT_MATERIALS } from "../../lib/materials";
import { STYLE_TEST_ROLE, latestStyleTests, removePhotoStyle, savePhotoStyle, setPhotoStyles, setStyleDemo, startStyleTests, testPhotosOf } from "../char/photo-styles";
import { TASK_ARG, json, liveStatus, loadTask, openTask, patchTask } from "./task-common";
import type { CtMcpContext, CtMcpTool } from "./tools";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// One MCP call is one silent POST: kept under the proxies' cut (Cloudflare Tunnel 100 s, nginx 120 s); the agent calls again.
const WAIT_MS = 60_000;
const POLL_MS = 4_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Seen 2026-10-19: the agent ended its turn "waiting for the server" (the auto task failed), opened helper tasks that
 * stayed "running" and blocked the page's chat, and asked the editor for ids it could read itself. */
const STAY = "Never end your turn while the server is still working for this request: keep calling char_status / char_wait (each waits up to a minute) until it is done, then go on — a turn that ends without submit_result FAILS the task. Do not open other tasks (char_open_task) on a set you already have a task for: every tool takes set_id for a version set, char_versions lists them, char_status gives the product ids. Ask the editor only what only they can decide.";

const COMMON = [
  "DEPLOY (asked 2026-10-29) — when the editor asks to deploy / put the product on sale: check_deploy {task_id, product_id} → fill every \"missing\" yourself: the Shopify title + description_html in US English (as a content task writes it: a clear searchable title, a warm description with what it is, how to personalize, size / material, care — p, ul/li, strong, h3 only; reuse lastContent / the linked product's text when it is good), the price table that fits the piece (its sizes match the product), mockups made earlier (make_product_mockups when there is none) → deploy_product (ACTIVE) → give the editor the Shopify url and admin url. A blocker you cannot fill (no price table at all, Shopify not configured) → say it in your summary.",
  "MISSING TOOL (asked 2026-10-29): you never change FlexiPrint's code. When a step needs something no tool does (the editor has a button for it, or nothing does it at all), do everything else, then say it in your summary under \"Thiếu tool MCP\": what the tool should do, its inputs, which editor button / screen it matches, and what you could not finish because of it — the team adds it and asks you again.",
  "You work on a v2 bộ nhân vật (character set) of FlexiPrint: ONE approved AI master illustration → pixel-registered layers (the customer swaps hair, colours, outfits…) → print products. READ flexiprint://guide/layer-rules first if you have not in this session — every picture after the master is an IN-PLACE edit of it.",
  "The image model is GPT Image 2.5 on the company API — the only one. Masters and the edits layers are cut from come on a transparent background (its own cut-out; no bg-remover). Every picture of a set is on one canvas: 1024×1024, or 1536×1024 for a row of 4+ subjects (a tall or wide group still fits inside with a margin). It re-draws a little of what it keeps (≈ 0.2 % scale, < 1 px per character): layer-kit measures and undoes that, so an edit is usable when what must stay looks the same — never ask it to move, zoom or re-frame.",
  "Write prompts in English. Talk to the editor (report_progress, summary, ask_user) in Vietnamese. report_progress before every batch of pictures (~30–60 s each).",
  "Pictures you make appear live in the editor's page. Look at every one with view_image before you judge it.",
  STAY,
  "\"references\" are pictures the editor dropped into the brief, each with a use (sample | style | character | outfit | pose | product | avoid) and the editor's note in Vietnamese — that note is what they want from it. view_image EVERY reference before you write anything. style / character / outfit / pose ones are attached to every master drawing automatically (with a line saying what to take from each) — your prompt must agree with them, never contradict them. product = how it should sit on the product; avoid = what must NOT be made. sample = a FINISHED product the editor wants something like (often the only picture): read everything from it — the product (shape, cut, size), the art style, every character (left → right: look, hair, skin, outfit, pose), the text (what it says, where, which parts are names the customer types), the decor and background — and turn it into the brief: characters → subjects, their hair / colours / outfits → slots (what the customer may change, per the note; ask_user when the note does not say), text → text, background / ornaments → decor (never part of the master). The master is only the characters, cut out on a transparent background; the rest comes back as separate layers.",
];

/** A lineup drawn version by version (brief.lineup.drawn) — said in the auto and chat steps. */
const DRAWN_LINEUP =
  "A LINEUP DRAWN VERSION BY VERSION (set.brief.lineup.drawn, asked 2026-10-19): this set is the biggest version (every subject); set.versions — or char_versions {task_id} (small: use it when get_task is too big to read) — lists a VERSION SET per smaller version (set_id, its subjects, masters, 3b pictures, cut). On approval of this set's master the server made each version set and drew 2 masters for it from the approved one. FIRST plan this set's 3b pictures (char_plan_pictures): every version set follows that plan (the characters it lacks dropped) and starts drawing it as soon as its master is approved. For each version: view_image both masters — the same characters as the approved master (faces, hair, outfits, proportions, how big the grandma is next to the children), only the listed ones, nobody cropped, small gaps, the same framing — then char_approve_master {task_id, set_id, image_id} (char_refine_master / char_draw_masters with set_id when neither is right). An approved version set runs 3a → 3b → 3c BY ITSELF on the server (minutes): watch get_task set.versions, view_image its 3b pictures like this set's; a wrong one → char_run_edits {task_id, set_id, prompts} then char_cut {task_id, set_id, what: \"plan\"}; char_status {task_id, set_id} waits. The product is built by the server once this set AND every version set are cut; after step 4 (backdrops, elements) char_remake_product rebuilds it. A version that needs other pictures than the plan gives it: char_plan_pictures with its set_id (its own plan from then on).";

/** A set drawn pose by pose (brief.poses) — said in the chat and auto steps. */
const POSED =
  "A SET DRAWN POSE BY POSE (set.brief.poses — EVERY set with 2+ characters since 2026-10-21; the editor: \"tất cả búp bê nên vẽ độc lập\"): never one master of everyone. Each pose = ONE character drawn ALONE, big, on its own square (a POSE SET: its own masters, doll, 3b pictures, files); subjects standing the same way share a pose (one drawn, the others take its files; brief.poses[].mirrored = placed flipped). Flow: 1) the brief with poses (char_update_brief; read the sample: who stands where, which way each head tilts, who overlaps whom — write that in scene for the composition) → 2) char_draw_poses (a pose set per pose + 2 masters each) → char_wait → view_image: the same character as the sample / references, ALONE, big, the same style and head size in every pose, the parts plain → char_approve_master {set_id, image_id} per pose when the editor handed you the whole set (else recommend; they approve on the pose's page) — char_refine_master / char_draw_masters with set_id fix one pose → 3) each approved pose runs 3a → 3b → 3c by itself (its 3b plan: the built-in one draws EVERY option of its one character on its doll — a picture per option, colours recoloured; char_plan_pictures with set_id only for something it cannot do) — watch char_versions, view_image its 3b pictures and files; a wrong one → char_run_edits {set_id} then char_cut {set_id, what: plan} → 4) when every pose is cut the server builds the product with everyone side by side; then char_compose: for each version (get_task set.composeVersions) where each character stands, how big, who is in front, mirrored or not — like the sample (the grandma taller in the middle behind, the children leaning in, a little overlap) → render_artwork mode print for each version → char_compose again until it reads like the sample → 5) step 4 as usual (elements, backdrops, char_remake_product, mockups).";

const BRAINSTORM_INSTRUCTIONS = [
  ...COMMON,
  "STEP brainstorm — turn the editor's idea into briefs. The brief rules and the result format are in \"briefRules\" (follow them exactly: English option names, slot modes, poses that keep parts separable).",
  "1. Read the idea, the request, the brief so far, the earlier rounds and steps; view_image every reference and the blank product. The briefs you write must follow what the references show and their notes (style sentence from the style references, subjects described as the character / outfit references show them, scene from the pose ones) — and say in each idea's \"why\" which reference it follows. A reference you cannot tell what to take from → ask_user.",
  "2. Only when something decides everything and you cannot guess it (the product, the cast), ask_user once with options. Otherwise go on.",
  "The piece: brief.product.templateId / layout (a khuôn in — list_print_templates) when the editor picked one; keep them in every idea and compose for its safe zone (a round ornament: everyone inside the centred circle, the top centre clear for the hole). None picked and the product is clear → set templateId + layout from list_print_templates yourself.",
  "3. submit_result(task_id, {summary, questions, ideas: [exactly 3 × {title, why, brief}]}) — the page shows them as directions the editor can take, each with a master the server draws from its brief (so every brief must be complete enough to draw).",
].join("\n");

/** How a set is made so its clipart cuts clean, and what each failed cut check means (asked 2026-10-30: "cho flexiprint
 * biết đường mà sau này tạo 1 bộ clipart sạch chuẩn"). Same as layer rules §9e. */
const CLEAN_SET =
  "CLEAN CLIPART (layer rules §9e, asked 2026-10-30) — a file is the 3b picture's pixels where it differs from what it was drawn on, so a set is clean when its pictures are: " +
  "1) master: solid sculpted hair with one outline, simple garments (§9-clean) — a master with loose strands is refined before approval. " +
  "2) same colour as the neighbour (silver hair under a white fur brim, a white sleeve on a pale hand, a red hat on a red sweater, hair the colour of the skin): give the slot cutColor in the brief BEFORE its 3b pictures are drawn — a #rrggbb far from every neighbour, mid-light, never magenta or skin; the colours of that slot (the first one too) take their hex from the part in the master. Check every pair of parts that touch: the hair against the hat, face and outfit; a hat against the sweater; a sleeve against the hand. " +
  "3) every picture adds ONE part and moves nothing of the picture it is drawn on (the doll's face, arms, outline stay where they were). " +
  "4) after char_cut read char_status failedChecks and fix by the check, never by asking for a looser cut: \"Khớp\" (the picture moved) or \"xoá / dời … px của búp bê\" → char_run_edits that picture again (same prompt + \"keep the figure exactly where it is, do not move or resize anything\") · \"Vùng trống\" → the part was not drawn: draw it bolder · \"Ghép = 3b\" red (lỗ = see-through pixels, p99 = colour steps): when the same picture also failed Khớp, redraw it; when its part is the same colour as its neighbour, give the slot cutColor and redraw; otherwise view_image the file and its picture, redraw once, and if it stays red say so in the summary (the editor fixes it by hand). A few hundred lỗ px along a jaw or ear are normal (the back hair fills them). " +
  "5) redraw a picture with its PLAN prompt: char_run_edits {roles: [role]} (prompts {role} replaces the whole prompt, the part's description too — then copy it in), and a lasting change (\"keep the figure exactly where it is\") goes into the plan with char_plan_pictures. Note each attempt's numbers (Khớp px, Ghép lỗ / p99); when the last is worse than an earlier one, char_use_edit the best attempt (then redraw the pictures drawn from it). At most 3 attempts per picture — then keep the best and say what is still red. " +
  "6) re-cut (char_cut \"plan\" after a redrawn picture) and report every check that is still red.";

const MASTER_INSTRUCTIONS = [
  ...COMMON,
  "STEP master — make the ONE master every layer will be cut from. \"assembledPrompt\" is the server's template from the brief: a starting point, not a rule — improve it.",
  "1. Read the brief (style, subjects left → right, slots with their FIRST option = how the master shows it, photo zones, product). view_image every reference (and their notes) and the blank product.",
  "2. Write the master prompt: the style; every subject in order, full body, its fixed clothing + the first option of every slot, PLAIN solid colours with the hex when given (no pattern, logo, text on any part a customer recolours); the pose / arrangement with a small gap between subjects (nobody covers another one's customisable part, no hair over someone else, pets beside the feet); photo zones drawn EMPTY (plain light grey, clean edge); the group centred with a generous empty margin; a fully transparent background (the server draws every master cut out), no floor, no cast shadow, no scenery, no text. For a die-cut product (cut \"alpha\") everything must be one connected silhouette.",
  "3. char_draw_masters(task_id, prompt, count 2) → char_wait → view_image. Check: it follows the references as their notes say (style, faces, outfits) without copying anything else; every subject, in order, nobody cropped; every customisable part clearly visible and plain; hair fully visible (it will be removed and re-added); background transparent and clean (no white or checkerboard drawn in); photo zones empty; the style right.",
  "4. A candidate that is close: char_refine_master(task_id, image_id, prompt) with ONE precise change (\"make the dog 20 % smaller, keep it where it is\") — an in-place edit, the rest stays. A candidate that is wrong overall: fix the prompt and draw again. At most ~3 rounds; then submit what is best and say what is still off.",
  "5. A refinement request (task \"imageId\" set): edit THAT master by the request (char_refine_master), check it, submit it.",
  "6. submit_result(task_id, {summary: Vietnamese — what you drew, what you checked, what is still off; image_ids: the masters you recommend, best first}). The editor approves one — you never approve.",
].join("\n");

const EDITS_INSTRUCTIONS = [
  ...COMMON,
  "STEP edits (UI: 3b \"AI vẽ ảnh để cắt clipart\") — the pictures the clipart files are cut from (\"edits\" lists every one: role, what it is for, the source it is drawn from, a starting prompt, and the current result if any). YOU decide which pictures exist (char_plan_pictures, rules in \"picturePlan.rules\") and how each is asked. How the set is cut (rebuilt 2026-10-14, pixel lock): the PAPER DOLL is the body file; every option is drawn ON the doll, in place; a clipart file = the option picture's pixels where it differs from the doll — nothing is segmented or guessed. So the doll + a file IS that picture: what you see in a picture is exactly what the customer gets.",
  "Roles: work = the approved master itself (no prompt) · base = the paper doll: every part the customer changes taken off (bald, a flat magenta tank top and shorts, empty hands) — the body file and the canvas of every option · shape:<slot>:<option> = one option drawn on the doll (every option of a shape / texture part, the first option of a colour part — its other colours are recolours of that picture) · zone:<zone> = a customer-photo zone painted magenta on the doll · thumb:<slot>:<option> = a held item / accessory drawn ALONE and complete from its option picture (the part the hand hides drawn too) — only the option's thumbnail in the shop, never cut (its server ending asks for the object alone, centred, transparent).",
  "0. No plan yet (picturePlan.byAgent false and nothing drawn): char_plan_pictures first — a plan of your own for this set.",
  "1. For each edit write a prompt that changes EXACTLY one thing on the named subject (say which one: \"the second character from the left\") WITHOUT the ending sentence: the server appends keepSentence (zones — drawn on white) or clearSentence (every other picture — drawn on a transparent background). base: a family-friendly paper-doll dress-up base (worded so; plainly \"remove her dress\" is refused), the bodies exactly as they were. An option: the hairstyle / garment / item in the same art style, sitting naturally on the doll — a garment covers the magenta underwear completely where it is worn (an open jacket shows it only in its opening); nothing else of the doll moves.",
  "2. char_run_edits(task_id, prompts: {role: prompt}, roles: [...]) — the doll is made first automatically; \"roles\" runs a role with its starting prompt (get_task \"startingPromptExamples\"); give a prompt only where you want a different one. → char_wait → view_image the results (a few at a time).",
  "3. Check each: transparent background; the doll's body, face, arms and hands did NOT move or change (a layer can only ADD to the doll — an arm drawn in a new place leaves the old arm visible); no magenta shows on a garment (it is a chroma key: never part of a clipart); the part looks right in the art style. Wrong → a better prompt and char_run_edits for that role again (at most ~3 tries per role). After the cut, the plan checks say it too (\"Khớp\" = the picture moved, \"xoá / dời … px của búp bê\" = it changed the doll).",
  "4. submit_result(task_id, {summary: Vietnamese — what you ran, what you redid and why, what is still off; image_ids: the final edits}). The editor then cuts the layers (layer-kit) and sees the checks.",
  CLEAN_SET,
].join("\n");

/** The material ids a brief's product can name (asked 2026-10-28: a clear glass ornament with a diamond-cut edge). */
const MATERIALS = `brief.product.material = what the piece is made of, one of: ${CT_MATERIALS.filter((m) => m.id !== "none").map((m) => `"${m.id}" (${m.label})`).join(", ")} — the phôi and the mockups are drawn in it (a glass ornament: "glass_clear" and a khuôn named after it, e.g. "Ornament kính tròn cạnh vát kim cương"). A khuôn with no phôi (get_task blankProduct null) or one of another material → char_make_blank, char_wait, view_image, then char_remake_product before make_product_mockups — never leave it for the editor.`;

/** A bộ ảnh khách's own AI styles — chat and auto. */
const PHOTO_STYLES =
  "STYLE ẢNH KHÁCH (a bộ ảnh khách with treat \"ai\", asked 2026-10-28): the styles are the set's OWN, written from the editor's request — \"siêu nhân áo choàng đỏ, khăn len, dây đèn…\" = one style per idea (1, 2, 6…, never padded; a single style is fine, the store then shows no picker). char_save_photo_style per idea: name (English, the customer sees it: \"Cozy Scarf\"), prompt = SHORT plain English, a few sentences like a person would write (asked 2026-10-28: no numbered rules, no long DO / NEVER lists): what to redraw (the pet or person of the customer's photo, keeping their real face and colours), how it is painted, what it wears or holds, and \"transparent background, no text or frame\". e.g. \"Redraw the pet from the customer's photo as a hand-painted watercolour portrait with a fine ink outline, head and chest. Keep its real face, eyes and fur colours. Dress it in a bright red superhero cape with a small gold clasp. Transparent background, no text, no frame.\" ref_urls: ONLY a picture the editor attached that shows the look of THAT style (a scarf like this, a painting style like this) — view_image each attachment and decide: a finished product sample (the whole ornament, a mockup) is char_add_reference use sample, not a style reference; never add the master or an element picture by default; none = []. The server tells the model which image is the customer's photo — the prompt need not number images. Every style is ONE look applied to whatever the customer uploads (dog, cat, person): never name a breed or a colour of the sample. Then char_test_photo_styles → char_wait → view_image every test (real face kept? the costume there? transparent, nothing cut off?), fix the prompt and test again (≤ 3 rounds); char_style_demo the best test of each style. The editor sees each test as photo → result, drags a card into the chat to ask for a change (the attachment label names the style id). Other options (frames, slogan, name text) stay brief.elements / brief.texts. char_remake_product puts the styles on the product; a prompt change works at once for customers, names / demos / new styles need the product rebuilt and redeployed.";

/** Editors write short, loose requests (asked 2026-10-28: "làm sao 1 editor ghi đầy đủ chi tiết như vậy được") —
 * the agent fills in the rest from the reference pictures and these defaults, then writes its plan back for review. */
const SHORT_REQUESTS =
  "SHORT REQUESTS (asked 2026-10-28): editors write a few loose lines (\"4 style: siêu nhân, khăn len…; 4 khung giáng sinh; tên trên trái; slogan trắng dưới; khuôn tròn; phôi kính\") and attach a sample. Never ask them for the details — fill them in from the sample picture and these defaults: decorations follow the khuôn's outline (a round khuôn → a wreath / garland curving with the circle, a U hugging the bottom and sides of the subject — never straight bars or a square frame on a round piece), every option of an element the same size, place and curve; the photo zone in the middle, the frame over its cut-off bottom; a customer name in a script font where they said; a fixed slogan curved along the edge when the sample does so; everything clear of the hanging hole and inside the safe area; a khuôn of that shape already in list_print_templates is reused, never a duplicate; a material they name (glass_clear…) is the khuôn's blank for the mockups (a khuôn with no phôi of that material yet → char_make_blank before the mockups); the texts' colour readable on that material. Then, in your first summary, write back in short Vietnamese what you decided (each style, each element and its options, the texts, khuôn, phôi, which attached picture went where) so the editor reviews it there and corrects only what is off.";

const IMPORTED =
  "AN IMPORTED SET (set.brief.imported — someone's own finished files, a Teeinblue export…, asked 2026-10-29): no master, no 3a/3b/3c, nothing drawn by AI. A known layout is read by the server; any other folder is yours: char_import_files (the folder: paths, sizes, small text files) → char_import_read (a json / csv / md / txt) and view_image a few layer files (url) → understand it: the canvas size (every layer file is the WHOLE canvas, same size — layer rules), the versions the customer picks first (number of people…) and inside one the variants (layout), each layer bottom → top — static (always there), choice (the customer picks: groups = a first row like skin tone / hair colour, options = the files), linked (follows another layer's choice: a head with the body's skin + outfit, the hair under the hat — its groups and options mirror the leader's, same counts and order) — and the texts the customer types (centre, width, letter height px, angle, colour, Google font + weight). Then char_import_build {task_id, manifest} (files by their path in the folder); set.brief.imported shows the build (status building → done, problems). Afterwards the set works like any other: render_artwork its product, make_product_mockups, char_add_product. A layout change after the build = char_import_build again with the fixed manifest. Never draw, trim or scale a file.";

const CHAT_INSTRUCTIONS = [
  ...COMMON,
  "STEP chat — the editor typed a request in the sticky chat of the set's page (like talking to you in a terminal). \"tab\" / \"section\" say where they were (1. Mô tả bộ clipart = brief · 2. Ảnh master · 3. Cắt clipart → 3a master cỡ in, 3b AI vẽ ảnh để cắt, 3c cắt clipart · 4. Sản phẩm) — the request is about THAT part unless it says otherwise. \"attachments\" are screenshots or pictures of the page they sent: view_image EVERY one first and find what they point at (a clipart file, a layer, a region, a master…). \"set\" is the whole bộ: brief, masters, the 3b pictures (edits, with prompts), the 3c regions (plan.pieces: key, picture, region url), the layer files (layers.slots[].files: option, colour, url, piece), the products, the earlier requests and what you answered.",
  "A NEW SET FROM THE CHAT (asked 2026-10-19: the brief has no form any more — the editor writes everything in this chat, with the reference pictures attached): when set.brief has no subjects (no photo zone for a bộ ảnh khách) the request IS the brief. 1) view_image EVERY attachment; 2) char_add_reference {task_id, url: the attachment url, use: sample for a finished product they want something like (style / character / outfit / pose / product / avoid otherwise), note: what they want from it, in their words}; 3) write the WHOLE brief from their words + the pictures by \"briefRules\" (char_update_brief {brief}) — the picture decides proportions and layout (how much of the height the sign takes, who is in the middle, how close they stand), their words win over it; 4) char_draw_masters (2, your own prompt from \"assembledMasterPrompt\" after char_get_brief) → char_wait → view_image → char_refine_master where close; 5) submit_result with a short Vietnamese summary of the brief (characters, what the customer changes, versions, texts) + which master you recommend — the editor approves it on step 2. Never approve it yourself unless they said so.",
  "Do exactly what is asked, nothing else, then check it with view_image. The tools:",
  "- brief: char_update_brief(task_id, brief) — the whole brief back (from \"set.brief\" with your change). Once a master is approved only additions are allowed (a new option / colour / slot / zone; existing ids and every slot's first option stay) — after one, run its 3b picture (char_run_edits) and re-cut (char_cut).",
  "- master: char_draw_masters / char_refine_master → char_wait → view_image. The editor approves a master themself (say which one you recommend).",
  "- 3b plan: char_plan_pictures(task_id, pictures) — WHICH pictures the set has and what each draws (\"picturePlan.rules\"); a new option in the brief needs a picture in the plan. Change a prompt for good in the plan; char_run_edits prompts are one-off.",
  "- 3b pictures: char_run_edits(task_id, prompts {role: prompt}, roles) — a redone picture redoes what is drawn from it; then char_cut so the files follow.",
  "- cut: char_cut(task_id, \"plan\") finds every region again from the 3b pictures and cuts the files; char_cut(task_id, \"build\") cuts the files (and remakes the product) from the current regions. char_status(task_id) waits for it and returns the checks and the new files — view_image the files you changed (and a combination of them) before you say it is fixed.",
  "- approve a master: ONLY when the editor's request hands you the whole set (\"làm hết\", \"tự duyệt\") — char_approve_master(task_id, image_id); it starts 3a. Otherwise recommend one and let them approve.",
  "- step 4 (product): the texts (brief.texts: names typed by the customer, a slogan picked from a list — place top / bottom / left / right) and the backgrounds (brief.backdrops) are changed with char_update_brief (allowed after the master is approved). char_draw_backdrops draws the backgrounds (char_wait, view_image each), char_remake_product builds the set's product again with them. Then list_product_options / render_artwork (mode \"print\", options) to check it, make_product_mockups (one entry per option set + scenes) → wait_product_mockups → view_image. ANOTHER product from the set (\"thêm sản phẩm tương tự … sứ / thảm / túi\") is char_add_product — never char_remake_product (that replaces the set's own product).",
  "- a question only the editor can answer → ask_user (Vietnamese, with options).",
  "BỘ ẢNH KHÁCH (set.brief.kind \"photo\" — the customer's own photo is the hero: a pet memorial ornament, a portrait): there are no characters, no 3a/3b/3c and no cut. brief.photoZones[0] = the customer's photo (where = what it shows, e.g. \"the customer's pet, sitting\"; treat \"ai\" + styles = the styles the customer picks from — the set's OWN styles written from the request (PHOTO_STYLES; a library style from list_ai_styles only when the editor names one); \"face\" = head only; box = shares of the safe area, null = laid out). brief.elements = the decorations, each {name, place: behind (wings) | above (halo) | bottom (a band of clouds over the photo's cut body, the texts lie on it) | free (box), mode shape | color (#hex options, the first drawn, the others recoloured), options, perBackdrop (one picture per background in its colours, follows the background)}. Flow: char_update_brief → char_draw_masters (the whole flat design with a SAMPLE pet) → the editor approves (or char_approve_master when handed the whole set) → char_draw_backdrops → char_draw_elements (every element option + the zone's sample: the master's pet alone) → char_wait, view_image each (whole? transparent? same look as the master?) → char_remake_product (keeps a photo zone the editor reshaped; reset_zones true = the layout again) → list_product_options, render_artwork, make_product_mockups.",
  PHOTO_STYLES,
  SHORT_REQUESTS,
  CLEAN_SET,
  MATERIALS,
  "A bộ nhân vật with a CHOICE OF WHO is in the picture (brief.lineup — a boy OR a girl; 1–5 people of a family): every subject drawn once in the master, standing apart (the server splits the body file per subject); the product gets one version per choice with only its subjects' layers — render_artwork / make_product_mockups pick it with {\"Version\": \"Girl\"} (or the lineup label). Decorations of a bộ nhân vật (brief.elements: a ribbon banner, a year in glitter numbers, trees beside the family, a ground band) are drawn after the master approval with char_draw_elements (each option alone, the master as the style reference) and placed by place / box; texts can be \"under\" a subject or \"free\" in a box; brief.charactersBox places the characters. Backdrops with tile true are seamless pattern squares repeated over the piece (a rug's plaid). A product with no fitting khuôn: create_print_template with the real size first. brief.choosers (boy / girl per child, grandma / grandpa, hats / no hats) + shownWhen on slots / texts / elements, slot follows (an element id: sweaters and hats follow the Theme), subject always (the grandma in every version), texts kind fixed / place on (a name on a hat brim): see briefRules in a brainstorm or the layer rules; render_artwork picks a chooser option by its label ({\"Grandchild 1\": \"Girl\", \"Hats\": \"No Hats\"}).",
  "A bộ nhân vật with a customer FACE (an elf / Santa body with the customers' faces, a die-cut acrylic): a normal character set with brief.photoZones [{where: \"the left elf's face\", treat: \"face\"}] and product.cut \"alpha\" — the master leaves the face empty, the body file gets a hole there and the face sits under it (hat brim, hair edge and collar over it).",
  POSED,
  DRAWN_LINEUP,
  IMPORTED,
  "submit_result(task_id, {summary: Vietnamese — what you changed, where to see it on the page, what is still off; image_ids: pictures you made, if any}).",
].join("\n");

const AUTO_INSTRUCTIONS = [
  ...COMMON,
  "STEP auto — the editor approved a master; everything after it is yours, on your own, until the product is finished (asked 2026-10-18: the editor only writes the request and approves the master; \"Dừng\" cancels this task — a cancelled task's tools refuse: stop at once). Same tools as a chat request. Check each stage with view_image before the next; fix what is wrong yourself (redraw a picture — never patch the cut); report_progress in Vietnamese at every stage (what is done, what you redid and why). Order:",
  "1. Bộ nhân vật: char_status waits for 3a (the master at print size, started on approval). Bộ ảnh khách (brief.kind \"photo\"): skip to 4.",
  "2. 3b: PLAN the pictures yourself — char_plan_pictures (rules in \"picturePlan.rules\"): from the brief and the approved master decide the doll and the pictures that give every option a clean cut (one character per picture — a set with several characters is drawn pose by pose; hair under hats drawn on / cut against the outfit picture; no rule in the code decides this for you). Then get_task \"set.edits\" lists them — char_run_edits with roles (all missing ones) → char_wait → view_image EVERY picture (a grid of a few at a time): transparent; the doll unchanged; exactly ONE part added (no stole on the gown picture, no gown on the stole picture, pants never recolour the top); no magenta on a part; thin parts on small figures drawn bold. Redraw the wrong ones (≤ 3 tries each).",
  "3. 3c: char_cut what \"plan\" (finds the regions, cuts the files, makes the product) → char_status → every failed check: redraw its picture, char_cut \"plan\" again. Then view_image the product (render_artwork mode print — each version / a few option sets).",
  "4. Step 4: char_draw_backdrops and char_draw_elements (every missing picture) and char_make_blank when the khuôn has no phôi of brief.product.material → char_wait → view_image each → redraw the wrong ones → char_remake_product → render_artwork (print, a few option sets: versions, themes, colours, names) → fix the layout in the brief (charactersBox, element / text boxes) with char_update_brief + char_remake_product when it does not read like the reference → make_product_mockups (2–3 option sets × the brief's scenes) → wait_product_mockups → view_image.",
  "4b. Bộ ảnh khách with treat \"ai\": the styles (PHOTO_STYLES below) before char_remake_product — none yet → write them from the request; test, fix, pick the demos.",
  PHOTO_STYLES,
  MATERIALS,
  CLEAN_SET,
  "5. submit_result {summary: Vietnamese — what was made (versions, options, mockups), what you fixed, what is still worth a look; image_ids: a few mockups}. Then the editor asks for changes in the chat.",
  POSED,
  DRAWN_LINEUP,
].join("\n");

const STEP_INSTRUCTIONS = { brainstorm: BRAINSTORM_INSTRUCTIONS, master: MASTER_INSTRUCTIONS, edits: EDITS_INSTRUCTIONS, chat: CHAT_INSTRUCTIONS, auto: AUTO_INSTRUCTIONS } as const;

async function charOf(db: CtServiceClient, task: CtAgentTask): Promise<{ project: CtCharProject; images: CtCharImage[] }> {
  const id = task.input.char?.projectId;
  if (task.kind !== "char" || !id) throw new Error("This tool is for bộ nhân vật (char) tasks");
  const project = await loadProject(db, id);
  if (!project) throw new Error("The bộ nhân vật of this task no longer exists");
  return { project, images: await loadImages(db, id) };
}

/** One starting prompt per kind of edit (base, shape, zone): the others follow the same pattern. */
function startingPromptExamples(brief: CtCharBrief): Array<{ role: string; prompt: string }> {
  const seen = new Set<string>();
  return planEdits(brief)
    .filter((e) => e.prompt && !seen.has(e.role.split(":")[0]) && seen.add(e.role.split(":")[0]))
    .map((e) => ({ role: e.role, prompt: withoutKeep(e.prompt) }));
}

function picture(im: CtCharImage, numbers?: Map<string, number>) {
  return {
    id: im.id,
    ...(numbers ? { number: numbers.get(im.id) } : {}),
    status: im.status,
    url: im.url,
    width: im.width,
    height: im.height,
    prompt: im.prompt,
    ...(im.note ? { note: im.note } : {}),
    ...(im.parent_id ? { parent_id: im.parent_id } : {}),
    ...(im.model ? { model: imageModelLabel(im.model) } : {}),
    ...(im.meta.align ? { align: im.meta.align } : {}),
    ...(im.error ? { error: im.error } : {}),
  };
}

/** The brief for the edits step: no option / colour ids (the roles carry them), no reference list (references). */
function compactBrief(b: CtCharProject["brief"]) {
  const { refs: _refs, ...rest } = b;
  return {
    ...rest,
    subjects: b.subjects.map((sub) => ({
      ...sub,
      slots: sub.slots.map((sl) => ({ ...sl, options: sl.options.map((o) => ({ name: o.name, value: o.value })), colors: sl.colors.map((x) => ({ name: x.name, value: x.value })) })),
    })),
  };
}

/** What a new brief drops of the approved one (the edits, regions and files hang on these ids). */
function briefLosses(old: CtCharBrief, next: CtCharBrief): string[] {
  const out: string[] = [];
  for (const sub of old.subjects) {
    const ns = next.subjects.find((x) => x.id === sub.id);
    if (!ns) {
      out.push(`subject ${sub.id} removed`);
      continue;
    }
    for (const sl of sub.slots) {
      const nl = ns.slots.find((x) => x.id === sl.id);
      // A slot the master does not show (optional, or behind a chooser's other option) was never cut from it:
      // it may go (a hat slot replaced by one slot per hat style).
      if (!nl && (sl.optional || !shownByDefault(old, sl.shownWhen))) continue;
      if (!nl) {
        out.push(`slot ${sl.part} removed`);
        continue;
      }
      if (nl.mode !== sl.mode || nl.wraps !== sl.wraps) out.push(`slot ${sl.part}: mode / wraps changed`);
      sl.options.forEach((o, i) => {
        const no = nl.options[i];
        if (!no || no.id !== o.id) out.push(`slot ${sl.part}: option ${o.name} moved or removed`);
      });
      sl.colors.forEach((o, i) => {
        const no = nl.colors[i];
        if (!no || no.id !== o.id) out.push(`slot ${sl.part}: colour ${o.name} moved or removed`);
      });
    }
  }
  for (const z of old.photoZones) if (!next.photoZones.some((x) => x.id === z.id)) out.push(`photo zone ${z.label} removed`);
  return out;
}

/** An edit prompt without its ending sentence (the server adds it: withTail). */
const withoutKeep = (prompt: string) => [KEEP, KEEP_CLEAR].reduce((p, t) => p.replace(t, ""), prompt).trim();
const withTail = (prompt: string, tail: string) => (prompt.includes(tail.trim()) ? prompt : withoutKeep(prompt).replace(/\.?\s*$/, ".") + tail);

type EarlierTask = Pick<CtAgentTask, "id" | "created_at" | "status" | "input" | "result" | "error">;

/** get_task of a chat request: the whole set, nothing left out (asked 2026-10-12: the agent must see what the editor
 * sees — brief, masters, 3b pictures with their prompts, 3c regions, every layer file, the products). */
/** The set's styles as get_task shows them: prompt, style references, demo, the newest test per test photo. */
function photoStylesView(p: CtCharProject, images: CtCharImage[], styles: CtCharPhotoStyle[]) {
  const tests = latestStyleTests(images);
  return {
    testPhotos: testPhotosOf(p),
    styles: styles.map((st) => ({
      ...st,
      tests: tests
        .filter((im) => im.role.startsWith(`${STYLE_TEST_ROLE}${st.id}:`))
        .map((im) => ({ id: im.id, status: im.status, url: im.url || null, photo: (im.meta as { sourceUrl?: string }).sourceUrl ?? null, ...(im.error ? { error: clip(im.error, 300) } : {}), stale: im.created_at < st.updated_at })),
    })),
  };
}

function chatView(task: CtAgentTask, p: CtCharProject, images: CtCharImage[], numbers: Map<string, number>, before: EarlierTask[], versions: unknown[], styles: CtCharPhotoStyle[]): Record<string, unknown> {
  const c = task.input.char!;
  const latest = latestEditsOf(images);
  const plan = p.cut?.plan ?? null;
  return {
    id: task.id,
    kind: task.kind,
    step: c.step,
    request: c.request,
    tab: c.tab ?? "brief",
    section: c.section ?? "",
    attachments: (c.attachments ?? []).map((a) => ({ ...a, picture: a.imageId ? (images.find((im) => im.id === a.imageId) ?? null) : null })),
    imageModel: imageModelLabel(CT_IMAGE_MODEL),
    set: {
      id: p.id,
      name: p.name,
      status: p.status,
      approvedMasterId: p.master_id,
      briefLocked: !!p.master_id,
      brief: p.brief,
      references: p.brief.refs.map((r) => ({ ...r, url: images.find((x) => x.id === r.id)?.url ?? null })),
      blankProduct: projectBlank(p, images)?.url ?? null,
      masters: images.filter((im) => im.kind === "master").map((m) => ({ ...picture(m, numbers), approved: m.id === p.master_id })),
      assembledMasterPrompt: masterPrompt(p.brief),
      // Compact (a 5-character set has 130+ edits and the agent's tool output is capped): no starting prompt per role
      // (char_run_edits uses it; startingPromptExamples shows one per kind), a picture's prompt only when it differs.
      edits: p.master_id && p.brief.kind !== "photo"
        ? planEdits(p.brief).map((e) => {
            const im = latest.get(e.role);
            const current = im
              ? {
                  id: im.id,
                  status: im.status,
                  url: im.url,
                  ...(im.prompt && withoutKeep(im.prompt) !== withoutKeep(e.prompt) ? { prompt: clip(withoutKeep(im.prompt), 600) } : {}),
                  ...(im.meta.align ? { align: im.meta.align } : {}),
                  ...(im.error ? { error: clip(im.error, 300) } : {}),
                }
              : null;
            return { role: e.role, label: e.label, source: e.source, current };
          })
        : [],
      startingPromptExamples: p.master_id && p.brief.kind !== "photo" ? startingPromptExamples(p.brief) : [],
      // The 3b plan: yours (brief.pictures) or none yet — the rules for writing one.
      ...(p.brief.kind !== "photo"
        ? {
            picturePlan: {
              byAgent: !!p.brief.pictures?.length,
              pictures: p.brief.pictures?.length ?? 0,
              files: p.brief.pictures?.length ? optionPictures(p.brief).length : 0,
              ...(p.brief.pictures?.length ? { problems: checkPictures(p.brief, p.brief.pictures, !p.brief.versionOf) } : {}),
              rules: PICTURE_PLAN_RULES,
            },
          }
        : {}),
      masterAtPrintSize: p.cut?.matte ? { status: p.cut.matte.status, error: p.cut.matte.error, url: p.cut.matte.colourUrl, alphaUrl: p.cut.matte.alpha?.url ?? null, width: p.cut.matte.width, height: p.cut.matte.height } : null,
      plan: plan
        ? {
            status: plan.status,
            error: plan.error,
            width: plan.width,
            height: plan.height,
            approved: plan.approved,
            pictures: plan.pictures.map((x) => ({ id: x.id, label: x.label, url: x.colourUrl, alphaUrl: x.alphaUrl })),
            pieces: plan.pieces.map((x) => ({ key: x.key, label: x.label, kind: x.kind, slot: x.slot, option: x.option, picture: x.picture, region: x.region.url, handFixed: x.region.edited })),
            checks: plan.checks,
          }
        : null,
      layers: p.layers
        ? {
            status: p.layers.status,
            error: p.layers.error,
            width: p.layers.width,
            height: p.layers.height,
            approved: p.layers.approved ?? false,
            checks: p.layers.checks,
            diff: p.layers.diffUrl ?? null,
            slots: p.layers.slots.map((sl) => ({ key: sl.key, label: sl.label, follows: sl.follows, files: sl.files.map((f) => ({ imageId: f.imageId, option: f.option, color: f.color, url: f.url, view: f.viewUrl ?? null, piece: f.piece ?? null })) })),
          }
        : null,
      // Every element picture the brief needs (+ a bộ ảnh khách's zone samples), with its newest picture.
      ...(p.brief.kind === "photo" || p.brief.elements.length
        ? {
            elementPictures: [
              ...elementPictures(p).map((x) => ({ role: x.role, element: x.element.name, option: x.name, recolouredFromFirst: !!x.recolor, current: latestElementImages(images).has(x.role) ? picture(latestElementImages(images).get(x.role)!) : null })),
              ...(p.brief.kind === "photo" ? p.brief.photoZones : []).map((z) => ({ role: `${SAMPLE_ROLE}${z.id}`, element: `sample — ${z.label}`, option: "", recolouredFromFirst: false, current: latestElementImages(images).has(`${SAMPLE_ROLE}${z.id}`) ? picture(latestElementImages(images).get(`${SAMPLE_ROLE}${z.id}`)!) : null })),
            ],
            running: images.filter((im) => im.status === "running").map((im) => ({ id: im.id, role: im.role })),
          }
        : {}),
      // A bộ ảnh khách's AI styles (each = one style option for the customer) with their newest tests.
      ...(p.brief.kind === "photo" ? { photoStyles: photoStylesView(p, images, styles) } : {}),
      productIds: p.product_ids,
      // A lineup drawn version by version: each smaller version's own set (its masters, 3b pictures, cut); a set drawn
      // pose by pose: each pose's set, and the versions char_compose places.
      ...(versions.length ? { versions } : {}),
      ...(p.brief.poses?.length ? { composeVersions: charVersions(p.brief).map((v) => ({ name: v.name, subjects: v.subjects.map((i) => p.brief.subjects[i].id) })) } : {}),
      // Step 4: the backgrounds drawn for brief.backdrops (newest per backdrop last) and the phôi.
      backdropPictures: images.filter((im) => im.kind === "blank" && im.role.startsWith("backdrop:")).map((im) => ({ id: im.id, backdrop: im.role.slice(9), status: im.status, url: im.url, prompt: im.prompt, error: im.error || undefined })),
      blanks: images.filter((im) => im.kind === "blank" && !im.role.startsWith("backdrop:") && im.status === "done").map((im) => ({ id: im.id, role: im.role, url: im.url })),
    },
    keepSentence: KEEP.trim(),
    clearSentence: KEEP_CLEAR.trim(),
    earlier: before.map((t) => ({
      at: t.created_at,
      step: t.input.char?.step,
      tab: t.input.char?.tab,
      section: t.input.char?.section,
      request: t.input.char?.request ?? "",
      attachments: t.input.char?.attachments ?? [],
      status: t.status,
      answer: t.result && "summary" in t.result ? str(t.result.summary) : t.error,
    })),
    questions: (task.questions ?? []).map((q) => ({ id: q.id, question: q.question, options: q.options.map((o) => o.label), answer: q.answer })),
    // How a brief is written (a new set described in the chat, or a change of it before the master).
    ...(!p.master_id ? { briefRules: CHAR_BRIEF_RULES } : {}),
    instructions: c.step === "auto" ? AUTO_INSTRUCTIONS : CHAT_INSTRUCTIONS,
  };
}

/** get_task of a char task. */
export async function charTaskView(db: CtServiceClient, task: CtAgentTask): Promise<unknown> {
  const c = task.input.char!;
  const { project: p, images } = await charOf(db, task);
  const masters = images.filter((im) => im.kind === "master");
  const numbers = new Map(masters.map((m, i) => [m.id, i + 1]));
  const { data: before } = await db
    .from(CT_TABLES.agentTasks)
    .select("id,created_at,status,input,result,error")
    .eq("kind", "char")
    .eq("input->char->>projectId", p.id)
    .neq("id", task.id)
    .order("created_at")
    .limit(30)
    .returns<Array<Pick<CtAgentTask, "id" | "created_at" | "status" | "input" | "result" | "error">>>();
  const latest = latestEditsOf(images);
  if (c.step === "chat" || c.step === "auto") return chatView(task, p, images, numbers, before ?? [], await versionsView(db, p), p.brief.kind === "photo" ? await setPhotoStyles(db, p) : []);
  const out: Record<string, unknown> = {
    id: task.id,
    kind: task.kind,
    step: c.step,
    request: c.request,
    ...(c.imageId ? { imageId: c.imageId, what: `Refine master #${numbers.get(c.imageId) ?? "?"} by the request.` } : {}),
    imageModel: imageModelLabel(CT_IMAGE_MODEL),
    project: {
      id: p.id,
      name: p.name,
      status: p.status,
      approvedMasterId: p.master_id,
      // edits: the brief without the option / colour ids (they are in the roles) — get_task must stay small
      brief: c.step === "edits" ? compactBrief(p.brief) : p.brief,
      layers: p.layers ? { status: p.layers.status, error: p.layers.error, checks: p.layers.checks.filter((x) => !x.ok) } : null,
    },
    // The editor's reference pictures, each with what it is for and their own words about it.
    references: p.brief.refs
      .map((r) => {
        const im = images.find((x) => x.id === r.id && x.status === "done");
        return im ? { id: im.id, use: r.use, editorNote: r.note, sentToImageModel: !!REF_USE_INFO[r.use].take, url: im.url } : null;
      })
      .filter(Boolean),
    blankProduct: projectBlank(p, images)?.url ?? null,
    // The edits step works on the approved master only (get_task must stay small: the agent's tool output is capped).
    masters:
      c.step === "edits"
        ? masters.filter((m) => m.id === p.master_id).map((m) => ({ id: m.id, number: numbers.get(m.id), url: m.url, width: m.width, height: m.height, approved: true }))
        : masters.map((m) => ({ ...picture(m, numbers), approved: m.id === p.master_id })),
    earlier: (before ?? []).map((t) => ({
      at: t.created_at,
      step: t.input.char?.step,
      request: t.input.char?.request ?? "",
      status: t.status,
      summary: t.result && "summary" in t.result ? clip(str(t.result.summary), 800) : t.error,
    })),
    questions: (task.questions ?? []).map((q) => ({ id: q.id, question: q.question, options: q.options.map((o) => o.label), answer: q.answer })),
    instructions: STEP_INSTRUCTIONS[c.step],
  };
  if (c.step === "brainstorm") {
    out.ideaRounds = p.ideas.slice(-3).map((r) => ({ request: r.request, summary: r.summary, ideas: r.ideas.map((i) => ({ title: i.title, why: i.why })) }));
    out.briefRules = CHAR_BRIEF_RULES;
  }
  if (c.step === "master") out.assembledPrompt = masterPrompt(p.brief);
  if (c.step === "edits") {
    // Compact: 40+ edits on a big brief. The keep sentence is given once; a made edit carries its prompt only when
    // it is not the starting one.
    out.keepSentence = KEEP.trim();
    out.clearSentence = KEEP_CLEAR.trim();
    out.edits = planEdits(p.brief).map((e) => {
      const im = latest.get(e.role);
      const current = im
        ? {
            id: im.id,
            status: im.status,
            url: im.url,
            ...(im.prompt && withoutKeep(im.prompt) !== withoutKeep(e.prompt) ? { prompt: clip(withoutKeep(im.prompt), 600) } : {}),
            ...(im.meta.align ? { align: im.meta.align } : {}),
            ...(im.error ? { error: clip(im.error, 300) } : {}),
          }
        : null;
      return { role: e.role, label: e.label, source: e.source, ...(c.roles.length && !c.roles.includes(e.role) ? { notAsked: true } : {}), current };
    });
    // One starting prompt per kind of edit (base, shape, zone): the others follow the same
    // pattern; char_run_edits with "roles" runs any role with its own starting prompt.
    out.startingPromptExamples = startingPromptExamples(p.brief);
    if (c.roles.length) out.what = `Only these roles were asked: ${c.roles.join(", ")}.`;
  }
  return out;
}

/** A progress line with pictures on the task (the editor watches it). */
async function progress(db: CtServiceClient, taskId: string, text: string, images: string[] = []): Promise<void> {
  const { data: task } = await db.from(CT_TABLES.agentTasks).select("*").eq("id", taskId).single<CtAgentTask>();
  if (!task) return;
  const line: CtAgentTaskProgress = { at: new Date().toISOString(), text, ...(images.length ? { images } : {}), kind: "run" };
  await patchTask(db, task.id, { status: liveStatus(task), progress: [...(task.progress ?? []), line].slice(-50) });
}

/** submit_result of a char task → the result row (throws a message the agent can act on). */
export async function submitCharResult(db: CtServiceClient, task: CtAgentTask, raw: Record<string, unknown>, summary: string): Promise<CtCharTaskResult> {
  const c = task.input.char!;
  const { project: p, images } = await charOf(db, task);
  const mine = images.filter((im) => im.meta.taskId === task.id);
  const running = mine.filter((im) => im.status === "running");
  if (running.length) throw new Error(`Not submitted — ${running.length} picture(s) of this task still being drawn: call char_wait with ${running.map((im) => im.id).join(", ")}, look at them, then submit.`);
  const ids = [...new Set((Array.isArray(raw.image_ids) ? raw.image_ids : Array.isArray(raw.imageIds) ? raw.imageIds : []).map(str).filter((x) => UUID.test(x)))];
  if (c.step === "brainstorm") {
    const round = ideaRoundFrom(raw, p, c.request);
    const { error } = await db.from(CT_TABLES.charProjects).update({ ideas: [...p.ideas, round].slice(-10) }).eq("id", p.id);
    if (error) throw new Error(error.message);
    // Each direction drawn once, so the editor sees it before choosing (a failed picture never fails the round).
    if (task.user_id) await drawIdeaPreviews(db, task.user_id, p, round).catch((e: Error) => console.warn("[ct] idea previews", e.message));
    return { step: c.step, summary, roundId: round.id };
  }
  if (c.step === "master") {
    const ok = new Set(images.filter((im) => im.kind === "master" && im.status === "done").map((im) => im.id));
    const bad = ids.filter((x) => !ok.has(x));
    if (bad.length) throw new Error(`Not submitted — not a finished master of this bộ: ${bad.join(", ")}`);
    if (!ids.length && !mine.some((im) => im.kind === "master" && im.status === "done")) throw new Error('Result needs "image_ids": the masters you recommend (make them with char_draw_masters / char_refine_master)');
    return { step: c.step, summary, imageIds: ids };
  }
  if (c.step === "chat" || c.step === "auto") {
    const ok = new Set(images.map((im) => im.id));
    return { step: c.step, summary, imageIds: ids.filter((x) => ok.has(x)) };
  }
  const editRows = images.filter((im) => im.kind === "edit");
  if (editRows.some((im) => im.status === "running")) throw new Error("Not submitted — edits of this bộ are still running: char_wait for them first.");
  return { step: c.step, summary, imageIds: ids.length ? ids : mine.filter((im) => im.kind === "edit" && im.status === "done").map((im) => im.id) };
}

function taskDb(ctx: CtMcpContext): CtServiceClient {
  if (!ctx.service) throw new Error("Tasks need the agent token");
  return ctx.service;
}

/** `set_id` of a tool: a version set of the task's set (a lineup drawn version by version — get_task set.versions). */
const SET_ARG = { set_id: { type: "string", description: "Optional: a VERSION SET of this task's set (get_task set.versions[].set_id) — the tool works on that version instead." } };

async function openCharTask(ctx: CtMcpContext, id: unknown, setId?: unknown): Promise<{ db: CtServiceClient; task: CtAgentTask; project: CtCharProject }> {
  const { db, task } = await loadTask(ctx, id);
  openTask(task);
  const { project } = await charOf(db, task);
  if (!task.user_id) throw new Error("The task has no owner");
  const sid = str(setId);
  if (sid) {
    const v = UUID.test(sid) ? await loadProject(db, sid) : null;
    if (!v || v.brief.versionOf?.id !== project.id) throw new Error("set_id is not a version set of this task's set — use get_task set.versions[].set_id");
    return { db: taskDb(ctx), task, project: projectRow(v) };
  }
  return { db: taskDb(ctx), task, project: projectRow(project) };
}

/** Every set of the task's lineup (the set + its version sets): pictures of any of them can be waited for. */
async function lineupIds(db: CtServiceClient, projectId: string): Promise<string[]> {
  const kids = await versionSetsOf(db, projectId);
  return [projectId, ...kids.map((k) => k.id)];
}

/** The version sets of a drawn lineup as get_task shows them: masters, 3b pictures, checks, files — compact. */
async function versionsView(db: CtServiceClient, p: CtCharProject): Promise<unknown[]> {
  if (!p.brief.lineup?.drawn && !p.brief.poses?.length) return [];
  const kids = await versionSetsOf(db, p.id);
  return Promise.all(
    kids.map(async (k) => {
      const images = await loadImages(db, k.id);
      const latest = latestEditsOf(images);
      return {
        set_id: k.id,
        ...(k.brief.versionOf?.pose ? { pose: k.brief.versionOf.pose, poseName: k.brief.versionOf.name } : { version: k.brief.versionOf?.name }),
        url: setUrl(k.id),
        status: k.status,
        subjects: k.brief.subjects.map((x) => x.name || x.description.split(/[,.;]/)[0]),
        approvedMasterId: k.master_id,
        masters: images.filter((im) => im.kind === "master").map((m) => ({ id: m.id, status: m.status, url: m.url, approved: m.id === k.master_id, ...(m.error ? { error: clip(m.error, 200) } : {}) })),
        masterAtPrintSize: k.cut?.matte ? { status: k.cut.matte.status, error: k.cut.matte.error } : null,
        // Compact (get_task of a big lineup passed 170 KB and the agent could not read it, 2026-10-19).
        edits: k.master_id
          ? planEdits(k.brief).map((e) => {
              const im = latest.get(e.role);
              return { role: e.role, status: im?.status ?? "missing", ...(im?.status === "done" ? { url: im.url } : {}), ...(im?.error ? { error: clip(im.error, 160) } : {}) };
            })
          : [],
        plan: k.cut?.plan ? { status: k.cut.plan.status, error: k.cut.plan.error, failedChecks: k.cut.plan.checks.filter((c) => !c.ok) } : null,
        layers: k.layers ? { status: k.layers.status, error: k.layers.error, files: k.layers.slots.reduce((n, sl) => n + sl.files.length, 0) } : null,
      };
    }),
  );
}

const SITE = siteUrl;
/** The set's page, for the people following along (the agent prints it in its session). */
const setUrl = (id: string) => `${SITE()}/v2/${id}`;

/** Who owns a set made from agent_ide: the email asked for, else the first admin. */
async function ownerFor(db: CtServiceClient, email: string): Promise<string> {
  if (email) {
    const { data } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
    const u = data?.users.find((x) => x.email?.toLowerCase() === email.toLowerCase());
    if (!u) throw new Error(`No FlexiPrint user ${email}`);
    return u.id;
  }
  const { data } = await db.from("user_profiles").select("user_id").eq("role", "admin").order("created_at").limit(1).maybeSingle<{ user_id: string }>();
  if (!data?.user_id) throw new Error("No admin user — pass owner_email");
  return data.user_id;
}

/** A chat task the agent opens for itself (it is already in its agent_ide session: no turn is sent). */
async function selfTask(db: CtServiceClient, userId: string, projectId: string, request: string): Promise<CtAgentTask> {
  const { data, error } = await db
    .from(CT_TABLES.agentTasks)
    .insert({
      user_id: userId,
      kind: "char",
      status: "running",
      input: { category: { id: null, name: "", spec: "", rules: {} }, note: "", images: [], refUrls: [], char: { projectId, step: "chat", request: clip(request, 20000), imageId: null, roles: [], tab: "brief", section: "", attachments: [] } },
    })
    .select("*")
    .single<CtAgentTask>();
  if (error || !data) throw new Error(error?.message ?? "Could not open a task");
  return data;
}

export const CT_MCP_CHAR_TOOLS: CtMcpTool[] = [
  {
    name: "char_draw_poses",
    description:
      "A set whose characters are drawn alone, pose by pose (brief.poses — every set with 2+ characters since 2026-10-21): makes a POSE SET per pose (one character alone on its own square: masters, doll, 3b pictures and files of its own; the parent's references copied in) and draws 2 masters for each. Missing ones only — a pose that has a set keeps it (redraw its masters: char_draw_masters with set_id). → the pose sets; view_image their masters (char_wait with the ids), approve one per pose (char_approve_master {set_id, image_id}) — each then runs 3a → 3b → 3c by itself.",
    inputSchema: { type: "object", properties: { ...TASK_ARG }, required: ["task_id"] },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id);
      if (task.input.char?.step !== "chat" && task.input.char?.step !== "auto" && task.input.char?.step !== "master") throw new Error("char_draw_poses is for chat requests");
      const sets = await startPoseSets(db, task.user_id!, project);
      const all = await Promise.all(sets.map(async (k) => ({ set_id: k.id, pose: k.brief.versionOf?.pose, name: k.brief.versionOf?.name, url: setUrl(k.id), masters: (await loadImages(db, k.id)).filter((im) => im.kind === "master").map((m) => ({ id: m.id, status: m.status })) })));
      await progress(db, task.id, `Đang vẽ master cho ${sets.length} dáng: ${sets.map((k) => k.brief.versionOf?.name).join(", ")}`);
      return json({ poses: all, next: "char_wait with each pose's master ids (set_id on char_wait is not needed — ids are enough), view_image, then char_approve_master {task_id, set_id, image_id} per pose." });
    },
  },
  {
    name: "char_compose",
    description:
      "A set drawn pose by pose: how each version of the product places its characters, to look like the sample. versions: [{name (the version's customer name — get_task set.composeVersions lists them with their subjects), people: [{subject (brief subject id), x (the figure's centre), y (its bottom — the cut line / feet), h (its height), flip? (mirrored; default = the pose's mirrored list)}]}] — any units, the same within a version and across versions (the grandma h 1, the children 0.8 …); people back → front (a later one is drawn over an earlier one where they overlap — the grandma first when the children lean on her, the inner children over the outer ones…; where only PART of a front character must go behind — a drooping hat tail over the neighbour's face — char_set_behind). The server fits each version's whole group into the piece's characters area (the sign under it). Saved in brief.compose, then the product is rebuilt in the background (2–4 min, char_status shows the new product id) → render_artwork mode print for each version, compare with the sample, call again until it reads like it.",
    inputSchema: {
      type: "object",
      properties: {
        ...TASK_ARG,
        versions: { type: "array", items: { type: "object" }, description: "[{name, people: [{subject, x, y, h, flip?}]}] — every version, back → front." },
      },
      required: ["task_id", "versions"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id);
      if (task.input.char?.step !== "chat" && task.input.char?.step !== "auto") throw new Error("char_compose is for chat requests");
      if (!project.brief.poses?.length) throw new Error("This set is not drawn pose by pose (brief.poses)");
      const compose = parseCharBrief({ ...project.brief, compose: args.versions }).compose ?? [];
      const wanted = charVersions(project.brief);
      const problems: string[] = [];
      for (const v of wanted) {
        const c = compose.find((x) => x.name === v.name);
        const ids = v.subjects.map((i) => project.brief.subjects[i].id);
        if (!c) problems.push(`version "${v.name}" is missing (subjects ${ids.join(", ")})`);
        else if (c.people.length !== ids.length || !ids.every((id) => c.people.some((x) => x.subject === id))) problems.push(`version "${v.name}" must place exactly ${ids.join(", ")}`);
      }
      if (problems.length) throw new Error(problems.join(" · "));
      const brief = { ...project.brief, compose };
      const { error } = await db.from(CT_TABLES.charProjects).update({ brief }).eq("id", project.id);
      if (error) throw new Error(error.message);
      void remakeDrawnProduct(db, task.user_id!, project.id).catch((e: Error) => console.warn("[ct] composed product", e.message));
      await progress(db, task.id, `Đã ghép ${compose.length} phiên bản — đang dựng lại sản phẩm`);
      return json({ saved: compose.length, next: "The product is rebuilt in the background once every pose set is cut (2–4 min): char_status until productIds change, then render_artwork mode print for each version ({\"<lineup label>\": \"<version>\"})." });
    },
  },
  {
    name: "char_set_behind",
    description:
      "A set drawn pose by pose: put PART of a pose's DOLL behind every other character (\"phần nằm sau\") — e.g. the tail of an inner grandchild's Santa hat that lies over the outer grandchild's face (in the sample it goes behind them). Inside the area the whole doll (every layer, in its own order) goes behind the neighbouring dolls — never behind its own body. set_id = the POSE set (get_task set.versions[].set_id), polygons = [[[x, y], …], …] in shares (0–1) of the pose's square canvas, drawn on the UNMIRRORED pose picture (mirrored characters get it mirrored); [] clears it. One area per pose, for every option and every character in that pose. The parent's product is rebuilt in the background (2–4 min) → render_artwork to check, then remake the mockups. The editor can draw the same thing by hand (Đưa 1 phần ra sau, on the whole artwork).",
    inputSchema: {
      type: "object",
      properties: {
        ...TASK_ARG,
        set_id: { type: "string", description: "The pose set (get_task set.versions[].set_id)." },
        polygons: { type: "array", items: { type: "array" }, description: "[[[x, y], …], …] shares of the pose canvas; [] = none." },
      },
      required: ["task_id", "set_id", "polygons"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id, args.set_id);
      if (!project.layers) throw new Error("The pose set is not cut yet");
      const polygons = Array.isArray(args.polygons) ? (args.polygons as unknown[]).filter(Array.isArray).map((pg) => (pg as unknown[]).filter((pt): pt is number[] => Array.isArray(pt) && pt.length === 2 && pt.every((v) => typeof v === "number"))) : [];
      const mask = polygons.length ? await polygonMask(project.layers, polygons) : null;
      const next = await setBehind(db, task.user_id!, project, "", mask);
      await progress(db, task.id, `${mask ? "Đặt" : "Bỏ"} phần nằm sau của dáng ${project.brief.versionOf?.name ?? ""} — đang dựng lại sản phẩm`);
      return json({ behindUrl: next.layers?.behindUrl ?? null, next: "The parent's product is rebuilt in the background (2–4 min): char_status until productIds change, then render_artwork each version and check the part lies behind the neighbour, then the mockups again." });
    },
  },
  {
    name: "char_versions",
    description:
      "A lineup drawn version by version (brief.lineup.drawn): every VERSION SET of the task's set — set_id, version name, subjects, masters (id, url, approved), 3a / 3b / 3c status and failed checks — small (get_task carries the whole set and can be too big to read). Use the set_id with char_approve_master / char_run_edits / char_cut / char_status.",
    inputSchema: { type: "object", properties: { ...TASK_ARG }, required: ["task_id"] },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, project } = await openCharTask(ctx, args.task_id);
      if (!project.brief.lineup?.drawn && !project.brief.poses?.length) return json({ versions: [], note: "This set is not drawn version by version nor pose by pose." });
      return json({ versions: await versionsView(db, project) });
    },
  },
  {
    name: "char_create_set",
    description:
      "agent_ide (someone chats with @flexiprint directly, not from the /v2 page): make a NEW bộ (set) — character (characters AI draws, the customer dresses them) or photo (the customer's photo is the hero). Opens a chat task on it for you (task_id: use it with every char_* tool, submit_result when the request is done) and returns the set's page url: PRINT IT for the people following. Then char_add_reference for the pictures they gave you, char_update_brief, char_draw_masters…",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Vietnamese set name: 'Ornament bà + 1–4 cháu — acrylic trong'." },
        kind: { type: "string", description: "character (default) | photo" },
        idea: { type: "string", description: "What they asked for, in their words." },
        owner_email: { type: "string", description: "FlexiPrint account that owns it (default: the admin)." },
      },
      required: ["name"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const db = taskDb(ctx);
      const owner = await ownerFor(db, str(args.owner_email));
      const brief = parseCharBrief({ kind: args.kind === "photo" ? "photo" : "character", idea: clip(str(args.idea), 4000) });
      const { data: p, error } = await db.from(CT_TABLES.charProjects).insert({ user_id: owner, name: clip(str(args.name), 200) || "Bộ mới", brief }).select("*").single<CtCharProject>();
      if (error || !p) throw new Error(error?.message ?? "Could not create the set");
      const task = await selfTask(db, owner, p.id, str(args.idea) || str(args.name));
      return json({ project_id: p.id, task_id: task.id, url: setUrl(p.id), next: "Print the url. Follow flexiprint://guide/whole-set. char_add_reference (their pictures) → char_update_brief → get_task → char_draw_masters." });
    },
  },
  {
    name: "char_open_task",
    description: "agent_ide: a new chat task on an EXISTING set (set id or its /v2 url) to work on it from your session — returns task_id and the page url (print it). One per request / phase; submit_result when it is done.",
    inputSchema: { type: "object", properties: { project: { type: "string", description: "Set id or its page url (…/v2/<id>)." }, request: { type: "string", description: "What you are asked (their words)." } }, required: ["project"] },
    callers: ["agent"],
    run: async (ctx, args) => {
      const db = taskDb(ctx);
      const id = (str(args.project).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) ?? [""])[0];
      const p = id ? await loadProject(db, id) : null;
      if (!p) throw new Error("No such set");
      const task = await selfTask(db, p.user_id ?? (await ownerFor(db, "")), p.id, str(args.request) || "(agent_ide)");
      return json({ project_id: p.id, task_id: task.id, url: setUrl(p.id), status: p.status });
    },
  },
  {
    name: "char_add_reference",
    description:
      "Put a picture into the set's brief as a reference (a sample product the editor wants something like, a style, a character…): from a public url, or the picture's bytes as base64 (a file they dropped in the agent_ide chat — read it and pass it). → the reference id (already in brief.refs with use + note).",
    inputSchema: {
      type: "object",
      properties: {
        ...TASK_ARG,
        url: { type: "string", description: "Public http(s) url of the picture." },
        image_base64: { type: "string", description: "PNG / JPEG / WebP bytes, base64 (no data: prefix needed)." },
        use: { type: "string", description: "sample | style | character | outfit | pose | product | avoid (default sample)." },
        note: { type: "string", description: "Vietnamese: what to take from it (their words)." },
      },
      required: ["task_id"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id);
      let buf: Buffer;
      if (str(args.image_base64)) buf = Buffer.from(str(args.image_base64).replace(/^data:[^,]+,/, ""), "base64");
      else if (/^https?:\/\//.test(str(args.url))) {
        const r = await fetch(str(args.url), { signal: AbortSignal.timeout(60_000) });
        if (!r.ok) throw new Error(`Could not fetch the picture (${r.status})`);
        buf = Buffer.from(await r.arrayBuffer());
      } else throw new Error("Give url or image_base64");
      if (buf.length < 100 || buf.length > 25 * 1024 * 1024) throw new Error("Not a picture (or over 25 MB)");
      const saved = await saveCharFile(project.user_id ?? task.user_id!, project.id, "ref", buf);
      const { data: im, error } = await db.from(CT_TABLES.charImages).insert({ project_id: project.id, user_id: project.user_id ?? task.user_id, kind: "ref", role: "ref", status: "done", ...saved }).select("*").single<CtCharImage>();
      if (error || !im) throw new Error(error?.message ?? "Could not save");
      const use = REF_USES.includes(str(args.use) as CtCharRefUse) ? (str(args.use) as CtCharRefUse) : "sample";
      const brief = parseCharBrief({ ...project.brief, refs: [...project.brief.refs, { id: im.id, use, note: clip(str(args.note), 600) }] });
      const { error: e2 } = await db.from(CT_TABLES.charProjects).update({ brief }).eq("id", project.id);
      if (e2) throw new Error(e2.message);
      return json({ ref_id: im.id, url: im.url, use });
    },
  },
  {
    name: "char_draw_masters",
    description:
      "Bộ nhân vật (char task, step master): draw master candidates from YOUR prompt with the team's image model (~30–60 s each, in the background). Returns their ids at once — then char_wait, then view_image. The style reference picture of the brief (if any) is sent with it automatically.",
    inputSchema: {
      type: "object",
      properties: {
        ...TASK_ARG,
        ...SET_ARG,
        prompt: { type: "string", description: "The full English master prompt." },
        count: { type: "number", description: "1–4 candidates (default 2)." },
      },
      required: ["task_id", "prompt"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id, args.set_id);
      if (task.input.char?.step !== "master" && task.input.char?.step !== "chat" && !(task.input.char?.step === "auto" && project.brief.versionOf)) throw new Error("char_draw_masters is for the master step");
      const prompt = clip(str(args.prompt), 8000);
      if (!prompt) throw new Error("prompt is required");
      if (project.brief.poses?.length) throw new Error("This set's characters are drawn pose by pose: char_draw_poses (first time), or char_draw_masters with set_id = a pose set (char_versions) to redraw that pose's masters");
      const rows = await drawMasters(db, task.user_id!, project, { prompt, count: Number(args.count) || 2, taskId: task.id });
      await progress(db, task.id, `Đang vẽ ${rows.length} master`);
      return json({ image_ids: rows.map((r) => r.id), next: "char_wait with these ids, then view_image." });
    },
  },
  {
    name: "char_refine_master",
    description:
      "Bộ nhân vật (step master): an IN-PLACE edit of one master candidate — your prompt says the one change; a sentence keeping everything else (same characters, pose, framing, transparent background) is appended. Returns the new candidate's id → char_wait.",
    inputSchema: {
      type: "object",
      properties: {
        ...TASK_ARG,
        ...SET_ARG,
        image_id: { type: "string", description: "The master to edit (id from get_task masters or char_wait)." },
        prompt: { type: "string", description: "English: exactly what to change." },
        note: { type: "string", description: "Vietnamese, short: what you changed (shown under the picture)." },
      },
      required: ["task_id", "image_id", "prompt"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id, args.set_id);
      if (task.input.char?.step !== "master" && task.input.char?.step !== "chat" && !(task.input.char?.step === "auto" && project.brief.versionOf)) throw new Error("char_refine_master is for the master step");
      const change = clip(str(args.prompt), 4000);
      if (!change) throw new Error("prompt is required");
      const row = await refineMasterImage(db, task.user_id!, project, str(args.image_id), change.replace(/\.?$/, ".") + KEEP_REFINE, clip(str(args.note), 300) || clip(change, 300), task.id);
      await progress(db, task.id, `Đang sửa master: ${clip(str(args.note) || change, 160)}`);
      return json({ image_id: row.id, next: "char_wait, then view_image." });
    },
  },
  {
    name: "char_run_edits",
    description:
      "Bộ nhân vật (step edits): run in-place edits of the approved master with YOUR prompt per role (roles from get_task \"edits\"). Roles you give a prompt for are (re)made; \a redone picture redoes everything made from it; \"work\" is a copy (no prompt). Runs in the background — char_wait with the returned ids.",
    inputSchema: {
      type: "object",
      properties: {
        ...TASK_ARG,
        ...SET_ARG,
        prompts: { type: "object", description: "{ role: English prompt } — e.g. {\"base\": \"…\", \"shape:<slot>:<option>\": \"…\"}." },
        roles: { type: "array", items: { type: "string" }, description: "Extra roles to (re)make with their last / starting prompt (optional)." },
      },
      required: ["task_id"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id, args.set_id);
      if (!["edits", "chat", "auto"].includes(task.input.char?.step ?? "")) throw new Error("char_run_edits is for the edits step");
      if (!project.master_id) throw new Error("No approved master yet — the editor approves one first");
      // A new set's 3b pictures are planned by the agent (asked 2026-10-19), not by the built-in rules.
      if (!project.brief.pictures?.length && !project.brief.versionOf && !(await loadImages(db, project.id)).some((im) => im.kind === "edit" && im.role !== "work"))
        throw new Error("Plan the 3b pictures first: char_plan_pictures (get_task picturePlan.rules)");
      const plan = planEdits(project.brief);
      const prompts: Record<string, string> = {};
      for (const [role, v] of Object.entries(record(args.prompts))) {
        if (!plan.some((e) => e.role === role)) throw new Error(`Unknown role "${role}" — use the roles of get_task "edits"`);
        if (role !== "work" && str(v).trim()) prompts[role] = withTail(clip(str(v), 7600), tailOf(role));
      }
      const extra = (Array.isArray(args.roles) ? args.roles : []).map(str).filter((r) => plan.some((e) => e.role === r));
      const roles = [...new Set([...Object.keys(prompts), ...extra])];
      if (!roles.length) throw new Error("Give prompts {role: prompt} (or roles) to run");
      const rows = await runEditRoles(db, task.user_id!, project, { roles, prompts, taskId: task.id });
      await progress(db, task.id, `Đang chạy ${rows.length} bản sửa: ${rows.map((r) => r.note || r.role).slice(0, 8).join(", ")}${rows.length > 8 ? "…" : ""}`);
      return json({ started: rows.map((r) => ({ image_id: r.id, role: r.role })), next: "char_wait with these ids (the pictures others are drawn from finish first), then view_image." });
    },
  },
  {
    name: "char_plan_pictures",
    description:
      "Bộ nhân vật: YOUR plan of the 3b pictures the clipart files are cut from — which pictures exist, what each is drawn from, says and draws (rules: get_task picturePlan.rules). Checked against the brief (every option drawn once, sources exist, no loop), then saved as brief.pictures; a lineup's version sets follow it. → what must be drawn (new / changed prompt) → char_run_edits {roles}.",
    inputSchema: {
      type: "object",
      properties: {
        ...TASK_ARG,
        ...SET_ARG,
        pictures: {
          type: "array",
          items: { type: "object" },
          description:
            "[{role, label (Vietnamese), source (\"work\" for base, else a role), prompt (English, no ending sentence), lines?: [{subject: subject id, text: \"{who}: …\"}], covers: [{slot: slot id, option: option id}], against?: role, fine?: true}] — base (the doll) and zone:<id> per photo zone required.",
        },
        dry_run: { type: "boolean", description: "Only check it (nothing saved)." },
      },
      required: ["task_id", "pictures"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id, args.set_id);
      if (!["edits", "chat", "auto"].includes(task.input.char?.step ?? "")) throw new Error("char_plan_pictures is for chat / auto / edits requests");
      if (project.brief.kind === "photo") throw new Error("A bộ ảnh khách has no 3b pictures (char_draw_elements)");
      if (project.layers?.status === "building") throw new Error("The set is being cut — char_status, then plan again");
      const pictures = parsePictures(args.pictures);
      if (!pictures) throw new Error("pictures: a non-empty array of pictures");
      const errors = checkPictures(project.brief, pictures);
      if (errors.length) throw new Error(`Plan not saved:\n- ${errors.join("\n- ")}`);
      const of = project.brief.versionOf;
      const brief = { ...project.brief, pictures, ...(of ? { versionOf: { ...of, ownPictures: true } } : {}) };
      const edits = planEdits(brief).filter((e) => e.role !== "work");
      const latest = latestEditsOf(await loadImages(db, project.id));
      // To draw: never drawn, failed, or asked differently now (its prompt or source changed).
      const toDraw = edits.filter((e) => {
        const im = latest.get(e.role);
        return !im || im.status === "failed" || (im.status === "done" && (im.prompt !== e.prompt || (im.meta as { sourceId?: string }).sourceId !== latest.get(e.source)?.id)) ;
      });
      if (args.dry_run !== true) {
        const { error } = await db.from(CT_TABLES.charProjects).update({ brief }).eq("id", project.id);
        if (error) throw new Error(error.message);
        if (!of) for (const k of await versionSetsOf(db, project.id)) await followParentPlan(db, k).catch((e: Error) => console.warn("[ct] version plan", e.message));
        await progress(db, task.id, `Kế hoạch 3b: ${pictures.length} ảnh, ${optionPictures(brief).length} file — ${toDraw.length} ảnh cần vẽ`);
      }
      return json({
        saved: args.dry_run !== true,
        pictures: pictures.length,
        files: optionPictures(brief).length,
        toDraw: toDraw.map((e) => e.role),
        next: toDraw.length ? "char_run_edits {task_id, roles: toDraw} → char_wait → view_image each, then char_cut \"plan\"." : "Nothing new to draw — char_cut \"plan\" if the plan changed what is cut against what.",
      });
    },
  },
  {
    name: "char_wait",
    description: "Wait for pictures of a bộ nhân vật to finish (the server waits up to ~1 min per call) → each one's status, url, prompt, registration. \"still running\" → call again.",
    inputSchema: { type: "object", properties: { ...TASK_ARG, image_ids: { type: "array", items: { type: "string" }, description: "Ids from char_draw_masters / char_refine_master / char_run_edits." } }, required: ["task_id", "image_ids"] },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task } = await loadTask(ctx, args.task_id);
      const ids = (Array.isArray(args.image_ids) ? args.image_ids : [args.image_ids]).map(str).filter((x) => UUID.test(x)).slice(0, 40);
      if (!ids.length) throw new Error("image_ids is required");
      const sets = await lineupIds(db, task.input.char?.projectId ?? "");
      const read = async () => (await db.from(CT_TABLES.charImages).select("*").in("id", ids).in("project_id", sets).returns<CtCharImage[]>()).data ?? [];
      const deadline = Date.now() + WAIT_MS;
      let rows = await read();
      const was = new Map(rows.map((r) => [r.id, r.status]));
      while (rows.some((r) => r.status === "running") && Date.now() + POLL_MS < deadline) {
        await sleep(POLL_MS);
        rows = await read();
      }
      const fresh = rows.filter((r) => r.status === "done" && was.get(r.id) === "running");
      if (fresh.length) await progress(db, task.id, `Xong ${fresh.length} ảnh`, fresh.map((r) => r.thumb_url || r.url));
      const failed = rows.filter((r) => r.status === "failed" && was.get(r.id) === "running");
      if (failed.length) await progress(db, task.id, `Lỗi ${failed.length} ảnh: ${clip(failed[0].error, 200)}`);
      const still = rows.filter((r) => r.status === "running").length;
      return json({
        pictures: rows.map((r) => ({ ...picture(r), role: r.role })),
        ...(still ? { message: `${still} still running — call char_wait again.` } : { next: "Look at them with view_image (url) before you judge." }),
      });
    },
  },
  {
    name: "char_get_brief",
    description: "Bộ nhân vật: just the set's brief (CtCharBrief JSON) — small, unlike get_task which carries the whole set. Read it before char_update_brief.",
    inputSchema: { type: "object", properties: { ...TASK_ARG, ...SET_ARG }, required: ["task_id"] },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { project } = await openCharTask(ctx, args.task_id, args.set_id);
      return json({ brief: project.brief, masterApproved: !!project.master_id });
    },
  },
  {
    name: "char_update_brief",
    description:
      "Bộ nhân vật (chat): save the brief — either `brief` (the whole CtCharBrief) or `patch` (only the top-level keys you change, e.g. {subjects, choosers, texts}: each replaces that key of the current brief, the rest stays; char_get_brief to read it). After a master is approved only additions are allowed — a new option / colour / slot / photo zone; existing ids and every slot's first option stay.",
    inputSchema: {
      type: "object",
      properties: { ...TASK_ARG, brief: { type: "object", description: "The full CtCharBrief." }, patch: { type: "object", description: "Top-level keys of CtCharBrief to replace." } },
      required: ["task_id"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id);
      if (task.input.char?.step !== "chat" && task.input.char?.step !== "auto") throw new Error("char_update_brief is for chat requests");
      const patch = record(args.patch);
      const whole = record(args.brief);
      if (!Object.keys(patch).length && !Object.keys(whole).length) throw new Error("char_update_brief: give `brief` or `patch`");
      const next = Object.keys(whole).length ? whole : { ...project.brief, ...patch };
      // The references are char_add_reference's: a whole brief written without them keeps them (2026-10-19: one dropped
      // the sample picture just added, and the masters were drawn without it).
      if (!Array.isArray(next.refs) || !next.refs.length) next.refs = project.brief.refs;
      // The 3b plan is char_plan_pictures': a brief written without it keeps it.
      if (next.pictures === undefined) next.pictures = project.brief.pictures ?? null;
      // Fields the parser drops silently: say what shape they take (the agent tried "lineup" five ways, 2026-10-18).
      const lu = record(next.lineup);
      if (next.lineup != null && lu.mode !== "one" && lu.mode !== "count") throw new Error('lineup must be {"mode": "one" | "count", "label": "Number of Grandchildren"} (or null)');
      if (next.framing != null && next.framing !== "full" && next.framing !== "bust") throw new Error('framing must be "full" or "bust"');
      // A khuôn in named by templateId fills the cut, size and layout sentence like the page does.
      const brief = await withTemplateProduct(db, parseCharBrief(next));
      if (project.master_id) {
        const lost = briefLosses(project.brief, brief);
        if (lost.length) throw new Error(`Master approved — only additions: ${lost.join("; ")}`);
      }
      const { error } = await db.from(CT_TABLES.charProjects).update({ brief }).eq("id", project.id);
      if (error) throw new Error(error.message);
      await progress(db, task.id, "Đã sửa brief");
      return json({ ok: true, next: project.master_id ? "New option → char_run_edits for its role (get_task again for the role list), then char_cut." : "Done." });
    },
  },
  {
    name: "char_cut",
    description:
      "Bộ nhân vật (chat): \"plan\" = find every 3c region again from the 3b pictures, then cut the files; \"build\" = cut the files from the current regions and remake the product. Runs in the background → char_status.",
    inputSchema: { type: "object", properties: { ...TASK_ARG,
        ...SET_ARG, what: { type: "string", description: "\"plan\" or \"build\"." } }, required: ["task_id", "what"] },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id, args.set_id);
      if (task.input.char?.step !== "chat" && task.input.char?.step !== "auto") throw new Error("char_cut is for chat requests");
      if (str(args.what) !== "plan" && str(args.what) !== "build") throw new Error('char_cut: "what" must be "plan" or "build"');
      if (str(args.what) === "plan") await startPlan(db, task.user_id!, project, true);
      else await startBuild(db, task.user_id!, project, project.cut?.plan ? { ...project.cut, plan: { ...project.cut.plan, approved: true } } : undefined, true);
      await progress(db, task.id, str(args.what) === "plan" ? "Đang tìm lại vùng 3c và cắt file" : "Đang cắt lại file layer");
      return json({ next: "char_status (it waits)." });
    },
  },
  {
    name: "char_status",
    description: "Bộ nhân vật (chat): wait (up to ~1 min) for the 3c regions / the layer cut to finish → their status, checks and the layer files.",
    inputSchema: { type: "object", properties: { ...TASK_ARG, ...SET_ARG }, required: ["task_id"] },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task } = await loadTask(ctx, args.task_id);
      const sid = str(args.set_id);
      const sets = sid ? await lineupIds(db, task.input.char?.projectId ?? "") : [];
      if (sid && !sets.includes(sid)) throw new Error("set_id is not a version set of this task's set");
      const id = sid || (task.input.char?.projectId ?? "");
      const busy = (p: CtCharProject) => p.cut?.matte?.status === "running" || p.cut?.plan?.status === "running" || p.layers?.status === "building";
      const deadline = Date.now() + WAIT_MS;
      let p = await loadProject(db, id);
      if (p) p = await failLostPlan(db, p);
      while (p && busy(p) && Date.now() + POLL_MS < deadline) {
        await sleep(POLL_MS);
        p = await loadProject(db, id);
      }
      if (!p) throw new Error("The bộ nhân vật no longer exists");
      return json({
        running: busy(p),
        plan: p.cut?.plan ? { status: p.cut.plan.status, error: p.cut.plan.error, failedChecks: p.cut.plan.checks.filter((c) => !c.ok) } : null,
        layers: p.layers
          ? // Compact: a lineup of 9 hair slots × 6 files made it too big to read — the product id went unseen (2026-10-19).
            { status: p.layers.status, error: p.layers.error, failedChecks: p.layers.checks.filter((c) => !c.ok), files: p.layers.slots.reduce((n, sl) => n + sl.files.length, 0), slots: p.layers.slots.map((sl) => `${sl.key} (${sl.files.length})`) }
          : null,
        productIds: p.product_ids,
        ...(p.brief.versionOf ? { lineupProductIds: (await loadProject(db, p.brief.versionOf.id))?.product_ids ?? [] } : {}),
        ...(busy(p) ? { message: "Still running — call char_status again." } : {}),
      });
    },
  },
  {
    name: "char_use_edit",
    description:
      "Bộ nhân vật (chat / auto): go back to an EARLIER attempt of a 3b picture (asked 2026-10-30: a redraw that came out worse replaced the better one). image_id = an attempt of that role from char_run_edits / char_wait. It becomes the picture the role uses; the pictures drawn from that role are listed in \"redraw\" — run them again (char_run_edits roles) so they lie on it, then char_cut \"plan\".",
    inputSchema: { type: "object", properties: { ...TASK_ARG, ...SET_ARG, image_id: { type: "string", description: "The earlier attempt (a 3b picture of the set, status done)." } }, required: ["task_id", "image_id"] },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id, args.set_id);
      if (!["edits", "chat", "auto"].includes(task.input.char?.step ?? "")) throw new Error("char_use_edit is for the edits, chat and auto steps");
      if (project.layers?.status === "building") throw new Error("Đang cắt layer — chờ xong");
      const id = str(args.image_id);
      if (!UUID.test(id)) throw new Error("image_id is not a valid id");
      const images = await loadImages(db, project.id);
      const im = images.find((x) => x.id === id);
      if (!im || im.kind !== "edit" || im.role === "work") throw new Error("image_id is not a 3b picture of this set");
      if (im.status !== "done") throw new Error(`That attempt is ${im.status}, not done`);
      // The role uses its newest picture (latestEditsOf), so the attempt is made the newest.
      const { error } = await db.from(CT_TABLES.charImages).update({ created_at: new Date().toISOString() }).eq("id", id);
      if (error) throw new Error(error.message);
      const plan = planEdits(project.brief);
      const redraw = new Set<string>();
      for (let grew = true; grew; ) {
        grew = false;
        for (const e of plan)
          if (!redraw.has(e.role) && (e.source === im.role || redraw.has(e.source))) {
            redraw.add(e.role);
            grew = true;
          }
      }
      await progress(db, task.id, `Dùng lại bản trước của ${im.note || im.role}`);
      return json({ ok: true, role: im.role, redraw: [...redraw], next: redraw.size ? "char_run_edits {roles: redraw} → char_wait → view_image, then char_cut \"plan\"." : "char_cut \"plan\"." });
    },
  },
  {
    name: "char_approve_master",
    description:
      "Bộ nhân vật (chat): approve a finished master — ONLY when the editor's request hands you the whole set (they said to do everything / approve yourself). Starts the master at print size (3a); then char_run_edits for the 3b pictures, char_cut(\"plan\") and char_cut(\"build\").",
    inputSchema: { type: "object", properties: { ...TASK_ARG,
        ...SET_ARG, image_id: { type: "string", description: "The master (set.masters / char_wait)." } }, required: ["task_id", "image_id"] },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id, args.set_id);
      // A version set's master is the agent's to pick in the auto step too (the editor approved the whole set's).
      if (task.input.char?.step !== "chat" && !(task.input.char?.step === "auto" && project.brief.versionOf)) throw new Error("char_approve_master is for chat requests");
      const id = str(args.image_id);
      if (!UUID.test(id)) throw new Error("image_id is not a valid id");
      const p = await setApprovedMaster(db, project, id);
      if (p.brief.versionOf) {
        void runVersionChain(db, task.user_id!, p.id);
        await progress(db, task.id, `Đã duyệt master ${p.brief.versionOf.pose ? "dáng" : "phiên bản"} ${p.brief.versionOf.name} — server tự làm 3a → 3b → 3c`);
        return json({ ok: true, next: "The server runs 3a → 3b → 3c for this version on its own (minutes). get_task set.versions shows its pictures: view_image each 3b picture; a wrong one → char_run_edits {set_id, prompts} then char_cut {set_id, what: plan}." });
      }
      if (p.brief.kind === "photo") {
        await progress(db, task.id, "Đã duyệt master");
        return json({ ok: true, next: "char_draw_backdrops (if brief.backdrops), then char_draw_elements." });
      }
      await startMatte(db, task.user_id!, p);
      if (p.brief.lineup?.drawn) await startVersionSets(db, task.user_id!, p);
      await progress(db, task.id, p.brief.lineup?.drawn ? "Đã duyệt master, đang làm master cỡ in (3a) + vẽ master từng phiên bản" : "Đã duyệt master, đang làm master cỡ in (3a)");
      return json({ ok: true, next: "char_status waits for 3a; then char_run_edits (roles from get_task set.edits — get_task again now that a master is approved)." });
    },
  },
  {
    name: "char_draw_backdrops",
    description:
      "Bộ nhân vật (chat, step 4): draw the backgrounds of brief.backdrops with the team's image model (the whole piece, behind the characters; ~1 min each, in the background). prompts {backdrop id: English prompt} replaces a starting prompt; ids = only these (default: all). → image ids for char_wait; then char_remake_product.",
    inputSchema: {
      type: "object",
      properties: {
        ...TASK_ARG,
        ids: { type: "array", items: { type: "string" }, description: "brief.backdrops ids (empty = all)." },
        prompts: { type: "object", description: "{ backdrop id: full English prompt } (optional)." },
      },
      required: ["task_id"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id);
      if (task.input.char?.step !== "chat" && task.input.char?.step !== "auto") throw new Error("char_draw_backdrops is for chat requests");
      const prompts = Object.fromEntries(Object.entries(record(args.prompts)).map(([k, v]) => [k, clip(str(v), 4000)]).filter(([, v]) => v));
      const ids = (Array.isArray(args.ids) ? args.ids : []).map(str).filter(Boolean);
      const rows = await startBackdrops(db, task.user_id!, project, { ids, prompts, taskId: task.id });
      await progress(db, task.id, `Đang vẽ ${rows.length} nền: ${rows.map((r) => r.note.replace(/^Nền — /, "")).join(", ")}`);
      return json({ image_ids: rows.map((r) => r.id), next: "char_wait, view_image each; then char_remake_product." });
    },
  },
  {
    name: "char_draw_elements",
    description:
      "After the master is approved (a bộ ảnh khách, or a bộ nhân vật's decorations): draw the decorations of brief.elements — each option ALONE on transparency in the master's look (perBackdrop ones: one per background, needs the backgrounds drawn first; colour options are recoloured from the first) — and each photo zone's sample (role \"sample:<zone id>\": the master's pet alone). roles / prompts {role: English prompt} = only these (roles in get_task set.elementPictures); none = every missing one. ~1 min each, in the background → image ids for char_wait.",
    inputSchema: {
      type: "object",
      properties: {
        ...TASK_ARG,
        roles: { type: "array", items: { type: "string" }, description: "\"el:<element id>:<option id>\", \"el:<element id>:bd:<backdrop id>\", \"sample:<zone id>\" (bộ ảnh khách only) (empty = every missing one)." },
        prompts: { type: "object", description: "{ role: full English prompt } (optional)." },
      },
      required: ["task_id"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id);
      if (task.input.char?.step !== "chat" && task.input.char?.step !== "auto") throw new Error("char_draw_elements is for chat requests");
      const prompts = Object.fromEntries(Object.entries(record(args.prompts)).map(([k, v]) => [k, clip(str(v), 4000)]).filter(([, v]) => v));
      const roles = (Array.isArray(args.roles) ? args.roles : []).map(str).filter(Boolean);
      const rows = await startElements(db, task.user_id!, project, { roles, prompts, taskId: task.id });
      await progress(db, task.id, `Đang vẽ ${rows.length} phần tử: ${rows.map((r) => r.note).slice(0, 8).join(", ")}`);
      return json({ image_ids: rows.map((r) => r.id), next: "char_wait, view_image each (colour options appear after their first is done); then char_remake_product." });
    },
  },
  {
    name: "char_make_blank",
    description:
      "Bộ nhân vật / bộ ảnh khách (chat / auto, step 4): draw the phôi trơn (the blank piece, no print) of brief.product with the team's image model — from the khuôn's outline / hole / size and brief.product.material (glass_clear…), copying the real piece from the editor's pictures (ref_urls, default the set's product / sample references: a photo of the blank or of a finished ornament — its print left out), ~1 min in the background. view_image the attachments first: a picture of the plain piece or a product photo goes in ref_urls. Use it when the khuôn has no phôi (get_task blankProduct null, the first mockup shows the print on white) or the phôi is of the wrong material. It is kept with the khuôn too (the next product on that khuôn reuses it). An uploaded phôi (brief.product.blankId) still wins over it. → image id for char_wait; view_image it; then char_remake_product and make_product_mockups again.",
    inputSchema: {
      type: "object",
      properties: {
        ...TASK_ARG,
        ref_urls: { type: "array", items: { type: "string" }, description: "Photos of the real piece to copy its material / edge / finish from (≤ 4): the editor's attachments showing the blank or the finished product. Omit = the set's references used as \"product\" or \"sample\"; [] = none." },
      },
      required: ["task_id"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id);
      if (task.input.char?.step !== "chat" && task.input.char?.step !== "auto") throw new Error("char_make_blank is for chat requests");
      const looks = Array.isArray(args.ref_urls) ? args.ref_urls.map(str).filter((u) => /^https?:\/\//.test(u)) : undefined;
      if (!project.brief.product.templateId) throw new Error("brief.product has no khuôn (templateId) — list_print_templates / create_print_template, char_update_brief first");
      const template = await briefTemplate(db, project);
      const row = await startCharBlank(db, task.user_id!, project, looks);
      if (!row) throw new Error("Không tạo được phôi");
      await progress(db, task.id, `Đang vẽ phôi trơn: ${row.note.replace(/^Phôi trơn AI — /, "")}`);
      const warning = project.brief.product.blankId
        ? "brief.product.blankId (an uploaded phôi) is set and wins — clear it with char_update_brief to use this one."
        : template?.spec.blanks.length
          ? `The khuôn already has ${template.spec.blanks.length} phôi and its first one wins over this one — tell the editor to remove it in Thư viện → Phôi, or make a new khuôn of this material (create_print_template).`
          : undefined;
      return json({
        image_id: row.id,
        ...(warning ? { warning } : {}),
        next: "char_wait, view_image it (the right material and shape, hole in place, nothing printed on it); then char_remake_product, make_product_mockups.",
      });
    },
  },
  {
    name: "char_save_photo_style",
    description:
      "Bộ ảnh khách (chat / auto): create one of the set's own AI styles (no style_id; it is offered by the photo zone, last) or change one (style_id). name = what the customer sees (English); prompt = short plain English (the customer's photo always goes first, the server says so); ref_urls = pictures the editor attached showing this style's look, sent after the photo ([] = none; omit = unchanged). Rules: PHOTO_STYLES in the instructions. → the style + the set's styles.",
    inputSchema: {
      type: "object",
      properties: {
        ...TASK_ARG,
        style_id: { type: "string", description: "A style of this set (get_task set.photoStyles) to change; empty = a new one." },
        name: { type: "string", description: "Customer-facing style name (English)." },
        prompt: { type: "string", description: "Short plain English prompt (PHOTO_STYLES)." },
        ref_urls: { type: "array", items: { type: "string" }, description: "≤ 3 picture urls sent after the customer's photo." },
        zone_id: { type: "string", description: "Photo zone (default: the first)." },
      },
      required: ["task_id", "name", "prompt"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id);
      const { style, project: p } = await savePhotoStyle(db, task.user_id!, project, {
        id: str(args.style_id) || undefined,
        name: str(args.name),
        prompt: str(args.prompt),
        refUrls: Array.isArray(args.ref_urls) ? args.ref_urls.map(str).filter(Boolean) : undefined,
        zoneId: str(args.zone_id) || undefined,
      });
      await progress(db, task.id, `${str(args.style_id) ? "Sửa" : "Thêm"} style ảnh khách "${style.name}"`);
      return json({ style, styles: (await setPhotoStyles(db, p)).map((x) => ({ id: x.id, name: x.name, offered: x.offered })), next: "char_test_photo_styles with this style_id → char_wait → view_image each test." });
    },
  },
  {
    name: "char_remove_photo_style",
    description: "Bộ ảnh khách: take a style off the photo zone (a style made for the set is deleted; a library style only stops being offered).",
    inputSchema: { type: "object", properties: { ...TASK_ARG, style_id: { type: "string", description: "get_task set.photoStyles[].id" } }, required: ["task_id", "style_id"] },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id);
      const p = await removePhotoStyle(db, project, str(args.style_id));
      await progress(db, task.id, `Bỏ style ảnh khách ${str(args.style_id)}`);
      return json({ styles: (await setPhotoStyles(db, p)).map((x) => ({ id: x.id, name: x.name, offered: x.offered })) });
    },
  },
  {
    name: "char_test_photo_styles",
    description:
      "Bộ ảnh khách: run styles on test photos exactly like a customer's upload (the style, cut out) — style_ids (none = every offered style) × photos (none = the editor's test photos, get_task set.photoStyles.testPhotos; else a stock sample pet). ~1 min each, 3 at a time, in the background → image ids for char_wait; then view_image each.",
    inputSchema: {
      type: "object",
      properties: {
        ...TASK_ARG,
        style_ids: { type: "array", items: { type: "string" }, description: "Style ids (none = every offered style)." },
        photos: { type: "array", items: { type: "string" }, description: "Picture urls of customer-like photos (optional)." },
      },
      required: ["task_id"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id);
      const ids = (Array.isArray(args.style_ids) ? args.style_ids : []).map(str).filter(Boolean);
      const photos = (Array.isArray(args.photos) ? args.photos : []).map(str).filter(Boolean);
      const rows = await startStyleTests(db, task.user_id!, project, { styleIds: ids, photos, taskId: task.id });
      await progress(db, task.id, `Đang thử ${rows.length} ảnh style: ${[...new Set(rows.map((r) => r.note.split(" — ")[0]))].join(", ")}`);
      return json({ image_ids: rows.map((r) => r.id), next: "char_wait, view_image each; fix the prompt with char_save_photo_style and test again; char_style_demo the best of each style." });
    },
  },
  {
    name: "char_style_demo",
    description: "Bộ ảnh khách: a finished test picture of a style becomes its demo (the picture the customer picks the style by on the store).",
    inputSchema: { type: "object", properties: { ...TASK_ARG, style_id: { type: "string", description: "The style." }, image_id: { type: "string", description: "One of its done tests." } }, required: ["task_id", "style_id", "image_id"] },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id);
      await setStyleDemo(db, project, str(args.style_id), str(args.image_id));
      await progress(db, task.id, `Đặt ảnh demo cho style ${str(args.style_id)}`, [str(args.image_id)]);
      return json({ ok: true });
    },
  },
  {
    name: "char_remake_product",
    description:
      "Bộ nhân vật (chat, step 4): build the set's product again from the current files and brief (backgrounds, texts, material) — it replaces the set's product. → the new product id; check it with list_product_options and render_artwork.",
    inputSchema: {
      type: "object",
      properties: { ...TASK_ARG, reset_zones: { type: "boolean", description: "true = customer photo zones from the set's own layout again (default: a zone the editor reshaped in the product is kept)." } },
      required: ["task_id"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id);
      if (task.input.char?.step !== "chat" && task.input.char?.step !== "auto") throw new Error("char_remake_product is for chat requests");
      const posed = !!project.brief.poses?.length;
      if (project.brief.kind !== "photo" && !posed && (project.layers?.status !== "done" || !project.layers.approved)) throw new Error('The files are not cut yet — char_cut("build") first (it makes the product too)');
      // A drawn lineup's product (every version / pose set) takes minutes: built in the background (an MCP call is cut at ~100 s).
      if (project.brief.lineup?.drawn || posed) {
        void remakeDrawnProduct(db, task.user_id!, project.id).catch((e: Error) => console.warn("[ct] drawn product", e.message));
        await progress(db, task.id, "Đang dựng lại sản phẩm (mọi phiên bản, vài phút)");
        return json({ building: true, next: "Built in the background (2–4 min): char_status shows the new productIds when it is done — do not call char_remake_product again meanwhile." });
      }
      const productId = await remakeSetProduct(db, project.user_id ?? task.user_id!, project, project.layers, { resetZones: args.reset_zones === true });
      if (!productId) throw new Error("Not every version set is cut yet (get_task set.versions: layers.status \"done\" for each) — wait for them, then call again");
      await progress(db, task.id, "Đã dựng lại sản phẩm");
      return json({ product_id: productId, next: "list_product_options, render_artwork (mode print), make_product_mockups." });
    },
  },
  {
    name: "char_import_files",
    description:
      "Bộ import (set.brief.imported): the uploaded folder — every file's path, size and url (images: view_image the url), folder by folder; small text files (json / md / txt / csv ≤ 6 KB) come with their contents. under = only that sub-folder. Large folders are paged (offset).",
    inputSchema: {
      type: "object",
      properties: { ...TASK_ARG, under: { type: "string", description: "A sub-folder path (default: all)." }, offset: { type: "number", description: "Skip this many files (paging)." } },
      required: ["task_id"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { project } = await openCharTask(ctx, args.task_id);
      if (!project.brief.imported) throw new Error("This set is not an imported one");
      const under = str(args.under).replace(/^\/+|\/+$/g, "");
      const all = (await importFiles(project)).filter((f) => !under || f.path.startsWith(`${under}/`));
      const offset = Math.max(0, Math.round(Number(args.offset) || 0));
      const page = all.slice(offset, offset + 400);
      // Folders first (how many files each), then the page of files.
      const folders = new Map<string, number>();
      for (const f of all) {
        const d = f.path.split("/").slice(0, -1).join("/") || ".";
        folders.set(d, (folders.get(d) ?? 0) + 1);
      }
      const texts: Record<string, string> = {};
      for (const f of page.filter((x) => /\.(json|md|txt|csv)$/i.test(x.path) && x.size <= 6000).slice(0, 20)) texts[f.path] = (await importText(project, f.path, 6000)) ?? "";
      return json({
        total: all.length,
        folders: Object.fromEntries([...folders].slice(0, 300)),
        files: page.map((f) => ({ path: f.path, size: f.size, url: f.url })),
        texts,
        ...(offset + page.length < all.length ? { next_offset: offset + page.length } : {}),
      });
    },
  },
  {
    name: "char_import_read",
    description: "Bộ import: one text file of the uploaded folder (json / csv / md / txt), up to 60 000 characters.",
    inputSchema: { type: "object", properties: { ...TASK_ARG, path: { type: "string", description: "Its path in the folder (char_import_files)." } }, required: ["task_id", "path"] },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { project } = await openCharTask(ctx, args.task_id);
      if (!project.brief.imported) throw new Error("This set is not an imported one");
      const text = await importText(project, str(args.path), 60_000);
      if (text === null) throw new Error("No such file in the folder");
      return json({ path: str(args.path), text });
    },
  },
  {
    name: "char_import_build",
    description:
      'Bộ import: build the set and its product from a manifest of the uploaded folder (background, minutes for thousands of files — set.brief.imported shows done / total, problems; get_task again to see it). manifest = {name, canvas: {width, height} px, dpi, widthMm, material (CT material id or ""), cut: "alpha" (die-cut along the artwork) | "rect", title, description, versionLabel ("Number of grandkids"), variantLabel ("Layout", "" when a version has one variant), versions: [{name, variants: [{name, layers: [{key, label (customer-facing English), kind: "static" | "choice" | "linked", follows (linked: the leader\'s key), groupLabel ("Skin tone"), groups: [{name, swatch (#hex or ""), options: [{name, file (path in the folder), default (bool)}]}]}] bottom first, texts: [{key, label, sample, maxChars, font (Google family), weight, size (letter height px), cx, cy, width, angle (deg clockwise), color, above (layer key it lies on, "" = top)}]}]}], sample (path of the finished look), mockups: [paths]}. Every layer file must be the whole canvas size.',
    inputSchema: { type: "object", properties: { ...TASK_ARG, manifest: { type: "object", description: "See the description." } }, required: ["task_id", "manifest"] },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id);
      if (!project.brief.imported) throw new Error("This set is not an imported one");
      const r = await buildFromAgent(db, project, args.manifest);
      await progress(db, task.id, "Đang dựng bộ import từ manifest");
      return json({ building: true, ...r, next: "get_task (set.brief.imported) until status done, then render_artwork the product (list_product_options for its options) and fix the manifest if a layer is wrong." });
    },
  },
  {
    name: "char_add_product",
    description:
      "Bộ nhân vật (chat, step 4): ANOTHER product from this set (\"thêm 1 sản phẩm tương tự ornament sứ\", a rug, a bag…) — a new product on khuôn in template_id (list_print_templates; create_print_template when no khuôn fits) with the whole set dropped on it, like dragging the set in the editor. The set's own product stays; the new one is listed in step 4 with it and follows the set when it is remade. material = what the new piece is made of (its phôi and mockups). → product id; then render_artwork (print) — the set fits its sheet as a whole; set_artwork_layers is NOT for it (fix the place in the editor) — and when the khuôn has no phôi of that material (blank null) make_product_blank before make_product_mockups.",
    inputSchema: {
      type: "object",
      properties: {
        ...TASK_ARG,
        template_id: { type: "string", description: "The khuôn in of the new product." },
        name: { type: "string", description: "Product name, e.g. \"Ornament sứ - chó mèo\"." },
        material: { type: "string", description: `One of ${CT_MATERIALS.filter((m) => m.id !== "none").map((m) => `"${m.id}"`).join(", ")}.` },
      },
      required: ["task_id", "template_id", "name", "material"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, project } = await openCharTask(ctx, args.task_id);
      if (task.input.char?.step !== "chat" && task.input.char?.step !== "auto") throw new Error("char_add_product is for chat requests");
      const material = str(args.material);
      if (!CT_MATERIALS.some((m) => m.id === material && m.id !== "none")) throw new Error(`Unknown material "${material}"`);
      const { data: t } = await db.from(CT_TABLES.printTemplates).select("*").eq("id", str(args.template_id)).maybeSingle<CtPrintTemplate>();
      if (!t) throw new Error("No such khuôn in — list_print_templates");
      const template = templateRow(t);
      const productId = await addSetProduct(db, project.user_id ?? task.user_id!, project, template, str(args.name).slice(0, 120) || `${project.name} — ${template.name}`, material);
      await progress(db, task.id, `Đã tạo sản phẩm mới từ bộ: ${str(args.name)}`);
      return json({
        product_id: productId,
        editor: `${siteUrl()}${CT_CONFIG.basePath}/${productId}`,
        blank: template.spec.blanks[0]?.url ?? null,
        next: "render_artwork (mode print) to look at it; make_product_blank when blank is null or of another material; then make_product_mockups.",
      });
    },
  },
];
