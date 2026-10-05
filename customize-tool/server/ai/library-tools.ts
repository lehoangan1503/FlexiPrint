/**
 * The library as tools: what a category can be built from without making anything new — style packs,
 * materials and the chi tiết thành phẩm other categories already use. Only the spec is really per category;
 * the rest is meant to be reused, so whoever writes a category (the prompt writer, an external agent over MCP)
 * looks here first and creates a record only when nothing fits.
 *
 * Two callers, one implementation:
 *   - server/ai/prompt-writer.ts (category "Tạo bằng AI") runs them in-process between its analysis and
 *     its matching pass;
 *   - review_category (server/ai/prompt-review.ts) checks a saved category's assembled prompts — the same review
 *     the category dialog runs after every AI change;
 *   - flexiprint-mcp (server/mcp) serves them with the rest of its tools.
 */

import { CT_TABLES } from "../../config";
import { normalizeCategoryRules } from "../../lib/library";
import type { CtClipartCategory, CtMaterialArt, CtMaterialSpec, CtPreset } from "../../types";
import type { CtServiceClient, CtSupabase } from "../supabase";
import { reviewCategory, type ReviewResult } from "./prompt-review";

export type LibraryDb = CtSupabase | CtServiceClient;
type Db = LibraryDb;

export interface CtLibraryStylePack {
  id: string;
  name: string;
  prompt: string;
  /** Categories that use it. */
  usedBy: string[];
  /** For save_preset's expected_updated_at. */
  updatedAt: string;
}

export interface CtLibraryMaterial extends CtLibraryStylePack {
  art: CtMaterialArt | null;
}

export interface CtLibraryDetailSet {
  category: string;
  details: CtMaterialSpec[];
}

export interface CtLibraryCatalog {
  stylePacks: CtLibraryStylePack[];
  materials: CtLibraryMaterial[];
  detailSets: CtLibraryDetailSet[];
}

type CategoryRow = Pick<CtClipartCategory, "id" | "name" | "rules">;
type PresetRow = Pick<CtPreset, "id" | "kind" | "name" | "prompt" | "params" | "updated_at">;

/** Every style pack, material and detail set, with the categories using each. */
export async function loadLibraryCatalog(db: Db): Promise<CtLibraryCatalog> {
  const [{ data: presets, error: pErr }, { data: categories, error: cErr }] = await Promise.all([
    db.from(CT_TABLES.presets).select("id,kind,name,prompt,params,updated_at").in("kind", ["style_pack", "material"]).order("sort_order").order("created_at").returns<PresetRow[]>(),
    db.from(CT_TABLES.categories).select("id,name,rules").order("sort_order").order("name").returns<CategoryRow[]>(),
  ]);
  if (pErr) throw new Error(pErr.message);
  if (cErr) throw new Error(cErr.message);
  const cats = (categories ?? []).map((c) => ({ name: c.name, rules: normalizeCategoryRules(c.rules) }));
  const usedBy = (id: string) => cats.filter((c) => c.rules.stylePackId === id || c.rules.materialIds.includes(id)).map((c) => c.name);
  const list = presets ?? [];
  return {
    stylePacks: list.filter((p) => p.kind === "style_pack").map((p) => ({ id: p.id, name: p.name, prompt: p.prompt, usedBy: usedBy(p.id), updatedAt: p.updated_at })),
    materials: list.filter((p) => p.kind === "material").map((p) => ({ id: p.id, name: p.name, prompt: p.prompt, art: p.params?.art ?? null, usedBy: usedBy(p.id), updatedAt: p.updated_at })),
    detailSets: cats.filter((c) => c.rules.details.length > 0).map((c) => ({ category: c.name, details: c.rules.details })),
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

interface JsonSchema {
  type: "object";
  properties: Record<string, { type: string; description: string }>;
  required?: string[];
}

interface CtLibraryTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  run: (catalog: CtLibraryCatalog, args: CtToolArgs, db: Db) => unknown;
}

interface CtToolArgs {
  query?: string;
  category?: string;
}

const QUERY_SCHEMA: JsonSchema = {
  type: "object",
  properties: { query: { type: "string", description: "Optional words to filter by (name / prompt / category), any language. Empty = everything." } },
};

/** Loose filter: every word of the query appears somewhere in the record. */
function matches(query: string | undefined, ...fields: string[]): boolean {
  const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fields.join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

export const CT_LIBRARY_TOOLS: CtLibraryTool[] = [
  {
    name: "list_style_packs",
    description:
      "Style packs of the FlexiPrint clipart library: HOW a set is drawn (outline, shading, palette, finish), generic to any object and reused across categories. Check before writing a new one — reuse an existing pack whose look matches the reference.",
    inputSchema: QUERY_SCHEMA,
    run: (c, a) => c.stylePacks.filter((p) => matches(a.query, p.name, p.prompt, ...p.usedBy)),
  },
  {
    name: "list_materials",
    description:
      "Material presets: the physical product a flat clipart becomes (clear acrylic, glitter, wood…), reused by many categories. art = print (artwork printed unchanged) | surface (material changes the artwork's surface). Check before writing a new one.",
    inputSchema: QUERY_SCHEMA,
    run: (c, a) => c.materials.filter((m) => matches(a.query, m.name, m.prompt, ...m.usedBy)),
  },
  {
    name: "list_product_details",
    description:
      "Chi tiết thành phẩm of existing categories: the finished product's extra parts (hole, jump ring, cord, clip…), grouped by category. mode = always (every material version) | version (an extra version with it, label = its name). Reuse the wording of a detail that is the same part.",
    inputSchema: QUERY_SCHEMA,
    run: (c, a) => c.detailSets.filter((s) => matches(a.query, s.category, ...s.details.map((d) => `${d.text} ${d.label}`))),
  },
  {
    name: "review_category",
    description:
      "Final check of a category's prompts, assembled exactly as the image models receive them (flat drawing + every material pass): contradictions, parts a 'leave out' cancels, positions / sizes that can't hold for every clipart, things in the wrong layer, product photos that contradict the details. Returns the issues (Vietnamese) and the fixed texts — nothing is saved. Run it after writing or changing a category.",
    inputSchema: {
      type: "object",
      properties: { category: { type: "string", description: "The category's id or exact name." } },
      required: ["category"],
    },
    run: (c, a, db) => reviewStoredCategory(db, c, a.category ?? ""),
  },
];

/** review_category: a saved category, read with its presets. */
async function reviewStoredCategory(db: Db, catalog: CtLibraryCatalog, ref: string): Promise<ReviewResult> {
  const key = ref.trim();
  if (!key) throw new Error("category is required");
  const byId = /^[0-9a-f-]{36}$/i.test(key);
  const { data: row, error } = await db.from(CT_TABLES.categories).select("id,name,usage,spec,rules").eq(byId ? "id" : "name", key).limit(1).maybeSingle<Pick<CtClipartCategory, "id" | "name" | "usage" | "spec" | "rules">>();
  if (error) throw new Error(error.message);
  if (!row) throw new Error(`No category ${key}`);
  const rules = normalizeCategoryRules(row.rules);
  const others = (list: string[]) => list.filter((n) => n !== row.name);
  const style = catalog.stylePacks.find((p) => p.id === rules.stylePackId) ?? null;
  const result = await reviewCategory({
    name: row.name,
    usage: row.usage,
    spec: row.spec,
    style: style ? { name: style.name, prompt: style.prompt, usedByOthers: others(style.usedBy) } : null,
    materials: rules.materialIds
      .map((id) => catalog.materials.find((m) => m.id === id))
      .filter((m): m is CtLibraryMaterial => Boolean(m))
      .map((m, i) => ({ key: `M${i + 1}`, name: m.name, prompt: m.prompt, art: m.art === "surface" ? "surface" : "print", usedByOthers: others(m.usedBy) })),
    rules,
  });
  if (!result) throw new Error("The review LLM did not answer — try again");
  return result;
}
