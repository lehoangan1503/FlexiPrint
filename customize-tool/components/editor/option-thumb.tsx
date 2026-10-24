"use client";

/** An option's tile picture: cropped to its own part and centred (lib/option-thumb.ts); the file itself until then.
 *  An option with no clipart (an empty file) shows its label instead of a blank tile. */

import { useEffect, useState } from "react";
import { optionThumbInfo, type OptionThumbInfo } from "../../lib/option-thumb";

export function OptionThumb({ url, label, className }: { url: string; label?: string; className?: string }) {
  const [shown, setShown] = useState<{ url: string; info: OptionThumbInfo } | null>(null);
  useEffect(() => {
    let live = true;
    void optionThumbInfo(url).then((info) => live && setShown({ url, info }));
    return () => {
      live = false;
    };
  }, [url]);
  const info = shown?.url === url ? shown.info : null;
  if (info?.empty)
    return (
      <span className="flex h-full w-full items-center justify-center bg-background/80 p-0.5 text-center text-[10px] font-medium leading-tight break-words">
        <span className="line-clamp-3">{label?.trim() || "(trống)"}</span>
      </span>
    );
  // eslint-disable-next-line @next/next/no-img-element -- a data url / our R2 picture
  return <img src={info?.src ?? url} alt="" className={className} loading="lazy" />;
}
