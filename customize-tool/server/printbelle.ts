/**
 * Printbelle's public catalog API (asked 2026-11-11 — read straight from the fulfiller, not through Teeinblue).
 * "Search Base Products" needs no account: POST products/v2/base/page {searchName, showDescription, pageNum,
 * pageSize}; searchName matches the product code (productSpu) too. Each product carries its variants (size, colour,
 * order code, base cost, weight), print areas (px) and mockups (background photo + overlay + the 4 corners where the
 * artwork sits). Docs: Postman collection "Printbelle.com API Document" (documenter.gw.postman.com 2s93RL1vvB).
 */

const URL_PAGE = "https://fulfillment.printbelle.com/prod_api/api/products/v2/base/page";

export interface PbVariant {
  printAreaKey: string | null;
  size: string | null;
  color: string | null;
  colorHex: string | null;
  productCode: string;
  price: number | null;
  weight: number | null;
}

export interface PbMockup {
  width: string | number;
  height: string | number;
  layers: { background?: string; main?: string };
  zone: Array<{ x: number; y: number }>;
  artwork?: { width: number; height: number };
}

export interface PbProduct {
  productSpu: string;
  productNameEn: string;
  productImg: string | null;
  productPhotoCollection: string[] | null;
  desc: string | null;
  variantSku: PbVariant[] | null;
  printAreas: Array<{ key: string; title: string | null; width: number; height: number }> | null;
  mockups: PbMockup[] | null;
}

interface PbAnswer {
  code: number;
  msg: string | null;
  data: { total: number; list: PbProduct[] } | null;
}

export async function printbelleSearch(q: string, page: number, perPage: number, withDescription = false): Promise<{ total: number; list: PbProduct[] }> {
  const res = await fetch(URL_PAGE, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ searchName: q, showDescription: withDescription, pageNum: page, pageSize: perPage }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`Printbelle: HTTP ${res.status}`);
  const body = (await res.json()) as PbAnswer;
  if (body.code !== 200 || !body.data) throw new Error(`Printbelle: ${body.msg ?? `code ${body.code}`}`);
  return { total: body.data.total, list: body.data.list ?? [] };
}

/** One product by its code (productSpu), with its description. */
export async function printbelleProduct(spu: string): Promise<PbProduct> {
  const { list } = await printbelleSearch(spu, 1, 20, true);
  const p = list.find((x) => x.productSpu === spu);
  if (!p) throw new Error(`Printbelle không có sản phẩm ${spu}`);
  return p;
}
