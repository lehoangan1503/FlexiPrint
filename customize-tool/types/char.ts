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
  /** The material preset of the product (lib/materials: "ceramic_gloss" for a ceramic ornament…); empty = by cut. */
  material?: string;
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

/**
 * How the customer's photo is shown in a zone:
 *   ai     redrawn in a style the customer picks (`styles`, ct_ai_styles refs "ai:<uuid>"), cut out
 *   face   only the head is kept, cut out (a face on an elf body — services/face-detect)
 *   photo  as uploaded
 */
export type CtCharPhotoTreat = "ai" | "face" | "photo";

/** A place in the picture the customer fills with their own photo (pet face, framed photo, the pet itself…). */
export interface CtCharPhotoZone {
  id: string;
  /** "the photo frame she holds", "the corgi's face" — the AI paints it to find it (a bộ nhân vật). In a bộ ảnh
   * khách: what the photo shows ("the customer's pet, sitting"). */
  where: string;
  label: string;
  /** Absent = "photo" (zones made before 2026-10-15). */
  treat?: CtCharPhotoTreat;
  /** treat "ai": the styles offered, first = default. */
  styles?: string[];
  /** A bộ ảnh khách: where the photo sits on the piece (shares of the safe area); null = the middle, above the texts. */
  box?: CtCharBox | null;
}

/** A box on the piece as shares (0–1) of its safe area (the frame without a khuôn in). */
export interface CtCharBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * What a set is (asked 2026-10-15):
 *   character  drawn characters the customer dresses (doll + every option drawn on it, pixel lock)
 *   photo      a bộ ảnh khách: the customer's own photo is the hero; the set is the decorations around it (wings,
 *              halo, a band of clouds over the photo's cut edge…), each option drawn on its own, + backgrounds + texts
 */
export type CtCharSetKind = "character" | "photo";

/**
 * Where a decoration of a bộ ảnh khách sits, from the photo zone:
 *   behind  behind the photo, wider than it (angel wings)
 *   above   over the top of the photo (a halo, a crown)
 *   bottom  a band over the bottom of the photo and the piece's bottom edge — hides where the photo's body is cut
 *           (clouds, flowers, snow); the texts go over it
 *   free    `box`
 */
export type CtCharElementPlace = "behind" | "above" | "bottom" | "free";

/** One decoration the customer picks (bộ ảnh khách). */
export interface CtCharElement {
  id: string;
  /** What the customer is asked, English: "Wings", "Halo colour". */
  name: string;
  place: CtCharElementPlace;
  /** shape: every option drawn on its own · color: the first drawn, the others recoloured from it (same outline). */
  mode: "shape" | "color";
  /** shape: an English description each · color: #rrggbb each. */
  options: CtCharOption[];
  /** One picture per background instead of options, drawn in that background's colours — follows the customer's
   * background choice (the band of clouds that matches each sky). */
  perBackdrop: boolean;
  /** On the piece (shares of the safe area); null = from `place`. */
  box: CtCharBox | null;
}

/** Where a text sits on the product, around the characters. */
export type CtCharTextPlace = "top" | "bottom" | "left" | "right";

/**
 * A text the customer personalises (asked 2026-10-14: a name left and right of the characters, a slogan picked from
 * the shop's list):
 *   input   the customer types it (defaultText as the example)
 *   choice  the customer picks one of `choices` (the first is the default)
 */
export interface CtCharTextField {
  id: string;
  /** What the customer is asked, in English: "Name on the left", "Choose your slogan". */
  label: string;
  kind: "input" | "choice";
  defaultText: string;
  choices: string[];
  /** A Google font of config.ts CT_FONTS. */
  font: string;
  /** #rrggbb */
  color: string;
  place: CtCharTextPlace;
  maxChars: number;
}

/**
 * A background the customer can pick, drawn behind the characters over the whole piece (asked 2026-10-14: snowflakes,
 * Halloween icons, cute emoji). The image model draws it from `value` (step 4, server/char/backdrops.ts); the
 * picture is a ct_char_images row kind "blank", role "backdrop:<id>".
 */
export interface CtCharBackdrop {
  id: string;
  /** What the customer sees, English: "Snowflakes". */
  name: string;
  /** English description for the image model. */
  value: string;
}

export interface CtCharBrief {
  /** What the set is (absent in briefs before 2026-10-15 = "character"). */
  kind: CtCharSetKind;
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
  /** A bộ ảnh khách's decorations, bottom → top within their place. */
  elements: CtCharElement[];
  /** The texts the customer personalises (names, a slogan), each in its place around the characters. */
  texts: CtCharTextField[];
  /** The backgrounds the customer picks from (none = the product's own colour); never part of the master. */
  backdrops: CtCharBackdrop[];
  /** Lifestyle mockup scenes. */
  mockups: string[];
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
  /** A part made of a back + a front layer (hair): the option as it is seen — its back, the whole part (thumbnails,
   * the option's picture in the product). */
  viewUrl?: string;
  viewThumbUrl?: string;
  /** Option name (shape / texture / colour). */
  option: string;
  /** Colour name of a recoloured shape ("" otherwise). */
  color: string;
  /** [x, y, w, h] of the visible pixels on the set's canvas (thumbnails zoom there). */
  bbox?: number[];
  /** The plan piece it was cut from (CtCharPiece.key) — its region is where to fix it. */
  piece?: string;
  /** Its colours over the whole canvas (JPEG): pixels a hand edit adds are painted from these. */
  plateUrl?: string;
  /** Edited by hand (server/char/file-edit.ts): the mask it was given (PNG alpha, the set's canvas at `editCrop`),
   * applied again when the set is cut again — every clipart stays as the editor left it. */
  editMaskUrl?: string;
  editCrop?: CtCharCrop;
  /** What the editor started from (the plain cut), on the same canvas: a new cut gets
   * only the difference again (what was erased / added), so the rest takes the new cut's edges. */
  editBaseUrl?: string;
  /** Moved by hand in the editor: [dx, dy] px on the set's canvas from where it was cut (every colour of the option,
   * back and front together) — a new cut is moved the same. */
  offset?: number[];
  /** Earlier versions of this file (a move: every file it moved), newest last ("Hoàn tác"). */
  history?: CtCharFileVersion[];
}

/** Where the set's canvas sits on the master at print size. */
export interface CtCharCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One saved state of a file group before a hand edit: each slot key → its file entry then. */
export interface CtCharFileVersion {
  at: string;
  files: Array<{ slot: string; file: Omit<CtCharLayerFile, "history"> }>;
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
  /** The canvas on the master (layer-kit crop). */
  crop?: CtCharCrop;
  /** The files' colour plates and edit masks on R2 (removed with the next cut). */
  extraPaths?: string[];
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

/** A picture layers are cut from, at print size, registered onto the master: the master, unwrap, base, each shape /
 * texture option (lib/char-plan.ts). Its alpha is gpt-image's own cut-out. */
export interface CtCharPicture {
  /** "master" | "unwrap" | "base" | "opt.<slot>.<i>" | "tex.<slot>.<i>". */
  id: string;
  label: string;
  colourUrl: string;
  colourPath: string;
  previewUrl: string;
  previewPath: string;
  /** Its alpha (the master's: always the matte's current one — null here). */
  alphaUrl: string | null;
  alphaPath: string | null;
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
 *   chat        the sticky chat of the page: anything the editor asks on any tab (with screenshots / pictures dragged
 *               in) — the agent gets the whole set (brief, masters, edits, regions, files, products) and every tool
 */
export type CtCharTaskStep = "brainstorm" | "master" | "edits" | "chat";

/** The tab of the page the editor was on when they wrote a chat request. */
export type CtCharChatTab = "brief" | "master" | "layers" | "product";

/** A picture sent with a chat request: a screenshot / file pasted or dropped, or a picture of the page dragged in. */
export interface CtCharChatAttachment {
  url: string;
  /** The page's own picture (master, edit, layer file…) when it was dragged from the page. */
  imageId: string | null;
  /** What it is, as the page knows it ("Master #2", "Người 1 — hair — lớp sau: Long Wavy · Auburn", "Ảnh chụp màn hình"). */
  label: string;
  source: "screenshot" | "file" | "page";
}

export interface CtCharTaskInput {
  projectId: string;
  step: CtCharTaskStep;
  /** What the editor wants, in their words (may be empty). */
  request: string;
  /** master: the master to refine (an in-place edit of it). */
  imageId: string | null;
  /** edits: only these roles (empty = whatever is missing). */
  roles: string[];
  /** chat: the tab the editor was on, its section ("3a" | "3b" | "3c" | ""), and the pictures sent with it. */
  tab?: CtCharChatTab;
  section?: string;
  attachments?: CtCharChatAttachment[];
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
