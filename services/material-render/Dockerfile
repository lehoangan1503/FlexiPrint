# material-render — print files + product renders (OpenCV). No model; ~250 MB image.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py material.py ./
EXPOSE 7003
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:7003/health')"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7003", "--workers", "2"]
