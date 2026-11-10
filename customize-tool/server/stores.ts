/**
 * The Shopify stores FlexiPrint sells on (ct_stores, migration 032) — asked 2026-11-10: a store switch on /dashboard;
 * product bases, price tables and the library are shared, artworks / products / deploys belong to one store.
 *
 *   GET  stores            → CtStoreList (every store + the one the user works on now)
 *   PUT  stores/current    { id } — the /dashboard switch
 *
 * Each store's app credentials (Dev Dashboard app, client credentials grant) are env vars, never in the database:
 *   SHOPIFY_<ID>_CLIENT_ID / SHOPIFY_<ID>_CLIENT_SECRET   (ID = the store id in capitals: SHOPIFY_CARIDORA_CLIENT_ID)
 *   CHERIVIA also reads the older SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET (/ SHOPIFY_STORE_DOMAIN before 032 ran).
 *
 * A new ct_products row with no store_id gets its owner's current store from a trigger, so the server paths that make
 * artworks (set builds, imports, MCP) need no store argument; a product made from an artwork takes the artwork's.
 */

import { NextResponse } from "next/server";
import { CT_TABLES } from "../config";
import type { CtProduct, CtStore, CtStoreList } from "../types";
import type { CtServiceClient, CtSession } from "./supabase";

type Db = CtSession["supabase"] | CtServiceClient;

interface StoreRow {
  id: string;
  name: string;
  shop_domain: string;
  public_url: string;
  sort_order: number;
}

/** The first store: every row made before migration 032. */
export const CT_DEFAULT_STORE = "cherivia";

export interface StoreCredentials {
  clientId: string;
  clientSecret: string;
}

function envKey(id: string): string {
  return id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/** The store's app credentials from env, or null when they are not set. */
export function storeCredentials(id: string): StoreCredentials | null {
  const k = envKey(id);
  const legacy = id === CT_DEFAULT_STORE;
  const clientId = process.env[`SHOPIFY_${k}_CLIENT_ID`] || (legacy ? process.env.SHOPIFY_CLIENT_ID : "") || "";
  const clientSecret = process.env[`SHOPIFY_${k}_CLIENT_SECRET`] || (legacy ? process.env.SHOPIFY_CLIENT_SECRET : "") || "";
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function storeRow(r: StoreRow): CtStore {
  return { id: r.id, name: r.name, shopDomain: r.shop_domain, publicUrl: r.public_url, configured: storeCredentials(r.id) !== null };
}

/** Before migration 032 ran: the one store of the env. */
function legacyStore(): CtStore {
  return {
    id: CT_DEFAULT_STORE,
    name: "CHERIVIA",
    shopDomain: process.env.SHOPIFY_STORE_DOMAIN ?? "",
    publicUrl: "",
    configured: storeCredentials(CT_DEFAULT_STORE) !== null && Boolean(process.env.SHOPIFY_STORE_DOMAIN),
  };
}

export async function loadStores(db: Db): Promise<CtStore[]> {
  const { data, error } = await db.from(CT_TABLES.stores).select("*").order("sort_order").order("created_at").returns<StoreRow[]>();
  if (error || !data?.length) return [legacyStore()];
  return data.map(storeRow);
}

export async function loadStore(db: Db, id: string): Promise<CtStore | null> {
  return (await loadStores(db)).find((st) => st.id === id) ?? null;
}

/** The store the user works on now: their pick on /dashboard, else the first store. */
export async function currentStoreId(db: Db, userId: string): Promise<string> {
  const { data } = await db.from(CT_TABLES.userStores).select("store_id").eq("user_id", userId).maybeSingle<{ store_id: string }>();
  if (data?.store_id) return data.store_id;
  return (await loadStores(db))[0]?.id ?? CT_DEFAULT_STORE;
}

/** The store an artwork / product belongs to (rows read before migration 032 = the first store). */
export async function storeOfProduct(db: Db, product: Pick<CtProduct, "store_id">): Promise<CtStore> {
  const id = product.store_id ?? CT_DEFAULT_STORE;
  const store = await loadStore(db, id);
  if (!store) throw new Error(`Không thấy store "${id}"`);
  return store;
}

/** A store id from a request (?store=…), else the user's current store. */
export async function storeFor(s: CtSession, raw: string | null): Promise<CtStore> {
  const id = raw?.trim() || (await currentStoreId(s.supabase, s.user.id));
  const store = await loadStore(s.supabase, id);
  if (!store) throw new Error(`Không thấy store "${id}"`);
  return store;
}

export async function listStores(s: CtSession): Promise<NextResponse> {
  const [stores, current] = await Promise.all([loadStores(s.supabase), currentStoreId(s.supabase, s.user.id)]);
  const body: CtStoreList = { stores, current: stores.some((st) => st.id === current) ? current : (stores[0]?.id ?? CT_DEFAULT_STORE) };
  return NextResponse.json(body);
}

export async function setCurrentStore(s: CtSession, raw: unknown): Promise<NextResponse> {
  const id = raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string" ? (raw as { id: string }).id.trim() : "";
  if (!(await loadStore(s.supabase, id))) return NextResponse.json({ error: "Không thấy store này" }, { status: 404 });
  const { error } = await s.supabase.from(CT_TABLES.userStores).upsert({ user_id: s.user.id, store_id: id, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return listStores(s);
}
