/**
 * reindexService.ts
 *
 * Robust event backfill system that replays Soroban contract events for a
 * specific ledger range, with:
 *   - Batched fetching (100 ledgers/batch, 50 ms inter-batch delay)
 *   - Duplicate-safe insertion via UNIQUE(tx_hash, event_index)
 *   - Deterministic ordering via eventOrdering (#1111)
 *   - Live progress tracking exposed through getReindexStatus()
 *   - Audit log entries for reindex_started and reindex_completed
 *   - Catch-up mode: when ledger lag exceeds CATCHUP_THRESHOLD, batch size
 *     widens to CATCHUP_BATCH_SIZE and the inter-batch delay drops to 0.
 *     Returns to steady-state parameters once caught up.
 *
 * Design notes:
 *   • Only one reindex job may run at a time (singleton guard).
 *   • The job runs in the background (fire-and-forget); callers poll status.
 *   • Uses eventBatchProcessor for the core fetch/normalize/insert pipeline.
 *   • RPC 429/rate-limit responses trigger a backoff regardless of mode.
 */

import { processEventBatches, type BatchProcessorProgress } from './eventBatchProcessor';
import { persistLastIndexedLedger } from '../db';
import { logAuditEvent } from './audit';
import { logger } from '../utils/logger';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Ledger range limit enforced at the API layer (10 000). */
export const MAX_REINDEX_RANGE = 10_000;

// ── Catch-up mode parameters ──────────────────────────────────────────────────
//
// When ledger lag (remaining ledgers) exceeds CATCHUP_THRESHOLD the batch loop
// switches into catch-up mode: larger batch and zero inter-batch delay.
//
// All values come from config.reindex (REINDEX_* environment variables,
// validated at startup) so operators can tune without a code change.

/** Hard ceiling on catch-up batch size to keep individual RPC responses sane. */
const MAX_ALLOWED_CATCHUP_BATCH_SIZE = 1_000;

/**
 * Remaining-ledger threshold above which catch-up mode activates.
 * Configurable via REINDEX_CATCHUP_THRESHOLD (default: 500).
 */
function getCatchupThreshold(): number {
  return config.reindex.catchupThreshold;
}

/**
 * Batch size used in catch-up mode.
 * Configurable via REINDEX_CATCHUP_BATCH_SIZE (default: 500).
 * Hard-capped at MAX_ALLOWED_CATCHUP_BATCH_SIZE.
 */
function getCatchupBatchSize(): number {
  return Math.min(config.reindex.catchupBatchSize, MAX_ALLOWED_CATCHUP_BATCH_SIZE);
}

/**
 * Normal steady-state batch size.
 * Configurable via REINDEX_BATCH_SIZE (default: 100).
 */
function getSteadyBatchSize(): number {
  return config.reindex.batchSize;
}

/**
 * Normal steady-state inter-batch delay in ms.
 * Configurable via REINDEX_BATCH_DELAY_MS (default: 50).
 */
function getSteadyBatchDelay(): number {
  return config.reindex.batchDelayMs;
}

/**
 * Backoff delay applied after an RPC 429 (rate-limit) error, regardless of mode.
 * Configurable via REINDEX_RATE_LIMIT_BACKOFF_MS (default: 2 000).
 */
function getRateLimitBackoffMs(): number {
  return config.reindex.rateLimitBackoffMs;
}

/** Determine whether an error is an RPC rate-limit response. */
function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|rate.?limit|too many requests/i.test(msg);
}

export type IndexerMode = 'steady' | 'catchup';

// ── Status ────────────────────────────────────────────────────────────────────

export type ReindexStatus = 'idle' | 'running' | 'complete' | 'error' | 'cancelled';

export interface ReindexState {
  status: ReindexStatus;
  fromLedger: number;
  toLedger: number;
  ledgersProcessed: number;
  ledgersTotal: number;
  eventsInserted: number;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  /** Current operating mode — updated on each mode transition. */
  mode: IndexerMode;
  /** Admin wallet that requested cancellation, if the job was cancelled. */
  cancelledBy?: string;
  /** Last ledger processed before the job completed or was cancelled. */
  lastProcessedLedger?: number;
}

const initialState = (): ReindexState => ({
  status: 'idle',
  fromLedger: 0,
  toLedger: 0,
  ledgersProcessed: 0,
  ledgersTotal: 0,
  eventsInserted: 0,
  startedAt: null,
  completedAt: null,
  errorMessage: null,
  mode: 'steady',
});

let _state: ReindexState = initialState();

/** Return a read-only snapshot of the current reindex state. */
export function getReindexStatus(): Readonly<ReindexState> {
  return { ..._state };
}

/** Reset state — used in tests only. */
export function _resetReindexState(): void {
  _state = initialState();
  _cancelFlag = false;
}

// ── Cancellation ──────────────────────────────────────────────────────────────

/**
 * Module-level cancel flag. The batch loop checks this between batches.
 * NOTE: This is a process-local flag. For horizontally-scaled deployments a
 * shared-storage flag (e.g. Redis key) would be needed — see issue description.
 */
let _cancelFlag = false;

/**
 * Request cancellation of the currently running reindex job.
 *
 * The job loop checks this flag after each batch; cancellation takes effect
 * within one batch iteration (≤ BATCH_SIZE ledgers).
 *
 * @returns true if a running job was found and flagged for cancellation;
 *          false if no job is currently running.
 */
export function cancelReindex(adminWallet: string): boolean {
  if (_state.status !== 'running') {
    return false;
  }
  _cancelFlag = true;
  // Record who requested cancellation in state so the audit log captures it.
  _state = { ..._state, cancelledBy: adminWallet };
  logger.info(`[reindex] cancellation requested by admin=${adminWallet}`);
  return true;
}

// ── Core background job ───────────────────────────────────────────────────────

/**
 * Start a background reindex job for the ledger range [fromLedger, toLedger].
 *
 * Returns immediately. Callers poll `getReindexStatus()` for progress.
 * Throws synchronously if a job is already running (caller must check status
 * before calling).
 *
 * @param fromLedger  - First ledger to replay (inclusive).
 * @param toLedger    - Last ledger to replay (inclusive).
 * @param adminWallet - Wallet of the admin who triggered the reindex (for audit).
 */
export function startReindex(
  fromLedger: number,
  toLedger: number,
  adminWallet: string,
): void {
  if (_state.status === 'running') {
    throw new ReindexAlreadyRunningError('A reindex job is already in progress.');
  }

  _cancelFlag = false; // reset any stale cancel flag from a previous job

  _state = {
    status: 'running',
    fromLedger,
    toLedger,
    ledgersProcessed: 0,
    ledgersTotal: toLedger - fromLedger + 1,
    eventsInserted: 0,
    startedAt: new Date().toISOString(),
    completedAt: null,
    errorMessage: null,
    mode: 'steady',
  };

  logAuditEvent({
    action: 'reindex_started',
    adminWallet,
    queryParams: { fromLedger, toLedger },
    timestamp: _state.startedAt!,
  }).catch(() => {});

  logger.info(`[reindex] started fromLedger=${fromLedger} toLedger=${toLedger} admin=${adminWallet}`);

  // Fire-and-forget — errors are caught inside _runReindex.
  _runReindex(fromLedger, toLedger, adminWallet).catch((err: unknown) => {
    logger.error(`[reindex] unexpected error in background job: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function _runReindex(
  fromLedger: number,
  toLedger: number,
  adminWallet: string,
): Promise<void> {
  let currentMode: IndexerMode = 'steady';

  try {
    const result = await processEventBatches({
      fromLedger,
      toLedger,
      batchSize: getSteadyBatchSize(),
      batchDelayMs: getSteadyBatchDelay(),
      adminWallet,
      onProgress: (progress: BatchProcessorProgress) => {
        _state = {
          ..._state,
          ledgersProcessed: progress.ledgersProcessed,
          eventsInserted: progress.eventsInserted,
          mode: currentMode,
        };
      },
      // Dynamic batch sizing based on catch-up mode
      getBatchSize: (remainingLedgers: number) => {
        const threshold = getCatchupThreshold();
        const newMode: IndexerMode = remainingLedgers > threshold ? 'catchup' : 'steady';
        if (newMode !== currentMode) {
          logger.info(
            `[reindex] mode transition: ${currentMode} -> ${newMode} ` +
            `(remaining=${remainingLedgers}, threshold=${threshold})`,
          );
          currentMode = newMode;
          _state = { ..._state, mode: currentMode };
        }
        return currentMode === 'catchup' ? getCatchupBatchSize() : getSteadyBatchSize();
      },
      // Dynamic delay: steady mode waits, catch-up mode has no delay
      getBatchDelay: () => {
        return currentMode === 'steady' ? getSteadyBatchDelay() : 0;
      },
      // Hook for cancellation
      shouldCancel: () => _cancelFlag,
      // Hook for rate-limit detection
      isRateLimitError,
      rateLimitBackoffMs: getRateLimitBackoffMs(),
    });

    if (result.error === 'cancelled') {
      const cancelledAt = new Date().toISOString();
      // The last processed ledger is derived from ledgersProcessed
      const lastLedger = fromLedger + result.ledgersProcessed - 1;
      logger.info(
        `[reindex] cancelled at ledger=${lastLedger} eventsInserted=${result.eventsInserted} admin=${adminWallet}`,
      );
      _state = {
        ..._state,
        status: 'cancelled',
        completedAt: cancelledAt,
        lastProcessedLedger: lastLedger,
        errorMessage: null,
      };
      logAuditEvent({
        action: 'reindex_cancelled',
        adminWallet: _state.cancelledBy ?? adminWallet,
        queryParams: {
          fromLedger,
          toLedger,
          lastProcessedLedger: lastLedger,
          eventsInserted: result.eventsInserted,
        },
        timestamp: cancelledAt,
      }).catch(() => {});
      return;
    }

    if (result.error) {
      throw new Error(result.error);
    }

    // Update the indexer's last_ledger so the normal poll loop resumes from
    // the correct position after the reindex completes.
    persistLastIndexedLedger(toLedger + 1);

    const completedAt = new Date().toISOString();
    _state = {
      ..._state,
      status: 'complete',
      ledgersProcessed: result.ledgersProcessed,
      eventsInserted: result.eventsInserted,
      completedAt,
      errorMessage: null,
    };

    logAuditEvent({
      action: 'reindex_completed',
      adminWallet,
      queryParams: { fromLedger, toLedger, eventsInserted: result.eventsInserted },
      timestamp: completedAt,
    }).catch(() => {});

    logger.info(
      `[reindex] completed fromLedger=${fromLedger} toLedger=${toLedger} eventsInserted=${result.eventsInserted}`,
    );
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    _state = {
      ..._state,
      status: 'error',
      completedAt: new Date().toISOString(),
      errorMessage,
    };

    logAuditEvent({
      action: 'reindex_error',
      adminWallet,
      queryParams: { fromLedger, toLedger, error: errorMessage },
      timestamp: new Date().toISOString(),
    }).catch(() => {});

    logger.error(`[reindex] failed: ${errorMessage}`);
  }
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class ReindexAlreadyRunningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReindexAlreadyRunningError';
  }
}
