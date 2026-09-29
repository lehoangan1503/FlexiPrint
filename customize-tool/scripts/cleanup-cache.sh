#!/usr/bin/env bash
#
# Deletes cached customer-photo results (AI styles, cut-outs) 24 h after they
# were uploaded — POST /api/customize-tool/cron/cleanup.
#
# The cache (customize-tool-cache/photo/<sha256>.png in the Storage bucket) only
# saves money and time: a deleted entry is simply recomputed on the next
# request. Customer uploads attached to orders (customize-tool-orders/…) are
# never touched.
#
# INSTALL ON THE VPS
#
#   1. install -m 755 customize-tool/scripts/cleanup-cache.sh /usr/local/bin/ct-cleanup-cache.sh
#   2. printf 'APP_BASE_URL=https://tool.example.com\nCT_CRON_SECRET=xxxx\n' > /etc/ct-cleanup.env
#      chmod 600 /etc/ct-cleanup.env          (same CT_CRON_SECRET as the app's .env)
#   3. crontab -e — hourly at :23 (the render purge uses :17):
#        23 * * * * CT_ENV_FILE=/etc/ct-cleanup.env /usr/local/bin/ct-cleanup-cache.sh >> /var/log/ct-cleanup.log 2>&1
#   4. Test now: CT_ENV_FILE=/etc/ct-cleanup.env /usr/local/bin/ct-cleanup-cache.sh
#
# Nothing breaks if this never runs: the app also sweeps at most once an hour
# when it writes a new cache entry. With R2 later, a bucket lifecycle rule on
# the prefix replaces this job (see customize-tool/server/blob-store.ts).

set -euo pipefail

if [ -n "${CT_ENV_FILE:-}" ] && [ -f "$CT_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$CT_ENV_FILE"
  set +a
fi

APP_BASE_URL="${APP_BASE_URL:-}"
SECRET="${CT_CRON_SECRET:-}"
if [ -z "$APP_BASE_URL" ] || [ -z "$SECRET" ]; then
  echo "$(date -Is) [ct-cleanup] ERROR: APP_BASE_URL and CT_CRON_SECRET must be set" >&2
  exit 1
fi

URL="${APP_BASE_URL%/}/api/customize-tool/cron/cleanup"
for round in $(seq 1 "${CT_CLEANUP_MAX_ROUNDS:-20}"); do
  if ! BODY=$(curl -sS --max-time 300 --fail-with-body -X POST -H "Authorization: Bearer $SECRET" "$URL"); then
    echo "$(date -Is) [ct-cleanup] request failed: ${BODY:-no response}" >&2
    exit 1
  fi
  echo "$(date -Is) [ct-cleanup] $BODY"
  case "$BODY" in
    *'"more":true'*) continue ;;
    *) break ;;
  esac
done
