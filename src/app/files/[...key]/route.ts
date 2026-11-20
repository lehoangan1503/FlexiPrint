// Public file proxy for the private R2 bucket (customize-tool/server/r2.ts).
// Keys are unique per upload, so responses are immutable and cached for a year
// by browsers and by nginx (deploy/nginx/flexiprint.conf). CORS * lets the
// Shopify storefront draw these images on a canvas and export it.
// `?w=400` (asked 2026-11-20: the product list loaded every 3 MB mockup PNG and lagged): a small WebP of the
// picture, width w (one of THUMB_WIDTHS), made on the fly; nginx caches it by its full url like the original.
import sharp from "sharp";
import { r2Get } from "../../../../customize-tool/server/r2";
import { THUMB_WIDTHS } from "../../../../customize-tool/lib/thumb-url";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS" };

async function serve(req: Request, params: Promise<{ key: string[] }>, head: boolean): Promise<Response> {
  const { key } = await params;
  const path = key.map(decodeURIComponent).join("/");
  if (!path || path.includes("..")) return new Response("Bad key", { status: 400, headers: CORS });
  const obj = await r2Get(path).catch(() => null);
  if (!obj?.Body) return new Response("Not found", { status: 404, headers: { ...CORS, "Cache-Control": "no-store" } });
  const w = Number(new URL(req.url).searchParams.get("w"));
  if ((THUMB_WIDTHS as readonly number[]).includes(w) && /^image\/(png|jpe?g|webp|gif|avif)$/.test(obj.ContentType ?? "")) {
    const small = await sharp(Buffer.from(await obj.Body.transformToByteArray()), { limitInputPixels: false })
      .rotate()
      .resize(w, w, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer()
      .catch(() => null);
    if (small) {
      const headers = { ...CORS, "Content-Type": "image/webp", "Cache-Control": "public, max-age=31536000, immutable", "Content-Length": String(small.length) };
      return new Response(head ? null : new Uint8Array(small), { status: 200, headers });
    }
    return new Response("Bad image", { status: 422, headers: { ...CORS, "Cache-Control": "no-store" } });
  }
  const headers: Record<string, string> = {
    ...CORS,
    "Content-Type": obj.ContentType ?? "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
  };
  if (obj.ContentLength !== undefined) headers["Content-Length"] = String(obj.ContentLength);
  if (obj.ETag) headers.ETag = obj.ETag;
  if (head) return new Response(null, { status: 200, headers });
  return new Response(obj.Body.transformToWebStream(), { status: 200, headers });
}

export async function GET(req: Request, ctx: { params: Promise<{ key: string[] }> }) {
  return serve(req, ctx.params, false);
}

export async function HEAD(req: Request, ctx: { params: Promise<{ key: string[] }> }) {
  return serve(req, ctx.params, true);
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
