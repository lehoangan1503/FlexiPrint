/**
 * The FlexiPrint system as MCP resources — what the @flexiprint agent has to know to work on the web app's tasks.
 */

import { LAYER_RULES } from "./layer-rules";

export interface CtMcpResource {
  uri: string;
  name: string;
  description: string;
  text: () => string;
}

const OVERVIEW = `# FlexiPrint — personalized print-on-demand products

FlexiPrint turns clipart and customer photos into physical products (clear acrylic ornaments, keychains, visor
clips…) sold on Shopify. Editors work in the web app; you (the @flexiprint agent) work on the same data through
this MCP. Everything you read here is live production data.

## Records
- CATEGORY (ct_clipart_categories): a folder of the clipart library (name, parent, sort order). Older categories
  also carry a spec and rules (details, reference / product photos) from when cliparts were drawn by AI.
- CLIPART (ct_assets, library = product_id null): an ORIGIN ("gốc", role main/sub) of a category; its children
  are variants ("đa sắc", recolours) and renditions (material versions: meta.material = the material preset id,
  meta.materialVersion = a version's label, e.g. "có dây"). Editors upload all of them by hand.

## Product base · Artwork · Sản phẩm (since 2026-11-07, like Teeinblue Product Base / Artwork / Campaign)
- PRODUCT BASE (list_base_products): the blank product sold — name = kind of product (Acrylic Ornament 1 side,
  Glass Ornament 1 side, Ceramic Ornament 2 sides, Poseable Doll), its Notion price table (variants: sizes × packs
  with prices), Shopify product type, the khuôn in + phôi of the piece, print areas. No design.
- ARTWORK (ct_products kind "artwork"): ONE whole design — every version, layer, option, khuôn, phôi, preview and
  print file. A finished bộ (drawn, imported) gives clipart + its artwork; char_add_product, create_artwork_product
  and import builds make artworks. An artwork is never deployed.
- SẢN PHẨM (kind "product"): what is sold = an artwork + a product base (make_product_from_artwork). It keeps a
  snapshot of the artwork (later artwork edits never reach it; the editor updates by hand), takes variants + price +
  product type from its base, and has its own title (theme), mockups and Shopify link. make_product_mockups,
  check_deploy and deploy_product work on the PRODUCT id.

## Tools
- Library reads: list_categories, get_category, list_cliparts, get_history, view_image.
- Tasks from the web app: get_task, report_progress, ask_user, submit_result, fail_task.
- v2 bộ nhân vật: the char_* tools (see flexiprint://guide/layer-rules). Chat requests (step "chat", the sticky chat
  of the set's page, any tab, with screenshots): char_update_brief, char_cut, char_status besides
  the master / edits tools; char_approve_master (only when the editor hands you the whole set), char_draw_backdrops
  and char_remake_product for step 4 — get_task gives the whole set.
- Products: list_print_templates / get_print_template (khuôn in), create_artwork_product / set_artwork_layers /
  check_artwork (a product laid out from library cliparts), render_artwork (guides, or the print file with chosen
  options), list_product_options, make_product_mockups → wait_product_mockups (the print on the phôi + AI photos).

## The 3 kinds of bộ (kiểu 1 / 2 / 3)
People in the company name a set by its kind ("làm bộ kiểu 1…"); the library's Clipart tab filters by it and the
"Tạo bộ clipart mới" popup asks them to say it. Same rule as lib/set-kind.ts:
- KIỂU 1 — the customer picks clipart ON A CHARACTER (hair, outfit, hat, held item…): a drawn bộ nhân vật, or a
  Teeinblue import. = char_create_set kind "character", brief.photoZones empty.
- KIỂU 2 — NO clipart to pick: the zones are layers put together, or take the customer's uploaded photo (a bộ ảnh
  khách: pet memorial, portrait). = char_create_set kind "photo" (brief.photoZones[0] = the customer's photo).
- KIỂU 3 — BOTH: clipart to pick AND a zone for the customer's photo (an elf / Santa body with the customer's face).
  = char_create_set kind "character" + brief.photoZones [{treat: "face", where: "the left elf's face"}].
The request names the kind → build exactly that kind. It does not, and the pictures / words do not settle it (is
there a customer photo? does the customer pick clipart?) → ask once, briefly, which kind (1, 2 or 3), and end your turn.
Never turn one kind into another on your own (no photo zone added to a kiểu 1, no clipart choices in a kiểu 2).

## A bộ nhân vật from idea to Shopify
1 Brief (idea, product = khuôn in + material, style, references, subjects + slots, photo zones, texts, backdrops,
mockup scenes) → 2 Master (one picture, approved) → 3 Layer: 3a the master at print size, 3b the pictures the files
are cut from (the paper doll + every option drawn on it), 3c regions (what each option drew anew) → files ("Tạo bộ custom" cuts them AND builds the product: clipart
folder + layers + texts + background + phôi) → 4 Sản phẩm: phôi / khuôn, backgrounds, mockups → the editor
(Thiết kế / Xem trước = flexi2-product.liquid / File in / Mockups) → Deploy (Shopify product + template).
Deploy by tool (asked 2026-10-29): check_deploy (what is missing) → fill it → deploy_product (ACTIVE by default).

## Tasks from the web app
kind "content" (deploy page: Shopify title + description) and kind "char" (a step of a v2 bộ nhân vật, or a chat
request written on its page).
You get a message with a task id. Then: get_task → work (report_progress now and then, in Vietnamese, one short
line each) → submit_result with the JSON the task's "instructions" describe, or fail_task with the reason. Always
finish with one of the two — and only when the work is COMPLETELY over. Your result's "summary" (Vietnamese) tells
the editor what you did. The page's chat also shows, in full, your last message of the turn and your proposal block
(since 2026-11-04) — so put every detail the editor asked for in the summary or in that last message, never "see below"
pointing at nothing.
A choice that is the editor's (two good directions, a taste call, missing information): ask_user with options, then
END YOUR TURN. Their answer comes back as a new message in the same session — continue the task from there.

## Someone asks you directly on agent_ide
To make a whole new product (idea / reference pictures → product + mockups) follow flexiprint://guide/whole-set.
`;

const WHOLE_SET = `# A whole bộ from one agent_ide session

Someone in the company asks you, in the agent_ide chat, for a new custom product. You do every step in THIS
session; they follow on the set's page and answer you here. Write to them in Vietnamese, short. Image prompts in
English. Read flexiprint://guide/layer-rules first.

1. Read the request and LOOK at every picture they sent (char_add_reference, then view_image). The sample picture
   decides how the piece looks — framing (full / bust behind a sign), pose, who is in the middle, what is in front,
   the decorations, where the names sit — unless their words say otherwise; only what neither says gets the
   defaults (full body, standing side by side). Missing a deciding fact (what product, real size, how many
   characters, what the customer can change, which KIỂU 1 / 2 / 3 — see flexiprint://guide/overview)? Ask once,
   briefly, and end your turn.
2. char_create_set {name, kind, idea} (kiểu 1 and 3 → kind "character", kiểu 3 also gets brief.photoZones; kiểu 2 →
   kind "photo") → PRINT the set url it returns (this server's own address, https://flexi2.next.lc/v2/<id>). Their pictures →
   char_add_reference (url, or image_base64 of a file in the session; use sample/style/…; note = what to take).
3. Khuôn in: list_print_templates. None at the real size → create_print_template (a 120×40 cm rug at 150 dpi, a
   die-cut acrylic square…) — never a small khuôn for a big product.
4. Brief: get_task (its briefRules say how) → char_update_brief: subjects + slots (hair / top / pants / glasses…, mode
   color / texture / shape), lineup (the customer picks one character / how many people), choosers (boy/girl per
   grandchild, hat / no hat…) + shownWhen, slot follows (sweater and hat follow the Theme), optional (a NO choice),
   elements (decorations: front, follows, box), texts (input / choice / fixed; top / bottom / left / right / under /
   free / on), backdrops (tile for repeat patterns), charactersBox, mockups. Sum the brief up for them (Vietnamese,
   short) and ask whether an option is missing. END YOUR TURN and wait.
5. Master: char_draw_masters (2) → char_wait → view_image → refine / redraw → show them (url + numbers) and END YOUR
   TURN: they choose. Then char_approve_master with their choice.
6. After approval do all of step "auto" (get_task instructions): 3b char_run_edits → check every picture (exactly one
   part added to the doll; no background; no magenta left; thin parts bold) → 3c char_cut what "plan" → char_status
   (every check passes) → step 4 char_draw_backdrops + char_draw_elements → char_remake_product → render_artwork a few
   combinations → fix the layout (boxes) if it does not look like the reference → make_product_mockups → look.
   A short progress line (with the url) at each stage. Something wrong at a stage: fix it at that stage.
7. Done: the set url + the product (list_product_options has the editor url) + a few mockups, and what is still worth
   a second look. submit_result on the open task. They want changes later: char_open_task (or the open task).
`;

export const CT_MCP_RESOURCES: CtMcpResource[] = [
  { uri: "flexiprint://guide/overview", name: "FlexiPrint — how the system works", description: "Records, tools, tasks. Read first.", text: () => OVERVIEW },
  { uri: "flexiprint://guide/layer-rules", name: "Layered art — pixel-registration rules", description: "MANDATORY for any design built from swappable parts (character skin / clothes / hair): one master canvas, full-canvas exports, one box per slot, hair back/front split, linked slots.", text: () => LAYER_RULES },
  { uri: "flexiprint://guide/whole-set", name: "A whole bộ from one agent_ide session", description: "Someone asks you directly (not from the web app) for a new custom product: create the set, brief, master (they approve), auto steps, product, mockups — all in one session.", text: () => WHOLE_SET },
];
