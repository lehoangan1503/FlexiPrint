#!/usr/bin/env bash
# Run bg-remover on this machine without Docker (Python 3.11–3.13 + uv).
#   ./run-local.sh            → http://127.0.0.1:7001
# First start downloads the model (~1 GB for birefnet-general) to ~/.rembg/models.
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -x .venv/bin/uvicorn ]; then
  uv venv --python "${PYTHON:-python3.12}" .venv
  uv pip install --python .venv/bin/python -r requirements.txt
fi
exec .venv/bin/uvicorn app:app --host "${HOST:-127.0.0.1}" --port "${PORT:-7001}"
