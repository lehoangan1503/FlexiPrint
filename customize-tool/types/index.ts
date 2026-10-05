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
  uppercase: boolean;
  /** Preset texts. Non-empty = the customer picks one from a dropdown instead of typing. */
  choices: string[];
}

/**
 * Free (no-AI) photo styles. "original" keeps the photo; "pixel" is a local
 * canvas filter; "oil" runs on the photo-style microservice (OpenCV).
 * lib/photo-styles.ts has the catalog.
 */
export type CtPhotoStyleId = "original" | "oil" | "pixel" | "face" | "face_bw" | "face_sepia" | "face_vivid" | "face_warm";

/**
 * Which kind of styles a photo zone offers — the inspector's tabs. Families never mix:
 *   free  no-AI filters ("original", "oil", "pixel"), customer picks
 *   ai    exactly one AI style
 *   face  face-detect crop + colour filter ("face*"), customer picks
 */
export type CtPhotoMode = "free" | "ai" | "face";

/** An AI style from the global library (ct_ai_styles), as a zone offers it: "ai:<uuid>". */
export type CtAiStyleRef = `ai:${string}`;

/** Any style a photo zone can offer. */
export type CtPhotoStyleRef = CtPhotoStyleId | CtAiStyleRef;

/** fal.ai edit endpoint ids we support (catalog + prices in lib/ai-style-models.ts). */
export type CtAiStyleModelId =
  | "fal-ai/nano-banana/edit"
  | "fal-ai/nano-banana-2/edit"
  | "fal-ai/bytedance/seedream/v4.5/edit"
  | "fal-ai/flux-pro/kontext"
  | "fal-ai/gpt-image-1.5/edit"
  | "fal-ai/qwen-image-edit-2511";

export interface CtAiStyleParams {
  /** Nano Banana 2 output size. */
  resolution: "0.5K" | "1K" | "2K";
  /** GPT Image quality. */
  quality: "low" | "medium" | "high";
  /** Output shape: square like the reference store, or follow the photo. */
  aspect: "1:1" | "auto";
  /** Append "on a pure white background" to the prompt (cut-out friendly). */
  whiteBackground: boolean;
  /** Cut the subject out of the AI result (bg-remover), even if the zone's cut-out is off. */
  removeBackground: boolean;
  outputFormat: "png" | "jpeg";
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

/** What the published template says about an AI style: its name only (prompt/model stay on the server). */
export interface CtPublicAiStyle {
  ref: CtAiStyleRef;
  name: string;
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
  /** Storefront may show "None" for this region. */
  allowNone: boolean;
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

export interface CtAssetMeta {
  /** For composites: which variant/text was chosen per region. */
  selection?: CtSelection;
  /** Colour shown when the option group uses the "swatch" display. */
  swatch?: string;
  /** Asset this one was derived from by an editor tool (e.g. background removal). */
  derivedFrom?: string;
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

export interface CtColorSource {
  url: string;
  /** Its variant line back then (a đa sắc). */
  variant?: CtAssetVariantLine;
}

export interface CtRenditionPad {
  x: number;
  y: number;
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
 * The LOOK of a material is AI-rendered (ComfyUI studio → renditions), not
 * simulated here.
 *   none            flat artwork, as designed
 *   acrylic_white   cut acrylic with a white backing (car visor clip, standee)
 *   acrylic_clear   clear acrylic — the scene shows through the plate border
 *   ceramic_gloss   glazed porcelain (round ornament) — glossy highlight
 *   ceramic_matte   unglazed / matte porcelain
 *   aluminum        printed metal sheet
 *   wood            printed / engraved wood
 */
export type CtMaterialId = "none" | "acrylic_white" | "acrylic_clear" | "ceramic_gloss" | "ceramic_matte" | "aluminum" | "wood";

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
  created_at: string;
  updated_at: string;
}

export interface CtProductListRow extends CtProduct {
  main_asset: Pick<CtAsset, "url" | "width" | "height"> | null;
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

interface CtPackLayerBase {
  id: string;
  name: string;
  box: CtPackBox;
  opacity: number;
  hidden: boolean;
}

/** Image frame: a photo (background, fingers holding the ornament, stickers). */
export interface CtPackImageLayer extends CtPackLayerBase {
  type: "image";
  url: string;
  fit: "cover" | "contain" | "stretch";
  blend: CtPackBlend;
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

export type CtPackLayer = CtPackFillLayer | CtPackImageLayer | CtPackFrameLayer | CtPackTextLayer;
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
}

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
  /** The "Cập nhật bằng AI" round this save applies (ct_category_history) — linked in the save's history row. */
  revision_id?: string | null;
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

/**
 * A style pack / material the category assistant wants: an existing preset of the library when one fits
 * (reuseId — nothing is created), otherwise a new one (name + prompt).
 */
export interface CtSuggestedPreset {
  name: string;
  prompt: string;
  /** An existing preset that fits — pick it instead of creating a new one. */
  reuseId: string | null;
  /** Why it was reused / why nothing in the library fits (Vietnamese, short). */
  reason: string;
}

/**
 * POST ai/prompt-suggest: a whole category from a note + reference images — name, spec, and the style pack,
 * materials and product details, reused from the library when they fit (server/ai/library-tools.ts).
 */
export interface CtPromptSuggestion {
  name: string;
  spec: string;
  style: CtSuggestedPreset;
  /** Materials read from the references / asked for in the note (acrylic, glitter…); empty when none. */
  materials: CtSuggestedPreset[];
  /** Chi tiết thành phẩm read from the references / the note (hole, cord, clip…); empty when none. */
  details: CtMaterialSpec[];
  /** Per detail: the category whose wording it reuses, or null when written new. */
  detailSources: Array<string | null>;
  /** What was reused and what is new, for the editor (Vietnamese). */
  summary: string;
  /** Per reference image (same order as sent): "design" shows the artwork to draw, "product" the finished physical product. */
  refRoles: CtRefRole[];
  /** The review of the drafted prompts; its fixes are already in spec / style / materials / details. */
  review: CtPromptReview | null;
}

export type CtRefRole = "design" | "product";

/** POST ai/details-suggest: a category's chi tiết thành phẩm read from a description + photos of the product. */
export interface CtDetailsSuggestion {
  details: CtMaterialSpec[];
}

/** POST ai/preset-prompt: a style pack / material prompt written from a description + reference images. */
export interface CtPresetPromptSuggestion {
  name: string;
  prompt: string;
  /** Material: what becomes of the artwork. (`specs`: older analyses — details are the category's now.) */
  specs?: CtMaterialSpec[];
  art?: CtMaterialArt;
  /** The analysis as recorded (absent when the history table is missing). */
  history?: CtPresetHistoryEntry;
}

/** POST ai/refine-suggest: the editor's feedback on generated cliparts, turned into an edit + optional spec / style rewrites. */
export interface CtRefineSuggestion {
  /** Vietnamese: what will change / stay and why (shown to the editor). */
  summary: string;
  /** English: everything the request doesn't touch, which FP Refine must keep exactly. */
  keep: string;
  /**
   * English instruction FP Refine applies to EVERY selected clipart: the shared change, written as the end
   * state each one must have (one that already has it keeps it) — never naming a single image.
   */
  edit: string;
  /** Per selected image (same order as sent): its own fixes and its own description. */
  images: CtRefineImagePlan[];
  /** Full rewritten category spec, or null when the request isn't category-wide. */
  spec: string | null;
  /** Full rewritten style-pack prompt, or null when the drawing style is fine. */
  style: string | null;
}

/** One clipart in a refine plan. */
export interface CtRefineImagePlan {
  name: string;
  /** English: fixes for THIS clipart only (what the editor said about it, or what it needs to reach the shared end state); "" = none. */
  edit: string;
  /** English: this clipart's own identity (model, colour scheme, livery, distinctive parts) — saved as its spec. */
  spec: string;
}

export interface CtRefineSuggestBody {
  fix: string;
  /** Generated cliparts the feedback is about, in the dialog's order: a copy with its number (#1…) drawn on, name, own spec (may be empty). */
  images: Array<{ image: Blob; name: string; spec: string }>;
  /** Photos of the part to change (e.g. the helmet wanted), or cliparts of the set that came out right. */
  refs: Blob[];
  /** Per ref: the clipart's name when it is a clipart of this set, "" for a photo. */
  refNames: string[];
  category: { name: string; usage: CtCategoryUsage; mode: CtCategoryMode; spec: string } | null;
  style: { name: string; prompt: string } | null;
  updateSpec: boolean;
  updateStyle: boolean;
}

export interface CtPresetBody {
  kind: CtPresetKind;
  name: string;
  prompt: string;
  reference_asset_ids: string[];
  params: CtPresetParams;
  sort_order?: number;
  /** Create: analyses made in the dialog before the preset existed — linked to it (ct_preset_history). */
  history_ids?: string[];
}

export type CtPresetHistoryEvent = "analysis" | "save";

/** What an analysis wrote, or what a save stored. */
export interface CtPresetHistoryResult {
  name: string;
  prompt: string;
  specs?: CtMaterialSpec[];
  art?: CtMaterialArt;
  /** Save: the preset's params as stored. */
  params?: CtPresetParams;
}

/**
 * One step of how a style pack / material came to be (migration 008): an AI analysis of the editor's
 * description + photos, or a save. Context for people and agents working on the preset later.
 */
export interface CtPresetHistoryEntry {
  id: string;
  preset_id: string | null;
  user_id: string | null;
  kind: "style_pack" | "material";
  event: CtPresetHistoryEvent;
  /** The editor's description at that point. */
  note: string;
  /** The reference photos it was made from (public urls). */
  ref_urls: string[];
  /** Analysis: the name / prompt it started from. */
  input: { name?: string; prompt?: string };
  result: CtPresetHistoryResult;
  /** Analysis: the LLM that wrote it. */
  model: string;
  created_at: string;
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
  /** The photo-style microservice is configured (CT_PHOTO_STYLE_URL). */
  styleService: boolean;
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

// ---------------------------------------------------------------------------
// AI dialog → ComfyUI recipes (server/studio.ts, services/comfy/.../recipes.py)
// ---------------------------------------------------------------------------

/** The four standard AI jobs. Main vs element comes from the category's usage. */
export type CtStudioRecipe = "origin" | "variant" | "material" | "mockup";

/** One line of a set: "name: text" in the studio nodes. */
export interface CtStudioLine {
  name: string;
  /** origin: what to draw · variant: "#hex" / CSS colour (recolour) or a change for the AI. */
  text: string;
  /** Variant lines: recolor = pixel recolour, no AI, free · ai = AI edit. Omitted = `method`. */
  mode?: "recolor" | "ai";
  /** Origin lines: photos of the object to draw (POST studio/refs → ComfyUI input names). */
  refs?: string[];
  /** Variant lines: the member this line remakes (its origin was fixed) — saved as the new one's meta.derivedFrom. */
  replaces?: string;
}

/** Per-run overrides of the category rules; 0 / omitted = the category's value. */
export interface CtStudioRulesOverride {
  canvas_w?: number;
  canvas_h?: number;
  fill?: number;
  anchor?: CtCategoryAnchor;
}

/** "category" = the category's background rule (cutout → BiRefNet, transparent → keep alpha, none → no cut-out). */
export type CtStudioCutout = "category" | "white" | "birefnet" | "keep";
export type CtStudioVariantMethod = "auto" | "recolor" | "ai_edit_locked" | "ai_edit";
export type CtStudioLock = "preset" | "on" | "off";

export interface CtStudioOriginParams {
  category_id: string;
  /** null = the category's default style pack. */
  style_pack_id: string | null;
  /** Material look in the same generation: null = the category's default, "none" = flat, else a material preset id. */
  material_id: string | null;
  /** Extra material notes for this run (added to the chosen / default material). */
  material_extra: string;
  /** One rendition of every new origin per material preset (FP Material on the flat clipart). */
  material_ids?: string[];
  note: string;
  subjects: CtStudioLine[];
  model: string;
  chain_reference: boolean;
  cutout: CtStudioCutout;
  rules: CtStudioRulesOverride;
  tags: string[];
}

/** Edit cliparts already made: change only what `instruction` says (FP Refine), save as new origins. */
export interface CtStudioRefineParams {
  /**
   * edit: this clipart's own fixes on top of `instruction`; spec: its own description (kept, saved as its spec);
   * parent_id: a set member (variant / colour version) — the edit is saved as a member of that origin;
   * materials: material presets to render the edited clipart in again (its category's materials).
   */
  targets: Array<{ clipart_id: string; name: string; edit?: string; spec?: string; parent_id?: string | null; materials?: string[] }>;
  /** Material look: omitted / null = each clipart's category default, "none" = flat, else a material preset id. */
  material_id?: string | null;
  /** Extra material notes for this edit. */
  material_extra?: string;
  /** English edit instruction (from POST ai/refine-suggest, editable). */
  instruction: string;
  /** English keep-list: what must stay exactly the same. */
  keep: string;
  /** Photos of the part to change (POST studio/refs → ComfyUI input names). */
  refs: string[];
  model: string;
  cutout: CtStudioCutout;
}

/** Free fixes (FP Adjust, no AI): recolour and / or mirror cliparts, each saved back in its place. */
export interface CtStudioAdjustParams {
  /** renditions: its material versions, given the same fix and saved as the new one's (material = their preset). */
  targets: Array<{
    clipart_id: string;
    name: string;
    spec?: string;
    parent_id?: string | null;
    renditions?: Array<{ id: string; name: string; material: string | null }>;
    /** Older single-rendition form. */
    rendition_id?: string | null;
    rendition_name?: string;
    material?: string | null;
  }>;
  /** "#rrggbb" — "" keeps the colour. */
  recolor: string;
  flip: boolean;
}

export interface CtStudioVariantParams {
  clipart_id: string;
  /** Several origins, the same lines for each (one run). Absent = clipart_id only. */
  clipart_ids?: string[];
  variants: CtStudioLine[];
  method: CtStudioVariantMethod;
  /** AI lines re-apply the origin's alpha (same outline pixel for pixel). */
  lock_silhouette: boolean;
  model: string;
}

export interface CtStudioMaterialParams {
  material_id: string;
  targets: Array<{ clipart_id: string; name: string }>;
  lock: CtStudioLock;
  edge_px: number;
  extra: string;
  model: string;
}

export interface CtStudioMockupParams {
  artwork_id: string;
  material_id: string | null;
  edge_px: number;
  scene_id: string;
  extra: string;
  model: string;
  name: string;
}

/** A saved artwork → its AI material version (product rendition of the composite): the material follows the whole outline. */
export interface CtStudioArtworkMaterialParams {
  artwork_id: string;
  material_id: string;
  edge_px: number;
  extra: string;
  model: string;
  name: string;
}

/** One tổ hợp to remake, by its number in the set ("#2"). */
export interface CtStudioEnhanceItem {
  number: number;
  /** studio/refs name of its picture. */
  ref: string;
  /** Name of the new mockup. */
  name: string;
  /** Instructions for this one only. */
  prompt: string;
}

/** Tổ hợp → "Tăng chất lượng với AI": each item is re-rendered photoreal, the other pictures ride along as references. */
export interface CtStudioMockupEnhanceParams {
  product_id: string;
  model: string;
  /** Instructions for every item. */
  prompt: string;
  items: CtStudioEnhanceItem[];
  /** Every picture the prompts may point at ("#n"), items included. */
  refs: Array<{ number: number; ref: string }>;
}

export type CtStudioRunBody =
  | { recipe: "origin"; params: CtStudioOriginParams }
  | { recipe: "refine"; params: CtStudioRefineParams }
  | { recipe: "adjust"; params: CtStudioAdjustParams }
  | { recipe: "variant"; params: CtStudioVariantParams }
  | { recipe: "material"; params: CtStudioMaterialParams }
  | { recipe: "mockup"; params: CtStudioMockupParams }
  | { recipe: "artwork_material"; params: CtStudioArtworkMaterialParams }
  | { recipe: "mockup_enhance"; params: CtStudioMockupEnhanceParams };

export type CtStudioRunState = "queued" | "running" | "done" | "error";

/** GET studio/runs/:id */
export interface CtStudioRunStatus {
  status: CtStudioRunState;
  /** Place in ComfyUI's queue while queued. */
  position?: number;
  /** FP node running now (FP_OriginGenerate…). */
  node?: string | null;
  error?: string;
  /** What the run saved so far: library cliparts, or product mockups. */
  assets: CtAsset[];
}

// ---------------------------------------------------------------------------
// Category revision ("Cập nhật bằng AI") + history (migration 010)
// ---------------------------------------------------------------------------

/**
 * What the revision does with a style pack / material: keep it, switch to another one of the library,
 * edit its prompt, add a new one, or (materials) drop it from the category.
 */
export type CtReviseAction = "keep" | "switch" | "edit" | "new" | "remove";

export interface CtRevisePreset {
  action: CtReviseAction;
  /** The preset the category uses now (null: an addition). */
  currentId: string | null;
  /** "switch": the library preset to use instead. */
  targetId: string | null;
  /** The resulting name / full prompt (keep / remove: the current one). */
  name: string;
  prompt: string;
  /** The current prompt, for the diff ("" for an addition). */
  before: string;
  /** Vietnamese: why. */
  why: string;
  /** Other categories using the current preset — an edit changes them too. */
  usedByOthers: string[];
}

/** What a new reference photo of the revision is kept as. */
export type CtReviseRefRole = "design" | "product" | "none";

/** POST ai/category-revise: the editor's feedback (+ numbered results, photos) → what to change in the category. */
export interface CtCategoryRevision {
  /** Vietnamese: what is wrong, on which images, and which layer causes it. */
  diagnosis: string;
  /** Full merged spec, or null to keep it. */
  spec: { text: string; why: string } | null;
  style: CtRevisePreset;
  materials: CtRevisePreset[];
  /** The full new details list, or null to keep it. */
  details: { list: CtMaterialSpec[]; why: string } | null;
  /** Per new reference photo (same order as sent). */
  refRoles: CtReviseRefRole[];
  /** Its ct_category_history row (null without migration 010). */
  historyId: string | null;
  /** The review of the prompts as they will be after this revision (server/ai/prompt-review.ts); its fixes are already folded in. */
  review: CtPromptReview | null;
}

export type CtReviewLayer = "spec" | "style" | "material" | "details" | "productRefs";

/** One problem the prompt review found in the assembled prompts. */
export interface CtReviewIssue {
  layer: CtReviewLayer;
  /** Material handle / photo number, or "". */
  target: string;
  severity: "high" | "low";
  /** Vietnamese. */
  problem: string;
  fix: string;
  /** The review changed that layer (the change is in the plan). */
  fixed: boolean;
}

/** The final check of a category's prompts, assembled the way the image models receive them. */
export interface CtPromptReview {
  issues: CtReviewIssue[];
  /** Product photos that contradict the details — removed from rules.productRefs when applied. */
  dropProductRefs: string[];
  model: string;
}

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
  /** Revise: the AI's plan (CtCategoryRevision). Save: the saved category (CtCategorySnapshot). */
  result: CtCategoryRevision | CtCategorySnapshot;
  model: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Agent tasks (migration 011): the category dialog's AI work done by the @flexiprint agent on agent_ide
// ---------------------------------------------------------------------------

/** "create" → CtPromptSuggestion; "revise" → CtCategoryRevision (an empty note = review only). */
export type CtAgentTaskKind = "create" | "revise";

export type CtAgentTaskStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export interface CtAgentTaskProgress {
  at: string;
  text: string;
}

/** What the dialog hands over — the same things it sends the built-in LLM, as urls. */
export interface CtAgentTaskInput {
  /** The category as the dialog has it (saved or not). Create: name / spec typed so far. */
  category: CtCategorySnapshot & { id: string | null };
  note: string;
  /** Result images the editor looked at, numbered #1… in this order. */
  images: Array<{ url: string; label: string }>;
  /** Reference photos the editor added (uploaded first). */
  refUrls: string[];
}

export interface CtAgentTask {
  id: string;
  user_id: string | null;
  category_id: string | null;
  kind: CtAgentTaskKind;
  status: CtAgentTaskStatus;
  input: CtAgentTaskInput;
  progress: CtAgentTaskProgress[];
  result: CtPromptSuggestion | CtCategoryRevision | null;
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
