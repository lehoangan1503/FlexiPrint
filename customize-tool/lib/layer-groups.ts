/**
 * Layers grouped by the character / part they draw, read from their names (asked 2026-11-04: take one character with
 * every option of his pose out of a bigger design). Names seen:
 *
 *   "Grandkid 1 — Hair · Grandkids sitting with Grandma]"   character before " — ", pose after " · "
 *   "Người 3 — hair — lớp trước [5 People]"                   the version tag "[…]" is dropped
 *   "Thân — Person 3", "Chữ — Name #3"                         a part of character number 3 → joins "Người 3"
 *   "Nền", "Phần tử — Ground", "Rug · …"                       its own group
 *
 * A chooser (a 1 px layer drawing nothing) has no group.
 */

import type { CtRegion } from "../types";
import { shapeBounds } from "./geometry";

export interface CtLayerGroup {
  key: string;
  label: string;
  ids: string[];
}

/** The trailing number of "Người 3", "Person 3", "Name #3", "Rider 3" — null when there is none. */
function numberOf(text: string): string | null {
  const m = /(?:^|\s|#)(\d{1,2})$/.exec(text.trim());
  return m ? m[1] : null;
}

function parse(name: string): { who: string; part: string; pose: string } {
  const clean = name.replace(/\s*\[[^\]]*\]\s*$/, "");
  const [head, ...rest] = clean.split(" · ");
  const pose = rest.join(" · ").replace(/[[\]]/g, "").trim();
  const bits = head.split(" — ").map((x) => x.trim());
  return { who: bits[0] || head.trim(), part: bits[1] ?? "", pose };
}

/** Layer id → its group (key + label). */
export function layerGroupOf(regions: CtRegion[]): Map<string, { key: string; label: string }> {
  const parsed = regions
    .filter((r) => {
      const b = shapeBounds(r.shape);
      return b.w > 1 || b.h > 1;
    })
    .map((r) => ({ r, ...parse(r.name) }));
  // Characters named with a number ("Người 3", "Grandkid 1"), per pose: number → their group.
  const numbered = new Map<string, { key: string; label: string }>();
  for (const p of parsed) {
    const n = numberOf(p.who);
    if (n && !numbered.has(`${n}|${p.pose}`)) numbered.set(`${n}|${p.pose}`, { key: `${p.who}|${p.pose}`, label: p.pose ? `${p.who} · ${p.pose}` : p.who });
  }
  const out = new Map<string, { key: string; label: string }>();
  for (const p of parsed) {
    if (numberOf(p.who)) {
      out.set(p.r.id, numbered.get(`${numberOf(p.who)}|${p.pose}`)!);
      continue;
    }
    // "Thân — Person 3", "Chữ — Name #3": a part of character 3, when there is one.
    const n = numberOf(p.part);
    const owner = n ? numbered.get(`${n}|${p.pose}`) : undefined;
    out.set(p.r.id, owner ?? { key: `${p.who}|${p.pose}`, label: p.pose ? `${p.who} · ${p.pose}` : p.who });
  }
  return out;
}

/** The groups, topmost layer's group first. */
export function layerGroups(regions: CtRegion[]): CtLayerGroup[] {
  const of = layerGroupOf(regions);
  const out = new Map<string, CtLayerGroup>();
  for (const r of [...regions].sort((a, b) => b.sort_order - a.sort_order)) {
    const g = of.get(r.id);
    if (!g) continue;
    const cur = out.get(g.key) ?? { ...g, ids: [] };
    cur.ids.push(r.id);
    out.set(g.key, cur);
  }
  return [...out.values()];
}
