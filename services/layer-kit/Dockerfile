# layer-kit — layer sets from a paper doll + options drawn on it (OpenCV/numpy, cut by difference), print upscale
# (Real-ESRGAN), all on CPU.
# No matting: gpt-image draws every picture on a transparent background.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Real-ESRGAN realesr-general-x4v3 (BSD-3). animevideov3 until 2026-10-30: it flattened fur and hair strands into
# waxy stripes (the cut picture looked worse than its 3b).
RUN mkdir -p weights && curl -fsSL -o weights/realesr-general-x4v3.pth \
      https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth \
    && echo "8dc7edb9ac80ccdc30c3a5dca6616509367f05fbc184ad95b731f05bece96292  weights/realesr-general-x4v3.pth" | sha256sum -c -
COPY app.py layers.py upscale.py ./
EXPOSE 7005
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:7005/health')"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7005", "--workers", "1"]
