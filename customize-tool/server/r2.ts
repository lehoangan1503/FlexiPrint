/**
 * Cloudflare R2 (S3 API) — the only file store. The bucket stays private; the
 * app serves objects at `${APP_URL}/files/<key>` (src/app/files/[...key]) with
 * long cache headers, and nginx caches them in front.
 *
 * Env: R2_ENDPOINT (https://<account>.r2.cloudflarestorage.com), R2_BUCKET,
 *      R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, APP_URL (public origin).
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

export async function r2Put(key: string, body: Buffer, mime: string): Promise<void> {
  await s3().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: mime }));
}

/** null when the object does not exist. */
export async function r2Get(key: string): Promise<GetObjectCommandOutput | null> {
  try {
    return await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
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
    await s3().send(new DeleteObjectsCommand({ Bucket: bucket(), Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }));
  }
}

/** Keys under `prefix` last modified before `cutoff`, oldest first, at most `limit`. */
export async function r2ListOlderThan(prefix: string, cutoff: Date, limit: number): Promise<string[]> {
  const out: Array<{ key: string; at: number }> = [];
  let token: string | undefined;
  do {
    const page = await s3().send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: `${prefix}/`, ContinuationToken: token }));
    for (const o of page.Contents ?? []) {
      if (o.Key && o.LastModified && o.LastModified < cutoff) out.push({ key: o.Key, at: o.LastModified.getTime() });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token && out.length < limit * 4);
  return out.sort((a, b) => a.at - b.at).slice(0, limit).map((o) => o.key);
}

/** Public URL the browser / storefront loads the object from. */
export function r2PublicUrl(key: string): string {
  const origin = (process.env.APP_URL ?? "").replace(/\/$/, "");
  return `${origin}${CT_CONFIG.filesPath}/${key.split("/").map(encodeURIComponent).join("/")}`;
}
