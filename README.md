# FlexiPrint

Personalized 2D product builder for Shopify (Customily / Teeinblue style): main object + custom zones
(image options, text, customer photo), per-main-version layouts, material rendering (acrylic, ceramic,
metal, wood) and print files with a laser cut path.

- **App**: Next.js 16 (standalone) — editor, dashboard, admin, public storefront API.
- **Auth + DB**: self-hosted Supabase (Postgres, GoTrue, PostgREST), schema `flexiprint`.
- **Files**: Cloudflare R2 (private bucket), served by the app at `/files/*` behind an nginx cache.
- **Services** (`services/`, Python, no AI): `bg-remover` (BiRefNet cut-out), `photo-style` (OpenCV styles),
  `material-render` (print files + cut SVG).
- **Storefront**: `customize-tool/shopify/` — theme section + `ct-customizer.js` (Shopify store `giftself-2`).

## Layout

```
src/app/            login, dashboard (product list), products/[id] (editor), admin/*, files/[...key], api/*
src/lib/            supabase clients, roles
customize-tool/     the product builder (see customize-tool/README.md)
services/           python microservices
supabase/migrations SQL for schema flexiprint (run in order)
deploy/             nginx config + VPS runbook (deploy/README.md)
```

## Accounts & roles

No public signup. The superadmin creates accounts in **/admin/dashboard/accounts**.

| Role | Where | Can |
|---|---|---|
| superadmin | `auth.users.raw_app_meta_data.role = 'admin'` (SQL) | /admin: accounts, all products |
| admin | `user_profiles.role = 'admin'` | tool admin — shared AI style library |
| mode | `user_profiles.role = 'mode'` | reserved |
| — | `role IS NULL` | own products |

Grant superadmin:

```sql
UPDATE auth.users SET raw_app_meta_data = raw_app_meta_data || '{"role":"admin"}' WHERE email = 'you@example.com';
```

## Local development

```bash
cp .env.example .env.local   # fill Supabase + R2 keys
npm install
npm run dev                  # Next + python services (services/*/run-local.sh)
npm run build:ct-storefront  # rebuild the Shopify bundle after changing lib/ or storefront/
```

## Deploy

See [deploy/README.md](deploy/README.md).
