/**
 * Product base page + editor buttons that MCP did not have (đợt 2 of docs/memory/2026-11-24_ra-soat-api-mcp.md, asked
 * 2026-11-24: "mỗi tính năng làm bằng giao diện đều có API và MCP"). Each tool calls the SAME handler as the page's API
 * route, as the signed-in user (or the task's user); a change of a base is for its maker or an admin, like the page:
 *
 *   list_fulfiller_catalog     GET  base-import/catalog          (Product base → "Import từ xưởng": the list)
 *   import_base_product        POST base-import/import           (admin; the "Import" of one catalog product)
 *   teeinblue_connection       GET|POST base-import/teeinblue    (admin; Merchize imports go through Teeinblue)
 *   refresh_base_from_fulfiller POST base-import/refresh         (admin; base page "Khuôn + phôi từ xưởng")
 *   make_base_khuon_phoi       POST base-products/:id/khuon-phoi (base page "phôi trơn theo phôi xưởng")
 *   set_base_assembly          POST base-products/:id/assembly   (base page "Ráp mảnh may": read / swap / off)
 *   base_scenes_auto           POST|GET base-products/:id/scenes/auto (the 3 ready backgrounds)
 *   republish_base             GET|POST base-products/:id/republish (base page "Cập nhật store")
 *   clone_base_product         POST base-products/:id/clone      (base page "Nhân bản")
 *   get_product_design / save_product_design  GET products/:id · PUT products/:id/design (the editor's "Lưu thiết kế")
 *   clone_version              the editor's "+ Version (nhân bản)": picture uploaded again + its layers copied, saved
 */

import { CT_TABLES } from "../../config";
import type { CtAsset, CtProductBundle, CtProductConfig, CtRegion, CtRegionItem } from "../../types";
import { cloneLayers, versionLayers } from "../../lib/layout";
import { normalizeProductConfig } from "../../lib/design";
import { str } from "../ai/llm";
import { isAdmin } from "../ai-styles";
import { fetchImage } from "../char/files";
import * as baseImport from "../base-import";
import { cloneBaseProduct } from "../base-products";
import { makeBaseAssembly } from "../base-assembly";
import { autoBaseScenes, autoBaseScenesState } from "../base-scenes";
import { getBaseStoreState, republishBase } from "../base-republish";
import { makeBaseKhuonPhoi } from "../fulfiller-phoi";
import { getBundle, saveDesign, uploadAsset } from "../handlers";
import { siteUrl } from "../site-url";
import type { CtSession } from "../supabase";
import { answer, idOf, owned, session } from "./crud-tools";
import { OPT_TASK_ARG, json } from "./task-common";
import type { CtMcpContext, CtMcpTool } from "./tools";

const BASE_ARG = { base_product_id: { type: "string", description: "From list_base_products." } };
const basePage = (id: string) => `${siteUrl()}/base-products/${id}`;

/** A change of a base: its maker or an admin (the page's rule; the service session skips the database's own check). */
async function ownBase(ctx: CtMcpContext, s: CtSession, id: string): Promise<{ name: string }> {
  const { data: row } = await s.supabase.from(CT_TABLES.baseProducts).select("user_id, name").eq("id", id).maybeSingle<{ user_id: string | null; name: string }>();
  if (!row) throw new Error("No such product base — list_base_products");
  const admin = ctx.caller === "user" ? ctx.admin : await isAdmin(s);
  if (!admin && row.user_id !== s.user.id) throw new Error("Only the base's maker or an admin may change it");
  return row;
}

async function adminOnly(ctx: CtMcpContext, s: CtSession): Promise<void> {
  const admin = ctx.caller === "user" ? ctx.admin : await isAdmin(s);
  if (!admin) throw new Error("Admins only (as on the Product base page)");
}

async function bundleOf(s: CtSession, id: string): Promise<CtProductBundle> {
  return (await answer(await getBundle(s, id))) as unknown as CtProductBundle;
}

export const CT_MCP_BASE_TOOLS: CtMcpTool[] = [
  {
    name: "list_fulfiller_catalog",
    description:
      "The fulfiller's catalog the Product base page imports from (\"Import từ xưởng\"): provider printbelle (its own API) or merchize (through Teeinblue — needs teeinblue_connection). Each item: catalog id, title, cost, whether a base was made from it already and the price table its title fits. Read-only. Then import_base_product with an item's id (admin).",
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        provider: { type: "string", description: "printbelle | merchize." },
        q: { type: "string", description: "Search words (title / id)." },
        page: { type: "number", description: "1, 2, … (default 1)." },
        filter: { type: "string", description: "all (default) | new (no base yet) | imported (made into a base)." },
      },
      required: ["provider"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      return json(await answer(await baseImport.importCatalog(s, str(args.provider), str(args.q).trim(), args.page == null ? null : String(args.page), str(args.filter) || null)));
    },
  },
  {
    name: "import_base_product",
    description:
      "Admin: make a NEW product base from a fulfiller's catalog product (the page's \"Import\"): its variants + base cost, print area, photos, khuôn + phôi from the fulfiller, the price table its title fits; then 3 AI preview backgrounds are drawn in the background (paid image calls). Refused when a base from that product exists already. ASK THE USER before importing — it adds a base everyone sees. → the base (base_product_id, its page).",
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        provider: { type: "string", description: "printbelle | merchize." },
        catalog_id: { type: "string", description: "The item's id from list_fulfiller_catalog." },
        title: { type: "string", description: "The catalog title (merchize: the base is named after it)." },
      },
      required: ["provider", "catalog_id"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      await adminOnly(ctx, s);
      const out = await answer(await baseImport.importBase(s, { provider: str(args.provider), catalogId: str(args.catalog_id), title: str(args.title) }));
      const base = out.base as { id: string; name: string };
      return json({ base_product_id: base.id, name: base.name, page: basePage(base.id), next: "base_scenes_auto {base_product_id} shows the 3 backgrounds being drawn; check the variants / price with list_base_products." });
    },
  },
  {
    name: "teeinblue_connection",
    description:
      "The Teeinblue link Merchize imports go through: without code → is it connected (read-only); with code (admin: the connection code pasted on the import dialog) → connects it.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, code: { type: "string", description: "The Teeinblue connection code (admin). Omit to only read." } } },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      if (!str(args.code).trim()) return json(await answer(await baseImport.getTeeinblueStatus()));
      await adminOnly(ctx, s);
      return json(await answer(await baseImport.setTeeinblue(s, { code: str(args.code) })));
    },
  },
  {
    name: "refresh_base_from_fulfiller",
    description:
      "Admin: a base made from Printbelle / Merchize takes its khuôn (only when it has none — a khuôn in use is kept), the fulfiller's phôi (zone + overlay) and links again (the base page's \"Khuôn + phôi từ xưởng\"); every product on it is laid on it again. → note of what changed, phoi (a phôi came).",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, ...BASE_ARG }, required: ["base_product_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      await adminOnly(ctx, s);
      const id = idOf(args, "base_product_id");
      const out = await answer(await baseImport.refreshFulfillerBase(s, { baseId: id }));
      return json({ base_product_id: id, note: out.note, phoi: out.phoi, reapplied: out.reapplied, failed: out.failed, page: basePage(id) });
    },
  },
  {
    name: "make_base_khuon_phoi",
    description:
      "The base's khuôn gets a phôi trơn (plain blank photo) drawn by AI from the fulfiller's phôi (the base page's \"phôi trơn theo phôi xưởng\", ~1 min, one paid image call): its texture then goes into the preview backgrounds. Only a base with a khuôn, its maker or an admin. → the khuôn with its phôi list.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, ...BASE_ARG }, required: ["base_product_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "base_product_id");
      await ownBase(ctx, s, id);
      const out = await answer(await makeBaseKhuonPhoi(s, id));
      const t = out.template as { id: string; name: string; spec?: { blanks?: Array<{ url: string; name?: string }> } };
      return json({ template_id: t.id, name: t.name, blanks: (t.spec?.blanks ?? []).map((b) => ({ url: b.url, name: b.name ?? "" })), page: basePage(id) });
    },
  },
  {
    name: "set_base_assembly",
    description:
      "Sewn print sheet (the base page's \"Ráp mảnh may\", for products sewn from pieces — a hooded blanket): the khuôn's pieces are matched to the parts of the preview so each piece prints its part of the design. No flags = read the pieces again; swap = the two halves the other way round; overflow wrap | hood = where the design past the edge goes; off = drop it (the sheet prints the design as it lies). Every product on the base is laid on it again. Maker or admin. → note, reapplied.",
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        ...BASE_ARG,
        swap: { type: "boolean", description: "The halves the other way round." },
        overflow: { type: "string", description: "wrap | hood." },
        off: { type: "boolean", description: "true = no sewn pieces." },
      },
      required: ["base_product_id"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "base_product_id");
      await ownBase(ctx, s, id);
      const out = await answer(await makeBaseAssembly(s, id, { swap: args.swap === true, off: args.off === true, ...(str(args.overflow) ? { overflow: str(args.overflow) } : {}) }));
      const base = out.base as { config?: { assembly?: { pieces?: unknown[] } | null } } | null;
      return json({ base_product_id: id, note: out.note, pieces: base?.config?.assembly?.pieces?.length ?? 0, reapplied: out.reapplied, page: basePage(id) });
    },
  },
  {
    name: "base_scenes_auto",
    description:
      "The base's 3 ready preview backgrounds (home, holiday, minimal — drawn by AI from its phôi trơn; a missing phôi is drawn from the khuôn first). start true = start drawing the ones missing (maker or admin; up to 4 paid image calls, a few minutes, in the background); without start = how the run is going (status idle | running | done | skipped | failed, step, made). The drawn backgrounds are listed by base_preview_check; set_base_preview picks one.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, ...BASE_ARG, start: { type: "boolean", description: "true = start the run." } }, required: ["base_product_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "base_product_id");
      if (args.start !== true) return json({ base_product_id: id, ...(await answer(autoBaseScenesState(id))) });
      await ownBase(ctx, s, id);
      return json({ base_product_id: id, ...(await answer(await autoBaseScenes(s, id))), next: "Call base_scenes_auto {base_product_id} (no start) until done." });
    },
  },
  {
    name: "republish_base",
    description:
      "The store side of a base (the base page's \"Cập nhật store\"): without confirm → read-only, how many of its products are on the store and which show an OLD preview / sewn sheet there (after the base's preview or assembly changed); confirm true → those products' storefront templates are published again (maker or admin; the store reads them within a few minutes). Ask the user before confirm when the list is long.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, ...BASE_ARG, confirm: { type: "boolean", description: "true = publish the stale ones again." } }, required: ["base_product_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "base_product_id");
      if (args.confirm !== true) {
        const st = await answer(await getBaseStoreState(s, id));
        return json({ base_product_id: id, ...st, next: (st.stale as unknown[] | undefined)?.length ? "republish_base {base_product_id, confirm: true} to publish those again." : "Nothing is stale." });
      }
      await ownBase(ctx, s, id);
      return json({ base_product_id: id, ...(await answer(await republishBase(s, id, siteUrl()))) });
    },
  },
  {
    name: "clone_base_product",
    description:
      "A copy of a product base to change freely (the base page's \"Nhân bản\"): variants, price table, khuôn, phôi, backgrounds — the same files; you become its maker; its products stay on the old base. Use it to try a change without moving products already on Shopify. → the new base_product_id.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, ...BASE_ARG, name: { type: "string", description: "Its name (default: “… (bản sao)”)." } }, required: ["base_product_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const out = await answer(await cloneBaseProduct(s, idOf(args, "base_product_id"), { name: str(args.name) }));
      const base = out.base as { id: string; name: string };
      return json({ base_product_id: base.id, name: base.name, page: basePage(base.id), next: "update_base_product on the copy; move a product to it with update_product base_product_id." });
    },
  },
  {
    name: "get_product_design",
    description:
      "The whole saved design of a product / artwork as the editor holds it: regions (layers: zones, texts, image slots, with config), items (each layer's options), config (the design's settings: main versions, layouts per version, scene…), versions (main pictures: id, name, url, size). Read it before save_product_design. Large — prefer the narrower tools (set_artwork_layers, update_product, update_asset) when one fits.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, product_id: { type: "string", description: "The product or artwork." } }, required: ["product_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "product_id");
      await owned(s, id);
      const b = await bundleOf(s, id);
      const versions = b.assets.filter((a) => a.role === "main").map((a) => ({ id: a.id, name: a.name, url: a.url, width: a.width, height: a.height, own: a.product_id === id }));
      return json({ product_id: id, name: b.product.name, kind: b.product.kind, base_product_id: b.product.base_product_id ?? null, main_asset_id: b.product.main_asset_id, versions, regions: b.regions, items: b.items, config: normalizeProductConfig(b.product.config) });
    },
  },
  {
    name: "save_product_design",
    description:
      "Save a product's / artwork's design like the editor's \"Lưu thiết kế\" (same handler, same rules): regions = the WHOLE layer list (replaces it; omit = keep), items = the WHOLE option list (omit = keep the stored ones of the regions kept), config = only the keys given change (shallow, over the stored config). The server keeps its own fields (versions' phôi, mockup prompts / order, preview box, deploy draft); an artwork's save is a new revision (its products show \"Có bản artwork mới\"). get_product_design first, change, save the result.",
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        product_id: { type: "string", description: "The product or artwork." },
        regions: { type: "array", items: { type: "object" }, description: "Every layer, in order (as get_product_design gives them)." },
        items: { type: "array", items: { type: "object" }, description: "Every option of those layers." },
        config: { type: "object", description: "Design settings to change (only the keys given)." },
      },
      required: ["product_id"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "product_id");
      if (!Array.isArray(args.regions) && !Array.isArray(args.items) && !(args.config && typeof args.config === "object")) throw new Error("Nothing to save — give regions, items and / or config");
      await owned(s, id);
      const b = await bundleOf(s, id);
      const regions = (Array.isArray(args.regions) ? args.regions : b.regions) as CtRegion[];
      const items = (Array.isArray(args.items) ? args.items : b.items) as CtRegionItem[];
      if (regions.some((r) => !r || typeof r !== "object" || typeof r.id !== "string")) throw new Error("regions: every layer needs its id");
      const config = { ...(b.product.config as unknown as Record<string, unknown>), ...((args.config as Record<string, unknown> | undefined) ?? {}) } as unknown as CtProductConfig;
      await answer(await saveDesign(s, id, { regions, items, config }));
      const ids = new Set(regions.map((r) => r.id));
      return json({ saved: true, product_id: id, regions: regions.length, items: items.filter((i) => ids.has(i.region_id)).length, next: "render_artwork / check_artwork to look at it." });
    },
  },
  {
    name: "clone_version",
    description:
      "The editor's \"+ Version (nhân bản)\": a version (main picture) of a product / artwork copied — its picture uploaded again as a new version and all its layers copied onto it — saved at once; the product then offers more than one version to the customer. → the new version's id (swap its picture or layers after).",
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        product_id: { type: "string", description: "The product or artwork." },
        version_id: { type: "string", description: "The version to copy (get_product_design versions; default: the main one)." },
        name: { type: "string", description: "The copy's name (default “… (bản sao)”)." },
      },
      required: ["product_id"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "product_id");
      const product = await owned(s, id);
      const b = await bundleOf(s, id);
      const srcId = str(args.version_id) || product.main_asset_id || "";
      const src = b.assets.find((a) => a.id === srcId && a.role === "main");
      if (!src) throw new Error("No such version on this product — get_product_design versions");
      const name = (str(args.name).trim() || `${src.name || "Version"} (bản sao)`).slice(0, 120);
      const form = new FormData();
      form.set("file", new Blob([new Uint8Array(await fetchImage(src.url))]), name);
      form.set("role", "main");
      form.set("name", name);
      const copy = (await answer(await uploadAsset(s, id, form))).asset as CtAsset;
      const own = versionLayers(b.regions, b.items, src.id);
      const cloned = cloneLayers(own.regions, own.items, copy.id);
      const cfg = normalizeProductConfig(b.product.config);
      const frame = cfg.layouts[src.id]?.frame;
      const config: CtProductConfig = {
        ...cfg,
        main: { ...cfg.main, enabled: true },
        layouts: frame ? { ...cfg.layouts, [copy.id]: { regions: {}, items: {}, frame } } : cfg.layouts,
      };
      const regions = [...b.regions, ...cloned.regions.map((r, i) => ({ ...r, sort_order: b.regions.length + i }))];
      await answer(await saveDesign(s, id, { regions, items: [...b.items, ...cloned.items], config: { ...(b.product.config as unknown as Record<string, unknown>), ...config } as CtProductConfig }));
      return json({ version_id: copy.id, name: copy.name, url: copy.url, layers: cloned.regions.length, next: "Change the copy's picture / layers (get_product_design → save_product_design), then make_version_thumbs." });
    },
  },
];
