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
 *   POST   products/:id/assets           multipart: file, role, parent_id?, name?, meta?
 *   POST   products/:id/generate         CtGenerateBody
 *   PATCH  assets/:id                    CtUpdateAssetBody
 *   DELETE assets/:id
 *   PUT    assets/:id/file              multipart: file  (replace image, keep id)
 *
 * Public (no session, CORS *) — used by the Shopify section:
 *   GET    public/templates/:productId[?version=N]   → CtTemplate
 *   POST   public/uploads/:productId     multipart: file, kind=photo|preview
 *   POST   public/photo/:productId       multipart: file, region, style, cutout=0|1 → processed image bytes
 *
 * Cron (Bearer CT_CRON_SECRET, no session):
 *   POST   cron/cleanup                  delete cached photo results older than 24 h
 *
 * Editor photo tools:
 *   GET    ai/photo                      → { ai, cutout, aiStyles } capabilities
 *   POST   products/:id/photo            multipart: file, style, cutout=0|1 → processed image bytes
 *   POST   products/:id/print-pack       multipart: file (flat design), main?, material, dpi? → zip (services/material-render)
 *
 * AI photo-style library (global; owner or admin edits, see server/ai-styles.ts):
 *   GET    ai-styles                     → { styles: CtAiStyle[], admin }
 *   POST   ai-styles                     CtAiStyleBody
 *   PATCH  ai-styles/:id                 CtAiStyleBody
 *   DELETE ai-styles/:id                 → 204
 */

import type { NextRequest } from "next/server";
import type { NextResponse } from "next/server";
import type {
  CtAiStyleBody,
  CtCreateProductBody,
  CtGenerateBody,
  CtSaveDesignBody,
  CtUpdateAssetBody,
  CtUpdateProductBody,
} from "../types";
import { ctSession } from "./supabase";
import * as h from "./handlers";
import * as st from "./ai-styles";

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

  const session = await ctSession();
  if (!session) return h.jsonError("Chưa đăng nhập", 401);

  const [head, id, sub] = path;
  const method = req.method;
  if (head === "ai") {
    if (id === "providers" && method === "GET") return h.aiProviders();
    if (id === "photo" && method === "GET") return h.photoCapabilitiesResponse();
    return h.jsonError("Not found", 404);
  }
  if (id && !UUID.test(id)) return h.jsonError("id không hợp lệ", 400);

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
    } else if (sub === "assets" && method === "POST") {
      return h.uploadAsset(session, id, await req.formData());
    } else if (sub === "photo" && method === "POST") {
      return h.editorPhoto(session, id, await req.formData());
    } else if (sub === "print-pack" && method === "POST") {
      return h.editorPrintPack(session, id, await req.formData());
    } else if (sub === "generate" && method === "POST") {
      const body = await readJson<CtGenerateBody>(req);
      return body ? h.generate(session, id, body) : h.jsonError("Body không hợp lệ", 400);
    }
  }

  if (head === "assets" && id && !sub) {
    if (method === "PATCH") {
      const body = await readJson<CtUpdateAssetBody>(req);
      return body ? h.updateAsset(session, id, body) : h.jsonError("Body không hợp lệ", 400);
    }
    if (method === "DELETE") return h.deleteAsset(session, id);
  }
  if (head === "assets" && id && sub === "file" && method === "PUT") {
    return h.replaceAssetFile(session, id, await req.formData());
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
