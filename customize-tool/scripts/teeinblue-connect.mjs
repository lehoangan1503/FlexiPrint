#!/usr/bin/env node
/**
 * Makes the "mã kết nối Teeinblue" for flexi2's Import product base → Merchize (server/teeinblue.ts): reads the
 * Teeinblue login cookies from Chrome on this Mac and copies a code to the clipboard — paste it in the Import
 * dialog. Open Teeinblue in Chrome first (Shopify admin → Apps → Teeinblue) so the login is fresh.
 *
 *   node customize-tool/scripts/teeinblue-connect.mjs [--profile "Profile 1"]
 *
 * macOS only: Chrome keeps cookies in <profile>/Cookies (SQLite), values encrypted with AES-128-CBC under a key
 * derived from the Keychain item "Chrome Safe Storage" (macOS asks once to allow it).
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const argProfile = process.argv.indexOf("--profile");
const profile = argProfile > 0 ? process.argv[argProfile + 1] : "Default";
const root = join(homedir(), "Library/Application Support/Google/Chrome", profile);
const db = [join(root, "Network/Cookies"), join(root, "Cookies")].find(existsSync);
if (!db) {
  console.error(`Không thấy file cookie của Chrome (${root})`);
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "tib-"));
try {
  const copy = join(dir, "Cookies");
  copyFileSync(db, copy);
  const sql = "select name, hex(encrypted_value), value, expires_utc from cookies where host_key like '%teeinblue.com' and (name like '%teeinblue_session%' or name = 'XSRF-TOKEN')";
  const rows = execFileSync("sqlite3", ["-separator", "\t", copy, sql], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t"));
  if (!rows.length) throw new Error("Chrome chưa đăng nhập Teeinblue — mở Teeinblue trên Chrome rồi chạy lại");
  const pass = execFileSync("security", ["find-generic-password", "-w", "-s", "Chrome Safe Storage"], { encoding: "utf8" }).trim();
  const key = pbkdf2Sync(pass, "saltysalt", 1003, 16, "sha1");
  const cookies = rows.map(([name, hex, plain, expiresUtc]) => {
    let value = plain;
    const enc = Buffer.from(hex, "hex");
    if (enc.length > 3 && enc.subarray(0, 3).toString() === "v10") {
      const d = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
      let out = Buffer.concat([d.update(enc.subarray(3)), d.final()]);
      // Chrome ≥ 130 puts SHA-256(host) before the value.
      if (out.length > 32 && /[^\x20-\x7e]/.test(out.subarray(0, 32).toString("latin1"))) out = out.subarray(32);
      value = out.toString("utf8");
    }
    // Chrome time = µs since 1601-01-01.
    const expires = Number(expiresUtc) ? Math.floor(Number(expiresUtc) / 1e6 - 11644473600) : 0;
    return { name, value, expires };
  });
  if (!cookies.some((c) => c.name === "__Secure-teeinblue_session")) throw new Error("Không có phiên Teeinblue — mở Teeinblue trên Chrome rồi chạy lại");
  const code = Buffer.from(JSON.stringify({ cookies })).toString("base64");
  try {
    execFileSync("pbcopy", { input: code });
    console.log("Đã chép mã kết nối Teeinblue — dán vào flexi2: Product base → Import → Merchize.");
  } catch {
    console.log(code);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
