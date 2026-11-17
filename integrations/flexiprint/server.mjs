#!/usr/bin/env node
// flexiprint — the ONE MCP (stdio) for FlexiPrint on the editor's own machine (asked 2026-11-17: "gom API thành 1 MCP
// tổng để mọi người làm sản phẩm từ a đến z"; replaces integrations/flexiprint-import). Two kinds of tools in one list:
//   - local  (need this machine's disk): flexiprint_import / _status (a bộ folder → set + product → Shopify draft),
//            flexiprint_upload_image (a picture → url), flexiprint_save_files (urls → a folder);
//   - server (every tool of flexiprint-mcp on flexi2, POST /api/customize-tool/mcp): sent on as this user — the
//            server checks rights (own products / sets, admins all; server/mcp/server.ts).
//
// Env (see README.md): FLEXI_EMAIL, FLEXI_PASSWORD (a flexi2 account), FLEXI_URL, FLEXI_ANON_KEY.
// No dependencies: Node 20+.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ENV_FILE = path.join(path.dirname(new URL(import.meta.url).pathname), ".env");
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const BASE = (process.env.FLEXI_URL || "https://flexi2.next.lc").replace(/\/$/, "");
const API = `${BASE}/api/customize-tool`;

// The same choice of files as the web page's Import bộ.
const JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX)(\/|$)|(^|\/)\._/i;
const KEEP = /\.(png|jpe?g|webp|json|csv|md|txt|ttf|otf)$/i;
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", json: "application/json", csv: "text/csv", md: "text/markdown", txt: "text/plain", ttf: "font/ttf", otf: "font/otf" };
/** Folders of a Teeinblue hand-off that only repeat its case layers (lib/char-import.ts IMPORT_COPIES). */
const COPIES = /(^|\/)(clipart-cat|file-in|preview)\//i;
const BATCH_BYTES = 8 * 1024 * 1024;
/** A zip goes in chunks of this size, like the web page (lib/import-queue.ts ZIP_CHUNK). */
const ZIP_CHUNK = 4 * 1024 * 1024;
const BATCH_FILES = 30;
const PARALLEL = 6;
/** One tool call waits this long for the build + Shopify, then hands back the set id for flexiprint_import_status. */
const WAIT_MS = 12 * 60 * 1000;

const log = (...a) => process.stderr.write(`[flexiprint] ${a.join(" ")}\n`);
const mb = (n) => `${(n / 1024 / 1024).toFixed(n > 100 * 1024 * 1024 ? 0 : 1)} MB`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- flexi2
let session = null;
async function token() {
  if (session && session.until > Date.now()) return session.token;
  const { FLEXI_EMAIL: email, FLEXI_PASSWORD: password, FLEXI_ANON_KEY: anon } = process.env;
  if (!email || !password || !anon) throw new Error(`Thiếu FLEXI_EMAIL / FLEXI_PASSWORD / FLEXI_ANON_KEY (file ${ENV_FILE})`);
  const res = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: anon, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`Đăng nhập flexi2 lỗi: ${body.error_description || body.msg || `HTTP ${res.status}`}`);
  session = { token: body.access_token, until: Date.now() + (Math.max(120, body.expires_in ?? 3600) - 60) * 1000 };
  return session.token;
}

async function call(p, init = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${API}/${p}`, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(180_000) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) session = null;
        if (res.status >= 500 && attempt < 3) throw new Error(body.error || `HTTP ${res.status}`);
        const e = new Error(body.error || `HTTP ${res.status}`);
        e.final = true;
        throw e;
      }
      return body;
    } catch (e) {
      // A dropped request over a slow line is sent again; an answer from the server is final.
      if (e.final || attempt >= 3) throw e;
      await sleep(2000 * attempt);
    }
  }
}
const postJson = (p, body) => call(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// ---------------------------------------------------------------- folder
function walk(root) {
  const out = [];
  const go = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) go(full);
      else if (d.isFile()) out.push({ full, path: path.relative(root, full).split(path.sep).join("/"), size: fs.statSync(full).size });
    }
  };
  go(root);
  return out;
}

/** The web page's importKeep (lib/char-import.ts): a Teeinblue hand-off leaves home only its copies of the case layers. */
function selectFiles(all) {
  const files = all.filter((f) => !JUNK.test(f.path) && KEEP.test(f.path));
  const cases = files.filter((f) => /(^|\/)teeinblue\.json$/i.test(f.path)).map((f) => f.path.split("/").slice(0, -1).join("/"));
  if (!cases.length) return files;
  return files.filter((f) => cases.some((d) => f.path.startsWith(`${d}/`)) || /\.(json|csv|md|txt)$/i.test(f.path) || !COPIES.test(f.path));
}

/** A folder or a .zip named or found: an absolute path, ~/…, or a name under ~/Downloads / ~/Desktop / the cwd. */
function findSource(raw) {
  const p = String(raw ?? "").trim().replace(/^~(?=$|\/)/, os.homedir());
  const bases = path.isAbsolute(p) ? [p] : [path.resolve(p), path.join(os.homedir(), "Downloads", p), path.join(os.homedir(), "Desktop", p), path.join(os.homedir(), "Downloads", "linh-download-output", p)];
  const tries = bases.flatMap((t) => (/\.zip$/i.test(t) ? [t] : [t, `${t}.zip`]));
  for (const t of tries) {
    if (!fs.existsSync(t)) continue;
    const st = fs.statSync(t);
    if (st.isDirectory()) return { root: t, zip: false };
    if (st.isFile() && /\.zip$/i.test(t)) return { root: t, zip: true, size: st.size };
  }
  throw new Error(`Không thấy folder / file .zip "${raw}" (đã tìm: ${tries.join(", ")})`);
}

// ---------------------------------------------------------------- import
const runs = new Map();

async function upload(setId, files, onBytes) {
  const batches = [];
  let cur = [];
  let size = 0;
  for (const f of files) {
    if (cur.length && (cur.length >= BATCH_FILES || size + f.size > BATCH_BYTES)) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(f);
    size += f.size;
  }
  if (cur.length) batches.push(cur);
  const uploaded = [];
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < batches.length; i = next++) {
      const form = new FormData();
      for (const f of batches[i]) {
        form.append("file", new Blob([fs.readFileSync(f.full)], { type: MIME[f.path.split(".").pop().toLowerCase()] ?? "application/octet-stream" }), path.basename(f.path));
        form.append("path", f.path);
      }
      const r = await call(`char/projects/${setId}/import/files`, { method: "POST", body: form });
      uploaded.push(...r.files);
      onBytes(batches[i].reduce((n, f) => n + f.size, 0));
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  return uploaded;
}

/** A zip in fixed chunks (several at once); chunks the server already has are not sent again. */
async function uploadZip(setId, file, size, onBytes) {
  const state = await call(`char/projects/${setId}/import/zip`);
  const have = new Set(state.total === size && state.chunk === ZIP_CHUNK ? state.have : []);
  const count = Math.ceil(size / ZIP_CHUNK);
  const todo = Array.from({ length: count }, (_, i) => i).filter((i) => !have.has(i));
  const fd = fs.openSync(file, "r");
  try {
    let next = 0;
    const worker = async () => {
      for (let k = next++; k < todo.length; k = next++) {
        const i = todo[k];
        const buf = Buffer.alloc(Math.min(ZIP_CHUNK, size - i * ZIP_CHUNK));
        fs.readSync(fd, buf, 0, buf.length, i * ZIP_CHUNK);
        await call(`char/projects/${setId}/import/zip?index=${i}&chunk=${ZIP_CHUNK}&total=${size}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: buf });
        onBytes(buf.length);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
  } finally {
    fs.closeSync(fd);
  }
}

/** Where the set is: build, Shopify, links. */
async function status(setId) {
  const { project } = await call(`char/projects/${setId}`);
  const imp = project.brief?.imported ?? {};
  const shop = imp.shopify ?? null;
  const building = ["uploading", "unpacking", "analyzing", "agent", "building"].includes(imp.status);
  return {
    set_id: setId,
    name: project.name,
    page: `${BASE}/v2/${setId}`,
    build: imp.status,
    progress: imp.total ? `${imp.done}/${imp.total} file layer` : undefined,
    summary: imp.summary,
    problems: imp.problems?.length ? imp.problems : undefined,
    error: imp.error || undefined,
    shopify: shop ? { status: shop.status, preview: shop.previewUrl || undefined, admin: shop.adminUrl || undefined, price_table: shop.priceTable || undefined, note: shop.error || undefined } : null,
    finished: !building && (imp.status !== "done" || !!shop && shop.status !== "deploying"),
  };
}

async function importFolder({ folder, name }) {
  const src = findSource(folder);
  const { root } = src;
  const all = src.zip ? [] : walk(root);
  const files = src.zip ? [] : selectFiles(all);
  if (!src.zip && !files.length) throw new Error(`Folder ${root} không có ảnh / ghi chú nào để import`);
  const bytes = src.zip ? src.size : files.reduce((n, f) => n + f.size, 0);
  const big = files.find((f) => f.size > 60 * 1024 * 1024);
  if (big) throw new Error(`${big.path} quá lớn (tối đa 60 MB một file)`);
  const setName = String(name || path.basename(root).replace(/\.zip$/i, "")).slice(0, 200);
  const { project } = await postJson("char/projects/import", { name: setName });
  const run = { setId: project.id, sent: 0, bytes, files: files.length, phase: "uploading", started: Date.now() };
  runs.set(project.id, run);
  const onBytes = (n) => {
    run.sent += n;
  };
  if (src.zip) {
    log(`${setName}: zip ${mb(bytes)} → ${project.id}`);
    await uploadZip(project.id, root, bytes, onBytes);
    run.phase = "started";
    // The server unpacks it, keeps what a folder upload would, then reads it as a folder.
    await postJson(`char/projects/${project.id}/import/unzip`, {});
  } else {
    log(`${setName}: ${files.length} file (${mb(bytes)}) → ${project.id}`);
    const uploaded = await upload(project.id, files, onBytes);
    run.phase = "started";
    await postJson(`char/projects/${project.id}/import/start`, { files: uploaded });
  }
  const until = Date.now() + WAIT_MS;
  let st = await status(project.id);
  while (!st.finished && Date.now() < until) {
    await sleep(10_000);
    st = await status(project.id).catch(() => st);
  }
  run.phase = "done";
  return {
    folder: root,
    sent: src.zip ? `zip ${mb(bytes)} (server giải nén)` : `${files.length} file (${mb(bytes)})${all.length - files.length ? `, bỏ ${all.length - files.length} file không cần` : ""}`,
    ...st,
    next: st.finished
      ? st.shopify?.preview
        ? "Đưa link preview (Shopify, theme nháp) và link page cho người dùng."
        : "Báo lỗi / việc còn thiếu cho người dùng (vd. chưa có bảng giá cho chất liệu)."
      : "Chưa xong — gọi flexiprint_import_status với set_id sau ít phút.",
  };
}

// ---------------------------------------------------------------- local tools (need this machine's disk)
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

/** A picture on this machine → a public url on flexi2 (the tools on the server take urls). */
async function uploadImage({ path: raw }) {
  const p = String(raw ?? "").trim().replace(/^~(?=$|\/|\\)/, os.homedir());
  if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error(`Không thấy file ảnh "${raw}"`);
  if (!IMAGE_EXT.test(p)) throw new Error("Chỉ nhận ảnh .png / .jpg / .webp");
  const size = fs.statSync(p).size;
  if (size > 25 * 1024 * 1024) throw new Error("Ảnh quá lớn (tối đa 25 MB)");
  const ext = path.extname(p).slice(1).toLowerCase();
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(p)], { type: MIME[ext] }), path.basename(p));
  const out = await call("library/packs/images", { method: "POST", body: form });
  return { url: out.url, width: out.width, height: out.height, next: "Dùng url này cho tool cần ảnh (char_add_reference url, add_template_blank url, …)." };
}

/** Files at public urls (mockups, print files…) → a folder on this machine. */
async function saveFiles({ urls, folder }) {
  const list = (Array.isArray(urls) ? urls : [urls]).map((u) => String(u ?? "").trim()).filter((u) => /^https?:\/\//.test(u));
  if (!list.length) throw new Error("urls: cần ít nhất một link http(s)");
  const dir = String(folder || path.join(os.homedir(), "Downloads", "flexiprint")).replace(/^~(?=$|\/|\\)/, os.homedir());
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  for (const [i, u] of list.entries()) {
    const res = await fetch(u, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) {
      saved.push({ url: u, error: `HTTP ${res.status}` });
      continue;
    }
    let name = decodeURIComponent(new URL(u).pathname.split("/").pop() || `file-${i + 1}`).replace(/[^\w.\-]+/g, "_");
    if (!path.extname(name)) name += { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" }[res.headers.get("content-type") ?? ""] ?? "";
    let file = path.join(dir, name);
    for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${path.basename(name, path.extname(name))}-${n}${path.extname(name)}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    saved.push({ url: u, file });
  }
  return { folder: dir, saved };
}

const LOCAL_TOOLS = [
  {
    name: "flexiprint_import",
    description:
      "Import a finished bộ clipart folder — or a .zip of one — on THIS machine (a Teeinblue hand-off like n00-POD-02, or any folder of layer files + mockups + notes) into FlexiPrint (flexi2). It uploads the folder, the server builds the bộ nhân vật + product and puts it on Shopify as a DRAFT. Waits up to ~12 min → page (the set on flexi2), shopify.preview (draft theme link), problems. Not finished → flexiprint_import_status {set_id}.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "The folder or .zip: /Users/…/n00-POD-02, ~/Downloads/n00-POD-02.zip, or just n00-POD-02." },
        name: { type: "string", description: "Name of the set (default: the folder name)." },
      },
      required: ["folder"],
    },
    run: importFolder,
  },
  {
    name: "flexiprint_import_status",
    description: "Where an import is: build progress, problems, the Shopify draft (preview / admin link, or why it did not go up). set_id from flexiprint_import.",
    inputSchema: { type: "object", properties: { set_id: { type: "string" } }, required: ["set_id"] },
    run: async (args) => {
      const id = String(args?.set_id ?? "");
      const run = runs.get(id);
      const st = await status(id);
      return run && run.phase === "uploading" ? { ...st, upload: `${mb(run.sent)} / ${mb(run.bytes)}` } : st;
    },
  },
  {
    name: "flexiprint_upload_image",
    description: "A picture on THIS machine (png / jpg / webp, ≤ 25 MB) → a public url on flexi2, for the tools that take an image url (char_add_reference, add_template_blank…).",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Full path, or ~/…" } }, required: ["path"] },
    run: uploadImage,
  },
  {
    name: "flexiprint_save_files",
    description: "Download files from their urls (mockups, print files, renders) into a folder on THIS machine. Default folder ~/Downloads/flexiprint.",
    inputSchema: {
      type: "object",
      properties: { urls: { type: "array", items: { type: "string" }, description: "http(s) links." }, folder: { type: "string", description: "Target folder (default ~/Downloads/flexiprint)." } },
      required: ["urls"],
    },
    run: saveFiles,
  },
];

// ---------------------------------------------------------------- server tools (flexiprint-mcp on flexi2, as this user)
let rpcId = 0;
async function remote(method, params) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      signal: AbortSignal.timeout(15 * 60_000),
    }).catch((e) => ({ ok: false, status: 0, error: e }));
    if (res.status === 401 && attempt < 2) {
      session = null;
      continue;
    }
    if (!res.ok) {
      if (attempt < 3 && (res.status === 0 || res.status >= 500)) {
        await sleep(2000 * attempt);
        continue;
      }
      throw new Error(`flexi2 MCP: ${res.error?.message || `HTTP ${res.status}`}`);
    }
    const body = await res.json();
    if (body.error) throw new Error(body.error.message);
    return body.result;
  }
}

let serverTools = null;
let serverInstructions = "";
async function loadServer() {
  if (serverTools) return serverTools;
  const init = await remote("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "flexiprint-local", version: VERSION } });
  serverInstructions = init?.instructions ?? "";
  const list = await remote("tools/list", {});
  serverTools = list?.tools ?? [];
  return serverTools;
}

// ---------------------------------------------------------------- MCP (stdio, newline-delimited JSON-RPC)
const VERSION = "2.0.0";
const INSTRUCTIONS =
  "FlexiPrint (flexi2) từ máy này: import folder bộ, ảnh từ máy lên, lưu file về máy (flexiprint_*), cùng mọi tool của server flexi2 (thư viện, artwork, sản phẩm, mockup, deploy Shopify, bộ nhân vật) với quyền tài khoản của bạn. Đọc read_guide trước. Làm sản phẩm: list_base_products → create_artwork_product / set_artwork_layers → make_product_from_artwork → make_product_mockups → wait_product_mockups → check_deploy → deploy_product (bỏ task_id).";

const local = (name) => LOCAL_TOOLS.find((t) => t.name === name);

async function listTools() {
  const mine = LOCAL_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  try {
    return [...mine, ...(await loadServer()).filter((t) => !local(t.name))];
  } catch (e) {
    log("server tools", e instanceof Error ? e.message : String(e));
    return mine;
  }
}

async function callTool(name, args) {
  const mine = local(name);
  if (mine) {
    const out = await mine.run(args ?? {});
    return { content: [{ type: "text", text: JSON.stringify(out, null, 1) }] };
  }
  return remote("tools/call", { name, arguments: args ?? {} });
}

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return;
  try {
    if (method === "initialize") {
      await loadServer().catch(() => {});
      return send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "flexiprint", version: VERSION },
          instructions: [INSTRUCTIONS, serverInstructions].filter(Boolean).join("\n\n"),
        },
      });
    }
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: await listTools() } });
    if (method === "tools/call") {
      try {
        return send({ jsonrpc: "2.0", id, result: await callTool(params?.name, params?.arguments) });
      } catch (e) {
        return send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] } });
      }
    }
    if (method === "resources/list" || method === "resources/read" || method === "resources/templates/list") return send({ jsonrpc: "2.0", id, result: await remote(method, params ?? {}) });
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${method}` } });
  } catch (e) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
  }
}

// CLI (a test without an MCP client):
//   node server.mjs import <folder> · status <set_id> · tools · call <tool> '<json args>'
const [cmd, a1, a2] = process.argv.slice(2);
if (cmd === "import" || cmd === "status") {
  const out = cmd === "import" ? await importFolder({ folder: a1, name: a2 }) : await local("flexiprint_import_status").run({ set_id: a1 });
  console.log(JSON.stringify(out, null, 1));
} else if (cmd === "tools") {
  for (const t of await listTools()) console.log(t.name);
} else if (cmd === "call") {
  const out = await callTool(a1, a2 ? JSON.parse(a2) : {});
  console.log(out.content?.map((c) => c.text ?? `[${c.type}]`).join("\n"), out.isError ? "\n(isError)" : "");
} else {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        void handle(JSON.parse(line));
      } catch {
        log("bad message", line.slice(0, 200));
      }
    }
  });
}
