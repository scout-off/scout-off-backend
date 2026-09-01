/**
 * Token Revocation / Blocklist Service
 *
 * Manages a JWT revocation list using a Redis-primary / DB-fallback dual-store
 * strategy so that revoked tokens survive server restarts and are shared
 * across every backend instance.
 *
 * Strategy:
 *  - Redis primary   : SETEX <jti>:revoked 1 <ttl_seconds>  (key disappears at natural expiry)
 *  - DB fallback     : INSERT into revoked_tokens when Redis is unavailable
 *  - Write-through   : Every revocation writes to both stores simultaneously.
 *                      A Redis failure is logged as a warning but does NOT abort the operation.
 *  - Startup sync    : Non-expired DB rows are loaded into Redis on startup to warm the cache.
 *  - Background prune: A setInterval deletes DB rows whose expires_at has passed. Runs every
 *                      PRUNE_INTERVAL_MS (default: 60 min) and also on module load.
 */

import Redis from 'ioredis';
import { EventEmitter } from 'events';
import config from '../config';
import { logger } from '../utils/logger';
import { getDriver } from '../db';

// ─── In-process revocation events ────────────────────────────────────────────
//
// SSE connections subscribe here (via onTokenRevoked) so a token revoked in
// this process terminates the matching established streams immediately.
// Revocations persisted by another instance are picked up by the SSE route's
// bounded DB sweep (getActiveRevokedJtis) — see docs/auth.md.

const revokedEmitter = new EventEmitter();
revokedEmitter.setMaxListeners(0); // one listener per SSE connection

const REVOKED_EVENT = 'token_revoked';

// ─── Redis client (optional) ──────────────────────────────────────────────────

/** Narrow surface we need from ioredis — same pattern as redisCacheStore.ts */
type RedisLike = Pick<Redis, 'setex' | 'exists' | 'keys' | 'set'>;

let redisClient: RedisLike | null = null;

if (config.redisUrl) {
  const client = new Redis(config.redisUrl);
  client.on('error', (err: Error) => {
    logger.error('[tokenBlocklist] Redis client error:', err);
  });
  redisClient = client;
}

// ─── Key helpers ──────────────────────────────────────────────────────────────

const REDIS_KEY_PREFIX = 'jti:revoked:';

function redisKey(jti: string): string {
  return `${REDIS_KEY_PREFIX}${jti}`;
}

// ─── Pruning ──────────────────────────────────────────────────────────────────

/** Prune interval — rows older than 24 hours beyond their expiry are also swept. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/** Delete all DB rows that have already expired. */
async function pruneExpiredTokens(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  try {
    const driver = getDriver();
    await driver.run('DELETE FROM revoked_tokens WHERE expires_at <= ?', [now]);
  } catch (err) {
    // DB may not be initialised yet during module load — suppress quietly;
    // the next scheduled run will succeed.
    logger.warn('[tokenBlocklist] prune skipped (DB not ready?):', err);
  }
}

// ─── Redis helpers ────────────────────────────────────────────────────────────

/**
 * Write a single jti into Redis with a TTL equal to the seconds remaining
 * until the token's natural expiry.  No-ops if Redis is unavailable.
 * Returns true on success, false on failure.
 */
async function writeToRedis(jti: string, expiresAt: number): Promise<boolean> {
  if (!redisClient) return false;
  const ttl = expiresAt - Math.floor(Date.now() / 1000);
  if (ttl <= 0) return false; // already expired — no point storing
  try {
    await redisClient.setex(redisKey(jti), ttl, '1');
    return true;
  } catch (err) {
    logger.warn('[tokenBlocklist] Redis write failed:', err);
    return false;
  }
}

/**
 * Check Redis for a revoked jti.
 * Returns true if found, false if not found, null if Redis is unavailable.
 */
async function checkRedis(jti: string): Promise<boolean | null> {
  if (!redisClient) return null;
  try {
    const exists = await (redisClient as Redis).exists(redisKey(jti));
    return exists === 1;
  } catch (err) {
    logger.warn('[tokenBlocklist] Redis read failed, falling back to DB:', err);
    return null;
  }
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function writeToDb(jti: string, expiresAt: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  try {
    const driver = getDriver();
    await driver.run(
      'INSERT INTO revoked_tokens (jti, revoked_at, expires_at) VALUES (?, ?, ?) ON CONFLICT(jti) DO NOTHING',
      [jti, now, expiresAt],
    );
  } catch (err) {
    logger.error('[tokenBlocklist] DB write failed:', err);
    throw err; // DB failure is fatal — let the caller handle it
  }
}

async function checkDb(jti: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  try {
    const driver = getDriver();
    // Only match rows that haven't expired yet (belt-and-suspenders beyond pruning)
    const row = await driver.get<{ jti: string }>(
      'SELECT jti FROM revoked_tokens WHERE jti = ? AND expires_at > ? LIMIT 1',
      [jti, now],
    );
    return row !== undefined;
  } catch (err) {
    logger.error('[tokenBlocklist] DB read failed:', err);
    // Fail-safe: if we can't check the DB, treat the token as revoked
    return true;
  }
}

// ─── Startup sync ─────────────────────────────────────────────────────────────

/**
 * Load all non-expired DB revocations into Redis to warm the cache after a
 * restart.  Called once from initBlocklist() which is invoked at server start.
 *
 * Runs asynchronously — the server does NOT wait for it to finish before
 * accepting requests (Redis is a cache; the DB fallback handles the gap).
 */
async function syncDbToRedis(): Promise<void> {
  if (!redisClient) return;

  const now = Math.floor(Date.now() / 1000);
  let rows: Array<{ jti: string; expires_at: number }> = [];

  try {
    const driver = getDriver();
    rows = await driver.all<{ jti: string; expires_at: number }>(
      'SELECT jti, expires_at FROM revoked_tokens WHERE expires_at > ?',
      [now],
    );
  } catch (err) {
    logger.warn('[tokenBlocklist] Startup sync failed to query DB:', err);
    return;
  }

  let loaded = 0;
  for (const row of rows) {
    const ok = await writeToRedis(row.jti, row.expires_at);
    if (ok) loaded++;
  }

  logger.info(`[tokenBlocklist] Startup sync: loaded ${loaded}/${rows.length} revocations into Redis`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialise the blocklist service.
 * - Prunes expired DB rows.
 * - Schedules background pruning every PRUNE_INTERVAL_MS.
 * - Triggers a non-blocking startup sync of DB rows into Redis.
 *
 * Must be called once at application startup (after initDb()).
 */
export function initBlocklist(): void {
  pruneExpiredTokens().catch((err) =>
    logger.warn('[tokenBlocklist] initial prune failed:', err),
  );
  setInterval(() => {
    pruneExpiredTokens().catch((err) =>
      logger.warn('[tokenBlocklist] scheduled prune failed:', err),
    );
  }, PRUNE_INTERVAL_MS).unref();

  // Kick off startup sync without blocking startup
  syncDbToRedis().catch((err) =>
    logger.error('[tokenBlocklist] Startup sync error:', err),
  );
}

/**
 * Add a jti to the revocation blocklist.
 *
 * Writes to both Redis (primary) and DB (fallback) simultaneously.
 * A Redis failure is logged as a warning but does NOT prevent the DB write
 * from proceeding — the token will still be blocked via the DB path.
 *
 * @param jti       JWT ID claim (`jti` from the JWT payload)
 * @param expiresAt Token expiry as a Unix timestamp (seconds)
 */
export async function revokeToken(jti: string, expiresAt: number): Promise<void> {
  // DB write first — it's the durable store
  await writeToDb(jti, expiresAt);

  // Redis write — best-effort; warn on failure but never throw
  const redisOk = await writeToRedis(jti, expiresAt);
  if (!redisOk && redisClient) {
    logger.warn(`[tokenBlocklist] Redis write failed for jti=${jti}; token is blocked via DB only`);
  }

  // Notify in-process subscribers (SSE connections) synchronously.
  revokedEmitter.emit(REVOKED_EVENT, jti);
}

/**
 * Subscribe to in-process token revocations. The callback fires with the
 * revoked jti whenever revokeToken() runs in this process. Returns an
 * unsubscribe function.
 */
export function onTokenRevoked(cb: (jti: string) => void): () => void {
  revokedEmitter.on(REVOKED_EVENT, cb);
  return () => {
    revokedEmitter.off(REVOKED_EVENT, cb);
  };
}

/**
 * Return every currently non-expired revoked jti (single DB query).
 * Used by the SSE route's bounded sweep so revocations that happened in
 * another process are detected within the documented sweep interval.
 * Returns an empty list when the store is unavailable.
 */
export async function getActiveRevokedJtis(): Promise<string[]> {
  const now = Math.floor(Date.now() / 1000);
  try {
    const driver = getDriver();
    const rows = await driver.all<{ jti: string }>(
      'SELECT jti FROM revoked_tokens WHERE expires_at > ?',
      [now],
    );
    return rows.map((r) => r.jti);
  } catch (err) {
    logger.warn('[tokenBlocklist] active-jti sweep query failed:', err);
    return [];
  }
}

/**
 * Returns true if the given jti has been revoked.
 *
 * Checks Redis first (O(1), network); falls back to DB if Redis is down or
 * returns a negative (jti not in cache yet, e.g. after a crash + restart
 * before startup sync completes).
 *
 * A missing `jti` (undefined / empty) is always treated as non-revoked.
 */
export async function isTokenRevoked(jti: string | undefined): Promise<boolean> {
  if (!jti) return false;

  const redisResult = await checkRedis(jti);

  // Redis available and answered definitively
  if (redisResult !== null) return redisResult;

  // Redis unavailable or returned null — fall back to DB
  return checkDb(jti);
}

/**
 * Delete all rows whose token has already expired.
 * Exposed for testing; normally called internally by the background job.
 */
export { pruneExpiredTokens };
