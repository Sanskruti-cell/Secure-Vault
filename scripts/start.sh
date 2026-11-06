#!/usr/bin/env bash
# ==============================================================================
# SecureVault – Multi-Service Startup Script
# Concurrently boots Python ML Service, Node.js Backend API, and Vite Frontend
# ==============================================================================

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_ROOT}"

echo "================================================================================"
echo "          SecureVault – Decentralized Encrypted Cloud Storage Mesh              "
echo "================================================================================"

trap 'echo ""; echo "🛑 Stopping all services..."; kill $(jobs -p) 2>/dev/null; exit' SIGINT SIGTERM EXIT

# 1. Start Python ML Microservice (Port 5001)
echo "🐍 [1/3] Starting Python ML Node Reliability Service (Port 5001)..."
cd "${PROJECT_ROOT}/backend/ml"
if [ -d "venv" ]; then
    source venv/bin/activate
fi
python3 ml_service.py &
ML_PID=$!
cd "${PROJECT_ROOT}"

# Give ML service a moment to initialize
sleep 1

# 2. Start Core Express Backend API (Port 5002)
echo "⚙️  [2/3] Starting SecureVault Backend API Server (Port 5002)..."
cd "${PROJECT_ROOT}/backend"
node src/server.js &
BACKEND_PID=$!
cd "${PROJECT_ROOT}"

# Give backend a moment to bind
sleep 1

# 3. Start Vite React Frontend (Port 5173)
echo "💻 [3/3] Starting SecureVault React 3D Frontend (Port 5173)..."
npm run dev &
FRONTEND_PID=$!

echo ""
echo "================================================================================"
echo "✔ SecureVault Storage Cluster is Online!"
echo "  • Frontend Web UI:  http://localhost:5173"
echo "  • Backend API:      http://localhost:5002"
echo "  • Python ML Bridge: http://localhost:5001"
echo "  • Press [Ctrl+C] to gracefully stop all services."
echo "================================================================================"
echo ""

wait
