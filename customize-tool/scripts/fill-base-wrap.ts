/**
 * One-off (2026-11-18, "base nào dùng prompt đó thì chép vào"): writes the SQL that copies the wrap sentence each
 * product base uses today (lib/mockup-prompt defaultMockupWrap, the look worked out the same way as the base page —
 * components/base/base-mockup-section.tsx) into its config.mockup.wrap, and its default scenes into an empty
 * config.mockup.scenes. Only empty fields are written; a base that has its own text keeps it.
 *   npx tsx customize-tool/scripts/fill-base-wrap.ts export.json > fill.sql
 * export.json = {bases: [{id, name, config}], tpls: [ct_print_templates rows]}.
 */
import { readFileSync } from "node:fs";
import { normalizeBaseConfig } from "../lib/base-product";
import { normalizePrintSpec } from "../lib/print-template";
import { defaultMockupWrap } from "../lib/mockup-prompt";
import { defaultScenes } from "../lib/mockup-scenes";

type Tpl = { id: string; name: string; kind: string; spec: unknown };
const data = JSON.parse(readFileSync(process.argv[2], "utf8")) as { bases: Array<{ id: string; name: string; config: unknown }>; tpls: Tpl[] | null };
const tpls = new Map((data.tpls ?? []).map((t) => [t.id, { ...t, spec: normalizePrintSpec(t.spec) }]));
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

console.log("begin;");
for (const b of data.bases) {
  const cfg = normalizeBaseConfig(b.config);
  const tpl = cfg.templateId ? tpls.get(cfg.templateId) ?? null : null;
  const piece = tpl?.name || b.name;
  const dieCut = tpl?.kind === "cut" || cfg.cut.mode === "alpha";
  const fromPhoi = !!cfg.preview.url || (!!tpl?.spec.blanks.length && cfg.cut.mode !== "alpha");
  const sets: string[] = [];
  if (!cfg.mockup.wrap.trim()) {
    const wrap = defaultMockupWrap({ piece, materialId: cfg.material, dieCut, fromPhoi });
    sets.push(`config = jsonb_set(config, '{mockup,wrap}', to_jsonb(${q(wrap)}::text))`);
  }
  if (!cfg.mockup.scenes.trim()) {
    const scenes = defaultScenes(piece).join("\n");
    sets.push(`config = jsonb_set(config, '{mockup,scenes}', to_jsonb(${q(scenes)}::text))`);
  }
  if (!sets.length) {
    console.error(`${b.name}: đã có đủ, bỏ qua`);
    continue;
  }
  // Make sure config.mockup exists, then fill only what is still empty (re-checked in SQL: someone may have typed meanwhile).
  console.log(`update flexiprint.ct_base_products set config = jsonb_set(coalesce(config, '{}'::jsonb), '{mockup}', coalesce(config->'mockup', '{}'::jsonb)) where id = ${q(b.id)};`);
  for (const s of sets) {
    const key = s.includes("{mockup,wrap}") ? "wrap" : "scenes";
    console.log(`update flexiprint.ct_base_products set ${s} where id = ${q(b.id)} and coalesce(btrim(config->'mockup'->>'${key}'), '') = '';`);
  }
  console.error(`${b.name} (${piece}; dieCut=${dieCut}, fromPhoi=${fromPhoi}, ${cfg.material}): ${sets.length === 2 ? "câu bọc + cảnh" : sets[0].includes("wrap") ? "câu bọc" : "cảnh"}`);
}
console.log("commit;");
