#!/usr/bin/env bash
# ==============================================================================
# SecureVault – Complete System Verification Suite
# Executes cryptographic tests, Reed-Solomon 4+2 tests, deduplication, and E2E
# ==============================================================================

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_ROOT}/backend"

echo "================================================================================"
echo "          SecureVault System & Cryptographic Verification Suite                 "
echo "================================================================================"

echo ""
echo "🔐 [1/4] Running Client Envelope AES-256-GCM / PBKDF2 / DEK Tests..."
node test_crypto_v2.js

echo ""
echo "🧩 [2/4] Running Reed-Solomon 4+2 Cauchy Matrix Erasure Coding Tests..."
node test_reed_solomon_42.js

echo ""
echo "♻️  [3/4] Running Content-Addressed Chunk Deduplication Tests..."
node test_dedup_e2e_verification.js

echo ""
echo "🌐 [4/4] Running Comprehensive End-to-End Workflow Verification..."
node test_comprehensive_e2e.mjs

echo ""
echo "================================================================================"
echo "🎉 ALL TESTS PASSED SUCCESSFULLY! ZERO COMPROMISES."
echo "================================================================================"
