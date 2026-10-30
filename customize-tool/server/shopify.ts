/**
 * Shopify Admin API (GraphQL) — Deploy sản phẩm.
 *
 * Auth: the Dev Dashboard app's client credentials (SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET on
 * SHOPIFY_STORE_DOMAIN) are exchanged for a 24 h token, cached in memory. Scopes in use: write_products
 * (product, variants, metafields, media). Publishing to the Online Store channel needs read/write_publications —
 * without them a deploy warns instead.
 *
 * Deploy = one `productSet` (synchronous): title / description / status, the price table's options + one variant
 * per cell (price = the pack's total), metafields customize_tool.product_id + customize_tool.pricing (read by
 * main-product.liquid), template suffix "flexiprint" and the chosen mockups as product images. Run again, it
 * updates the same product: variants are matched by option values so their ids (and carts) survive.
 */

import type {
  CtAsset,
  CtShopifyCollection,
  CtPriceTableConfig,
  CtShopifyInfo,
  CtShopifyLink,
  CtShopifyProductSummary,
  CtShopifyStatus,
} from "../types";
import { priceCells, shopifyPricing, usesPacks, usesSizes } from "../lib/pricing";

const API_VERSION = () => process.env.SHOPIFY_API_VERSION || "2026-07";
const DOMAIN = () => process.env.SHOPIFY_STORE_DOMAIN ?? "";
/** The draft theme carrying the FlexiPrint section — product links open in it, never the live theme. */
const PREVIEW_THEME = () => process.env.SHOPIFY_PREVIEW_THEME_ID ?? "";

/** The theme template the deployed product uses (templates/product.flexiprint.json → section flexiprint-product). */
export const CT_SHOPIFY_TEMPLATE_SUFFIX = "flexiprint";
export const CT_METAFIELD_NS = "customize_tool";

export function shopifyConfigured(): boolean {
  return Boolean(DOMAIN() && process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET);
}

export class ShopifyError extends Error {}

let token: { value: string; until: number } | null = null;

async function accessToken(): Promise<string> {
  if (token && token.until > Date.now()) return token.value;
  if (!shopifyConfigured()) throw new ShopifyError("Chưa cấu hình Shopify (SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET)");
  const res = await fetch(`https://${DOMAIN()}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.SHOPIFY_CLIENT_ID ?? "",
      client_secret: process.env.SHOPIFY_CLIENT_SECRET ?? "",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !body.access_token) throw new ShopifyError(`Shopify từ chối đăng nhập app: ${body.error_description ?? `HTTP ${res.status}`}`);
  // Renewed 10 minutes early.
  token = { value: body.access_token, until: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 600) * 1000 };
  return token.value;
}

interface GqlError {
  message: string;
  extensions?: { code?: string };
}

interface UserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`https://${DOMAIN()}/admin/api/${API_VERSION()}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await accessToken() },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401) token = null;
  const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: GqlError[] | string };
  if (!res.ok || body.errors) {
    const msg = Array.isArray(body.errors) ? body.errors.map((e) => e.message).join("; ") : (body.errors ?? `HTTP ${res.status}`);
    throw new ShopifyError(`Shopify: ${msg}`);
  }
  if (!body.data) throw new ShopifyError("Shopify: không có dữ liệu");
  return body.data;
}

function userErrors(list: UserError[] | undefined): void {
  if (list?.length) throw new ShopifyError(`Shopify: ${list.map((e) => (e.field?.length ? `${e.field.join(".")}: ${e.message}` : e.message)).join("; ")}`);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const PRODUCT_FIELDS = `
  id title handle status descriptionHtml vendor productType tags onlineStoreUrl onlineStorePreviewUrl
  options { name values }
  variantsCount { count }
  featuredMedia { preview { image { url } } }
  ctId: metafield(namespace: "${CT_METAFIELD_NS}", key: "product_id") { value }
  crumb: metafield(namespace: "${CT_METAFIELD_NS}", key: "breadcrumb_collection") { value }
  collections(first: 50) { nodes { id title handle } }
`;

interface ProductNode {
  id: string;
  title: string;
  handle: string;
  status: CtShopifyStatus;
  descriptionHtml: string;
  vendor: string;
  productType: string;
  tags: string[];
  onlineStoreUrl: string | null;
  onlineStorePreviewUrl: string | null;
  options: Array<{ name: string; values: string[] }>;
  variantsCount: { count: number } | null;
  featuredMedia: { preview: { image: { url: string } | null } | null } | null;
  ctId: { value: string } | null;
  crumb: { value: string } | null;
  collections: { nodes: CtShopifyCollection[] };
}

function summary(p: ProductNode): CtShopifyProductSummary {
  return {
    id: p.id,
    title: p.title,
    handle: p.handle,
    status: p.status,
    descriptionHtml: p.descriptionHtml,
    vendor: p.vendor,
    productType: p.productType,
    tags: p.tags,
    storeUrl: p.onlineStoreUrl ?? p.onlineStorePreviewUrl ?? null,
    options: p.options,
    variantsCount: p.variantsCount?.count ?? 0,
    imageUrl: p.featuredMedia?.preview?.image?.url ?? null,
    ctProductId: p.ctId?.value ?? null,
    collectionIds: p.collections.nodes.map((c) => c.id),
    primaryCollectionId: p.crumb?.value ?? null,
  };
}

export async function shopifyInfo(productGid: string | null): Promise<CtShopifyInfo> {
  if (!shopifyConfigured()) return { configured: false, shop: null, product: null };
  const data = await gql<{
    shop: { name: string; myshopifyDomain: string; currencyCode: string; currencyFormats: { moneyFormat: string } };
    product: ProductNode | null;
  }>(
    `query($id: ID!, $has: Boolean!) {
      shop { name myshopifyDomain currencyCode currencyFormats { moneyFormat } }
      product(id: $id) @include(if: $has) { ${PRODUCT_FIELDS} }
    }`,
    { id: productGid ?? "gid://shopify/Product/0", has: Boolean(productGid) },
  );
  return {
    configured: true,
    shop: { name: data.shop.name, domain: data.shop.myshopifyDomain, currency: data.shop.currencyCode, moneyFormat: data.shop.currencyFormats.moneyFormat },
    product: data.product ? summary(data.product) : null,
  };
}

export async function searchShopifyProducts(q: string): Promise<CtShopifyProductSummary[]> {
  const clean = q.replace(/["\\]/g, " ").trim();
  const data = await gql<{ products: { nodes: ProductNode[] } }>(
    `query($q: String) { products(first: 20, query: $q, sortKey: UPDATED_AT, reverse: true) { nodes { ${PRODUCT_FIELDS} } } }`,
    { q: clean ? `title:*${clean}* OR handle:*${clean}*` : null },
  );
  return data.products.nodes.map(summary);
}

// ---------------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------------

export interface ShopifyDeployInput {
  ctProductId: string;
  link: CtShopifyLink | null;
  /** Deploy onto this product (gid) — else the linked one, else a new product. */
  targetId: string | null;
  title: string;
  descriptionHtml: string;
  status: CtShopifyStatus;
  vendor: string;
  productType: string;
  tags: string[];
  priceTableId: string;
  pricing: CtPriceTableConfig;
  /** Custom collections the product is in; `primaryCollectionId` = the one the breadcrumb shows. */
  collectionIds: string[];
  primaryCollectionId: string | null;
  /** Product images, in order (absolute URLs Shopify can fetch). */
  media: Array<{ asset: CtAsset; url: string }>;
  templateVersion: number;
}

interface ExistingProduct {
  id: string;
  handle: string;
  variants: { nodes: Array<{ id: string; selectedOptions: Array<{ name: string; value: string }> }> };
  media: { nodes: Array<{ id: string }> };
}

const DEFAULT_OPTION = { name: "Title", value: "Default Title" };

function variantKey(options: Array<{ name: string; value: string }>): string {
  return options
    .map((o) => `${o.name.toLowerCase()}=${o.value.toLowerCase()}`)
    .sort()
    .join("|");
}

export async function deployToShopify(input: ShopifyDeployInput): Promise<{ link: CtShopifyLink; warnings: string[]; previewUrl: string | null }> {
  const warnings: string[] = [];
  const targetId = input.targetId ?? input.link?.productId ?? null;
  let existing: ExistingProduct | null = null;
  if (targetId) {
    const data = await gql<{ product: ExistingProduct | null }>(
      `query($id: ID!) { product(id: $id) {
        id handle
        variants(first: 250) { nodes { id selectedOptions { name value } } }
        media(first: 100) { nodes { id } }
      } }`,
      { id: targetId },
    );
    existing = data.product;
    if (!existing) {
      if (input.targetId) throw new ShopifyError("Không tìm thấy sản phẩm Shopify đã chọn (đã bị xoá?)");
      warnings.push("Sản phẩm Shopify cũ không còn — đã tạo sản phẩm mới.");
    }
  }

  // Options + one variant per price cell.
  const cfg = input.pricing;
  const sizes = usesSizes(cfg);
  const packs = usesPacks(cfg);
  const productOptions: Array<{ name: string; position: number; values: Array<{ name: string }> }> = [];
  if (sizes) productOptions.push({ name: cfg.sizeLabel, position: productOptions.length + 1, values: cfg.sizes.map((s) => ({ name: s.label })) });
  if (packs) productOptions.push({ name: cfg.packLabel, position: productOptions.length + 1, values: cfg.packs.map((p) => ({ name: p.label })) });
  if (!productOptions.length) productOptions.push({ name: DEFAULT_OPTION.name, position: 1, values: [{ name: DEFAULT_OPTION.value }] });

  const oldVariants = new Map((existing?.variants.nodes ?? []).map((v) => [variantKey(v.selectedOptions), v.id]));
  const variants = priceCells(cfg).map((cell, i) => {
    const values: Array<{ name: string; value: string }> = [];
    if (sizes && cell.size) values.push({ name: cfg.sizeLabel, value: cell.size.label });
    if (packs && cell.pack) values.push({ name: cfg.packLabel, value: cell.pack.label });
    if (!values.length) values.push(DEFAULT_OPTION);
    const id = oldVariants.get(variantKey(values));
    return {
      ...(id ? { id } : {}),
      position: i + 1,
      optionValues: values.map((v) => ({ optionName: v.name, name: v.value })),
      price: cell.price.toFixed(2),
      compareAtPrice: cell.compareAt !== null ? cell.compareAt.toFixed(2) : null,
      // Made to order: never "sold out".
      inventoryPolicy: "CONTINUE",
      inventoryItem: { tracked: false, requiresShipping: true },
      taxable: true,
    };
  });

  // Product images: the chosen mockups (re-used by id when already uploaded), then whatever else the product has.
  const known = input.link?.media ?? {};
  const liveMedia = new Set((existing?.media.nodes ?? []).map((m) => m.id));
  const ours = new Set(Object.values(known));
  const files = input.media.map(({ asset, url }) => {
    const id = known[asset.id];
    return id && liveMedia.has(id) ? { id } : { originalSource: url, alt: asset.name || input.title, contentType: "IMAGE" };
  });
  const foreign = (existing?.media.nodes ?? []).filter((m) => !ours.has(m.id)).map((m) => ({ id: m.id }));
  const manageMedia = input.media.length > 0 || Object.keys(known).length > 0;

  const productInput = {
    title: input.title,
    descriptionHtml: input.descriptionHtml,
    status: input.status,
    vendor: input.vendor,
    productType: input.productType,
    tags: input.tags,
    templateSuffix: CT_SHOPIFY_TEMPLATE_SUFFIX,
    productOptions,
    variants,
    metafields: [
      { namespace: CT_METAFIELD_NS, key: "product_id", type: "single_line_text_field", value: input.ctProductId },
      { namespace: CT_METAFIELD_NS, key: "pricing", type: "json", value: JSON.stringify(shopifyPricing(cfg)) },
      // The collection main-product.liquid shows in the breadcrumb (Home › Ornaments › product).
      ...(input.primaryCollectionId ? [{ namespace: CT_METAFIELD_NS, key: "breadcrumb_collection", type: "collection_reference", value: input.primaryCollectionId }] : []),
    ],
    collections: input.collectionIds,
    ...(manageMedia ? { files: [...files, ...foreign] } : {}),
  };

  const data = await gql<{
    productSet: {
      product: {
        id: string;
        handle: string;
        title: string;
        status: CtShopifyStatus;
        onlineStoreUrl: string | null;
        onlineStorePreviewUrl: string | null;
        media: { nodes: Array<{ id: string }> };
      } | null;
      userErrors: UserError[];
    };
  }>(
    `mutation($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
      productSet(input: $input, identifier: $identifier, synchronous: true) {
        product { id handle title status onlineStoreUrl onlineStorePreviewUrl media(first: 100) { nodes { id } } }
        userErrors { field message code }
      }
    }`,
    { input: productInput, identifier: existing ? { id: existing.id } : null },
  );
  userErrors(data.productSet.userErrors);
  const p = data.productSet.product;
  if (!p) throw new ShopifyError("Shopify không trả về sản phẩm");

  if (!input.primaryCollectionId && existing) {
    await gql<{ metafieldsDelete: { userErrors: UserError[] } }>(
      `mutation($m: [MetafieldIdentifierInput!]!) { metafieldsDelete(metafields: $m) { userErrors { field message } } }`,
      { m: [{ ownerId: p.id, namespace: CT_METAFIELD_NS, key: "breadcrumb_collection" }] },
    ).catch(() => undefined);
  }

  // Media come back in the order they were sent: ours first.
  const media: Record<string, string> = {};
  if (manageMedia) input.media.forEach(({ asset }, i) => {
    const node = p.media.nodes[i];
    if (node) media[asset.id] = node.id;
  });
  if (manageMedia && p.media.nodes.length < input.media.length) warnings.push("Một số ảnh chưa lên Shopify (URL ảnh không tải được từ Shopify?).");

  if (p.status === "ACTIVE" && !p.onlineStoreUrl) {
    const published = await publishToOnlineStore(p.id).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    if (published !== true) {
      warnings.push(
        `Chưa tự bật kênh Online Store (${published}). Nếu sản phẩm chưa hiện trên store: Shopify admin → sản phẩm → Sales channels → Online Store, hoặc cấp thêm scope read_publications + write_publications cho app.`,
      );
    }
  }

  const numericId = p.id.split("/").pop() ?? "";
  const shopDomain = DOMAIN();
  return {
    warnings,
    // Staff preview (passes the store password, works for a draft; expires) — not stored.
    previewUrl: themePreview(p.onlineStorePreviewUrl),
    link: {
      productId: p.id,
      handle: p.handle,
      title: p.title,
      status: p.status,
      priceTableId: input.priceTableId,
      media,
      deployedAt: new Date().toISOString(),
      templateVersion: input.templateVersion,
      url: `${p.onlineStoreUrl ?? `https://${shopDomain}/products/${p.handle}`}${PREVIEW_THEME() ? `?preview_theme_id=${PREVIEW_THEME()}` : ""}`,
      adminUrl: `https://admin.shopify.com/store/${shopDomain.replace(/\.myshopify\.com$/, "")}/products/${numericId}`,
    },
  };
}

/**
 * The preview link opened in the draft theme. Shopify's own link (…shopifypreview.com/products_preview?preview_key=…)
 * always renders the live theme; the same path on the shop's domain with _sc=1&preview_theme_id=… renders the given
 * one, draft product included (verified 2026-10-30).
 */
function themePreview(url: string | null): string | null {
  if (!url || !PREVIEW_THEME()) return url;
  const u = new URL(url);
  u.protocol = "https:";
  u.host = DOMAIN();
  u.searchParams.set("_ab", "0");
  u.searchParams.set("_fd", "0");
  u.searchParams.set("_sc", "1");
  u.searchParams.set("preview_theme_id", PREVIEW_THEME());
  return u.toString();
}

/** Publish on the Online Store channel. true, or why not (missing scope…). */
async function publishToOnlineStore(productId: string): Promise<true | string> {
  const pubs = await gql<{ publications: { nodes: Array<{ id: string; name: string; catalog: { title: string } | null }> } }>(
    `{ publications(first: 20) { nodes { id name catalog { title } } } }`,
  );
  const store = pubs.publications.nodes.find((n) => /online store/i.test(n.name) || /online store/i.test(n.catalog?.title ?? ""));
  if (!store) return "không thấy kênh Online Store";
  const res = await gql<{ publishablePublish: { userErrors: UserError[] } }>(
    `mutation($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { field message } } }`,
    { id: productId, input: [{ publicationId: store.id }] },
  );
  userErrors(res.publishablePublish.userErrors);
  return true;
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

/** Every collection; smart (rule-based) ones can't be joined by hand. */
export async function listCollections(): Promise<CtShopifyCollection[]> {
  const out: CtShopifyCollection[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const data: { collections: { nodes: Array<CtShopifyCollection & { ruleSet: object | null }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await gql(
      `query($after: String) { collections(first: 250, after: $after, sortKey: TITLE) { nodes { id title handle ruleSet { appliedDisjunctively } } pageInfo { hasNextPage endCursor } } }`,
      { after },
    );
    for (const c of data.collections.nodes) out.push({ id: c.id, title: c.title, handle: c.handle, smart: c.ruleSet !== null });
    if (!data.collections.pageInfo.hasNextPage) break;
    after = data.collections.pageInfo.endCursor;
  }
  return out;
}

export async function createCollection(title: string): Promise<CtShopifyCollection> {
  const data = await gql<{ collectionCreate: { collection: { id: string; title: string; handle: string } | null; userErrors: UserError[] } }>(
    `mutation($input: CollectionInput!) { collectionCreate(input: $input) { collection { id title handle } userErrors { field message } } }`,
    { input: { title } },
  );
  userErrors(data.collectionCreate.userErrors);
  const c = data.collectionCreate.collection;
  if (!c) throw new ShopifyError("Shopify không tạo được collection");
  // A new collection is not on the Online Store until published; the breadcrumb link still works for staff.
  return { ...c, smart: false };
}
