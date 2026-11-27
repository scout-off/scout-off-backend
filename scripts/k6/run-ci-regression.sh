#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <candidate-checkout> <main-checkout>" >&2
  exit 2
fi

CANDIDATE_DIR="$(cd "$1" && pwd)"
MAIN_DIR="$(cd "$2" && pwd)"
RESULT_DIR="${K6_RESULT_DIR:-${RUNNER_TEMP:-/tmp}/scout-k6-regression}"
mkdir -p "$RESULT_DIR"

JWT_SECRET='ci-performance-test-secret-not-for-deployments'
CONTRACT_ID='CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4'
SCOUT_WALLET='GFAZQXNK3BFMN7XRVGBAEZI3BYWDXHZVJBDG5AXBLYMN6VJXVHAJBGZE'
APP_PID=''

cleanup() {
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    kill "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

seed_database() {
  local app_dir="$1"
  local db_path="$2"
  (
    cd "$app_dir"
    env \
      NODE_ENV=test \
      SECRETS_PROVIDER=env \
      DB_DRIVER=sqlite \
      DB_PATH="$db_path" \
      JWT_SECRET="$JWT_SECRET" \
      CONTRACT_ID="$CONTRACT_ID" \
      INDEXER_ENABLED=false \
      npm run seed -- --only players,subscriptions
  )
}

start_app() {
  local app_dir="$1"
  local port="$2"
  local db_path="$3"
  local label="$4"
  local base_url="http://127.0.0.1:${port}"

  (
    cd "$app_dir"
    exec env \
      NODE_ENV=test \
      SECRETS_PROVIDER=env \
      PORT="$port" \
      DB_DRIVER=sqlite \
      DB_PATH="$db_path" \
      JWT_SECRET="$JWT_SECRET" \
      CONTRACT_ID="$CONTRACT_ID" \
      INDEXER_ENABLED=false \
      STELLAR_HEALTH_CHECK=false \
      SOROBAN_RPC_URL=http://127.0.0.1:1 \
      SSE_KEEPALIVE_INTERVAL_MS=5000 \
      node dist/index.js
  ) > "$RESULT_DIR/${label}-server.log" 2>&1 &
  APP_PID=$!

  for attempt in $(seq 1 60); do
    if curl --silent --fail "$base_url/health" >/dev/null; then
      echo "$label app is healthy at $base_url"
      return
    fi
    if ! kill -0 "$APP_PID" 2>/dev/null; then
      echo "$label app exited before becoming healthy:" >&2
      tail -n 80 "$RESULT_DIR/${label}-server.log" >&2
      exit 1
    fi
    sleep 1
  done

  echo "$label app did not become healthy:" >&2
  tail -n 80 "$RESULT_DIR/${label}-server.log" >&2
  exit 1
}

stop_app() {
  cleanup
  APP_PID=''
}

run_profile() {
  local base_url="$1"
  local output="$2"
  # subscription_status is intentionally excluded because it queries Soroban
  # RPC and would make this local, seeded profile depend on external network state.
  K6_PROFILE=ci \
  K6_SCENARIO='auth_flow,player_list,player_profile,sse_stream,admin_stats' \
  K6_BASE_URL="$base_url" \
  K6_PLAYER_ID=seed-player-001 \
  K6_SCOUT_WALLET="$SCOUT_WALLET" \
  TEST_ADMIN_JWT="$(JWT_SECRET="$JWT_SECRET" node -e "process.stdout.write(require('jsonwebtoken').sign({sub:'GADMINPERF',role:'admin'}, process.env.JWT_SECRET, {expiresIn:'1h'}))")" \
  TEST_SCOUT_JWT="$(JWT_SECRET="$JWT_SECRET" SCOUT_WALLET="$SCOUT_WALLET" node -e "process.stdout.write(require('jsonwebtoken').sign({sub:process.env.SCOUT_WALLET,role:'scout'}, process.env.JWT_SECRET, {expiresIn:'1h'}))")" \
    k6 run --summary-export "$output" "$CANDIDATE_DIR/scripts/k6/suite.js"
}

MAIN_DB="${RUNNER_TEMP:-/tmp}/scout-k6-main-${GITHUB_RUN_ID:-local}.db"
CANDIDATE_DB="${RUNNER_TEMP:-/tmp}/scout-k6-candidate-${GITHUB_RUN_ID:-local}.db"
seed_database "$MAIN_DIR" "$MAIN_DB"
seed_database "$CANDIDATE_DIR" "$CANDIDATE_DB"

start_app "$MAIN_DIR" 4101 "$MAIN_DB" main
run_profile http://127.0.0.1:4101 "$RESULT_DIR/main-summary.json"
stop_app

start_app "$CANDIDATE_DIR" 4102 "$CANDIDATE_DB" candidate
run_profile http://127.0.0.1:4102 "$RESULT_DIR/candidate-summary.json"
stop_app

node "$CANDIDATE_DIR/scripts/k6/compare-ci-results.js" \
  "$RESULT_DIR/main-summary.json" \
  "$RESULT_DIR/candidate-summary.json" \
  "$CANDIDATE_DIR/scripts/k6/ci-budgets.json"
