#!/usr/bin/env bash
# --- USAGE START ---
# backup-restore-smoke-test.sh — End-to-end backup → restore → smoke-test cycle.
#
# This script:
#   1. Seeds a test SQLite database with known data
#   2. Creates a backup using backup-db.sh
#   3. Restores the backup to a fresh database file
#   4. Runs pending migrations against the restored database
#   5. Verifies row counts match the pre-backup state
#   6. Starts the application server against the restored DB
#   7. Checks /health/readiness returns 200
#   8. Cleans up all temporary files
#
# Environment variables:
#   DB_PATH          Path to the source database (will be created if missing)
#   BACKUP_DEST      Directory for backups
#   RESTORE_DEST     Path for the restored database (default: temp file)
#   MIGRATIONS_DIR   Directory containing migration SQL files
#   APP_START_CMD    Command to start the app (default: npm start)
#   APP_PORT         Port for the app (default: 3000)
#   APP_STARTUP_TIMEOUT  Seconds to wait for app startup (default: 30)
#
# Usage:
#   DB_PATH=test.db BACKUP_DEST=./backups ./scripts/backup-restore-smoke-test.sh
#
# Exit codes:
#   0  All smoke tests passed
#   1  Any step failed
# --- USAGE END ---

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ─── Configuration ────────────────────────────────────────────────────────────

DB_PATH="${DB_PATH:-${REPO_ROOT}/test-smoke.db}"
ORIGINAL_DB_PATH="${DB_PATH}"
BACKUP_DEST="${BACKUP_DEST:-${REPO_ROOT}/backups}"
RESTORE_DEST="${RESTORE_DEST:-}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-${REPO_ROOT}/db}"
APP_START_CMD="${APP_START_CMD:-npm start}"
APP_PORT="${APP_PORT:-3000}"
APP_STARTUP_TIMEOUT="${APP_STARTUP_TIMEOUT:-30}"

# ─── Helpers ────────────────────────────────────────────────────────────────────

log() {
  echo "[backup-restore-smoke-test] $*"
}

fail() {
  echo "[backup-restore-smoke-test] ERROR: $*" >&2
  exit 1
}

cleanup() {
  log "Cleaning up temporary files..."
  
  # Stop the app server if it's running
  if [[ -n "${APP_PID:-}" ]] && kill -0 "${APP_PID}" 2>/dev/null; then
    log "Stopping app server (PID: ${APP_PID})..."
    kill "${APP_PID}" 2>/dev/null || true
    wait "${APP_PID}" 2>/dev/null || true
  fi
  
  # Remove temporary files
  if [[ -n "${RESTORE_DEST}" && -f "${RESTORE_DEST}" ]]; then
    rm -f "${RESTORE_DEST}"
  fi

  # Use ORIGINAL_DB_PATH, not DB_PATH: Step 6 below reassigns DB_PATH to
  # RESTORE_DEST (so the app under test reads the restored DB), so by the
  # time this trap runs DB_PATH no longer points at the originally-seeded
  # database file — removing it here would just re-delete RESTORE_DEST
  # (already handled above) and leave the real seed file behind.
  if [[ -f "${ORIGINAL_DB_PATH}" ]]; then
    rm -f "${ORIGINAL_DB_PATH}"
  fi
  
  # Remove backup directory
  if [[ -d "${BACKUP_DEST}" ]]; then
    rm -rf "${BACKUP_DEST}"
  fi
}

trap cleanup EXIT

# ─── Step 1: Seed test database ───────────────────────────────────────────────

log "Step 1: Seeding test database at ${DB_PATH}"

mkdir -p "$(dirname "${DB_PATH}")"

# Create database with initial schema
bash "${SCRIPT_DIR}/sqlite-cli.sh" "${DB_PATH}" "$(cat "${MIGRATIONS_DIR}/001_initial.sql")"

# Insert test data. DB_PATH "will be created if missing" (see header) implies
# this script must also tolerate an *already-existing* DB_PATH that some
# caller pre-seeded (e.g. to set up a known starting state before invoking
# this script) — so these inserts use INSERT OR IGNORE to stay idempotent
# rather than failing on UNIQUE/PRIMARY KEY conflicts against data that's
# already there.
bash "${SCRIPT_DIR}/sqlite-cli.sh" "${DB_PATH}" "
  INSERT OR IGNORE INTO players (player_id, wallet, created_at)
  VALUES ('player-1', 'GTESTWALLET123456789012345678901234567890', 1);

  INSERT OR IGNORE INTO events (type, ledger, tx_hash, payload)
  VALUES ('register', 100, 'abc123hash', '{}');

  CREATE TABLE IF NOT EXISTS migrations (
    id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );

  INSERT OR IGNORE INTO migrations (id, applied_at) VALUES ('001_initial.sql', 1);
"

# Record pre-backup row counts
EXPECT_PLAYERS=$(bash "${SCRIPT_DIR}/sqlite-cli.sh" "${DB_PATH}" "SELECT COUNT(*) FROM players;")
EXPECT_EVENTS=$(bash "${SCRIPT_DIR}/sqlite-cli.sh" "${DB_PATH}" "SELECT COUNT(*) FROM events;")
EXPECT_MIGRATIONS=$(bash "${SCRIPT_DIR}/sqlite-cli.sh" "${DB_PATH}" "SELECT COUNT(*) FROM migrations;")

log "Pre-backup row counts: players=${EXPECT_PLAYERS}, events=${EXPECT_EVENTS}, migrations=${EXPECT_MIGRATIONS}"

# ─── Step 2: Create backup ────────────────────────────────────────────────────

log "Step 2: Creating backup"

mkdir -p "${BACKUP_DEST}"

# backup-db.sh reads DB_PATH/BACKUP_DEST as environment variables (see its
# own header doc), not as positional CLI arguments — its argument parser
# rejects anything besides --verify-only/--help with "Unknown argument".
DB_PATH="${DB_PATH}" \
BACKUP_DEST="${BACKUP_DEST}" \
  bash "${SCRIPT_DIR}/backup-db.sh" \
  || fail "Backup creation failed"

# Find the backup file
BACKUP_FILE=$(ls -t "${BACKUP_DEST}"/*.db 2>/dev/null | head -1)
if [[ -z "${BACKUP_FILE}" ]]; then
  fail "No backup file found in ${BACKUP_DEST}"
fi

log "Backup created: ${BACKUP_FILE}"

# ─── Step 3: Restore to fresh database ────────────────────────────────────────

log "Step 3: Restoring backup to fresh database"

if [[ -z "${RESTORE_DEST}" ]]; then
  RESTORE_DEST=$(mktemp /tmp/scout-off-restore-XXXXXX.db)
fi

cp "${BACKUP_FILE}" "${RESTORE_DEST}" || fail "Failed to copy backup to restore destination"

log "Backup restored to: ${RESTORE_DEST}"

# ─── Step 4: Run migrations ───────────────────────────────────────────────────

log "Step 4: Running pending migrations"

# Apply all migration files in order
for migration_file in "${MIGRATIONS_DIR}"/*.sql; do
  if [[ ! -f "${migration_file}" ]]; then
    continue
  fi
  
  migration_name=$(basename "${migration_file}")

  # This smoke test operates purely on SQLite via sqlite-cli.sh and, unlike
  # src/db/migrate.ts, applies migration SQL verbatim with no PostgreSQL ->
  # SQLite translation step. _postgres.sql files are PostgreSQL-only variants
  # of the plain .sql migration of the same number (already applied earlier
  # in this same loop) and are not written to run against SQLite — skip them
  # here rather than failing the whole smoke test on non-portable syntax.
  if [[ "${migration_name}" == *_postgres.sql ]]; then
    log "Skipping PostgreSQL-only migration (not applicable to SQLite): ${migration_name}"
    continue
  fi

  # Check if migration already applied
  APPLIED=$(bash "${SCRIPT_DIR}/sqlite-cli.sh" "${RESTORE_DEST}" \
    "SELECT COUNT(*) FROM migrations WHERE id='${migration_name}';" 2>/dev/null || echo "0")
  
  if [[ "${APPLIED}" -eq 0 ]]; then
    log "Applying migration: ${migration_name}"
    bash "${SCRIPT_DIR}/sqlite-cli.sh" "${RESTORE_DEST}" "$(cat "${migration_file}")"
    
    # Record migration as applied
    bash "${SCRIPT_DIR}/sqlite-cli.sh" "${RESTORE_DEST}" \
      "INSERT INTO migrations (id, applied_at) VALUES ('${migration_name}', $(date +%s));"
  else
    log "Migration already applied: ${migration_name}"
  fi
done

log "Migrations completed"

# ─── Step 5: Verify row counts ────────────────────────────────────────────────

log "Step 5: Verifying row counts"

ACTUAL_PLAYERS=$(bash "${SCRIPT_DIR}/sqlite-cli.sh" "${RESTORE_DEST}" "SELECT COUNT(*) FROM players;")
ACTUAL_EVENTS=$(bash "${SCRIPT_DIR}/sqlite-cli.sh" "${RESTORE_DEST}" "SELECT COUNT(*) FROM events;")
ACTUAL_MIGRATIONS=$(bash "${SCRIPT_DIR}/sqlite-cli.sh" "${RESTORE_DEST}" "SELECT COUNT(*) FROM migrations;")

log "Post-restore row counts: players=${ACTUAL_PLAYERS}, events=${ACTUAL_EVENTS}, migrations=${ACTUAL_MIGRATIONS}"

if [[ "${ACTUAL_PLAYERS}" != "${EXPECT_PLAYERS}" ]]; then
  fail "Row count mismatch for players: expected ${EXPECT_PLAYERS}, got ${ACTUAL_PLAYERS}"
fi

if [[ "${ACTUAL_EVENTS}" != "${EXPECT_EVENTS}" ]]; then
  fail "Row count mismatch for events: expected ${EXPECT_EVENTS}, got ${ACTUAL_EVENTS}"
fi

# Unlike players/events (untouched by migrations), the migrations table is
# *expected* to grow between the pre-backup snapshot and this point: Step 4
# deliberately applies whatever migration files were still pending, adding
# one new row per file it applies. EXPECT_MIGRATIONS was captured before
# those were applied, so it is a floor, not an exact match — the real
# invariant backup/restore must preserve is that no pre-existing migration
# record was lost, not that no new ones were added.
if [[ "${ACTUAL_MIGRATIONS}" -lt "${EXPECT_MIGRATIONS}" ]]; then
  fail "Row count mismatch for migrations: expected at least ${EXPECT_MIGRATIONS}, got ${ACTUAL_MIGRATIONS}"
fi

log "Row count verification passed"

# ─── Step 6: Start application and check health ───────────────────────────────

log "Step 6: Starting application and checking health"

# Set environment variables for the app.
#
# NOTE: these must match the exact names src/config.ts reads — DB_PATH (not
# DATABASE_PATH) and STELLAR_HEALTH_CHECK (not STELLAR_HEALTH_CHECK_ENABLED).
# Using the wrong names silently no-ops them: the app would fall back to its
# default DB path (scout-off.db) instead of the restored/migrated
# RESTORE_DEST, and would leave the real Stellar health check enabled.
export DB_PATH="${RESTORE_DEST}"
export NODE_ENV=test
export PORT="${APP_PORT}"
export LOG_LEVEL=error
export STELLAR_HEALTH_CHECK=false
export IPFS_ENABLED=false

# Start the app in the background
log "Starting app: ${APP_START_CMD}"
${APP_START_CMD} &
APP_PID=$!

# Wait for app to start
log "Waiting for app to start (timeout: ${APP_STARTUP_TIMEOUT}s)..."
STARTUP_WAIT=0
while [[ ${STARTUP_WAIT} -lt ${APP_STARTUP_TIMEOUT} ]]; do
  if curl -s -o /dev/null -w "%{http_code}" "http://localhost:${APP_PORT}/health/liveness" 2>/dev/null | grep -q "200"; then
    log "App started successfully"
    break
  fi
  
  # Check if app process is still running
  if ! kill -0 "${APP_PID}" 2>/dev/null; then
    fail "App process exited unexpectedly"
  fi
  
  sleep 1
  STARTUP_WAIT=$((STARTUP_WAIT + 1))
done

if [[ ${STARTUP_WAIT} -ge ${APP_STARTUP_TIMEOUT} ]]; then
  fail "App did not start within ${APP_STARTUP_TIMEOUT} seconds"
fi

# ─── Step 7: Check /health/readiness ─────────────────────────────────────────

log "Step 7: Checking /health/readiness endpoint"

HEALTH_RESPONSE=$(curl -s -w "\n%{http_code}" "http://localhost:${APP_PORT}/health/readiness" 2>&1)
HTTP_CODE=$(echo "${HEALTH_RESPONSE}" | tail -1)
BODY=$(echo "${HEALTH_RESPONSE}" | sed '$d')

log "Health check response: HTTP ${HTTP_CODE}"
log "Health check body: ${BODY}"

if [[ "${HTTP_CODE}" != "200" ]]; then
  fail "/health/readiness returned HTTP ${HTTP_CODE} instead of 200"
fi

# Verify the response contains expected structure
if ! echo "${BODY}" | grep -q '"status":"ok"'; then
  fail "/health/readiness response does not contain status: ok"
fi

if ! echo "${BODY}" | grep -q '"db"'; then
  fail "/health/readiness response does not contain db status"
fi

log "/health/readiness check passed"

# ─── Success ──────────────────────────────────────────────────────────────────

log "All smoke tests passed successfully!"
exit 0