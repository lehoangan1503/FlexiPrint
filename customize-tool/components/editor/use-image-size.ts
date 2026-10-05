"use client";

/** Natural size of the image at `url` (null until it has loaded, or for no url). Shares lib/compositor's image cache. */

import { useEffect, useMemo, useState } from "react";
import { loadImage } from "../../lib/compositor";

export interface CtImageSize {
  width: number;
  height: number;
}

export function useImageSize(url: string | null | undefined): CtImageSize | null {
  const [size, setSize] = useState<{ url: string; width: number; height: number } | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    loadImage(url)
      .then((img) => {
        if (!cancelled) setSize({ url, width: img.naturalWidth, height: img.naturalHeight });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [url]);
  // A size measured for an earlier url is stale. Memoised: callers put it in hook deps.
  const ok = size !== null && !!url && size.url === url;
  const width = ok ? size.width : 0;
  const height = ok ? size.height : 0;
  return useMemo(() => (ok ? { width, height } : null), [ok, width, height]);
}
