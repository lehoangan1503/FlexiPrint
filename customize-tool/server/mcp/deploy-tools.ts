/**
 * MCP tools for Deploy (asked 2026-10-29: the agent finishes and deploys a product itself, ACTIVE when everything
 * passes) — the same pipeline as the editor's Deploy page (server/handlers.ts runDeploy):
 *
 *   check_deploy     what a deploy of the product would use and what blocks it (Vietnamese "missing" list)
 *   list_base_products / make_product_from_artwork   product bases (variants + price) and a product = artwork + base
 *   deploy_product   the same checks again, then the storefront template + the Shopify product (variants from the
 *                    price table, mockups as images); run again it updates the same Shopify product
 *
 * The task's user must be able to edit the product (its owner, or an admin — migration 026).
 */

import type { CtAgentTask, CtAsset, CtBaseProduct, CtContentResult, CtPriceTable, CtProduct, CtShopifyCollection, CtShopifyInfo } from "../../types";
import { auditOptions } from "../../lib/option-audit";
import { suggestCollections } from "../../lib/collections";
import { defaultDeployMedia } from "../../lib/deploy-media";
import { normalizePriceTableConfig, priceCells, priceTableFor, priceTableProblems } from "../../lib/pricing";
import { str } from "../ai/llm";
import { serviceSession } from "../char/product";
import { ownedProduct, productTemplate, readDeployBody, runDeploy } from "../handlers";
import { listCollections, previewLinks, shopifyConfigured, shopifyInfo } from "../shopify";
import { siteUrl } from "../site-url";
import { listBaseRows, loadBaseProduct } from "../base-products";
import { makeProductFromArtwork } from "../artwork-link";
import { ensureVersionPhoi, jobName } from "../version-phoi";
import { normalizeProductConfig } from "../../lib/design";
import { CT_CONFIG, CT_TABLES } from "../../config";
import type { CtServiceClient, CtSession } from "../supabase";
import { TASK_ARG, json, liveStatus, loadTask } from "./task-common";
import type { CtMcpContext, CtMcpTool } from "./tools";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A description shorter than this (its text, tags stripped) is not a product page. */
const MIN_DESCRIPTION = 200;

/** The task, a session of its user and the product they may edit. */
async function openProduct(ctx: CtMcpContext, args: Record<string, unknown>): Promise<{ db: CtServiceClient; task: CtAgentTask; s: CtSession; product: CtProduct }> {
  const { db, task } = await loadTask(ctx, args.task_id);
  if (!task.user_id) throw new Error("The task has no user");
  const id = str(args.product_id);
  if (!UUID.test(id)) throw new Error("product_id is not a valid id");
  const s = await serviceSession(db, task.user_id);
  const product = await ownedProduct(s, id);
  if (!product) throw new Error("No such product, or the task's user may not edit it");
  return { db, task, s, product };
}

async function progress(db: CtServiceClient, taskId: string, text: string): Promise<void> {
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
async function deployState(db: CtServiceClient, s: CtSession, product: CtProduct): Promise<DeployState> {
  const [base, info, tables, mockups, built, content] = await Promise.all([
    product.base_product_id ? loadBaseProduct(db, product.base_product_id) : Promise.resolve(null),
    shopifyInfo(product.shopify?.productId ?? null).catch((e: Error): CtShopifyInfo => ({ configured: shopifyConfigured(), shop: null, product: null, error: e.message })),
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
function blockers(st: DeployState, pick: { kind: string; tableId: string | null; title: string; descriptionHtml: string; mediaIds: string[] }): string[] {
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
function defaultTable(st: DeployState, product: CtProduct): string | null {
  // The base product owns the prices (2026-11-07).
  if (st.base?.config.priceTableId) return st.base.config.priceTableId;
  const linked = product.shopify?.priceTableId;
  if (linked && st.tables.some((t) => t.id === linked)) return linked;
  return priceTableFor(st.tables, product.config?.material?.id ?? "")?.id ?? null;
}

/** The mockups a deploy takes when none are named: the ones already on the Shopify product, else the scene mockups. */
function defaultMedia(st: DeployState, product: CtProduct): string[] {
  const known = product.shopify ? Object.keys(product.shopify.media).filter((id) => st.mockups.some((a) => a.id === id)) : [];
  return known.length ? known : defaultDeployMedia(st.mockups);
}

const strings = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

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
      let q = ctx.db.from(CT_TABLES.products).select("id, name, shopify").not("shopify", "is", null);
      q = ids.length ? q.in("id", ids) : q.order("updated_at", { ascending: false }).limit(limit);
      const { data, error } = await q.returns<Array<Pick<CtProduct, "id" | "name" | "shopify">>>();
      if (error) throw new Error(error.message);
      const rows = (data ?? []).filter((p) => p.shopify?.productId);
      if (!rows.length) return json({ products: [], note: ids.length ? "Các sản phẩm này chưa deploy lên Shopify." : "Chưa có sản phẩm nào deploy lên Shopify." });
      const live = new Map((await previewLinks(rows.map((p) => p.shopify!.productId))).map((x) => [x.id, x]));
      return json({
        products: rows.map((p) => {
          const x = live.get(p.shopify!.productId);
          return x
            ? { product_id: p.id, name: p.name, title: x.title, status: x.status, preview: x.previewUrl, store: x.storeUrl, admin: p.shopify!.adminUrl }
            : { product_id: p.id, name: p.name, error: "Sản phẩm Shopify không còn (đã xoá?) — deploy lại" };
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
      properties: { ...TASK_ARG, product_id: { type: "string", description: "The FlexiPrint product (char_status gives the set's product id)." } },
      required: ["task_id", "product_id"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, s, product } = await openProduct(ctx, args);
      const st = await deployState(db, s, product);
      const collections = await listCollections().catch((): CtShopifyCollection[] => []);
      const linked = st.info.product;
      const tableId = defaultTable(st, product);
      const title = linked?.title || st.content?.title || "";
      const descriptionHtml = linked?.descriptionHtml || st.content?.descriptionHtml || "";
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
        missing: blockers(st, { kind: product.kind ?? "artwork", tableId, title, descriptionHtml, mediaIds: defaultMedia(st, product) }),
        next: "Fill what is missing (title + description_html in US English per the content rules; a price table that fits — never create one, the editor keeps them; make_product_mockups when there is none), then deploy_product. Collections: reuse the store's — the suggested ones fit the title; a smart (rule-based) one is joined through its rules (the deploy adds the tag / type), so pick it like any other. Never create a collection when one fits.",
      });
    },
  },
  {
    name: "list_base_products",
    description:
      "Product bases (like Teeinblue): the blank products sold — they OWN the physical piece: print area (= the canvas of an artwork made for it), khuôn in (fixed shape) or cut along the design (cut.mode khuon | alpha | none, border mm, silhouette, hanging hole), the preview photo / phôi (preview), material, Shopify product type, the price table (variants sizes × packs with prices), how many products use each. An artwork is only the design; a product (what is sold) = an artwork + one of these.",
    inputSchema: { type: "object", properties: { ...TASK_ARG }, required: ["task_id"] },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db } = await loadTask(ctx, args.task_id);
      const bases = await listBaseRows(db);
      return json({
        bases: bases.map((b) => ({
          id: b.id,
          name: b.name,
          material: b.config.material,
          productType: b.config.productType,
          khuon: b.template ? { id: b.template.id, name: b.template.name, width: b.template.width, height: b.template.height, phoi: b.template.blankUrl } : null,
          printAreas: b.config.printAreas,
          cut: b.config.cut,
          preview: b.config.preview.url ? { url: b.config.preview.url, kind: b.config.cut.mode === "alpha" ? "background (AI phôi per version: make_version_phoi)" : "phôi photo" } : null,
          variants: b.priceTable ? priceCells(b.priceTable.config).map((c) => ({ size: c.size?.label ?? "", pack: c.pack?.label ?? "", price: c.price, compareAt: c.compareAt })) : [],
          priceTable: b.priceTable?.name ?? null,
          products: b.products,
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
        ...TASK_ARG,
        artwork_id: { type: "string", description: "The artwork (a set's product id, an import's, render_artwork's)." },
        base_product_id: { type: "string", description: "From list_base_products — the one of the artwork's material / khuôn." },
        name: { type: "string", description: "Product title (theme), default = the artwork's name." },
      },
      required: ["task_id", "artwork_id", "base_product_id"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task } = await loadTask(ctx, args.task_id);
      if (!task.user_id) throw new Error("The task has no user");
      const s = await serviceSession(db, task.user_id);
      const id = str(args.artwork_id);
      if (!UUID.test(id)) throw new Error("artwork_id is not a valid id");
      const artwork = await ownedProduct(s, id);
      if (!artwork) throw new Error("No such artwork, or the task's user may not edit it");
      const base = await loadBaseProduct(db, str(args.base_product_id));
      if (!base) throw new Error("No such product base — list_base_products");
      const product = await makeProductFromArtwork(db, task.user_id, artwork, base, str(args.name) || undefined);
      await progress(db, task.id, `Đã tạo sản phẩm “${product.name}” từ artwork “${artwork.name}” trên ${base.name}`);
      return json({ product_id: product.id, editor: `${siteUrl()}${CT_CONFIG.basePath}/${product.id}`, next: "make_product_mockups on product_id, then check_deploy / deploy_product." });
    },
  },
  {
    name: "set_artwork_base",
    description:
      "The base an ARTWORK is viewed on (the editor's \"Xem trên base\"): render_artwork / check_artwork then draw and check it on that base's khuôn + safe zone, the AI phôi (make_version_phoi) are made for it. Changes nothing in the design; products keep their own base. base_product_id empty = none.",
    inputSchema: {
      type: "object",
      properties: { ...TASK_ARG, artwork_id: { type: "string", description: "The artwork." }, base_product_id: { type: "string", description: "From list_base_products ('' = none)." } },
      required: ["task_id", "artwork_id"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task } = await loadTask(ctx, args.task_id);
      if (!task.user_id) throw new Error("The task has no user");
      const s = await serviceSession(db, task.user_id);
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
        ...TASK_ARG,
        artwork_id: { type: "string", description: "The artwork." },
        base_product_id: { type: "string", description: "Default: the artwork's base (set_artwork_base)." },
        version_ids: { type: "array", items: { type: "string" }, description: "Only these versions (main asset ids from version_phoi_status)." },
        redo: { type: "boolean", description: "Draw again even when they have one." },
      },
      required: ["task_id", "artwork_id"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task } = await loadTask(ctx, args.task_id);
      if (!task.user_id) throw new Error("The task has no user");
      const s = await serviceSession(db, task.user_id);
      const artwork = await ownedProduct(s, str(args.artwork_id));
      if (!artwork) throw new Error("No such artwork, or the task's user may not edit it");
      if (artwork.kind === "product") throw new Error("Phôi are made on the ARTWORK (its products take them): pass the artwork id (config.artworkLink of the product)");
      const base = await loadBaseProduct(db, str(args.base_product_id) || artwork.base_product_id || "");
      if (!base) throw new Error("The artwork has no base — set_artwork_base or pass base_product_id");
      const ids = Array.isArray(args.version_ids) ? args.version_ids.map(str).filter(Boolean) : [];
      const versions = await ensureVersionPhoi(db, task.user_id, artwork.id, base, { redo: args.redo === true, mainIds: ids });
      await progress(db, task.id, `Phôi preview “${artwork.name}” trên ${base.name}: ${versions.filter((v) => v.status === "started").length} version gửi AI, ${versions.filter((v) => v.status === "have").length} đã có`);
      return json({ artwork_id: artwork.id, base: base.name, versions, next: "version_phoi_status after ~2 min; view_image the urls." });
    },
  },
  {
    name: "version_phoi_status",
    description: "The preview photos (phôi) of an artwork's versions per base: url, source (ai | folder = the import folder's own), and the AI jobs (running / failed with error).",
    inputSchema: { type: "object", properties: { ...TASK_ARG, artwork_id: { type: "string", description: "The artwork." } }, required: ["task_id", "artwork_id"] },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task } = await loadTask(ctx, args.task_id);
      if (!task.user_id) throw new Error("The task has no user");
      const s = await serviceSession(db, task.user_id);
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
    inputSchema: { type: "object", properties: { ...TASK_ARG, artwork_id: { type: "string", description: "The artwork." } }, required: ["task_id", "artwork_id"] },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db } = await loadTask(ctx, args.task_id);
      const id = str(args.artwork_id);
      if (!UUID.test(id)) throw new Error("artwork_id is not a valid id");
      const { data: art } = await db.from(CT_TABLES.products).select("config").eq("id", id).maybeSingle<Pick<CtProduct, "config">>();
      if (!art) throw new Error("No such artwork");
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
    name: "deploy_product",
    description:
      "Deploy a product to Shopify — the editor's Deploy button: publishes the storefront template, then creates (or updates, keeping its variants) the Shopify product with the price table's variants, the title / description, and mockups as images. Refuses with the list of blockers (title, description_html ≥ 200 chars of text, a valid price table, ≥ 1 mockup, the template builds, Shopify configured). status ACTIVE (default, on sale at once) | DRAFT. → the Shopify link (store url, admin url), preview url, warnings, template version.",
    inputSchema: {
      type: "object",
      properties: {
        ...TASK_ARG,
        product_id: { type: "string", description: "The FlexiPrint product." },
        title: { type: "string", description: "Shopify title (US English)." },
        description_html: { type: "string", description: "Shopify description: p, ul/li, strong, h3 only." },
        price_table_id: { type: "string", description: "A price table from check_deploy (default: the linked one, else the newest)." },
        status: { type: "string", description: "ACTIVE (default, on sale at once) | DRAFT." },
        tags: { type: "array", items: { type: "string" }, description: "Shopify tags." },
        product_type: { type: "string", description: "Shopify product type (e.g. Christmas Ornament)." },
        vendor: { type: "string", description: "Shopify vendor (empty = the shop's default)." },
        media_asset_ids: { type: "array", items: { type: "string" }, description: "Mockup ids, in order (default: those already on Shopify, else the first 8)." },
        collection_ids: { type: "array", items: { type: "string" }, description: "gid://shopify/Collection/… from check_deploy, smart ones too (default: the ones that fit the title)." },
        primary_collection_id: { type: "string", description: "The breadcrumb collection (one of collection_ids)." },
      },
      required: ["task_id", "product_id", "title", "description_html"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const { db, task, s, product } = await openProduct(ctx, args);
      const st = await deployState(db, s, product);
      const tableId = str(args.price_table_id) || defaultTable(st, product);
      const named = strings(args.media_asset_ids).filter((id) => st.mockups.some((a) => a.id === id));
      const mediaIds = named.length ? named : defaultMedia(st, product);
      const namedCollections = strings(args.collection_ids);
      const collectionIds = namedCollections.length ? namedCollections : suggestCollections(await listCollections().catch((): CtShopifyCollection[] => []), { title: str(args.title), description: str(args.description_html), tags: strings(args.tags) }).map((c) => c.id);
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
      await progress(db, task.id, `Đang deploy “${body.title}” lên Shopify (${body.status})…`);
      const r = await runDeploy(s, product, body, siteUrl());
      if ("error" in r) {
        await progress(db, task.id, `Deploy lỗi: ${r.error}`);
        throw new Error(r.error);
      }
      await progress(db, task.id, `Đã deploy lên Shopify (${r.shopify.status}, template v${r.publish.version}): ${r.shopify.url || r.shopify.adminUrl}`);
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
