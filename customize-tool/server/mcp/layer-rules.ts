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
  canvas (difference / alpha). Never generate a part alone and scale it into the slot.

## 9a. Key mode — one AI picture per clipart (every new project, asked 2026-10-10)
- The master is drawn on a TRANSPARENT background (gpt-image background "transparent"): step 3a takes its own alpha.
- Each clipart is ONE picture made from the master: the part kept as drawn, everything else of every character a
  flat magenta (#FF00FF) silhouette with no lines, the background transparent. The file = that picture's non-magenta
  pixels — its colours and its cut line come from the SAME picture, so nothing of a neighbour sticks to the edge
  (painting a region on one picture and taking the pixels from another left skin on hair, cardigans and glasses).
- Ask "turn EVERYTHING magenta except the <part>", naming every other part with its colour. Never ask for a part
  alone on an empty canvas: the model then invents a new part anywhere — the silhouettes are what hold it in place.
- Every clip is made FROM THE MASTER, options too ("take OFF the wrap dress, give her a completely different skater
  dress — no belt, no bow …, then everything magenta except it"). Drawn on the transparent paper doll the model
  re-framed the figures ~10 % bigger and moved the arms (a mug beside the hand); "replace with X" alone kept the old
  garment's details.
- The body is the PAPER DOLL (every changeable part removed, skin-tone bodysuit, empty hands) drawn transparent and
  used as it is — nothing is cut from it. Word it as a "family-friendly paper-doll dress-up base" (a plain "remove
  her dress" is refused by the safety filter).
- Placement: layer-kit registers each clip by its silhouette on the master's (ECC on the alphas, the part itself
  left out; an ECC that wanders off is dropped), and fits a master part's colours back to the master. The magenta is
  strict (#FF00FF ± a few levels, + its shaded edge within 5 px): purple / lilac / pink garments are never keyed out.
- Checks: "ráp lại = master" allows ~2–3 px (every file is the model's own re-drawing); a clip placed more than that
  off is flagged "Khớp clipart … làm lại".
- A picture asked transparent that comes back with a painted background (checkerboard / white) is refused and
  drawn again.

## 9b. The cut follows the AI-painted regions (bước 3b — asked 2026-10-10; paint mode, older projects)
- Step 3b ("AI tô vùng clipart") makes, on the approved master, one in-place picture per clipart: the part painted
  flat magenta (its exact region), or another shape / colour / material drawn in place. Those pictures ARE the cut:
  a part's file is cut by its painted region (or by its own picture against the base), never guessed from the
  master alone. A region that comes out wrong is fixed by painting that picture again, not by cutting looser.
- "Tạo bộ custom" (3c) = cut every clipart from those regions → the cliparts in the product's library folder → ONE
  finished product built from them, ready in the editor (it replaces the set's previous product).

## 10. Checks before a set is used
- Every file of a slot has the same pixel size.
- Every option of a slot has the same box in the product (no per-item transform).
- The alpha of each option lies where the part belongs (compare its bbox with the slot's default option).
- Split parts: front ⊆ back (≥ 95% overlap); an empty back where nothing is behind.
- Linked slots: same group names, same counts, same order.
`;
