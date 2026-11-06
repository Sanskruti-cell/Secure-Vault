# Production Dockerfile for SecureVault Python ML Service
FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY backend/ml/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy ML microservice code and pre-trained model artifacts
COPY backend/ml/ ./

EXPOSE 5001

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:5001/health')" || exit 1

CMD ["gunicorn", "--bind", "0.0.0.0:5001", "--workers", "2", "--timeout", "60", "ml_service:app"]
