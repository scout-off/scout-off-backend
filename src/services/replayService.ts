/**
 * replayService.ts
 *
 * Targeted event replay for small ledger ranges without touching the main
 * indexer cursor. This provides a surgical tool for fixing narrow historical
 * gaps (e.g., "we think ledgers 500123-500130 were missed") while the indexer
 * is live near tip.
 *
 * Key differences from reindexService:
 *   - Maximum range is 200 ledgers (vs 10,000 for reindex)
 *   - Does NOT call persistLastIndexedLedger (cursor remains unchanged)
 *   - No catch-up mode (always uses steady-state batch size)
 *   - No cancellation (small ranges complete quickly)
 *   - Returns count of newly inserted events (audited)
 *
 * Shares the batch-fetch + INSERT-OR-IGNORE logic with reindexService via
 * eventBatchProcessor.
 */

import { processEventBatches, type BatchProcessorProgress } from './eventBatchProcessor';
import { logAuditEvent } from './audit';
import { logger } from '../utils/logger';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum ledger range for targeted replay (small surgical fixes). */
export const MAX_REPLAY_RANGE = 200;

/** Default batch size for replay (same as reindex steady-state). */
const DEFAULT_BATCH_SIZE = 100;

/** Default inter-batch delay in ms (same as reindex steady-state). */
const DEFAULT_BATCH_DELAY_MS = 50;

// ── Status ────────────────────────────────────────────────────────────────────

export type ReplayStatus = 'idle' | 'running' | 'complete' | 'error';

export interface ReplayState {
  status: ReplayStatus;
  fromLedger: number;
  toLedger: number;
  ledgersProcessed: number;
  ledgersTotal: number;
  eventsInserted: number;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
}

const initialState = (): ReplayState => ({
  status: 'idle',
  fromLedger: 0,
  toLedger: 0,
  ledgersProcessed: 0,
  ledgersTotal: 0,
  eventsInserted: 0,
  startedAt: null,
  completedAt: null,
  errorMessage: null,
});

let _state: ReplayState = initialState();

/** Return a read-only snapshot of the current replay state. */
export function getReplayStatus(): Readonly<ReplayState> {
  return { ..._state };
}

/** Reset state — used in tests only. */
export function _resetReplayState(): void {
  _state = initialState();
}

// ── Core replay function ───────────────────────────────────────────────────────

/**
 * Run a targeted replay for the ledger range [fromLedger, toLedger].
 *
 * This is a synchronous function that processes the range and returns
 * the result. Unlike reindexService, it does not run in the background
 * since replay ranges are small (≤ 200 ledgers) and complete quickly.
 *
 * @param fromLedger  - First ledger to replay (inclusive).
 * @param toLedger    - Last ledger to replay (inclusive).
 * @param adminWallet - Wallet of the admin who triggered the replay (for audit).
 * @returns Result with count of newly inserted events.
 */
export async function runReplay(
  fromLedger: number,
  toLedger: number,
  adminWallet: string,
): Promise<{ eventsInserted: number; error?: string }> {
  if (_state.status === 'running') {
    throw new ReplayAlreadyRunningError('A replay job is already in progress.');
  }

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
  };

  logAuditEvent({
    action: 'replay_started',
    adminWallet,
    queryParams: { fromLedger, toLedger },
    timestamp: _state.startedAt!,
  }).catch(() => {});

  logger.info(`[replay] started fromLedger=${fromLedger} toLedger=${toLedger} admin=${adminWallet}`);

  const onProgress = (progress: BatchProcessorProgress) => {
    _state = {
      ..._state,
      ledgersProcessed: progress.ledgersProcessed,
      eventsInserted: progress.eventsInserted,
    };
  };

  const result = await processEventBatches({
    fromLedger,
    toLedger,
    batchSize: DEFAULT_BATCH_SIZE,
    batchDelayMs: DEFAULT_BATCH_DELAY_MS,
    adminWallet,
    onProgress,
  });

  const completedAt = new Date().toISOString();

  if (result.error) {
    _state = {
      ..._state,
      status: 'error',
      completedAt,
      errorMessage: result.error,
    };

    logAuditEvent({
      action: 'replay_error',
      adminWallet,
      queryParams: { fromLedger, toLedger, error: result.error },
      timestamp: completedAt,
    }).catch(() => {});

    logger.error(`[replay] failed: ${result.error}`);
    return { eventsInserted: result.eventsInserted, error: result.error };
  }

  _state = {
    ..._state,
    status: 'complete',
    ledgersProcessed: result.ledgersProcessed,
    eventsInserted: result.eventsInserted,
    completedAt,
    errorMessage: null,
  };

  logAuditEvent({
    action: 'replay_completed',
    adminWallet,
    queryParams: { fromLedger, toLedger, eventsInserted: result.eventsInserted },
    timestamp: completedAt,
  }).catch(() => {});

  logger.info(
    `[replay] completed fromLedger=${fromLedger} toLedger=${toLedger} eventsInserted=${result.eventsInserted}`,
  );

  return { eventsInserted: result.eventsInserted };
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class ReplayAlreadyRunningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayAlreadyRunningError';
  }
}
