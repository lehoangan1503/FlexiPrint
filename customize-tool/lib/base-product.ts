/**
 * Product base config (ct_base_products.config, types CtBaseProductConfig) — normalised the same way in the browser
 * (base product page) and on the server (server/base-products.ts).
 */

import type { CtBaseCut, CtBaseCutMode, CtBaseProductConfig, CtMaterialId, CtPrintArea } from "../types";
import { newId } from "./geometry";
import { normalizeScene } from "./scene";

const MATERIALS: CtMaterialId[] = ["none", "acrylic_white", "acrylic_clear", "glass_clear", "ceramic_gloss", "ceramic_matte", "aluminum", "wood"];

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function num(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
}

function uuidOrNull(v: unknown): string | null {
  return typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v : null;
}

/** What a piece of `material` is cut like when the base says nothing: acrylic / wood along the art, a khuôn when it has one. */
export function defaultBaseCut(material: CtMaterialId, templateId: string | null): CtBaseCut {
  const alpha = material.startsWith("acrylic") || material === "wood";
  const mode: CtBaseCutMode = alpha ? "alpha" : templateId ? "khuon" : "none";
  return { mode, borderMm: alpha ? 2.5 : 0, silhouette: alpha, hole: alpha, holeSize: 9 };
}

function normalizeCut(raw: unknown, material: CtMaterialId, templateId: string | null): CtBaseCut {
  const d = defaultBaseCut(material, templateId);
  if (!raw || typeof raw !== "object") return d;
  const c = raw as Partial<Record<keyof CtBaseCut, unknown>>;
  const mode: CtBaseCutMode = c.mode === "khuon" || c.mode === "alpha" || c.mode === "none" ? c.mode : d.mode;
  const f = (v: unknown, lo: number, hi: number, dflt: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
  return {
    mode,
    borderMm: f(c.borderMm, 0, 20, d.borderMm),
    silhouette: typeof c.silhouette === "boolean" ? c.silhouette : d.silhouette,
    hole: typeof c.hole === "boolean" ? c.hole : d.hole,
    holeSize: f(c.holeSize, 3, 30, d.holeSize),
  };
}

export function normalizeBaseConfig(raw: unknown): CtBaseProductConfig {
  const c = raw && typeof raw === "object" ? (raw as Partial<Record<keyof CtBaseProductConfig, unknown>>) : {};
  const areas = Array.isArray(c.printAreas) ? c.printAreas : [];
  const ful = c.fulfillment && typeof c.fulfillment === "object" ? (c.fulfillment as Partial<Record<string, unknown>>) : {};
  const material: CtMaterialId = MATERIALS.includes(c.material as CtMaterialId) ? (c.material as CtMaterialId) : "none";
  const templateId = uuidOrNull(c.templateId);
  return {
    description: str(c.description, 20000),
    productType: str(c.productType, 120),
    material,
    priceTableId: uuidOrNull(c.priceTableId),
    templateId,
    printAreas: areas
      .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
      .map(
        (a): CtPrintArea => ({
          id: str(a.id, 64) || newId(),
          name: str(a.name, 60) || "Front",
          width: num(a.width, 1, 30000, 1000),
          height: num(a.height, 1, 30000, 1000),
          dpi: num(a.dpi, 1, 2400, 300),
        }),
      )
      .slice(0, 8),
    fulfillment: { provider: str(ful.provider, 80), catalogId: str(ful.catalogId, 120) },
    notes: str(c.notes, 4000),
    cut: normalizeCut(c.cut, material, templateId),
    preview: normalizeScene(c.preview && typeof c.preview === "object" ? c.preview : null),
  };
}

