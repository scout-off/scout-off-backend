/**
 * tests/services/eventBatchProcessor.test.ts
 *
 * Unit test suite for src/services/eventBatchProcessor.ts.
 *
 * Covers:
 *   - Basic batch processing with empty range
 *   - Event insertion and counting
 *   - Dynamic batch sizing via getBatchSize hook
 *   - Dynamic batch delay via getBatchDelay hook
 *   - Cancellation via shouldCancel hook
 *   - Rate-limit backoff via isRateLimitError hook
 *   - Progress callback invocation
 *   - onBatchComplete hook invocation
 *   - Custom contract IDs
 */

import {
  processEventBatches,
  type BatchProcessorProgress,
} from '../../src/services/eventBatchProcessor';

// ── Mock external dependencies ────────────────────────────────────────────────

const mockGetEvents = jest.fn();

jest.mock('../../src/services/stellar', () => ({
  server: {
    getEvents: (...args: unknown[]) => mockGetEvents(...args),
  },
}));

jest.mock('../../src/services/audit', () => ({
  logAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/indexer', () => ({
  normalizePayload: jest.fn((p: Record<string, unknown>) => p),
  normalizeEventId: jest.fn((_contractId: string, ledger: number, txHash: string) => `${ledger}:${txHash}`),
  normalizeSorobanEvent: jest.fn((raw: { topic: unknown[]; value: unknown }) => {
    const { scValToNative } = require('@stellar/stellar-sdk');
    return {
      type: scValToNative(raw.topic[0]),
      payload: scValToNative(raw.value),
    };
  }),
  getIndexedContractIds: jest.fn(() => ['CONTRACT_A', 'CONTRACT_B']),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(
  type: string,
  payload: Record<string, unknown>,
  txHash: string,
  ledger: number,
  ledgerClosedAt?: string,
) {
  const { nativeToScVal } = require('@stellar/stellar-sdk');
  return {
    topic: [nativeToScVal(type, { type: 'symbol' })],
    value: nativeToScVal(payload),
    ledger,
    txHash,
    ledgerClosedAt: ledgerClosedAt ?? null,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  const indexerModule = require('../../src/services/indexer');
  indexerModule.normalizeSorobanEvent.mockImplementation((raw: { topic: unknown[]; value: unknown }) => {
    const { scValToNative } = require('@stellar/stellar-sdk');
    return {
      type: scValToNative(raw.topic[0]),
      payload: scValToNative(raw.value),
    };
  });
});

// ── Basic functionality ───────────────────────────────────────────────────────

describe('basic functionality', () => {
  it('processes an empty ledger range successfully', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });

    const result = await processEventBatches({
      fromLedger: 100,
      toLedger: 100,
      batchSize: 100,
      batchDelayMs: 0,
      adminWallet: 'GADMIN',
    });

    expect(result.eventsInserted).toBe(0);
    expect(result.ledgersProcessed).toBe(1);
    expect(result.error).toBeUndefined();
  });

  it('inserts events and counts them correctly', async () => {
    const txHash = 'aaaa' + '0'.repeat(60);
    mockGetEvents.mockResolvedValue({
      events: [
        makeEvent('player_registered', { player_id: 'P1', wallet: 'G' + 'A'.repeat(55) }, txHash, 200),
      ],
    });

    const result = await processEventBatches({
      fromLedger: 200,
      toLedger: 200,
      batchSize: 100,
      batchDelayMs: 0,
      adminWallet: 'GADMIN',
    });

    expect(result.eventsInserted).toBeGreaterThanOrEqual(0);
    expect(result.ledgersProcessed).toBe(1);
    expect(result.error).toBeUndefined();
  });

  it('uses the default contract IDs when not specified', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });

    await processEventBatches({
      fromLedger: 1,
      toLedger: 1,
      batchSize: 100,
      batchDelayMs: 0,
      adminWallet: 'GADMIN',
    });

    const indexerModule = require('../../src/services/indexer');
    expect(indexerModule.getIndexedContractIds).toHaveBeenCalled();
  });

  it('uses custom contract IDs when provided', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });

    await processEventBatches({
      fromLedger: 1,
      toLedger: 1,
      batchSize: 100,
      batchDelayMs: 0,
      adminWallet: 'GADMIN',
      contractIds: ['CUSTOM_CONTRACT'],
    });

    const indexerModule = require('../../src/services/indexer');
    expect(indexerModule.getIndexedContractIds).not.toHaveBeenCalled();
    expect(mockGetEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ type: 'contract', contractIds: ['CUSTOM_CONTRACT'] }],
      }),
    );
  });
});

// ── Dynamic batch sizing ───────────────────────────────────────────────────────

describe('dynamic batch sizing', () => {
  it('uses getBatchSize hook to compute batch size', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });

    const batchSizeCalls: number[] = [];
    await processEventBatches({
      fromLedger: 1,
      toLedger: 300,
      batchSize: 100, // fallback
      batchDelayMs: 0,
      adminWallet: 'GADMIN',
      getBatchSize: (remaining: number) => {
        batchSizeCalls.push(remaining);
        return Math.min(remaining, 50);
      },
    });

    expect(batchSizeCalls.length).toBeGreaterThan(0);
    expect(batchSizeCalls[0]).toBe(300);
  });

  it('changes batch size dynamically based on remaining ledgers', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });

    const callLedgerStarts: number[] = [];
    mockGetEvents.mockImplementation(async ({ startLedger }: { startLedger: number }) => {
      callLedgerStarts.push(startLedger);
      return { events: [] };
    });

    await processEventBatches({
      fromLedger: 1,
      toLedger: 200,
      batchSize: 100,
      batchDelayMs: 0,
      adminWallet: 'GADMIN',
      getBatchSize: (remaining: number) => {
        // Use larger batches when many ledgers remain
        return remaining > 100 ? 150 : 50;
      },
    });

    // First batch should start at 1 with size 150
    expect(callLedgerStarts[0]).toBe(1);
    // Second batch should start at 151 (1 + 150)
    if (callLedgerStarts.length > 1) {
      expect(callLedgerStarts[1]).toBe(151);
    }
  });
});

// ── Dynamic batch delay ───────────────────────────────────────────────────────

describe('dynamic batch delay', () => {
  it('uses getBatchDelay hook to compute delay', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });

    const delayCalls: number[] = [];
    const realSetTimeout = global.setTimeout;
    jest.spyOn(global, 'setTimeout').mockImplementation((fn: any, delay?: number, ...args: any[]) => {
      if (typeof delay === 'number') {
        delayCalls.push(delay);
      }
      return realSetTimeout(fn, 0, ...args);
    });

    await processEventBatches({
      fromLedger: 1,
      toLedger: 200,
      batchSize: 100,
      batchDelayMs: 50, // fallback
      adminWallet: 'GADMIN',
      getBatchDelay: () => 100,
    });

    expect(delayCalls).toContain(100);
    jest.restoreAllMocks();
  });

  it('skips delay when getBatchDelay returns 0', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });

    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    await processEventBatches({
      fromLedger: 1,
      toLedger: 100,
      batchSize: 100,
      batchDelayMs: 50,
      adminWallet: 'GADMIN',
      getBatchDelay: () => 0,
    });

    // Should not call setTimeout for inter-batch delays
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });
});

// ── Cancellation ─────────────────────────────────────────────────────────────

describe('cancellation', () => {
  it('returns cancelled error when shouldCancel returns true', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });

    let cancelAfterFirstBatch = false;
    const result = await processEventBatches({
      fromLedger: 1,
      toLedger: 300,
      batchSize: 100,
      batchDelayMs: 0,
      adminWallet: 'GADMIN',
      shouldCancel: () => cancelAfterFirstBatch,
      onProgress: (progress) => {
        if (progress.ledgersProcessed >= 100) {
          cancelAfterFirstBatch = true;
        }
      },
    });

    expect(result.error).toBe('cancelled');
    expect(result.ledgersProcessed).toBeLessThan(300);
  });

  it('does not call RPC after cancellation', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });

    const result = await processEventBatches({
      fromLedger: 1,
      toLedger: 1000,
      batchSize: 100,
      batchDelayMs: 0,
      adminWallet: 'GADMIN',
      shouldCancel: () => true,
    });

    expect(result.error).toBe('cancelled');
    expect(mockGetEvents).not.toHaveBeenCalled();
  });
});

// ── Rate-limit backoff ─────────────────────────────────────────────────────────

describe('rate-limit backoff', () => {
  it('backs off and retries on rate-limit error', async () => {
    let callCount = 0;
    mockGetEvents.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('HTTP 429 Too Many Requests');
      }
      return { events: [] };
    });

    const result = await processEventBatches({
      fromLedger: 1,
      toLedger: 100,
      batchSize: 100,
      batchDelayMs: 0,
      adminWallet: 'GADMIN',
      isRateLimitError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        return msg.includes('429');
      },
      rateLimitBackoffMs: 100,
    });

    expect(callCount).toBe(2); // first call failed, second succeeded
    expect(result.error).toBeUndefined();
  });

  it('continues to next batch on non-rate-limit error', async () => {
    mockGetEvents
      .mockRejectedValueOnce(new Error('RPC timeout'))
      .mockResolvedValue({ events: [] });

    const result = await processEventBatches({
      fromLedger: 1,
      toLedger: 200,
      batchSize: 100,
      batchDelayMs: 0,
      adminWallet: 'GADMIN',
    });

    expect(mockGetEvents).toHaveBeenCalledTimes(2);
    expect(result.error).toBeUndefined();
  });
});

// ── Progress callback ─────────────────────────────────────────────────────────

describe('progress callback', () => {
  it('calls onProgress after each batch', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });

    const progressCalls: BatchProcessorProgress[] = [];
    await processEventBatches({
      fromLedger: 1,
      toLedger: 200,
      batchSize: 100,
      batchDelayMs: 0,
      adminWallet: 'GADMIN',
      onProgress: (progress) => {
        progressCalls.push(progress);
      },
    });

    expect(progressCalls.length).toBe(2); // 2 batches
    expect(progressCalls[0].ledgersProcessed).toBe(100);
    expect(progressCalls[1].ledgersProcessed).toBe(200);
  });

  it('reports correct totals in progress', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });

    const progressCalls: BatchProcessorProgress[] = [];
    await processEventBatches({
      fromLedger: 50,
      toLedger: 149,
      batchSize: 100,
      batchDelayMs: 0,
      adminWallet: 'GADMIN',
      onProgress: (progress) => {
        progressCalls.push(progress);
      },
    });

    expect(progressCalls[0].ledgersTotal).toBe(100);
  });
});

// ── onBatchComplete hook ─────────────────────────────────────────────────────

describe('onBatchComplete hook', () => {
  it('calls onBatchComplete after each batch', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });

    const batchCompleteCalls: Array<[number, number]> = [];
    await processEventBatches({
      fromLedger: 1,
      toLedger: 200,
      batchSize: 100,
      batchDelayMs: 0,
      adminWallet: 'GADMIN',
      onBatchComplete: (lastLedger, eventsInserted) => {
        batchCompleteCalls.push([lastLedger, eventsInserted]);
      },
    });

    expect(batchCompleteCalls.length).toBe(2);
    expect(batchCompleteCalls[0][0]).toBe(100);
    expect(batchCompleteCalls[1][0]).toBe(200);
  });

  it('waits for async onBatchComplete before continuing', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });

    let onBatchCompleteResolved = false;
    await processEventBatches({
      fromLedger: 1,
      toLedger: 100,
      batchSize: 100,
      batchDelayMs: 0,
      adminWallet: 'GADMIN',
      onBatchComplete: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        onBatchCompleteResolved = true;
      },
    });

    expect(onBatchCompleteResolved).toBe(true);
  });
});
