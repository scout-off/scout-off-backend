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
import { ReadableRateLimitStore } from './rateLimitStore';
import { InMemoryRateLimitStore } from './inMemoryRateLimitStore';
import { RedisRateLimitStore } from './redisRateLimitStore';
import { getRedisClient } from '../services/redis';
import { logger } from '../utils/logger';
import { ErrorCode } from '../utils/errorCodes';
import { extractAccount } from '../services/sep10';
import { insertAuditLog } from '../db';

// ─── Configuration ─────────────────────────────────────────────────────────────
// Values are sourced from src/config.ts (config.authLockout) so they are
// validated once at startup via parseNumericEnv, can be overridden in tests
// through config mocks, and are documented in .env.example (#1830).

export const AUTH_FAIL_THRESHOLD = config.authLockout.threshold;
export const AUTH_LOCKOUT_BASE_MS = config.authLockout.baseMs;
export const AUTH_LOCKOUT_MAX_MS = config.authLockout.maxMs;
/** Sliding window in which failures are counted. */
export const AUTH_FAIL_WINDOW_MS = config.authLockout.windowMs;

const LOCKOUT_KEY_PREFIX = 'auth:fail';
const LOCKOUT_STATE_PREFIX = 'auth:locked';

// ─── Store ─────────────────────────────────────────────────────────────────────

function createLockoutStore(): ReadableRateLimitStore {
  const redis = getRedisClient();
  if (redis) return new RedisRateLimitStore(redis);
  return new InMemoryRateLimitStore();
}

// Lazily created so the store is not instantiated during module load in tests
// that mock the redis client.
let _store: ReadableRateLimitStore | null = null;
function getLockoutStore(): ReadableRateLimitStore {
  if (!_store) _store = createLockoutStore();
  return _store;
}

/** Override the store — used in tests only. */
export function _setLockoutStore(store: ReadableRateLimitStore): void {
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
 * @deprecated Use {@link enforceAuthLockout}. Kept as an alias for older call
 * sites; the previous implementation never enforced anything and wrote a
 * stray store key on every request.
 */
export function checkAuthLockout(req: Request, res: Response, next: NextFunction): void {
  enforceAuthLockout(req, res, next);
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
    // Read-only check: probing with increment() would itself create or bump the
    // lock key, so two checks in quick succession would lock a clean account.
    const state = await store.get(lockKey);
    if (!state) return { locked: false };
    const retryAfterSec = Math.max(1, Math.ceil((state.resetAt - Date.now()) / 1000));
    return { locked: true, retryAfterSec };
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

      // (Re)start the lockout-state key with the escalated backoff as its window.
      // Without the reset, an existing lock key would keep its original expiry.
      await store.reset(lockKey);
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
  const store = getLockoutStore();
  try {
    await Promise.all([
      store.reset(`${LOCKOUT_KEY_PREFIX}:${account}`),
      store.reset(`${LOCKOUT_STATE_PREFIX}:account:${account}`),
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
          error:
            'Account temporarily locked due to too many failed attempts. Please try again later.',
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
