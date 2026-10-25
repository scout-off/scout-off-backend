/**
 * Repository: wallet blocklist.
 *
 * Moved verbatim out of the 3,500-line `src/db/index.ts` barrel (#1535);
 * behaviour is unchanged. `src/db/index.ts` re-exports every symbol below.
 *
 * Driver status: fully on `getDriver()` (async) — works on both SQLite and PostgreSQL.
 */
import { getDriver, timedQueryAsync } from '../query';

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
