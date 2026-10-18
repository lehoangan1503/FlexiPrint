/**
 * A product's customer choices, by name — for the @flexiprint agent over MCP (list_product_options, render_artwork,
 * make_product_mockups): every layer the customer picks in (its options, a text's list) and a selection built from
 * {"layer name or label": "option name or text"} — so the agent can say "the Halloween background, the pumpkin bucket"
 * without ids. Linked layers (a back half of hair) are never asked: they follow their leader (lib/design resolveLinked).
 */

import { CT_MAIN_KEY, type CtRegion, type CtSelection } from "../types";
import { defaultRegionSelection, isLinkedLayer, mainVersions, normalizeProductConfig, normalizeRegion, regionGroups, resolveLinked, textMode } from "../lib/design";
import { onVersion } from "../lib/layout";

/** The key that picks a product's version by name ({"Version": "Girl"}); its own label works too. */
export const VERSION_KEY = "Version";
import type { ArtworkBundle } from "./print-render";

export interface CtProductOptionView {
  layer: string;
  /** What the customer is asked. */
  label: string;
  /** "version": who is in the picture (a boy / a girl, 1–5 people) — each version has its own layers. */
  kind: CtRegion["kind"] | "version";
  /** The version a layer belongs to (a product with versions). */
  version?: string;
  /** image layers: each option (a colour group's options listed under it). */
  options?: Array<{ asset_id: string; name: string; group: string; isDefault: boolean }>;
  /** text layers: "input" (typed) | "list" (choices) | "fixed". */
  textMode?: string;
  choices?: string[];
  defaultText?: string;
}

const norm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");

/** The layers the customer chooses in, with their options. */
export function productOptions(b: ArtworkBundle): CtProductOptionView[] {
  const out: CtProductOptionView[] = [];
  const config = normalizeProductConfig(b.product.config);
  const mains = mainVersions(b.assets, b.product.main_asset_id);
  const versioned = config.main.enabled && mains.length > 1;
  if (versioned)
    out.push({ layer: VERSION_KEY, label: config.main.label, kind: "version", options: mains.map((m, i) => ({ asset_id: m.id, name: m.name, group: "", isDefault: i === 0 })) });
  const versionOf = (r: CtRegion) => (versioned ? mains.find((m) => m.id === r.config.mainId)?.name : undefined);
  for (const raw of [...b.regions].sort((x, y) => x.sort_order - y.sort_order)) {
    const r = normalizeRegion(raw);
    if (r.config.materialFrame || isLinkedLayer(r, b.regions)) continue;
    const version = versionOf(r);
    if (r.kind === "image") {
      const def = defaultRegionSelection(r, b.items, b.assets);
      const groups = regionGroups(r, b.items, b.assets);
      out.push({
        layer: r.name,
        label: r.config.image.label,
        kind: r.kind,
        ...(version ? { version } : {}),
        options: groups.flatMap((g) => g.options.map((a) => ({ asset_id: a.id, name: a.name, group: g.name, isDefault: def.kind === "image" && def.assetId === a.id }))),
      });
    } else if (r.kind === "text") {
      out.push({ layer: r.name, label: r.config.text.label, kind: r.kind, ...(version ? { version } : {}), textMode: textMode(r), choices: r.config.text.choices, defaultText: r.config.text.defaultText });
    } else out.push({ layer: r.name, label: r.config.photo.label, kind: r.kind, ...(version ? { version } : {}) });
  }
  return out;
}

/**
 * A selection from names: keys match a layer's name or customer label, values an option's asset id / name (whole
 * name, or every "·"-separated word group of the value found in it: "Long Wavy · Auburn") or a text. The rest stays
 * default. Throws a message listing what did not match.
 */
export function selectionFromNames(b: ArtworkBundle, wanted: Record<string, string>): CtSelection {
  const sel: CtSelection = {};
  for (const r of b.regions) sel[r.id] = defaultRegionSelection(r, b.items, b.assets);
  const errors: string[] = [];
  // The version first ("Version" or the product's own label, "Choose character": "Girl"): layers are then looked up
  // among that version's own.
  const config = normalizeProductConfig(b.product.config);
  const mains = mainVersions(b.assets, b.product.main_asset_id);
  let mainId = mains[0]?.id ?? null;
  const entries = Object.entries(wanted).filter(([key, value]) => {
    if (!(mains.length > 1 && (norm(key) === norm(VERSION_KEY) || norm(key) === norm(config.main.label)))) return true;
    const m = mains.find((x) => x.id === value || norm(x.name) === norm(value));
    if (m) {
      mainId = m.id;
      sel[CT_MAIN_KEY] = { kind: "main", assetId: m.id, optionId: null };
    } else errors.push(`"${key}": no version "${value}" — versions: ${mains.map((x) => x.name).join(" | ")}`);
    return false;
  });
  const shown = b.regions.filter((r) => onVersion(r, mainId));
  for (const [key, value] of entries) {
    // A linked layer (the back half of hair) has its leader's label: it follows, it is never picked itself.
    const r = shown.map(normalizeRegion).find((x) => !x.config.materialFrame && !isLinkedLayer(x, b.regions) && [x.name, x.name.replace(/\s*\[[^\]]*\]$/, ""), x.kind === "image" ? x.config.image.label : x.kind === "text" ? x.config.text.label : x.config.photo.label].some((n) => norm(n) === norm(key)));
    if (!r) {
      errors.push(`no layer "${key}"`);
      continue;
    }
    if (r.kind === "text") {
      const mode = textMode(r);
      if (mode === "list" && !r.config.text.choices.some((c) => norm(c) === norm(value))) {
        errors.push(`"${key}": "${value}" is not one of its choices (${r.config.text.choices.join(" | ")})`);
        continue;
      }
      sel[r.id] = { kind: "text", text: mode === "list" ? (r.config.text.choices.find((c) => norm(c) === norm(value)) ?? value) : value };
      continue;
    }
    if (r.kind !== "image") {
      errors.push(`"${key}" is a ${r.kind} layer — only image and text layers can be chosen`);
      continue;
    }
    const options = regionGroups(r, b.items, b.assets).flatMap((g) => g.options);
    const parts = value.split(/[·,]/).map(norm).filter(Boolean);
    const exact = options.filter((a) => a.id === value || norm(a.name) === norm(value));
    const found = exact.length ? exact : options.filter((a) => parts.every((p) => norm(a.name).includes(p)));
    if (found.length !== 1) {
      errors.push(`"${key}": ${found.length ? `"${value}" matches ${found.length} options` : `no option "${value}"`} — options: ${options.map((a) => a.name).join(" | ")}`);
      continue;
    }
    sel[r.id] = { kind: "image", assetId: found[0].id };
  }
  if (errors.length) throw new Error(`Options not understood: ${errors.join("; ")}. list_product_options shows the layers and their options.`);
  return resolveLinked(b.regions, b.items, b.assets, sel);
}
