/**
 * The sentence wrapped around every mockup scene (asked 2026-11-17: the mockup prompts out of the code, kept on the
 * product base). The base page shows the default one (defaultMockupWrap) and may keep its own (CtBaseMockup.wrap);
 * "" = the default. Placeholders: {product} = the piece's name, {scene} = one scene prompt.
 * Shared by the server (server/product-mockups.ts) and the base page (components/base/base-mockup-section.tsx).
 */

export const KEEP_PRINT =
  " The printed artwork on the product must stay EXACTLY as in the reference picture: the same characters, the same colours, " +
  "the same text letter for letter, the same size and position on the product. Do not redraw, restyle, crop or change the print. " +
  "Photorealistic product photography, natural soft light.";

/** A clear glass piece (lib/materials "glass_clear", asked 2026-10-28: a round glass ornament, not acrylic, its edge
 * cut in facets like a diamond) — said in the phôi and mockup prompts, or the model draws frosted acrylic. */
export const GLASS_LOOK =
  "made of thick, perfectly clear crystal glass (not acrylic, not frosted): see-through where nothing is printed, its rim cut in many small bevelled facets like a diamond that sparkle and refract the light";

/**
 * A clear acrylic phôi (lib/materials "acrylic_clear", asked 2026-11-13: "phôi phải thật sự trong suốt và clean"): the
 * print is pasted flat on it, so a frosted / milky face or a glare streak shows around and through the preview.
 */
export const CLEAR_ACRYLIC_LOOK =
  "perfectly clear, colourless, glossy see-through acrylic like clean window glass: NOT frosted, NOT milky, NOT hazy, no texture — what is behind it shows through sharp and unchanged; NO glare, reflection, light streak or highlight anywhere across its face — only its thin cut edge catches a fine line of light";

export function isGlass(material: string | undefined, label = ""): boolean {
  return material === "glass_clear" || /\b(glass|crystal)\b|kính|thuỷ tinh|thủy tinh|pha lê/i.test(label);
}

/** Most reference pictures (besides the product's own front picture) sent with each mockup. */
export const CT_MOCKUP_REFS_MAX = 4;

/** Well-formed reference urls (https, no repeats, at most CT_MOCKUP_REFS_MAX). */
export function mockupRefList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const urls = raw.filter((u): u is string => typeof u === "string" && /^https:\/\/\S+$/.test(u.trim()) && u.length <= 1000).map((u) => u.trim());
  return [...new Set(urls)].slice(0, CT_MOCKUP_REFS_MAX);
}

export interface CtMockupLook {
  /** The piece's name (the khuôn's, else the product's). */
  piece: string;
  materialId: string;
  /** Die-cut acrylic (cut along the artwork). */
  dieCut: boolean;
  /** The front picture is the print on a real phôi photo (its material comes from the photo). */
  fromPhoi: boolean;
}

/** The default wrap for a piece like that, with {product} and {scene} left in. */
export function defaultMockupWrap(o: CtMockupLook): string {
  // A die-cut acrylic is named by what it is (the khuôn's name is the team's Vietnamese one).
  const what = o.dieCut
    ? `${o.materialId === "acrylic_white" ? "white-backed" : "clear"} acrylic ornament, die-cut along the artwork's outline with a thin clear border, a small round clear tab with a hole at the top centre, hung by a gold cord through that hole`
    : "{product}";
  // With a phôi photo the reference already shows the real piece: its material comes from it, never from the name
  // (2026-11-12: base "Round Window Hanging Stained Glass" — a FROSTED glass phôi — came out as clear faceted crystal
  // because the name has "Glass" in it). Without a phôi (art on white), the clear-glass words are still said.
  const glass = !o.dieCut && !o.fromPhoi && isGlass(o.materialId, o.piece);
  const keepLook = o.fromPhoi
    ? " The product's material, colour, surface texture and finish (frosted / sandblasted, clear, matte, glossy, wood grain…), its rim / edge and any chain, hook or hanger are EXACTLY as in the reference picture: do not make it clearer, shinier or more transparent, do not add facets, bevels or sparkle it does not have."
    : "";
  return `Square lifestyle product photo of this exact ${what}${glass ? `, ${GLASS_LOOK}` : ""} {scene}.${keepLook} The product is shown as a real physical object in a fitting, beautiful setting (the finished product with any hanger, ribbon or stand it would really have). The WHOLE product is in the picture, centred and big — about 70 % of the picture's width — with clear empty space between it and all four edges of the picture: no part of it (its ends, its edges, its tab) is cut off or touches the frame.${o.dieCut ? " The acrylic is glossy and see-through where nothing is printed, its cut edge catching the light." : ""}${KEEP_PRINT}`;
}

/**
 * The prompt sent for one scene: the wrap with its placeholders filled (a wrap without {scene} gets the scene after
 * it), and — with reference pictures — the sentence that says which picture is which.
 */
export function fillMockupWrap(wrap: string, piece: string, scene: string, refs: number): string {
  let out = wrap.split("{product}").join(piece);
  out = out.includes("{scene}") ? out.split("{scene}").join(scene) : `${out.trim()} Setting: ${scene}.`;
  if (refs > 0)
    out += ` Picture 1 is the product itself (keep it and its print exactly). Picture${refs > 1 ? "s" : ""} ${refs > 1 ? `2–${refs + 1}` : "2"} ${refs > 1 ? "are" : "is"} only a reference for the setting, styling, light and mood of the photo: follow ${refs > 1 ? "them" : "it"}, but never copy any product, print, text or logo from ${refs > 1 ? "them" : "it"}.`;
  return out;
}
