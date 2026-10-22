/**
 * "Phần nằm sau" of a clipart layer (asked 2026-10-22: the tail of an inner grandchild's Santa hat lay over the outer
 * grandchild's face — in the sample it goes behind them). A mask on the set's canvas, kept on the layer slot
 * (CtCharLayerSlot.behindUrl), the same for every option of that layer (the Christmas and the Easter hat). When the
 * parent's product is built (server/char/product.ts), the part of that layer inside the mask becomes its own layer under
 * every character of the version, linked to the part (it follows the Theme with it); a mirrored character gets the
 * mask mirrored.
 *
 *   POST char/projects/:id/layers/behind {slot, mask: PNG data URL | null}   — drawn in the editor (null = none)
 *   POST char/projects/:id/layers/behind/stage {slot, option}                — the parent's biggest version, whole,
 *        split at this layer's copies (behindStage: the editor shows the finished artwork live — asked 2026-10-23:
 *        drawn without seeing the neighbours, the part that goes behind was cut short)
 *   MCP char_set_behind {set_id, slot, polygons: [[[x, y], …]] shares of the canvas | []} — set by @flexiprint
 *
 * Only pose sets (brief.versionOf.pose): their parent's product is rebuilt in the background after a change.
 */

import sharp from "sharp";
import { NextResponse } from "next/server";
import { CT_TABLES } from "../../config";
import { CT_MAIN_KEY, type CtCharLayerSet, type CtCharProject, type CtBehindPlate, type CtBehindStage, type CtRegion, type CtSelection } from "../../types";
import type { CtSession } from "../supabase";
import { saveCharRaw } from "./files";
import { canEditProject, jobDb, jsonError, loadProject, NOT_YOURS, projectRow, type Db } from "./projects";
import { pngBytes } from "./file-edit";
import { remakeDrawnProduct } from "./versions";
import { loadArtwork, renderArtwork } from "../print-render";
import { defaultRegionSelection, linkedLeader, locateOption, mainVersions, regionGroups, resolveLinked } from "../../lib/design";
import { onVersion } from "../../lib/layout";
import { shapeBounds } from "../../lib/geometry";
import { composedVersions } from "../../lib/char-lineup";
import { charClipart } from "./product";
import { fetchImage } from "./files";

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
 * The parent's product as the customer sees its biggest version, whole (asked 2026-10-23: "hiện full artwork, kết quả
 * phải là artwork hoàn chỉnh với layer đã ra sau"), split at every copy of the layer being edited: the editor stacks
 * [each copy × mask (under everything)] then the plates, a copy drawn as copy × (1 − mask) — the finished artwork, live.
 * `option`: the option of the layer shown (the Theme it follows is set to match).
 */
export async function behindStage(db: Db, userId: string, p: CtCharProject, slotKey: string, option: string): Promise<CtBehindStage> {
  const set = p.layers;
  const parentId = p.brief.versionOf?.pose ? p.brief.versionOf.id : null;
  if (!set || !parentId) throw new Error("Chỉ dùng cho dáng của một bộ ghép dáng");
  const slot = slotIn(set, slotKey);
  if (!slot) throw new Error(`Không có layer "${slotKey}"`);
  const file = slot.files.find((f) => f.option === option) ?? slot.files[0];
  const parent = await loadProject(db, parentId);
  const productId = parent?.product_ids[0];
  if (!parent || !productId || !file) throw new Error("Bộ cha chưa có sản phẩm");
  const b = await loadArtwork(db, productId);
  if (!b) throw new Error("Không đọc được sản phẩm của bộ cha");
  const mains = mainVersions(b.assets, b.product.main_asset_id);
  const versions = composedVersions(parent.brief);
  const main = mains.find((m) => m.name === versions[versions.length - 1]?.name) ?? mains[mains.length - 1];
  if (!main) throw new Error("Sản phẩm chưa có phiên bản");
  const ids = new Set(slot.files.map((f) => f.imageId));
  const byId = new Map(b.assets.map((a) => [a.id, a]));
  const fxOf = (r: CtRegion) => {
    const item = b.items.find((i) => i.region_id === r.id);
    const a = item ? byId.get(item.asset_id) : undefined;
    return a?.meta.charLayerId && ids.has(a.meta.charLayerId) ? (a.meta.charFx ?? {}) : null;
  };
  const regions = b.regions.filter((r) => onVersion(r, main.id)).sort((x, y) => x.sort_order - y.sort_order);
  // Every copy of this layer (a hat-and-sweater outfit: its hat and its sweater, each where it lies), and its old
  // back parts (left out: the editor draws them).
  const isCopy = (r: CtRegion) => {
    const fx = fxOf(r);
    return !!fx && fx.behind?.keep !== "in";
  };
  const isOldBack = (r: CtRegion) => fxOf(r)?.behind?.keep === "in";
  const copies = regions.filter(isCopy);
  if (!copies.length) throw new Error("Không thấy layer này trong sản phẩm của bộ cha");
  // The option shown: its asset in the first copy, the copy's leader (the Theme) set to the same place.
  const base: CtSelection = { [CT_MAIN_KEY]: { kind: "main", assetId: main.id, optionId: null } };
  const groups = regionGroups(copies[0], b.items, b.assets);
  const want = b.assets.find((a) => a.meta.charLayerId === file.imageId && groups.some((g) => g.options.some((o) => o.id === a.id)));
  const at = locateOption(groups, want?.id ?? null);
  const leader = linkedLeader(copies[0], b.regions);
  if (leader) {
    const lg = regionGroups(leader, b.items, b.assets);
    const o = lg[at.group]?.options[Math.min(at.option, (lg[at.group]?.options.length ?? 1) - 1)];
    if (o) base[leader.id] = { kind: "image", assetId: o.id };
  }
  for (const r of regions) if (!(r.id in base)) base[r.id] = defaultRegionSelection(r, b.items, b.assets);
  const chosen = resolveLinked(b.regions, b.items, b.assets, base);
  const W = b.spec?.width ?? byId.get(b.product.main_asset_id ?? "")?.width ?? 1000;
  const H = b.spec?.height ?? byId.get(b.product.main_asset_id ?? "")?.height ?? 1000;
  const maxSide = 1600;
  const k = Math.min(1, maxSide / Math.max(W, H));
  // Choosers draw nothing but decide what shows: in every plate.
  const choosers = regions.filter((r) => r.name.startsWith("Chọn — "));
  const plates: CtBehindPlate[] = [];
  // The layer's picture per part (whole / hat / sweater) for the option shown, unmirrored on the pose canvas.
  const raw = fetchImage(file.url);
  const layers = new Map<string, Promise<string>>();
  const layerOf = (part: string) => {
    if (!layers.has(part)) layers.set(part, raw.then((png) => charClipart(png, part === "hat" || part === "rest" ? { part } : null)).then(async (png) => (await saveCharRaw(userId, p.id, "behind-stage", png, "image/png")).url));
    return layers.get(part)!;
  };
  let run: CtRegion[] = [];
  const flush = async () => {
    if (!run.length) return;
    const png = await renderArtwork({ ...b, regions: [...choosers, ...run] }, chosen, maxSide, "print");
    plates.push({ url: (await saveCharRaw(userId, p.id, "behind-stage", png, "image/png")).url });
    run = [];
  };
  for (const r of regions) {
    if (choosers.includes(r) || isOldBack(r)) continue;
    if (!isCopy(r)) {
      run.push(r);
      continue;
    }
    await flush();
    const bb = shapeBounds(r.shape);
    const part = fxOf(r)?.part ?? "";
    plates.push({ box: { x: bb.x * k, y: bb.y * k, w: bb.w * k, h: bb.h * k }, flip: fxOf(r)?.flip === true, layerUrl: await layerOf(part) });
  }
  await flush();
  return { width: Math.round(W * k), height: Math.round(H * k), plates };
}

/** POST char/projects/:id/layers/behind/stage {slot, option} → BehindStage */
export async function behindStageRoute(s: CtSession, id: string, body: unknown): Promise<NextResponse> {
  const p = await loadProject(s.supabase, id);
  if (!p) return jsonError("Không tìm thấy bộ nhân vật", 404);
  const b = (body && typeof body === "object" ? body : {}) as { slot?: unknown; option?: unknown };
  try {
    return NextResponse.json(await behindStage(jobDb(s), p.user_id ?? s.user.id, p, typeof b.slot === "string" ? b.slot : "", typeof b.option === "string" ? b.option : ""));
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Không dựng được artwork", 400);
  }
}
