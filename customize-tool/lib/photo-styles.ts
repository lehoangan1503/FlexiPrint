/**
 * Customer-photo render styles, shared by the editor, the storefront and the
 * server. Pure — no DOM.
 *
 * Two families:
 *   Free  (CT_PHOTO_STYLES)  no AI cost
 *     engine "none"    the photo as uploaded
 *     engine "local"   a canvas filter in the browser (lib/photo-process.ts)
 *     engine "server"  the photo-style microservice (OpenCV, ~1 s)
 *   AI    "ai:<uuid>"        a row of the global ct_ai_styles library (prompt +
 *                            fal.ai model), always run on the server. Only the
 *                            name ever reaches the storefront.
 */

import type { CtAiStyleRef, CtPhotoStyleId, CtPhotoStyleRef, CtPublicAiStyle } from "../types";

export type CtPhotoStyleEngine = "none" | "local" | "server";

export interface CtPhotoStyleDef {
  id: CtPhotoStyleId;
  /** Customer-facing (storefront is English). */
  label: string;
  /** Editor-facing hint. */
  hint: string;
  engine: CtPhotoStyleEngine;
}

export const CT_PHOTO_STYLES: CtPhotoStyleDef[] = [
  { id: "original", label: "Real photo", hint: "Giữ nguyên ảnh khách", engine: "none" },
  { id: "oil", label: "Oil painting", hint: "Sơn dầu nét nhỏ, giữ màu gốc (service photo-style, OpenCV)", engine: "server" },
  { id: "pixel", label: "Pixel art", hint: "Pixel art giữ màu gốc — lọc ngay trên trình duyệt", engine: "local" },
];

const BY_ID = new Map(CT_PHOTO_STYLES.map((s) => [s.id, s]));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isPhotoStyle(id: string): id is CtPhotoStyleId {
  return BY_ID.has(id as CtPhotoStyleId);
}

export function isAiStyleRef(ref: string): ref is CtAiStyleRef {
  return ref.startsWith("ai:") && UUID.test(ref.slice(3));
}

export function isPhotoStyleRef(ref: string): ref is CtPhotoStyleRef {
  return isPhotoStyle(ref) || isAiStyleRef(ref);
}

export function aiStyleRef(id: string): CtAiStyleRef {
  return `ai:${id}`;
}

export function aiStyleId(ref: CtAiStyleRef): string {
  return ref.slice(3);
}

export function photoStyle(id: CtPhotoStyleId | undefined): CtPhotoStyleDef {
  return BY_ID.get(id ?? "original") ?? CT_PHOTO_STYLES[0];
}

export function styleEngine(ref: CtPhotoStyleRef | undefined): CtPhotoStyleEngine {
  if (ref && isAiStyleRef(ref)) return "server";
  return photoStyle(ref as CtPhotoStyleId | undefined).engine;
}

/** Customer-facing name. AI names come from the template / the editor's style list. */
export function styleLabel(ref: CtPhotoStyleRef | undefined, aiStyles: CtPublicAiStyle[] | undefined): string {
  if (ref && isAiStyleRef(ref)) return aiStyles?.find((s) => s.ref === ref)?.name ?? "AI style";
  return photoStyle(ref as CtPhotoStyleId | undefined).label;
}

/** Does rendering this style (+ cut-out) need the server? */
export function needsServer(style: CtPhotoStyleRef, cutout: boolean): boolean {
  return cutout || styleEngine(style) === "server";
}
