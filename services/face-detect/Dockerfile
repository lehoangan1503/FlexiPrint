# face-detect — OpenCV face detection + face parsing + crop behind FastAPI. ~300 MB image, CPU only.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py ./
# Bake the YuNet + face-parsing models into the image (app.py would otherwise download them on first start).
RUN python -c "import app"
EXPOSE 7004
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:7004/health')"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7004", "--workers", "2"]
