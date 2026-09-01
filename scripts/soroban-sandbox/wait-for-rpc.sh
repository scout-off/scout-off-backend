#!/usr/bin/env bash
# Wait until the local Soroban RPC responds.
set -euo pipefail

RPC_URL="${SOROBAN_RPC_URL:-http://localhost:8000/soroban/rpc}"
ATTEMPTS="${WAIT_ATTEMPTS:-60}"

echo "[wait-for-rpc] waiting for ${RPC_URL}"
for i in $(seq 1 "$ATTEMPTS"); do
  if curl -sf -X POST "$RPC_URL" \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' >/dev/null 2>&1; then
    echo "[wait-for-rpc] ready after ${i} attempt(s)"
    exit 0
  fi
  sleep 2
done

echo "[wait-for-rpc] timed out waiting for ${RPC_URL}" >&2
exit 1
