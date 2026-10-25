/**
 * eventBatchProcessor.ts
 *
 * Shared batch-fetch and event processing logic used by both reindexService
 * and replayService. Provides:
 *   - Batched fetching from Soroban RPC with configurable batch size
 *   - Event normalization and deterministic ordering
 *   - Duplicate-safe insertion via INSERT OR IGNORE
 *   - Progress tracking and audit logging
 *   - Support for dynamic batch sizing (catch-up mode)
 *   - Support for cancellation
 *   - Support for rate-limit backoff
 *
 * This module contains the core event processing pipeline without any
 * cursor management logic, making it suitable for both full reindex
 * (which updates the cursor) and targeted replay (which does not).
 */

import { server } from './stellar';
import config from '../config';
import { getDb } from '../db';
import { normalizeEventId, normalizeSorobanEvent, getIndexedContractIds } from './indexer';
import { normalizeAndSortEvents, type RawIndexerEvent } from './eventOrdering';
import { logger } from '../utils/logger';

export interface BatchProcessorOptions {
  /** First ledger to replay (inclusive). */
  fromLedger: number;
  /** Last ledger to replay (inclusive). */
  toLedger: number;
  /** Number of ledgers to fetch per RPC call. */
  batchSize: number;
  /** Delay in ms between batches (0 for no delay). */
  batchDelayMs: number;
  /** Admin wallet for audit logging. */
  adminWallet: string;
  /** Optional progress callback called after each batch. */
  onProgress?: (progress: BatchProcessorProgress) => void;
  /** Contract IDs to fetch events from. Defaults to the full indexed contract list. */
  contractIds?: string[];
  /** Optional function to dynamically compute batch size based on remaining ledgers. */
  getBatchSize?: (remainingLedgers: number) => number;
  /** Optional function to dynamically compute batch delay based on current batch state. */
  getBatchDelay?: (currentBatchStart: number, remainingLedgers: number) => number;
  /** Optional hook called after each batch completes (for cursor persistence, etc.). */
  onBatchComplete?: (lastLedger: number, eventsInserted: number) => void | Promise<void>;
  /** Optional hook to check if the job should be cancelled. */
  shouldCancel?: () => boolean;
  /** Optional function to detect rate-limit errors (for backoff logic). */
  isRateLimitError?: (err: unknown) => boolean;
  /** Backoff delay in ms when a rate-limit error is detected. */
  rateLimitBackoffMs?: number;
}

export interface BatchProcessorProgress {
  ledgersProcessed: number;
  ledgersTotal: number;
  eventsInserted: number;
  currentBatchStart: number;
  currentBatchEnd: number;
}

export interface BatchProcessorResult {
  eventsInserted: number;
  ledgersProcessed: number;
  error?: string;
}

/**
 * Process events for a ledger range using batched RPC fetches.
 *
 * This function:
 *   - Fetches events in batches from the Soroban RPC
 *   - Normalizes and sorts events deterministically
 *   - Inserts events using INSERT OR IGNORE (duplicate-safe)
 *   - Calls the progress callback after each batch
 *   - Does NOT modify the indexer cursor (persistLastIndexedLedger)
 *   - Supports dynamic batch sizing and delays via hooks
 *   - Supports cancellation via shouldCancel hook
 *   - Supports rate-limit backoff via isRateLimitError hook
 *
 * @param options - Configuration for the batch processor
 * @returns Result with count of newly inserted events
 */
export async function processEventBatches(
  options: BatchProcessorOptions,
): Promise<BatchProcessorResult> {
  const {
    fromLedger,
    toLedger,
    batchSize,
    batchDelayMs,
    onProgress,
    contractIds: explicitContractIds,
    getBatchSize,
    getBatchDelay,
    onBatchComplete,
    shouldCancel,
    isRateLimitError,
    rateLimitBackoffMs = 2000,
  } = options;

  const contractIds = explicitContractIds ?? getIndexedContractIds();
  const primaryContractId = contractIds.length > 0 ? contractIds[0] : config.registerContractId;
  const db = getDb();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO events
      (type, ledger, tx_hash, payload, created_at, tx_application_order, event_index, contract_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let eventsInserted = 0;
  let currentBatchStart = fromLedger;

  try {
    while (currentBatchStart <= toLedger) {
      // Check for cancellation before processing the batch
      if (shouldCancel?.()) {
        logger.info(`[batchProcessor] cancelled at ledger=${currentBatchStart}`);
        return {
          eventsInserted,
          ledgersProcessed: currentBatchStart - fromLedger,
          error: 'cancelled',
        };
      }

      const remaining = toLedger - currentBatchStart + 1;
      const dynamicBatchSize = getBatchSize ? getBatchSize(remaining) : batchSize;
      const batchEnd = Math.min(currentBatchStart + dynamicBatchSize - 1, toLedger);

      let batchEvents: Awaited<ReturnType<typeof server.getEvents>>['events'] = [];
      try {
        const response = await server.getEvents({
          startLedger: currentBatchStart,
          filters: [{ type: 'contract', contractIds: contractIds.length ? contractIds : [primaryContractId] }],
        });
        batchEvents = response.events.filter(
          (e: (typeof response.events)[number]) => e.ledger >= currentBatchStart && e.ledger <= batchEnd,
        );
      } catch (rpcErr: unknown) {
        if (isRateLimitError?.(rpcErr)) {
          // Rate-limit error: back off and retry the same batch
          logger.warn(
            `[batchProcessor] rate-limited, backing off ${rateLimitBackoffMs}ms ` +
            `(ledger ${currentBatchStart}-${batchEnd})`,
          );
          await _delay(rateLimitBackoffMs);
          continue; // retry without advancing currentBatchStart
        }
        logger.warn(
          `[batchProcessor] RPC error on ledger batch ${currentBatchStart}-${batchEnd}: ${
            rpcErr instanceof Error ? rpcErr.message : String(rpcErr)
          }`,
        );
        // Continue to next batch (partial failures don't abort the job)
      }

      const rawEvents: RawIndexerEvent[] = batchEvents.map((raw: any) => ({
        ledger: raw.ledger,
        txHash: raw.txHash,
        id: raw.id,
        contractId: raw.contractId ?? primaryContractId,
        topic: raw.topic,
        value: raw.value,
        ledgerClosedAt: raw.ledgerClosedAt,
        txIndex: raw.txIndex,
        eventIndex: raw.eventIndex,
      }));
      const ordered = normalizeAndSortEvents(rawEvents, primaryContractId);

      // Insert events from this batch in a single transaction, in total order.
      const insertBatch = db.transaction(
        (events: typeof ordered) => {
          let batchInserted = 0;
          for (const event of events) {
            const raw = event.raw as any;
            const { type, payload } = normalizeSorobanEvent(raw);
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
              logger.debug(`[batchProcessor] inserted eventId=${eventId}`);
            }
          }
          return batchInserted;
        },
      );

      const batchInserted = insertBatch(ordered);
      eventsInserted += batchInserted;

      const ledgersProcessed = batchEnd - fromLedger + 1;

      logger.info(
        `[batchProcessor] batch done ledgers=${currentBatchStart}-${batchEnd} ` +
        `batchSize=${dynamicBatchSize} eventsInserted=${eventsInserted} total`,
      );

      // Call onBatchComplete hook for cursor persistence, etc.
      if (onBatchComplete) {
        await onBatchComplete(batchEnd, batchInserted);
      }

      if (onProgress) {
        onProgress({
          ledgersProcessed,
          ledgersTotal: toLedger - fromLedger + 1,
          eventsInserted,
          currentBatchStart,
          currentBatchEnd: batchEnd,
        });
      }

      currentBatchStart = batchEnd + 1;

      // Throttle between batches
      const dynamicDelay = getBatchDelay ? getBatchDelay(currentBatchStart, toLedger - currentBatchStart + 1) : batchDelayMs;
      if (dynamicDelay > 0 && currentBatchStart <= toLedger) {
        await _delay(dynamicDelay);
      }
    }

    return {
      eventsInserted,
      ledgersProcessed: toLedger - fromLedger + 1,
    };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(`[batchProcessor] failed: ${errorMessage}`);
    return {
      eventsInserted,
      ledgersProcessed: currentBatchStart - fromLedger,
      error: errorMessage,
    };
  }
}

function _delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
