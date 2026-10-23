-- Migration 028: Security event pub/sub metrics (PostgreSQL)
--
-- PostgreSQL counterpart of 028_security_event_metrics.sql (SQLite).
-- Mirrors security_event_log with repo Postgres conventions (SERIAL
-- primary key, BIGINT timestamps).

CREATE TABLE IF NOT EXISTS security_event_log (
  id                 SERIAL PRIMARY KEY,
  event_type         TEXT   NOT NULL,
  subject            TEXT   NOT NULL,
  origin_instance_id TEXT   NOT NULL,
  propagated_count   INTEGER DEFAULT 0,
  created_at         BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_security_event_log_type ON security_event_log (event_type);
CREATE INDEX IF NOT EXISTS idx_security_event_log_subject ON security_event_log (subject);
CREATE INDEX IF NOT EXISTS idx_security_event_log_created_at ON security_event_log (created_at);
