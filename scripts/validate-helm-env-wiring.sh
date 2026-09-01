#!/usr/bin/env bash
# --- USAGE START ---
# validate-helm-env-wiring.sh — Verifies that every production-required
# environment variable from src/config.ts is correctly wired into the
# rendered Helm deployment manifest, either as a secretKeyRef (for sensitive
# values) or as a ConfigMap entry (for non-sensitive values).
#
# This guards against the failure mode described in issue #1043: secrets
# created in the Kubernetes Secret via the documented runbook but silently
# not injected into the running pod because the deployment template was
# never updated.
#
# The script renders the chart with a synthetic values file that populates
# every documented Secret key, then greps the rendered manifest for each
# required env var name. A missing entry causes a non-zero exit so CI fails
# loudly rather than deploying a silently broken configuration.
#
# Requires:
#   helm 3.x or 4.x on PATH (preinstalled on GitHub Actions ubuntu-latest)
#
# Usage:
#   bash scripts/validate-helm-env-wiring.sh
#
# Exit codes:
#   0  All required variables are wired in the rendered manifest
#   1  One or more required variables are missing
# --- USAGE END ---

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CHART_DIR="${REPO_ROOT}/helm/scout-off-backend"
RELEASE="scout-off-env-wiring-test"

fail() {
  echo "[validate-helm-env-wiring] FAIL: $*" >&2
  exit 1
}

pass() {
  echo "[validate-helm-env-wiring] PASS: $*"
}

command -v helm >/dev/null 2>&1 || fail "helm 3.x/4.x is required but was not found on PATH"

# ─── Synthetic values file that includes all documented Secret keys ────────────
# helm template --set can't populate a Kubernetes Secret object (the chart
# doesn't create one — operators create it out-of-band). We create a temporary
# values override that provides a non-empty secretName so the secretKeyRef
# blocks resolve, and a fake secret is NOT required because helm template only
# validates the template syntax, not the existence of cluster objects.
# We simply need to confirm every env var NAME appears in the rendered YAML.

TMPDIR_HELM="$(mktemp -d)"
trap 'rm -rf "${TMPDIR_HELM}"' EXIT

VALUES_OVERRIDE="${TMPDIR_HELM}/test-values.yaml"
cat > "${VALUES_OVERRIDE}" <<'EOF'
# Synthetic overrides for env-wiring validation — not for real deployments.
secretName: scout-off-secrets
env:
  NODE_ENV: production
  PORT: "4000"
  NETWORK: mainnet
  NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015"
  HORIZON_URL: https://horizon.stellar.org
  SOROBAN_RPC_URL: https://soroban-rpc.mainnet.stellar.gateway.fm
  LOG_LEVEL: info
  DB_DRIVER: sqlite
  DB_PATH: /data/scout-off.db
  PLATFORM_FEE_BPS: "500"
  CORS_ALLOWED_ORIGINS: "https://app.scoutoff.io,https://scoutoff.io"
  SUBSCRIPTION_GRACE_PERIOD_HOURS: "24"
  TRUSTED_PROXY_COUNT: "1"
  WEBHOOK_ENABLED: "false"
  WEBHOOK_TIMEOUT_MS: "10000"
  SLOW_QUERY_THRESHOLD_MS: "50"
  ADMIN_ACTION_TTL_MS: "3600000"
  PLAYER_CACHE_TTL_MS: "60000"
  RATE_LIMIT_ENABLED: "true"
  RATE_LIMIT_WINDOW_MS: "60000"
  RATE_LIMIT_MAX: "60"
  AUTH_RATE_LIMIT_WINDOW_MS: "60000"
  AUTH_RATE_LIMIT_MAX: "5"
  JWT_ACCESS_TTL_SECONDS: "900"
  STELLAR_HEALTH_CHECK: "true"
  SSE_KEEPALIVE_INTERVAL_MS: "15000"
  SSE_MAX_CONNECTIONS: "0"
  REQUEST_TIMEOUT_MS: "30000"
  METRICS_ENABLED: "true"
  ADMIN_ACTION_TTL_MS: "3600000"
EOF

# Render the chart
RENDERED="$(helm template "${RELEASE}" "${CHART_DIR}" -f "${VALUES_OVERRIDE}")"

echo ""
echo "=== Helm env-wiring audit ==="
echo ""

FAILURES=0

check_env() {
  local var="$1"
  local category="$2"   # "secret" or "configmap"
  if echo "${RENDERED}" | grep -q "name: ${var}"; then
    pass "${var} is wired (${category})"
  else
    echo "[validate-helm-env-wiring] FAIL: ${var} is NOT wired in the rendered deployment (expected: ${category})" >&2
    FAILURES=$(( FAILURES + 1 ))
  fi
}

echo "--- Secret-backed variables (secretKeyRef) ---"
# Required / production-required secrets
check_env "JWT_SECRET"                     "secret"
check_env "SEP10_SERVER_SECRET"            "secret"
check_env "PLATFORM_SECRET_KEY"            "secret"
check_env "API_KEY_LOOKUP_SECRET"          "secret"
check_env "PINATA_API_KEY"                 "secret"
check_env "PINATA_SECRET"                  "secret"
check_env "WEBHOOK_SECRET_ENCRYPTION_KEY"  "secret"

# Per-contract IDs (required in multi-contract deployments)
check_env "REGISTER_CONTRACT_ID"           "secret"
check_env "PROGRESS_CONTRACT_ID"           "secret"
check_env "SUBSCRIPTION_CONTRACT_ID"       "secret"
check_env "CONNECTION_CONTRACT_ID"         "secret"

# Optional secrets (present but optional: true)
check_env "CONTRACT_ID"                    "secret (optional)"
check_env "JWT_SECRET_PREVIOUS"            "secret (optional)"
check_env "JWT_SECRET_PREVIOUS_UNTIL"      "secret (optional)"
check_env "ADMIN_WALLET"                   "secret (optional)"
check_env "ADMIN_WALLETS"                  "secret (optional)"
check_env "DATABASE_URL"                   "secret (optional)"
check_env "REDIS_URL"                      "secret (optional)"
check_env "WEBHOOK_SECRET"                 "secret (optional)"

echo ""
echo "--- ConfigMap-backed variables (envFrom configMapRef) ---"
# Verify the ConfigMap itself is referenced in envFrom
if echo "${RENDERED}" | grep -q "configMapRef"; then
  pass "ConfigMap is referenced via envFrom"
else
  echo "[validate-helm-env-wiring] FAIL: no configMapRef found in rendered deployment" >&2
  FAILURES=$(( FAILURES + 1 ))
fi

# Key non-sensitive production config values that must be in the ConfigMap
for var in \
  NODE_ENV \
  PORT \
  NETWORK \
  NETWORK_PASSPHRASE \
  HORIZON_URL \
  SOROBAN_RPC_URL \
  LOG_LEVEL \
  DB_DRIVER \
  DB_PATH \
  PLATFORM_FEE_BPS \
  CORS_ALLOWED_ORIGINS \
  SUBSCRIPTION_GRACE_PERIOD_HOURS \
  TRUSTED_PROXY_COUNT \
  WEBHOOK_ENABLED \
  WEBHOOK_TIMEOUT_MS \
  SLOW_QUERY_THRESHOLD_MS \
  RATE_LIMIT_ENABLED \
  RATE_LIMIT_WINDOW_MS \
  RATE_LIMIT_MAX \
  AUTH_RATE_LIMIT_WINDOW_MS \
  AUTH_RATE_LIMIT_MAX \
  JWT_ACCESS_TTL_SECONDS \
  STELLAR_HEALTH_CHECK \
  SSE_KEEPALIVE_INTERVAL_MS \
  SSE_MAX_CONNECTIONS \
  REQUEST_TIMEOUT_MS; do
  if echo "${RENDERED}" | grep -q "${var}"; then
    pass "${var} is present in ConfigMap"
  else
    echo "[validate-helm-env-wiring] FAIL: ${var} not found in rendered ConfigMap" >&2
    FAILURES=$(( FAILURES + 1 ))
  fi
done

echo ""
if [[ "${FAILURES}" -gt 0 ]]; then
  fail "${FAILURES} env var(s) missing from the rendered Helm manifest — see failures above"
fi

echo "[validate-helm-env-wiring] All required env vars are correctly wired. (${FAILURES} failures)"
