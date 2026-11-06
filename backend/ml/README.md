# SecureVault – ML-Powered Storage Node Reliability Microservice

## Overview
The Python ML service continuously monitors storage cluster telemetry across all storage nodes (AWS S3, Azure Blob, Google Cloud Storage, and edge storage instances). It provides dynamic reliability scoring and health classification using a trained `scikit-learn` Logistic Regression and Random Forest classifier, with automatic deterministic heuristic failover.

The predictions are consumed by `backend/src/services/nodeService.js` to rank and select the optimal $K=4$ data nodes and $M=2$ parity nodes for Reed-Solomon $(4+2)$ shard distribution.

---

## Telemetry Feature Vector
The model ingests 5 core operational dimensions per node:
1. **Effective Latency ($ms$)**: Exponential moving average of ping and I/O latency.
2. **Failure Rate**: Cumulative ratio of failed operations to total operations ($f_{failed} / f_{total}$). Unmeasured nodes receive an honest prior (3%).
3. **Recent Consecutive Failures**: Count of failures in the active sliding window.
4. **Storage Utilization (%)**: Disk space percentage currently consumed.
5. **Node Availability**: Binary flag ($1.0$ online, $0.0$ offline or simulated failure).

---

## REST API Endpoints

### 1. `GET /health`
Returns service status, model loading state, and active feature list.
```json
{
  "status": "online",
  "model": "scikit-learn LogisticRegression",
  "in_memory": true,
  "model_loaded": true,
  "model_source": "bootstrap_model",
  "features": ["effective_latency_ms", "failure_rate", "recent_failures", "storage_util_pct", "is_available"]
}
```

### 2. `POST /predict`
Evaluates a batch of storage nodes and returns reliability scores ($0-100\%$) and health status.
**Request Body**:
```json
{
  "nodes": [
    {
      "nodeId": "node-01",
      "name": "AWS-S3-US-EAST",
      "status": "online",
      "avgLatencyMs": 42.5,
      "totalOperations": 1250,
      "failedOperations": 3,
      "recentFailures": 0,
      "storageUtil": 38.2
    }
  ]
}
```
**Response**:
```json
{
  "success": true,
  "source": "bootstrap_model",
  "predictions": [
    {
      "nodeId": "node-01",
      "name": "AWS-S3-US-EAST",
      "isHealthy": true,
      "reliabilityScore": 99.4,
      "status": "Healthy",
      "predictionSource": "bootstrap_model",
      "telemetry": {
        "effectiveLatencyMs": 42.5,
        "failureRate": 0.0024,
        "recentFailures": 0,
        "totalOperations": 1250,
        "failedOperations": 3
      }
    }
  ]
}
```

---

## Installation & Running

### Requirements
- Python 3.9+
- Packages in `requirements.txt` (`Flask`, `scikit-learn`, `numpy`, `joblib`, `gunicorn`)

### Quickstart
```bash
# Navigate to ml directory
cd backend/ml

# Install dependencies
pip install -r requirements.txt

# (Optional) Re-train the model assets
python train_model.py

# Run development server
python ml_service.py

# Run production server with Gunicorn
gunicorn -w 2 -b 0.0.0.0:5001 ml_service:app
```
