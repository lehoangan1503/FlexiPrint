/**
 * The three kinds of clipart set (asked 2026-11-03 — the library's Clipart tab filters by them, and naming the kind
 * while writing a set's prompt helps @flexiprint build it right):
 *
 *   1  the customer picks clipart on a character — hair, outfit, hat, held item… (a drawn bộ nhân vật, a Teeinblue import)
 *   2  no clipart to pick: the zones are layers put together, or take the customer's uploaded photo (a bộ ảnh khách)
 *   3  both: clipart to pick and a zone for the customer's photo (an elf with the customer's face)
 *
 * Read from the set's brief, so every list can show it without loading the set's files. Imports are kind 1 for now:
 * the Teeinblue folders seen so far are character sets with options (other folders get their own rule when they come).
 */

import type { CtCharProject } from "../types";

export type CtSetKind = 1 | 2 | 3;

export const SET_KINDS: CtSetKind[] = [1, 2, 3];

export const SET_KIND_INFO: Record<CtSetKind, { label: string; short: string }> = {
  1: { label: "Kiểu 1", short: "Khách chọn clipart trên nhân vật" },
  2: { label: "Kiểu 2", short: "Ghép layer / vùng ảnh khách, không chọn clipart" },
  3: { label: "Kiểu 3", short: "Chọn clipart + vùng ảnh khách" },
};

export function setKind(p: Pick<CtCharProject, "brief">): CtSetKind {
  const b = p.brief;
  if (b.imported) return 1;
  if (b.kind === "photo") return 2;
  return (b.photoZones?.length ?? 0) > 0 ? 3 : 1;
}
