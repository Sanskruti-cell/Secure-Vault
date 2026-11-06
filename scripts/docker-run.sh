#!/usr/bin/env bash
# ==============================================================================
# SecureVault – Production Docker Deployment Script
# ==============================================================================

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_ROOT}"

echo "🐳 [SecureVault Docker] Building and launching orchestrated containers..."

docker compose down --remove-orphans || true
docker compose build
docker compose up -d

echo ""
echo "⏳ Waiting for cluster containers to report healthy..."
sleep 5

docker compose ps

echo ""
echo "✔ SecureVault Docker cluster deployed successfully!"
echo "  • Access the Web Application at: http://localhost:5173"
echo "  • Backend API endpoint:         http://localhost:5002/api/health"
echo "  • Python ML service endpoint:    http://localhost:5001/health"
