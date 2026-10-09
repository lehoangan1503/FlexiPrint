/**
 * Browser client of the khuôn in API (server/print-templates.ts, server/print-products.ts).
 */

import { CT_CONFIG } from "../config";
import type { CtApiError, CtProduct } from "../types";
import type { CtPrintKind, CtPrintSpec, CtPrintTemplate } from "../types/print";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${CT_CONFIG.apiBase}/${path}`, init);
  if (res.status === 204) return undefined as T;
  const body: T | CtApiError = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error((body as CtApiError).error ?? `HTTP ${res.status}`);
  return body as T;
}

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export interface CtPrintTemplateBody {
  name: string;
  kind: CtPrintKind;
  spec: CtPrintSpec;
}

export const printApi = {
  list: () => call<{ templates: CtPrintTemplate[] }>("print-templates").then((r) => r.templates),
  create: (body: CtPrintTemplateBody) => call<{ template: CtPrintTemplate }>("print-templates", json("POST", body)).then((r) => r.template),
  update: (id: string, body: Partial<CtPrintTemplateBody>) => call<{ template: CtPrintTemplate }>(`print-templates/${id}`, json("PATCH", body)).then((r) => r.template),
  remove: (id: string) => call<void>(`print-templates/${id}`, { method: "DELETE" }),
  uploadImage: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return call<{ url: string; width: number; height: number }>("print-templates/images", { method: "POST", body: form });
  },
  /** A product on the template: its canvas = the sheet, the cut line = its khuôn vật liệu. */
  createProduct: (templateId: string, name: string) => call<{ product: CtProduct }>("products/from-template", json("POST", { templateId, name })).then((r) => r.product),
};
