/**
 * Files of a bộ nhân vật on R2: `<uid>/customize-tool/char/<project>/<kind>/<uuid>.png` (the original — print
 * quality, what layers and print files are made from) + `….webp` beside it (≤ 640 px, for the page). Pixels under
 * full transparency carry no colour, so a mostly-empty layer PNG stays small.
 */

import sharp from "sharp";
import { CT_CONFIG } from "../../config";
import type { CtCharImageKind } from "../../types";
import { ctUpload } from "../storage";

export const THUMB_SIDE = 640;

export interface SavedCharFile {
  url: string;
  storage_path: string;
  thumb_url: string;
  thumb_path: string;
  width: number;
  height: number;
}

export function charFolder(userId: string, projectId: string): string {
  return `${userId}/${CT_CONFIG.storagePrefix}/char/${projectId}`;
}

/** Store an original (PNG, or JPEG for a photo without alpha) + its WebP preview. */
export async function saveCharFile(userId: string, projectId: string, kind: CtCharImageKind, data: Buffer): Promise<SavedCharFile> {
  const img = sharp(data, { limitInputPixels: 20000 * 20000 });
  const meta = await img.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error("Ảnh không đọc được");
  const photo = kind === "blank" || kind === "mockup" || kind === "ref";
  const original = photo && !meta.hasAlpha ? await img.clone().jpeg({ quality: 92, mozjpeg: true }).toBuffer() : await img.clone().png({ compressionLevel: 9 }).toBuffer();
  const mime = photo && !meta.hasAlpha ? "image/jpeg" : "image/png";
  const thumb = await img.clone().resize({ width: THUMB_SIDE, height: THUMB_SIDE, fit: "inside", withoutEnlargement: true }).webp({ quality: 80, alphaQuality: 90 }).toBuffer();
  const base = `${charFolder(userId, projectId)}/${kind}/${crypto.randomUUID()}`;
  const storage_path = `${base}.${mime === "image/jpeg" ? "jpg" : "png"}`;
  const thumb_path = `${base}.webp`;
  const [url, thumb_url] = await Promise.all([ctUpload(storage_path, original, mime), ctUpload(thumb_path, thumb, "image/webp")]);
  return { url, storage_path, thumb_url, thumb_path, width, height };
}

/** A plain file next to the project's pictures (no preview): `…/<folder>/<uuid>.<ext>`. */
export async function saveCharRaw(userId: string, projectId: string, folder: string, data: Buffer, mime: "image/jpeg" | "image/png" | "image/webp"): Promise<{ url: string; path: string }> {
  const path = `${charFolder(userId, projectId)}/${folder}/${crypto.randomUUID()}.${mime.split("/")[1].replace("jpeg", "jpg")}`;
  return { url: await ctUpload(path, data, mime), path };
}

/**
 * A picture by URL, fetched again (up to 4 times) when the transfer breaks: 2026-11-04 flexi2 → its own files is
 * lossy, one body cut off mid-way ("terminated") failed a whole set's product build after the files were cut.
 * A 4xx answer is final; a broken connection, a timeout or a 5xx is tried again.
 */
export async function fetchImage(url: string): Promise<Buffer> {
  for (let attempt = 1; ; attempt++) {
    let status = 0;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      status = res.status;
      if (!res.ok) throw new Error(`Không tải được ảnh (${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (attempt >= 4 || (status >= 400 && status < 500)) throw e;
      console.warn("[ct] fetch image again", url.split("/").pop(), e instanceof Error ? e.message : String(e));
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

/** A picture sent with a sticky-chat request (screenshot / file): `<folder>/chat/<uuid>.png`, no image row — the
 * agent task keeps its url. Screenshots are PNG; a big one is scaled to ≤ 2400 px. */
export async function saveChatFile(userId: string, projectId: string, data: Buffer): Promise<{ url: string; width: number; height: number }> {
  const img = sharp(data, { limitInputPixels: 20000 * 20000 }).rotate();
  const out = await img.resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
  if (!out.info.width || !out.info.height) throw new Error("Ảnh không đọc được");
  const url = await ctUpload(`${charFolder(userId, projectId)}/chat/${crypto.randomUUID()}.png`, out.data, "image/png");
  return { url, width: out.info.width, height: out.info.height };
}
