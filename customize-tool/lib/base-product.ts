/**
 * Product base config (ct_base_products.config, types CtBaseProductConfig) — normalised the same way in the browser
 * (base product page) and on the server (server/base-products.ts).
 */

import type { CtBaseProductConfig, CtMaterialId, CtPrintArea } from "../types";
import { newId } from "./geometry";

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

export function normalizeBaseConfig(raw: unknown): CtBaseProductConfig {
  const c = raw && typeof raw === "object" ? (raw as Partial<Record<keyof CtBaseProductConfig, unknown>>) : {};
  const areas = Array.isArray(c.printAreas) ? c.printAreas : [];
  const ful = c.fulfillment && typeof c.fulfillment === "object" ? (c.fulfillment as Partial<Record<string, unknown>>) : {};
  return {
    description: str(c.description, 20000),
    productType: str(c.productType, 120),
    material: MATERIALS.includes(c.material as CtMaterialId) ? (c.material as CtMaterialId) : "none",
    priceTableId: uuidOrNull(c.priceTableId),
    templateId: uuidOrNull(c.templateId),
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
  };
}

