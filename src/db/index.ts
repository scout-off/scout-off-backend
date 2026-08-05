import Database from 'better-sqlite3';
import crypto from 'crypto';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import config from '../config';
import { EventRecord, ContractEventType } from '../types';
import { runMigrations } from './migrate';
import { logger } from '../utils/logger';
import { computeChainHash, auditChainContent, GENESIS_HASH } from '../utils/hashChain';
import { encryptWebhookSecret, decryptWebhookSecret } from '../utils/webhookSecretCipher';
import { DbDriver } from './driver';
import { SqliteDriver } from './sqlite-driver';
import { PostgresDriver } from './postgres-driver';
import { observeDbQueryDuration } from '../middleware/metrics';

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
      typeof (result as { changes: unknown }).changes === 'number'
    ) {
      row_count = (result as { changes: number }).changes;
    } else if (result !== null && result !== undefined && !Array.isArray(result) && typeof result !== 'object') {
      // scalar (number, boolean, string) — treat as 1 row
      row_count = 1;
    }
    logger.warn({ query_name: sql, duration_ms, row_count });
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

    const pgDriver = new PostgresDriver(config.databaseUrl, config.databaseSsl);
    await pgDriver.connect();
    _driver = pgDriver;

    logger.info('[db] Connected to PostgreSQL');
  } else {
    // SQLite initialization (default)
    _db = new Database(config.dbPath);
    _driver = new SqliteDriver(_db);

    // Create initial schema inline (for backwards compatibility with in-memory test databases)
    _driver.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        type       TEXT NOT NULL,
        ledger     INTEGER NOT NULL,
        ledger_hash TEXT,
        tx_hash    TEXT NOT NULL UNIQUE,
        payload    TEXT NOT NULL,
        created_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_events_ledger ON events (ledger);
      CREATE INDEX IF NOT EXISTS idx_events_type_ledger ON events (type, ledger);
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
  runMigrations(_driver);

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
    sql = 'SELECT * FROM events WHERE type = ? ORDER BY ledger ASC LIMIT ? OFFSET ?';
    rows = timedQuery(sql, () => db.prepare(sql).all(type, limit, offset) as EventRow[]);
  } else if (type) {
    sql = 'SELECT * FROM events WHERE type = ? ORDER BY ledger ASC';
    rows = timedQuery(sql, () => db.prepare(sql).all(type) as EventRow[]);
  } else if (hasPagination) {
    sql = 'SELECT * FROM events ORDER BY ledger ASC LIMIT ? OFFSET ?';
    rows = timedQuery(sql, () => db.prepare(sql).all(limit, offset) as EventRow[]);
  } else {
    sql = 'SELECT * FROM events ORDER BY ledger ASC';
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
  const sql = 'SELECT type, ledger, payload, created_at FROM events ' + where + ' ORDER BY ledger ASC, id ASC LIMIT ? OFFSET ?';
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
  const sql = 'SELECT type, ledger, payload, created_at FROM events ' + where + ' ORDER BY ledger ASC, id ASC';

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

export function insertPlayerProfileHistory(p: {
  player_id: string;
  metadata_uri: string;
  changed_at: number;
  tx_hash: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO player_profile_history (player_id, metadata_uri, changed_at, tx_hash)
       VALUES (?, ?, ?, ?)`,
    )
    .run(p.player_id, p.metadata_uri, p.changed_at, p.tx_hash);
}

export function getPlayerProfileHistory(
  playerId: string,
): PlayerProfileHistoryRow[] {
  return getDb()
    .prepare(
      `SELECT id, metadata_uri, changed_at, tx_hash
       FROM player_profile_history
       WHERE player_id = ?
       ORDER BY changed_at DESC`,
    )
    .all(playerId) as PlayerProfileHistoryRow[];
}

/**
 * Returns all history rows for a player ordered oldest-first (ASC), with a
 * 1-based `version` number assigned by insertion order. The version number is
 * derived from the row's position in the ascending sequence so it is stable
 * even after rows are inserted concurrently.
 */
export function getPlayerProfileHistoryVersioned(
  playerId: string,
): Array<PlayerProfileHistoryRow & { version: number }> {
  const rows = getDb()
    .prepare(
      `SELECT id, metadata_uri, changed_at, tx_hash
       FROM player_profile_history
       WHERE player_id = ?
       ORDER BY id ASC`,
    )
    .all(playerId) as PlayerProfileHistoryRow[];

  return rows.map((row, idx) => ({ ...row, version: idx + 1 }));
}

export function insertOrUpdatePlayer(p: {
  player_id: string;
  wallet: string;
  position?: string;
  region?: string;
  metadata_uri?: string;
  created_at?: number;
  registered_at?: number;
}): void {
  const sql = `INSERT INTO players (player_id, wallet, position, region, metadata_uri, created_at, registered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET
         wallet       = excluded.wallet,
         position     = excluded.position,
         region       = excluded.region,
         metadata_uri = excluded.metadata_uri`;
  withDbSpan('insertOrUpdatePlayer', sql, () =>
    timedQuery(sql, () =>
      getDb().prepare(sql).run(p.player_id, p.wallet, p.position ?? null, p.region ?? null, p.metadata_uri ?? null, p.created_at ?? null, p.registered_at ?? 0)
    )
  );
}

/** @deprecated Use insertOrUpdatePlayer instead. Will be removed in next release. */
export const upsertPlayer = insertOrUpdatePlayer;

export function updatePlayerProgress(playerId: string, level: number): void {
  const sql = 'UPDATE players SET progress_level = ? WHERE player_id = ?';
  withDbSpan('updatePlayerProgress', sql, () =>
    timedQuery(sql, () => getDb().prepare(sql).run(level, playerId))
  );
}

export interface ValidatorStatsRow {
  wallet: string;
  milestones_approved: number;
  milestones_rejected: number;
}

export function incrementValidatorApproved(wallet: string): void {
  const sql = `INSERT INTO validator_stats (wallet, milestones_approved, milestones_rejected)
               VALUES (?, 1, 0)
               ON CONFLICT(wallet) DO UPDATE SET milestones_approved = milestones_approved + 1`;
  timedQuery(sql, () => getDb().prepare(sql).run(wallet));
}

export function incrementValidatorRejected(wallet: string): void {
  const sql = `INSERT INTO validator_stats (wallet, milestones_approved, milestones_rejected)
               VALUES (?, 0, 1)
               ON CONFLICT(wallet) DO UPDATE SET milestones_rejected = milestones_rejected + 1`;
  timedQuery(sql, () => getDb().prepare(sql).run(wallet));
}

export function getValidatorStats(wallet: string): ValidatorStatsRow | null {
  const sql = 'SELECT * FROM validator_stats WHERE wallet = ?';
  return timedQuery(sql, () => 
    (getDb().prepare(sql).get(wallet) as ValidatorStatsRow | undefined) ?? null
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

export function insertPendingMilestone(
  milestoneId: string,
  playerId: string,
  validatorWallet: string,
  milestoneType: string,
  evidenceUri: string,
  submittedAt: number
): void {
  const sql = `INSERT OR IGNORE INTO pending_milestones 
               (milestone_id, player_id, validator_wallet, milestone_type, evidence_uri, submitted_at) 
               VALUES (?, ?, ?, ?, ?, ?)`;
  timedQuery(sql, () => getDb().prepare(sql).run(milestoneId, playerId, validatorWallet, milestoneType, evidenceUri, submittedAt));
}

export function removePendingMilestone(milestoneId: string): void {
  const sql = 'DELETE FROM pending_milestones WHERE milestone_id = ?';
  timedQuery(sql, () => getDb().prepare(sql).run(milestoneId));
}

/**
 * Cancel (delete) all pending milestones for a given player.
 * Returns the number of rows removed.
 */
export function cancelPendingMilestonesForPlayer(playerId: string): number {
  const sql = 'DELETE FROM pending_milestones WHERE player_id = ?';
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(playerId);
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

export function getPendingMilestones(options: GetPendingMilestonesOptions): { data: PendingMilestoneRow[], total: number } {
  const db = getDb();
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
  const countSql = 'SELECT COUNT(*) AS total FROM pending_milestones pm ' + 
                   'LEFT JOIN players p ON pm.player_id = p.player_id ' + 
                   whereClause;
  const countRow = timedQuery(countSql, () => db.prepare(countSql).get(...params) as { total: number });
  const total = countRow.total;

  // Get paginated data
  const page = options.page || 1;
  const pageSize = options.pageSize || 20;
  const offset = (page - 1) * pageSize;
  const dataSql = 'SELECT pm.* FROM pending_milestones pm ' + 
                  'LEFT JOIN players p ON pm.player_id = p.player_id ' + 
                  whereClause + 
                  ' ORDER BY pm.submitted_at DESC ' + 
                  'LIMIT ? OFFSET ?';
  const data = timedQuery(dataSql, () => db.prepare(dataSql).all(...params, pageSize, offset) as PendingMilestoneRow[]);

  return { data, total };
}

export function getPlayerById(playerId: string): PlayerRow | null {
  const sql = 'SELECT * FROM players WHERE player_id = ?';
  return timedQuery(sql, () =>
    (getDb().prepare(sql).get(playerId) as PlayerRow | undefined) ?? null
  );
}

export function getPlayerByWallet(wallet: string): PlayerRow | null {
  const sql = 'SELECT * FROM players WHERE wallet = ?';
  return timedQuery(sql, () =>
    (getDb().prepare(sql).get(wallet) as PlayerRow | undefined) ?? null
  );
}

export function deactivatePlayer(playerId: string): void {
  const sql = 'UPDATE players SET is_active = 0 WHERE player_id = ?';
  timedQuery(sql, () => getDb().prepare(sql).run(playerId));
}

/** Deactivate a player and persist a human-readable reason. */
export function deactivatePlayerWithReason(playerId: string, reason: string): void {
  const sql = 'UPDATE players SET is_active = 0, deactivation_reason = ? WHERE player_id = ?';
  timedQuery(sql, () => getDb().prepare(sql).run(reason, playerId));
}

export function reactivatePlayer(playerId: string): void {
  const sql = 'UPDATE players SET is_active = 1 WHERE player_id = ?';
  timedQuery(sql, () => getDb().prepare(sql).run(playerId));
}

/** Clear deactivation state and reason on reactivation. */
export function reactivatePlayerWithReason(playerId: string): void {
  const sql = "UPDATE players SET is_active = 1, deactivation_reason = NULL WHERE player_id = ?";
  timedQuery(sql, () => getDb().prepare(sql).run(playerId));
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

export function queryPlayers(opts: QueryPlayersOptions): PlayerRow[] {
  const { where, params } = buildPlayerWhereClause(opts);
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  const sql = 'SELECT * FROM players ' + where + ' ORDER BY created_at ASC LIMIT ? OFFSET ?';
  return timedQuery(sql, () =>
    getDb().prepare(sql).all(...params, limit, offset) as PlayerRow[]
  );
}

export function countPlayers(opts: Omit<QueryPlayersOptions, 'limit' | 'offset'>): number {
  const { where, params } = buildPlayerWhereClause(opts);
  const sql = 'SELECT COUNT(*) as count FROM players ' + where;
  return timedQuery(sql, () => {
    const row = getDb().prepare(sql).get(...params) as { count: number };
    return row.count;
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

export function searchPlayers(opts: SearchPlayersOptions): SearchPlayersResult {
  const db = getDb();
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
      const decoded = decodeCursor(opts.cursor);
      if (decoded && decoded.length >= 2) {
        cursorWhere = 'AND (search_score, player_id) < (?, ?)';
        cursorParams.push(decoded[0] as number, decoded[1] as string);
      }
    }

    const fetchLimit = useCursor ? limit + 1 : limit;
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
    const rows = timedQuery(sql, () =>
      db.prepare(sql).all(...allParams) as ScoredPlayerRow[]
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
    const decoded = decodeCursor(opts.cursor);
    if (decoded && decoded.length >= 2) {
      const lastVal = decoded[0] as string | number;
      const lastPlayerId = decoded[1] as string;
      const op = direction === 'ASC' ? '>' : '<';
      cursorWhere = `AND (${orderColumn}, player_id) ${op} (?, ?)`;
      cursorParams.push(lastVal, lastPlayerId);
    }
  }

  const fetchLimit = useCursor ? limit + 1 : limit;
  const sql = `SELECT * FROM players ${baseWhere} ${cursorWhere} ORDER BY ${orderColumn} ${direction}, player_id ASC LIMIT ? ${offsetClause}`;
  const allParams = [...params, ...cursorParams, fetchLimit];
  const rows = timedQuery(sql, () =>
    db.prepare(sql).all(...allParams) as PlayerRow[]
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
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Look up a non-expired idempotency key regardless of its status.
 * Returns the stored record, or null when the key is absent or expired.
 */
export function getIdempotencyRecord(key: string): IdempotencyRecord | null {
  const sql = 'SELECT * FROM idempotency_keys WHERE key = ? AND expires_at > ?';
  const now = Date.now();
  return timedQuery(sql, () =>
    (getDb().prepare(sql).get(key, now) as IdempotencyRecord | undefined) ?? null
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
export function claimIdempotencyKey(key: string): boolean {
  const now = Date.now();
  const sql = `
    INSERT OR IGNORE INTO idempotency_keys (key, status_code, response, created_at, expires_at, status)
    VALUES (?, 0, '', ?, ?, 'pending')
  `;
  const result = timedQuery(sql, () =>
    getDb()
      .prepare(sql)
      .run(key, now, now + IDEMPOTENCY_TTL_MS)
  );
  // changes === 1 means a new row was inserted (this caller won the race).
  return result.changes === 1;
}

/**
 * Transition a 'pending' idempotency key to 'complete', recording the final
 * response.  Called by the middleware after the handler has written its response.
 */
export function updateIdempotencyRecord(
  key: string,
  statusCode: number,
  body: unknown,
): void {
  const sql = `
    UPDATE idempotency_keys
    SET status_code = ?, response = ?, status = 'complete'
    WHERE key = ?
  `;
  timedQuery(sql, () =>
    getDb()
      .prepare(sql)
      .run(statusCode, JSON.stringify(body), key)
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
export function saveIdempotencyRecord(
  key: string,
  statusCode: number,
  body: unknown,
): void {
  const now = Date.now();
  const sql = `
    INSERT INTO idempotency_keys (key, status_code, response, created_at, expires_at, status)
    VALUES (?, ?, ?, ?, ?, 'complete')
    ON CONFLICT(key) DO NOTHING
  `;
  timedQuery(sql, () =>
    getDb()
      .prepare(sql)
      .run(key, statusCode, JSON.stringify(body), now, now + IDEMPOTENCY_TTL_MS)
  );
}

/**
 * Delete all idempotency records whose TTL has passed.
 * Call this periodically (e.g., from the indexer poll loop) to keep the table small.
 */
export function purgeExpiredIdempotencyKeys(): number {
  const sql = 'DELETE FROM idempotency_keys WHERE expires_at <= ?';
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(Date.now());
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

export function getLatestSubscription(scoutWallet: string): SubscriptionRow | null {
  const sql = `SELECT * FROM subscriptions WHERE scout_wallet = ? AND cancelled_at IS NULL ORDER BY expires_at DESC LIMIT 1`;
  return withDbSpan('getLatestSubscription', sql, () =>
    timedQuery(sql, () =>
      (getDb().prepare(sql).get(scoutWallet) as SubscriptionRow | undefined) ?? null
    )
  );
}

/**
 * Return all subscription rows for a scout (including cancelled), ordered newest-first.
 * Used by the payment history endpoint.
 */
export function getSubscriptionsByScout(scoutWallet: string): SubscriptionRow[] {
  const sql = `SELECT * FROM subscriptions WHERE scout_wallet = ? ORDER BY created_at DESC`;
  return timedQuery(sql, () =>
    getDb().prepare(sql).all(scoutWallet) as SubscriptionRow[]
  );
}

export function insertSubscription(p: {
  scout_wallet: string;
  tier: string;
  expires_at: number;
  created_at: number;
}): number {
  const sql = `INSERT INTO subscriptions (scout_wallet, tier, expires_at, created_at) VALUES (?, ?, ?, ?)`;
  return withDbSpan('insertSubscription', sql, () =>
    timedQuery(sql, () => {
      const info = getDb().prepare(sql).run(p.scout_wallet, p.tier, p.expires_at, p.created_at);
      return info.lastInsertRowid as number;
    })
  );
}

export function dbRenewSubscription(p: { id: number; tier: string; expires_at: number }): void {
  const sql = `UPDATE subscriptions SET tier = ?, expires_at = ? WHERE id = ?`;
  timedQuery(sql, () => getDb().prepare(sql).run(p.tier, p.expires_at, p.id));
}

export function dbCancelSubscription(p: { id: number; cancelled_at: number }): void {
  const sql = `UPDATE subscriptions SET cancelled_at = ? WHERE id = ?`;
  timedQuery(sql, () => getDb().prepare(sql).run(p.cancelled_at, p.id));
}

// ─── Contact unlock helpers ───────────────────────────────────────────────────

export interface ContactUnlockRow {
  scout_wallet: string;
  player_id: string;
  tx_hash: string;
  unlocked_at: number;
}

export function insertContactUnlock(p: {
  scout_wallet: string;
  player_id: string;
  tx_hash: string;
  unlocked_at: number;
}): void {
  const sql = `INSERT INTO contact_unlocks (scout_wallet, player_id, tx_hash, unlocked_at) VALUES (?, ?, ?, ?) ON CONFLICT(scout_wallet, player_id) DO NOTHING`;
  withDbSpan('insertContactUnlock', sql, () =>
    timedQuery(sql, () => getDb().prepare(sql).run(p.scout_wallet, p.player_id, p.tx_hash, p.unlocked_at))
  );
}

export function getContactUnlocksByScout(scoutWallet: string): ContactUnlockRow[] {
  const sql = `SELECT * FROM contact_unlocks WHERE scout_wallet = ? ORDER BY unlocked_at DESC`;
  return timedQuery(sql, () => getDb().prepare(sql).all(scoutWallet) as ContactUnlockRow[]);
}

/**
 * Return all contact-unlock rows for a given player (i.e. every scout who has
 * unlocked that player's contact details). Used to fan out SSE notifications
 * when a player is deactivated.
 */
export function getContactUnlocksByPlayer(playerId: string): ContactUnlockRow[] {
  const sql = `SELECT * FROM contact_unlocks WHERE player_id = ? ORDER BY unlocked_at DESC`;
  return timedQuery(sql, () => getDb().prepare(sql).all(playerId) as ContactUnlockRow[]);
}

export function hasContactUnlock(scoutWallet: string, playerId: string): boolean {
  const sql = `SELECT 1 FROM contact_unlocks WHERE scout_wallet = ? AND player_id = ? LIMIT 1`;
  return timedQuery(sql, () => getDb().prepare(sql).get(scoutWallet, playerId) !== undefined);
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
 * Get daily counts of new players registered within a time window.
 * Uses SQLite's strftime to group by date at the SQL level.
 */
export function getNewPlayersTimeSeries(startDateMs: number, endDateMs: number): TimeSeriesPoint[] {
  const sql = `
    SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') as date, COUNT(*) as count
    FROM players
    WHERE created_at >= ? AND created_at <= ?
    GROUP BY date
    ORDER BY date ASC
  `;
  const rows = timedQuery(sql, () =>
    getDb().prepare(sql).all(startDateMs, endDateMs) as Array<{ date: string; count: number }>
  );
  return rows.map((r) => ({ date: r.date, count: r.count }));
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
export function getContactUnlocksTimeSeries(startDateMs: number, endDateMs: number): TimeSeriesPoint[] {
  const sql = `
    SELECT strftime('%Y-%m-%d', unlocked_at / 1000, 'unixepoch') as date, COUNT(*) as count
    FROM contact_unlocks
    WHERE unlocked_at >= ? AND unlocked_at <= ?
    GROUP BY date
    ORDER BY date ASC
  `;
  const rows = timedQuery(sql, () =>
    getDb().prepare(sql).all(startDateMs, endDateMs) as Array<{ date: string; count: number }>
  );
  return rows.map((r) => ({ date: r.date, count: r.count }));
}

/**
 * Get daily counts of subscriptions started within a time window.
 */
export function getSubscriptionsStartedTimeSeries(startDateMs: number, endDateMs: number): TimeSeriesPoint[] {
  const sql = `
    SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') as date, COUNT(*) as count
    FROM subscriptions
    WHERE created_at >= ? AND created_at <= ?
    GROUP BY date
    ORDER BY date ASC
  `;
  const rows = timedQuery(sql, () =>
    getDb().prepare(sql).all(startDateMs, endDateMs) as Array<{ date: string; count: number }>
  );
  return rows.map((r) => ({ date: r.date, count: r.count }));
}

/**
 * Get daily counts of new players grouped by region within a time window.
 */
export function getNewPlayersByRegionTimeSeries(startDateMs: number, endDateMs: number): RegionBreakdownPoint[] {
  const sql = `
    SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') as date, region, COUNT(*) as count
    FROM players
    WHERE created_at >= ? AND created_at <= ?
    GROUP BY date, region
    ORDER BY date ASC, region ASC
  `;
  const rows = timedQuery(sql, () =>
    getDb().prepare(sql).all(startDateMs, endDateMs) as Array<{ date: string; region: string | null; count: number }>
  );
  return rows.map((r) => ({ date: r.date, region: r.region ?? 'unknown', count: r.count }));
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
 * hash chain. better-sqlite3 is fully synchronous and this runs inside a
 * single db.transaction(), so the "read the last hash, then insert" sequence
 * below can't race with a concurrent insert.
 */
export function insertAuditLog(p: {
  action: string;
  adminWallet?: string;
  queryParams?: Record<string, unknown>;
  createdAt: string;
  /** Defaults to 'admin_action' (the pre-existing caller, logAuditEvent). */
  eventSource?: string;
}): AuditLogRow {
  const sql = 'INSERT INTO audit_log (hash-chained)';
  return timedQuery(sql, () =>
    getDb().transaction(() => {
      const db = getDb();
      const adminWallet = p.adminWallet ?? '';
      const queryParams = JSON.stringify(p.queryParams ?? {});
      const eventSource = p.eventSource ?? 'admin_action';

      const prevRow = db
        .prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1')
        .get() as { hash: string } | undefined;
      const prevHash = prevRow?.hash ?? GENESIS_HASH;

      const hash = computeChainHash(
        auditChainContent({ action: p.action, adminWallet, queryParams, createdAt: p.createdAt, eventSource }),
        prevHash
      );

      const info = db
        .prepare(
          `INSERT INTO audit_log (action, admin_wallet, query_params, created_at, prev_hash, hash, event_source)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(p.action, adminWallet, queryParams, p.createdAt, prevHash, hash, eventSource);

      return {
        id: Number(info.lastInsertRowid),
        action: p.action,
        admin_wallet: adminWallet,
        query_params: queryParams,
        created_at: p.createdAt,
        prev_hash: prevHash,
        hash,
        event_source: eventSource,
      };
    })()
  );
}

export function getAuditLogs(filters: {
  action?: string;
  startDate?: string;
  endDate?: string;
  eventSource?: string;
  actorWallet?: string;
  limit?: number;
  offset?: number;
}): AuditLogRow[] {
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
  const sql = 'SELECT * FROM audit_log ' + where + ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  return timedQuery(sql, () => getDb().prepare(sql).all(...params, limit, offset) as AuditLogRow[]);
}

export function getAuditLogsCount(filters: {
  action?: string;
  startDate?: string;
  endDate?: string;
  eventSource?: string;
  actorWallet?: string;
}): number {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (filters.action) { conditions.push('action = ?'); params.push(filters.action); }
  if (filters.startDate) { conditions.push('created_at >= ?'); params.push(filters.startDate); }
  if (filters.endDate) { conditions.push('created_at <= ?'); params.push(filters.endDate); }
  if (filters.eventSource) { conditions.push('event_source = ?'); params.push(filters.eventSource); }
  if (filters.actorWallet) { conditions.push('admin_wallet = ?'); params.push(filters.actorWallet); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const sql = 'SELECT COUNT(*) AS count FROM audit_log ' + where;
  return timedQuery(sql, () => {
    const row = getDb().prepare(sql).get(...params) as { count: number };
    return row.count;
  });
}

/**
 * Returns ALL audit_log rows matching the given filters, unpaginated and
 * ordered by id ascending (i.e. insertion / hash-chain order). Used by
 * verifyAuditChain() (needs every row, in chain order, to walk the whole
 * chain) and queryAudit() (the old in-memory auditStore had no pagination,
 * so this preserves that "just give me everything" contract).
 */
export function getAllAuditLogRows(filters: {
  eventSource?: string;
  actorWallet?: string;
  action?: string;
} = {}): AuditLogRow[] {
  const conditions: string[] = [];
  const params: string[] = [];
  if (filters.action) { conditions.push('action = ?'); params.push(filters.action); }
  if (filters.eventSource) { conditions.push('event_source = ?'); params.push(filters.eventSource); }
  if (filters.actorWallet) { conditions.push('admin_wallet = ?'); params.push(filters.actorWallet); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const sql = 'SELECT * FROM audit_log ' + where + ' ORDER BY id ASC';
  return timedQuery(sql, () => getDb().prepare(sql).all(...params) as AuditLogRow[]);
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
}

export function getTrialOfferById(offerId: string): TrialOfferRow | null {
  const sql = 'SELECT * FROM trial_offers WHERE offer_id = ?';
  return timedQuery(sql, () =>
    (getDb().prepare(sql).get(offerId) as TrialOfferRow | undefined) ?? null
  );
}

export function insertTrialOffer(p: {
  offer_id: string;
  scout_wallet: string;
  player_id: string;
  details_uri: string;
  created_at: number;
}): void {
  const sql = `INSERT OR IGNORE INTO trial_offers (offer_id, scout_wallet, player_id, details_uri, created_at) VALUES (?, ?, ?, ?, ?)`;
  timedQuery(sql, () => getDb().prepare(sql).run(p.offer_id, p.scout_wallet, p.player_id, p.details_uri, p.created_at));
}

export function respondToTrialOffer(p: {
  offer_id: string;
  status: string;
  reject_reason?: string;
  responded_at: number;
}): void {
  const sql = `UPDATE trial_offers SET status = ?, reject_reason = ?, responded_at = ? WHERE offer_id = ?`;
  timedQuery(sql, () => getDb().prepare(sql).run(p.status, p.reject_reason ?? null, p.responded_at, p.offer_id));
}

/**
 * Count the number of trial offers submitted for a given player.
 * Returns 0 when the trial_offers table does not exist yet (pre-migration).
 */
export function countTrialOffersByPlayer(playerId: string): number {
  try {
    const sql = 'SELECT COUNT(*) AS cnt FROM trial_offers WHERE player_id = ?';
    const row = timedQuery(sql, () =>
      getDb().prepare(sql).get(playerId) as { cnt: number } | undefined,
    );
    return row?.cnt ?? 0;
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
}

export function insertPendingPin(p: {
  payload: string;
  created_at: string;
  last_tried: string;
  hash?: string | null;
}): boolean {
  if (p.hash) {
    const sql = `INSERT OR IGNORE INTO pending_pins (payload, hash, created_at, last_tried) VALUES (?, ?, ?, ?)`;
    return timedQuery(sql, () => {
      const info = getDb().prepare(sql).run(p.payload, p.hash, p.created_at, p.last_tried);
      return info.changes > 0;
    });
  } else {
    const sql = `INSERT INTO pending_pins (payload, created_at, last_tried) VALUES (?, ?, ?)`;
    timedQuery(sql, () => getDb().prepare(sql).run(p.payload, p.created_at, p.last_tried));
    return true;
  }
}

export function getPendingPins(): PendingPinRow[] {
  const sql = 'SELECT * FROM pending_pins ORDER BY created_at ASC';
  return timedQuery(sql, () => getDb().prepare(sql).all() as PendingPinRow[]);
}

export function deletePendingPin(id: number): void {
  const sql = 'DELETE FROM pending_pins WHERE id = ?';
  timedQuery(sql, () => getDb().prepare(sql).run(id));
}

export function deletePendingPinByHash(hash: string): void {
  const sql = 'DELETE FROM pending_pins WHERE hash = ?';
  timedQuery(sql, () => getDb().prepare(sql).run(hash));
}

export function isPendingPinByHash(hash: string): boolean {
  const sql = 'SELECT 1 FROM pending_pins WHERE hash = ? LIMIT 1';
  return timedQuery(sql, () => getDb().prepare(sql).get(hash) !== undefined);
}

export function incrementPendingPinAttempts(id: number): void {
  const sql = 'UPDATE pending_pins SET attempts = attempts + 1, last_tried = ? WHERE id = ?';
  timedQuery(sql, () => getDb().prepare(sql).run(new Date().toISOString(), id));
}

/**
 * Persist the resolved CID on a pending_pins row identified by content hash.
 *
 * Called by the winning upload instance immediately after a successful Pinata
 * upload so that any other instance waiting on the same lock can retrieve the
 * CID from the DB instead of issuing a duplicate upload.
 */
export function setPendingPinResolvedCid(hash: string, cid: string): void {
  const sql = 'UPDATE pending_pins SET resolved_cid = ? WHERE hash = ?';
  timedQuery(sql, () => getDb().prepare(sql).run(cid, hash));
}

/**
 * Return the resolved CID for a previously completed pin identified by content
 * hash, or null if none has been recorded yet (i.e. the winning instance is
 * still uploading or the row no longer exists).
 */
export function getResolvedCidByHash(hash: string): string | null {
  const sql = 'SELECT resolved_cid FROM pending_pins WHERE hash = ? LIMIT 1';
  const row = timedQuery(sql, () => getDb().prepare(sql).get(hash) as { resolved_cid: string | null } | undefined);
  return row?.resolved_cid ?? null;
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
export function upsertScoutNote(p: {
  scout_wallet: string;
  player_id: string;
  note_text: string;
  updated_at: number;
}): void {
  const sql = `
    INSERT INTO scout_player_notes (scout_wallet, player_id, note_text, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(scout_wallet, player_id) DO UPDATE SET
      note_text  = excluded.note_text,
      updated_at = excluded.updated_at
  `;
  timedQuery(sql, () =>
    getDb().prepare(sql).run(p.scout_wallet, p.player_id, p.note_text, p.updated_at),
  );
}

/**
 * Retrieve a single private note by scout wallet + player id.
 * Returns null when no note exists.
 */
export function getScoutNote(
  scoutWallet: string,
  playerId: string,
): ScoutPlayerNoteRow | null {
  const sql =
    'SELECT * FROM scout_player_notes WHERE scout_wallet = ? AND player_id = ? LIMIT 1';
  return timedQuery(sql, () =>
    (getDb().prepare(sql).get(scoutWallet, playerId) as ScoutPlayerNoteRow | undefined) ?? null,
  );
}

/**
 * List all private notes authored by a scout, ordered newest-first.
 */
export function getScoutNotes(scoutWallet: string): ScoutPlayerNoteRow[] {
  const sql =
    'SELECT * FROM scout_player_notes WHERE scout_wallet = ? ORDER BY updated_at DESC';
  return timedQuery(sql, () =>
    getDb().prepare(sql).all(scoutWallet) as ScoutPlayerNoteRow[],
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
export function insertScoutPlayerNote(p: {
  scout_wallet: string;
  player_id: string;
  content: string;
  created_at: number;
  updated_at: number;
}): number {
  const sql = `
    INSERT INTO scout_player_notes_v2 (scout_wallet, player_id, content, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `;
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(p.scout_wallet, p.player_id, p.content, p.created_at, p.updated_at);
    return info.lastInsertRowid as number;
  });
}

/**
 * List all notes for a scout-player pair, ordered newest-first.
 */
export function getScoutPlayerNotes(
  scoutWallet: string,
  playerId: string,
): ScoutPlayerNoteV2Row[] {
  const sql = `
    SELECT * FROM scout_player_notes_v2
    WHERE scout_wallet = ? AND player_id = ?
    ORDER BY created_at DESC
  `;
  return timedQuery(sql, () =>
    getDb().prepare(sql).all(scoutWallet, playerId) as ScoutPlayerNoteV2Row[],
  );
}

/**
 * Update the content of a note identified by id and scout_wallet.
 * Scoping the update to scout_wallet prevents cross-scout tampering.
 * Returns true when a row was updated, false when not found.
 */
export function updateScoutPlayerNote(p: {
  id: number;
  scout_wallet: string;
  content: string;
  updated_at: number;
}): boolean {
  const sql = `
    UPDATE scout_player_notes_v2
    SET content = ?, updated_at = ?
    WHERE id = ? AND scout_wallet = ?
  `;
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(p.content, p.updated_at, p.id, p.scout_wallet);
    return info.changes > 0;
  });
}

/**
 * Delete a note by id, scoped to the owning scout wallet.
 * Returns true when a row was deleted, false when not found.
 */
export function deleteScoutPlayerNote(id: number, scoutWallet: string): boolean {
  const sql = `
    DELETE FROM scout_player_notes_v2
    WHERE id = ? AND scout_wallet = ?
  `;
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(id, scoutWallet);
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
}

/**
 * Persist a new API key.  Only the salted hash is stored; the caller must
 * have already generated the hash before calling this function.
 * Returns the new row id.
 */
export function insertApiKey(p: {
  key_hash: string;
  scout_wallet: string;
  label: string;
  created_at: number;
}): number {
  const sql = `
    INSERT INTO api_keys (key_hash, scout_wallet, label, created_at)
    VALUES (?, ?, ?, ?)
  `;
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(p.key_hash, p.scout_wallet, p.label, p.created_at);
    return info.lastInsertRowid as number;
  });
}

/**
 * List all non-revoked API keys for a scout wallet.
 */
export function listApiKeysByWallet(scoutWallet: string): ApiKeyRow[] {
  const sql = `
    SELECT * FROM api_keys
    WHERE scout_wallet = ?
    ORDER BY created_at DESC
  `;
  return timedQuery(sql, () =>
    getDb().prepare(sql).all(scoutWallet) as ApiKeyRow[],
  );
}

/**
 * Revoke an API key by its row id.
 * Only revokes keys belonging to the given scout wallet for security.
 * Returns true when a row was updated, false when not found.
 */
export function revokeApiKeyById(id: number, scoutWallet: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  const sql = `
    UPDATE api_keys SET revoked_at = ?
    WHERE id = ? AND scout_wallet = ? AND revoked_at IS NULL
  `;
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(now, id, scoutWallet);
    return info.changes > 0;
  });
}

/**
 * Look up an API key row by its full hash value (including salt prefix).
 * Returns null when not found or already revoked.
 */
export function getApiKeyByHash(keyHash: string): ApiKeyRow | null {
  const sql = `SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL LIMIT 1`;
  return timedQuery(sql, () =>
    (getDb().prepare(sql).get(keyHash) as ApiKeyRow | undefined) ?? null,
  );
}

/**
 * Return all active (non-revoked) API keys across all scouts.
 * Used by auth middleware to verify an incoming X-API-Key header.
 */
export function getAllActiveApiKeys(): ApiKeyRow[] {
  const sql = `SELECT * FROM api_keys WHERE revoked_at IS NULL`;
  return timedQuery(sql, () => getDb().prepare(sql).all() as ApiKeyRow[]);
}

/**
 * Update the last_used_at timestamp for an API key.
 */
export function touchApiKeyLastUsed(id: number): void {
  const now = Math.floor(Date.now() / 1000);
  const sql = `UPDATE api_keys SET last_used_at = ? WHERE id = ?`;
  timedQuery(sql, () => getDb().prepare(sql).run(now, id));
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
export function insertBookmark(p: {
  scout_wallet: string;
  player_id: string;
  folder_id?: number | null;
  note?: string | null;
  created_at: number;
}): boolean {
  const sql = `
    INSERT OR IGNORE INTO scout_bookmarks (scout_wallet, player_id, folder_id, note, created_at)
    VALUES (?, ?, ?, ?, ?)
  `;
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(
      p.scout_wallet,
      p.player_id,
      p.folder_id ?? null,
      p.note ?? null,
      p.created_at
    );
    return info.changes > 0;
  });
}

/**
 * Delete a bookmark.
 * Returns true when a row was deleted, false when it did not exist.
 */
export function deleteBookmark(scoutWallet: string, playerId: string): boolean {
  const sql = `DELETE FROM scout_bookmarks WHERE scout_wallet = ? AND player_id = ?`;
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(scoutWallet, playerId);
    return info.changes > 0;
  });
}

/**
 * List all bookmarks for a scout, ordered by creation time (newest first).
 * Optionally filter by folder_id.
 */
export function getBookmarksByScout(scoutWallet: string, folderId?: number | null): ScoutBookmarkRow[] {
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
  
  return timedQuery(sql, () =>
    getDb().prepare(sql).all(...params) as ScoutBookmarkRow[],
  );
}

/**
 * Insert a bookmark folder. Returns the new folder id.
 */
export function insertBookmarkFolder(p: {
  scout_wallet: string;
  name: string;
  created_at: number;
}): number {
  const sql = `
    INSERT INTO scout_bookmark_folders (scout_wallet, name, created_at)
    VALUES (?, ?, ?)
  `;
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(p.scout_wallet, p.name, p.created_at);
    return info.lastInsertRowid as number;
  });
}

/**
 * List all bookmark folders for a scout, ordered by creation time (newest first).
 */
export function getBookmarkFoldersByScout(scoutWallet: string): ScoutBookmarkFolderRow[] {
  const sql = `
    SELECT * FROM scout_bookmark_folders
    WHERE scout_wallet = ?
    ORDER BY created_at DESC
  `;
  return timedQuery(sql, () =>
    getDb().prepare(sql).all(scoutWallet) as ScoutBookmarkFolderRow[],
  );
}

/**
 * Get a bookmark folder by id, ensuring it belongs to the scout.
 */
export function getBookmarkFolderById(folderId: number, scoutWallet: string): ScoutBookmarkFolderRow | null {
  const sql = `
    SELECT * FROM scout_bookmark_folders
    WHERE id = ? AND scout_wallet = ?
  `;
  return timedQuery(sql, () =>
    (getDb().prepare(sql).get(folderId, scoutWallet) as ScoutBookmarkFolderRow | undefined) ?? null
  );
}

/**
 * Delete a bookmark folder by id, ensuring it belongs to the scout.
 * Returns true when a row was deleted, false when it did not exist.
 */
export function deleteBookmarkFolder(folderId: number, scoutWallet: string): boolean {
  const sql = `DELETE FROM scout_bookmark_folders WHERE id = ? AND scout_wallet = ?`;
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(folderId, scoutWallet);
    return info.changes > 0;
  });
}

/**
 * Move bookmarks from a folder to root (set folder_id to NULL) when folder is deleted.
 */
export function moveBookmarksToRoot(folderId: number, scoutWallet: string): void {
  const sql = `UPDATE scout_bookmarks SET folder_id = NULL WHERE folder_id = ? AND scout_wallet = ?`;
  timedQuery(sql, () => getDb().prepare(sql).run(folderId, scoutWallet));
}

/**
 * Count bookmarks in a folder.
 */
export function countBookmarksInFolder(folderId: number): number {
  const sql = `SELECT COUNT(*) as count FROM scout_bookmarks WHERE folder_id = ?`;
  return timedQuery(sql, () => {
    const row = getDb().prepare(sql).get(folderId) as { count: number } | undefined;
    return row?.count ?? 0;
  });
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

export function getAllActiveSavedSearches(): SavedSearchRow[] {
  const sql = 'SELECT * FROM scout_saved_searches WHERE notify_enabled = 1';
  return timedQuery(sql, () => getDb().prepare(sql).all() as SavedSearchRow[]);
}

export function getSavedSearchNotification(scoutWallet: string, playerId: string): number | null {
  const sql = 'SELECT notified_at FROM saved_search_notifications WHERE scout_wallet = ? AND player_id = ?';
  return timedQuery(sql, () => {
    const row = getDb().prepare(sql).get(scoutWallet, playerId) as { notified_at: number } | undefined;
    return row ? row.notified_at : null;
  });
}

export function recordSavedSearchNotification(scoutWallet: string, playerId: string, notifiedAt: number): void {
  const sql = 'INSERT INTO saved_search_notifications (scout_wallet, player_id, notified_at) ' +
              'VALUES (?, ?, ?) ' +
              'ON CONFLICT(scout_wallet, player_id) DO UPDATE SET notified_at = excluded.notified_at';
  timedQuery(sql, () => getDb().prepare(sql).run(scoutWallet, playerId, notifiedAt));
}

/**
 * Insert a new saved search for a scout.
 * Returns the new row id.
 */
export function insertSavedSearch(p: {
  scout_wallet: string;
  name: string;
  filters: string; // pre-serialised JSON
  created_at: number;
  notify_enabled?: number;
}): number {
  const sql = 'INSERT INTO scout_saved_searches (scout_wallet, name, filters, created_at, notify_enabled) VALUES (?, ?, ?, ?, ?)';
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(p.scout_wallet, p.name, p.filters, p.created_at, p.notify_enabled ?? 1);
    return info.lastInsertRowid as number;
  });
}

/**
 * List all saved searches for a scout, ordered newest-first.
 */
export function getSavedSearchesByScout(scoutWallet: string): SavedSearchRow[] {
  const sql = `
    SELECT * FROM scout_saved_searches
    WHERE scout_wallet = ?
    ORDER BY created_at DESC
  `;
  return timedQuery(sql, () =>
    getDb().prepare(sql).all(scoutWallet) as SavedSearchRow[],
  );
}

/**
 * Delete a saved search by id.
 * Only deletes rows belonging to the given scout wallet for security.
 * Returns true when a row was deleted, false when it did not exist.
 */
export function deleteSavedSearch(id: number, scoutWallet: string): boolean {
  const sql = `DELETE FROM scout_saved_searches WHERE id = ? AND scout_wallet = ?`;
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(id, scoutWallet);
    return info.changes > 0;
  });
}

/**
 * Get a saved search by id.
 * Only returns rows belonging to the given scout wallet for security.
 * Returns null when not found.
 */
export function getSavedSearchById(id: number, scoutWallet: string): SavedSearchRow | null {
  const sql = `SELECT * FROM scout_saved_searches WHERE id = ? AND scout_wallet = ?`;
  return timedQuery(sql, () =>
    (getDb().prepare(sql).get(id, scoutWallet) as SavedSearchRow | undefined) ?? null
  );
}

/**
 * Update a saved search's name and/or filters.
 * Only updates rows belonging to the given scout wallet for security.
 * Returns true when a row was updated, false when it did not exist.
 */
export function updateSavedSearch(
  id: number,
  scoutWallet: string,
  updates: { name?: string; filters?: string }
): boolean {
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
  const sql = `UPDATE scout_saved_searches SET ${fields.join(', ')} WHERE id = ? AND scout_wallet = ?`;
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(...params);
    return info.changes > 0;
  });
}

/**
 * Count saved searches for a scout.
 * Used to enforce the 20 saved searches limit.
 */
export function countSavedSearchesByScout(scoutWallet: string): number {
  const sql = `SELECT COUNT(*) as count FROM scout_saved_searches WHERE scout_wallet = ?`;
  const row = timedQuery(sql, () =>
    getDb().prepare(sql).get(scoutWallet) as { count: number }
  );
  return row.count;
}

// ─── Profile views helpers ────────────────────────────────────────────────────

/**
 * Record a profile view from a scout.
 * Inserts a new row into the profile_views table with scout wallet, player ID,
 * and timestamps. Used to track scout engagement with player profiles.
 */
export function recordProfileView(p: {
  scout_wallet: string;
  player_id: string;
  viewed_at: number;
  created_at: number;
}): void {
  const sql = `INSERT INTO profile_views (scout_wallet, player_id, viewed_at, created_at) VALUES (?, ?, ?, ?)`;
  timedQuery(sql, () => getDb().prepare(sql).run(p.scout_wallet, p.player_id, p.viewed_at, p.created_at));
}

/**
 * Get the timestamp of the most recent profile view from a scout for a specific player.
 * Returns the Unix timestamp of the most recent view, or null if no view exists.
 * Used by deduplication logic to check the 5-minute dedup window.
 */
export function getLastProfileView(scoutWallet: string, playerId: string): number | null {
  const sql = `SELECT viewed_at FROM profile_views WHERE player_id = ? AND scout_wallet = ? ORDER BY viewed_at DESC LIMIT 1`;
  const row = timedQuery(sql, () =>
    getDb().prepare(sql).get(playerId, scoutWallet) as { viewed_at: number } | undefined
  );
  return row?.viewed_at ?? null;
}

/**
 * Get the total count of profile views for a player.
 * Returns the count of all profile_views records for the given player_id.
 * Used in analytics aggregation.
 */
export function getProfileViewCount(playerId: string): number {
  const sql = `SELECT COUNT(*) as count FROM profile_views WHERE player_id = ?`;
  const row = timedQuery(sql, () =>
    getDb().prepare(sql).get(playerId) as { count: number }
  );
  return row.count;
}

/**
 * Get the count of unique scout wallets that have viewed a player's profile.
 * Counts distinct scout_wallet values (excluding NULL) from profile_views for the given player.
 * Used in analytics aggregation to determine viewer_count.
 */
export function getUniqueViewerCount(playerId: string): number {
  const sql = `SELECT COUNT(DISTINCT scout_wallet) as count FROM profile_views WHERE player_id = ? AND scout_wallet IS NOT NULL`;
  const row = timedQuery(sql, () =>
    getDb().prepare(sql).get(playerId) as { count: number }
  );
  return row.count;
}

/**
 * Get the count of unique scout wallets that have unlocked contact information for a player.
 * Counts distinct scout_wallet values from the contact_unlocks table for the given player.
 * Used in analytics aggregation to determine contact_unlock_count.
 */
export function getContactUnlockCount(playerId: string): number {
  const sql = `SELECT COUNT(DISTINCT scout_wallet) as count FROM contact_unlocks WHERE player_id = ?`;
  const row = timedQuery(sql, () =>
    getDb().prepare(sql).get(playerId) as { count: number }
  );
  return row.count;
}

// ─── Feature flags (#494) ─────────────────────────────────────────────────────

export interface FeatureFlagRow {
  name: string;
  enabled: number;
  updated_at: number;
  updated_by: string;
}

export function getAllFeatureFlags(): FeatureFlagRow[] {
  const sql = `SELECT * FROM feature_flags ORDER BY name`;
  return timedQuery(sql, () => getDb().prepare(sql).all() as FeatureFlagRow[]);
}

export function getFeatureFlag(name: string): FeatureFlagRow | null {
  const sql = `SELECT * FROM feature_flags WHERE name = ?`;
  return timedQuery(sql, () =>
    (getDb().prepare(sql).get(name) as FeatureFlagRow | undefined) ?? null,
  );
}

export function upsertFeatureFlag(p: {
  name: string;
  enabled: number;
  updated_at: number;
  updated_by: string;
}): void {
  const sql = `
    INSERT INTO feature_flags (name, enabled, updated_at, updated_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      enabled = excluded.enabled,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `;
  timedQuery(sql, () => {
    getDb().prepare(sql).run(p.name, p.enabled, p.updated_at, p.updated_by);
  });
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

export function insertPendingAdminAction(p: {
  id: string;
  action_type: string;
  proposer: string;
  payload: string;
  required_signatures: number;
  expires_at: number;
  created_at: number;
}): void {
  const sql = `INSERT INTO pending_admin_actions (id, action_type, proposer, payload, required_signatures, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`;
  timedQuery(sql, () => getDb().prepare(sql).run(p.id, p.action_type, p.proposer, p.payload, p.required_signatures, p.expires_at, p.created_at));
}

export function getPendingAdminActionById(id: string): PendingAdminActionRow | null {
  const sql = `SELECT * FROM pending_admin_actions WHERE id = ?`;
  return timedQuery(sql, () =>
    (getDb().prepare(sql).get(id) as PendingAdminActionRow | undefined) ?? null
  );
}

export function getPendingAdminActionsByStatus(status: string): PendingAdminActionRow[] {
  const sql = `SELECT * FROM pending_admin_actions WHERE status = ? ORDER BY created_at DESC`;
  return timedQuery(sql, () => getDb().prepare(sql).all(status) as PendingAdminActionRow[]);
}

export function updatePendingAdminActionStatus(id: string, status: string): void {
  const sql = `UPDATE pending_admin_actions SET status = ? WHERE id = ?`;
  timedQuery(sql, () => getDb().prepare(sql).run(status, id));
}

export function incrementActionSignatures(id: string): void {
  const sql = `UPDATE pending_admin_actions SET collected_signatures = collected_signatures + 1 WHERE id = ?`;
  timedQuery(sql, () => getDb().prepare(sql).run(id));
}

export function expireStalePendingAdminActions(): number {
  const sql = `UPDATE pending_admin_actions SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?`;
  const info = timedQuery(sql, () => getDb().prepare(sql).run(Date.now()));
  return info.changes;
}

export function insertAdminActionSignature(p: {
  action_id: string;
  signer: string;
  signed_at: number;
}): boolean {
  const sql = `INSERT OR IGNORE INTO admin_action_signatures (action_id, signer, signed_at) VALUES (?, ?, ?)`;
  const info = timedQuery(sql, () => getDb().prepare(sql).run(p.action_id, p.signer, p.signed_at));
  return info.changes > 0;
}

export function getAdminActionSignature(action_id: string, signer: string): { signed_at: number } | null {
  const sql = `SELECT signed_at FROM admin_action_signatures WHERE action_id = ? AND signer = ?`;
  return timedQuery(sql, () =>
    (getDb().prepare(sql).get(action_id, signer) as { signed_at: number } | undefined) ?? null
  );
}

export function getAdminActionSignatures(action_id: string): { signer: string; signed_at: number }[] {
  const sql = `SELECT signer, signed_at FROM admin_action_signatures WHERE action_id = ? ORDER BY signed_at ASC`;
  return timedQuery(sql, () => getDb().prepare(sql).all(action_id) as { signer: string; signed_at: number }[]);
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

export type WebhookDeadLetterStatus = 'pending' | 'replayed';

export interface WebhookDeadLetter {
  id: number;
  subscription_id: number | null;
  url: string;
  event_type: string;
  payload: string;
  failure_reason: string;
  attempts: number;
  status: WebhookDeadLetterStatus;
  created_at: string;
  replayed_at: string | null;
}

export interface InsertDeadLetterInput {
  subscriptionId: number | null;
  url: string;
  eventType: string;
  payload: string;
  failureReason: string;
  attempts: number;
}

export function insertWebhookDeadLetter(input: InsertDeadLetterInput): WebhookDeadLetter {
  const sql = `INSERT INTO webhook_dead_letters
    (subscription_id, url, event_type, payload, failure_reason, attempts, status)
   VALUES (?, ?, ?, ?, ?, ?, 'pending')`;
  return timedQuery(sql, () => {
    const info = getDb()
      .prepare(sql)
      .run(
        input.subscriptionId,
        input.url,
        input.eventType,
        input.payload,
        input.failureReason,
        input.attempts
      );
    return {
      id: Number(info.lastInsertRowid),
      subscription_id: input.subscriptionId,
      url: input.url,
      event_type: input.eventType,
      payload: input.payload,
      failure_reason: input.failureReason,
      attempts: input.attempts,
      status: 'pending',
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

export function getWebhookDeadLetterById(id: number): WebhookDeadLetter | undefined {
  const sql = 'SELECT * FROM webhook_dead_letters WHERE id = ?';
  return timedQuery(sql, () =>
    getDb().prepare(sql).get(id) as WebhookDeadLetter | undefined
  );
}

export function markWebhookDeadLetterReplayed(id: number): void {
  const sql = "UPDATE webhook_dead_letters SET status = 'replayed', replayed_at = ? WHERE id = ?";
  timedQuery(sql, () => getDb().prepare(sql).run(new Date().toISOString(), id));
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
export function insertFeeWithdrawal(p: {
  idempotencyKey: string | null;
  treasuryAddress: string;
  amountStroops: string;
  txHash: string;
  adminWallet: string;
  createdAt: string;
}): number {
  const sql = `
    INSERT INTO fee_withdrawals
      (idempotency_key, treasury_address, amount_stroops, tx_hash, admin_wallet, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `;
  return timedQuery(sql, () => {
    const info = getDb()
      .prepare(sql)
      .run(
        p.idempotencyKey ?? null,
        p.treasuryAddress,
        p.amountStroops,
        p.txHash,
        p.adminWallet,
        p.createdAt,
      );
    return info.lastInsertRowid as number;
  });
}

/**
 * Look up a fee withdrawal by idempotency key.
 * Returns null when no record exists for the given key, so callers can
 * distinguish "never submitted" from "already submitted".
 */
export function getFeeWithdrawalByIdempotencyKey(key: string): FeeWithdrawalRow | null {
  const sql = `SELECT * FROM fee_withdrawals WHERE idempotency_key = ? LIMIT 1`;
  return timedQuery(sql, () =>
    (getDb().prepare(sql).get(key) as FeeWithdrawalRow | undefined) ?? null,
  );
}

/**
 * Return the most recent fee_withdrawals rows, newest-first.
 * Used by GET /api/admin/fees to show withdrawal history.
 */
export function listFeeWithdrawals(limit = 50, offset = 0): FeeWithdrawalRow[] {
  const sql = `
    SELECT * FROM fee_withdrawals
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `;
  return timedQuery(sql, () =>
    getDb().prepare(sql).all(limit, offset) as FeeWithdrawalRow[],
  );
}
