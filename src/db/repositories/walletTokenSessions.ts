/**
 * Repository: wallet token sessions.
 *
 * Tracks issued refresh-token sessions per wallet (jti, issuedAt, expiresAt,
 * userAgent/IP hash) so an admin can enumerate every active session for a
 * wallet and revoke them all at once. Rotation on /auth/refresh marks the old
 * jti as superseded; revoke-all marks every active jti as revoked and sets a
 * per-wallet `tokens_valid_after` cutoff.
 *
 * Driver status: fully on `getDriver()` (async) — works on both SQLite and
 * PostgreSQL. `?` placeholders are translated per-driver by the driver layer.
 */
import { getDriver, timedQueryAsync } from '../query';

export interface TokenSessionRow {
  jti: string;
  wallet: string;
  issued_at: number;
  expires_at: number;
  user_agent: string | null;
  ip_hash: string | null;
  superseded_at: number | null;
  revoked_at: number | null;
}

/** Record a newly issued refresh-token session at issue time. */
export async function recordTokenSession(p: {
  jti: string;
  wallet: string;
  issuedAt: number;
  expiresAt: number;
  userAgent?: string | null;
  ipHash?: string | null;
}): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const sql = `
    INSERT INTO wallet_token_sessions
      (jti, wallet, issued_at, expires_at, user_agent, ip_hash)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(jti) DO NOTHING
  `;
  await timedQueryAsync(sql, () =>
    getDriver().run(sql, [
      p.jti,
      p.wallet,
      p.issuedAt,
      p.expiresAt,
      p.userAgent ?? null,
      p.ipHash ?? null,
    ]),
  );
}

/** Mark a refresh-token jti as superseded (rotation on /auth/refresh). */
export async function markTokenSuperseded(jti: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const sql = `
    UPDATE wallet_token_sessions
    SET superseded_at = ?
    WHERE jti = ? AND superseded_at IS NULL
  `;
  await timedQueryAsync(sql, () => getDriver().run(sql, [now, jti]));
}

/** Mark one or more refresh-token jtis as revoked. */
export async function revokeSessions(wallet: string, jtis: string[]): Promise<void> {
  if (jtis.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  const placeholders = jtis.map(() => '?').join(',');
  // sql-injection-ok: placeholders are generated `?` markers; jtis are bound values.
  const sql = `
    UPDATE wallet_token_sessions
    SET revoked_at = ?
    WHERE wallet = ? AND jti IN (${placeholders}) AND revoked_at IS NULL
  `;
  await timedQueryAsync(sql, () => getDriver().run(sql, [now, wallet, ...jtis]));
}

/** Return every active (not superseded, not revoked, not expired) session for a wallet. */
export async function getActiveSessions(wallet: string): Promise<TokenSessionRow[]> {
  const now = Math.floor(Date.now() / 1000);
  const sql = `
    SELECT jti, wallet, issued_at, expires_at, user_agent, ip_hash, superseded_at, revoked_at
    FROM wallet_token_sessions
    WHERE wallet = ? AND superseded_at IS NULL AND revoked_at IS NULL AND expires_at > ?
    ORDER BY issued_at DESC
  `;
  return timedQueryAsync(sql, async () =>
    (await getDriver().all<TokenSessionRow>(sql, [wallet, now])).map((r) => ({
      ...r,
      user_agent: r.user_agent ?? null,
      ip_hash: r.ip_hash ?? null,
    })),
  );
}

/** Set the per-wallet `tokens_valid_after` cutoff (Unix seconds). Access tokens issued at or before this
 *  timestamp are rejected by requireAuth even before they expire. */
export async function setTokensValidAfter(wallet: string, tokensValidAfter: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const sql = `
    INSERT INTO wallet_token_validity (wallet, tokens_valid_after, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(wallet) DO UPDATE SET tokens_valid_after = excluded.tokens_valid_after, updated_at = excluded.updated_at
  `;
  await timedQueryAsync(sql, () => getDriver().run(sql, [wallet, tokensValidAfter, now]));
}

/** Return the per-wallet `tokens_valid_after` cutoff, or null when none has been set. */
export async function getTokensValidAfter(wallet: string): Promise<number | null> {
  const sql = `SELECT tokens_valid_after FROM wallet_token_validity WHERE wallet = ? LIMIT 1`;
  return timedQueryAsync(sql, async () => {
    const row = await getDriver().get<{ tokens_valid_after: number }>(sql, [wallet]);
    return row ? row.tokens_valid_after : null;
  });
}
