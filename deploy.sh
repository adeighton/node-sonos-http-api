#!/usr/bin/env bash
#
# Deploy the Sonos HTTP API to the Raspberry Pi.
#
# Syncs the project with rsync (honouring .gitignore, so node_modules, cache, settings.json and
# .env are never copied), installs the production dependencies, writes the systemd unit and
# restarts the service.
#
# Prerequisites on the Pi:
#   - passwordless SSH for ${SERVER_USER}
#   - Node.js 24 or newer (nvm or a system install)
#   - ~/${REMOTE_DIRECTORY}/.env with the AWS credentials (never rsynced):
#       scp .env pi@man-in-the-ceiling.local:node-sonos-http-api/.env
#   - ~/${REMOTE_DIRECTORY}/settings.json, if you use one (rsynced from here on purpose)
set -euo pipefail

# ===== CONFIGURATION =====
SERVER_NAME="man-in-the-ceiling.local"
SERVER_USER="pi"
REMOTE_DIRECTORY="node-sonos-http-api"
SERVICE_NAME="sonos"
MIN_NODE_MAJOR=24
# =========================

REMOTE_HOST="${REMOTE_HOST:-${SERVER_USER}@${SERVER_NAME}}"
REMOTE_DIR="${REMOTE_DIR:-~/${REMOTE_DIRECTORY}/}"
# Non-interactive SSH shells skip .bashrc, so nvm is loaded by hand before every remote command.
LOAD_NVM='export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true'

remote() {
  ssh "${REMOTE_HOST}" "${LOAD_NVM}; $*"
}

echo "🚀 Deploying ${SERVICE_NAME} to ${REMOTE_HOST}..."

echo "🔍 Checking Node.js on the remote system..."
REMOTE_NODE_PATH=$(remote 'command -v node' || true)
if [ -z "${REMOTE_NODE_PATH}" ]; then
  echo "❌ Could not find 'node' on ${REMOTE_HOST} (install Node ${MIN_NODE_MAJOR}+ with nvm or apt)."
  exit 1
fi
REMOTE_NODE_VERSION=$(remote "'${REMOTE_NODE_PATH}' -v")
REMOTE_NODE_MAJOR=${REMOTE_NODE_VERSION#v}
REMOTE_NODE_MAJOR=${REMOTE_NODE_MAJOR%%.*}
if [ "${REMOTE_NODE_MAJOR}" -lt "${MIN_NODE_MAJOR}" ]; then
  echo "❌ ${REMOTE_HOST} runs Node ${REMOTE_NODE_VERSION}; this server needs Node ${MIN_NODE_MAJOR} or newer."
  echo "   On the Pi: nvm install ${MIN_NODE_MAJOR} && nvm alias default ${MIN_NODE_MAJOR}"
  exit 1
fi
echo "✅ Found Node.js ${REMOTE_NODE_VERSION} at ${REMOTE_NODE_PATH}"

echo "🔐 Checking for .env on the remote system..."
if ! remote "test -f ${REMOTE_DIR}.env"; then
  echo "❌ ${REMOTE_HOST}:${REMOTE_DIR}.env is missing. It holds the AWS credentials and is never rsynced."
  echo "   Provision it once with: scp .env ${REMOTE_HOST}:${REMOTE_DIR}.env"
  exit 1
fi
echo "✅ .env is present"

echo "📦 Syncing files..."
rsync -az --delete \
  --include='settings.json' \
  --exclude='.git' \
  --exclude='.github' \
  --exclude='deploy.sh' \
  --exclude='coverage' \
  --exclude='static/tts' \
  --filter=':- .gitignore' \
  . "${REMOTE_HOST}:${REMOTE_DIR}"
echo "✅ Files synced to ${REMOTE_HOST}:${REMOTE_DIR}"

echo "📦 Installing production dependencies..."
remote "cd ${REMOTE_DIR} && npm ci --omit=dev --no-fund --no-audit"
echo "✅ Dependencies installed"

echo "📄 Writing the systemd unit..."
cat <<UNIT | ssh "${REMOTE_HOST}" "cat > /tmp/${SERVICE_NAME}.service"
[Unit]
Description=Deighton Home Automation - Sonos HTTP API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVER_USER}
WorkingDirectory=/home/${SERVER_USER}/${REMOTE_DIRECTORY}
Environment=NODE_ENV=production
ExecStart=${REMOTE_NODE_PATH} --disable-warning=ExperimentalWarning --env-file-if-exists=.env src/main.ts
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

ssh "${REMOTE_HOST}" "sudo mv /tmp/${SERVICE_NAME}.service /etc/systemd/system/ && \
  sudo systemctl daemon-reload && \
  sudo systemctl enable ${SERVICE_NAME} && \
  sudo systemctl restart ${SERVICE_NAME}"
echo "✅ Service restarted"

echo "🎉 Deployment complete!"
ssh "${REMOTE_HOST}" "sudo systemctl status ${SERVICE_NAME} --no-pager" || true
