# Deploy — VPS runbook

VPS `139.180.132.159` (Ubuntu, 2 vCPU, 1.6 GB RAM + 8 GB swap). A records to the VPS:
`flexiprint.next.lc` (app) and `flexiprint-api.next.lc` (Supabase Studio + API).

```
/opt/flexiprint/
  supabase/     self-hosted Supabase (official docker/ + docker-compose.flexiprint.yml)
  app/          this repo (git clone) + .env
  migrations/   copies of supabase/migrations used to initialise the DB
```

## 1. Supabase (trimmed)

Official `docker/` from github.com/supabase/supabase with `docker-compose.flexiprint.yml` on top:
realtime, storage, imgproxy, edge functions and the pooler are disabled (files are on R2), Postgres is
tuned small, and the gateway listens on `127.0.0.1:8000` only.

`.env` changes from `.env.example` (after `sh utils/generate-keys.sh --update-env`):

```
COMPOSE_FILE=docker-compose.yml:docker-compose.flexiprint.yml
SUPABASE_PUBLIC_URL=https://flexiprint-api.next.lc
API_EXTERNAL_URL=https://flexiprint-api.next.lc
SITE_URL=https://flexiprint.next.lc
PGRST_DB_SCHEMAS=public,graphql_public,flexiprint
DISABLE_SIGNUP=true
ENABLE_EMAIL_AUTOCONFIRM=true
API_GW_HTTP_PORT=127.0.0.1:8000
```

```bash
cd /opt/flexiprint/supabase && docker compose up -d
for f in /opt/flexiprint/migrations/*.sql; do docker exec -i supabase-db psql -U postgres -v ON_ERROR_STOP=1 < $f; done
docker compose restart rest     # PostgREST picks up the new schema
```

**Supabase admin (Studio)**: https://flexiprint-api.next.lc (like supa-api.top for the 3D tool) —
nginx `deploy/nginx/flexiprint-supabase.conf` → Envoy, which asks for basic auth
(`DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` in the Supabase `.env`). The same domain also serves the
APIs; the app itself reaches Supabase through its own domain (`/auth/v1`, `/rest/v1` in flexiprint.conf).

## 2. App + services

```bash
cd /opt/flexiprint/app && git pull
docker compose up -d --build      # app on 127.0.0.1:3000, services on the internal network
```

`.env` = `.env.example` filled with the Supabase keys (`ANON_KEY`, `SERVICE_ROLE_KEY` from the Supabase `.env`)
and R2 credentials. `NEXT_PUBLIC_*` are baked in at build time — rebuild after changing them.

## 3. nginx + SSL

```bash
cp deploy/nginx/flexiprint-cache.conf /etc/nginx/conf.d/
cp deploy/nginx/flexiprint.conf /etc/nginx/sites-available/flexiprint
cp deploy/nginx/flexiprint-supabase.conf /etc/nginx/sites-available/flexiprint-supabase
ln -sf /etc/nginx/sites-available/flexiprint /etc/nginx/sites-enabled/flexiprint
ln -sf /etc/nginx/sites-available/flexiprint-supabase /etc/nginx/sites-enabled/flexiprint-supabase
nginx -t && systemctl reload nginx
certbot --nginx -d flexiprint.next.lc -d flexiprint-api.next.lc --redirect --agree-tos -n --register-unsafely-without-email
```

`client_max_body_size 500m` everywhere; `/api/` streams request bodies (no buffering) with 600 s timeouts.

## 4. Cron

```
23 * * * *  curl -fsS -X POST -H "Authorization: Bearer $CT_CRON_SECRET" https://flexiprint.next.lc/api/customize-tool/cron/cleanup
0 3 * * *   docker exec supabase-db pg_dump -U postgres -n flexiprint -n auth -Fc postgres > /var/backups/flexiprint-$(date +\%F).dump
```

## 5. Shopify (giftself-2.myshopify.com)

- App **FlexiPrint** (Dev Dashboard, same org as the store): client credentials in the app `.env`
  (`SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`) → Admin API token, auto-refreshed. Scopes: themes, products,
  files, read_orders. The metafield definition `customize_tool.product_id` (product, storefront read) exists.
- Theme files can't be written through the Admin API without a Shopify exemption, so they go through
  Shopify CLI with a staff login: `scripts/push-theme.sh` duplicates the live theme once into
  **FlexiPrint preview** and pushes only `sections/flexiprint-product.liquid`, `assets/ct-customizer.{js,css}`
  and `templates/product.flexiprint.json` (`--only` + `--nodelete`, never a full push).
- A personalized product: template `product.flexiprint` + metafield `customize_tool.product_id` = FlexiPrint id.
