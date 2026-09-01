#!/usr/bin/env bash
# verify-backup.sh — Confirm a SQLite backup is restorable.
#
# Copies the backup to a scratch directory, runs PRAGMA integrity_check, and
# optionally compares row counts for key tables (players, migrations, events)
# against expected values captured at backup time.
#
# Environment variables:
#   BACKUP_FILE       Path or URI to the backup (local, s3://…, or gs://…)
#   COUNTS_FILE       Optional sidecar with players/events/migrations counts
#   EXPECT_PLAYERS    Optional expected row count (overrides COUNTS_FILE)
#   EXPECT_EVENTS     Optional expected row count (overrides COUNTS_FILE)
#   EXPECT_MIGRATIONS Optional expected row count (overrides COUNTS_FILE)
#   SCRATCH_DIR       Optional scratch directory (default: mktemp -d)
#   MANIFEST_FILE     Optional path to SHA-256 manifest file for integrity verification
#
# Usage:
#   ./scripts/verify-backup.sh /var/backups/scout-off/scout-off-20250720T120000Z.db
#   ./scripts/verify-backup.sh s3://my-bucket/scout-off-backups/scout-off-20250720T120000Z.db
#   COUNTS_FILE=/var/backups/scout-off/scout-off-20250720T120000Z.db.counts \
#     ./scripts/verify-backup.sh /var/backups/scout-off/scout-off-20250720T120000Z.db
#
# Exit codes:
#   0  Backup verified successfully
#   1  Missing input, CLI tool, integrity failure, or row-count mismatch

set -euo pipefail

SCRIPT_NAME="verify-backup"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_FILE="${BACKUP_FILE:-${1:-}}"
COUNTS_FILE="${COUNTS_FILE:-}"
EXPECT_PLAYERS="${EXPECT_PLAYERS:-}"
EXPECT_EVENTS="${EXPECT_EVENTS:-}"
EXPECT_MIGRATIONS="${EXPECT_MIGRATIONS:-}"
SCRATCH_DIR="${SCRATCH_DIR:-}"
MANIFEST_FILE="${MANIFEST_FILE:-}"
OWNED_SCRATCH=false

log() {
  echo "[${SCRIPT_NAME}] $*"
}

fail() {
  echo "[${SCRIPT_NAME}] ERROR: $*" >&2
  exit 1
}

cleanup() {
  if [[ "${OWNED_SCRATCH}" == true && -n "${SCRATCH_DIR}" && -d "${SCRATCH_DIR}" ]]; then
    rm -rf "${SCRATCH_DIR}"
  fi
}
trap cleanup EXIT

require_sqlite3() {
  if ! command -v sqlite3 &>/dev/null && ! command -v python3 &>/dev/null; then
    fail "'sqlite3' CLI (or python3 fallback) is required to verify backups."
  fi
}

resolve_counts_file() {
  if [[ -n "${COUNTS_FILE}" ]]; then
    return
  fi

  if [[ -n "${BACKUP_FILE}" ]]; then
    COUNTS_FILE="${BACKUP_FILE}.counts"
  fi
}

fetch_counts_sidecar() {
  local destination="$1"
  local fetch_output
  local fetch_status

  if [[ "${COUNTS_FILE}" == s3://* ]]; then
    if ! command -v aws &>/dev/null; then
      fail "'aws' CLI not found. Install it to fetch S3 counts sidecars."
    fi
    fetch_output="$(aws s3 cp "${COUNTS_FILE}" "${destination}" 2>&1)"
    fetch_status=$?
    if [[ "${fetch_status}" -eq 0 ]]; then
      return 0
    fi
    # Distinguish "object does not exist" from all other failures.
    # aws s3 cp exits 1 for both cases; "NoSuchKey" in the error message
    # is the reliable signal that the sidecar simply doesn't exist yet
    # (legitimate for backups predating the sidecar convention).
    if echo "${fetch_output}" | grep -qi "NoSuchKey\|does not exist\|404"; then
      return 1  # Caller treats this as "sidecar absent — skip silently"
    fi
    # Any other error (network, auth, permissions) should be surfaced.
    fail "Failed to fetch counts sidecar from S3 (exit ${fetch_status}): ${fetch_output}"
  fi

  if [[ "${COUNTS_FILE}" == gs://* ]]; then
    if ! command -v gsutil &>/dev/null; then
      fail "'gsutil' not found. Install the Google Cloud SDK to fetch GCS counts sidecars."
    fi
    fetch_output="$(gsutil cp "${COUNTS_FILE}" "${destination}" 2>&1)"
    fetch_status=$?
    if [[ "${fetch_status}" -eq 0 ]]; then
      return 0
    fi
    # gsutil signals a missing object with "No such object" in its output.
    if echo "${fetch_output}" | grep -qi "No such object\|404\|Not Found"; then
      return 1  # Sidecar absent — skip silently
    fi
    fail "Failed to fetch counts sidecar from GCS (exit ${fetch_status}): ${fetch_output}"
  fi

  if [[ ! -f "${COUNTS_FILE}" ]]; then
    return 1
  fi

  cp "${COUNTS_FILE}" "${destination}" || fail "Failed to copy counts sidecar to scratch location."
  return 0
}

load_expected_counts() {
  resolve_counts_file

  if [[ -z "${COUNTS_FILE}" ]]; then
    return
  fi

  local scratch_counts="${SCRATCH_DIR}/backup.db.counts"

  if [[ "${COUNTS_FILE}" != s3://* && "${COUNTS_FILE}" != gs://* && ! -f "${COUNTS_FILE}" ]]; then
    log "Counts sidecar not found (${COUNTS_FILE}); skipping row-count spot-checks."
    COUNTS_FILE=""
    return
  fi

  # fetch_counts_sidecar returns 1 only for a genuine "not found" response.
  # Any other fetch failure causes it to call fail() directly, so if we reach
  # the 'if ! ...' branch here the sidecar is legitimately absent.
  if ! fetch_counts_sidecar "${scratch_counts}"; then
    log "Counts sidecar not present (${COUNTS_FILE}); skipping row-count spot-checks."
    COUNTS_FILE=""
    return
  fi
  # shellcheck disable=SC1090
  source "${scratch_counts}"
  EXPECT_PLAYERS="${EXPECT_PLAYERS:-${players:-}}"
  EXPECT_EVENTS="${EXPECT_EVENTS:-${events:-}}"
  EXPECT_MIGRATIONS="${EXPECT_MIGRATIONS:-${migrations:-}}"
}

table_count() {
  local db_path="$1"
  local table="$2"
  bash "${SCRIPT_DIR}/sqlite-cli.sh" "${db_path}" "SELECT COUNT(*) FROM \"${table}\";" 2>/dev/null || echo "0"
}

fetch_backup_to_scratch() {
  local scratch_backup="${SCRATCH_DIR}/backup.db"

  if [[ "${BACKUP_FILE}" == s3://* ]]; then
    if ! command -v aws &>/dev/null; then
      fail "'aws' CLI not found. Install it to verify S3 backups."
    fi
    aws s3 cp "${BACKUP_FILE}" "${scratch_backup}" || fail "Failed to download backup from S3: ${BACKUP_FILE}"

  elif [[ "${BACKUP_FILE}" == gs://* ]]; then
    if ! command -v gsutil &>/dev/null; then
      fail "'gsutil' not found. Install the Google Cloud SDK to verify GCS backups."
    fi
    gsutil cp "${BACKUP_FILE}" "${scratch_backup}" || fail "Failed to download backup from GCS: ${BACKUP_FILE}"

  else
    if [[ ! -f "${BACKUP_FILE}" ]]; then
      fail "Backup file not found: ${BACKUP_FILE}"
    fi
    cp "${BACKUP_FILE}" "${scratch_backup}" || fail "Failed to copy backup to scratch location."
  fi

  echo "${scratch_backup}"
}

verify_sha256_manifest() {
  local db_path="$1"
  
  if [[ -z "${MANIFEST_FILE}" ]]; then
    log "No manifest file specified; skipping SHA-256 verification."
    return
  fi
  
  if [[ ! -f "${MANIFEST_FILE}" ]]; then
    fail "Manifest file not found: ${MANIFEST_FILE}"
  fi
  
  # Calculate SHA-256 hash of the backup file
  local actual_hash
  if command -v sha256sum &>/dev/null; then
    actual_hash=$(sha256sum "${db_path}" | awk '{print $1}')
  elif command -v shasum &>/dev/null; then
    actual_hash=$(shasum -a 256 "${db_path}" | awk '{print $1}')
  else
    log "Neither sha256sum nor shasum found; skipping SHA-256 verification."
    return
  fi
  
  # Read expected hash from manifest file
  local expected_hash
  expected_hash=$(grep "$(basename "${BACKUP_FILE}")" "${MANIFEST_FILE}" | awk '{print $1}' || true)
  
  if [[ -z "${expected_hash}" ]]; then
    log "No entry found in manifest for $(basename "${BACKUP_FILE}"); skipping SHA-256 verification."
    return
  fi
  
  if [[ "${actual_hash}" != "${expected_hash}" ]]; then
    fail "SHA-256 hash mismatch for '${BACKUP_FILE}': expected ${expected_hash}, got ${actual_hash}"
  fi
  
  log "SHA-256 manifest verification passed (${actual_hash})."
}

verify_integrity() {
  local db_path="$1"
  local result
  local status=0

  result="$(bash "${SCRIPT_DIR}/sqlite-cli.sh" "${db_path}" 'PRAGMA integrity_check;' 2>&1 | tr -d '\r')" || status=$?

  if [[ "${status}" -ne 0 ]]; then
    fail "PRAGMA integrity_check failed for '${BACKUP_FILE}': ${result}"
  fi

  if [[ "${result}" != "ok" ]]; then
    fail "PRAGMA integrity_check failed for '${BACKUP_FILE}': ${result}"
  fi

  log "PRAGMA integrity_check passed."
}

verify_row_counts() {
  local db_path="$1"
  local actual_players actual_events actual_migrations

  if [[ -z "${EXPECT_PLAYERS}${EXPECT_EVENTS}${EXPECT_MIGRATIONS}" ]]; then
    log "No expected row counts provided; skipping table spot-checks."
    return
  fi

  actual_players="$(table_count "${db_path}" "players")"
  actual_events="$(table_count "${db_path}" "events")"
  actual_migrations="$(table_count "${db_path}" "migrations")"

  if [[ -n "${EXPECT_PLAYERS}" && "${actual_players}" != "${EXPECT_PLAYERS}" ]]; then
    fail "players row count mismatch for '${BACKUP_FILE}': expected ${EXPECT_PLAYERS}, got ${actual_players}"
  fi

  if [[ -n "${EXPECT_EVENTS}" && "${actual_events}" != "${EXPECT_EVENTS}" ]]; then
    fail "events row count mismatch for '${BACKUP_FILE}': expected ${EXPECT_EVENTS}, got ${actual_events}"
  fi

  if [[ -n "${EXPECT_MIGRATIONS}" && "${actual_migrations}" != "${EXPECT_MIGRATIONS}" ]]; then
    fail "migrations row count mismatch for '${BACKUP_FILE}': expected ${EXPECT_MIGRATIONS}, got ${actual_migrations}"
  fi

  log "Row-count spot-check passed (players=${actual_players}, events=${actual_events}, migrations=${actual_migrations})."
}

main() {
  if [[ -z "${BACKUP_FILE}" ]]; then
    fail "BACKUP_FILE is required. Pass a local path or s3:// / gs:// URI as the first argument."
  fi

  require_sqlite3

  if [[ -z "${SCRATCH_DIR}" ]]; then
    SCRATCH_DIR="$(mktemp -d)"
    OWNED_SCRATCH=true
  else
    mkdir -p "${SCRATCH_DIR}"
  fi

  load_expected_counts

  log "Verifying backup '${BACKUP_FILE}' (scratch: ${SCRATCH_DIR})"

  local scratch_db
  scratch_db="$(fetch_backup_to_scratch)"
  verify_sha256_manifest "${scratch_db}"
  verify_integrity "${scratch_db}"
  verify_row_counts "${scratch_db}"

  log "Backup verification succeeded: ${BACKUP_FILE}"
}

main "$@"
