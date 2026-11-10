/**
 * "Import product base" from a fulfiller (asked 2026-11-11, like Teeinblue's "Import products from API-integrated
 * Fulfillment"): pick a product of Printbelle's or Merchize's catalog → a NEW flexi2 product base with its print
 * areas, the fulfiller's variants + base cost, its order codes, description, photos and (Printbelle) the phôi photo
 * with where the artwork sits on it. Bases that exist are never changed: a catalog product that already has a base
 * is shown as "Đã có", not imported twice.
 *
 * Price: the Notion price table whose name fits the title (lib/pricing priceTableForTitle), else none — set later on
 * the base page. Material stays "none" and the cut "none" (khuôn / cut are chosen on the base page), so imported bases
 * are never picked automatically for sets / imports by material.
 *
 *   GET  base-import/catalog?provider=printbelle|merchize&q=&page=  → CtFulfillCatalogPage
 *   POST base-import/import      CtBaseImportBody → { base }         (admin)
 *   GET  base-import/teeinblue   → CtTeeinblueStatus                 (Merchize goes through Teeinblue)
 *   POST base-import/teeinblue   { code } → CtTeeinblueStatus        (admin)
 */

import { NextResponse } from "next/server";
import { CT_CONFIG, CT_TABLES } from "../config";
import type {
  CtBaseProduct,
  CtBaseProductConfig,
  CtBaseSource,
  CtBaseVariant,
  CtFulfillCatalogItem,
  CtFulfillCatalogPage,
  CtFulfillProvider,
  CtPrintArea,
  CtProductScene,
} from "../types";
import { normalizeBaseConfig } from "../lib/base-product";
import { newId } from "../lib/geometry";
import { priceTableForTitle } from "../lib/pricing";
import { normalizeScene } from "../lib/scene";
import { isAdmin } from "./ai-styles";
import { printbelleProduct, printbelleSearch, type PbProduct } from "./printbelle";
import { ctUpload } from "./storage";
import { connectTeeinblue, merchizeCatalog, merchizeProduct, teeinblueStatus, TEEINBLUE_CDN, type TibProduct } from "./teeinblue";
import type { CtSession } from "./supabase";

const PER_PAGE = 24;
const PROVIDER_NAME: Record<CtFulfillProvider, string> = { printbelle: "Printbelle", merchize: "Merchize" };

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

function asProvider(v: unknown): CtFulfillProvider | null {
  return v === "printbelle" || v === "merchize" ? v : null;
}

/** "Prinbelle" (an old hand-typed base) and "Printbelle" are the same fulfiller. */
function providerOf(name: string): CtFulfillProvider | null {
  const n = name.toLowerCase();
  if (/^prin?t?belle/.test(n)) return "printbelle";
  if (/^merchize/.test(n)) return "merchize";
  return null;
}

/** "<provider>:<CATALOG ID>" of every base made from a fulfiller product — by its import, or typed by hand. */
async function existingBases(s: CtSession): Promise<Map<string, { id: string; name: string }>> {
  const { data } = await s.supabase.from(CT_TABLES.baseProducts).select("id,name,config").returns<Array<Pick<CtBaseProduct, "id" | "name" | "config">>>();
  const out = new Map<string, { id: string; name: string }>();
  for (const b of data ?? []) {
    const src = b.config?.source;
    if (src?.provider && src.catalogId) out.set(`${src.provider}:${src.catalogId.toUpperCase()}`, { id: b.id, name: b.name });
    const ful = b.config?.fulfillment;
    const p = ful?.provider ? providerOf(ful.provider) : null;
    if (p && ful?.catalogId) out.set(`${p}:${ful.catalogId.toUpperCase()}`, { id: b.id, name: b.name });
  }
  return out;
}

async function priceTables(s: CtSession): Promise<Array<{ id: string; name: string }>> {
  const { data } = await s.supabase.from(CT_TABLES.priceTables).select("id,name").returns<Array<{ id: string; name: string }>>();
  return data ?? [];
}

function minCost(costs: Array<number | null | undefined>): number | null {
  const n = costs.filter((c): c is number => typeof c === "number" && Number.isFinite(c));
  return n.length ? Math.min(...n) : null;
}

export async function importCatalog(s: CtSession, providerRaw: string | null, q: string, pageRaw: string | null): Promise<NextResponse> {
  const provider = asProvider(providerRaw);
  if (!provider) return jsonError("provider = printbelle | merchize", 400);
  const page = Math.max(1, Math.min(500, Number(pageRaw) || 1));
  try {
    const [found, existing, tables] = await Promise.all([
      provider === "printbelle"
        ? printbelleSearch(q, page, PER_PAGE).then((r) => ({
            total: r.total,
            items: r.list.map((p): Omit<CtFulfillCatalogItem, "existing" | "priceTable"> => ({
              catalogId: p.productSpu,
              title: p.productNameEn,
              image: p.productImg ?? p.productPhotoCollection?.[0] ?? null,
              cost: minCost((p.variantSku ?? []).map((v) => v.price)),
              variants: p.variantSku?.length ?? 0,
              printArea: p.printAreas?.[0] ? { width: p.printAreas[0].width, height: p.printAreas[0].height } : null,
            })),
          }))
        : merchizeCatalog(q, page, PER_PAGE),
      existingBases(s),
      priceTables(s),
    ]);
    const body: CtFulfillCatalogPage = {
      provider,
      page,
      perPage: PER_PAGE,
      total: found.total,
      items: found.items.map((it) => {
        const t = priceTableForTitle(tables, it.title);
        return { ...it, existing: existing.get(`${provider}:${it.catalogId.toUpperCase()}`) ?? null, priceTable: t ? { id: t.id, name: t.name } : null };
      }),
    };
    return NextResponse.json(body);
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Lỗi", 502);
  }
}

/** The fulfiller's HTML description → plain text (the base keeps text). */
function htmlText(html: string | null | undefined): string {
  if (!html) return "";
  const named: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", bull: "•", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", times: "×", deg: "°" };
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n: string) => named[n.toLowerCase()] ?? m)
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l, i, all) => l || (i > 0 && all[i - 1]))
    .join("\n")
    .trim()
    .slice(0, 20000);
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** Copies a fulfiller picture to our storage (their links may move); null when it cannot be fetched. */
async function copyPicture(userId: string, folder: string, url: string): Promise<{ url: string; data: Buffer } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
    if (!res.ok) return null;
    const mime = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    const ext = EXT[mime];
    if (!ext) return null;
    const data = Buffer.from(await res.arrayBuffer());
    const stored = await ctUpload(`${userId}/${CT_CONFIG.storagePrefix}/bases/${folder}/${crypto.randomUUID()}.${ext}`, data, mime);
    return { url: stored, data };
  } catch {
    return null;
  }
}

async function copyPictures(userId: string, folder: string, urls: string[]): Promise<string[]> {
  const uniq = [...new Set(urls.filter((u) => /^https?:\/\//.test(u)))].slice(0, 8);
  const out = await Promise.all(uniq.map((u) => copyPicture(userId, folder, u)));
  return out.flatMap((x) => (x ? [x.url] : []));
}

function nameOf(title: string): string {
  return title.replace(/\s+/g, " ").trim().slice(0, 160) || "Product base";
}

/** Printbelle → base config. The first mockup = the phôi photo; its zone = where the artwork sits. */
async function fromPrintbelle(s: CtSession, folder: string, p: PbProduct): Promise<{ name: string; config: Partial<CtBaseProductConfig> }> {
  const areas: CtPrintArea[] = (p.printAreas ?? []).map((a) => ({ id: newId(), name: a.key || "Artwork", width: a.width, height: a.height, dpi: 300 }));
  const variants: CtBaseVariant[] = (p.variantSku ?? []).map((v) => ({
    id: newId(),
    size: v.size ?? "",
    color: v.color ?? "",
    colorHex: v.colorHex ?? null,
    sku: v.productCode,
    cost: typeof v.price === "number" ? v.price : null,
    weightG: typeof v.weight === "number" ? v.weight : null,
    printArea: v.printAreaKey ?? areas[0]?.name ?? "",
    printWidth: (areas.find((a) => a.name === v.printAreaKey) ?? areas[0])?.width ?? null,
    printHeight: (areas.find((a) => a.name === v.printAreaKey) ?? areas[0])?.height ?? null,
  }));
  let preview: CtProductScene = normalizeScene(null);
  const mk = (p.mockups ?? []).find((m) => m.layers?.background && m.zone?.length === 4);
  if (mk?.layers.background) {
    const bg = await copyPicture(s.user.id, folder, mk.layers.background);
    const xs = mk.zone.map((z) => z.x);
    const ys = mk.zone.map((z) => z.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    if (bg) preview = normalizeScene({ url: bg.url, width: Number(mk.width) || 1000, height: Number(mk.height) || 1000, box: { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y } });
  }
  const photos = await copyPictures(s.user.id, folder, [p.productImg ?? "", ...(p.productPhotoCollection ?? [])]);
  return {
    name: nameOf(p.productNameEn),
    config: { description: htmlText(p.desc), printAreas: areas, variants, preview, source: { provider: "printbelle", catalogId: p.productSpu, via: "printbelle", teeinblueId: null, importedAt: new Date().toISOString(), photos } },
  };
}

/**
 * Merchize (read off Teeinblue) → base config. No phôi zone: the photos are kept, the preview is set by hand.
 * Teeinblue may give each variant its own print area (variant_printareas: "2-side Printed - 7x7 - front" 2100×6300):
 * the base's print areas are then one per face name (the size most variants use), and every variant keeps its own.
 */
async function fromTeeinblue(s: CtSession, folder: string, catalogId: string, p: TibProduct): Promise<{ name: string; config: Partial<CtBaseProductConfig> }> {
  const byId = new Map(p.printareas.map((a) => [a.id, a]));
  const areaOf = (v: TibProduct["variants"][number]) => byId.get(v.variant_printareas[0]?.printarea_id ?? v.printarea_id ?? -1) ?? null;
  const uses = new Map<number, number>();
  for (const v of p.variants) {
    const a = areaOf(v);
    if (a) uses.set(a.id, (uses.get(a.id) ?? 0) + 1);
  }
  const faces = new Map<string, TibProduct["printareas"][number]>();
  for (const a of p.printareas) {
    const face = a.name || "front";
    const had = faces.get(face);
    if (!had || (uses.get(a.id) ?? 0) > (uses.get(had.id) ?? 0)) faces.set(face, a);
  }
  const areas: CtPrintArea[] = [...faces.entries()].slice(0, 8).map(([face, a]) => ({ id: newId(), name: face.charAt(0).toUpperCase() + face.slice(1), width: a.width, height: a.height, dpi: a.dpi || 300 }));
  const variants: CtBaseVariant[] = p.variants.map((v) => {
    const a = areaOf(v);
    return {
      id: newId(),
      size: v.size ?? "",
      color: v.color && v.color !== "Default" ? v.color : "",
      colorHex: v.color_hex ?? null,
      sku: v.fulfillment_linked_id ?? "",
      cost: typeof v.base_cost === "number" ? v.base_cost : null,
      weightG: v.weight && Number.isFinite(Number(v.weight)) ? Number(v.weight) : null,
      printArea: a ? a.display_name || a.name : (areas[0]?.name ?? ""),
      printWidth: a?.width ?? null,
      printHeight: a?.height ?? null,
    };
  });
  const pics = p.mockups.map((m) => (m.preview_url ? TEEINBLUE_CDN + m.preview_url.replace(/^\/+/, "") : (m.ref ?? m.url ?? "")));
  const photos = await copyPictures(s.user.id, folder, pics);
  return {
    name: nameOf(p.title),
    config: { description: htmlText(p.description), printAreas: areas, variants, source: { provider: "merchize", catalogId, via: "teeinblue", teeinblueId: p.id, importedAt: new Date().toISOString(), photos } satisfies CtBaseSource },
  };
}

export async function importBase(s: CtSession, raw: unknown): Promise<NextResponse> {
  if (!(await isAdmin(s))) return jsonError("Chỉ admin import product base", 403);
  const b = raw && typeof raw === "object" ? (raw as Partial<Record<string, unknown>>) : {};
  const provider = asProvider(b.provider);
  const catalogId = typeof b.catalogId === "string" ? b.catalogId.trim().slice(0, 120) : "";
  if (!provider || !catalogId) return jsonError("Cần provider + catalogId", 400);
  const had = (await existingBases(s)).get(`${provider}:${catalogId.toUpperCase()}`);
  if (had) return jsonError(`Đã có product base “${had.name}” làm từ ${PROVIDER_NAME[provider]} ${catalogId}`, 409);
  try {
    const folder = `${provider}-${catalogId.replace(/[^a-z0-9_-]+/gi, "_")}`;
    let made: { name: string; config: Partial<CtBaseProductConfig> };
    let note: string;
    if (provider === "printbelle") {
      made = await fromPrintbelle(s, folder, await printbelleProduct(catalogId));
      note = `Import từ Printbelle (API) ${catalogId}`;
    } else {
      const { product, created } = await merchizeProduct(catalogId);
      made = await fromTeeinblue(s, folder, catalogId, product);
      note = `Import từ Merchize ${catalogId} qua Teeinblue (base #${product.id}${created ? ", đã archive bên Teeinblue" : ", base có sẵn bên Teeinblue — không đổi"})`;
    }
    const table = priceTableForTitle(await priceTables(s), made.name);
    const config = normalizeBaseConfig({
      ...made.config,
      productType: "",
      material: "none",
      priceTableId: table?.id ?? null,
      templateId: null,
      fulfillment: { provider: PROVIDER_NAME[provider], catalogId },
      notes: `${note} · ${new Date().toISOString().slice(0, 10)}`,
      cut: { mode: "none", borderMm: 0, silhouette: true, hole: false, holeSize: 9 },
    });
    const { data: last } = await s.supabase.from(CT_TABLES.baseProducts).select("sort_order").order("sort_order", { ascending: false }).limit(1).maybeSingle<{ sort_order: number }>();
    const { data, error } = await s.supabase
      .from(CT_TABLES.baseProducts)
      .insert({ user_id: s.user.id, name: made.name, config, sort_order: (last?.sort_order ?? 0) + 1 })
      .select("*")
      .single<CtBaseProduct>();
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ base: { ...data, config: normalizeBaseConfig(data.config) } }, { status: 201 });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Lỗi", 502);
  }
}

export async function getTeeinblueStatus(): Promise<NextResponse> {
  try {
    return NextResponse.json(await teeinblueStatus());
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Lỗi", 500);
  }
}

export async function setTeeinblue(s: CtSession, raw: unknown): Promise<NextResponse> {
  if (!(await isAdmin(s))) return jsonError("Chỉ admin kết nối Teeinblue", 403);
  const code = raw && typeof raw === "object" && typeof (raw as { code?: unknown }).code === "string" ? (raw as { code: string }).code : "";
  if (!code.trim()) return jsonError("Dán mã kết nối", 400);
  try {
    return NextResponse.json(await connectTeeinblue(code));
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Lỗi", 400);
  }
}
