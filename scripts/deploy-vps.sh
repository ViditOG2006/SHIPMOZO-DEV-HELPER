#!/usr/bin/env bash
# Bare-metal deploy on Ubuntu 22.04+ (no Docker). Run on the server as deploy user.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/shipmozo-dev-helper}"
REPO_URL="${1:-}"

if [[ -z "$REPO_URL" ]]; then
  echo "Usage: APP_DIR=/opt/shipmozo-dev-helper ./scripts/deploy-vps.sh <git-repo-url>"
  exit 1
fi

sudo apt-get update
sudo apt-get install -y curl git python3 python3-pip

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

sudo mkdir -p "$APP_DIR"
sudo chown -R "$USER:$USER" "$APP_DIR"

if [[ ! -d "$APP_DIR/.git" ]]; then
  git clone "$REPO_URL" "$APP_DIR"
else
  git -C "$APP_DIR" pull --ff-only
fi

cd "$APP_DIR"
npm ci --omit=dev
pip3 install --user -r requirements.txt
python3 -m playwright install chromium
python3 -m playwright install-deps chromium || true

cp -n .env.example .env 2>/dev/null || true
echo "Edit $APP_DIR/.env with API keys, then: sudo systemctl restart shipmozo-dev-helper"

sudo tee /etc/systemd/system/shipmozo-dev-helper.service >/dev/null <<EOF
[Unit]
Description=Shipmozo Dev Helper
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=PYTHON_BIN=python3
Environment=HOST=0.0.0.0
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable shipmozo-dev-helper
sudo systemctl restart shipmozo-dev-helper
sudo systemctl status shipmozo-dev-helper --no-pager
