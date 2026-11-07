/**
 * An imported bộ → Shopify. Asked 2026-10-30 to go there by itself; since 2026-11-07 (Product base · Artwork · Sản
 * phẩm) a build stops at the clipart + the ARTWORK, and this runs on request: the artwork's product (made on the
 * base product of the folder's material) is deployed as a DRAFT — the folder's title and description
 * (title-description.txt), the base product's variants + prices, its mockups — and the set keeps the staff preview
 * link (live theme, template flexi2). Nothing goes on sale: an editor turns it ACTIVE later.
 */

import { CT_TABLES } from "../../config";
import type { CtAsset, CtCharImportManifest, CtCharImportShopify, CtCharProject, CtProduct } from "../../types";
import { suggestCollections } from "../../lib/collections";
import { defaultDeployMedia } from "../../lib/deploy-media";
import { baseProductFor, materialWord } from "../../lib/pricing";
import { listBaseRows } from "../base-products";
import { ensureProductFor } from "../artwork-link";
import { runDeploy } from "../handlers";
import { createCollection, listCollections, shopifyConfigured } from "../shopify";
import { siteUrl } from "../site-url";
import type { CtSession } from "../supabase";


/** Images Shopify gets: the import's sales pictures, in order. */
const MAX_MEDIA = 10;

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = (t: string) => esc(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>");

/** A description already written as HTML (@flexiprint's manifest, 2026-11-02 — it showed as raw tags on the store). */
const HTML_DESCRIPTION = /<\/?(p|h[1-6]|ul|ol|li|strong|em|b|i|br|div|span|a)\b[^>]*>/i;

/** HTML kept as written, minus what a product page must never run. */
const safeHtml = (html: string) =>
  html
    .replace(/<(script|style|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|style|iframe|object|embed)\b[^>]*\/?>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["']?)\s*javascript:[^"'\s>]*\2/gi, "")
    .trim();

/** The folder's description (plain text with **bold**, "- " lists, "### " heads, or HTML) as the HTML a product page takes. */
export function descriptionHtml(text: string): string {
  if (HTML_DESCRIPTION.test(text)) return safeHtml(text);
  const out: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) out.push(`<ul>${list.map((x) => `<li>${inline(x)}</li>`).join("")}</ul>`);
    list = [];
  };
  for (const block of text.replace(/\r/g, "").split(/\n{2,}/)) {
    for (const raw of block.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const item = /^[-*•]\s+(.*)$/.exec(line);
      if (item) {
        list.push(item[1]);
        continue;
      }
      flush();
      const head = /^#{1,6}\s+(.*)$/.exec(line) ?? /^\*\*([^*]+)\*\*:?$/.exec(line);
      out.push(head ? `<h3>${inline(head[1])}</h3>` : `<p>${inline(line)}</p>`);
    }
    flush();
  }
  return out.join("\n");
}

/** What the deploy takes from the import. */
export interface ImportDeployInfo {
  title: string;
  description: string;
  material: string;
}

export async function saveImportShopify(s: CtSession, setId: string, patch: Partial<CtCharImportShopify>): Promise<void> {
  const db = s.supabase;
  const { data } = await db.from(CT_TABLES.charProjects).select("brief").eq("id", setId).maybeSingle<{ brief: { imported?: { shopify?: CtCharImportShopify } } }>();
  const brief = data?.brief;
  if (!brief?.imported) return;
  const cur: CtCharImportShopify = brief.imported.shopify ?? { status: "deploying", previewUrl: "", adminUrl: "", priceTable: "", error: "", at: "", title: "", description: "", material: "" };
  await db
    .from(CT_TABLES.charProjects)
    .update({ brief: { ...brief, imported: { ...brief.imported, shopify: { ...cur, ...patch, at: new Date().toISOString() } } } })
    .eq("id", setId);
}

/** The manifest's part a deploy takes. */
export function deployInfo(m: CtCharImportManifest): ImportDeployInfo {
  return { title: m.title, description: m.description, material: m.material };
}

/** The set as it was imported — for a deploy again (brief.imported.shopify; an older set: its product). */
export function savedDeployInfo(p: CtCharProject, product: CtProduct | null): ImportDeployInfo {
  const shop = p.brief.imported?.shopify;
  return { title: shop?.title || product?.name || p.name, description: shop?.description ?? "", material: shop?.material || product?.config?.material?.id || "" };
}

/**
 * The built artwork → its product (made on the base product of its material when it has none yet) → a Shopify draft
 * (the product's Shopify product again when it has one); the outcome (link or why not) on brief.imported.shopify.
 * Since 2026-11-07 a build stops at the artwork: this runs when someone asks ("Tạo sản phẩm + đưa lên Shopify",
 * MCP char_import_deploy). Never throws.
 */
export async function deployImported(s: CtSession, setId: string, artworkId: string, info: ImportDeployInfo): Promise<void> {
  try {
    await saveImportShopify(s, setId, { status: "deploying", error: "", ...info });
    if (!shopifyConfigured()) throw new Error("Chưa cấu hình Shopify trên server");
    const db = s.supabase;
    const { data: artwork } = await db.from(CT_TABLES.products).select("*").eq("id", artworkId).single<CtProduct>();
    if (!artwork) throw new Error("Không thấy artwork của bộ");

    const word = materialWord(info.material);
    const base = baseProductFor(await listBaseRows(db), info.material);
    if (!base) {
      throw new Error(
        word
          ? `Chưa có product base cho chất liệu ${word.name} — tạo ở tab Product base rồi bấm lại`
          : `Không biết product base nào cho chất liệu "${info.material || "chưa rõ"}" — tạo sản phẩm từ artwork (chọn product base) rồi deploy ở trang sản phẩm`,
      );
    }
    const product = artwork.kind === "product" ? artwork : await ensureProductFor(db, artwork.user_id, artwork, base);
    const productId = product.id;
    const table = base.priceTable;
    if (!table) throw new Error(`Product base “${base.name}” chưa gắn bảng giá`);

    const { data: mockups } = await db.from(CT_TABLES.assets).select("id, name").eq("product_id", productId).eq("role", "mockup").order("created_at").returns<Array<Pick<CtAsset, "id" | "name">>>();
    const title = (info.title || product.name).trim();
    if (title && title !== product.name) await db.from(CT_TABLES.products).update({ name: title }).eq("id", productId);
    const ornament = /ornament/i.test(title);
    const collections = await listCollections();
    // The product type a type rule of the store already names (CHERIVIA ships "Acrylic Ornament" / "Christmas
    // Ornament" as ornaments — a "Glass Ornament" would fall in the other shipping group).
    const types = new Set(collections.flatMap((c) => c.rules.filter((r) => r.column === "TYPE" && r.relation === "EQUALS").map((r) => r.condition)));
    const productType = ornament ? ([word ? `${word.name} Ornament` : "", "Christmas Ornament", "Ornament"].find((t) => t && types.has(t)) ?? (word ? `${word.name} Ornament` : "Ornament")) : "";
    const tags = ["personalized", ...(ornament ? ["ornament", "christmas"] : [])];
    // The store's collections that fit; a new one only when none does (no twins — 2026-10-30).
    let fit = suggestCollections(collections, { title, description: info.description, tags });
    if (!fit.length && productType) fit = [await createCollection(`${productType}s`)];
    const r = await runDeploy(
      s,
      product,
      {
        priceTableId: table.id,
        title,
        descriptionHtml: info.description ? descriptionHtml(info.description) : "",
        status: product.shopify?.status ?? "DRAFT",
        vendor: "",
        productType: base.config.productType || productType,
        tags,
        mediaAssetIds: defaultDeployMedia(mockups ?? []).slice(0, MAX_MEDIA),
        collectionIds: fit.map((c) => c.id),
        primaryCollectionId: fit[0]?.id ?? null,
        shopifyProductId: null,
      },
      siteUrl(),
    );
    if ("error" in r) throw new Error(r.error);
    // An active product opens its own page (a preview link expires); a draft one only has the preview link (live theme).
    const live = (product.shopify?.status ?? "DRAFT") === "ACTIVE";
    await saveImportShopify(s, setId, { status: "done", productId, previewUrl: live ? r.shopify.url : (r.previewUrl ?? r.shopify.url), adminUrl: r.shopify.adminUrl, priceTable: table.name, error: r.warnings.join(" ") });
  } catch (e) {
    await saveImportShopify(s, setId, { status: "failed", error: e instanceof Error ? e.message : String(e) }).catch(() => undefined);
  }
}
