/**
 * Cloudflare R2 (S3 API) — the only file store. Public urls: with R2_PUBLIC_URL set
 * (e.g. https://cdn.teein.top — an R2 Custom Domain on the bucket, CORS *), the browser
 * loads `${R2_PUBLIC_URL}/<R2_KEY_PREFIX>/<key>` straight from Cloudflare; without it the
 * app serves objects at `${APP_URL}/files/<key>` (src/app/files/[...key]) with long cache
 * headers, nginx caching in front. Both forms are recognised as our own files (urls
 * already stored in the DB keep the /files/ form and keep working) — r2KeyOfUrl.
 * Rollback: drop R2_PUBLIC_URL.
 *
 * Env: R2_ENDPOINT (https://<account>.r2.cloudflarestorage.com), R2_BUCKET,
 *      R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, APP_URL (public origin),
 *      R2_KEY_PREFIX (optional, e.g. "flexiprint" — every object lives under it, so the
 *      bucket can be shared with other projects; callers never see it),
 *      R2_PUBLIC_URL (optional, origin of the bucket's custom domain, no trailing slash).
 */

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { CT_CONFIG } from "../config";

let client: S3Client | null = null;

export function r2Configured(): boolean {
  return Boolean(process.env.R2_ENDPOINT && process.env.R2_BUCKET && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
}

function s3(): S3Client {
  if (!r2Configured()) throw new Error("R2 chưa cấu hình (R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)");
  client ??= new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
  });
  return client;
}

const bucket = () => process.env.R2_BUCKET!;

const PREFIX = (process.env.R2_KEY_PREFIX ?? "").replace(/^\/+|\/+$/g, "");
/** Caller key → bucket key. */
const full = (key: string) => (PREFIX ? `${PREFIX}/${key}` : key);
/** Bucket key → caller key. */
const bare = (key: string) => (PREFIX && key.startsWith(`${PREFIX}/`) ? key.slice(PREFIX.length + 1) : key);

/** Keys are unique per upload, so the object never changes: cached for a year (the custom domain serves this header). */
export const R2_CACHE_IMMUTABLE = "public, max-age=31536000, immutable";
/** For the few keys written again in place (an import's folder files, _index.json, _manifest.json). */
export const R2_CACHE_SHORT = "public, max-age=300";

export async function r2Put(key: string, body: Buffer, mime: string, cacheControl: string = R2_CACHE_IMMUTABLE): Promise<void> {
  await s3().send(new PutObjectCommand({ Bucket: bucket(), Key: full(key), Body: body, ContentType: mime, CacheControl: cacheControl }));
}

/** null when the object does not exist. */
export async function r2Get(key: string): Promise<GetObjectCommandOutput | null> {
  try {
    return await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: full(key) }));
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "NoSuchKey" || name === "NotFound") return null;
    throw e;
  }
}

export async function r2Remove(keys: string[]): Promise<void> {
  // DeleteObjects takes up to 1000 keys.
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    if (batch.length === 0) continue;
    await s3().send(new DeleteObjectsCommand({ Bucket: bucket(), Delete: { Objects: batch.map((k) => ({ Key: full(k) })), Quiet: true } }));
  }
}

/** Every key under `prefix`. */
export async function r2Keys(prefix: string): Promise<string[]> {
  const out: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3().send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: `${full(prefix)}/`, ContinuationToken: token }));
    for (const o of page.Contents ?? []) if (o.Key) out.push(bare(o.Key));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/** Every object under `prefix` with its size. */
export async function r2Objects(prefix: string): Promise<Array<{ key: string; size: number }>> {
  const out: Array<{ key: string; size: number }> = [];
  let token: string | undefined;
  do {
    const page = await s3().send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: `${full(prefix)}/`, ContinuationToken: token }));
    for (const o of page.Contents ?? []) if (o.Key) out.push({ key: bare(o.Key), size: o.Size ?? 0 });
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/** Keys under `prefix` last modified before `cutoff`, oldest first, at most `limit`. */
export async function r2ListOlderThan(prefix: string, cutoff: Date, limit: number): Promise<string[]> {
  const out: Array<{ key: string; at: number }> = [];
  let token: string | undefined;
  do {
    const page = await s3().send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: `${full(prefix)}/`, ContinuationToken: token }));
    for (const o of page.Contents ?? []) {
      if (o.Key && o.LastModified && o.LastModified < cutoff) out.push({ key: bare(o.Key), at: o.LastModified.getTime() });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token && out.length < limit * 4);
  return out.sort((a, b) => a.at - b.at).slice(0, limit).map((o) => o.key);
}

const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");
/** `${APP_URL}/files/` — the app route; every url stored before R2_PUBLIC_URL has this form. */
const appFilesRoot = () => `${(process.env.APP_URL ?? "").replace(/\/$/, "")}${CT_CONFIG.filesPath}/`;
/** `${R2_PUBLIC_URL}/<prefix>/` — null when the custom domain is not configured. */
function cdnRoot(): string | null {
  const origin = (process.env.R2_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  return origin ? `${origin}/${PREFIX ? `${encodeKey(PREFIX)}/` : ""}` : null;
}

/** Public URL the browser / storefront loads the object from. `r2PublicUrl("")` is the current root. */
export function r2PublicUrl(key: string): string {
  return `${cdnRoot() ?? appFilesRoot()}${encodeKey(key)}`;
}

/** Every root a url of our own files may start with: the custom domain (if set) and the app's /files/. */
export function r2PublicRoots(): string[] {
  const cdn = cdnRoot();
  return cdn ? [cdn, appFilesRoot()] : [appFilesRoot()];
}

/** The caller key of one of our own file urls (either form), null for any other url. */
export function r2KeyOfUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const root = r2PublicRoots().find((r) => url.startsWith(r));
  if (!root) return null;
  const rest = url.slice(root.length).split(/[?#]/)[0];
  if (!rest) return null;
  try {
    return rest.split("/").map(decodeURIComponent).join("/");
  } catch {
    return null;
  }
}
