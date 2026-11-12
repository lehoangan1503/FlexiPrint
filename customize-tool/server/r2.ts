/**
 * Cloudflare R2 (S3 API) — the only file store. Stored / editor urls are always
 * `${APP_URL}/files/<key>` (src/app/files/[...key]; nginx caches in front) — the team works
 * from Vietnam, where that path is fast and Cloudflare's is slow (2026-11-12: ~0.08 s vs 0.5–2.8 s).
 * Storefront answers (router: every `public/*` response) swap our file urls for
 * `${R2_STOREFRONT_URL}/<R2_KEY_PREFIX>/<key>` — an R2 Custom Domain on the bucket (CORS *),
 * fast for the US customers; editor answers swap any such url back to /files/ (r2RewriteUrls).
 * Both forms are recognised as our own files (r2KeyOfUrl). Rollback: drop R2_STOREFRONT_URL.
 *
 * Env: R2_ENDPOINT (https://<account>.r2.cloudflarestorage.com), R2_BUCKET,
 *      R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, APP_URL (public origin),
 *      R2_KEY_PREFIX (optional, e.g. "flexiprint" — every object lives under it, so the
 *      bucket can be shared with other projects; callers never see it),
 *      R2_STOREFRONT_URL (optional, origin of the bucket's custom domain, e.g. https://cdn.teein.top).
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
/** `${APP_URL}/files/` — the app route: the root of every stored url. */
const appFilesRoot = () => `${(process.env.APP_URL ?? "").replace(/\/$/, "")}${CT_CONFIG.filesPath}/`;
/** The custom domain's root with the key prefix. 2026-11-12 a few hours of uploads were stored with it
 * (env R2_PUBLIC_URL, since renamed): known even with the variable unset, so those urls stay ours. */
const KNOWN_CDN_ORIGINS = ["https://cdn.teein.top"];
const cdnRootOf = (origin: string) => `${origin.replace(/\/+$/, "")}/${PREFIX ? `${encodeKey(PREFIX)}/` : ""}`;
/** Storefront root — null when R2_STOREFRONT_URL is not set (the store then gets /files/ too). */
function storefrontRoot(): string | null {
  const origin = (process.env.R2_STOREFRONT_URL ?? "").trim();
  return origin ? cdnRootOf(origin) : null;
}
function cdnRoots(): string[] {
  const set = storefrontRoot();
  const known = PREFIX ? KNOWN_CDN_ORIGINS.map(cdnRootOf) : [];
  return [...new Set([...(set ? [set] : []), ...known])];
}

/** The url stored in the DB and shown in the editor (`${APP_URL}/files/<key>`). `r2PublicUrl("")` is its root. */
export function r2PublicUrl(key: string): string {
  return `${appFilesRoot()}${encodeKey(key)}`;
}

/** Every root a url of our own files may start with: the app's /files/ and the custom domain. */
export function r2PublicRoots(): string[] {
  return [appFilesRoot(), ...cdnRoots()];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every url of our files inside `text` (a JSON body) moved to one root: "storefront" → the custom domain
 * (unchanged when R2_STOREFRONT_URL is unset), "editor" → /files/. Plain string swap of the roots: a url is
 * `<root><encoded key>`, and the key part stays as it is.
 */
export function r2RewriteUrls(text: string, to: "storefront" | "editor"): string {
  const target = to === "storefront" ? storefrontRoot() : appFilesRoot();
  if (!target) return text;
  const from = r2PublicRoots().filter((r) => r !== target);
  if (!from.some((r) => text.includes(r))) return text;
  return text.replace(new RegExp(from.map(escapeRe).join("|"), "g"), target);
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
