// Public file proxy for the private R2 bucket (customize-tool/server/r2.ts).
// Keys are unique per upload, so responses are immutable and cached for a year
// by browsers and by nginx (deploy/nginx/flexiprint.conf). CORS * lets the
// Shopify storefront draw these images on a canvas and export it.
import { r2Get } from "../../../../customize-tool/server/r2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS" };

async function serve(params: Promise<{ key: string[] }>, head: boolean): Promise<Response> {
  const { key } = await params;
  const path = key.map(decodeURIComponent).join("/");
  if (!path || path.includes("..")) return new Response("Bad key", { status: 400, headers: CORS });
  const obj = await r2Get(path).catch(() => null);
  if (!obj?.Body) return new Response("Not found", { status: 404, headers: { ...CORS, "Cache-Control": "no-store" } });
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

export async function GET(_req: Request, ctx: { params: Promise<{ key: string[] }> }) {
  return serve(ctx.params, false);
}

export async function HEAD(_req: Request, ctx: { params: Promise<{ key: string[] }> }) {
  return serve(ctx.params, true);
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
