/**
 * "Phần nằm sau" of a clipart layer (asked 2026-10-22: the tail of an inner grandchild's Santa hat lay over the outer
 * grandchild's face — in the sample it goes behind them). A mask on the set's canvas, kept on the layer slot
 * (CtCharLayerSlot.behindUrl), the same for every option of that layer (the Christmas and the Easter hat). When the
 * parent's product is built (server/char/product.ts), the part of that layer inside the mask becomes its own layer under
 * every character of the version, linked to the part (it follows the Theme with it); a mirrored character gets the
 * mask mirrored.
 *
 *   POST char/projects/:id/layers/behind {slot, mask: PNG data URL | null}   — drawn in the editor (null = none)
 *   POST char/projects/:id/layers/behind/context {option}                    — the parent's biggest version around
 *        this pose, on the pose's canvas (asked 2026-10-23: drawn without seeing the neighbours, the part that goes
 *        behind was cut short and the rest of the hat lay over the next grandchild with a straight edge)
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
import { loadArtwork, renderArtwork } from "../print-render";
import { selectionFromNames } from "../product-options";
import { mainVersions, normalizeProductConfig } from "../../lib/design";
import { onVersion } from "../../lib/layout";
import { shapeBounds } from "../../lib/geometry";
import { composedVersions, subjectName } from "../../lib/char-lineup";
import { poseOf } from "../../lib/char-brief";

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

/**
 * The parent's product as the customer sees its biggest version (`option`: the Theme / outfit shown — the file being
 * edited), cut to where this pose's character stands and scaled onto the pose's canvas: the editor shows it dimmed
 * behind the layer, so the part that goes behind is drawn around exactly what overlaps the neighbours. The character
 * used is one standing unmirrored in this pose, the one with the most people around it.
 */
export async function behindContext(db: Db, userId: string, p: CtCharProject, option: string): Promise<string> {
  const set = p.layers;
  const parentId = p.brief.versionOf?.pose ? p.brief.versionOf.id : null;
  if (!set || !parentId) throw new Error("Chỉ dùng cho dáng của một bộ ghép dáng");
  const parent = await loadProject(db, parentId);
  const productId = parent?.product_ids[0];
  if (!parent || !productId) throw new Error("Bộ cha chưa có sản phẩm");
  const b = await loadArtwork(db, productId);
  if (!b) throw new Error("Không đọc được sản phẩm của bộ cha");
  const versions = composedVersions(parent.brief);
  const v = versions[versions.length - 1];
  const mains = mainVersions(b.assets, b.product.main_asset_id);
  const main = mains.find((m) => m.name === v?.name) ?? mains[mains.length - 1];
  if (!v || !main) throw new Error("Sản phẩm chưa có phiên bản");
  const mine = v.people.filter((x) => {
    const at = poseOf(parent.brief, x.subject);
    return !!at && at.pose.id === p.brief.versionOf?.pose && !(x.flip ?? at.mirrored);
  });
  const centre = v.people.reduce((n, x) => n + x.x, 0) / Math.max(1, v.people.length);
  const person = [...mine].sort((a, c) => Math.abs(a.x - centre) - Math.abs(c.x - centre))[0];
  if (!person) throw new Error("Không có nhân vật nào đứng thẳng (không lật) ở dáng này");
  const name = subjectName(parent.brief, parent.brief.subjects.findIndex((x) => x.id === person.subject));
  const body = b.regions.find((r) => onVersion(r, main.id) && r.name.startsWith(`Thân — ${name}`));
  if (!body) throw new Error(`Không thấy layer thân của ${name}`);
  const box = shapeBounds(body.shape);
  const config = normalizeProductConfig(b.product.config);
  let selection;
  try {
    selection = selectionFromNames(b, { [config.main.label || "Version"]: main.name, ...(option ? { Theme: option } : {}) });
  } catch {
    selection = selectionFromNames(b, { [config.main.label || "Version"]: main.name });
  }
  const W = b.spec?.width ?? b.assets.find((a) => a.id === b.product.main_asset_id)?.width ?? 1000;
  const H = b.spec?.height ?? b.assets.find((a) => a.id === b.product.main_asset_id)?.height ?? 1000;
  const print = await renderArtwork(b, selection, Math.max(W, H), "print");
  // The pose's canvas = the body layer's box on the print: the part of the print inside it, scaled onto the canvas.
  const k = set.width / box.w;
  const meta = await sharp(print).metadata();
  const pw = meta.width ?? W;
  const ph = meta.height ?? H;
  const r = pw / W;
  const x0 = Math.max(0, Math.floor(box.x * r));
  const y0 = Math.max(0, Math.floor(box.y * r));
  const x1 = Math.min(pw, Math.ceil((box.x + box.w) * r));
  const y1 = Math.min(ph, Math.ceil((box.y + box.h) * r));
  if (x1 <= x0 || y1 <= y0) throw new Error("Nhân vật nằm ngoài khung in");
  const cw = Math.max(1, Math.min(set.width, Math.round(((x1 - x0) / r) * k)));
  const chh = Math.max(1, Math.min(set.height, Math.round(((y1 - y0) / r) * k)));
  const piece = await sharp(print).extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }).resize(cw, chh, { fit: "fill" }).png().toBuffer();
  const left = Math.max(0, Math.min(set.width - cw, Math.round((x0 / r - box.x) * k)));
  const top = Math.max(0, Math.min(set.height - chh, Math.round((y0 / r - box.y) * k)));
  const png = await sharp({ create: { width: set.width, height: set.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: piece, left, top }])
    .png()
    .toBuffer();
  return (await saveCharRaw(userId, p.id, "behind-context", png, "image/png")).url;
}

/** POST char/projects/:id/layers/behind/context {option} → {url} */
export async function behindContextRoute(s: CtSession, id: string, body: unknown): Promise<NextResponse> {
  const p = await loadProject(s.supabase, id);
  if (!p) return jsonError("Không tìm thấy bộ nhân vật", 404);
  const option = body && typeof body === "object" && typeof (body as { option?: unknown }).option === "string" ? (body as { option: string }).option : "";
  try {
    return NextResponse.json({ url: await behindContext(jobDb(s), p.user_id ?? s.user.id, p, option) });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không dựng được ảnh ghép", 400);
  }
}
