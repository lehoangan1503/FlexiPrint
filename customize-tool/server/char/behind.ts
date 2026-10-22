/**
 * "Phần nằm sau" of a clipart layer (asked 2026-10-22: the tail of an inner grandchild's Santa hat lay over the outer
 * grandchild's face — in the sample it goes behind them). A mask on the set's canvas, kept on the layer slot
 * (CtCharLayerSlot.behindUrl), the same for every option of that layer (the Christmas and the Easter hat). When the
 * parent's product is built (server/char/product.ts), the part of that layer inside the mask becomes its own layer under
 * every character of the version, linked to the part (it follows the Theme with it); a mirrored character gets the
 * mask mirrored.
 *
 *   POST char/projects/:id/layers/behind {slot, mask: PNG data URL | null}   — drawn in the editor (null = none)
 *   MCP char_set_behind {set_id, slot, polygons: [[[x, y], …]] shares of the canvas | []} — set by @flexiprint
 *
 * Only pose sets (brief.versionOf.pose): their parent's product is rebuilt in the background after a change.
 */

import sharp from "sharp";
import { NextResponse } from "next/server";
import { CT_TABLES } from "../../config";
import type { CtCharLayerSet, CtCharProject } from "../../types";
import type { CtSession } from "../supabase";
import { saveCharRaw } from "./files";
import { canEditProject, jobDb, jsonError, loadProject, NOT_YOURS, projectRow, type Db } from "./projects";
import { pngBytes } from "./file-edit";
import { remakeDrawnProduct } from "./versions";

/** The layer slot a mask may go on: a part's own layer (a hair's front half stands for the part). */
function slotIn(set: CtCharLayerSet, key: string) {
  return set.slots.find((sl) => sl.key === key) ?? set.slots.find((sl) => sl.key === `${key}:front`) ?? null;
}

/** A mask PNG (white, alpha = the part that goes behind) on the set's canvas; null when it is empty. */
async function normalMask(set: CtCharLayerSet, png: Buffer): Promise<Buffer | null> {
  const { data, info } = await sharp(png).ensureAlpha().resize(set.width, set.height, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  let any = false;
  for (let i = 0; i < info.width * info.height; i++) {
    const a = data[i * 4 + 3];
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = 255;
    if (a > 8) any = true;
  }
  return any ? sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer() : null;
}

/** Polygons in shares of the canvas (0–1) → a mask PNG. */
export async function polygonMask(set: CtCharLayerSet, polygons: number[][][]): Promise<Buffer | null> {
  const paths = polygons
    .filter((pg) => pg.length >= 3)
    .map((pg) => `<path d="${pg.map(([x, y], i) => `${i ? "L" : "M"}${(x * set.width).toFixed(1)} ${(y * set.height).toFixed(1)}`).join(" ")} Z" fill="#fff"/>`);
  if (!paths.length) return null;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${set.width}" height="${set.height}">${paths.join("")}</svg>`;
  return normalMask(set, await sharp(Buffer.from(svg)).png().toBuffer());
}

/** Saves (or clears) a layer's back part on a pose set, then rebuilds the parent's product in the background. */
export async function setBehind(db: Db, userId: string, p: CtCharProject, slotKey: string, mask: Buffer | null): Promise<CtCharProject> {
  const set = p.layers;
  if (!set || set.status !== "done") throw new Error("Bộ chưa cắt xong");
  if (!p.brief.versionOf?.pose) throw new Error("Chỉ dùng cho dáng của một bộ ghép dáng");
  const slot = slotIn(set, slotKey);
  if (!slot || slot.key === "body" || slot.follows) throw new Error(`Không có layer "${slotKey}"`);
  const png = mask ? await normalMask(set, mask) : null;
  const url = png ? (await saveCharRaw(userId, p.id, "behind", png, "image/png")).url : undefined;
  const slots = set.slots.map((sl) => (sl.key === slot.key ? { ...sl, behindUrl: url } : sl));
  const { data, error } = await db.from(CT_TABLES.charProjects).update({ layers: { ...set, slots } }).eq("id", p.id).select("*").single<CtCharProject>();
  if (error || !data) throw new Error(error?.message ?? "Không lưu được");
  void remakeDrawnProduct(db, userId, p.brief.versionOf.id).catch((e: Error) => console.warn("[ct] behind product", e.message));
  return projectRow(data);
}

/** POST char/projects/:id/layers/behind {slot, mask} */
export async function behindRoute(s: CtSession, id: string, body: unknown): Promise<NextResponse> {
  const p = await loadProject(s.supabase, id);
  if (!p) return jsonError("Không tìm thấy bộ nhân vật", 404);
  if (!(await canEditProject(s, p))) return jsonError(NOT_YOURS, 403);
  const b = (body && typeof body === "object" ? body : {}) as { slot?: unknown; mask?: unknown };
  if (typeof b.slot !== "string") return jsonError("Thiếu slot", 400);
  try {
    const project = await setBehind(jobDb(s), p.user_id ?? s.user.id, p, b.slot, b.mask ? pngBytes(b.mask) : null);
    return NextResponse.json({ project });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không lưu được", 400);
  }
}
