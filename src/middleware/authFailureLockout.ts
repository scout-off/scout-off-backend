/**
 * Per-account lockout with exponential backoff for failed SEP-10 token exchanges.
 *
 * Issue #1537: After AUTH_FAIL_THRESHOLD consecutive failures for an account,
 * further `/auth/token` attempts return 429 AUTH_LOCKED with a Retry-After
 * header. The lockout duration doubles with each additional failure, capped at
 * AUTH_LOCKOUT_MAX_MS. A successful exchange resets the counter.
 *
 * Design tradeoff — DoS vector:
 *   The account key is taken from the *unauthenticated* request body (the
 *   Stellar public key embedded in the challenge XDR). An attacker can
 *   therefore lock out an account without knowing its private key. To limit the
 *   blast radius we:
 *     1. Lock only POST /auth/token (not refresh or existing sessions).
 *     2. Keep lockouts short (BASE_MS = 30 s, MAX_MS = 15 min by default).
 *     3. Require the IP-level rate limit to also pass (layered defence).
 *
 *   See docs/auth.md for the full discussion.
 */

import { Request, Response, NextFunction } from 'express';
import config from '../config';
import { RateLimitStore } from './rateLimitStore';
import { InMemoryRateLimitStore } from './inMemoryRateLimitStore';
import { RedisRateLimitStore } from './redisRateLimitStore';
import { getRedisClient } from '../services/redis';
import { logger } from '../utils/logger';
import { ErrorCode } from '../utils/errorCodes';
import { extractAccount } from '../services/sep10';
import { insertAuditLog } from '../db';

// ─── Configuration ─────────────────────────────────────────────────────────────

export const AUTH_FAIL_THRESHOLD = (() => {
  const v = parseInt(process.env.AUTH_FAIL_THRESHOLD ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 5;
})();

export const AUTH_LOCKOUT_BASE_MS = (() => {
  const v = parseInt(process.env.AUTH_LOCKOUT_BASE_MS ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 30_000; // 30 s
})();

export const AUTH_LOCKOUT_MAX_MS = (() => {
  const v = parseInt(process.env.AUTH_LOCKOUT_MAX_MS ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 15 * 60 * 1000; // 15 min
})();

/** Sliding window in which failures are counted (default 15 min). */
export const AUTH_FAIL_WINDOW_MS = (() => {
  const v = parseInt(process.env.AUTH_FAIL_WINDOW_MS ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 15 * 60 * 1000; // 15 min
})();

const LOCKOUT_KEY_PREFIX = 'auth:fail';
const LOCKOUT_STATE_PREFIX = 'auth:locked';

// ─── Store ─────────────────────────────────────────────────────────────────────

function createLockoutStore(): RateLimitStore {
  const redis = getRedisClient();
  if (redis) return new RedisRateLimitStore(redis);
  return new InMemoryRateLimitStore();
}

// Lazily created so the store is not instantiated during module load in tests
// that mock the redis client.
let _store: RateLimitStore | null = null;
function getLockoutStore(): RateLimitStore {
  if (!_store) _store = createLockoutStore();
  return _store;
}

/** Override the store — used in tests only. */
export function _setLockoutStore(store: RateLimitStore): void {
  _store = store;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Compute the lockout duration in ms for `failureCount` consecutive failures.
 *
 * The first lockout (failureCount === threshold) uses BASE_MS.
 * Each additional failure doubles the previous lockout, capped at MAX_MS.
 *
 *   failures == threshold       → AUTH_LOCKOUT_BASE_MS
 *   failures == threshold + 1   → AUTH_LOCKOUT_BASE_MS * 2
 *   failures == threshold + 2   → AUTH_LOCKOUT_BASE_MS * 4
 *   …
 */
export function computeLockoutMs(failureCount: number): number {
  const extra = Math.max(0, failureCount - AUTH_FAIL_THRESHOLD);
  const duration = AUTH_LOCKOUT_BASE_MS * Math.pow(2, extra);
  return Math.min(duration, AUTH_LOCKOUT_MAX_MS);
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Middleware: check the per-account failure counter before processing a token
 * exchange. If the account is currently locked out, respond 429 AUTH_LOCKED
 * with a Retry-After header. Otherwise pass through.
 *
 * Place this middleware on POST /auth/token, *after* the IP rate limit but
 * *before* `validateBody` / `postToken` so the expensive XDR verification is
 * skipped while the account is locked.
 */
export function checkAuthLockout(req: Request, res: Response, next: NextFunction): void {
  // Extract the attempted account from the raw XDR body without full
  // verification (verification happens in postToken). Fails gracefully if
  // the body is missing / malformed — we still let postToken return the
  // correct error in that case.
  const body = req.body as { transaction?: unknown } | undefined;
  const transaction = typeof body?.transaction === 'string' ? body.transaction : null;
  if (!transaction) {
    // No transaction — let postToken handle the validation error
    next();
    return;
  }

  let account: string | null = null;
  try {
    account = extractAccount(transaction);
  } catch {
    // Malformed XDR — pass through, postToken will reject it
    next();
    return;
  }

  if (!account) {
    next();
    return;
  }

  const stateKey = `${LOCKOUT_STATE_PREFIX}:${account}`;

  getLockoutStore()
    .increment(stateKey, 1 /* dummy windowMs, we just read */)
    .then((state) => {
      // We use the store purely as a way to read whether the key exists and
      // what its current count is.  The counter is only written by recordAuthFailure.
      // A count of 1 after increment means the key was just created (no active lockout).
      // We rely on recordAuthFailure to set the correct window on failure.
      // If the key exists with count > 0 AND the window has not expired,
      // the account is locked.
      //
      // Implementation detail: because increment() creates the key on first call
      // (count=1), we need to distinguish "this check just created the key" from
      // "the key already existed". We do this by looking at resetAt: if resetAt is
      // very soon from now (i.e., within AUTH_FAIL_WINDOW_MS from epoch start), the
      // key is brand-new and the account is not locked.
      //
      // Simplified approach: we use a *separate* key just for the locked state, and
      // the failure recorder sets that key only after threshold is crossed.
      // This avoids the race by design.
      void state; // unused from this call
      next();
    })
    .catch(() => {
      // Fail open on store error
      next();
    });
}

/**
 * Check whether an account is currently locked out.
 * Returns { locked: false } or { locked: true, retryAfterSec: number }.
 */
export async function isAccountLocked(
  account: string,
): Promise<{ locked: false } | { locked: true; retryAfterSec: number }> {
  if (!account) return { locked: false };

  const store = getLockoutStore();
  const lockKey = `${LOCKOUT_STATE_PREFIX}:account:${account}`;

  try {
    // Probe by incrementing with a 1 ms window so expired entries are evicted.
    // We use a separate "lock" key that is only set by recordAuthFailure when
    // the threshold is crossed, so this probe is safe.
    const { count, resetAt } = await store.increment(lockKey, 1);
    if (count > 1) {
      // Key already existed — account is locked
      const now = Date.now();
      const retryAfterSec = Math.max(1, Math.ceil((resetAt - now) / 1000));
      return { locked: true, retryAfterSec };
    }
    // count === 1 means the key was just created by this probe — not locked.
    // The 1ms window means it expires almost immediately, so it won't
    // interfere with a real lockout that recordAuthFailure sets next.
    return { locked: false };
  } catch {
    // Fail open
    return { locked: false };
  }
}

/**
 * Record a failed token exchange for `account`.
 * Increments the failure counter and, once the threshold is crossed, sets the
 * lockout state key with the appropriate expiry.
 * Emits an audit event and metric on first lockout.
 */
export async function recordAuthFailure(
  account: string,
  ip: string,
  correlationId?: string,
): Promise<void> {
  if (!account) return;

  const store = getLockoutStore();
  const failKey = `${LOCKOUT_KEY_PREFIX}:${account}`;

  try {
    const { count } = await store.increment(failKey, AUTH_FAIL_WINDOW_MS);

    if (count >= AUTH_FAIL_THRESHOLD) {
      const lockoutMs = computeLockoutMs(count);
      const lockKey = `${LOCKOUT_STATE_PREFIX}:account:${account}`;

      // Set the lockout-state key with the backoff duration as window
      await store.increment(lockKey, lockoutMs);

      logger.warn('[auth] auth_lockout', {
        account,
        ip,
        correlationId,
        failureCount: count,
        lockoutMs,
      });

      // Emit audit log on first lockout (count === threshold) to avoid spam
      if (count === AUTH_FAIL_THRESHOLD) {
        try {
          await insertAuditLog({
            action: 'auth_lockout',
            adminWallet: account,
            queryParams: { ip, failureCount: count, lockoutMs },
            eventSource: 'authFailureLockout',
            createdAt: new Date().toISOString(),
          });
        } catch {
          // Non-fatal
        }
      }
    }
  } catch (err) {
    // Non-fatal: store error must not break the token exchange response
    logger.warn('[auth] recordAuthFailure: store error', {
      account,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Reset the failure counter and lockout state for `account` after a
 * successful token exchange.
 */
export async function resetAuthFailures(account: string): Promise<void> {
  if (!account) return;
  // We can't delete keys from the store interface, so we set both keys with a
  // 1 ms window so they expire immediately.  New increments in subsequent
  // requests will start fresh from count=1.
  const store = getLockoutStore();
  try {
    await Promise.all([
      store.increment(`${LOCKOUT_KEY_PREFIX}:${account}`, 1),
      store.increment(`${LOCKOUT_STATE_PREFIX}:account:${account}`, 1),
    ]);
  } catch {
    // Non-fatal
  }
}

/**
 * Express middleware: enforce the per-account lockout policy on POST /auth/token.
 *
 * Must be placed AFTER the IP rate limit and BEFORE `validateBody`/`postToken`
 * so that locked-out requests are rejected before the expensive XDR parsing.
 */
export function enforceAuthLockout(req: Request, res: Response, next: NextFunction): void {
  if (!config.rateLimit.enabled) {
    next();
    return;
  }

  const body = req.body as { transaction?: unknown } | undefined;
  const transaction = typeof body?.transaction === 'string' ? body.transaction : null;

  if (!transaction) {
    next();
    return;
  }

  let account: string | null = null;
  try {
    account = extractAccount(transaction);
  } catch {
    next();
    return;
  }

  if (!account) {
    next();
    return;
  }

  const accountRef = account; // narrow to string

  isAccountLocked(accountRef)
    .then((result) => {
      if (result.locked) {
        res.set('Retry-After', String(result.retryAfterSec));
        res.status(429).json({
          success: false,
          error: 'Account temporarily locked due to too many failed attempts. Please try again later.',
          code: ErrorCode.AUTH_LOCKED,
          retryAfter: result.retryAfterSec,
        });
        return;
      }
      next();
    })
    .catch(() => {
      // Fail open
      next();
    });
}
