#!/usr/bin/env bash
# Run layer-kit on this machine without Docker (Python 3.11–3.13 + uv).
#   ./run-local.sh            → http://127.0.0.1:7005
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -x .venv/bin/uvicorn ]; then
  uv venv --python "${PYTHON:-python3.12}" .venv
  uv pip install --python .venv/bin/python -r requirements.txt
fi
if [ ! -f weights/realesr-animevideov3.pth ]; then
  mkdir -p weights
  curl -fsSL -o weights/realesr-animevideov3.pth https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-animevideov3.pth
fi
exec .venv/bin/uvicorn app:app --host "${HOST:-127.0.0.1}" --port "${PORT:-7005}"
