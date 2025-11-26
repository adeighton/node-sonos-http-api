#!/bin/bash

# Deploy Sonos HTTP API
# This script syncs the project files to the remote Pi, preserving settings.json but excluding git files
#
# Setup Instructions:
# Set up passwordless SSH key authentication with the remote host

# ===== CONFIGURATION =====
# Edit these variables to change deployment target
SERVER_NAME="man-in-the-ceiling.local"
SERVER_USER="pi"
REMOTE_DIRECTORY="node-sonos-http-api"
SERVICE_NAME="sonos"
# =======================

echo "🚀 Deploying ${SERVICE_NAME} to ${SERVER_NAME}..."

# Define variables
REMOTE_HOST="${REMOTE_HOST:-${SERVER_USER}@${SERVER_NAME}}"
REMOTE_DIR="${REMOTE_DIR:-~/${REMOTE_DIRECTORY}/}"

# Perform the sync with rsync, excluding deploy.sh and using .gitignore patterns
rsync -avz \
  --include='settings.json' \
  --exclude='.git' \
  --exclude='deploy.sh' \
  --filter=':- .gitignore' \
  . "${REMOTE_HOST}:${REMOTE_DIR}"

# Check if the sync was successful
if [ $? -eq 0 ]; then
    echo "✅ File sync completed successfully!"
else
    echo "❌ Deployment failed with error code $?"
    exit 1
fi

echo "📋 Deployed files are now available at ${REMOTE_HOST}:${REMOTE_DIR}"

# Locate Node binary dynamically
echo "🔍 Locating Node.js binary on remote system..."

# We manually load NVM because non-interactive SSH shells exit .bashrc early
REMOTE_NODE_PATH=$(ssh ${REMOTE_HOST} "export NVM_DIR=\"\$HOME/.nvm\" && [ -s \"\$NVM_DIR/nvm.sh\" ] && \. \"\$NVM_DIR/nvm.sh\" && which node")

# Fallback: If NVM method failed, try standard system path lookup
if [ -z "$REMOTE_NODE_PATH" ]; then
    REMOTE_NODE_PATH=$(ssh ${REMOTE_HOST} "which node")
fi

if [ -z "$REMOTE_NODE_PATH" ]; then
    echo "❌ Could not find 'node' on remote system."
    echo "   (Make sure NVM is installed in ~/.nvm or Node is in /usr/bin)"
    exit 1
else
    echo "✅ Found Node.js at: $REMOTE_NODE_PATH"
fi

# Install dependencies on the remote system
echo "📦 Installing npm dependencies on remote system..."

# Load NVM if available (optional), then run npm install
# Uses || true to continue even if NVM isn't installed (e.g., Node via apt)
ssh ${REMOTE_HOST} "{ export NVM_DIR=\"\$HOME/.nvm\" && [ -s \"\$NVM_DIR/nvm.sh\" ] && \. \"\$NVM_DIR/nvm.sh\"; } || true; cd ${REMOTE_DIR} && npm install --omit=dev && npm install --prefix ./lib/sonos-discovery --omit=dev"

if [ $? -eq 0 ]; then
    echo "✅ npm install completed successfully!"
else
    echo "❌ npm install failed with error code $?"
    exit 1
fi

# Deploy systemd service file
echo "📄 Deploying systemd service file..."

# Create the service file on the remote system using local expansion piped to remote
# This ensures ${SERVER_USER} and ${REMOTE_DIRECTORY} are expanded locally before sending
# Uses the DYNAMIC Node path found earlier
cat <<EOF | ssh ${REMOTE_HOST} "cat > /tmp/${SERVICE_NAME}.service"
[Unit]
Description=Deighton Home Automation - Sonos HTTP API
After=network.target

[Service]
Type=simple
User=${SERVER_USER}
WorkingDirectory=/home/${SERVER_USER}/${REMOTE_DIRECTORY}
ExecStart=${REMOTE_NODE_PATH} server.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# Move service file to system directory and restart service
ssh ${REMOTE_HOST} "sudo mv /tmp/${SERVICE_NAME}.service /etc/systemd/system/ && \
                    sudo systemctl daemon-reload && \
                    sudo systemctl enable ${SERVICE_NAME} && \
                    sudo systemctl restart ${SERVICE_NAME}"

if [ $? -eq 0 ]; then
    echo "✅ Service file deployed and service restarted successfully!"
else
    echo "❌ Service deployment failed with error code $?"
    exit 1
fi

echo "🎉 Deployment complete!"
echo "📊 Service status:"
ssh ${REMOTE_HOST} "sudo systemctl status ${SERVICE_NAME}"
