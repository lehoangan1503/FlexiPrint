#!/usr/bin/env node
// Put the FlexiPrint (flexi2) product page on a Shopify theme through the Admin API (themeFilesUpsert, scope
// write_themes) with the app's client credentials — no Shopify CLI login.
//
//   node --env-file=.env.local scripts/push-theme.mjs                 # the live theme (role MAIN)
//   THEME=<id or name> node --env-file=.env.local scripts/push-theme.mjs   # another theme, e.g. "Copy of Cherivia Ornament (nháp)"
//   STORE=caridora node --env-file=.env.local scripts/push-theme.mjs  # another store (migration 032): its app is
//                                    SHOPIFY_CARIDORA_CLIENT_ID / _CLIENT_SECRET / _STORE_DOMAIN (default: CHERIVIA =
//                                    SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET / SHOPIFY_STORE_DOMAIN)
//
// Since 2026-11-03 it goes to the LIVE theme, but only as files of its own — every file the theme already
// has is left as it is (the theme's product.json, its sections, snippets, assets, the other product.* templates):
//   sections/flexi2-product.liquid   ← customize-tool/shopify/sections/flexi2-product.liquid (self-contained: no theme snippet/asset/JS)
//   assets/flexi2-customizer.{js,css}
//   templates/product.flexi2.json    (section flexi2-product, api_base = API_BASE, default flexi2) — the template every
//                                    deployed product uses (server/shopify.ts CT_SHOPIFY_TEMPLATE_SUFFIX = "flexi2")
//   assets/flexi2-tasks.js           the cards of the customer's background photo tasks (storefront/tasks.ts), on EVERY
//                                    page — loaded by ONE line added to layout/theme.liquid before </body> (asked
//                                    2026-11-09 "khắp store"): the line is added once (marker FLEXI2_TASKS), the theme's
//                                    own layout is backed up to backups/ first, nothing else in it is touched.
// Any other filename is refused (ALLOWED below), so a later edit of this script cannot overwrite a theme file by mistake.
// The template copies the live theme's product page (read only, asked 2026-11-02 "cho giống store chính"): its info blocks
// the section knows (sale, delivery date, benefits, collapsible rows — Description shows the product description —,
// custom liquid) in their order, and the sections under it (disclosures, related products).
// SKIP_ASSETS=1 sends only the section + template (no storefront build, flexi2-customizer.* left as they are on the theme).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The store (server/stores.ts): its app's credentials are SHOPIFY_<ID>_*; CHERIVIA also reads the older names.
const STORE_ID = (process.env.STORE || "cherivia").toLowerCase();
const K = STORE_ID.toUpperCase().replace(/[^A-Z0-9]/g, "_");
const legacy = STORE_ID === "cherivia";
const KNOWN_DOMAINS = { cherivia: "v5bpim-cd.myshopify.com", caridora: "v1ebmg-u1.myshopify.com" };
const STORE = process.env[`SHOPIFY_${K}_STORE_DOMAIN`] || (legacy ? process.env.SHOPIFY_STORE_DOMAIN : "") || KNOWN_DOMAINS[STORE_ID];
const CLIENT_ID = process.env[`SHOPIFY_${K}_CLIENT_ID`] || (legacy ? process.env.SHOPIFY_CLIENT_ID : "");
const CLIENT_SECRET = process.env[`SHOPIFY_${K}_CLIENT_SECRET`] || (legacy ? process.env.SHOPIFY_CLIENT_SECRET : "");
const API = process.env.SHOPIFY_API_VERSION || "2026-07";
// Not APP_URL: .env.local carries the local one. Every deploy goes through flexi2.
const API_BASE = process.env.API_BASE || "https://flexi2.next.lc";
const THEME = process.env.THEME || ""; // empty = the live (MAIN) theme
const ALLOWED = new Set([
  "sections/flexi2-product.liquid",
  "assets/flexi2-customizer.js",
  "assets/flexi2-customizer.css",
  "templates/product.flexi2.json",
  "assets/flexi2-tasks.js",
]);
const TASKS_MARK = "FLEXI2_TASKS";
const TASKS_LINE = `{%- comment -%}${TASKS_MARK}: FlexiPrint photo task cards (scripts/push-theme.mjs){%- endcomment -%}<script src="{{ 'flexi2-tasks.js' | asset_url }}" defer="defer"></script>`;

if (!STORE || !CLIENT_ID || !CLIENT_SECRET) {
  console.error(`Thiếu app của store ${STORE_ID}: SHOPIFY_${K}_CLIENT_ID / SHOPIFY_${K}_CLIENT_SECRET (node --env-file=.env.local …)`);
  process.exit(1);
}

const auth = await fetch(`https://${STORE}/admin/oauth/access_token`, {
  method: "POST",
  headers: { Accept: "application/json" },
  body: new URLSearchParams({ grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
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
const theme = THEME ? themes.nodes.find((t) => t.name === THEME || t.id.endsWith(`/${THEME}`)) : themes.nodes.find((t) => t.role === "MAIN");
if (!theme) throw new Error(`Không thấy theme "${THEME || "MAIN"}". Có: ${themes.nodes.map((t) => `${t.name} (${t.id.split("/").pop()}, ${t.role})`).join(", ")}`);

const skipAssets = process.env.SKIP_ASSETS === "1";
if (!skipAssets) execFileSync("npm", ["run", "-s", "build:ct-storefront"], { cwd: root, stdio: "inherit" });

const src = (p) => fs.readFileSync(path.join(root, "customize-tool/shopify", p), "utf8");
const template = JSON.parse(src("templates/product.customize.json"));
template.sections.main.type = "flexi2-product";
template.sections.main.settings.api_base = API_BASE;

// The live theme's product page, read only.
const OWN_BLOCKS = new Set(["custom_liquid", "cv_sale_banner", "cv_delivery", "cv_benefits", "collapsible_tab"]);
// The icons the section draws itself (its schema select); any other → none, or the template would not validate.
const OWN_ICONS = new Set(["none", "box", "check_mark", "clipboard", "heart", "return", "truck"]);
const live = themes.nodes.find((t) => t.role === "MAIN");
if (live) {
  const { theme: lt } = await gql(
    `query($id: ID!) { theme(id: $id) { files(filenames: ["templates/product.json"]) { nodes { body { ... on OnlineStoreThemeFileBodyText { content } } } } } }`,
    { id: live.id },
  );
  const text = lt?.files.nodes[0]?.body?.content ?? "";
  const page = text ? JSON.parse(text.replace(/^\s*\/\*[\s\S]*?\*\//, "")) : null;
  const main = page?.sections?.[page.order.find((k) => page.sections[k].type === "main-product") ?? "main"];
  if (main) {
    const order = (main.block_order ?? Object.keys(main.blocks ?? {})).filter((k) => OWN_BLOCKS.has(main.blocks[k]?.type) && !main.blocks[k].disabled);
    template.sections.main.blocks = Object.fromEntries(
      order.map((k) => {
        const b = structuredClone(main.blocks[k]);
        if (b.type === "collapsible_tab" && b.settings && !OWN_ICONS.has(b.settings.icon ?? "check_mark")) b.settings.icon = "none";
        return [k, b];
      }),
    );
    template.sections.main.block_order = order;
    for (const k of page.order.filter((k) => page.sections[k].type !== "main-product")) {
      template.sections[k] = page.sections[k];
      template.order.push(k);
    }
    console.log(`Theo trang sản phẩm theme live "${live.name}": khối ${order.join(", ")}; section ${template.order.join(", ")}`);
  }
}

// Section first: a template may only reference a section that already exists on the theme.
const batches = [
  [
    ["sections/flexi2-product.liquid", src("sections/flexi2-product.liquid")],
    ...(skipAssets
      ? []
      : [
          ["assets/flexi2-customizer.js", src("assets/flexi2-customizer.js")],
          ["assets/flexi2-customizer.css", src("assets/flexi2-customizer.css")],
          ["assets/flexi2-tasks.js", src("assets/flexi2-tasks.js")],
        ]),
  ],
  [["templates/product.flexi2.json", JSON.stringify(template, null, 2)]],
];
for (const [filename] of batches.flat()) {
  if (!ALLOWED.has(filename)) throw new Error(`Không ghi "${filename}": chỉ được ghi file flexi2 riêng (${[...ALLOWED].join(", ")}).`);
}
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
// The one line in the theme's layout that loads the task cards on every page — added once, the original backed up.
{
  const { theme: t } = await gql(
    `query($id: ID!) { theme(id: $id) { files(filenames: ["layout/theme.liquid"]) { nodes { checksumMd5 body { ... on OnlineStoreThemeFileBodyText { content } } } } } }`,
    { id: theme.id },
  );
  const layout = t?.files.nodes[0]?.body?.content ?? "";
  if (!layout) console.log("! layout/theme.liquid không đọc được — card tác vụ chỉ hiện trên trang sản phẩm FlexiPrint");
  else if (layout.includes(TASKS_MARK)) console.log("= layout/theme.liquid đã có dòng flexi2-tasks.js");
  else {
    const at = layout.lastIndexOf("</body>");
    if (at < 0) throw new Error("layout/theme.liquid không có </body> — không chèn");
    const dir = path.join(root, "backups");
    fs.mkdirSync(dir, { recursive: true });
    const backup = path.join(dir, `theme-liquid-${theme.id.split("/").pop()}-${new Date().toISOString().replace(/[:.]/g, "-")}.liquid`);
    fs.writeFileSync(backup, layout);
    const next = `${layout.slice(0, at)}  ${TASKS_LINE}\n${layout.slice(at)}`;
    const { themeFilesUpsert: r } = await gql(
      `mutation($t: ID!, $f: [OnlineStoreThemeFilesUpsertFileInput!]!) {
        themeFilesUpsert(themeId: $t, files: $f) { upsertedThemeFiles { filename } userErrors { filename code message } }
      }`,
      { t: theme.id, f: [{ filename: "layout/theme.liquid", body: { type: "TEXT", value: next } }] },
    );
    if (r.userErrors.length) throw new Error(`Shopify: ${JSON.stringify(r.userErrors)}`);
    console.log(`✓ layout/theme.liquid (+1 dòng flexi2-tasks.js; bản gốc: ${path.relative(root, backup)})`);
  }
}
console.log(`Theme "${theme.name}" (${theme.id.split("/").pop()}, ${theme.role}) trên ${STORE}, api_base = ${API_BASE}`);
