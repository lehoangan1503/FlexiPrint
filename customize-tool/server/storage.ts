/**
 * File storage for the tool — Cloudflare R2 (server/r2.ts). Callers check
 * ownership before writing / deleting (server/handlers.ts ownedProduct).
 */

import { CT_CONFIG } from "../config";
import { r2PublicUrl, r2Put, r2Remove } from "./r2";

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

export function ctStoragePath(userId: string, productId: string, role: string, mime: string): string {
  const ext = EXT[mime] ?? "png";
  return `${userId}/${CT_CONFIG.storagePrefix}/${productId}/${role}/${crypto.randomUUID()}.${ext}`;
}

/** Library clipart: `<uid>/customize-tool/library/<category|none>/<role>/…` — no product in the key, it outlives any product. */
export function ctLibraryPath(userId: string, categoryId: string | null, role: string, mime: string): string {
  const ext = EXT[mime] ?? "png";
  return `${userId}/${CT_CONFIG.storagePrefix}/library/${categoryId ?? "none"}/${role}/${crypto.randomUUID()}.${ext}`;
}

export async function ctUpload(path: string, body: Buffer, mime: string): Promise<string> {
  try {
    await r2Put(path, body, mime);
  } catch (e) {
    throw new Error(`Upload thất bại: ${e instanceof Error ? e.message : String(e)}`);
  }
  return r2PublicUrl(path);
}

export async function ctRemove(paths: string[]): Promise<void> {
  const keys = paths.filter(Boolean);
  if (keys.length === 0) return;
  // Best effort: an orphaned object costs storage, a failed delete must not block the row delete.
  await r2Remove(keys).catch((e: Error) => console.warn("[ct] R2 remove failed", e.message));
}

/** Storefront upload path — outside every user's `<uid>/` folder. */
export function ctPublicUploadPath(productId: string, kind: string, mime: string): string {
  const ext = EXT[mime] ?? "png";
  const day = new Date().toISOString().slice(0, 10);
  return `${CT_CONFIG.storagePrefix}-orders/${productId}/${day}/${kind}-${crypto.randomUUID()}.${ext}`;
}

export async function ctDownload(url: string): Promise<{ data: Buffer; mime: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Không tải được ảnh tham chiếu (${res.status})`);
  const mime = res.headers.get("content-type")?.split(";")[0] ?? "image/png";
  return { data: Buffer.from(await res.arrayBuffer()), mime };
}
