/**
 * MCP tools for khuôn in + artwork (types/print.ts): an agent (or a user's Claude) lays out a product from library
 * cliparts on a template, looks at it, fixes it — no picture is drawn by AI here.
 *
 *   list_print_templates / get_print_template   the pieces: sheet px, cut line, safe zone, holes, zones, sizes
 *   create_artwork_product                       a product on a template with its layers (cliparts, texts, photo
 *                                                zones, fills) → product id + where each main element sits
 *   set_artwork_layers                           replace a product's layers (the khuôn layer stays)
 *   render_artwork                               a picture of it with the khuôn drawn over, or its print file
 *                                                (server/print-render.ts) — default options or the ones named
 *   check_artwork                                every main element inside the safe zone?
 *   list_product_options                         the layers the customer picks in, with their options / text lists
 *   make_product_mockups / wait_product_mockups  the print (chosen options) on the phôi + AI lifestyle photos, the
 *                                                same pipeline as the editor's Mockups tab (server/product-mockups.ts)
 *
 * Coordinates are the template's sheet px (x, y = top-left). A layer with several asset_ids offers them as the
 * customer's options (first = default). A flat design generated with the template drawn in it and cut into cliparts
 * keeps each clipart's box: pass those boxes and the product matches the generated picture.
 */

import sharp from "sharp";
import { CT_CONFIG, CT_FONTS, CT_TABLES } from "../../config";
import type { CtAiStyleParams, CtAsset, CtBounds, CtRegion, CtRegionItem, CtShape } from "../../types";
import type { CtPrintBlank, CtPrintSpec, CtPrintTemplate } from "../../types/print";
import { defaultRegionConfig } from "../../lib/design";
import { newId, shapeBounds } from "../../lib/geometry";
import { safeShapes, sizedTemplateSpec } from "../../lib/print-template";
import { str } from "../ai/llm";
import { aiStyleRef, isAiStyleRef, withAiStyles } from "../../lib/photo-styles";
import { normalizeAiStyleParams } from "../../lib/ai-style-models";
import { ctLibraryPath, ctUpload } from "../storage";
import { siteUrl } from "../site-url";
import { frameRegion, makeTemplateProduct, productPrintOf, type PrintDb } from "../print-products";
import { loadArtwork, renderArtwork, safeReport } from "../print-render";
import { productOptions, selectionFromNames } from "../product-options";
import { makeProductBlank, productMockups } from "../product-mockups";
import { serviceSession } from "../char/product";
import type { CtPackImage } from "../../types";
import type { CtSession } from "../supabase";
import { templateRow } from "../print-templates";
import * as h from "../handlers";
import { makeVersionThumbs } from "../version-thumbs";
import { addTemplateBlank, saveTemplateBlanks, setDefaultBlank } from "../print-blanks";
import { fetchImage } from "../char/files";
import { json } from "./task-common";
import type { CtMcpContext, CtMcpTool } from "./tools";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One layer as the agent describes it. */
interface LayerArg {
  type?: unknown;
  name?: unknown;
  label?: unknown;
  asset_ids?: unknown;
  x?: unknown;
  y?: unknown;
  w?: unknown;
  h?: unknown;
  rotation?: unknown;
  text?: unknown;
  editable?: unknown;
  max_chars?: unknown;
  font?: unknown;
  font_size?: unknown;
  color?: unknown;
  shape?: unknown;
  styles?: unknown;
  default_style?: unknown;
  zone?: unknown;
  mode?: unknown;
  tile?: unknown;
  print_only?: unknown;
}

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

const LAYERS_DOC =
  'Layers, bottom first. Each: {"type": "clipart" | "text" | "photo" | "fill", "name": "…", "label": customer-facing question ("Choose your dog")}. ' +
  'clipart: "asset_ids" (library clipart ids — several = the customer picks one, first is the default), "x","y","w","h" (the box the picture is fitted into, sheet px), optional "rotation" (deg). ' +
  'text: "text", box x/y/w/h, "editable" (true = the customer types it, e.g. a name; false = fixed), "max_chars", "font" (Google font family), "font_size" px, "color" "#rrggbb". ' +
  'photo: a customer photo zone, box x/y/w/h, "shape" "rect"|"ellipse", optional "styles" (AI style refs "ai:<id>" from list_ai_styles — the customer\'s photo is redrawn in the one they pick, by its demo picture) + "default_style". ' +
  'fill: covers a zone with a picture — "zone" (a template zone id, or "sheet" = the whole cut piece), "asset_ids" (options), "mode" "cover" (one picture, e.g. a background) | "tile" (a repeated pattern, "tile" px wide), "print_only" (true: printed but not drawn on the product photo — a background whose options each have their own mockup photo).';

async function ownerOf(ctx: CtMcpContext, args: Record<string, unknown>, fallback: string | null): Promise<string> {
  if (ctx.caller === "user") {
    const { data } = await ctx.db.auth.getUser();
    if (data.user) return data.user.id;
  }
  const taskId = str(args.task_id);
  if (taskId && UUID.test(taskId)) {
    const { data } = await ctx.db.from(CT_TABLES.agentTasks).select("user_id").eq("id", taskId).maybeSingle<{ user_id: string | null }>();
    if (data?.user_id) return data.user_id;
  }
  if (fallback) return fallback;
  throw new Error("Who owns the product? Pass task_id (the product goes to that task's user).");
}

async function templateOf(db: PrintDb, id: unknown): Promise<CtPrintTemplate> {
  const key = str(id);
  if (!UUID.test(key)) throw new Error("template_id is not a valid id — list_print_templates");
  const { data } = await db.from(CT_TABLES.printTemplates).select("*").eq("id", key).maybeSingle<CtPrintTemplate>();
  if (!data) throw new Error("No such template");
  return templateRow(data);
}

function templateSummary(t: CtPrintTemplate) {
  const b = (s: CtShape) => {
    const x = shapeBounds(s);
    return { type: s.type, x: Math.round(x.x), y: Math.round(x.y), w: Math.round(x.w), h: Math.round(x.h) };
  };
  return {
    id: t.id,
    name: t.name,
    kind: t.kind,
    sheet: { width: t.spec.width, height: t.spec.height, dpi: t.spec.dpi, mm: [t.spec.widthMm, t.spec.heightMm] },
    cutLine: t.spec.outline ? b(t.spec.outline) : null,
    bleedPx: t.spec.bleed,
    safeZone: safeShapes(t.spec).map(b),
    cutOut: t.spec.cuts.map(b),
    zones: t.spec.zones.map((z) => ({ id: z.id, name: z.name, ...b(z.shape) })),
    sizes: t.spec.sizes.map((s) => ({ name: s.name, width: s.width, height: s.height })),
    guideSheet: t.spec.frameUrl,
    notes: t.spec.notes,
    // First = the phôi every product on the khuôn gets (Xem trước, mockups); box = where the sheet sits on its photo.
    blanks: t.spec.blanks.map((x, i) => ({ id: x.id, name: x.name, url: x.url, width: x.width, height: x.height, box: x.box, ai: x.ai, ...(i === 0 ? { default: true } : {}) })),
  };
}

/** A box the agent gave ({x, y, w, h} in photo px), checked against the photo. */
function boxArg(raw: unknown, blank: Pick<CtPrintBlank, "width" | "height">): CtBounds | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const [x, y, w, h] = [r.x, r.y, r.w, r.h].map(Number);
  if (![x, y, w, h].every(Number.isFinite) || w < 8 || h < 8) throw new Error("box: {x, y, w, h} in the phôi photo's px (w, h ≥ 8)");
  if (x < -w || y < -h || x > blank.width || y > blank.height) throw new Error(`box is off the photo (${blank.width} × ${blank.height} px)`);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/** The phôi photo with the khuôn's cut line (red) and hole drawn where its box puts the sheet — to check the box. */
async function blankPreview(t: CtPrintTemplate, b: CtPrintBlank): Promise<Buffer> {
  const k = b.box.w / Math.max(1, t.spec.width);
  const ky = b.box.h / Math.max(1, t.spec.height);
  const svgShape = (sh: CtShape, stroke: string) => {
    const X = (v: number) => (b.box.x + v * k).toFixed(1);
    const Y = (v: number) => (b.box.y + v * ky).toFixed(1);
    if (sh.type === "rect") return `<rect x="${X(sh.x)}" y="${Y(sh.y)}" width="${(sh.w * k).toFixed(1)}" height="${(sh.h * ky).toFixed(1)}" rx="${((sh.radius ?? 0) * k).toFixed(1)}" fill="none" stroke="${stroke}" stroke-width="3"/>`;
    if (sh.type === "ellipse") return `<ellipse cx="${X(sh.cx)}" cy="${Y(sh.cy)}" rx="${(sh.rx * k).toFixed(1)}" ry="${(sh.ry * ky).toFixed(1)}" fill="none" stroke="${stroke}" stroke-width="3"/>`;
    return `<polygon points="${sh.points.map((p) => `${X(p.x)},${Y(p.y)}`).join(" ")}" fill="none" stroke="${stroke}" stroke-width="3"/>`;
  };
  const shapes = [
    `<rect x="${b.box.x}" y="${b.box.y}" width="${b.box.w}" height="${b.box.h}" fill="none" stroke="#00a0ff" stroke-width="2" stroke-dasharray="10 8"/>`,
    ...(t.spec.outline ? [svgShape(t.spec.outline, "#ff2020")] : []),
    ...t.spec.cuts.map((c) => svgShape(c, "#ff2020")),
  ];
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${b.width}" height="${b.height}">${shapes.join("")}</svg>`);
  const photo = await sharp(await fetchImage(b.url)).resize(b.width, b.height, { fit: "fill" }).toBuffer();
  return sharp(photo).composite([{ input: svg }]).resize({ width: 1024, height: 1024, fit: "inside" }).png().toBuffer();
}

/** The tool's answer for a phôi change: the khuôn's phôi, the products moved to the new default and a picture of it. */
async function blankAnswer(t: CtPrintTemplate, products: string[], note: string) {
  const first = t.spec.blanks[0];
  const png = first ? await blankPreview(t, first).catch(() => null) : null;
  const preview = png ? await ctUpload(ctLibraryPath(t.user_id ?? "shared", null, "blank-preview", "image/png"), png, "image/png").catch(() => null) : null;
  return json({
    template_id: t.id,
    name: t.name,
    blanks: templateSummary(t).blanks,
    productsUpdated: products,
    ...(preview ? { preview } : {}),
    next: `${note} view_image preview: the default phôi with the khuôn's cut line (red) where its box (blue dashed) puts the sheet — the red line must sit exactly on the piece's edge, else set_template_blank with a corrected box. Then make_product_mockups again (productsUpdated already show this phôi; a product kept on its own phôi needs char_remake_product).`,
  });
}

/** The agent's layers → regions + items (throws a message the agent can act on). */
async function buildLayers(db: PrintDb, productId: string, spec: CtPrintSpec, raw: unknown, start: number): Promise<{ regions: CtRegion[]; items: CtRegionItem[] }> {
  if (!Array.isArray(raw) || !raw.length) throw new Error(`"layers" must be a non-empty array. ${LAYERS_DOC}`);
  const wanted = [...new Set(raw.flatMap((l) => (Array.isArray((l as LayerArg).asset_ids) ? ((l as LayerArg).asset_ids as unknown[]).map(str) : [])))];
  const { data: found } = wanted.length ? await db.from(CT_TABLES.assets).select("id,name").in("id", wanted.filter((x) => UUID.test(x))).returns<Array<Pick<CtAsset, "id" | "name">>>() : { data: [] };
  const known = new Set((found ?? []).map((a) => a.id));
  const missing = wanted.filter((x) => !known.has(x));
  if (missing.length) throw new Error(`Unknown asset ids: ${missing.join(", ")} — use list_cliparts ids`);

  const regions: CtRegion[] = [];
  const items: CtRegionItem[] = [];
  raw.forEach((value, i) => {
    const l = value as LayerArg;
    const type = str(l.type);
    const name = str(l.name) || `${type || "layer"} ${i + 1}`;
    const box: CtShape = { type: "rect", x: num(l.x, 0), y: num(l.y, 0), w: Math.max(1, num(l.w, spec.width / 3)), h: Math.max(1, num(l.h, spec.height / 3)), radius: 0 };
    const ids = Array.isArray(l.asset_ids) ? (l.asset_ids as unknown[]).map(str).filter(Boolean) : [];
    const id = newId();
    const order = start + i;
    const addItems = () =>
      ids.forEach((assetId, k) => items.push({ id: newId(), region_id: id, asset_id: assetId, transform: { offsetX: 0, offsetY: 0, scale: 1, rotation: num(l.rotation, 0) }, is_default: k === 0, sort_order: k }));
    if (type === "clipart") {
      if (!ids.length) throw new Error(`Layer "${name}": clipart needs asset_ids`);
      const config = defaultRegionConfig("image");
      config.clip = false;
      config.image.label = str(l.label) || name;
      regions.push({ id, product_id: productId, name, kind: "image", shape: box, config, sort_order: order });
      addItems();
    } else if (type === "fill") {
      if (!ids.length) throw new Error(`Layer "${name}": fill needs asset_ids`);
      const zoneId = str(l.zone) || "sheet";
      const zone = spec.zones.find((z) => z.id === zoneId);
      if (zoneId !== "sheet" && !zone) throw new Error(`Layer "${name}": no zone "${zoneId}" — zones: ${spec.zones.map((z) => z.id).join(", ") || "none (use \"sheet\")"}`);
      const shape: CtShape = zone?.shape ?? spec.outline ?? { type: "rect", x: 0, y: 0, w: spec.width, h: spec.height, radius: 0 };
      const config = defaultRegionConfig("image");
      config.image.label = str(l.label) || name;
      config.fill = { mode: str(l.mode) === "tile" ? "tile" : "cover", tile: Math.max(8, num(l.tile, 256)), ...(zone ? { zone: zone.id } : {}) };
      if (l.print_only === true) config.printOnly = true;
      regions.push({ id, product_id: productId, name, kind: "image", shape, config, sort_order: order });
      addItems();
    } else if (type === "text") {
      const config = defaultRegionConfig("text");
      const text = str(l.text);
      const font = str(l.font);
      config.text = {
        ...config.text,
        mode: l.editable === true ? "input" : "fixed",
        label: str(l.label) || name,
        defaultText: text,
        placeholder: text,
        maxChars: Math.max(1, Math.round(num(l.max_chars, Math.max(12, text.length)))),
        fontFamily: font || CT_FONTS[1].family,
        fontSize: num(l.font_size, Math.round(box.h * 0.8)),
        color: /^#[0-9a-f]{6}$/i.test(str(l.color)) ? str(l.color) : config.text.color,
        uppercase: false,
      };
      regions.push({ id, product_id: productId, name, kind: "text", shape: box, config, sort_order: order });
    } else if (type === "photo") {
      const config = defaultRegionConfig("photo");
      config.photo.label = str(l.label) || "Upload your photo";
      const refs = (Array.isArray(l.styles) ? l.styles : []).map((x) => (UUID.test(str(x)) ? aiStyleRef(str(x)) : str(x))).filter(isAiStyleRef);
      const def = str(l.default_style);
      if (refs.length) config.photo = withAiStyles(config.photo, refs, isAiStyleRef(def) ? def : UUID.test(def) ? aiStyleRef(def) : undefined);
      const shape: CtShape = str(l.shape) === "ellipse" ? { type: "ellipse", cx: box.x + box.w / 2, cy: box.y + box.h / 2, rx: box.w / 2, ry: box.h / 2 } : box;
      regions.push({ id, product_id: productId, name, kind: "photo", shape, config, sort_order: order });
    } else {
      throw new Error(`Layer "${name}": unknown type "${type}". ${LAYERS_DOC}`);
    }
  });
  return { regions, items };
}

async function saveLayers(db: PrintDb, productId: string, frame: CtRegion | null, built: { regions: CtRegion[]; items: CtRegionItem[] }): Promise<void> {
  const regions = frame ? [frame, ...built.regions] : built.regions;
  const { error } = await db.rpc("ct_save_design", { p_product_id: productId, p_regions: regions.map((r, i) => ({ ...r, sort_order: i })), p_items: built.items });
  if (error) throw new Error(error.message);
}

/** Who the mockups are made as: the signed-in editor, or (agent) the product's owner. */
async function sessionFor(ctx: CtMcpContext, ownerId: string | null): Promise<CtSession> {
  if (ctx.caller === "user") {
    const { data } = await ctx.db.auth.getUser();
    if (!data.user) throw new Error("Not signed in");
    return { supabase: ctx.db as CtSession["supabase"], user: data.user };
  }
  if (!ctx.service || !ownerId) throw new Error("The product has no owner");
  return serviceSession(ctx.service, ownerId);
}

/** make_product_blank's background drawings, by product (this process only — a restart forgets them; the phôi itself is saved). */
const BLANK_JOBS = new Map<string, { status: "running" | "done" | "failed"; error: string }>();

const editorUrl = (id: string) => `${siteUrl()}${CT_CONFIG.basePath}/${id}`;

export const CT_MCP_PRINT_TOOLS: CtMcpTool[] = [
  {
    name: "list_ai_styles",
    description:
      "AI photo styles of the global library: the customer's uploaded photo is redrawn in the style they pick (GPT Image 2.5, ~30–60 s). Each has a demo picture (the style on a sample pet photo) — view_image it to choose. Offer them on a photo zone: create_artwork_product / set_artwork_layers photo layer \"styles\": [ref, …].",
    inputSchema: { type: "object", properties: {} },
    callers: ["agent", "user"],
    run: async (ctx) => {
      const { data, error } = await ctx.db.from(CT_TABLES.aiStyles).select("id,name,prompt,params").order("sort_order").order("created_at").returns<Array<{ id: string; name: string; prompt: string; params: Partial<CtAiStyleParams> | null }>>();
      if (error) throw new Error(error.message);
      return json({
        styles: (data ?? []).map((r) => {
          const p = normalizeAiStyleParams(r.params);
          return { id: r.id, ref: aiStyleRef(r.id), name: r.name, demoUrl: p.demoUrl || null, prompt: r.prompt, ...(p.setId ? { madeForSet: p.setId } : {}), ...(p.refUrls.length ? { refUrls: p.refUrls } : {}) };
        }),
      });
    },
  },
  {
    name: "list_print_templates",
    description: "Khuôn in: the pieces products are printed on (ornament, tile, poster, sticker, all-over-print trousers…): sheet px, cut line, safe zone (main elements must stay inside), holes, named zones (fills), sizes.",
    inputSchema: { type: "object", properties: {} },
    callers: ["agent", "user"],
    run: async (ctx) => {
      const { data, error } = await ctx.db.from(CT_TABLES.printTemplates).select("*").order("sort_order").order("created_at").returns<CtPrintTemplate[]>();
      if (error) throw new Error(error.message);
      return json({ templates: (data ?? []).map((t) => templateSummary(templateRow(t))) });
    },
  },
  {
    name: "get_print_template",
    description: "One khuôn in in full (shapes as stored: rect {x,y,w,h,radius}, ellipse {cx,cy,rx,ry}, polygon {points}).",
    inputSchema: { type: "object", properties: { template_id: { type: "string", description: "From list_print_templates." } }, required: ["template_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const t = await templateOf(ctx.db, args.template_id);
      return json({ ...templateSummary(t), spec: t.spec });
    },
  },
  {
    name: "create_print_template",
    description:
      "Make a new khuôn in from the piece's REAL size when no khuôn of list_print_templates fits the product the editor describes (a 120 × 40 cm rug, a 30 × 40 cm canvas…) — never stretch a small khuôn: a 1024 px picture printed on a rug is blurred. kind 'flat' = a fixed rectangle (rounded corners), 'cut' = die-cut along the artwork (acrylic, sticker). dpi: 300 for small hard goods (≤ 30 cm), 150 for big soft ones (rugs, blankets, flags). → the template id; set it as brief.product.templateId.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Vietnamese name with the size: \"Thảm bếp dài 120×40 cm (47.2×15.7″)\"." },
        kind: { type: "string", description: "flat | cut" },
        width_mm: { type: "number", description: "The finished piece's width, mm (23.6 in = 600 mm)." },
        height_mm: { type: "number", description: "Its height, mm." },
        dpi: { type: "number", description: "300 (small) or 150 (big). Default by size." },
        corner_mm: { type: "number", description: "Rounded corners of the cut line (flat)." },
        bleed_mm: { type: "number", description: "Artwork past the cut line (flat; a rug's bound edge ~10)." },
        safe_mm: { type: "number", description: "Main elements stay this far inside the cut line (default 5 % of the short side)." },
        hole: { type: "object", description: "{ diameter_mm, from_top_mm } a round hanging hole at the top centre (an ornament)." },
        notes: { type: "string", description: "Vietnamese notes for the editor (what is printed, edges)." },
        task_id: { type: "string", description: "Agent: the task it is for (its user owns the khuôn)." },
      },
      required: ["name", "kind", "width_mm", "height_mm"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const w = Number(args.width_mm);
      const h = Number(args.height_mm);
      if (!(w > 5 && h > 5 && w < 5000 && h < 5000)) throw new Error("width_mm / height_mm: the piece's size in mm (5–5000)");
      const kind = args.kind === "cut" ? "cut" : "flat";
      const dpi = Number(args.dpi) > 0 ? Math.min(600, Math.max(72, Math.round(Number(args.dpi)))) : Math.max(w, h) > 300 ? 150 : 300;
      const hole = args.hole && typeof args.hole === "object" ? (args.hole as Record<string, unknown>) : null;
      const spec = sizedTemplateSpec({
        widthMm: w,
        heightMm: h,
        dpi,
        kind,
        cornerMm: Number(args.corner_mm) || 0,
        bleedMm: Number(args.bleed_mm) || 0,
        ...(Number(args.safe_mm) > 0 ? { safeMm: Number(args.safe_mm) } : {}),
        hole: hole && Number(hole.diameter_mm) > 0 ? { diameterMm: Number(hole.diameter_mm), fromTopMm: Number(hole.from_top_mm) || Number(hole.diameter_mm) } : null,
        notes: str(args.notes),
      });
      const owner = await ownerOf(ctx, args, null);
      const { data, error } = await ctx.db.from(CT_TABLES.printTemplates).insert({ user_id: owner, name: str(args.name).slice(0, 120) || `Khuôn ${w}×${h} mm`, kind, spec, sort_order: 100 }).select("*").single<CtPrintTemplate>();
      if (error || !data) throw new Error(error?.message ?? "Không lưu được khuôn");
      return json({ ...templateSummary(templateRow(data)), next: "brief.product.templateId = this id (char_update_brief)." });
    },
  },
  {
    name: "add_template_blank",
    description:
      "Khuôn in: add a phôi (a photo of the blank piece, nothing printed) to a khuôn from a picture url — a picture the editor attached in the chat, a photo of the real blank. It must be shot straight on (front face only, no thickness / side visible, plain even backdrop). The box (where the sheet sits on the photo) is found on it; pass box to set it yourself. default (true) = it becomes the first phôi, the one every product on the khuôn gets (Xem trước, mockups). → the khuôn's phôi + a picture with the cut line drawn on it: view it.",
    inputSchema: {
      type: "object",
      properties: {
        template_id: { type: "string", description: "From list_print_templates." },
        url: { type: "string", description: "The picture (https)." },
        name: { type: "string", description: "Vietnamese name, e.g. \"Phôi sứ trắng chụp thẳng\"." },
        default: { type: "boolean", description: "Make it the khuôn's first phôi (default true)." },
        box: { type: "object", description: "{x, y, w, h} — the sheet on the photo, photo px (omit = found on the photo)." },
        task_id: { type: "string", description: "Agent: the task it is for (its user stores the photo)." },
      },
      required: ["template_id", "url"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const t = await templateOf(ctx.db, args.template_id);
      const url = str(args.url);
      if (!/^https?:\/\//.test(url)) throw new Error("url: an https picture url");
      const owner = await ownerOf(ctx, args, t.user_id);
      const added = await addTemplateBlank(ctx.db, owner, t, await fetchImage(url), str(args.name).slice(0, 120) || "Phôi", false);
      let blank = added.spec.blanks[added.spec.blanks.length - 1];
      let current = added;
      const box = boxArg(args.box, blank);
      if (box) {
        blank = { ...blank, box };
        current = (await saveTemplateBlanks(ctx.db, current, current.spec.blanks.map((b) => (b.id === blank.id ? blank : b)))).template;
      }
      if (args.default === false) return blankAnswer(current, [], `Added phôi ${blank.id} (not the default).`);
      const r = await setDefaultBlank(ctx.db, current, blank.id);
      return blankAnswer(r.template, r.products, `Phôi ${blank.id} is now the default.`);
    },
  },
  {
    name: "set_template_blank",
    description:
      "Khuôn in: change one phôi of a khuôn (get_print_template → blanks[].id): default true = make it the first one (every product on the khuôn gets it), box = where the sheet sits on its photo ({x, y, w, h} photo px — fix it when the cut line misses the piece's edge), detect true = find the box on the photo again, name, remove true = delete it from the khuôn. Products on the khuôn that showed one of its phôi move to the new default by themselves. → the khuôn's phôi + a picture of the default one with the cut line drawn: view it.",
    inputSchema: {
      type: "object",
      properties: {
        template_id: { type: "string", description: "From list_print_templates." },
        blank_id: { type: "string", description: "get_print_template blanks[].id" },
        default: { type: "boolean", description: "true = make it the first phôi." },
        box: { type: "object", description: "{x, y, w, h} in the phôi photo's px." },
        detect: { type: "boolean", description: "true = find the box on the photo again." },
        name: { type: "string", description: "A new name." },
        remove: { type: "boolean", description: "true = delete this phôi from the khuôn." },
      },
      required: ["template_id", "blank_id"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const t = await templateOf(ctx.db, args.template_id);
      const id = str(args.blank_id);
      const old = t.spec.blanks.find((b) => b.id === id);
      if (!old) throw new Error(`No phôi ${id} on this khuôn — get_print_template blanks: ${t.spec.blanks.map((b) => b.id).join(", ") || "none"}`);
      if (args.remove === true) {
        const r = await saveTemplateBlanks(ctx.db, t, t.spec.blanks.filter((b) => b.id !== id));
        return blankAnswer(r.template, r.products, `Removed phôi ${id}.`);
      }
      let next: CtPrintBlank = { ...old, ...(str(args.name) ? { name: str(args.name).slice(0, 120) } : {}) };
      if (args.detect === true) {
        const { sceneForBlank } = await import("../product-mockups");
        const scene = await sceneForBlank(await fetchImage(old.url), old.url, t.spec);
        next = { ...next, box: scene.box };
      }
      const box = boxArg(args.box, old);
      if (box) next = { ...next, box };
      const list = t.spec.blanks.map((b) => (b.id === id ? next : b));
      const r = await saveTemplateBlanks(ctx.db, t, args.default === true ? [next, ...list.filter((b) => b.id !== id)] : list);
      return blankAnswer(r.template, r.products, `Saved phôi ${id}.`);
    },
  },
  {
    name: "delete_print_template",
    description:
      "Delete a khuôn in made by mistake (a duplicate, a test). Refused while a product or a bộ uses it (the answer lists them) — move those to another khuôn first. Ask the editor before deleting a khuôn you did not make in this task.",
    inputSchema: { type: "object", properties: { template_id: { type: "string", description: "From list_print_templates." } }, required: ["template_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const t = await templateOf(ctx.db, args.template_id);
      const [{ data: products }, { data: sets }] = await Promise.all([
        ctx.db.from(CT_TABLES.products).select("id, name").eq("config->print->>templateId", t.id).limit(20).returns<Array<{ id: string; name: string }>>(),
        ctx.db.from(CT_TABLES.charProjects).select("id, name").eq("brief->product->>templateId", t.id).limit(20).returns<Array<{ id: string; name: string }>>(),
      ]);
      if (products?.length || sets?.length) return json({ deleted: false, template_id: t.id, name: t.name, usedBy: { products: products ?? [], sets: sets ?? [] }, message: "In use — not deleted." });
      const { error, count } = await ctx.db.from(CT_TABLES.printTemplates).delete({ count: "exact" }).eq("id", t.id);
      if (error) throw new Error(error.message);
      if (!count) throw new Error("Not deleted (only its maker or an admin may)");
      return json({ deleted: true, template_id: t.id, name: t.name });
    },
  },
  {
    name: "create_artwork_product",
    description: `Make a product on a khuôn in from library cliparts: its canvas is the template's sheet, its print file is cut to the template. Returns the product id, its editor url and where each main element sits against the safe zone (fix outside ones with set_artwork_layers). Look at it with render_artwork. ${LAYERS_DOC}`,
    inputSchema: {
      type: "object",
      properties: {
        template_id: { type: "string", description: "From list_print_templates." },
        name: { type: "string", description: "Product name." },
        layers: { type: "array", items: { type: "object" }, description: LAYERS_DOC },
        task_id: { type: "string", description: "Agent: the task the product is for (its user owns the product)." },
      },
      required: ["template_id", "name", "layers"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const t = await templateOf(ctx.db, args.template_id);
      const owner = await ownerOf(ctx, args, t.user_id);
      const product = await makeTemplateProduct(ctx.db, owner, t, str(args.name) || t.name);
      try {
        const built = await buildLayers(ctx.db, product.id, t.spec, args.layers, 1);
        await saveLayers(ctx.db, product.id, frameRegion(product.id, productPrintOf(t)), built);
      } catch (e) {
        await ctx.db.from(CT_TABLES.products).delete().eq("id", product.id);
        throw e;
      }
      const bundle = await loadArtwork(ctx.db, product.id);
      return json({ product_id: product.id, editor: editorUrl(product.id), safeZone: bundle ? safeReport(bundle) : [], next: "render_artwork to look at it; set_artwork_layers to fix." });
    },
  },
  {
    name: "set_artwork_layers",
    description: `Replace every layer of a product made on a khuôn in (its khuôn layer stays). ${LAYERS_DOC}`,
    inputSchema: {
      type: "object",
      properties: {
        product_id: { type: "string", description: "From create_artwork_product." },
        layers: { type: "array", items: { type: "object" }, description: LAYERS_DOC },
      },
      required: ["product_id", "layers"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const bundle = await loadArtwork(ctx.db, str(args.product_id));
      if (!bundle?.spec) throw new Error("Not a product made on a khuôn in");
      const frame = bundle.regions.find((r) => r.config.materialFrame) ?? null;
      const built = await buildLayers(ctx.db, bundle.product.id, bundle.spec, args.layers, 1);
      await saveLayers(ctx.db, bundle.product.id, frame, built);
      const next = await loadArtwork(ctx.db, bundle.product.id);
      return json({ product_id: bundle.product.id, safeZone: next ? safeReport(next) : [] });
    },
  },
  {
    name: "check_artwork",
    description: "Where each main element (placed clipart, text, photo zone) of a khuôn in product sits, and whether it is inside the safe zone.",
    inputSchema: { type: "object", properties: { product_id: { type: "string", description: "The product." } }, required: ["product_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const bundle = await loadArtwork(ctx.db, str(args.product_id));
      if (!bundle) throw new Error("No such product");
      const report = safeReport(bundle);
      return json({ product_id: bundle.product.id, sheet: bundle.spec ? { width: bundle.spec.width, height: bundle.spec.height } : null, layers: report, allInside: report.every((r) => r.inSafe) });
    },
  },
  {
    name: "render_artwork",
    description:
      'A picture of a product. mode "guides" (default): the cut line, safe zone (dashed), holes and zones drawn over; red boxes = main elements outside the safe zone. mode "print": the print file as the storefront makes it (transparent, cut to the khuôn). "options" picks the customer\'s choices by name (list_product_options), else the defaults. Text is drawn with its real font.',
    inputSchema: {
      type: "object",
      properties: {
        product_id: { type: "string", description: "The product." },
        mode: { type: "string", description: '"guides" (default) or "print".' },
        options: { type: "object", description: '{"<layer name or label>": "<option name / text>"} — e.g. {"Background": "Halloween", "Choose your slogan": "Best Friends Forever"}.' },
      },
      required: ["product_id"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const bundle = await loadArtwork(ctx.db, str(args.product_id));
      if (!bundle) throw new Error("No such product");
      const options = args.options && typeof args.options === "object" ? (args.options as Record<string, unknown>) : {};
      const selection = selectionFromNames(bundle, Object.fromEntries(Object.entries(options).map(([k, v]) => [k, str(v)])));
      const png = await renderArtwork(bundle, selection, 1400, str(args.mode) === "print" ? "print" : "guides");
      const url = await ctUpload(ctLibraryPath(bundle.product.user_id, null, "artwork-render", "image/png"), png, "image/png");
      return { images: [{ data: png.toString("base64"), mimeType: "image/png", url }] };
    },
  },
  {
    name: "set_photo_zone",
    description:
      "Move / reshape ONE customer-photo layer (\"Ảnh khách — …\") of a product — per version: a product with versions (Red Santa / Green Elf / Sleigh) has its own photo layers in each. Without x/y/w/h → the photo layers: id, version, name, shape, box. With them → that layer becomes an ellipse (default) or rect of that box (sheet px, x/y = top-left; render_artwork shows the sheet). A face zone lies UNDER the body: the face shows where the body has no pixels (its hole / the empty head), the hat brim and collar over its edge — draw the box a little bigger than the hole. The other layers, the photo settings (styles, required, fit) and the customer's framing stay. Kept by char_remake_product (reset_zones: true goes back to the set's zones). A published product is published again. Then render_artwork that version (options {\"Choose Design\": \"<version>\"}) and look.",
    inputSchema: {
      type: "object",
      properties: {
        product_id: { type: "string", description: "The product." },
        region_id: { type: "string", description: "The photo layer's id (from the listing). Or version + label." },
        version: { type: "string", description: "The version's name (as listed), with label." },
        label: { type: "string", description: "The photo layer's customer label or name (\"Upload photo for person 1\"), with version." },
        shape: { type: "string", description: "\"ellipse\" (default) or \"rect\"." },
        x: { type: "number", description: "Box left, sheet px." },
        y: { type: "number", description: "Box top, sheet px." },
        w: { type: "number", description: "Box width." },
        h: { type: "number", description: "Box height." },
      },
      required: ["product_id"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const bundle = await loadArtwork(ctx.db, str(args.product_id));
      if (!bundle) throw new Error("No such product");
      const mains = new Map(bundle.assets.filter((a) => a.role === "main").map((a) => [a.id, a.name]));
      const versionOf = (r: CtRegion) => (r.config.mainId ? (mains.get(r.config.mainId) ?? "") : "");
      const photos = bundle.regions.filter((r) => r.kind === "photo");
      const listing = () =>
        photos.map((r) => {
          const b = shapeBounds(r.shape);
          return { id: r.id, version: versionOf(r), name: r.name, label: r.config.photo.label, shape: r.shape.type, box: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) } };
        });
      const box = [args.x, args.y, args.w, args.h];
      if (box.every((v) => v === undefined)) return json({ product_id: bundle.product.id, photoLayers: listing() });
      if (!box.every((v) => typeof v === "number" && Number.isFinite(v)) || num(args.w, 0) <= 0 || num(args.h, 0) <= 0) throw new Error("x, y, w, h: numbers, w and h > 0");
      const want = str(args.label).trim().toLowerCase();
      const version = str(args.version).trim().toLowerCase();
      const target = args.region_id
        ? photos.find((r) => r.id === str(args.region_id))
        : photos.find((r) => versionOf(r).trim().toLowerCase() === version && (r.config.photo.label.toLowerCase() === want || r.name.toLowerCase().includes(want)) && want !== "");
      if (!target) return json({ error: "No such photo layer — pick one of these (region_id, or version + label).", photoLayers: listing() });
      const [x, y, w, bh] = box as number[];
      const shape: CtShape = str(args.shape) === "rect" ? { type: "rect", x, y, w, h: bh, radius: 0 } : { type: "ellipse", cx: x + w / 2, cy: y + bh / 2, rx: w / 2, ry: bh / 2 };
      const { error } = await ctx.db.from(CT_TABLES.regions).update({ shape }).eq("id", target.id);
      if (error) throw new Error(error.message);
      const { data: product } = await ctx.db.from(CT_TABLES.products).select("user_id, published_version").eq("id", bundle.product.id).maybeSingle<{ user_id: string; published_version: number | null }>();
      let published = false;
      if (product?.published_version) published = (await h.publish(await serviceSession(ctx.db, product.user_id), bundle.product.id, siteUrl())).ok;
      return json({ product_id: bundle.product.id, set: { id: target.id, version: versionOf(target), name: target.name, shape }, published, next: `render_artwork {product_id, options: {<the version chooser>: "${versionOf(target)}"}} and look at the zone.` });
    },
  },
  {
    name: "make_version_thumbs",
    description:
      "The picture on each VERSION tile the customer picks first (\"Choose Design\": Red Santa / Green Elf…): every version drawn as its print with the default options, cropped close on a square, saved as the version's thumb; the version picker then shows pictures, not words. Product builds with versions make them by themselves — call this after the layers were changed by hand (or for a product built before 2026-11-04). A published product is published again so the store shows them. → made {version: url}, failed.",
    inputSchema: { type: "object", properties: { product_id: { type: "string", description: "The product." } }, required: ["product_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const productId = str(args.product_id);
      const out = await makeVersionThumbs(ctx.db, productId);
      const { data: product } = await ctx.db.from(CT_TABLES.products).select("user_id, published_version").eq("id", productId).maybeSingle<{ user_id: string; published_version: number | null }>();
      let published = false;
      if (product?.published_version && Object.keys(out.made).length) published = (await h.publish(await serviceSession(ctx.db, product.user_id), productId, siteUrl())).ok;
      return json({ ...out, published, next: Object.keys(out.made).length ? "view_image a few of the urls." : "No versions to picture (one version, or versions off)." });
    },
  },
  {
    name: "list_product_options",
    description: "The layers of a product the customer picks in (backgrounds, hair, clothes, held items, texts…) with every option's name and which is the default — the names render_artwork / make_product_mockups take.",
    inputSchema: { type: "object", properties: { product_id: { type: "string", description: "The product." } }, required: ["product_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const bundle = await loadArtwork(ctx.db, str(args.product_id));
      if (!bundle) throw new Error("No such product");
      return json({ product_id: bundle.product.id, name: bundle.product.name, editor: editorUrl(bundle.product.id), layers: productOptions(bundle) });
    },
  },
  {
    name: "make_product_mockups",
    description:
      "Mockups of a product, one set per entry: one AI lifestyle photo per scene (~1 min, in the background), drawn from the print with those options (rendered on the server exactly, text in its font) laid on the product's phôi — that front picture (front) is only the AI's reference, not a product picture. The photos are added to the product (editor → Mockups) and are what Deploy sends to Shopify. → job ids; then wait_product_mockups and view_image every photo.",
    inputSchema: {
      type: "object",
      properties: {
        product_id: { type: "string", description: "The product." },
        mockups: {
          type: "array",
          items: { type: "object" },
          description: '[{"label": "Christmas", "options": {"<layer>": "<option>"}, "scenes": ["<English: where the product is and what is around it — e.g. hanging on a decorated Christmas tree with warm bokeh lights>"]}] — 1–4 entries, 1–3 scenes each.',
        },
        task_id: { type: "string", description: "Agent: the task it is for (its user owns the mockups)." },
      },
      required: ["product_id", "mockups"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const bundle = await loadArtwork(ctx.db, str(args.product_id));
      if (!bundle) throw new Error("No such product");
      const list = (Array.isArray(args.mockups) ? args.mockups : []).slice(0, 4).map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : {}));
      if (!list.length) throw new Error('"mockups" must list at least one {label, options, scenes}');
      const s = await sessionFor(ctx, bundle.product.user_id);
      const out: Array<{ label: string; front: string; jobs: Array<{ id: string; scene: string; status: string }> }> = [];
      for (const m of list) {
        const options = m.options && typeof m.options === "object" ? (m.options as Record<string, unknown>) : {};
        const selection = selectionFromNames(bundle, Object.fromEntries(Object.entries(options).map(([k, v]) => [k, str(v)])));
        const scenes = (Array.isArray(m.scenes) ? m.scenes : []).map(str).filter(Boolean).slice(0, 3);
        const print = await renderArtwork(bundle, selection, Math.max(bundle.spec?.width ?? 2000, bundle.spec?.height ?? 2000), "print");
        const label = str(m.label).slice(0, 60);
        const r = await productMockups(s, bundle.product, print, scenes, label);
        out.push({ label, front: r.front.url, jobs: r.jobs.filter((j) => j.status === "running").map((j) => ({ id: j.id, scene: j.description, status: j.status })) });
      }
      return json({ mockups: out, next: "wait_product_mockups with the job ids, then view_image each photo (the print must be unchanged on it)." });
    },
  },
  {
    name: "make_product_blank",
    description:
      "Draw a phôi trơn (the blank piece, nothing printed) for a product from its khuôn in and material (the team's image model, ~1 min in the background) — for a product whose khuôn has no phôi of its material (char_add_product → blank null, or a glass phôi on a ceramic product). It becomes the product's phôi (Xem trước, Mockups) and the khuôn keeps it for the next product. check: true → is it done, and the product's phôi url; view_image it before make_product_mockups.",
    inputSchema: {
      type: "object",
      properties: { product_id: { type: "string", description: "The product." }, check: { type: "boolean", description: "true = only report the state." }, task_id: { type: "string", description: "Agent: the task it is for." } },
      required: ["product_id"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const productId = str(args.product_id);
      const { data: product } = await ctx.db.from(CT_TABLES.products).select("id, user_id, config").eq("id", productId).maybeSingle<{ id: string; user_id: string | null; config: { scene?: { url?: string } } }>();
      if (!product) throw new Error("No such product");
      const state = BLANK_JOBS.get(productId);
      if (args.check === true || state?.status === "running")
        return json({ status: state?.status ?? "idle", error: state?.error || undefined, blank: product.config?.scene?.url || null, ...(state?.status === "running" ? { message: "still drawing — call again with check: true in ~30 s." } : {}) });
      const s = await sessionFor(ctx, product.user_id);
      BLANK_JOBS.set(productId, { status: "running", error: "" });
      void makeProductBlank(s, productId)
        .then(async (res) => {
          const body = (await res.json()) as { error?: string };
          BLANK_JOBS.set(productId, res.ok ? { status: "done", error: "" } : { status: "failed", error: body.error ?? `HTTP ${res.status}` });
        })
        .catch((e: Error) => BLANK_JOBS.set(productId, { status: "failed", error: e.message }));
      return json({ status: "running", next: "make_product_blank {product_id, check: true} in ~1 min, view_image the blank, then make_product_mockups." });
    },
  },
  {
    name: "wait_product_mockups",
    description: "Wait (up to ~1 min per call) for mockup jobs of a product → each one's status and url. \"still running\" → call again.",
    inputSchema: {
      type: "object",
      properties: { product_id: { type: "string", description: "The product." }, job_ids: { type: "array", items: { type: "string" }, description: "From make_product_mockups." } },
      required: ["product_id", "job_ids"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const ids = (Array.isArray(args.job_ids) ? args.job_ids : []).map(str).filter((x) => UUID.test(x)).slice(0, 20);
      if (!ids.length) throw new Error("job_ids is required");
      const read = async () => (await ctx.db.from(CT_TABLES.packImages).select("*").in("id", ids).eq("name", `mockup:${str(args.product_id)}`).returns<CtPackImage[]>()).data ?? [];
      const deadline = Date.now() + 60_000; // under the proxies' cut (Cloudflare Tunnel 100 s), as char-tools WAIT_MS
      let rows = await read();
      while (rows.some((r) => r.status === "running") && Date.now() + 4000 < deadline) {
        await new Promise((r) => setTimeout(r, 4000));
        rows = await read();
      }
      const still = rows.filter((r) => r.status === "running").length;
      return json({ jobs: rows.map((r) => ({ id: r.id, scene: r.description, status: r.status, url: r.url, error: r.error || undefined })), ...(still ? { message: `${still} still running — call again.` } : {}) });
    },
  },
];
