/**
 * Customer-photo render styles, shared by the editor, the storefront and the
 * server. Pure — no DOM.
 *
 * Three families (CtPhotoMode — a zone offers one):
 *   Free  (CT_PHOTO_STYLES, family "free")  no AI cost
 *     engine "none"    the photo as uploaded
 *     engine "local"   a canvas filter in the browser (lib/photo-process.ts)
 *   Face  (CT_PHOTO_STYLES, family "face")  no AI cost
 *     the server cuts the photo out, services/face-detect keeps only the head
 *     (no neck / body), the browser applies `filter`. The 5 are a fixed set:
 *     a Face zone always offers all of them (lib/design.ts).
 *   AI    "ai:<uuid>"        a row of the global ct_ai_styles library (prompt +
 *                            fal.ai model), always run on the server. Only the
 *                            name ever reaches the storefront.
 */

import type { CtAiStyleRef, CtPhotoMode, CtPhotoStyleId, CtPhotoStyleRef, CtPublicAiStyle } from "../types";

export type CtPhotoStyleEngine = "none" | "local" | "server";

/** Colour filter the browser applies after the server step (lib/photo-process.ts colorFilter). */
export type CtPhotoFilter = "bw" | "sepia" | "vivid" | "warm";

export interface CtPhotoStyleDef {
  id: CtPhotoStyleId;
  /** Customer-facing (storefront is English). */
  label: string;
  /** Editor-facing hint. */
  hint: string;
  engine: CtPhotoStyleEngine;
  family: "free" | "face";
  filter?: CtPhotoFilter;
}

export const CT_PHOTO_STYLES: CtPhotoStyleDef[] = [
  { id: "original", label: "Real photo", hint: "Giữ nguyên ảnh khách", engine: "none", family: "free" },
  { id: "pixel", label: "Pixel art", hint: "Pixel art giữ màu gốc — lọc ngay trên trình duyệt", engine: "local", family: "free" },
  { id: "face", label: "Real face", hint: "Cắt khuôn mặt, giữ màu gốc", engine: "server", family: "face" },
  { id: "face_bw", label: "Black & white", hint: "Cắt khuôn mặt + đen trắng", engine: "server", family: "face", filter: "bw" },
  { id: "face_sepia", label: "Sepia", hint: "Cắt khuôn mặt + tông nâu cổ điển", engine: "server", family: "face", filter: "sepia" },
  { id: "face_vivid", label: "Vivid", hint: "Cắt khuôn mặt + màu tươi, tương phản hơn", engine: "server", family: "face", filter: "vivid" },
  { id: "face_warm", label: "Warm", hint: "Cắt khuôn mặt + tông ấm vàng nắng", engine: "server", family: "face", filter: "warm" },
];

export const CT_FREE_STYLES = CT_PHOTO_STYLES.filter((s) => s.family === "free");
export const CT_FACE_STYLES = CT_PHOTO_STYLES.filter((s) => s.family === "face");

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

/** The family (= inspector tab) a style belongs to. */
export function styleFamily(ref: CtPhotoStyleRef): CtPhotoMode {
  return isAiStyleRef(ref) ? "ai" : photoStyle(ref).family;
}

/** The zone's tab: the stored mode, or (older zones) what its styles imply — a lone default "Real photo" means none picked yet. */
export function photoMode(cfg: { mode?: CtPhotoMode; styles: CtPhotoStyleRef[] }): CtPhotoMode | null {
  if (cfg.mode) return cfg.mode;
  const first = cfg.styles[0];
  if (!first || (cfg.styles.length === 1 && first === "original")) return null;
  return styleFamily(first);
}

export function styleFilter(ref: CtPhotoStyleRef | undefined): CtPhotoFilter | undefined {
  return ref && !isAiStyleRef(ref) ? photoStyle(ref).filter : undefined;
}

/** Does rendering this style (+ cut-out) need the server? */
export function needsServer(style: CtPhotoStyleRef, cutout: boolean): boolean {
  return cutout || styleEngine(style) === "server";
}
