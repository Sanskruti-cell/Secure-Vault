#!/usr/bin/env bash
# ==============================================================================
# SecureVault – Automated Installation Script
# Installs dependencies for Frontend, Backend, and Python ML Service
# ==============================================================================

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "🚀 [SecureVault] Beginning installation across all services..."
echo "📂 Root Directory: ${PROJECT_ROOT}"

# 1. Frontend Dependencies
echo ""
echo "📦 [1/3] Installing Frontend Dependencies..."
cd "${PROJECT_ROOT}"
npm install

# 2. Backend Dependencies
echo ""
echo "📦 [2/3] Installing Backend Dependencies..."
cd "${PROJECT_ROOT}/backend"
npm install

# 3. Python ML Service Dependencies
echo ""
echo "🐍 [3/3] Installing Python ML Service Dependencies..."
cd "${PROJECT_ROOT}/backend/ml"
if command -v python3 &>/dev/null; then
    if [ ! -d "venv" ]; then
        echo "Creating Python virtual environment in backend/ml/venv..."
        python3 -m venv venv
    fi
    source venv/bin/activate
    pip install --upgrade pip
    pip install -r requirements.txt
    deactivate
    echo "✔ Python ML virtual environment ready."
else
    echo "⚠️ Python3 not found in PATH. Skipping virtual environment creation."
fi

# Ensure .env exists if not present
cd "${PROJECT_ROOT}"
if [ ! -f ".env" ] && [ -f ".env.example" ]; then
    cp .env.example .env
    echo "✔ Created root .env from .env.example"
fi

if [ ! -f "backend/.env" ] && [ -f "backend/.env.example" ]; then
    cp backend/.env.example backend/.env
    echo "✔ Created backend/.env from backend/.env.example"
fi

echo ""
echo "✅ [SecureVault] Installation successfully completed!"
echo "👉 Run ./scripts/start.sh to launch the full cluster."
