#!/usr/bin/env node
// flexiprint-import — MCP (stdio) on the editor's own machine (asked 2026-10-30: "sếp chỉ cần đề cập folder rồi tải
// content từ folder đó lên"). Claude Code is told "import ~/Downloads/n00-POD-02 lên FlexiPrint": this reads the
// folder, sends it to flexi2 the way the "Import bộ" button does (components/char/import-button.tsx), and the server
// builds the set + product and puts it on Shopify as a draft (server/char/import-deploy.ts) — the reply carries the
// set's page and the store preview link.
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
const BATCH_BYTES = 8 * 1024 * 1024;
const BATCH_FILES = 30;
const PARALLEL = 6;
/** One tool call waits this long for the build + Shopify, then hands back the set id for flexiprint_import_status. */
const WAIT_MS = 12 * 60 * 1000;

const log = (...a) => process.stderr.write(`[flexiprint-import] ${a.join(" ")}\n`);
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

/** The web page's selectFiles: a Teeinblue hand-off sends only its case folders, the top files and the notes. */
function selectFiles(all) {
  const files = all.filter((f) => !JUNK.test(f.path) && KEEP.test(f.path));
  const cases = files.filter((f) => /(^|\/)teeinblue\.json$/i.test(f.path)).map((f) => f.path.split("/").slice(0, -1).join("/"));
  if (!cases.length) return files;
  return files.filter((f) => !f.path.includes("/") || /\.(json|csv|md|txt)$/i.test(f.path) || cases.some((d) => f.path.startsWith(`${d}/`)));
}

/** A folder named or found: an absolute path, ~/…, or a name under ~/Downloads / ~/Desktop / the cwd. */
function findFolder(raw) {
  const p = String(raw ?? "").trim().replace(/^~(?=$|\/)/, os.homedir());
  const tries = path.isAbsolute(p) ? [p] : [path.resolve(p), path.join(os.homedir(), "Downloads", p), path.join(os.homedir(), "Desktop", p), path.join(os.homedir(), "Downloads", "linh-download-output", p)];
  for (const t of tries) if (fs.existsSync(t) && fs.statSync(t).isDirectory()) return t;
  throw new Error(`Không thấy folder "${raw}" (đã tìm: ${tries.join(", ")})`);
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

/** Where the set is: build, Shopify, links. */
async function status(setId) {
  const { project } = await call(`char/projects/${setId}`);
  const imp = project.brief?.imported ?? {};
  const shop = imp.shopify ?? null;
  const building = ["uploading", "analyzing", "agent", "building"].includes(imp.status);
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
  const root = findFolder(folder);
  const all = walk(root);
  const files = selectFiles(all);
  if (!files.length) throw new Error(`Folder ${root} không có ảnh / ghi chú nào để import`);
  const bytes = files.reduce((n, f) => n + f.size, 0);
  const big = files.find((f) => f.size > 60 * 1024 * 1024);
  if (big) throw new Error(`${big.path} quá lớn (tối đa 60 MB một file)`);
  const setName = String(name || path.basename(root)).slice(0, 200);
  const { project } = await postJson("char/projects/import", { name: setName });
  const run = { setId: project.id, sent: 0, bytes, files: files.length, phase: "uploading", started: Date.now() };
  runs.set(project.id, run);
  log(`${setName}: ${files.length} file (${mb(bytes)}) → ${project.id}`);
  const uploaded = await upload(project.id, files, (n) => {
    run.sent += n;
  });
  run.phase = "started";
  await postJson(`char/projects/${project.id}/import/start`, { files: uploaded });
  const until = Date.now() + WAIT_MS;
  let st = await status(project.id);
  while (!st.finished && Date.now() < until) {
    await sleep(10_000);
    st = await status(project.id).catch(() => st);
  }
  run.phase = "done";
  return {
    folder: root,
    sent: `${files.length} file (${mb(bytes)})${all.length - files.length ? `, bỏ ${all.length - files.length} file không cần` : ""}`,
    ...st,
    next: st.finished
      ? st.shopify?.preview
        ? "Đưa link preview (Shopify, theme nháp) và link page cho người dùng."
        : "Báo lỗi / việc còn thiếu cho người dùng (vd. chưa có bảng giá cho chất liệu)."
      : "Chưa xong — gọi flexiprint_import_status với set_id sau ít phút.",
  };
}

// ---------------------------------------------------------------- MCP (stdio, newline-delimited JSON-RPC)
const TOOLS = [
  {
    name: "flexiprint_import",
    description:
      "Import a finished bộ clipart folder on THIS machine (a Teeinblue hand-off like n00-POD-02, or any folder of layer files + mockups + notes) into FlexiPrint (flexi2). It uploads the folder, the server builds the bộ nhân vật + its product, then puts the product on the Shopify store as a DRAFT (price table by material, title/description from the folder). Waits up to ~12 min. → page (the set on flexi2), shopify.preview (store preview in the draft theme), shopify.admin, problems. folder = absolute path, ~/…, or a folder name in ~/Downloads.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "The folder: /Users/…/n00-POD-02, ~/Downloads/n00-POD-02, or just n00-POD-02." },
        name: { type: "string", description: "Name of the set (default: the folder name)." },
      },
      required: ["folder"],
    },
  },
  {
    name: "flexiprint_import_status",
    description: "Where an import is: build progress, problems, the Shopify draft (preview / admin link, or why it did not go up). set_id from flexiprint_import.",
    inputSchema: { type: "object", properties: { set_id: { type: "string" } }, required: ["set_id"] },
  },
];

async function runTool(name, args) {
  if (name === "flexiprint_import") return importFolder(args ?? {});
  if (name === "flexiprint_import_status") {
    const id = String(args?.set_id ?? "");
    const run = runs.get(id);
    const st = await status(id);
    return run && run.phase === "uploading" ? { ...st, upload: `${mb(run.sent)} / ${mb(run.bytes)}` } : st;
  }
  throw new Error(`Unknown tool: ${name}`);
}

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return;
  try {
    if (method === "initialize")
      return send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "flexiprint-import", version: "1.0.0" } } });
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call") {
      try {
        const out = await runTool(params?.name, params?.arguments);
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(out, null, 1) }] } });
      } catch (e) {
        return send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] } });
      }
    }
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${method}` } });
  } catch (e) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
  }
}

// CLI: `node server.mjs import <folder>` / `node server.mjs status <set_id>` (a test without an MCP client).
if (process.argv[2] === "import" || process.argv[2] === "status") {
  const out = process.argv[2] === "import" ? await importFolder({ folder: process.argv[3], name: process.argv[4] }) : await runTool("flexiprint_import_status", { set_id: process.argv[3] });
  console.log(JSON.stringify(out, null, 1));
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
