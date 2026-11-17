/**
 * Sample customer photos for the mockups (asked 2026-11-17: "có custom mặt người thì sẽ là 5 mặt người đưa lên"): each
 * mockup of a product with a photo zone shows a different person (or pet), run through the zone's own style exactly
 * like a customer's upload — the face cut, the AI style, the cut-out.
 *
 *   POST products/:id/mockups/samples   { regionId, items: [{ style, name }] } → { samples: [{ url, error }] }
 *                                       one styled picture per item, in order (the editor's Mockups tab)
 *
 * The people / pets are a shared pool of AI photos (ct_pack_images rows "mockup-sample:person|pet", not listed): drawn
 * once each from a list of different looks, up to POOL_TARGET per kind, then reused — a style already run on a pool
 * photo comes from the photo cache for free. A name-only zone (CtPhotoConfig.input "name") gets the item's name drawn
 * by its style instead.
 */

import { NextResponse } from "next/server";
import { CT_CONFIG, CT_TABLES } from "../config";
import type { CtAiStyle, CtPackImage, CtPhotoStyleRef, CtProduct, CtRegion } from "../types";
import { normalizeProductConfig, normalizeRegion } from "../lib/design";
import { shapeBounds } from "../lib/geometry";
import { faceTargets } from "../lib/face-center";
import { isAiStyleRef, isPhotoStyleRef, styleFamily } from "../lib/photo-styles";
import { CT_IMAGE_MODEL } from "../lib/image-models";
import { CT_MOCKUP_SCENES_MAX } from "../lib/mockup-scenes";
import { PET_HINT, type CtMockupVariant } from "../lib/mockup-variants";
import { processPhoto } from "./ai/photo";
import { isAdmin, loadAiStyle } from "./ai-styles";
import { fetchImage } from "./char/files";
import { drawImage } from "./pack-images";
import { finishPhoto } from "./photo-tasks";
import { ctUpload } from "./storage";
import { ctServiceClient, type CtSession } from "./supabase";

export interface CtMockupSampleItem {
  style: CtPhotoStyleRef;
  name: string;
}

export interface CtMockupSample {
  url: string | null;
  error: string;
}

type Subject = "person" | "pet";

/** Pool size per kind: new looks are drawn until there are this many, then the pool is only reused. */
const POOL_TARGET = 14;

const poolName = (kind: Subject) => `mockup-sample:${kind}`;

const PEOPLE = [
  "a smiling woman in her late 20s with long wavy brown hair",
  "a man in his 30s with short dark hair and a trimmed beard",
  "a cheerful Black woman in her 30s with curly natural hair",
  "an East Asian man in his 20s with neat black hair",
  "a grandmother in her 70s with short silver hair and glasses",
  "a grandfather in his 70s with white hair and a warm smile",
  "a little girl about 6 years old with blonde pigtails",
  "a little boy about 7 years old with short brown hair and freckles",
  "a Latina woman in her 40s with shoulder-length dark hair",
  "a red-haired man in his 40s with a friendly smile",
  "a South Asian woman in her 30s with long black hair",
  "a teenage boy about 15 with curly dark hair",
  "a blonde woman in her 50s with a short bob",
  "a Black man in his 50s with a short grey beard",
  "a baby about 1 year old with chubby cheeks",
  "a young woman in her 20s with a pixie cut",
];

const PETS = [
  "a golden retriever",
  "an orange tabby cat",
  "a French bulldog",
  "a black-and-white tuxedo cat",
  "a beagle",
  "a Pembroke Welsh corgi",
  "a fluffy grey Persian cat",
  "a Siberian husky with blue eyes",
  "a chocolate Labrador",
  "a Siamese cat",
  "a long-haired dachshund",
  "a pug",
  "a border collie",
  "a Shih Tzu with a little bow",
  "a calico cat",
  "a chihuahua",
];

function portraitPrompt(kind: Subject, look: string): string {
  return kind === "pet"
    ? `Casual smartphone photo of ${look}, a real pet at home, sitting and looking at the camera, its whole head and chest in the picture, plain softly lit light-grey wall behind, even daylight, sharp focus, realistic photo. No text, no watermark, no other animals or people.`
    : `Casual smartphone photo of ${look}, a real person at home, head and shoulders, facing the camera with a natural smile, eyes open, plain softly lit light-grey wall behind, even daylight, sharp focus on the face, realistic photo. No text, no watermark, nobody else in the picture.`;
}

function shuffled<T>(list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** `want` different source photos of `kind` (the pool grows by the ones it lacks, up to POOL_TARGET). */
async function poolPhotos(s: CtSession, kind: Subject, want: number): Promise<Array<{ data: Buffer; mime: string }>> {
  const db = ctServiceClient() ?? s.supabase;
  const { data } = await db.from(CT_TABLES.packImages).select("*").eq("name", poolName(kind)).eq("status", "done").not("url", "is", null).limit(100).returns<CtPackImage[]>();
  const have = data ?? [];
  const looks = kind === "pet" ? PETS : PEOPLE;
  const missing = shuffled(looks.filter((l) => !have.some((r) => r.description === l)));
  const toDraw = have.length < POOL_TARGET ? missing.slice(0, Math.min(want, POOL_TARGET - have.length)) : [];
  const drawn = await Promise.allSettled(
    toDraw.map(async (look) => {
      const prompt = portraitPrompt(kind, look);
      const out = await drawImage(CT_IMAGE_MODEL, prompt, [], "1:1", "crop");
      const ext = out.mime === "image/png" ? "png" : "jpg";
      const url = await ctUpload(`${s.user.id}/${CT_CONFIG.storagePrefix}/mockup-samples/${kind}-${crypto.randomUUID()}.${ext}`, out.data, out.mime);
      await db.from(CT_TABLES.packImages).insert({ user_id: s.user.id, name: poolName(kind), source: "ai", status: "done", listed: false, description: look, prompt, refs: [], aspect: "1:1", model: CT_IMAGE_MODEL, url, mime: out.mime });
      return { data: out.data, mime: out.mime };
    }),
  );
  const fresh = drawn.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const out = [...fresh];
  for (const row of shuffled(have)) {
    if (out.length >= want) break;
    try {
      const buf = await fetchImage(row.url!);
      out.push({ data: buf, mime: row.mime || "image/jpeg" });
    } catch {
      // A lost picture: the next one.
    }
  }
  if (!out.length) {
    const why = drawn.find((r): r is PromiseRejectedResult => r.status === "rejected");
    throw new Error(`Không có ảnh khách mẫu (${why ? String(why.reason instanceof Error ? why.reason.message : why.reason) : "kho trống"})`);
  }
  // Fewer looks than mockups: they repeat (each still in its own style / option).
  for (let i = 0; out.length < want; i++) out.push(out[i]);
  return shuffled(out).slice(0, want);
}

/**
 * One picture per item for the photo zone `region` of `product`, as a customer's upload would come out of the zone (its
 * style, cut-out, face cut, the khuôn's face areas) — uploaded, in order. An item that fails says why.
 */
export async function styledSamples(s: CtSession, product: CtProduct, region: CtRegion, items: CtMockupSampleItem[]): Promise<CtMockupSample[]> {
  const r = normalizeRegion(region);
  const cfg = r.config.photo;
  const nameOnly = cfg.input === "name";
  const styles = new Map<string, CtAiStyle | null>();
  for (const it of items) if (isAiStyleRef(it.style) && !styles.has(it.style)) styles.set(it.style, await loadAiStyle(s.supabase, it.style));
  let sources: Array<{ data: Buffer; mime: string } | null> = items.map(() => null);
  if (!nameOnly) {
    const words = [cfg.label, ...[...styles.values()].map((st) => (st ? `${st.name} ${st.prompt}` : ""))].join(" ");
    const kind: Subject = PET_HINT.test(words) ? "pet" : "person";
    sources = await poolPhotos(s, kind, items.length);
  }
  const config = normalizeProductConfig(product.config);
  const targets = faceTargets(config.print, shapeBounds(r.shape));
  return Promise.all(
    items.map(async (it, i): Promise<CtMockupSample> => {
      try {
        if (!isPhotoStyleRef(it.style)) throw new Error("Style không hợp lệ");
        const aiStyle = isAiStyleRef(it.style) ? styles.get(it.style) : undefined;
        if (isAiStyleRef(it.style) && !aiStyle) throw new Error("Style AI không còn");
        if (nameOnly && !aiStyle) throw new Error("Vùng chỉ nhập tên cần một style AI");
        const out = await processPhoto({ image: sources[i], style: it.style, cutout: cfg.cutout, aiStyle: aiStyle ?? undefined, name: it.name });
        const png = await finishPhoto(out, cfg.cutout, cfg.fadeCrop && !nameOnly, styleFamily(it.style) === "face", nameOnly ? null : targets);
        const url = await ctUpload(`${s.user.id}/${CT_CONFIG.storagePrefix}/${product.id}/mockup-samples/${crypto.randomUUID()}.png`, png, "image/png");
        return { url, error: "" };
      } catch (e) {
        return { url: null, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
}

/**
 * Every variant's photo zones filled with a different sample (server/product-mockups.ts bulk path): the pictures go
 * into the selections; the errors come back (a zone that failed keeps its own sample picture).
 */
export async function fillVariantPhotos(s: CtSession, product: CtProduct, regions: CtRegion[], variants: CtMockupVariant[]): Promise<string[]> {
  const byRegion = new Map<string, Array<{ variant: number; item: CtMockupSampleItem }>>();
  variants.forEach((v, i) => {
    for (const p of v.photos) {
      const list = byRegion.get(p.regionId) ?? [];
      list.push({ variant: i, item: { style: p.style, name: p.name } });
      byRegion.set(p.regionId, list);
    }
  });
  const errors: string[] = [];
  await Promise.all(
    [...byRegion].map(async ([regionId, list]) => {
      const region = regions.find((r) => r.id === regionId);
      if (!region) return;
      const samples = await styledSamples(
        s,
        product,
        region,
        list.map((x) => x.item),
      ).catch((e: unknown) => list.map((): CtMockupSample => ({ url: null, error: e instanceof Error ? e.message : String(e) })));
      samples.forEach((sample, k) => {
        const v = variants[list[k].variant];
        const sel = v.selection[regionId];
        if (sample.url && sel?.kind === "photo") v.selection[regionId] = { ...sel, url: sample.url };
        else if (sample.error) errors.push(sample.error);
      });
    }),
  );
  return [...new Set(errors)];
}

/** POST products/:id/mockups/samples */
export async function mockupSamples(s: CtSession, productId: string, body: unknown): Promise<NextResponse> {
  const { data: product } = await s.supabase.from(CT_TABLES.products).select("*").eq("id", productId).maybeSingle<CtProduct>();
  if (!product || (product.user_id !== s.user.id && !(await isAdmin(s)))) return NextResponse.json({ error: "Không có quyền sửa sản phẩm này" }, { status: 403 });
  const b = (body && typeof body === "object" ? body : {}) as { regionId?: unknown; items?: unknown };
  const regionId = typeof b.regionId === "string" ? b.regionId : "";
  const items: CtMockupSampleItem[] = (Array.isArray(b.items) ? b.items : [])
    .slice(0, CT_MOCKUP_SCENES_MAX)
    .flatMap((x: unknown) => {
      const o = (x && typeof x === "object" ? x : {}) as { style?: unknown; name?: unknown };
      return typeof o.style === "string" && isPhotoStyleRef(o.style) ? [{ style: o.style, name: typeof o.name === "string" ? o.name.slice(0, 60) : "" }] : [];
    });
  if (!regionId || !items.length) return NextResponse.json({ error: "Thiếu vùng ảnh hoặc style" }, { status: 400 });
  // The product's own zones, or the artwork's it draws (a product made from an artwork).
  const link = normalizeProductConfig(product.config).artworkLink;
  const owners = [productId, ...(link ? [link.artworkId] : [])];
  const { data: region } = await s.supabase.from(CT_TABLES.regions).select("*").eq("id", regionId).in("product_id", owners).maybeSingle<CtRegion>();
  if (!region || region.kind !== "photo") return NextResponse.json({ error: "Vùng ảnh không tồn tại" }, { status: 404 });
  return NextResponse.json({ samples: await styledSamples(s, product, region, items) });
}
