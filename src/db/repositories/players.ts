/**
 * Repository: players, profile history, pending milestones, token registry and search.
 *
 * Moved verbatim out of the 3,500-line `src/db/index.ts` barrel (#1535);
 * behaviour is unchanged. `src/db/index.ts` re-exports every symbol below.
 *
 * Driver status: fully on `getDriver()` (async) — works on both SQLite and PostgreSQL.
 */
import { getDriver, timedQueryAsync } from '../query';

// ─── Player table helpers ─────────────────────────────────────────────────────

export interface PlayerRow {
  player_id: string;
  on_chain_player_id: string | null;
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
  on_chain_player_id?: string | null;
  wallet: string;
  position?: string;
  region?: string;
  metadata_uri?: string;
  created_at?: number;
  registered_at?: number;
}): Promise<void> {
  const sql = `INSERT INTO players (player_id, on_chain_player_id, wallet, position, region, metadata_uri, created_at, registered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET
         on_chain_player_id = COALESCE(excluded.on_chain_player_id, players.on_chain_player_id),
         wallet       = excluded.wallet,
         position     = excluded.position,
         region       = excluded.region,
         metadata_uri = excluded.metadata_uri`;
  await timedQueryAsync(sql, () =>
    getDriver().run(sql, [p.player_id, p.on_chain_player_id ?? null, p.wallet, p.position ?? null, p.region ?? null, p.metadata_uri ?? null, p.created_at ?? null, p.registered_at ?? 0])
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
  /** Inclusive lower bound on pm.submitted_at (Unix seconds). */
  submittedAfter?: number;
  /** Inclusive upper bound on pm.submitted_at (Unix seconds). */
  submittedBefore?: number;
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
  if (options.submittedAfter !== undefined) {
    whereConditions.push('pm.submitted_at >= ?');
    params.push(options.submittedAfter);
  }
  if (options.submittedBefore !== undefined) {
    whereConditions.push('pm.submitted_at <= ?');
    params.push(options.submittedBefore);
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

export async function getPlayerByOnChainId(onChainPlayerId: string): Promise<PlayerRow | null> {
  const sql = 'SELECT * FROM players WHERE on_chain_player_id = ?';
  return timedQueryAsync(sql, async () =>
    (await getDriver().get<PlayerRow>(sql, [onChainPlayerId])) ?? null
  );
}

export async function getPlayersMissingOnChainId(
  afterPlayerId: string,
  limit: number,
): Promise<PlayerRow[]> {
  const sql = `SELECT * FROM players
               WHERE on_chain_player_id IS NULL AND player_id > ?
               ORDER BY player_id LIMIT ?`;
  return timedQueryAsync(sql, () => getDriver().all<PlayerRow>(sql, [afterPlayerId, limit]));
}

export async function setPlayerOnChainId(
  playerId: string,
  onChainPlayerId: string,
): Promise<void> {
  const sql = `UPDATE players SET on_chain_player_id = ?
               WHERE player_id = ? AND (on_chain_player_id IS NULL OR on_chain_player_id = ?)`;
  await timedQueryAsync(sql, () =>
    getDriver().run(sql, [onChainPlayerId, playerId, onChainPlayerId]),
  );
  const player = await getPlayerById(playerId);
  if (!player || player.on_chain_player_id !== onChainPlayerId) {
    throw new Error(`Player ${playerId} already has a different on-chain ID mapping`);
  }
}

// ─── Player token registry ───────────────────────────────────────────────────

export interface PlayerTokenHolderRow {
  holder_wallet: string;
  token_balance: number | string;
}

export interface PlayerTokenInventory {
  totalSupply: number;
  soldTokens: number;
  holders: Array<{ holder: string; tokens: number }>;
}

export type PlayerTokenPurchaseResult =
  | { status: 'not_found' }
  | { status: 'exhausted'; remaining: number }
  | { status: 'purchased'; newBalance: number };

export async function seedPlayerTokenSupply(
  playerId: string,
  totalSupply: number,
): Promise<void> {
  const sql = `INSERT INTO player_token_supply (player_id, total_supply)
               VALUES (?, ?)
               ON CONFLICT(player_id) DO UPDATE SET total_supply = excluded.total_supply`;
  await timedQueryAsync(sql, () => getDriver().run(sql, [playerId, totalSupply]));
}

export async function getPlayerTokenInventory(
  playerId: string,
): Promise<PlayerTokenInventory | null> {
  const supplySql = 'SELECT total_supply FROM player_token_supply WHERE player_id = ?';
  const supply = await timedQueryAsync(supplySql, () =>
    getDriver().get<{ total_supply: number | string }>(supplySql, [playerId]),
  );
  if (!supply) return null;

  const holdersSql = `SELECT holder_wallet, token_balance
                      FROM player_token_balances
                      WHERE player_id = ?
                      ORDER BY holder_wallet`;
  const rows = await timedQueryAsync(holdersSql, () =>
    getDriver().all<PlayerTokenHolderRow>(holdersSql, [playerId]),
  );
  const holders = rows.map((row) => ({
    holder: row.holder_wallet,
    tokens: Number(row.token_balance),
  }));

  return {
    totalSupply: Number(supply.total_supply),
    soldTokens: holders.reduce((total, row) => total + row.tokens, 0),
    holders,
  };
}

export async function purchasePlayerTokens(
  playerId: string,
  buyerWallet: string,
  amount: number,
): Promise<PlayerTokenPurchaseResult> {
  return getDriver().transaction(async (tx) => {
    await tx.lockForWrite(`player-token:${playerId}`);

    const supply = await tx.get<{ total_supply: number | string }>(
      'SELECT total_supply FROM player_token_supply WHERE player_id = ?',
      [playerId],
    );
    if (!supply) return { status: 'not_found' };

    const sold = await tx.value<number | string>(
      'SELECT COALESCE(SUM(token_balance), 0) FROM player_token_balances WHERE player_id = ?',
      [playerId],
    );
    const remaining = Number(supply.total_supply) - Number(sold ?? 0);
    if (amount > remaining) return { status: 'exhausted', remaining };

    const balanceSql = `INSERT INTO player_token_balances (player_id, holder_wallet, token_balance)
                        VALUES (?, ?, ?)
                        ON CONFLICT(player_id, holder_wallet) DO UPDATE
                        SET token_balance = player_token_balances.token_balance + excluded.token_balance`;
    await tx.run(balanceSql, [playerId, buyerWallet, amount]);

    const balance = await tx.value<number | string>(
      'SELECT token_balance FROM player_token_balances WHERE player_id = ? AND holder_wallet = ?',
      [playerId, buyerWallet],
    );
    return { status: 'purchased', newBalance: Number(balance) };
  });
}

export async function resetPlayerTokenRegistry(): Promise<void> {
  await getDriver().transaction(async (tx) => {
    await tx.run('DELETE FROM player_token_balances');
    await tx.run('DELETE FROM player_token_supply');
  });
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
  _sortOrder: string,
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
