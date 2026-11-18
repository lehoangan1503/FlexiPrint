/**
 * The khuôn's phôi trơn made from the fulfiller's phôi (asked 2026-11-18 on the Quilt Blanket: "xưởng có phôi thì lấy
 * về làm ảnh tham khảo và tạo luôn phôi … phôi của xưởng đôi khi đã có hoạ tiết, mình cần tham khảo chất liệu, texture
 * và gen lại 1 phôi trơn y hệt cấu trúc, đảm bảo nó khớp với config size của khuôn in"; "nếu nó trơn nhẵn không có màu
 * thì dùng luôn"):
 *
 *   POST base-products/:id/khuon-phoi → { template }   (~1 min with AI: call it with jobFetch)
 *
 *  - the fulfiller's phôi is a plain, colourless studio shot of the blank (no overlay) → used as it is ("copy");
 *  - else (a scene with a person, a sample print, a colour) → drawn again by the image model: the khuôn's outline as the
 *    shape, the fulfiller's phôi + a close-up of its surface + its product photos as references, the base's
 *    description as text — same material, texture and construction (quilting…), no print ("ai").
 * Either way it becomes the khuôn's first (default) phôi, with where it came from (CtPrintBlank.from) for the badge.
 * Also run on its own by the base's automatic backgrounds (server/base-scenes.ts runAuto) right after an import.
 */

import sharp from "sharp";
import { NextResponse } from "next/server";
import { CT_CONFIG } from "../config";
import type { CtBaseProduct, CtBaseProductConfig, CtProductScene } from "../types";
import type { CtPrintBlank, CtPrintTemplate } from "../types/print";
import { newId } from "../lib/geometry";
import { loadBaseProduct } from "./base-products";
import { loadTemplate } from "./artwork-link";
import { fetchImage } from "./char/files";
import { addTemplateBlank, saveTemplateBlanks } from "./print-blanks";
import { baseBlankHints, makeBlank } from "./product-mockups";
import { ctRemove, ctUpload } from "./storage";
import type { CtServiceClient, CtSession, CtSupabase } from "./supabase";

type Db = CtSupabase | CtServiceClient;

const PROVIDER: Record<string, string> = { merchize: "Merchize", printbelle: "Printbelle" };

export function fulfillerName(cfg: CtBaseProductConfig): string | null {
  return cfg.source ? (PROVIDER[cfg.source.provider] ?? cfg.source.provider) : null;
}

/**
 * The fulfiller's own phôi of an imported base: kept apart since 2026-11-18 (source.phoi), else the plain phôi behind
 * the preview (an AI background keeps the one it was drawn from), else the preview itself. null = none.
 */
export function fulfillerPhoi(cfg: CtBaseProductConfig): CtProductScene | null {
  if (!cfg.source) return null;
  if (cfg.source.phoi?.url) return cfg.source.phoi;
  const current = cfg.previewScenes.find((sc) => sc.scene.url && sc.scene.url === cfg.preview.url);
  const p = current ? current.plain : cfg.preview;
  return p.url ? p : null;
}

/** The piece's face on the phôi (its box, kept inside the picture), px of the file. */
async function faceCrop(photo: Buffer, scene: CtProductScene, share = 1): Promise<{ left: number; top: number; width: number; height: number }> {
  const m = await sharp(photo).metadata();
  const W = m.width ?? scene.width;
  const H = m.height ?? scene.height;
  const sx = W / Math.max(1, scene.width);
  const sy = H / Math.max(1, scene.height);
  const b = scene.box;
  const cx = (b.x + b.w / 2) * sx;
  const cy = (b.y + b.h / 2) * sy;
  const w = b.w * sx * share;
  const h = b.h * sy * share;
  const left = Math.max(0, Math.round(cx - w / 2));
  const top = Math.max(0, Math.round(cy - h / 2));
  return { left, top, width: Math.max(1, Math.min(W - left, Math.round(w))), height: Math.max(1, Math.min(H - top, Math.round(h))) };
}

/**
 * A plain colourless studio shot of the blank: no overlay (nothing in front of it, no scene), its face light and grey
 * (no colour, no print — the middle 80 % of the box: chroma low, no dark marks).
 */
async function plainStudioShot(photo: Buffer, scene: CtProductScene): Promise<boolean> {
  if (scene.overlay || !scene.box.w || !scene.box.h) return false;
  const { data, info } = await sharp(photo)
    .removeAlpha()
    .extract(await faceCrop(photo, scene, 0.8))
    .resize(200, 200, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let chroma = 0;
  let dark = 0;
  const n = info.width * info.height;
  for (let p = 0; p < n; p++) {
    const r = data[p * 3];
    const g = data[p * 3 + 1];
    const b = data[p * 3 + 2];
    chroma += Math.max(r, g, b) - Math.min(r, g, b);
    if (0.299 * r + 0.587 * g + 0.114 * b < 110) dark++;
  }
  return chroma / n < 12 && dark / n < 0.02;
}

/** The fulfiller's phôi made the khuôn's first phôi (copied, or drawn again by AI). Throws a message for the editor. */
export async function makeKhuonPhoi(db: Db, userId: string, base: CtBaseProduct, template: CtPrintTemplate): Promise<CtPrintTemplate> {
  const cfg = base.config;
  const provider = fulfillerName(cfg) ?? "xưởng";
  const ref = fulfillerPhoi(cfg);
  const photos = (cfg.source?.photos ?? []).slice(0, 2);
  if (!ref && !photos.length) throw new Error("Base chưa có phôi hay ảnh sản phẩm của xưởng để làm phôi trơn");
  const photo = ref?.url ? await fetchImage(ref.url) : null;

  let blank: CtPrintBlank;
  let others = template.spec.blanks;
  if (ref?.url && photo && (await plainStudioShot(photo, ref))) {
    blank = { id: newId(), name: `Phôi ${provider}`, url: ref.url, width: ref.width, height: ref.height, box: ref.box, ai: false, from: { provider, kind: "copy", refs: [ref.url] } };
  } else {
    const temp: string[] = [];
    try {
      const looks: string[] = [];
      if (ref?.url && photo) {
        looks.push(ref.url);
        // A close-up of its face: the stitch pattern / weave at a scale the model can read.
        const close = await sharp(photo).removeAlpha().extract(await faceCrop(photo, ref, 0.42)).resize(768, 768, { fit: "inside" }).jpeg({ quality: 92 }).toBuffer();
        const path = `${userId}/${CT_CONFIG.storagePrefix}/blank-guides/close-${crypto.randomUUID()}.jpg`;
        looks.push(await ctUpload(path, close, "image/jpeg"));
        temp.push(path);
      }
      looks.push(...photos);
      const hints = baseBlankHints(base);
      const extra = [
        ref?.url
          ? `The first reference photo of the real piece is ${provider}'s own blank of this exact product, the next one a close-up of its face: copy that surface exactly — the same fabric and sheen, the same quilting / stitch pattern at the same scale and angle (as many rows across the face), the same hem or binding at the edge. If it carries a sample print or colour, leave the print out and keep only the material and its construction.`
          : "",
        hints.extra,
      ]
        .filter(Boolean)
        .join(" ");
      const drawn = await makeBlank(userId, base.name, template.spec, cfg.material, looks, extra);
      const t = await addTemplateBlank(db, userId, template, drawn, `Phôi AI · theo phôi ${provider}`, true);
      const added = t.spec.blanks[t.spec.blanks.length - 1];
      blank = { ...added, from: { provider, kind: "ai", refs: [...(ref?.url ? [ref.url] : []), ...photos] } };
      others = t.spec.blanks.filter((b) => b.id !== added.id);
      template = t;
    } finally {
      if (temp.length) await ctRemove(temp).catch(() => undefined);
    }
  }
  return (await saveTemplateBlanks(db, template, [blank, ...others])).template;
}

/** POST base-products/:id/khuon-phoi */
export async function makeBaseKhuonPhoi(s: CtSession, baseId: string): Promise<NextResponse> {
  const base = await loadBaseProduct(s.supabase, baseId);
  if (!base) return NextResponse.json({ error: "Không tìm thấy product base" }, { status: 404 });
  const template = await loadTemplate(s.supabase, base.config.templateId);
  if (!template) return NextResponse.json({ error: "Base chưa có khuôn in" }, { status: 409 });
  try {
    return NextResponse.json({ template: await makeKhuonPhoi(s.supabase, s.user.id, base, template) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Không tạo được phôi trơn" }, { status: 500 });
  }
}
