/**
 * Mockups of a product made from a bộ nhân vật.
 *
 *   POST char/projects/:id/mockups  multipart print (PNG, the product's print file as the editor renders it),
 *                                   productId → { images } the front mockup (done) + lifestyle scenes (running)
 *
 * Front mockup = the print placed EXACTLY into the product scene's box on the blank photo, with the fabric's own
 * light and shadow multiplied in (no AI — what the customer sees is right). Lifestyle scenes = an AI re-render of
 * that front mockup per brief.mockups scene, told to keep the print as it is (marketing pictures only). Every
 * mockup is also added to the product (asset role "mockup" → Tổ hợp list).
 */

import { NextResponse } from "next/server";
import sharp from "sharp";
import { CT_TABLES } from "../../config";
import type { CtCharImage, CtProduct, CtProductScene } from "../../types";
import * as h from "../handlers";
import type { CtSession } from "../supabase";
import { fetchImage, saveCharFile } from "./files";
import { lightOnBlank } from "../../lib/blank-shading";
import { editModels, jobDb, jsonError, loadProject, runCharDraw } from "./projects";

const KEEP_PRINT =
  " The printed artwork on the product must stay EXACTLY as in the reference picture: the same characters, the same colours, " +
  "the same text letter for letter, the same size and position on the product. Do not redraw, restyle, crop or change the print. " +
  "Photorealistic product photography, natural soft light.";

/** The print on the blank photo, inside `box` (photo px, may reach past the photo), lit by the blank's own shading. */
export async function frontMockup(blank: Buffer, print: Buffer, box: CtProductScene["box"]): Promise<Buffer> {
  const meta = await sharp(blank).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const bw = Math.max(1, Math.round(box.w));
  const bh = Math.max(1, Math.round(box.h));
  const bx = Math.round(box.x);
  const by = Math.round(box.y);
  // The part of the box on the photo.
  const x = Math.max(0, bx);
  const y = Math.max(0, by);
  const w = Math.min(W, bx + bw) - x;
  const hh = Math.min(H, by + bh) - y;
  if (w <= 0 || hh <= 0) return sharp(blank).removeAlpha().jpeg({ quality: 92 }).toBuffer();
  const art = await sharp(await sharp(print).resize(bw, bh, { fit: "fill", kernel: "lanczos3" }).ensureAlpha().png().toBuffer())
    .extract({ left: x - bx, top: y - by, width: w, height: hh })
    .raw()
    .toBuffer();
  // The phôi's own light on the print: its shading darkens it, its gloss highlights lie over it (lib/blank-shading).
  const under = await sharp(blank).removeAlpha().extract({ left: x, top: y, width: w, height: hh }).raw().toBuffer();
  const out = Buffer.alloc(w * hh * 4);
  lightOnBlank(art, under, w, hh, 3, out);
  const patch = await sharp(out, { raw: { width: w, height: hh, channels: 4 } }).removeAlpha().png().toBuffer();
  return sharp(blank).removeAlpha().composite([{ input: patch, left: x, top: y }]).jpeg({ quality: 92 }).toBuffer();
}

/** POST char/projects/:id/mockups */
export async function makeCharMockups(s: CtSession, id: string, form: FormData): Promise<NextResponse> {
  const p = await loadProject(s.supabase, id);
  if (!p) return jsonError("Không tìm thấy bộ nhân vật", 404);
  const productId = String(form.get("productId") ?? "");
  if (!p.product_ids.includes(productId)) return jsonError("Sản phẩm không thuộc bộ này", 400);
  const file = form.get("print");
  if (!(file instanceof Blob) || !file.size) return jsonError("Thiếu file in", 400);
  const print = Buffer.from(await file.arrayBuffer());
  const { data: product } = await s.supabase.from(CT_TABLES.products).select("*").eq("id", productId).maybeSingle<CtProduct>();
  if (!product) return jsonError("Không tìm thấy sản phẩm", 404);

  const scene = product.config?.scene;
  let front: Buffer;
  if (scene?.url && scene.box.w > 0) front = await frontMockup(await fetchImage(scene.url), print, scene.box);
  else {
    // No blank photo: the print on white with a margin.
    const m = await sharp(print).metadata();
    const pad = Math.round(Math.max(m.width ?? 0, m.height ?? 0) * 0.08);
    front = await sharp(print).flatten({ background: "#ffffff" }).extend({ top: pad, bottom: pad, left: pad, right: pad, background: "#ffffff" }).jpeg({ quality: 92 }).toBuffer();
  }

  const toProduct = async (data: Buffer, name: string) => {
    const f = new FormData();
    f.set("file", new Blob([new Uint8Array(data)], { type: "image/jpeg" }), `${name}.jpg`);
    f.set("role", "mockup");
    f.set("name", name);
    await h.uploadAsset(s, productId, f);
  };
  const saved = await saveCharFile(s.user.id, id, "mockup", front);
  const { data: frontRow, error } = await s.supabase
    .from(CT_TABLES.charImages)
    .insert({ project_id: id, user_id: s.user.id, kind: "mockup", role: `front:${productId}`, status: "done", note: "Chụp thẳng (chính xác)", ...saved })
    .select("*")
    .single<CtCharImage>();
  if (error || !frontRow) return jsonError(error?.message ?? "Không lưu được", 500);
  await toProduct(front, "mockup_front");

  const scenes = (p.brief.mockups.length ? p.brief.mockups : ["on a bright minimal table with soft daylight and a few matching props"]).slice(0, 3);
  const { data: rows } = await s.supabase
    .from(CT_TABLES.charImages)
    .insert(scenes.map((sc) => ({ project_id: id, user_id: s.user.id, kind: "mockup", role: `scene:${productId}`, parent_id: frontRow.id, status: "running", note: sc, prompt: `Lifestyle product photo of this exact product ${sc}.${KEEP_PRINT}` })))
    .select("*")
    .returns<CtCharImage[]>();
  const db = jobDb(s);
  const models = await editModels();
  for (const row of rows ?? [])
    void runCharDraw(db, s.user.id, row, { prompt: row.prompt, refs: [frontRow.url], aspect: "4:5", refSize: { w: frontRow.width, h: frontRow.height }, models }).then(async (done) => {
      if (done) await toProduct(await fetchImage(done.url), `mockup_${row.note.split(/\s+/).slice(0, 4).join("_")}`).catch(() => undefined);
    });
  return NextResponse.json({ images: [frontRow, ...(rows ?? [])] }, { status: 202 });
}
