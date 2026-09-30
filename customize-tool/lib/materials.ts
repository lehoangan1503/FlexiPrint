/**
 * Material catalog — the physical product a design is printed on (acrylic
 * plate, ceramic ornament…). Pure data: the editor and the server (print
 * files, services/material-render) share it.
 *
 * Only production facts live here (outline, border, thickness, white ink).
 * How a material LOOKS is AI-rendered from a prompt preset (ct_presets kind
 * "material", ComfyUI studio) into clipart renditions — no canvas simulation.
 */

import type { CtMaterialConfig, CtMaterialId, CtMaterialShape } from "../types";

export interface CtMaterialPreset {
  id: CtMaterialId;
  /** Editor-facing. */
  label: string;
  hint: string;
  /** Outline the material usually has (the editor pre-selects it; the user can change it). */
  shape: CtMaterialShape;
  thicknessMm: number;
  borderMm: number;
  /** The print needs a white-ink layer (white.png). */
  whiteInk: boolean;
}

export const CT_MATERIALS: CtMaterialPreset[] = [
  { id: "none", label: "Phẳng (không vật liệu)", hint: "Chỉ xuất ảnh in, không đường cắt", shape: "main", thicknessMm: 0, borderMm: 0, whiteInk: false },
  {
    id: "acrylic_white",
    label: "Acrylic trắng (cắt theo hình)",
    hint: "In UV lên acrylic có lót trắng, cắt laser theo viền thiết kế + viền (kẹp xe, standee)",
    shape: "contour",
    thicknessMm: 3,
    borderMm: 2.5,
    whiteInk: true,
  },
  { id: "acrylic_clear", label: "Acrylic trong", hint: "Acrylic trong suốt, lớp mực trắng dưới phần in, cắt theo viền", shape: "contour", thicknessMm: 3, borderMm: 2.5, whiteInk: true },
  { id: "ceramic_gloss", label: "Sứ bóng", hint: "Phôi sứ (ornament tròn): main = phôi, mọi layer in lên phôi", shape: "main", thicknessMm: 0, borderMm: 0, whiteInk: false },
  { id: "ceramic_matte", label: "Sứ mờ", hint: "Phôi sứ men mờ: main = phôi", shape: "main", thicknessMm: 0, borderMm: 0, whiteInk: false },
  { id: "aluminum", label: "Nhôm in (metal)", hint: "Tấm nhôm in", shape: "main", thicknessMm: 1, borderMm: 1.5, whiteInk: false },
  { id: "wood", label: "Gỗ in", hint: "Gỗ ép in UV, cắt theo viền", shape: "contour", thicknessMm: 3, borderMm: 2, whiteInk: false },
];

const BY_ID = new Map(CT_MATERIALS.map((m) => [m.id, m]));

export function isMaterialId(id: string): id is CtMaterialId {
  return BY_ID.has(id as CtMaterialId);
}

export function materialPreset(id: CtMaterialId | undefined): CtMaterialPreset {
  return BY_ID.get(id ?? "none") ?? CT_MATERIALS[0];
}

export function defaultMaterialConfig(): CtMaterialConfig {
  return { id: "none", shape: "main", widthMm: 140, borderMm: 0, thicknessMm: 0, display: "flat" };
}

/** The config a material starts with when picked (keeps the size). */
export function applyMaterialPreset(cur: CtMaterialConfig, id: CtMaterialId): CtMaterialConfig {
  const p = materialPreset(id);
  return { ...cur, id, shape: p.shape, borderMm: p.borderMm, thicknessMm: p.thicknessMm };
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

/** Configs saved before 006 carry shadow / gloss / scene keys: dropped here. */
export function normalizeMaterialConfig(raw: Partial<CtMaterialConfig> | null | undefined): CtMaterialConfig {
  const base = defaultMaterialConfig();
  if (!raw) return base;
  return {
    id: raw.id && isMaterialId(raw.id) ? raw.id : base.id,
    shape: raw.shape === "contour" || raw.shape === "main" ? raw.shape : base.shape,
    widthMm: num(raw.widthMm, base.widthMm, 5, 2000),
    borderMm: num(raw.borderMm, base.borderMm, 0, 50),
    thicknessMm: num(raw.thicknessMm, base.thicknessMm, 0, 30),
    display: raw.display === "rendition" ? "rendition" : "flat",
  };
}

/** Main-asset pixels per millimetre. */
export function pxPerMm(material: CtMaterialConfig, mainWidthPx: number): number {
  return mainWidthPx / Math.max(1, material.widthMm);
}
