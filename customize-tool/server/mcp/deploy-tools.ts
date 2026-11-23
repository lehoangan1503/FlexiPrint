/**
 * MCP tools for Deploy (asked 2026-10-29: the agent finishes and deploys a product itself, ACTIVE when everything
 * passes) — the same pipeline as the editor's Deploy page (server/handlers.ts runDeploy):
 *
 *   check_deploy     what a deploy of the product would use and what blocks it (Vietnamese "missing" list)
 *   list_base_products / make_product_from_artwork   product bases (variants + price) and a product = artwork + base
 *   deploy_product   the same checks again, then the storefront template + the Shopify product (variants from the
 *                    price table, mockups as images); run again it updates the same Shopify product
 *
 * The task's user — or the signed-in user (no task_id, the local MCP integrations/flexiprint, 2026-11-17) — must be
 * able to edit the product (its owner, or an admin — migration 026).
 */

import type { CtAgentTask, CtAsset, CtBaseProduct, CtContentResult, CtPriceTable, CtProduct, CtShopifyCollection, CtShopifyInfo } from "../../types";
import { auditOptions } from "../../lib/option-audit";
import { suggestCollections } from "../../lib/collections";
import { defaultDeployMedia, effectivePicks } from "../../lib/deploy-media";
import { normalizePriceTableConfig, priceCells, priceTableFor, priceTableProblems } from "../../lib/pricing";
import { str } from "../ai/llm";
import { serviceSession } from "../char/product";
import { ownedProduct, productTemplate, readDeployBody, runDeploy } from "../handlers";
import { listCollections, previewLinks, shopifyConfigured, shopifyInfo } from "../shopify";
import { loadStores, storeOfProduct } from "../stores";
import { siteUrl } from "../site-url";
import { listBaseRows, loadBaseProduct } from "../base-products";
import { applyBase, makeProductFromArtwork, resyncProduct } from "../artwork-link";
import { saveOwnMockupPrompt } from "../product-mockups";
import { baseImage, normalizeBaseConfig, normalizeBaseMockup } from "../../lib/base-product";
import { CT_MOCKUP_BLOCK_REFS_MAX, CT_MOCKUP_REFS_MAX, badBlockRefs, defaultMockupWrap, mockupRefList } from "../../lib/mockup-prompt";
import { defaultScenes, splitScenes } from "../../lib/mockup-scenes";
import { ensureVersionPhoi, jobName } from "../version-phoi";
import { normalizeProductConfig } from "../../lib/design";
import { liveDraft, normalizeCustomerNote, normalizeDeployDraft } from "../../lib/deploy-draft";
import { CT_CONFIG, CT_TABLES } from "../../config";
import type { CtServiceClient, CtSession } from "../supabase";
import { OPT_TASK_ARG, actorOf, json, liveStatus } from "./task-common";
import type { CtMcpContext, CtMcpTool } from "./tools";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A description shorter than this (its text, tags stripped) is not a product page. */
const MIN_DESCRIPTION = 200;

/** Who works (the task's user, or the signed-in user — task_id optional for them) and a session as that user. */
async function openActor(ctx: CtMcpContext, args: Record<string, unknown>): Promise<{ db: CtServiceClient; task: CtAgentTask | null; userId: string; s: CtSession }> {
  const { db, task, userId } = await actorOf(ctx, args.task_id);
  return { db, task, userId, s: await serviceSession(db, userId) };
}

/** The task (if any), a session of its user and the product they may edit. */
async function openProduct(ctx: CtMcpContext, args: Record<string, unknown>): Promise<{ db: CtServiceClient; task: CtAgentTask | null; s: CtSession; product: CtProduct }> {
  const { db, task, s } = await openActor(ctx, args);
  const id = str(args.product_id);
  if (!UUID.test(id)) throw new Error("product_id is not a valid id");
  const product = await ownedProduct(s, id);
  if (!product) throw new Error("No such product, or you may not edit it");
  return { db, task, s, product };
}

/** One progress line on the task — nothing when the user works without one. */
async function progress(db: CtServiceClient, taskId: string | undefined, text: string): Promise<void> {
  if (!taskId) return;
  const { data: task } = await db.from(CT_TABLES.agentTasks).select("*").eq("id", taskId).single<CtAgentTask>();
  if (!task) return;
  await db
    .from(CT_TABLES.agentTasks)
    .update({ status: liveStatus(task), progress: [...(task.progress ?? []), { at: new Date().toISOString(), text, kind: "run" }].slice(-50) })
    .eq("id", taskId);
}

const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();

interface DeployState {
  /** The product's base product (variants + price), when it has one. */
  base: CtBaseProduct | null;
  info: CtShopifyInfo;
  tables: CtPriceTable[];
  mockups: CtAsset[];
  templateError: string | null;
  audit: ReturnType<typeof auditOptions> | null;
  content: CtContentResult | null;
}

/** Everything a deploy of the product reads. */
export async function deployState(db: CtServiceClient, s: CtSession, product: CtProduct): Promise<DeployState> {
  const store = await storeOfProduct(db, product);
  const [base, info, tables, mockups, built, content] = await Promise.all([
    product.base_product_id ? loadBaseProduct(db, product.base_product_id) : Promise.resolve(null),
    shopifyInfo(store, product.shopify?.productId ?? null).catch((e: Error): CtShopifyInfo => ({ configured: shopifyConfigured(store), shop: null, product: null, error: e.message })),
    db
      .from(CT_TABLES.priceTables)
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(200)
      .returns<CtPriceTable[]>()
      .then((r) => (r.data ?? []).map((t) => ({ ...t, config: normalizePriceTableConfig(t.config) }))),
    db
      .from(CT_TABLES.assets)
      .select("*")
      .eq("product_id", product.id)
      .eq("role", "mockup")
      .order("created_at")
      .returns<CtAsset[]>()
      .then((r) => r.data ?? []),
    productTemplate(s, product),
    db
      .from(CT_TABLES.agentTasks)
      .select("result")
      .eq("kind", "content")
      .eq("status", "done")
      .eq("input->content->>productId", product.id)
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ result: CtContentResult | null }>()
      .then((r) => r.data?.result ?? null),
  ]);
  return {
    base,
    info,
    tables,
    mockups,
    templateError: "error" in built ? built.error : null,
    audit: "error" in built ? null : auditOptions(built.template),
    content,
  };
}

/** What blocks a deploy (Vietnamese, the editor reads it). */
export function blockers(st: DeployState, pick: { kind: string; tableId: string | null; title: string; descriptionHtml: string; mediaIds: string[] }): string[] {
  const out: string[] = [];
  if (pick.kind !== "product") out.push("Đây là ARTWORK, không phải sản phẩm — make_product_from_artwork (artwork + product base) rồi deploy sản phẩm đó.");
  if (!st.info.configured) out.push("Chưa cấu hình Shopify trên server (SHOPIFY_STORE_DOMAIN / CLIENT_ID / CLIENT_SECRET).");
  const table = st.tables.find((t) => t.id === pick.tableId);
  if (!st.tables.length) out.push("Chưa có bảng giá nào — editor tạo bảng giá ở trang Deploy.");
  else if (!table) out.push("Chưa chọn bảng giá (price_table_id).");
  else {
    const problems = priceTableProblems(table.config);
    if (problems.length) out.push(`Bảng giá “${table.name}”: ${problems.join(" ")}`);
  }
  if (!pick.title.trim()) out.push("Thiếu title Shopify.");
  const text = textOf(pick.descriptionHtml);
  if (!text) out.push("Thiếu description Shopify.");
  else if (text.length < MIN_DESCRIPTION) out.push(`Description quá ngắn (${text.length} ký tự chữ, cần ≥ ${MIN_DESCRIPTION}).`);
  if (/<script|\son\w+=|javascript:/i.test(pick.descriptionHtml)) out.push("Description có script / event handler / javascript: — chỉ HTML thường.");
  if (!st.mockups.length) out.push("Sản phẩm chưa có mockup — make_product_mockups trước.");
  else if (!pick.mediaIds.length) out.push("Không có mockup nào được chọn làm ảnh sản phẩm.");
  if (st.templateError) out.push(`Template không dựng được: ${st.templateError}`);
  return out;
}

/** The price table a deploy takes when none is named: the one the product was deployed with, else its material's. */
export function defaultTable(st: DeployState, product: CtProduct): string | null {
  // The base product owns the prices (2026-11-07).
  if (st.base?.config.priceTableId) return st.base.config.priceTableId;
  const linked = product.shopify?.priceTableId;
  if (linked && st.tables.some((t) => t.id === linked)) return linked;
  return priceTableFor(st.tables, product.config?.material?.id ?? "")?.id ?? null;
}

/**
 * The mockups a deploy takes when none are named: the product's ticked ones in its order ("Ảnh sản phẩm", asked
 * 2026-11-19 — all of them, no cap), else the ones already on Shopify, else every scene mockup.
 */
export function defaultMedia(st: DeployState, product: CtProduct): string[] {
  return defaultDeployMedia(st.mockups, effectivePicks(st.mockups, normalizeProductConfig(product.config), product.shopify?.media));
}

const strings = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

/** The deploy fields an agent may write ahead (save_deploy_draft, make_product_from_artwork). */
const DRAFT_PROPS = {
  title: { type: "string", description: "Shopify title (US English), saved ahead: Deploy later uses it." },
  description_html: { type: "string", description: "Shopify description (p, ul/li, strong, h3 only; ≥ 200 characters of text to deploy), saved ahead." },
  tags: { type: "array", items: { type: "string" }, description: "Shopify tags, saved ahead." },
  product_type: { type: "string", description: "Shopify product type (default: the base's)." },
  vendor: { type: "string", description: "Shopify vendor (empty = the shop's)." },
  status: { type: "string", description: "ACTIVE (default) | DRAFT — what Deploy will use." },
  collection_ids: { type: "array", items: { type: "string" }, description: "gid://shopify/Collection/… (check_deploy collections)." },
  primary_collection_id: { type: "string", description: "The breadcrumb collection (one of collection_ids)." },
  customer_note: {
    type: "object",
    description:
      'A text box on the Shopify product page for the customer (NOT printed — for a printed name / text add an editable text layer to the artwork): {"enabled": true, "label": "Gift message" (shown above the box and the order line\'s name for it), "placeholder": "…", "required": true = Add to cart waits until it is filled, "max_chars": 250}. {"enabled": false} = no box. Goes up on the next deploy.',
  },
} as const;

/** Merge the given deploy fields into the product's saved draft (Lưu nháp) and / or its customer note box. */
async function saveDraft(db: CtServiceClient, product: CtProduct, args: Record<string, unknown>): Promise<CtProduct> {
  const cfg = normalizeProductConfig(product.config);
  const old = cfg.deployDraft;
  const given = (k: string) => args[k] !== undefined;
  // Only the customer note given: the draft (and its date — a deployed one must stay old) is left as it is.
  const draftGiven = ["title", "description_html", "tags", "product_type", "vendor", "status", "collection_ids", "primary_collection_id"].some(given);
  const draft = !draftGiven ? old : normalizeDeployDraft({
    title: given("title") ? str(args.title) : (old?.title ?? ""),
    descriptionHtml: given("description_html") ? str(args.description_html) : (old?.descriptionHtml ?? ""),
    tags: given("tags") ? strings(args.tags) : (old?.tags ?? []),
    productType: given("product_type") ? str(args.product_type) : (old?.productType ?? ""),
    vendor: given("vendor") ? str(args.vendor) : (old?.vendor ?? ""),
    status: given("status") ? str(args.status).toUpperCase() : (old?.status ?? "ACTIVE"),
    collectionIds: given("collection_ids") ? strings(args.collection_ids) : (old?.collectionIds ?? []),
    primaryCollectionId: given("primary_collection_id") ? str(args.primary_collection_id) : (old?.primaryCollectionId ?? null),
    savedAt: new Date().toISOString(),
  });
  const n = args.customer_note && typeof args.customer_note === "object" ? (args.customer_note as Record<string, unknown>) : null;
  const customerNote = n ? normalizeCustomerNote({ ...cfg.customerNote, ...n, ...(n.max_chars !== undefined ? { maxChars: Number(n.max_chars) } : {}) }) : cfg.customerNote;
  const config = { ...cfg, deployDraft: draft ?? old, customerNote };
  const { data, error } = await db.from(CT_TABLES.products).update({ config }).eq("id", product.id).select("*").single<CtProduct>();
  if (error || !data) throw new Error(error?.message ?? "Could not save the draft");
  return data;
}

export const CT_MCP_DEPLOY_TOOLS: CtMcpTool[] = [
  {
    name: "shopify_preview_links",
    description:
      "Fresh links to look at deployed products on the store in the draft theme, without deploying again. A DRAFT product only has a temporary preview link that expires after a while (\"link hết hạn\") — this returns the one valid now; a published one has its own page (store, permanent). product_ids = FlexiPrint product ids; none = the most recently deployed products (limit, default 10). → [{product_id, name, shopify status, preview, store, admin}]. A draft cannot be added to the cart — say so when the editor wants to test the cart.",
    inputSchema: {
      type: "object",
      properties: {
        product_ids: { type: "array", items: { type: "string" }, description: "FlexiPrint product ids (default: the latest deployed ones)." },
        limit: { type: "number", description: "How many latest ones when product_ids is empty (1–30, default 10)." },
        task_id: { type: "string", description: "Agent: the task it is for (optional)." },
      },
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const ids = strings(args.product_ids).filter((id) => UUID.test(id));
      const limit = Math.min(30, Math.max(1, Math.round(Number(args.limit) || 10)));
      let q = ctx.db.from(CT_TABLES.products).select("id, name, shopify, store_id").not("shopify", "is", null);
      q = ids.length ? q.in("id", ids) : q.order("updated_at", { ascending: false }).limit(limit);
      const { data, error } = await q.returns<Array<Pick<CtProduct, "id" | "name" | "shopify" | "store_id">>>();
      if (error) throw new Error(error.message);
      const rows = (data ?? []).filter((p) => p.shopify?.productId);
      if (!rows.length) return json({ products: [], note: ids.length ? "Các sản phẩm này chưa deploy lên Shopify." : "Chưa có sản phẩm nào deploy lên Shopify." });
      // Each product on its own store (migration 032).
      const stores = await loadStores(ctx.db);
      const live = new Map<string, Awaited<ReturnType<typeof previewLinks>>[number]>();
      for (const store of stores) {
        const gids = rows.filter((p) => (p.store_id ?? stores[0]?.id) === store.id).map((p) => p.shopify!.productId);
        if (gids.length) for (const x of await previewLinks(store, gids).catch(() => [])) live.set(x.id, x);
      }
      const storeName = (id: string | undefined) => stores.find((x) => x.id === id)?.name ?? id ?? "";
      return json({
        products: rows.map((p) => {
          const x = live.get(p.shopify!.productId);
          return x
            ? { product_id: p.id, name: p.name, shop: storeName(p.store_id), title: x.title, status: x.status, preview: x.previewUrl, store: x.storeUrl, admin: p.shopify!.adminUrl }
            : { product_id: p.id, name: p.name, shop: storeName(p.store_id), error: "Sản phẩm Shopify không còn (đã xoá?) — deploy lại" };
        }),
        note: "preview = link xem thử theme nháp (sản phẩm DRAFT: hết hạn sau một thời gian — gọi lại để lấy link đang dùng được; không thêm vào giỏ được). store = trang cố định khi sản phẩm ACTIVE + bật Online Store.",
      });
    },
  },
  {
    name: "check_deploy",
    description:
      "Before deploying a product to Shopify: what the deploy would use and what blocks it. → shopify (configured, the linked Shopify product now: title, description, url), priceTables (id, name, sizes / packs with prices, problems; default = linked or newest), template (builds? the customer fields the product page asks, warnings), mockups (id, url — the product's images), collections, lastContent (the title + description a content task wrote, if any), missing (Vietnamese: every blocker with defaults). Fill what is missing yourself, then deploy_product.",
    inputSchema: {
      type: "object",
      properties: { ...OPT_TASK_ARG, product_id: { type: "string", description: "The FlexiPrint product (char_status gives the set's product id)." } },
      required: ["product_id"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const { db, s, product } = await openProduct(ctx, args);
      const st = await deployState(db, s, product);
      const collections = await listCollections(await storeOfProduct(db, product)).catch((): CtShopifyCollection[] => []);
      const linked = st.info.product;
      const tableId = defaultTable(st, product);
      const draft = liveDraft(product);
      const title = draft?.title || linked?.title || st.content?.title || "";
      const descriptionHtml = draft?.descriptionHtml || linked?.descriptionHtml || st.content?.descriptionHtml || "";
      const fit = suggestCollections(collections, { title: title || product.name, description: descriptionHtml });
      return json({
        product: { id: product.id, name: product.name, status: product.status, publishedVersion: product.published_version },
        shopify: {
          configured: st.info.configured,
          shop: st.info.shop?.domain ?? null,
          error: st.info.error,
          linked: product.shopify ? { productId: product.shopify.productId, status: product.shopify.status, url: product.shopify.url, adminUrl: product.shopify.adminUrl, deployedAt: product.shopify.deployedAt } : null,
          now: linked ? { title: linked.title, descriptionHtml: linked.descriptionHtml, status: linked.status, tags: linked.tags, productType: linked.productType, vendor: linked.vendor, collectionIds: linked.collectionIds } : null,
        },
        priceTables: st.tables.map((t) => ({
          id: t.id,
          name: t.name,
          default: t.id === tableId,
          cells: priceCells(t.config).map((c) => [c.size?.label, c.pack?.label, `${c.price}`].filter(Boolean).join(" · ")),
          problems: priceTableProblems(t.config),
        })),
        template: st.templateError
          ? { ok: false, error: st.templateError }
          : { ok: true, versions: st.audit?.versions ?? [], lines: (st.audit?.lines ?? []).filter((l) => l.level !== "ok") },
        mockups: st.mockups.map((a) => ({ id: a.id, url: a.url, default: defaultMedia(st, product).includes(a.id) })),
        collections: collections.map((c) => ({ id: c.id, title: c.title, smart: c.smart, rules: c.smart ? c.rules.map((r) => `${r.column} ${r.relation} ${r.condition}`) : undefined, suggested: fit.some((x) => x.id === c.id) })),
        lastContent: st.content ? { title: st.content.title, descriptionHtml: st.content.descriptionHtml } : null,
        draft: draft ? { ...draft, note: "Saved ahead (save_deploy_draft / the Deploy page's Lưu nháp): deploy_product uses it for what you leave out." } : null,
        customerNote: normalizeProductConfig(product.config).customerNote,
        missing: blockers(st, { kind: product.kind ?? "artwork", tableId, title, descriptionHtml, mediaIds: defaultMedia(st, product) }),
        next: "Fill what is missing (title + description_html in US English per the content rules; a price table that fits — never create one, the editor keeps them; make_product_mockups when there is none), then deploy_product. Collections: reuse the store's — the suggested ones fit the title; a smart (rule-based) one is joined through its rules (the deploy adds the tag / type), so pick it like any other. Never create a collection when one fits.",
      });
    },
  },
  {
    name: "list_base_products",
    description:
      "Product bases (like Teeinblue): the blank products sold — they OWN the physical piece: print area (= the canvas of an artwork made for it), khuôn in (fixed shape) or cut along the design (cut.mode khuon | alpha | none, border mm, silhouette, hanging hole), the preview photo / phôi (preview), material, Shopify product type, the price table (variants sizes × packs with prices), how many products use each. An artwork is only the design; a product (what is sold) = an artwork + one of these.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG }, required: [] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const { db } = await actorOf(ctx, args.task_id);
      const bases = await listBaseRows(db);
      return json({
        bases: bases.map((b) => ({
          id: b.id,
          name: b.name,
          material: b.config.material,
          productType: b.config.productType,
          image: b.config.image,
          khuon: b.template ? { id: b.template.id, name: b.template.name, width: b.template.width, height: b.template.height, phoi: b.template.blankUrl } : null,
          printAreas: b.config.printAreas,
          cut: b.config.cut,
          preview: b.config.preview.url ? { url: b.config.preview.url, kind: b.config.cut.mode === "alpha" ? "background (AI phôi per version: make_version_phoi)" : "phôi photo" } : null,
          variants: b.priceTable ? priceCells(b.priceTable.config).map((c) => ({ size: c.size?.label ?? "", pack: c.pack?.label ?? "", price: c.price, compareAt: c.compareAt })) : [],
          priceTable: b.priceTable?.name ?? null,
          products: b.products,
          mockupPrompt: { scenes: b.config.mockup.scenes.trim() ? splitScenes(b.config.mockup.scenes).scenes.length : 0, wrap: !!b.config.mockup.wrap.trim(), refs: b.config.mockup.refs.length, sizeCharts: b.config.mockup.sizeCharts.length },
        })),
      });
    },
  },
  {
    name: "make_product_from_artwork",
    description:
      "A product (what is sold) from a finished artwork on a product base: the product holds a snapshot of the artwork's DESIGN (layers, options, versions, texts — later artwork edits never change it; the editor updates it by hand) and the base lays its khuôn / cut / silhouette / phôi on it and gives variants + prices + product type. The same artwork can make products on several bases. Its name starts as the artwork's (the theme), or `name`. → product_id, editor link. Then make_product_mockups / wait_product_mockups, then check_deploy / deploy_product on THIS product id (never on the artwork).",
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        artwork_id: { type: "string", description: "The artwork (a set's product id, an import's, render_artwork's)." },
        base_product_id: { type: "string", description: "From list_base_products — the one of the artwork's material / khuôn." },
        name: { type: "string", description: "Product title (theme), default = the artwork's name." },
        mockup_blocks: { type: "array", items: { type: "object" }, description: `Optional: this product's own mockup prompts, one photo each, pictures per prompt: [{"prompt": "<English scene>", "refs": ["<https url>", …]}] — a block's refs (max ${CT_MOCKUP_BLOCK_REFS_MAX}) go with that prompt only (picture 2, 3… after the front picture); no refs = the base's. Wins over mockup_scenes.` },
        mockup_scenes: { type: "string", description: "Optional, older form of mockup_blocks: this product's own scene prompts as one text (English; one per line, or split by an empty line / ---), no pictures of their own." },
        ...DRAFT_PROPS,
      },
      required: ["artwork_id", "base_product_id"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const { db, task, userId, s } = await openActor(ctx, args);
      const id = str(args.artwork_id);
      if (!UUID.test(id)) throw new Error("artwork_id is not a valid id");
      const artwork = await ownedProduct(s, id);
      if (!artwork) throw new Error("No such artwork, or the task's user may not edit it");
      const base = await loadBaseProduct(db, str(args.base_product_id));
      if (!base) throw new Error("No such product base — list_base_products");
      if (args.mockup_refs !== undefined) throw new Error("mockup_refs is gone (2026-11-23): reference pictures are per prompt now — mockup_blocks [{prompt, refs}]");
      const badBlocks = badBlockRefs(args.mockup_blocks);
      if (badBlocks) throw new Error(`mockup_blocks: ${badBlocks}`);
      let product = await makeProductFromArtwork(db, userId, artwork, base, str(args.name) || undefined);
      product = await saveOwnMockupPrompt(db, product, {
        blocks: Array.isArray(args.mockup_blocks) && args.mockup_blocks.length ? args.mockup_blocks : undefined,
        scenes: typeof args.mockup_scenes === "string" && args.mockup_scenes.trim() ? args.mockup_scenes : undefined,
      });
      if (str(args.title) || str(args.description_html) || args.customer_note) product = await saveDraft(db, product, args);
      await progress(db, task?.id, `Đã tạo sản phẩm “${product.name}” từ artwork “${artwork.name}” trên ${base.name}`);
      return json({ product_id: product.id, editor: `${siteUrl()}${CT_CONFIG.basePath}/${product.id}`, next: "make_product_mockups on product_id, then check_deploy / deploy_product." });
    },
  },
  {
    name: "get_base_mockup_prompt",
    description:
      'The AI mockup prompts of a PRODUCT BASE, used by every product made on it that has none of its own: scenes (one photo each), wrap = THE WHOLE PROMPT sent to the image model for each scene ({product} = piece name, {scene} = one scene — nothing else is added by the server), refs = reference pictures sent after the product\'s front picture (picture 1; refs are pictures 2..). Empty wrap = each scene is sent alone as the whole prompt ({product} filled) — for bases whose products each carry their own full prompts. A wrap without {scene}, or no scene (here and on the product) → making mockups is refused. sampleWrap / sampleScenes are only samples to start a new text from, never used by themselves. canEdit = you may change them with set_base_mockup_prompt (the base\'s maker or an admin).',
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, base_product_id: { type: "string", description: "From list_base_products." } }, required: ["base_product_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const { db } = await actorOf(ctx, args.task_id);
      const base = (await listBaseRows(db)).find((b) => b.id === str(args.base_product_id));
      if (!base) throw new Error("No such product base — list_base_products");
      const m = base.config.mockup;
      // As the server decides it for a product on this base (server/product-mockups.ts productMockups).
      const fromPhoi = !!base.config.preview.url || (!!base.template?.blankUrl && base.config.cut.mode !== "alpha");
      return json({
        base: { id: base.id, name: base.name },
        scenes: m.scenes,
        sceneList: m.scenes.trim() ? splitScenes(m.scenes).scenes : [],
        sampleScenes: defaultScenes(base.name),
        wrap: m.wrap,
        sampleWrap: defaultMockupWrap({ piece: base.template?.name || base.name, materialId: base.config.material, dieCut: base.config.cut.mode === "alpha", fromPhoi }),
        refs: m.refs,
        sizeCharts: m.sizeCharts,
        canEdit: ctx.caller === "agent" || ctx.admin || (!!ctx.userId && base.user_id === ctx.userId),
      });
    },
  },
  {
    name: "set_base_mockup_prompt",
    description:
      'Change a PRODUCT BASE\'s AI mockup prompts (only its maker or an admin). Give only what changes: scenes (English, one per line or split by an empty line / ---, no limit on count or length; "" = none — products without scenes of their own then fail), wrap (the whole prompt per scene, must hold {scene}; "" = none — each scene is then sent alone as the whole prompt), refs (https urls, max 4 — the whole new list; [] = none). Products with prompts of their own keep theirs. One product\'s own prompts go with make_product_mockups save_scenes / save_refs instead.',
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        base_product_id: { type: "string", description: "From list_base_products." },
        scenes: { type: "string", description: "The scene prompts." },
        wrap: { type: "string", description: "The sentence around each scene." },
        refs: { type: "array", items: { type: "string" }, description: "Reference picture urls." },
        size_charts: { type: "array", items: { type: "string" }, description: "Size chart pictures (https, max 4, the whole new list): not sent to the AI, added after the mockups on every deploy of a product on this base." },
      },
      required: ["base_product_id"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const { db } = await actorOf(ctx, args.task_id);
      const id = str(args.base_product_id);
      if (!UUID.test(id)) throw new Error("base_product_id is not a valid id");
      const { data: row } = await db.from(CT_TABLES.baseProducts).select("user_id, name, config").eq("id", id).maybeSingle<{ user_id: string | null; name: string; config: Record<string, unknown> | null }>();
      if (!row) throw new Error("No such product base — list_base_products");
      if (ctx.caller === "user" && !ctx.admin && row.user_id !== ctx.userId) throw new Error("Only the base's maker or an admin may change its mockup prompts");
      const m = normalizeBaseMockup(row.config?.mockup);
      if (typeof args.scenes === "string") {
        m.scenes = args.scenes;
      }
      if (typeof args.wrap === "string") m.wrap = args.wrap;
      if (Array.isArray(args.refs)) {
        const refs = mockupRefList(args.refs);
        if (args.refs.length > refs.length) throw new Error(`refs: https urls only, at most ${CT_MOCKUP_REFS_MAX}, no repeats`);
        m.refs = refs;
      }
      if (Array.isArray(args.size_charts)) {
        const charts = mockupRefList(args.size_charts);
        if (args.size_charts.length > charts.length) throw new Error(`size_charts: https urls only, at most ${CT_MOCKUP_REFS_MAX}, no repeats`);
        m.sizeCharts = charts;
      }
      // Read fresh: only the mockup key changes (the base page's other fields stay).
      const { error } = await db.from(CT_TABLES.baseProducts).update({ config: { ...(row.config ?? {}), mockup: m } }).eq("id", id);
      if (error) throw new Error(error.message);
      return json({ ok: true, base: { id, name: row.name }, mockup: m, note: "Used by the next mockups of every product on this base that has no prompts of its own." });
    },
  },
  {
    name: "create_base_product",
    description:
      "A NEW product base (you become its maker) — only for a kind of product that has no base yet (list_base_products first); to change or fix an existing base use update_base_product, never a new one: what is sold and how — name, Shopify product type, description, material, the print area (= the canvas of artworks made for it, px), the price table (variants: sizes × packs with prices — e.g. two kinds of blanket as two \"sizes\" with size_label \"Blanket type\"), and the mockup prompts (scenes, wrap, refs = reference pictures for the AI, size_charts = pictures added after the mockups on every deploy). No khuôn in (a fixed shape) is needed for a product that is not cut to a shape: no_khuon defaults to true without template_id. Pictures on this machine → flexiprint_upload_image first. → base_product_id, price_table_id, its page. Then create_artwork_product {base_product_id} per idea → make_product_from_artwork → make_product_mockups → deploy_product.",
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        name: { type: "string", description: "The base's name (the kind of product)." },
        image_url: { type: "string", description: "REQUIRED: the base's own fixed picture (https; a file on this machine → flexiprint_upload_image first). Shown on the base's card and picker; product mockups never replace it." },
        product_type: { type: "string", description: "Shopify product type (the store's collections key on it)." },
        description: { type: "string", description: "Product page description until a product's own replaces it (HTML ok)." },
        material: { type: "string", description: "none | acrylic_white | acrylic_clear | glass_clear | ceramic_gloss | ceramic_matte | aluminum | wood (default none)." },
        print_area: { type: "object", description: "{width, height, dpi?, name?} px — the artwork canvas (default 1000×1000)." },
        template_id: { type: "string", description: "Optional khuôn in (list_print_templates) — only for a piece cut to a fixed shape." },
        no_khuon: { type: "boolean", description: "Needs no khuôn (default true when no template_id)." },
        price_table_id: { type: "string", description: "An existing price table, instead of price_table." },
        price_table: { type: "object", description: '{size_label?: "Size", sizes: [{label, price, compare_at?}], pack_label?, packs?: [{qty, label?, discount_pct}]} — no packs = one piece only.' },
        mockup: { type: "object", description: "{scenes?: string, wrap?: string, refs?: [urls ≤ 4], size_charts?: [urls ≤ 4]}" },
      },
      required: ["name", "image_url"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const { db, userId } = await actorOf(ctx, args.task_id);
      const name = str(args.name).slice(0, 160);
      if (!name) throw new Error("name is needed");
      const image = baseImage(args.image_url);
      if (!image) throw new Error("image_url is needed — the base's own picture (https; a file on this machine → flexiprint_upload_image first)");
      const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
      const list = (v: unknown) => (Array.isArray(v) ? v.map(obj).filter((x): x is Record<string, unknown> => !!x) : []);
      let priceTableId = str(args.price_table_id) || null;
      if (priceTableId && !UUID.test(priceTableId)) throw new Error("price_table_id is not a valid id");
      const pt = obj(args.price_table);
      if (pt) {
        const packs = list(pt.packs);
        const cfg = normalizePriceTableConfig({
          sizeLabel: pt.size_label,
          packLabel: pt.pack_label,
          itemLabel: pt.item_label,
          sizes: list(pt.sizes).map((x) => ({ label: x.label, price: x.price, compareAt: x.compare_at ?? null })),
          packs: packs.length ? packs.map((x) => ({ qty: x.qty, label: x.label, discountPct: x.discount_pct })) : [{ qty: 1, label: "1 PC", discountPct: 0 }],
          overrides: {},
        });
        const problems = priceTableProblems(cfg);
        if (problems.length) throw new Error(`price_table: ${problems.join(" ")}`);
        const { data, error } = await db.from(CT_TABLES.priceTables).insert({ user_id: userId, name: name.slice(0, 120), config: cfg }).select("id").single<{ id: string }>();
        if (error || !data) throw new Error(error?.message ?? "Price table not saved");
        priceTableId = data.id;
      }
      const mk = obj(args.mockup) ?? {};
      const mockup = normalizeBaseMockup({ scenes: mk.scenes, wrap: mk.wrap, refs: mk.refs, sizeCharts: mk.size_charts });
      const area = obj(args.print_area);
      const templateId = str(args.template_id) || null;
      const config = normalizeBaseConfig({
        description: args.description,
        productType: args.product_type,
        material: args.material,
        priceTableId,
        templateId,
        noKhuon: typeof args.no_khuon === "boolean" ? args.no_khuon : !templateId,
        printAreas: area ? [{ name: area.name, width: area.width, height: area.height, dpi: area.dpi }] : [],
        mockup,
        image,
      });
      const { data: base, error } = await db.from(CT_TABLES.baseProducts).insert({ user_id: userId, name, config }).select("id").single<{ id: string }>();
      if (error || !base) throw new Error(error?.message ?? "Base not saved");
      return json({ base_product_id: base.id, price_table_id: priceTableId, page: `${siteUrl()}/base-products/${base.id}`, next: "create_artwork_product {base_product_id, layers} per idea (a finished picture: a clipart layer with image_url), then make_product_from_artwork → make_product_mockups → deploy_product." });
    },
  },
  {
    name: "update_base_product",
    description:
      "Change an EXISTING product base in place (only its maker or an admin) — the way to fix or change a base; never create_base_product again for a change. Give only what changes: name, product_type, description, material, print_area, template_id ('' = no khuôn), price_table (edits the base's own table in place; a table other bases share is copied first) or price_table_id (switch to another table), mockup {scenes?, wrap?, refs?, size_charts?} (only the keys given). Every product on the base is laid on it again. → the base as list_base_products shows it.",
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        base_product_id: { type: "string", description: "From list_base_products." },
        name: { type: "string", description: "New name." },
        product_type: { type: "string", description: "Shopify product type." },
        description: { type: "string", description: "Product page description (HTML ok)." },
        material: { type: "string", description: "none | acrylic_white | acrylic_clear | glass_clear | ceramic_gloss | ceramic_matte | aluminum | wood." },
        print_area: { type: "object", description: "{width, height, dpi?, name?} px — replaces the first print area (its id is kept)." },
        template_id: { type: "string", description: "Khuôn in (list_print_templates); '' = none." },
        price_table_id: { type: "string", description: "Switch to this existing price table." },
        price_table: { type: "object", description: 'The whole new table: {size_label?, sizes: [{label, price, compare_at?}], pack_label?, packs?: [{qty, label?, discount_pct}]}.' },
        mockup: { type: "object", description: "{scenes?, wrap?, refs?: [urls ≤ 4], size_charts?: [urls ≤ 4]} — only the keys given change." },
        image_url: { type: "string", description: "A new fixed picture for the base (https; a file on this machine → flexiprint_upload_image first)." },
      },
      required: ["base_product_id"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const { db, userId } = await actorOf(ctx, args.task_id);
      const id = str(args.base_product_id);
      if (!UUID.test(id)) throw new Error("base_product_id is not a valid id");
      const { data: row } = await db.from(CT_TABLES.baseProducts).select("user_id, name, config").eq("id", id).maybeSingle<{ user_id: string | null; name: string; config: Record<string, unknown> | null }>();
      if (!row) throw new Error("No such product base — list_base_products");
      if (ctx.caller === "user" && !ctx.admin && row.user_id !== ctx.userId) throw new Error("Only the base's maker or an admin may change it");
      const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
      const list = (v: unknown) => (Array.isArray(v) ? v.map(obj).filter((x): x is Record<string, unknown> => !!x) : []);
      const now = normalizeBaseConfig(row.config);
      const raw: Record<string, unknown> = { ...(row.config ?? {}) };
      const changed: string[] = [];
      const name = typeof args.name === "string" && args.name.trim() ? args.name.trim().slice(0, 160) : row.name;
      if (name !== row.name) changed.push("name");
      if (typeof args.product_type === "string") { raw.productType = args.product_type; changed.push("product_type"); }
      if (typeof args.description === "string") { raw.description = args.description; changed.push("description"); }
      if (typeof args.image_url === "string") {
        const image = baseImage(args.image_url);
        if (!image) throw new Error("image_url: an https picture url");
        raw.image = image;
        changed.push("image");
      }
      if (typeof args.material === "string") { raw.material = args.material; changed.push("material"); }
      if (typeof args.template_id === "string") {
        const t = args.template_id.trim();
        if (t && !UUID.test(t)) throw new Error("template_id is not a valid id");
        raw.templateId = t || null;
        raw.noKhuon = !t;
        changed.push("template_id");
      }
      const area = obj(args.print_area);
      if (area) {
        const first = now.printAreas[0];
        raw.printAreas = [{ id: first?.id, name: area.name ?? first?.name, width: area.width, height: area.height, dpi: area.dpi ?? first?.dpi }, ...now.printAreas.slice(1)];
        changed.push("print_area");
      }
      const pid = str(args.price_table_id);
      if (pid) {
        if (!UUID.test(pid)) throw new Error("price_table_id is not a valid id");
        raw.priceTableId = pid;
        changed.push("price_table_id");
      }
      let priceTableId = (raw.priceTableId as string | null | undefined) ?? now.priceTableId;
      const pt = obj(args.price_table);
      if (pt) {
        const packs = list(pt.packs);
        const cfg = normalizePriceTableConfig({
          sizeLabel: pt.size_label,
          packLabel: pt.pack_label,
          itemLabel: pt.item_label,
          sizes: list(pt.sizes).map((x) => ({ label: x.label, price: x.price, compareAt: x.compare_at ?? null })),
          packs: packs.length ? packs.map((x) => ({ qty: x.qty, label: x.label, discountPct: x.discount_pct })) : [{ qty: 1, label: "1 PC", discountPct: 0 }],
          overrides: {},
        });
        const problems = priceTableProblems(cfg);
        if (problems.length) throw new Error(`price_table: ${problems.join(" ")}`);
        // Edit the base's own table in place; one other bases also use is copied, so they keep their prices.
        let shared = true;
        if (priceTableId) {
          const { data: users } = await db.from(CT_TABLES.baseProducts).select("id").eq("config->>priceTableId", priceTableId).returns<Array<{ id: string }>>();
          shared = (users ?? []).some((u) => u.id !== id);
        }
        if (priceTableId && !shared) {
          const { error } = await db.from(CT_TABLES.priceTables).update({ config: cfg }).eq("id", priceTableId);
          if (error) throw new Error(error.message);
        } else {
          const { data, error } = await db.from(CT_TABLES.priceTables).insert({ user_id: userId, name: name.slice(0, 120), config: cfg }).select("id").single<{ id: string }>();
          if (error || !data) throw new Error(error?.message ?? "Price table not saved");
          priceTableId = data.id;
        }
        raw.priceTableId = priceTableId;
        changed.push("price_table");
      }
      const mk = obj(args.mockup);
      if (mk) {
        const m = { ...now.mockup };
        if (typeof mk.scenes === "string") m.scenes = mk.scenes;
        if (typeof mk.wrap === "string") m.wrap = mk.wrap;
        if (Array.isArray(mk.refs)) {
          const refs = mockupRefList(mk.refs);
          if (mk.refs.length > refs.length) throw new Error(`mockup.refs: https urls only, at most ${CT_MOCKUP_REFS_MAX}, no repeats`);
          m.refs = refs;
        }
        if (Array.isArray(mk.size_charts)) {
          const charts = mockupRefList(mk.size_charts);
          if (mk.size_charts.length > charts.length) throw new Error(`mockup.size_charts: https urls only, at most ${CT_MOCKUP_REFS_MAX}, no repeats`);
          m.sizeCharts = charts;
        }
        raw.mockup = m;
        changed.push("mockup");
      }
      if (!changed.length) throw new Error("Nothing to change — give at least one field");
      const config = normalizeBaseConfig(raw);
      const { error } = await db.from(CT_TABLES.baseProducts).update({ name, config }).eq("id", id);
      if (error) throw new Error(error.message);
      // As the base page's save (server/base-products.ts updateBaseProduct): every product on it is laid on it again.
      const { data: products } = await db.from(CT_TABLES.products).select("*").eq("base_product_id", id).eq("kind", "product").returns<CtProduct[]>();
      const failed: string[] = [];
      for (const p of products ?? []) await applyBase(db, p).catch((e: Error) => failed.push(`${p.name}: ${e.message}`));
      return json({ ok: true, base_product_id: id, name, changed, price_table_id: priceTableId, reapplied: (products ?? []).length - failed.length, failed, page: `${siteUrl()}/base-products/${id}` });
    },
  },
  {
    name: "set_artwork_base",
    description:
      "The base an ARTWORK is viewed on (the editor's \"Xem trên base\"): render_artwork / check_artwork then draw and check it on that base's khuôn + safe zone, the AI phôi (make_version_phoi) are made for it. Changes nothing in the design; products keep their own base. base_product_id empty = none.",
    inputSchema: {
      type: "object",
      properties: { ...OPT_TASK_ARG, artwork_id: { type: "string", description: "The artwork." }, base_product_id: { type: "string", description: "From list_base_products ('' = none)." } },
      required: ["artwork_id"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const { db, task, userId, s } = await openActor(ctx, args);
      const artwork = await ownedProduct(s, str(args.artwork_id));
      if (!artwork) throw new Error("No such artwork, or the task's user may not edit it");
      if (artwork.kind === "product") throw new Error("That is a product — its base is set on the product page (make_product_from_artwork picks it)");
      const baseId = str(args.base_product_id);
      const base = baseId ? await loadBaseProduct(db, baseId) : null;
      if (baseId && !base) throw new Error("No such product base — list_base_products");
      const { error } = await db.from(CT_TABLES.products).update({ base_product_id: base?.id ?? null }).eq("id", artwork.id);
      if (error) throw new Error(error.message);
      return json({ artwork_id: artwork.id, base: base ? { id: base.id, name: base.name, cut: base.config.cut.mode } : null, next: base?.config.cut.mode === "alpha" ? "render_artwork; make_version_phoi for the customer's preview." : "render_artwork." });
    },
  },
  {
    name: "make_version_phoi",
    description:
      "The customer's preview photo of every version of an ARTWORK on a cut-to-shape base (acrylic): the version's fixed parts made into the real piece by the AI on the base's background (Teeinblue's hand-drawn \"Preview scene N\"); the customer's picks / texts are laid on it live. Preview only — the print file never uses it. Versions that already have one (an import folder's own preview, or drawn before) are LEFT ALONE; redo = draw again the named version_ids (or all AI ones). Runs in the background (~2 min each, in parallel) → per version: have | running | started | failed. Then version_phoi_status. Products made from the artwork get them by themselves. A khuôn base (ceramic, glass) needs none: its phôi is the khuôn's.",
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        artwork_id: { type: "string", description: "The artwork." },
        base_product_id: { type: "string", description: "Default: the artwork's base (set_artwork_base)." },
        version_ids: { type: "array", items: { type: "string" }, description: "Only these versions (main asset ids from version_phoi_status)." },
        redo: { type: "boolean", description: "Draw again even when they have one." },
      },
      required: ["artwork_id"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const { db, task, userId, s } = await openActor(ctx, args);
      const artwork = await ownedProduct(s, str(args.artwork_id));
      if (!artwork) throw new Error("No such artwork, or the task's user may not edit it");
      if (artwork.kind === "product") throw new Error("Phôi are made on the ARTWORK (its products take them): pass the artwork id (config.artworkLink of the product)");
      const base = await loadBaseProduct(db, str(args.base_product_id) || artwork.base_product_id || "");
      if (!base) throw new Error("The artwork has no base — set_artwork_base or pass base_product_id");
      const ids = Array.isArray(args.version_ids) ? args.version_ids.map(str).filter(Boolean) : [];
      const versions = await ensureVersionPhoi(db, userId, artwork.id, base, { redo: args.redo === true, mainIds: ids });
      await progress(db, task?.id, `Phôi preview “${artwork.name}” trên ${base.name}: ${versions.filter((v) => v.status === "started").length} version gửi AI, ${versions.filter((v) => v.status === "have").length} đã có`);
      return json({ artwork_id: artwork.id, base: base.name, versions, next: "version_phoi_status after ~2 min; view_image the urls." });
    },
  },
  {
    name: "version_phoi_status",
    description: "The preview photos (phôi) of an artwork's versions per base: url, source (ai | folder = the import folder's own), and the AI jobs (running / failed with error).",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, artwork_id: { type: "string", description: "The artwork." } }, required: ["artwork_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const { db, task, userId, s } = await openActor(ctx, args);
      const artwork = await ownedProduct(s, str(args.artwork_id));
      if (!artwork) throw new Error("No such artwork, or the task's user may not edit it");
      const { data: mains } = await db.from(CT_TABLES.assets).select("id,name").eq("product_id", artwork.id).eq("role", "main").order("sort_order").returns<Array<{ id: string; name: string }>>();
      const { data: jobs } = await db.from(CT_TABLES.packImages).select("description,status,error,created_at").eq("name", jobName(artwork.id)).order("created_at", { ascending: false }).limit(60).returns<Array<{ description: string; status: string; error: string | null; created_at: string }>>();
      const phoi = normalizeProductConfig(artwork.config).versionPhoi;
      return json({
        artwork_id: artwork.id,
        versions: (mains ?? []).map((m) => {
          const job = (jobs ?? []).find((j) => j.description === m.id);
          return { version_id: m.id, name: m.name, phoi: phoi.filter((p) => p.mainId === m.id).map((p) => ({ base_id: p.baseId, url: p.url, source: p.source ?? "ai", at: p.at })), job: job ? { status: job.status, error: job.error || undefined, at: job.created_at } : null };
        }),
      });
    },
  },
  {
    name: "list_artwork_products",
    description: "The products (what is sold) made from an artwork: id, name, base, whether it still holds the artwork's latest design (\"Có bản artwork mới\" = outdated), Shopify link.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, artwork_id: { type: "string", description: "The artwork." } }, required: ["artwork_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const { db, s } = await openActor(ctx, args);
      const id = str(args.artwork_id);
      if (!UUID.test(id)) throw new Error("artwork_id is not a valid id");
      const art = await ownedProduct(s, id);
      if (!art) throw new Error("No such artwork, or you may not edit it");
      const revision = normalizeProductConfig(art.config).artworkRevision;
      const { data } = await db.from(CT_TABLES.products).select("id,name,base_product_id,config,shopify").eq("kind", "product").eq("config->artworkLink->>artworkId", id).order("created_at").returns<Array<Pick<CtProduct, "id" | "name" | "base_product_id" | "config" | "shopify">>>();
      const bases = new Map((await listBaseRows(db)).map((b) => [b.id, b.name]));
      return json({
        products: (data ?? []).map((p) => {
          const link = normalizeProductConfig(p.config).artworkLink;
          return { product_id: p.id, name: p.name, base: p.base_product_id ? (bases.get(p.base_product_id) ?? p.base_product_id) : null, outdated: !!link && link.revision < revision, shopify: p.shopify ? { handle: p.shopify.handle, status: p.shopify.status } : null, editor: `${siteUrl()}${CT_CONFIG.basePath}/${p.id}` };
        }),
      });
    },
  },
  {
    name: "sync_product_from_artwork",
    description:
      "Update a product to its artwork's latest design in place — the editor's «cập nhật theo artwork» button (asked 2026-11-19): layers, options and versions are copied again; the product keeps its id, name, base, price table, mockups and Shopify link. Use it when list_artwork_products says outdated, instead of making a new product. Old mockups still show the old design → make_product_mockups again, then deploy_product to push it to Shopify. → the product's new revision.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, product_id: { type: "string", description: "The product (from list_artwork_products)." } }, required: ["product_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const { db, s } = await openActor(ctx, args);
      const id = str(args.product_id);
      if (!UUID.test(id)) throw new Error("product_id is not a valid id");
      const product = await ownedProduct(s, id);
      if (!product) throw new Error("No such product, or you may not edit it");
      const link = normalizeProductConfig(product.config).artworkLink;
      if (!link) throw new Error("This product was not made from an artwork");
      const artwork = await ownedProduct(s, link.artworkId);
      if (!artwork) throw new Error("Its artwork is gone, or you may not edit it");
      const before = link.revision;
      const saved = await resyncProduct(db, artwork, product);
      const after = normalizeProductConfig(saved.config).artworkLink?.revision ?? before;
      return json({ product_id: saved.id, name: saved.name, artwork: artwork.name, revision_before: before, revision_now: after, next: "make_product_mockups (the old mockups show the old design), then deploy_product", editor: `${siteUrl()}${CT_CONFIG.basePath}/${saved.id}` });
    },
  },
  {
    name: "save_deploy_draft",
    description:
      "Write a product's Deploy fields AHEAD — the Deploy page's Lưu nháp (asked 2026-11-20): title, description, tags, type, vendor, status, collections, and the customer note box. Give only what changes (the rest of the draft stays). The Deploy page opens filled with it and deploy_product / the product list's bulk Deploy use it, so once the mockups are made the editor only presses Deploy. Kept until the next deploy (after that the Shopify product's text wins). Nothing goes to Shopify now. → the saved draft.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, product_id: { type: "string", description: "The FlexiPrint product (kind product)." }, ...DRAFT_PROPS }, required: ["product_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const { db, task, product } = await openProduct(ctx, args);
      if ((product.kind ?? "artwork") !== "product") throw new Error("That is an artwork — make_product_from_artwork, then save the draft on the product");
      const saved = await saveDraft(db, product, args);
      const cfg = normalizeProductConfig(saved.config);
      await progress(db, task?.id, `Đã lưu nháp deploy cho “${saved.name}”`);
      return json({ product_id: saved.id, draft: cfg.deployDraft, customerNote: cfg.customerNote, deploy_page: `${siteUrl()}${CT_CONFIG.basePath}/${saved.id}/deploy`, next: "make_product_mockups if it has none, then deploy_product {product_id} (the draft fills the rest) — ask the user before ACTIVE." });
    },
  },
  {
    name: "deploy_product",
    description:
      "Deploy a product to Shopify — the editor's Deploy button: publishes the storefront template, then creates (or updates, keeping its variants) the Shopify product with the price table's variants, the title / description, and mockups as images. Refuses with the list of blockers (title, description_html ≥ 200 chars of text, a valid price table, ≥ 1 mockup, the template builds, Shopify configured). status ACTIVE (default, on sale at once) | DRAFT. → the Shopify link (store url, admin url), preview url, warnings, template version.",
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        product_id: { type: "string", description: "The FlexiPrint product." },
        title: { type: "string", description: "Shopify title (US English). Default: the draft saved ahead (check_deploy draft)." },
        description_html: { type: "string", description: "Shopify description: p, ul/li, strong, h3 only. Default: the draft saved ahead." },
        price_table_id: { type: "string", description: "A price table from check_deploy (default: the linked one, else the newest)." },
        status: { type: "string", description: "ACTIVE (default, on sale at once) | DRAFT." },
        tags: { type: "array", items: { type: "string" }, description: "Shopify tags." },
        product_type: { type: "string", description: "Shopify product type (e.g. Christmas Ornament)." },
        vendor: { type: "string", description: "Shopify vendor (empty = the shop's default)." },
        media_asset_ids: { type: "array", items: { type: "string" }, description: "Mockup ids, in order (default: the product's ticked mockups in its order — set in the editor's Ảnh sản phẩm — else those on Shopify, else all scene mockups). Ids not in the list are taken off Shopify." },
        collection_ids: { type: "array", items: { type: "string" }, description: "gid://shopify/Collection/… from check_deploy, smart ones too (default: the ones that fit the title)." },
        primary_collection_id: { type: "string", description: "The breadcrumb collection (one of collection_ids)." },
        customer_note: { ...DRAFT_PROPS.customer_note, description: `${DRAFT_PROPS.customer_note.description.replace(" Goes up on the next deploy.", "")} Default: the product's (check_deploy customerNote).` },
      },
      required: ["product_id"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const opened = await openProduct(ctx, args);
      const { db, task, s } = opened;
      // A customer note box given here is kept on the product (like the Deploy page's tick), then deployed with it.
      const product = args.customer_note && typeof args.customer_note === "object" ? await saveDraft(db, opened.product, { customer_note: args.customer_note }) : opened.product;
      const st = await deployState(db, s, product);
      // What the agent leaves out comes from the draft saved ahead (save_deploy_draft / Lưu nháp).
      const draft = liveDraft(product);
      if (draft) {
        args = {
          ...args,
          title: str(args.title) || draft.title,
          description_html: str(args.description_html) || draft.descriptionHtml,
          status: str(args.status) || draft.status,
          tags: strings(args.tags).length ? args.tags : draft.tags,
          product_type: str(args.product_type) || draft.productType,
          vendor: str(args.vendor) || draft.vendor,
          collection_ids: strings(args.collection_ids).length ? args.collection_ids : draft.collectionIds,
          primary_collection_id: str(args.primary_collection_id) || draft.primaryCollectionId || "",
        };
      }
      // Already on Shopify and no draft: what it has there now (as check_deploy shows) — a deploy again with only
      // product_id (e.g. to turn the customer note off) keeps its text instead of being refused for a missing title.
      const linked = st.info.product;
      if (linked) {
        args = {
          ...args,
          title: str(args.title) || linked.title,
          description_html: str(args.description_html) || linked.descriptionHtml,
          status: str(args.status) || linked.status,
          tags: strings(args.tags).length ? args.tags : linked.tags,
          product_type: str(args.product_type) || linked.productType,
          vendor: str(args.vendor) || linked.vendor,
          collection_ids: strings(args.collection_ids).length ? args.collection_ids : linked.collectionIds,
          primary_collection_id: str(args.primary_collection_id) || linked.primaryCollectionId || "",
        };
      }
      const tableId = str(args.price_table_id) || defaultTable(st, product);
      const named = strings(args.media_asset_ids).filter((id) => st.mockups.some((a) => a.id === id));
      const mediaIds = named.length ? named : defaultMedia(st, product);
      const namedCollections = strings(args.collection_ids);
      const collectionIds = namedCollections.length ? namedCollections : suggestCollections(await listCollections(await storeOfProduct(db, product)).catch((): CtShopifyCollection[] => []), { title: str(args.title), description: str(args.description_html), tags: strings(args.tags) }).map((c) => c.id);
      const body = readDeployBody({
        priceTableId: tableId ?? "",
        title: str(args.title),
        descriptionHtml: str(args.description_html),
        status: str(args.status) === "DRAFT" ? "DRAFT" : "ACTIVE",
        vendor: str(args.vendor),
        productType: str(args.product_type),
        tags: strings(args.tags),
        mediaAssetIds: mediaIds,
        collectionIds,
        primaryCollectionId: str(args.primary_collection_id) || collectionIds[0] || null,
        shopifyProductId: null,
      });
      const missing = blockers(st, { kind: product.kind ?? "artwork", tableId, title: body?.title ?? "", descriptionHtml: body?.descriptionHtml ?? "", mediaIds });
      if (!body || missing.length) throw new Error(`Chưa deploy được:\n- ${(missing.length ? missing : ["Thiếu title hoặc bảng giá."]).join("\n- ")}`);
      await progress(db, task?.id, `Đang deploy “${body.title}” lên Shopify (${body.status})…`);
      const r = await runDeploy(s, product, body, siteUrl());
      if ("error" in r) {
        await progress(db, task?.id, `Deploy lỗi: ${r.error}`);
        throw new Error(r.error);
      }
      await progress(db, task?.id, `Đã deploy lên Shopify (${r.shopify.status}, template v${r.publish.version}): ${r.shopify.url || r.shopify.adminUrl}`);
      return json({
        ok: true,
        shopify: { productId: r.shopify.productId, status: r.shopify.status, url: r.shopify.url, adminUrl: r.shopify.adminUrl, handle: r.shopify.handle },
        previewUrl: r.previewUrl,
        templateVersion: r.publish.version,
        warnings: r.warnings,
        next: "Give the editor the Shopify link (url; adminUrl to edit) and the warnings, if any.",
      });
    },
  },
];
