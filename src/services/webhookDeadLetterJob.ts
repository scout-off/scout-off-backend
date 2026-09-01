/**
 * Background retry job for the webhook dead-letter queue.
 *
 * Every 5 minutes the job:
 *   1. Refreshes the per-subscription dead-letter gauge and evaluates
 *      configurable size / insert-rate thresholds (#1131).
 *   2. Picks up pending rows older than 10 minutes whose retry_count < 5.
 *   3. Atomically claims each eligible row (pending → in_progress) so that
 *      a second overlapping sweep cannot process the same row.
 *   4. Re-attempts delivery via postWebhookWithRetry.
 *   5. On success: deletes the dead-letter row and increments
 *      webhook_retry_success_total.
 *   6. On failure: increments retry_count / last_attempted_at and releases
 *      the claim (back to pending) so a future sweep can retry.
 *
 * The scheduler uses self-rescheduling setTimeout instead of setInterval to
 * guarantee that the next sweep never starts before the current one finishes,
 * eliminating the overlap bug described in #1018.
 */

import crypto from 'crypto';
import {
  countWebhookDeadLetters,
  countWebhookDeadLettersBySubscription,
  listWebhookDeadLetters,
  listWebhookSubscriptions,
  claimWebhookDeadLetter,
  releaseWebhookDeadLetterClaim,
  markWebhookDeadLetterReplayed,
  updateWebhookDeadLetterAttempt,
  WebhookDeadLetter,
} from '../db';
import { postWebhookWithRetry } from './webhooks';
import { logger } from '../utils/logger';
import { incrementWebhookRetrySuccessTotal } from '../middleware/metrics';
import { evaluateDeadLetterAlerts } from './webhookDeadLetterAlerts';
import config from '../config';

// ─── Configuration ─────────────────────────────────────────────────────────────

/** How often the retry job runs (ms). */
export const DEAD_LETTER_JOB_INTERVAL_MS = 5 * 60 * 1000; // 5 min

/** Dead letters must be at least this old before auto-retry (ms). */
const MIN_AGE_BEFORE_RETRY_MS = 10 * 60 * 1000; // 10 min

/** Maximum number of auto-retries per dead-letter row. */
export const MAX_AUTO_RETRIES = 5;

/** @deprecated Prefer config.webhookDeadLetterAlert.sizeThreshold. */
export const OVERFLOW_THRESHOLD = (): number => config.webhookDeadLetterAlert.sizeThreshold;

/** Stale lock threshold — locks older than this are assumed abandoned (ms). */
const STALE_LOCK_THRESHOLD_MS = 15 * 60 * 1000; // 15 min

// ─── Core logic (exported for testing) ────────────────────────────────────────

/**
 * Generate a unique worker identifier for this process invocation.
 * Used as the `locked_by` value when claiming dead-letter rows, so overlapping
 * sweeps (even from separate processes) can distinguish their own claims.
 */
export function generateWorkerId(): string {
  return `worker-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/** Cache the worker ID for the lifetime of a single sweep. */
let _currentWorkerId: string | null = null;

/**
 * Run one iteration of the dead-letter retry sweep.
 * Returns the number of rows successfully re-delivered.
 */
export async function runDeadLetterRetryJob(): Promise<number> {
  let successCount = 0;
  _currentWorkerId = generateWorkerId();

  // ── Threshold alerting + gauge refresh (#1131) ─────────────────────────────
  const total = countWebhookDeadLetters();
  const bySubscription = countWebhookDeadLettersBySubscription();
  await evaluateDeadLetterAlerts(total, bySubscription);

  // ── Pick eligible rows ───────────────────────────────────────────────────────
  // Fetch a generous page (up to 200) and filter in-process so we don't need
  // a custom SQL query.  The queue is expected to stay small; if it grows very
  // large the overflow alert above fires long before we'd need batching here.
  const rows = listWebhookDeadLetters(200, 0);
  const cutoff = new Date(Date.now() - MIN_AGE_BEFORE_RETRY_MS).toISOString();

  const eligible = rows.filter(
    (r: WebhookDeadLetter) =>
      r.status === 'pending' &&
      r.attempts < MAX_AUTO_RETRIES &&
      r.created_at <= cutoff,
  );

  if (eligible.length === 0) {
    _currentWorkerId = null;
    return 0;
  }

  const subscriptions = listWebhookSubscriptions();

  // ── Recover stale locks from crashed workers ──────────────────────────────────
  const staleThreshold = new Date(Date.now() - STALE_LOCK_THRESHOLD_MS).toISOString();
  for (const row of eligible) {
    if (row.status === 'pending') continue;
    if (row.locked_at && row.locked_at < staleThreshold) {
      logger.warn(
        `[webhooks] recovering stale lock — id=${row.id} locked_by=${row.locked_by} locked_at=${row.locked_at}`,
      );
      releaseWebhookDeadLetterClaim(row.id);
      // Re-fetch after releasing — it will appear as pending again on next filter.
    }
  }

  // Re-fetch eligible rows after stale-lock recovery.
  const refreshedRows = listWebhookDeadLetters(200, 0);
  const refreshedEligible = refreshedRows.filter(
    (r: WebhookDeadLetter) =>
      r.status === 'pending' &&
      r.attempts < MAX_AUTO_RETRIES &&
      r.created_at <= cutoff,
  );

  // ── Process each eligible row with atomic claim ──────────────────────────────
  // Process sequentially (not Promise.all) to avoid overwhelming subscribers.
  // Each claim is atomic — only one concurrent sweep wins.
  for (const deadLetter of refreshedEligible) {
    // Atomically claim the row — only one caller wins.
    const claimed = claimWebhookDeadLetter(deadLetter.id, _currentWorkerId!);
    if (!claimed) {
      // Another sweep already claimed this row; skip it.
      continue;
    }

    const subscription =
      subscriptions.find((s) => s.id === claimed.subscription_id) ??
      subscriptions.find((s) => s.url === claimed.url);

    try {
      await postWebhookWithRetry(claimed.url, JSON.parse(claimed.payload), {
        retries: 2,
        baseDelayMs: 500,
        maxDelayMs: 5000,
        secret: subscription?.secret,
      });

      markWebhookDeadLetterReplayed(claimed.id);
      incrementWebhookRetrySuccessTotal();
      successCount += 1;

      logger.info(
        `[webhooks] dead-letter auto-retry succeeded — id=${claimed.id} url=${claimed.url} delivery_id=${claimed.delivery_id}`,
      );
    } catch (err) {
      const failureReason = err instanceof Error ? err.message : String(err);
      const newAttempts = claimed.attempts + 1;
      updateWebhookDeadLetterAttempt(claimed.id, newAttempts, failureReason);
      // Release the claim so a future sweep can retry.
      releaseWebhookDeadLetterClaim(claimed.id);

      logger.warn(
        `[webhooks] dead-letter auto-retry failed — id=${claimed.id} url=${claimed.url} ` +
          `attempts=${newAttempts} reason=${failureReason} delivery_id=${claimed.delivery_id}`,
      );
    }
  }

  _currentWorkerId = null;
  return successCount;
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

let _nextTimeout: ReturnType<typeof setTimeout> | null = null;
let _running = false;
let _stopped = false;

/**
 * Schedule the next sweep. Self-rescheduling ensures a new sweep never starts
 * before the current one finishes — unlike setInterval which fires
 * independently of whether the previous invocation completed.
 */
function scheduleNext(): void {
  if (_stopped) return;
  _nextTimeout = setTimeout(async () => {
    if (_stopped) return;
    _running = true;
    try {
      const n = await runDeadLetterRetryJob();
      if (n > 0) {
        logger.info(`[webhooks] dead-letter job completed — ${n} deliveries retried successfully`);
      }
    } catch (err) {
      logger.error('[webhooks] dead-letter job error:', err);
    } finally {
      _running = false;
      scheduleNext();
    }
  }, DEAD_LETTER_JOB_INTERVAL_MS);

  // Don't prevent graceful shutdown.
  if (_nextTimeout.unref) _nextTimeout.unref();
}

/**
 * Start the background dead-letter retry job.
 * Safe to call multiple times — subsequent calls are no-ops if the job is
 * already running.
 */
export function startDeadLetterRetryJob(): void {
  if (_nextTimeout !== null) return;
  _stopped = false;
  logger.info('[webhooks] dead-letter retry job started');
  scheduleNext();
}

/**
 * Stop the background job.  Intended for graceful shutdown and test isolation.
 */
export function stopDeadLetterRetryJob(): void {
  _stopped = true;
  if (_nextTimeout !== null) {
    clearTimeout(_nextTimeout);
    _nextTimeout = null;
  }
}

/**
 * Expose internal state for testing.
 */
export function isDeadLetterJobRunning(): boolean {
  return _nextTimeout !== null;
}
