/**
 * Repository: scout API keys, lookup hashes and revocation scheduling.
 *
 * Moved verbatim out of the 3,500-line `src/db/index.ts` barrel (#1535);
 * behaviour is unchanged. `src/db/index.ts` re-exports every symbol below.
 *
 * Driver status: fully on `getDriver()` (async) — works on both SQLite and PostgreSQL.
 */
import { getDriver, timedQueryAsync } from '../query';
import { ApiKeyLimitError, MAX_API_KEYS_PER_SCOUT, MAX_WEBHOOK_SUBSCRIPTIONS_PER_SCOUT, WebhookSubscriptionLimitError } from '../../utils/scoutResourceLimits';

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
    return getDriver().transaction(async (tx) => {
      await tx.lockForWrite(`api-key-limit:${p.scout_wallet}`);
      const count = await tx.value<number | string>(
        'SELECT COUNT(*) FROM api_keys WHERE scout_wallet = ?',
        [p.scout_wallet],
      );
      if (Number(count ?? 0) >= MAX_API_KEYS_PER_SCOUT) {
        throw new ApiKeyLimitError();
      }

      const info = await tx.run(sql, [
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
  const changed = await timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [now, id, scoutWallet]);
    return info.changes > 0;
  });

  // Emit revocation event (in-process and cross-instance via Redis)
  if (changed) {
    const { publishApiKeyRevoked } = await import('../../services/apiKeyService');
    void publishApiKeyRevoked(id).catch(() => {});
  }

  return changed;
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


/**
 * Get all active API key IDs (not revoked, not past expiry).
 * Used by the SSE authorization sweep to check if a session's API key is still valid.
 */
export async function getActiveApiKeyIds(): Promise<number[]> {
  const now = Math.floor(Date.now() / 1000);
  const sql = `
    SELECT id FROM api_keys
    WHERE revoked_at IS NULL
      AND (revoke_after IS NULL OR revoke_after > ?)
      AND (expires_at IS NULL OR expires_at > ?)
  `;
  const rows = await timedQueryAsync(sql, () =>
    getDriver().all<{ id: number }>(sql, [now, now]),
  );
  return rows.map((r) => r.id);
}
