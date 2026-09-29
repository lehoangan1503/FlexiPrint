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
  CtGenerateBody,
  CtGenerateResponse,
  CtMaterialConfig,
  CtPhotoCapabilities,
  CtProduct,
  CtProductBundle,
  CtProductListRow,
  CtPublishResponse,
  CtSaveDesignBody,
  CtUpdateAssetBody,
  CtUpdateProductBody,
} from "../types";

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

  generate: (productId: string, body: CtGenerateBody) =>
    call<CtGenerateResponse>(`products/${productId}/generate`, json("POST", body)),
};
