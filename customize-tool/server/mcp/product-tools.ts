/**
 * Product / mockup / price-table / collection tools that the web page had and MCP did not (asked 2026-11-24: "mỗi tính
 * năng làm bằng giao diện đều có API và MCP đều dùng được và biết cách dùng"; đợt 1 of docs/memory/2026-11-24_ra-soat-api-mcp.md).
 * Each one calls the SAME handler as the page's API route, as the signed-in user (or the task's user), so ownership and
 * every rule are checked the same way:
 *
 *   create_shopify_collection  POST shopify/collections            (Deploy page "+ collection")
 *   clone_product              POST products/:id/clone              (product list "Nhân bản")
 *   fit_artwork_to_base        POST products/:id/fit-base           (artwork "Khớp canvas với khuôn base")
 *   set_preview_box            POST products/:id/preview-box        (Deploy page: where the design sits on the preview photo)
 *   set_multi_photo            POST products/:id/multi-photo        (Deploy page "Popup nhiều ảnh": every photo slot in one popup)
 *   clear_failed_mockups       DELETE products/:id/mockups/failed   (Mockups tab "Xoá N ô lỗi")
 *   add_product_mockups        POST products/:id/assets role mockup (Mockups tab "Import mockup" — pictures made elsewhere)
 *   update_asset / delete_asset PATCH / DELETE assets/:id           (rename, swatch colour, move a variant; delete a picture)
 *   link_library_main / unlink_library_main  POST / DELETE products/:id/mains (a library clipart as a version)
 *   delete_version_phoi        DELETE products/:id/version-phoi     (drop a version's AI phôi on a base)
 *   create_price_table / update_price_table  POST / PATCH price-tables (preview + confirm_token first, like the base's prices)
 */

import { CT_CONFIG, CT_TABLES } from "../../config";
import type { CtAsset, CtBaseOption, CtPriceTable, CtShopifyCollection } from "../../types";
import { normalizeBaseConfig } from "../../lib/base-product";
import { normalizeProductConfig } from "../../lib/design";
import { normalizePriceTableConfig } from "../../lib/pricing";
import { str } from "../ai/llm";
import { fetchImage } from "../char/files";
import { deleteAsset, setMultiPhoto, shopifyCreateCollection, updateAsset, uploadAsset } from "../handlers";
import { cloneProduct, setPreviewBox } from "../artwork-link";
import { fitArtworkToBase } from "../artwork-fit";
import { clearFailedMockupJobs } from "../product-mockups";
import { createPriceTable, loadPriceTable, updatePriceTable } from "../price-tables";
import { linkProductMain, unlinkProductMain } from "../library";
import { deleteVersionPhoi } from "../version-phoi";
import { listCollections } from "../shopify";
import { storeFor, storeOfProduct } from "../stores";
import type { CtSession } from "../supabase";
import { siteUrl } from "../site-url";
import { CONFIRM_ARG, PRICE_TABLE_ARG, confirmToken, previewAnswer, readPriceTable, variantPreview } from "./base-variants";
import { answer, idOf, owned, session } from "./crud-tools";
import { OPT_TASK_ARG, json } from "./task-common";
import type { CtMcpTool } from "./tools";

const editorUrl = (id: string) => `${siteUrl()}${CT_CONFIG.basePath}/${id}`;

/** The options a price table prices: those of the first base using it (none = the table's own option names). */
async function tableOptions(db: CtSession["supabase"], tableId: string | null): Promise<{ options: CtBaseOption[]; bases: string[] }> {
  if (!tableId) return { options: [], bases: [] };
  const { data } = await db.from(CT_TABLES.baseProducts).select("name, config").eq("config->>priceTableId", tableId).returns<Array<{ name: string; config: unknown }>>();
  const rows = data ?? [];
  return { options: rows.length ? normalizeBaseConfig(rows[0].config).options : [], bases: rows.map((r) => r.name) };
}

export const CT_MCP_PRODUCT_TOOLS: CtMcpTool[] = [
  {
    name: "create_shopify_collection",
    description:
      "Make a manual collection on the store (the Deploy page's \"+ collection\"). Reuse first: check_deploy lists the store's collections and marks the ones that fit (suggested) — create one only when none fits the product. A collection with the same title already there is returned instead of a twin. A new collection is not on the Online Store until it is published on Shopify (the breadcrumb works for staff). Then give its id in collection_ids of save_deploy_draft / deploy_product. → {collection: {id, title, handle}, created}.",
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        title: { type: "string", description: "The collection's title (US English, plural: \"Christmas Ornaments\")." },
        product_id: { type: "string", description: "The product it is for: the collection is made on that product's store (default: your current store)." },
      },
      required: ["title"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const title = str(args.title).trim();
      if (!title) throw new Error("title is empty");
      let storeId: string | null = null;
      if (str(args.product_id)) storeId = (await storeOfProduct(s.supabase, await owned(s, idOf(args, "product_id")))).id;
      const before = new Set((await listCollections(await storeFor(s, storeId)).catch((): CtShopifyCollection[] => [])).map((c) => c.id));
      const out = await answer(await shopifyCreateCollection(s, storeId, { title }));
      const c = out.collection as CtShopifyCollection;
      return json({ collection: { id: c.id, title: c.title, handle: c.handle, smart: c.smart }, created: !before.has(c.id), next: "Put its id in collection_ids (save_deploy_draft / deploy_product)." });
    },
  },
  {
    name: "clone_product",
    description:
      "A copy of a PRODUCT as it is now (the product list's Nhân bản): its layers, options, versions, photos per option, mockup prompts and the artwork link; on the same base or base_product_id (laid on it again). Not copied: the Shopify link (its deploy makes a NEW Shopify product), the mockup pictures, the SKU. Artworks are not cloned (make_product_from_artwork instead). → the new product's id + editor url.",
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        product_id: { type: "string", description: "The product to copy." },
        name: { type: "string", description: "The copy's name (default: \"<name> (bản sao)\")." },
        base_product_id: { type: "string", description: "Put the copy on this base instead (list_base_products)." },
      },
      required: ["product_id"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "product_id");
      const body: { name?: string; baseProductId?: string } = {};
      if (str(args.name).trim()) body.name = str(args.name).trim();
      if (str(args.base_product_id)) body.baseProductId = idOf(args, "base_product_id");
      const out = await answer(await cloneProduct(s, id, body));
      const p = out.product as { id: string; name: string; base_product_id: string | null };
      return json({ product_id: p.id, name: p.name, base_product_id: p.base_product_id, editor: editorUrl(p.id), next: "set its SKU (update_product sku), make_product_mockups, then deploy_product" });
    },
  },
  {
    name: "fit_artwork_to_base",
    description:
      "An ARTWORK's canvas made exactly its base's khuôn in (the artwork editor's \"Khớp canvas với khuôn base\"): a canvas of another shape shows the khuôn with bare strips around it and prints the canvas, not the khuôn. Every layer, version frame and layout moves with the khuôn. Refused for a product (fix its artwork, then sync_product_from_artwork) and for a canvas that is a real picture. → {changed, width, height}.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, product_id: { type: "string", description: "The artwork (set_artwork_base first when it has no base)." } }, required: ["product_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      return json(await answer(await fitArtworkToBase(s, idOf(args, "product_id"))));
    },
  },
  {
    name: "set_preview_box",
    description:
      "Where the design sits on a product's preview photo (the customer's live preview on Shopify; the Deploy page's \"Vị trí trên ảnh xem trước\"). Without box: only reads → the photo (url, width, height) and the box now. box {x, y, w, h} in that photo's pixels = the design's frame moved there (this product only, the base's photo stays); box null = back to the base's position. The store sees it on the next deploy_product.",
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        product_id: { type: "string", description: "The product." },
        box: { type: "object", description: '{"x": 120, "y": 80, "w": 600, "h": 600} in the preview photo\'s pixels; null = the base\'s.' },
      },
      required: ["product_id"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "product_id");
      const p = await owned(s, id);
      const sceneOf = (cfg: unknown) => {
        const c = normalizeProductConfig(cfg as Parameters<typeof normalizeProductConfig>[0]);
        return { url: c.scene.url || null, width: c.scene.width, height: c.scene.height, box: c.scene.box ?? null, own_position: !!c.previewBox };
      };
      if (args.box === undefined) return json({ product_id: id, preview: sceneOf(p.config), note: "Give box {x, y, w, h} (photo pixels) to move the design, null for the base's position." });
      const out = await answer(await setPreviewBox(s, id, { box: args.box }));
      return json({ product_id: id, preview: sceneOf((out.product as { config: unknown }).config), next: "deploy_product puts the new position on the store." });
    },
  },
  {
    name: "set_multi_photo",
    description:
      "The store's \"one popup for every photo\" mode of a product (the Deploy page's \"Popup nhiều ảnh\"): on = the customer gets ONE popup — the live preview of the whole product on the left, every AI photo slot on the right (upload / change, its own progress bar, error + Try again), the AI jobs run side by side and each result drops into the preview; no waiting screen, no Buy More. Off (default) = one photo dialog per slot. Meant for products with several AI photo slots (3+). A product already published is published again at once, so the live page uses it now (no deploy needed). Without on: only reads → {on, photo_slots}.",
    inputSchema: {
      type: "object",
      properties: { ...OPT_TASK_ARG, product_id: { type: "string", description: "The product." }, on: { type: "boolean", description: "true = one popup for every photo slot; false = one dialog per slot." } },
      required: ["product_id"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "product_id");
      const p = await owned(s, id);
      const { data: regions } = await s.supabase.from(CT_TABLES.regions).select("kind,config").eq("product_id", id).returns<Array<{ kind: string; config: { photo?: { styles?: string[] } } }>>();
      const slots = (regions ?? []).filter((r) => r.kind === "photo").length;
      if (typeof args.on !== "boolean") return json({ product_id: id, on: normalizeProductConfig(p.config).multiPhoto, photo_slots: slots });
      const out = await answer(await setMultiPhoto(s, id, { on: args.on }, siteUrl()));
      return json({ product_id: id, on: args.on, photo_slots: slots, published: out.published, version: out.version ?? null, ...(slots < 2 && args.on ? { note: "Fewer than 2 photo slots: the popup adds little here." } : {}) });
    },
  },
  {
    name: "clear_failed_mockups",
    description: "Remove a product's failed AI mockup cards (the Mockups tab's \"Xoá N ô lỗi\"): the red cards only — finished photos and running drawings stay. → {removed}.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, product_id: { type: "string", description: "The product." } }, required: ["product_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "product_id");
      return json({ product_id: id, ...(await answer(await clearFailedMockupJobs(s, id))) });
    },
  },
  {
    name: "add_product_mockups",
    description:
      "Add mockup pictures made elsewhere (a photographer, Photoshop) to a product, as they are — the Mockups tab's \"Import mockup\". image_urls: https links to PNG / JPEG / WebP (a file of yours: upload it first, e.g. flexiprint_upload_image). They join the product's mockups (last in the Shopify order; update_product mockup_order to move them) and go up on the next deploy_product. Nothing is drawn, nothing is paid. → the new asset ids.",
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        product_id: { type: "string", description: "The product." },
        image_urls: { type: "array", items: { type: "string" }, description: "https picture links (max 20)." },
        names: { type: "array", items: { type: "string" }, description: "Optional names, same order (default: the file name)." },
      },
      required: ["product_id", "image_urls"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "product_id");
      await owned(s, id);
      const urls = Array.isArray(args.image_urls) ? args.image_urls.map(String).map((u) => u.trim()) : [];
      if (!urls.length) throw new Error("image_urls is empty");
      if (urls.length > 20) throw new Error("At most 20 pictures per call");
      const names = Array.isArray(args.names) ? args.names.map(String) : [];
      const added: Array<{ id: string; url: string; name: string }> = [];
      const failed: Array<{ url: string; error: string }> = [];
      for (const [i, url] of urls.entries()) {
        try {
          if (!/^https:\/\/\S+$/.test(url)) throw new Error("not an https link");
          const data = await fetchImage(url);
          const form = new FormData();
          const name = (names[i] || decodeURIComponent(url.split("?")[0].split("/").pop() || "mockup")).replace(/\.[a-z0-9]+$/i, "").slice(0, 120);
          form.set("file", new Blob([new Uint8Array(data)]), name);
          form.set("role", "mockup");
          form.set("name", name);
          const a = (await answer(await uploadAsset(s, id, form))).asset as CtAsset;
          added.push({ id: a.id, url: a.url, name: a.name });
        } catch (e) {
          failed.push({ url, error: e instanceof Error ? e.message : "error" });
        }
      }
      return json({ product_id: id, added, failed });
    },
  },
  {
    name: "update_asset",
    description:
      "Change a picture of a product / artwork in place (the editor's rename, swatch colour, drag into another option group): name, swatch (\"#c0392b\" — the colour shown when its option group uses the swatch display), parent_id (a VARIANT only: move it into another sub group of the same product), sort_order. Library cliparts too (their owner or an admin). Give only what changes. → the asset.",
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        asset_id: { type: "string", description: "The asset (list_product_options, check_deploy mockups, list_cliparts)." },
        name: { type: "string", description: "New name." },
        swatch: { type: "string", description: "Swatch colour, #rrggbb; \"\" = none." },
        parent_id: { type: "string", description: "A variant only: the sub (option group) to move it into." },
        sort_order: { type: "number", description: "Its place among its siblings." },
      },
      required: ["asset_id"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "asset_id");
      const body: Parameters<typeof updateAsset>[2] = {};
      if (typeof args.name === "string" && args.name.trim()) body.name = args.name.trim().slice(0, 200);
      if (typeof args.swatch === "string") {
        const sw = args.swatch.trim();
        if (sw && !/^#[0-9a-f]{6}$/i.test(sw)) throw new Error("swatch: #rrggbb");
        body.meta = { swatch: sw || undefined };
      }
      if (typeof args.parent_id === "string" && args.parent_id) body.parent_id = idOf(args, "parent_id");
      if (typeof args.sort_order === "number" && Number.isFinite(args.sort_order)) body.sort_order = Math.round(args.sort_order);
      if (!Object.keys(body).length) throw new Error("Nothing to change — give name, swatch, parent_id or sort_order");
      const a = (await answer(await updateAsset(s, id, body))).asset as CtAsset;
      return json({ asset: { id: a.id, name: a.name, role: a.role, parent_id: a.parent_id, sort_order: a.sort_order, swatch: a.meta?.swatch ?? null, url: a.url }, changed: Object.keys(body) });
    },
  },
  {
    name: "delete_asset",
    description:
      "Delete a picture of a product / artwork for good (the editor's × on a version, layer clipart or option) — ASK THE USER FIRST. Its variants go with it. Refused while products made from the artwork still use it (sync them first), and for a library clipart a product still uses. A mockup: delete_mockup (also takes it off Shopify on the next deploy). → {deleted}.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, asset_id: { type: "string", description: "The asset." } }, required: ["asset_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "asset_id");
      const { data: a } = await s.supabase.from(CT_TABLES.assets).select("id, name, role, product_id").eq("id", id).maybeSingle<Pick<CtAsset, "id" | "name" | "role" | "product_id">>();
      if (!a) throw new Error("No such asset");
      if (a.role === "mockup") throw new Error("That is a mockup — delete_mockup {product_id, asset_ids}");
      await answer(await deleteAsset(s, id));
      return json({ deleted: id, name: a.name, role: a.role, product_id: a.product_id });
    },
  },
  {
    name: "link_library_main",
    description:
      "Use a library clipart (list_cliparts: an origin, a recolour or a material version, as it is) as a VERSION of a product / artwork — the editor's \"Thêm version từ thư viện\". The first one becomes the main version when there is none. The clipart stays in the library. → the version's asset.",
    inputSchema: {
      type: "object",
      properties: { ...OPT_TASK_ARG, product_id: { type: "string", description: "The product or artwork." }, asset_id: { type: "string", description: "The library clipart." } },
      required: ["product_id", "asset_id"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const out = await answer(await linkProductMain(s, idOf(args, "product_id"), idOf(args, "asset_id")));
      return json({ product_id: str(args.product_id), main_asset_id: out.main_asset_id, linked: ((out.assets as CtAsset[]) ?? []).map((a) => ({ id: a.id, name: a.name, url: a.url })) });
    },
  },
  {
    name: "unlink_library_main",
    description: "Stop using a library clipart as a version of a product / artwork (the editor's × on a linked version). The clipart stays in the library. → {ok}.",
    inputSchema: {
      type: "object",
      properties: { ...OPT_TASK_ARG, product_id: { type: "string", description: "The product or artwork." }, asset_id: { type: "string", description: "The linked library clipart." } },
      required: ["product_id", "asset_id"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      await answer(await unlinkProductMain(s, idOf(args, "product_id"), idOf(args, "asset_id")));
      return json({ ok: true, product_id: str(args.product_id), unlinked: str(args.asset_id) });
    },
  },
  {
    name: "delete_version_phoi",
    description: "Drop one version's AI phôi on one base (the artwork editor's × on a phôi of \"Phôi theo version\"): that version is shown on the base's own phôi again. make_version_phoi draws a new one. → the phôi left (version_phoi_status).",
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        product_id: { type: "string", description: "The artwork / product." },
        main_id: { type: "string", description: "The version (main asset id) — version_phoi_status phoi[].mainId." },
        base_id: { type: "string", description: "The base it is for — version_phoi_status phoi[].baseId." },
      },
      required: ["product_id", "main_id", "base_id"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "product_id");
      return json({ product_id: id, ...(await answer(await deleteVersionPhoi(s, id, idOf(args, "main_id"), idOf(args, "base_id")))) });
    },
  },
  {
    name: "create_price_table",
    description:
      "A new price table (the Bảng giá page's \"Tạo bảng\") — PRICES only, the product base holds the variants. Prices ALWAYS go through the user: the first call saves nothing and answers a preview (rows, packs, problems) + confirm_token; show it, ask, and only on their yes call again with the same arguments + confirm_token. Then link it to a base with update_base_product price_table_id. → the table.",
    inputSchema: {
      type: "object",
      properties: { ...OPT_TASK_ARG, name: { type: "string", description: "The table's name (\"Acrylic Ornament 1 side\")." }, price_table: PRICE_TABLE_ARG, confirm_token: CONFIRM_ARG },
      required: ["name", "price_table"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const name = str(args.name).trim().slice(0, 120);
      if (!name) throw new Error("name is empty");
      const table = readPriceTable(args.price_table, undefined);
      if (!table) throw new Error("price_table is needed");
      const preview = variantPreview(table, []);
      const token = confirmToken("price-table:new", { name, options: [], table, tableId: null });
      if (str(args.confirm_token) !== token) {
        if (str(args.confirm_token)) throw new Error("confirm_token does not fit these arguments (they changed since the preview) — call without confirm_token for a new preview and ask the user again");
        return json(previewAnswer(token, preview, { name }));
      }
      const t = (await answer(await createPriceTable(s, { name, config: table }))).table as CtPriceTable;
      return json({ saved: true, price_table_id: t.id, name: t.name, next: "update_base_product {base_product_id, price_table_id} to price a base with it" });
    },
  },
  {
    name: "update_price_table",
    description:
      "Change a price table in place (its maker or an admin; the Bảng giá page): name and / or the whole new price_table. EVERY base using it gets the new prices on its products' next deploy — the preview names those bases. A price change ALWAYS goes through the user: the first call saves nothing and answers a preview + confirm_token; show it, ask, and only on their yes call again with the same arguments + confirm_token (a rename alone saves at once). To change only one base's prices when others share the table, use update_base_product price_table (it copies a shared table). → the table.",
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        price_table_id: { type: "string", description: "From list_price_tables." },
        name: { type: "string", description: "New name." },
        price_table: { ...PRICE_TABLE_ARG, description: `The whole new table. ${PRICE_TABLE_ARG.description}` },
        confirm_token: CONFIRM_ARG,
      },
      required: ["price_table_id"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "price_table_id");
      const now = await loadPriceTable(s, id);
      if (!now) throw new Error("No such price table — list_price_tables");
      if (ctx.caller === "user" && !ctx.admin && now.user_id !== ctx.userId) throw new Error("Only the table's maker or an admin may change it");
      const name = str(args.name).trim().slice(0, 120) || now.name;
      const { options, bases } = await tableOptions(s.supabase, id);
      const table = args.price_table === undefined ? null : (readPriceTable(args.price_table, options.length ? options : undefined) ?? null);
      if (!table && name === now.name) throw new Error("Nothing to change — give name or price_table");
      if (table) {
        const preview = variantPreview(table, options);
        const token = confirmToken("price-table:" + id, { name, options, table, tableId: id });
        if (str(args.confirm_token) !== token) {
          if (str(args.confirm_token)) throw new Error("confirm_token does not fit these arguments (they changed since the preview) — call without confirm_token for a new preview and ask the user again");
          return json(previewAnswer(token, preview, { price_table_id: id, name, used_by_bases: bases, note: bases.length ? `Every product of ${bases.length} base(s) deploys with these prices from its next deploy.` : "No base uses this table yet." }));
        }
        if (preview.problems.length) throw new Error(`Variants / prices: ${preview.problems.join(" ")}`);
      }
      const t = (await answer(await updatePriceTable(s, id, { name, config: table ?? normalizePriceTableConfig(now.config) }))).table as CtPriceTable;
      return json({ saved: true, price_table_id: t.id, name: t.name, changed: [...(name !== now.name ? ["name"] : []), ...(table ? ["prices"] : [])], used_by_bases: bases });
    },
  },
];

