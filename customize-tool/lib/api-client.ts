/**
 * Typed browser client for the Customize Tool API.
 */

import { CT_CONFIG } from "../config";
import type {
  CtCategoryHistoryEntry,
  CtPackImage,
  CtPackImageAspect,
  CtAgentStatus,
  CtAgentTask,
  CtAgentTaskInput,
  CtAgentTaskKind,
  CtCategoryRevision,
  CtCategorySnapshot,
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
  CtMaterialConfig,
  CtPhotoCapabilities,
  CtMockupPack,
  CtMockupPackBody,
  CtPreset,
  CtPresetBody,
  CtPresetKind,
  CtDetailsSuggestion,
  CtPresetHistoryEntry,
  CtPresetPromptSuggestion,
  CtPromptSuggestion,
  CtRefineSuggestBody,
  CtRefineSuggestion,
  CtProduct,
  CtProductBundle,
  CtProductListRow,
  CtPublishResponse,
  CtSaveDesignBody,
  CtStudioRunBody,
  CtStudioRunStatus,
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
  /** `force`: also take it out of the products that use it (otherwise 409 while used). */
  deleteClipart: (id: string, force = false) => call<void>(`library/cliparts/${id}${force ? "?force=1" : ""}`, { method: "DELETE" }),
  /**
   * Products using clipart `id` switch to `withId`, then `id` is deleted (AI refine "replace the old one"). Its đa sắc
   * move to `withId`; its vật liệu versions are deleted — or move too with `keepRenditions` (the caller makes them again).
   */
  replaceClipart: (id: string, withId: string, keepRenditions = false) =>
    call<{ usage: CtClipartUsage[]; moved: string[] }>(`library/cliparts/${id}/replace`, json("POST", { with: withId, ...(keepRenditions ? { keep_renditions: true } : {}) })),
  /** Material pictures of a clipart: vật liệu versions, their đa sắc, vật liệu of its đa sắc. */
  clipartMaterials: (id: string) => call<{ cliparts: CtAsset[] }>(`library/cliparts/${id}/materials`).then((r) => r.cliparts),
  clipartUsage: (id: string) => call<{ usage: CtClipartUsage[] }>(`library/cliparts/${id}/usage`).then((r) => r.usage),
  /** Move a product clipart (with its versions) into the library. */
  promoteAsset: (id: string, categoryId: string | null) =>
    call<{ assets: CtAsset[] }>(`assets/${id}/promote`, json("POST", { category_id: categoryId })).then((r) => r.assets),
  linkMain: (productId: string, assetId: string) =>
    call<{ assets: CtAsset[]; main_asset_id: string }>(`products/${productId}/mains`, json("POST", { asset_id: assetId })),
  unlinkMain: (productId: string, assetId: string) => call<void>(`products/${productId}/mains/${assetId}`, { method: "DELETE" }),

  listPacks: () => call<{ packs: CtMockupPack[]; admin: boolean }>("library/packs"),
  createPack: (body: CtMockupPackBody) => call<{ pack: CtMockupPack }>("library/packs", json("POST", body)).then((r) => r.pack),
  updatePack: (id: string, body: CtMockupPackBody) => call<{ pack: CtMockupPack }>(`library/packs/${id}`, json("PATCH", body)).then((r) => r.pack),
  deletePack: (id: string) => call<void>(`library/packs/${id}`, { method: "DELETE" }),
  /** Thư viện ảnh tổ hợp: newest first; scope "mine" = my uploads, "ai" = AI-made (with history). */
  listPackImages: (scope: "all" | "mine" | "ai" = "all", q = "") => {
    const params = new URLSearchParams({ scope });
    if (q) params.set("q", q);
    return call<{ images: CtPackImage[] }>(`library/pack-images?${params}`).then((r) => r.images);
  },
  getPackImage: (id: string) => call<{ image: CtPackImage }>(`library/pack-images/${id}`).then((r) => r.image),
  /** Saved as <name>_<timestamp>.<ext>. */
  uploadPackLibraryImage: (file: Blob, name: string) => {
    const form = new FormData();
    form.append("file", file);
    form.append("name", name);
    return call<{ image: CtPackImage }>("library/pack-images", { method: "POST", body: form }).then((r) => r.image);
  },
  /**
   * Starts a direct generation (status "running"): poll getPackImage. `refs` = library urls, `files` = new reference
   * photos; `prompt` = drawn as written (else a one-shot LLM writes it); `parentId` = the photo it edits (sent first).
   */
  generatePackImage: (body: {
    description: string;
    aspect: CtPackImageAspect;
    refs: string[];
    files: Blob[];
    prompt?: string;
    parentId?: string | null;
    transparent?: boolean;
  }) => {
    const form = new FormData();
    form.append("description", body.description);
    form.append("aspect", body.aspect);
    form.append("refs", JSON.stringify(body.refs));
    if (body.prompt) form.append("prompt", body.prompt);
    if (body.parentId) form.append("parent_id", body.parentId);
    if (body.transparent) form.append("transparent", "1");
    for (const f of body.files) form.append("ref", f);
    return call<{ image: CtPackImage }>("library/pack-images/generate", { method: "POST", body: form }).then((r) => r.image);
  },
  deletePackImage: (id: string) => call<void>(`library/pack-images/${id}`, { method: "DELETE" }),
  /** A background / overlay / slot sample picture for a pack. */
  uploadPackImage: (file: Blob) => {
    const form = new FormData();
    form.append("file", file);
    return call<{ url: string; width: number; height: number }>("library/packs/images", { method: "POST", body: form });
  },

  listPresets: (kind?: CtPresetKind) => call<{ presets: CtPreset[]; admin: boolean }>(`presets${kind ? `?kind=${kind}` : ""}`),
  createPreset: (body: CtPresetBody) => call<{ preset: CtPreset }>("presets", json("POST", body)).then((r) => r.preset),
  updatePreset: (id: string, body: CtPresetBody) => call<{ preset: CtPreset }>(`presets/${id}`, json("PATCH", body)).then((r) => r.preset),
  deletePreset: (id: string) => call<void>(`presets/${id}`, { method: "DELETE" }),
  /** A style pack's / material's analyses and saves, newest first (migration 008). */
  presetHistory: (id: string) => call<{ history: CtPresetHistoryEntry[] }>(`presets/${id}/history`).then((r) => r.history),
  /** A preset's reference photo → its public url (kept in params.refs). */
  uploadPresetRef: (file: Blob) => {
    const form = new FormData();
    form.append("file", file, "ref.png");
    return call<{ url: string }>("presets/refs", { method: "POST", body: form }).then((r) => r.url);
  },
  /**
   * Category dialog "Tạo bằng AI": name, spec, style pack, materials and details from a note / reference images,
   * reusing the library's presets when they fit (server/ai/prompt-writer.ts).
   */
  suggestCategoryPrompts: (body: { name: string; spec: string; note: string; images: Blob[] }) => {
    const form = new FormData();
    form.append("name", body.name);
    form.append("spec", body.spec);
    form.append("note", body.note);
    body.images.forEach((b, i) => form.append("file", b, `ref-${i}.jpg`));
    return call<CtPromptSuggestion>("ai/prompt-suggest", { method: "POST", body: form });
  },
  /**
   * Category dialog "Cập nhật bằng AI": what the editor dislikes (+ the numbered results, new photos uploaded
   * first) → what to change in spec / style pack / materials / details (server/ai/prompt-writer.ts).
   */
  suggestCategoryRevision: (body: { category: CtCategorySnapshot & { id: string | null }; note: string; images: Array<{ image: Blob; label: string; url: string }>; refUrls: string[] }) => {
    const form = new FormData();
    form.append("category", JSON.stringify(body.category));
    form.append("note", body.note);
    body.images.forEach((im, i) => {
      form.append("image_file", im.image, `result-${i + 1}.jpg`);
      form.append("image_label", im.label);
      form.append("image_url", im.url);
    });
    body.refUrls.forEach((u) => form.append("ref_url", u));
    return call<CtCategoryRevision>("ai/category-revise", { method: "POST", body: form });
  },
  /**
   * Category dialog "Kiểm tra prompt": the category's prompts read together as the image models get them →
   * conflicts found + their fixes as an ordinary plan (server/ai/prompt-review.ts).
   */
  reviewCategory: (category: CtCategorySnapshot & { id: string | null }) => {
    const form = new FormData();
    form.append("category", JSON.stringify(category));
    return call<CtCategoryRevision>("ai/category-review", { method: "POST", body: form });
  },
  /** Is the @flexiprint agent (agent_ide) configured and answering — server/agent/tasks.ts. */
  agentStatus: () => call<CtAgentStatus>("ai/agent-status"),
  /** Hand the dialog's AI work to the agent instead of the built-in LLM (migration 011). */
  createAgentTask: (body: { kind: CtAgentTaskKind; input: CtAgentTaskInput }) => call<CtAgentTask>("ai/agent-tasks", json("POST", body)),
  agentTask: (id: string) => call<CtAgentTask>(`ai/agent-tasks/${id}`),
  /** The editor's latest agent tasks of a kind, newest first. */
  listAgentTasks: (kind: CtAgentTaskKind) => call<{ tasks: CtAgentTask[] }>(`ai/agent-tasks?kind=${kind}`).then((r) => r.tasks),
  cancelAgentTask: (id: string) => call<CtAgentTask>(`ai/agent-tasks/${id}/cancel`, { method: "POST" }),
  /** Answer the agent's question (ask_user): it continues the task with it. */
  answerAgentTask: (id: string, body: { question_id: string; choices: string[]; text: string }) => call<CtAgentTask>(`ai/agent-tasks/${id}/answer`, json("POST", body)),
  /** A category's AI revisions and saves, newest first (migration 010). */
  categoryHistory: (id: string) => call<{ history: CtCategoryHistoryEntry[] }>(`library/categories/${id}/history`).then((r) => r.history),
  /** Category dialog "Chi tiết thành phẩm": the product's details from a description + photos (uploaded first). */
  suggestDetails: (body: { name: string; spec: string; note: string; refUrls: string[] }) => {
    const form = new FormData();
    form.append("name", body.name);
    form.append("spec", body.spec);
    form.append("note", body.note);
    body.refUrls.forEach((u) => form.append("ref_url", u));
    return call<CtDetailsSuggestion>("ai/details-suggest", { method: "POST", body: form });
  },
  /** Style pack / material dialog "Tạo prompt bằng AI": description + reference images → name + prompt. */
  suggestPresetPrompt: (body: { kind: "style_pack" | "material"; presetId: string | null; name: string; note: string; prompt: string; images: Blob[]; savedRefs: string[] }) => {
    const form = new FormData();
    form.append("kind", body.kind);
    if (body.presetId) form.append("preset_id", body.presetId);
    form.append("name", body.name);
    form.append("note", body.note);
    form.append("prompt", body.prompt);
    body.savedRefs.forEach((u) => form.append("ref_url", u));
    body.images.forEach((b, i) => form.append("file", b, `ref-${i}.jpg`));
    return call<CtPresetPromptSuggestion>("ai/preset-prompt", { method: "POST", body: form });
  },
  /** AI dialog "Chỉnh sửa": feedback on generated cliparts → edit instruction + optional spec / style rewrite. */
  suggestRefine: (body: CtRefineSuggestBody) => {
    const form = new FormData();
    form.append("fix", body.fix);
    // Parallel lists: the n-th url, name and spec are the same clipart.
    body.images.forEach((im, i) => {
      form.append("image_file", im.image, `clipart-${i + 1}.jpg`);
      form.append("image_name", im.name);
      form.append("image_spec", im.spec);
    });
    body.refs.forEach((b, i) => {
      form.append("file", b, `ref-${i}.jpg`);
      form.append("ref_name", body.refNames[i] ?? "");
    });
    form.append("category", JSON.stringify(body.category));
    form.append("style", JSON.stringify(body.style));
    if (body.updateSpec) form.append("update_spec", "1");
    if (body.updateStyle) form.append("update_style", "1");
    return call<CtRefineSuggestion>("ai/refine-suggest", { method: "POST", body: form });
  },

  /** Sets the fp_studio cookie the studio's nginx gate checks. */
  studioSession: () => call<{ url: string }>("studio/session", { method: "POST" }),
  /** AI dialog: the recipes run by ComfyUI (server/studio.ts). */
  studioModels: () => call<{ models: string[] }>("studio/models").then((r) => r.models),
  studioRun: (body: CtStudioRunBody) => call<{ run_id: string }>("studio/runs", json("POST", body)).then((r) => r.run_id),
  studioRunStatus: (runId: string) => call<CtStudioRunStatus>(`studio/runs/${runId}`),
  studioUploadRef: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return call<{ name: string }>("studio/refs", { method: "POST", body: form }).then((r) => r.name);
  },
  studioDraft: (body: CtStudioRunBody) => call<{ draft_id: string }>("studio/drafts", json("POST", body)).then((r) => r.draft_id),

};
