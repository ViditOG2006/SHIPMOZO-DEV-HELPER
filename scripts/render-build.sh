#!/usr/bin/env bash
# Render native Node web service build (no Docker).
set -euo pipefail

echo "[render-build] npm ci..."
npm ci

echo "[render-build] Python + Playwright (panel screenshots / E2E)..."
if command -v python3 >/dev/null 2>&1; then
  python3 -m pip install --upgrade pip
  python3 -m pip install -r requirements.txt
  python3 -m playwright install chromium || echo "[render-build] WARN: playwright browser install failed (non-fatal)"
else
  echo "[render-build] WARN: python3 not found - UI/API will run; screenshots/E2E need Python"
fi

mkdir -p output data
echo "[render-build] done"
