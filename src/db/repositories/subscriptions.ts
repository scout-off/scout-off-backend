/**
 * Repository: scout subscriptions.
 *
 * Moved verbatim out of the 3,500-line `src/db/index.ts` barrel (#1535);
 * behaviour is unchanged. `src/db/index.ts` re-exports every symbol below.
 *
 * Driver status: fully on `getDriver()` (async) — works on both SQLite and PostgreSQL.
 */
import { getDriver, timedQueryAsync } from '../query';

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
