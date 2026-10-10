"use client";

/** An option's tile picture: cropped to its own part and centred (lib/option-thumb.ts); the file itself until then. */

import { useEffect, useState } from "react";
import { optionThumb } from "../../lib/option-thumb";

export function OptionThumb({ url, className }: { url: string; className?: string }) {
  const [shown, setShown] = useState<{ url: string; src: string } | null>(null);
  useEffect(() => {
    let live = true;
    void optionThumb(url).then((src) => live && setShown({ url, src }));
    return () => {
      live = false;
    };
  }, [url]);
  // eslint-disable-next-line @next/next/no-img-element -- a data url / our R2 picture
  return <img src={shown?.url === url ? shown.src : url} alt="" className={className} loading="lazy" />;
}
