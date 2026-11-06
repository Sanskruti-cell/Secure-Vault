"""
SecureVault Node Reliability Model Trainer
-------------------------------------------
Trains a scikit-learn LogisticRegression classifier to predict storage node health
and operational reliability score.

HONEST ARCHITECTURE & TARGET DEFINITION:
- Current training dataset is a controlled SYNTHETIC BOOTSTRAP DATASET (1,500 samples).
- It is NOT real historical data collected from production clusters.
- The model is clearly labeled as a 'bootstrap_model'.
- Operational features used:
  1. effective_latency_ms (observed avgLatencyMs or static baseline)
  2. failure_rate (failedOperations / totalOperations; 0.03 prior if totalOperations == 0)
  3. recent_failures (consecutive failure count)
  4. storage_util_pct (actual or simulated disk usage %)
  5. is_available (1.0 = online, 0.0 = offline or degraded)
- Ground Truth Target (y):
  Healthy (1) when:
    is_available == 1 AND recent_failures <= 1 AND failure_rate < 0.10 AND latency < 140 AND storage_util < 90
  Unhealthy/Degraded (0) otherwise.
"""

import os
import joblib
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

def train_and_save_model():
    np.random.seed(42)
    num_samples = 1500

    # 1. Latencies: 80% normal (10-80ms), 15% elevated (80-200ms), 5% severe (200-350ms)
    lat_normal = np.random.uniform(10, 80, int(num_samples * 0.80))
    lat_elevated = np.random.uniform(80, 200, int(num_samples * 0.15))
    lat_severe = np.random.uniform(200, 350, int(num_samples * 0.05))
    latencies = np.concatenate([lat_normal, lat_elevated, lat_severe])
    np.random.shuffle(latencies)

    # 2. Failure rates: 75% low (<0.05), 15% moderate (0.05-0.15), 10% high (0.15-0.60)
    fr_low = np.random.uniform(0.0, 0.05, int(num_samples * 0.75))
    fr_med = np.random.uniform(0.05, 0.15, int(num_samples * 0.15))
    fr_high = np.random.uniform(0.15, 0.60, int(num_samples * 0.10))
    failure_rates = np.concatenate([fr_low, fr_med, fr_high])
    np.random.shuffle(failure_rates)

    # 3. Recent consecutive failures: 80% 0 failures, 12% 1 failure, 8% 2-6 failures
    rf_zero = np.zeros(int(num_samples * 0.80))
    rf_one = np.ones(int(num_samples * 0.12))
    rf_multi = np.random.randint(2, 7, int(num_samples * 0.08))
    recent_failures = np.concatenate([rf_zero, rf_one, rf_multi])
    np.random.shuffle(recent_failures)

    # 4. Storage utilization %: uniform [15, 95]
    storage_utils = np.random.uniform(15, 95, num_samples)

    # 5. Availability: 88% online (1.0), 12% offline or degraded (0.0)
    availabilities = (np.random.uniform(0, 1, num_samples) < 0.88).astype(float)

    X = np.column_stack([latencies, failure_rates, recent_failures, storage_utils, availabilities])

    # Target rule: Healthy (1) if available, <=1 recent failure, failure_rate < 10%, latency < 140ms, storage < 90%
    y = (
        (availabilities == 1.0) &
        (recent_failures <= 1) &
        (failure_rates < 0.10) &
        (latencies < 140) &
        (storage_utils < 90)
    ).astype(int)

    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    model = LogisticRegression(random_state=42, max_iter=1000)
    model.fit(X_scaled, y)

    ml_dir = os.path.dirname(os.path.abspath(__file__))
    os.makedirs(ml_dir, exist_ok=True)

    metadata = {
        "model_source": "bootstrap_model",
        "dataset_type": "synthetic_bootstrap",
        "num_samples": num_samples,
        "features": ["effective_latency_ms", "failure_rate", "recent_failures", "storage_util_pct", "is_available"],
        "version": "2.0.0"
    }

    joblib.dump(model, os.path.join(ml_dir, 'node_health_model.joblib'))
    joblib.dump(scaler, os.path.join(ml_dir, 'scaler.joblib'))
    joblib.dump(metadata, os.path.join(ml_dir, 'model_metadata.joblib'))

    accuracy = model.score(X_scaled, y) * 100
    print(f"[Train] Logistic Regression Node Reliability Bootstrap Model trained (Accuracy: {accuracy:.2f}%)")
    print(f"[Train] Features: {metadata['features']}")
    print(f"[Train] Source tagged as: {metadata['model_source']}")

if __name__ == '__main__':
    train_and_save_model()
