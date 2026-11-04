/**
 * Layers grouped by the character / part they draw, read from their names (asked 2026-11-04: take one character with
 * every option of his pose out of a bigger design). Names seen:
 *
 *   "Grandkid 1 — Hair · Grandkids sitting with Grandma]"   character before " — ", pose after " · "
 *   "Người 3 — hair — lớp trước [5 People]"                   the version tag "[…]" is dropped
 *   "Thân — Person 3", "Chữ — Name #3", "Chữ — Rider 3 name"   a part of character number 3 → joins "Người 3"
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
    // "Thân — Person 3", "Chữ — Name #3", "Chữ — Rider 1 name": a part of character 3 / 1, when there is one.
    const n = numberOf(p.part) ?? /(?:^|\s|#)(\d{1,2})(?:\s|$)/.exec(p.part)?.[1] ?? null;
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

/** What a pick map (lib/compositor renderPickMap) holds: each shown layer's alpha at `scale`. */
export interface CtPickPixels {
  scale: number;
  w: number;
  h: number;
  layers: Array<{ id: string | null; alpha: Uint8ClampedArray }>;
}

/**
 * The layers a selection box (canvas px) holds: those with most of their own visible pixels (≥ 60 %) inside it — the
 * pixels, not their frames (a bộ's layers all share the canvas-wide frame), so a background covering the whole artwork
 * stays out of a box drawn round one character. A layer showing nothing now (glasses set to "none") goes with the
 * character its picked layers belong to (`shown`: the layers on show, named — layerGroupOf).
 */
export function layersInBox(m: CtPickPixels, box: { x: number; y: number; w: number; h: number }, shown: CtRegion[]): string[] {
  const x0 = Math.max(0, Math.floor(box.x * m.scale));
  const y0 = Math.max(0, Math.floor(box.y * m.scale));
  const x1 = Math.min(m.w, Math.ceil((box.x + box.w) * m.scale));
  const y1 = Math.min(m.h, Math.ceil((box.y + box.h) * m.scale));
  const out: string[] = [];
  const drawn = new Set<string>();
  for (const l of m.layers) {
    if (!l.id) continue;
    let total = 0;
    let inside = 0;
    for (let i = 0; i < l.alpha.length; i++) {
      if (l.alpha[i] < 24) continue;
      total++;
      const x = i % m.w;
      const y = (i - x) / m.w;
      if (x >= x0 && x < x1 && y >= y0 && y < y1) inside++;
    }
    if (total) drawn.add(l.id);
    if (total && inside / total >= 0.6) out.push(l.id);
  }
  const groupOf = layerGroupOf(shown);
  const keys = new Set(out.map((id) => groupOf.get(id)?.key).filter(Boolean));
  for (const r of shown) if (!out.includes(r.id) && !drawn.has(r.id) && keys.has(groupOf.get(r.id)?.key)) out.push(r.id);
  return out;
}
