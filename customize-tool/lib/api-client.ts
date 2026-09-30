/**
 * Typed browser client for the Customize Tool API.
 */

import { CT_CONFIG } from "../config";
import type {
  CtAiProviderInfo,
  CtAiStyle,
  CtAiStyleBody,
  CtApiError,
  CtAsset,
  CtAssetMeta,
  CtAssetRole,
  CtAssetSource,
  CtCategoryBody,
  CtClipartCategory,
  CtClipartUsage,
  CtGenerateBody,
  CtGenerateResponse,
  CtMaterialConfig,
  CtPhotoCapabilities,
  CtPreset,
  CtPresetBody,
  CtPresetKind,
  CtProduct,
  CtProductBundle,
  CtProductListRow,
  CtPublishResponse,
  CtSaveDesignBody,
  CtUpdateAssetBody,
  CtUpdateClipartBody,
  CtUpdateProductBody,
} from "../types";

export interface CtUploadClipartOpts {
  categoryId: string | null;
  parentId?: string | null;
  rendition?: boolean;
  name?: string;
  spec?: string;
  tags?: string[];
  source?: CtAssetSource;
  meta?: CtAssetMeta;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${CT_CONFIG.apiBase}/${path}`, init);
  if (res.status === 204) return undefined as T;
  const body: T | CtApiError = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) {
    throw new Error((body as CtApiError).error ?? `HTTP ${res.status}`);
  }
  return body as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const ctApi = {
  providers: () => call<{ providers: CtAiProviderInfo[] }>("ai/providers").then((r) => r.providers),
  photoCapabilities: () => call<CtPhotoCapabilities>("ai/photo"),
  /** Server step of customer-photo processing, for lib/photo-process.ts. */
  photoEndpoint: (productId: string) => `${CT_CONFIG.apiBase}/products/${productId}/photo`,

  listProducts: (q: string) =>
    call<{ products: CtProductListRow[] }>(`products?q=${encodeURIComponent(q)}`).then((r) => r.products),
  createProduct: (name: string) => call<{ product: CtProduct }>("products", json("POST", { name })).then((r) => r.product),
  getBundle: (id: string) => call<CtProductBundle>(`products/${id}`),
  updateProduct: (id: string, body: CtUpdateProductBody) =>
    call<{ product: CtProduct }>(`products/${id}`, json("PATCH", body)).then((r) => r.product),
  deleteProduct: (id: string) => call<void>(`products/${id}`, { method: "DELETE" }),
  saveDesign: (id: string, body: CtSaveDesignBody) => call<{ ok: true }>(`products/${id}/design`, json("PUT", body)),
  publish: (id: string) => call<{ product: CtProduct; publish: CtPublishResponse }>(`products/${id}/publish`, { method: "POST" }),

  uploadAsset: (
    productId: string,
    file: Blob,
    opts: { role: CtAssetRole; parentId?: string | null; name?: string; meta?: CtAssetMeta },
  ) => {
    const form = new FormData();
    form.append("file", file, file instanceof File ? file.name : `${opts.role}.png`);
    form.append("role", opts.role);
    if (opts.parentId) form.append("parent_id", opts.parentId);
    if (opts.name) form.append("name", opts.name);
    if (opts.meta) form.append("meta", JSON.stringify(opts.meta));
    return call<{ asset: CtAsset }>(`products/${productId}/assets`, { method: "POST", body: form }).then((r) => r.asset);
  },
  updateAsset: (id: string, body: CtUpdateAssetBody) =>
    call<{ asset: CtAsset }>(`assets/${id}`, json("PATCH", body)).then((r) => r.asset),
  replaceAssetFile: (id: string, file: Blob) => {
    const form = new FormData();
    form.append("file", file, "asset.png");
    return call<{ asset: CtAsset }>(`assets/${id}/file`, { method: "PUT", body: form }).then((r) => r.asset);
  },
  deleteAsset: (id: string) => call<void>(`assets/${id}`, { method: "DELETE" }),

  listAiStyles: () => call<{ styles: CtAiStyle[]; admin: boolean }>("ai-styles"),
  createAiStyle: (body: CtAiStyleBody) => call<{ style: CtAiStyle }>("ai-styles", json("POST", body)).then((r) => r.style),
  updateAiStyle: (id: string, body: CtAiStyleBody) => call<{ style: CtAiStyle }>(`ai-styles/${id}`, json("PATCH", body)).then((r) => r.style),
  deleteAiStyle: (id: string) => call<void>(`ai-styles/${id}`, { method: "DELETE" }),

  /** Print files + cut path (zip) for the product's material — services/material-render. */
  printPack: async (productId: string, body: { design: Blob; main: Blob | null; material: CtMaterialConfig; dpi: number }): Promise<Blob> => {
    const form = new FormData();
    form.append("file", body.design, "design.png");
    if (body.main) form.append("main", body.main, "main.png");
    form.append("material", JSON.stringify(body.material));
    form.append("dpi", String(body.dpi));
    const res = await fetch(`${CT_CONFIG.apiBase}/products/${productId}/print-pack`, { method: "POST", body: form });
    if (!res.ok) {
      const err: CtApiError = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error);
    }
    return res.blob();
  },

  // ------------------------------------------------------------ clipart library
  listCategories: () => call<{ categories: CtClipartCategory[]; uncategorized: number; admin: boolean }>("library/categories"),
  createCategory: (body: CtCategoryBody) => call<{ category: CtClipartCategory }>("library/categories", json("POST", body)).then((r) => r.category),
  updateCategory: (id: string, body: CtCategoryBody) =>
    call<{ category: CtClipartCategory }>(`library/categories/${id}`, json("PATCH", body)).then((r) => r.category),
  deleteCategory: (id: string) => call<void>(`library/categories/${id}`, { method: "DELETE" }),
  /** category: id, "none" (uncategorized) or null (all). */
  listCliparts: (category: string | null, q = "") => {
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (q) params.set("q", q);
    return call<{ cliparts: CtAsset[] }>(`library/cliparts?${params}`).then((r) => r.cliparts);
  },
  uploadClipart: (file: Blob, opts: CtUploadClipartOpts) => {
    const form = new FormData();
    form.append("file", file, file instanceof File ? file.name : "clipart.png");
    if (opts.categoryId) form.append("category_id", opts.categoryId);
    if (opts.parentId) form.append("parent_id", opts.parentId);
    if (opts.rendition) form.append("rendition", "1");
    if (opts.name) form.append("name", opts.name);
    if (opts.spec) form.append("spec", opts.spec);
    if (opts.tags) form.append("tags", JSON.stringify(opts.tags));
    if (opts.source) form.append("source", opts.source);
    if (opts.meta) form.append("meta", JSON.stringify(opts.meta));
    return call<{ clipart: CtAsset }>("library/cliparts", { method: "POST", body: form }).then((r) => r.clipart);
  },
  updateClipart: (id: string, body: CtUpdateClipartBody) =>
    call<{ clipart: CtAsset }>(`library/cliparts/${id}`, json("PATCH", body)).then((r) => r.clipart),
  deleteClipart: (id: string) => call<void>(`library/cliparts/${id}`, { method: "DELETE" }),
  clipartUsage: (id: string) => call<{ usage: CtClipartUsage[] }>(`library/cliparts/${id}/usage`).then((r) => r.usage),
  /** Move a product clipart (with its versions) into the library. */
  promoteAsset: (id: string, categoryId: string | null) =>
    call<{ assets: CtAsset[] }>(`assets/${id}/promote`, json("POST", { category_id: categoryId })).then((r) => r.assets),
  linkMain: (productId: string, assetId: string) =>
    call<{ assets: CtAsset[]; main_asset_id: string }>(`products/${productId}/mains`, json("POST", { asset_id: assetId })),
  unlinkMain: (productId: string, assetId: string) => call<void>(`products/${productId}/mains/${assetId}`, { method: "DELETE" }),

  listPresets: (kind?: CtPresetKind) => call<{ presets: CtPreset[]; admin: boolean }>(`presets${kind ? `?kind=${kind}` : ""}`),
  createPreset: (body: CtPresetBody) => call<{ preset: CtPreset }>("presets", json("POST", body)).then((r) => r.preset),
  updatePreset: (id: string, body: CtPresetBody) => call<{ preset: CtPreset }>(`presets/${id}`, json("PATCH", body)).then((r) => r.preset),
  deletePreset: (id: string) => call<void>(`presets/${id}`, { method: "DELETE" }),

  /** Sets the fp_studio cookie the studio's nginx gate checks. */
  studioSession: () => call<{ url: string }>("studio/session", { method: "POST" }),

  generate: (productId: string, body: CtGenerateBody) =>
    call<CtGenerateResponse>(`products/${productId}/generate`, json("POST", body)),
};
