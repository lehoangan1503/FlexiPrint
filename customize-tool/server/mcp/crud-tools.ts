/**
 * Change / remove tools (asked 2026-11-20: "mọi bước từ tạo product base đến sản phẩm lên Shopify đều có quyền thêm
 * sửa xoá qua MCP"). The create / update tools live with their step (deploy-tools, print-tools); these fill the gaps:
 * rename / move a product, delete a base, a price table, an artwork, a product, a mockup, and the Shopify side
 * (status, delete). Every one runs as the signed-in user (or the task's user) through the same handlers the web
 * page uses, so ownership is checked the same way (own items; admins everything).
 */

import type { NextResponse } from "next/server";
import { CT_TABLES } from "../../config";
import type { CtProduct, CtShopifyStatus } from "../../types";
import { str } from "../ai/llm";
import { serviceSession } from "../char/product";
import { deleteAsset, deleteProduct, ownedProduct, updateProduct } from "../handlers";
import { deleteBaseProduct } from "../base-products";
import { deletePriceTable, listPriceTables } from "../price-tables";
import { deleteShopifyProduct, setShopifyStatus, shopifyConfigured } from "../shopify";
import { storeOfProduct } from "../stores";
import type { CtSession } from "../supabase";
import { OPT_TASK_ARG, actorOf, json } from "./task-common";
import type { CtMcpContext, CtMcpTool } from "./tools";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES: CtShopifyStatus[] = ["ACTIVE", "DRAFT", "ARCHIVED"];

async function session(ctx: CtMcpContext, args: Record<string, unknown>): Promise<CtSession> {
  const { db, userId } = await actorOf(ctx, args.task_id);
  return serviceSession(db, userId);
}

function idOf(args: Record<string, unknown>, key: string): string {
  const id = str(args[key]);
  if (!UUID.test(id)) throw new Error(`${key} is not a valid id`);
  return id;
}

/** A web handler's answer as a tool result: its error text thrown, else its JSON (or {ok: true}). */
async function answer(res: NextResponse): Promise<Record<string, unknown>> {
  const body = res.status === 204 ? {} : ((await res.json().catch(() => ({}))) as Record<string, unknown>);
  if (res.status >= 400) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${res.status}`);
  return Object.keys(body).length ? body : { ok: true };
}

async function owned(s: CtSession, id: string): Promise<CtProduct> {
  const p = await ownedProduct(s, id);
  if (!p) throw new Error("No such product / artwork, or you may not edit it");
  return p;
}

export const CT_MCP_CRUD_TOOLS: CtMcpTool[] = [
  {
    name: "update_product",
    description:
      "Change a product or an artwork in place: name, status (draft | ready | archived — FlexiPrint's own, not Shopify's), base_product_id (move a product to another base: variants, price, khuôn, phôi follow), mockup_order (asset ids, picture 1 first = the Shopify order) and mockup_off (asset ids not sent to Shopify). Give only what changes. The Shopify product changes on the next deploy_product.",
    inputSchema: {
      type: "object",
      properties: {
        ...OPT_TASK_ARG,
        product_id: { type: "string", description: "The product or artwork." },
        name: { type: "string", description: "New name." },
        status: { type: "string", description: "draft | ready | archived." },
        base_product_id: { type: "string", description: "A product only: the base to move it to (list_base_products)." },
        mockup_order: { type: "array", items: { type: "string" }, description: "Mockup asset ids in Shopify order." },
        mockup_off: { type: "array", items: { type: "string" }, description: "Mockup asset ids NOT sent to Shopify." },
      },
      required: ["product_id"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "product_id");
      await owned(s, id);
      const body: Parameters<typeof updateProduct>[2] = {};
      if (typeof args.name === "string" && args.name.trim()) body.name = args.name.trim().slice(0, 200);
      if (args.status === "draft" || args.status === "ready" || args.status === "archived") body.status = args.status;
      if (typeof args.base_product_id === "string" && args.base_product_id) body.base_product_id = idOf(args, "base_product_id");
      if (Array.isArray(args.mockup_order)) body.mockupOrder = args.mockup_order.map(String);
      if (Array.isArray(args.mockup_off)) body.mockupOff = args.mockup_off.map(String);
      if (!Object.keys(body).length) throw new Error("Nothing to change — give name, status, base_product_id, mockup_order or mockup_off");
      const out = await answer(await updateProduct(s, id, body));
      const p = out.product as CtProduct | undefined;
      return json({ product_id: id, changed: Object.keys(body), name: p?.name, status: p?.status, base_product_id: p?.base_product_id });
    },
  },
  {
    name: "delete_mockup",
    description: "Delete mockup pictures of a product (bad ones). They also leave the next deploy_product; a picture already on Shopify is removed from Shopify on that deploy. → what was deleted, what failed.",
    inputSchema: {
      type: "object",
      properties: { ...OPT_TASK_ARG, product_id: { type: "string", description: "The product." }, asset_ids: { type: "array", items: { type: "string" }, description: "Mockup asset ids (wait_product_mockups / check_deploy)." } },
      required: ["product_id", "asset_ids"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "product_id");
      await owned(s, id);
      const ids = Array.isArray(args.asset_ids) ? args.asset_ids.map(String).filter((x) => UUID.test(x)) : [];
      if (!ids.length) throw new Error("asset_ids is empty");
      const { data: rows } = await s.supabase.from(CT_TABLES.assets).select("id").eq("product_id", id).eq("role", "mockup").in("id", ids).returns<Array<{ id: string }>>();
      const mine = new Set((rows ?? []).map((r) => r.id));
      const deleted: string[] = [];
      const failed: Array<{ id: string; error: string }> = [];
      for (const a of ids) {
        if (!mine.has(a)) {
          failed.push({ id: a, error: "not a mockup of this product" });
          continue;
        }
        try {
          await answer(await deleteAsset(s, a));
          deleted.push(a);
        } catch (e) {
          failed.push({ id: a, error: e instanceof Error ? e.message : "error" });
        }
      }
      return json({ product_id: id, deleted, failed });
    },
  },
  {
    name: "delete_product",
    description:
      "Delete a product (what is sold) or an artwork from FlexiPrint for good — ASK THE USER FIRST. An artwork that products were made from is refused (delete or keep those first). A product on Shopify: shopify = \"keep\" (default: the Shopify product stays, no longer linked), \"archive\" (set ARCHIVED on Shopify first) or \"delete\" (delete it on Shopify first).",
    inputSchema: {
      type: "object",
      properties: { ...OPT_TASK_ARG, product_id: { type: "string", description: "The product or artwork." }, shopify: { type: "string", description: "keep (default) | archive | delete." } },
      required: ["product_id"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "product_id");
      const p = await owned(s, id);
      const mode = args.shopify === "archive" || args.shopify === "delete" ? args.shopify : "keep";
      let shopify: string | null = null;
      if (p.shopify?.productId && mode !== "keep") {
        const store = await storeOfProduct(s.supabase, p);
        if (!shopifyConfigured(store)) throw new Error(`Store ${store.name} has no Shopify app on the server — use shopify "keep"`);
        if (mode === "archive") await setShopifyStatus(store, p.shopify.productId, "ARCHIVED");
        else await deleteShopifyProduct(store, p.shopify.productId);
        shopify = mode === "archive" ? "archived" : "deleted";
      } else if (p.shopify?.productId) shopify = `kept: ${p.shopify.adminUrl}`;
      await answer(await deleteProduct(s, id));
      return json({ deleted: id, name: p.name, kind: p.kind, shopify });
    },
  },
  {
    name: "set_shopify_status",
    description: "Change a deployed product's status on Shopify without a full deploy: ACTIVE (on sale) | DRAFT (hidden) | ARCHIVED (put away). Putting a product ACTIVE sells it — ask the user first.",
    inputSchema: {
      type: "object",
      properties: { ...OPT_TASK_ARG, product_id: { type: "string", description: "The FlexiPrint product." }, status: { type: "string", description: "ACTIVE | DRAFT | ARCHIVED." } },
      required: ["product_id", "status"],
    },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "product_id");
      const status = str(args.status).toUpperCase() as CtShopifyStatus;
      if (!STATUSES.includes(status)) throw new Error("status: ACTIVE | DRAFT | ARCHIVED");
      const p = await owned(s, id);
      if (!p.shopify?.productId) throw new Error("This product is not on Shopify yet — deploy_product");
      const store = await storeOfProduct(s.supabase, p);
      if (!shopifyConfigured(store)) throw new Error(`Store ${store.name} has no Shopify app on the server`);
      await setShopifyStatus(store, p.shopify.productId, status);
      await s.supabase.from(CT_TABLES.products).update({ shopify: { ...p.shopify, status } }).eq("id", id);
      return json({ product_id: id, status, admin: p.shopify.adminUrl });
    },
  },
  {
    name: "delete_shopify_product",
    description: "Take a product off Shopify for good (deletes the Shopify product; FlexiPrint keeps the product, unlinked — deploy_product makes a new one later). ASK THE USER FIRST. To only hide it use set_shopify_status DRAFT.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, product_id: { type: "string", description: "The FlexiPrint product." } }, required: ["product_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "product_id");
      const p = await owned(s, id);
      if (!p.shopify?.productId) throw new Error("This product is not on Shopify");
      const store = await storeOfProduct(s.supabase, p);
      if (!shopifyConfigured(store)) throw new Error(`Store ${store.name} has no Shopify app on the server`);
      await deleteShopifyProduct(store, p.shopify.productId);
      await s.supabase.from(CT_TABLES.products).update({ shopify: null }).eq("id", id);
      return json({ product_id: id, deleted_from_shopify: p.shopify.handle, store: store.name });
    },
  },
  {
    name: "delete_base_product",
    description: "Delete a product base (only its maker or an admin) — ASK THE USER FIRST. Refused while products use it (move them with update_product base_product_id, or delete them).",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, base_product_id: { type: "string", description: "From list_base_products." } }, required: ["base_product_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "base_product_id");
      const { data: row } = await s.supabase.from(CT_TABLES.baseProducts).select("user_id, name").eq("id", id).maybeSingle<{ user_id: string | null; name: string }>();
      if (!row) throw new Error("No such product base — list_base_products");
      if (ctx.caller === "user" && !ctx.admin && row.user_id !== ctx.userId) throw new Error("Only the base's maker or an admin may delete it");
      await answer(await deleteBaseProduct(s, id));
      return json({ deleted: id, name: row.name });
    },
  },
  {
    name: "list_price_tables",
    description: "Every price table (sizes × packs with prices): id, name, sizes, packs, whose. Change one through update_base_product price_table (the base's own) or pick one with price_table_id.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG }, required: [] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const out = await answer(await listPriceTables(s));
      const tables = (out.tables as Array<{ id: string; name: string; user_id: string; config: { sizes: Array<{ label: string; price: number }>; packs: Array<{ qty: number; discountPct: number }> } }>) ?? [];
      return json({ tables: tables.map((t) => ({ id: t.id, name: t.name, mine: t.user_id === s.user.id, sizes: t.config.sizes.map((x) => `${x.label} ${x.price}`), packs: t.config.packs.map((x) => `${x.qty}×${x.discountPct ? ` −${x.discountPct}%` : ""}`) })) });
    },
  },
  {
    name: "delete_price_table",
    description: "Delete a price table (only its maker or an admin) — ASK THE USER FIRST. Refused while a product base uses it.",
    inputSchema: { type: "object", properties: { ...OPT_TASK_ARG, price_table_id: { type: "string", description: "From list_price_tables." } }, required: ["price_table_id"] },
    callers: ["agent", "user"],
    run: async (ctx, args) => {
      const s = await session(ctx, args);
      const id = idOf(args, "price_table_id");
      const { data: row } = await s.supabase.from(CT_TABLES.priceTables).select("user_id, name").eq("id", id).maybeSingle<{ user_id: string | null; name: string }>();
      if (!row) throw new Error("No such price table — list_price_tables");
      if (ctx.caller === "user" && !ctx.admin && row.user_id !== ctx.userId) throw new Error("Only the table's maker or an admin may delete it");
      const { data: bases } = await s.supabase.from(CT_TABLES.baseProducts).select("name").eq("config->>priceTableId", id).returns<Array<{ name: string }>>();
      if (bases?.length) throw new Error(`Used by ${bases.length} product base(s): ${bases.map((b) => b.name).slice(0, 3).join(", ")} — switch them first (update_base_product price_table_id)`);
      await answer(await deletePriceTable(s, id));
      return json({ deleted: id, name: row.name });
    },
  },
];
