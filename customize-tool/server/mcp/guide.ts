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

## A bộ nhân vật from idea to Shopify
1 Brief (idea, product = khuôn in + material, style, references, subjects + slots, photo zones, texts, backdrops,
mockup scenes) → 2 Master (one picture, approved) → 3 Layer: 3a the master at print size, 3b the pictures the files
are cut from (the paper doll + every option drawn on it), 3c regions (what each option drew anew) → files ("Tạo bộ custom" cuts them AND builds the product: clipart
folder + layers + texts + background + phôi) → 4 Sản phẩm: phôi / khuôn, backgrounds, mockups → the editor
(Thiết kế / Xem trước = main-product.liquid / File in / Mockups) → Deploy (Shopify product + template).

## Tasks from the web app
kind "content" (deploy page: Shopify title + description) and kind "char" (a step of a v2 bộ nhân vật, or a chat
request written on its page).
You get a message with a task id. Then: get_task → work (report_progress now and then, in Vietnamese, one short
line each) → submit_result with the JSON the task's "instructions" describe, or fail_task with the reason. Always
finish with one of the two — and only when the work is COMPLETELY over. Your result's "summary" (Vietnamese) tells
the editor what you did.
A choice that is the editor's (two good directions, a taste call, missing information): ask_user with options, then
END YOUR TURN. Their answer comes back as a new message in the same session — continue the task from there.
`;

export const CT_MCP_RESOURCES: CtMcpResource[] = [
  { uri: "flexiprint://guide/overview", name: "FlexiPrint — how the system works", description: "Records, tools, tasks. Read first.", text: () => OVERVIEW },
  { uri: "flexiprint://guide/layer-rules", name: "Layered art — pixel-registration rules", description: "MANDATORY for any design built from swappable parts (character skin / clothes / hair): one master canvas, full-canvas exports, one box per slot, hair back/front split, linked slots.", text: () => LAYER_RULES },
];
