#!/usr/bin/env bash
# Push the FlexiPrint storefront files to a Shopify theme with Shopify CLI (staff login — the
# Admin API can't write theme files without a Shopify exemption).
#
#   scripts/push-theme.sh                 # duplicate the live theme once → "FlexiPrint preview", push there
#   THEME=<id> scripts/push-theme.sh      # push to an existing theme (never a full push: --only + --nodelete)
#
# Uploads, renamed so nothing of the theme is overwritten:
#   sections/flexiprint-product.liquid   ← customize-tool/shopify/sections/main-product.liquid
#   assets/ct-customizer.{js,css}
#   templates/product.flexiprint.json    ← assign this template to personalized products
set -euo pipefail
cd "$(dirname "$0")/.."
STORE="${STORE:-giftself-2.myshopify.com}"
APP_URL="${APP_URL:-https://flexiprint.next.lc}"
NAME="FlexiPrint preview"

npm run -s build:ct-storefront

OUT="$(mktemp -d)/theme"
mkdir -p "$OUT"/{sections,assets,templates}
cp customize-tool/shopify/sections/main-product.liquid "$OUT/sections/flexiprint-product.liquid"
cp customize-tool/shopify/assets/ct-customizer.js customize-tool/shopify/assets/ct-customizer.css "$OUT/assets/"
node -e '
const t = require(process.argv[1]);
t.sections.main.type = "flexiprint-product";
t.sections.main.settings.api_base = process.argv[2];
process.stdout.write(JSON.stringify(t, null, 2));
' "$PWD/customize-tool/shopify/templates/product.customize.json" "$APP_URL" > "$OUT/templates/product.flexiprint.json"

if [ -z "${THEME:-}" ]; then
  THEME="$(shopify theme list --store "$STORE" --name "$NAME" --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);process.stdout.write(a[0]?String(a[0].id):"")}catch{}})')"
  if [ -z "$THEME" ]; then
    LIVE="$(shopify theme list --store "$STORE" --role live --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s)[0].id)))')"
    echo "Duplicating live theme $LIVE → \"$NAME\""
    THEME="$(shopify theme duplicate --store "$STORE" --theme "$LIVE" --name "$NAME" --force --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(String((j.theme||j).id))})')"
  fi
fi

echo "Pushing to theme $THEME on $STORE"
shopify theme push --store "$STORE" --theme "$THEME" --path "$OUT" --nodelete \
  --only sections/flexiprint-product.liquid --only assets/ct-customizer.js --only assets/ct-customizer.css --only templates/product.flexiprint.json
echo "Preview: https://$STORE/?preview_theme_id=$THEME"
