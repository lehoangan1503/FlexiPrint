/**
 * Mockups that show what the customer can change (asked 2026-11-17: "trong sản phẩm có custom được những gì thì nó sẽ
 * tự custom những thứ đó … custom được tên thì 5 dòng prompt sẽ là 5 cái tên khác nhau, có custom mặt người thì sẽ là
 * 5 mặt người"): one design per mockup prompt, each a different random pick of everything the customer chooses —
 *
 *   version            spread over the versions (1 person / 2 people, boy / girl), not twice the same while others wait
 *   custom layer       one of its options (linked layers follow, as always)
 *   zone option con    one of the zone's own options (a text's colour / font, a photo frame's shape)
 *   text the customer  types: a different name per mockup, written like the design's own sample ("The Smiths",
 *                      "Est. 2019", "EMMA"), within the zone's length; picks from a list / options: one of them
 *   photo zone         a request (`photos`) — the server styles a different sample person / pet for it
 *                      (server/mockup-samples.ts); a name-only zone gets a different name drawn by its style
 *
 * Pure: the editor's Mockups tab renders each selection itself (lib/compositor), the product list's bulk "Tạo mockup"
 * on the server (server/print-render).
 */

import { CT_MAIN_KEY } from "../types";
import type { CtMainOptionConfig, CtPhotoStyleRef, CtRegion, CtRegionItem, CtRenderAsset, CtSelection } from "../types";
import { activeRegions, isLinkedLayer, mainSubOptions, mainVersions, normalizeRegion, regionChoices, resolveLinked, textMode } from "./design";
import { onVersion } from "./layout";

/** A photo zone of one variant that needs a sample picture from the server. */
export interface CtMockupPhotoNeed {
  regionId: string;
  style: CtPhotoStyleRef;
  /** A different name for each variant (drawn by a name-only zone's style, or by a style that writes the name). */
  name: string;
}

export interface CtMockupVariant {
  selection: CtSelection;
  /** What was picked, short ("2 người · Emma & Noah · Hồng"). */
  label: string;
  photos: CtMockupPhotoNeed[];
}

/** What a product lets the customer change (the Mockups tab says it, and offers the random mockups only then). */
export interface CtCustomizable {
  versions: number;
  layers: number;
  texts: number;
  photos: number;
}

export const FEMALE_NAMES = ["Emma", "Olivia", "Ava", "Sophia", "Mia", "Isabella", "Amelia", "Harper", "Ella", "Lily", "Grace", "Chloe", "Zoe", "Nora", "Hazel", "Ruby"];
export const MALE_NAMES = ["Liam", "Noah", "Oliver", "James", "Elijah", "Lucas", "Henry", "Jack", "Leo", "Owen", "Ethan", "Mason", "Logan", "Wyatt", "Caleb", "Theo"];
const FIRST_NAMES = [...FEMALE_NAMES, ...MALE_NAMES];

/** Who the field names (its label / placeholder): "Mrs. Claus's name" → a woman's name, "Santa's name" → a man's. */
const FEMALE_HINT = /\b(mrs|ms|miss|mom|mommy|mama|mum|grandma|granny|nana|gigi|wife|girl|girls|daughter|sister|aunt|auntie|bride|her|she|lady|queen|princess|mother|grandmother)\b/i;
const MALE_HINT = /\b(mr|santa|dad|daddy|papa|grandpa|pops|husband|boy|boys|son|brother|uncle|groom|his|he|king|prince|man|father|grandfather)\b/i;
const SURNAMES = ["Smith", "Johnson", "Miller", "Davis", "Garcia", "Wilson", "Anderson", "Taylor", "Thomas", "Moore", "Martin", "Clark", "Lewis", "Walker", "Hall", "Young", "Allen", "King", "Wright", "Scott", "Baker", "Carter", "Turner", "Parker"];
const PET_NAMES = ["Bella", "Max", "Luna", "Charlie", "Daisy", "Milo", "Coco", "Rocky", "Bailey", "Teddy", "Lola", "Buddy", "Oreo", "Ginger", "Biscuit", "Pepper", "Mochi", "Simba", "Nala", "Ziggy"];

/** Capitalised words that are part of a sample text's wording, not a name to swap ("The", "Family", "Merry"…). */
const WORDING = new Set(
  (
    "the and of in on at to for with from by our my your his her their a an est est. since established family families " +
    "merry christmas xmas happy new year years birthday baby babys first 1st 2nd 3rd love loved loving forever always home " +
    "sweet mr mrs ms miss dr mom mommy mama mum dad daddy papa grandma grandpa granny nana nanny gigi pops grandmother " +
    "grandfather aunt auntie uncle sister brother sis bro son daughter wife husband bride groom couple wedding anniversary " +
    "best friends friend sisters brothers team club memorial loving memory heaven angel rip in ever our first together " +
    "personalized custom bed house home kitchen garden farm ranch cafe bakery shop co company crew squad tree ornament " +
    "dog cat pup puppy kitty pet pets life place lake cabin camp grill bar pub"
  ).split(/\s+/),
);

/** A word as WORDING lists it ("Est." → "est.", "Smiths," → "smiths", "Emma's" → "emma"). */
const wordKey = (w: string) => w.toLowerCase().replace(/['’]s$/, "").replace(/[^a-z0-9.]/g, "");

export const PET_HINT = /\b(pet|pets|dog|dogs|puppy|pup|cat|cats|kitten|kitty|paw|paws)\b|chó|mèo|thú cưng/i;

function shuffled<T>(list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Draws from a list in a random order, each value once before any repeats. */
class Deck<T> {
  private queue: T[] = [];
  constructor(private readonly list: T[]) {}
  next(fits: (v: T) => boolean = () => true): T | null {
    if (!this.list.length) return null;
    for (let round = 0; round < 2; round++) {
      if (!this.queue.length) this.queue = shuffled(this.list);
      const i = this.queue.findIndex(fits);
      if (i >= 0) return this.queue.splice(i, 1)[0];
      this.queue = [];
    }
    return null;
  }
}

const randInt = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));

/** A number like `digits`: a year for 4 digits, a day / month-ish small number otherwise (zero-padded like it). */
function swapNumber(digits: string, prev: string, next: string): string {
  if (digits.length === 4) return String(randInt(1965, new Date().getFullYear()));
  if (digits.length > 4) return Array.from(digits, (_, i) => String(i === 0 ? randInt(1, 9) : randInt(0, 9))).join("");
  // dd/mm or mm/dd: keep it a valid day and month (≤ 12 when it sits next to a separator either side).
  const dated = /[/.\-]/.test(prev) || /[/.\-]/.test(next);
  const n = dated ? randInt(1, 12) : randInt(1, Math.min(99, Math.max(9, Number(digits) * 2 || 9)));
  return digits.length === 2 ? String(n).padStart(2, "0") : String(n);
}

interface TextDecks {
  first: Deck<string>;
  female: Deck<string>;
  male: Deck<string>;
  last: Deck<string>;
  pet: Deck<string>;
}

export function newTextDecks(): TextDecks {
  return { first: new Deck(FIRST_NAMES), female: new Deck(FEMALE_NAMES), male: new Deck(MALE_NAMES), last: new Deck(SURNAMES), pet: new Deck(PET_NAMES) };
}

/**
 * A text a customer could have typed in place of the design's sample `sample`: its names swapped for other names
 * (a pet's when the field is about a pet), its numbers for other numbers, its wording kept ("The Smiths" → "The
 * Parkers", "Est. 2019" → "Est. 1987"). Within `maxChars` (0 = no limit); case like the sample's.
 */
export function sampleText(sample: string, maxChars: number, hint: string, decks: TextDecks): string {
  const pet = PET_HINT.test(hint);
  const female = FEMALE_HINT.test(hint) || FEMALE_NAMES.includes(sample.trim());
  const male = MALE_HINT.test(hint) || MALE_NAMES.includes(sample.trim());
  const firstDeck = pet ? decks.pet : female && !male ? decks.female : male && !female ? decks.male : decks.first;
  const src = sample.trim();
  const upper = src.length > 1 && src === src.toUpperCase() && /[A-Z]/.test(src);
  const lower = src.length > 1 && src === src.toLowerCase() && /[a-z]/.test(src);
  const cased = (s: string) => (upper ? s.toUpperCase() : lower ? s.toLowerCase() : s);
  const limit = maxChars > 0 ? maxChars : 40;

  const build = (room: number): string => {
    const name = () => cased(firstDeck.next((n) => n.length <= room) ?? firstDeck.next() ?? "Emma");
    const words = src.split(/\s+/).filter(Boolean);
    // Nothing to follow (empty, a placeholder like "Your name"): just a name.
    if (!src || (words.length <= 3 && /\b(your|name|names|text|here)\b/i.test(src))) return name();
    if (!/\d/.test(src) && !words.some((w) => (upper || /^[A-Z]/.test(w)) && !WORDING.has(wordKey(w)))) {
      // Only wording ("Merry Christmas", "Grandma"): kept — there is no name in it to change. A lowercase name: a name.
      return words.every((w) => WORDING.has(wordKey(w))) ? src : name();
    }
    const tokens = src.split(/(\s+|[&+,/]|\d+)/).filter((t) => t !== "");
    const out: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (/^\d+$/.test(t)) {
        out.push(swapNumber(t, tokens[i - 1] ?? "", tokens[i + 1] ?? ""));
        continue;
      }
      const word = t.match(/^([^A-Za-z]*)([A-Za-z][A-Za-z'’-]*)([^A-Za-z]*)$/);
      const core = word?.[2] ?? "";
      const key = core.toLowerCase();
      // Names only: a capitalised word (or any word of an all-caps sample) that is not part of the wording.
      if (!word || !(upper || /^[A-Z]/.test(core)) || WORDING.has(key) || WORDING.has(wordKey(core))) {
        out.push(t);
        continue;
      }
      const prevWord = tokens.slice(0, i).reverse().find((x) => /\S/.test(x)) ?? "";
      const nextWord = tokens.slice(i + 1).find((x) => /\S/.test(x)) ?? "";
      const surname = /^the$/i.test(prevWord) || /^famil/i.test(nextWord) || /^(mr|mrs|ms|dr)\.?$/i.test(prevWord);
      let name = (surname ? decks.last.next() : firstDeck.next()) ?? core;
      // "The Smiths" → "The Parkers", "Emma's" → "Ava's".
      if (surname && /s$/i.test(core) && /^the$/i.test(prevWord)) name = /(s|x|z|ch|sh)$/i.test(name) ? `${name}es` : `${name}s`;
      const possessive = core.match(/['’]s$/)?.[0] ?? "";
      out.push(`${word[1]}${upper ? name.toUpperCase() : name}${possessive}${word[3]}`);
    }
    return out.join("");
  };

  for (let tries = 0; tries < 6; tries++) {
    const t = build(limit);
    if (t.length <= limit) return t;
  }
  // Too long whatever the names: a short first name alone.
  return cased(firstDeck.next((n) => n.length <= limit) ?? src.slice(0, limit));
}

/** The versions the customer picks from, like the storefront: none when the version option is off (an artwork that
 * keeps an old picture as a second main — 2026-11-18 Nutcracker blanket — shows its default version only). */
function customerVersions<A extends CtRenderAsset>(assets: A[], main: Pick<CtMainOptionConfig, "enabled">, defaultMainId: string | null): A[] {
  return main.enabled ? mainVersions(assets, defaultMainId) : [];
}

/** Everything the customer can change on the product (versions with 2+ — only when the version option is on —,
 * layers with 2+ options, typed / picked texts, photo zones). Layers / zones of a version the customer never sees
 * are not counted. */
export function customizable(regions: CtRegion[], items: CtRegionItem[], assets: CtRenderAsset[], main: Pick<CtMainOptionConfig, "enabled">, defaultMainId: string | null): CtCustomizable {
  const mains = customerVersions(assets, main, defaultMainId);
  const seen = new Set(mains.length > 1 ? mains.map((m) => m.id) : [defaultMainId]);
  const rs = regions.map(normalizeRegion).filter((r) => !r.config.mainId || defaultMainId === null || seen.has(r.config.mainId));
  return {
    versions: mains.length > 1 ? mains.length : 0,
    layers: rs.filter((r) => r.kind === "image" && !isLinkedLayer(r, rs) && regionChoices(r, items, assets).length > 1).length,
    texts: rs.filter((r) => r.kind === "text" && textMode(r) !== "fixed").length,
    photos: rs.filter((r) => r.kind === "photo").length,
  };
}

export const isCustomizable = (c: CtCustomizable) => c.versions + c.layers + c.texts + c.photos > 0;

/** The words of a customizable summary ("3 version · 2 layer · 1 chữ · 1 ảnh khách"). */
export function customizableText(c: CtCustomizable): string {
  return [
    c.versions ? `${c.versions} version` : "",
    c.layers ? `${c.layers} layer có option` : "",
    c.texts ? `${c.texts} chữ` : "",
    c.photos ? `${c.photos} ảnh khách` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * `count` designs, each a different random pick of what the customer chooses (see the head of the file), starting
 * from `base` (the design's own content). Photo zones come back as `photos` to fill: the selection keeps the zone's
 * pick (option, style) with no picture yet.
 */
export function mockupVariants(input: {
  regions: CtRegion[];
  items: CtRegionItem[];
  assets: CtRenderAsset[];
  base: CtSelection;
  /** The product's version option (config.main): versions + their sub-options are picked only when it is on. */
  main: Pick<CtMainOptionConfig, "enabled" | "subOptions">;
  defaultMainId: string | null;
  count: number;
}): CtMockupVariant[] {
  const regions = input.regions.map(normalizeRegion);
  const { items, assets } = input;
  const mains = customerVersions(assets, input.main, input.defaultMainId);
  const mainDeck = new Deck(mains);
  const decks = newTextDecks();
  // One deck per layer / zone, so options spread over the mockups instead of repeating.
  const layerDecks = new Map<string, Deck<string | null>>();
  const deckOf = (key: string, list: Array<string | null>) => {
    let d = layerDecks.get(key);
    if (!d) layerDecks.set(key, (d = new Deck(list)));
    return d;
  };
  const out: CtMockupVariant[] = [];
  for (let i = 0; i < Math.max(1, input.count); i++) {
    const sel: CtSelection = { ...input.base };
    const label: string[] = [];
    let mainId = input.defaultMainId;
    // The version, then one of its own pictures (its sub-options, "Thêm option": the version itself first).
    const m = mains.length > 1 ? mainDeck.next() : (mains[0] ?? null);
    if (m) {
      const subs = mainSubOptions(assets, input.main, m.id);
      const optionId = subs.length ? deckOf(`${CT_MAIN_KEY}:${m.id}`, [null, ...subs.map((o) => o.id)]).next() : null;
      sel[CT_MAIN_KEY] = { kind: "main", assetId: m.id, optionId };
      mainId = m.id;
      const sub = subs.find((o) => o.id === optionId);
      if (mains.length > 1 || sub) label.push(sub ? `${m.name} (${sub.name})` : m.name);
    } else delete sel[CT_MAIN_KEY]; // version option off: the default version, whatever the editor is showing
    const mine = regions.filter((r) => mainId === null || onVersion(r, mainId));
    const photos: CtMockupPhotoNeed[] = [];
    for (const r of mine) {
      const optionIds = [null, ...r.config.options.list.map((o) => o.id)];
      if (r.kind === "image") {
        if (isLinkedLayer(r, regions)) continue;
        const choices: Array<string | null> = regionChoices(r, items, assets).map((c) => c.asset.id);
        if (r.config.image.allowNone) choices.push(null);
        if (choices.length < 2) continue;
        sel[r.id] = { kind: "image", assetId: deckOf(r.id, choices).next() ?? null };
      } else if (r.kind === "text") {
        const t = r.config.text;
        const mode = textMode(r);
        const optionId = optionIds.length > 1 ? deckOf(`${r.id}:opt`, optionIds).next() : null;
        if (mode === "fixed") continue;
        if (mode === "list") {
          const choice = deckOf(r.id, t.choices.filter(Boolean)).next();
          sel[r.id] = { kind: "text", text: choice ?? t.defaultText, optionId };
        } else if (mode === "options") {
          sel[r.id] = { kind: "text", text: "", optionId };
        } else {
          const prev = input.base[r.id];
          const sample = prev?.kind === "text" && prev.text ? prev.text : t.defaultText || t.placeholder;
          const text = t.format === "date" ? sampleText(sample || "05/12/2019", t.maxChars, "", decks) : sampleText(sample, t.maxChars, `${t.label} ${t.placeholder}`, decks);
          sel[r.id] = { kind: "text", text, optionId };
          label.push(text);
        }
      } else if (r.kind === "photo") {
        const p = r.config.photo;
        const style = p.styles.length > 1 ? (deckOf(`${r.id}:style`, p.styles).next() as CtPhotoStyleRef | null) ?? p.defaultStyle : p.defaultStyle;
        const optionId = optionIds.length > 1 ? deckOf(`${r.id}:opt`, optionIds).next() : null;
        sel[r.id] = { kind: "photo", url: null, transform: { offsetX: 0, offsetY: 0, scale: 1, rotation: 0 }, style, sourceUrl: null, optionId };
        const name = sampleText("", p.name?.maxChars ?? 0, `${p.label} ${p.name?.label ?? ""}`, decks);
        photos.push({ regionId: r.id, style, name });
        if (p.input === "name") label.push(name);
      }
    }
    const selection = resolveLinked(regions, items, assets, sel);
    // A photo zone that only shows under an option the variant did not pick needs no picture.
    const shown = new Set(activeRegions(mine, selection).map((r) => r.id));
    out.push({ selection, label: label.join(" · "), photos: photos.filter((p) => shown.has(p.regionId)) });
  }
  return out;
}
