#!/usr/bin/env bash
# Run the ComfyUI studio on this machine without Docker (started by `npm run dev`).
#   ./run-local.sh   → http://localhost:8188  (the app's /studio frames it: CT_STUDIO_URL=http://localhost:8188/)
# First run clones ComfyUI into .comfy/ (gitignored) + a venv with CPU torch (~2 GB, a few minutes).
# The FlexiPrint node pack is symlinked from custom_nodes/flexiprint, so edits here are live after a restart
# (JS edits: just reload the page). Keys come from the repo's .env.local.
set -euo pipefail
cd "$(dirname "$0")"
REF="${COMFY_REF:-v0.38.0}"
if [ ! -f .comfy/main.py ]; then
  git clone --depth 1 --branch "$REF" https://github.com/comfyanonymous/ComfyUI.git .comfy
fi
if [ ! -x .comfy/.venv/bin/python ] || ! .comfy/.venv/bin/python -c "import torch, aiohttp" 2>/dev/null; then
  "${PYTHON:-python3.12}" -m venv .comfy/.venv
  .comfy/.venv/bin/pip install -q --upgrade pip
  .comfy/.venv/bin/pip install -q torch torchvision torchaudio
  .comfy/.venv/bin/pip install -q -r .comfy/requirements.txt
fi
ln -sfn "$PWD/custom_nodes/flexiprint" .comfy/custom_nodes/flexiprint

# Keys from the app's .env.local (same names the VPS uses).
ENV_FILE="../../.env.local"
get() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
export FP_API_URL="${FP_API_URL:-http://127.0.0.1:3000/api/customize-tool}"
export FP_COMFY_TOKEN="${FP_COMFY_TOKEN:-$(get CT_COMFY_TOKEN)}"
export CPA_BASE_URL="${CPA_BASE_URL:-$(get CPA_BASE_URL)}"
export CPA_API_KEY="${CPA_API_KEY:-$(get CPA_API_KEY)}"
export FAL_KEY="${FAL_KEY:-$(get FAL_KEY)}"

cd .comfy
exec .venv/bin/python main.py --cpu --listen 127.0.0.1 --port "${PORT:-8188}" --disable-smart-memory --cache-lru 8 --disable-auto-launch
