/**
 * A product on a khuôn in (types/print.ts):
 *
 *   POST products/from-template  { templateId, name } → { product }
 *
 * Its canvas is the template's sheet: the main asset is a transparent sheet of that size (the artwork is made of
 * layers on it), the cut line becomes the product's khuôn vật liệu (lib/material-frame — the print file is cut to it,
 * the hanging hole stays empty) and config.print keeps a copy of the template (the editor draws its safe zone and
 * zones; the storefront renders the print file at add-to-cart from it).
 */

import sharp from "sharp";
import { NextResponse } from "next/server";
import { CT_TABLES } from "../config";
import type { CtCreateArtworkBody, CtProduct, CtRegion } from "../types";
import type { CtPrintFace, CtProductPrint, CtPrintTemplate } from "../types/print";
import { defaultProductConfig, defaultRegionConfig } from "../lib/design";
import { newId } from "../lib/geometry";
import { insertAssetAs } from "./handlers";
import { getTemplate } from "./print-templates";
import { loadBaseProduct } from "./base-products";
import type { CtServiceClient, CtSession } from "./supabase";

/** The user's own client, or the service client (the @flexiprint MCP). */
export type PrintDb = CtSession["supabase"] | CtServiceClient;

interface FromTemplateBody {
  templateId?: unknown;
  name?: unknown;
}

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export function productPrintOf(t: CtPrintTemplate): CtProductPrint {
  return { templateId: t.id, name: t.name, kind: t.kind, spec: t.spec };
}

/**
 * The khuôn vật liệu layer of a template face: its cut line (+ cut-outs) — or, a khuôn drawn as a picture, the whole
 * sheet with that picture as the mask. None for a template cut along the artwork, or a face without a mask.
 */
export function frameRegion(productId: string, print: CtProductPrint, face: CtPrintFace | null = null, mainId: string | null = null): CtRegion | null {
  const { spec } = print;
  const base = { id: newId(), product_id: productId, kind: "image" as const, sort_order: 0 };
  const config = { ...defaultRegionConfig("image"), clip: false, materialFrame: true, ...(mainId ? { mainId } : {}) };
  if (face) {
    if (!face.maskUrl) return null;
    return { ...base, name: `Khuôn in — ${face.name}`, shape: { type: "rect", x: 0, y: 0, w: spec.width, h: spec.height, radius: 0 }, config: { ...config, maskUrl: face.maskUrl, guideUrl: face.guideUrl } };
  }
  if (print.kind === "cut" || !spec.outline) return null;
  return { ...base, name: `Khuôn in — ${print.name}`, shape: spec.outline, config: { ...config, cuts: spec.cuts } };
}

/** A transparent PNG of the sheet: the product's canvas. */
async function blankSheet(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Create the product (owned by `userId`), its sheet and its khuôn layer. A khuôn with several faces (trousers: front /
 * back) gives one sheet per face — each a version of the product with its own layers and its own print file. The
 * khuôn's first phôi becomes the product photo. Throws a message for the editor.
 */
export async function makeTemplateProduct(db: PrintDb, userId: string, template: CtPrintTemplate, name: string): Promise<CtProduct> {
  const print = productPrintOf(template);
  const blank = template.spec.blanks[0];
  const config = {
    ...defaultProductConfig(),
    print,
    material: { ...defaultProductConfig().material, widthMm: template.spec.widthMm || defaultProductConfig().material.widthMm },
    // The khuôn's phôi: Xem trước and Mockups put the artwork on it.
    ...(blank ? { scene: { url: blank.url, width: blank.width, height: blank.height, box: blank.box } } : {}),
  };
  const { data: product, error } = await db.from(CT_TABLES.products).insert({ user_id: userId, name, config }).select("*").single<CtProduct>();
  if (error || !product) throw new Error(error?.message ?? "Không tạo được sản phẩm");
  try {
    const faces: Array<CtPrintFace | null> = template.spec.faces.length ? template.spec.faces : [null];
    const sheet = await blankSheet(template.spec.width, template.spec.height);
    const regions: CtRegion[] = [];
    let mainId: string | null = null;
    for (const [i, face] of faces.entries()) {
      const main = await insertAssetAs(db, userId, {
        productId: product.id,
        role: "main",
        parentId: null,
        generationId: null,
        name: face ? face.name : `Tờ in ${template.spec.width}×${template.spec.height}`,
        data: sheet,
        meta: { printSheet: true },
      });
      mainId ??= main.id;
      const frame = frameRegion(product.id, print, face, faces.length > 1 ? main.id : null);
      if (frame) regions.push({ ...frame, sort_order: regions.length });
    }
    await db.from(CT_TABLES.products).update({ main_asset_id: mainId }).eq("id", product.id);
    if (regions.length) {
      const { error: e } = await db.rpc("ct_save_design", { p_product_id: product.id, p_regions: regions, p_items: [] });
      if (e) throw new Error(e.message);
    }
    return { ...product, main_asset_id: mainId };
  } catch (e) {
    await db.from(CT_TABLES.products).delete().eq("id", product.id);
    throw e;
  }
}

export async function createProductFromTemplate(s: CtSession, body: FromTemplateBody): Promise<NextResponse> {
  const templateId = typeof body.templateId === "string" ? body.templateId : "";
  const template = templateId ? await getTemplate(s, templateId) : null;
  if (!template) return jsonError("Không tìm thấy khuôn in", 404);
  const name = (typeof body.name === "string" ? body.name.trim() : "").slice(0, 200) || template.name;
  try {
    const product = await makeTemplateProduct(s.supabase, s.user.id, template, name);
    return NextResponse.json({ product }, { status: 201 });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không tạo được sản phẩm", 500);
  }
}

/** An artwork on a blank canvas of any size (no khuôn): one transparent sheet, layers are added in the editor. */
export async function makeBlankArtwork(db: PrintDb, userId: string, name: string, width: number, height: number): Promise<CtProduct> {
  const { data: product, error } = await db.from(CT_TABLES.products).insert({ user_id: userId, name, config: defaultProductConfig() }).select("*").single<CtProduct>();
  if (error || !product) throw new Error(error?.message ?? "Không tạo được artwork");
  try {
    const main = await insertAssetAs(db, userId, {
      productId: product.id,
      role: "main",
      parentId: null,
      generationId: null,
      name: `Canvas ${width}×${height}`,
      data: await blankSheet(width, height),
      meta: { printSheet: true },
    });
    await db.from(CT_TABLES.products).update({ main_asset_id: main.id }).eq("id", product.id);
    return { ...product, main_asset_id: main.id };
  } catch (e) {
    await db.from(CT_TABLES.products).delete().eq("id", product.id);
    throw e;
  }
}

/**
 * POST products/artwork CtCreateArtworkBody (asked 2026-11-07: "tạo thủ công với size width height ngẫu nhiên và vùng
 * printarea custom"): on the base product's khuôn in (its sheet, cut line, phôi) when it has one, else a blank canvas
 * of the size given (or the base product's first print area).
 */
export async function createArtwork(s: CtSession, raw: unknown): Promise<NextResponse> {
  const b = raw && typeof raw === "object" ? (raw as Partial<Record<keyof CtCreateArtworkBody, unknown>>) : {};
  const name = (typeof b.name === "string" ? b.name.trim() : "").slice(0, 200);
  if (!name) return jsonError("Artwork cần tên", 400);
  const base = typeof b.baseProductId === "string" ? await loadBaseProduct(s.supabase, b.baseProductId) : null;
  try {
    if (base?.config.templateId) {
      const template = await getTemplate(s, base.config.templateId);
      if (!template) return jsonError("Khuôn in của product base không còn", 404);
      return NextResponse.json({ product: await makeTemplateProduct(s.supabase, s.user.id, template, name) }, { status: 201 });
    }
    const area = base?.config.printAreas[0];
    const size = (v: unknown, d: number) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) && n >= 16 && n <= 12000 ? n : d;
    };
    const width = size(b.width, area?.width ?? 1000);
    const height = size(b.height, area?.height ?? 1000);
    if (width * height > 80_000_000) return jsonError("Canvas quá lớn (tối đa 80 MP)", 400);
    return NextResponse.json({ product: await makeBlankArtwork(s.supabase, s.user.id, name, width, height) }, { status: 201 });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không tạo được artwork", 500);
  }
}
