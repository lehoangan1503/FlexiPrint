/**
 * Production files for material products (acrylic / ceramic / metal / wood):
 * the editor posts the full-resolution flat design, this forwards it to the
 * material-render microservice (services/material-render) together with the
 * product's material config and the preset knobs from lib/materials.ts — the
 * single catalog of materials — and streams back the zip
 * (print.png, white.png, cut.svg, preview.png, meta.json).
 *
 * Env: CT_MATERIAL_URL (e.g. http://127.0.0.1:7003), CT_MATERIAL_TOKEN.
 */

import { NextResponse } from "next/server";
import type { CtMaterialConfig } from "../types";
import { materialPreset, normalizeMaterialConfig } from "../lib/materials";

const MAX_BYTES = 500 * 1024 * 1024;

export interface CtPrintPackRequest {
  design: Blob;
  main: Blob | null;
  material: CtMaterialConfig;
  dpi: number;
}

/** Parse the editor's multipart body: file, main?, material (JSON), dpi?. Returns an error message on bad input. */
export function readPrintPackForm(form: FormData): CtPrintPackRequest | string {
  const design = form.get("file");
  if (!(design instanceof Blob) || design.size === 0) return "Thiếu file thiết kế";
  if (design.size > MAX_BYTES) return "File thiết kế quá lớn (tối đa 500 MB)";
  const main = form.get("main");
  let material: CtMaterialConfig;
  try {
    material = normalizeMaterialConfig(JSON.parse(String(form.get("material") ?? "{}")) as Partial<CtMaterialConfig>);
  } catch {
    return "material phải là JSON";
  }
  if (material.id === "none") return "Chưa chọn vật liệu";
  const dpi = Number(form.get("dpi") ?? 300);
  return {
    design,
    main: main instanceof Blob && main.size > 0 && main.size <= MAX_BYTES ? main : null,
    material,
    dpi: Number.isFinite(dpi) ? Math.min(1200, Math.max(72, Math.round(dpi))) : 300,
  };
}

export async function printPack(req: CtPrintPackRequest): Promise<NextResponse> {
  const base = process.env.CT_MATERIAL_URL;
  if (!base) return NextResponse.json({ error: "Chưa cấu hình CT_MATERIAL_URL (services/material-render)" }, { status: 501 });
  const preset = materialPreset(req.material.id);
  const params = {
    material: req.material.id,
    shape: req.material.shape,
    widthMm: req.material.widthMm,
    borderMm: req.material.borderMm,
    thicknessMm: req.material.thicknessMm,
    shadow: req.material.shadow,
    gloss: req.material.gloss,
    dpi: req.dpi,
    preset: {
      face: preset.face,
      faceOpacity: preset.faceOpacity,
      edge: preset.edge,
      bevel: preset.bevel,
      pillow: preset.pillow,
      finish: preset.finish,
      printTint: preset.printTint,
    },
  };
  const form = new FormData();
  form.append("file", req.design, "design.png");
  if (req.main && req.material.shape === "main") form.append("main", req.main, "main.png");
  form.append("params", JSON.stringify(params));
  const token = process.env.CT_MATERIAL_TOKEN;
  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/$/, "")}/print-pack`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    return NextResponse.json(
      { error: `material-render không phản hồi (${base}) — service chưa chạy? (${e instanceof Error ? e.message : String(e)})` },
      { status: 502 },
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = text.slice(0, 300);
    try {
      const j: { detail?: string } = JSON.parse(text);
      message = j.detail ?? message;
    } catch {
      // plain-text error body
    }
    return NextResponse.json({ error: `material-render ${res.status}: ${message}` }, { status: 502 });
  }
  return new NextResponse(await res.arrayBuffer(), {
    status: 200,
    headers: { "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="print-pack.zip"' },
  });
}
