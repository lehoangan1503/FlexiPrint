/**
 * One-off (2026-11-17, "prompt mockup ra khỏi code"): writes the SQL that copies today's default scene prompts into
 * every product base that has no mockup prompts yet (CtBaseProductConfig.mockup) — the same scenes the code used
 * (lib/mockup-scenes defaultScenes of the khuôn's name, else the base's). wrap stays "" = the code's default sentence.
 *   npx tsx customize-tool/scripts/fill-base-mockup.ts bases.json > fill.sql
 * bases.json = [{id, name, tpl}] (tpl = the khuôn's name or null).
 */
import { readFileSync } from "node:fs";
import { defaultScenes } from "../lib/mockup-scenes";

const bases = JSON.parse(readFileSync(process.argv[2], "utf8")) as Array<{ id: string; name: string; tpl: string | null }>;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
console.log("begin;");
for (const b of bases) {
  const mockup = { scenes: defaultScenes(b.tpl || b.name).join("\n"), wrap: "", refs: [] as string[] };
  console.log(
    `update flexiprint.ct_base_products set config = jsonb_set(coalesce(config, '{}'::jsonb), '{mockup}', ${q(JSON.stringify(mockup))}::jsonb) where id = ${q(b.id)} and not (coalesce(config, '{}'::jsonb) ? 'mockup');`,
  );
  console.error(`${b.name} (${b.tpl ?? "-"}): ${mockup.scenes.split("\n").length} cảnh — ${mockup.scenes.split("\n")[0].slice(0, 70)}`);
}
console.log("commit;");
