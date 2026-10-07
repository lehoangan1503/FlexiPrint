/**
 * What the customer will be asked on the product page, read from the template a deploy ships — and what in the
 * design would trip the storefront (unnamed fields, clashing cart property names, empty custom layers…).
 * Pure; the Deploy page shows it (and hands it to @flexiprint as facts for the product copy).
 */

import { CT_BASE_OPTION } from "../types";
import type { CtRegion, CtRenderAsset, CtTemplate } from "../types";
import { formOrder, isLinkedLayer, mainSubOptions, mainVersions, normalizeRegion, regionGroups, textMode } from "./design";
import { onVersion } from "./layout";

export type CtAuditLevel = "ok" | "info" | "warn";

export interface CtAuditLine {
  level: CtAuditLevel;
  text: string;
}

export interface CtVersionAudit {
  name: string;
  /** Customer fields, in form order (child zones indented with "↳ … khi chọn X"). */
  fields: string[];
  /** Custom layers simply drawn (one picture). */
  layers: number;
}

export interface CtOptionAudit {
  versions: CtVersionAudit[];
  lines: CtAuditLine[];
}

/** Pictures a custom layer offers (hidden ones left out). */
function layerOffer(r: CtRegion, tpl: CtTemplate): number {
  return regionGroups(r, tpl.items, tpl.assets).reduce((n, g) => n + g.options.length, 0);
}

/** One customer field, or null for what the customer does not touch (a fixed text, a one-picture layer). */
function fieldLine(r: CtRegion, tpl: CtTemplate): string | null {
  const n = normalizeRegion(r);
  const sub = n.config.options.list.length ? ` + ${n.config.options.label || "option con"} (${n.config.options.list.length + 1} lựa chọn)` : "";
  if (n.kind === "image") {
    if (isLinkedLayer(n, tpl.regions)) return null;
    const offered = layerOffer(n, tpl);
    return offered >= 2 ? `Chọn ảnh “${n.config.image.label || n.name}” — 1 trong ${offered} (không sửa)` : null;
  }
  if (n.kind === "text") {
    const t = n.config.text;
    const label = t.label || n.name;
    switch (textMode(n)) {
      case "fixed":
        return null;
      case "list":
        return `Text “${label}” — chọn 1 trong ${t.choices.filter(Boolean).length}${sub}`;
      case "options":
        return `Option “${label}” — ${n.config.options.list.length + 1} lựa chọn`;
      default:
        return `Text “${label}” — tối đa ${t.maxChars} ký tự${sub}`;
    }
  }
  const p = n.config.photo;
  return `Upload ảnh “${p.label || n.name}”${p.required ? " (bắt buộc)" : ""}${p.styles.length > 1 ? ` — ${p.styles.length} ${p.styleLabel === "Filter" ? "filter" : "style"}` : ""}${sub}`;
}

/** The option a child zone hangs on, for people ("Texas"). */
function optionName(parent: CtRegion, optionId: string, assets: CtRenderAsset[]): string {
  if (parent.kind === "image") return assets.find((a) => a.id === optionId)?.name || "ảnh";
  const o = normalizeRegion(parent).config.options;
  return optionId === CT_BASE_OPTION ? o.baseName || "mặc định" : o.list.find((x) => x.id === optionId)?.name || "option";
}

export function auditOptions(tpl: CtTemplate): CtOptionAudit {
  const lines: CtAuditLine[] = [];
  const mains = tpl.config.main.enabled ? mainVersions(tpl.assets, tpl.mainAssetId) : tpl.assets.filter((a) => a.id === tpl.mainAssetId);
  const versions: CtVersionAudit[] = [];

  if (tpl.config.main.enabled && mains.length > 1) {
    const subs = mains.reduce((n, m) => n + mainSubOptions(tpl.assets, tpl.config.main, m.id).length, 0);
    lines.push({ level: "ok", text: `Khách chọn version “${tpl.config.main.label}”: ${mains.length} version${subs ? `, ${subs} option con` : ""}.` });
  } else if (tpl.config.main.enabled && mains.length === 1) {
    // One version with sub-options: the storefront offers them under the main label.
    const subs = mainSubOptions(tpl.assets, tpl.config.main, mains[0].id).length;
    if (subs) lines.push({ level: "ok", text: `Khách chọn “${tpl.config.main.label}”: ${subs + 1} ảnh (${mains[0].name} + ${subs} option).` });
  }

  let picks = 0;
  for (const m of mains) {
    const own = formOrder(tpl.regions.map(normalizeRegion)).filter((r) => onVersion(r, m.id));
    const byId = new Map(own.map((r) => [r.id, r]));
    const label = mains.length > 1 ? `Version “${m.name}”: ` : "";
    const fields: string[] = [];
    let fixed = 0;
    // Tree order: a child zone right under the option that opens it.
    const emit = (r: CtRegion, depth: number) => {
      const line = fieldLine(r, tpl);
      if (line) {
        const p = r.config.parent;
        const parent = p ? byId.get(p.regionId) : undefined;
        fields.push(`${"  ".repeat(depth)}${depth ? "↳ " : ""}${line}${p && parent ? ` (khi chọn “${optionName(parent, p.optionId, tpl.assets)}”)` : ""}`);
      } else if (r.kind === "image") fixed++;
      for (const c of own) if (c.config.parent?.regionId === r.id) emit(c, depth + 1);
    };
    for (const r of own) if (!r.config.parent || !byId.has(r.config.parent.regionId)) emit(r, 0);
    versions.push({ name: m.name || "Version", fields, layers: fixed });

    for (const r of own) {
      const n = normalizeRegion(r);
      if (n.config.parent && !byId.has(n.config.parent.regionId)) lines.push({ level: "warn", text: `${label}“${n.name}” là option con của vùng đã xoá — sẽ không hiện.` });
      if (n.kind === "image") {
        const offered = layerOffer(n, tpl);
        if (offered >= 2) picks++;
        if (offered === 0) lines.push({ level: "warn", text: `${label}custom layer “${n.name}” chưa có ảnh — sẽ trống trên store.` });
        else if (offered >= 2 && !n.config.image.label.trim()) lines.push({ level: "warn", text: `${label}custom layer “${n.name}” cho khách chọn nhưng chưa có nhãn.` });
        continue;
      }
      const mode = n.kind === "text" ? textMode(n) : null;
      const shown = n.kind === "text" ? n.config.text.label : n.config.photo.label;
      if (mode !== "fixed" && !shown.trim()) lines.push({ level: "warn", text: `${label}vùng “${n.name}” chưa có nhãn cho khách.` });
      if (n.config.options.list.some((o) => !o.name.trim())) lines.push({ level: "warn", text: `${label}“${shown || n.name}” có option chưa đặt tên.` });
      if (mode !== "options" && n.config.options.list.length && !n.config.options.label.trim()) lines.push({ level: "warn", text: `${label}“${shown || n.name}”: option con chưa có nhãn.` });
    }
    // Cart property names must be unique in a line: clashing labels get " (2)".
    const labels = own
      .filter((r) => (r.kind === "text" && textMode(r) !== "fixed") || r.kind === "photo")
      .map((r) => (r.kind === "text" ? r.config.text.label : r.config.photo.label).trim().toLowerCase())
      .filter(Boolean);
    const dup = labels.find((l, i) => labels.indexOf(l) !== i);
    if (dup) lines.push({ level: "warn", text: `${label}2 trường cùng nhãn “${dup}” — giỏ hàng sẽ ghi “${dup} (2)”, nên đặt tên khác nhau.` });
    if (!fields.length) lines.push({ level: "info", text: `${label}không có trường nào cho khách (chỉ hiện thiết kế cố định).` });
  }

  const fixedCount = versions.reduce((n, v) => n + v.layers, 0);
  if (picks) lines.push({ level: "ok", text: `${picks} custom layer cho khách chọn ảnh (chỉ chọn, không sửa); swatch là clipart gốc, canvas hiện bản vật liệu.` });
  if (fixedCount) lines.push({ level: "ok", text: `${fixedCount} custom layer 1 ảnh — vẽ cố định.` });
  if (tpl.config.mockupEdit) lines.push({ level: "ok", text: "Mockup edit: khách chỉnh thiết kế ngay trên tổ hợp đã chọn." });
  return { versions, lines };
}
