/**
 * Typed browser client for the Customize Tool API.
 */

import { CT_CONFIG } from "../config";
import { jobFetch } from "./job-fetch";
import type { CtPrintTemplate } from "../types/print";
import type { CtBehindStage, CtCharPhotoStyle, CtCharVersionCard,
  CtPackImage,
  CtAgentStatus,
  CtAgentTask,
  CtCharChatAttachment,
  CtCharChatTab,
  CtAgentTaskInput,
  CtAgentTaskKind,
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
  CtPresetKind,
  CtDeployBody,
  CtDeployResponse,
  CtPriceTable,
  CtPriceTableBody,
  CtShopifyCollection,
  CtShopifyInfo,
  CtShopifyProductSummary,
  CtProduct,
  CtProductBundle,
  CtProductListRow,
  CtPublishResponse,
  CtSaveDesignBody,
  CtSelection,
  CtUpdateAssetBody,
  CtUpdateClipartBody,
  CtUpdateProductBody,
  CtCharBrief,
  CtCharIdeaRound,
  CtCharImage,
  CtCharProject,
  CtProductArtworks,
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
  const res = await jobFetch(`${CT_CONFIG.apiBase}/${path}`, init);
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
  deploy: (id: string, body: CtDeployBody) => call<CtDeployResponse>(`products/${id}/deploy`, json("POST", body)),
  shopifyInfo: (id: string) => call<CtShopifyInfo>(`products/${id}/shopify`),
  searchShopifyProducts: (q: string) =>
    call<{ products: CtShopifyProductSummary[] }>(`shopify/products?q=${encodeURIComponent(q)}`).then((r) => r.products),

  listCollections: () => call<{ collections: CtShopifyCollection[] }>("shopify/collections").then((r) => r.collections),
  createCollection: (title: string) => call<{ collection: CtShopifyCollection }>("shopify/collections", json("POST", { title })).then((r) => r.collection),


  listPriceTables: () => call<{ tables: CtPriceTable[] }>("price-tables").then((r) => r.tables),
  createPriceTable: (body: CtPriceTableBody) => call<{ table: CtPriceTable }>("price-tables", json("POST", body)).then((r) => r.table),
  updatePriceTable: (id: string, body: CtPriceTableBody) => call<{ table: CtPriceTable }>(`price-tables/${id}`, json("PATCH", body)).then((r) => r.table),
  deletePriceTable: (id: string) => call<void>(`price-tables/${id}`, { method: "DELETE" }),

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
  makeAiStyleDemo: (id: string, sample?: File) => {
    const form = new FormData();
    if (sample) form.set("sample", sample);
    return call<{ style: CtAiStyle }>(`ai-styles/${id}/demo`, { method: "POST", body: form }).then((r) => r.style);
  },

  /** The product's folder in the library and the artworks saved into it (server/artworks.ts). */
  productArtworks: (productId: string) => call<CtProductArtworks>(`products/${productId}/artworks`),
  /** A version's artwork (replaced in place) or, without versionId, one more artwork. */
  saveProductArtwork: (productId: string, file: Blob, opts: { versionId?: string; hash?: string; name: string; selection: CtSelection }) => {
    const form = new FormData();
    form.append("file", file, "artwork.png");
    if (opts.versionId) form.append("versionId", opts.versionId);
    if (opts.hash) form.append("hash", opts.hash);
    form.append("name", opts.name);
    form.append("selection", JSON.stringify(opts.selection));
    return call<{ artwork: CtAsset }>(`products/${productId}/artworks`, { method: "POST", body: form });
  },
  pruneProductArtworks: (productId: string, versionIds: string[]) => call<{ removed: number }>(`products/${productId}/artworks/prune`, json("POST", { versionIds })),
  /** AI mockups of the product (server/product-mockups.ts): jobs newest first. */
  mockupJobs: (productId: string) => call<{ jobs: CtPackImage[] }>(`products/${productId}/mockups`).then((r) => r.jobs),
  /** The artwork laid on the phôi (exact) + one AI photo per scene (running in the background). */
  makeMockups: (productId: string, print: Blob, scenes: string[]) => {
    const form = new FormData();
    form.append("print", print, "print.png");
    form.append("scenes", JSON.stringify(scenes));
    return call<{ jobs: CtPackImage[]; front: CtAsset }>(`products/${productId}/mockups`, { method: "POST", body: form });
  },
  /** An AI phôi trơn from the product's khuôn in → config.scene. */
  makeBlank: (productId: string) => call<{ product: CtProduct; asset: CtAsset }>(`products/${productId}/blank`, json("POST", {})),

  /** Print files + cut path (zip) for the product's material — services/material-render. */
  printPack: async (productId: string, body: { design: Blob; main: Blob | null; material: CtMaterialConfig; dpi: number }): Promise<Blob> => {
    const form = new FormData();
    form.append("file", body.design, "design.png");
    if (body.main) form.append("main", body.main, "main.png");
    form.append("material", JSON.stringify(body.material));
    form.append("dpi", String(body.dpi));
    const res = await jobFetch(`${CT_CONFIG.apiBase}/products/${productId}/print-pack`, { method: "POST", body: form });
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
  /** Thư viện ảnh mockup: newest first; scope "mine" = my uploads. */
  listPackImages: (scope: "all" | "mine" = "all", q = "") => {
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
  deletePackImage: (id: string) => call<void>(`library/pack-images/${id}`, { method: "DELETE" }),
  /** A background / overlay / slot sample picture for a pack. */
  uploadPackImage: (file: Blob) => {
    const form = new FormData();
    form.append("file", file);
    return call<{ url: string; width: number; height: number }>("library/packs/images", { method: "POST", body: form });
  },

  listPresets: (kind?: CtPresetKind) => call<{ presets: CtPreset[]; admin: boolean }>(`presets${kind ? `?kind=${kind}` : ""}`),
  /** Is the @flexiprint agent (agent_ide) configured and answering — server/agent/tasks.ts. */
  agentStatus: () => call<CtAgentStatus>("ai/agent-status"),
  /** Hand work to the @flexiprint agent (kind content | char, migration 011). */
  createAgentTask: (body: { kind: CtAgentTaskKind; input: CtAgentTaskInput }) => call<CtAgentTask>("ai/agent-tasks", json("POST", body)),
  agentTask: (id: string) => call<CtAgentTask>(`ai/agent-tasks/${id}`),
  /** The editor's latest agent tasks of a kind, newest first. */
  listAgentTasks: (kind: CtAgentTaskKind, collection: string | null = null) =>
    call<{ tasks: CtAgentTask[] }>(`ai/agent-tasks?kind=${kind}${collection ? `&collection=${collection}` : ""}`).then((r) => r.tasks),
  cancelAgentTask: (id: string) => call<CtAgentTask>(`ai/agent-tasks/${id}/cancel`, { method: "POST" }),
  /** Answer the agent's question (ask_user): it continues the task with it. */
  answerAgentTask: (id: string, body: { question_id: string; choices: string[]; text: string }) => call<CtAgentTask>(`ai/agent-tasks/${id}/answer`, json("POST", body)),
  injectAgentTask: (id: string, body: { text: string; attachments: CtCharChatAttachment[]; tab: CtCharChatTab; section: string }) => call<CtAgentTask>(`ai/agent-tasks/${id}/inject`, json("POST", body)),

};

/** v2 bộ nhân vật (server/char/projects.ts). */
export const charApi = {
  list: () => call<{ projects: CtCharProject[]; thumbs: Record<string, string> }>("char/projects"),
  create: (body: { name: string; brief?: CtCharBrief }) => call<{ project: CtCharProject }>("char/projects", json("POST", body)).then((r) => r.project),
  get: (id: string) => call<{ project: CtCharProject; images: CtCharImage[] }>(`char/projects/${id}`),
  /** A lineup drawn version by version: each smaller version's own set (server/char/versions.ts). */
  versions: (id: string) => call<{ versions: CtCharVersionCard[] }>(`char/projects/${id}/versions`).then((r) => r.versions),
  /** An idea's preview picture becomes a master candidate (the editor took that direction). */
  adoptMaster: (id: string, imageId: string) => call<{ image: CtCharImage }>(`char/projects/${id}/masters/${imageId}/adopt`, json("POST", {})).then((r) => r.image),
  update: (id: string, body: { name?: string; brief?: CtCharBrief }) => call<{ project: CtCharProject }>(`char/projects/${id}`, json("PATCH", body)).then((r) => r.project),
  remove: (id: string) => call<{ ok: true }>(`char/projects/${id}`, { method: "DELETE" }),
  upload: (id: string, file: File, kind: "ref" | "blank") => {
    const form = new FormData();
    form.append("file", file);
    form.append("kind", kind);
    return call<{ image: CtCharImage }>(`char/projects/${id}/files`, { method: "POST", body: form }).then((r) => r.image);
  },
  /** A screenshot / picture for the sticky chat (stored, no image row) → its url. */
  chatFile: (id: string, file: Blob) => {
    const form = new FormData();
    form.append("file", file, "chat.png");
    return call<{ url: string; width: number; height: number }>(`char/projects/${id}/chat-files`, { method: "POST", body: form });
  },
  /** The editor's own khuôn in as a picture → a new khuôn (Thư viện → Khuôn in) the brief can point at. */
  uploadKhuon: (id: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return call<{ template: CtPrintTemplate }>(`char/projects/${id}/khuon`, { method: "POST", body: form }).then((r) => r.template);
  },
  /** (Re)draw the AI khuôn from the approved master (then its phôi trơn). */
  khuonAi: (id: string) => call<{ image: CtCharImage }>(`char/projects/${id}/khuon`, json("POST", {})).then((r) => r.image),
  masters: (id: string, body: { prompt?: string; count?: number }) => call<{ images: CtCharImage[] }>(`char/projects/${id}/masters`, json("POST", body)).then((r) => r.images),
  refine: (id: string, imageId: string, note: string) => call<{ image: CtCharImage }>(`char/projects/${id}/masters/${imageId}/refine`, json("POST", { note })).then((r) => r.image),
  approve: (id: string, imageId: string | null) => call<{ project: CtCharProject }>(`char/projects/${id}/approve`, json("POST", { imageId })).then((r) => r.project),
  /** Make the planned edits still missing (or `roles` again). */
  edits: (id: string, roles?: string[]) => call<{ images: CtCharImage[] }>(`char/projects/${id}/edits`, json("POST", roles ? { roles } : {})).then((r) => r.images),
  createProduct: (id: string, name: string) => call<{ productId: string }>(`char/projects/${id}/products`, json("POST", { name })).then((r) => r.productId),
  /** (Re)make the AI phôi trơn from the brief's khuôn in (server/char/blank.ts). */
  blank: (id: string) => call<{ image: CtCharImage }>(`char/projects/${id}/blank`, json("POST", {})).then((r) => r.image),
  /** The set's product built again (new backgrounds / texts), replacing the set's products. */
  remakeProduct: (id: string) => call<{ productId: string }>(`char/projects/${id}/products/remake`, json("POST", {})),
  /** A bộ ảnh khách: (re)draw element pictures — every missing one, or `roles` (server/char/elements.ts). */
  elements: (id: string, roles: string[] = [], prompts: Record<string, string> = {}) => call<{ images: CtCharImage[] }>(`char/projects/${id}/elements`, json("POST", { roles, prompts })).then((r) => r.images),
  /** A bộ ảnh khách's own AI styles (server/char/photo-styles.ts). */
  photoStyles: (id: string) => call<{ styles: CtCharPhotoStyle[] }>(`char/projects/${id}/photo-styles`).then((r) => r.styles),
  savePhotoStyle: (id: string, body: { id?: string; name: string; prompt: string; refUrls?: string[] }) => call<{ styles: CtCharPhotoStyle[]; project: CtCharProject }>(`char/projects/${id}/photo-styles`, json("POST", body)),
  removePhotoStyle: (id: string, styleId: string) => call<{ styles: CtCharPhotoStyle[]; project: CtCharProject }>(`char/projects/${id}/photo-styles/${styleId}`, { method: "DELETE" }),
  testPhotoStyles: (id: string, styleIds: string[] = [], photos: string[] = []) => call<{ images: CtCharImage[] }>(`char/projects/${id}/photo-styles/test`, json("POST", { styleIds, photos })).then((r) => r.images),
  styleDemo: (id: string, styleId: string, imageId: string) => call<{ styles: CtCharPhotoStyle[] }>(`char/projects/${id}/photo-styles/demo`, json("POST", { styleId, imageId })).then((r) => r.styles),
  styleTestPhotos: (id: string, photos: string[]) => call<{ project: CtCharProject }>(`char/projects/${id}/photo-styles/photos`, json("POST", { photos })).then((r) => r.project),
  orderPhotoStyles: (id: string, styleIds: string[]) => call<{ project: CtCharProject }>(`char/projects/${id}/photo-styles/order`, json("POST", { styleIds })).then((r) => r.project),
  /** (Re)draw the brief's backgrounds — all, or `ids` (server/char/backdrops.ts). */
  backdrops: (id: string, ids: string[] = []) => call<{ images: CtCharImage[] }>(`char/projects/${id}/backdrops`, json("POST", { ids })).then((r) => r.images),

  buildLayers: (id: string) => call<{ project: CtCharProject }>(`char/projects/${id}/layers`, json("POST", {})).then((r) => r.project),
  approveLayers: (id: string, approved: boolean) => call<{ project: CtCharProject }>(`char/projects/${id}/layers/approve`, json("POST", { approved })).then((r) => r.project),
  /** The cut reviewed on the master (server/char/cut.ts): step "matte" (the backdrop) or "plan" (layer regions). */
  cut: (id: string, step: "matte" | "plan", action?: "fix" | "region" | "revert" | "approve", body: Record<string, unknown> = {}) =>
    call<{ project: CtCharProject }>(`char/projects/${id}/${step}${action ? `/${action}` : ""}`, json("POST", body)).then((r) => r.project),
  /** One clipart file edited by hand: its new alpha on the set's canvas → files, thumbnails, products replaced. */
  /** A hand edit of one clipart: its new mask (null = unchanged) and / or a move of its option (whole px). */
  editFile: (id: string, imageId: string, mask: string | null, move?: { dx: number; dy: number } | null) =>
    call<{ project: CtCharProject }>(`char/projects/${id}/layers/file`, json("POST", { imageId, mask, move: move ?? null })).then((r) => r.project),
  /** A pose set's "phần nằm sau" of one layer (server/char/behind.ts): its mask, or null to clear it. */
  /** The parent's biggest version, whole, split at this layer's copies (the "phần nằm sau" editor — server/char/behind.ts). */
  behindStage: (id: string, slot: string, option: string) => call<CtBehindStage>(`char/projects/${id}/layers/behind/stage`, json("POST", { slot, option })),
  setBehind: (id: string, slot: string, mask: string | null) => call<{ project: CtCharProject }>(`char/projects/${id}/layers/behind`, json("POST", { slot, mask })).then((r) => r.project),
  revertFile: (id: string, imageId: string) => call<{ project: CtCharProject }>(`char/projects/${id}/layers/file/revert`, json("POST", { imageId })).then((r) => r.project),
};
