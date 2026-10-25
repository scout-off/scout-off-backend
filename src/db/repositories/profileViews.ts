/**
 * Repository: profile view tracking.
 *
 * Moved verbatim out of the 3,500-line `src/db/index.ts` barrel (#1535);
 * behaviour is unchanged. `src/db/index.ts` re-exports every symbol below.
 *
 * Driver status: fully on `getDriver()` (async) — works on both SQLite and PostgreSQL.
 */
import { getDriver, timedQueryAsync } from '../query';

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
  const sql = `SELECT (SELECT COUNT(*) FROM profile_views WHERE player_id = ?)
    + COALESCE((SELECT SUM(view_count) FROM profile_view_daily WHERE player_id = ?), 0) as count`;
  const row = await timedQueryAsync(sql, () =>
    getDriver().transaction(tx => tx.get<{ count: number | string }>(sql, [playerId, playerId]))
  );
  return Number(row?.count ?? 0);
}

/**
 * Get the count of unique scout wallets that have viewed a player's profile.
 * Counts distinct scout_wallet values (excluding NULL) from profile_views for the given player.
 * Used in analytics aggregation to determine viewer_count.
 */
export async function getUniqueViewerCount(playerId: string): Promise<number> {
  const sql = `SELECT COUNT(*) as count FROM (
    SELECT scout_wallet FROM profile_views WHERE player_id = ? AND scout_wallet IS NOT NULL
    UNION SELECT scout_wallet FROM profile_view_daily WHERE player_id = ?
  ) AS viewers`;
  const row = await timedQueryAsync(sql, () =>
    getDriver().transaction(tx => tx.get<{ count: number | string }>(sql, [playerId, playerId]))
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
