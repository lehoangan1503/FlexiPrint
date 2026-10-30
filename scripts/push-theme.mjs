#!/usr/bin/env node
// Update the FlexiPrint storefront files in a Shopify theme through the Admin API (themeFilesUpsert, scope
// write_themes) with the app's client credentials — no Shopify CLI login.
//
//   node --env-file=.env.local scripts/push-theme.mjs                 # theme "Copy of Cherivia Ornament (nháp)"
//   THEME=<id or name> node --env-file=.env.local scripts/push-theme.mjs
//
// Only these files are written, nothing else in the theme is touched (its own templates/product.json stays):
//   sections/flexiprint-product.liquid   ← customize-tool/shopify/sections/main-product.liquid
//   assets/ct-customizer.{js,css}
//   templates/product.flexiprint.json    (section flexiprint-product, api_base = API_BASE, default flexi2) — the template every
//                                        deployed product uses (server/shopify.ts CT_SHOPIFY_TEMPLATE_SUFFIX)
// The live (MAIN) theme is refused unless ALLOW_LIVE=1.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORE = process.env.SHOPIFY_STORE_DOMAIN;
const API = process.env.SHOPIFY_API_VERSION || "2026-07";
// Not APP_URL: .env.local carries the local one. Every deploy goes through flexi2.
const API_BASE = process.env.API_BASE || "https://flexi2.next.lc";
const THEME = process.env.THEME || "Copy of Cherivia Ornament (nháp)";

if (!STORE || !process.env.SHOPIFY_CLIENT_ID || !process.env.SHOPIFY_CLIENT_SECRET) {
  console.error("Thiếu SHOPIFY_STORE_DOMAIN / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET (node --env-file=.env.local …)");
  process.exit(1);
}

const auth = await fetch(`https://${STORE}/admin/oauth/access_token`, {
  method: "POST",
  body: new URLSearchParams({ grant_type: "client_credentials", client_id: process.env.SHOPIFY_CLIENT_ID, client_secret: process.env.SHOPIFY_CLIENT_SECRET }),
}).then((r) => r.json());
if (!auth.access_token) throw new Error(`Shopify từ chối đăng nhập app: ${JSON.stringify(auth)}`);

async function gql(query, variables = {}) {
  const res = await fetch(`https://${STORE}/admin/api/${API}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": auth.access_token },
    body: JSON.stringify({ query, variables }),
  }).then((r) => r.json());
  if (res.errors) throw new Error(`Shopify: ${JSON.stringify(res.errors)}`);
  return res.data;
}

const { themes } = await gql(`{ themes(first: 50) { nodes { id name role } } }`);
const theme = themes.nodes.find((t) => t.name === THEME || t.id.endsWith(`/${THEME}`));
if (!theme) throw new Error(`Không thấy theme "${THEME}". Có: ${themes.nodes.map((t) => `${t.name} (${t.id.split("/").pop()}, ${t.role})`).join(", ")}`);
if (theme.role === "MAIN" && process.env.ALLOW_LIVE !== "1") throw new Error(`"${theme.name}" là theme live — không đẩy (ALLOW_LIVE=1 nếu thật sự muốn).`);

execFileSync("npm", ["run", "-s", "build:ct-storefront"], { cwd: root, stdio: "inherit" });

const src = (p) => fs.readFileSync(path.join(root, "customize-tool/shopify", p), "utf8");
const template = JSON.parse(src("templates/product.customize.json"));
template.sections.main.type = "flexiprint-product";
template.sections.main.settings.api_base = API_BASE;

// Section first: a template may only reference a section that already exists on the theme.
const batches = [
  [
    ["sections/flexiprint-product.liquid", src("sections/main-product.liquid")],
    ["assets/ct-customizer.js", src("assets/ct-customizer.js")],
    ["assets/ct-customizer.css", src("assets/ct-customizer.css")],
  ],
  [["templates/product.flexiprint.json", JSON.stringify(template, null, 2)]],
];
for (const files of batches) {
  const { themeFilesUpsert: r } = await gql(
    `mutation($t: ID!, $f: [OnlineStoreThemeFilesUpsertFileInput!]!) {
      themeFilesUpsert(themeId: $t, files: $f) { upsertedThemeFiles { filename } userErrors { filename code message } }
    }`,
    { t: theme.id, f: files.map(([filename, value]) => ({ filename, body: { type: "TEXT", value } })) },
  );
  if (r.userErrors.length) throw new Error(`Shopify: ${JSON.stringify(r.userErrors)}`);
  for (const f of r.upsertedThemeFiles) console.log(`✓ ${f.filename}`);
}
console.log(`Theme "${theme.name}" (${theme.id.split("/").pop()}, ${theme.role}) trên ${STORE}, api_base = ${API_BASE}`);
