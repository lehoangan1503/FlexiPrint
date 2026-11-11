/**
 * Merchize khuôn in + phôi for ONE base, at its import (asked 2026-11-12: "chỉ làm logic để đó, cần import cái nào thì
 * support, hoặc báo làm tay cái nào không hỗ trợ"). Nothing is fetched in bulk.
 *
 * 1. merchize.com → the product's Drive folders (server/merchize-site.ts).
 * 2. Template: the folder's PSDs (not the mockups); their headers (26 bytes, HTTP Range) give the sheet px, the one
 *    matching the base's print area wins. services/layer-kit /psd/template reads it by layer names:
 *      gray    `gray` = print area, `safe zone` = safe lines            → one khuôn
 *      shapes  `safe zone` group of named shapes (Heart / Circle …)     → one khuôn per shape, the first on the base
 *      cut     "Cut-out Shape" + "Printed Design" (custom shape)        → no khuôn: the base cuts along the design
 *      manual  anything else                                            → the team makes the khuôn (links kept)
 * 3. Phôi: the same folder's "Mockup" PSDs → /psd/mockup: the blank product (design rendered white), the overlay
 *    (shading + what hides the design off the product) and the design's box. Not for cut-to-shape products.
 */

import sharp from "sharp";
import { CT_CONFIG, CT_TABLES } from "../config";
import { newId } from "../lib/geometry";
import { normalizePrintSpec } from "../lib/print-template";
import { normalizeScene } from "../lib/scene";
import type { CtBaseCutMode, CtBaseSourceLink, CtProductScene, CtShape } from "../types";
import type { CtPrintTemplate } from "../types/print";
import { kitPost } from "./char/kit";
import { merchizePage } from "./merchize-site";
import { driveFolder, type DriveEntry } from "./printbelle-khuon";
import { ctLibraryPath, ctUpload } from "./storage";
import type { CtSession } from "./supabase";

const KIT_MS = 15 * 60_000;

const download = (id: string) => `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;

interface PsdFile {
  id: string;
  name: string;
  width: number;
  height: number;
}

/** A PSD's sheet px from its first 26 bytes; null when it isn't a PSD. */
async function psdSize(e: DriveEntry): Promise<PsdFile | null> {
  try {
    const res = await fetch(download(e.id), { headers: { range: "bytes=0-25" }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return null;
    const b = Buffer.from(await res.arrayBuffer());
    if (b.length < 26 || b.toString("latin1", 0, 4) !== "8BPS") return null;
    return { id: e.id, name: e.name, height: b.readUInt32BE(14), width: b.readUInt32BE(18) };
  } catch {
    return null;
  }
}

interface Folder {
  templates: DriveEntry[];
  mockups: DriveEntry[];
}

const isPsd = (e: DriveEntry) => !e.folder && /\.(psd|psb)$/i.test(e.name);

/** A Drive folder's template PSDs + the PSDs of its "Mockup" sub-folder(s). */
async function readFolder(id: string): Promise<Folder> {
  const entries = await driveFolder(id);
  const templates = entries.filter((e) => isPsd(e) && !/mockup/i.test(e.name));
  const mockups = entries.filter((e) => isPsd(e) && /mockup/i.test(e.name));
  for (const sub of entries.filter((e) => e.folder && /mockup/i.test(e.name)).slice(0, 2)) mockups.push(...(await driveFolder(sub.id)).filter(isPsd));
  return { templates, mockups };
}

interface KitFace {
  name: string;
  mask: string;
  guide: string;
  safe: CtShape[];
}

interface KitTemplate {
  family: "gray" | "shapes" | "cut" | "manual";
  width: number;
  height: number;
  faces: KitFace[];
}

interface KitMockup {
  error?: string;
  scenes?: string[];
  width: number;
  height: number;
  scene: string;
  warp: string;
  box: { x: number; y: number; w: number; h: number };
  phoi: string;
  overlay: string;
}

export interface MerchizeKhuonImport {
  /** The khuôn put on the base (the first shape when there are several); null = none. */
  templateId: string | null;
  /** The base's cut: khuon (a khuôn was made), alpha (custom shape), null = leave it. */
  cut: CtBaseCutMode | null;
  /** Merchize's phôi (blank product + overlay + box); null = none made. */
  preview: CtProductScene | null;
  /** The template / mockup links (kept on the base for the team). */
  links: CtBaseSourceLink[];
  /** What was made and what is left to do by hand, for the base's notes. */
  notes: string[];
}

async function putPng(userId: string, data: Buffer): Promise<string> {
  return ctUpload(ctLibraryPath(userId, null, "print-template", "image/png"), data, "image/png");
}

async function makeKhuon(s: CtSession, name: string, t: KitTemplate, face: KitFace, file: PsdFile, folderId: string): Promise<string> {
  // The mask as the other khuôn store it: white, alpha = printed.
  const maskPng = await sharp({ create: { width: t.width, height: t.height, channels: 3, background: "#ffffff" } })
    .joinChannel(Buffer.from(face.mask, "base64"))
    .png()
    .toBuffer();
  const [guideUrl, maskUrl] = await Promise.all([putPng(s.user.id, Buffer.from(face.guide, "base64")), putPng(s.user.id, maskPng)]);
  const mm = (px: number) => Math.round((px / 300) * 254) / 10;
  const spec = normalizePrintSpec({
    width: t.width,
    height: t.height,
    dpi: 300,
    widthMm: mm(t.width),
    heightMm: mm(t.height),
    safe: face.safe,
    faces: [{ id: newId(), name: "Mặt in", imageUrl: guideUrl, maskUrl, guideUrl }],
    notes: `Khuôn Merchize: ${file.name}${t.faces.length > 1 ? ` · hình ${face.name}` : ""} · https://drive.google.com/drive/folders/${folderId}`,
  });
  const { data: last } = await s.supabase.from(CT_TABLES.printTemplates).select("sort_order").order("sort_order", { ascending: false }).limit(1).maybeSingle<{ sort_order: number }>();
  const { data, error } = await s.supabase
    .from(CT_TABLES.printTemplates)
    .insert({ name: name.slice(0, 200), kind: "flat", spec, sort_order: (last?.sort_order ?? 0) + 1, user_id: s.user.id })
    .select("*")
    .single<CtPrintTemplate>();
  if (error) throw new Error(error.message);
  return data.id;
}

/** The template that fits the print area: the same px, else the same shape (largest), else the first. */
function pickTemplate(files: PsdFile[], sheet: { width: number; height: number } | null): PsdFile | null {
  if (!files.length) return null;
  if (!sheet) return files[0];
  const exact = files.find((f) => f.width === sheet.width && f.height === sheet.height);
  if (exact) return exact;
  const same = files.filter((f) => Math.abs(f.width / f.height - sheet.width / sheet.height) < 0.02).sort((a, b) => b.width * b.height - a.width * a.height);
  return same[0] ?? null;
}

/**
 * Merchize SKU → khuôn + phôi for a base whose print area is `sheet`. `wantKhuon` false keeps the base's own khuôn (a
 * refresh). Never throws: what can't be made becomes a note.
 */
export async function importMerchizeKhuon(s: CtSession, sku: string, baseName: string, sheet: { width: number; height: number } | null, wantKhuon = true): Promise<MerchizeKhuonImport> {
  const out: MerchizeKhuonImport = { templateId: null, cut: null, preview: null, links: [], notes: [] };
  try {
    const page = await merchizePage(sku);
    if (!page) {
      out.notes.push("merchize.com không có sản phẩm này — làm khuôn + phôi tay");
      return out;
    }
    out.links = page.links;
    if (!page.folders.length) {
      out.notes.push("Merchize không để file khuôn công khai cho mã này — làm khuôn + phôi tay");
      return out;
    }
    // The folder holding the template that fits the print area.
    let chosen: { folderId: string; folder: Folder; file: PsdFile } | null = null;
    let anyTemplate = false;
    for (const folderId of page.folders.slice(0, 6)) {
      const folder = await readFolder(folderId).catch((): Folder => ({ templates: [], mockups: [] }));
      if (!folder.templates.length) continue;
      anyTemplate = true;
      const sizes = (await Promise.all(folder.templates.slice(0, 8).map(psdSize))).filter((x): x is PsdFile => !!x);
      const file = pickTemplate(sizes, sheet);
      if (file) {
        chosen = { folderId, folder, file };
        if (sheet && file.width === sheet.width && file.height === sheet.height) break;
      }
    }
    if (!chosen) {
      out.notes.push(anyTemplate ? `File khuôn Merchize không khớp vùng in ${sheet ? `${sheet.width}×${sheet.height}` : ""} — chọn khuôn tay` : "Thư mục Merchize không có file khuôn PSD — làm khuôn tay");
      return out;
    }
    const { folderId, folder, file } = chosen;
    const fileSheet = { width: file.width, height: file.height };

    let family: KitTemplate["family"] | null = null;
    if (wantKhuon) {
      const t = await kitPost<KitTemplate>("/psd/template", { url: download(file.id), sheet: [file.width, file.height] }, KIT_MS);
      family = t.family;
      if (t.family === "cut") {
        out.cut = "alpha";
        out.notes.push(`${file.name}: sản phẩm cắt theo hình thiết kế — base cắt theo viền (alpha), không cần khuôn`);
      } else if (t.family === "manual" || !t.faces.length) {
        out.notes.push(`${file.name}: khuôn PSD không theo quy ước layer (gray / safe zone) — làm khuôn tay`);
      } else {
        const ids: string[] = [];
        for (const face of t.faces.slice(0, 12)) {
          const label = t.faces.length > 1 ? `${baseName} · ${face.name}` : `${baseName} · Merchize ${sku}`;
          ids.push(await makeKhuon(s, label, t, face, file, folderId));
        }
        out.templateId = ids[0];
        out.cut = "khuon";
        out.notes.push(
          t.faces.length > 1
            ? `${t.faces.length} khuôn theo hình (${t.faces.map((f) => f.name).join(", ")}) từ ${file.name} — base dùng “${t.faces[0].name}”, đổi ở Khuôn in`
            : `Khuôn in từ ${file.name} (${file.width}×${file.height}px, ${t.faces[0].safe.length} vùng an toàn)`,
        );
      }
    }

    // Phôi — not for custom-shape products (the plate is drawn from each design).
    if (family !== "cut") {
      if (!folder.mockups.length) out.notes.push("Merchize không có mockup PSD cho khuôn này — phôi tải tay / tạo bằng AI");
      let lastError = "";
      for (const m of folder.mockups.slice(0, 3)) {
        try {
          const r = await kitPost<KitMockup>("/psd/mockup", { url: download(m.id), sheet: [fileSheet.width, fileSheet.height] }, KIT_MS);
          if (r.error) {
            lastError = `${m.name}: ${r.error}`;
            continue;
          }
          const dir = `${s.user.id}/${CT_CONFIG.storagePrefix}/bases/merchize-${sku.replace(/[^a-z0-9_-]+/gi, "_")}`;
          const [url, overlay] = await Promise.all([
            ctUpload(`${dir}/${crypto.randomUUID()}.jpg`, Buffer.from(r.phoi, "base64"), "image/jpeg"),
            ctUpload(`${dir}/${crypto.randomUUID()}.png`, Buffer.from(r.overlay, "base64"), "image/png"),
          ]);
          // The smart object holds the whole template sheet; the base's print area is that sheet (same shape).
          out.preview = normalizeScene({ url, width: r.width, height: r.height, box: r.box, overlay });
          out.notes.push(`Phôi từ mockup ${m.name} (cảnh “${r.scene}”${r.warp !== "warpNone" ? ", ảnh gốc có uốn cong — thiết kế đặt phẳng, gần đúng" : ""})`);
          lastError = "";
          break;
        } catch (e) {
          lastError = `${m.name}: ${e instanceof Error ? e.message : "lỗi"}`;
        }
      }
      if (!out.preview && lastError) out.notes.push(`Không dựng được phôi (${lastError}) — phôi tải tay / tạo bằng AI`);
    }
    return out;
  } catch (e) {
    out.notes.push(`Không lấy được khuôn Merchize: ${e instanceof Error ? e.message : "lỗi"} — làm tay`);
    return out;
  }
}
