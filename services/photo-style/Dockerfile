# photo-style — OpenCV art filters behind FastAPI. No model download; ~250 MB image.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py styles.py ./
EXPOSE 7002
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:7002/health')"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7002", "--workers", "2"]
