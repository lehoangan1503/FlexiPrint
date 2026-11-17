/**
 * A base's preview reaching the store (asked 2026-11-17: "phôi + preview ở product base thay đổi ảnh preview thì các
 * sản phẩm dùng nó có thay đổi không?"). Saving the base re-lays every product on it in flexi2 at once (applyBase), but
 * the store reads published templates only — so the base page lists the products whose published preview is older and
 * publishes them again in one click (template only: Shopify product, photos and price stay).
 *
 *   GET  base-products/:id/republish → CtBaseStoreState
 *   POST base-products/:id/republish → CtBaseRepublishResult
 *
 * setBasePreview — a scene of the base made its preview (MCP set_base_preview), products re-laid like a base save.
 */

import { NextResponse } from "next/server";
import { CT_TABLES } from "../config";
import type { CtBaseRepublishResult, CtBaseStoreState, CtProduct, CtProductScene } from "../types";
import { normalizeProductConfig } from "../lib/design";
import { normalizeBaseConfig } from "../lib/base-product";
import { normalizeScene } from "../lib/scene";
import { publish } from "./handlers";
import { applyBase } from "./artwork-link";
import type { CtSession } from "./supabase";

interface PublishedRow {
  product_id: string;
  version: number;
  template: { config?: { scene?: unknown } } | null;
}

const sameScene = (a: CtProductScene, b: CtProductScene) =>
  a.url === b.url && (a.overlay ?? "") === (b.overlay ?? "") && ["x", "y", "w", "h"].every((k) => Math.abs(a.box[k as keyof CtProductScene["box"]] - b.box[k as keyof CtProductScene["box"]]) < 0.5);

/** The base's products on the store, and those whose published preview is not the one flexi2 shows now. */
export async function baseStoreState(db: CtSession["supabase"], baseId: string): Promise<CtBaseStoreState & { ids: string[] }> {
  const { data: products } = await db
    .from(CT_TABLES.products)
    .select("id, name, config, published_version")
    .eq("base_product_id", baseId)
    .eq("kind", "product")
    .not("published_version", "is", null)
    .returns<Array<Pick<CtProduct, "id" | "name" | "config" | "published_version">>>();
  const list = products ?? [];
  const stale: CtBaseStoreState["stale"] = [];
  for (const p of list) {
    const { data: row } = await db
      .from(CT_TABLES.templates)
      .select("product_id, version, template")
      .eq("product_id", p.id)
      .eq("version", p.published_version as number)
      .maybeSingle<PublishedRow>();
    const live = normalizeScene(row?.template?.config?.scene ?? null);
    if (!sameScene(live, normalizeProductConfig(p.config).scene)) stale.push({ id: p.id, name: p.name });
  }
  return { deployed: list.length, stale, ids: stale.map((p) => p.id) };
}

/** GET base-products/:id/republish */
export async function getBaseStoreState(s: CtSession, baseId: string): Promise<NextResponse> {
  const st = await baseStoreState(s.supabase, baseId);
  return NextResponse.json({ deployed: st.deployed, stale: st.stale } satisfies CtBaseStoreState);
}

/** POST base-products/:id/republish — every product of the base whose store preview is old, published again. */
export async function republishBase(s: CtSession, baseId: string, origin: string): Promise<NextResponse> {
  const { stale } = await baseStoreState(s.supabase, baseId);
  const out: CtBaseRepublishResult = { published: 0, failed: [] };
  for (const p of stale) {
    const res = await publish(s, p.id, origin);
    if (res.ok) out.published++;
    else out.failed.push(`${p.name}: ${String(((await res.json().catch(() => ({}))) as { error?: unknown }).error ?? res.status)}`);
  }
  return NextResponse.json(out);
}

/** A scene of the base made its preview; the products on it re-laid (flexi2 only — the store needs republishBase). */
export async function setBasePreview(s: CtSession, baseId: string, sceneId: string): Promise<{ reapplied: number; failed: string[] }> {
  const { data: row } = await s.supabase.from(CT_TABLES.baseProducts).select("config").eq("id", baseId).maybeSingle<{ config: Record<string, unknown> | null }>();
  if (!row) throw new Error("Không tìm thấy product base");
  const scene = normalizeBaseConfig(row.config).previewScenes.find((sc) => sc.id === sceneId);
  if (!scene) throw new Error("Base không có nền này (scene_id)");
  const { data: saved, error } = await s.supabase
    .from(CT_TABLES.baseProducts)
    .update({ config: { ...(row.config ?? {}), preview: scene.scene } })
    .eq("id", baseId)
    .select("id")
    .maybeSingle<{ id: string }>();
  if (error) throw new Error(error.message);
  if (!saved) throw new Error("Không có quyền sửa product base này");
  const { data: products } = await s.supabase.from(CT_TABLES.products).select("*").eq("base_product_id", baseId).eq("kind", "product").returns<CtProduct[]>();
  const failed: string[] = [];
  for (const p of products ?? []) await applyBase(s.supabase, p).catch((e: Error) => failed.push(`${p.name}: ${e.message}`));
  return { reapplied: (products ?? []).length - failed.length, failed };
}
