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
  Glass Ornament 1 side, Ceramic Ornament 2 sides, Poseable Doll), its VARIANTS (options = the rows of buttons on
  Shopify, ≤ 3 with the pack: two kinds of blanket in 3 sizes = Material [2] × Size [3], never 6 glued "sizes"), its
  Notion price table (PRICES only: one per combination + the packs), Shopify product type, print areas, and (since 2026-11-08) the WHOLE physical piece: its khuôn in,
  how it is cut (fixed khuôn / along the art + border mm / flat), the silhouette in the print file, the phôi or the
  preview background. No design.
- ARTWORK (ct_products kind "artwork"): ONE whole design — every version, layer, option. Its canvas is the print
  area of the base it was made for; it holds NO khuôn and NO phôi: it is viewed on a base (base_product_id = "Xem
  trên base") which lays its khuôn / phôi / cut on it, and can be used on any other base. A finished bộ (drawn,
  imported) gives clipart + its artwork; char_add_product, create_artwork_product and import builds make artworks.
  An artwork is never deployed.
- SẢN PHẨM (kind "product"): what is sold = an artwork + a product base (make_product_from_artwork). It keeps a
  snapshot of the artwork (later artwork edits never reach it; the editor updates by hand) with the base laid on it
  (khuôn layer, phôi, silhouette — re-laid when the base changes), takes variants + price + product type from its
  base, and has its own title (theme), placement in the khuôn, mockups and Shopify link. make_product_mockups,
  check_deploy and deploy_product work on the PRODUCT id.
- STORES (since 2026-11-10): several Shopify stores (CHERIVIA, Caridora…). Product bases, price tables and the library
  (bộ clipart, khuôn, phôi, fonts, AI styles) are SHARED; every artwork and product belongs to ONE store. A new
  artwork lands in the store its owner picked on /dashboard (nothing to pass); a product made from an artwork is on
  the artwork's store, and deploy_product always sends it to the product's own store.

## Tools
Two callers. The @flexiprint agent (task_id from the web app's message on every task tool). A signed-in editor
through the local MCP "flexiprint" (integrations/flexiprint, since 2026-11-17): every tool too, on their own
artworks / products / sets (admins: all) — product, base and deploy tools WITHOUT task_id; a bộ nhân vật through a task
of its own (char_create_set for a new set, char_open_task for an existing one → task_id), finished with submit_result.
Local tools of that MCP: flexiprint_import (a bộ folder on the machine), flexiprint_upload_image (a picture → url),
flexiprint_save_files (urls → a folder).
- Library reads: list_categories, get_category, list_cliparts, get_history, view_image.
- Tasks from the web app: get_task, report_progress, ask_user, submit_result, fail_task.
- v2 bộ nhân vật: the char_* tools (see flexiprint://guide/layer-rules). Chat requests (step "chat", the sticky chat
  of the set's page, any tab, with screenshots): char_update_brief, char_cut, char_status besides
  the master / edits tools; char_approve_master (only when the editor hands you the whole set), char_draw_backdrops
  and char_remake_product for step 4 — get_task gives the whole set.
- Bases: list_base_products (print area, khuôn, cut, preview photo, variants + price); create_base_product (a new base: image_url = its fixed picture, required —
  with its options (variants) and its price table (prices) given APART + mockup prompts / reference pictures / size
  charts — no khuôn needed for a piece not cut to shape), ONLY when no base of that kind exists. Creating a base, or
  changing its options / prices, ALWAYS goes through the user: the first call saves nothing and answers a preview +
  confirm_token — show the option rows, variant count and prices, ask, and only on their yes call again with the
  same arguments + confirm_token. Unsure how the kind of product splits into options → ask before the first call; any change to an existing base (name, price, description, khuôn, prompts) is
  update_base_product on the same id — never a new base.
  Size charts (get/set_base_mockup_prompt size_charts) go up after the mockups on every deploy of the base's products.
- Artworks: create_artwork_product {base_product_id} / set_artwork_layers / check_artwork (an artwork laid out from
  library cliparts on a base's print area), set_artwork_base (the base it is viewed on), render_artwork (on its base:
  guides, or the print file with chosen options), list_product_options, make_version_phoi → version_phoi_status (the
  customer's preview photo per version on an acrylic base; an import folder's own preview is kept, never redrawn).
  A photo layer with "input": "name" (the customer types, the AI style draws it): its "label" is the field's label,
  "placeholder" its hint, "max_chars" its length (default 12, max 40 — a whole line like "The Montgomery Family" needs
  ~30). Changed on the artwork → sync the product, deploy again.
- Products: make_product_from_artwork {artwork_id, base_product_id} → make_product_mockups → wait_product_mockups →
  check_deploy → deploy_product, all on the PRODUCT id. Title / description / tags / collections / customer note box
  known ahead → give them to make_product_from_artwork or save_deploy_draft (= the Deploy page's Lưu nháp): after the
  mockups the editor only presses Deploy, and deploy_product {product_id} alone uses them. Tags you give = hand-typed
  only: every deploy adds the auto tags itself — the SKU lower case (n06-pod-126), the staff code = its first part
  (n06), col_<collection handle> per collection — and takes off the last deploy's stale ones (check_deploy autoTags).
  Customer options (names, photos, note box) are not tags: they go as metafields. list_artwork_products (an artwork's products, outdated ones) → sync_product_from_artwork updates an outdated one in place (never a new product).
- Change / remove (every step): update_base_product / delete_base_product, list_price_tables / delete_price_table,
  set_artwork_layers (an artwork) / delete_product (artwork or product), update_product (name, status, move base,
  mockup order / off), delete_mockup, set_shopify_status (ACTIVE / DRAFT / ARCHIVED), delete_shopify_product.
  Deleting anything, or putting a product ACTIVE: ask the user first.
- Mockup prompts: kept on the PRODUCT BASE (get_base_mockup_prompt / set_base_mockup_prompt — scenes, the sentence
  around each scene, reference pictures; only the base's maker or an admin edits). A product's own prompt BLOCKS win over
  the base's scenes — one block = one photo = {prompt, refs}, its refs sent with that prompt only (picture 2, 3…; none =
  the base's): the editor's Mockups blocks, make_product_mockups save_blocks (or refs inside a scene of mockups),
  make_product_from_artwork mockup_blocks. Read / change ONE product's prompt without drawing:
  get_product_mockup_prompt / set_product_mockup_prompt (blocks; shared_refs = its own "Ảnh tham chiếu chung" in place
  of the base's refs — drop / add / replace pictures for that product only, shared_refs_from_base = back to the base's).
- Khuôn in (the base's physical shape, rarely touched): list_print_templates / get_print_template; create_print_template
  (from the piece's REAL size, only when none fits), add_template_blank / set_template_blank (a phôi photo of a khuôn:
  which is first, where the sheet sits), delete_print_template (one made by mistake; refused while used).

## Every editor button has a tool (asked 2026-11-24)
What the web page does, a tool does — through the same handler, so the same owner rules hold.
- Products: clone_product (Nhân bản — a copy without mockups, SKU or Shopify link), update_product also main_asset_id
  (Đặt làm chính), thumbnail_url, notes, samples (the default picks: list_product_options default_picks, by region
  id), update_asset (rename, swatch colour, move a variant to another group) / delete_asset (ask first; a mockup →
  delete_mockup), link_library_main / unlink_library_main (a library clipart as a version), fit_artwork_to_base (an
  artwork's "Khớp canvas với khuôn base"), set_photo_zone (a customer-photo layer's place, per version),
  make_version_thumbs (the version tiles), delete_version_phoi (drop a version's AI phôi). Several products outdated
  against their artwork: sync_product_from_artwork once per product (= the list's bulk update).
- Mockups: add_product_mockups (pictures made elsewhere, by https url — nothing drawn, nothing paid),
  clear_failed_mockups (Xoá N ô lỗi), delete_mockup, update_product mockup_order / mockup_off. A product the customer
  customises: make_product_mockups makes each scene a different random pick itself (names, options, a sample person /
  pet or a drawn name in each photo zone — the options you name stay fixed; vary false = exactly yours). make_product_blank is
  for old products without a base only. A refused drawing handed to you (task kind "mockup"): get_task → retry_mockup.
- Deploy: set_preview_box (where the design sits on the preview photo, this product only), shopify_preview_links (a
  fresh preview link of deployed products). Collections: reuse check_deploy's (suggested = fits the title; a smart one
  is joined through its rules); none fits → create_shopify_collection {title, product_id} (a title already there is
  reused). check_deploy shopify.handAdded (pictures added by hand on Shopify) → deploy_product remove_shopify_media_ids
  takes them off; customerPhoi.applies → deploy_product customer_phoi (the Deploy page's "Phôi AI có ảnh khách").
  A product with several AI photo slots (3+, e.g. a photo-collage blanket): set_multi_photo {product_id, on: true} =
  ONE popup on the store for every slot (preview left, slots right, AI jobs side by side) — live at once, no deploy;
  only when the user asks for it (it is the owner's per-product choice). Customer AI drawings: a timeout / dropped
  connection is tried once more by itself; a drawing that still fails does not count against the customer's daily cap.
- Price tables: list_price_tables; create_price_table / update_price_table — prices ALWAYS through the user (first call
  = preview + confirm_token, save only on their yes); update_price_table changes every base using the table (one base
  only → update_base_product price_table, which copies a shared table); delete_price_table (ask first).
- AI photo styles of the library: list_ai_styles, update_ai_style (its prompt reaches customers at once).
- Design: get_product_design (the whole saved design: layers, options, settings, versions) → save_product_design
  (regions / items = whole lists, config = only the keys given; = the editor's "Lưu thiết kế"); prefer the narrower
  tools when one fits. clone_version (+ Version nhân bản: picture + layers copied as a new version, saved).
- Product base page: update_base_product also print_areas (every side), cut (khuon | alpha | none, border, hanging
  hole), preview (photo url, box = where the sheet sits, overlay), fulfillment, notes; clone_base_product (Nhân bản —
  try a change without moving products on Shopify). Import (admin, ask first): list_fulfiller_catalog {provider
  printbelle | merchize} → import_base_product (merchize needs teeinblue_connection); refresh_base_from_fulfiller
  (Khuôn + phôi từ xưởng). Pictures (paid AI calls — the user's yes first): make_base_khuon_phoi (phôi trơn from the
  fulfiller's), base_scenes_auto {start: true} (the 3 ready backgrounds; without start = how it goes), make_base_scene
  {base_id, prompt | preset} → base_scene_status. Then base_preview_check / render_base_preview (a real design on a
  scene) → set_base_preview {base_id, scene_id}. set_base_assembly (Ráp mảnh may: sewn pieces, swap, off). After the
  preview / assembly changed: republish_base (no confirm = which products show an old preview on the store; confirm
  true = Cập nhật store).
- Base preview tasks (kind "base_preview"): the same tools with task_id; set_base_preview ONLY when the request says apply.
- Clipart library: create_category / update_category (only the fields given) / delete_category (empty only);
  upload_clipart (image_url or data_base64; parent_id = a set member, rendition = a vật liệu version), update_clipart
  (name, spec, tags, category — origins only), clipart_usage → delete_clipart (force only after the editor says so) or
  replace_clipart (an edited one takes its place in every product); promote_to_library (a product's picture → library).
- Fonts: list_fonts / upload_font (.ttf .otf .woff) / delete_font. AI photo styles: create_ai_style → make_ai_style_demo
  (paid: one AI picture) / update_ai_style (also remove_background, ref_urls — our urls) / delete_ai_style.
  remove_background false = the AI picture is kept whole, backdrop included (full-bleed art on a blanket); it is the
  only switch — the photo zone always asks for a cut-out and the style's tick decides.
- Khuôn in: draw_print_template_ai (not saved: look, then) → save_print_template (any shape: no template_id = new;
  spec given whole), make_template_blank_ai (phôi AI). upload_image: a picture (url or base64) → our url for every
  tool that takes one. create_blank_artwork: an empty artwork on a base or a W×H canvas.
- A signed-in user also: list_agent_tasks / open_agent_task (content, mockup, base_preview, char — what the buttons
  open) / cancel_agent_task / answer_agent_task; char_list_sets, char_rename_set, char_delete_set (confirm, ask first).
  Every change above is its maker's or an admin's; deletes are asked first.
- Bộ nhân vật by hand (its page's buttons, no task needed): char_get_set (files, 3a matte, 3c regions — the ids and
  urls) → char_edit_file (a clipart file: mask = its new alpha on the bộ's canvas, move {dx, dy}, fix = cân màu; every
  colour of the option follows) / char_revert_file (hoàn tác) / char_approve_layers; char_cut_step (matte: start, fix
  points, revert, approve; plan: start, region key + mask, revert key, approve). A bộ ảnh khách: char_order_photo_styles,
  char_set_test_photos. @flexiprint working on the bộ is told of each change, as for a change on the page.
- Lưu thành bộ clipart: char_extract_set {product_id, region_ids (get_product_design), name, version_id?} — the layers
  copied at the same place into a new bộ (its picture drawn on the server).
- Mockup library: list_mockup_packs (full = the scenes) → save_mockup_pack (no pack_id = new; slides given whole;
  pictures via upload_mockup_pack_image) / delete_mockup_pack (confirm). Thư viện ảnh mockup: list_pack_images,
  get_pack_image, upload_pack_image, delete_pack_image (confirm). mockup_sample_photos: sample people / pets for a photo
  zone through its styles (paid: one AI picture each, nothing saved). list_presets: material presets (read-only).
- Bộ nhân vật, besides the steps above: char_get_brief (the brief only, small), char_plan_pictures (your 3b plan),
  char_refine_master (an in-place edit of a master), char_use_edit (back to an earlier, better 3b attempt),
  char_make_blank (step 4 phôi trơn). Drawn pose by pose: char_draw_poses → char_compose (each version's placement) →
  char_set_behind (part of a doll behind the others); drawn version by version: char_versions. Bộ ảnh khách:
  char_save_photo_style / char_remove_photo_style / char_test_photo_styles / char_style_demo. Bộ import
  (set.brief.imported): char_import_files / char_import_read → char_import_locate / char_import_diff →
  char_import_preview → char_import_build → char_import_deploy; char_import_rethumb (option pictures again).

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
1 Brief (idea, product = a PRODUCT BASE: brief.product.baseId from list_base_products — its print area is the
canvas, its khuôn's safe zone the composition; style, references, subjects + slots, photo zones, texts, backdrops,
mockup scenes) → 2 Master (one picture, approved) → 3 Layer: 3a the master at print size, 3b the pictures the files
are cut from (the paper doll + every option drawn on it), 3c regions (what each option drew anew) → files ("Tạo bộ
custom" cuts them AND builds the ARTWORK: clipart folder + layers + texts + background, viewed on the base — no
khuôn, no phôi in it) → 4 backgrounds, the artwork's preview (acrylic base: make_version_phoi) → SẢN PHẨM:
make_product_from_artwork {artwork_id, base_product_id} (the same artwork can go on several bases) → mockups on the
product → Deploy the product (Shopify product + template).
Deploy by tool (asked 2026-10-29): check_deploy {product_id} (what is missing) → fill it → deploy_product (ACTIVE by
default) — never on an artwork.

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
3. Product base: list_base_products → the base of the piece they want (Acrylic Ornament, Ceramic, Glass, Poseable
   Doll…) → char_update_brief {product: {baseId}}: the artwork's canvas = its print area, its khuôn decides the safe
   zone. No base fits the product → ask them (a new base is made on the Product base page with its khuôn, price table
   and phôi) — never put a khuôn or a phôi into the set.
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
   combinations → fix the layout (boxes) if it does not look like the reference → acrylic base: make_version_phoi →
   make_product_from_artwork {artwork_id, base_product_id} → make_product_mockups on the PRODUCT → look.
   A short progress line (with the url) at each stage. Something wrong at a stage: fix it at that stage.
7. Done: the set url + the artwork + the product made from it (editor urls) + a few mockups, and what is still worth
   a second look. submit_result on the open task. They want changes later: char_open_task (or the open task).
`;

export const CT_MCP_RESOURCES: CtMcpResource[] = [
  { uri: "flexiprint://guide/overview", name: "FlexiPrint — how the system works", description: "Records, tools, tasks. Read first.", text: () => OVERVIEW },
  { uri: "flexiprint://guide/layer-rules", name: "Layered art — pixel-registration rules", description: "MANDATORY for any design built from swappable parts (character skin / clothes / hair): one master canvas, full-canvas exports, one box per slot, hair back/front split, linked slots.", text: () => LAYER_RULES },
  { uri: "flexiprint://guide/whole-set", name: "A whole bộ from one agent_ide session", description: "Someone asks you directly (not from the web app) for a new custom product: create the set, brief, master (they approve), auto steps, product, mockups — all in one session.", text: () => WHOLE_SET },
];
