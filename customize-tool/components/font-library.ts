"use client";

/**
 * The team's font library in the browser (server/fonts.ts): loaded once per page, every font added to the page under
 * its family (lib/compositor addFontFile) so the canvas, the font list and the previews draw it. `reloadFonts` after
 * an upload / delete updates every component using the hook.
 */

import { useEffect, useState } from "react";
import type { CtLibraryFont } from "../types";
import { ctApi } from "../lib/api-client";
import { addFontFile } from "../lib/compositor";

let cache: CtLibraryFont[] | null = null;
let pending: Promise<CtLibraryFont[]> | null = null;
const listeners = new Set<(f: CtLibraryFont[]) => void>();

function publish(list: CtLibraryFont[]) {
  cache = list;
  for (const f of list) void addFontFile(f.family, f.url);
  for (const l of listeners) l(list);
}

export function reloadFonts(): Promise<CtLibraryFont[]> {
  pending = ctApi
    .listFonts()
    .then((r) => {
      publish(r.fonts);
      return r.fonts;
    })
    .catch(() => cache ?? [])
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** The library's fonts (empty until loaded). */
export function useLibraryFonts(): CtLibraryFont[] {
  const [fonts, setFonts] = useState<CtLibraryFont[]>(cache ?? []);
  useEffect(() => {
    listeners.add(setFonts);
    if (!cache && !pending) void reloadFonts();
    return () => {
      listeners.delete(setFonts);
    };
  }, []);
  return fonts;
}
