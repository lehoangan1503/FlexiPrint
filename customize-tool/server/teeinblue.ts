/**
 * Teeinblue portal, as flexi2's way into Merchize's catalog (asked 2026-11-11 — Merchize has no public catalog API,
 * Teeinblue lists and imports it). This is Teeinblue's own web-app API (portal-api.teeinblue.com, Laravel Sanctum),
 * not a published one: a logged-in session (cookies) acting for the Cherivia account.
 *
 *   login     ct_secrets 'teeinblue' = the session cookies + acting user. Pasted once from the connect script
 *             (scripts/teeinblue-connect.mjs reads them from Chrome); every answer renews them (Set-Cookie saved
 *             back) and a keep-alive call runs twice a day, so the 14-day session never runs out while flexi2 runs.
 *   catalog   GET fulfillments/<merchize>/catalogs?search= — id, title, picture, lowest base cost.
 *   import    reuse a Teeinblue base already made from that catalog id (any status, never changed), else
 *             POST products/import, read it, then archive it (the copy only existed for flexi2 to read; archived
 *             bases stay searchable under Teeinblue's "Archived" tab and can be unarchived).
 */

import { CT_TABLES } from "../config";
import type { CtFulfillCatalogItem, CtTeeinblueStatus } from "../types";
import { ctServiceClient, type CtServiceClient } from "./supabase";

const API = "https://portal-api.teeinblue.com/api/";
export const TEEINBLUE_CDN = "https://cdn.teeinblue.com/";
const KEY = "teeinblue";
const KEEPALIVE_MS = 12 * 60 * 60 * 1000;

interface TibCookie {
  name: string;
  value: string;
  /** Unix seconds; 0 = session cookie. */
  expires: number;
}

interface TibSecret {
  cookies: TibCookie[];
  actingUserId: number | null;
  account: string | null;
  savedAt: string;
  error: string | null;
}

/** A Teeinblue product base as flexi2 reads it (GraphQL products_by_pk). */
export interface TibProduct {
  id: number;
  title: string;
  description: string | null;
  fulfillment_linked_id: string | null;
  printareas: Array<{ name: string; display_name: string | null; width: number; height: number; dpi: number | null; position: number | null }>;
  variants: Array<{ color: string | null; color_hex: string | null; size: string | null; base_cost: number | null; weight: string | null; available: boolean | null; fulfillment_linked_id: string | null; printarea_id: number | null }>;
  mockups: Array<{ preview_url: string | null; url: string | null; ref: string | null; width: number | null; height: number | null }>;
}

interface TibGraphql<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

function db(): CtServiceClient {
  const c = ctServiceClient();
  if (!c) throw new Error("Server thiếu SUPABASE_SERVICE_ROLE_KEY");
  return c;
}

async function loadSecret(): Promise<TibSecret | null> {
  const { data, error } = await db().from(CT_TABLES.secrets).select("value").eq("key", KEY).maybeSingle<{ value: TibSecret }>();
  if (error) throw new Error(/ct_secrets/.test(error.message) ? `Thiếu migration 033_secrets.sql (${error.message})` : error.message);
  return data?.value ?? null;
}

async function saveSecret(s: TibSecret): Promise<void> {
  const { error } = await db().from(CT_TABLES.secrets).upsert({ key: KEY, value: s }, { onConflict: "key" });
  if (error) throw new Error(error.message);
}

function cookieHeader(cookies: TibCookie[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** Set-Cookie lines → the jar (same name replaced). */
function mergeCookies(jar: TibCookie[], setCookies: string[]): TibCookie[] {
  const out = new Map(jar.map((c) => [c.name, c]));
  for (const line of setCookies) {
    const [pair, ...attrs] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    let expires = 0;
    for (const a of attrs) {
      const [k, v] = a.split("=").map((x) => x.trim());
      if (/^max-age$/i.test(k) && v) expires = Math.floor(Date.now() / 1000) + Number(v);
      else if (/^expires$/i.test(k) && v && !expires) expires = Math.floor(new Date(v).getTime() / 1000) || 0;
    }
    if (!value || (expires && expires * 1000 < Date.now())) out.delete(name);
    else out.set(name, { name, value, expires });
  }
  return [...out.values()];
}

class TibAuthError extends Error {}

/** One portal call with the saved session; the renewed cookies are saved back. */
async function tibFetch(path: string, init: { method?: string; body?: unknown } = {}, secretIn?: TibSecret): Promise<unknown> {
  const secret = secretIn ?? (await loadSecret());
  if (!secret?.cookies.length) throw new TibAuthError("Chưa kết nối Teeinblue");
  const xsrf = secret.cookies.find((c) => c.name === "XSRF-TOKEN")?.value;
  const headers: Record<string, string> = {
    accept: "application/json",
    origin: "https://portal.teeinblue.com",
    referer: "https://portal.teeinblue.com/",
    cookie: cookieHeader(secret.cookies),
  };
  if (xsrf) headers["x-xsrf-token"] = decodeURIComponent(xsrf);
  if (secret.actingUserId) headers["x-acting-user-id"] = String(secret.actingUserId);
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(API + path, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: AbortSignal.timeout(60_000) });
  const set = res.headers.getSetCookie();
  if (set.length) {
    secret.cookies = mergeCookies(secret.cookies, set);
    secret.savedAt = new Date().toISOString();
  }
  if (res.status === 401 || res.status === 419) {
    secret.error = "Phiên Teeinblue đã hết — kết nối lại";
    await saveSecret(secret);
    throw new TibAuthError(secret.error);
  }
  if (secret.error || set.length) {
    secret.error = null;
    await saveSecret(secret);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = body && typeof body === "object" && "message" in body ? String((body as { message: unknown }).message) : `HTTP ${res.status}`;
    throw new Error(`Teeinblue: ${msg}`);
  }
  return body;
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const r = (await tibFetch("graphql", { method: "POST", body: { query, variables } })) as TibGraphql<T>;
  if (r.errors?.length) throw new Error(`Teeinblue: ${r.errors[0].message}`);
  if (!r.data) throw new Error("Teeinblue: không có dữ liệu");
  return r.data;
}

/** Keep the session alive while flexi2 runs (Teeinblue sessions end after 14 idle days). */
function startKeepAlive(): void {
  const g = globalThis as { __ctTeeinblueKeepAlive?: ReturnType<typeof setInterval> };
  if (g.__ctTeeinblueKeepAlive) return;
  g.__ctTeeinblueKeepAlive = setInterval(() => {
    void loadSecret()
      .then((s) => (s?.cookies.length && !s.error ? tibFetch("user", {}, s) : null))
      .catch((e: Error) => console.warn("[ct] teeinblue keep-alive", e.message));
  }, KEEPALIVE_MS);
  g.__ctTeeinblueKeepAlive.unref?.();
}

function statusOf(s: TibSecret | null): CtTeeinblueStatus {
  const session = s?.cookies.find((c) => c.name === "__Secure-teeinblue_session");
  return {
    connected: !!session && !s?.error,
    account: s?.account ?? null,
    expiresAt: session?.expires ? new Date(session.expires * 1000).toISOString() : null,
    error: s?.error ?? null,
  };
}

export async function teeinblueStatus(): Promise<CtTeeinblueStatus> {
  startKeepAlive();
  return statusOf(await loadSecret());
}

/**
 * The connect code from scripts/teeinblue-connect.mjs (base64 of {cookies}) — or a raw "a=b; c=d" Cookie header.
 * Checked against the portal before it is kept.
 */
export async function connectTeeinblue(code: string): Promise<CtTeeinblueStatus> {
  let cookies: TibCookie[] = [];
  const raw = code.trim();
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as { cookies?: Array<Partial<TibCookie>> };
    cookies = (parsed.cookies ?? []).filter((c): c is TibCookie => typeof c.name === "string" && typeof c.value === "string").map((c) => ({ name: c.name, value: c.value, expires: Number(c.expires) || 0 }));
  } catch {
    cookies = raw
      .replace(/^cookie:\s*/i, "")
      .split(";")
      .map((p) => p.trim())
      .filter((p) => p.includes("="))
      .map((p) => ({ name: p.slice(0, p.indexOf("=")), value: p.slice(p.indexOf("=") + 1), expires: 0 }));
  }
  cookies = cookies.filter((c) => /teeinblue_session|XSRF-TOKEN/.test(c.name));
  if (!cookies.some((c) => c.name === "__Secure-teeinblue_session")) throw new Error("Mã kết nối không có phiên Teeinblue (__Secure-teeinblue_session) — đăng nhập Teeinblue trên Chrome rồi chạy lại script");
  const secret: TibSecret = { cookies, actingUserId: null, account: null, savedAt: new Date().toISOString(), error: null };
  const user = (await tibFetch("user", {}, secret).catch((e: Error) => {
    throw new Error(e instanceof TibAuthError ? "Teeinblue không nhận phiên này (đã đăng xuất / hết hạn) — mở Teeinblue trên Chrome rồi chạy lại script" : e.message);
  })) as { id?: number };
  secret.actingUserId = typeof user?.id === "number" ? user.id : null;
  const instances = (await tibFetch("instances", {}, secret).catch(() => [])) as Array<{ domain?: string; platform_domain?: string }>;
  secret.account = instances.map((i) => i.domain || i.platform_domain).filter(Boolean).join(", ") || null;
  await saveSecret(secret);
  startKeepAlive();
  return statusOf(secret);
}

let merchizeId: number | null = null;

async function merchizeFulfillmentId(): Promise<number> {
  if (merchizeId) return merchizeId;
  const d = await gql<{ fulfillments: Array<{ id: number; name: string }> }>(`query { fulfillments(where: {name: {_eq: "merchize"}}) { id name } }`);
  const id = d.fulfillments[0]?.id;
  if (!id) throw new Error("Teeinblue không có Merchize");
  merchizeId = id;
  return id;
}

/** Merchize's catalog, through Teeinblue. */
export async function merchizeCatalog(q: string, page: number, perPage: number): Promise<{ items: Array<Omit<CtFulfillCatalogItem, "existing" | "priceTable">>; total: number }> {
  startKeepAlive();
  const fid = await merchizeFulfillmentId();
  const qs = new URLSearchParams({ page: String(page), per_page: String(perPage) });
  if (q) qs.set("search", q);
  const r = (await tibFetch(`fulfillments/${fid}/catalogs?${qs}`)) as { meta?: { total?: number }; data?: Array<{ fulfillment_catalog_id: string; title: string; images?: string[]; base_cost?: number | null }> };
  return {
    total: r.meta?.total ?? 0,
    items: (r.data ?? []).map((x) => ({
      catalogId: x.fulfillment_catalog_id,
      title: x.title,
      image: x.images?.[0] ?? null,
      cost: typeof x.base_cost === "number" ? x.base_cost : null,
      variants: null,
      printArea: null,
    })),
  };
}

const PRODUCT_FIELDS = `id title description fulfillment_linked_id
  printareas(order_by: [{position: asc}, {id: asc}]) { id name display_name width height dpi position }
  variants(order_by: {id: asc}) { color color_hex size base_cost weight available fulfillment_linked_id printarea_id }
  mockups(order_by: [{position: asc}, {id: asc}]) { preview_url url ref width height }`;

async function readProduct(id: number): Promise<TibProduct> {
  const d = await gql<{ products_by_pk: TibProduct | null }>(`query($id: bigint!) { products_by_pk(id: $id) { ${PRODUCT_FIELDS} } }`, { id });
  if (!d.products_by_pk) throw new Error(`Teeinblue không có product base ${id}`);
  return d.products_by_pk;
}

/** The newest Teeinblue base made from a Merchize catalog id (active or archived), or null. */
async function findBase(fid: number, catalogId: string): Promise<{ id: number; variants: number } | null> {
  const d = await gql<{ products: Array<{ id: number; variants_aggregate: { aggregate: { count: number } } }> }>(
    `query($fid: bigint!, $cid: String!) { products(where: {fulfillment_id: {_eq: $fid}, fulfillment_linked_id: {_eq: $cid}, deleted_at: {_is_null: true}}, order_by: {id: desc}, limit: 1) { id variants_aggregate { aggregate { count } } } }`,
    { fid, cid: catalogId },
  );
  const p = d.products[0];
  return p ? { id: p.id, variants: p.variants_aggregate.aggregate.count } : null;
}

/**
 * A Merchize product read off Teeinblue. `created` = flexi2 imported it on Teeinblue just now (and archived it after
 * reading); false = an existing Teeinblue base was only read.
 */
export async function merchizeProduct(catalogId: string): Promise<{ product: TibProduct; created: boolean }> {
  const fid = await merchizeFulfillmentId();
  const had = await findBase(fid, catalogId);
  if (had) return { product: await readProduct(had.id), created: false };
  await tibFetch("products/import", { method: "POST", body: { fulfillment_id: fid, catalog_id: catalogId } });
  let made: { id: number; variants: number } | null = null;
  for (let i = 0; i < 20; i++) {
    made = await findBase(fid, catalogId);
    if (made && made.variants > 0) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!made) throw new Error("Teeinblue chưa tạo xong product base — thử lại sau ít phút");
  const product = await readProduct(made.id);
  await tibFetch(`products/${made.id}/archive`, { method: "POST", body: {} }).catch((e: Error) => console.warn("[ct] teeinblue archive", made?.id, e.message));
  return { product, created: true };
}
