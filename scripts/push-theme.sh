#!/usr/bin/env bash
# Update the FlexiPrint storefront files in the Shopify theme "FlexiPrint" (live on giftself-2)
# with Shopify CLI — staff login; the Admin API can't write theme files without a Shopify exemption.
#
#   scripts/push-theme.sh              # theme named "FlexiPrint"
#   THEME=<id> scripts/push-theme.sh   # another theme
#
# Only these files are pushed (--only + --nodelete, never a full push):
#   sections/flexiprint-product.liquid   ← customize-tool/shopify/sections/main-product.liquid
#   assets/ct-customizer.{js,css}
#   templates/product.json + product.flexiprint.json  (section flexiprint-product, api_base = APP_URL)
# The theme itself is Shopify's Horizon (github.com/Shopify/horizon) with these files added.
set -euo pipefail
cd "$(dirname "$0")/.."
STORE="${STORE:-giftself-2.myshopify.com}"
APP_URL="${APP_URL:-https://flexiprint.next.lc}"
THEME="${THEME:-FlexiPrint}"

npm run -s build:ct-storefront

OUT="$(mktemp -d)/theme"
mkdir -p "$OUT"/{sections,assets,templates}
cp customize-tool/shopify/sections/main-product.liquid "$OUT/sections/flexiprint-product.liquid"
cp customize-tool/shopify/assets/ct-customizer.js customize-tool/shopify/assets/ct-customizer.css "$OUT/assets/"
node -e '
const fs = require("fs");
const t = require(process.argv[1]);
t.sections.main.type = "flexiprint-product";
t.sections.main.settings.api_base = process.argv[2];
const s = JSON.stringify(t, null, 2);
for (const f of ["product.json", "product.flexiprint.json"]) fs.writeFileSync(process.argv[3] + "/templates/" + f, s);
' "$PWD/customize-tool/shopify/templates/product.customize.json" "$APP_URL" "$OUT"

# Section first: a template may only reference a section that already exists on the theme.
shopify theme push --store "$STORE" --theme "$THEME" --path "$OUT" --nodelete --allow-live \
  --only sections/flexiprint-product.liquid --only assets/ct-customizer.js --only assets/ct-customizer.css
shopify theme push --store "$STORE" --theme "$THEME" --path "$OUT" --nodelete --allow-live \
  --only templates/product.json --only templates/product.flexiprint.json
