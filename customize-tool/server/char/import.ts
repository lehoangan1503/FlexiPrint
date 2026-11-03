/**
 * Import a finished bộ (asked 2026-10-29: "bộ đủ, dùng với teeinblue ok rồi" — someone's own layer files become a bộ
 * nhân vật with its product, as a set drawn by AI ends):
 *
 *   POST char/projects/import {name}            → { project } a set waiting for its files (brief.imported)
 *   GET  char/projects/imports                   → { imports: CtCharImportRow[] } the user's imports (import page, header)
 *   GET  char/projects/:id/import/files          → { files } already uploaded (an upload cut off goes on from there)
 *   POST char/projects/:id/import/files          multipart file[] + path[] (the folder, a few files a request)
 *                                                → { files: CtCharImportFile[] } saved under <set folder>/import/<path>
 *   GET  char/projects/:id/import/zip            → { total, chunk, have[] } the chunks of a zip already on the server
 *   POST char/projects/:id/import/zip?index=&chunk=&total=   one chunk of a zip (raw bytes)
 *   POST char/projects/:id/import/unzip          all chunks came: unpacked in the background (status "unpacking"),
 *                                                then read as an uploaded folder (start)
 *   POST char/projects/:id/import/start {files}  the whole list once uploaded: a known format (lib/char-import.ts) is
 *                                                read here and the product built in the background; any other folder
 *                                                goes to @flexiprint (a chat task: char_import_files → char_import_build)
 *   POST char/projects/:id/import/rebuild        the product built again from the saved manifest
 *   POST char/projects/:id/import/deploy         the product to Shopify again as a draft (import-deploy.ts — a build
 *                                                does it by itself)
 *   POST char/projects/:id/import/rethumb {fixes?}  the option pictures made again from the library clipart, the
 *                                                product published again; fixes = some set by hand (char_import_rethumb)
 *
 * The build (layer rules, server/mcp/layer-rules.ts): every image layer is the whole canvas — files used as they are,
 * never trimmed or scaled; a file of another size is named in `problems` and left empty. One product version per
 * manifest version; a version's variants hang under a chooser layer ("Layout"); a linked layer follows its leader
 * (config.image.follows) with mirrored groups. Every file becomes a library clipart in the product's folder (a group's
 * first file the gốc, the others its đa sắc), so the set can be dragged into any product (lib/char-set-layers.ts).
 */

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import yauzl from "yauzl";
import { NextResponse } from "next/server";
import sharp, { type OverlayOptions } from "sharp";
import { CT_FONTS, CT_TABLES } from "../../config";
import type { CtAsset, CtCharImportBox, CtCharImported, CtCharImportFile, CtCharImportRow, CtCharImportLayer, CtCharImportManifest, CtCharImportText, CtCharProject, CtProduct, CtRegion, CtRegionItem } from "../../types";
import { defaultCharBrief, parseCharBrief } from "../../lib/char-brief";
import { importKeep, manifestFiles, manifestPlacements, parseManifest, readTeeinblue, type CtImportTexts } from "../../lib/char-import";
import { defaultProductConfig, defaultRegionConfig } from "../../lib/design";
import { applyMaterialPreset, isMaterialId } from "../../lib/materials";
import { createAgentTask, setAgentChats } from "../agent/tasks";
import { loadFont, textSvg } from "../print-text";
import { placePiece } from "./import-place";
import { findProductFolder, productFolder } from "../artworks";
import * as h from "../handlers";
import { readImageInfo } from "../image-size";
import { insertClipart } from "../library";
import { r2Get, r2Keys, r2Objects, r2PublicUrl } from "../r2";
import { ctLibraryPath, ctRemove, ctUpload } from "../storage";
import type { CtSession } from "../supabase";
import { charFolder, saveCharFile, saveCharRaw } from "./files";
import { deployImported, deployInfo, saveImportShopify, savedDeployInfo } from "./import-deploy";
import { refreshSetUsers } from "./set-users";
import { serviceSession } from "./product";
import { siteUrl } from "../site-url";
import { NOT_YOURS, canEditProject, jobDb, jsonError, loadProject, projectRow, type Db } from "./projects";

/** One upload request's files at most (the page sends a few MB at a time). */
const MAX_IMPORT_FILE = 60 * 1024 * 1024;
/** Text files read to find the format (json / md / txt / csv). */
const MAX_TEXT = 2 * 1024 * 1024;
/** Files fetched, checked and stored at once while building. */
const POOL = 12;
/** How often a running build says it is alive (the page calls it cut off after 3 min without one). */
const BEAT_MS = 30_000;

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

/**
 * A file of the import, read again when the transfer breaks (2026-11-04: flexi2 → R2 is lossy; one body cut off
 * mid-way, "aborted", failed a 10-minute build at its mockups — the SDK retries the request, not the body).
 */
async function readKey(key: string): Promise<Buffer | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      const obj = await r2Get(key);
      if (!obj?.Body) return null;
      return Buffer.from(await obj.Body.transformToByteArray());
    } catch (e) {
      if (attempt >= 4) throw e;
      console.warn("[ct] import read again", key, e instanceof Error ? e.message : String(e));
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

/** brief.imported changed in place (the rest of the brief as it is now). */
/** Each set's import writes in turn: they read and write the whole brief, and the build's heartbeat runs beside them. */
const importWrites = new Map<string, Promise<void>>();

function setImported(db: Db, id: string, patch: Partial<CtCharImported>, project: Partial<Pick<CtCharProject, "product_ids" | "status" | "master_id">> = {}): Promise<void> {
  const run = (importWrites.get(id) ?? Promise.resolve()).catch(() => undefined).then(() => writeImported(db, id, patch, project));
  importWrites.set(id, run);
  void run.finally(() => importWrites.get(id) === run && importWrites.delete(id)).catch(() => undefined);
  return run;
}

async function writeImported(db: Db, id: string, patch: Partial<CtCharImported>, project: Partial<Pick<CtCharProject, "product_ids" | "status" | "master_id">>): Promise<void> {
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

/** GET char/projects/imports — the user's imports, newest first (the import page and the header's status). */
export async function listImports(s: CtSession): Promise<NextResponse> {
  const { data, error } = await s.supabase
    .from(CT_TABLES.charProjects)
    .select("id, name, created_at, updated_at, product_ids, brief")
    .eq("user_id", s.user.id)
    .not("brief->imported", "is", null)
    .order("created_at", { ascending: false })
    .limit(60)
    .returns<Array<Pick<CtCharProject, "id" | "name" | "created_at" | "updated_at" | "product_ids"> & { brief: unknown }>>();
  if (error) return jsonError(error.message, 500);
  const imports: CtCharImportRow[] = [];
  for (const r of data ?? []) {
    const imported = parseCharBrief(r.brief).imported;
    if (imported) imports.push({ id: r.id, name: r.name, created_at: r.created_at, updated_at: r.updated_at, product_ids: r.product_ids ?? [], imported });
  }
  const chats = await setAgentChats(s, imports.map((r) => r.id));
  for (const r of imports) {
    const chat = chats.get(r.id);
    if (chat) r.agent = chat;
  }
  return NextResponse.json({ imports });
}

/** GET char/projects/:id/import/files — what is on the bucket already (a cut-off upload sends only the rest). */
async function uploadedFiles(s: CtSession, p: CtCharProject): Promise<NextResponse> {
  const root = importRoot(p, s.user.id);
  const files: CtCharImportFile[] = (await r2Objects(root))
    .map((o) => ({ path: o.key.slice(root.length + 1), url: r2PublicUrl(o.key), size: o.size }))
    .filter((f) => f.path && !f.path.startsWith("_"));
  return NextResponse.json({ files });
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
  return NextResponse.json(await startFrom(s, p, files));
}

/** The uploaded files read: a known format is built in the background, any other goes to @flexiprint. */
async function startFrom(s: CtSession, p: CtCharProject, files: CtCharImportFile[]): Promise<{ status: string; summary?: string[]; problems?: string[] }> {
  const root = importRoot(p, s.user.id);
  const indexUrl = await ctUpload(`${root}/_index.json`, Buffer.from(JSON.stringify(files)), "application/json");
  const db = jobDb(s);
  await setImported(db, p.id, { status: "analyzing", files: files.length, bytes: files.reduce((n, f) => n + f.size, 0), indexUrl, error: "", summary: [], problems: [] });
  const texts = await readTexts(root, files);
  const read = readTeeinblue(p.name, files, texts);
  if (read) {
    await startBuild(db, p.user_id ?? s.user.id, p.id, read.manifest, "teeinblue", read.summary, read.problems);
    return { status: "building", summary: read.summary, problems: read.problems };
  }
  // Another layout: @flexiprint reads the folder and writes the manifest.
  await setImported(db, p.id, { status: "agent", format: "agent", summary: [`${files.length} file — không phải định dạng đã biết, @flexiprint đang phân tích folder`] });
  const request =
    "Bộ import: người dùng vừa tải lên folder bộ clipart đã làm sẵn (file layer, phôi, mockup…) — định dạng chưa quen. Đọc folder bằng char_import_files / char_import_read (view_image vài file), hiểu cấu trúc (lớp nào cố định, lớp nào khách chọn, lớp nào đi theo lớp khác, phiên bản, chữ khách gõ). Phân tích và kết hợp TẤT CẢ những gì có trong folder để ra sản phẩm cuối giống file in / preview của folder: mảnh nhỏ hơn khung → char_import_locate trong file in từng phiên bản để lấy box; chữ → char_import_diff (bản có tên vs không tên); font riêng của folder → fontFile. Kiểm từng phiên bản bằng char_import_preview (so với file in) rồi mới char_import_build. Không dừng giữa chừng chỉ vì định dạng lạ; không vẽ gì bằng AI.";
  const res = await createAgentTask(s, { kind: "char", input: { char: { projectId: p.id, step: "chat", request, roles: [], tab: "brief", section: "" } } });
  if (!res.ok) {
    const err = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`;
    await setImported(db, p.id, { status: "failed", error: `Không nhận ra định dạng folder và không gọi được @flexiprint: ${err}` });
  }
  return { status: res.ok ? "agent" : "failed" };
}

// ---------------------------------------------------------------- a zip (asked 2026-11-02: "cho nó tải zip đi")
//
// One file instead of a thousand: the page sends the zip in fixed-size chunks (several at once, each written at its
// place), the server keeps them on its own disk until all came, then opens the zip, keeps what a folder upload would
// keep (importKeep) and goes on as after a folder upload. A cut-off upload asks which chunks came and sends the rest.

/** Largest zip / chunk taken. */
const MAX_ZIP = 8 * 1024 * 1024 * 1024;
const MAX_CHUNK = 32 * 1024 * 1024;
/** Files unpacked and stored at once. */
const UNZIP_POOL = 8;

interface ZipState {
  total: number;
  chunk: number;
  have: number[];
}

const zipDir = () => path.join(os.tmpdir(), "ct-import-zip");
const zipFile = (id: string) => path.join(zipDir(), `${id}.zip`);
const zipMeta = (id: string) => path.join(zipDir(), `${id}.json`);
const chunksOf = (z: Pick<ZipState, "total" | "chunk">) => Math.ceil(z.total / z.chunk);

async function readZipState(id: string): Promise<ZipState | null> {
  try {
    const z = JSON.parse(await fsp.readFile(zipMeta(id), "utf8")) as ZipState;
    return Array.isArray(z.have) && z.total > 0 && z.chunk > 0 ? z : null;
  } catch {
    return null;
  }
}

/** Chunk writes of one set go one after the other (the state file is read and written by each). */
const zipLocks = new Map<string, Promise<unknown>>();
function zipLocked<T>(id: string, run: () => Promise<T>): Promise<T> {
  const next = (zipLocks.get(id) ?? Promise.resolve()).catch(() => undefined).then(run);
  zipLocks.set(id, next);
  void next.finally(() => zipLocks.get(id) === next && zipLocks.delete(id)).catch(() => undefined);
  return next;
}

async function dropZip(id: string): Promise<void> {
  await fsp.rm(zipFile(id), { force: true }).catch(() => undefined);
  await fsp.rm(zipMeta(id), { force: true }).catch(() => undefined);
}

/** GET char/projects/:id/import/zip — the chunks already here. */
async function zipStatus(p: CtCharProject): Promise<NextResponse> {
  return NextResponse.json((await readZipState(p.id)) ?? { total: 0, chunk: 0, have: [] });
}

/** POST char/projects/:id/import/zip?index=&chunk=&total= — one chunk (raw bytes) written at its place. */
async function zipChunk(req: Request, p: CtCharProject): Promise<NextResponse> {
  if (p.brief.imported?.status !== "uploading") return jsonError("Bộ này không còn chờ file", 409);
  const q = new URL(req.url).searchParams;
  const index = Number(q.get("index"));
  const chunk = Number(q.get("chunk"));
  const total = Number(q.get("total"));
  if (!Number.isInteger(total) || total <= 0 || total > MAX_ZIP) return jsonError("File zip tối đa 8 GB", 413);
  if (!Number.isInteger(chunk) || chunk < 1024 * 1024 || chunk > MAX_CHUNK) return jsonError("Cỡ mảnh không hợp lệ", 400);
  if (!Number.isInteger(index) || index < 0 || index >= chunksOf({ total, chunk })) return jsonError("Số mảnh không hợp lệ", 400);
  const data = Buffer.from(await req.arrayBuffer());
  const want = Math.min(chunk, total - index * chunk);
  if (data.length !== want) return jsonError(`Mảnh ${index} thiếu dữ liệu (${data.length}/${want} byte) — gửi lại`, 400);
  const state = await zipLocked(p.id, async () => {
    await fsp.mkdir(zipDir(), { recursive: true });
    let z = await readZipState(p.id);
    // Another file picked for this set: start over.
    if (!z || z.total !== total || z.chunk !== chunk) {
      await dropZip(p.id);
      z = { total, chunk, have: [] };
    }
    // "r+" writes anywhere in the file but needs it to exist.
    await fsp.writeFile(zipFile(p.id), "", { flag: "a" });
    const fh = await fsp.open(zipFile(p.id), "r+");
    try {
      await fh.write(data, 0, data.length, index * chunk);
    } finally {
      await fh.close();
    }
    if (!z.have.includes(index)) z.have.push(index);
    await fsp.writeFile(zipMeta(p.id), JSON.stringify(z));
    return z;
  });
  return NextResponse.json({ have: state.have.length, of: chunksOf(state) });
}

const unpacking = new Set<string>();

/** POST char/projects/:id/import/unzip — every chunk came: opened in the background, then read as a folder would be. */
async function unzipImport(s: CtSession, p: CtCharProject): Promise<NextResponse> {
  if (unpacking.has(p.id)) return jsonError("Đang giải nén — chờ xong", 409);
  const z = await readZipState(p.id);
  const of = z ? chunksOf(z) : 0;
  if (!z || z.have.length < of) return jsonError(`File zip chưa tải đủ (${z?.have.length ?? 0}/${of} mảnh)`, 409);
  const db = jobDb(s);
  await setImported(db, p.id, { status: "unpacking", done: 0, total: 0, files: 0, bytes: z.total, error: "", beat: new Date().toISOString() });
  unpacking.add(p.id);
  void unpackZip(s, p)
    .then(async (files) => {
      await dropZip(p.id);
      if (!files.length) throw new Error("File zip không có ảnh / ghi chú nào để import");
      await startFrom(s, p, files);
    })
    .catch(async (e: Error) => {
      console.warn("[ct] import unzip", p.id, e.message);
      await setImported(db, p.id, { status: "failed", error: `Giải nén lỗi: ${e.message}` }).catch(() => undefined);
    })
    .finally(() => unpacking.delete(p.id));
  return NextResponse.json({ status: "unpacking" });
}

/** The zip's kept files stored under the import folder, as a folder upload would have put them. */
async function unpackZip(s: CtSession, p: CtCharProject): Promise<CtCharImportFile[]> {
  const root = importRoot(p, s.user.id);
  const db = jobDb(s);
  const zip = await new Promise<yauzl.ZipFile>((ok, no) => yauzl.open(zipFile(p.id), { lazyEntries: true, autoClose: false }, (e, z) => (e || !z ? no(e ?? new Error("Không mở được zip")) : ok(z))));
  try {
    const entries: yauzl.Entry[] = [];
    await new Promise<void>((ok, no) => {
      zip.on("entry", (e: yauzl.Entry) => {
        if (!e.fileName.endsWith("/")) entries.push(e);
        zip.readEntry();
      });
      zip.on("end", () => ok());
      zip.on("error", no);
      zip.readEntry();
    });
    // A zip of one folder: paths inside that folder (as a picked folder's are).
    const names = entries.map((e) => e.fileName.replace(/\\/g, "/")).filter((n) => !/(^|\/)__MACOSX\//.test(n));
    const tops = new Set(names.map((n) => (n.includes("/") ? n.split("/")[0] : "")));
    const strip = tops.size === 1 && !tops.has("") ? `${[...tops][0]}/` : "";
    const picked = importKeep(
      entries.flatMap((entry) => {
        const name = entry.fileName.replace(/\\/g, "/");
        const clean = cleanPath(strip && name.startsWith(strip) ? name.slice(strip.length) : name);
        return clean && entry.uncompressedSize <= MAX_IMPORT_FILE ? [{ path: clean, entry }] : [];
      }),
    );
    await setImported(db, p.id, { total: picked.length, done: 0, beat: new Date().toISOString() });
    const out: CtCharImportFile[] = [];
    let next = 0;
    let done = 0;
    const worker = async () => {
      for (let i = next++; i < picked.length; i = next++) {
        const { path: rel, entry } = picked[i];
        const data = await new Promise<Buffer>((ok, no) =>
          zip.openReadStream(entry, (e, stream) => {
            if (e || !stream) return no(e ?? new Error(`Không đọc được ${rel}`));
            const parts: Buffer[] = [];
            stream.on("data", (b: Buffer) => parts.push(b));
            stream.on("end", () => ok(Buffer.concat(parts)));
            stream.on("error", no);
          }),
        );
        out.push({ path: rel, url: await ctUpload(`${root}/${rel}`, data, MIME[extOf(rel)] ?? "application/octet-stream"), size: data.length });
        if (++done % 25 === 0) await setImported(db, p.id, { done, beat: new Date().toISOString() });
      }
    };
    await Promise.all(Array.from({ length: UNZIP_POOL }, worker));
    await setImported(db, p.id, { done, beat: new Date().toISOString() });
    return out;
  } finally {
    zip.close();
  }
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
  const total = manifestPlacements(manifest);
  await setImported(db, projectId, { status: "building", format, manifestUrl, summary, problems, done: 0, total, error: "", beat: new Date().toISOString() });
  void buildImport(db, owner, projectId, manifest).catch(async (e: Error) => {
    console.warn("[ct] import build", projectId, e.message);
    await setImported(db, projectId, { status: "failed", error: e.message }).catch(() => undefined);
  });
}

/** POST char/projects/:id/import/rebuild — the product again from the saved manifest. */
async function rebuildImport(s: CtSession, p: CtCharProject): Promise<NextResponse> {
  if (building.has(p.id)) return jsonError("Đang dựng — chờ xong", 409);
  const imp = p.brief.imported!;
  const db = jobDb(s);
  // A known format is read again (a fixed reader applies); a manifest @flexiprint wrote is built as it is.
  if (imp.format === "teeinblue") {
    const files = await importFiles(p);
    const read = files.length ? readTeeinblue(p.name, files, await readTexts(importRoot(p, s.user.id), files)) : null;
    if (!read) return jsonError("Không đọc lại được folder đã tải", 409);
    await startBuild(db, p.user_id ?? s.user.id, p.id, read.manifest, "teeinblue", read.summary, read.problems);
    return NextResponse.json({ status: "building", summary: read.summary });
  }
  const url = imp.manifestUrl;
  const key = url ? keyOf(importRoot(p, s.user.id), url) : null;
  const b = key ? await readKey(key) : null;
  if (!b) return jsonError("Chưa có manifest — tải folder lên trước", 409);
  await startBuild(db, p.user_id ?? s.user.id, p.id, JSON.parse(b.toString("utf8")) as CtCharImportManifest, imp.format, imp.summary, []);
  return NextResponse.json({ status: "building" });
}

/** POST char/projects/:id/import/deploy — the set's product to Shopify again (a draft; after a price table was added…). */
async function redeployImport(s: CtSession, p: CtCharProject): Promise<NextResponse> {
  const productId = p.product_ids[0];
  if (!productId) return jsonError("Bộ chưa có sản phẩm", 409);
  if (p.brief.imported?.shopify?.status === "deploying") return jsonError("Đang đưa lên Shopify — chờ xong", 409);
  const db = jobDb(s);
  const userId = p.user_id ?? s.user.id;
  const { data: product } = await db.from(CT_TABLES.products).select("*").eq("id", productId).maybeSingle<CtProduct>();
  const ss = await serviceSession(db, userId);
  const info = savedDeployInfo(p, product ?? null);
  // In the background (the template + Shopify take up to a minute; the page polls while it is "deploying").
  await saveImportShopify(ss, p.id, { status: "deploying", error: "", ...info });
  void deployImported(ss, p.id, productId, info);
  return NextResponse.json({ status: "deploying" });
}

/** Runs one at a time per set. */
const building = new Map<string, Promise<string>>();

function buildImport(db: Db, userId: string, projectId: string, m: CtCharImportManifest): Promise<string> {
  const run = (building.get(projectId) ?? Promise.resolve(""))
    .catch(() => "")
    .then(() => buildNow(db, userId, projectId, m));
  building.set(projectId, run);
  // A heartbeat for as long as this process builds (2026-11-04: after the files, the design / mockups / Shopify steps
  // wrote no beat for minutes, so the page said "bị ngắt" while the server still answered "Đang dựng").
  const pulse = setInterval(() => {
    void setImported(db, projectId, { beat: new Date().toISOString() }).catch(() => undefined);
  }, BEAT_MS);
  void run.finally(() => {
    clearInterval(pulse);
    if (building.get(projectId) === run) building.delete(projectId);
  }).catch(() => undefined);
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
    const thumbOf = (look: string, png: Buffer): Promise<string> => {
      const hit = thumbs.get(look);
      if (hit) return hit;
      const made = (async () => {
        const square = await optionPicture(png);
        return square ? (await saveCharRaw(userId, p.id, "thumb", square, "image/webp")).url : "";
      })().catch(() => "");
      thumbs.set(look, made);
      return made;
    };

    // ---- cliparts: one per file of a group (its first the gốc), made as their files come ----
    type Made = { sub: CtAsset; byUrl: Map<string, CtAsset> };
    let order = 0;
    const fileOf = async (url: string, box?: CtCharImportBox): Promise<Buffer> => {
      const key = keyOf(root, url);
      let png = key ? await readKey(key) : null;
      const info = png ? readImageInfo(png) : null;
      if (!png || !info) {
        problems.push(`${url.split("/").slice(-3).join("/")}: không đọc được ảnh — để trống`);
        png = sheet;
      } else if (box) {
        // A small piece the source places itself: put where the manifest says, on a whole canvas.
        png = await placePiece(png, box, W, H);
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
    /** A layer that follows the one being made (the hat on the hair): drawn into its option pictures, above or under. */
    type Linked = { layer: CtCharImportLayer; above: boolean };
    /**
     * An option's picture with the files of the layers that follow it (2026-10-30: the hair under a hat is a sliver
     * around the hat — alone, the "Hat" choices showed four scraps of hair; with the hat drawn in they show the hat).
     */
    const optionThumb = async (url: string, png: Buffer, linked: Array<{ url: string; above: boolean; box?: CtCharImportBox }>): Promise<string> => {
      const parts = linked.filter((l) => l.url);
      if (!parts.length) return thumbOf(url.split("/").pop() ?? url, png);
      const files = await Promise.all(parts.map(async (l) => ({ ...l, png: await fileOf(l.url, l.box) })));
      const under = files.filter((f) => !f.above && f.png !== sheet).map((f) => ({ input: f.png }));
      const over = files.filter((f) => f.above && f.png !== sheet).map((f) => ({ input: f.png }));
      const base = under.length ? await sharp(under[0].input).composite([...under.slice(1), { input: png }, ...over]).png().toBuffer() : await sharp(png).composite(over).png().toBuffer();
      return thumbOf([url, ...parts.map((l) => l.url)].map((u) => u.split("/").pop() ?? u).join("+"), base);
    };
    /**
     * A group's cliparts — every group its own (a linked hat repeated in each hair colour group too). Written in one go:
     * ids made here, the files stored side by side, one insert for the group (a clipart at a time — insertClipart's
     * lookups — took ~40 min for 6915 files, 2026-10-29).
     */
    const groupOf = async (layer: CtCharImportLayer, gi: number, withThumbs: boolean, linked: Linked[] = []): Promise<Made> => {
      const g = layer.groups[gi];
      const gocId = crypto.randomUUID();
      const rows = await Promise.all(
        g.options.map(async (o, oi) => {
          const png = await fileOf(o.url, o.box ?? layer.box);
          const thumb =
            withThumbs && png !== sheet
              ? await optionThumb(
                  o.url,
                  png,
                  linked.map((l) => {
                    const lo = l.layer.groups[gi]?.options[oi];
                    return { url: lo?.url ?? "", above: l.above, box: lo?.box ?? l.layer.box };
                  }),
                )
              : "";
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
    // The folder's own fonts: a copy kept with the set (the uploaded folder goes after the build).
    const fontUrls = new Map<string, string>();
    for (const file of new Set(m.versions.flatMap((v) => v.variants.flatMap((x) => x.texts.map((t) => t.fontFile ?? "")))).values()) {
      if (!file) continue;
      const key = keyOf(root, file);
      const buf = key ? await readKey(key) : null;
      const ext = (file.split(".").pop() ?? "ttf").toLowerCase();
      if (!buf || !["ttf", "otf"].includes(ext)) {
        problems.push(`${file.split("/").pop()}: không đọc được font (chỉ nhận .ttf / .otf) — chữ dùng Poppins`);
        continue;
      }
      fontUrls.set(file, await ctUpload(`${charFolder(userId, p.id)}/font/${createHash("sha1").update(buf).digest("hex").slice(0, 16)}.${ext}`, buf, ext === "otf" ? "font/otf" : "font/ttf"));
    }
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
        const addText = (t: CtCharImportText) => regions.push(textRegion(product.id, mainId, t, xtag, parent, fonts, problems, t.fontFile ? fontUrls.get(t.fontFile) : undefined));
        for (const layer of x.layers) {
          const cfg = defaultRegionConfig("image");
          const choice = layer.kind === "choice";
          const at = x.layers.indexOf(layer);
          const linked: Linked[] = x.layers.filter((l) => layer.thumbWithFollowers && l.kind === "linked" && l.follows === layer.key).map((l) => ({ layer: l, above: x.layers.indexOf(l) > at }));
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
              image: { ...cfg.image, label: layer.label, display: "image", groupLabel: layer.groupLabel, groupDisplay: swatches ? "swatch" : "button", ...(linked.length ? { thumbFollowers: true } : {}) },
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
                const made = await groupOf(layer, gi, choice, linked);
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

    // A hand-off often keeps the same sales picture twice (at the top and in anh-ban-hang/): each goes once.
    const seen = new Set<string>();
    for (const [i, url] of m.mockupUrls.entries()) {
      const key = keyOf(root, url);
      // A sales picture that will not come is named, not a failed build (the product is already made).
      try {
        const png = key ? await readKey(key) : null;
        if (!png) continue;
        const hash = createHash("sha1").update(png).digest("hex");
        if (seen.has(hash)) continue;
        seen.add(hash);
        const jpeg = await sharp(png).flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer();
        const a = await upload(jpeg, "mockup", `mockup_${i + 1}`, "image/jpeg");
        const meta = await sharp(jpeg).metadata();
        await db.from(CT_TABLES.packImages).insert({ user_id: userId, name: `mockup:${product.id}`, source: "upload", status: "done", listed: false, url: a.url, storage_path: null, mime: "image/jpeg", width: meta.width ?? null, height: meta.height ?? null, description: `Ảnh bán hàng ${i + 1} (từ bộ import)`, prompt: "", refs: [], aspect: "", model: "" });
      } catch (e) {
        problems.push(`${url.split("/").pop()}: không lưu được ảnh bán hàng (${e instanceof Error ? e.message : String(e)}) — bỏ qua`);
      }
    }

    // ---- the set: its sample as the master, the product as its own ----
    let masterId = p.master_id;
    const sampleKey = m.sampleUrl ? keyOf(root, m.sampleUrl) : null;
    const sample = sampleKey ? await readKey(sampleKey).catch(() => null) : null;
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
    await dropLeftovers(db, p, userId).catch((e: Error) => console.warn("[ct] import leftovers", e.message));
    await deployImported(s, p.id, product.id, deployInfo(m));
    return product.id;
  } catch (e) {
    await dropProduct(s, product.id).catch(() => undefined);
    throw e;
  }
}

/** An option picture (thumb): the file's pixels cropped close, centred on a square with a margin, 240 px — null when empty. */
async function optionPicture(png: Buffer): Promise<Buffer | null> {
  const trimmed = await sharp(png).trim({ threshold: 0 }).toBuffer({ resolveWithObject: true }).catch(() => null);
  if (!trimmed) return null;
  const { width: w, height: h } = trimmed.info;
  const side = Math.max(w, h);
  const pad = Math.round(side * 0.06);
  // Padded to a square first, then scaled: sharp runs resize before extend in one pipeline, which cropped every
  // non-square piece to its middle (two eyes → the gap between them, 254×333; flowers lost their heads — 2026-11-02).
  const padded = await sharp(trimmed.data)
    .extend({ top: pad + Math.floor((side - h) / 2), bottom: pad + Math.ceil((side - h) / 2), left: pad + Math.floor((side - w) / 2), right: pad + Math.ceil((side - w) / 2), background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return sharp(padded).resize(240, 240).webp({ quality: 86, alphaQuality: 90 }).toBuffer();
}

/** One option picture set by hand (MCP char_import_rethumb): another picture, and / or a crop of the canvas. */
export interface CtImportThumbFix {
  /** The layer's customer label ("Eye color") or its region name. */
  layer: string;
  /** The option's name ("Blue") — its group's too when names repeat ("Skin 1 · Blonde"). */
  option: string;
  /** A picture of this app (a library clipart / file url) instead of the option's own file — whole canvas or not. */
  url?: string;
  /** Only this part of the picture, in its own px. */
  crop?: { x: number; y: number; w: number; h: number };
}

/** Hand-set option pictures as sent (MCP / route body): the ones naming a layer and an option. */
export function parseThumbFixes(raw: unknown): CtImportThumbFix[] {
  const num = (v: unknown) => Number(v) || 0;
  return (Array.isArray(raw) ? raw : [])
    .map((x): CtImportThumbFix => {
      const f = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
      const c = f.crop && typeof f.crop === "object" ? (f.crop as Record<string, unknown>) : null;
      const url = typeof f.url === "string" ? f.url.trim() : "";
      return {
        layer: typeof f.layer === "string" ? f.layer.trim() : "",
        option: typeof f.option === "string" ? f.option.trim() : "",
        ...(url ? { url } : {}),
        ...(c ? { crop: { x: num(c.x), y: num(c.y), w: num(c.w), h: num(c.h) } } : {}),
      };
    })
    .filter((f) => f.layer && f.option);
}

/**
 * The option pictures of an imported set's product made again from its library clipart (asked 2026-11-02: thumbs
 * were cut wrong by the resize-before-extend slip, and the folder is gone after the build). Every option of a choice
 * layer gets a fresh picture — with its followers drawn in where the build did that (config.image.thumbFollowers;
 * older builds: the Teeinblue "… — Hat" layers) — `fixes` set some by hand. Then the products are published again
 * (the storefront reads the published template). Old picture files stay: products the set was dragged into may still
 * show them until they are published again.
 */
export async function rethumbImport(s: CtSession, p: CtCharProject, fixes: CtImportThumbFix[]): Promise<{ made: number; empty: string[]; unmatched: string[]; published: string[] }> {
  const db = s.supabase;
  const productId = p.product_ids[0];
  if (!productId) throw new Error("The set has no product yet — char_import_build first");
  const userId = p.user_id ?? s.user.id;
  const { data: regions } = await db.from(CT_TABLES.regions).select("*").eq("product_id", productId).returns<CtRegion[]>();
  const images = (regions ?? []).filter((r) => r.kind === "image");
  // Ids go in the request url: a few dozen at a time (n00-POD-02 has 465 layers — one request was too long and came
  // back empty).
  const items: CtRegionItem[] = [];
  for (let i = 0; i < images.length; i += 60) {
    const { data, error } = await db.from(CT_TABLES.items).select("*").in("region_id", images.slice(i, i + 60).map((r) => r.id)).returns<CtRegionItem[]>();
    if (error) throw new Error(error.message);
    items.push(...(data ?? []));
  }
  const subIds = [...new Set(items.map((i) => i.asset_id))];
  const assets: CtAsset[] = [];
  for (let i = 0; i < subIds.length; i += 60) {
    const ids = subIds.slice(i, i + 60);
    const { data: subs, error } = await db.from(CT_TABLES.assets).select("*").in("id", ids).returns<CtAsset[]>();
    const { data: kids, error: kidsError } = await db.from(CT_TABLES.assets).select("*").in("parent_id", ids).returns<CtAsset[]>();
    if (error || kidsError) throw new Error((error ?? kidsError)!.message);
    assets.push(...(subs ?? []), ...(kids ?? []));
  }
  const byId = new Map(assets.map((a) => [a.id, a]));
  /** A layer's groups, each its options in order (the sub, then its đa sắc). */
  const groupsOf = (r: CtRegion): CtAsset[][] =>
    items
      .filter((i) => i.region_id === r.id)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((i) => {
        const sub = byId.get(i.asset_id);
        if (!sub) return [];
        return [sub, ...assets.filter((a) => a.parent_id === sub.id).sort((a, b) => a.sort_order - b.sort_order)];
      });
  // Files read as needed, never kept (n00-POD-02's are ~430 MB).
  const fileOf = readKey;
  const publicRoot = r2PublicUrl("");
  const keyOfUrl = (url: string) => (url.startsWith(publicRoot) ? url.slice(publicRoot.length).split("/").map(decodeURIComponent).join("/") : null);
  const optionName = (a: CtAsset) => a.name.split(" · ").slice(1).join(" · ");
  const lower = (t: string) => t.trim().toLowerCase();
  const used = new Set<number>();
  const fixFor = (r: CtRegion, a: CtAsset): CtImportThumbFix | undefined => {
    const i = fixes.findIndex((f) => {
      const layer = lower(f.layer);
      if (layer !== lower(r.config.image.label) && layer !== lower(r.name)) return false;
      const opt = lower(f.option);
      const name = lower(optionName(a));
      return opt === name || name.endsWith(` · ${opt}`) || opt === lower(a.name);
    });
    if (i >= 0) used.add(i);
    return i >= 0 ? fixes[i] : undefined;
  };

  let made = 0;
  const empty: string[] = [];
  /** One option's picture. */
  const remake = async (label: string, followers: Array<{ groups: CtAsset[][]; above: boolean }>, gi: number, oi: number, a: CtAsset, fix: CtImportThumbFix | undefined) => {
    const key = fix?.url ? keyOfUrl(fix.url) : a.storage_path;
    if (fix?.url && !key) throw new Error(`${label} · ${optionName(a)}: url must be a picture of this app (${publicRoot}…)`);
    let png = key ? await fileOf(key) : null;
    if (png && !fix?.url && followers.length) {
      const parts = await Promise.all(
        followers.map(async (f) => {
          const x = f.groups[gi]?.[oi];
          return { above: f.above, png: x?.storage_path ? await fileOf(x.storage_path) : null };
        }),
      );
      const under = parts.filter((x) => !x.above && x.png).map((x) => ({ input: x.png! }));
      const over = parts.filter((x) => x.above && x.png).map((x) => ({ input: x.png! }));
      if (under.length || over.length) png = await sharp(under.length ? under[0].input : png).composite([...under.slice(1), ...(under.length ? [{ input: png }] : []), ...over]).png().toBuffer();
    }
    if (png && fix?.crop) {
      const c = fix.crop;
      png = await sharp(png).extract({ left: Math.max(0, Math.round(c.x)), top: Math.max(0, Math.round(c.y)), width: Math.max(1, Math.round(c.w)), height: Math.max(1, Math.round(c.h)) }).png().toBuffer().catch(() => {
        throw new Error(`${label} · ${optionName(a)}: crop is outside the picture`);
      });
    }
    const square = png ? await optionPicture(png) : null;
    if (!square) {
      empty.push(`${label} · ${optionName(a)}`);
      return;
    }
    const thumb = (await saveCharRaw(userId, p.id, "thumb", square, "image/webp")).url;
    await db.from(CT_TABLES.assets).update({ meta: { ...(a.meta ?? {}), thumb } }).eq("id", a.id);
    made++;
  };
  const jobs: Array<() => Promise<void>> = [];
  for (const r of images) {
    const groups = groupsOf(r);
    const isChoice = !r.config.image.follows && groups.some((g) => g.some((a) => a.meta?.thumb));
    const fixed = groups.flat().filter((a) => fixFor(r, a));
    if (!isChoice && !fixed.length) continue;
    const label = r.config.image.label || r.name;
    const withFollowers = r.config.image.thumbFollowers === true || /— Hat$/.test(label);
    const followers = withFollowers
      ? images.filter((f) => f.config.image.follows === r.id).map((f) => ({ groups: groupsOf(f), above: f.sort_order > r.sort_order }))
      : [];
    for (const [gi, g] of groups.entries()) {
      for (const [oi, a] of g.entries()) {
        const fix = fixFor(r, a);
        if (!isChoice && !fix) continue;
        jobs.push(() => remake(label, followers, gi, oi, a, fix));
      }
    }
  }
  // A few at once (one at a time took ~70 min for n00-POD-02's 4416 options).
  let next = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let i = next++; i < jobs.length; i = next++) await jobs[i]();
    }),
  );
  // The storefront shows the published template: every product of the set that was published takes the new pictures.
  const published: string[] = [];
  const { data: products } = await db.from(CT_TABLES.products).select("id, published_version").in("id", p.product_ids).returns<Array<{ id: string; published_version: number | null }>>();
  for (const x of products ?? []) {
    if (!x.published_version) continue;
    const res = await h.publish(s, x.id, siteUrl());
    if (res.ok) published.push(x.id);
  }
  return { made, empty, unmatched: fixes.filter((_, i) => !used.has(i)).map((f) => `${f.layer} · ${f.option}`), published };
}

/**
 * Once the product is built, what only served the build goes (asked 2026-10-30: "chỉ hướng tới việc store lên được
 * sản phẩm, sau đó các cái không cần bỏ hết"): the uploaded folder (every file is now a library clipart — n00-POD-02
 * kept 527 MB of it) and option pictures no clipart points at (earlier builds'). A rebuild needs the folder uploaded
 * again.
 */
async function dropLeftovers(db: Db, p: CtCharProject, userId: string): Promise<void> {
  const folder = charFolder(p.user_id ?? userId, p.id);
  await ctRemove(await r2Keys(`${folder}/import`));
  await setImported(db, p.id, { indexUrl: "", manifestUrl: "" });
  const thumbs = await r2Keys(`${folder}/thumb`);
  if (!thumbs.length) return;
  const used = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from(CT_TABLES.assets)
      .select("meta")
      .like("meta->>thumb", `%/char/${p.id}/thumb/%`)
      .order("id")
      .range(from, from + 999)
      .returns<Array<{ meta: { thumb?: string } }>>();
    if (error) throw new Error(error.message);
    for (const a of data ?? []) used.add(a.meta.thumb?.split("/").pop() ?? "");
    if ((data ?? []).length < 1000) break;
  }
  await ctRemove(thumbs.filter((k) => !used.has(k.split("/").pop() ?? "")));
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
export function textRegion(productId: string, mainId: string, t: CtCharImportText, tag: string, parent: CtRegion["config"]["parent"], fonts: Set<string>, problems: string[], fontUrl?: string): CtRegion {
  const cfg = defaultRegionConfig("text");
  // The folder's own font file: its family as named, loaded from our copy.
  const family = fontUrl ? t.font : fonts.has(t.font) ? t.font : "Poppins";
  if (family !== t.font) problems.push(`Font "${t.font}" chưa có trong danh sách font — tạm dùng Poppins`);
  const weights = fontUrl ? [t.weight || 400] : (CT_FONTS.find((f) => f.family === family)?.weights ?? [400]);
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
        ...(fontUrl ? { fontUrl } : {}),
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
  if (sub === "files" && req.method === "GET") return uploadedFiles(s, p);
  if (sub === "zip" && req.method === "GET") return zipStatus(p);
  if (req.method !== "POST") return jsonError("Not found", 404);
  if (sub === "files") return uploadFiles(s, p, await req.formData());
  if (sub === "zip") return zipChunk(req, p);
  if (sub === "unzip") return unzipImport(s, p);
  if (sub === "start") return startImport(s, p, await req.json().catch(() => null));
  if (sub === "rebuild") return rebuildImport(s, p);
  if (sub === "deploy") return redeployImport(s, p);
  if (sub === "rethumb") return NextResponse.json(await rethumbImport(s, p, parseThumbFixes(((await req.json().catch(() => null)) as { fixes?: unknown } | null)?.fixes)));
  return jsonError("Not found", 404);
}

// ---------------------------------------------------------------- checks before a build (asked 2026-11-04)
//
// A folder of another layout is put together by @flexiprint from everything in it (pieces, the finished prints, the
// previews, the fonts): it measures where pieces sit (char_import_locate), where the names are (char_import_diff),
// then draws one version of its manifest beside the folder's own print (char_import_preview) — before the build,
// which deletes the folder.

export interface CtImportPreviewOptions {
  /** Version by name or 1-based number (default the first); variant likewise. */
  version: string;
  variant: string;
  /** Layer key → option name the customer would pick (default: each layer's default, else its first). */
  choices: Record<string, string>;
  /** A picture of the folder to set beside it (the finished print), and the canvas inside it (x, y, w, h). */
  compare: string;
  region: number[] | null;
}

/** The url of a file of the upload (by path or url). */
export async function importFileUrl(p: CtCharProject, pathOrUrl: string): Promise<string | null> {
  const files = await importFiles(p);
  return files.find((f) => f.path === pathOrUrl || f.url === pathOrUrl)?.url ?? null;
}

/**
 * One version of a manifest drawn as the build would put it together — the default (or chosen) option of every layer,
 * the texts with their samples — on its canvas; beside the folder's own picture when `compare` is given, with how far
 * apart they are (mean colour difference, 0–255, where either has ink).
 */
export async function previewImport(p: CtCharProject, raw: unknown, o: CtImportPreviewOptions): Promise<{ url: string; version: string; variant: string; problems: string[]; difference: number | null }> {
  const files = await importFiles(p);
  if (!files.length) throw new Error("The set has no uploaded files (the folder is gone after a build — upload it again)");
  const { manifest: m, problems } = parseManifest(raw, files);
  const W = m.canvas.width;
  const H = m.canvas.height;
  if (W < 8 || H < 8) throw new Error("manifest.canvas width / height missing");
  const root = importRoot(p, "");
  const pickOf = <T extends { name: string }>(list: T[], want: string): T | undefined => (want ? (list.find((x) => x.name === want) ?? list[Number(want) - 1]) : list[0]);
  const v = pickOf(m.versions, o.version);
  if (!v) throw new Error(`No version "${o.version}" (${m.versions.map((x) => x.name).join(", ")})`);
  const x = pickOf(v.variants, o.variant);
  if (!x) throw new Error(`No variant "${o.variant}" in version ${v.name}`);

  const read = async (url: string, box?: CtCharImportBox): Promise<Buffer | null> => {
    const key = keyOf(root, url);
    const png = key ? await readKey(key) : null;
    const info = png ? readImageInfo(png) : null;
    if (!png || !info) {
      problems.push(`${url.split("/").pop()}: không đọc được ảnh`);
      return null;
    }
    if (box) return placePiece(png, box, W, H);
    if (info.width !== W || info.height !== H) {
      problems.push(`${url.split("/").pop()}: ${info.width}×${info.height}, khung ${W}×${H} — cần box (char_import_locate) hoặc file đủ khung`);
      return null;
    }
    return png;
  };

  // Which group / option each layer shows: the pick, else the default, else the first; a linked layer the leader's.
  const at = new Map<string, { gi: number; oi: number }>();
  for (const l of x.layers) {
    if (l.kind === "linked" && at.has(l.follows)) {
      at.set(l.key, at.get(l.follows)!);
      continue;
    }
    const want = o.choices[l.key] ?? o.choices[l.label];
    let pos = { gi: 0, oi: 0 };
    l.groups.forEach((g, gi) =>
      g.options.forEach((op, oi) => {
        if (want ? op.name === want || `${g.name} · ${op.name}` === want : op.default) pos = { gi, oi };
      }),
    );
    if (want && !l.groups.some((g) => g.options.some((op) => op.name === want || `${g.name} · ${op.name}` === want))) problems.push(`${l.key}: không có lựa chọn "${want}"`);
    at.set(l.key, pos);
  }

  const fonts = new Set(CT_FONTS.map((f) => f.family));
  const overlays: OverlayOptions[] = [];
  const textOf = async (t: CtCharImportText) => {
    const r = textRegion("preview", "preview", t, "", undefined, fonts, problems, t.fontFile || undefined);
    const font = await loadFont(r.config.text.fontFamily, r.config.text.fontWeight, r.config.text.fontUrl);
    if (!font) {
      problems.push(`${t.key}: không nạp được font ${t.font}`);
      return;
    }
    const s = r.shape.type === "rect" ? r.shape : { x: 0, y: 0, w: W, h: H };
    const svg = textSvg(font, t.sample || t.label, r.config.text, { x: s.x, y: s.y, w: s.w, h: s.h });
    if (svg) overlays.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${svg}</svg>`), left: 0, top: 0 });
  };
  const keys = new Set(x.layers.map((l) => l.key));
  for (const l of x.layers) {
    const pos = at.get(l.key)!;
    const op = l.groups[pos.gi]?.options[pos.oi];
    const png = op?.url ? await read(op.url, op.box ?? l.box) : null;
    if (png) overlays.push({ input: png, left: 0, top: 0 });
    for (const t of x.texts.filter((t) => t.above === l.key)) await textOf(t);
  }
  for (const t of x.texts.filter((t) => !t.above || !keys.has(t.above))) await textOf(t);
  const drawn = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(overlays).png().toBuffer();

  let out = drawn;
  let difference: number | null = null;
  if (o.compare) {
    const url = files.find((f) => f.path === o.compare || f.url === o.compare)?.url;
    const key = url ? keyOf(root, url) : null;
    const buf = key ? await readKey(key) : null;
    if (!buf) problems.push(`compare: không có file "${o.compare}"`);
    else {
      const [rx, ry, rw, rh] = o.region && o.region.length === 4 ? o.region.map((n) => Math.round(n)) : [0, 0, 0, 0];
      let ref = sharp(buf).ensureAlpha();
      if (rw > 0 && rh > 0) ref = ref.extract({ left: rx, top: ry, width: rw, height: rh });
      const refPng = await ref.resize(W, H, { fit: "fill" }).png().toBuffer();
      // How far apart, on the same grey (a print saved without transparency has its own background — compared as is).
      const flat = async (b: Buffer) => sharp(b).flatten({ background: "#e8e8e8" }).raw().toBuffer();
      const [a, b] = await Promise.all([flat(drawn), flat(refPng)]);
      let sum = 0;
      let n = 0;
      for (let i = 0; i < a.length; i += 3) {
        const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
        const ink = Math.max(Math.abs(a[i] - 232), Math.abs(b[i] - 232), Math.abs(a[i + 1] - 232), Math.abs(b[i + 1] - 232)) > 12;
        if (ink) {
          sum += d;
          n++;
        }
      }
      difference = n ? Math.round((sum / n) * 10) / 10 : 0;
      // Side by side on a light grey: what the build makes | the folder's own.
      const gap = 16;
      out = await sharp({ create: { width: W * 2 + gap, height: H, channels: 4, background: "#e8e8e8" } })
        .composite([
          { input: drawn, left: 0, top: 0 },
          { input: refPng, left: W + gap, top: 0 },
        ])
        .png()
        .toBuffer();
    }
  }
  const saved = await ctUpload(`${root}/_check/${crypto.randomUUID()}.png`, out, "image/png");
  return { url: saved, version: v.name, variant: x.name, problems: [...new Set(problems)], difference };
}
