/**
 * Repository: idempotency-key claim / release / purge helpers.
 *
 * Moved verbatim out of the 3,500-line `src/db/index.ts` barrel (#1535);
 * behaviour is unchanged. `src/db/index.ts` re-exports every symbol below.
 *
 * Driver status: fully on `getDriver()` (async) — works on both SQLite and PostgreSQL.
 */
import { getDriver, timedQueryAsync } from '../query';
import type { DbTxHandle } from '../driver';
import config from '../../config';

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
  /**
   * Lease expiry (Unix ms). While status='pending' and locked_until > now,
   * concurrent callers cannot re-claim this key. NULL means no lease (legacy).
   */
  locked_until?: number | null;
}

/**
 * Delete a pending idempotency record without persisting a response.
 * Used when a streaming handler calls res.end without res.json, or when the
 * request handler throws before sending a response. Releases the lease so the
 * key can be re-used immediately by a retry.
 */
export async function releaseIdempotencyKey(key: string): Promise<void> {
  const sql = 'DELETE FROM idempotency_keys WHERE key = ? AND status = ?';
  await timedQueryAsync(sql, () =>
    getDriver().run(sql, [key, 'pending'])
  );
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const IDEMPOTENCY_LEASE_MS = config.idempotencyLeaseMs; // Lease expiry (ms)

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
 * Attempt to claim an idempotency key by inserting a 'pending' marker, or
 * re-claiming an expired lease. The lease mechanism allows a crashed or hung
 * request to release its claim so a retry can proceed before the 24 h TTL.
 *
 * Atomic UPDATE that transitions a pending record whose lease has expired
 * (locked_until < now) to a fresh pending record with a new lease, or inserts
 * a new row if the key is absent or fully expired.
 *
 * Uses a single SQL statement so concurrent callers cannot race to grab the
 * same expired record.
 *
 * Returns true  — this caller owns the key; proceed with the handler.
 * Returns false — another request owns the key (either still pending with
 *                 an active lease, or complete with a valid cached response).
 */
export async function claimIdempotencyKey(
  key: string,
  requestFingerprint?: string | null,
): Promise<boolean> {
  const now = Date.now();
  const lockedUntil = now + IDEMPOTENCY_LEASE_MS;
  const expiresAt = now + IDEMPOTENCY_TTL_MS;

  // First try to re-claim an expired pending record. If that succeeds, we own
  // the key. If not, fall back to a normal INSERT OR IGNORE.
  const reclaimSql = `
    UPDATE idempotency_keys
    SET status_code = 0,
        response = '',
        status = 'pending',
        created_at = ?,
        locked_until = ?,
        expires_at = ?,
        request_fingerprint = ?
    WHERE key = ?
      AND status = 'pending'
      AND (locked_until IS NULL OR locked_until < ?)
    `;
  const insertSql = `
    INSERT INTO idempotency_keys (key, status_code, response, created_at, expires_at, status, locked_until, request_fingerprint)
    VALUES (?, 0, '', ?, ?, 'pending', ?, ?)
    ON CONFLICT (key) DO NOTHING
  `;

  // Attempt reclaim first (SQLite: no RETURNING, so we check changes)
  const reclaimResult = await timedQueryAsync(reclaimSql, () =>
    getDriver().run(reclaimSql, [now, lockedUntil, expiresAt, requestFingerprint ?? null, key, now])
  );

  if (reclaimResult.changes === 1) {
    return true;
  }

  // Reclaim didn't succeed; try a fresh insert
  const insertResult = await timedQueryAsync(insertSql, () =>
    getDriver().run(insertSql, [key, now, expiresAt, lockedUntil, requestFingerprint ?? null])
  );

  return insertResult.changes === 1;
}

/**
 * Transition a 'pending' idempotency key to 'complete', or delete it for
 * transient failures.  Called by the middleware after the handler has written
 * its response.
 *
 * Only persisted outcomes:
 *   • 2xx (success)
 *   • 4xx that are deterministic (exclude 408/409/423/429 which indicate
 *     retryable conditions or client errors that should not be cached)
 *
 * Transient 5xx responses are NOT cached; the pending record is deleted so
 * the client can retry with the same key.
 */
export async function updateIdempotencyRecord(
  key: string,
  statusCode: number,
  body: unknown,
): Promise<void> {
  const shouldCache = isDeterministicOutcome(statusCode);

  if (shouldCache) {
    const sql = `
      UPDATE idempotency_keys
      SET status_code = ?, response = ?, status = 'complete'
      WHERE key = ?
    `;
    await timedQueryAsync(sql, () =>
      getDriver().run(sql, [statusCode, JSON.stringify(body), key])
    );
  } else {
    // For transient failures (5xx) and retryable client errors (408/409/423/429),
    // delete the pending record so the client can retry with the same key.
    const sql = 'DELETE FROM idempotency_keys WHERE key = ? AND status = ?';
    await timedQueryAsync(sql, () =>
      getDriver().run(sql, [key, 'pending'])
    );
  }
}

/**
 * Returns true when the response should be cached for idempotency replay.
 *
 * 2xx: always cache (successful outcomes are deterministic).
 * 4xx: cache only if not retryable (exclude 408/409/423/429).
 * 5xx: never cache (transient server errors should be retryable).
 */
function isDeterministicOutcome(statusCode: number): boolean {
  if (statusCode >= 200 && statusCode < 300) {
    return true;
  }
  if (statusCode >= 400 && statusCode < 500) {
    // 408 (Request Timeout), 409 (Conflict), 423 (Locked), 429 (Too Many Requests)
    // are all retryable or indicate a client action is needed; don't cache.
    return ![408, 409, 423, 429].includes(statusCode);
  }
  // 5xx are transient; clients should retry.
  return false;
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
    INSERT INTO idempotency_keys (key, status_code, response, created_at, expires_at, status, locked_until)
    VALUES (?, ?, ?, ?, ?, 'complete', ?)
    ON CONFLICT(key) DO NOTHING
  `;
  await timedQueryAsync(sql, () =>
    getDriver().run(sql, [key, statusCode, JSON.stringify(body), now, now + IDEMPOTENCY_TTL_MS, null])
  );
}

/**
 * Delete one bounded batch of expired idempotency responses. The retention
 * scheduler calls this with its transaction and sweep cutoff.
 */
export async function purgeExpiredIdempotencyKeys(
  before = Date.now(), limit = config.retention.batchSize, tx?: DbTxHandle,
): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid idempotency purge batch size');
  const sql = 'DELETE FROM idempotency_keys WHERE key IN (SELECT key FROM idempotency_keys WHERE expires_at < ? ORDER BY expires_at LIMIT ?) AND expires_at < ?';
  return timedQueryAsync(sql, async () => {
    const info = await (tx ?? getDriver()).run(sql, [before, limit, before]);
    return info.changes;
  });
}
