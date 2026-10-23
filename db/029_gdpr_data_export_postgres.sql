-- Migration 029 (Postgres): GDPR data-export jobs (#1330)
--
-- Postgres twin of db/029_gdpr_data_export.sql. Keeps timestamp columns as
-- BIGINT epoch values, consistent with the other Postgres migrations.

CREATE TABLE IF NOT EXISTS data_export_jobs (
  id              BIGSERIAL PRIMARY KEY,
  request_type    TEXT    NOT NULL CHECK (request_type IN ('player','scout')),
  requester_id    TEXT    NOT NULL,
  requester_ip    TEXT,
  status          TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
  archive_path    TEXT,
  archive_hash    TEXT,
  error_reason    TEXT,
  created_at      BIGINT  NOT NULL,
  started_at      BIGINT,
  completed_at    BIGINT,
  expires_at      BIGINT
);

CREATE TABLE IF NOT EXISTS export_download_tokens (
  id              BIGSERIAL PRIMARY KEY,
  job_id          BIGINT  NOT NULL REFERENCES data_export_jobs(id) ON DELETE CASCADE,
  token           TEXT    NOT NULL UNIQUE,
  used_at         BIGINT,
  expires_at      BIGINT  NOT NULL,
  created_at      BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_data_export_jobs_requester_id ON data_export_jobs (requester_id);
CREATE INDEX IF NOT EXISTS idx_data_export_jobs_status ON data_export_jobs (status);
CREATE INDEX IF NOT EXISTS idx_data_export_jobs_created_at ON data_export_jobs (created_at);
-- token already has a UNIQUE index; kept for parity with the SQLite migration.
CREATE INDEX IF NOT EXISTS idx_export_download_tokens_token ON export_download_tokens (token);
CREATE INDEX IF NOT EXISTS idx_export_download_tokens_job_id ON export_download_tokens (job_id);
