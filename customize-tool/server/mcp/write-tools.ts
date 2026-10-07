/**
 * flexiprint-mcp write tools — the agent saves categories / presets itself, for people who ask @flexiprint
 * directly on agent_ide. (A task from the web app is still answered with submit_result: the editor approves it.)
 *
 * Every write:
 *   - goes through the web app's own checks (cleanCategory / cleanPreset);
 *   - refuses when the record changed since the agent read it (expected_updated_at) — no silent overwrite of an
 *     editor's work;
 *   - refuses a category while a web-app task is running on it;
 *   - leaves a history row (before + after, who asked, why — model "agent:flexiprint"), so restore_category can
 *     put any saved version back.
 * A preset shared by other categories is only changed with confirm_shared (it changes them too).
 * Needs migration 012 (service-role writes).
 */

import { CT_TABLES } from "../../config";
import { normalizeCategoryRules } from "../../lib/library";
import { normalizeMaterialSpecs } from "../../lib/materials";
import type { CtCategoryBody, CtCategoryHistoryEntry, CtCategoryRules, CtCategorySnapshot, CtClipartCategory, CtPreset, CtPresetBody, CtPresetKind } from "../../types";
import { cleanCategory, cleanPreset, isOwnUploadUrl } from "../library";
import { ownerId } from "../studio";
import type { CtServiceClient } from "../supabase";
import { loadLibraryCatalog } from "../ai/library-tools";
import { clip, record, str } from "../ai/llm";
import type { CtMcpTool } from "./tools";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_MODEL = "agent:flexiprint";

type CategoryRow = Omit<CtClipartCategory, "count" | "can_edit">;

function serviceOf(db: CtServiceClient | null): CtServiceClient {
  if (!db) throw new Error("Writes need the agent token");
  return db;
}

function snapshotOf(c: Pick<CategoryRow, "name" | "spec" | "rules">): CtCategorySnapshot {
  return { name: c.name, spec: c.spec, rules: normalizeCategoryRules(c.rules) };
}

function noteOf(args: Record<string, unknown>): string {
  const why = str(args.why);
  if (!why) throw new Error('"why" is required: one Vietnamese sentence the editors will read in the history');
  const by = str(args.requested_by);
  return clip(`@flexiprint: ${why}${by ? ` (theo yêu cầu của ${by})` : ""}`, 1000);
}

async function findCategoryRow(db: CtServiceClient, ref: unknown): Promise<CategoryRow> {
  const key = str(ref);
  const { data, error } = await db.from(CT_TABLES.categories).select("*").eq(UUID.test(key) ? "id" : "name", key).limit(1).maybeSingle<CategoryRow>();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`No category "${key}"`);
  return data;
}

/** A web-app task running on the category: its result is the editor's to approve — don't save under it. */
async function assertNoOpenTask(db: CtServiceClient, categoryId: string): Promise<void> {
  const { data, error } = await db.from(CT_TABLES.agentTasks).select("id").eq("category_id", categoryId).in("status", ["pending", "running"]).limit(1);
  if (error) return; // no task table yet (migration 011): nothing can be running
  if (data?.length) throw new Error("A task from the web app is open on this category — answer it with submit_result; the editor applies it");
}

/** Saves the category (update when `cur` is given) and its history row. */
async function writeCategory(db: CtServiceClient, cur: CategoryRow | null, body: CtCategoryBody, note: string, extra: Record<string, unknown> = {}) {
  const clean = cleanCategory(body);
  if (typeof clean === "string") throw new Error(clean);
  const owner = await ownerId(db);
  let saved: CategoryRow | null;
  if (cur) {
    // Only if nobody saved in between (the row's updated_at is still the one read).
    const { data, error } = await db.from(CT_TABLES.categories).update(clean).eq("id", cur.id).eq("updated_at", cur.updated_at).select("*").maybeSingle<CategoryRow>();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("The category changed while saving — get_category again and redo the change");
    saved = data;
  } else {
    const { data, error } = await db.from(CT_TABLES.categories).insert({ ...clean, user_id: owner }).select("*").single<CategoryRow>();
    if (error) throw new Error(error.message);
    saved = data;
  }
  const { data: h } = await db
    .from(CT_TABLES.categoryHistory)
    .insert({
      category_id: saved.id,
      user_id: owner,
      event: "save",
      note,
      ref_urls: [],
      image_urls: [],
      input: { by: AGENT_MODEL, ...(cur ? { before: snapshotOf(cur) } : {}), ...extra },
      result: snapshotOf(saved),
      model: AGENT_MODEL,
    })
    .select("id")
    .maybeSingle<Pick<CtCategoryHistoryEntry, "id">>();
  return { id: saved.id, name: saved.name, updatedAt: saved.updated_at, historyId: h?.id ?? null };
}

const urls = (v: unknown): string[] | null => (Array.isArray(v) ? v.map(str).filter(isOwnUploadUrl) : null);

export const CT_MCP_WRITE_TOOLS: CtMcpTool[] = [
  {
    name: "save_category",
    description: [
      "SAVE a category (no category = create one). Only when a person asked you directly to change / create it — a web-app task is answered with submit_result instead.",
      "Give only the fields to change; the rest stays. Updating needs expected_updated_at = updatedAt from your latest get_category (refused if someone saved since).",
      "Fields: name, spec, usage (main | element), shape (alpha | frame), details [{text, mode, label}], details_note, style_pack_id, material_ids [ids], design_refs [urls], product_refs [urls].",
      "Always: why (Vietnamese, for the history) and requested_by (who asked). Check the result with assemble_prompts first.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Id or exact name; omit to create a new category." },
        expected_updated_at: { type: "string", description: "updatedAt from get_category (required to update)." },
        name: { type: "string", description: "Name (required to create)." },
        spec: { type: "string", description: "Full spec, English." },
        usage: { type: "string", description: "main | element (create; default main)." },
        shape: {
          type: "string",
          description:
            "alpha = cut along the clipart's outline (die-cut acrylic, sticker; the clipart is the object alone) | frame = fixed-shape product (round ceramic ornament, mug, trousers; the clipart is a full-bleed picture, a product's khuôn vật liệu cuts the shape).",
        },
        details: { type: "array", items: { type: "object" }, description: "FULL details list [{text, mode: always|version, label}]." },
        details_note: { type: "string", description: "The editor's description of the product." },
        style_pack_id: { type: "string", description: "A style pack id (list_style_packs). Required to create." },
        material_ids: { type: "array", items: { type: "string" }, description: "FULL list of material ids." },
        design_refs: { type: "array", items: { type: "string" }, description: "FULL list of design reference urls." },
        product_refs: { type: "array", items: { type: "string" }, description: "FULL list of product photo urls." },
        why: { type: "string", description: "Why (Vietnamese) — shown in the category's history." },
        requested_by: { type: "string", description: "Who asked for it." },
      },
      required: ["why"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const db = serviceOf(ctx.service);
      const note = noteOf(args);
      const lib = await loadLibraryCatalog(db);
      const cur = str(args.category) ? await findCategoryRow(db, args.category) : null;
      if (cur) {
        if (str(args.expected_updated_at) !== cur.updated_at) throw new Error(`The category was saved at ${cur.updated_at} — get_category again, redo the change on what is there now`);
        await assertNoOpenTask(db, cur.id);
      }
      const rules: CtCategoryRules = normalizeCategoryRules(cur?.rules ?? {});
      if (args.details !== undefined) rules.details = normalizeMaterialSpecs(args.details);
      if (args.details_note !== undefined) rules.detailsNote = str(args.details_note);
      if (args.shape !== undefined) rules.shape = str(args.shape) === "frame" ? "frame" : "alpha";
      if (args.style_pack_id !== undefined) {
        if (!lib.stylePacks.some((p) => p.id === str(args.style_pack_id))) throw new Error("style_pack_id is not a style pack (list_style_packs)");
        rules.stylePackId = str(args.style_pack_id);
      }
      if (args.material_ids !== undefined) {
        const ids = (Array.isArray(args.material_ids) ? args.material_ids : []).map(str);
        const bad = ids.filter((id) => !lib.materials.some((m) => m.id === id));
        if (bad.length) throw new Error(`Not materials: ${bad.join(", ")} (list_materials)`);
        rules.materialIds = [...new Set(ids)];
      }
      const design = urls(args.design_refs);
      if (design) rules.refs = design.slice(0, 6);
      const product = urls(args.product_refs);
      if (product) rules.productRefs = product.slice(0, 6);
      if (!cur && !rules.stylePackId) throw new Error("A new category needs style_pack_id");
      const body: CtCategoryBody = {
        name: str(args.name) || cur?.name || "",
        parent_id: cur?.parent_id ?? null,
        usage: cur ? cur.usage : str(args.usage) === "element" ? "element" : "main",
        mode: cur?.mode ?? "origin_set",
        spec: args.spec !== undefined ? str(args.spec) : (cur?.spec ?? ""),
        rules,
      };
      return { json: { ok: true, ...(await writeCategory(db, cur, body, note)) } };
    },
  },
  {
    name: "restore_category",
    description:
      "Put a category back to a version from its history (get_history: a 'save' row → what was saved then; a 'revise' row → the category as it was before that revision). Leaves a history row itself, so it can be undone too.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Id or exact name." },
        history_id: { type: "string", description: "The history row's id (get_history)." },
        why: { type: "string", description: "Why (Vietnamese)." },
        requested_by: { type: "string", description: "Who asked for it." },
      },
      required: ["category", "history_id", "why"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const db = serviceOf(ctx.service);
      const note = noteOf(args);
      const cur = await findCategoryRow(db, args.category);
      await assertNoOpenTask(db, cur.id);
      const { data: h, error } = await db.from(CT_TABLES.categoryHistory).select("*").eq("id", str(args.history_id)).eq("category_id", cur.id).maybeSingle<CtCategoryHistoryEntry>();
      if (error) throw new Error(error.message);
      if (!h) throw new Error("No such history row for this category");
      const snap = record(h.event === "save" ? h.result : h.input);
      if (!str(snap.name) || typeof snap.rules !== "object") throw new Error("That history row holds no full category version");
      const body: CtCategoryBody = { name: str(snap.name), parent_id: cur.parent_id, usage: cur.usage, mode: cur.mode, spec: str(snap.spec), rules: normalizeCategoryRules(record(snap.rules)) };
      return { json: { ok: true, ...(await writeCategory(db, cur, body, note, { restored_from: h.id })) } };
    },
  },
  {
    name: "save_preset",
    description:
      "SAVE a style pack or material (no preset = create). Only when a person asked you directly. A preset other categories use changes them all: then confirm_shared must be true (ask the person first), or create a new preset and point the category at it with save_category.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "style_pack | material" },
        preset: { type: "string", description: "The preset id; omit to create." },
        expected_updated_at: { type: "string", description: "updatedAt of the preset from get_category / list_style_packs / list_materials (required to update)." },
        name: { type: "string", description: "Name, 2–4 words (required to create)." },
        prompt: { type: "string", description: "The FULL prompt, English." },
        art: { type: "string", description: "Material: print | surface." },
        confirm_shared: { type: "boolean", description: "true = change it for every category using it." },
        why: { type: "string", description: "Why (Vietnamese)." },
        requested_by: { type: "string", description: "Who asked for it." },
      },
      required: ["kind", "why"],
    },
    callers: ["agent"],
    run: async (ctx, args) => {
      const db = serviceOf(ctx.service);
      const note = noteOf(args);
      const kind = str(args.kind) as CtPresetKind;
      if (kind !== "style_pack" && kind !== "material") throw new Error("kind: style_pack | material");
      const owner = await ownerId(db);
      let cur: CtPreset | null = null;
      if (str(args.preset)) {
        const { data } = await db.from(CT_TABLES.presets).select("*").eq("id", str(args.preset)).eq("kind", kind).maybeSingle<CtPreset>();
        if (!data) throw new Error(`No ${kind} ${str(args.preset)}`);
        cur = data;
        if (str(args.expected_updated_at) !== cur.updated_at) throw new Error(`The preset was saved at ${cur.updated_at} — read it again and redo the change`);
        const lib = await loadLibraryCatalog(db);
        const usedBy = (kind === "style_pack" ? lib.stylePacks : lib.materials).find((p) => p.id === cur?.id)?.usedBy ?? [];
        if (usedBy.length > 1 && args.confirm_shared !== true) {
          throw new Error(`Used by ${usedBy.join(", ")} — they all change. Ask the person; then confirm_shared: true, or create a new preset instead`);
        }
      }
      const art = str(args.art);
      const body: CtPresetBody = {
        kind,
        name: str(args.name) || cur?.name || "",
        prompt: str(args.prompt) || cur?.prompt || "",
        reference_asset_ids: cur?.reference_asset_ids ?? [],
        params: { ...(cur?.params ?? (kind === "material" ? { art: "print" as const } : {})), ...(kind === "material" && (art === "print" || art === "surface") ? { art } : {}) },
      };
      const clean = cleanPreset(body);
      if (typeof clean === "string") throw new Error(clean);
      const q = cur
        ? db.from(CT_TABLES.presets).update(clean).eq("id", cur.id).eq("updated_at", cur.updated_at)
        : db.from(CT_TABLES.presets).insert({ ...clean, user_id: owner });
      const { data: saved, error } = await q.select("*").maybeSingle<CtPreset>();
      if (error) throw new Error(error.message);
      if (!saved) throw new Error("The preset changed while saving — read it again");
      await db.from(CT_TABLES.presetHistory).insert({
        preset_id: saved.id,
        user_id: owner,
        kind,
        event: "save",
        note,
        ref_urls: saved.params.refs ?? [],
        input: { by: AGENT_MODEL, ...(cur ? { before: { name: cur.name, prompt: cur.prompt, params: cur.params } } : {}) },
        result: { name: saved.name, prompt: saved.prompt, params: saved.params },
        model: AGENT_MODEL,
      });
      return { json: { ok: true, id: saved.id, name: saved.name, updatedAt: saved.updated_at } };
    },
  },
];
