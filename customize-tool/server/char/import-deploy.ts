/**
 * An imported bộ goes to Shopify by itself (asked 2026-10-30: "việc import bộ là thẳng tới deploy và ra sản phẩm
 * preview luôn chứ không deploy tay"): once built, its product is deployed as a DRAFT — the folder's title and
 * description (title-description.txt), the price table named after its material, its mockups as images — and the set
 * keeps the staff preview link that opens it in the draft theme (SHOPIFY_PREVIEW_THEME_ID). Nothing goes on sale: an
 * editor turns it ACTIVE later.
 */

import { CT_TABLES } from "../../config";
import type { CtAsset, CtCharImportManifest, CtCharImportShopify, CtCharProject, CtMaterialId, CtPriceTable, CtProduct } from "../../types";
import { suggestCollections } from "../../lib/collections";
import { defaultDeployMedia } from "../../lib/deploy-media";
import { runDeploy } from "../handlers";
import { createCollection, listCollections, shopifyConfigured } from "../shopify";
import { siteUrl } from "../site-url";
import type { CtSession } from "../supabase";

/** The word a price table's name carries for a material ("Acrylic Ornament 1 side · Cherivia"). */
const MATERIAL_WORD: Partial<Record<CtMaterialId, { find: RegExp; name: string }>> = {
  acrylic_clear: { find: /acrylic/i, name: "Acrylic" },
  acrylic_white: { find: /acrylic/i, name: "Acrylic" },
  glass_clear: { find: /glass/i, name: "Glass" },
  ceramic_gloss: { find: /ceramic/i, name: "Ceramic" },
  ceramic_matte: { find: /ceramic/i, name: "Ceramic" },
  aluminum: { find: /alumin|metal/i, name: "Aluminum" },
  wood: { find: /wood/i, name: "Wooden" },
};

/** Images Shopify gets: the import's sales pictures, in order. */
const MAX_MEDIA = 10;

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = (t: string) => esc(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>");

/** The folder's description (plain text with **bold**, "- " lists, "### " heads) as the HTML a product page takes. */
export function descriptionHtml(text: string): string {
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
 * The built product → a Shopify draft (the set's Shopify product again when it has one); the outcome (link or why
 * not) on brief.imported.shopify. Never throws.
 */
export async function deployImported(s: CtSession, setId: string, productId: string, info: ImportDeployInfo): Promise<void> {
  try {
    await saveImportShopify(s, setId, { status: "deploying", error: "", ...info });
    if (!shopifyConfigured()) throw new Error("Chưa cấu hình Shopify trên server");
    const db = s.supabase;
    const { data: product } = await db.from(CT_TABLES.products).select("*").eq("id", productId).single<CtProduct>();
    if (!product) throw new Error("Không thấy sản phẩm của bộ");

    const word = MATERIAL_WORD[info.material as CtMaterialId];
    const { data: tables } = await db.from(CT_TABLES.priceTables).select("*").order("updated_at", { ascending: false }).limit(200).returns<CtPriceTable[]>();
    const table = word ? (tables ?? []).find((t) => word.find.test(t.name)) : undefined;
    if (!table) {
      throw new Error(
        word
          ? `Chưa có bảng giá cho chất liệu ${word.name} — tạo một bảng giá có chữ "${word.name}" trong tên (trang Deploy) rồi bấm "Đưa lên Shopify lại"`
          : `Không biết bảng giá nào cho chất liệu "${info.material || "chưa rõ"}" — deploy ở trang Deploy của sản phẩm`,
      );
    }

    const { data: mockups } = await db.from(CT_TABLES.assets).select("id, name").eq("product_id", productId).eq("role", "mockup").order("created_at").returns<Array<Pick<CtAsset, "id" | "name">>>();
    const title = (info.title || product.name).trim();
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
        productType,
        tags,
        mediaAssetIds: defaultDeployMedia(mockups ?? []).slice(0, MAX_MEDIA),
        collectionIds: fit.map((c) => c.id),
        primaryCollectionId: fit[0]?.id ?? null,
        shopifyProductId: null,
      },
      siteUrl(),
    );
    if ("error" in r) throw new Error(r.error);
    await saveImportShopify(s, setId, { status: "done", previewUrl: r.previewUrl ?? r.shopify.url, adminUrl: r.shopify.adminUrl, priceTable: table.name, error: r.warnings.join(" ") });
  } catch (e) {
    await saveImportShopify(s, setId, { status: "failed", error: e instanceof Error ? e.message : String(e) }).catch(() => undefined);
  }
}
