import type Database from 'better-sqlite3';
import crypto from 'crypto';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import config from '../config';
import { EventRecord, ContractEventType } from '../types';
import { EVENTS_ORDER_BY_SQL } from '../services/eventOrdering';
import { runMigrations } from './migrate';
import { logger } from '../utils/logger';
import { computeChainHash, auditChainContent, GENESIS_HASH } from '../utils/hashChain';
import { encryptWebhookSecret, decryptWebhookSecret } from '../utils/webhookSecretCipher';
import { DbDriver } from './driver';
import { SqliteDriver } from './sqlite-driver';
import { PostgresDriver } from './postgres-driver';
import { observeDbQueryDuration } from '../middleware/metrics';
import {
  createBetterSqlite3LoadError,
  isBetterSqlite3LoadFailure,
} from './betterSqlite3Error';

const dbTracer = trace.getTracer('scout-off-backend');

/**
 * Thin wrapper that creates a DB span, runs fn(), sets ipfs.cid on success,
 * records exception and ERROR status on throw. Zero-cost when OTEL is not
 * configured (noop tracer).
 */
function withDbSpan<T>(name: string, sql: string, fn: () => T): T {
  const span = dbTracer.startSpan(`db.${name}`, {
    attributes: { 'db.system': 'sqlite', 'db.statement': sql.slice(0, 200) },
  });
  try {
    const result = fn();
    span.end();
    return result;
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
    span.end();
    throw err;
  }
}

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

    const pgDriver = new PostgresDriver(config.databaseUrl, config.databaseSsl, config.databasePoolSize);
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
    // makes a writer that does contend for the single write lock retry for
    // up to 5s instead of failing immediately with SQLITE_BUSY.
    sqliteDb.pragma('journal_mode = WAL');
    sqliteDb.pragma('busy_timeout = 5000');
    _db = sqliteDb;
    _driver = new SqliteDriver(sqliteDb);

    // Create initial schema inline (for backwards compatibility with in-memory test databases)
    _driver.exec(`
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
    `);

    logger.info(`[db] Connected to SQLite at ${config.dbPath}`);
  }

  // Run migrations (SQL migration files from db/ directory)
  await runMigrations(_driver);

  // Seed a subscription row for the legacy WEBHOOK_URL/WEBHOOK_ENABLED config on
  // first startup, so single-subscriber deployments keep working with the new
  // DB-backed subscription model without any manual migration step.
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

// ─── State helpers ────────────────────────────────────────────────────────────

export function fetchLastIndexedLedger(): number {
  const sql = 'SELECT value FROM indexer_state WHERE key = ?';
  const row = timedQuery(sql, () =>
    getDb().prepare(sql).get('last_ledger') as { value: string } | undefined
  );
  return row ? parseInt(row.value, 10) : 0;
}

/** @deprecated Use fetchLastIndexedLedger instead. Will be removed in next release. */
export const getLastLedger = fetchLastIndexedLedger;

export function persistLastIndexedLedger(ledger: number): void {
  const sql = 'INSERT INTO indexer_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';
  timedQuery(sql, () => getDb().prepare(sql).run('last_ledger', String(ledger)));
}

/** @deprecated Use persistLastIndexedLedger instead. Will be removed in next release. */
export const setLastLedger = persistLastIndexedLedger;

// ─── Query helpers ────────────────────────────────────────────────────────────

interface EventRow {
  type: string;
  payload: string;
  created_at: number | null;
  ledger_hash: string | null;
}

export interface GetEventsOptions {
  limit?: number;
  offset?: number;
}

export function queryEvents(
  type?: ContractEventType,
  opts?: GetEventsOptions,
): EventRecord[] {
  const db = getDb();
  const { limit, offset } = opts ?? {};
  const hasPagination = limit !== undefined && offset !== undefined;

  let sql: string;
  let rows: EventRow[];
  if (type && hasPagination) {
    // sql-injection-check-ignore: EVENTS_ORDER_BY_SQL is a hardcoded ORDER BY fragment; values are bound via params.
    sql = `SELECT * FROM events WHERE type = ? ORDER BY ${EVENTS_ORDER_BY_SQL} LIMIT ? OFFSET ?`;
    rows = timedQuery(sql, () => db.prepare(sql).all(type, limit, offset) as EventRow[]);
  } else if (type) {
    // sql-injection-check-ignore: EVENTS_ORDER_BY_SQL is a hardcoded ORDER BY fragment; values are bound via params.
    sql = `SELECT * FROM events WHERE type = ? ORDER BY ${EVENTS_ORDER_BY_SQL}`;
    rows = timedQuery(sql, () => db.prepare(sql).all(type) as EventRow[]);
  } else if (hasPagination) {
    // sql-injection-check-ignore: EVENTS_ORDER_BY_SQL is a hardcoded ORDER BY fragment; values are bound via params.
    sql = `SELECT * FROM events ORDER BY ${EVENTS_ORDER_BY_SQL} LIMIT ? OFFSET ?`;
    rows = timedQuery(sql, () => db.prepare(sql).all(limit, offset) as EventRow[]);
  } else {
    // sql-injection-check-ignore: EVENTS_ORDER_BY_SQL is a hardcoded ORDER BY fragment; values are bound via params.
    sql = `SELECT * FROM events ORDER BY ${EVENTS_ORDER_BY_SQL}`;
    rows = timedQuery(sql, () => db.prepare(sql).all() as EventRow[]);
  }

  return rows.map((r) => ({
    source: config.contractId,
    type: r.type as ContractEventType,
    payload: JSON.parse(r.payload),
    contractAddress: config.contractId,
    created_at: r.created_at,
  }));
}

/** @deprecated Use queryEvents instead. Will be removed in next release. */
export const getEvents = queryEvents;

export function rollbackEventsFromLedger(ledger: number): void {
  const db = getDb();
  // Delete pending milestones associated with these events (since they might be re-indexed)
  // Actually, wait, it's safer to just let the indexer re-insert, but pending_milestones has a unique milestone_id so INSERT OR IGNORE will handle it.
  // We'll delete events from the specified ledger forwards.
  db.prepare('DELETE FROM events WHERE ledger >= ?').run(ledger);
}

export function getEventsCount(type?: ContractEventType): number {
  const db = getDb();
  const sql = type
    ? 'SELECT COUNT(*) AS count FROM events WHERE type = ?'
    : 'SELECT COUNT(*) AS count FROM events';
  const row = type
    ? timedQuery(sql, () => db.prepare(sql).get(type) as { count: number } | undefined)
    : timedQuery(sql, () => db.prepare(sql).get() as { count: number } | undefined);
  return row?.count ?? 0;
}

/** Filter accepted by {@link getEventsPage} — mirrors `adminDateRangeSchema` in adminController. */
export interface EventsPageFilter {
  type?: ContractEventType;
  startDate?: Date;
  endDate?: Date;
}

/**
 * Opaque cursor used by the keyset-pagination variant of the events listing.
 * Encodes the (ledger, id) position of the last row returned on the previous
 * page so that the next page starts immediately after it, independent of
 * concurrent inserts.
 */
export interface EventsCursor {
  ledger: number;
  id: number;
}

/**
 * Encode a (ledger, id) pair into a URL-safe opaque cursor string.
 */
export function encodeEventsCursor(cursor: EventsCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

/**
 * Decode a cursor string produced by {@link encodeEventsCursor}.
 * Returns `null` when the value is missing, malformed, or contains
 * non-integer fields — callers should treat `null` as "start from the
 * beginning".
 */
export function decodeEventsCursor(raw: string | undefined): EventsCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'ledger' in parsed &&
      'id' in parsed &&
      Number.isInteger((parsed as Record<string, unknown>).ledger) &&
      Number.isInteger((parsed as Record<string, unknown>).id)
    ) {
      return parsed as EventsCursor;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch one page of events using a stable keyset cursor over (ledger DESC, id DESC).
 * When `afterCursor` is supplied only rows with (ledger, id) < (cursor.ledger, cursor.id)
 * are returned, making pagination stable under concurrent inserts.
 *
 * Returns up to `limit` rows and, when there are more rows beyond the page, a
 * `nextCursor` value ready to be encoded and returned to the client.
 */
export function getEventsPageKeyset(
  filter: EventsPageFilter,
  limit: number,
  afterCursor: EventsCursor | null,
): { rows: EventExportRow[]; nextCursor: EventsCursor | null } {
  const db = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.type) {
    clauses.push('type = ?');
    params.push(filter.type);
  }
  if (filter.startDate) {
    clauses.push('created_at >= ?');
    params.push(filter.startDate.getTime());
  }
  if (filter.endDate) {
    clauses.push('created_at <= ?');
    params.push(filter.endDate.getTime());
  }
  if (afterCursor) {
    // Keyset condition: rows that come before the cursor in DESC order
    clauses.push('(ledger < ? OR (ledger = ? AND id < ?))');
    params.push(afterCursor.ledger, afterCursor.ledger, afterCursor.id);
  }

  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  // Fetch one extra row to know whether a next page exists
  const fetchLimit = limit + 1;
  params.push(fetchLimit);

  const sql =
    'SELECT id, type, ledger, payload, created_at FROM events ' +
    where +
    ' ORDER BY ledger DESC, id DESC LIMIT ?';

  const rawRows = timedQuery(sql, () => db.prepare(sql).all(...(params as unknown[]))) as Array<{
    id: number;
    type: string;
    ledger: number;
    payload: string;
    created_at: number | null;
  }>;

  const hasMore = rawRows.length > limit;
  const pageRows = hasMore ? rawRows.slice(0, limit) : rawRows;

  const rows: EventExportRow[] = pageRows.map((r) => ({
    type: r.type as ContractEventType,
    ledger: r.ledger,
    createdAt: r.created_at,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
  }));

  let nextCursor: EventsCursor | null = null;
  if (hasMore && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1]!;
    nextCursor = { ledger: last.ledger, id: last.id };
  }

  return { rows, nextCursor };
}

/** A single row read directly off the `events` table, including `ledger`, for CSV export. */
export interface EventExportRow {
  type: ContractEventType;
  ledger: number;
  createdAt: number | null;
  payload: Record<string, unknown>;
}

/**
 * Count indexed events at the SQL level, filtered by type and/or created_at range.
 * Used to populate the `total` field in paginated event responses without loading
 * all matching rows into memory.
 */
export function countEventsFiltered(filter: EventsPageFilter): number {
  const db = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.type) {
    clauses.push('type = ?');
    params.push(filter.type);
  }
  if (filter.startDate) {
    clauses.push('created_at >= ?');
    params.push(filter.startDate.getTime());
  }
  if (filter.endDate) {
    clauses.push('created_at <= ?');
    params.push(filter.endDate.getTime());
  }

  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const sql = 'SELECT COUNT(*) AS count FROM events ' + where;
  const row = timedQuery(sql, () =>
    db.prepare(sql).get(...(params as unknown[])) as { count: number } | undefined,
  );
  return row?.count ?? 0;
}

/**
 * Fetches one bounded page of indexed events (LIMIT/OFFSET), filtered at the
 * SQL level by type and/or created_at range, ordered by ledger ascending
 * (ties broken by insertion order via `id`).
 *
 * This is the building block that makes streaming export possible: callers
 * loop, increasing `offset` by `limit` each time, until a page comes back
 * shorter than `limit` — at no point does the whole table need to live in
 * memory at once.
 */
export function getEventsPage(filter: EventsPageFilter, limit: number, offset: number): EventExportRow[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.type) {
    clauses.push('type = ?');
    params.push(filter.type);
  }
  if (filter.startDate) {
    clauses.push('created_at >= ?');
    params.push(filter.startDate.getTime());
  }
  if (filter.endDate) {
    clauses.push('created_at <= ?');
    params.push(filter.endDate.getTime());
  }

  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const sql =
    'SELECT type, ledger, payload, created_at FROM events ' +
    where +
    ` ORDER BY ${EVENTS_ORDER_BY_SQL} LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = timedQuery(sql, () => db.prepare(sql).all(...(params as unknown[]))) as Array<{
    type: string;
    ledger: number;
    payload: string;
    created_at: number | null;
  }>;

  return rows.map((r) => ({
    type: r.type as ContractEventType,
    ledger: r.ledger,
    createdAt: r.created_at,
    payload: JSON.parse(r.payload),
  }));
}

/**
 * Generator that lazily yields one event row at a time using
 * better-sqlite3's `Statement.iterate()` cursor, filtered by type and/or
 * created_at range, ordered by ledger ascending (ties broken by id).
 *
 * Unlike LIMIT/OFFSET pagination this uses a single prepared statement
 * cursor, so the result is a stable snapshot that does not drift when the
 * indexer inserts rows concurrently — no duplicates or skipped rows.
 */
export function* getEventsIterable(filter: EventsPageFilter): Generator<EventExportRow, void, void> {
  const db = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.type) {
    clauses.push('type = ?');
    params.push(filter.type);
  }
  if (filter.startDate) {
    clauses.push('created_at >= ?');
    params.push(filter.startDate.getTime());
  }
  if (filter.endDate) {
    clauses.push('created_at <= ?');
    params.push(filter.endDate.getTime());
  }

  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const sql =
    'SELECT type, ledger, payload, created_at FROM events ' +
    where +
    ` ORDER BY ${EVENTS_ORDER_BY_SQL}`;

  const stmt = db.prepare(sql);
  const iterator = stmt.iterate(...(params as unknown[])) as IterableIterator<{
    type: string;
    ledger: number;
    payload: string;
    created_at: number | null;
  }>;

  for (const row of iterator) {
    yield {
      type: row.type as ContractEventType,
      ledger: row.ledger,
      createdAt: row.created_at,
      payload: JSON.parse(row.payload),
    };
  }
}

// ─── Player table helpers ─────────────────────────────────────────────────────

export interface PlayerRow {
  player_id: string;
  wallet: string;
  position: string | null;
  region: string | null;
  metadata_uri: string | null;
  progress_level: number;
  created_at: number | null;
  registered_at: number;
  is_active: number;
}

export interface ScoredPlayerRow extends PlayerRow {
  search_score: number;
}

export interface QueryPlayersOptions {
  region?: string;
  position?: string;
  minTier?: number;
  limit?: number;
  offset?: number;
  includeDeactivated?: boolean;
}

export interface PlayerProfileHistoryRow {
  id: number;
  metadata_uri: string;
  changed_at: number;
  tx_hash: string;
}

export async function insertPlayerProfileHistory(p: {
  player_id: string;
  metadata_uri: string;
  changed_at: number;
  tx_hash: string;
}): Promise<void> {
  const sql = `INSERT INTO player_profile_history (player_id, metadata_uri, changed_at, tx_hash)
       VALUES (?, ?, ?, ?)`;
  await timedQueryAsync(sql, () =>
    getDriver().run(sql, [p.player_id, p.metadata_uri, p.changed_at, p.tx_hash]),
  );
}

export async function getPlayerProfileHistory(
  playerId: string,
): Promise<PlayerProfileHistoryRow[]> {
  const sql = `SELECT id, metadata_uri, changed_at, tx_hash
       FROM player_profile_history
       WHERE player_id = ?
       ORDER BY changed_at DESC`;
  return timedQueryAsync(sql, () => getDriver().all<PlayerProfileHistoryRow>(sql, [playerId]));
}

/**
 * Returns all history rows for a player ordered oldest-first (ASC), with a
 * 1-based `version` number assigned by insertion order. The version number is
 * derived from the row's position in the ascending sequence so it is stable
 * even after rows are inserted concurrently.
 */
export async function getPlayerProfileHistoryVersioned(
  playerId: string,
): Promise<Array<PlayerProfileHistoryRow & { version: number }>> {
  const sql = `SELECT id, metadata_uri, changed_at, tx_hash
       FROM player_profile_history
       WHERE player_id = ?
       ORDER BY id ASC`;
  const rows = await timedQueryAsync(sql, () => getDriver().all<PlayerProfileHistoryRow>(sql, [playerId]));

  return rows.map((row, idx) => ({ ...row, version: idx + 1 }));
}

export async function insertOrUpdatePlayer(p: {
  player_id: string;
  wallet: string;
  position?: string;
  region?: string;
  metadata_uri?: string;
  created_at?: number;
  registered_at?: number;
}): Promise<void> {
  const sql = `INSERT INTO players (player_id, wallet, position, region, metadata_uri, created_at, registered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET
         wallet       = excluded.wallet,
         position     = excluded.position,
         region       = excluded.region,
         metadata_uri = excluded.metadata_uri`;
  await timedQueryAsync(sql, () =>
    getDriver().run(sql, [p.player_id, p.wallet, p.position ?? null, p.region ?? null, p.metadata_uri ?? null, p.created_at ?? null, p.registered_at ?? 0])
  );
}

/** @deprecated Use insertOrUpdatePlayer instead. Will be removed in next release. */
export const upsertPlayer = insertOrUpdatePlayer;

export async function updatePlayerProgress(playerId: string, level: number): Promise<void> {
  const sql = 'UPDATE players SET progress_level = ? WHERE player_id = ?';
  await timedQueryAsync(sql, () => getDriver().run(sql, [level, playerId]));
}

export interface ValidatorStatsRow {
  wallet: string;
  milestones_approved: number;
  milestones_rejected: number;
}

export async function incrementValidatorApproved(wallet: string): Promise<void> {
  const sql = `INSERT INTO validator_stats (wallet, milestones_approved, milestones_rejected)
               VALUES (?, 1, 0)
               ON CONFLICT(wallet) DO UPDATE SET milestones_approved = milestones_approved + 1`;
  await timedQueryAsync(sql, () => getDriver().run(sql, [wallet]));
}

export async function incrementValidatorRejected(wallet: string): Promise<void> {
  const sql = `INSERT INTO validator_stats (wallet, milestones_approved, milestones_rejected)
               VALUES (?, 0, 1)
               ON CONFLICT(wallet) DO UPDATE SET milestones_rejected = milestones_rejected + 1`;
  await timedQueryAsync(sql, () => getDriver().run(sql, [wallet]));
}

export async function getValidatorStats(wallet: string): Promise<ValidatorStatsRow | null> {
  const sql = 'SELECT * FROM validator_stats WHERE wallet = ?';
  return timedQueryAsync(sql, async () =>
    (await getDriver().get<ValidatorStatsRow>(sql, [wallet])) ?? null
  );
}

export interface PendingMilestoneRow {
  milestone_id: string;
  player_id: string;
  validator_wallet: string;
  milestone_type: string;
  evidence_uri: string;
  submitted_at: number;
}

export async function insertPendingMilestone(
  milestoneId: string,
  playerId: string,
  validatorWallet: string,
  milestoneType: string,
  evidenceUri: string,
  submittedAt: number
): Promise<void> {
  const sql = `INSERT INTO pending_milestones
               (milestone_id, player_id, validator_wallet, milestone_type, evidence_uri, submitted_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT (milestone_id) DO NOTHING`;
  await timedQueryAsync(sql, () =>
    getDriver().run(sql, [milestoneId, playerId, validatorWallet, milestoneType, evidenceUri, submittedAt])
  );
}

export async function removePendingMilestone(milestoneId: string): Promise<void> {
  const sql = 'DELETE FROM pending_milestones WHERE milestone_id = ?';
  await timedQueryAsync(sql, () => getDriver().run(sql, [milestoneId]));
}

/**
 * Cancel (delete) all pending milestones for a given player.
 * Returns the number of rows removed.
 */
export async function cancelPendingMilestonesForPlayer(playerId: string): Promise<number> {
  const sql = 'DELETE FROM pending_milestones WHERE player_id = ?';
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [playerId]);
    return info.changes;
  });
}

export interface GetPendingMilestonesOptions {
  validatorWallet?: string;
  position?: string;
  region?: string;
  playerId?: string;
  page?: number;
  pageSize?: number;
}

export async function getPendingMilestones(options: GetPendingMilestonesOptions): Promise<{ data: PendingMilestoneRow[], total: number }> {
  const driver = getDriver();
  // We need to join with players to filter by position and region
  const whereConditions: string[] = [];
  const params: (string | number)[] = [];

  if (options.validatorWallet) {
    whereConditions.push('pm.validator_wallet = ?');
    params.push(options.validatorWallet);
  }
  if (options.position) {
    whereConditions.push('p.position = ?');
    params.push(options.position);
  }
  if (options.region) {
    whereConditions.push('p.region = ?');
    params.push(options.region);
  }
  if (options.playerId) {
    whereConditions.push('pm.player_id = ?');
    params.push(options.playerId);
  }

  const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';

  // Get total count
  // sql-injection-check-ignore: `whereClause` is built from hardcoded `col = ?` conditions; values are bound via params.
  const countSql = `SELECT COUNT(*) AS total FROM pending_milestones pm
                    LEFT JOIN players p ON pm.player_id = p.player_id
                    ${whereClause}`;
  const countRow = await timedQueryAsync(countSql, () => driver.get<{ total: number }>(countSql, params));
  const total = Number(countRow?.total ?? 0);

  // Get paginated data
  const page = options.page || 1;
  const pageSize = options.pageSize || 20;
  const offset = (page - 1) * pageSize;
  // sql-injection-check-ignore: `whereClause` is built from hardcoded `col = ?` conditions; values are bound via params.
  const dataSql = `SELECT pm.* FROM pending_milestones pm
                   LEFT JOIN players p ON pm.player_id = p.player_id
                   ${whereClause}
                   ORDER BY pm.submitted_at DESC
                   LIMIT ? OFFSET ?`;
  const data = await timedQueryAsync(dataSql, () =>
    driver.all<PendingMilestoneRow>(dataSql, [...params, pageSize, offset])
  );

  return { data, total };
}

export async function getPlayerById(playerId: string): Promise<PlayerRow | null> {
  const sql = 'SELECT * FROM players WHERE player_id = ?';
  return timedQueryAsync(sql, async () =>
    (await getDriver().get<PlayerRow>(sql, [playerId])) ?? null
  );
}

export async function getPlayerByWallet(wallet: string): Promise<PlayerRow | null> {
  const sql = 'SELECT * FROM players WHERE wallet = ?';
  return timedQueryAsync(sql, async () =>
    (await getDriver().get<PlayerRow>(sql, [wallet])) ?? null
  );
}

export async function deactivatePlayer(playerId: string): Promise<void> {
  const sql = 'UPDATE players SET is_active = 0 WHERE player_id = ?';
  await timedQueryAsync(sql, () => getDriver().run(sql, [playerId]));
}

/** Deactivate a player and persist a human-readable reason. */
export async function deactivatePlayerWithReason(playerId: string, reason: string): Promise<void> {
  const sql = 'UPDATE players SET is_active = 0, deactivation_reason = ? WHERE player_id = ?';
  await timedQueryAsync(sql, () => getDriver().run(sql, [reason, playerId]));
}

export async function reactivatePlayer(playerId: string): Promise<void> {
  const sql = 'UPDATE players SET is_active = 1 WHERE player_id = ?';
  await timedQueryAsync(sql, () => getDriver().run(sql, [playerId]));
}

/** Clear deactivation state and reason on reactivation. */
export async function reactivatePlayerWithReason(playerId: string): Promise<void> {
  const sql = "UPDATE players SET is_active = 1, deactivation_reason = NULL WHERE player_id = ?";
  await timedQueryAsync(sql, () => getDriver().run(sql, [playerId]));
}

function buildPlayerWhereClause(opts: QueryPlayersOptions): { where: string; params: (string | number)[] } {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts.region) {
    conditions.push("region = ?");
    params.push(opts.region);
  }
  if (opts.position) {
    conditions.push("position = ?");
    params.push(opts.position);
  }
  if (opts.minTier !== undefined) {
    conditions.push("progress_level >= ?");
    params.push(opts.minTier);
  }
  if (!opts.includeDeactivated) {
    conditions.push("is_active = 1");
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  return { where, params };
}

export async function queryPlayers(opts: QueryPlayersOptions): Promise<PlayerRow[]> {
  const { where, params } = buildPlayerWhereClause(opts);
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  // sql-injection-check-ignore: `where` is built from hardcoded `col = ?` conditions; values are bound via params.
  const sql = `SELECT * FROM players ${where} ORDER BY created_at ASC LIMIT ? OFFSET ?`;
  return timedQueryAsync(sql, () =>
    getDriver().all<PlayerRow>(sql, [...params, limit, offset])
  );
}

export async function countPlayers(opts: Omit<QueryPlayersOptions, 'limit' | 'offset'>): Promise<number> {
  const { where, params } = buildPlayerWhereClause(opts);
  // sql-injection-check-ignore: `where` is built from hardcoded `col = ?` conditions; values are bound via params.
  const sql = `SELECT COUNT(*) as count FROM players ${where}`;
  return timedQueryAsync(sql, async () => {
    const row = await getDriver().get<{ count: number | string }>(sql, params);
    return Number(row?.count ?? 0);
  });
}

// ─── Player search ranking & cursor pagination (#577) ─────────────────────────

export interface SearchPlayersOptions {
  region?: string;
  position?: string;
  minTier?: number;
  limit?: number;
  offset?: number;
  sortBy?: 'relevance' | 'tier' | 'region' | 'created_at';
  sortOrder?: 'asc' | 'desc';
  cursor?: string | null;
  includeDeactivated?: boolean;
}

export interface SearchPlayersResult {
  data: PlayerRow[];
  nextCursor: string | null;
}

function encodeCursor(values: (string | number)[]): string {
  return Buffer.from(JSON.stringify(values)).toString('base64');
}

function decodeCursor(cursor: string): (string | number)[] | null {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export async function searchPlayers(opts: SearchPlayersOptions): Promise<SearchPlayersResult> {
  const driver = getDriver();
  const sortBy = opts.sortBy ?? 'relevance';
  const sortOrder = opts.sortOrder ?? 'desc';
  const direction = sortOrder === 'asc' ? 'ASC' : 'DESC';
  const limit = opts.limit ?? 20;

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts.region) {
    conditions.push('region = ?');
    params.push(opts.region);
  }
  if (opts.position) {
    conditions.push('position = ?');
    params.push(opts.position);
  }
  if (opts.minTier !== undefined) {
    conditions.push('progress_level >= ?');
    params.push(opts.minTier);
  }
  if (!opts.includeDeactivated) {
    conditions.push('is_active = 1');
  }

  const baseWhere = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const useCursor = !!opts.cursor;

  if (sortBy === 'relevance') {
    let cursorWhere = '';
    const cursorParams: (string | number)[] = [];
    const offsetClause = (!useCursor && opts.offset) ? `OFFSET ${opts.offset}` : '';

    if (useCursor) {
      const decoded = decodeCursor(opts.cursor as string);
      if (decoded && decoded.length >= 2) {
        cursorWhere = 'AND (search_score, player_id) < (?, ?)';
        cursorParams.push(decoded[0] as number, decoded[1] as string);
      }
    }

    const fetchLimit = useCursor ? limit + 1 : limit;
    // sql-injection-check-ignore: baseWhere/cursorWhere use `?` placeholders for values; offsetClause embeds a validated number.
    const sql = `WITH scored AS (
      SELECT *,
        (CAST(progress_level AS REAL) * 10.0) +
        (CASE WHEN registered_at > 0 THEN 5.0 ELSE 0.0 END) AS search_score
      FROM players
      ${baseWhere}
    )
    SELECT * FROM scored
    ${cursorWhere}
    ORDER BY search_score DESC, player_id ASC
    LIMIT ? ${offsetClause}`;

    const allParams = [...params, ...cursorParams, fetchLimit];
    const rows = await timedQueryAsync(sql, () =>
      driver.all<ScoredPlayerRow>(sql, allParams)
    );

    if (useCursor) {
      return processCursorResults(rows, limit, sortBy, sortOrder);
    }
    return { data: rows as PlayerRow[], nextCursor: null };
  }

  let orderColumn: string;
  switch (sortBy) {
    case 'tier':
      orderColumn = 'progress_level';
      break;
    case 'region':
      orderColumn = 'region';
      break;
    case 'created_at':
      orderColumn = 'registered_at';
      break;
    default:
      orderColumn = 'registered_at';
  }

  let cursorWhere = '';
  const cursorParams: (string | number)[] = [];
  const offsetClause = (!useCursor && opts.offset) ? `OFFSET ${opts.offset}` : '';

  if (useCursor) {
    const decoded = decodeCursor(opts.cursor as string);
    if (decoded && decoded.length >= 2) {
      const lastVal = decoded[0] as string | number;
      const lastPlayerId = decoded[1] as string;
      const op = direction === 'ASC' ? '>' : '<';
      cursorWhere = `AND (${orderColumn}, player_id) ${op} (?, ?)`;
      cursorParams.push(lastVal, lastPlayerId);
    }
  }

  const fetchLimit = useCursor ? limit + 1 : limit;
  // sql-injection-check-ignore: baseWhere/cursorWhere use `?` placeholders for values; orderColumn/direction are drawn from fixed enums; offsetClause embeds a validated number.
  const sql = `SELECT * FROM players ${baseWhere} ${cursorWhere} ORDER BY ${orderColumn} ${direction}, player_id ASC LIMIT ? ${offsetClause}`;
  const allParams = [...params, ...cursorParams, fetchLimit];
  const rows = await timedQueryAsync(sql, () =>
    driver.all<PlayerRow>(sql, allParams)
  );

  if (useCursor) {
    return processCursorResults(rows, limit, sortBy, sortOrder);
  }
  return { data: rows as PlayerRow[], nextCursor: null };
}

function processCursorResults(
  rows: (PlayerRow | ScoredPlayerRow)[],
  limit: number,
  sortBy: string,
  sortOrder: string,
): SearchPlayersResult {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor: string | null = null;
  if (hasMore && data.length > 0) {
    const last = data[data.length - 1];
    if (sortBy === 'relevance') {
      const scored = last as ScoredPlayerRow;
      nextCursor = encodeCursor([scored.search_score, scored.player_id]);
    } else {
      let lastVal: string | number;
      switch (sortBy) {
        case 'tier':
          lastVal = last.progress_level;
          break;
        case 'region':
          lastVal = last.region ?? '';
          break;
        case 'created_at':
          lastVal = last.registered_at;
          break;
        default:
          lastVal = last.registered_at;
      }
      nextCursor = encodeCursor([lastVal, last.player_id]);
    }
  }

  return { data, nextCursor };
}

// ─── Idempotency key helpers ──────────────────────────────────────────────────

export interface IdempotencyRecord {
  key: string;
  status_code: number;
  response: string; // raw JSON string
  created_at: number;
  expires_at: number;
  /** 'pending' while the originating request is in-flight; 'complete' once saved. */
  status: 'pending' | 'complete';
  /**
   * Fingerprint of the originating request (e.g. wallet + playerId). NULL for
   * endpoints that don't opt into fingerprint conflict detection.
   */
  request_fingerprint: string | null;
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Look up a non-expired idempotency key regardless of its status.
 * Returns the stored record, or null when the key is absent or expired.
 */
export async function getIdempotencyRecord(key: string): Promise<IdempotencyRecord | null> {
  const sql = 'SELECT * FROM idempotency_keys WHERE key = ? AND expires_at > ?';
  const now = Date.now();
  return timedQueryAsync(sql, async () =>
    (await getDriver().get<IdempotencyRecord>(sql, [key, now])) ?? null
  );
}

/**
 * Attempt to claim an idempotency key by inserting a 'pending' marker.
 *
 * Uses INSERT OR IGNORE so that the insert is a single atomic operation:
 * exactly one concurrent request will succeed and receive `true`; every
 * other request for the same key receives `false` and must not run the
 * downstream handler.
 *
 * Returns true  — this caller owns the key; proceed with the handler.
 * Returns false — another request already claimed the key; caller must wait.
 */
export async function claimIdempotencyKey(
  key: string,
  requestFingerprint?: string | null,
): Promise<boolean> {
  const now = Date.now();
  const sql = `
    INSERT INTO idempotency_keys (key, status_code, response, created_at, expires_at, status, request_fingerprint)
    VALUES (?, 0, '', ?, ?, 'pending', ?)
    ON CONFLICT (key) DO NOTHING
  `;
  const result = await timedQueryAsync(sql, () =>
    getDriver().run(sql, [key, now, now + IDEMPOTENCY_TTL_MS, requestFingerprint ?? null])
  );
  // changes === 1 means a new row was inserted (this caller won the race).
  return result.changes === 1;
}

/**
 * Transition a 'pending' idempotency key to 'complete', recording the final
 * response.  Called by the middleware after the handler has written its response.
 */
export async function updateIdempotencyRecord(
  key: string,
  statusCode: number,
  body: unknown,
): Promise<void> {
  const sql = `
    UPDATE idempotency_keys
    SET status_code = ?, response = ?, status = 'complete'
    WHERE key = ?
  `;
  await timedQueryAsync(sql, () =>
    getDriver().run(sql, [statusCode, JSON.stringify(body), key])
  );
}

/**
 * Persist a new idempotency key with its response payload.
 * Silently ignores conflicts — two concurrent requests with the same key
 * will both compute a response but only the first one to commit wins; the
 * second one will then be served the stored value by getIdempotencyRecord.
 *
 * @deprecated Prefer claimIdempotencyKey + updateIdempotencyRecord for proper
 * race-condition protection.  This function is retained for backwards
 * compatibility with tests and external callers.
 */
export async function saveIdempotencyRecord(
  key: string,
  statusCode: number,
  body: unknown,
): Promise<void> {
  const now = Date.now();
  const sql = `
    INSERT INTO idempotency_keys (key, status_code, response, created_at, expires_at, status)
    VALUES (?, ?, ?, ?, ?, 'complete')
    ON CONFLICT(key) DO NOTHING
  `;
  await timedQueryAsync(sql, () =>
    getDriver().run(sql, [key, statusCode, JSON.stringify(body), now, now + IDEMPOTENCY_TTL_MS])
  );
}

/**
 * Delete all idempotency records whose TTL has passed.
 * Call this periodically (e.g., from the indexer poll loop) to keep the table small.
 */
export async function purgeExpiredIdempotencyKeys(): Promise<number> {
  const sql = 'DELETE FROM idempotency_keys WHERE expires_at <= ?';
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [Date.now()]);
    return info.changes;
  });
}

// ─── Subscription helpers ─────────────────────────────────────────────────────

export interface SubscriptionRow {
  id: number;
  scout_wallet: string;
  tier: string;
  expires_at: number;
  cancelled_at: number | null;
  created_at: number;
}

export async function getLatestSubscription(scoutWallet: string): Promise<SubscriptionRow | null> {
  const sql = `SELECT * FROM subscriptions WHERE scout_wallet = ? AND cancelled_at IS NULL ORDER BY expires_at DESC LIMIT 1`;
  return timedQueryAsync(sql, async () =>
    (await getDriver().get<SubscriptionRow>(sql, [scoutWallet])) ?? null
  );
}

/**
 * Return all subscription rows for a scout (including cancelled), ordered newest-first.
 * Used by the payment history endpoint.
 */
export async function getSubscriptionsByScout(scoutWallet: string): Promise<SubscriptionRow[]> {
  const sql = `SELECT * FROM subscriptions WHERE scout_wallet = ? ORDER BY created_at DESC`;
  return timedQueryAsync(sql, () => getDriver().all<SubscriptionRow>(sql, [scoutWallet]));
}

export async function insertSubscription(p: {
  scout_wallet: string;
  tier: string;
  expires_at: number;
  created_at: number;
}): Promise<number> {
  const sql = `INSERT INTO subscriptions (scout_wallet, tier, expires_at, created_at) VALUES (?, ?, ?, ?) RETURNING id`;
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [p.scout_wallet, p.tier, p.expires_at, p.created_at]);
    return info.lastId;
  });
}

export async function dbRenewSubscription(p: { id: number; tier: string; expires_at: number }): Promise<void> {
  const sql = `UPDATE subscriptions SET tier = ?, expires_at = ? WHERE id = ?`;
  await timedQueryAsync(sql, () => getDriver().run(sql, [p.tier, p.expires_at, p.id]));
}

export async function dbCancelSubscription(p: { id: number; cancelled_at: number }): Promise<void> {
  const sql = `UPDATE subscriptions SET cancelled_at = ? WHERE id = ?`;
  await timedQueryAsync(sql, () => getDriver().run(sql, [p.cancelled_at, p.id]));
}

// ─── Contact unlock helpers ───────────────────────────────────────────────────

export interface ContactUnlockRow {
  scout_wallet: string;
  player_id: string;
  tx_hash: string;
  unlocked_at: number;
}

export async function insertContactUnlock(p: {
  scout_wallet: string;
  player_id: string;
  tx_hash: string;
  unlocked_at: number;
}): Promise<void> {
  const sql = `INSERT INTO contact_unlocks (scout_wallet, player_id, tx_hash, unlocked_at) VALUES (?, ?, ?, ?) ON CONFLICT(scout_wallet, player_id) DO NOTHING`;
  await timedQueryAsync(sql, () => getDriver().run(sql, [p.scout_wallet, p.player_id, p.tx_hash, p.unlocked_at]));
}

export async function getContactUnlocksByScout(scoutWallet: string): Promise<ContactUnlockRow[]> {
  const sql = `SELECT * FROM contact_unlocks WHERE scout_wallet = ? ORDER BY unlocked_at DESC`;
  return timedQueryAsync(sql, () => getDriver().all<ContactUnlockRow>(sql, [scoutWallet]));
}

/**
 * Return all contact-unlock rows for a given player (i.e. every scout who has
 * unlocked that player's contact details). Used to fan out SSE notifications
 * when a player is deactivated.
 */
export async function getContactUnlocksByPlayer(playerId: string): Promise<ContactUnlockRow[]> {
  const sql = `SELECT * FROM contact_unlocks WHERE player_id = ? ORDER BY unlocked_at DESC`;
  return timedQueryAsync(sql, () => getDriver().all<ContactUnlockRow>(sql, [playerId]));
}

export async function hasContactUnlock(scoutWallet: string, playerId: string): Promise<boolean> {
  const sql = `SELECT 1 FROM contact_unlocks WHERE scout_wallet = ? AND player_id = ? LIMIT 1`;
  return timedQueryAsync(sql, async () => (await getDriver().get(sql, [scoutWallet, playerId])) !== undefined);
}

// ─── Time-series stats helpers ───────────────────────────────────────────────────

export interface TimeSeriesPoint {
  date: string;
  count: number;
}

export interface RegionBreakdownPoint {
  date: string;
  region: string;
  count: number;
}

/**
 * SQL expression that buckets an epoch-milliseconds column into a
 * 'YYYY-MM-DD' date string, for GROUP BY date. SQLite's strftime() and
 * Postgres's to_char(to_timestamp(...)) are both dialect-specific — neither
 * expression works on the other driver — so this branches on config.dbDriver
 * rather than trying to find one expression that works everywhere.
 */
function dateBucketExpr(column: string): string {
  return config.dbDriver === 'postgres'
    ? `to_char(to_timestamp(${column} / 1000.0), 'YYYY-MM-DD')`
    : `strftime('%Y-%m-%d', ${column} / 1000, 'unixepoch')`;
}

/**
 * Get daily counts of new players registered within a time window.
 */
export async function getNewPlayersTimeSeries(startDateMs: number, endDateMs: number): Promise<TimeSeriesPoint[]> {
  // sql-injection-check-ignore: dateBucketExpr takes a hardcoded column literal, not user input; the SQL it returns is driver-specific date formatting.
  const sql = `
    SELECT ${dateBucketExpr('created_at')} as date, COUNT(*) as count
    FROM players
    WHERE created_at >= ? AND created_at <= ?
    GROUP BY date
    ORDER BY date ASC
  `;
  const rows = await timedQueryAsync(sql, () =>
    getDriver().all<{ date: string; count: number | string }>(sql, [startDateMs, endDateMs])
  );
  return rows.map((r) => ({ date: r.date, count: Number(r.count) }));
}

/**
 * Get daily counts of milestones approved within a time window.
 */
export function getMilestonesApprovedTimeSeries(startDateMs: number, endDateMs: number): TimeSeriesPoint[] {
  const sql = `
    SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') as date, COUNT(*) as count
    FROM events
    WHERE type = 'milestone_approved' AND created_at >= ? AND created_at <= ?
    GROUP BY date
    ORDER BY date ASC
  `;
  const rows = timedQuery(sql, () =>
    getDb().prepare(sql).all(startDateMs, endDateMs) as Array<{ date: string; count: number }>
  );
  return rows.map((r) => ({ date: r.date, count: r.count }));
}

/**
 * Get daily counts of contact unlocks within a time window.
 */
export async function getContactUnlocksTimeSeries(startDateMs: number, endDateMs: number): Promise<TimeSeriesPoint[]> {
  // sql-injection-check-ignore: dateBucketExpr takes a hardcoded column literal, not user input; the SQL it returns is driver-specific date formatting.
  const sql = `
    SELECT ${dateBucketExpr('unlocked_at')} as date, COUNT(*) as count
    FROM contact_unlocks
    WHERE unlocked_at >= ? AND unlocked_at <= ?
    GROUP BY date
    ORDER BY date ASC
  `;
  const rows = await timedQueryAsync(sql, () =>
    getDriver().all<{ date: string; count: number | string }>(sql, [startDateMs, endDateMs])
  );
  return rows.map((r) => ({ date: r.date, count: Number(r.count) }));
}

/**
 * Get daily counts of subscriptions started within a time window.
 */
export async function getSubscriptionsStartedTimeSeries(startDateMs: number, endDateMs: number): Promise<TimeSeriesPoint[]> {
  // sql-injection-check-ignore: dateBucketExpr takes a hardcoded column literal, not user input; the SQL it returns is driver-specific date formatting.
  const sql = `
    SELECT ${dateBucketExpr('created_at')} as date, COUNT(*) as count
    FROM subscriptions
    WHERE created_at >= ? AND created_at <= ?
    GROUP BY date
    ORDER BY date ASC
  `;
  const rows = await timedQueryAsync(sql, () =>
    getDriver().all<{ date: string; count: number | string }>(sql, [startDateMs, endDateMs])
  );
  return rows.map((r) => ({ date: r.date, count: Number(r.count) }));
}

/**
 * Get daily counts of new players grouped by region within a time window.
 */
export async function getNewPlayersByRegionTimeSeries(startDateMs: number, endDateMs: number): Promise<RegionBreakdownPoint[]> {
  // sql-injection-check-ignore: dateBucketExpr takes a hardcoded column literal, not user input; the SQL it returns is driver-specific date formatting.
  const sql = `
    SELECT ${dateBucketExpr('created_at')} as date, region, COUNT(*) as count
    FROM players
    WHERE created_at >= ? AND created_at <= ?
    GROUP BY date, region
    ORDER BY date ASC, region ASC
  `;
  const rows = await timedQueryAsync(sql, () =>
    getDriver().all<{ date: string; region: string | null; count: number | string }>(sql, [startDateMs, endDateMs])
  );
  return rows.map((r) => ({ date: r.date, region: r.region ?? 'unknown', count: Number(r.count) }));
}

// ─── Audit log helpers ────────────────────────────────────────────────────────
//
// audit_log is a single, tamper-evident hash chain (see db/012_audit_log_hash_chain.sql
// and src/utils/hashChain.ts) shared by two callers: src/services/audit.ts's
// logAuditEvent (admin actions; event_source='admin_action') and
// src/utils/audit.ts's recordAudit/queryAudit (validator/player app events;
// event_source='app_event', formerly an in-memory array — see #464). Every
// insert reads the previous row's hash and chains onto it, so the two event
// sources interleave into one continuous, verifiable timeline.

export interface AuditLogRow {
  id: number;
  action: string;
  admin_wallet: string;
  query_params: string;
  created_at: string;
  prev_hash: string | null;
  hash: string;
  event_source: string;
}

/**
 * Inserts a row into audit_log and chains it onto the current end of the
 * hash chain. The "read the last hash, then insert" sequence below runs
 * inside driver.transaction() and takes tx.lockForWrite('audit_log') before
 * reading, which on both drivers guarantees no concurrent insertAuditLog
 * call can interleave between the read and the write: SqliteDriver
 * serializes all transactions on its single connection regardless (the lock
 * is a no-op there), while PostgresDriver's transactions run on genuinely
 * concurrent pooled connections — a plain BEGIN/COMMIT alone does NOT
 * prevent two of them from both reading the same "last row" under READ
 * COMMITTED, so the advisory lock is load-bearing there. A write that fails
 * (e.g. a dropped connection) throws here rather than silently vanishing —
 * callers must not swallow it.
 */
export async function insertAuditLog(p: {
  action: string;
  adminWallet?: string;
  queryParams?: Record<string, unknown>;
  createdAt: string;
  /** Defaults to 'admin_action' (the pre-existing caller, logAuditEvent). */
  eventSource?: string;
}): Promise<AuditLogRow> {
  const sql = 'INSERT INTO audit_log (hash-chained)';
  return timedQueryAsync(sql, () =>
    getDriver().transaction(async (tx) => {
      const adminWallet = p.adminWallet ?? '';
      const queryParams = JSON.stringify(p.queryParams ?? {});
      const eventSource = p.eventSource ?? 'admin_action';

      // See DbTxHandle.lockForWrite: without this, two concurrent
      // transactions on PostgresDriver's pooled connections can both read
      // the same "last row" below and both insert, producing two rows that
      // both chain onto the same prev_hash instead of a linear chain.
      await tx.lockForWrite('audit_log');

      const prevRow = await tx.get<{ hash: string }>(
        'SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1'
      );
      const prevHash = prevRow?.hash ?? GENESIS_HASH;

      const hash = computeChainHash(
        auditChainContent({ action: p.action, adminWallet, queryParams, createdAt: p.createdAt, eventSource }),
        prevHash
      );

      const info = await tx.run(
        `INSERT INTO audit_log (action, admin_wallet, query_params, created_at, prev_hash, hash, event_source)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [p.action, adminWallet, queryParams, p.createdAt, prevHash, hash, eventSource]
      );

      return {
        id: info.lastId,
        action: p.action,
        admin_wallet: adminWallet,
        query_params: queryParams,
        created_at: p.createdAt,
        prev_hash: prevHash,
        hash,
        event_source: eventSource,
      };
    })
  );
}

export async function getAuditLogs(filters: {
  action?: string;
  startDate?: string;
  endDate?: string;
  eventSource?: string;
  actorWallet?: string;
  limit?: number;
  offset?: number;
}): Promise<AuditLogRow[]> {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (filters.action) { conditions.push('action = ?'); params.push(filters.action); }
  if (filters.startDate) { conditions.push('created_at >= ?'); params.push(filters.startDate); }
  if (filters.endDate) { conditions.push('created_at <= ?'); params.push(filters.endDate); }
  if (filters.eventSource) { conditions.push('event_source = ?'); params.push(filters.eventSource); }
  if (filters.actorWallet) { conditions.push('admin_wallet = ?'); params.push(filters.actorWallet); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;
// sql-injection-check-ignore: `where` is built from hardcoded `col = ?` conditions; values are bound via params.
const sql = `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  return timedQueryAsync(sql, () => getDriver().all<AuditLogRow>(sql, [...params, limit, offset]));
}

export async function getAuditLogsCount(filters: {
  action?: string;
  startDate?: string;
  endDate?: string;
  eventSource?: string;
  actorWallet?: string;
}): Promise<number> {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (filters.action) { conditions.push('action = ?'); params.push(filters.action); }
  if (filters.startDate) { conditions.push('created_at >= ?'); params.push(filters.startDate); }
  if (filters.endDate) { conditions.push('created_at <= ?'); params.push(filters.endDate); }
  if (filters.eventSource) { conditions.push('event_source = ?'); params.push(filters.eventSource); }
  if (filters.actorWallet) { conditions.push('admin_wallet = ?'); params.push(filters.actorWallet); }
const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  // sql-injection-check-ignore: `where` is built from hardcoded `col = ?` conditions; values are bound via params.
  const sql = `SELECT COUNT(*) AS count FROM audit_log ${where}`;
  return timedQueryAsync(sql, async () => {
    const row = await getDriver().get<{ count: number | string }>(sql, params);
    return Number(row?.count ?? 0);
  });
}

/**
 * Returns ALL audit_log rows matching the given filters, unpaginated and
 * ordered by id ascending (i.e. insertion / hash-chain order). Used by
 * verifyAuditChain() (needs every row, in chain order, to walk the whole
 * chain) and queryAudit() (the old in-memory auditStore had no pagination,
 * so this preserves that "just give me everything" contract).
 */
export async function getAllAuditLogRows(filters: {
  eventSource?: string;
  actorWallet?: string;
  action?: string;
} = {}): Promise<AuditLogRow[]> {
  const conditions: string[] = [];
  const params: string[] = [];
  if (filters.action) { conditions.push('action = ?'); params.push(filters.action); }
  if (filters.eventSource) { conditions.push('event_source = ?'); params.push(filters.eventSource); }
  if (filters.actorWallet) { conditions.push('admin_wallet = ?'); params.push(filters.actorWallet); }
const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  // sql-injection-check-ignore: `where` is built from hardcoded `col = ?` conditions; values are bound via params.
  const sql = `SELECT * FROM audit_log ${where} ORDER BY id ASC`;
  return timedQueryAsync(sql, () => getDriver().all<AuditLogRow>(sql, params));
}

// ─── Trial offer helpers ──────────────────────────────────────────────────────

export interface TrialOfferRow {
  id: number;
  offer_id: string;
  scout_wallet: string;
  player_id: string;
  details_uri: string;
  status: string;
  reject_reason: string | null;
  responded_at: number | null;
  created_at: number;
  /** Unix epoch seconds after which accept/reject is rejected. NULL = no expiry (pre-migration rows). */
  expires_at: number | null;
  /** Unix epoch seconds when the originating scout withdrew the offer. NULL = not cancelled. */
  cancelled_at: number | null;
}

export async function getTrialOfferById(offerId: string): Promise<TrialOfferRow | null> {
  const sql = 'SELECT * FROM trial_offers WHERE offer_id = ?';
  return timedQueryAsync(sql, async () =>
    (await getDriver().get<TrialOfferRow>(sql, [offerId])) ?? null
  );
}

export async function insertTrialOffer(p: {
  offer_id: string;
  scout_wallet: string;
  player_id: string;
  details_uri: string;
  created_at: number;
  expires_at?: number | null;
}): Promise<void> {
  const sql = `INSERT INTO trial_offers (offer_id, scout_wallet, player_id, details_uri, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (offer_id) DO NOTHING`;
  await timedQueryAsync(sql, () =>
    getDriver().run(sql, [p.offer_id, p.scout_wallet, p.player_id, p.details_uri, p.created_at, p.expires_at ?? null])
  );
}

export async function respondToTrialOffer(p: {
  offer_id: string;
  status: string;
  reject_reason?: string;
  responded_at: number;
}): Promise<void> {
  const sql = `UPDATE trial_offers SET status = ?, reject_reason = ?, responded_at = ? WHERE offer_id = ?`;
  await timedQueryAsync(sql, () =>
    getDriver().run(sql, [p.status, p.reject_reason ?? null, p.responded_at, p.offer_id])
  );
}

/**
 * Cancel (withdraw) a still-pending trial offer.
 * Only succeeds when the offer exists, belongs to the given scout, and is
 * still in 'pending' status. Returns true when the cancellation was applied,
 * false when no matching pending offer was found.
 */
export async function cancelTrialOffer(offerId: string, scoutWallet: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const sql = `
    UPDATE trial_offers
    SET status = 'cancelled', cancelled_at = ?
    WHERE offer_id = ? AND scout_wallet = ? AND status = 'pending'
  `;
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [now, offerId, scoutWallet]);
    return info.changes > 0;
  });
}

/**
 * Count the number of trial offers submitted for a given player.
 * Returns 0 when the trial_offers table does not exist yet (pre-migration).
 */
export async function countTrialOffersByPlayer(playerId: string): Promise<number> {
  try {
    const sql = 'SELECT COUNT(*) AS cnt FROM trial_offers WHERE player_id = ?';
    const row = await timedQueryAsync(sql, () =>
      getDriver().get<{ cnt: number | string }>(sql, [playerId]),
    );
    return Number(row?.cnt ?? 0);
  } catch {
    // Table may not exist in very early migration states
    return 0;
  }
}

// ─── Pending pin helpers ──────────────────────────────────────────────────────

export interface PendingPinRow {
  id: number;
  payload: string;
  attempts: number;
  created_at: string;
  last_tried: string | null;
  hash?: string | null;
  /** CID written by the winning upload instance once the pin succeeds. */
  resolved_cid?: string | null;
  status?: string;
  expired_reason?: string | null;
  last_reconciled_at?: string | null;
}

export async function insertPendingPin(p: {
  payload: string;
  created_at: string;
  last_tried: string;
  hash?: string | null;
}): Promise<boolean> {
  if (p.hash) {
    const sql = `INSERT INTO pending_pins (payload, hash, created_at, last_tried) VALUES (?, ?, ?, ?) ON CONFLICT (hash) DO NOTHING`;
    return timedQueryAsync(sql, async () => {
      const info = await getDriver().run(sql, [p.payload, p.hash, p.created_at, p.last_tried]);
      return info.changes > 0;
    });
  } else {
    const sql = `INSERT INTO pending_pins (payload, created_at, last_tried) VALUES (?, ?, ?)`;
    await timedQueryAsync(sql, () => getDriver().run(sql, [p.payload, p.created_at, p.last_tried]));
    return true;
  }
}

export async function getPendingPins(): Promise<PendingPinRow[]> {
  const sql = "SELECT * FROM pending_pins WHERE status IS NULL OR status = 'pending' ORDER BY created_at ASC";
  return timedQueryAsync(sql, () => getDriver().all<PendingPinRow>(sql));
}

export async function deletePendingPin(id: number): Promise<void> {
  const sql = 'DELETE FROM pending_pins WHERE id = ?';
  await timedQueryAsync(sql, () => getDriver().run(sql, [id]));
}

export async function deletePendingPinByHash(hash: string): Promise<void> {
  const sql = 'DELETE FROM pending_pins WHERE hash = ?';
  await timedQueryAsync(sql, () => getDriver().run(sql, [hash]));
}

export async function isPendingPinByHash(hash: string): Promise<boolean> {
  const sql = "SELECT 1 FROM pending_pins WHERE hash = ? AND (status IS NULL OR status = 'pending') LIMIT 1";
  return timedQueryAsync(sql, async () => (await getDriver().get(sql, [hash])) !== undefined);
}

export async function incrementPendingPinAttempts(id: number): Promise<void> {
  const sql = 'UPDATE pending_pins SET attempts = attempts + 1, last_tried = ? WHERE id = ?';
  await timedQueryAsync(sql, () => getDriver().run(sql, [new Date().toISOString(), id]));
}

/**
 * Persist the resolved CID on a pending_pins row identified by content hash.
 *
 * Called by the winning upload instance immediately after a successful Pinata
 * upload so that any other instance waiting on the same lock can retrieve the
 * CID from the DB instead of issuing a duplicate upload.
 */
export async function setPendingPinResolvedCid(hash: string, cid: string): Promise<void> {
  const sql = "UPDATE pending_pins SET resolved_cid = ?, status = 'resolved' WHERE hash = ?";
  await timedQueryAsync(sql, () => getDriver().run(sql, [cid, hash]));
}

/**
 * Return the resolved CID for a previously completed pin identified by content
 * hash, or null if none has been recorded yet (i.e. the winning instance is
 * still uploading or the row no longer exists).
 */
export async function getResolvedCidByHash(hash: string): Promise<string | null> {
  const sql = 'SELECT resolved_cid FROM pending_pins WHERE hash = ? LIMIT 1';
  const row = await timedQueryAsync(sql, () => getDriver().get<{ resolved_cid: string | null }>(sql, [hash]));
  return row?.resolved_cid ?? null;
}

/**
 * Return pending pins created on or before olderThanIso that are pending/unresolved.
 */
export async function getStalePendingPins(olderThanIso: string, limit = 50): Promise<PendingPinRow[]> {
  const sql = `SELECT * FROM pending_pins WHERE (status IS NULL OR status = 'pending') AND created_at <= ? ORDER BY created_at ASC LIMIT ?`;
  return timedQueryAsync(sql, () => getDriver().all<PendingPinRow>(sql, [olderThanIso, limit]));
}

/**
 * Update reconciliation outcome for a pending pin.
 * Can mark status='resolved', status='expired' with an expired_reason, or update retry metadata.
 */
export async function updatePendingPinReconciliation(p: {
  id: number;
  status: string;
  expiredReason?: string | null;
  resolvedCid?: string | null;
  lastReconciledAt?: string;
}): Promise<boolean> {
  const lastReconciled = p.lastReconciledAt ?? new Date().toISOString();
  const sql = `UPDATE pending_pins SET status = ?, expired_reason = ?, resolved_cid = COALESCE(?, resolved_cid), last_reconciled_at = ? WHERE id = ?`;
  const res = await timedQueryAsync(sql, () => getDriver().run(sql, [p.status, p.expiredReason ?? null, p.resolvedCid ?? null, lastReconciled, p.id]));
  return res.changes > 0;
}

/**
 * Count the number of stuck pending pins (status is pending and created_at <= olderThanIso).
 */
export async function countStuckPendingPins(olderThanIso: string): Promise<number> {
  const sql = `SELECT COUNT(*) as count FROM pending_pins WHERE (status IS NULL OR status = 'pending') AND created_at <= ?`;
  const row = await timedQueryAsync(sql, () => getDriver().get<{ count: number | string }>(sql, [olderThanIso]));
  return Number(row?.count ?? 0);
}

// ─── Scout player notes helpers (#488) ───────────────────────────────────────

export interface ScoutPlayerNoteRow {
  id: number;
  scout_wallet: string;
  player_id: string;
  note_text: string;
  updated_at: number;
}

/**
 * Create or update a private note for a scout on a specific player.
 * Uses upsert semantics: calling twice for the same (scout_wallet, player_id)
 * pair overwrites the note rather than creating a duplicate row.
 */
export async function upsertScoutNote(p: {
  scout_wallet: string;
  player_id: string;
  note_text: string;
  updated_at: number;
}): Promise<void> {
  const sql = `
    INSERT INTO scout_player_notes (scout_wallet, player_id, note_text, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(scout_wallet, player_id) DO UPDATE SET
      note_text  = excluded.note_text,
      updated_at = excluded.updated_at
  `;
  await timedQueryAsync(sql, () =>
    getDriver().run(sql, [p.scout_wallet, p.player_id, p.note_text, p.updated_at]),
  );
}

/**
 * Retrieve a single private note by scout wallet + player id.
 * Returns null when no note exists.
 */
export async function getScoutNote(
  scoutWallet: string,
  playerId: string,
): Promise<ScoutPlayerNoteRow | null> {
  const sql =
    'SELECT * FROM scout_player_notes WHERE scout_wallet = ? AND player_id = ? LIMIT 1';
  return timedQueryAsync(sql, async () =>
    (await getDriver().get<ScoutPlayerNoteRow>(sql, [scoutWallet, playerId])) ?? null,
  );
}

/**
 * List all private notes authored by a scout, ordered newest-first.
 */
export async function getScoutNotes(scoutWallet: string): Promise<ScoutPlayerNoteRow[]> {
  const sql =
    'SELECT * FROM scout_player_notes WHERE scout_wallet = ? ORDER BY updated_at DESC';
  return timedQueryAsync(sql, () =>
    getDriver().all<ScoutPlayerNoteRow>(sql, [scoutWallet]),
  );
}

// ─── Scout player notes v2 helpers (multi-note CRUD) ─────────────────────────

export interface ScoutPlayerNoteV2Row {
  id: number;
  scout_wallet: string;
  player_id: string;
  content: string;
  created_at: number;
  updated_at: number;
}

/**
 * Insert a new private note for a scout on a specific player.
 * Returns the new row id.
 */
export async function insertScoutPlayerNote(p: {
  scout_wallet: string;
  player_id: string;
  content: string;
  created_at: number;
  updated_at: number;
}): Promise<number> {
  const sql = `
    INSERT INTO scout_player_notes_v2 (scout_wallet, player_id, content, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    RETURNING id
  `;
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [p.scout_wallet, p.player_id, p.content, p.created_at, p.updated_at]);
    return info.lastId;
  });
}

/**
 * List all notes for a scout-player pair, ordered newest-first.
 */
export async function getScoutPlayerNotes(
  scoutWallet: string,
  playerId: string,
): Promise<ScoutPlayerNoteV2Row[]> {
  const sql = `
    SELECT * FROM scout_player_notes_v2
    WHERE scout_wallet = ? AND player_id = ?
    ORDER BY created_at DESC
  `;
  return timedQueryAsync(sql, () =>
    getDriver().all<ScoutPlayerNoteV2Row>(sql, [scoutWallet, playerId]),
  );
}

/**
 * Update the content of a note identified by id and scout_wallet.
 * Scoping the update to scout_wallet prevents cross-scout tampering.
 * Returns true when a row was updated, false when not found.
 */
export async function updateScoutPlayerNote(p: {
  id: number;
  scout_wallet: string;
  content: string;
  updated_at: number;
}): Promise<boolean> {
  const sql = `
    UPDATE scout_player_notes_v2
    SET content = ?, updated_at = ?
    WHERE id = ? AND scout_wallet = ?
  `;
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [p.content, p.updated_at, p.id, p.scout_wallet]);
    return info.changes > 0;
  });
}

/**
 * Delete a note by id, scoped to the owning scout wallet.
 * Returns true when a row was deleted, false when not found.
 */
export async function deleteScoutPlayerNote(id: number, scoutWallet: string): Promise<boolean> {
  const sql = `
    DELETE FROM scout_player_notes_v2
    WHERE id = ? AND scout_wallet = ?
  `;
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [id, scoutWallet]);
    return info.changes > 0;
  });
}

// ─── API key helpers (#490) ───────────────────────────────────────────────────

export interface ApiKeyRow {
  id: number;
  key_hash: string;
  scout_wallet: string;
  label: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  /** JSON-encoded scope list (db/014_api_key_scopes.sql). NULL/empty = legacy key. */
  scopes: string | null;
  rate_limit_per_minute: number | null;
  /**
   * Indexed deterministic lookup value (db/024_api_key_lookup_hash.sql, #1033).
   * NULL on rows issued before that migration — those are healed lazily on
   * first successful authentication. Never the authentication proof: see
   * src/utils/apiKeyLookup.ts.
   */
  lookup_hash: string | null;
  /**
   * Unix timestamp (seconds) after which this key stops authenticating
   * (db/025_api_key_rotation.sql, #676). Set only by POST .../rotate, which
   * schedules the *old* key for revocation after a grace period rather than
   * revoking it immediately. NULL (the default) means no scheduled
   * revocation. Enforced live by every active-key query — see
   * getActiveApiKeyByLookupHash().
   */
  revoke_after: number | null;
  /**
   * Hard expiry timestamp in Unix seconds (db/026_api_key_expiry.sql, #674).
   * NULL means the key never expires on its own (explicit no-expiry).
   * Keys whose expires_at is in the past are rejected by auth with a
   * distinct "expired" error rather than "invalid key".
   */
  expires_at: number | null;
}

/**
 * Persist a new API key.  Only the salted hash is stored; the caller must
 * have already generated the hash before calling this function.
 * Returns the new row id.
 *
 * `scopes` is optional: when omitted the key is stored with NULL scopes,
 * which the authorization layer treats as a legacy key with unrestricted
 * scout-level access (backward compatible with keys issued before scope
 * enforcement existed).
 *
 * `lookup_hash` is the indexed deterministic lookup value (#1033). It is
 * optional only so that callers predating it still compile; every production
 * issuance path must supply it, otherwise the new key lands on the slow
 * transitional scan path until its first successful authentication.
 */
export async function insertApiKey(p: {
  key_hash: string;
  scout_wallet: string;
  label: string;
  created_at: number;
  scopes?: string[];
  lookup_hash?: string;
  /** Unix timestamp (seconds) when the key expires. NULL = no expiry. */
  expires_at?: number | null;
}): Promise<number> {
  const sql = `
    INSERT INTO api_keys (key_hash, scout_wallet, label, created_at, scopes, lookup_hash, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `;
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [
      p.key_hash,
      p.scout_wallet,
      p.label,
      p.created_at,
      p.scopes ? JSON.stringify(p.scopes) : null,
      p.lookup_hash ?? null,
      p.expires_at ?? null,
    ]);
    return info.lastId;
  });
}

/**
 * List all non-revoked API keys for a scout wallet.
 */
export async function listApiKeysByWallet(scoutWallet: string): Promise<ApiKeyRow[]> {
  const sql = `
    SELECT * FROM api_keys
    WHERE scout_wallet = ?
    ORDER BY created_at DESC
  `;
  return timedQueryAsync(sql, () =>
    getDriver().all<ApiKeyRow>(sql, [scoutWallet]),
  );
}

/**
 * Revoke an API key by its row id.
 * Only revokes keys belonging to the given scout wallet for security.
 * Returns true when a row was updated, false when not found.
 */
export async function revokeApiKeyById(id: number, scoutWallet: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const sql = `
    UPDATE api_keys SET revoked_at = ?
    WHERE id = ? AND scout_wallet = ? AND revoked_at IS NULL
  `;
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [now, id, scoutWallet]);
    return info.changes > 0;
  });
}

/**
 * SQL fragment excluding:
 *  - permanently revoked rows (revoked_at IS NOT NULL)
 *  - rows past their scheduled rotation deadline (#676)
 *  - rows past their hard expiry timestamp (#674)
 *
 * Shared by every "active key" query so enforcement is consistent and
 * requires no background sweep.
 *
 * Callers must bind `now` (unix seconds) twice: once for revoke_after and
 * once for expires_at.
 */
const ACTIVE_KEY_SQL = `revoked_at IS NULL AND (revoke_after IS NULL OR revoke_after > ?) AND (expires_at IS NULL OR expires_at > ?)`;

/**
 * Look up an API key row by its full hash value (including salt prefix).
 * Returns null when not found, already revoked, or past its rotation
 * grace-period deadline.
 */
export async function getApiKeyByHash(keyHash: string): Promise<ApiKeyRow | null> {
  const now = Math.floor(Date.now() / 1000);
  // sql-injection-check-ignore: ACTIVE_KEY_SQL is a hardcoded fragment; values are bound via params.
  const sql = `SELECT * FROM api_keys WHERE key_hash = ? AND ${ACTIVE_KEY_SQL} LIMIT 1`;
  return timedQueryAsync(sql, async () =>
    (await getDriver().get<ApiKeyRow>(sql, [keyHash, now, now])) ?? null,
  );
}

/**
 * Look up an API key row by id, scoped to its owning scout wallet. Returns
 * revoked and grace-period-scheduled rows too (unlike the active-key
 * queries) — callers such as rotateApiKey need to see and validate the
 * row's current state themselves.
 */
export async function getApiKeyById(id: number, scoutWallet: string): Promise<ApiKeyRow | null> {
  const sql = `SELECT * FROM api_keys WHERE id = ? AND scout_wallet = ? LIMIT 1`;
  return timedQueryAsync(sql, async () =>
    (await getDriver().get<ApiKeyRow>(sql, [id, scoutWallet])) ?? null,
  );
}

/**
 * Load every active API key row (not permanently revoked, and not past its
 * rotation grace-period deadline). A full-table read — never used on the
 * X-API-Key authentication hot path, which resolves a candidate with the
 * single indexed lookup in getActiveApiKeyByLookupHash() instead (#1033).
 * Kept for diagnostics/regression coverage only.
 */
export async function getAllActiveApiKeys(): Promise<ApiKeyRow[]> {
  const now = Math.floor(Date.now() / 1000);
  // sql-injection-check-ignore: ACTIVE_KEY_SQL is a hardcoded fragment; values are bound via params.
  const sql = `SELECT * FROM api_keys WHERE ${ACTIVE_KEY_SQL}`;
  return timedQueryAsync(sql, () => getDriver().all<ApiKeyRow>(sql, [now, now]));
}

/**
 * Locate the single active API key row carrying `lookupHash` — excluding
 * both permanently revoked rows and rows past their rotation grace-period
 * deadline (db/025_api_key_rotation.sql, #676).
 *
 * This is the hot path for X-API-Key authentication (#1033): one indexed
 * equality lookup against the UNIQUE idx_api_keys_lookup_hash, replacing the
 * former "load every active key and re-hash each one" scan.
 *
 * Returning a row proves nothing on its own — the caller must still verify the
 * presented raw key against `key_hash`. See src/utils/apiKeyLookup.ts.
 */
export async function getActiveApiKeyByLookupHash(lookupHash: string): Promise<ApiKeyRow | null> {
  const now = Math.floor(Date.now() / 1000);
  // sql-injection-check-ignore: ACTIVE_KEY_SQL is a hardcoded fragment; values are bound via params.
  const sql = `SELECT * FROM api_keys WHERE lookup_hash = ? AND ${ACTIVE_KEY_SQL} LIMIT 1`;
  return timedQueryAsync(sql, async () =>
    (await getDriver().get<ApiKeyRow>(sql, [lookupHash, now, now])) ?? null,
  );
}

/**
 * Load active API key rows that predate db/024_api_key_lookup_hash.sql and
 * have not yet been healed onto the indexed lookup path (#1033). Backed by
 * the partial index idx_api_keys_lookup_pending, so this shrinks to an empty
 * result — and an effectively free indexed probe — as keys are used. Also
 * excludes rows past their rotation grace-period deadline (#676).
 */
export async function getActiveApiKeysAwaitingLookupHash(): Promise<ApiKeyRow[]> {
  const now = Math.floor(Date.now() / 1000);
  // sql-injection-check-ignore: ACTIVE_KEY_SQL is a hardcoded fragment; values are bound via params.
  const sql = `SELECT * FROM api_keys WHERE lookup_hash IS NULL AND ${ACTIVE_KEY_SQL}`;
  return timedQueryAsync(sql, () => getDriver().all<ApiKeyRow>(sql, [now, now]));
}

/**
 * Schedule an active API key for revocation at `revokeAfter` (unix seconds)
 * instead of revoking it immediately (#676). Used by key rotation to give
 * callers a grace window to roll a replacement key out before the old one
 * stops authenticating. A fresh call always overwrites any previously
 * scheduled deadline on the row.
 *
 * Only schedules keys belonging to the given scout wallet, and only while
 * not already permanently revoked. Returns true when a row was updated,
 * false when not found, not owned by this wallet, or already revoked.
 */
export async function scheduleApiKeyRevocation(
  id: number,
  scoutWallet: string,
  revokeAfter: number,
): Promise<boolean> {
  const sql = `
    UPDATE api_keys SET revoke_after = ?
    WHERE id = ? AND scout_wallet = ? AND revoked_at IS NULL
  `;
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [revokeAfter, id, scoutWallet]);
    return info.changes > 0;
  });
}

/**
 * Persist the derived lookup_hash for a pre-migration API key (#1033).
 * Only ever fills a NULL — an existing lookup value is never overwritten.
 */
export async function setApiKeyLookupHash(id: number, lookupHash: string): Promise<void> {
  const sql = `UPDATE api_keys SET lookup_hash = ? WHERE id = ? AND lookup_hash IS NULL`;
  await timedQueryAsync(sql, () => getDriver().run(sql, [lookupHash, id]));
}

/**
 * Update the last_used_at timestamp for an API key.
 */
export async function touchApiKeyLastUsed(id: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const sql = `UPDATE api_keys SET last_used_at = ? WHERE id = ?`;
  await timedQueryAsync(sql, () => getDriver().run(sql, [now, id]));
}

// ─── Wallet blocklist helpers (#1019) ────────────────────────────────────────

/**
 * Add a wallet to the blocklist. Idempotent — re-blocking an already
 * blocked wallet is a no-op.
 */
export async function blockWalletDb(wallet: string, reason: string | null): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const sql = `
    INSERT INTO wallet_blocklist (wallet, reason, blocked_at)
    VALUES (?, ?, ?)
    ON CONFLICT(wallet) DO NOTHING
  `;
  await timedQueryAsync(sql, () =>
    getDriver().run(sql, [wallet, reason, now]),
  );
}

/** Remove a wallet from the blocklist. Returns true if a row was removed. */
export async function unblockWalletDb(wallet: string): Promise<boolean> {
  const sql = `DELETE FROM wallet_blocklist WHERE wallet = ?`;
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [wallet]);
    return info.changes > 0;
  });
}

/** Fresh DB check — is this wallet currently blocklisted? */
export async function isWalletBlocklistedDb(wallet: string): Promise<boolean> {
  const sql = `SELECT wallet FROM wallet_blocklist WHERE wallet = ? LIMIT 1`;
  return timedQueryAsync(sql, async () =>
    (await getDriver().get<{ wallet: string }>(sql, [wallet])) !== undefined,
  );
}

/** Return every currently blocklisted wallet (one query, used by sweeps). */
export async function listBlockedWalletsDb(): Promise<string[]> {
  const sql = `SELECT wallet FROM wallet_blocklist`;
  return timedQueryAsync(sql, async () =>
    (await getDriver().all<{ wallet: string }>(sql)).map((r) => r.wallet),
  );
}

// ─── Scout bookmarks helpers (#487) ──────────────────────────────────────────

export interface ScoutBookmarkRow {
  id: number;
  scout_wallet: string;
  player_id: string;
  folder_id: number | null;
  note: string | null;
  created_at: number;
}

export interface ScoutBookmarkFolderRow {
  id: number;
  scout_wallet: string;
  name: string;
  created_at: number;
}

/**
 * Insert a bookmark.  Uses INSERT OR IGNORE so re-bookmarking is idempotent.
 * Returns true when a new row was inserted, false when it already existed.
 */
export async function insertBookmark(p: {
  scout_wallet: string;
  player_id: string;
  folder_id?: number | null;
  note?: string | null;
  created_at: number;
}): Promise<boolean> {
  const sql = `
    INSERT INTO scout_bookmarks (scout_wallet, player_id, folder_id, note, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (scout_wallet, player_id) DO NOTHING
  `;
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [
      p.scout_wallet,
      p.player_id,
      p.folder_id ?? null,
      p.note ?? null,
      p.created_at,
    ]);
    return info.changes > 0;
  });
}

/**
 * Delete a bookmark.
 * Returns true when a row was deleted, false when it did not exist.
 */
export async function deleteBookmark(scoutWallet: string, playerId: string): Promise<boolean> {
  const sql = `DELETE FROM scout_bookmarks WHERE scout_wallet = ? AND player_id = ?`;
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [scoutWallet, playerId]);
    return info.changes > 0;
  });
}

/**
 * List all bookmarks for a scout, ordered by creation time (newest first).
 * Optionally filter by folder_id.
 */
export async function getBookmarksByScout(scoutWallet: string, folderId?: number | null): Promise<ScoutBookmarkRow[]> {
  let sql: string;
  let params: (string | number | null)[];

  if (folderId !== undefined) {
    sql = `
      SELECT * FROM scout_bookmarks
      WHERE scout_wallet = ? AND folder_id = ?
      ORDER BY created_at DESC
    `;
    params = [scoutWallet, folderId];
  } else {
    sql = `
      SELECT * FROM scout_bookmarks
      WHERE scout_wallet = ?
      ORDER BY created_at DESC
    `;
    params = [scoutWallet];
  }

  return timedQueryAsync(sql, () => getDriver().all<ScoutBookmarkRow>(sql, params));
}

/**
 * Insert a bookmark folder. Returns the new folder id.
 */
export async function insertBookmarkFolder(p: {
  scout_wallet: string;
  name: string;
  created_at: number;
}): Promise<number> {
  const sql = `
    INSERT INTO scout_bookmark_folders (scout_wallet, name, created_at)
    VALUES (?, ?, ?)
    RETURNING id
  `;
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [p.scout_wallet, p.name, p.created_at]);
    return info.lastId;
  });
}

/**
 * List all bookmark folders for a scout, ordered by creation time (newest first).
 */
export async function getBookmarkFoldersByScout(scoutWallet: string): Promise<ScoutBookmarkFolderRow[]> {
  const sql = `
    SELECT * FROM scout_bookmark_folders
    WHERE scout_wallet = ?
    ORDER BY created_at DESC
  `;
  return timedQueryAsync(sql, () => getDriver().all<ScoutBookmarkFolderRow>(sql, [scoutWallet]));
}

/**
 * Get a bookmark folder by id, ensuring it belongs to the scout.
 */
export async function getBookmarkFolderById(folderId: number, scoutWallet: string): Promise<ScoutBookmarkFolderRow | null> {
  const sql = `
    SELECT * FROM scout_bookmark_folders
    WHERE id = ? AND scout_wallet = ?
  `;
  return timedQueryAsync(sql, async () =>
    (await getDriver().get<ScoutBookmarkFolderRow>(sql, [folderId, scoutWallet])) ?? null
  );
}

/**
 * Delete a bookmark folder by id, ensuring it belongs to the scout.
 * Returns true when a row was deleted, false when it did not exist.
 */
export async function deleteBookmarkFolder(folderId: number, scoutWallet: string): Promise<boolean> {
  const sql = `DELETE FROM scout_bookmark_folders WHERE id = ? AND scout_wallet = ?`;
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [folderId, scoutWallet]);
    return info.changes > 0;
  });
}

/**
 * Move bookmarks from a folder to root (set folder_id to NULL) when folder is deleted.
 */
export async function moveBookmarksToRoot(folderId: number, scoutWallet: string): Promise<void> {
  const sql = `UPDATE scout_bookmarks SET folder_id = NULL WHERE folder_id = ? AND scout_wallet = ?`;
  await timedQueryAsync(sql, () => getDriver().run(sql, [folderId, scoutWallet]));
}

/**
 * Count bookmarks in a folder.
 */
export async function countBookmarksInFolder(folderId: number): Promise<number> {
  const sql = `SELECT COUNT(*) as count FROM scout_bookmarks WHERE folder_id = ?`;
  return timedQueryAsync(sql, async () => {
    const row = await getDriver().get<{ count: number | string }>(sql, [folderId]);
    return Number(row?.count ?? 0);
  });
}

/**
 * Joined row returned by getBookmarkedPlayersWithDetails().
 * Combines bookmark metadata with the bookmarked player's full profile.
 */
export interface BookmarkedPlayerRow extends PlayerRow {
  bookmarked_at: number;
  bookmark_folder_id: number | null;
  bookmark_note: string | null;
}

/**
 * Fetch all bookmarked players for a scout in a single JOIN query, eliminating
 * the N+1 pattern of calling getPlayerById() once per bookmark row.
 *
 * Returns rows ordered by bookmark creation time (newest first), matching the
 * ordering of getBookmarksByScout(). Bookmarks whose player_id no longer
 * exists in the players table are silently dropped (INNER JOIN semantics).
 *
 * @param scoutWallet  The scout's Stellar wallet address.
 * @param folderId     Optional folder filter. When provided, only bookmarks in
 *                     that folder are returned.
 */
export async function getBookmarkedPlayersWithDetails(
  scoutWallet: string,
  folderId?: number | null,
): Promise<BookmarkedPlayerRow[]> {
  let sql: string;
  let params: (string | number | null)[];

  if (folderId !== undefined) {
    sql = `
      SELECT
        p.*,
        b.created_at AS bookmarked_at,
        b.folder_id  AS bookmark_folder_id,
        b.note       AS bookmark_note
      FROM scout_bookmarks b
      INNER JOIN players p ON p.player_id = b.player_id
      WHERE b.scout_wallet = ? AND b.folder_id = ?
      ORDER BY b.created_at DESC
    `;
    params = [scoutWallet, folderId];
  } else {
    sql = `
      SELECT
        p.*,
        b.created_at AS bookmarked_at,
        b.folder_id  AS bookmark_folder_id,
        b.note       AS bookmark_note
      FROM scout_bookmarks b
      INNER JOIN players p ON p.player_id = b.player_id
      WHERE b.scout_wallet = ?
      ORDER BY b.created_at DESC
    `;
    params = [scoutWallet];
  }

  return timedQueryAsync(sql, () => getDriver().all<BookmarkedPlayerRow>(sql, params));
}

// ─── Scout saved-search helpers (#486) ───────────────────────────────────────

export interface SavedSearchRow {
  id: number;
  scout_wallet: string;
  name: string;
  filters: string; // JSON string
  created_at: number;
  notify_enabled: number;
}

export async function getAllActiveSavedSearches(): Promise<SavedSearchRow[]> {
  const sql = 'SELECT * FROM scout_saved_searches WHERE notify_enabled = 1';
  return timedQueryAsync(sql, () => getDriver().all<SavedSearchRow>(sql));
}

export async function getSavedSearchNotification(scoutWallet: string, playerId: string): Promise<number | null> {
  const sql = 'SELECT notified_at FROM saved_search_notifications WHERE scout_wallet = ? AND player_id = ?';
  return timedQueryAsync(sql, async () => {
    const row = await getDriver().get<{ notified_at: number }>(sql, [scoutWallet, playerId]);
    return row ? row.notified_at : null;
  });
}

export async function recordSavedSearchNotification(scoutWallet: string, playerId: string, notifiedAt: number): Promise<void> {
  const sql = 'INSERT INTO saved_search_notifications (scout_wallet, player_id, notified_at) ' +
              'VALUES (?, ?, ?) ' +
              'ON CONFLICT(scout_wallet, player_id) DO UPDATE SET notified_at = excluded.notified_at';
  await timedQueryAsync(sql, () => getDriver().run(sql, [scoutWallet, playerId, notifiedAt]));
}

/**
 * Insert a new saved search for a scout.
 * Returns the new row id.
 */
export async function insertSavedSearch(p: {
  scout_wallet: string;
  name: string;
  filters: string; // pre-serialised JSON
  created_at: number;
  notify_enabled?: number;
}): Promise<number> {
  const sql = `
    INSERT INTO scout_saved_searches (scout_wallet, name, filters, created_at, notify_enabled)
    VALUES (?, ?, ?, ?, ?)
    RETURNING id
  `;
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [p.scout_wallet, p.name, p.filters, p.created_at, p.notify_enabled ?? 1]);
    return info.lastId;
  });
}

/**
 * List all saved searches for a scout, ordered newest-first.
 */
export async function getSavedSearchesByScout(scoutWallet: string): Promise<SavedSearchRow[]> {
  const sql = `
    SELECT * FROM scout_saved_searches
    WHERE scout_wallet = ?
    ORDER BY created_at DESC
  `;
  return timedQueryAsync(sql, () =>
    getDriver().all<SavedSearchRow>(sql, [scoutWallet]),
  );
}

/**
 * Delete a saved search by id.
 * Only deletes rows belonging to the given scout wallet for security.
 * Returns true when a row was deleted, false when it did not exist.
 */
export async function deleteSavedSearch(id: number, scoutWallet: string): Promise<boolean> {
  const sql = `DELETE FROM scout_saved_searches WHERE id = ? AND scout_wallet = ?`;
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [id, scoutWallet]);
    return info.changes > 0;
  });
}

/**
 * Get a saved search by id.
 * Only returns rows belonging to the given scout wallet for security.
 * Returns null when not found.
 */
export async function getSavedSearchById(id: number, scoutWallet: string): Promise<SavedSearchRow | null> {
  const sql = `SELECT * FROM scout_saved_searches WHERE id = ? AND scout_wallet = ?`;
  return timedQueryAsync(sql, async () =>
    (await getDriver().get<SavedSearchRow>(sql, [id, scoutWallet])) ?? null
  );
}

/**
 * Update a saved search's name and/or filters.
 * Only updates rows belonging to the given scout wallet for security.
 * Returns true when a row was updated, false when it did not exist.
 */
export async function updateSavedSearch(
  id: number,
  scoutWallet: string,
  updates: { name?: string; filters?: string }
): Promise<boolean> {
  const fields: string[] = [];
  const params: (string | number)[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    params.push(updates.name);
  }
  if (updates.filters !== undefined) {
    fields.push('filters = ?');
    params.push(updates.filters);
  }

  if (fields.length === 0) {
    return false;
  }

  params.push(id, scoutWallet);
  // sql-injection-check-ignore: fields.join produces `col = ?` fragments only ("name = ?", "filters = ?"); values are bound via params.
  const sql = `UPDATE scout_saved_searches SET ${fields.join(', ')} WHERE id = ? AND scout_wallet = ?`;
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, params);
    return info.changes > 0;
  });
}

/**
 * Count saved searches for a scout.
 * Used to enforce the 20 saved searches limit.
 */
export async function countSavedSearchesByScout(scoutWallet: string): Promise<number> {
  const sql = `SELECT COUNT(*) as count FROM scout_saved_searches WHERE scout_wallet = ?`;
  const row = await timedQueryAsync(sql, () =>
    getDriver().get<{ count: number | string }>(sql, [scoutWallet])
  );
  return Number(row?.count ?? 0);
}

// ─── Profile views helpers ────────────────────────────────────────────────────

/**
 * Record a profile view from a scout.
 * Inserts a new row into the profile_views table with scout wallet, player ID,
 * and timestamps. Used to track scout engagement with player profiles.
 */
export async function recordProfileView(p: {
  scout_wallet: string;
  player_id: string;
  viewed_at: number;
  created_at: number;
}): Promise<void> {
  const sql = `INSERT INTO profile_views (scout_wallet, player_id, viewed_at, created_at) VALUES (?, ?, ?, ?)`;
  await timedQueryAsync(sql, () => getDriver().run(sql, [p.scout_wallet, p.player_id, p.viewed_at, p.created_at]));
}

/**
 * Get the timestamp of the most recent profile view from a scout for a specific player.
 * Returns the Unix timestamp of the most recent view, or null if no view exists.
 * Used by deduplication logic to check the 5-minute dedup window.
 */
export async function getLastProfileView(scoutWallet: string, playerId: string): Promise<number | null> {
  const sql = `SELECT viewed_at FROM profile_views WHERE player_id = ? AND scout_wallet = ? ORDER BY viewed_at DESC LIMIT 1`;
  const row = await timedQueryAsync(sql, () =>
    getDriver().get<{ viewed_at: number }>(sql, [playerId, scoutWallet])
  );
  return row?.viewed_at ?? null;
}

/**
 * Get the total count of profile views for a player.
 * Returns the count of all profile_views records for the given player_id.
 * Used in analytics aggregation.
 */
export async function getProfileViewCount(playerId: string): Promise<number> {
  const sql = `SELECT COUNT(*) as count FROM profile_views WHERE player_id = ?`;
  const row = await timedQueryAsync(sql, () =>
    getDriver().get<{ count: number | string }>(sql, [playerId])
  );
  return Number(row?.count ?? 0);
}

/**
 * Get the count of unique scout wallets that have viewed a player's profile.
 * Counts distinct scout_wallet values (excluding NULL) from profile_views for the given player.
 * Used in analytics aggregation to determine viewer_count.
 */
export async function getUniqueViewerCount(playerId: string): Promise<number> {
  const sql = `SELECT COUNT(DISTINCT scout_wallet) as count FROM profile_views WHERE player_id = ? AND scout_wallet IS NOT NULL`;
  const row = await timedQueryAsync(sql, () =>
    getDriver().get<{ count: number | string }>(sql, [playerId])
  );
  return Number(row?.count ?? 0);
}

/**
 * Get the count of unique scout wallets that have unlocked contact information for a player.
 * Counts distinct scout_wallet values from the contact_unlocks table for the given player.
 * Used in analytics aggregation to determine contact_unlock_count.
 */
export async function getContactUnlockCount(playerId: string): Promise<number> {
  const sql = `SELECT COUNT(DISTINCT scout_wallet) as count FROM contact_unlocks WHERE player_id = ?`;
  const row = await timedQueryAsync(sql, () =>
    getDriver().get<{ count: number | string }>(sql, [playerId])
  );
  return Number(row?.count ?? 0);
}

// ─── Feature flags (#494) ─────────────────────────────────────────────────────

export interface FeatureFlagRow {
  name: string;
  enabled: number;
  updated_at: number;
  updated_by: string;
}

export async function getAllFeatureFlags(): Promise<FeatureFlagRow[]> {
  const sql = `SELECT * FROM feature_flags ORDER BY name`;
  return timedQueryAsync(sql, async () => normalizeFeatureFlags(await getDriver().all<FeatureFlagRow>(sql)));
}

export async function getFeatureFlag(name: string): Promise<FeatureFlagRow | null> {
  const sql = `SELECT * FROM feature_flags WHERE name = ?`;
  return timedQueryAsync(sql, async () => {
    const row = await getDriver().get<FeatureFlagRow>(sql, [name]);
    return row ? normalizeFeatureFlag(row) : null;
  });
}

export async function upsertFeatureFlag(p: {
  name: string;
  enabled: number;
  updated_at: number;
  updated_by: string;
}): Promise<void> {
  const sql = `
    INSERT INTO feature_flags (name, enabled, updated_at, updated_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      enabled = excluded.enabled,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `;
  await timedQueryAsync(sql, () => getDriver().run(sql, [p.name, p.enabled, p.updated_at, p.updated_by]));
}

/**
 * feature_flags.enabled is INTEGER (0/1) on both drivers (see
 * db/010_feature_flags_postgres.sql for why it isn't BOOLEAN on Postgres),
 * but defensively normalise here too in case a row was ever written by
 * something outside upsertFeatureFlag, so callers (and existing tests) that
 * compare `enabled === 1` keep working identically on both drivers.
 */
function normalizeFeatureFlag(row: FeatureFlagRow): FeatureFlagRow {
  const raw = row.enabled as unknown;
  return { ...row, enabled: raw === true || raw === 1 ? 1 : 0 };
}

function normalizeFeatureFlags(rows: FeatureFlagRow[]): FeatureFlagRow[] {
  return rows.map(normalizeFeatureFlag);
}

// ─── Multi-admin action helpers ───────────────────────────────────────────────

export interface PendingAdminActionRow {
  id: string;
  action_type: string;
  proposer: string;
  payload: string;
  required_signatures: number;
  collected_signatures: number;
  status: string;
  expires_at: number;
  created_at: number;
}

export async function insertPendingAdminAction(p: {
  id: string;
  action_type: string;
  proposer: string;
  payload: string;
  required_signatures: number;
  expires_at: number;
  created_at: number;
}): Promise<void> {
  const sql = `INSERT INTO pending_admin_actions (id, action_type, proposer, payload, required_signatures, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`;
  await timedQueryAsync(sql, () => getDriver().run(sql, [p.id, p.action_type, p.proposer, p.payload, p.required_signatures, p.expires_at, p.created_at]));
}

export async function getPendingAdminActionById(id: string): Promise<PendingAdminActionRow | null> {
  const sql = `SELECT * FROM pending_admin_actions WHERE id = ?`;
  return timedQueryAsync(sql, async () =>
    (await getDriver().get<PendingAdminActionRow>(sql, [id])) ?? null
  );
}

export async function getPendingAdminActionsByStatus(status: string): Promise<PendingAdminActionRow[]> {
  const sql = `SELECT * FROM pending_admin_actions WHERE status = ? ORDER BY created_at DESC`;
  return timedQueryAsync(sql, () => getDriver().all<PendingAdminActionRow>(sql, [status]));
}

export async function updatePendingAdminActionStatus(id: string, status: string): Promise<void> {
  const sql = `UPDATE pending_admin_actions SET status = ? WHERE id = ?`;
  await timedQueryAsync(sql, () => getDriver().run(sql, [status, id]));
}

export async function incrementActionSignatures(id: string): Promise<void> {
  const sql = `UPDATE pending_admin_actions SET collected_signatures = collected_signatures + 1 WHERE id = ?`;
  await timedQueryAsync(sql, () => getDriver().run(sql, [id]));
}

export async function expireStalePendingAdminActions(): Promise<number> {
  const sql = `UPDATE pending_admin_actions SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?`;
  const info = await timedQueryAsync(sql, () => getDriver().run(sql, [Date.now()]));
  return info.changes;
}

export async function insertAdminActionSignature(p: {
  action_id: string;
  signer: string;
  signed_at: number;
}): Promise<boolean> {
  const sql = `INSERT INTO admin_action_signatures (action_id, signer, signed_at) VALUES (?, ?, ?) ON CONFLICT (action_id, signer) DO NOTHING`;
  const info = await timedQueryAsync(sql, () => getDriver().run(sql, [p.action_id, p.signer, p.signed_at]));
  return info.changes > 0;
}

export async function getAdminActionSignature(action_id: string, signer: string): Promise<{ signed_at: number } | null> {
  const sql = `SELECT signed_at FROM admin_action_signatures WHERE action_id = ? AND signer = ?`;
  return timedQueryAsync(sql, async () =>
    (await getDriver().get<{ signed_at: number }>(sql, [action_id, signer])) ?? null
  );
}

export async function getAdminActionSignatures(action_id: string): Promise<{ signer: string; signed_at: number }[]> {
  const sql = `SELECT signer, signed_at FROM admin_action_signatures WHERE action_id = ? ORDER BY signed_at ASC`;
  return timedQueryAsync(sql, () => getDriver().all<{ signer: string; signed_at: number }>(sql, [action_id]));
}

// ─── Webhook subscriptions (#470) ────────────────────────────────────────────
//
// Schema defined in db/012_webhook_subscriptions.sql. Each row is a subscriber
// that receives outbound event webhooks; `secret` is the per-subscriber HMAC
// key used to sign every delivery (see src/services/webhooks.ts, docs/webhooks.md).

export interface WebhookSubscription {
  id: number;
  url: string;
  secret: string;
  scout_wallet: string | null;
  event_types: string | null; // JSON array of ContractEventType strings, or null = all
  created_at: string;
}

export function createWebhookSubscription(
  url: string,
  secret?: string,
  scoutWallet?: string,
  eventTypes?: string[],
): WebhookSubscription {
  const finalSecret = secret ?? crypto.randomBytes(32).toString('hex');
  // Encrypted at rest (#686) — only the ciphertext is ever persisted. The
  // plaintext is returned to the caller here (e.g. for the API response at
  // issuance time) but is never written back to storage.
  const encryptedSecret = encryptWebhookSecret(finalSecret);
  const eventTypesJson = eventTypes && eventTypes.length > 0 ? JSON.stringify(eventTypes) : null;
  const sql = 'INSERT INTO webhook_subscriptions (url, secret, scout_wallet, event_types) VALUES (?, ?, ?, ?)';
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(url, encryptedSecret, scoutWallet ?? null, eventTypesJson);
    return {
      id: Number(info.lastInsertRowid),
      url,
      secret: finalSecret,
      scout_wallet: scoutWallet ?? null,
      event_types: eventTypesJson,
      created_at: new Date().toISOString(),
    };
  });
}

export function listWebhookSubscriptions(): WebhookSubscription[] {
  const sql = 'SELECT * FROM webhook_subscriptions ORDER BY id ASC';
  return timedQuery(sql, () => {
    const rows = getDb().prepare(sql).all() as WebhookSubscription[];
    // Decrypted only here, in memory, immediately before the caller signs a
    // delivery with it (src/services/webhooks.ts) — never persisted.
    return rows.map((row) => ({ ...row, secret: decryptWebhookSecret(row.secret) }));
  });
}

/**
 * Look up a single webhook subscription by its row id.
 * Returns the row with the secret still encrypted (callers that need the
 * plaintext secret must call decryptWebhookSecret themselves).
 * Returns undefined when not found.
 */
export function getWebhookSubscriptionById(id: number): WebhookSubscription | undefined {
  const sql = 'SELECT * FROM webhook_subscriptions WHERE id = ?';
  return timedQuery(sql, () =>
    getDb().prepare(sql).get(id) as WebhookSubscription | undefined,
  );
}

/**
 * List all webhook subscriptions owned by a specific scout wallet.
 * Secrets are returned encrypted — decrypt before use.
 */
export function getWebhookSubscriptionsByScout(scoutWallet: string): WebhookSubscription[] {
  const sql = 'SELECT * FROM webhook_subscriptions WHERE scout_wallet = ? ORDER BY id ASC';
  return timedQuery(sql, () =>
    getDb().prepare(sql).all(scoutWallet) as WebhookSubscription[],
  );
}

/**
 * Delete a webhook subscription by id, scoped to a specific scout wallet to
 * prevent cross-scout deletion. Returns true when a row was deleted.
 */
export function deleteWebhookSubscription(id: number, scoutWallet: string): boolean {
  const sql = 'DELETE FROM webhook_subscriptions WHERE id = ? AND scout_wallet = ?';
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(id, scoutWallet);
    return info.changes > 0;
  });
}

/**
 * Idempotently seeds a subscription for the legacy WEBHOOK_URL config so
 * single-subscriber deployments keep working after moving to the DB-backed
 * subscription model. No-op if the URL is already subscribed, or if the
 * legacy webhook is not enabled/configured. Called once from initDb().
 */
export function ensureLegacyWebhookSubscription(): void {
  if (!config.webhook.enabled || !config.webhook.url) return;

  const sql = 'SELECT * FROM webhook_subscriptions WHERE url = ?';
  const existing = timedQuery(sql, () =>
    getDb().prepare(sql).get(config.webhook.url) as WebhookSubscription | undefined
  );
  if (existing) return;

  createWebhookSubscription(config.webhook.url, config.webhook.secret || undefined);
}

// ─── Webhook dead-letter queue (#470) ────────────────────────────────────────
//
// Schema defined in db/013_webhook_dead_letters.sql. A row is inserted whenever
// postWebhookWithRetry() exhausts all retry attempts for a given subscriber,
// instead of the delivery being logged and dropped.

export type WebhookDeadLetterStatus = 'pending' | 'in_progress' | 'replayed';

export interface WebhookDeadLetter {
  id: number;
  subscription_id: number | null;
  url: string;
  event_type: string;
  payload: string;
  delivery_id: string;
  failure_reason: string;
  attempts: number;
  status: WebhookDeadLetterStatus;
  locked_by: string | null;
  locked_at: string | null;
  created_at: string;
  replayed_at: string | null;
}

export interface InsertDeadLetterInput {
  subscriptionId: number | null;
  url: string;
  eventType: string;
  payload: string;
  deliveryId: string;
  failureReason: string;
  attempts: number;
}

export function insertWebhookDeadLetter(input: InsertDeadLetterInput): WebhookDeadLetter {
  const sql = `INSERT INTO webhook_dead_letters
    (subscription_id, url, event_type, payload, delivery_id, failure_reason, attempts, status)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`;
  return timedQuery(sql, () => {
    const info = getDb()
      .prepare(sql)
      .run(
        input.subscriptionId,
        input.url,
        input.eventType,
        input.payload,
        input.deliveryId,
        input.failureReason,
        input.attempts
      );
    return {
      id: Number(info.lastInsertRowid),
      subscription_id: input.subscriptionId,
      url: input.url,
      event_type: input.eventType,
      payload: input.payload,
      delivery_id: input.deliveryId,
      failure_reason: input.failureReason,
      attempts: input.attempts,
      status: 'pending',
      locked_by: null,
      locked_at: null,
      created_at: new Date().toISOString(),
      replayed_at: null,
    };
  });
}

export function listWebhookDeadLetters(limit: number, offset: number): WebhookDeadLetter[] {
  const sql = 'SELECT * FROM webhook_dead_letters ORDER BY id DESC LIMIT ? OFFSET ?';
  return timedQuery(sql, () =>
    getDb().prepare(sql).all(limit, offset) as WebhookDeadLetter[]
  );
}

export function countWebhookDeadLetters(): number {
  const sql = 'SELECT COUNT(*) as count FROM webhook_dead_letters';
  return timedQuery(sql, () => {
    const row = getDb().prepare(sql).get() as { count: number } | undefined;
    return row?.count ?? 0;
  });
}

/**
 * Dead-letter counts grouped by subscription_id for metrics and alerting (#1131).
 */
export function countWebhookDeadLettersBySubscription(): Array<{
  subscription_id: number | null;
  count: number;
}> {
  const sql = `SELECT subscription_id, COUNT(*) AS count
               FROM webhook_dead_letters
               WHERE status IN ('pending', 'in_progress')
               GROUP BY subscription_id
               ORDER BY count DESC`;
  return timedQuery(sql, () =>
    getDb().prepare(sql).all() as Array<{ subscription_id: number | null; count: number }>,
  );
}

export function getWebhookDeadLetterById(id: number): WebhookDeadLetter | undefined {
  const sql = 'SELECT * FROM webhook_dead_letters WHERE id = ?';
  return timedQuery(sql, () =>
    getDb().prepare(sql).get(id) as WebhookDeadLetter | undefined
  );
}

export function markWebhookDeadLetterReplayed(id: number): void {
  const sql = "UPDATE webhook_dead_letters SET status = 'replayed', replayed_at = ?, locked_by = NULL, locked_at = NULL WHERE id = ?";
  timedQuery(sql, () => getDb().prepare(sql).run(new Date().toISOString(), id));
}

/**
 * Atomically claim a pending dead-letter row for processing by setting
 * status to 'in_progress' and recording the worker identifier.
 *
 * Returns the claimed row on success, or null if another worker already
 * claimed it (or the row was already replayed / exhausted).
 *
 * The UPDATE ... WHERE status = 'pending' is atomic in both SQLite and
 * PostgreSQL, so exactly one concurrent caller wins the race.
 */
export function claimWebhookDeadLetter(id: number, workerId: string): WebhookDeadLetter | null {
  const now = new Date().toISOString();
  const sql = `UPDATE webhook_dead_letters
    SET status = 'in_progress', locked_by = ?, locked_at = ?
    WHERE id = ? AND status = 'pending'`;
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(workerId, now, id);
    if (info.changes === 0) return null;
    return getWebhookDeadLetterById(id) ?? null;
  });
}

/**
 * Release a claim on a dead-letter row, returning it to 'pending' status.
 * Used when a sweep fails partway through and the row needs to be retried
 * by a future sweep.
 */
export function releaseWebhookDeadLetterClaim(id: number): void {
  const sql = `UPDATE webhook_dead_letters
    SET status = 'pending', locked_by = NULL, locked_at = NULL
    WHERE id = ? AND status = 'in_progress'`;
  timedQuery(sql, () => getDb().prepare(sql).run(id));
}

export function updateWebhookDeadLetterAttempt(
  id: number,
  attempts: number,
  failureReason: string
): void {
  const sql = 'UPDATE webhook_dead_letters SET attempts = ?, failure_reason = ? WHERE id = ?';
  timedQuery(sql, () => getDb().prepare(sql).run(attempts, failureReason, id));
}

/** Delete a specific dead-letter row by id. Returns true when a row was deleted. */
export function deleteWebhookDeadLetter(id: number): boolean {
  const sql = 'DELETE FROM webhook_dead_letters WHERE id = ?';
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(id);
    return info.changes > 0;
  });
}

/** Delete all dead-letter rows older than cutoffDays days. Returns the count deleted. */
export function purgeOldWebhookDeadLetters(cutoffDays: number): number {
  // created_at is stored as ISO text ("2024-01-01T00:00:00.000Z")
  const cutoff = new Date(Date.now() - cutoffDays * 24 * 60 * 60 * 1000).toISOString();
  const sql = "DELETE FROM webhook_dead_letters WHERE created_at < ?";
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(cutoff);
    return info.changes;
  });
}

// ─── Fee withdrawal helpers (#fee-withdrawal) ────────────────────────────────

export interface FeeWithdrawalRow {
  id: number;
  idempotency_key: string | null;
  treasury_address: string;
  amount_stroops: string;
  tx_hash: string;
  admin_wallet: string;
  created_at: string;
}

/**
 * Insert a confirmed fee withdrawal record.
 * The UNIQUE constraint on `tx_hash` prevents duplicate rows for the same
 * on-chain transaction; the UNIQUE constraint on `idempotency_key` provides
 * a storage-layer guard against double-submission at the DB level (the HTTP
 * idempotency middleware is the primary gate, but belts-and-suspenders here
 * is valuable for audit integrity).
 *
 * Returns the new row id.
 */
export async function insertFeeWithdrawal(p: {
  idempotencyKey: string | null;
  treasuryAddress: string;
  amountStroops: string;
  txHash: string;
  adminWallet: string;
  createdAt: string;
}): Promise<number> {
  const sql = `
    INSERT INTO fee_withdrawals
      (idempotency_key, treasury_address, amount_stroops, tx_hash, admin_wallet, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    RETURNING id
  `;
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [
      p.idempotencyKey ?? null,
      p.treasuryAddress,
      p.amountStroops,
      p.txHash,
      p.adminWallet,
      p.createdAt,
    ]);
    return info.lastId;
  });
}

/**
 * Look up a fee withdrawal by idempotency key.
 * Returns null when no record exists for the given key, so callers can
 * distinguish "never submitted" from "already submitted".
 */
export async function getFeeWithdrawalByIdempotencyKey(key: string): Promise<FeeWithdrawalRow | null> {
  const sql = `SELECT * FROM fee_withdrawals WHERE idempotency_key = ? LIMIT 1`;
  return timedQueryAsync(sql, async () =>
    (await getDriver().get<FeeWithdrawalRow>(sql, [key])) ?? null,
  );
}

/**
 * Return the most recent fee_withdrawals rows, newest-first.
 * Used by GET /api/admin/fees to show withdrawal history.
 */
export async function listFeeWithdrawals(limit = 50, offset = 0): Promise<FeeWithdrawalRow[]> {
  const sql = `
    SELECT * FROM fee_withdrawals
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `;
  return timedQueryAsync(sql, () =>
    getDriver().all<FeeWithdrawalRow>(sql, [limit, offset]),
  );
}

// ─── Webhook delivery history (#1121) ─────────────────────────────────────────

export interface WebhookDeliveryRow {
  id: number;
  subscription_id: string;
  event_type: string;
  delivery_id: string;
  attempt_count: number;
  status: 'success' | 'failure';
  status_code: number | null;
  error_message: string | null;
  latency_ms: number | null;
  created_at: number;
}

export interface InsertWebhookDeliveryParams {
  subscriptionId: string;
  eventType: string;
  deliveryId: string;
  attemptCount: number;
  status: 'success' | 'failure';
  statusCode?: number | null;
  errorMessage?: string | null;
  latencyMs?: number | null;
}

/**
 * Persist a webhook delivery attempt record (success or failure).
 * Called by the webhook service after every dispatch.
 */
export function insertWebhookDelivery(p: InsertWebhookDeliveryParams): void {
  const sql = `
    INSERT INTO webhook_deliveries
      (subscription_id, event_type, delivery_id, attempt_count, status, status_code, error_message, latency_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  timedQuery(sql, () =>
    getDb()
      .prepare(sql)
      .run(
        p.subscriptionId,
        p.eventType,
        p.deliveryId,
        p.attemptCount,
        p.status,
        p.statusCode ?? null,
        p.errorMessage ?? null,
        p.latencyMs ?? null,
        Date.now(),
      ),
  );
}

export interface GetWebhookDeliveriesOptions {
  subscriptionId: string;
  limit?: number;
  offset?: number;
}

/** Return paginated delivery records for a given subscription (newest first). */
export function getWebhookDeliveries(
  opts: GetWebhookDeliveriesOptions,
): { data: WebhookDeliveryRow[]; total: number } {
  const db = getDb();
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;

  const countSql =
    'SELECT COUNT(*) AS count FROM webhook_deliveries WHERE subscription_id = ?';
  const total = timedQuery(countSql, () => {
    const row = db.prepare(countSql).get(opts.subscriptionId) as { count: number };
    return row.count;
  });

  const dataSql = `
    SELECT * FROM webhook_deliveries
    WHERE subscription_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `;
  const data = timedQuery(dataSql, () =>
    db.prepare(dataSql).all(opts.subscriptionId, limit, offset) as WebhookDeliveryRow[],
  );

  return { data, total };
}

export interface WebhookDeliverySummary {
  subscription_id: string;
  total: number;
  successes: number;
  failures: number;
  success_rate: number;
  last_success_at: number | null;
}

/**
 * Return a rolled-up success-rate summary for a subscription over the given
 * window (default: last 24 hours).
 */
export function getWebhookDeliverySummary(
  subscriptionId: string,
  windowMs = 24 * 60 * 60 * 1000,
): WebhookDeliverySummary {
  const db = getDb();
  const since = Date.now() - windowMs;

  const sql = `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
      SUM(CASE WHEN status = 'failure' THEN 1 ELSE 0 END) AS failures,
      MAX(CASE WHEN status = 'success' THEN created_at ELSE NULL END) AS last_success_at
    FROM webhook_deliveries
    WHERE subscription_id = ? AND created_at >= ?
  `;
  const row = timedQuery(sql, () =>
    db.prepare(sql).get(subscriptionId, since) as {
      total: number;
      successes: number;
      failures: number;
      last_success_at: number | null;
    },
  );

  const total = row.total ?? 0;
  const successes = row.successes ?? 0;
  return {
    subscription_id: subscriptionId,
    total,
    successes,
    failures: row.failures ?? 0,
    success_rate: total === 0 ? 0 : Math.round((successes / total) * 100) / 100,
    last_success_at: row.last_success_at ?? null,
  };
}

/**
 * Delete delivery records older than retentionMs (default 30 days).
 * Call periodically (e.g., from the indexer poll loop) to bound table growth.
 * Returns the number of rows deleted.
 */
export function pruneWebhookDeliveries(retentionMs = 30 * 24 * 60 * 60 * 1000): number {
  const cutoff = Date.now() - retentionMs;
  const sql = 'DELETE FROM webhook_deliveries WHERE created_at < ?';
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(cutoff);
    return info.changes;
  });
}
