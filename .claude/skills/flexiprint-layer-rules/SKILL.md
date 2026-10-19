---
name: flexiprint-layer-rules
description: Use when building or changing anything in FlexiPrint that composes a design from swappable layers (character parts, hair back/front, linked options, clipart import/fit, region items) — strict pixel-registration rules that code and data must never break.
---

# Layered art — pixel-registration rules (mandatory)

Source of truth: `customize-tool/server/mcp/layer-rules.ts` (served to agents as `flexiprint://guide/layer-rules`).
Read it before touching layered-art code. Code consequences:

- Never auto-trim, auto-fit, re-centre or rescale a clipart by its alpha when it goes into a layer slot. Items of a
  slot share the slot's box; a per-item transform breaks registration.
- Files of one slot must have identical pixel size — validate on import and say which file differs.
- A part both behind and in front (hair) = two slots, same box; the back slot is LINKED to the front slot (follows
  its choice by group name + index), never a customer choice.
- Fixed z-order per product; an option never changes depth.
- Point / polygon outlines are for the product shape (khuôn vật liệu, cut lines) only — never for cutting character
  parts.
- AI-made parts: in-place edit on the master canvas, extract on that canvas; never generate standalone and scale in.

## Pixel lock — THE way a v2 character set is cut (approved by the user 2026-10-15: "cách này ngon, lưu vào system rule")

1. gpt-image draws ONE paper doll from the master (every part the customer changes taken off: bald, flat magenta
   #D81BD8 underwear, empty hands), then EVERY option of every part drawn ON that doll, in place, transparent
   background (a colour-only part: one drawing, its other colours are recolours of that file).
2. Each option is registered onto the doll (affine + local flow trusted where the warped picture matches, ≤ 8 px).
3. Body file = the doll, pixel for pixel. An option file = ONLY the pixels where its picture differs from the doll
   (colour ΔE > 12, or figure past the doll's outline), minus 1–2 px outline-shift lines, minus the magenta key (by
   hue), kept on its own subject's side of the doll, near its main piece. Doll + file = exactly that 3b picture.
4. Hair: back = the whole hair of its picture, front = the same pixels over the doll's figure (front ⊂ back).
5. A layer can only ADD to the doll: a picture that erased / moved doll pixels (check "lost") is drawn again.
6. Each picture adds exactly ONE part (no stole on the gown picture, no gown on the stole picture, pants never
   recolour the top). Thin parts on small figures (glasses on a family of five) are drawn bolder, never cut with a
   lower threshold.
7. A customer choice of who is in the picture (brief.lineup): subjects apart in the master, the body split per subject,
   one product version per choice. The doll's magenta is cleaned the same way for every set (body: shadow; option
   edges: dropped; magenta parts untouched).

Never: a segmentation model choosing edges (SAM), seeds/paint pictures, "unwrap" pictures, parts drawn alone and
fitted ("whole"), per-case post-processing heuristics (trim / grow / fill-by-colour / front_of …). Every one of those
was tried until 2026-10-14 and produced seams and clipart that did not match 3b. WHICH 3b pictures a set has is
planned by @flexiprint for that set (char_plan_pictures → brief.pictures, lib/char-pictures.ts, since 2026-10-19) —
never add product-type rules to lib/char-plan.ts (it is only the plan of older sets without one). A wrong file is fixed by drawing its
3b picture again (or by hand in the file editor) — not by another rule in the cut.

Background: research of macorner's dress-up products (2026-10-07). Every option file is the full master canvas;
hair = full "back" layer + "front" layer with the face/neck erased, the back one following the front choice.
