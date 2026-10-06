/**
 * One catch-all dispatcher for the whole API, so the host needs a single
 * route shim (src/app/api/customize-tool/[...path]/route.ts):
 *
 *   GET    ai/providers
 *   GET    products?q=
 *   POST   products                      { name }
 *   GET    products/:id                  → CtProductBundle
 *   PATCH  products/:id                  CtUpdateProductBody
 *   DELETE products/:id
 *   PUT    products/:id/design           CtSaveDesignBody
 *   POST   products/:id/publish          → snapshot into ct_templates (Shopify)
 *   POST   products/:id/deploy           CtDeployBody → publish + Shopify product with the price table's variants (server/shopify.ts)
 *   GET    products/:id/shopify          → CtShopifyInfo (shop + the linked Shopify product now)
 *   GET    shopify/products?q=           → { products } Shopify products to deploy onto
 *   GET    shopify/collections · POST {title}  → collections (deploy page badges; the starred one = breadcrumb)
 *   GET    settings/image-model · PUT { model }           model ảnh AI cho cả team (server/settings.ts)
 *   GET    price-tables · POST CtPriceTableBody · PATCH :id · DELETE :id   bảng giá (server/price-tables.ts)
 *   POST   products/:id/assets           multipart: file, role, parent_id?, name?, meta?
 *   (AI generation runs in the ComfyUI studio — server/studio.ts, services/comfy)
 *   PATCH  assets/:id                    CtUpdateAssetBody
 *   DELETE assets/:id
 *   PUT    assets/:id/file              multipart: file  (replace image, keep id)
 *
 * Public (no session, CORS *) — used by the Shopify section:
 *   GET    public/templates/:productId[?version=N]   → CtTemplate
 *   POST   public/uploads/:productId     multipart: file, kind=photo|preview
 *   POST   public/photo/:productId       multipart: file, region, style, cutout=0|1 → processed image bytes
 *
 * MCP (session cookie, or Bearer CT_COMFY_TOKEN for agents / the studio):
 *   POST   mcp                           flexiprint-mcp, JSON-RPC 2.0 (server/mcp): Bearer CT_AGENT_TOKEN (agent) | CT_COMFY_TOKEN (studio) | cookie
 *
 * Cron (Bearer CT_CRON_SECRET, no session):
 *   POST   cron/cleanup                  delete cached photo results older than 24 h
 *
 * Editor photo tools:
 *   GET    ai/photo                      → { ai, cutout, aiStyles } capabilities
 *   POST   ai/refine-suggest             multipart: keep, fix, image_url×n, file×≤4, category, style, update_spec, update_style → CtRefineSuggestion
 *   POST   ai/prompt-suggest             multipart: name?, spec?, note?, file×≤4 → CtPromptSuggestion (category dialog; reuses library presets)
 *   POST   ai/category-revise            multipart: category (JSON {id?, name, spec, rules}), note, image_file/image_label/image_url×≤12 (numbered results), ref_url×≤4 → CtCategoryRevision (recorded in ct_category_history)
 *   POST   ai/category-review            multipart: category (JSON {id?, name, spec, rules}) → CtCategoryRevision: the prompts checked as assembled, fixes as a plan (server/ai/prompt-review.ts)
 *   GET    ai/agent-status               → CtAgentStatus (the @flexiprint agent on agent_ide: configured / online)
 *   GET    ai/agent-tasks?kind=          → { tasks } the editor's latest (photo library history: kind pack_image)
 *   POST   ai/agent-tasks                {kind: create|revise|pack_image, input: CtAgentTaskInput} → CtAgentTask, sent to agent_ide (server/agent/tasks.ts)
 *   GET    ai/agent-tasks/:id            → CtAgentTask (progress, then result in the built-in LLM's shape)
 *   POST   ai/agent-tasks/:id/answer     {question_id, choices, text} — answer the agent's question (ask_user)
 *   POST   ai/agent-tasks/:id/cancel
 *   POST   ai/details-suggest            multipart: name, spec, note, ref_url×≤6, file×≤4 → CtDetailsSuggestion (category's chi tiết thành phẩm)
 *   POST   ai/preset-prompt              multipart: kind, preset_id?, name?, note, prompt?, ref_url×≤6, file×≤4 → CtPresetPromptSuggestion (recorded in the preset's history)
 *   POST   products/:id/photo            multipart: file, style, cutout=0|1 → processed image bytes
 *   POST   products/:id/print-pack       multipart: file (flat design), main?, material, dpi? → zip (services/material-render)
 *
 * AI photo-style library (global; owner or admin edits, see server/ai-styles.ts):
 *   GET    ai-styles                     → { styles: CtAiStyle[], admin }
 *   POST   ai-styles                     CtAiStyleBody
 *   PATCH  ai-styles/:id                 CtAiStyleBody
 *   DELETE ai-styles/:id                 → 204
 *
 * Clipart library (global, migration 006; see server/library.ts):
 *   GET    library/categories            → { categories, uncategorized, admin }
 *   POST   library/categories            CtCategoryBody
 *   PATCH  library/categories/:id        CtCategoryBody
 *   DELETE library/categories/:id        409 while it holds cliparts / sub-categories
 *   GET    library/categories/:id/history → { history: CtCategoryHistoryEntry[] } (AI revisions + saves, migration 010)
 *   GET    library/cliparts?category=<id|none>&q=   → { cliparts } (origins + members + renditions)
 *   POST   library/cliparts              multipart: file, category_id?, parent_id?, rendition=1?, name?, spec?, tags?, source?, meta?
 *   PATCH  library/cliparts/:id          CtUpdateClipartBody
 *   DELETE library/cliparts/:id[?force=1] 409 while a product uses it; force = take it out of those products, then delete
 *   POST   library/cliparts/:id/replace  { with, keep_renditions? } — products using it switch to clipart `with`, then it is deleted
 *                                       (keep_renditions: its vật liệu versions move to `with` too, to be made again)
 *   GET    library/cliparts/:id/usage    → { usage: CtClipartUsage[] }
 *   GET    library/cliparts/:id/materials → { cliparts } its vật liệu, their đa sắc, vật liệu of its đa sắc
 *   POST   assets/:id/promote            { category_id } — move a product clipart into the library
 *   POST   products/:id/mains            { asset_id } — use a library main as a version
 *   DELETE products/:id/mains/:assetId
 *   GET    library/packs                 → { packs, admin }  mockup packs (server/mockup-packs.ts)
 *   POST   library/packs                 CtMockupPackBody
 *   PATCH  library/packs/:id             CtMockupPackBody
 *   DELETE library/packs/:id
 *   POST   library/packs/images          multipart file → { url, width, height }
 *   GET    library/pack-images?q=&scope= → { images }  thư viện ảnh tổ hợp (server/pack-images.ts)
 *   POST   library/pack-images           multipart file, name → { image }
 *   POST   library/pack-images/generate  multipart description, aspect, refs, ref files → { image } (running)
 *   GET    library/pack-images/:id       → { image }
 *   DELETE library/pack-images/:id
 *   GET    library/pack-collections · POST {name} · PATCH :id {name}   bộ ảnh
 *   GET    presets?kind=                 → { presets, admin }  (style_pack | material | scene)
 *   POST   presets                       CtPresetBody
 *   PATCH  presets/:id                   CtPresetBody
 *   DELETE presets/:id
 *   POST   presets/refs                  multipart file → { url }  (a preset's reference photo)
 *   GET    presets/:id/history           → { history: CtPresetHistoryEntry[] }  (analyses + saves, newest first)
 *
 * ComfyUI studio (server/studio.ts):
 *   POST   studio/session                sets the fp_studio cookie → { url }
 *   GET    studio/models                 → { models }  (AI dialog)
 *   POST   studio/runs                   CtStudioRunBody → { run_id }  — one of the 4 recipes, run by ComfyUI
 *   GET    studio/runs/:id               → CtStudioRunStatus
 *   POST   studio/drafts                 CtStudioRunBody → { draft_id }  — same graph, opened in the studio
 *   POST   studio/refs                   multipart file → { name }  — reference photo for the origin recipe
 *   GET    studio/auth                   nginx auth_request (cookie, no session) → 204 | 401
 *   *      internal/*                    node pack API, Bearer CT_COMFY_TOKEN (docker network only)
 */

import type { NextRequest } from "next/server";
import type { NextResponse } from "next/server";
import type {
  CtAiStyleBody,
  CtCategoryBody,
  CtCreateProductBody,
  CtMockupPackBody,
  CtPresetBody,
  CtSaveDesignBody,
  CtStudioRunBody,
  CtUpdateAssetBody,
  CtUpdateClipartBody,
  CtUpdateProductBody,
} from "../types";
import { ctServiceClient, ctSession, type CtSession } from "./supabase";
import * as h from "./handlers";
import * as st from "./ai-styles";
import * as lib from "./library";
import * as studio from "./studio";
import * as packs from "./mockup-packs";
import * as packImages from "./pack-images";
import * as prices from "./price-tables";
import * as settings from "./settings";
import { reviewCategoryPrompts, suggestCategoryPrompts, suggestCategoryRevision, suggestDetails, suggestPresetPrompt, suggestRefine } from "./ai/prompt-writer";
import { mcpEndpoint } from "./mcp/server";
import { agentStatus, answerAgentTask, cancelAgentTask, createAgentTask, getAgentTask, listAgentTasks } from "./agent/tasks";

export interface CtRouteContext {
  params: Promise<{ path?: string[] }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readJson<T>(req: NextRequest): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/** Public origin, honouring a reverse proxy (the template URL is pasted into Shopify). */
function publicOrigin(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host");
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return host ? `${proto}://${host}` : req.nextUrl.origin;
}

async function dispatchPublic(req: NextRequest, path: string[]): Promise<NextResponse> {
  const [, resource, id] = path;
  if (req.method === "OPTIONS") return h.publicPreflight();
  if (!id || !UUID.test(id)) return h.jsonError("id không hợp lệ", 400);
  if (resource === "templates" && req.method === "GET") {
    const v = Number(req.nextUrl.searchParams.get("version"));
    return h.publicTemplate(id, Number.isInteger(v) && v > 0 ? v : null);
  }
  if (resource === "uploads" && req.method === "POST") return h.publicUpload(id, await req.formData());
  if (resource === "photo" && req.method === "POST") {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
    return h.publicPhoto(id, await req.formData(), ip, req.headers.get("origin"));
  }
  return h.jsonError("Not found", 404);
}

async function dispatch(req: NextRequest, ctx: CtRouteContext): Promise<NextResponse> {
  const path = (await ctx.params).path ?? [];
  if (path[0] === "public") return dispatchPublic(req, path);
  if (path[0] === "cron" && path[1] === "cleanup" && req.method === "POST") return h.cronCleanup(req.headers.get("authorization"));
  // ComfyUI studio: nginx auth_request (own cookie) and the node pack's internal API (bearer token).
  if (path[0] === "studio" && path[1] === "auth" && req.method === "GET") return studio.studioAuth(req);
  if (path[0] === "internal") return studio.dispatchInternal(req, path);
  if (path[0] === "mcp" && path.length === 1) return mcpEndpoint(req);

  const session = await ctSession();
  if (!session) return h.jsonError("Chưa đăng nhập", 401);

  const [head, id, sub] = path;
  const method = req.method;
  if (head === "ai") {
    if (id === "providers" && method === "GET") return h.aiProviders();
    if (id === "photo" && method === "GET") return h.photoCapabilitiesResponse();
    if (id === "prompt-suggest" && method === "POST") return suggestCategoryPrompts(session, await req.formData());
    if (id === "preset-prompt" && method === "POST") return suggestPresetPrompt(session, await req.formData());
    if (id === "category-revise" && method === "POST") return suggestCategoryRevision(session, await req.formData());
    if (id === "category-review" && method === "POST") return reviewCategoryPrompts(session, await req.formData());
    if (id === "agent-status" && method === "GET") return agentStatus();
    if (id === "agent-tasks" && !sub && method === "GET") return listAgentTasks(session, req.nextUrl.searchParams.get("kind"), req.nextUrl.searchParams.get("collection"));
    if (id === "agent-tasks" && !sub && method === "POST") return createAgentTask(session, await readJson<unknown>(req));
    if (id === "agent-tasks" && sub && !path[3] && method === "GET") return getAgentTask(session, sub);
    if (id === "agent-tasks" && sub && path[3] === "cancel" && method === "POST") return cancelAgentTask(session, sub);
    if (id === "agent-tasks" && sub && path[3] === "answer" && method === "POST") return answerAgentTask(session, sub, await readJson<unknown>(req));
    if (id === "details-suggest" && method === "POST") return suggestDetails(await req.formData());
    if (id === "refine-suggest" && method === "POST") return suggestRefine(await req.formData());
    return h.jsonError("Not found", 404);
  }
  if (head === "library") return dispatchLibrary(req, session, path);
  if (head === "studio") {
    if (id === "session" && method === "POST") return studio.studioSession(session);
    if (id === "models" && method === "GET") return studio.studioModels();
    if (id === "runs" && !sub && method === "POST") return studio.studioRun(await readJson<CtStudioRunBody>(req));
    if (id === "runs" && sub && method === "GET") return studio.studioRunStatus(session.supabase, sub);
    if (id === "drafts" && method === "POST") return studio.studioDraft(await readJson<CtStudioRunBody>(req));
    if (id === "refs" && method === "POST") return studio.studioUploadRef(await req.formData());
    return h.jsonError("Not found", 404);
  }
  if (head === "presets" && id === "refs" && !sub && method === "POST") return lib.uploadPresetRef(session, await req.formData());
  if (head === "shopify" && id === "products" && !sub && method === "GET") return h.shopifySearch(req.nextUrl.searchParams.get("q")?.trim() ?? "");
  if (head === "shopify" && id === "collections" && !sub && method === "GET") return h.shopifyCollections();
  if (head === "shopify" && id === "collections" && !sub && method === "POST") return h.shopifyCreateCollection(await readJson<unknown>(req));
  if (head === "settings" && id === "image-model" && !sub) {
    if (method === "GET") return settings.getImageModel();
    if (method === "PUT") return settings.setImageModel(session, await readJson<{ model?: unknown }>(req));
  }
  if (id && !UUID.test(id)) return h.jsonError("id không hợp lệ", 400);

  if (head === "presets" && id && sub === "history" && method === "GET") return lib.listPresetHistory(session, id);
  if (head === "presets" && !sub) {
    if (!id && method === "GET") return lib.listPresets(session, req.nextUrl.searchParams.get("kind"));
    const body = method === "POST" || method === "PATCH" ? await readJson<CtPresetBody>(req) : null;
    if (!id && method === "POST") return body ? lib.createPreset(session, body) : h.jsonError("Body không hợp lệ", 400);
    if (id && method === "PATCH") return body ? lib.updatePreset(session, id, body) : h.jsonError("Body không hợp lệ", 400);
    if (id && method === "DELETE") return lib.deletePreset(session, id);
  }

  if (head === "price-tables" && !sub) {
    if (!id && method === "GET") return prices.listPriceTables(session);
    if (!id && method === "POST") return prices.createPriceTable(session, await readJson<unknown>(req));
    if (id && method === "PATCH") return prices.updatePriceTable(session, id, await readJson<unknown>(req));
    if (id && method === "DELETE") return prices.deletePriceTable(session, id);
  }
  if (head === "ai-styles" && !sub) {
    if (!id && method === "GET") return st.listAiStyles(session);
    const body = method === "POST" || method === "PATCH" ? await readJson<CtAiStyleBody>(req) : null;
    if (!id && method === "POST") return body ? st.createAiStyle(session, body) : h.jsonError("Body không hợp lệ", 400);
    if (id && method === "PATCH") return body ? st.updateAiStyle(session, id, body) : h.jsonError("Body không hợp lệ", 400);
    if (id && method === "DELETE") return st.deleteAiStyle(session, id);
  }

  if (head === "products") {
    if (!id) {
      if (method === "GET") return h.listProducts(session, req.nextUrl.searchParams.get("q")?.trim() ?? "");
      if (method === "POST") {
        const body = await readJson<CtCreateProductBody>(req);
        return body ? h.createProduct(session, body) : h.jsonError("Body không hợp lệ", 400);
      }
    } else if (!sub) {
      if (method === "GET") return h.getBundle(session, id);
      if (method === "PATCH") {
        const body = await readJson<CtUpdateProductBody>(req);
        return body ? h.updateProduct(session, id, body) : h.jsonError("Body không hợp lệ", 400);
      }
      if (method === "DELETE") return h.deleteProduct(session, id);
    } else if (sub === "design" && method === "PUT") {
      const body = await readJson<CtSaveDesignBody>(req);
      return body ? h.saveDesign(session, id, body) : h.jsonError("Body không hợp lệ", 400);
    } else if (sub === "publish" && method === "POST") {
      return h.publish(session, id, publicOrigin(req));
    } else if (sub === "deploy" && method === "POST") {
      return h.deploy(session, id, await readJson<unknown>(req), publicOrigin(req));
    } else if (sub === "shopify" && method === "GET") {
      return h.shopifyStatus(session, id);
    } else if (sub === "assets" && method === "POST") {
      return h.uploadAsset(session, id, await req.formData());
    } else if (sub === "photo" && method === "POST") {
      return h.editorPhoto(session, id, await req.formData());
    } else if (sub === "print-pack" && method === "POST") {
      return h.editorPrintPack(session, id, await req.formData());
    } else if (sub === "mains") {
      const assetId = path[3];
      if (!assetId && method === "POST") {
        const body = await readJson<{ asset_id: string }>(req);
        return body && UUID.test(body.asset_id ?? "") ? lib.linkProductMain(session, id, body.asset_id) : h.jsonError("Body không hợp lệ", 400);
      }
      if (assetId && UUID.test(assetId) && method === "DELETE") return lib.unlinkProductMain(session, id, assetId);
    }
  }

  if (head === "assets" && id && !sub) {
    if (method === "PATCH") {
      const body = await readJson<CtUpdateAssetBody>(req);
      return body ? h.updateAsset(session, id, body) : h.jsonError("Body không hợp lệ", 400);
    }
    if (method === "DELETE") return h.deleteAsset(session, id);
  }
  if (head === "assets" && id && sub === "promote" && method === "POST") {
    const body = await readJson<{ category_id: string | null }>(req);
    const cat = body?.category_id ?? null;
    return cat === null || UUID.test(cat) ? lib.promoteAsset(session, id, cat) : h.jsonError("category_id không hợp lệ", 400);
  }
  if (head === "assets" && id && sub === "file" && method === "PUT") {
    return h.replaceAssetFile(session, id, await req.formData());
  }

  return h.jsonError("Not found", 404);
}

async function dispatchLibrary(req: NextRequest, session: CtSession, path: string[]): Promise<NextResponse> {
  const [, resource, id, sub] = path;
  const method = req.method;
  if (resource === "packs" && id === "images" && !sub && method === "POST") return packs.uploadPackImage(session, await req.formData());
  if (resource === "pack-collections") {
    if (!id && method === "GET") return packImages.listPackCollections(session);
    if (!id && method === "POST") return packImages.createPackCollection(session, await readJson<unknown>(req));
    if (id && UUID.test(id) && !sub && method === "PATCH") return packImages.renamePackCollection(session, id, await readJson<unknown>(req));
    return h.jsonError("Not found", 404);
  }
  if (resource === "pack-images") {
    if (!id && method === "GET") return packImages.listPackImages(session, req.nextUrl.searchParams);
    if (!id && method === "POST") return packImages.uploadPackLibraryImage(session, await req.formData());
    if (id === "generate" && !sub && method === "POST") return packImages.generatePackImage(session, await req.formData());
    if (id && UUID.test(id) && !sub && method === "GET") return packImages.getPackImage(session, id);
    if (id && UUID.test(id) && !sub && method === "DELETE") return packImages.deletePackImage(session, id);
    return h.jsonError("Not found", 404);
  }
  if (id && !UUID.test(id)) return h.jsonError("id không hợp lệ", 400);
  if (resource === "packs" && !sub) {
    if (!id && method === "GET") return packs.listPacks(session);
    const body = method === "POST" || method === "PATCH" ? await readJson<CtMockupPackBody>(req) : null;
    if (!id && method === "POST") return body ? packs.createPack(session, body) : h.jsonError("Body không hợp lệ", 400);
    if (id && method === "PATCH") return body ? packs.updatePack(session, id, body) : h.jsonError("Body không hợp lệ", 400);
    if (id && method === "DELETE") return packs.deletePack(session, id);
  }
  if (resource === "categories" && id && sub === "history" && method === "GET") return lib.listCategoryHistory(session, id);
  if (resource === "categories" && !sub) {
    if (!id && method === "GET") return lib.listCategories(session);
    const body = method === "POST" || method === "PATCH" ? await readJson<CtCategoryBody>(req) : null;
    if (!id && method === "POST") return body ? lib.createCategory(session, body) : h.jsonError("Body không hợp lệ", 400);
    if (id && method === "PATCH") return body ? lib.updateCategory(session, id, body) : h.jsonError("Body không hợp lệ", 400);
    if (id && method === "DELETE") return lib.deleteCategory(session, id);
  }
  if (resource === "cliparts") {
    if (!id && method === "GET") {
      const params = req.nextUrl.searchParams;
      const category = params.get("category");
      if (category && category !== "none" && !UUID.test(category)) return h.jsonError("category không hợp lệ", 400);
      return lib.listCliparts(session, category, params.get("q")?.trim() ?? "");
    }
    if (!id && method === "POST") return lib.uploadClipart(session, await req.formData());
    if (id && sub === "usage" && method === "GET") return lib.getClipartUsage(session, id);
    if (id && sub === "materials" && method === "GET") return lib.getClipartMaterials(session, id);
    if (id && !sub && method === "PATCH") {
      const body = await readJson<CtUpdateClipartBody>(req);
      return body ? lib.updateClipart(session, id, body) : h.jsonError("Body không hợp lệ", 400);
    }
    if (id && !sub && method === "DELETE") return lib.deleteClipart(session, id, req.nextUrl.searchParams.get("force") === "1");
    if (id && sub === "replace" && method === "POST") {
      const body = await readJson<{ with?: string; keep_renditions?: boolean }>(req);
      return body?.with && UUID.test(body.with) ? lib.replaceClipart(session, id, body.with, body.keep_renditions === true) : h.jsonError("Thiếu id bản mới", 400);
    }
  }
  return h.jsonError("Not found", 404);
}

export const ctRouteHandlers = {
  GET: dispatch,
  POST: dispatch,
  PUT: dispatch,
  PATCH: dispatch,
  DELETE: dispatch,
  OPTIONS: dispatch,
};
