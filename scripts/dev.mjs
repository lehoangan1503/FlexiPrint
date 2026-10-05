#!/usr/bin/env node
// `npm run dev`: Next.js + the customize-tool Python services + the ComfyUI studio (services/*/run-local.sh).
// A service whose port is already listening is assumed running and skipped.
// SKIP_SERVICES=1 npm run dev → Next only. Ctrl+C stops everything.
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SERVICES = [
  { name: "bg-remover", port: 7001, color: 35 },
  { name: "photo-style", port: 7002, color: 36 },
  { name: "material-render", port: 7003, color: 33 },
  { name: "face-detect", port: 7004, color: 31 },
  // ComfyUI studio (first run installs ComfyUI into services/comfy/.comfy — a few minutes).
  { name: "comfy", port: 8188, color: 34 },
];

const children = [];

function prefixed(name, color, stream, out) {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) out.write(`\x1b[${color}m[${name}]\x1b[0m ${line}\n`);
  });
}

function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => resolve(false));
  });
}

function run(name, color, cmd, args, cwd, { critical }) {
  const child = spawn(cmd, args, { cwd, env: process.env, stdio: ["inherit", "pipe", "pipe"], detached: true });
  prefixed(name, color, child.stdout, process.stdout);
  prefixed(name, color, child.stderr, process.stderr);
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.log(`\x1b[${color}m[${name}]\x1b[0m exited (${signal ?? code})`);
    if (critical) shutdown(code ?? 1);
  });
  children.push(child);
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  // Each child leads its own process group, so uvicorn workers / next's children die too.
  for (const c of children) {
    try { process.kill(-c.pid, "SIGTERM"); } catch { /* already gone */ }
  }
  setTimeout(() => process.exit(code), 1500).unref();
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

if (process.env.SKIP_SERVICES !== "1") {
  for (const s of SERVICES) {
    if (await portInUse(s.port)) {
      console.log(`\x1b[${s.color}m[${s.name}]\x1b[0m port ${s.port} already in use — assuming it's running`);
      // A ComfyUI left over from an earlier run keeps the node pack it loaded: edits to custom_nodes/ (FP Material,
      // recipes) do nothing until it is restarted.
      if (s.name === "comfy") {
        console.log(`\x1b[${s.color}m[${s.name}]\x1b[0m ⚠ it runs the node pack it loaded at start — after editing custom_nodes/, stop it (lsof -ti:${s.port} | xargs kill) and rerun npm run dev`);
      }
      continue;
    }
    run(s.name, s.color, "./run-local.sh", [], path.join(root, "services", s.name), { critical: false });
  }
}

run("next", 32, "npx", ["next", "dev", ...process.argv.slice(2)], root, { critical: true });
