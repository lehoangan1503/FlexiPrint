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

import { CT_CONFIG, CT_FONTS, CT_TABLES } from "../../config";
import type { CtAiStyleParams, CtAsset, CtRegion, CtRegionItem, CtShape } from "../../types";
import type { CtPrintSpec, CtPrintTemplate } from "../../types/print";
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
import { productMockups } from "../product-mockups";
import { serviceSession } from "../char/product";
import type { CtPackImage } from "../../types";
import type { CtSession } from "../supabase";
import { templateRow } from "../print-templates";
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
  };
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
      "Mockups of a product, one set per entry: the print with those options (rendered on the server exactly, text in its font) laid on the product's phôi (exact, done at once) + one AI lifestyle photo per scene made from it (~1 min, in the background). They are added to the product (editor → Mockups). → job ids; then wait_product_mockups and view_image every photo.",
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
