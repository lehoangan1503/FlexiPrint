/**
 * Links from the editor / library into the ComfyUI studio (/studio → /comfy/).
 * The studio's FlexiPrint extension reads fp_* from its URL and opens that
 * graph with the clipart / artwork / category already picked
 * (services/comfy/custom_nodes/flexiprint/js/flexiprint.js openFromUrl).
 */

export type CtStudioTemplate = "01-origin-set" | "02-variant-set" | "03-element-pack" | "04-clipart-material" | "05-artwork-mockup";

export interface CtStudioTarget {
  template: CtStudioTemplate;
  clipart?: string | null;
  artwork?: string | null;
  category?: string | null;
}

const KEYS = ["template", "clipart", "artwork", "category"] as const;

/** App page: /studio?template=…&clipart=… */
export function studioHref(t: CtStudioTarget): string {
  const q = new URLSearchParams();
  for (const k of KEYS) {
    const v = t[k];
    if (v) q.set(k, v);
  }
  return `/studio?${q}`;
}

/** The iframe URL: studio base + fp_* params taken from the /studio page's own query. */
export function studioFrameUrl(base: string, pageQuery: URLSearchParams): string {
  const q = new URLSearchParams();
  for (const k of KEYS) {
    const v = pageQuery.get(k);
    if (v && /^[\w-]+$/.test(v)) q.set(`fp_${k}`, v);
  }
  const s = q.toString();
  return s ? `${base}${base.includes("?") ? "&" : "?"}${s}` : base;
}

export function openStudio(t: CtStudioTarget): void {
  window.open(studioHref(t), "_blank", "noopener");
}
