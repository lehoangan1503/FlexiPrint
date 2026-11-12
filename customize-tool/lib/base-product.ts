/**
 * Product base config (ct_base_products.config, types CtBaseProductConfig) — normalised the same way in the browser
 * (base product page) and on the server (server/base-products.ts).
 */

import type { CtBaseCut, CtBaseCutMode, CtBaseProductConfig, CtBaseScene, CtBaseScenePreset, CtBaseSource, CtBaseVariant, CtMaterialId, CtPrintArea } from "../types";
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
  return { mode, borderMm: alpha ? 2.5 : 0, silhouette: true, hole: alpha, holeSize: 9 };
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
    // Every print file carries its silhouette (2026-11-10: "file in ra luôn phải có silhouette") — no switch.
    silhouette: true,
    hole: typeof c.hole === "boolean" ? c.hole : d.hole,
    holeSize: f(c.holeSize, 3, 30, d.holeSize),
  };
}

function money(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

function normalizeVariants(raw: unknown): CtBaseVariant[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
    .map(
      (v): CtBaseVariant => ({
        id: str(v.id, 64) || newId(),
        size: str(v.size, 120),
        color: str(v.color, 80),
        colorHex: /^#[0-9a-f]{3,8}$/i.test(str(v.colorHex, 9)) ? str(v.colorHex, 9) : null,
        sku: str(v.sku, 160),
        cost: money(v.cost),
        weightG: money(v.weightG),
        printArea: str(v.printArea, 120),
        printWidth: typeof v.printWidth === "number" && v.printWidth > 0 ? num(v.printWidth, 1, 30000, 1000) : null,
        printHeight: typeof v.printHeight === "number" && v.printHeight > 0 ? num(v.printHeight, 1, 30000, 1000) : null,
      }),
    )
    .slice(0, 500);
}

function normalizeSource(raw: unknown): CtBaseSource | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<Record<keyof CtBaseSource, unknown>>;
  const provider = s.provider === "printbelle" || s.provider === "merchize" ? s.provider : null;
  const catalogId = str(s.catalogId, 120);
  if (!provider || !catalogId) return null;
  return {
    provider,
    catalogId,
    via: s.via === "teeinblue" ? "teeinblue" : "printbelle",
    teeinblueId: typeof s.teeinblueId === "number" && Number.isFinite(s.teeinblueId) ? s.teeinblueId : null,
    importedAt: str(s.importedAt, 40),
    photos: Array.isArray(s.photos) ? s.photos.filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u)).slice(0, 12) : [],
    links: (Array.isArray(s.links) ? s.links : [])
      .map((l) => (l && typeof l === "object" ? (l as Partial<Record<"label" | "url", unknown>>) : {}))
      .filter((l): l is { label: string; url: string } => typeof l.url === "string" && /^https:\/\//.test(l.url) && typeof l.label === "string")
      .slice(0, 12)
      .map((l) => ({ label: l.label.slice(0, 160), url: l.url.slice(0, 500) })),
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
    variants: normalizeVariants(c.variants),
    source: normalizeSource(c.source),
    preview: normalizeScene(c.preview && typeof c.preview === "object" ? c.preview : null),
    previewScenes: normalizeBaseScenes(c.previewScenes),
    scenesAuto: str(c.scenesAuto, 40) || null,
  };
}

const SCENE_PRESETS: CtBaseScenePreset[] = ["home", "holiday", "minimal", "custom"];

function normalizeBaseScenes(raw: unknown): CtBaseScene[] {
  if (!Array.isArray(raw)) return [];
  const out: CtBaseScene[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Partial<Record<keyof CtBaseScene, unknown>>;
    const scene = normalizeScene(o.scene && typeof o.scene === "object" ? o.scene : null);
    if (!scene.url) continue;
    out.push({
      id: str(o.id, 64) || newId(),
      preset: SCENE_PRESETS.find((p) => p === o.preset) ?? "custom",
      prompt: str(o.prompt, 1000),
      scene,
      plain: normalizeScene(o.plain && typeof o.plain === "object" ? o.plain : null),
      found: o.found === true,
      at: str(o.at, 40),
    });
  }
  return out.slice(-24);
}

