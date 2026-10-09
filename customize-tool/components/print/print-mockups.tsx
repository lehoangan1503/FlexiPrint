"use client";

/**
 * Mockups tab, products on a khuôn in: the photo per option of each print-only layer (OptionMockups) and the photos
 * whose zones are repainted (ZoneMockups, clothes). Shown above the hand-made mockup builder.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { CtAsset, CtProductConfig, CtProductScene, CtRegion, CtRegionItem, CtSelection, CtZoneMockup } from "../../types";
import { regionGroups } from "../../lib/design";
import { zoneFills } from "../../lib/zone-mockup";
import { OptionMockups } from "./option-mockups";
import { ZoneMockups } from "./zone-mockups";

export interface PrintMockupsProps {
  config: CtProductConfig;
  regions: CtRegion[];
  items: CtRegionItem[];
  assets: CtAsset[];
  selection: CtSelection;
  /** The design canvas (the sheet). */
  design: { width: number; height: number };
  onConfig: (patch: Partial<CtProductConfig>) => void;
}

export function PrintMockups({ config, regions, items, assets, selection, design, onConfig }: PrintMockupsProps) {
  const [open, setOpen] = useState(true);
  const printOnly = regions.filter((r) => r.kind === "image" && r.config.printOnly);
  const spec = config.print?.spec ?? null;
  if (!printOnly.length && !spec?.zones.length) return null;
  const setOptionScenes = (layerId: string, scenes: Record<string, CtProductScene>) => {
    const next = { ...config.mockupsByOption };
    if (Object.keys(scenes).length) next[layerId] = scenes;
    else delete next[layerId];
    onConfig({ mockupsByOption: next });
  };
  return (
    <section className="border-b bg-card">
      <button className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm font-semibold" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        Mockup trên trang sản phẩm {config.print ? `· ${config.print.name}` : ""}
      </button>
      {open && (
        <div className="max-h-[60vh] space-y-6 overflow-y-auto px-4 pb-4">
          {printOnly.map((r) => (
            <OptionMockups
              key={r.id}
              layer={r}
              options={regionGroups(r, items, assets).flatMap((g) => g.options)}
              scenes={config.mockupsByOption[r.id] ?? {}}
              design={design}
              onChange={(scenes) => setOptionScenes(r.id, scenes)}
            />
          ))}
          {spec && spec.zones.length > 0 && (
            <ZoneMockups spec={spec} mockups={config.zoneMockups} fills={zoneFills(regions, assets, selection)} onChange={(zoneMockups: CtZoneMockup[]) => onConfig({ zoneMockups })} />
          )}
        </div>
      )}
    </section>
  );
}
