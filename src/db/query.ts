/**
 * Shared database plumbing: connection lifecycle, driver access and the
 * timing/observability wrappers used by every repository module (#1535).
 *
 * Domain query helpers live in `src/db/repositories/<domain>.ts`; this module
 * is imported by those repositories (never the other way round) so the
 * dependency graph stays acyclic.
 */
import type Database from 'better-sqlite3';
import crypto from 'crypto';
import config from '../config';
import { EventRecord, ContractEventType } from '../types';
import { EVENTS_ORDER_BY_SQL } from '../services/eventOrdering';
import { runMigrations } from './migrate';
import { logger } from '../utils/logger';
import { computeChainHash, auditChainContent, GENESIS_HASH } from '../utils/hashChain';
import { encryptWebhookSecret, decryptWebhookSecret } from '../utils/webhookSecretCipher';
import { decryptField, encryptField } from '../utils/fieldCipher';
import { DbDriver } from './driver';
import { SqliteDriver } from './sqlite-driver';
import { PostgresDriver } from './postgres-driver';
import {
  createBetterSqlite3LoadError,
  isBetterSqlite3LoadFailure,
} from './betterSqlite3Error';
import { ApiKeyLimitError, MAX_API_KEYS_PER_SCOUT, MAX_WEBHOOK_SUBSCRIPTIONS_PER_SCOUT, WebhookSubscriptionLimitError } from '../utils/scoutResourceLimits';

function slowQueryThresholdMs(): number {
  return parseInt(process.env.SLOW_QUERY_THRESHOLD_MS ?? '50', 10);
}

/**
 * Runs fn(), logs a structured warning if it takes longer than
 * SLOW_QUERY_THRESHOLD_MS.
 *
 * Structured log fields:
 *  - query_name:  the SQL statement (used as a human-readable identifier)
 *  - duration_ms: elapsed time in milliseconds
 *  - row_count:   number of rows returned (arrays) or affected (RunResult);
 *                 -1 when the result type carries no row count
 */
export function timedQuery<T>(sql: string, fn: () => T): T {
  const start = Date.now();
  const result = fn();
  const duration_ms = Date.now() - start;
  if (duration_ms >= slowQueryThresholdMs()) {
    // Derive a best-effort row count from the return value.
    let row_count = -1;
    if (Array.isArray(result)) {
      row_count = result.length;
    } else if (
      result !== null &&
      typeof result === 'object' &&
      'changes' in (result as object) &&
      typeof (result as unknown as { changes: unknown }).changes === 'number'
    ) {
      row_count = (result as unknown as { changes: number }).changes;
    } else if (result !== null && result !== undefined && !Array.isArray(result) && typeof result !== 'object') {
      // scalar (number, boolean, string) — treat as 1 row
      row_count = 1;
    }
    logger.warn({ query_name: sql, duration_ms, row_count });
  }
  return result;
}

/** Async counterpart to {@link timedQuery} for DbDriver-backed call sites. */
export async function timedQueryAsync<T>(sql: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  const result = await fn();
  const duration = Date.now() - start;
  if (duration >= slowQueryThresholdMs()) {
    logger.warn(`[db] slow query ${duration}ms: ${sql}`);
  }
  return result;
}

// ─── Connection & schema ──────────────────────────────────────────────────────

let _driver: DbDriver | null = null;
let _db: Database.Database | null = null;

/**
 * Initialise the database connection and run pending migrations.
 * Must be called once at application startup before any query helper is used.
 * Safe to call in tests with DB_PATH=:memory: set before import.
 * 
 * For PostgreSQL, this must be awaited as it requires async connection setup.
 */
export async function initDb(): Promise<void> {
  if (config.dbDriver === 'postgres') {
    // PostgreSQL initialization
    if (!config.databaseUrl) {
      throw new Error(
        'DATABASE_URL environment variable is required when DB_DRIVER=postgres'
      );
    }

    const pgDriver = new PostgresDriver(config.databaseUrl, config.databaseSsl, config.databasePoolSize, {
      statementTimeoutMs: config.databaseStatementTimeoutMs,
      queryTimeoutMs: config.databaseQueryTimeoutMs,
      idleInTransactionSessionTimeoutMs: config.databaseIdleTransactionTimeoutMs,
    });
    await pgDriver.connect();
    _driver = pgDriver;

    logger.info(`[db] Connected to PostgreSQL (pool size ${config.databasePoolSize})`);
  } else {
    // SQLite initialization (default). Load the native addon lazily so a
    // missing/wrong-ABI binding becomes a clear startup error instead of an
    // opaque require failure at module import time.
    let BetterSqlite3: typeof import('better-sqlite3');
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      BetterSqlite3 = require('better-sqlite3');
    } catch (err) {
      throw createBetterSqlite3LoadError(err);
    }

    let sqliteDb: Database.Database;
    try {
      sqliteDb = new BetterSqlite3(config.dbPath);
    } catch (err) {
      if (isBetterSqlite3LoadFailure(err)) {
        throw createBetterSqlite3LoadError(err);
      }
      throw err;
    }
    // WAL mode lets readers and a writer proceed concurrently instead of
    // blocking each other on the default rollback journal, and busy_timeout
    // makes a writer that contends for the single write lock retry for a
    // bounded, configurable period instead of failing immediately with SQLITE_BUSY.
    sqliteDb.pragma('journal_mode = WAL');
    sqliteDb.pragma(`busy_timeout = ${config.sqliteBusyTimeoutMs}`);
    _db = sqliteDb;
    _driver = new SqliteDriver(sqliteDb);

    // Create initial schema inline (for backwards compatibility with in-memory test databases)
    await _driver.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        type                 TEXT NOT NULL,
        ledger               INTEGER NOT NULL,
        ledger_hash          TEXT,
        tx_hash              TEXT NOT NULL,
        payload              TEXT NOT NULL,
        created_at           INTEGER,
        tx_application_order INTEGER NOT NULL DEFAULT 0,
        event_index          INTEGER NOT NULL DEFAULT 0,
        contract_id          TEXT NOT NULL DEFAULT ''
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_tx_event ON events (tx_hash, event_index);
      CREATE INDEX IF NOT EXISTS idx_events_ledger ON events (ledger);
      CREATE INDEX IF NOT EXISTS idx_events_type_ledger ON events (type, ledger);
      CREATE INDEX IF NOT EXISTS idx_events_ordinal ON events (ledger, tx_application_order, event_index, contract_id);
      CREATE TABLE IF NOT EXISTS tx_correlations (
        tx_hash        TEXT PRIMARY KEY,
        correlation_id TEXT NOT NULL,
        created_at     INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS indexer_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS players (
        player_id      TEXT    PRIMARY KEY,
        wallet         TEXT    NOT NULL,
        position       TEXT,
        region         TEXT,
        metadata_uri   TEXT,
        progress_level INTEGER DEFAULT 0,
        created_at     INTEGER,
        registered_at  INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_players_region        ON players (region);
      CREATE INDEX IF NOT EXISTS idx_players_position      ON players (position);
      CREATE INDEX IF NOT EXISTS idx_players_tier          ON players (progress_level);
      CREATE INDEX IF NOT EXISTS idx_players_registered_at ON players (registered_at);
      CREATE TABLE IF NOT EXISTS validator_stats (
        wallet             TEXT PRIMARY KEY,
        milestones_approved INTEGER DEFAULT 0,
        milestones_rejected INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS pending_milestones (
        milestone_id    TEXT PRIMARY KEY,
        player_id       TEXT NOT NULL,
        validator_wallet TEXT NOT NULL,
        milestone_type  TEXT NOT NULL,
        evidence_uri    TEXT NOT NULL,
        submitted_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pending_milestones_validator ON pending_milestones (validator_wallet);
      CREATE INDEX IF NOT EXISTS idx_pending_milestones_player ON pending_milestones (player_id);
      CREATE TABLE IF NOT EXISTS contact_unlocks (
        scout_wallet TEXT    NOT NULL,
        player_id    TEXT    NOT NULL,
        tx_hash      TEXT    NOT NULL,
        unlocked_at  INTEGER NOT NULL,
        PRIMARY KEY (scout_wallet, player_id)
      );
      CREATE INDEX IF NOT EXISTS idx_contact_unlocks_scout ON contact_unlocks (scout_wallet);
      CREATE TABLE IF NOT EXISTS indexer_unprocessed_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        type        TEXT,
        ledger      INTEGER,
        tx_hash     TEXT NOT NULL,
        event_index INTEGER NOT NULL DEFAULT 0,
        contract_id TEXT,
        topic_json  TEXT,
        value_xdr   TEXT,
        reason      TEXT NOT NULL,
        payload     TEXT,
        created_at  INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_indexer_unprocessed_tx_event
        ON indexer_unprocessed_events (tx_hash, event_index);
    `);

    logger.info(`[db] Connected to SQLite at ${config.dbPath}`);
  }

  // Run migrations (SQL migration files from db/ directory)
  await runMigrations(_driver);

  // Seed a subscription row for the legacy WEBHOOK_URL/WEBHOOK_ENABLED config on
  // first startup, so single-subscriber deployments keep working with the new
  // DB-backed subscription model without any manual migration step.
  // Imported lazily so this module never has a static dependency on a
  // repository (repositories import this module, not the other way round).
  const { ensureLegacyWebhookSubscription } = await import(
    './repositories/webhookSubscriptions'
  );
  ensureLegacyWebhookSubscription();
}

export function getDriver(): DbDriver {
  if (!_driver) throw new Error("Database not initialised — call initDb() first");
  return _driver;
}

export function getDb(): Database.Database {
  if (!_db) throw new Error("Database not initialised — call initDb() first for SQLite");
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_driver) {
    await _driver.close();
    _driver = null;
  }
  if (_db) {
    _db.close();
    _db = null;
  }
}
