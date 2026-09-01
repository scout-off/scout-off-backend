#!/usr/bin/env bash
# --- USAGE START ---
# backup-db.sh — Copy the ScoutOff SQLite database to a timestamped backup location.
#
# Supports both local filesystem destinations and S3/GCS URIs:
#   Local:  BACKUP_DEST=/var/backups/scout-off
#   AWS S3: BACKUP_DEST=s3://my-bucket/scout-off-backups
#   GCS:    BACKUP_DEST=gs://my-bucket/scout-off-backups
#
# Every backup is verified immediately after creation (PRAGMA integrity_check
# plus row-count spot-checks). Use --verify-only to run a restore-verification
# drill against an existing backup without creating a new one.
#
# Environment variables:
#   DB_PATH      Path to the SQLite database file (default: scout-off.db)
#   BACKUP_DEST  Destination directory or bucket URI (required for backup mode)
#
# Usage:
#   DB_PATH=/data/scout-off.db BACKUP_DEST=/var/backups/scout-off ./scripts/backup-db.sh
#   ./scripts/backup-db.sh --verify-only /var/backups/scout-off/scout-off-20250720T120000Z.db
#   ./scripts/backup-db.sh --verify-only s3://my-bucket/scout-off-backups/scout-off-20250720T120000Z.db
#
# Exit codes:
#   0  Success (backup created and verified, or standalone verify passed)
#   1  Validation, copy, or verification failure
# --- USAGE END ---

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Configuration ────────────────────────────────────────────────────────────

DB_PATH="${DB_PATH:-scout-off.db}"
BACKUP_DEST="${BACKUP_DEST:-}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DB_BASENAME="$(basename "${DB_PATH}" .db)"
BACKUP_FILENAME="${DB_BASENAME}-${TIMESTAMP}.db"
VERIFY_ONLY=false
BACKUP_TO_VERIFY=""

# ─── Helpers ────────────────────────────────────────────────────────────────────

log() {
  echo "[backup-db] $*"
}

fail() {
  echo "[backup-db] ERROR: $*" >&2
  exit 1
}

require_sqlite3() {
  if ! command -v sqlite3 &>/dev/null && ! command -v python3 &>/dev/null; then
    fail "'sqlite3' CLI (or python3 fallback) is required to create and verify backups."
  fi
}

table_count() {
  local db_path="$1"
  local table="$2"
  local output
  local status

  # Capture output and exit code separately so we can distinguish
  # "query succeeded and returned 0" from "query failed" (locked DB,
  # corrupt file, missing table, etc.).  The previous implementation
  # used `2>/dev/null || echo "0"`, which silently masked any failure
  # and returned 0 — indistinguishable from a genuinely empty table.
  output="$(bash "${SCRIPT_DIR}/sqlite-cli.sh" "${db_path}" "SELECT COUNT(*) FROM \"${table}\";" 2>&1)"
  status=$?

  if [[ "${status}" -ne 0 ]]; then
    fail "table_count() query failed for table '${table}' in '${db_path}' (exit ${status}): ${output}"
  fi

  echo "${output}"
}

capture_source_counts() {
  EXPECT_PLAYERS="$(table_count "${DB_PATH}" "players")"
  EXPECT_EVENTS="$(table_count "${DB_PATH}" "events")"
  EXPECT_MIGRATIONS="$(table_count "${DB_PATH}" "migrations")"
}

write_counts_file() {
  local counts_path="$1"
  cat > "${counts_path}" <<EOF
players=${EXPECT_PLAYERS}
events=${EXPECT_EVENTS}
migrations=${EXPECT_MIGRATIONS}
EOF
}

upload_counts_sidecar() {
  local counts_path="$1"
  local remote_name="${BACKUP_FILENAME}.counts"

  if [[ "${BACKUP_DEST}" == s3://* ]]; then
    aws s3 cp "${counts_path}" "${BACKUP_DEST}/${remote_name}" || fail "Failed to upload counts sidecar to S3."
  elif [[ "${BACKUP_DEST}" == gs://* ]]; then
    gsutil cp "${counts_path}" "${BACKUP_DEST}/${remote_name}" || fail "Failed to upload counts sidecar to GCS."
  else
    cp "${counts_path}" "${BACKUP_DEST}/${remote_name}" || fail "Failed to write counts sidecar locally."
  fi
}

run_verification() {
  local backup_location="$1"
  local counts_file="${2:-}"

  BACKUP_FILE="${backup_location}" \
    COUNTS_FILE="${counts_file}" \
    EXPECT_PLAYERS="${EXPECT_PLAYERS:-}" \
    EXPECT_EVENTS="${EXPECT_EVENTS:-}" \
    EXPECT_MIGRATIONS="${EXPECT_MIGRATIONS:-}" \
    bash "${SCRIPT_DIR}/verify-backup.sh" "${backup_location}" || fail "Backup verification failed for '${backup_location}'."
}

# ─── Argument parsing ───────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --verify-only)
      VERIFY_ONLY=true
      BACKUP_TO_VERIFY="${2:-}"
      if [[ -z "${BACKUP_TO_VERIFY}" ]]; then
        fail "--verify-only requires a backup path or URI argument."
      fi
      shift 2
      ;;
    -h|--help)
      # Extract usage text between marker lines so --help is robust to
      # future edits that add/remove lines from the header comment.
      awk '/^# --- USAGE START ---/{found=1; next} /^# --- USAGE END ---/{exit} found{sub(/^# ?/,""); print}' "$0"
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

if [[ "${VERIFY_ONLY}" == true ]]; then
  require_sqlite3
  run_verification "${BACKUP_TO_VERIFY}"
  exit 0
fi

# ─── Validation ───────────────────────────────────────────────────────────────

if [[ -z "${BACKUP_DEST}" ]]; then
  fail "BACKUP_DEST is not set. Provide a local path or an S3/GCS URI."
fi

if [[ ! -f "${DB_PATH}" ]]; then
  fail "Database file not found: ${DB_PATH}"
fi

require_sqlite3
capture_source_counts

log "Starting backup of '${DB_PATH}' → '${BACKUP_DEST}/${BACKUP_FILENAME}'"
log "Source row counts: players=${EXPECT_PLAYERS}, events=${EXPECT_EVENTS}, migrations=${EXPECT_MIGRATIONS}"

# ─── Copy ─────────────────────────────────────────────────────────────────────

COUNTS_FILE="$(mktemp)"
write_counts_file "${COUNTS_FILE}"
trap 'rm -f "${COUNTS_FILE}"' EXIT

if [[ "${BACKUP_DEST}" == s3://* ]]; then
  if ! command -v aws &>/dev/null; then
    fail "'aws' CLI not found. Install it to use S3 backups."
  fi
  aws s3 cp "${DB_PATH}" "${BACKUP_DEST}/${BACKUP_FILENAME}" || fail "aws s3 cp failed."
  upload_counts_sidecar "${COUNTS_FILE}"

elif [[ "${BACKUP_DEST}" == gs://* ]]; then
  if ! command -v gsutil &>/dev/null; then
    fail "'gsutil' not found. Install the Google Cloud SDK to use GCS backups."
  fi
  gsutil cp "${DB_PATH}" "${BACKUP_DEST}/${BACKUP_FILENAME}" || fail "gsutil cp failed."
  upload_counts_sidecar "${COUNTS_FILE}"

else
  mkdir -p "${BACKUP_DEST}" || fail "Could not create backup directory '${BACKUP_DEST}'."
  cp "${DB_PATH}" "${BACKUP_DEST}/${BACKUP_FILENAME}" || fail "cp failed."
  upload_counts_sidecar "${COUNTS_FILE}"
fi

log "Backup complete: ${BACKUP_DEST}/${BACKUP_FILENAME}"

# ─── Verify ───────────────────────────────────────────────────────────────────

if [[ "${BACKUP_DEST}" == s3://* || "${BACKUP_DEST}" == gs://* ]]; then
  run_verification "${BACKUP_DEST}/${BACKUP_FILENAME}"
else
  run_verification "${BACKUP_DEST}/${BACKUP_FILENAME}" "${BACKUP_DEST}/${BACKUP_FILENAME}.counts"
fi

log "Backup verified successfully."
