/**
 * Customize Tool — domain types.
 *
 * Vocabulary (kept identical in DB, API and UI):
 *
 *   CtProduct   one customizable product (the "big record"). Owns everything
 *               below through foreign keys.
 *   main asset  the base artwork the product is built on (ct_products.main_asset_id).
 *   region      a custom zone drawn on the main asset (rect / ellipse / polygon).
 *               kind "image" hosts sub objects, "text" takes customer text,
 *               "photo" takes a customer upload.
 *   sub asset   an object placed into an image region (e.g. "glasses").
 *   variant     a version of a sub asset (e.g. "black sunglasses"); parent_id
 *               points at the sub asset.
 *   composite   a flattened render of one combination, used as AI input for
 *               mockups.
 *   mockup      an AI-generated marketing image (often several products in one shot).
 *   rendition   an AI material version of a clipart (acrylic, glitter…): same
 *               silhouette and size, shown on the storefront instead of the flat art.
 *
 * Cliparts (main / sub / variant / rendition) live in the global LIBRARY when
 * product_id is NULL (migration 006): grouped by ct_clipart_categories and
 * reused by any product through region items and ct_product_mains.
 *
 * All geometry is in MAIN-ASSET PIXELS, so a design survives zooming/panning in
 * the editor and renders identically at any output scale.
 */

export type CtProductStatus = "draft" | "ready" | "archived";

export type CtAssetRole = "main" | "sub" | "variant" | "rendition" | "composite" | "mockup" | "reference";

/** Where a clipart came from (licensing: stock art needs its license noted). */
export type CtAssetSource = "upload" | "ai" | "stock";

export type CtRegionKind = "image" | "text" | "photo";

export type CtGenerationStatus = "pending" | "succeeded" | "failed";

export type CtAiProviderId = "gemini" | "openai";

/** Provider recorded on ct_generations rows: editor providers + the ComfyUI studio. */
export type CtGenerationProvider = CtAiProviderId | "comfy";

/**
 * How a group of options is shown to the customer:
 *   image     tiles with the option picture (dumpling colours, glasses)
 *   swatch    colour dots (asset.meta.swatch), falling back to the picture
 *   button    text chips (GLITTER / NO GLITTER)
 *   dropdown  a select (Choose Quote, Choose State)
 */
export type CtOptionDisplay = "image" | "swatch" | "button" | "dropdown";

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface CtPoint {
  x: number;
  y: number;
}

export interface CtRectShape {
  type: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
  /** Corner radius in px. */
  radius: number;
}

export interface CtEllipseShape {
  type: "ellipse";
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export interface CtPolygonShape {
  type: "polygon";
  points: CtPoint[];
}

export type CtShape = CtRectShape | CtEllipseShape | CtPolygonShape;

export interface CtBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where an item sits inside its region. Relative to the region's bounding box
 * so resizing a region carries its content along:
 *   offsetX/offsetY  centre offset as a fraction of bbox w/h (0 = centred)
 *   scale            1 = "contain" fit into the bbox
 *   rotation         degrees
 */
export interface CtTransform {
  offsetX: number;
  offsetY: number;
  scale: number;
  rotation: number;
}

// ---------------------------------------------------------------------------
// Region config (per kind)
// ---------------------------------------------------------------------------

export type CtTextAlign = "left" | "center" | "right";

export interface CtTextConfig {
  label: string;
  placeholder: string;
  defaultText: string;
  maxChars: number;
  fontFamily: string;
  fontWeight: number;
  /** Font size in main-asset px; auto-shrinks to fit the region width. */
  fontSize: number;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  align: CtTextAlign;
  letterSpacing: number;
  /** -100..100 — bends the baseline into an arc; 0 = straight. */
  curve: number;
  /** With a curve: the arc's radius as a share of the zone's width — the letters follow THAT circle whatever the text's
   * length (a name on a hat's brim follows the brim, server/char/product.ts brimArc); only the sign of `curve` counts
   * then. Absent: the radius follows the text (|curve| = the sweep, 100 = half a circle). */
  arcRadius?: number;
  /** With a curve: the arc turned by this many degrees (clockwise) about the zone's centre — a brim on a tilted head. */
  arcTilt?: number;
  uppercase: boolean;
  /** Preset texts (mode "list"): the customer picks one from a dropdown. */
  choices: string[];
  /**
   * What the customer does with the zone:
   *   input    types the text (defaultText as a start)            — the usual
   *   fixed    nothing: defaultText is drawn as designed (no field)
   *   list     picks one of `choices`
   *   options  picks one of the zone's options (CtRegionConfig.options, swatches / buttons); each option draws its
   *            own text (`value`) and lettering and may open child zones (text / custom layer / photo upload)
   * Absent (older zones) = "list" when there are choices, else "input".
   */
  mode?: CtTextMode;
  /** Mode "input": what the customer types — free text, or a date the field formats as dd/mm/yyyy. Absent = "text". */
  format?: CtTextFormat;
}

export type CtTextMode = "input" | "fixed" | "list" | "options";
export type CtTextFormat = "text" | "date";

/**
 * Free (no-AI) photo styles. "original" keeps the photo; "pixel" is a local
 * canvas filter. lib/photo-styles.ts has the catalog.
 */
export type CtPhotoStyleId = "original" | "pixel" | "face" | "face_bw" | "face_sepia" | "face_vivid" | "face_warm";

/**
 * Which kind of styles a photo zone offers — the inspector's tabs. Families never mix:
 *   free  no-AI filters ("original", "pixel"), customer picks
 *   ai    one or more AI styles (each with a demo picture), customer picks
 *   face  face-detect crop + colour filter ("face*"), customer picks
 */
export type CtPhotoMode = "free" | "ai" | "face";

/** An AI style from the global library (ct_ai_styles), as a zone offers it: "ai:<uuid>". */
export type CtAiStyleRef = `ai:${string}`;

/** Any style a photo zone can offer. */
export type CtPhotoStyleRef = CtPhotoStyleId | CtAiStyleRef;

/** The model an AI style runs on: always the team's image model (lib/image-models CT_IMAGE_MODEL, asked 2026-10-12 /
 * 2026-10-15 — no fal, no Nano Banana, no picker). Older rows' fal ids read as it. */
export type CtAiStyleModelId = "cpa:gpt-image-2.5";

export interface CtAiStyleParams {
  /** Output shape: square, or follow the photo. */
  aspect: "1:1" | "auto";
  /** Cut the subject out of the AI result even if the zone's cut-out is off (the model is asked for alpha; the
   * bg-remover runs when it hands back an opaque picture). */
  removeBackground: boolean;
  /** The style run on a sample photo — the picture the editor and the customer pick the style by ("" = none yet). */
  demoUrl: string;
  /** The sample photo that demo was made from. */
  demoSourceUrl: string;
  /** Style reference pictures sent after the customer's photo (image 2, 3…; ≤ 3) — like a studio prompt "Image 1 is
   * the customer's photo, image 2 is the style reference". */
  refUrls: string[];
  /** The bộ ảnh khách the style was made for ("" = a library style): listed with that set, run like any other. */
  setId: string;
}

/** A row of ct_ai_styles, as the editor sees it. Never sent to the storefront. */
export interface CtAiStyle {
  id: string;
  user_id: string | null;
  name: string;
  prompt: string;
  model: CtAiStyleModelId;
  params: CtAiStyleParams;
  sort_order: number;
  created_at: string;
  updated_at: string;
  /** Owner's nickname / email; "Built-in" for user_id NULL. */
  owner: string;
  /** The signed-in user may edit / delete it (owner or admin). */
  can_edit: boolean;
}

export interface CtAiStyleBody {
  name: string;
  prompt: string;
  model: CtAiStyleModelId;
  params: CtAiStyleParams;
}

/** What the published template says about an AI style: its name and demo picture (prompt/model stay on the server). */
export interface CtPublicAiStyle {
  ref: CtAiStyleRef;
  name: string;
  /** The style's demo picture (params.demoUrl), shown on the customer's style tile. */
  demoUrl?: string;
}

/**
 * The photo's own frame inside a photo zone. The zone's shape stays the mask;
 * this frame is where the customer's photo is fitted — moved, resized (any
 * aspect) and turned freely without deforming the zone. Centre offset and size
 * are fractions of the zone's bounding box; `rotation` (degrees, clockwise) is
 * the zone's tilt: a helmet set at an angle → Face photos, which come back
 * upright, are turned to match.
 *
 * `auto` (Face zones by default): the numbers are ignored and the frame is
 * worked out per photo (lib/geometry.ts autoPhotoFrame) — turned by the
 * zone's tilt, centred on the circle that encloses the zone's outline, the
 * photo (the trimmed face, upright) contain-fitted into that circle's square
 * grown 15 % on every side so the rounded face covers the whole zone, plus a
 * small margin around the photo. Moving the frame by hand turns `auto` off
 * with the frame as it was.
 *
 * Per main version: a version with its own layout keeps its own frame
 * (CtRegionOverride.frame) — a helmet that sits elsewhere tilts elsewhere.
 */
export interface CtPhotoFrame {
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  auto: boolean;
  /**
   * The ZONE's tilt (degrees, clockwise) that an auto frame turns by; null =
   * read from the outline (lib/geometry.ts orientedBox — a quad drawn on a
   * tilted helmet). Face photos come back upright (eye line level), so this is
   * the angle the face ends up at.
   */
  tilt: number | null;
  /** Empty margin inside the frame around the photo, as a fraction of the frame's shorter side (0 = the photo touches the frame). */
  padding: number;
  /**
   * The zone has a child frame (a sub-layer under it in Layers). Off — deleted
   * from there — the photo simply fits the zone's box, upright; the zone stays.
   */
  enabled: boolean;
}

export interface CtPhotoConfig {
  label: string;
  fit: "cover" | "contain";
  /** Customer must upload before adding to cart. */
  required: boolean;
  /** Styles offered to the customer (free ids and "ai:<id>"), in picker order. One entry = no picker, that style is applied. */
  styles: CtPhotoStyleRef[];
  /** Pre-selected style (must be in `styles`). */
  defaultStyle: CtPhotoStyleRef;
  /** Label above the style picker ("Choose Style"). */
  styleLabel: string;
  /** The tab the editor picked; absent = none yet (the test upload asks for one). Inferred from `styles` for older zones. */
  mode?: CtPhotoMode;
  /** Where the photo goes inside the zone (identity = the zone's box, upright). */
  frame: CtPhotoFrame;
  /** Cut the subject out of its background (pet / person), then trim to it. */
  cutout: boolean;
  /**
   * With cutout: where the photo frame crops the subject (a body cut off at the
   * bottom), fade it out softly instead of ending in a straight line, so it
   * blends into the product artwork.
   */
  fadeCrop: boolean;
  /**
   * A sample of what a customer's photo becomes (a bộ ảnh khách: the pet of the master, alone, in the style): shown
   * in the zone until the customer uploads theirs — the editor, the storefront preview, the mockups. Never printed
   * for an order (the zone is required).
   */
  sampleUrl?: string;
}

/**
 * An image ("Object") zone holds one or more GROUPS. A group is one placed sub
 * asset (a ct_region_items row): its options are the sub itself followed by
 * its variants, and they all share the item's transform. With two groups the
 * customer first picks the group ("Choose Style": Glitter / No Glitter), then
 * the option inside it ("Choose Dumpling"); switching group keeps the option
 * position, so "blue glitter" becomes "blue no-glitter".
 */
export interface CtImageConfig {
  /** Label above the options ("Choose Dumpling"). */
  label: string;
  display: CtOptionDisplay;
  /** Label above the groups; only shown when the zone has 2+ groups ("Choose Style"). */
  groupLabel: string;
  groupDisplay: CtOptionDisplay;
  /** itemId -> customer-facing group name (defaults to the sub asset's name). */
  groupNames: Record<string, string>;
  /** Options not offered to customers (e.g. an AI base image). */
  hiddenAssetIds: string[];
  /**
   * Library pictures offered inside a group that are not the gốc's own đa sắc (a đa sắc of a vật liệu version):
   * picture id -> the group's sub asset id. The product reads them as variants of that sub.
   */
  extraOptions: Record<string, string>;
  /** The option customers see first (clicked in the inspector); null / no longer offered = the first group's first option. */
  defaultAssetId: string | null;
  /** Storefront may show "None" for this region. */
  allowNone: boolean;
  /** With allowNone: the customer starts on "None" (glasses: NO first — asked 2026-10-18). */
  defaultNone?: boolean;
  /**
   * Linked layer (server/mcp/layer-rules.ts §6): this layer is not a customer choice — it shows the option at the
   * same group / option position as layer `follows` shows (the back half of a hairstyle follows the front half).
   * Its groups must mirror the leader's: same names, same counts, same order.
   */
  follows?: string;
}

export interface CtRegionConfig {
  /**
   * Hide whatever falls outside the zone outline. Off lets e.g. a hat overflow
   * its anchor zone; on keeps a customer photo inside a round frame.
   */
  clip: boolean;
  /**
   * Layer above the main artwork (true) or behind it (false). Behind only
   * shows through transparent parts of the main image — a photo seen through
   * a frame's cut-out window.
   */
  aboveMain: boolean;
  /**
   * The main version this layer belongs to: every version has its own set of
   * layers (a new version starts empty). Absent = shown on every version
   * (layers made before versions had their own — the editor splits them on load).
   */
  mainId?: string;
  image: CtImageConfig;
  text: CtTextConfig;
  photo: CtPhotoConfig;
  /** Text / photo zones: sub-options the customer picks in a second row ("Thêm option con", like a main version's). */
  options: CtZoneOptions;
  /** A child zone: only there while its parent shows one option (CtZoneParent). */
  parent?: CtZoneParent;
  /**
   * Custom layers: this layer's outline is the product's fixed shape (a round ornament, a pair of trousers) — the
   * "khuôn vật liệu". The print file is cut to it, and a vật liệu made "theo khuôn" is the clipart cut to it (minus
   * `cuts`) — every clipart of the khuôn gives a vật liệu of exactly the same size. One per version.
   */
  materialFrame?: boolean;
  /** Khuôn vật liệu: parts cut out of the piece (a hanging hole), artboard px. */
  cuts?: CtShape[];
  /**
   * Khuôn vật liệu drawn as a picture (a khuôn in face, types/print.ts CtPrintFace): alpha = printed, artboard size.
   * When set it is what the print file is cut to (the shape is then the whole artboard).
   */
  maskUrl?: string | null;
  /** Its cut line + safe zone, drawn over the canvas in the editor (artboard size, transparent). */
  guideUrl?: string | null;
  /**
   * Image layer that FILLS its outline instead of placing a picture in it (types/print.ts): a pattern repeated over
   * a pair of trousers' legs, a background covering the whole piece. `zone`: the khuôn in zone it follows — each
   * size of the piece draws it in that size's zone.
   */
  fill?: CtFillConfig;
  /**
   * Drawn in the print file only, never on the product photo (mockup): the background the photo already shows —
   * each of its options shows its own mockup (CtProductConfig.mockupsByOption).
   */
  printOnly?: boolean;
}

/** How a fill layer covers its outline. */
export interface CtFillConfig {
  /** tile: the picture repeated, `tile` px wide · cover: one picture covering the outline (cropped). */
  mode: "tile" | "cover";
  /** Tile width in canvas px (tile mode). */
  tile: number;
  /** The khuôn in zone this layer fills (types/print.ts CtPrintZone.id). */
  zone?: string;
}

/**
 * Sub-options of a customer zone (text or photo), the way a main version has its own ("Thêm option"): the zone
 * itself is the first choice (`baseName`), then `list`. A choice changes how the zone looks, not what the customer
 * types / uploads: a text option its lettering (font, colours…), a photo option its frame's shape (circle / heart).
 * Empty `list` = no second row.
 */
export interface CtZoneOptions {
  /** Label above the row ("Choose color"). */
  label: string;
  display: CtOptionDisplay;
  /** The zone's own look, offered first ("Gold"). */
  baseName: string;
  /** Swatch of the zone's own look (display "swatch"). */
  baseSwatch?: string;
  /** Text mode "options": what the zone's own option draws (default: baseName). */
  baseValue?: string;
  list: CtZoneOption[];
}

/** Option id of a zone's own look (its first choice) in CtZoneParent.optionId. */
export const CT_BASE_OPTION = "base";

/**
 * A child zone ("option con" of an option): drawn and asked only while its parent zone shows that option — a text
 * zone's option (or its own look, CT_BASE_OPTION), or a custom layer's picture (asset id). Children nest: a child
 * can have children of its own.
 */
export interface CtZoneParent {
  regionId: string;
  optionId: string;
}

/** Lettering a text sub-option overrides (the rest — label, choices, max chars — stays the zone's). */
export type CtZoneTextStyle = Partial<
  Pick<CtTextConfig, "fontFamily" | "fontWeight" | "fontSize" | "color" | "strokeColor" | "strokeWidth" | "letterSpacing" | "curve" | "uppercase" | "align">
>;

export interface CtZoneOption {
  id: string;
  name: string;
  swatch?: string;
  /** Text zones: lettering of this option. */
  text?: CtZoneTextStyle;
  /** Photo (or text) zones: the zone's outline for this option, main px. */
  shape?: CtShape;
  /** Text mode "options": the text this option draws (default: its name; "" = nothing). */
  value?: string;
}

// ---------------------------------------------------------------------------
// DB rows
// ---------------------------------------------------------------------------

export interface CtAsset {
  id: string;
  user_id: string;
  /** NULL = library clipart (shared by every product). */
  product_id: string | null;
  role: CtAssetRole;
  parent_id: string | null;
  generation_id: string | null;
  name: string;
  url: string;
  storage_path: string;
  width: number;
  height: number;
  mime: string;
  meta: CtAssetMeta;
  sort_order: number;
  created_at: string;
  /** Library category (migration 006); null for product-only assets. */
  category_id: string | null;
  /** The clipart's own description / prompt. */
  spec: string;
  tags: string[];
  source: CtAssetSource;
  license: string;
}

export interface CtCharFileFx {
  flip?: boolean;
  part?: "hat" | "rest";
  /** server/char/behind.ts: the file inside ("in", the back layer) or outside ("out") this mask (unflipped url). */
  behind?: { url: string; keep: "in" | "out" };
}

export interface CtAssetMeta {
  /** A product's canvas made from a khuôn in (server/print-products.ts): a transparent sheet. */
  printSheet?: boolean;
  /** A library artwork (saved from a product): what it was made of, to open / reuse it. */
  artwork?: CtArtworkMeta;
  /** For composites: which variant/text was chosen per region. */
  selection?: CtSelection;
  /** Colour shown when the option group uses the "swatch" display. */
  swatch?: string;
  /** Asset this one was derived from by an editor tool (e.g. background removal). */
  derivedFrom?: string;
  /** Copied from a bộ nhân vật layer file (ct_char_images id): replaced when that file is fixed. */
  charLayerId?: string;
  /** How the product made it from that file (a pose set's file in its parent's product): flopped (the pose placed on
   * the other side) and / or only the hat or the rest of a headwear outfit. Applied again when the file is fixed. */
  charFx?: CtCharFileFx;
  note?: string;
  /** Renditions: the material preset it was rendered with. */
  material?: string;
  /** Renditions: the material version it is ("có dây"); absent = the base version. */
  materialVersion?: string;
  /**
   * Renditions drawn on a larger canvas than their clipart (the acrylic plate, a cord reach outside it): the
   * extra room on each side as a fraction of the clipart's width (x) / height (y). The clipart's own pixels sit
   * exactly at (pad.x·w, pad.y·h) inside it.
   */
  pad?: CtRenditionPad;
  /**
   * Renditions made "theo khuôn": the clipart cut to a product's khuôn vật liệu (CtRegionConfig.materialFrame) —
   * used by that product only, drawn over the khuôn's box (pad around it) instead of the clipart's frame.
   */
  frame?: CtRenditionFrame;
  /** AI-made set members / renditions: silhouette match against the parent (1 = identical). */
  iou?: number;
  /** Set members: how it was made from its origin (the variant line) — a fixed origin remakes it the same way. */
  variant?: CtAssetVariantLine;
  /** Tổ hợp (mockup made in the editor): the scene it was rendered from — open it again, or put it in a set. */
  scene?: CtPackSlide;
  /** Main versions in the template: the flat clipart for the option swatch (url may be the material version). */
  thumb?: string;
  /**
   * A picture recoloured with "Sửa nhanh → Đổi màu": the picture it had before the first recolour (its file is kept),
   * so "Màu gốc" can bring it back. null = cleared.
   */
  colorSource?: CtColorSource | null;
}

/**
 * A finished design saved into the product's folder (server/artworks.ts): one per version, updated when the design is
 * saved — or an extra one saved by hand ("Lưu thành artwork mới", no version).
 */
export interface CtArtworkMeta {
  productId: string;
  selection: CtSelection;
  templateId: string | null;
  /** The main version it is the artwork of; absent = an extra one. */
  versionId?: string;
  /** What it was rendered from (layers + content): the same again = not uploaded again. */
  hash?: string;
}

/** What a library category shows: its cliparts, or the finished artworks saved into it. */
export type CtLibraryShelf = "clipart" | "artwork";

/** GET products/:id/artworks — the product's folder and the artworks in it. */
export interface CtProductArtworks {
  category: CtClipartCategory | null;
  artworks: CtAsset[];
}

export interface CtColorSource {
  url: string;
  /** Its variant line back then (a đa sắc). */
  variant?: CtAssetVariantLine;
}

export interface CtRenditionPad {
  x: number;
  y: number;
}

export interface CtRenditionFrame {
  productId: string;
  /** The khuôn layer it was cut to. */
  regionId: string;
  /** The khuôn's box on the artboard when it was made (artboard px) — used if the layer is gone. */
  box: CtBounds;
}

/**
 * A clipart cut to a khuôn vật liệu, for FP_FrameClipart: the output canvas (w × h px), where the clipart lands
 * on it (its version frame, turned about its centre), the khuôn outline and the parts cut out — all canvas px.
 * Same khuôn = same canvas, whichever clipart.
 */
export interface CtFrameCut {
  w: number;
  h: number;
  art: CtMainFrame;
  clip: [number, number][];
  cuts: [number, number][][];
}

export interface CtAssetVariantLine {
  /** "#rrggbb" / colour name (recolour) or the change for the AI. */
  text: string;
  /** Omitted = auto (a colour → recolour, else AI). */
  mode?: "recolor" | "ai";
}

export interface CtRegion {
  id: string;
  product_id: string;
  name: string;
  kind: CtRegionKind;
  shape: CtShape;
  config: CtRegionConfig;
  sort_order: number;
}

export interface CtRegionItem {
  id: string;
  region_id: string;
  /** A sub asset. Its variants are the choices a customer sees. */
  asset_id: string;
  transform: CtTransform;
  is_default: boolean;
  sort_order: number;
}

/**
 * The main object can itself be an option: every main asset is a VERSION
 * (colour of the plate, material of the ornament). The customer picks one and
 * the zones are drawn on top of it, so versions should share the default
 * main's pixel size (a mismatched one is stretched onto it).
 */
export interface CtMainOptionConfig {
  enabled: boolean;
  label: string;
  display: CtOptionDisplay;
  /**
   * Sub-options of a version ("Thêm option"): other pictures of it (đa sắc) the customer picks in a second row
   * once the version is chosen — the version itself first, then these. They share the version's layers and
   * config; only the picture changes. In the bundle / template they read as role "variant", parent = the version.
   */
  subOptions: CtMainSubOptions[];
}

export interface CtMainSubOptions {
  /** The version (main asset id). */
  mainId: string;
  /** Library cliparts, in picker order (the version itself is not listed). */
  ids: string[];
}

/**
 * LEGACY — every main version now has its own layers (CtRegionConfig.mainId);
 * the editor turns these overrides into per-version copies on load. Still
 * read for templates published before that.
 *
 * Per-main-version layout: a main version ("1 person", "2 people", or a car
 * whose helmet sits elsewhere) can move / reshape / hide zones and move the
 * objects inside them. Anything not overridden inherits the base layout (the
 * zones as drawn). Keyed by zone / item id.
 */
export interface CtRegionOverride {
  shape?: CtShape;
  /** Photo zones: this version's own child frame (position, size, tilt) — CtPhotoConfig.frame. */
  frame?: CtPhotoFrame;
  /** Zone not used by this version: not drawn, not in the customer form. */
  hidden?: boolean;
}

export interface CtMainLayout {
  regions: Record<string, CtRegionOverride>;
  items: Record<string, CtTransform>;
  /**
   * The version's own picture as a frame on the artboard (the edit canvas = the default main's size, never
   * resized): moved / resized / turned like a layer. Absent = it fills the artboard.
   */
  frame?: CtMainFrame;
}

/** Box of a main version's picture on the artboard, artboard px; rotation in degrees (clockwise) about its centre. */
export interface CtMainFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
}

/**
 * The physical product the design is printed on (lib/materials.ts) — drives
 * the print files (services/material-render: print.png, white ink, cut.svg).
 * The LOOK of a material is a rendition picture of each clipart (uploaded in
 * /library), not simulated here.
 *   none            flat artwork, as designed
 *   acrylic_white   cut acrylic with a white backing (car visor clip, standee)
 *   acrylic_clear   clear acrylic — the scene shows through the plate border
 *   ceramic_gloss   glazed porcelain (round ornament) — glossy highlight
 *   ceramic_matte   unglazed / matte porcelain
 *   aluminum        printed metal sheet
 *   wood            printed / engraved wood
 */
export type CtMaterialId = "none" | "acrylic_white" | "acrylic_clear" | "glass_clear" | "ceramic_gloss" | "ceramic_matte" | "aluminum" | "wood";

/**
 * Where the plate outline comes from:
 *   contour  cut along the design's own silhouette + a border (acrylic cut-to-shape)
 *   main     the main asset IS the blank (white ceramic disk): its alpha is the plate,
 *            and every layer is printed onto it (clipped to it)
 */
export type CtMaterialShape = "contour" | "main";

/**
 * What the storefront shows:
 *   flat       the cliparts as drawn
 *   rendition  each clipart's AI material version (library "rendition", same
 *              silhouette + size) where one exists — acrylic / glitter look.
 * Print files always use the flat art.
 */
export type CtMaterialDisplay = "flat" | "rendition";

export interface CtMaterialConfig {
  id: CtMaterialId;
  shape: CtMaterialShape;
  /** Physical width of the main artwork, mm — converts the mm settings below to pixels. */
  widthMm: number;
  /** contour: margin of plate around the design, mm. */
  borderMm: number;
  /** Plate thickness, mm (acrylic 3 mm; 0 = none) — goes into the print meta. */
  thicknessMm: number;
  display: CtMaterialDisplay;
  /**
   * display "rendition": cliparts drawn FLAT anyway — their material version is switched off for this
   * product (the library card's "vật liệu" toggle when the clipart was dragged in).
   */
  flatIds: string[];
  /**
   * display "rendition": which material version the product shows ("có dây"; "" = the base version). A clipart
   * without that version shows its base one.
   */
  version: string;
}

export interface CtProductConfig {
  main: CtMainOptionConfig;
  /** Storefront / editor display: a background photo with the design placed on it. */
  scene: CtProductScene;
  /** Main asset id -> its own layout (absent = uses the base layout). */
  layouts: Record<string, CtMainLayout>;
  material: CtMaterialConfig;
  /**
   * The design's own content (Thiết kế tab): what is chosen / typed / uploaded
   * in every version's layers — photos as stored URLs. The Tổ hợp frames draw
   * it, so a version dragged in is the finished artwork. Never published: the
   * storefront template leaves it out (customers bring their own).
   */
  samples: CtSelection;
  /** "Mockup edit" (Tổ hợp tab): the storefront canvas shows this scene with the live design in its product frames. */
  mockupEdit: CtMockupEdit | null;
  /** The khuôn in the product was made on (a copy, types/print.ts); null = a product drawn on its own picture. */
  print: CtProductPrint | null;
  /**
   * The product photo per option of a print-only layer (a background colour): layer id → option asset id → scene.
   * The storefront shows that photo with the design (minus print-only layers) placed on it.
   */
  mockupsByOption: Record<string, Record<string, CtProductScene>>;
  /** Product photos that recolour named zones (clothes): see CtZoneMockup. */
  zoneMockups: CtZoneMockup[];
}

/**
 * A product photo whose named zones are repainted with what the customer picks (trousers on a table): each zone of
 * the khuôn in has its outline on the photo; a fill layer's pattern is drawn into it and the photo's own light and
 * folds are multiplied back over it (lib/zone-mockup.ts). No flat print file is bent onto the photo.
 */
export interface CtZoneMockup {
  id: string;
  name: string;
  url: string;
  width: number;
  height: number;
  /** khuôn zone id → its outline on the photo (photo px). */
  zones: Record<string, CtShape>;
  /** Pattern tile width on the photo, px (how big the print looks on it). */
  tile: number;
  /** How strongly the photo's shading shows through (0–1). */
  shading: number;
}

/**
 * A tổ hợp used as the customer's editing canvas: its scene (background, hands, props…) with every product frame
 * showing the LIVE design instead of the rendered product — the competitor's "ornament on the tree" preview.
 * Frame k shows design k of a pack (wrapping); with one design every frame shows it.
 */
export interface CtMockupEdit {
  /** The tổ hợp (mockup asset) it was made from. */
  assetId: string;
  /** Its scene; frames keep their box / shadow / cord, their own picture is dropped. */
  slide: CtPackSlide;
  /** Product frame id → its material's hanger (hole + cord). */
  frames: Record<string, { hole: boolean; cord: CtCordStyle }>;
  /**
   * The vật liệu version the tổ hợp's frames picked ("có dây"; "" = base): the storefront draws the design in it,
   * whatever option the customer picks. null = the product's own (config.material.version).
   */
  materialVersion: string | null;
}

/** What a published template carries (no design samples). */
export type CtPublicProductConfig = Omit<CtProductConfig, "samples">;

export interface CtProduct {
  id: string;
  user_id: string;
  name: string;
  status: CtProductStatus;
  main_asset_id: string | null;
  thumbnail_url: string | null;
  notes: string;
  /** Added by migration 002; absent on rows read before it ran. Stored partial; lib/design normalizeProductConfig fills it. */
  config?: Partial<CtProductConfig>;
  /** Latest published template version (migration 002); null = never published. */
  published_version?: number | null;
  published_at?: string | null;
  /** Its Shopify product, once deployed (migration 018). */
  shopify?: CtShopifyLink | null;
  created_at: string;
  updated_at: string;
}

export interface CtProductListRow extends CtProduct {
  main_asset: Pick<CtAsset, "url" | "width" | "height"> | null;
  /** The product's first mockup (the card shows it before the main object). */
  mockup_url: string | null;
}

export interface CtGeneration {
  id: string;
  user_id: string;
  /** NULL for library generations (ComfyUI studio). */
  product_id: string | null;
  target_role: CtAssetRole;
  parent_asset_id: string | null;
  provider: CtGenerationProvider;
  model: string;
  prompt: string;
  reference_asset_ids: string[];
  params: CtGenerationParams;
  status: CtGenerationStatus;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface CtGenerationParams {
  aspectRatio: CtAspectRatio;
  count: number;
  transparent: boolean;
}

/** Everything the editor needs in one fetch. */
export interface CtProductBundle {
  product: CtProduct;
  assets: CtAsset[];
  regions: CtRegion[];
  items: CtRegionItem[];
  generations: CtGeneration[];
}

// ---------------------------------------------------------------------------
// Product scene + tổ hợp (mockups) — lib/mockup.ts, migration 007
// ---------------------------------------------------------------------------

/**
 * The product shown on a background (Thiết kế → Nền): the design (main + its
 * layers, in main px) is drawn into `box`, in background px. Print files
 * never use it.
 */
export interface CtProductScene {
  /** null = no background (the design alone). */
  url: string | null;
  width: number;
  height: number;
  box: { x: number; y: number; w: number; h: number };
}

/**
 * A tổ hợp: one mockup picture made by hand in the editor — a stack of
 * frames: background fills (colour / gradient), image frames (photos, hands),
 * product frames (a main version drawn with the product's design content and
 * its material) and text. Saved on the product as a mockup (meta.scene);
 * several make a set (CtMockupPack, a template) that other products of the
 * kind reuse — their own versions + design content go in the frames.
 */

/** Layer box in canvas px; rotation (degrees, clockwise) about its centre. */
export interface CtPackBox {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
}

export type CtPackBlend = "normal" | "multiply" | "screen" | "overlay" | "soft-light" | "darken" | "lighten";

/** Part of a layer's content that shows, as fractions of the uncropped content (0..1). */
export interface CtPackCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A lasso cut on a layer: the outline as (u, v) pairs, fractions of the layer's full (uncropped, unflipped) content,
 * so it stays on the content when the layer moves, turns, flips or is cropped. `keep` = only the inside stays;
 * otherwise the inside is cut away.
 */
export interface CtPackCut {
  points: number[];
  keep: boolean;
}

interface CtPackLayerBase {
  id: string;
  name: string;
  /** What shows on the scene — the cropped part when `crop` is set. */
  box: CtPackBox;
  opacity: number;
  hidden: boolean;
  /** Cắt (image and product frames): the content is box / crop big, only `crop` of it shows; absent = all. */
  crop?: CtPackCrop | null;
  /** Mirrored along the layer's own axes. */
  flipX?: boolean;
  flipY?: boolean;
  /** Cắt (lasso), in order. */
  cuts?: CtPackCut[];
}

/** Image frame: a photo (background, fingers holding the ornament, stickers). */
export interface CtPackImageLayer extends CtPackLayerBase {
  type: "image";
  url: string;
  /** "original" = the frame is the photo's real pixel size (drawn like cover); "stretch" only for the product scene. */
  fit: "cover" | "contain" | "original" | "stretch";
  blend: CtPackBlend;
  /** Gaussian blur of the photo (CSS blur), scene px; 0 = sharp. */
  blur: number;
}

/** Linear gradient across a fill frame (lib/gradients.ts presets). */
export interface CtPackGradient {
  /** Preset name, "" = custom. */
  name: string;
  /** CSS colours, evenly spaced, first = start. */
  colors: string[];
  /** CSS angle: 0 = bottom → top, 90 = left → right. */
  angle: number;
}

/** Background frame: a flat colour, or a gradient when `gradient` is set. */
export interface CtPackFillLayer extends CtPackLayerBase {
  type: "fill";
  color: string;
  gradient: CtPackGradient | null;
}

export interface CtPackShadow {
  enabled: boolean;
  /** px on the canvas */
  blur: number;
  dx: number;
  dy: number;
  /** 0..1 */
  opacity: number;
}

/**
 * A product in the scene: a main version with the product's design content
 * (CtProductConfig.samples), drawn with its material, contain-fitted
 * (trimmed) into the box.
 */
export interface CtPackFrameLayer extends CtPackLayerBase {
  type: "frame";
  /** Which main version, by position (0 = default) — another product of the set puts its own version there. */
  mainIndex: number;
  /** Saved artwork (composite) whose AI material version is drawn instead of the assembled one; null = assembled. */
  artworkId: string | null;
  /**
   * The version's material picture this frame shows (a vật liệu version, its đa sắc, or the vật liệu of a đa sắc
   * of the version); null = the version's default material. Product-specific: a template drops it.
   */
  pictureId: string | null;
  shadow: CtPackShadow;
  /** Hole + cord: "auto" = as the material's rules say. */
  hanger: "auto" | "on" | "off";
  /** Cord length, canvas px (from the hole, upwards). */
  cordLength: number;
  /** Cord tilt, degrees (0 = straight up). */
  cordAngle: number;
}

export interface CtPackTextLayer extends CtPackLayerBase {
  type: "text";
  text: string;
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  color: string;
  align: "left" | "center" | "right";
  /** Text shadow for legibility on photos. */
  shadow: boolean;
}

/** One brush stroke, scene px: the path (x0, y0, x1, y1…) and the brush diameter; `erase` takes the blur off again. */
export interface CtPackBrushStroke {
  points: number[];
  size: number;
  erase: boolean;
}

/**
 * Cọ làm mờ: wherever it is painted, everything under it (all layers below, merged) shows blurred. Covers the
 * whole scene; its box is not used.
 */
export interface CtPackBlurLayer extends CtPackLayerBase {
  type: "blur";
  /** Blur radius, scene px. */
  strength: number;
  strokes: CtPackBrushStroke[];
}

export type CtPackLayer = CtPackFillLayer | CtPackImageLayer | CtPackFrameLayer | CtPackTextLayer | CtPackBlurLayer;
export type CtPackLayerType = CtPackLayer["type"];

/** One tổ hợp (scene). */
export interface CtPackSlide {
  id: string;
  name: string;
  width: number;
  height: number;
  /** LEGACY fill under every layer — normalizeSlide turns it into a fill frame; always "" now. */
  background: string;
  /** Bottom first. */
  layers: CtPackLayer[];
}

/** A named set of tổ hợp (library, ct_mockup_packs). */
export interface CtMockupPack {
  id: string;
  user_id: string | null;
  name: string;
  notes: string;
  slides: CtPackSlide[];
  thumbnail_url: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  can_edit?: boolean;
}

export interface CtMockupPackBody {
  name: string;
  notes: string;
  slides: CtPackSlide[];
  thumbnail_url: string | null;
}

// ---------------------------------------------------------------------------
// Clipart library (migration 006)
// ---------------------------------------------------------------------------

/** What the origins of a category are used as. */
export type CtCategoryUsage = "main" | "element";

/**
 * How a category grows:
 *   origin_set   independent originals of one kind (each car model, each hobby icon)
 *   variant_set  one silhouette in many colours / styles (dumpling × 10 colours)
 */
export type CtCategoryMode = "origin_set" | "variant_set";

export type CtCategoryAnchor = "center" | "bottom";

/**
 * auto: keep the model's alpha when it returned a transparent background, else cut it out (BiRefNet).
 * The others are legacy values of categories saved before the rule left the dialog — read as "auto".
 */
export type CtCategoryBackground = "auto" | "transparent" | "cutout" | "none";

/** Generation / normalisation rules every clipart of a category follows (ComfyUI nodes enforce them). */
export interface CtCategoryRules {
  /** Output canvas, px — every clipart of the set shares it so they swap in place. */
  canvas: { w: number; h: number };
  /** Subject size as a fraction of the canvas' shorter side. */
  fill: number;
  anchor: CtCategoryAnchor;
  background: CtCategoryBackground;
  /** Set members keep the origin's exact alpha (same outline, same size). */
  lockSilhouette: boolean;
  /**
   * The finished product's outline:
   *   alpha  cut along the clipart's own outline (acrylic die-cut, sticker) — the clipart is the object alone, its
   *          vật liệu follows its alpha
   *   frame  a fixed shape (round ceramic ornament, trousers, a framed print) — the clipart is a full-bleed picture,
   *          background included; a product's khuôn vật liệu cuts the shape (lib/material-frame)
   */
  shape: CtProductShape;
  /** Style pack (ct_presets kind style_pack) — required for a new category. */
  stylePackId: string | null;
  /**
   * Material versions every new origin gets (ct_presets kind material). The flat clipart is always made;
   * each id here adds one rendition of it (FP Material, identical to the flat one + the material).
   */
  materialIds: string[];
  /**
   * Reference photos of the set's look (public urls, saved from "Tạo prompt bằng AI"): the image model gets them
   * with every new origin of the category — not only the LLM that wrote the spec / style pack.
   */
  refs: string[];
  /**
   * Chi tiết thành phẩm: what the finished product of THIS category has besides its material (a hanging hole,
   * a spring and a cord, a visor clip…). Never part of the flat clipart (the file the factory gets): only the
   * material versions get them (FP Material). Copied — never shared — between categories.
   */
  details: CtMaterialSpec[];
  /** Photos of the finished product (public urls): the material step's image model gets them, never the flat drawing. */
  productRefs: string[];
  /** The editor's description the details were read from. */
  detailsNote: string;
  /**
   * The product this category is the folder of (server/artworks.ts): its artworks and — a v2 bộ nhân vật — its
   * layer cliparts live here; renaming the product renames the category. null = an ordinary category.
   */
  productId: string | null;
}

export type CtProductShape = "alpha" | "frame";

export interface CtClipartCategory {
  id: string;
  user_id: string | null;
  parent_id: string | null;
  name: string;
  usage: CtCategoryUsage;
  mode: CtCategoryMode;
  spec: string;
  rules: CtCategoryRules;
  sort_order: number;
  created_at: string;
  updated_at: string;
  /** Origins in the category (list endpoint only). */
  count?: number;
  can_edit?: boolean;
}

export interface CtCategoryBody {
  name: string;
  parent_id: string | null;
  usage: CtCategoryUsage;
  mode: CtCategoryMode;
  spec: string;
  rules: CtCategoryRules;
  sort_order?: number;
}

export interface CtUpdateClipartBody {
  name?: string;
  spec?: string;
  tags?: string[];
  category_id?: string | null;
  sort_order?: number;
  license?: string;
  meta?: CtAssetMeta;
}

export type CtPresetKind = "style_pack" | "material" | "scene";

/**
 * Material rules — the physical facts of a material version, on top of its
 * prompt. The look rules go into the AI prompt (services/comfy FP Material);
 * the hanger (hole + cord) is drawn by the mockup renderer (lib/mockup.ts),
 * since a cord reaches outside the plate the AI's outline is locked to.
 */
export interface CtMaterialRules {
  /** Same as the flat clipart, pixel for pixel — only the material is added. */
  keepExact: boolean;
  /** Realistic detail: thickness, polished edge, glossy highlights. */
  realistic: boolean;
  /** Round hanging hole near the top. */
  hole: boolean;
  /** Cord through the hole. */
  cord: CtCordStyle;
}

export type CtCordStyle = "none" | "gold" | "silver" | "red" | "white";

export interface CtPresetParams {
  /** Material (older presets): re-apply the source alpha so the rendition keeps the exact outline. */
  lockSilhouette?: boolean;
  /** Material (older presets): rules of the physical product (absent = all off). */
  rules?: CtMaterialRules;
  /** Preferred model id for this preset. */
  model?: string;
  /**
   * Material: what becomes of the printed artwork. "print" — it stays the original pixels, the material is
   * built around it (clear acrylic, wood cut-out); "surface" — the material covers it (glitter, embroidery).
   * Absent = an older preset (the material version is drawn inside the clipart's outline).
   */
  art?: CtMaterialArt;
  /**
   * Material, older presets only: details (hole, cord…). They belong to the category now (CtCategoryRules.details,
   * migration 009 moves them); the studio no longer reads them.
   */
  specs?: CtMaterialSpec[];
  /** Reference photos of the finished product (public urls): the image model gets them with the artwork. */
  refs?: string[];
  /** Style pack / material: the editor's description the prompt (and the material's details) were written from. */
  note?: string;
}

export type CtMaterialArt = "print" | "surface";

/**
 * A detail a material adds — free text, read from the editor's description and reference photos (never a fixed
 * option list: a hanging hole, a cord, a flower, a cup handle…). Where it goes is part of the text.
 */
export interface CtMaterialSpec {
  /** For the image model, English. */
  text: string;
  /**
   * "always": part of every material version. "version": one more version WITH it — an edit of the base,
   * so everything else (hole, plate, art) sits exactly where it is in the base.
   */
  mode: CtMaterialSpecMode;
  /** The version's name ("có dây") — mode "version". */
  label: string;
}

export type CtMaterialSpecMode = "always" | "version";

export interface CtPreset {
  id: string;
  user_id: string | null;
  kind: CtPresetKind;
  name: string;
  prompt: string;
  reference_asset_ids: string[];
  params: CtPresetParams;
  sort_order: number;
  created_at: string;
  updated_at: string;
  can_edit?: boolean;
}

/** GET library/cliparts */
export interface CtLibraryQuery {
  category?: string | null;
  q?: string;
  /** Only origins (parent_id NULL); their set members / renditions come along. */
  withChildren?: boolean;
}

/** Where a library clipart is used — deleting it is refused while this is non-empty. */
export interface CtClipartUsage {
  productId: string;
  productName: string;
}

// ---------------------------------------------------------------------------
// Customer-side selection (what a storefront order would carry)
// ---------------------------------------------------------------------------

/** Chosen main version, stored under CT_MAIN_KEY in a CtSelection. */
export interface CtMainSelection {
  kind: "main";
  assetId: string | null;
  /** A sub-option of that version (CtMainOptionConfig.subOptions); absent / null = the version's own picture. */
  optionId?: string | null;
}

export interface CtImageSelection {
  kind: "image";
  /** Chosen variant (or the sub asset itself when it has no variants); null = none. */
  assetId: string | null;
}

export interface CtTextSelection {
  kind: "text";
  text: string;
  /** Chosen sub-option (CtRegionConfig.options); absent / null = the zone's own look. */
  optionId?: string | null;
}

export interface CtPhotoSelection {
  kind: "photo";
  /** Object URL / public URL of the RENDERED photo (after style + cut-out) — what the compositor draws. */
  url: string | null;
  transform: CtTransform;
  /** Style the customer picked; absent = "original" (selections saved before styles existed). */
  style?: CtPhotoStyleRef;
  /** The customer's untouched upload, kept for fulfilment when url is a processed version. */
  sourceUrl?: string | null;
  /** Chosen sub-option (CtRegionConfig.options); absent / null = the zone's own shape. */
  optionId?: string | null;
}

export type CtRegionSelection = CtImageSelection | CtTextSelection | CtPhotoSelection;

/** regionId -> selection, plus the main version under CT_MAIN_KEY. */
export type CtSelection = Record<string, CtRegionSelection | CtMainSelection>;

/** Selection key of the main version (region ids are UUIDs, so it cannot collide). */
export const CT_MAIN_KEY = "$main";

// ---------------------------------------------------------------------------
// Published template — what the Shopify storefront renders
// ---------------------------------------------------------------------------

/** The asset fields rendering needs; CtAsset satisfies it. */
export type CtRenderAsset = Pick<
  CtAsset,
  "id" | "role" | "parent_id" | "name" | "url" | "width" | "height" | "meta" | "sort_order" | "created_at"
>;

/**
 * Immutable snapshot written by "Publish" (ct_templates). The storefront loads
 * the latest one and renders it with lib/compositor.ts — the same code as the
 * editor, so the cart preview matches what was designed.
 */
export interface CtTemplate {
  schema: 1;
  productId: string;
  version: number;
  name: string;
  publishedAt: string;
  /** Default main; all zone geometry is in its pixel space. */
  mainAssetId: string;
  width: number;
  height: number;
  config: CtPublicProductConfig;
  assets: CtRenderAsset[];
  regions: CtRegion[];
  items: CtRegionItem[];
  /** Names of the AI styles the zones offer (no prompt / model). */
  aiStyles?: CtPublicAiStyle[];
  /**
   * Each custom layer's default picture (layer id → asset id), as picked in the editor. A layer with 2+ pictures is
   * a pick-only option for the customer (a set of hairstyles); with one it is simply drawn.
   */
  picks?: Record<string, string | null>;
}

export interface CtPublishResponse {
  version: number;
  publishedAt: string;
  /** Public JSON endpoint the storefront section fetches. */
  templateUrl: string;
}

export interface CtPublicUploadResponse {
  url: string;
}

// ---------------------------------------------------------------------------
// API payloads
// ---------------------------------------------------------------------------

export type CtAspectRatio = "1:1" | "3:4" | "4:3" | "9:16" | "16:9";

export interface CtCreateProductBody {
  name: string;
}

export interface CtUpdateProductBody {
  name?: string;
  status?: CtProductStatus;
  main_asset_id?: string | null;
  thumbnail_url?: string | null;
  notes?: string;
  /** Design samples only (CtProductConfig.samples) — merged into the stored config. */
  samples?: CtSelection;
}

export interface CtSaveDesignBody {
  regions: CtRegion[];
  items: CtRegionItem[];
  config: CtProductConfig;
}

export interface CtUpdateAssetBody {
  name?: string;
  /** Variants only: move the option into another group (sub asset). */
  parent_id?: string | null;
  sort_order?: number;
  /** Shallow-merged into the stored meta. */
  meta?: CtAssetMeta;
}

export interface CtAiModelOption {
  id: string;
  label: string;
  supportsTransparent: boolean;
  maxReferences: number;
}

export interface CtAiProviderInfo {
  id: CtAiProviderId;
  label: string;
  configured: boolean;
  models: CtAiModelOption[];
}

/** What the server can do for customer photos (GET ai/photo). */
export interface CtPhotoCapabilities {
  /** An AI provider is configured. */
  ai: boolean;
  /** Subject cut-out works (FAL_KEY matting, or the AI fallback). */
  cutout: boolean;
  /** AI styles can run (FAL_KEY is set). */
  aiStyles: boolean;
  /** Face styles can run (CT_FACE_DETECT_URL, services/face-detect). */
  faceDetect: boolean;
}

export interface CtApiError {
  error: string;
}

/**
 * 202 body of a POST sent with `?async=1` that is still running after a few seconds (server/jobs.ts): ask `poll`
 * (GET) until it answers something else — that is the POST's own response.
 */
export interface CtJobPending {
  ctJob: string;
  poll: string;
}

// ---------------------------------------------------------------------------
// Category history (migration 010): saves (older rows also hold AI revisions)
// ---------------------------------------------------------------------------

export type CtCategoryHistoryEvent = "revise" | "save";

/** The category state a history row records. */
export interface CtCategorySnapshot {
  name: string;
  spec: string;
  rules: CtCategoryRules;
}

export interface CtCategoryHistoryEntry {
  id: string;
  category_id: string | null;
  user_id: string | null;
  event: CtCategoryHistoryEvent;
  /** Revise: what the editor said was wrong. */
  note: string;
  /** Revise: the new reference photos (public urls). */
  ref_urls: string[];
  /** Revise: the result images the editor looked at, in their numbered order. */
  image_urls: string[];
  /** Revise: the category before. Save: { revision_id }. */
  input: Partial<CtCategorySnapshot> & { revision_id?: string | null };
  /** Save: the saved category. Revise (older rows): the AI's plan as it was then. */
  result: CtCategorySnapshot | Record<string, unknown>;
  model: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Agent tasks (migration 011): work done by the @flexiprint agent on agent_ide
// ---------------------------------------------------------------------------

/** content = "Tạo content với FlexiPrint" of the Deploy page (input.content, result CtContentResult). */
/** char = a step of a v2 bộ nhân vật (input.char, result CtCharTaskResult — types/char.ts). */
/** (Older rows may hold the removed kinds create / revise / pack_image; they are no longer listed or run.) */
export type CtAgentTaskKind = "content" | "char";

/** waiting = the agent asked the editor something (ask_user) and ended its turn until they answer. */
export type CtAgentTaskStatus = "pending" | "running" | "waiting" | "done" | "failed" | "cancelled";

export interface CtAgentTaskProgress {
  at: string;
  text: string;
  /** Images to show with the line. */
  images?: string[];
  /** note = the agent's own line (report_progress); run = an image made; question / answer = ask_user; inject = the
   * editor's "Gửi chen" while the agent works. */
  kind?: "note" | "run" | "question" | "answer" | "inject";
}

/** Something for @flexiprint to read while it works on a bộ (ct_agent_inbox, migration 028): the editor's "Gửi chen"
 * (message) or a change they made by hand in the editor (edit). */
export interface CtAgentInboxRow {
  id: string;
  project_id: string;
  task_id: string | null;
  user_id: string | null;
  kind: "message" | "edit";
  text: string;
  attachments: CtCharChatAttachment[];
  created_at: string;
  seen_at: string | null;
}

/** An option the agent offers in a question. */
export interface CtAgentQuestionOption {
  label: string;
  description: string;
}

/** A question the agent asked the editor mid-task (migration 014). */
export interface CtAgentQuestion {
  id: string;
  question: string;
  options: CtAgentQuestionOption[];
  /** Several options may be picked. */
  multi: boolean;
  /** A typed answer is accepted (besides or instead of the options). */
  allow_text: boolean;
  asked_at: string;
  answer: { choices: string[]; text: string; at: string } | null;
}

/** A studio run an agent task started (migration 013; the studio is gone — older rows only). */
export interface CtAgentTaskRun {
  run_id: string;
  recipe: string;
  /** What it made, for the editor ("vật liệu: police car"). */
  label: string;
  status: "queued" | "running" | "done" | "error";
  started_at: string;
  finished_at: string | null;
  asset_ids: string[];
  error: string;
}

/** What a task hands over. The category fields are left over from the removed category tasks (sent empty). */
export interface CtAgentTaskInput {
  category: CtCategorySnapshot & { id: string | null };
  note: string;
  images: Array<{ url: string; label: string }>;
  refUrls: string[];
  /** content: the product to write the Shopify title + description for. */
  content?: CtContentTaskInput;
  /** char: the bộ nhân vật and the step the agent does for it. */
  char?: CtCharTaskInput;
  /** Fingerprint of the agent's MCP tool list when the task was made: the agent_ide session fixes its tool list when it
   * starts, so a task after a deploy that changed the tools opens a fresh session instead of continuing the old one. */
  mcpTools?: string;
}

/**
 * A content task: title + description for the product's Shopify page. Every content task of a product is one
 * conversation with the agent (its earlier requests and results come with get_task), so "ngắn hơn", "giữ title cũ"
 * continue the last version.
 */
export interface CtContentTaskInput {
  productId: string;
  productName: string;
  /** What the editor wants (tone, keywords, length…); may be empty. */
  request: string;
  /** Title / description as the Deploy page has them now (the base of an edit). */
  title: string;
  descriptionHtml: string;
  /** What the customer personalizes (lib/option-audit.ts lines), the price table, product type. */
  facts: string[];
  /** Product photos (mockups) the agent can look at. */
  imageUrls: string[];
}

export interface CtContentResult {
  summary: string;
  title: string;
  descriptionHtml: string;
}

export interface CtAgentTask {
  id: string;
  user_id: string | null;
  category_id: string | null;
  kind: CtAgentTaskKind;
  status: CtAgentTaskStatus;
  input: CtAgentTaskInput;
  progress: CtAgentTaskProgress[];
  runs: CtAgentTaskRun[];
  questions: CtAgentQuestion[];
  result: CtContentResult | CtCharTaskResult | null;
  error: string;
  agent_job_id: string;
  agent_session_id: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

/** GET ai/agent-status: is the @flexiprint agent configured and answering. */
export interface CtAgentStatus {
  configured: boolean;
  online: boolean;
  /** The agent's card (name, title) when online. */
  name: string;
  error: string;
}

/**
 * A photo of the thư viện ảnh mockup (ct_pack_images, migration 015): uploaded by hand. Older rows were made by AI
 * (source "ai": description, prompt, refs… kept as they are).
 */
export interface CtPackImage {
  id: string;
  user_id: string | null;
  name: string;
  source: "upload" | "ai";
  status: "running" | "done" | "failed";
  url: string | null;
  storage_path: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  /** AI: what the editor asked for. */
  description: string;
  /** AI: the prompt FlexiPrint wrote and the model drew. */
  prompt: string;
  /** AI: reference photo urls. */
  refs: string[];
  aspect: string;
  model: string;
  error: string;
  /** The @flexiprint task that made it (migration 016). */
  task_id: string | null;
  /** The photo it was edited from. */
  parent_id: string | null;
  /** Background cut out (a layer). */
  transparent: boolean;
  /** In the library — an agent's draft is not until it submits it. */
  listed: boolean;
  /** The bộ ảnh it was made in. */
  collection_id: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Bảng giá + Deploy sản phẩm lên Shopify (migration 018; lib/pricing.ts, server/shopify.ts)
// ---------------------------------------------------------------------------

/** One size of a price table ("3.5 inches"): the price of ONE piece. */
export interface CtPriceSize {
  id: string;
  label: string;
  price: number;
  /** Struck-through price of one piece; null = none (a pack discount still shows the undiscounted total). */
  compareAt: number | null;
}

/** One pack ("Buy More Save More"): `qty` pieces, each a different design, `discountPct` off the size price. */
export interface CtPricePack {
  id: string;
  qty: number;
  /** Shown on the storefront card ("2 PCS"). */
  label: string;
  discountPct: number;
}

/** A hand-set cell of the Size × Pack grid (total for the pack), over the computed one. */
export interface CtPriceCellOverride {
  price?: number;
  compareAt?: number | null;
}

/**
 * A named price table. Deploy turns it into the Shopify product's options (Size, Pack) and one variant per cell,
 * priced at the cell's TOTAL (a 6-pack variant costs the 6 pieces). A dimension with a single entry is left out
 * (no 1-value option on the product page).
 */
export interface CtPriceTableConfig {
  /** Shopify option name of the sizes ("Size"). */
  sizeLabel: string;
  /** Shopify option name of the packs ("Buy More Save More (Different Designs)"). */
  packLabel: string;
  /** What one design of a pack is called on the storefront ("Ornament" → tabs "Ornament 1…6"). */
  itemLabel: string;
  sizes: CtPriceSize[];
  packs: CtPricePack[];
  /** "<sizeId>:<packId>" → hand-set cell. */
  overrides: Record<string, CtPriceCellOverride>;
}

export interface CtPriceTable {
  id: string;
  user_id: string | null;
  name: string;
  config: CtPriceTableConfig;
  created_at: string;
  updated_at: string;
}

export interface CtPriceTableBody {
  name: string;
  config: CtPriceTableConfig;
}

/** One computed cell = one Shopify variant. */
export interface CtPriceCell {
  size: CtPriceSize | null;
  pack: CtPricePack | null;
  qty: number;
  /** Total of the pack. */
  price: number;
  compareAt: number | null;
  /** price / qty. */
  unit: number;
  overridden: boolean;
}

/**
 * Metafield customize_tool.pricing (json) of a deployed product — how main-product.liquid tells the pack option
 * from the others and how many designs each of its values holds.
 */
export interface CtShopifyPricing {
  schema: 1;
  sizeOption: string | null;
  packOption: string | null;
  itemLabel: string;
  /** Pack option value → number of designs. */
  packs: Record<string, number>;
}

export type CtShopifyStatus = "ACTIVE" | "DRAFT" | "ARCHIVED";

/** ct_products.shopify: the product's Shopify product (migration 018). */
export interface CtShopifyLink {
  /** gid://shopify/Product/… */
  productId: string;
  handle: string;
  title: string;
  status: CtShopifyStatus;
  priceTableId: string | null;
  /** Our asset id → Shopify media id (product images made from mockups). */
  media: Record<string, string>;
  deployedAt: string;
  templateVersion: number;
  url: string;
  adminUrl: string;
}

export interface CtDeployBody {
  priceTableId: string;
  title: string;
  descriptionHtml: string;
  status: CtShopifyStatus;
  vendor: string;
  productType: string;
  tags: string[];
  /** Product images, in order: mockup / tổ hợp asset ids of this product. */
  mediaAssetIds: string[];
  /** Deploy onto this existing Shopify product (gid) instead of the linked one / a new one. */
  shopifyProductId?: string | null;
  /** Custom collections (gids) the product joins. */
  collectionIds: string[];
  /** The breadcrumb's collection (one of collectionIds); null = the theme's default. */
  primaryCollectionId: string | null;
}

export interface CtShopifyCollection {
  id: string;
  title: string;
  handle: string;
  /** Rule-based: products can't be added by hand. */
  smart: boolean;
}

export interface CtDeployResponse {
  product: CtProduct;
  publish: CtPublishResponse;
  shopify: CtShopifyLink;
  /** Staff preview of the product page (works while the store has a password; expires after a while). */
  previewUrl: string | null;
  warnings: string[];
}

/** A Shopify product as the Deploy page shows it (prefill, "link an existing product"). */
export interface CtShopifyProductSummary {
  id: string;
  title: string;
  handle: string;
  status: CtShopifyStatus;
  descriptionHtml: string;
  vendor: string;
  productType: string;
  tags: string[];
  /** Its page on the store: the live url once published, until then Shopify's preview url. */
  storeUrl: string | null;
  options: Array<{ name: string; values: string[] }>;
  variantsCount: number;
  imageUrl: string | null;
  /** customize_tool.product_id on it (another FlexiPrint product may own it). */
  ctProductId: string | null;
  collectionIds: string[];
  /** customize_tool.breadcrumb_collection. */
  primaryCollectionId: string | null;
}

export interface CtShopifyInfo {
  configured: boolean;
  shop: { name: string; domain: string; currency: string; moneyFormat: string } | null;
  /** The linked product as it is on Shopify now (null: none / deleted there). */
  product: CtShopifyProductSummary | null;
  error?: string;
}

import type { CtCharChatAttachment, CtCharTaskInput, CtCharTaskResult } from "./char";
import type { CtProductPrint } from "./print";
export * from "./char";
export * from "./print";
