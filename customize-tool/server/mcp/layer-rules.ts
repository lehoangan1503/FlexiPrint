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
- Pictures (lib/char-plan.ts): base = the PAPER DOLL drawn from the master (every part the customer changes taken
  off: bald, flat magenta #D81BD8 tank top + shorts, empty hands) · EVERY option drawn ON the doll, in place (all
  options of a shape / texture part, the first option of a colour part — its other colours are recolours of that
  file) · zones painted magenta on the doll. No other picture. The doll is the canvas: fix the doll (legs, body) and
  every option is drawn again on it.
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

## 10. Checks before a set is used
- Every file of a slot has the same pixel size.
- Every option of a slot has the same box in the product (no per-item transform).
- The alpha of each option lies where the part belongs (compare its bbox with the slot's default option).
- Split parts: front ⊆ back (≥ 95% overlap); an empty back where nothing is behind.
- Linked slots: same group names, same counts, same order.
`;
