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
 *   • normalizePayload / normalizeEventId from indexer.ts are reused so
 *     deduplication semantics are identical to the normal polling loop.
 *   • RPC 429/rate-limit responses trigger a backoff regardless of mode.
 */

import { server } from './stellar';
import { scValToNative } from '@stellar/stellar-sdk';
import config from '../config';
import { getDb, persistLastIndexedLedger } from '../db';
import { normalizePayload, normalizeEventId } from './indexer';
import { normalizeAndSortEvents, type RawIndexerEvent } from './eventOrdering';
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
// All values are configurable via environment variables so operators can tune
// without a code change.

/** Hard ceiling on catch-up batch size to keep individual RPC responses sane. */
const MAX_ALLOWED_CATCHUP_BATCH_SIZE = 1_000;

/**
 * Remaining-ledger threshold above which catch-up mode activates.
 * Configurable via REINDEX_CATCHUP_THRESHOLD (default: 500).
 */
function getCatchupThreshold(): number {
  return parseInt(process.env.REINDEX_CATCHUP_THRESHOLD ?? '500', 10);
}

/**
 * Batch size used in catch-up mode.
 * Configurable via REINDEX_CATCHUP_BATCH_SIZE (default: 500).
 * Hard-capped at MAX_ALLOWED_CATCHUP_BATCH_SIZE.
 */
function getCatchupBatchSize(): number {
  const raw = parseInt(process.env.REINDEX_CATCHUP_BATCH_SIZE ?? '500', 10);
  return Math.min(raw, MAX_ALLOWED_CATCHUP_BATCH_SIZE);
}

/**
 * Normal steady-state batch size.
 * Configurable via REINDEX_BATCH_SIZE (default: 100).
 */
function getSteadyBatchSize(): number {
  return parseInt(process.env.REINDEX_BATCH_SIZE ?? '100', 10);
}

/**
 * Normal steady-state inter-batch delay in ms.
 * Configurable via REINDEX_BATCH_DELAY_MS (default: 50).
 */
function getSteadyBatchDelay(): number {
  return parseInt(process.env.REINDEX_BATCH_DELAY_MS ?? '50', 10);
}

/**
 * Backoff delay applied after an RPC 429 (rate-limit) error, regardless of mode.
 * Configurable via REINDEX_RATE_LIMIT_BACKOFF_MS (default: 2 000).
 */
function getRateLimitBackoffMs(): number {
  return parseInt(process.env.REINDEX_RATE_LIMIT_BACKOFF_MS ?? '2000', 10);
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
  const db = getDb();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO events
      (type, ledger, tx_hash, payload, created_at, tx_application_order, event_index, contract_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let eventsInserted = 0;
  let currentBatchStart = fromLedger;
  let currentMode: IndexerMode = 'steady';

  try {
    while (currentBatchStart <= toLedger) {
      const remaining = toLedger - currentBatchStart + 1;
      const threshold = getCatchupThreshold();

      // ── Mode selection ────────────────────────────────────────────────────
      const newMode: IndexerMode = remaining > threshold ? 'catchup' : 'steady';
      if (newMode !== currentMode) {
        logger.info(
          `[reindex] mode transition: ${currentMode} -> ${newMode} ` +
          `(remaining=${remaining}, threshold=${threshold})`,
        );
        currentMode = newMode;
        _state = { ..._state, mode: currentMode };
      }

      const batchSize = currentMode === 'catchup' ? getCatchupBatchSize() : getSteadyBatchSize();
      const batchEnd = Math.min(currentBatchStart + batchSize - 1, toLedger);

      let batchEvents: Awaited<ReturnType<typeof server.getEvents>>['events'] = [];
      try {
        const response = await server.getEvents({
          startLedger: currentBatchStart,
          filters: [{ type: 'contract', contractIds: [config.registerContractId] }],
        });
        batchEvents = response.events.filter(
          (e: (typeof response.events)[number]) => e.ledger >= currentBatchStart && e.ledger <= batchEnd,
        );
      } catch (rpcErr: unknown) {
        if (isRateLimitError(rpcErr)) {
          // RPC 429: back off regardless of mode, then retry the same batch.
          const backoff = getRateLimitBackoffMs();
          logger.warn(
            `[reindex] rate-limited (mode=${currentMode}), backing off ${backoff}ms ` +
            `(ledger ${currentBatchStart}-${batchEnd})`,
          );
          await _delay(backoff);
          continue; // retry without advancing currentBatchStart
        }
        logger.warn(
          `[reindex] RPC error on ledger batch ${currentBatchStart}-${batchEnd}: ${
            rpcErr instanceof Error ? rpcErr.message : String(rpcErr)
          }`,
        );
        // Non-rate-limit errors: continue to next batch (partial failures don't abort the job).
      }

      const rawEvents: RawIndexerEvent[] = batchEvents.map((raw: any) => ({
        ledger: raw.ledger,
        txHash: raw.txHash,
        id: raw.id,
        contractId: raw.contractId ?? config.registerContractId,
        topic: raw.topic,
        value: raw.value,
        ledgerClosedAt: raw.ledgerClosedAt,
        txIndex: raw.txIndex,
        eventIndex: raw.eventIndex,
      }));
      const ordered = normalizeAndSortEvents(rawEvents, config.registerContractId);

      // Insert events from this batch in a single transaction, in total order.
      const insertBatch = db.transaction(
        (events: typeof ordered) => {
          let batchInserted = 0;
          for (const event of events) {
            const raw = event.raw as any;
            const type = raw.topic?.[0] ? (scValToNative(raw.topic[0]) as string) : '';
            const payload = normalizePayload(
              (raw.value ? (scValToNative(raw.value) as Record<string, unknown>) : {}) ?? {},
            );
            const eventId = normalizeEventId(
              event.contractId,
              event.ledger,
              event.txHash,
              event.eventIndex,
            );
            const createdAt = raw.ledgerClosedAt
              ? new Date(raw.ledgerClosedAt).getTime()
              : Date.now();

            const result = insert.run(
              type,
              event.ledger,
              event.txHash,
              JSON.stringify(payload),
              createdAt,
              event.txApplicationOrder,
              event.eventIndex,
              event.contractId,
            );
            if (result.changes === 1) {
              batchInserted++;
              logger.debug(`[reindex] inserted eventId=${eventId}`);
            }
          }
          return batchInserted;
        },
      );

      eventsInserted += insertBatch(ordered);

      const ledgersProcessed = batchEnd - fromLedger + 1;
      _state = {
        ..._state,
        ledgersProcessed,
        eventsInserted,
        mode: currentMode,
      };

      logger.info(
        `[reindex] batch done ledgers=${currentBatchStart}-${batchEnd} ` +
        `mode=${currentMode} batchSize=${batchSize} eventsInserted=${eventsInserted} total`,
      );

      currentBatchStart = batchEnd + 1;

      // Throttle: steady mode waits between batches; catch-up mode has no delay.
      const delayMs = currentMode === 'steady' ? getSteadyBatchDelay() : 0;
      if (delayMs > 0 && currentBatchStart <= toLedger) {
        await _delay(delayMs);
      }

      // ── Cooperative cancellation check-point ──────────────────────────────
      // Check the cancel flag AFTER the delay so the cancellation point is
      // well-defined: one full batch is always completed before stopping.
      if (_cancelFlag) {
        const cancelledAt = new Date().toISOString();
        const lastLedger = batchEnd;
        logger.info(
          `[reindex] cancelled at ledger=${lastLedger} eventsInserted=${eventsInserted} admin=${adminWallet}`,
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
            eventsInserted,
          },
          timestamp: cancelledAt,
        }).catch(() => {});
        return;
      }
    }

    // Update the indexer's last_ledger so the normal poll loop resumes from
    // the correct position after the reindex completes.
    persistLastIndexedLedger(toLedger + 1);

    const completedAt = new Date().toISOString();
    _state = {
      ..._state,
      status: 'complete',
      ledgersProcessed: _state.ledgersTotal,
      completedAt,
      errorMessage: null,
    };

    logAuditEvent({
      action: 'reindex_completed',
      adminWallet,
      queryParams: { fromLedger, toLedger, eventsInserted },
      timestamp: completedAt,
    }).catch(() => {});

    logger.info(
      `[reindex] completed fromLedger=${fromLedger} toLedger=${toLedger} eventsInserted=${eventsInserted}`,
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function _delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class ReindexAlreadyRunningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReindexAlreadyRunningError';
  }
}
