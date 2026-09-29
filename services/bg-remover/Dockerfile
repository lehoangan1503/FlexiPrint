# bg-remover — rembg + BiRefNet behind FastAPI. CPU image; ~1.3 GB with the model baked in.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    BG_MODEL=birefnet-general \
    U2NET_HOME=/models

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Bake the model into the image so a cold start never downloads 1 GB.
ARG BG_MODEL=birefnet-general
RUN python -c "from rembg import new_session; new_session('${BG_MODEL}')"

COPY app.py .
EXPOSE 7001
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:7001/health')"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7001", "--workers", "1"]
