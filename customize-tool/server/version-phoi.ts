/**
 * The AI phôi of each version (2026-11-08, asked: "riêng bước này phải dùng ảnh AI gen thì vật liệu mới thật được.
 * Preview của khách thì dùng ảnh AI gen phôi preview … file cuối cùng in … là file không có vật liệu"):
 *
 *   POST   products/:id/version-phoi   multipart: file (the reference, PNG 1024×1024: the version's fixed parts on the
 *                                      base's background with a rough clear plate — made in the editor), mainId, baseId,
 *                                      box (JSON: where the artwork canvas is on it) → { job }
 *   GET    products/:id/version-phoi   → CtVersionPhoiStatus
 *   DELETE products/:id/version-phoi?mainId=&baseId=
 *
 * The AI makes the reference a real photo of the piece (gpt-image, like Teeinblue's hand-made "Preview scene" per
 * version), layer-kit puts the answer back on the reference's pixels (/register-photo: the AI moves and zooms the whole
 * frame), so the canvas box of the reference is the box on the photo. The storefront lays the customer's picks and texts
 * on it. Preview only — print files never read it.
 */

import sharp from "sharp";
import { NextResponse } from "next/server";
import { CT_CONFIG, CT_TABLES } from "../config";
import type { CtBaseProduct, CtPackImage, CtProduct, CtVersionPhoi, CtVersionPhoiStatus } from "../types";
import { normalizeProductConfig, normalizeVersionPhoi } from "../lib/design";
import { CT_IMAGE_MODEL } from "../lib/image-models";
import { drawImage } from "./pack-images";
import { kitPost } from "./char/kit";
import { ctUpload } from "./storage";
import { loadBaseProduct } from "./base-products";
import { jsonError, ownedProduct } from "./handlers";
import { applyBase } from "./artwork-link";
import { phoiReference } from "./version-phoi-ref";
import { ctServiceClient, type CtServiceClient, type CtSession } from "./supabase";

type Db = CtSession["supabase"] | CtServiceClient;

export const jobName = (productId: string) => `phoi:${productId}`;

/** One write at a time per artwork: several versions finish together, each adds its own entry to the stored list. */
const chains = new Map<string, Promise<void>>();

async function savePhoi(db: Db, productId: string, entry: CtVersionPhoi | { remove: { mainId: string; baseId: string } }): Promise<void> {
  const prev = chains.get(productId) ?? Promise.resolve();
  const next = prev.then(async () => {
    const { data } = await db.from(CT_TABLES.products).select("config").eq("id", productId).maybeSingle<Pick<CtProduct, "config">>();
    if (!data) return;
    const list = normalizeVersionPhoi(data.config?.versionPhoi);
    const key = "remove" in entry ? entry.remove : entry;
    const kept = list.filter((v) => !(v.mainId === key.mainId && v.baseId === key.baseId));
    const versionPhoi = "remove" in entry ? kept : [...kept, entry];
    const { error } = await db.from(CT_TABLES.products).update({ config: { ...data.config, versionPhoi } }).eq("id", productId);
    if (error) throw new Error(error.message);
  });
  chains.set(
    productId,
    next.catch(() => undefined),
  );
  return next;
}

export function promptFor(material: string, hole: boolean): string {
  const white = material === "acrylic_white";
  return [
    "This picture is a rough mock-up: a flat printed artwork on a die-cut acrylic ornament, pasted on a photo of a Christmas tree.",
    `Turn it into ONE real photograph of that exact ornament: a ${white ? "white-backed" : "clear, see-through"} 3 mm acrylic plate cut along the light outline shown, with a real polished cut edge that catches the light, subtle reflections on its glossy face and a soft natural shadow${hole ? ", a small round clear tab with a hole at the top centre, hung on the tree by a thin gold cord through that hole" : ", hanging on the tree"}.`,
    "The printed artwork on it stays EXACTLY as it is drawn: same shapes, colours, lettering, positions and size — nothing added, removed, moved or redrawn.",
    `Areas of the plate with no print stay empty ${white ? "white" : "clear"} acrylic: never put new characters, faces, people, animals or text there.`,
    "Same camera, same framing, same size of the ornament in the picture: do not zoom, move, tilt or crop. Keep the tree, the branches and the warm bokeh lights of the background.",
  ].join(" ");
}

/**
 * The AI's photo where the mask is white (the piece, its shadow, the tab + cord), the reference's background elsewhere
 * — blended over a soft edge. No mask: the AI's photo as it is.
 */
async function keepBackground(ref: Buffer, ai: Buffer, mask: Buffer | null, w: number, h: number): Promise<Buffer> {
  if (!mask) return sharp(ai).jpeg({ quality: 90 }).toBuffer();
  const alpha = await sharp(mask).resize(w, h, { fit: "fill" }).greyscale().blur(Math.max(2, w / 80)).extractChannel(0).toBuffer();
  // Two steps: in one pipeline sharp drops the alpha last — the joined mask went with it.
  const rgb = await sharp(ai).removeAlpha().png().toBuffer();
  const piece = await sharp(rgb).joinChannel(alpha).png().toBuffer();
  return sharp(ref).resize(w, h, { fit: "fill" }).removeAlpha().composite([{ input: piece }]).jpeg({ quality: 90 }).toBuffer();
}

/** One AI phôi picture made from a reference: where it is stored, its size and the canvas box on it. */
export interface CtPhoiPicture {
  url: string;
  width: number;
  height: number;
  box: CtVersionPhoi["box"];
}

/**
 * The AI makes the reference a real photo, layer-kit puts it back on the reference's pixels, the AI is kept only
 * inside the mask (the reference's background elsewhere) — stored as a JPEG under `dir`. One try; throws on failure.
 */
export async function drawPhoi(input: { ref: Buffer; refUrl: string; mask: Buffer | null; box: CtVersionPhoi["box"]; prompt: string; dir: string; name: string }): Promise<CtPhoiPicture> {
  const { ref, refUrl, mask, box, prompt, dir, name } = input;
  const width = (await sharp(ref).metadata()).width ?? 1024;
  const ai = await drawImage(CT_IMAGE_MODEL, prompt, [refUrl], "1:1", "crop");
  const aiUrl = await ctUpload(`${dir}/ai-${crypto.randomUUID()}.png`, ai.data, "image/png");
  const reg = await kitPost<{ png: string; w: number; h: number; scale: number; similarity: boolean; residual: number }>("/register-photo", { ref: refUrl, url: aiUrl }, 180_000);
  // The answer is on the reference's canvas (its own size: the AI's 1024²): the box scales with it.
  const k = reg.w / width;
  const jpg = await keepBackground(ref, Buffer.from(reg.png, "base64"), mask, reg.w, reg.h);
  const url = await ctUpload(`${dir}/${name}-${crypto.randomUUID()}.jpg`, jpg, "image/jpeg");
  console.info(`[ct] phôi AI ${dir}/${name}: scale ${reg.scale}${reg.similarity ? "" : " (no features)"}, residual ${reg.residual}px`);
  return { url, width: reg.w, height: reg.h, box: { x: box.x * k, y: box.y * k, w: box.w * k, h: box.h * k } };
}

/** What one AI phôi job needs: the reference + mask (1024², made by the editor or server/version-phoi-ref.ts). */
export interface CtPhoiJobInput {
  userId: string;
  productId: string;
  base: CtBaseProduct;
  mainId: string;
  ref: Buffer;
  mask: Buffer | null;
  /** Where the artwork canvas is on the reference (its px). */
  box: CtVersionPhoi["box"];
}

/** Starts the AI for one version (background job: AI → register → keep background → saved) — returns the job row. */
export async function startPhoiJob(db: Db, input: CtPhoiJobInput): Promise<CtPackImage> {
  const { userId, productId, base, mainId, mask, box } = input;
  const ref = await sharp(input.ref).png().toBuffer();
  const dir = `${userId}/${CT_CONFIG.storagePrefix}/${productId}/phoi`;
  const refUrl = await ctUpload(`${dir}/ref-${crypto.randomUUID()}.png`, ref, "image/png");
  const prompt = promptFor(base.config.material, base.config.cut.hole);
  const { data: job, error } = await db
    .from(CT_TABLES.packImages)
    .insert({ user_id: userId, name: jobName(productId), source: "ai", status: "running", listed: false, description: mainId, prompt, refs: [refUrl], aspect: "1:1", model: CT_IMAGE_MODEL })
    .select("*")
    .single<CtPackImage>();
  if (error || !job) throw new Error(error?.message ?? "Không tạo được việc");

  void (async () => {
    let last = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await drawPhoi({ ref, refUrl, mask, box, prompt, dir, name: mainId });
        await savePhoi(db, productId, { baseId: base.id, mainId, ...out, at: new Date().toISOString(), source: "ai" });
        await db.from(CT_TABLES.packImages).update({ status: "done", url: out.url, mime: "image/jpeg", width: out.width, height: out.height, error: "" }).eq("id", job.id);
        await refreshProductsOf(db, productId);
        return;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
    }
    await db.from(CT_TABLES.packImages).update({ status: "failed", error: last.slice(0, 1000) }).eq("id", job.id);
  })();
  return job;
}

/** The products made from this artwork show a new phôi at once (their preview, not their design). */
async function refreshProductsOf(db: Db, artworkId: string): Promise<void> {
  const { data: made } = await db.from(CT_TABLES.products).select("*").eq("kind", "product").eq("config->artworkLink->>artworkId", artworkId).returns<CtProduct[]>();
  for (const p of made ?? []) await applyBase(db, p).catch((e: Error) => console.warn(`[ct] phôi → ${p.name}: ${e.message}`));
}

/**
 * A phôi that needs no AI (2026-11-08, asked: an import whose folder already has its preview must not be drawn again):
 * the folder's own picture of the version on the piece, saved as it is.
 */
export async function savePhoiPicture(db: Db, userId: string, productId: string, baseId: string, mainId: string, picture: Buffer, box: CtVersionPhoi["box"] | null): Promise<CtVersionPhoi> {
  const jpg = await sharp(picture).flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer();
  const meta = await sharp(jpg).metadata();
  const width = meta.width ?? 1024;
  const height = meta.height ?? 1024;
  const url = await ctUpload(`${userId}/${CT_CONFIG.storagePrefix}/${productId}/phoi/${mainId}-${crypto.randomUUID()}.jpg`, jpg, "image/jpeg");
  const entry: CtVersionPhoi = { baseId, mainId, url, width, height, box: box ?? { x: 0, y: 0, w: width, h: height }, at: new Date().toISOString(), source: "folder" };
  await savePhoi(db, productId, entry);
  await refreshProductsOf(db, productId);
  return entry;
}

/** One version's phôi state after ensureVersionPhoi. */
export interface CtPhoiVersionState {
  mainId: string;
  name: string;
  /** have = already has one (AI or the folder's) · running = an AI job is on it · started = sent to the AI now · failed */
  status: "have" | "running" | "started" | "failed";
  source?: "ai" | "folder";
  error?: string;
}

/**
 * Every version of an artwork gets its phôi on a cut-to-shape base: the ones that have one (drawn before, or the import
 * folder's own preview) are left alone, the others go to the AI (reference made on the server). `redo` = draw these
 * versions again even when they have one (never a folder's picture unless named in `mainIds`).
 */
export async function ensureVersionPhoi(db: Db, userId: string, artworkId: string, base: CtBaseProduct, opts: { redo?: boolean; mainIds?: string[] } = {}): Promise<CtPhoiVersionState[]> {
  if (base.config.cut.mode !== "alpha") throw new Error(`Base ${base.name} không cắt theo viền thiết kế — preview dùng phôi của khuôn, không cần phôi AI`);
  if (!base.config.preview.url) throw new Error(`Base ${base.name} chưa có ảnh nền xem trước (trang base → Phôi / nền xem trước)`);
  const { data: art } = await db.from(CT_TABLES.products).select("config").eq("id", artworkId).maybeSingle<Pick<CtProduct, "config">>();
  if (!art) throw new Error("Không tìm thấy artwork");
  const have = normalizeProductConfig(art.config).versionPhoi.filter((v) => v.baseId === base.id);
  const { data: mains } = await db.from(CT_TABLES.assets).select("id,name,sort_order").eq("product_id", artworkId).eq("role", "main").order("sort_order").returns<Array<{ id: string; name: string }>>();
  const { data: jobs } = await db.from(CT_TABLES.packImages).select("description,status").eq("name", jobName(artworkId)).eq("status", "running").returns<Array<{ description: string; status: string }>>();
  const running = new Set((jobs ?? []).map((j) => j.description));
  const out: CtPhoiVersionState[] = [];
  for (const m of mains ?? []) {
    if (opts.mainIds?.length && !opts.mainIds.includes(m.id)) continue;
    const own = have.find((v) => v.mainId === m.id);
    const named = !!opts.mainIds?.includes(m.id);
    if (running.has(m.id)) {
      out.push({ mainId: m.id, name: m.name, status: "running" });
      continue;
    }
    if (own && (!opts.redo || (own.source === "folder" && !named))) {
      out.push({ mainId: m.id, name: m.name, status: "have", source: own.source ?? "ai" });
      continue;
    }
    try {
      const ref = await phoiReference(db, artworkId, base, m.id);
      await startPhoiJob(db, { userId, productId: artworkId, base, mainId: m.id, ref: ref.ref, mask: ref.mask, box: ref.box });
      out.push({ mainId: m.id, name: m.name, status: "started" });
    } catch (e) {
      out.push({ mainId: m.id, name: m.name, status: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/** POST products/:id/version-phoi */
export async function makeVersionPhoi(s: CtSession, productId: string, form: FormData): Promise<NextResponse> {
  const product = await ownedProduct(s, productId);
  if (!product) return jsonError("Không tìm thấy artwork", 404);
  const file = form.get("file");
  const mainId = typeof form.get("mainId") === "string" ? String(form.get("mainId")) : "";
  const baseId = typeof form.get("baseId") === "string" ? String(form.get("baseId")) : "";
  let box: CtVersionPhoi["box"] | null = null;
  try {
    const b = JSON.parse(String(form.get("box") ?? "null")) as CtVersionPhoi["box"] | null;
    if (b && [b.x, b.y, b.w, b.h].every((n) => typeof n === "number" && Number.isFinite(n)) && b.w > 0 && b.h > 0) box = b;
  } catch {
    box = null;
  }
  if (!(file instanceof Blob) || !mainId || !baseId || !box) return jsonError("Thiếu ảnh mẫu / version / base / khung", 400);
  const base = await loadBaseProduct(s.supabase, baseId);
  if (!base) return jsonError("Không tìm thấy product base", 404);
  const maskFile = form.get("mask");
  const mask = maskFile instanceof Blob ? Buffer.from(await maskFile.arrayBuffer()) : null;
  const db = ctServiceClient() ?? s.supabase;
  try {
    const job = await startPhoiJob(db, { userId: s.user.id, productId, base, mainId, ref: Buffer.from(await file.arrayBuffer()), mask, box });
    return NextResponse.json({ job }, { status: 202 });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không tạo được việc", 500);
  }
}

/** GET products/:id/version-phoi */
export async function versionPhoiStatus(s: CtSession, productId: string): Promise<NextResponse> {
  const product = await ownedProduct(s, productId);
  if (!product) return jsonError("Không tìm thấy artwork", 404);
  const { data: jobs } = await s.supabase.from(CT_TABLES.packImages).select("*").eq("name", jobName(productId)).order("created_at", { ascending: false }).limit(60).returns<CtPackImage[]>();
  const out: CtVersionPhoiStatus = { phoi: normalizeProductConfig(product.config).versionPhoi, jobs: jobs ?? [] };
  return NextResponse.json(out);
}

/** DELETE products/:id/version-phoi?mainId=&baseId= */
export async function deleteVersionPhoi(s: CtSession, productId: string, mainId: string, baseId: string): Promise<NextResponse> {
  if (!(await ownedProduct(s, productId))) return jsonError("Không tìm thấy artwork", 404);
  await savePhoi(s.supabase, productId, { remove: { mainId, baseId } });
  return new NextResponse(null, { status: 204 });
}
