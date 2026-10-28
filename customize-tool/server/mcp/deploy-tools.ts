/**
 * MCP tools for Deploy (asked 2026-10-29: the agent finishes and deploys a product itself, ACTIVE when everything
 * passes) — the same pipeline as the editor's Deploy page (server/handlers.ts runDeploy):
 *
 *   check_deploy     what a deploy of the product would use and what blocks it (Vietnamese "missing" list)
 *   deploy_product   the same checks again, then the storefront template + the Shopify product (variants from the
 *                    price table, mockups as images); run again it updates the same Shopify product
 *
 * The task's user must be able to edit the product (its owner, or an admin — migration 026).
 */

import { CT_TABLES } from "../../config";
import type { CtAgentTask, CtAsset, CtContentResult, CtPriceTable, CtProduct, CtShopifyCollection, CtShopifyInfo } from "../../types";
import { auditOptions } from "../../lib/option-audit";
import { normalizePriceTableConfig, priceCells, priceTableProblems } from "../../lib/pricing";
import { str } from "../ai/llm";
import { serviceSession } from "../char/product";
import { ownedProduct, productTemplate, readDeployBody, runDeploy } from "../handlers";
import { listCollections, shopifyConfigured, shopifyInfo } from "../shopify";
import { siteUrl } from "../site-url";
import type { CtServiceClient, CtSession } from "../supabase";
import { TASK_ARG, json, liveStatus, loadTask } from "./task-common";
import type { CtMcpContext, CtMcpTool } from "./tools";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The page shows this many mockups by default; the deploy takes them unless told otherwise. */
const DEFAULT_MEDIA = 8;
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
  info: CtShopifyInfo;
  tables: CtPriceTable[];
  mockups: CtAsset[];
  templateError: string | null;
  audit: ReturnType<typeof auditOptions> | null;
  content: CtContentResult | null;
}

/** Everything a deploy of the product reads. */
async function deployState(db: CtServiceClient, s: CtSession, product: CtProduct): Promise<DeployState> {
  const [info, tables, mockups, built, content] = await Promise.all([
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
    info,
    tables,
    mockups,
    templateError: "error" in built ? built.error : null,
    audit: "error" in built ? null : auditOptions(built.template),
    content,
  };
}

/** What blocks a deploy (Vietnamese, the editor reads it). */
function blockers(st: DeployState, pick: { tableId: string | null; title: string; descriptionHtml: string; mediaIds: string[] }): string[] {
  const out: string[] = [];
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

/** The price table a deploy takes when none is named: the one the product was deployed with, else the newest. */
function defaultTable(st: DeployState, product: CtProduct): string | null {
  const linked = product.shopify?.priceTableId;
  return linked && st.tables.some((t) => t.id === linked) ? linked : (st.tables[0]?.id ?? null);
}

/** The mockups a deploy takes when none are named: the ones already on the Shopify product, else the first few. */
function defaultMedia(st: DeployState, product: CtProduct): string[] {
  const known = product.shopify ? Object.keys(product.shopify.media).filter((id) => st.mockups.some((a) => a.id === id)) : [];
  return known.length ? known : st.mockups.slice(0, DEFAULT_MEDIA).map((a) => a.id);
}

const strings = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

export const CT_MCP_DEPLOY_TOOLS: CtMcpTool[] = [
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
        collections: collections.map((c) => ({ id: c.id, title: c.title, smart: c.smart })),
        lastContent: st.content ? { title: st.content.title, descriptionHtml: st.content.descriptionHtml } : null,
        missing: blockers(st, { tableId, title, descriptionHtml, mediaIds: defaultMedia(st, product) }),
        next: "Fill what is missing (title + description_html in US English per the content rules; a price table that fits; make_product_mockups when there is none), then deploy_product.",
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
        collection_ids: { type: "array", items: { type: "string" }, description: "gid://shopify/Collection/… from check_deploy (not smart ones)." },
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
      const collectionIds = strings(args.collection_ids);
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
      const missing = blockers(st, { tableId, title: body?.title ?? "", descriptionHtml: body?.descriptionHtml ?? "", mediaIds });
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
