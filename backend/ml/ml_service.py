import os
import math
import joblib
import numpy as np
from flask import Flask, request, jsonify

app = Flask(__name__)

ML_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(ML_DIR, 'node_health_model.joblib')
SCALER_PATH = os.path.join(ML_DIR, 'scaler.joblib')
META_PATH = os.path.join(ML_DIR, 'model_metadata.joblib')

model = None
scaler = None
model_source = "heuristic_fallback"
model_features = []

def load_ml_assets():
    global model, scaler, model_source, model_features
    try:
        if os.path.exists(MODEL_PATH) and os.path.exists(SCALER_PATH):
            model = joblib.load(MODEL_PATH)
            scaler = joblib.load(SCALER_PATH)
            if os.path.exists(META_PATH):
                meta = joblib.load(META_PATH)
                model_source = meta.get("model_source", "bootstrap_model")
                model_features = meta.get("features", [])
            else:
                model_source = "bootstrap_model"
            print(f"[ML Service] Successfully loaded {model_source} into memory.")
        else:
            print("[ML Service Notice] Model files not found. Operating in deterministic heuristic fallback mode.")
            model = None
            scaler = None
            model_source = "heuristic_fallback"
    except Exception as e:
        print(f"[ML Service Warning] Failed to load model files: {e}. Falling back to heuristic mode.")
        model = None
        scaler = None
        model_source = "heuristic_fallback"

load_ml_assets()

def calculate_heuristic_prediction(node_id, name, eff_latency, failure_rate, recent_failures, is_available, is_unmeasured, total_ops, failed_ops):
    """
    Deterministic rule-based fallback when model is absent or prediction fails.
    """
    if is_available == 0.0:
        return {
            "nodeId": node_id,
            "name": name,
            "isHealthy": False,
            "reliabilityScore": 25.0,
            "status": "Degraded/Unhealthy",
            "predictionSource": "heuristic_fallback",
            "telemetry": {
                "effectiveLatencyMs": round(eff_latency, 2),
                "failureRate": round(failure_rate, 4),
                "isFailureRateUnmeasured": is_unmeasured,
                "recentFailures": recent_failures,
                "totalOperations": total_ops,
                "failedOperations": failed_ops
            }
        }

    if recent_failures >= 2:
        return {
            "nodeId": node_id,
            "name": name,
            "isHealthy": False,
            "reliabilityScore": 45.0,
            "status": "Degraded/Unhealthy",
            "predictionSource": "heuristic_fallback",
            "telemetry": {
                "effectiveLatencyMs": round(eff_latency, 2),
                "failureRate": round(failure_rate, 4),
                "isFailureRateUnmeasured": is_unmeasured,
                "recentFailures": recent_failures,
                "totalOperations": total_ops,
                "failedOperations": failed_ops
            }
        }

    # Base score: 100 - penalties
    lat_penalty = min(20.0, eff_latency / 10.0)
    fail_penalty = failure_rate * 45.0
    rec_penalty = recent_failures * 15.0
    raw_score = 100.0 - lat_penalty - fail_penalty - rec_penalty
    reliability_score = round(max(5.0, min(99.5, raw_score)), 2)

    is_healthy = bool(reliability_score >= 65.0 and failure_rate < 0.15)
    return {
        "nodeId": node_id,
        "name": name,
        "isHealthy": is_healthy,
        "reliabilityScore": reliability_score,
        "status": "Healthy" if is_healthy else "Degraded/Unhealthy",
        "predictionSource": "heuristic_fallback",
        "telemetry": {
            "effectiveLatencyMs": round(eff_latency, 2),
            "failureRate": round(failure_rate, 4),
            "isFailureRateUnmeasured": is_unmeasured,
            "recentFailures": recent_failures,
            "totalOperations": total_ops,
            "failedOperations": failed_ops
        }
    }

@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        "status": "online",
        "model": "scikit-learn LogisticRegression",
        "in_memory": True,
        "model_loaded": model is not None,
        "model_source": model_source,
        "features": model_features or ["effective_latency_ms", "failure_rate", "recent_failures", "storage_util_pct", "is_available"]
    })

@app.route('/predict', methods=['POST'])
def predict_nodes():
    try:
        data = request.get_json(silent=True)
        if not data or not isinstance(data, dict):
            return jsonify({"success": False, "error": "Invalid JSON body"}), 400

        nodes = data.get('nodes')
        if not isinstance(nodes, list) or len(nodes) == 0:
            return jsonify({"success": False, "error": "Invalid payload: 'nodes' must be a non-empty list"}), 400

        feature_vectors = []
        parsed_nodes_meta = []

        # Validate and extract features for each node
        for idx, n in enumerate(nodes):
            if not isinstance(n, dict):
                return jsonify({"success": False, "error": f"Node at index {idx} must be a JSON object"}), 400

            node_id = str(n.get('nodeId') or n.get('id') or f"node-{idx+1}")
            node_name = n.get('name') or node_id

            # 1. Total Operations & Failed Operations
            raw_total_ops = n.get('totalOperations', 0)
            raw_failed_ops = n.get('failedOperations', 0)

            # Check for non-finite values
            for val_name, val in [('totalOperations', raw_total_ops), ('failedOperations', raw_failed_ops)]:
                if isinstance(val, (int, float)) and not np.isfinite(val):
                    return jsonify({"success": False, "error": f"Field '{val_name}' on {node_id} contains non-finite number"}), 400

            try:
                total_ops = int(raw_total_ops or 0)
                failed_ops = int(raw_failed_ops or 0)
            except (ValueError, TypeError):
                return jsonify({"success": False, "error": f"Invalid integer for totalOperations/failedOperations on {node_id}"}), 400

            if total_ops < 0 or failed_ops < 0:
                return jsonify({"success": False, "error": f"Operation counts on {node_id} cannot be negative"}), 400

            # 2. Failure Rate
            if total_ops > 0:
                failure_rate = min(1.0, max(0.0, failed_ops / total_ops))
                is_unmeasured = False
            else:
                # Honest handling: unmeasured node receives neutral prior (0.03), not 0% perfect nor 100% broken
                failure_rate = 0.03
                is_unmeasured = True

            # 3. Recent Failures
            raw_rf = n.get('recentFailures')
            if raw_rf is None:
                raw_rf = n.get('failures', 0)

            if isinstance(raw_rf, (int, float)) and not np.isfinite(raw_rf):
                return jsonify({"success": False, "error": f"Field 'recentFailures' on {node_id} contains non-finite number"}), 400

            try:
                recent_failures = int(raw_rf or 0)
            except (ValueError, TypeError):
                return jsonify({"success": False, "error": f"Invalid integer for recentFailures on {node_id}"}), 400

            if recent_failures < 0:
                return jsonify({"success": False, "error": f"recentFailures on {node_id} cannot be negative"}), 400

            # 4. Latency
            raw_avg_lat = n.get('avgLatencyMs')
            raw_static_lat = n.get('latency', 50)

            for val_name, val in [('avgLatencyMs', raw_avg_lat), ('latency', raw_static_lat)]:
                if val is not None and isinstance(val, (int, float)) and not np.isfinite(val):
                    return jsonify({"success": False, "error": f"Field '{val_name}' on {node_id} contains non-finite number"}), 400

            if raw_avg_lat is not None:
                try:
                    eff_latency = float(raw_avg_lat)
                    if eff_latency < 0:
                        return jsonify({"success": False, "error": f"avgLatencyMs on {node_id} cannot be negative"}), 400
                    is_lat_measured = True
                except (ValueError, TypeError):
                    return jsonify({"success": False, "error": f"Invalid number for avgLatencyMs on {node_id}"}), 400
            else:
                try:
                    eff_latency = float(raw_static_lat or 50.0)
                    if eff_latency < 0:
                        eff_latency = 50.0
                except (ValueError, TypeError):
                    eff_latency = 50.0
                is_lat_measured = False

            eff_latency = max(1.0, min(1000.0, eff_latency))

            # 5. Storage Utilization
            raw_storage_util = n.get('storageUtil', 50.0)
            if isinstance(raw_storage_util, (int, float)) and not np.isfinite(raw_storage_util):
                return jsonify({"success": False, "error": f"Field 'storageUtil' on {node_id} contains non-finite number"}), 400
            try:
                storage_util = max(0.0, min(100.0, float(raw_storage_util or 50.0)))
            except (ValueError, TypeError):
                storage_util = 50.0

            # 6. Availability
            status = str(n.get('status', 'online')).lower()
            is_sim_fail = bool(n.get('isSimulatedFailure', False))
            is_available = 0.0 if (status in ['offline', 'degraded', 'unhealthy'] or is_sim_fail) else 1.0

            meta_entry = {
                "nodeId": node_id,
                "name": node_name,
                "eff_latency": eff_latency,
                "failure_rate": failure_rate,
                "recent_failures": recent_failures,
                "storage_util": storage_util,
                "is_available": is_available,
                "is_unmeasured": is_unmeasured,
                "is_lat_measured": is_lat_measured,
                "total_ops": total_ops,
                "failed_ops": failed_ops
            }
            parsed_nodes_meta.append(meta_entry)
            feature_vectors.append([eff_latency, failure_rate, float(recent_failures), storage_util, is_available])

        # If model is not loaded, use heuristic fallback
        if model is None or scaler is None:
            results = [
                calculate_heuristic_prediction(
                    m["nodeId"], m["name"], m["eff_latency"], m["failure_rate"],
                    m["recent_failures"], m["is_available"], m["is_unmeasured"],
                    m["total_ops"], m["failed_ops"]
                )
                for m in parsed_nodes_meta
            ]
            return jsonify({
                "success": True,
                "source": "heuristic_fallback",
                "predictions": results
            })

        # Run model prediction
        try:
            X = np.array(feature_vectors)
            X_scaled = scaler.transform(X)
            probabilities = model.predict_proba(X_scaled)[:, 1]
            predictions = model.predict(X_scaled)

            results = []
            for i, m in enumerate(parsed_nodes_meta):
                prob = float(probabilities[i])
                pred_label = int(predictions[i])

                # Bound reliability score safely in [5.0, 99.9]
                reliability_score = round(max(5.0, min(99.9, prob * 100)), 2)

                # Node is healthy if model classified healthy AND availability holds AND low failure rate
                is_healthy = bool(
                    m["is_available"] == 1.0 and
                    pred_label == 1 and
                    prob >= 0.50 and
                    m["recent_failures"] <= 1 and
                    m["failure_rate"] < 0.20
                )

                status_str = "Healthy" if is_healthy else "Degraded/Unhealthy"

                results.append({
                    "nodeId": m["nodeId"],
                    "name": m["name"],
                    "isHealthy": is_healthy,
                    "reliabilityScore": reliability_score,
                    "status": status_str,
                    "predictionSource": model_source,
                    "telemetry": {
                        "effectiveLatencyMs": round(m["eff_latency"], 2),
                        "isLatencyMeasured": m["is_lat_measured"],
                        "failureRate": round(m["failure_rate"], 4),
                        "isFailureRateUnmeasured": m["is_unmeasured"],
                        "recentFailures": m["recent_failures"],
                        "totalOperations": m["total_ops"],
                        "failedOperations": m["failed_ops"]
                    }
                })

            return jsonify({
                "success": True,
                "source": model_source,
                "predictions": results
            })

        except Exception as pred_err:
            print(f"[ML Service Warning] Prediction error: {pred_err}. Using heuristic fallback.")
            results = [
                calculate_heuristic_prediction(
                    m["nodeId"], m["name"], m["eff_latency"], m["failure_rate"],
                    m["recent_failures"], m["is_available"], m["is_unmeasured"],
                    m["total_ops"], m["failed_ops"]
                )
                for m in parsed_nodes_meta
            ]
            return jsonify({
                "success": True,
                "source": "heuristic_fallback",
                "predictions": results
            })

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

if __name__ == '__main__':
    host = os.environ.get('HOST', '127.0.0.1')
    port = int(os.environ.get('PORT', 5001))
    print(f"[ML Service] Starting Node Reliability Server on http://{host}:{port}")
    app.run(host=host, port=port, debug=False)
