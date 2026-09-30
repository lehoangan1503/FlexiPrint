# ComfyUI studio for FlexiPrint — CPU only, no local models: every image model
# is an HTTP call from the FlexiPrint node pack (fal.ai, cpa.next.lc), so this
# runs on the small VPS next to the app (~400–500 MB RSS idle).
FROM python:3.12-slim

ARG COMFY_REF=v0.38.0
ENV PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends git libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt
RUN git clone --depth 1 --branch ${COMFY_REF} https://github.com/comfyanonymous/ComfyUI.git comfy \
 && pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu \
 && pip install -r comfy/requirements.txt

COPY custom_nodes/flexiprint /opt/comfy/custom_nodes/flexiprint

WORKDIR /opt/comfy
EXPOSE 8188
# --cache-lru: keep a few node results (re-running a graph doesn't re-bill the API)
# without growing RAM; --disable-smart-memory: nothing to keep on a GPU anyway.
CMD ["python", "main.py", "--cpu", "--listen", "0.0.0.0", "--port", "8188", "--disable-smart-memory", "--cache-lru", "8", "--disable-auto-launch"]
