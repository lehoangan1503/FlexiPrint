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
# Real-ESRGAN realesr-animevideov3 (BSD-3).
RUN mkdir -p weights && curl -fsSL -o weights/realesr-animevideov3.pth \
      https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-animevideov3.pth \
    && echo "b8a8376811077954d82ca3fcf476f1ac3da3e8a68a4f4d71363008000a18b75d  weights/realesr-animevideov3.pth" | sha256sum -c -
COPY app.py layers.py upscale.py ./
EXPOSE 7005
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:7005/health')"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7005", "--workers", "1"]
