-- Migration 029: GDPR data-export jobs (#1330)
--
-- The platform supports erasure (POST /api/players/:playerId/anonymize) but
-- lacks a mechanism for data subjects to exercise their right of access
-- (GDPR Art. 15/20). This migration adds asynchronous data-export jobs
-- producing time-limited, downloadable JSON archives.
--
-- New tables:
--   - data_export_jobs: tracks pending/completed export requests
--   - export_download_tokens: single-use download URLs with expiry

CREATE TABLE IF NOT EXISTS data_export_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  request_type    TEXT    NOT NULL,  -- 'player' or 'scout'
  requester_id    TEXT    NOT NULL,  -- player_id or scout wallet
  requester_ip    TEXT,
  status          TEXT    NOT NULL DEFAULT 'pending',  -- pending, processing, completed, failed
  archive_path    TEXT,              -- path to stored archive (local volume or object store)
  archive_hash    TEXT,              -- SHA256 of encrypted archive for verification
  error_reason    TEXT,
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  completed_at    INTEGER,
  expires_at      INTEGER            -- archive auto-delete deadline (24-72h)
);

CREATE TABLE IF NOT EXISTS export_download_tokens (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          INTEGER NOT NULL REFERENCES data_export_jobs(id) ON DELETE CASCADE,
  token           TEXT    NOT NULL UNIQUE,  -- random single-use token
  used_at         INTEGER,                  -- timestamp of first/only download
  expires_at      INTEGER NOT NULL,        -- token expiry (short-lived, e.g. 24h)
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_data_export_jobs_requester_id ON data_export_jobs (requester_id);
CREATE INDEX IF NOT EXISTS idx_data_export_jobs_status ON data_export_jobs (status);
CREATE INDEX IF NOT EXISTS idx_data_export_jobs_created_at ON data_export_jobs (created_at);
CREATE INDEX IF NOT EXISTS idx_export_download_tokens_token ON export_download_tokens (token);
CREATE INDEX IF NOT EXISTS idx_export_download_tokens_job_id ON export_download_tokens (job_id);
