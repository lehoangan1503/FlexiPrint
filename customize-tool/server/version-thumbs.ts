/**
 * Pictures for a product's VERSION tiles (asked 2026-11-04: "Choose Design" showed "Red / Gre / Rei" — the system
 * should look at the product and give each version a picture). A version's own asset is often a blank sheet: what it
 * looks like is its layers. So each version is drawn as the print (server/print-render, default options), cropped
 * close to its pixels on a square, and stored as the version asset's meta.thumb — the storefront's tile
 * (display "image") and the editor's Version list show it. Made after every product build that has versions;
 * MCP make_version_thumbs makes them again after a hand edit.
 */

import sharp from "sharp";
import { CT_TABLES } from "../config";
import { CT_MAIN_KEY, type CtAsset, type CtProductConfig } from "../types";
import { mainVersions, normalizeProductConfig } from "../lib/design";
import { loadArtwork, renderArtwork } from "./print-render";
import { ctStoragePath, ctUpload } from "./storage";
import type { PrintDb } from "./print-products";

/** Tile side, px (the storefront tile is ~120 css px: 2× for sharp screens, a little more for the editor). */
const TILE = 320;

export interface VersionThumbsResult {
  /** Versions given a picture: name → its url. */
  made: Record<string, string>;
  /** Versions that came out empty or failed, with why. */
  failed: string[];
}

/** The version picture cropped to its pixels, padded to a square, TILE px; null when it has no visible pixels. */
async function square(png: Buffer): Promise<Buffer | null> {
  const trimmed = await sharp(png).trim({ threshold: 0 }).toBuffer({ resolveWithObject: true }).catch(() => null);
  if (!trimmed) return null;
  const { width: w, height: h } = trimmed.info;
  const side = Math.max(w, h);
  const pad = Math.round(side * 0.05);
  // Padded first, then scaled (sharp resizes before it extends in one pipeline — see server/char/import optionPicture).
  const padded = await sharp(trimmed.data)
    .extend({ top: pad + Math.floor((side - h) / 2), bottom: pad + Math.ceil((side - h) / 2), left: pad + Math.floor((side - w) / 2), right: pad + Math.ceil((side - w) / 2), background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return sharp(padded).resize(TILE, TILE).webp({ quality: 86, alphaQuality: 90 }).toBuffer();
}

/**
 * Every version of `productId` drawn and stored as its tile picture; the version picker switched to pictures
 * (config.main.display "image") once every version has one. A product with one version (or versions off) is left
 * as it is. Never throws for one version: it is listed in `failed`.
 */
export async function makeVersionThumbs(db: PrintDb, productId: string): Promise<VersionThumbsResult> {
  const bundle = await loadArtwork(db, productId);
  if (!bundle) throw new Error("No such product");
  const config = normalizeProductConfig(bundle.product.config);
  const mainId = bundle.product.main_asset_id;
  const mains = config.main.enabled && mainId ? mainVersions(bundle.assets, mainId) : [];
  const out: VersionThumbsResult = { made: {}, failed: [] };
  if (mains.length < 2) return out;

  const one = async (m: CtAsset) => {
    try {
      const png = await renderArtwork(bundle, { [CT_MAIN_KEY]: { kind: "main", assetId: m.id, optionId: null } }, 1000, "print");
      const tile = await square(png);
      if (!tile) {
        out.failed.push(`${m.name}: nothing drawn`);
        return;
      }
      const url = await ctUpload(ctStoragePath(bundle.product.user_id, productId, "version-thumb", "image/webp"), tile, "image/webp");
      const { error } = await db.from(CT_TABLES.assets).update({ meta: { ...(m.meta ?? {}), thumb: url } }).eq("id", m.id);
      if (error) throw new Error(error.message);
      out.made[m.name] = url;
    } catch (e) {
      out.failed.push(`${m.name}: ${(e as Error).message}`);
    }
  };
  // A few at once: each one fetches every layer file of its version.
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, mains.length) }, async () => {
      for (let i = next++; i < mains.length; i = next++) await one(mains[i]);
    }),
  );

  if (!out.failed.length && config.main.display !== "image") {
    const raw = (bundle.product.config ?? {}) as Partial<CtProductConfig>;
    const next: Partial<CtProductConfig> = { ...raw, main: { ...config.main, display: "image" } };
    await db.from(CT_TABLES.products).update({ config: next }).eq("id", productId);
  }
  return out;
}
