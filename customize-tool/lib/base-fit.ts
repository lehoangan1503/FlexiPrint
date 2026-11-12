/**
 * An artwork laid on a product base (2026-11-08, like Teeinblue / Customily: the base owns the physical piece, the
 * artwork only the design):
 *
 *   base  print area (px, dpi) · khuôn in (a fixed shape) or "cut along the art" · phôi / preview photo ·
 *         silhouette in the print file · variants + price
 *   artwork  layers, options, versions — its canvas is the print area it was made for, it carries no khuôn or phôi
 *
 * `withBase` gives the artwork's config + layers as they are on the base: the khuôn becomes a khuôn layer laid on the
 * canvas (contain-fitted, then the product's placement), the material / mm / silhouette follow the base's cut, the
 * preview photo is the base's (a clear plate drawn from the design itself for a cut-to-shape acrylic). The editor uses
 * it for Xem trước / File in of an artwork ("Xem trên base", never saved); a product gets it baked in
 * (server/artwork-link.ts applyBase) so the storefront, the deploy and the server print need nothing else.
 */

import type { CtBaseProduct, CtBasePlacement, CtMaterialConfig, CtPrintAssembly, CtPrintSilhouette, CtProductConfig, CtProductScene, CtRegion, CtSewnPiece, CtShape } from "../types";
import type { CtPrintTemplate, CtProductPrint } from "../types/print";
import { defaultRegionConfig } from "./design";
import { scaleShape } from "./print-template";
import { assemblyOnCanvas, pieceOf, sheetToDesign } from "./assembly";

export interface FitBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BaseFitInput {
  productId: string;
  config: CtProductConfig;
  regions: CtRegion[];
  main: { width: number; height: number };
}

export interface BaseFit {
  config: CtProductConfig;
  regions: CtRegion[];
  /** The khuôn layer the base added (null: none — no khuôn, a cut-to-shape piece, or the artwork has its own). */
  frame: CtRegion | null;
  /** Where the khuôn's sheet sits on the canvas (canvas px), when the base has a khuôn. */
  place: FitBox | null;
}

/** Id of the khuôn layer the editor adds while viewing an artwork on a base (never saved). */
export const VIEW_FRAME_ID = "00000000-0000-4000-8000-00000000b45e";

export const DEFAULT_PLACEMENT: CtBasePlacement = { scale: 1, x: 0, y: 0 };

/**
 * The box (canvas px) the khuôn's sheet takes on the artwork: contain-fitted and centred, then the placement — the
 * artwork `scale` × bigger in the khuôn (the khuôn smaller on it) and moved by x / y of the khuôn's size.
 */
export function sheetPlace(main: { width: number; height: number }, sheet: { width: number; height: number }, placement: CtBasePlacement): FitBox {
  const k = Math.min(main.width / sheet.width, main.height / sheet.height);
  const w = (sheet.width * k) / placement.scale;
  const h = (sheet.height * k) / placement.scale;
  const cx = main.width / 2 - placement.x * w;
  const cy = main.height / 2 - placement.y * h;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

function moveShape(shape: CtShape, dx: number, dy: number): CtShape {
  switch (shape.type) {
    case "rect":
      return { ...shape, x: shape.x + dx, y: shape.y + dy };
    case "ellipse":
      return { ...shape, cx: shape.cx + dx, cy: shape.cy + dy };
    case "polygon":
      return { ...shape, points: shape.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  }
}

/** A shape of the sheet (sheet px) where the sheet sits on the canvas. */
function onCanvas(shape: CtShape, sheetWidth: number, place: FitBox): CtShape {
  const k = place.w / sheetWidth;
  return moveShape(scaleShape(shape, k, k), place.x, place.y);
}

/** The khuôn layer of `print` laid at `place` on the canvas; null for a khuôn cut along the art / without a shape. */
export function baseFrameRegion(productId: string, id: string, print: CtProductPrint, place: FitBox): CtRegion | null {
  const { spec } = print;
  const config = { ...defaultRegionConfig("image"), clip: false, materialFrame: true };
  const base = { id, product_id: productId, kind: "image" as const, sort_order: 0 };
  const face = spec.faces[0];
  if (face) {
    // A khuôn drawn only as a picture of lines (Printbelle Template.tif of a flat piece: blanket body + hood + pocket,
    // 2026-11-12): its guide over the design, cut to its sheet.
    if (!face.maskUrl) {
      if (!face.guideUrl) return null;
      return {
        ...base,
        name: `Khuôn in — ${print.name}`,
        shape: { type: "rect", x: place.x, y: place.y, w: place.w, h: place.h, radius: 0 },
        config: { ...config, guideUrl: face.guideUrl },
      };
    }
    return {
      ...base,
      name: `Khuôn in — ${print.name}`,
      shape: { type: "rect", x: place.x, y: place.y, w: place.w, h: place.h, radius: 0 },
      config: { ...config, maskUrl: face.maskUrl, guideUrl: face.guideUrl },
    };
  }
  if (print.kind === "cut" || !spec.outline) return null;
  return {
    ...base,
    name: `Khuôn in — ${print.name}`,
    shape: onCanvas(spec.outline, spec.width, place),
    config: { ...config, cuts: spec.cuts.map((c) => onCanvas(c, spec.width, place)) },
  };
}

/** The canvas's box on a photo where `sheetBox` is the sheet's box (photo px) and `place` the sheet's on the canvas. */
function canvasOnPhoto(sheetBox: FitBox, place: FitBox, main: { width: number; height: number }): FitBox {
  const s = sheetBox.w / place.w;
  return { x: sheetBox.x - place.x * s, y: sheetBox.y - place.y * s, w: main.width * s, h: main.height * s };
}

/** The canvas contain-fitted (centred) in a photo's box — the box keeps the print area's shape, the canvas its own. */
function containIn(box: FitBox, main: { width: number; height: number }): FitBox {
  const k = Math.min(box.w / main.width, box.h / main.height);
  const w = main.width * k;
  const h = main.height * k;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/** mm across the artwork canvas on this base: the khuôn's real width, else the print area's at its dpi. */
function canvasWidthMm(base: CtBaseProduct, print: CtProductPrint | null, place: FitBox | null, main: { width: number; height: number }): number {
  if (print?.spec.widthMm && place) return (print.spec.widthMm * main.width) / place.w;
  if (print?.spec.widthMm) return print.spec.widthMm;
  const area = base.config.printAreas[0];
  if (!area) return 0;
  const k = Math.min(area.width / main.width, area.height / main.height);
  return ((main.width * k) / area.dpi) * 25.4;
}

/**
 * The khuôn's spec redrawn in the artwork canvas's px (its outline, safe zone, cut-outs, zones where the sheet sits on
 * the canvas): what the editor's guides, the safe-zone check and the print file read. Sizes are dropped (a khuôn with
 * sizes makes its own sheets), the guide picture only kept when the sheet is the canvas.
 */
export function printOnCanvas(print: CtProductPrint, place: FitBox, main: { width: number; height: number }): CtProductPrint {
  const { spec } = print;
  const same = Math.abs(place.x) < 0.5 && Math.abs(place.y) < 0.5 && Math.abs(place.w - main.width) < 0.5 && Math.abs(place.h - main.height) < 0.5;
  if (same && spec.width === main.width && spec.height === main.height) return print;
  const on = (sh: CtShape) => onCanvas(sh, spec.width, place);
  return {
    ...print,
    spec: {
      ...spec,
      width: main.width,
      height: main.height,
      widthMm: spec.widthMm ? (spec.widthMm * main.width) / place.w : spec.widthMm,
      heightMm: spec.heightMm ? (spec.heightMm * main.height) / place.h : spec.heightMm,
      outline: spec.outline ? on(spec.outline) : null,
      bleed: (spec.bleed * place.w) / spec.width,
      safe: spec.safe.map(on),
      cuts: spec.cuts.map(on),
      zones: spec.zones.map((z) => ({ ...z, shape: on(z.shape) })),
      sizes: [],
      frameUrl: same ? spec.frameUrl : null,
    },
  };
}

/**
 * The canvas of an artwork made for a base (Teeinblue: "set the artwork size the same as the print area"): its first
 * print area, else its khuôn's sheet, else 1000².
 */
export function baseCanvas(base: CtBaseProduct, template: CtPrintTemplate | null): { width: number; height: number } {
  const area = base.config.printAreas[0];
  if (area?.width && area.height) return { width: area.width, height: area.height };
  if (template) return { width: template.spec.width, height: template.spec.height };
  return { width: 1000, height: 1000 };
}

/** A khuôn whose sheet is not the canvas, redrawn on it (contain-fitted, centred) — its safe zone, outline, holes. */
export function templateOnCanvas(t: CtPrintTemplate, canvas: { width: number; height: number }): CtPrintTemplate {
  if (t.spec.width === canvas.width && t.spec.height === canvas.height) return t;
  const print = printOnCanvas(productPrintOfTemplate(t), sheetPlace(canvas, t.spec, DEFAULT_PLACEMENT), canvas);
  return { ...t, spec: { ...print.spec, blanks: [] } };
}

export function productPrintOfTemplate(t: CtPrintTemplate): CtProductPrint {
  return { templateId: t.id, name: t.name, kind: t.kind, spec: t.spec };
}

/** A sewn sheet's safe zones (canvas px of the sheet) moved to where their pieces show on the design. */
function sewnSafe(print: CtProductPrint, pieces: CtSewnPiece[]): CtProductPrint {
  if (!pieces.length) return print;
  const safe = print.spec.safe.flatMap((s) => {
    const p = pieceOf(pieces, s);
    return p ? [sheetToDesign(s, p)] : [];
  });
  return { ...print, spec: { ...print.spec, safe, outline: null, cuts: [], zones: [] } };
}

/** The artwork as it is on `base` (see the file comment). No base: unchanged. */
export function withBase(
  input: BaseFitInput,
  base: CtBaseProduct | null,
  template: CtPrintTemplate | null,
  placement: CtBasePlacement = DEFAULT_PLACEMENT,
  frameId: string = VIEW_FRAME_ID,
): BaseFit {
  const { config, main } = input;
  const regions = input.regions.filter((r) => r.id !== frameId);
  if (!base) return { config, regions, frame: null, place: null };
  const cut = base.config.cut;
  const tpl = template && template.id === base.config.templateId ? template : null;
  // The base's khuôn in rules the print file whatever its cut (2026-11-12: a flat Wearable Hooded Blanket base with the
  // Printbelle HWHB khuôn was ignored because it is "in phẳng" — an artwork dropped from an acrylic set kept printing
  // like acrylic).
  const print = tpl ? productPrintOfTemplate(tpl) : null;
  // An artwork made on a khuôn before 2026-11-08 has its own khuôn layer: it stays (it is that khuôn).
  const ownFrame = regions.some((r) => r.config?.materialFrame);
  // Where the khuôn's sheet sits on the canvas: placed by the product (a fixed khuôn), else just fitted (its guides).
  const sheetBox = print ? sheetPlace(main, print.spec, cut.mode === "khuon" ? placement : DEFAULT_PLACEMENT) : null;
  // Cut along the art (alpha): the khuôn is only guides. Fixed khuôn / flat print: the design sits in the khuôn.
  const place = cut.mode !== "alpha" ? sheetBox : null;
  // A sheet sewn from pieces (hooded blanket): the design is the product as the preview shows it — the guide on it is
  // the khuôn's lines moved to where each piece shows (lib/assembly), the file in is sewn from it.
  const sewn = base.config.assembly && print && place && cut.mode !== "alpha" ? base.config.assembly : null;
  const pieces = sewn && place && print ? assemblyOnCanvas(sewn, print.spec.width, place) : [];
  let frame = place && print && !ownFrame ? baseFrameRegion(input.productId, frameId, print, place) : null;
  if (frame && sewn?.guideUrl) frame = { ...frame, config: { ...frame.config, guideUrl: sewn.guideUrl, maskUrl: null } };
  const sheetGuideUrl = print?.spec.faces[0]?.guideUrl ?? null;
  const assembly: CtPrintAssembly | null = pieces.length && place ? { pieces, sheetGuide: sheetGuideUrl ? { url: sheetGuideUrl, ...place } : null } : null;

  const widthMm = canvasWidthMm(base, print, sheetBox, main);
  const material: CtMaterialConfig = {
    ...config.material,
    id: base.config.material,
    // Only a base cut along the art cuts along it (an artwork from an acrylic set keeps no "contour" of its own).
    shape: cut.mode === "alpha" ? "contour" : config.material.shape === "contour" ? "main" : config.material.shape,
    widthMm: widthMm > 0 ? Math.round(widthMm * 10) / 10 : config.material.widthMm,
    borderMm: cut.mode === "alpha" ? cut.borderMm : config.material.borderMm,
  };
  const pxPerMm = widthMm > 0 ? main.width / widthMm : 0;
  // On for every cut piece (2026-11-10): the khuôn's shape (inside its solid line), else the design's own outline. A
  // flat print (blanket, shirt — nothing is cut) has none: the file is the design on the khuôn (2026-11-12).
  const printSilhouette: CtPrintSilhouette = {
    enabled: cut.mode !== "none",
    offset: cut.mode === "alpha" ? Math.min(60, Math.max(0, Math.round(cut.borderMm * pxPerMm))) : 0,
    hole: cut.mode === "alpha" && cut.hole,
    holeSize: cut.holeSize,
  };

  // The preview photo: the base's own, else (a khuôn) the khuôn's first phôi, else the artwork's.
  let scene: CtProductScene = config.scene;
  const photo = base.config.preview;
  const blank = print?.spec.blanks[0];
  if (cut.mode === "alpha" && photo.url) {
    scene = { url: photo.url, width: photo.width, height: photo.height, box: containIn(photo.box, main), plate: { border: widthMm > 0 ? cut.borderMm / widthMm : 0.025 } };
  } else if (photo.url) {
    scene = { url: photo.url, width: photo.width, height: photo.height, box: place ? canvasOnPhoto(photo.box, place, main) : containIn(photo.box, main), ...(photo.overlay ? { overlay: photo.overlay } : {}) };
  } else if (blank && place) {
    scene = { url: blank.url, width: blank.width, height: blank.height, box: canvasOnPhoto(blank.box, place, main) };
  }

  return {
    config: {
      ...config,
      viewBaseId: base.id,
      print: print && sheetBox ? sewnSafe(printOnCanvas(print, sheetBox, main), pieces) : ownFrame ? config.print : null,
      material,
      printSilhouette,
      scene,
      assembly,
    },
    regions: frame ? [frame, ...regions] : regions,
    frame,
    place,
  };
}
