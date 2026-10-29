/**
 * Import a finished bộ (asked 2026-10-29: "bộ đủ, dùng với teeinblue ok rồi" — someone's own layer files become a bộ
 * nhân vật with its product, as a set drawn by AI ends):
 *
 *   POST char/projects/import {name}            → { project } a set waiting for its files (brief.imported)
 *   POST char/projects/:id/import/files          multipart file[] + path[] (the folder, a few files a request)
 *                                                → { files: CtCharImportFile[] } saved under <set folder>/import/<path>
 *   POST char/projects/:id/import/start {files}  the whole list once uploaded: a known format (lib/char-import.ts) is
 *                                                read here and the product built in the background; any other folder
 *                                                goes to @flexiprint (a chat task: char_import_files → char_import_build)
 *   POST char/projects/:id/import/rebuild        the product built again from the saved manifest
 *
 * The build (layer rules, server/mcp/layer-rules.ts): every image layer is the whole canvas — files used as they are,
 * never trimmed or scaled; a file of another size is named in `problems` and left empty. One product version per
 * manifest version; a version's variants hang under a chooser layer ("Layout"); a linked layer follows its leader
 * (config.image.follows) with mirrored groups. Every file becomes a library clipart in the product's folder (a group's
 * first file the gốc, the others its đa sắc), so the set can be dragged into any product (lib/char-set-layers.ts).
 */

import { NextResponse } from "next/server";
import sharp from "sharp";
import { CT_FONTS, CT_TABLES } from "../../config";
import type { CtAsset, CtCharImported, CtCharImportFile, CtCharImportLayer, CtCharImportManifest, CtCharImportText, CtCharProject, CtProduct, CtRegion, CtRegionItem } from "../../types";
import { defaultCharBrief, parseCharBrief } from "../../lib/char-brief";
import { manifestFiles, parseManifest, readTeeinblue, type CtImportTexts } from "../../lib/char-import";
import { defaultProductConfig, defaultRegionConfig } from "../../lib/design";
import { applyMaterialPreset, isMaterialId } from "../../lib/materials";
import { createAgentTask } from "../agent/tasks";
import { findProductFolder, productFolder } from "../artworks";
import * as h from "../handlers";
import { readImageInfo } from "../image-size";
import { insertClipart } from "../library";
import { r2Get, r2PublicUrl } from "../r2";
import { ctLibraryPath, ctRemove, ctUpload } from "../storage";
import type { CtSession } from "../supabase";
import { charFolder, saveCharFile, saveCharRaw } from "./files";
import { refreshSetUsers } from "./set-users";
import { serviceSession } from "./product";
import { NOT_YOURS, canEditProject, jobDb, jsonError, loadProject, projectRow, type Db } from "./projects";

/** One upload request's files at most (the page sends a few MB at a time). */
const MAX_IMPORT_FILE = 60 * 1024 * 1024;
/** Text files read to find the format (json / md / txt / csv). */
const MAX_TEXT = 2 * 1024 * 1024;
/** Files fetched, checked and stored at once while building. */
const POOL = 12;

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  json: "application/json",
  csv: "text/csv",
  md: "text/markdown",
  txt: "text/plain",
  ttf: "font/ttf",
  otf: "font/otf",
};
const extOf = (path: string) => (path.split(".").pop() ?? "").toLowerCase();
const importRoot = (p: Pick<CtCharProject, "id" | "user_id">, userId: string) => `${charFolder(p.user_id ?? userId, p.id)}/import`;

/** A path from the folder made safe as a key: no leading slash, no "..", no empty parts. */
function cleanPath(raw: string): string | null {
  const parts = raw.replace(/\\/g, "/").split("/").filter((x) => x && x !== ".");
  if (!parts.length || parts.some((x) => x === "..")) return null;
  return parts.join("/").slice(0, 600);
}

/** The bucket key of a file this import uploaded (its public url) — null for any other url. */
function keyOf(root: string, url: string): string | null {
  const prefix = r2PublicUrl(`${root}/`);
  if (!url.startsWith(prefix)) return null;
  return `${root}/${url.slice(prefix.length).split("/").map(decodeURIComponent).join("/")}`;
}

async function readKey(key: string): Promise<Buffer | null> {
  const obj = await r2Get(key);
  if (!obj?.Body) return null;
  return Buffer.from(await obj.Body.transformToByteArray());
}

/** brief.imported changed in place (the rest of the brief as it is now). */
async function setImported(db: Db, id: string, patch: Partial<CtCharImported>, project: Partial<Pick<CtCharProject, "product_ids" | "status" | "master_id">> = {}): Promise<void> {
  const { data } = await db.from(CT_TABLES.charProjects).select("brief").eq("id", id).maybeSingle<{ brief: unknown }>();
  const brief = parseCharBrief(data?.brief);
  const cur = brief.imported ?? emptyImported();
  await db.from(CT_TABLES.charProjects).update({ brief: { ...brief, imported: { ...cur, ...patch } }, ...project }).eq("id", id);
}

function emptyImported(): CtCharImported {
  return { status: "uploading", format: "", files: 0, bytes: 0, indexUrl: "", manifestUrl: "", done: 0, total: 0, error: "", summary: [], problems: [] };
}

async function importProject(s: CtSession, id: string): Promise<CtCharProject | NextResponse> {
  const p = await loadProject(s.supabase, id);
  if (!p) return jsonError("Không tìm thấy bộ nhân vật", 404);
  if (!(await canEditProject(s, p))) return jsonError(NOT_YOURS, 403);
  if (!p.brief.imported) return jsonError("Bộ này không phải bộ import", 409);
  return p;
}

/** POST char/projects/import */
export async function createImport(s: CtSession, body: unknown): Promise<NextResponse> {
  const b = (body && typeof body === "object" ? body : {}) as { name?: unknown };
  const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 200) : "Bộ import";
  const brief = { ...defaultCharBrief(), imported: emptyImported() };
  const { data, error } = await s.supabase.from(CT_TABLES.charProjects).insert({ user_id: s.user.id, name, brief }).select("*").single<CtCharProject>();
  if (error || !data) return jsonError(error?.message ?? "Không tạo được", 500);
  return NextResponse.json({ project: projectRow(data) }, { status: 201 });
}

/** POST char/projects/:id/import/files */
async function uploadFiles(s: CtSession, p: CtCharProject, form: FormData): Promise<NextResponse> {
  const files = form.getAll("file");
  const paths = form.getAll("path").map(String);
  if (!files.length || files.length !== paths.length) return jsonError("Cần file[] và path[] cùng số", 400);
  const root = importRoot(p, s.user.id);
  const todo: Array<{ path: string; blob: Blob }> = [];
  for (const [i, f] of files.entries()) {
    if (!(f instanceof Blob)) continue;
    const path = cleanPath(paths[i]);
    if (!path) return jsonError(`Đường dẫn không hợp lệ: ${paths[i]}`, 400);
    if (f.size > MAX_IMPORT_FILE) return jsonError(`${path}: quá lớn (tối đa 60 MB)`, 413);
    todo.push({ path, blob: f });
  }
  // Stored side by side (one after the other, a 30-file request took ~45 s: each R2 write waits ~0.3 s+).
  const out = await Promise.all(
    todo.map(async ({ path, blob }): Promise<CtCharImportFile> => ({ path, url: await ctUpload(`${root}/${path}`, Buffer.from(await blob.arrayBuffer()), MIME[extOf(path)] ?? "application/octet-stream"), size: blob.size })),
  );
  return NextResponse.json({ files: out });
}

/** POST char/projects/:id/import/start */
async function startImport(s: CtSession, p: CtCharProject, body: unknown): Promise<NextResponse> {
  const root = importRoot(p, s.user.id);
  const raw = body && typeof body === "object" ? (body as { files?: unknown }).files : null;
  const files: CtCharImportFile[] = (Array.isArray(raw) ? raw : [])
    .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : {}))
    .map((x) => ({ path: cleanPath(String(x.path ?? "")) ?? "", url: String(x.url ?? ""), size: Number(x.size) || 0 }))
    // Only files of this import.
    .filter((f) => f.path && keyOf(root, f.url) === `${root}/${f.path}`);
  if (!files.length) return jsonError("Chưa có file nào", 400);
  const indexUrl = await ctUpload(`${root}/_index.json`, Buffer.from(JSON.stringify(files)), "application/json");
  const db = jobDb(s);
  await setImported(db, p.id, { status: "analyzing", files: files.length, bytes: files.reduce((n, f) => n + f.size, 0), indexUrl, error: "", summary: [], problems: [] });
  const texts = await readTexts(root, files);
  const read = readTeeinblue(p.name, files, texts);
  if (read) {
    await startBuild(db, p.user_id ?? s.user.id, p.id, read.manifest, "teeinblue", read.summary, read.problems);
    return NextResponse.json({ status: "building", summary: read.summary, problems: read.problems });
  }
  // Another layout: @flexiprint reads the folder and writes the manifest.
  await setImported(db, p.id, { status: "agent", format: "agent", summary: [`${files.length} file — không phải định dạng đã biết, @flexiprint đang phân tích folder`] });
  const request =
    "Bộ import: người dùng vừa tải lên folder bộ clipart đã làm sẵn (file layer, phôi, mockup…). Đọc folder bằng char_import_files / char_import_read (view_image vài file), hiểu cấu trúc (lớp nào cố định, lớp nào khách chọn, lớp nào đi theo lớp khác, phiên bản, chữ khách gõ), rồi char_import_build với manifest để dựng bộ + sản phẩm. Không vẽ gì bằng AI.";
  const res = await createAgentTask(s, { kind: "char", input: { char: { projectId: p.id, step: "chat", request, roles: [], tab: "brief", section: "" } } });
  if (!res.ok) {
    const err = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`;
    await setImported(db, p.id, { status: "failed", error: `Không nhận ra định dạng folder và không gọi được @flexiprint: ${err}` });
  }
  return NextResponse.json({ status: res.ok ? "agent" : "failed" });
}

async function readTexts(root: string, files: CtCharImportFile[]): Promise<CtImportTexts> {
  const texts: CtImportTexts = new Map();
  const wanted = files.filter((f) => /\.(json|md|txt|csv)$/i.test(f.path) && f.size <= MAX_TEXT && !f.path.startsWith("_"));
  for (let i = 0; i < wanted.length; i += POOL)
    await Promise.all(
      wanted.slice(i, i + POOL).map(async (f) => {
        const b = await readKey(`${root}/${f.path}`).catch(() => null);
        if (b) texts.set(f.path, b.toString("utf8").replace(/^﻿/, ""));
      }),
    );
  return texts;
}

/** The uploaded file list of an import (MCP). */
export async function importFiles(p: CtCharProject): Promise<CtCharImportFile[]> {
  const url = p.brief.imported?.indexUrl;
  if (!url) return [];
  const key = keyOf(importRoot(p, ""), url);
  const b = key ? await readKey(key) : null;
  return b ? (JSON.parse(b.toString("utf8")) as CtCharImportFile[]) : [];
}

/** A text file of an import (MCP char_import_read), ≤ `max` characters. */
export async function importText(p: CtCharProject, path: string, max: number): Promise<string | null> {
  const clean = cleanPath(path);
  if (!clean) return null;
  const b = await readKey(`${importRoot(p, "")}/${clean}`);
  return b ? b.toString("utf8").replace(/^﻿/, "").slice(0, max) : null;
}

/** A manifest @flexiprint wrote (MCP char_import_build): checked against the upload, then built. */
export async function buildFromAgent(db: Db, p: CtCharProject, raw: unknown): Promise<{ summary: string[]; problems: string[] }> {
  const files = await importFiles(p);
  if (!files.length) throw new Error("The set has no uploaded files");
  const { manifest, problems } = parseManifest(raw, files);
  if (!manifest.name) manifest.name = p.name;
  const fatal = problems.filter((x) => /bắt buộc|trống|follows|giống hệt|không có file/i.test(x));
  if (fatal.length) throw new Error(`Manifest chưa đúng:\n${fatal.slice(0, 20).join("\n")}`);
  const variants = manifest.versions.flatMap((v) => v.variants);
  const summary = [
    `Manifest của @flexiprint: khung ${manifest.canvas.width}×${manifest.canvas.height} px`,
    `${manifest.versions.length} phiên bản${manifest.variantLabel ? ` × kiểu (${manifest.variantLabel})` : ""}: ${manifest.versions.map((v) => v.name).join(", ")}`,
    `${variants.reduce((n, x) => n + x.layers.length, 0)} lớp, ${manifestFiles(manifest).length} file, ${variants.reduce((n, x) => n + x.texts.length, 0)} ô chữ`,
  ];
  await startBuild(db, p.user_id ?? "", p.id, manifest, "agent", summary, problems);
  return { summary, problems };
}

/** Save the manifest and build in the background (the page polls brief.imported). */
async function startBuild(db: Db, userId: string, projectId: string, manifest: CtCharImportManifest, format: string, summary: string[], problems: string[]): Promise<void> {
  const p = await loadProject(db, projectId);
  if (!p) throw new Error("Không tìm thấy bộ nhân vật");
  const owner = p.user_id ?? userId;
  const manifestUrl = await ctUpload(`${importRoot(p, owner)}/_manifest.json`, Buffer.from(JSON.stringify(manifest)), "application/json");
  const total = manifestFiles(manifest).length;
  await setImported(db, projectId, { status: "building", format, manifestUrl, summary, problems, done: 0, total, error: "", beat: new Date().toISOString() });
  void buildImport(db, owner, projectId, manifest).catch(async (e: Error) => {
    console.warn("[ct] import build", projectId, e.message);
    await setImported(db, projectId, { status: "failed", error: e.message }).catch(() => undefined);
  });
}

/** POST char/projects/:id/import/rebuild — the product again from the saved manifest. */
async function rebuildImport(s: CtSession, p: CtCharProject): Promise<NextResponse> {
  if (building.has(p.id)) return jsonError("Đang dựng — chờ xong", 409);
  const url = p.brief.imported?.manifestUrl;
  const key = url ? keyOf(importRoot(p, s.user.id), url) : null;
  const b = key ? await readKey(key) : null;
  if (!b) return jsonError("Chưa có manifest — tải folder lên trước", 409);
  const manifest = JSON.parse(b.toString("utf8")) as CtCharImportManifest;
  const imp = p.brief.imported!;
  await startBuild(jobDb(s), p.user_id ?? s.user.id, p.id, manifest, imp.format, imp.summary, []);
  return NextResponse.json({ status: "building" });
}

/** Runs one at a time per set. */
const building = new Map<string, Promise<string>>();

function buildImport(db: Db, userId: string, projectId: string, m: CtCharImportManifest): Promise<string> {
  const run = (building.get(projectId) ?? Promise.resolve(""))
    .catch(() => "")
    .then(() => buildNow(db, userId, projectId, m));
  building.set(projectId, run);
  void run.finally(() => building.get(projectId) === run && building.delete(projectId)).catch(() => undefined);
  return run;
}

async function buildNow(db: Db, userId: string, projectId: string, m: CtCharImportManifest): Promise<string> {
  const s = await serviceSession(db, userId);
  const p = await loadProject(db, projectId);
  if (!p) throw new Error("Không tìm thấy bộ nhân vật");
  const root = importRoot(p, userId);
  const W = m.canvas.width;
  const H = m.canvas.height;
  const problems: string[] = [...(p.brief.imported?.problems ?? [])];

  // A build cut off before (the app restarted): its half-made product and clipart go first.
  const half = p.brief.imported?.productId;
  if (half && !p.product_ids.includes(half)) await dropProduct(s, half).catch((e: Error) => console.warn("[ct] import half product", e.message));
  const product = (await body<{ product: CtProduct }>(await h.createProduct(s, { name: p.name }))).product;
  await setImported(db, p.id, { productId: product.id });
  try {
    const folder = await productFolder(db, userId, { id: product.id, name: p.name });
    const upload = async (data: Buffer, role: string, name: string, mime = "image/png"): Promise<CtAsset> => {
      const form = new FormData();
      form.set("file", new Blob([new Uint8Array(data)], { type: mime }), `${name}.${mime === "image/jpeg" ? "jpg" : "png"}`);
      form.set("role", role);
      form.set("name", name);
      return (await body<{ asset: CtAsset }>(await h.uploadAsset(s, product.id, form))).asset;
    };
    const sheet = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const blank8 = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();

    // ---- every file: fetched, checked (canvas size), its option picture (thumb) made once per look ----
    let done = 0;
    const thumbs = new Map<string, Promise<string>>();
    const thumbOf = (url: string, png: Buffer): Promise<string> => {
      const look = url.split("/").pop() ?? url;
      const hit = thumbs.get(look);
      if (hit) return hit;
      const made = (async () => {
        const trimmed = await sharp(png).trim({ threshold: 0 }).toBuffer({ resolveWithObject: true }).catch(() => null);
        if (!trimmed) return "";
        const side = Math.max(trimmed.info.width, trimmed.info.height);
        const pad = Math.round(side * 0.06);
        const square = await sharp(trimmed.data)
          .extend({ top: pad + Math.floor((side - trimmed.info.height) / 2), bottom: pad + Math.ceil((side - trimmed.info.height) / 2), left: pad + Math.floor((side - trimmed.info.width) / 2), right: pad + Math.ceil((side - trimmed.info.width) / 2), background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .resize(240, 240)
          .webp({ quality: 86, alphaQuality: 90 })
          .toBuffer();
        return (await saveCharRaw(userId, p.id, "thumb", square, "image/webp")).url;
      })().catch(() => "");
      thumbs.set(look, made);
      return made;
    };

    // ---- cliparts: one per file of a group (its first the gốc), made as their files come ----
    type Made = { sub: CtAsset; byUrl: Map<string, CtAsset> };
    let order = 0;
    const fileOf = async (url: string): Promise<Buffer> => {
      const key = keyOf(root, url);
      let png = key ? await readKey(key) : null;
      const info = png ? readImageInfo(png) : null;
      if (!png || !info) {
        problems.push(`${url.split("/").slice(-3).join("/")}: không đọc được ảnh — để trống`);
        png = sheet;
      } else if (info.width !== W || info.height !== H) {
        // Layer rules: never scaled to fit — the wrong file is named and left empty.
        problems.push(`${url.split("/").slice(-3).join("/")}: ${info.width}×${info.height}, khung là ${W}×${H} — để trống`);
        png = sheet;
      }
      return png;
    };
    const tick = async () => {
      done++;
      if (done % 100 === 0) await setImported(db, p.id, { done, beat: new Date().toISOString() });
    };
    /**
     * A group's cliparts — every group its own (a linked hat repeated in each hair colour group too). Written in one go:
     * ids made here, the files stored side by side, one insert for the group (a clipart at a time — insertClipart's
     * lookups — took ~40 min for 6915 files, 2026-10-29).
     */
    const groupOf = async (layer: CtCharImportLayer, gi: number, withThumbs: boolean): Promise<Made> => {
      const g = layer.groups[gi];
      const gocId = crypto.randomUUID();
      const rows = await Promise.all(
        g.options.map(async (o, oi) => {
          const png = await fileOf(o.url);
          const thumb = withThumbs && png !== sheet ? await thumbOf(o.url, png) : "";
          const role = oi === 0 ? "sub" : "variant";
          const path = ctLibraryPath(userId, folder.id, role, "image/png");
          const url = await ctUpload(path, png, "image/png");
          await tick();
          return {
            id: oi === 0 ? gocId : crypto.randomUUID(),
            user_id: userId,
            product_id: null,
            category_id: folder.id,
            role,
            parent_id: oi === 0 ? null : gocId,
            generation_id: null,
            name: [layer.label, g.name, o.name].filter(Boolean).join(" · "),
            spec: "",
            tags: [],
            source: "upload",
            url,
            storage_path: path,
            width: W,
            height: H,
            mime: "image/png",
            meta: { ...(thumb ? { thumb } : {}), ...(oi === 0 && g.swatch ? { swatch: g.swatch } : {}) },
            sort_order: oi === 0 ? order++ : oi,
          };
        }),
      );
      const { data, error } = await db.from(CT_TABLES.assets).insert(rows).select("*").returns<CtAsset[]>();
      if (error || !data) {
        await ctRemove(rows.map((r) => r.storage_path));
        throw new Error(error?.message ?? "Không lưu được clipart");
      }
      const byId = new Map(data.map((a) => [a.id, a]));
      return { sub: byId.get(gocId)!, byUrl: new Map(g.options.map((o, oi) => [o.url, byId.get(rows[oi].id)!])) };
    };
    // A small pool: groups in parallel, each group's files in order (đa sắc hang on the first).
    const queue: Array<() => Promise<unknown>> = [];
    const results: Array<Promise<unknown>> = [];
    const later = <T>(fn: () => Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        queue.push(() => fn().then(resolve, reject));
      });
    const runPool = async () => {
      const workers = Array.from({ length: POOL }, async () => {
        for (let job = queue.shift(); job; job = queue.shift()) await job().catch(() => undefined);
      });
      await Promise.all(workers);
    };

    // The variants' chooser pictures (made once, every version uses them).
    const variantNames = [...new Set(m.versions.flatMap((v) => (v.variants.length > 1 ? v.variants.map((x) => x.name) : [])))];
    const chooser = new Map<string, CtAsset>();
    for (const name of variantNames) {
      const parent = chooser.size ? [...chooser.values()][0].id : null;
      chooser.set(name, await insertClipart(db, userId, { categoryId: folder.id, parentId: parent, rendition: false, name: `${m.variantLabel || "Layout"} · ${name}`, spec: "", tags: [], source: "upload", meta: {}, generationId: null, data: blank8 }));
    }

    // ---- versions → layers ----
    const mains: CtAsset[] = [];
    for (const v of m.versions) mains.push(await upload(sheet, "main", m.versions.length > 1 ? v.name : `Khung ${W}×${H}`));
    const regions: CtRegion[] = [];
    const items: CtRegionItem[] = [];
    const full = { type: "rect" as const, x: 0, y: 0, w: W, h: H, radius: 0 };
    const fonts = new Set(CT_FONTS.map((f) => f.family));
    for (const [vi, v] of m.versions.entries()) {
      const mainId = mains[vi].id;
      const tag = m.versions.length > 1 ? ` [${v.name}]` : "";
      let pick: CtRegion | null = null;
      if (v.variants.length > 1) {
        const cfg = defaultRegionConfig("image");
        const label = m.variantLabel || "Layout";
        pick = { id: crypto.randomUUID(), product_id: product.id, name: `Chọn — ${label}${tag}`, kind: "image", shape: { type: "rect", x: 0, y: 0, w: 1, h: 1, radius: 0 }, config: { ...cfg, clip: false, mainId, image: { ...cfg.image, label, display: "button" } }, sort_order: 0 };
        regions.push(pick);
        items.push({ id: crypto.randomUUID(), region_id: pick.id, asset_id: [...chooser.values()][0].id, transform: { offsetX: 0, offsetY: 0, scale: 1, rotation: 0 }, is_default: true, sort_order: 0 });
      }
      for (const x of v.variants) {
        const parent = pick ? { regionId: pick.id, optionId: chooser.get(x.name)!.id } : undefined;
        const xtag = pick ? `${tag.slice(0, -1)} · ${x.name}]` : tag;
        const byKey = new Map<string, CtRegion>();
        const textsAbove = (key: string) => x.texts.filter((t) => t.above === key);
        const addText = (t: CtCharImportText) => regions.push(textRegion(product.id, mainId, t, xtag, parent, fonts, problems));
        for (const layer of x.layers) {
          const cfg = defaultRegionConfig("image");
          const choice = layer.kind === "choice";
          const swatches = layer.groups.some((g) => g.swatch);
          const r: CtRegion = {
            id: crypto.randomUUID(),
            product_id: product.id,
            name: `${layer.label}${xtag}`,
            kind: "image",
            shape: full,
            config: {
              ...cfg,
              clip: false,
              mainId,
              ...(parent ? { parent } : {}),
              image: { ...cfg.image, label: layer.label, display: "image", groupLabel: layer.groupLabel, groupDisplay: swatches ? "swatch" : "button" },
            },
            sort_order: 0,
          };
          regions.push(r);
          byKey.set(layer.key, r);
          for (const t of textsAbove(layer.key)) addText(t);
          layer.groups.forEach((g, gi) => {
            const itemId = crypto.randomUUID();
            results.push(
              later(async () => {
                const made = await groupOf(layer, gi, choice);
                items.push({ id: itemId, region_id: r.id, asset_id: made.sub.id, transform: { offsetX: 0, offsetY: 0, scale: 1, rotation: 0 }, is_default: gi === 0, sort_order: gi });
                if (g.name) r.config.image.groupNames[itemId] = g.name;
                const def = g.options.find((o) => o.default);
                if (choice && def) r.config.image.defaultAssetId = made.byUrl.get(def.url)?.id ?? null;
              }),
            );
          });
        }
        for (const layer of x.layers) {
          if (layer.kind !== "linked") continue;
          const r = byKey.get(layer.key);
          const lead = byKey.get(layer.follows);
          if (r && lead) r.config.image.follows = lead.id;
        }
        // Texts not placed above a layer: above everything of the variant.
        for (const t of x.texts.filter((t) => !t.above || !byKey.has(t.above))) addText(t);
      }
    }
    await Promise.all([runPool(), ...results]);
    await setImported(db, p.id, { done });
    items.sort((a, b) => regions.findIndex((r) => r.id === a.region_id) - regions.findIndex((r) => r.id === b.region_id) || a.sort_order - b.sort_order);

    // ---- the product: versions, material, mockups ----
    const config = defaultProductConfig();
    if (m.versions.length > 1) config.main = { ...config.main, enabled: true, label: m.versionLabel || "Version", display: "button", subOptions: [] };
    const material = m.material && isMaterialId(m.material) ? m.material : m.cut === "alpha" ? "acrylic_clear" : null;
    config.material = { ...(material ? applyMaterialPreset(config.material, material) : config.material), widthMm: m.widthMm || config.material.widthMm };
    await body(await h.saveDesign(s, product.id, { regions: regions.map((r, i) => ({ ...r, sort_order: i })), items, config }));
    await db.from(CT_TABLES.products).update({ main_asset_id: mains[0].id }).eq("id", product.id);

    for (const [i, url] of m.mockupUrls.entries()) {
      const key = keyOf(root, url);
      const png = key ? await readKey(key) : null;
      if (!png) continue;
      const jpeg = await sharp(png).flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer();
      const a = await upload(jpeg, "mockup", `mockup_${i + 1}`, "image/jpeg");
      const meta = await sharp(jpeg).metadata();
      await db.from(CT_TABLES.packImages).insert({ user_id: userId, name: `mockup:${product.id}`, source: "upload", status: "done", listed: false, url: a.url, storage_path: null, mime: "image/jpeg", width: meta.width ?? null, height: meta.height ?? null, description: `Ảnh bán hàng ${i + 1} (từ bộ import)`, prompt: "", refs: [], aspect: "", model: "" });
    }

    // ---- the set: its sample as the master, the product as its own ----
    let masterId = p.master_id;
    const sampleKey = m.sampleUrl ? keyOf(root, m.sampleUrl) : null;
    const sample = sampleKey ? await readKey(sampleKey) : null;
    if (sample && !masterId) {
      const saved = await saveCharFile(userId, p.id, "master", sample);
      const { data: im } = await db.from(CT_TABLES.charImages).insert({ project_id: p.id, user_id: userId, kind: "master", role: "master", status: "done", ...saved }).select("id").single<{ id: string }>();
      masterId = im?.id ?? null;
    }
    const old = p.product_ids.filter((x) => x !== product.id);
    await setImported(db, p.id, { status: "done", done, problems: [...new Set(problems)].slice(0, 60), error: "" }, { product_ids: [product.id], status: "product", master_id: masterId });
    // Products the set was dragged into take the new layers, then the old product and its clipart go.
    await refreshSetUsers(s, { ...p, product_ids: old }, product.id).catch((e: Error) => console.warn("[ct] import set users", e.message));
    for (const pid of old) await dropProduct(s, pid);
    return product.id;
  } catch (e) {
    await dropProduct(s, product.id).catch(() => undefined);
    throw e;
  }
}

/** A product of the set with its clipart folder (its files on R2 too). */
async function dropProduct(s: CtSession, productId: string): Promise<void> {
  const db = s.supabase;
  const f = await findProductFolder(db, productId);
  if (f) {
    const { data: cliparts } = await db.from(CT_TABLES.assets).select("storage_path").eq("category_id", f.id).returns<Array<{ storage_path: string }>>();
    const paths = (cliparts ?? []).map((c) => c.storage_path).filter(Boolean);
    for (let i = 0; i < paths.length; i += 1000) await ctRemove(paths.slice(i, i + 1000));
    await db.from(CT_TABLES.assets).delete().eq("category_id", f.id);
    await db.from(CT_TABLES.categories).delete().eq("id", f.id);
  }
  await h.deleteProduct(s, productId);
}

/**
 * A name on the piece: its centre, max width and letter height from the source, turned `angle` degrees (a flat arc
 * turned — the way a name on a tilted hat brim is drawn, server/char/product.ts).
 */
function textRegion(productId: string, mainId: string, t: CtCharImportText, tag: string, parent: CtRegion["config"]["parent"], fonts: Set<string>, problems: string[]): CtRegion {
  const cfg = defaultRegionConfig("text");
  const family = fonts.has(t.font) ? t.font : "Poppins";
  if (family !== t.font) problems.push(`Font "${t.font}" chưa có trong danh sách font — tạm dùng Poppins`);
  const weights = CT_FONTS.find((f) => f.family === family)?.weights ?? [400];
  const weight = weights.reduce((best, w) => (Math.abs(w - t.weight) < Math.abs(best - t.weight) ? w : best), weights[0]);
  // The source gives the letters' height; a font's size is about 1.4 × its capital height.
  const fontSize = Math.max(8, Math.round(t.size * 1.4 * 10) / 10);
  const h = Math.round(fontSize * 1.3);
  const w = Math.max(t.width, fontSize);
  return {
    id: crypto.randomUUID(),
    product_id: productId,
    name: `Chữ — ${t.label}${tag}`,
    kind: "text",
    shape: { type: "rect", x: t.cx - w / 2, y: t.cy - h / 2, w, h, radius: 0 },
    config: {
      ...cfg,
      mainId,
      ...(parent ? { parent } : {}),
      text: {
        ...cfg.text,
        mode: "input",
        label: t.label,
        placeholder: t.sample ? `Example: ${t.sample}` : "",
        defaultText: t.sample,
        maxChars: t.maxChars,
        fontFamily: family,
        fontWeight: weight,
        fontSize,
        color: t.color,
        align: "center",
        ...(t.angle ? { curve: 1, arcRadius: 1000, arcTilt: Math.round(t.angle * 100) / 100 } : { curve: 0 }),
        uppercase: false,
      },
    },
    sort_order: 0,
  };
}

async function body<T>(res: NextResponse): Promise<T> {
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

/** char/projects/:id/import/<sub> */
export async function importRoute(req: Request, s: CtSession, id: string, sub: string): Promise<NextResponse> {
  const p = await importProject(s, id);
  if (p instanceof NextResponse) return p;
  if (sub === "files") return uploadFiles(s, p, await req.formData());
  if (sub === "start") return startImport(s, p, await req.json().catch(() => null));
  if (sub === "rebuild") return rebuildImport(s, p);
  return jsonError("Not found", 404);
}
