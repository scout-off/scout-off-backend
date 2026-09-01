import { Request, Response, NextFunction } from 'express';
import {
  getIdempotencyRecord,
  claimIdempotencyKey,
  updateIdempotencyRecord,
} from '../db';
import { inFlightLock } from '../utils/inflightLock';
import { logger } from '../utils/logger';

/**
 * How long (ms) to wait for an in-progress duplicate to complete before
 * giving up and returning a 409 to the second caller.
 */
const IN_PROGRESS_WAIT_MS = 5_000;

/**
 * Options for the idempotency middleware.
 */
export interface IdempotencyOptions {
  /**
   * Computes a fingerprint of the logical request (e.g. the wallet + playerId
   * path params for the contact-unlock endpoint). When set, replaying the
   * same idempotency key with a materially different request is rejected with
   * 409 instead of serving the cached response of the unrelated request.
   * Return null to opt a particular request out of fingerprint checks.
   */
  requestFingerprint?: (req: Request) => string | null;
}

/**
 * Idempotency middleware for mutating endpoints — claim-first design.
 *
 * Dual API:
 *  - Plain middleware: `router.post(path, idempotency, handler)` (no options).
 *  - Factory: `router.post(path, idempotency({ requestFingerprint }), handler)`
 *    to enable request-fingerprint conflict detection (Issue #761).
 *
 * Flow:
 *  1. No `Idempotency-Key` header → pass through unchanged.
 *  2. Key exists as a *complete* record → return cached response (no handler call),
 *       unless a fingerprint is configured and the stored fingerprint differs
 *       from the current request's → 409 Conflict.
 *  3. Key exists as a *pending* record (another request is in-flight) →
 *       use inFlightLock to coalesce: wait up to IN_PROGRESS_WAIT_MS for the
 *       original to finish, then return its cached response.
 *       If it never completes within the window → 409 Conflict.
 *  4. No record yet → atomically INSERT a 'pending' marker via
 *       claimIdempotencyKey (INSERT OR IGNORE).
 *       • Claim wins  → intercept res.json to persist the response as 'complete'
 *                        then call next().
 *       • Claim loses → treat the same as case 3 (concurrent duplicate).
 *
 * Keys expire after 24 hours (controlled by IDEMPOTENCY_TTL_MS in db/index.ts).
 */
export function idempotency(req: Request, res: Response, next: NextFunction): void;
export function idempotency(
  options: IdempotencyOptions,
): (req: Request, res: Response, next: NextFunction) => void;
export function idempotency(
  reqOrOptions: Request | IdempotencyOptions,
  res?: Response,
  next?: NextFunction,
): void | ((req: Request, res: Response, next: NextFunction) => void) {
  // Plain middleware usage: idempotency(req, res, next).
  if (typeof (reqOrOptions as Request).params === 'object') {
    handleIdempotency(reqOrOptions as Request, res as Response, next as NextFunction, undefined).catch(next as NextFunction);
    return;
  }

  // Factory usage: idempotency({ requestFingerprint }).
  const options = reqOrOptions as IdempotencyOptions;
  return (req: Request, res: Response, next: NextFunction): void => {
    handleIdempotency(req, res, next, options).catch(next);
  };
}

async function handleIdempotency(
  req: Request,
  res: Response,
  next: NextFunction,
  options: IdempotencyOptions | undefined,
): Promise<void> {
  const key = req.headers['idempotency-key'];

  // No key supplied — pass through without any idempotency behaviour.
  if (!key || typeof key !== 'string' || key.trim() === '') {
    next();
    return;
  }

  const trimmedKey = key.trim();
  const requestFingerprint = options?.requestFingerprint
    ? options.requestFingerprint(req)
    : null;

  // ── Step 1: check for an existing record ─────────────────────────────────
  let existingRecord;
  try {
    existingRecord = await getIdempotencyRecord(trimmedKey);
  } catch (err) {
    // DB read failure is non-fatal; fall through and process normally.
    logger.warn(
      `[idempotency] cache_lookup_error key=${trimmedKey} err=${(err as Error).message}`,
    );
    next();
    return;
  }

  if (existingRecord) {
    if (existingRecord.status === 'complete') {
      // ── Case 2: complete cache hit ────────────────────────────────────────
      if (fingerprintConflicts(requestFingerprint, existingRecord.request_fingerprint)) {
        logger.warn(`[idempotency] fingerprint_conflict key=${trimmedKey}`);
        res.status(409).json({ error: 'Idempotency key was already used with a different request' });
        return;
      }
      logger.info(`[idempotency] cache_hit key=${trimmedKey}`);
      res.status(existingRecord.status_code).json(JSON.parse(existingRecord.response));
      return;
    }

    // ── Case 3: pending (in-flight duplicate) ─────────────────────────────
    logger.info(`[idempotency] pending_duplicate key=${trimmedKey}`);
    waitForCompletion(trimmedKey, res, requestFingerprint);
    return;
  }

  // ── Step 2: attempt to claim the key (atomic INSERT OR IGNORE) ───────────
  let claimed: boolean;
  try {
    claimed = await claimIdempotencyKey(trimmedKey, requestFingerprint);
  } catch (err) {
    // DB claim failure is non-fatal; process normally without idempotency.
    logger.warn(
      `[idempotency] claim_error key=${trimmedKey} err=${(err as Error).message}`,
    );
    next();
    return;
  }

  if (!claimed) {
    // Another process/thread won the INSERT race — treat as pending duplicate.
    logger.info(`[idempotency] lost_claim_race key=${trimmedKey}`);
    waitForCompletion(trimmedKey, res, requestFingerprint);
    return;
  }

  // ── Step 3: we own the key — register the completion via inFlightLock ────
  //
  // We wrap next() inside inFlightLock.withLock so that any concurrent loser
  // that calls waitForCompletion() will simply await this exact Promise and
  // share the result rather than polling the DB.
  //
  // We use a "deferred" pattern: create the resolution handles up-front so
  // that res.json (which fires inside the handler, not here) can resolve the
  // lock promise.
  let resolveInFlight!: (value: { statusCode: number; body: unknown }) => void;
  let rejectInFlight!: (reason: unknown) => void;

  const inFlightPromise = new Promise<{ statusCode: number; body: unknown }>(
    (resolve, reject) => {
      resolveInFlight = resolve;
      rejectInFlight = reject;
    },
  );

  // Register the promise under this key so concurrent losers can await it.
  // inFlightLock.withLock() is designed for async coalescing; we prime it by
  // running a no-op fn that returns our pre-created promise.
  void inFlightLock.withLock(trimmedKey, () => inFlightPromise);

  // Intercept res.json to persist the response and resolve the in-flight promise.
  const originalJson = res.json.bind(res);

  res.json = function (body: unknown): Response {
    // Persist the response before sending; ignore errors (best-effort). This
    // stays fire-and-forget rather than awaited: res.json must return
    // synchronously to preserve Express's response contract. Wrapped in
    // Promise.resolve() so this can never throw synchronously or reject
    // unhandled even if updateIdempotencyRecord doesn't return a genuine
    // Promise (e.g. an incomplete test mock).
    Promise.resolve(updateIdempotencyRecord(trimmedKey, res.statusCode, body))
      .then(() => logger.info(`[idempotency] cache_stored key=${trimmedKey} status=${res.statusCode}`))
      .catch((err: unknown) =>
        logger.warn(`[idempotency] cache_store_error key=${trimmedKey} err=${(err as Error).message}`),
      );
    // Resolve the in-flight promise so concurrent waiters unblock.
    resolveInFlight({ statusCode: res.statusCode, body });
    return originalJson(body);
  };

  // Also handle the case where the handler calls next(err) or never calls res.json
  // (e.g. streams, redirects).  We reject so waiters are not stuck forever.
  const originalEnd = res.end.bind(res) as (...args: unknown[]) => Response;
  (res as unknown as { end: (...args: unknown[]) => Response }).end = function (
    ...args: unknown[]
  ): Response {
    // If res.json was never called (e.g. res.send with non-JSON body), reject.
    rejectInFlight(new Error('response ended without res.json'));
    return originalEnd(...args);
  };

  next();
}

/**
 * Returns true when a stored request fingerprint conflicts with the current
 * request's fingerprint (i.e. the same idempotency key was used with a
 * materially different request). Fingerprint checks only apply when the
 * middleware was configured with a requestFingerprint function; otherwise
 * no conflict is ever reported (legacy key-only behaviour).
 */
function fingerprintConflicts(
  requestFingerprint: string | null,
  storedFingerprint: string | null | undefined,
): boolean {
  return (
    requestFingerprint !== null &&
    storedFingerprint != null &&
    storedFingerprint !== requestFingerprint
  );
}

/**
 * Wait for the in-flight owner to finish, then serve the cached response.
 * Falls back to a 409 if the owner doesn't complete within IN_PROGRESS_WAIT_MS.
 */
function waitForCompletion(
  key: string,
  res: Response,
  requestFingerprint: string | null,
): void {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error('in-progress timeout')),
      IN_PROGRESS_WAIT_MS,
    ),
  );

  Promise.race([
    inFlightLock.withLock(key, () =>
      // If the lock resolves it means the owner finished; we don't need to
      // run any fn — return a sentinel value.
      Promise.resolve({ statusCode: 0, body: null }),
    ),
    timeout,
  ])
    .then(async () => {
      // Owner finished — read the completed record from the DB.
      const record = await getIdempotencyRecord(key);
      if (record && record.status === 'complete') {
        if (fingerprintConflicts(requestFingerprint, record.request_fingerprint)) {
          logger.warn(`[idempotency] fingerprint_conflict_after_wait key=${key}`);
          res.status(409).json({ error: 'Idempotency key was already used with a different request' });
          return;
        }
        logger.info(`[idempotency] served_after_wait key=${key}`);
        res.status(record.status_code).json(JSON.parse(record.response));
      } else {
        // Record is still pending or gone — return 409.
        logger.warn(`[idempotency] still_pending_after_wait key=${key}`);
        res
          .status(409)
          .json({ error: 'Request already in progress for this idempotency key' });
      }
    })
    .catch((err: Error) => {
      logger.warn(
        `[idempotency] wait_timeout key=${key} err=${err.message}`,
      );
      res
        .status(409)
        .json({ error: 'Request already in progress for this idempotency key' });
    });
}
