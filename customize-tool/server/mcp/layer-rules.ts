/**
 * Layered art — the pixel-registration rules for any design composed from interchangeable parts (a character's
 * skin / top / pants / shoes / hair, accessories). Learned from a production dress-up product (macorner, 2026-10):
 * every option lands on exactly the same pixels because of HOW the files are made, not because of any fitting
 * code. MANDATORY: a file that breaks one of these rules never lines up, and no editor setting can fix it.
 */
export const LAYER_RULES = `# Layered art — pixel-registration rules (MANDATORY)

A layered design is one picture split into parts the customer swaps (skin, top, pants, shoes, hair, glasses…).
The parts line up to the pixel ONLY because they come out of one file at one size. Follow every rule.

## 1. One master, one canvas
- Every part of the design is painted in ONE master document at ONE canvas size (e.g. 1000×1000), on ONE base
  pose. Parts are never drawn on their own and moved into place afterwards.
- Every option of a part (each colour, each style) is painted in that same master, on top of the same base.

## 2. Export the full canvas — never trim
- Each option = a PNG (or AVIF/WebP with alpha) of the FULL canvas, transparent everywhere but the part.
- Never crop to the content, resize, re-centre or pad differently. The part's position IS the transparent padding.
  (Transparent padding costs almost nothing: an empty 1000×1000 PNG/AVIF is a few hundred bytes.)
- A slot may use a smaller sub-canvas (hair 683×1000) when ALL its options share it; its offset / scale / angle
  against the master is fixed once, for the whole slot.

## 3. One box per slot
- In the product, a slot (one layer) has ONE box (x, y, w, h, angle) = where its canvas sits on the print.
- Every option of the slot is drawn in exactly that box: no per-option offset or transform, no fit / contain, no
  centring on the alpha, no "auto-trim". Body slots usually share the same box (the master canvas).

## 4. Fixed stacking order
- One z-order per product, e.g.: back hair → skin/body → pants → top → head → eyes → shoes → front hair →
  accessories → text. A part never changes its depth per option.

## 5. Parts that are both behind and in front (hair, scarf, cape, long ears…) = TWO layers
- BACK layer: the WHOLE part, drawn under the body.
- FRONT layer: the SAME pixels with everything that must be hidden erased — the face, the neck, what falls behind the
  torso — drawn on top. Erase from the back layer's pixels; never repaint the front (it would not match).
- Both on the same canvas and the same box. Check: ≥ 95% of the front layer's pixels are also in the back layer.
- An option with nothing behind (an updo): its back file is an EMPTY transparent canvas of the same size.
- The split is decided per style by the artist (a ponytail goes mostly behind, loose hair partly in front); only the
  face/neck core is always erased.

## 6. Linked slots — one choice, several files
- The back slot is not a customer choice: it FOLLOWS the front slot (macorner: dependLayer).
- Its options are a parallel tree: same groups (colours), same names, same order / index (1_1 … 1_N per colour).
  Choosing front #21 "Ginger" draws back #21 "Ginger". Same mechanism for body sets that follow another choice
  (young / aged skin follows the face).
- In FlexiPrint: the back layer's Inspector → "Liên kết theo layer" = the front layer (config.image.follows). The
  storefront never shows it; every renderer (editor, print file, mockups, storefront) resolves it the same way.

## 7. The base never moves
- All faces / heads / bodies of a set share the same pose and the face sits on the same pixels — otherwise the
  front-hair erasing no longer matches. Another pose or body = another master set (switched by a linked choice).

## 8. Never register by hand
- Never cut a part out by clicking points along its outline, and never place a part by eye. Points / outlines are
  only for the PRODUCT's shape (khuôn vật liệu, cut lines), never for a character's parts.

## 9. AI-made parts
- An AI-made option is an in-place edit of the master canvas (same size, same base) and the part is extracted on that
  canvas (§9b). Never generate a part alone and scale it into the slot (the 2026-10-13 "whole" pictures did exactly
  that — re-framed ×3–5 and re-drawn, they never matched; removed 2026-10-14).

## 9-clean. A master that cuts clean (asked 2026-10-10)
- Hair is drawn as smooth, solid, sculpted locks with ONE continuous outline: no flyaway strands, no single hairs
  or wisps apart from the hair mass, no see-through hair ends. Clothes are simple shapes with continuous outlines:
  no lace, fringe, ruffles, see-through fabric, dangling straps or tassels. Every master prompt carries this
  (lib/char-brief.ts CLEAN_PARTS), every hair / garment option drawn in place too. A master with loose strands is
  refined or redrawn BEFORE it is approved — strands never cut clean afterwards.

## 9b. Pixel lock — THE way a v2 set is cut (approved by the user 2026-10-15: "cách này ngon, lưu vào system rule")
- One image model only: GPT Image 2.5 (company API, quality high). Every picture a file is cut from is drawn on a
  TRANSPARENT background — its alpha is the cut-out; nothing is matted afterwards. Never ask GPT to "remove the
  background" of an existing picture (tested 2026-10-12: it re-framed the figure ~20 %).
- Pictures: PLANNED BY @flexiprint per set since 2026-10-19 (char_plan_pictures → brief.pictures,
  lib/char-pictures.ts PICTURE_PLAN_RULES; a set without a plan keeps the old lib/char-plan.ts rules). Always:
  base = the PAPER DOLL drawn from the master (every part the customer changes taken off: bald, flat magenta #D81BD8
  tank top + shorts, empty hands, blank face) · every option drawn IN PLACE on the doll or on another picture of the
  plan (hair under the hats of the outfit picture, cut against it) — one part per character per picture, the same
  part of every character may share one · colour parts draw only their first option (the rest are recolours) ·
  zones painted magenta on the doll. The doll is the canvas: fix the doll (legs, body) and every option is drawn
  again on it.
- Every option is registered onto the doll: affine + local flow trusted where the moved picture matches (≤ 8 px — the
  AI shifts a pair of legs 3–4 px now and then), residual ≤ 0.6 px.
- The body file IS the doll. An option file = its picture's pixels where they differ from the doll (layer-kit
  part_region): colour ΔE > 12 or figure past the doll's outline, minus the 1–2 px lines where an outline only moved,
  minus the magenta key by hue (the doll's underwear never belongs to a part), only on its own subject's side of the
  doll and near its main piece (the AI re-draws the other figure a little). So doll + file = exactly that 3b picture.
- Hair: back = the whole hair of its picture, front = the same hair over the doll's figure (front ⊂ back, same
  pixels). Colours: the file recoloured where it has the part's own hue.
- A layer can only ADD to the doll: a picture that erased or moved doll pixels (checks "Khớp", "xoá / dời … px của
  búp bê") is drawn again — never patched in the cut.
- Prompts: garments in SOLID opaque fabric ("knit" alone gave openwork mesh), covering the magenta wherever worn; a
  garment under a jacket is sleeveless; an item goes in the doll's empty hand; nothing else of the doll moves.
- NEVER again (all tried until 2026-10-14, all gave seams and clipart unlike 3b): a segmentation model choosing edges
  (SAM), seeds / paint pictures, "unwrap" pictures, a part drawn alone and fitted ("whole"), per-case heuristics in
  the cut (trim / grow / fill-by-colour / front_of / lock_reach …). A wrong file → draw its 3b picture again, or fix
  it by hand in the file editor.
- Option thumbnails: a part a hand partly hides (a glass, a cane) gets a 3b picture "thumb:<slot>:<option>" — the
  object alone and complete — used ONLY as the option's thumbnail in the shop (asset meta.thumb); its clipart stays the cut.
- "Tạo bộ custom" = plan (regions) → cut → the cliparts in the product's library folder → ONE finished product, its
  layers in the cut's order (a recoloured jacket lies over the dress).
- Each picture adds exactly ONE part (2026-10-18): a gown picture with the stole drawn on it, a stole picture with the
  gown, pants that recolour the underwear top — each would carry the other part into its file and hide the customer's
  choice of it. Say "ONLY the <part>, the magenta underwear stays visible around it" and draw again.
- Thin parts on small figures (gọng kính on a family of five on a wide canvas) fall under the cut's minimum piece:
  draw them bolder (cartoon glasses: thick frames, tinted lenses with a shine) — never lower the cut's threshold.
- Who is in the picture as a customer choice (brief.lineup, 2026-10-18): the subjects stand apart in the master; the
  body file is split per subject (each connected piece to the nearest subject's centre, a piece holding two centres
  split by x) — one version per choice, only its subjects' layers.
- The doll's magenta never reaches a product (standard chroma-key clean-up, the same for every set): uncovered
  underwear in the body file is a dark shadow; a key-coloured pixel within 4 px of an option file's edge (the doll
  mixed into its outline) is dropped — a magenta / purple part itself is left alone.

## 9c. Hats and hair — the product stacks the files like 3c (2026-10-29 / 30)
- A file is cut to lie on the picture it was drawn on. The product keeps the cut's order: back hair → body → parts in
  the set's order → front hair. Changing that order shows exactly the pixels the upper file hid. (2026-10-29: the
  Santa hat moved over the hair showed the brim's shadow on the forehead — part of the outfit file — as a skin line.)
- Hair drawn UNDER a hat (slot on = the outfit): it lies over the whole outfit, the hat is never split out of it.
  Hair drawn on the bald doll with a hat over it (no on): the hat becomes its own layer over the hair.
- The hair fits only the hat band it was drawn under. Hats on one band (restyle): one hair slot. Hats of different
  shapes, or a theme without a hat: one hair slot per kind of head, each shownWhen its theme, the later ones
  sameAs the first — one picker for the customer, each theme its own files. Never an optional hat over hair drawn
  under it.
- A name on a brim follows the band of the hat shown with it (a text per hat shape, shownWhen its theme; one size per
  theme). Every name on a hat: text band true + box where the band is (measured on that hat's picture) — the band
  is found inside that box. Found on its own (no band: old sets only) it missed both the Santa cuff and the witch band.

## 9d. Same colour as its neighbour — draw it in a cut colour (2026-10-30)
- A part is cut by how its colour differs from what it lies on. Silver hair under a white fur brim, a white sleeve on
  a pale hand, a red hat on a red sweater: no edge to find, the file comes out with holes and ragged edges.
- Such a slot gets cutColor (#rrggbb): far from every neighbour, mid-light (the shading stays), never the doll's
  magenta nor a skin tone. Its 3b pictures draw the part in it (the server says so in the prompt); every colour the
  customer picks — the first one too — is a recolour of that clean file, to exactly its hex (the part's middle tone:
  take the hex from the part in the master). The master keeps the real colour.
- The same for every part with options: hat / hair, sweater / hat, hand / sleeve.

## 10. Checks before a set is used
- Every file of a slot has the same pixel size.
- Every option of a slot has the same box in the product (no per-item transform).
- The alpha of each option lies where the part belongs (compare its bbox with the slot's default option).
- Split parts: front ⊆ back (≥ 95% overlap); an empty back where nothing is behind.
- Linked slots: same group names, same counts, same order.
`;
