/**
 * What the customer picks in a set, read from its product's image zones (asked 2026-11-03: an imported Teeinblue set
 * showed "Bộ chưa có clipart" in the library although its product has every option). An imported set has no cut
 * files — its clipart are the product's zone pictures — so the library shows those: one row per field (zones with
 * the same label across versions merged), each option its picture.
 *
 *   GET char/projects/:id/options → { fields: CtSetOptionField[] }
 * listCharProjects uses `setPreviewOptions` for the two pictures on a set's card.
 */

import { NextResponse } from "next/server";
import { CT_TABLES } from "../../config";
import type { CtAsset, CtCharProject, CtRegion, CtRegionItem, CtSetOptionField } from "../../types";
import { customerOptionName } from "../../lib/design";
import type { CtSession } from "../supabase";
import { jsonError, loadProject, type Db } from "./projects";

/** Ids go in the request url: a few dozen at a time (n00-POD-02 has 465 zones). */
const CHUNK = 60;

async function inChunks<T>(ids: string[], run: (part: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...(await run(ids.slice(i, i + CHUNK))));
  return out;
}

/**
 * The image fields of a product, in zone order. `maxZones` stops early (a card needs only the first field with a
 * choice); `maxOptions` caps a field's pictures.
 */
export async function productOptionFields(db: Db, productId: string, maxZones = Infinity, maxOptions = 60): Promise<CtSetOptionField[]> {
  const { data: regions, error } = await db
    .from(CT_TABLES.regions)
    .select("id, name, kind, config, sort_order")
    .eq("product_id", productId)
    .eq("kind", "image")
    .order("sort_order")
    .limit(Number.isFinite(maxZones) ? maxZones : 2000)
    .returns<Array<Pick<CtRegion, "id" | "name" | "kind" | "config" | "sort_order">>>();
  if (error) throw new Error(error.message);
  const zones = regions ?? [];
  if (!zones.length) return [];
  const items = await inChunks(
    zones.map((r) => r.id),
    async (part) => {
      const { data, error: e } = await db.from(CT_TABLES.items).select("id, region_id, asset_id, sort_order").in("region_id", part).returns<Array<Pick<CtRegionItem, "id" | "region_id" | "asset_id" | "sort_order">>>();
      if (e) throw new Error(e.message);
      return data ?? [];
    },
  );
  const subIds = [...new Set(items.map((i) => i.asset_id))];
  const cols = "id, name, url, meta, parent_id, sort_order";
  type Row = Pick<CtAsset, "id" | "name" | "url" | "meta" | "parent_id" | "sort_order">;
  const subs = await inChunks(subIds, async (part) => {
    const { data, error: e } = await db.from(CT_TABLES.assets).select(cols).in("id", part).returns<Row[]>();
    if (e) throw new Error(e.message);
    return data ?? [];
  });
  const kids = await inChunks(subIds, async (part) => {
    const { data, error: e } = await db.from(CT_TABLES.assets).select(cols).in("parent_id", part).returns<Row[]>();
    if (e) throw new Error(e.message);
    return data ?? [];
  });
  const byId = new Map(subs.map((a) => [a.id, a]));

  const fields = new Map<string, CtSetOptionField>();
  for (const r of zones) {
    const label = (r.config?.image?.label || r.name || "").trim();
    // A zone's options: each item's picture, then its colour variants (đa sắc).
    const options = items
      .filter((i) => i.region_id === r.id)
      .sort((a, b) => a.sort_order - b.sort_order)
      .flatMap((i) => {
        const sub = byId.get(i.asset_id);
        return sub ? [sub, ...kids.filter((k) => k.parent_id === sub.id).sort((a, b) => a.sort_order - b.sort_order)] : [];
      });
    // One picture only = a fixed part of the design (background, shadow), not a choice; a layer that follows another
    // choice (its outfit under the picked head…) is not picked by the customer either.
    if (options.length < 2 || r.config?.image?.follows) continue;
    // Zones are per version ("Grandma — Hat · Grandkids sitting with Grandma]"): the field is the part before " · ".
    const name = label.split(" · ")[0].trim() || label;
    const field = fields.get(name) ?? { label: name, options: [] };
    for (const a of options) {
      if (field.options.length >= maxOptions) break;
      const shown = customerOptionName(a.name, name);
      if (field.options.some((o) => o.name === shown)) continue;
      field.options.push({ name: shown, thumb: a.meta?.thumb ?? a.url });
    }
    fields.set(name, field);
  }
  return [...fields.values()];
}

/** The first two option pictures of a set, for its card: a drawn set's cut files, an imported set's zone pictures. */
export async function setPreviewOptions(db: Db, p: CtCharProject): Promise<string[]> {
  const slot = p.layers?.slots.find((s) => s.files.length >= 2);
  if (slot) return slot.files.slice(0, 2).map((f) => f.viewThumbUrl || f.thumbUrl || f.url);
  if (!p.brief.imported || !p.product_ids[0]) return [];
  const fields = await productOptionFields(db, p.product_ids[0], 40, 2);
  return fields[0]?.options.slice(0, 2).map((o) => o.thumb) ?? [];
}

/** GET char/projects/:id/options */
export async function getSetOptions(s: CtSession, id: string): Promise<NextResponse> {
  const p = await loadProject(s.supabase, id);
  if (!p) return jsonError("Không tìm thấy bộ", 404);
  const productId = p.product_ids[0];
  if (!productId) return NextResponse.json({ fields: [] });
  try {
    return NextResponse.json({ fields: await productOptionFields(s.supabase, productId) });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : String(e), 500);
  }
}
