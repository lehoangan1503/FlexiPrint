"use client";

/**
 * Every version of a product is an artwork (asked 2026-10-10): a clipart of many layers, flattened. When the design is
 * saved, each version is rendered as its print file (the whole edit frame, cut to the khuôn — what File in shows) with
 * the content chosen in the editor, and stored in the product's folder of the library (server/artworks.ts). A
 * version whose layers and content did not change since its last artwork is not uploaded again.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CT_MAIN_KEY } from "../../types";
import type { CtAsset, CtProduct, CtProductConfig, CtRegion, CtRegionItem, CtSelection } from "../../types";
import { ctApi } from "../../lib/api-client";
import { canvasToBlob, renderComposite } from "../../lib/compositor";
import { displayAssets } from "../../lib/library";
import { claimSharedLayers, versionLayers } from "../../lib/layout";
import { defaultRegionSelection, isSelectionValid, mainVersions, normalizeProductConfig, normalizeRegion } from "../../lib/design";

export interface ArtworkSaverInput {
  product: CtProduct | null;
  main: CtAsset | null;
  mains: CtAsset[];
  assets: CtAsset[];
  regions: CtRegion[];
  items: CtRegionItem[];
  config: CtProductConfig;
  selection: CtSelection;
  onError: (message: string) => void;
}

export interface ArtworkSaver {
  /** Render + store every changed version (background; a call while running runs once more after). */
  saveAll: () => void;
  /** The content shown now as one more artwork (not tied to a version). */
  saveExtra: (name: string) => Promise<void>;
  busy: boolean;
  /** The product's folder (category) once known. */
  folderName: string | null;
}

/** djb2 over a string → short hex: enough to tell "changed" from "same". */
function hashOf(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/** A version's content: the editor's choices with that version picked (the shown one keeps its sub-option). */
function versionSelection(selection: CtSelection, mainId: string): CtSelection {
  const cur = selection[CT_MAIN_KEY];
  const keepOption = cur?.kind === "main" && cur.assetId === mainId ? cur.optionId ?? null : null;
  return { ...selection, [CT_MAIN_KEY]: { kind: "main", assetId: mainId, optionId: keepOption } };
}

/** What is stored with the artwork: local test photos (blob: urls) are not kept. */
function storedSelection(selection: CtSelection): CtSelection {
  const out: CtSelection = {};
  for (const [k, v] of Object.entries(selection)) {
    if (v.kind === "photo" && (v.url?.startsWith("blob:") || v.sourceUrl?.startsWith("blob:"))) continue;
    out[k] = v;
  }
  return out;
}

export interface VersionArtworksInput {
  product: CtProduct;
  main: CtAsset;
  mains: CtAsset[];
  assets: CtAsset[];
  regions: CtRegion[];
  items: CtRegionItem[];
  config: CtProductConfig;
  selection: CtSelection;
}

/**
 * Every version of the product rendered as its print file and stored as its artwork; a version whose hash is in
 * `hashes` already (versionId → hash) is skipped, and `hashes` is updated. Versions gone from the product lose
 * theirs. Used by the editor's Lưu thiết kế and by the dashboard's Artwork tab (a product never saved in the editor).
 */
export async function saveVersionArtworks(input: VersionArtworksInput, hashes: Map<string, string>, onVersion?: (done: number, total: number) => void): Promise<number> {
  const { product, main, mains, assets, regions, items, config, selection } = input;
  let made = 0;
  for (const [k, m] of mains.entries()) {
    onVersion?.(k, mains.length);
    const sel = versionSelection(selection, m.id);
    const layers = versionLayers(regions, items, m.id);
    const used = new Set(layers.regions.map((r) => r.id));
    const content = Object.fromEntries(Object.entries(sel).filter(([key]) => key === CT_MAIN_KEY || used.has(key)));
    const hash = hashOf(JSON.stringify({ r: layers.regions, i: layers.items, s: content, l: config.layouts[m.id] ?? null, print: config.print?.spec.outline ?? null }));
    if (hashes.get(m.id) === hash) continue;
    const canvas = await renderComposite({ main, assets: displayAssets(assets, "flat"), regions, items, selection: sel, scale: 1, layouts: config.layouts, cutToFrame: true });
    const file = await canvasToBlob(canvas, "image/png");
    await ctApi.saveProductArtwork(product.id, file, { versionId: m.id, hash, name: `${product.name} — ${m.name || "version"}`, selection: storedSelection(content) });
    hashes.set(m.id, hash);
    made++;
  }
  onVersion?.(mains.length, mains.length);
  await ctApi.pruneProductArtworks(product.id, mains.map((m) => m.id));
  return made;
}

export function useArtworkSaver(input: ArtworkSaverInput): ArtworkSaver {
  const ref = useRef(input);
  ref.current = input;
  const hashes = useRef(new Map<string, string>());
  const loaded = useRef<string | null>(null);
  const running = useRef(false);
  const again = useRef(false);
  const [busy, setBusy] = useState(false);
  const [folderName, setFolderName] = useState<string | null>(null);
  const productId = input.product?.id ?? null;

  // What is already in the folder (so an unchanged version is not uploaded again after a reload).
  useEffect(() => {
    if (!productId || loaded.current === productId) return;
    loaded.current = productId;
    ctApi
      .productArtworks(productId)
      .then((r) => {
        setFolderName(r.category?.name ?? null);
        for (const a of r.artworks) {
          const art = a.meta.artwork;
          if (art?.versionId && art.hash) hashes.current.set(art.versionId, art.hash);
        }
      })
      .catch(() => undefined);
  }, [productId]);

  const render = async (selection: CtSelection): Promise<Blob> => {
    const { main, assets, regions, items, config } = ref.current;
    if (!main) throw new Error("Chưa có version");
    const canvas = await renderComposite({ main, assets: displayAssets(assets, "flat"), regions, items, selection, scale: 1, layouts: config.layouts, cutToFrame: true });
    return canvasToBlob(canvas, "image/png");
  };

  const runOnce = async () => {
    const { product, main, mains, assets, regions, items, config, selection } = ref.current;
    if (!product || !main) return;
    if (await saveVersionArtworks({ product, main, mains, assets, regions, items, config, selection }, hashes.current)) setFolderName((n) => n ?? product.name);
  };

  const saveAll = useCallback(() => {
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    setBusy(true);
    void (async () => {
      try {
        do {
          again.current = false;
          await runOnce();
        } while (again.current);
      } catch (e) {
        ref.current.onError(e instanceof Error ? `Không lưu được artwork: ${e.message}` : "Không lưu được artwork");
      } finally {
        running.current = false;
        setBusy(false);
      }
    })();
    // runOnce reads everything from the ref.
  }, []);

  const saveExtra = async (name: string) => {
    const { product, selection } = ref.current;
    if (!product) return;
    setBusy(true);
    try {
      const file = await render(selection);
      await ctApi.saveProductArtwork(product.id, file, { name: name.trim() || `${product.name} — artwork`, selection: storedSelection(selection) });
      setFolderName((n) => n ?? product.name);
    } finally {
      setBusy(false);
    }
  };

  return { saveAll, saveExtra, busy, folderName };
}

/**
 * A product's artworks made from its saved design, without opening the editor (the dashboard's Artwork tab): the
 * content is the design's samples (CtProductConfig.samples), as the editor would show it. Returns how many were made.
 */
export async function buildProductArtworks(productId: string, onVersion?: (done: number, total: number) => void): Promise<number> {
  const [bundle, have] = await Promise.all([ctApi.getBundle(productId), ctApi.productArtworks(productId)]);
  const product = bundle.product;
  const main = bundle.assets.find((a) => a.id === product.main_asset_id);
  if (!main) throw new Error("Sản phẩm chưa có version");
  const config = normalizeProductConfig(product.config);
  const regions = bundle.regions.map(normalizeRegion);
  const layers = claimSharedLayers(regions, main.id) ?? regions;
  // Every layer's choice: what the designer left (samples), else its default — as the editor fills them on opening.
  const selection: CtSelection = {};
  if (config.samples[CT_MAIN_KEY]) selection[CT_MAIN_KEY] = config.samples[CT_MAIN_KEY];
  for (const r of layers) {
    const cur = config.samples[r.id];
    selection[r.id] = cur && isSelectionValid(r, cur, bundle.items, bundle.assets) ? cur : defaultRegionSelection(r, bundle.items, bundle.assets);
  }
  const hashes = new Map<string, string>();
  for (const a of have.artworks) if (a.meta.artwork?.versionId && a.meta.artwork.hash) hashes.set(a.meta.artwork.versionId, a.meta.artwork.hash);
  return saveVersionArtworks(
    {
      product,
      main,
      mains: mainVersions(bundle.assets, main.id),
      assets: bundle.assets,
      // Older designs' shared layers belong to the default version, as the editor reads them.
      regions: layers,
      items: bundle.items,
      config,
      selection,
    },
    hashes,
    onVersion,
  );
}
