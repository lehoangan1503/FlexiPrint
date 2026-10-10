/**
 * v2 — bộ nhân vật: one brief → one approved AI master → pixel-registered layers → products.
 * Rules: flexiprint://guide/layer-rules (server/mcp/layer-rules.ts).
 */

/** What the print goes on, and how its edge is made. */
export type CtCharCut = "rect" | "alpha" | "frame";

export interface CtCharProduct {
  /** Free words: "túi mỹ phẩm", "ly sứ 11oz", "sticker cắt viền"… */
  label: string;
  /** rect: printed in a box on the product · alpha: cut along the art's outline (sticker, acrylic) · frame: fixed khuôn. */
  cut: CtCharCut;
  /** Print area in mm (0 = not known yet). */
  widthMm: number;
  heightMm: number;
  /** Blank product photo shot straight on (ct_char_images kind "blank"); null = AI makes one later. */
  blankId: string | null;
  /** The khuôn in (types/print.ts) the set is made for; its safe zone decides the composition. */
  templateId?: string | null;
  /** How the picture must sit on that piece, for the image model (lib/print-template layoutHint). */
  layout?: string;
}

/**
 * How a slot's options differ.
 *   color   recolour of the master's own pixels (same outline) — clothes colours, hair colours
 *   texture in-place edit of the part (glitter, metallic, pattern) kept inside the part's own mask — same outline
 *   shape   the part changes outline (hairstyle, hat, glasses): the part is removed once, each option is added back
 *           in place on that base
 */
export type CtCharSlotMode = "color" | "texture" | "shape";

export interface CtCharOption {
  id: string;
  /** Name the customer sees: "Red", "Top Bun". */
  name: string;
  /** color: #rrggbb · texture / shape: a short English description for the AI ("gold glitter sequin"). */
  value: string;
}

export interface CtCharSlot {
  id: string;
  /** The part, in words: "hair", "sweater", "shoes", "collar"… */
  part: string;
  mode: CtCharSlotMode;
  /** The first option is how the master shows it. */
  options: CtCharOption[];
  /** shape slots only: colours each shape comes in (recolours) — the customer picks colour + shape. */
  colors: CtCharOption[];
  /** A part both behind and in front of the body (long hair, scarf): two layers, back linked to front. */
  wraps: boolean;
}

/**
 * What a reference picture is for:
 *   sample     a finished product the editor wants something like — @flexiprint reads everything from it (product,
 *              style, characters, poses, text, decor); the image model gets its style, characters, outfits, pose
 *   style      drawing style, line work, colouring — sent to the image model with the master prompt
 *   character  how a person / pet looks (face, hair, breed) — sent to the image model
 *   outfit     clothes / accessories — sent to the image model
 *   pose       pose / arrangement — sent to the image model
 *   product    how it sits on the product (layout, print area) — @flexiprint reads it, not the image model
 *   avoid      what NOT to make — @flexiprint reads it, not the image model
 */
export type CtCharRefUse = "sample" | "style" | "character" | "outfit" | "pose" | "product" | "avoid";

export interface CtCharRef {
  /** ct_char_images id (kind "ref"). */
  id: string;
  use: CtCharRefUse;
  /** The editor's words: what to take from it ("chỉ lấy nét vẽ và màu pastel", "cún giống con này"). */
  note: string;
}

export type CtCharSubjectKind = "person" | "pet" | "object";

export interface CtCharSubject {
  id: string;
  kind: CtCharSubjectKind;
  /** "young woman, sitting, one knee up" · "small corgi, sitting" — order in the list = left → right in the picture. */
  description: string;
  slots: CtCharSlot[];
}

/** A place in the picture the customer fills with their own photo (pet face, framed photo…). */
export interface CtCharPhotoZone {
  id: string;
  /** "the photo frame she holds", "the corgi's face" — the AI paints it to find it. */
  where: string;
  label: string;
}

export interface CtCharText {
  enabled: boolean;
  defaultText: string;
  font: string;
  /** "under the characters", "on the left, vertical"… */
  place: string;
}

export interface CtCharBrief {
  /** The editor's own words (vague is fine — brainstorm turns it into the rest). */
  idea: string;
  product: CtCharProduct;
  /** Art style, one sentence. */
  style: string;
  /** Reference pictures the editor dropped in, each with what to take from it (asked 2026-10-09). */
  refs: CtCharRef[];
  /** Pose / arrangement of everyone together: "sitting side by side on the floor". */
  scene: string;
  subjects: CtCharSubject[];
  photoZones: CtCharPhotoZone[];
  text: CtCharText;
  /** Background decoration around the characters (separate art, not part of the master). */
  decor: string;
  /** Lifestyle mockup scenes. */
  mockups: string[];
  /**
   * How the clipart files are made (asked 2026-10-10):
   *   key    one AI picture per clipart — the part kept as drawn, everything else of the figures flat magenta, the
   *          background transparent; the file is that picture's own non-magenta pixels (lib/char-plan.ts)
   *   paint  (older projects) magenta regions painted on the master, the pixels cut from the master / base
   */
  clips: "key" | "paint";
}

export type CtCharStatus = "brief" | "master" | "layers" | "product";

/** One brainstorm direction: a named style + a full brief proposal the editor can take. */
export interface CtCharIdea {
  id: string;
  title: string;
  why: string;
  brief: CtCharBrief;
}

export interface CtCharIdeaRound {
  id: string;
  at: string;
  /** What the editor asked. */
  request: string;
  summary: string;
  /** Questions worth answering before making the master. */
  questions: string[];
  ideas: CtCharIdea[];
}

export interface CtCharProject {
  id: string;
  user_id: string | null;
  name: string;
  brief: CtCharBrief;
  ideas: CtCharIdeaRound[];
  master_id: string | null;
  status: CtCharStatus;
  /** The cut reviewed on the master: backdrop removed, then every layer's region (null = not started). */
  cut: CtCharCutState | null;
  /** null until layers were built once. */
  layers: CtCharLayerSet | null;
  product_ids: string[];
  created_at: string;
  updated_at: string;
}

export type CtCharImageKind = "ref" | "blank" | "master" | "edit" | "layer" | "mockup";
export type CtCharImageStatus = "running" | "done" | "failed";

/** Registration of an in-place edit against the approved master (layer-rules §5: ≤ 0.5 px). */
export interface CtCharAlign {
  /** Overall shift (px). */
  dx: number;
  dy: number;
  /** Share of pixels that stayed the same (0–1). */
  unchanged: number;
  /** Local shift before the correction, 90th percentile over the picture (px). */
  before?: number;
  /** Local shift left after layer-kit moved the edit back (affine + local flow) — what the layers have (px). */
  residual?: number;
  /** Worst local shift left (px). */
  max?: number;
}

export interface CtCharImageMeta {
  align?: CtCharAlign;
  /** Candidate number of a master batch. */
  candidate?: number;
  /** The picture an edit was made from (work / base) — an edit of an older base is stale. */
  sourceId?: string;
  /** Made by @flexiprint for this agent task (its prompt is the agent's). */
  taskId?: string;
}

export interface CtCharImage {
  id: string;
  project_id: string;
  user_id: string | null;
  kind: CtCharImageKind;
  role: string;
  parent_id: string | null;
  status: CtCharImageStatus;
  prompt: string;
  note: string;
  model: string;
  url: string;
  storage_path: string;
  thumb_url: string;
  thumb_path: string;
  width: number | null;
  height: number | null;
  meta: CtCharImageMeta;
  error: string;
  created_at: string;
  updated_at: string;
}

/** The layer set built from the approved master (server/char/layers.ts). */
export interface CtCharLayerFile {
  /** ct_char_images id of the file. */
  imageId: string;
  url: string;
  thumbUrl: string;
  /** Option name (shape / texture / colour). */
  option: string;
  /** Colour name of a recoloured shape ("" otherwise). */
  color: string;
  /** [x, y, w, h] of the visible pixels on the set's canvas (thumbnails zoom there). */
  bbox?: number[];
  /** The plan piece it was cut from (CtCharPiece.key) — its region is where to fix it. */
  piece?: string;
}

export interface CtCharLayerSlot {
  /** "body", "<slot id>", "<slot id>:back", "<slot id>:front". */
  key: string;
  label: string;
  files: CtCharLayerFile[];
  /** The back half of a wrapping part follows this slot's choice (layer-rules §6). */
  follows: string | null;
}

export interface CtCharLayerCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** The plan piece to fix when it fails (CtCharPiece.key). */
  piece?: string;
}

export interface CtCharLayerZone {
  id: string;
  label: string;
  /** Polygon on the layer canvas (px). */
  polygon: number[][];
}

export interface CtCharLayerSet {
  status: "building" | "done" | "failed";
  error: string;
  /** Common canvas of every file (the crop of the working master). */
  width: number;
  height: number;
  /** Bottom → top. */
  slots: CtCharLayerSlot[];
  zones: CtCharLayerZone[];
  checks: CtCharLayerCheck[];
  builtAt: string;
  /** Where the files stacked back differ from the master (red = hole, blue = extra, yellow = colour), same canvas. */
  diffUrl?: string;
  diffPath?: string;
  /** The editor checked the files: final, handed on to the products. */
  approved?: boolean;
}

// ---- the cut, reviewed on the master (server/char/cut.ts, services/layer-kit) -----------------------------
// 1. matte  the master at print size without its backdrop → the editor fixes the alpha by hand, approves
// 2. plan   every layer's region on its picture (master, base, each shape option) → fixed by hand, approved
// 3. layers the files: region × the picture's subject alpha (+ recolours, back / front) → checked, approved

export type CtCharJobStatus = "running" | "done" | "failed";

/** A mask the editor fixes by hand (PNG: white, alpha = the mask): the current one + earlier ones (≤ 5). */
export interface CtCharMask {
  url: string;
  path: string;
  /** Changed by hand since it was made. */
  edited: boolean;
  history: Array<{ url: string; path: string; at: string }>;
}

export interface CtCharMatte {
  status: CtCharJobStatus;
  error: string;
  width: number;
  height: number;
  /** The master's colours at print size (un-mixed from the backdrop at the edge) + a WebP preview (≤ 1024 px). */
  colourUrl: string;
  colourPath: string;
  previewUrl: string;
  previewPath: string;
  /** null while running. */
  alpha: CtCharMask | null;
  approved: boolean;
  at: string;
}

/** A picture layers are cut from, at print size: the master, the base, each shape / texture option. */
export interface CtCharPicture {
  /** "master" | "base" | "opt.<slot>.<i>" | "tex.<slot>.<i>". */
  id: string;
  label: string;
  colourUrl: string;
  colourPath: string;
  previewUrl: string;
  previewPath: string;
  /** Its subject alpha as planned (the master's: always the matte's current one). */
  alphaUrl: string | null;
  alphaPath: string | null;
  /** An edit: its own matte + where it kept its parent — the parent's (hand-fixed) alpha holds there at cut time. */
  ownUrl: string | null;
  ownPath: string | null;
  keepUrl: string | null;
  keepPath: string | null;
  parent: string | null;
}

export type CtCharPieceKind = "body" | "part" | "zone";

/** One layer's region on its picture: which pixels of that picture the layer is. */
export interface CtCharPiece {
  /** "body" | "<slot>" (colour / texture part) | "<slot>#<option index>" (shape option) | "zone:<id>". */
  key: string;
  slot: string;
  kind: CtCharPieceKind;
  label: string;
  option: string;
  index: number;
  /** CtCharPicture id. */
  picture: string;
  region: CtCharMask;
  /** What the region was found from (source pictures + matte): same again → a hand-fixed region is kept on a re-plan. */
  sig?: string;
}

export interface CtCharPlan {
  status: CtCharJobStatus;
  error: string;
  width: number;
  height: number;
  pictures: CtCharPicture[];
  pieces: CtCharPiece[];
  checks: CtCharLayerCheck[];
  approved: boolean;
  at: string;
}

export interface CtCharCutState {
  matte: CtCharMatte | null;
  plan: CtCharPlan | null;
}

/**
 * A step of a bộ nhân vật done by @flexiprint (agent task kind "char", server/mcp/char-tools.ts):
 *   brainstorm  directions for the brief → a new CtCharIdeaRound on the project
 *   master      the agent writes the master prompt, draws candidates, looks at them, refines in place; the editor
 *               approves one (imageId set = refine that master by `request`)
 *   edits       the agent writes the prompt of every in-place edit the brief needs, runs them, checks, redoes
 */
export type CtCharTaskStep = "brainstorm" | "master" | "edits";

export interface CtCharTaskInput {
  projectId: string;
  step: CtCharTaskStep;
  /** What the editor wants, in their words (may be empty). */
  request: string;
  /** master: the master to refine (an in-place edit of it). */
  imageId: string | null;
  /** edits: only these roles (empty = whatever is missing). */
  roles: string[];
}

export interface CtCharTaskResult {
  step: CtCharTaskStep;
  /** Vietnamese: what the agent did, what it checked, what is still off. */
  summary: string;
  /** brainstorm: the round it added. */
  roundId?: string;
  /** master: the masters it recommends, best first. edits: the edits it made. */
  imageIds?: string[];
}
