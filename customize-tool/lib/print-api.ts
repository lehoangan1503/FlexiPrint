/**
 * Browser client of the khuôn in API (server/print-templates.ts, server/print-products.ts).
 */

import { CT_CONFIG } from "../config";
import type { CtApiError, CtProduct } from "../types";
import type { CtPrintAiRequest, CtPrintAiResult, CtPrintFace, CtPrintKind, CtPrintSpec, CtPrintTemplate } from "../types/print";

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
  /** The khuôn drawn by AI (not saved): a new one, a change of `templateId`'s, or of an unsaved round (`base`). */
  ai: (body: CtPrintAiRequest & { name: string; base: CtPrintFace[] }) => call<CtPrintAiResult>("print-templates/ai", json("POST", body)),
  /** A phôi photo of the khuôn (its box found on it). */
  uploadBlank: (id: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    form.append("name", file.name.replace(/\.[a-z0-9]+$/i, ""));
    return call<{ template: CtPrintTemplate }>(`print-templates/${id}/blanks`, { method: "POST", body: form }).then((r) => r.template);
  },
  /** A phôi drawn by AI from the khuôn. */
  aiBlank: (id: string) => call<{ template: CtPrintTemplate }>(`print-templates/${id}/blanks/ai`, json("POST", {})).then((r) => r.template),
  /** A product on the template: its canvas = the sheet, the cut line = its khuôn vật liệu. */
  createProduct: (templateId: string, name: string) => call<{ product: CtProduct }>("products/from-template", json("POST", { templateId, name })).then((r) => r.product),
};
