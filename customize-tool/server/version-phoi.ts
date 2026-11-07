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
import type { CtPackImage, CtProduct, CtVersionPhoi, CtVersionPhoiStatus } from "../types";
import { normalizeProductConfig, normalizeVersionPhoi } from "../lib/design";
import { CT_IMAGE_MODEL } from "../lib/image-models";
import { drawImage } from "./pack-images";
import { kitPost } from "./char/kit";
import { ctUpload } from "./storage";
import { loadBaseProduct } from "./base-products";
import { jsonError, ownedProduct } from "./handlers";
import { applyBase } from "./artwork-link";
import { ctServiceClient, type CtServiceClient, type CtSession } from "./supabase";

type Db = CtSession["supabase"] | CtServiceClient;

const jobName = (productId: string) => `phoi:${productId}`;

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

function promptFor(material: string, hole: boolean): string {
  const white = material === "acrylic_white";
  return [
    "This picture is a rough mock-up: a flat printed artwork on a die-cut acrylic ornament, pasted on a photo of a Christmas tree.",
    `Turn it into ONE real photograph of that exact ornament: a ${white ? "white-backed" : "clear, see-through"} 3 mm acrylic plate cut along the light outline shown, with a real polished cut edge that catches the light, subtle reflections on its glossy face and a soft natural shadow${hole ? ", a small round clear tab with a hole at the top centre, hung on the tree by a thin gold cord through that hole" : ", hanging on the tree"}.`,
    "The printed artwork on it stays EXACTLY as it is drawn: same shapes, colours, lettering, positions and size — nothing added, removed, moved or redrawn.",
    `Areas of the plate with no print stay empty ${white ? "white" : "clear"} acrylic: never put new characters, faces, people, animals or text there.`,
    "Same camera, same framing, same size of the ornament in the picture: do not zoom, move, tilt or crop. Keep the tree, the branches and the warm bokeh lights of the background.",
  ].join(" ");
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
  const ref = await sharp(Buffer.from(await file.arrayBuffer())).png().toBuffer();
  const meta = await sharp(ref).metadata();
  const width = meta.width ?? 1024;
  const height = meta.height ?? 1024;
  const dir = `${s.user.id}/${CT_CONFIG.storagePrefix}/${productId}/phoi`;
  const refUrl = await ctUpload(`${dir}/ref-${crypto.randomUUID()}.png`, ref, "image/png");
  const prompt = promptFor(base.config.material, base.config.cut.hole);
  const db = ctServiceClient() ?? s.supabase;
  const { data: job, error } = await db
    .from(CT_TABLES.packImages)
    .insert({ user_id: s.user.id, name: jobName(productId), source: "ai", status: "running", listed: false, description: mainId, prompt, refs: [refUrl], aspect: "1:1", model: CT_IMAGE_MODEL })
    .select("*")
    .single<CtPackImage>();
  if (error || !job) return jsonError(error?.message ?? "Không tạo được việc", 500);

  void (async () => {
    let last = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const ai = await drawImage(CT_IMAGE_MODEL, prompt, [refUrl], "1:1", "crop");
        const aiUrl = await ctUpload(`${dir}/ai-${crypto.randomUUID()}.png`, ai.data, "image/png");
        const reg = await kitPost<{ png: string; w: number; h: number; scale: number; similarity: boolean; residual: number }>("/register-photo", { ref: refUrl, url: aiUrl }, 180_000);
        // The answer is on the reference's canvas (its own size: the AI's 1024²): the box scales with it.
        const k = reg.w / width;
        const jpg = await sharp(Buffer.from(reg.png, "base64")).jpeg({ quality: 90 }).toBuffer();
        const url = await ctUpload(`${dir}/${mainId}-${crypto.randomUUID()}.jpg`, jpg, "image/jpeg");
        await savePhoi(db, productId, { baseId, mainId, url, width: reg.w, height: reg.h, box: { x: box.x * k, y: box.y * k, w: box.w * k, h: box.h * k }, at: new Date().toISOString() });
        await db.from(CT_TABLES.packImages).update({ status: "done", url, mime: "image/jpeg", width: reg.w, height: reg.h, error: "" }).eq("id", job.id);
        // The products made from this artwork show it at once (their preview, not their design).
        const { data: made } = await db.from(CT_TABLES.products).select("*").eq("kind", "product").eq("config->artworkLink->>artworkId", productId).returns<CtProduct[]>();
        for (const p of made ?? []) await applyBase(db, p).catch((e: Error) => console.warn(`[ct] phôi AI → ${p.name}: ${e.message}`));
        console.info(`[ct] phôi AI ${productId}/${mainId}: scale ${reg.scale}${reg.similarity ? "" : " (no features)"}, residual ${reg.residual}px`);
        return;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
    }
    await db.from(CT_TABLES.packImages).update({ status: "failed", error: last.slice(0, 1000) }).eq("id", job.id);
  })();
  return NextResponse.json({ job }, { status: 202 });
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
