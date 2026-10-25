/**
 * Repository: paid contact unlocks and unlock counts.
 *
 * Moved verbatim out of the 3,500-line `src/db/index.ts` barrel (#1535);
 * behaviour is unchanged. `src/db/index.ts` re-exports every symbol below.
 *
 * Driver status: fully on `getDriver()` (async) — works on both SQLite and PostgreSQL.
 */
import { getDriver, timedQueryAsync } from '../query';

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
