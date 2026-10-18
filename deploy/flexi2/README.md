# flexi2 — an-vm (company machine) runbook

A second FlexiPrint next to the VPS (deploy/README.md), **independent since 2026-10-19**: its own Supabase (own DB, own
keys) and R2 prefix (`R2_KEY_PREFIX=flexi2`, same bucket); no data flows between the two — only the GitHub repo is
shared (each updates when someone pulls on that machine). Reached through Cloudflare Tunnel — no open port.

It started as a copy of the VPS data (2026-10-19: DB rows + auth users, R2 `flexiprint/` → `flexi2/`, URLs rewritten
`https://flexiprint.next.lc/` → `https://flexi2.next.lc/`; `/opt/flexi2/restore-vps.sh`) — a one-off, not repeated.

| | |
|---|---|
| Machine | `an-vm`, Ubuntu 24.04, 8 cores, 11 GB RAM + 8 GB swap; Tailscale `100.108.93.16` (`ssh an@100.108.93.16`) |
| App | https://flexi2.next.lc |
| Supabase Studio + API | https://flexi2-api.next.lc (basic auth: `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` in the Supabase `.env`) |

```
/opt/flexi2/
  supabase/   self-hosted Supabase — the VPS's files (same versions) + its own .env (generate-keys.sh)
  app/        this repo (git clone, deploy key ~/.ssh/flexiprint_deploy, host alias github-flexiprint) + .env
  certs/      local CA + certificate for nginx :443 (containers only, see below)
```

## Cloudflare Tunnel

Every request must answer within ~100 s (the tunnel cuts a silent one): long work is a job — POST `?async=1`
(server/jobs.ts, lib/job-fetch.ts), MCP waits ≤ 60 s per call.

Tunnel public hostnames (both to the same nginx, which routes by Host):

| Hostname | Service |
|---|---|
| `flexi2.next.lc` | `http://localhost:80` |
| `flexi2-api.next.lc` | `http://localhost:80` |

Install the connector with the token from the Cloudflare dashboard: `sudo cloudflared service install <token>`.

## Why nginx also listens on :443

As on the VPS, the app and layer-kit call Supabase / `/files/` at `https://flexi2.next.lc`, resolved to the host
(`extra_hosts: ${APP_DOMAIN}:host-gateway`). Behind the tunnel there is no public certificate here, so nginx :443
uses `/opt/flexi2/certs/local.crt` (signed by `ca.crt`, made with openssl) and `docker-compose.flexi2.yml` makes the
containers trust it (`NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`). Browsers never see :443.

## Update

```bash
cd /opt/flexi2/app && git pull && docker compose up -d --build
# new migration: docker exec -i supabase-db psql -U postgres -v ON_ERROR_STOP=1 < supabase/migrations/0NN_….sql
#                then (cd /opt/flexi2/supabase && docker compose restart rest)
```

`/opt/flexi2/app/.env` carries `COMPOSE_FILE=docker-compose.yml:deploy/flexi2/docker-compose.flexi2.yml`.

## First install (done 2026-10-19)

1. `apt install docker-compose-v2 nginx`, 8 GB `/swapfile`.
2. Supabase: VPS `/opt/flexiprint/supabase` copied without data / `.env`; `.env` from `.env.example` +
   `sh utils/generate-keys.sh --update-env` + the values in deploy/README.md §1 with `flexi2` domains; `docker compose up -d`;
   every `supabase/migrations/*.sql` in order; `docker compose restart rest`.
3. App `.env`: the VPS one with `flexi2` URLs, the new Supabase keys, `R2_KEY_PREFIX=flexi2`, a new
   `CT_CRON_SECRET`; `AGENT_IDE_*` and `CT_AGENT_TOKEN` as the VPS + `CT_AGENT_MCP=flexi2`: the same @flexiprint agent
   serves both — its `flexiprint` capability needs an MCP server `flexi2` (integrations/agent-ide/flexiprint-capability.json).
4. nginx: `deploy/flexi2/nginx-flexi2.conf` → `/etc/nginx/sites-available/flexi2`, linked into sites-enabled.
5. Cron (`/etc/cron.d/flexi2`): hourly cache cleanup, nightly `pg_dump` to `/var/backups/flexi2`.
