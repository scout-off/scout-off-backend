import Database from 'better-sqlite3';
import config from '../config';
import { EventRecord, ContractEventType } from '../types';
import { runMigrations } from './migrate';
import { logger } from '../utils/logger';

function slowQueryThresholdMs(): number {
  return parseInt(process.env.SLOW_QUERY_THRESHOLD_MS ?? '50', 10);
}

/** Runs fn(), logs a warn if it takes longer than SLOW_QUERY_THRESHOLD_MS. */
export function timedQuery<T>(sql: string, fn: () => T): T {
  const start = Date.now();
  const result = fn();
  const duration = Date.now() - start;
  if (duration >= slowQueryThresholdMs()) {
    logger.warn(`[db] slow query ${duration}ms: ${sql}`);
  }
  return result;
}

// ─── Connection & schema ──────────────────────────────────────────────────────

let _db: Database.Database | null = null;

/**
 * Initialise the database connection and run pending migrations.
 * Must be called once at application startup before any query helper is used.
 * Safe to call in tests with DB_PATH=:memory: set before import.
 */
export function initDb(): void {
  _db = new Database(config.dbPath);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      type       TEXT NOT NULL,
      ledger     INTEGER NOT NULL,
      tx_hash    TEXT NOT NULL UNIQUE,
      payload    TEXT NOT NULL,
      created_at INTEGER
    );
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
      created_at     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_players_region   ON players (region);
    CREATE INDEX IF NOT EXISTS idx_players_position ON players (position);
    CREATE INDEX IF NOT EXISTS idx_players_tier     ON players (progress_level);
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
  // Run SQL migrations (player_profile_history, idempotency_keys, etc.)
  runMigrations(_db);
}

export function getDb(): Database.Database {
  if (!_db) throw new Error("Database not initialised — call initDb() first");
  return _db;
}

// ─── State helpers ────────────────────────────────────────────────────────────

export function getLastLedger(): number {
  const sql = 'SELECT value FROM indexer_state WHERE key = ?';
  const row = timedQuery(sql, () =>
    getDb().prepare(sql).get('last_ledger') as { value: string } | undefined
  );
  return row ? parseInt(row.value, 10) : 0;
}

export function setLastLedger(ledger: number): void {
  const sql = 'INSERT INTO indexer_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';
  timedQuery(sql, () => getDb().prepare(sql).run('last_ledger', String(ledger)));
}

// ─── Query helpers ────────────────────────────────────────────────────────────

interface EventRow {
  type: string;
  payload: string;
  created_at: number | null;
}

export interface GetEventsOptions {
  limit?: number;
  offset?: number;
}

export function getEvents(
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

// ─── Player table helpers ─────────────────────────────────────────────────────

export interface PlayerRow {
  player_id: string;
  wallet: string;
  position: string | null;
  region: string | null;
  metadata_uri: string | null;
  progress_level: number;
  created_at: number | null;
}

export interface QueryPlayersOptions {
  region?: string;
  position?: string;
  minTier?: number;
  limit?: number;
  offset?: number;
}

export interface PlayerProfileHistoryRow {
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
      `SELECT metadata_uri, changed_at, tx_hash
       FROM player_profile_history
       WHERE player_id = ?
       ORDER BY changed_at DESC`,
    )
    .all(playerId) as PlayerProfileHistoryRow[];
}

export function upsertPlayer(p: {
  player_id: string;
  wallet: string;
  position?: string;
  region?: string;
  metadata_uri?: string;
  created_at?: number;
}): void {
  const sql = `INSERT INTO players (player_id, wallet, position, region, metadata_uri, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET
         wallet       = excluded.wallet,
         position     = excluded.position,
         region       = excluded.region,
         metadata_uri = excluded.metadata_uri`;
  timedQuery(sql, () =>
    getDb().prepare(sql).run(p.player_id, p.wallet, p.position ?? null, p.region ?? null, p.metadata_uri ?? null, p.created_at ?? null)
  );
}

export function updatePlayerProgress(playerId: string, level: number): void {
  const sql = 'UPDATE players SET progress_level = ? WHERE player_id = ?';
  timedQuery(sql, () => getDb().prepare(sql).run(level, playerId));
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

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  // Get total count
  const countSql = `SELECT COUNT(*) AS total FROM pending_milestones pm 
                    LEFT JOIN players p ON pm.player_id = p.player_id 
                    ${whereClause}`;
  const countRow = timedQuery(countSql, () => db.prepare(countSql).get(...params) as { total: number });
  const total = countRow.total;

  // Get paginated data
  const page = options.page || 1;
  const pageSize = options.pageSize || 20;
  const offset = (page - 1) * pageSize;
  const dataSql = `SELECT pm.* FROM pending_milestones pm 
                   LEFT JOIN players p ON pm.player_id = p.player_id 
                   ${whereClause}
                   ORDER BY pm.submitted_at DESC
                   LIMIT ? OFFSET ?`;
  const data = timedQuery(dataSql, () => db.prepare(dataSql).all(...params, pageSize, offset) as PendingMilestoneRow[]);

  return { data, total };
}

export function getPlayerById(playerId: string): PlayerRow | null {
  const sql = 'SELECT * FROM players WHERE player_id = ?';
  return timedQuery(sql, () =>
    (getDb().prepare(sql).get(playerId) as PlayerRow | undefined) ?? null
  );
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

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params };
}

export function queryPlayers(opts: QueryPlayersOptions): PlayerRow[] {
  const { where, params } = buildPlayerWhereClause(opts);
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  const sql = `SELECT * FROM players ${where} ORDER BY created_at ASC LIMIT ? OFFSET ?`;
  return timedQuery(sql, () =>
    getDb().prepare(sql).all(...params, limit, offset) as PlayerRow[]
  );
}

export function countPlayers(opts: Omit<QueryPlayersOptions, 'limit' | 'offset'>): number {
  const { where, params } = buildPlayerWhereClause(opts);
  const sql = `SELECT COUNT(*) as count FROM players ${where}`;
  return timedQuery(sql, () => {
    const row = getDb().prepare(sql).get(...params) as { count: number };
    return row.count;
  });
}

// ─── Idempotency key helpers ──────────────────────────────────────────────────

export interface IdempotencyRecord {
  key: string;
  status_code: number;
  response: string; // raw JSON string
  created_at: number;
  expires_at: number;
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Look up a non-expired idempotency key.
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
 * Persist a new idempotency key with its response payload.
 * Silently ignores conflicts — two concurrent requests with the same key
 * will both compute a response but only the first one to commit wins; the
 * second one will then be served the stored value by getIdempotencyRecord.
 */
export function saveIdempotencyRecord(
  key: string,
  statusCode: number,
  body: unknown,
): void {
  const now = Date.now();
  const sql = `
    INSERT INTO idempotency_keys (key, status_code, response, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
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
  return timedQuery(sql, () =>
    (getDb().prepare(sql).get(scoutWallet) as SubscriptionRow | undefined) ?? null
  );
}

export function insertSubscription(p: {
  scout_wallet: string;
  tier: string;
  expires_at: number;
  created_at: number;
}): number {
  const sql = `INSERT INTO subscriptions (scout_wallet, tier, expires_at, created_at) VALUES (?, ?, ?, ?)`;
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(p.scout_wallet, p.tier, p.expires_at, p.created_at);
    return info.lastInsertRowid as number;
  });
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
  timedQuery(sql, () => getDb().prepare(sql).run(p.scout_wallet, p.player_id, p.tx_hash, p.unlocked_at));
}

export function getContactUnlocksByScout(scoutWallet: string): ContactUnlockRow[] {
  const sql = `SELECT * FROM contact_unlocks WHERE scout_wallet = ? ORDER BY unlocked_at DESC`;
  return timedQuery(sql, () => getDb().prepare(sql).all(scoutWallet) as ContactUnlockRow[]);
}

export function hasContactUnlock(scoutWallet: string, playerId: string): boolean {
  const sql = `SELECT 1 FROM contact_unlocks WHERE scout_wallet = ? AND player_id = ? LIMIT 1`;
  return timedQuery(sql, () => getDb().prepare(sql).get(scoutWallet, playerId) !== undefined);
}

// ─── Audit log helpers ────────────────────────────────────────────────────────

export interface AuditLogRow {
  id: number;
  action: string;
  admin_wallet: string;
  query_params: string;
  created_at: string;
}

export function insertAuditLog(p: {
  action: string;
  adminWallet?: string;
  queryParams?: Record<string, unknown>;
  createdAt: string;
}): void {
  const sql = `INSERT INTO audit_log (action, admin_wallet, query_params, created_at) VALUES (?, ?, ?, ?)`;
  timedQuery(sql, () =>
    getDb().prepare(sql).run(p.action, p.adminWallet ?? '', JSON.stringify(p.queryParams ?? {}), p.createdAt)
  );
}

export function getAuditLogs(filters: {
  action?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}): AuditLogRow[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (filters.action) { conditions.push('action = ?'); params.push(filters.action); }
  if (filters.startDate) { conditions.push('created_at >= ?'); params.push(filters.startDate); }
  if (filters.endDate) { conditions.push('created_at <= ?'); params.push(filters.endDate); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;
  const sql = `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  return timedQuery(sql, () => getDb().prepare(sql).all(...params, limit, offset) as AuditLogRow[]);
}

export function getAuditLogsCount(filters: {
  action?: string;
  startDate?: string;
  endDate?: string;
}): number {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (filters.action) { conditions.push('action = ?'); params.push(filters.action); }
  if (filters.startDate) { conditions.push('created_at >= ?'); params.push(filters.startDate); }
  if (filters.endDate) { conditions.push('created_at <= ?'); params.push(filters.endDate); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT COUNT(*) AS count FROM audit_log ${where}`;
  return timedQuery(sql, () => {
    const row = getDb().prepare(sql).get(...params) as { count: number };
    return row.count;
  });
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

// ─── Pending pin helpers ──────────────────────────────────────────────────────

export interface PendingPinRow {
  id: number;
  payload: string;
  attempts: number;
  created_at: string;
  last_tried: string | null;
  hash?: string | null;
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
  created_at: number;
}

/**
 * Insert a bookmark.  Uses INSERT OR IGNORE so re-bookmarking is idempotent.
 * Returns true when a new row was inserted, false when it already existed.
 */
export function insertBookmark(p: {
  scout_wallet: string;
  player_id: string;
  created_at: number;
}): boolean {
  const sql = `
    INSERT OR IGNORE INTO scout_bookmarks (scout_wallet, player_id, created_at)
    VALUES (?, ?, ?)
  `;
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(p.scout_wallet, p.player_id, p.created_at);
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
 */
export function getBookmarksByScout(scoutWallet: string): ScoutBookmarkRow[] {
  const sql = `
    SELECT * FROM scout_bookmarks
    WHERE scout_wallet = ?
    ORDER BY created_at DESC
  `;
  return timedQuery(sql, () =>
    getDb().prepare(sql).all(scoutWallet) as ScoutBookmarkRow[],
  );
}

// ─── Scout saved-search helpers (#486) ───────────────────────────────────────

export interface SavedSearchRow {
  id: number;
  scout_wallet: string;
  name: string;
  filters: string; // JSON string
  created_at: number;
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
}): number {
  const sql = `
    INSERT INTO scout_saved_searches (scout_wallet, name, filters, created_at)
    VALUES (?, ?, ?, ?)
  `;
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(p.scout_wallet, p.name, p.filters, p.created_at);
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
