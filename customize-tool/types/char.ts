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
  /** The customer may also pick none of it ("NO" glasses, asked 2026-10-18): the options are drawn as usual, the
   * product's layer gets a "None" choice. */
  optional?: boolean;
  /** Not a choice of its own: shows the option at the same position as this decoration or chooser (brief.elements /
   * brief.choosers id) — the sweaters and hats of a family follow the theme the customer picks. Same option count and order. */
  follows?: string | null;
  /** Only there while a chooser shows one option (a boy's hair while "Grandchild 1" is "Boy"). */
  shownWhen?: CtCharShownWhen | null;
  /**
   * Drawn together (asked 2026-10-19: a picture per option per grandchild was 60+ pictures): every slot of the set with
   * the same group — one per subject (each grandchild's hair) — has its option k drawn in ONE picture for everyone;
   * each subject's file is cut from it on its own side. Options are matched by position.
   */
  group?: string | null;
  /**
   * Drawn ON a picture of this group (the outfit with the hat) and cut against it, not the doll (asked 2026-10-19: hair
   * drawn on the bald doll stuck out from under the Santa hats): the hair is drawn UNDER the hats and only what shows is
   * kept — so in the product it lies OVER that outfit, like in 3c (the outfit is never split around it).
   */
  on?: string | null;
  /** The options after the first are drawn from the first one's picture (the Halloween / Easter hats on the Santa
   * hats' band — the hair drawn under it fits them all); still cut against the doll. */
  restyle?: boolean;
  /** A worn outfit whose top piece (above the face) is headwear. Hair drawn under it (a hair slot with `on` = this slot
   * or its group): the product keeps the cut's order, the hair over the whole outfit (2026-10-29: the hat over the hair
   * showed the brim's shadow on the forehead as a skin line). Hair drawn on the bald doll (no `on`): the hat becomes its
   * own layer over the hair, the rest (the sweater) under it. */
  headwear?: boolean;
  /**
   * The same customer choice as that slot of the same character (asked 2026-10-30: hair drawn under each kind of hat —
   * a Santa hat, a witch hat with a wide brim, no hat — is one slot per kind, each with shownWhen its theme): one
   * picker for all of them in the product (empty pictures with that slot's thumbnails, every one of them follows it),
   * so the hair the customer picked stays when the theme changes. Same options, colours and order as that slot.
   */
  sameAs?: string | null;
  /**
   * The colour (#rrggbb) its 3b pictures draw the part in, when the real colour is (nearly) that of what it lies on or
   * against (asked 2026-10-30: silver hair under a white fur brim, a white sweater on a white doll hand — the cut finds
   * no edge between them): a colour far from its neighbours, mid-light so the shading stays. Every colour the customer
   * picks is then a recolour of that drawing, the first one too; the master keeps the real colour.
   */
  cutColor?: string | null;
}

/** A condition on a chooser (brief.choosers): the part / text / decoration exists only while it shows `option`. */
export interface CtCharShownWhen {
  chooser: string;
  option: string;
}

/**
 * A customer choice that draws nothing itself and only decides which parts exist (asked 2026-10-18: each grandchild a
 * boy or a girl, the grandparent a grandma or a grandpa, hats or no hats): the parts, texts and decorations with
 * `shownWhen` on it come and go. `subject` = it belongs to that character (only in the versions that have them).
 */
export interface CtCharChooser {
  id: string;
  /** What the customer is asked, English: "Grandchild 1", "Hats". */
  label: string;
  /** The first one is the master's / the default. */
  options: CtCharOption[];
  subject?: string | null;
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
  /** What the customer calls this character, English ("Boy", "Person 1") — the version name when the customer picks
   * who is in the picture (brief.lineup), and the start of its options' labels. Empty = from the description. */
  name?: string;
  /** Always in the picture whatever the lineup (the grandma the grandchildren gather round). */
  always?: boolean;
}

/**
 * Who is in the picture is itself a customer choice (asked 2026-10-18: a graduation ornament of a boy OR a girl; a
 * family rug of 1–5 people). Every subject is drawn once in the master, standing apart; the product gets one version
 * per choice (CtMainOptionConfig), each with only its subjects' layers, laid out on their own:
 *   one    the customer picks ONE subject (a version per subject, named by subject.name)
 *   count  the customer picks how many: version k = the first k subjects from the left, same size, centred
 */
export interface CtCharLineup {
  mode: "one" | "count";
  /** What the customer is asked, English: "Choose character", "Number of people". */
  label: string;
  /**
   * Every version is drawn as its OWN picture (asked 2026-10-19: grandma + 1 grandchild cut out of the row of five
   * looked patchy): this set is the biggest version; each smaller one is a version set (brief.versionOf) with its own
   * master, doll and cut, and the product takes each version's layers from its own set.
   */
  drawn?: boolean;
}

/** A version set: one version of a set drawn on its own (brief.lineup.drawn) — not listed, built into the parent's product. */
export interface CtCharVersionOf {
  /** The parent set. */
  id: string;
  /** The version's customer name ("1", "2 People"). */
  name: string;
  /** Its position among the parent's versions (0 = the first). */
  index: number;
  /** Its 3b plan was written for it (char_plan_pictures with its set_id); else it follows the parent's plan. */
  ownPictures?: boolean;
  /** A POSE set (brief.poses of the parent, asked 2026-10-21): one character of the parent drawn alone in this pose —
   * the pose id; its files are placed in every version of the parent's product by brief.compose. */
  pose?: string;
}

/**
 * A pose of a set with several characters (asked 2026-10-21: "tất cả búp bê nên vẽ độc lập" — characters drawn
 * together in one picture got their hair and hats stuck to each other when cut): ONE character drawn alone, big, on
 * its own square canvas — its own master, doll, 3b pictures and files (a pose set, brief.versionOf.pose). Characters
 * standing the same way share a pose (two grandchildren on the left with the head tilted right): drawn once, placed
 * twice; one on the other side may use it mirrored. The product's versions are composed of the poses' files
 * (brief.compose).
 */
export interface CtCharPose {
  id: string;
  /** For the page, Vietnamese: "Bà ở giữa", "Cháu bên trái". */
  name: string;
  /** English, for the image model: the pose, the angle, where the head tilts ("leaning forward, chin on both hands,
   * head tilted slightly to the right"). The character's look comes from the subject it is drawn as. */
  description: string;
  /** The subjects (ids) drawn with this pose; the first is the one drawn, the others have the same parts and options. */
  subjects: string[];
  /** Subjects of `subjects` placed mirrored (the grandchildren on the right of a pose drawn facing the middle from the left). */
  mirrored: string[];
}

/** One character in a composed version: where its figure goes, in any units the version shares (the server fits the
 * whole group into the product's characters area). */
export interface CtCharComposePerson {
  /** The brief subject id. */
  subject: string;
  /** The figure's centre, left → right. */
  x: number;
  /** The figure's bottom (its feet / the cut line), downwards. */
  y: number;
  /** The figure's height (the grandma 1, the children 0.8). */
  h: number;
  /** Mirrored (default: as in its pose's `mirrored`). */
  flip?: boolean;
}

/** A version of the product composed of poses (asked 2026-10-21: @flexiprint places the characters of each version
 * to look like the sample). `people` back → front: a later one is drawn over an earlier one where they overlap. */
export interface CtCharComposeVersion {
  /** The version's customer name (lib/char-lineup charVersions: "1", "2"… or the only one ""). */
  name: string;
  people: CtCharComposePerson[];
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
  /** treat "ai": the styles offered, first = default. A bộ ảnh khách's own styles (asked 2026-10-28: "4 kiểu: khăn
   * choàng, bộ đồ siêu nhân áo choàng đỏ, dây đèn quấn quanh…") are ct_ai_styles rows made for the set
   * (params.setId, server/char/photo-styles.ts) — each becomes one style option on the storefront. */
  styles?: string[];
  /** Customer-like photos the editor tests every style on (step 3 "Style ảnh khách"; uploaded, ≤ 6). */
  testPhotos?: string[];
  /** A bộ ảnh khách: where the photo sits on the piece (shares of the safe area); null = the middle, above the texts. */
  box?: CtCharBox | null;
}

/** A bộ ảnh khách's AI style (a ct_ai_styles row — server/char/photo-styles.ts) as the page and the agent see it. */
export interface CtCharPhotoStyle {
  id: string;
  ref: string;
  name: string;
  prompt: string;
  refUrls: string[];
  demoUrl: string;
  /** Offered by the zone (else made for the set and taken off). */
  offered: boolean;
  /** Made for this set (a library style the zone also offers is false: edited in the library). */
  own: boolean;
  updated_at: string;
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
 *   plaque  a bộ nhân vật's sign in front of the characters' cut-off bottom ("This Grandma Belongs To"): as wide as the
 *           group of each version, about a quarter of the piece's height, the forearms resting on its top edge
 */
export type CtCharElementPlace = "behind" | "above" | "bottom" | "free" | "plaque";

/** One decoration the customer picks (bộ ảnh khách), or a decoration of a bộ nhân vật (asked 2026-10-18: a "Class of"
 * scroll, a ribbon banner, the year in glitter numbers, a Christmas tree beside the family) — drawn ALONE in the
 * master's look, never cut; a single option is simply drawn (no choice). */
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
  /** Another element (or a chooser) whose choice this one shows at the same position (the right-hand decoration and the
   * ground follow the left-hand one's theme; the sign follows the Theme chooser): not a customer choice, same option count. */
  follows?: string | null;
  /** Drawn in front of the characters (the year over the gown); default = behind them. A bộ nhân vật only. */
  front?: boolean;
  shownWhen?: CtCharShownWhen | null;
}

/** Where a text sits on the product, around the characters — "under": under one character (`subject`), the name of
 * each person of a family rug; "free": `box`; "on": over one character (`subject`) at `box` = shares of THAT
 * character's own box (a name on a hat's brim, on a sweater); "plaque": on the sign in front of the characters
 * (brief.elements place "plaque"), sized with it in every version. */
export type CtCharTextPlace = "top" | "bottom" | "left" | "right" | "under" | "free" | "on" | "plaque";

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
  /** input = typed · choice = picked from `choices` · fixed = `defaultText` as it is (no field — "This Grandma Belongs
   * To", one per grandparent option with shownWhen). */
  kind: "input" | "choice" | "fixed";
  defaultText: string;
  choices: string[];
  /** A Google font of config.ts CT_FONTS. */
  font: string;
  /** #rrggbb */
  color: string;
  place: CtCharTextPlace;
  maxChars: number;
  /** place "under": the subject (id) it is the name of — shown only with that subject. */
  subject?: string | null;
  /** place "free": shares of the safe area. */
  box?: CtCharBox | null;
  /** Letters drawn upper-case. */
  uppercase?: boolean;
  shownWhen?: CtCharShownWhen | null;
  /** Bowed along an arc (-100..100, positive ∩) — a name along a hat's brim. */
  curve?: number;
  /** place "on" a hat whose band is not its widest low part (a witch hat: the band above the wide brim, 2026-10-30):
   * `box` (shares of the character's box) marks where the band is; the server finds the band inside it. Without it
   * the band is found on its own and `box` is used only on a character without a hat. */
  band?: boolean;
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
  /** A repeating pattern (buffalo plaid): drawn as one seamless tile and repeated over the piece — sharp on a 120 cm
   * rug, where one picture stretched over it would blur. */
  tile?: boolean;
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
  /** Where the characters go on the piece (shares of the safe area); null = laid out around the texts. */
  charactersBox?: CtCharBox | null;
  /** Choices that only decide which parts exist (boy / girl, hats / no hats). */
  choosers?: CtCharChooser[];
  /** Who is in the picture is a customer choice (null = everyone, always). */
  lineup?: CtCharLineup | null;
  /** This set is one version of another (brief.lineup.drawn there) or one of its poses (brief.poses there). */
  versionOf?: CtCharVersionOf | null;
  /** Every character drawn alone in a pose (a pose set each); null = the characters drawn together in the master. */
  poses?: CtCharPose[] | null;
  /** How each version places the poses' characters (@flexiprint, char_compose); null = side by side in order. */
  compose?: CtCharComposeVersion[] | null;
  /** How much of the characters the master shows: "full" head to toe (default), or "bust" = chest up, cut level at
   * the bottom (a sign / plank element in front hides the cut — "This Grandma Belongs To"). */
  framing?: "full" | "bust";
  /** The texts the customer personalises (names, a slogan), each in its place around the characters. */
  texts: CtCharTextField[];
  /** The backgrounds the customer picks from (none = the product's own colour); never part of the master. */
  backdrops: CtCharBackdrop[];
  /** Lifestyle mockup scenes. */
  mockups: string[];
  /** The 3b pictures, planned by @flexiprint for THIS set (lib/char-pictures.ts). Absent = the older built-in plan
   * (lib/char-plan.ts rules). */
  pictures?: CtCharPlanPicture[] | null;
  /** A set imported from finished files (Teeinblue export…, asked 2026-10-29) — no master, no cut: its product is built
   * from the uploaded layer files (server/char/import.ts). Absent = a set drawn by AI. */
  imported?: CtCharImported | null;
}

/**
 * A bộ imported from someone's own finished files (asked 2026-10-29: "bộ đủ, dùng với teeinblue ok rồi"). The folder is
 * uploaded file by file to `<set folder>/import/<its path>`; a known format is read by the server (lib/char-import.ts),
 * any other by @flexiprint (MCP char_import_files → char_import_build), both into a CtCharImportManifest the set's product
 * is built from.
 */
export interface CtCharImported {
  status: "uploading" | "analyzing" | "agent" | "building" | "done" | "failed";
  /** "teeinblue" (read by the server) or "agent" (@flexiprint wrote the manifest). */
  format: string;
  /** Uploaded files and their total bytes. */
  files: number;
  bytes: number;
  /** JSON list of the uploaded files (CtCharImportFile[]) on R2. */
  indexUrl: string;
  /** The manifest the product was built from (JSON on R2). */
  manifestUrl: string;
  /** Building: layer files done of total. */
  done: number;
  total: number;
  error: string;
  /** What the import found, shown on the set's page: "18 trường hợp · 6 phiên bản × 3 kiểu…". */
  summary: string[];
  /** Files that did not fit (another size than the canvas…): left out, named here. */
  problems: string[];
  /** The product being built (a build cut off by a restart leaves it half made: the next build removes it). */
  productId?: string;
  /** Last sign of life of the build (ISO) — none for minutes = cut off (the app restarted). */
  beat?: string;
  /** The built product sent to Shopify as a draft right away (server/char/import-deploy.ts). */
  shopify?: CtCharImportShopify;
}

/** An import's own deploy: a Shopify draft and the link that opens it in the draft theme. */
export interface CtCharImportShopify {
  status: "deploying" | "done" | "failed";
  /** Staff preview in the draft theme (expires; a new deploy makes a new one). */
  previewUrl: string;
  adminUrl: string;
  /** The price table it took (by the material). */
  priceTable: string;
  error: string;
  at: string;
  /** What a deploy again takes (the uploaded folder is gone by then): the folder's title, description, material. */
  title: string;
  description: string;
  material: string;
}

/** One uploaded file of an import: its path in the folder, where it is. */
export interface CtCharImportFile {
  path: string;
  url: string;
  size: number;
}

/**
 * What an imported set is made of — every source format comes to this. Every image file is a whole-canvas PNG of
 * `canvas` size (layer rules: pixel-registered, never trimmed or scaled).
 */
export interface CtCharImportManifest {
  name: string;
  canvas: { width: number; height: number };
  /** Print resolution (300) and the piece's width in mm, when the source says. */
  dpi: number;
  widthMm: number;
  /** A CT_MATERIALS id ("acrylic_clear"…) or "". */
  material: string;
  /** Die-cut along the artwork (custom-cut acrylic) or printed on a fixed shape. */
  cut: "alpha" | "rect";
  title: string;
  description: string;
  /** The customer's first choice: one version each ("Number of grandkids": 1…6). */
  versionLabel: string;
  /** Inside a version, a second choice when its variants differ ("Layout"): a chooser layer, each variant's layers
   * under its option. */
  variantLabel: string;
  versions: CtCharImportVersion[];
  /** The finished look (a sample / master) and the sales photos. */
  sampleUrl: string;
  mockupUrls: string[];
}

export interface CtCharImportVersion {
  name: string;
  variants: CtCharImportVariant[];
}

export interface CtCharImportVariant {
  name: string;
  /** Bottom first. */
  layers: CtCharImportLayer[];
  texts: CtCharImportText[];
}

export interface CtCharImportLayer {
  /** Its name in the source ("05-ba-than"). */
  key: string;
  /** Customer-facing ("Grandma — Outfit"). */
  label: string;
  /** static: always shown, one file · choice: the customer picks · linked: follows layer `follows` (same group / option
   * position — its groups mirror the leader's). */
  kind: "static" | "choice" | "linked";
  follows: string;
  /** Label of the group row ("Skin tone") when there are 2+ groups. */
  groupLabel: string;
  groups: CtCharImportGroup[];
  /** Its option pictures show the layers that follow it drawn in (the hair under a hat: the choice is the hat, the
   * file only a sliver of hair). */
  thumbWithFollowers?: boolean;
}

export interface CtCharImportGroup {
  name: string;
  /** #hex: the group is picked by a colour dot. */
  swatch: string;
  options: CtCharImportOption[];
}

export interface CtCharImportOption {
  name: string;
  url: string;
  /** The option the customer starts on. */
  default: boolean;
}

export interface CtCharImportText {
  key: string;
  label: string;
  sample: string;
  maxChars: number;
  /** Google font family + weight ("Baloo 2", 800). */
  font: string;
  weight: number;
  /** Letter height px, the text's centre and max width on the canvas, turned `angle` degrees clockwise. */
  size: number;
  cx: number;
  cy: number;
  width: number;
  angle: number;
  color: string;
  /** The text lies right above this layer (its key); "" = above everything. */
  above: string;
}

/**
 * One 3b picture of an agent's plan (asked 2026-10-19: what to draw is decided per set by @flexiprint — products are
 * too varied for rules in code). The server only checks the plan, draws it in order and cuts it: a clipart file is the
 * picture's pixels that differ from the doll (or from `against`), on its subject's own side of the canvas.
 */
export interface CtCharPlanPicture {
  /** "base" = the paper doll (body file, drawn from "work") · "zone:<photo zone id>" · "thumb:<slot id>:<option id>"
   * (a shop thumbnail, never cut) · any other id of the agent's ("hair-1", "outfit-xmas"). */
  role: string;
  /** Vietnamese, for the page. */
  label: string;
  /** What it is drawn from: "work" (the approved master) or another picture's role. */
  source: string;
  /** English: the change, said once for everyone (the server adds the keep-everything sentence). */
  prompt: string;
  /** One line per character, kept only in a set that has that character (a version without them drops it). */
  lines?: CtCharPictureLine[];
  /** The options this picture draws, at most one slot per subject (each subject's file is cut on its own side). */
  covers: CtCharPictureCover[];
  /** Cut against this picture instead of the doll (hair drawn under the hats of the outfit picture). */
  against?: string | null;
  /** Thin features (eyes, brows, a mouth): small pieces kept. */
  fine?: boolean;
}

export interface CtCharPictureLine {
  /** Subject id. */
  subject: string;
  /** English; "{who}" = how the image model is told which character it is. */
  text: string;
}

export interface CtCharPictureCover {
  /** Slot id. */
  slot: string;
  /** Option id. */
  option: string;
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

/** The "phần nằm sau" editor's artwork (server/char/behind.ts behindStage): the parent's biggest version, whole. */
export interface CtBehindPlate {
  /** A picture of every layer between two copies of the edited layer (render px). */
  url?: string;
  /** A copy of the edited layer: its canvas's box on the artwork (render px), mirrored or not, and its picture for the
   * option shown on the pose canvas (a hat-and-sweater outfit: the hat or the sweater). */
  box?: { x: number; y: number; w: number; h: number };
  flip?: boolean;
  layerUrl?: string;
}

export interface CtBehindStage {
  width: number;
  height: number;
  /** Back → front: pictures and the copies of the layer, in the product's stacking order. */
  plates: CtBehindPlate[];
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
  /** A pose set's "phần nằm sau" (server/char/behind.ts): a mask on the canvas — inside it the WHOLE doll (every layer,
   * in its own order) lies behind every other character of the parent's product. */
  behindUrl?: string;
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
  /** The layer-kit job while it runs: whether a plan still runs is asked there, not guessed from the clock. */
  job?: string;
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
 *   auto        everything after the master is approved, on its own (asked 2026-10-18): 3a → the 3b pictures (drawn,
 *               checked, redrawn) → the cut → step 4 (backgrounds, decorations, the product, mockups); the editor only
 *               watches it — "Dừng" cancels the task, then they ask for changes in the chat
 *   chat        the sticky chat of the page: anything the editor asks on any tab (with screenshots / pictures dragged
 *               in) — the agent gets the whole set (brief, masters, edits, regions, files, products) and every tool
 */
export type CtCharTaskStep = "brainstorm" | "master" | "edits" | "chat" | "auto";

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

/** One version set of a drawn lineup as the parent's page shows it (GET char/projects/:id/versions). */
export interface CtCharVersionCard {
  project: CtCharProject;
  /** Its masters, newest last. */
  masters: Array<{ id: string; status: CtCharImageStatus; thumbUrl: string; url: string }>;
  /** 3b pictures the cut needs: done / all. */
  edits: { done: number; total: number; running: number; failed: number };
}

/** A bộ nhân vật a product uses (GET char/projects?product=:id): the one it was built from (own) or one dropped into it. */
export interface CtProductCharSet {
  id: string;
  name: string;
  own: boolean;
}

/** A product a bộ nhân vật is used in (GET char/projects/:id/used-by): its own (built from it) or one it was dropped into. */
export interface CtCharSetProduct {
  id: string;
  name: string;
  thumbnail_url: string | null;
  created_at: string;
  own: boolean;
}
