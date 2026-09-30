/**
 * Role-specific framing wrapped around the user's prompt.
 *
 * The user writes WHAT they want ("kawaii dumpling, rainbow glitter"); these
 * wrappers pin down HOW it must come out so the result drops straight into the
 * compositor: isolated, centred, flat backdrop that removeBackground() can cut,
 * and — for variants — the same framing as the parent so it stays registered.
 */

import type { CtAssetRole } from "../../types";

const PRINT_QUALITY =
  "Print-ready illustration quality: crisp clean edges, no blur, no noise, no watermark, no signature, no border, no frame.";

const FLAT_BACKDROP =
  "Place it on a perfectly flat, solid pure white (#FFFFFF) background with no gradient, no shadow, no floor and no reflection.";

export function buildPrompt(role: CtAssetRole, userPrompt: string, refCount: number, transparent: boolean): string {
  const backdrop = transparent ? "Use a fully transparent background." : FLAT_BACKDROP;
  const refs =
    refCount > 0
      ? `You are given ${refCount} reference image${refCount > 1 ? "s" : ""}; follow their subject, style and palette closely.`
      : "";

  switch (role) {
    case "main":
      return [
        "Create the MAIN artwork for a flat, die-cut acrylic ornament.",
        "The whole object must be fully visible, centred, filling about 85% of the frame, viewed straight-on.",
        refs,
        `Artwork: ${userPrompt}`,
        "Do not add any text unless the artwork description explicitly asks for it.",
        backdrop,
        PRINT_QUALITY,
      ]
        .filter(Boolean)
        .join("\n");

    case "sub":
      return [
        "Create ONE isolated decorative element (a sticker-like sub object) that will be layered onto another artwork.",
        "Only that single element, centred, filling about 80% of the frame. No other objects, no scenery, no text.",
        refs,
        `Element: ${userPrompt}`,
        backdrop,
        PRINT_QUALITY,
      ]
        .filter(Boolean)
        .join("\n");

    case "variant":
      return [
        "The FIRST reference image is the exact element to modify. Produce a new version of it.",
        "Keep EXACTLY the same canvas framing, object size, position, viewing angle, outline thickness, rendering style and lighting,",
        "so the new version can replace the original pixel-for-pixel in a layered design.",
        refCount > 1 ? "Further reference images are style guides only." : "",
        `Change: ${userPrompt}`,
        backdrop,
        PRINT_QUALITY,
      ]
        .filter(Boolean)
        .join("\n");

    case "mockup":
      return [
        "Create a professional, photorealistic e-commerce lifestyle photo.",
        refCount > 1
          ? `Show all ${refCount} provided products together in one shot, each clearly visible.`
          : "Show the provided product clearly as the hero of the shot.",
        "Each provided image is a finished printed design on clear acrylic: reproduce its artwork, colours and any text EXACTLY — do not redraw, restyle, translate or misspell it.",
        "Physically plausible: thin acrylic thickness at the cut edge, subtle reflections, soft realistic shadows, shallow depth of field.",
        `Scene: ${userPrompt}`,
      ].join("\n");

    case "reference":
    case "composite":
    case "rendition":
      return userPrompt;
  }
}
