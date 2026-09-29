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
 *
 * All geometry is in MAIN-ASSET PIXELS, so a design survives zooming/panning in
 * the editor and renders identically at any output scale.
 */

export type CtProductStatus = "draft" | "ready" | "archived";

export type CtAssetRole = "main" | "sub" | "variant" | "composite" | "mockup" | "reference";

export type CtRegionKind = "image" | "text" | "photo";

export type CtGenerationStatus = "pending" | "succeeded" | "failed";

export type CtAiProviderId = "gemini" | "openai";

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
export type CtPhotoStyleId = "original" | "oil" | "pixel";

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
  product_id: string;
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
}

export interface CtAssetMeta {
  /** For composites: which variant/text was chosen per region. */
  selection?: CtSelection;
  /** Colour shown when the option group uses the "swatch" display. */
  swatch?: string;
  /** Asset this one was derived from by an editor tool (e.g. background removal). */
  derivedFrom?: string;
  note?: string;
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
}

/**
 * Per-main-version layout: a main version ("1 person", "2 people", or a car
 * whose helmet sits elsewhere) can move / reshape / hide zones and move the
 * objects inside them. Anything not overridden inherits the base layout (the
 * zones as drawn). Keyed by zone / item id.
 */
export interface CtRegionOverride {
  shape?: CtShape;
  /** Zone not used by this version: not drawn, not in the customer form. */
  hidden?: boolean;
}

export interface CtMainLayout {
  regions: Record<string, CtRegionOverride>;
  items: Record<string, CtTransform>;
}

/**
 * How the finished design is rendered as a physical product (lib/materials.ts):
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

/** Where the rendered product sits on the scene photo (fractions of the scene). */
export interface CtScenePlacement {
  /** Centre of the product. */
  x: number;
  y: number;
  /** Product width as a fraction of the scene width. */
  width: number;
  rotation: number;
}

export interface CtMaterialConfig {
  id: CtMaterialId;
  shape: CtMaterialShape;
  /** Physical width of the main artwork, mm — converts the mm settings below to pixels. */
  widthMm: number;
  /** contour: margin of plate around the design, mm. */
  borderMm: number;
  /** Plate thickness shown as an edge, mm (acrylic 3 mm; 0 = none). */
  thicknessMm: number;
  /** Drop shadow strength 0..1. */
  shadow: number;
  /** Highlight / sheen strength 0..1. */
  gloss: number;
  /** Background photo (a "reference" asset) the product is placed on; null = transparent. */
  sceneAssetId: string | null;
  scene: CtScenePlacement;
}

export interface CtProductConfig {
  main: CtMainOptionConfig;
  /** Main asset id -> its own layout (absent = uses the base layout). */
  layouts: Record<string, CtMainLayout>;
  material: CtMaterialConfig;
}

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
  product_id: string;
  target_role: CtAssetRole;
  parent_asset_id: string | null;
  provider: CtAiProviderId;
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
// Customer-side selection (what a storefront order would carry)
// ---------------------------------------------------------------------------

/** Chosen main version, stored under CT_MAIN_KEY in a CtSelection. */
export interface CtMainSelection {
  kind: "main";
  assetId: string | null;
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
  config: CtProductConfig;
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

export interface CtGenerateBody {
  targetRole: CtAssetRole;
  /** Required for "variant" — the sub asset the versions belong to. */
  parentAssetId: string | null;
  provider: CtAiProviderId;
  model: string;
  prompt: string;
  referenceAssetIds: string[];
  params: CtGenerationParams;
}

export interface CtGenerateResponse {
  generation: CtGeneration;
  assets: CtAsset[];
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
}

export interface CtApiError {
  error: string;
}
