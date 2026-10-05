#!/usr/bin/env bash
# Run face-detect on this machine without Docker (Python 3.11–3.13 + uv).
#   ./run-local.sh            → http://127.0.0.1:7004
# First start downloads the YuNet face model (~230 KB) and the face-parsing model (~50 MB) to ./models.
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -x .venv/bin/uvicorn ]; then
  uv venv --python "${PYTHON:-python3.12}" .venv
  uv pip install --python .venv/bin/python -r requirements.txt
fi
exec .venv/bin/uvicorn app:app --host "${HOST:-127.0.0.1}" --port "${PORT:-7004}"
