#!/usr/bin/env bash
# Render native Node web service build (no Docker).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Browsers must live inside the deploy artifact — /opt/render/.cache does NOT persist to runtime.
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$ROOT_DIR/.playwright-browsers}"
mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"

retry() {
  local max_attempts=$1
  shift
  local attempt=1
  while true; do
    if "$@"; then
      return 0
    fi
    if (( attempt >= max_attempts )); then
      return 1
    fi
    echo "[render-build] WARN: command failed (attempt ${attempt}/${max_attempts}); retrying in 5s..."
    sleep 5
    attempt=$((attempt + 1))
  done
}

verify_playwright_browsers() {
  if find "$PLAYWRIGHT_BROWSERS_PATH" -maxdepth 6 -type f \( -name 'chrome-headless-shell' -o -name 'chrome' \) 2>/dev/null | head -1 | grep -q .; then
    echo "[render-build] Playwright Chromium verified under $PLAYWRIGHT_BROWSERS_PATH"
    return 0
  fi
  echo "[render-build] ERROR: Playwright Chromium not found under $PLAYWRIGHT_BROWSERS_PATH after install"
  ls -laR "$PLAYWRIGHT_BROWSERS_PATH" 2>/dev/null || true
  return 1
}

echo "[render-build] npm ci..."
npm ci

echo "[render-build] Python + Playwright (panel screenshots / E2E)..."
if ! command -v python3 >/dev/null 2>&1; then
  echo "[render-build] ERROR: python3 not found - required for screenshots/E2E"
  exit 1
fi

python3 -m pip install --upgrade pip
echo "[render-build] requirements.txt playwright pin: $(grep -E '^playwright==' requirements.txt || true)"
python3 -m pip install -r requirements.txt

echo "[render-build] Installing Playwright Chromium (Python, path=$PLAYWRIGHT_BROWSERS_PATH)..."
if ! retry 3 python3 -m playwright install chromium; then
  echo "[render-build] ERROR: python3 -m playwright install chromium failed after 3 attempts"
  exit 1
fi

echo "[render-build] Installing Playwright Chromium (Node, path=$PLAYWRIGHT_BROWSERS_PATH)..."
if ! retry 3 npx playwright install chromium; then
  echo "[render-build] ERROR: npx playwright install chromium failed after 3 attempts"
  exit 1
fi

if ! verify_playwright_browsers; then
  exit 1
fi

mkdir -p output data
echo "[render-build] done"
