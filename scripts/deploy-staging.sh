#!/usr/bin/env bash
# Deploy ScoutOff backend on the target server using a blue-green strategy.
# Invoked remotely by .github/workflows/deploy-staging.yml and
# .github/workflows/deploy-mainnet.yml after the release tarball is uploaded
# and extracted.
#
# Usage:
#   bash scripts/deploy-staging.sh [ROOT] [COMMAND] [ENVIRONMENT]
#
#   ROOT        — absolute path to the deployment directory
#                 (default: parent directory of this script)
#   COMMAND     — "deploy" (default) or "rollback"
#   ENVIRONMENT — "staging" (default) or "mainnet"
#
# Port allocation:
#   staging  blue → 4000  green → 4001
#   mainnet  blue → 4002  green → 4003
#
# Dependency/build ordering rationale:
#   1. npm ci (full install, devDependencies included) — typescript lives under
#      devDependencies so it must be present for `npm run build` to succeed.
#   2. npm run build — compiles TypeScript to dist/ using the tsc binary that
#      was just installed.
#   3. npm prune --omit=dev — strips devDependencies from node_modules so the
#      running process only loads production packages.
#
# This ordering avoids the failure mode where --omit=dev is passed to npm ci
# before the build step, leaving tsc unavailable when it is needed.
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
COMMAND="${2:-deploy}"
ENVIRONMENT="${3:-staging}"
cd "$ROOT"

# ---------------------------------------------------------------------------
# Port and PM2 process-name configuration per environment
# ---------------------------------------------------------------------------
case "$ENVIRONMENT" in
  mainnet)
    BLUE_PORT=4002
    GREEN_PORT=4003
    BLUE_PM2_NAME="scout-off-backend-mainnet-blue"
    GREEN_PM2_NAME="scout-off-backend-mainnet-green"
    ;;
  staging|*)
    BLUE_PORT=4000
    GREEN_PORT=4001
    BLUE_PM2_NAME="scout-off-backend-blue"
    GREEN_PM2_NAME="scout-off-backend-green"
    ;;
esac

SLOT_FILE="$ROOT/.active-slot-${ENVIRONMENT}"
if [ ! -f "$SLOT_FILE" ]; then
  echo "blue" > "$SLOT_FILE"
fi
ACTIVE_SLOT=$(cat "$SLOT_FILE")

flip_traffic() {
  local target_slot=$1
  local target_port=$2
  local nginx_conf="/etc/nginx/conf.d/scout-off-${ENVIRONMENT}-upstream.conf"

  echo "Flipping traffic to $target_slot (Port $target_port) [$ENVIRONMENT]..."
  if [ -d "/etc/nginx/conf.d" ]; then
    echo "upstream scout_off_${ENVIRONMENT}_backend { server 127.0.0.1:${target_port}; }" | sudo tee "$nginx_conf" > /dev/null
    sudo systemctl reload nginx
    echo "Nginx reloaded successfully."
  else
    echo "WARNING: /etc/nginx/conf.d not found. You must configure your reverse proxy to point to Port $target_port manually."
  fi
  echo "$target_slot" > "$SLOT_FILE"
}

if [ "$COMMAND" == "rollback" ]; then
  if [ "$ACTIVE_SLOT" == "blue" ]; then
    TARGET_SLOT="green"
    TARGET_PORT=$GREEN_PORT
  else
    TARGET_SLOT="blue"
    TARGET_PORT=$BLUE_PORT
  fi
  echo "Rolling back [$ENVIRONMENT] from $ACTIVE_SLOT to $TARGET_SLOT..."
  flip_traffic "$TARGET_SLOT" "$TARGET_PORT"
  echo "Rollback complete. Active slot is now $TARGET_SLOT."
  exit 0
fi

# -- Normal Deploy --

if [ "$ACTIVE_SLOT" == "blue" ]; then
  IDLE_SLOT="green"
  IDLE_PORT=$GREEN_PORT
  IDLE_PM2_NAME=$GREEN_PM2_NAME
  ACTIVE_PORT=$BLUE_PORT
else
  IDLE_SLOT="blue"
  IDLE_PORT=$BLUE_PORT
  IDLE_PM2_NAME=$BLUE_PM2_NAME
  ACTIVE_PORT=$GREEN_PORT
fi

echo "[$ENVIRONMENT] Current active slot is $ACTIVE_SLOT (Port $ACTIVE_PORT). Deploying to $IDLE_SLOT (Port $IDLE_PORT)..."

echo "Installing all dependencies (including devDependencies for build)..."
npm ci

echo "Building TypeScript..."
npm run build

echo "Pruning devDependencies..."
npm prune --omit=dev

echo "Starting $IDLE_SLOT ($IDLE_PM2_NAME)..."
if ! command -v pm2 >/dev/null 2>&1; then
  echo "ERROR: pm2 is required for blue-green deployment."
  exit 1
fi

# Restart or start the idle slot
PORT=$IDLE_PORT pm2 restart "$IDLE_PM2_NAME" 2>/dev/null || \
PORT=$IDLE_PORT pm2 start dist/index.js --name "$IDLE_PM2_NAME"

# Save PM2 state so it restarts on boot
pm2 save >/dev/null 2>&1 || true

echo "Waiting for $IDLE_SLOT to be healthy..."
HEALTH_URL="http://127.0.0.1:${IDLE_PORT}/health"
HEALTHY=false
for attempt in {1..10}; do
  if curl -fsSL "$HEALTH_URL" | grep -q '"status":"ok"'; then
    echo "$IDLE_SLOT is healthy!"
    HEALTHY=true
    break
  fi
  echo "Attempt $attempt failed; retrying in 5s..."
  sleep 5
done

if [ "$HEALTHY" != "true" ]; then
  echo "Failed to start $IDLE_SLOT. Health check failed. Aborting deploy."
  exit 1
fi

# Flip traffic to the newly deployed slot
flip_traffic "$IDLE_SLOT" "$IDLE_PORT"

echo "[$ENVIRONMENT] Deploy complete. Active slot is now $IDLE_SLOT (Port $IDLE_PORT)."
