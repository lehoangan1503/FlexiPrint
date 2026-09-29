/**
 * Material catalog — how a finished design is rendered as a physical product
 * (acrylic plate, ceramic ornament…). Pure data, no DOM: the editor, the
 * storefront and the server (print files) share it. The canvas renderer is
 * lib/material-render.ts; the production files come from services/material-render.
 *
 * Each preset is a set of rendering knobs, so a new material is one entry here.
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
  gloss: number;
  shadow: number;
  /** Colour of the plate face under the print; null = no plate face (flat). */
  face: string | null;
  /** 0..1 — below 1 the scene shows through the plate border (clear acrylic). */
  faceOpacity: number;
  /** Plate edge colours, top → bottom of the thickness. */
  edge: [string, string];
  /** Inner-rim bevel light (top-left) / dark (bottom-right) strength 0..1. */
  bevel: number;
  /** Soft shading near the outline — a curved glaze / pillowy edge, 0..1. */
  pillow: number;
  /** "gloss" = one soft diagonal highlight; "sheen" = brushed-metal bands; "grain" = wood fibres. */
  finish: "gloss" | "sheen" | "grain" | "none";
  /** Tint multiplied over the print (wood absorbs ink); null = none. */
  printTint: string | null;
}

export const CT_MATERIALS: CtMaterialPreset[] = [
  {
    id: "none",
    label: "Phẳng (không vật liệu)",
    hint: "Ảnh thiết kế như vẽ, không hiệu ứng",
    shape: "main",
    thicknessMm: 0,
    borderMm: 0,
    gloss: 0,
    shadow: 0,
    face: null,
    faceOpacity: 1,
    edge: ["#ffffff", "#ffffff"],
    bevel: 0,
    pillow: 0,
    finish: "none",
    printTint: null,
  },
  {
    id: "acrylic_white",
    label: "Acrylic trắng (cắt theo hình)",
    hint: "In UV lên acrylic có lót trắng, cắt laser theo viền thiết kế + viền trắng (kẹp xe, standee)",
    shape: "contour",
    thicknessMm: 3,
    borderMm: 2.5,
    gloss: 0.35,
    shadow: 0.55,
    face: "#ffffff",
    faceOpacity: 1,
    edge: ["#f4f6f8", "#b9c1c9"],
    bevel: 0.7,
    pillow: 0.08,
    finish: "gloss",
    printTint: null,
  },
  {
    id: "acrylic_clear",
    label: "Acrylic trong",
    hint: "Acrylic trong suốt — viền plate thấy nền phía sau, cạnh dày ánh xanh",
    shape: "contour",
    thicknessMm: 3,
    borderMm: 2.5,
    gloss: 0.5,
    shadow: 0.35,
    face: "#eef6fb",
    faceOpacity: 0.28,
    edge: ["#e6f4fb", "#8fb6c9"],
    bevel: 0.9,
    pillow: 0,
    finish: "gloss",
    printTint: null,
  },
  {
    id: "ceramic_gloss",
    label: "Sứ bóng",
    hint: "Phôi sứ tráng men (ornament tròn): main = phôi trắng, mọi layer in lên phôi, men bóng",
    shape: "main",
    thicknessMm: 0,
    borderMm: 0,
    gloss: 0.6,
    shadow: 0.45,
    face: null,
    faceOpacity: 1,
    edge: ["#ffffff", "#d9d9d4"],
    bevel: 0.25,
    pillow: 0.22,
    finish: "gloss",
    printTint: null,
  },
  {
    id: "ceramic_matte",
    label: "Sứ mờ",
    hint: "Phôi sứ không men / men mờ — không vệt bóng, bo cạnh mềm",
    shape: "main",
    thicknessMm: 0,
    borderMm: 0,
    gloss: 0.12,
    shadow: 0.4,
    face: null,
    faceOpacity: 1,
    edge: ["#ffffff", "#d9d9d4"],
    bevel: 0.15,
    pillow: 0.18,
    finish: "gloss",
    printTint: null,
  },
  {
    id: "aluminum",
    label: "Nhôm in (metal)",
    hint: "Tấm nhôm in — ánh kim dạng dải, cạnh mỏng xám",
    shape: "main",
    thicknessMm: 1,
    borderMm: 1.5,
    gloss: 0.4,
    shadow: 0.45,
    face: "#e9ecef",
    faceOpacity: 1,
    edge: ["#d5dade", "#8a9197"],
    bevel: 0.5,
    pillow: 0,
    finish: "sheen",
    printTint: null,
  },
  {
    id: "wood",
    label: "Gỗ in",
    hint: "Gỗ ép in UV — vân gỗ lộ nhẹ qua mực, cạnh gỗ",
    shape: "contour",
    thicknessMm: 3,
    borderMm: 2,
    gloss: 0.05,
    shadow: 0.5,
    face: "#e8cfa6",
    faceOpacity: 1,
    edge: ["#c89b63", "#8a6034"],
    bevel: 0.35,
    pillow: 0,
    finish: "grain",
    printTint: "#f3dfbf",
  },
];

const BY_ID = new Map(CT_MATERIALS.map((m) => [m.id, m]));

export function isMaterialId(id: string): id is CtMaterialId {
  return BY_ID.has(id as CtMaterialId);
}

export function materialPreset(id: CtMaterialId | undefined): CtMaterialPreset {
  return BY_ID.get(id ?? "none") ?? CT_MATERIALS[0];
}

export function defaultMaterialConfig(): CtMaterialConfig {
  return {
    id: "none",
    shape: "main",
    widthMm: 140,
    borderMm: 0,
    thicknessMm: 0,
    shadow: 0,
    gloss: 0,
    sceneAssetId: null,
    scene: { x: 0.5, y: 0.5, width: 0.7, rotation: 0 },
  };
}

/** The config a material starts with when picked (keeps size + scene). */
export function applyMaterialPreset(cur: CtMaterialConfig, id: CtMaterialId): CtMaterialConfig {
  const p = materialPreset(id);
  return { ...cur, id, shape: p.shape, borderMm: p.borderMm, thicknessMm: p.thicknessMm, gloss: p.gloss, shadow: p.shadow };
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

export function normalizeMaterialConfig(raw: Partial<CtMaterialConfig> | null | undefined): CtMaterialConfig {
  const base = defaultMaterialConfig();
  if (!raw) return base;
  const scene: Partial<CtMaterialConfig["scene"]> = raw.scene ?? {};
  return {
    id: raw.id && isMaterialId(raw.id) ? raw.id : base.id,
    shape: raw.shape === "contour" || raw.shape === "main" ? raw.shape : base.shape,
    widthMm: num(raw.widthMm, base.widthMm, 5, 2000),
    borderMm: num(raw.borderMm, base.borderMm, 0, 50),
    thicknessMm: num(raw.thicknessMm, base.thicknessMm, 0, 30),
    shadow: num(raw.shadow, base.shadow, 0, 1),
    gloss: num(raw.gloss, base.gloss, 0, 1),
    sceneAssetId: typeof raw.sceneAssetId === "string" && raw.sceneAssetId ? raw.sceneAssetId : null,
    scene: {
      x: num(scene.x, base.scene.x, -1, 2),
      y: num(scene.y, base.scene.y, -1, 2),
      width: num(scene.width, base.scene.width, 0.02, 3),
      rotation: num(scene.rotation, base.scene.rotation, -180, 180),
    },
  };
}

/** Main-asset pixels per millimetre. */
export function pxPerMm(material: CtMaterialConfig, mainWidthPx: number): number {
  return mainWidthPx / Math.max(1, material.widthMm);
}

/** Does this config change the picture at all? */
export function materialActive(material: CtMaterialConfig): boolean {
  return material.id !== "none" || material.sceneAssetId !== null;
}
