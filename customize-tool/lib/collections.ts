/**
 * Which of the store's collections a product belongs in (asked 2026-10-30: "cho dùng lại các collection, tránh tạo
 * nhiều, tạo trùng — sản phẩm deploy cũng xem tìm collection phù hợp, không có thì mới tạo"). A smart collection
 * (rule-based, e.g. CHERIVIA's "For Family" = tag family) is joined by giving the product what its rules ask
 * (server/shopify.ts smartNeeds); a manual one by adding the product to it.
 */

import type { CtShopifyCollection } from "../types";

/** Words in a product's title / description / tags that put it in a collection keyed by this tag. */
const TAG_WORDS: Record<string, string[]> = {
  ornament: ["ornament", "ornaments"],
  family: ["family", "grandma", "grandpa", "grandmother", "grandfather", "nana", "papa", "mom", "dad", "mother", "father", "grandkid", "grandkids", "grandchild", "grandchildren", "sister", "sisters", "brother", "brothers", "siblings"],
  couples: ["couple", "couples", "husband", "wife", "boyfriend", "girlfriend", "anniversary", "valentine"],
  baby: ["baby's first", "babys first", "baby first", "newborn"],
  pets: ["pet", "pets", "dog", "dogs", "cat", "cats", "puppy", "kitten", "paw", "woofmas", "meowy"],
  memorial: ["memorial", "in loving memory", "in heaven", "rainbow bridge", "remembrance", "sympathy"],
  photo: ["photo", "picture", "portrait from your photo"],
  friends: ["friend", "friends", "bestie", "besties", "bff"],
};

/** Collections never picked for a product by itself: shipping groups (by product type) and editorial picks. */
const NEVER = /^(ship\b|home ?page$|trending|best ?sellers?|new arrivals?|sale\b)/i;

/** Product kinds: a collection named after one ("Photo Ornaments") only takes products of that kind. */
const KINDS = ["ornament", "doll", "mug", "tumbler", "shirt", "sweatshirt", "hoodie", "blanket", "pillow", "rug", "bag", "canvas", "poster", "plaque", "sign", "necklace", "keychain", "candle"];

const STOP = new Set(["for", "the", "and", "with", "your", "gift", "gifts", "personalized", "custom", "collection", "page", "home"]);

const norm = (t: string) => ` ${t.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ")} `;
const has = (text: string, word: string) => text.includes(` ${word} `);

/** The collections the product fits, best first (the first is the breadcrumb). */
export function suggestCollections(collections: CtShopifyCollection[], product: { title: string; description?: string; tags?: string[] }): CtShopifyCollection[] {
  const text = norm([product.title, product.description ?? "", ...(product.tags ?? [])].join(" ").replace(/<[^>]*>/g, " "));
  const out: Array<{ c: CtShopifyCollection; score: number }> = [];
  const title = norm(product.title);
  const kindOf = (t: string) => KINDS.filter((k) => has(t, k) || has(t, `${k}s`));
  for (const c of collections) {
    if (NEVER.test(c.title) || NEVER.test(c.handle)) continue;
    const kinds = kindOf(norm(c.title));
    if (kinds.length && !kinds.some((k) => kindOf(text).includes(k))) continue;
    let score = 0;
    if (c.smart) {
      // A tag rule: the product's words for that tag.
      for (const r of c.rules) {
        if (r.column !== "TAG" || r.relation !== "EQUALS") continue;
        const tag = r.condition.toLowerCase();
        const words = TAG_WORDS[tag] ?? [tag];
        const hits = words.filter((w) => has(text, w)).length;
        if (hits) score = Math.max(score, hits + (has(title, words[0]) ? 2 : 0));
      }
    } else {
      // A manual one: the meaningful words of its title.
      const words = norm(c.title).trim().split(" ").filter((w) => w.length > 2 && !STOP.has(w));
      const hits = words.filter((w) => has(text, w) || has(text, w.replace(/s$/, ""))).length;
      if (words.length && hits === words.length) score = hits + 1;
    }
    // The collection of the product's own kind leads (the breadcrumb: Home › Christmas Ornaments › …).
    if (score > 0) out.push({ c, score: score + (kinds.some((k) => kindOf(title).includes(k)) ? 10 : 0) });
  }
  return out.sort((a, b) => b.score - a.score).map((x) => x.c);
}

/** A collection with this title already (case, spaces and a final "s" ignored) — reused instead of a twin. */
export function sameCollection(collections: CtShopifyCollection[], title: string): CtShopifyCollection | null {
  const key = (t: string) => norm(t).trim().replace(/s$/, "");
  const want = key(title);
  return collections.find((c) => key(c.title) === want) ?? null;
}
