/**
 * eventBatchProcessor.ts
 *
 * Shared batch-fetch and event processing logic used by both reindexService
 * and replayService. Provides:
 *   - Batched fetching from Soroban RPC with configurable batch size
 *   - Event normalization and deterministic ordering
 *   - Duplicate-safe insertion via INSERT OR IGNORE
 *   - Progress tracking and audit logging
 *
 * This module contains the core event processing pipeline without any
 * cursor management logic, making it suitable for both full reindex
 * (which updates the cursor) and targeted replay (which does not).
 */

import { server } from './stellar';
import { scValToNative } from '@stellar/stellar-sdk';
import config from '../config';
import { getDb } from '../db';
import { normalizePayload, normalizeEventId } from './indexer';
import { normalizeAndSortEvents, type RawIndexerEvent } from './eventOrdering';
import { logAuditEvent } from './audit';
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
    adminWallet,
    onProgress,
  } = options;

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
              logger.debug(`[batchProcessor] inserted eventId=${eventId}`);
            }
          }
          return batchInserted;
        },
      );

      eventsInserted += insertBatch(ordered);

      const ledgersProcessed = batchEnd - fromLedger + 1;

      logger.info(
        `[batchProcessor] batch done ledgers=${currentBatchStart}-${batchEnd} ` +
        `batchSize=${batchSize} eventsInserted=${eventsInserted} total`,
      );

      if (onProgress) {
        onProgress({
          ledgersProcessed,
          ledgersTotal: toLedger - fromLedger + 1,
          eventsInserted,
          currentBatchStart,
          currentBatchEnd,
        });
      }

      currentBatchStart = batchEnd + 1;

      // Throttle between batches if configured
      if (batchDelayMs > 0 && currentBatchStart <= toLedger) {
        await _delay(batchDelayMs);
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
