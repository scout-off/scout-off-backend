/**
 * Tests for issue #1588 — direct coverage for src/services/eventBatchProcessor.ts.
 *
 * Mocks the Stellar RPC server.getEvents; uses the real in-memory SQLite DB
 * (via tests setup) and the real normalizeAndSortEvents for ordering checks.
 */

const mockGetEvents = jest.fn();
const mockLogAuditEvent = jest.fn().mockResolvedValue(undefined);

jest.mock('../../src/services/stellar', () => ({
  server: {
    getEvents: (...args: unknown[]) => mockGetEvents(...args),
  },
}));

jest.mock('../../src/services/audit', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
}));

// Lightweight indexer mocks so tests don't need full SDK ScVal round-trips.
// Ordering itself still uses the real normalizeAndSortEvents (eventOrdering.ts).
jest.mock('../../src/services/indexer', () => ({
  normalizeEventId: (...parts: unknown[]) => (parts as string[]).join(':'),
  normalizeSorobanEvent: (raw: { topic?: unknown; value?: unknown; txHash?: string }) => ({
    type: 'test_event',
    payload: { txHash: (raw as { txHash?: string }).txHash ?? 'unknown' },
  }),
}));

import { processEventBatches } from '../../src/services/eventBatchProcessor';
import { normalizeAndSortEvents } from '../../src/services/eventOrdering';

let txCounter = 0;
function uniqueTx(prefix: string): string {
  txCounter += 1;
  return `${prefix}${txCounter}`.padEnd(64, '0').slice(0, 64);
}

function makeRaw(overrides: Record<string, unknown> = {}) {
  return {
    ledger: 100,
    txHash: uniqueTx('tx'),
    id: '100-0-0',
    contractId: 'CCONTRACT',
    topic: ['test_event'],
    value: {},
    ledgerClosedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    txIndex: 0,
    eventIndex: 0,
    ...overrides,
  };
}

function cleanEvents() {
  const { getDb } = require('../../src/db');
  getDb().exec('DELETE FROM events');
}

function readEventsOrdered(): Array<{ ledger: number; tx_hash: string; event_index: number }> {
  const { getDb } = require('../../src/db');
  return getDb()
    .prepare(
      'SELECT ledger, tx_hash, event_index FROM events ORDER BY ledger ASC, tx_application_order ASC, event_index ASC, contract_id ASC',
    )
    .all();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLogAuditEvent.mockResolvedValue(undefined);
  cleanEvents();
});

describe('processEventBatches batching', () => {
  it('makes a single RPC call for a range smaller than the batch size', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });
    const result = await processEventBatches({
      fromLedger: 1000,
      toLedger: 1009,
      batchSize: 50,
      batchDelayMs: 0,
      adminWallet: 'GADMIN',
    });
    expect(mockGetEvents).toHaveBeenCalledTimes(1);
    expect(mockGetEvents).toHaveBeenCalledWith(expect.objectContaining({ startLedger: 1000 }));
    expect(result.error).toBeUndefined();
    expect(result.ledgersProcessed).toBe(10);
  });

  it('spans three batches with the correct startLedger values and no gaps or overlaps', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });
    const onProgress = jest.fn();
    const result = await processEventBatches({
      fromLedger: 1,
      toLedger: 300,
      batchSize: 100,
      batchDelayMs: 0,
      adminWallet: 'GADMIN',
      onProgress,
    });
    const starts = mockGetEvents.mock.calls.map((c: unknown[]) => (c[0] as { startLedger: number }).startLedger);
    expect(starts).toEqual([1, 101, 201]);
    expect(result.ledgersProcessed).toBe(300);
    // Progress covers every ledger exactly once: 100 + 100 + 100.
    const last = onProgress.mock.calls[onProgress.mock.calls.length - 1][0];
    expect(last.ledgersProcessed).toBe(300);
    expect(last.ledgersTotal).toBe(300);
  });

  it('inserts out-of-order events in deterministic order (matches normalizeAndSortEvents)', async () => {
    const raws = [
      makeRaw({ ledger: 500, txHash: uniqueTx('aaa'), txIndex: 2, eventIndex: 0 }),
      makeRaw({ ledger: 500, txHash: uniqueTx('bbb'), txIndex: 0, eventIndex: 0 }),
      makeRaw({ ledger: 500, txHash: uniqueTx('ccc'), txIndex: 1, eventIndex: 0 }),
    ];
    // Return them out of order; the processor must still insert deterministically.
    mockGetEvents.mockResolvedValue({ events: [raws[0], raws[2], raws[1]] });
    await processEventBatches({
      fromLedger: 500,
      toLedger: 500,
      batchSize: 100,
      batchDelayMs: 0,
      adminWallet: 'GADMIN',
    });
    const expected = normalizeAndSortEvents(raws, 'CCONTRACT').map((e) => e.txHash);
    const actual = readEventsOrdered().map((r) => r.tx_hash);
    expect(actual).toEqual(expected);
  });

  it('inserts duplicate events across batches once (INSERT OR IGNORE)', async () => {
    const dup = makeRaw({ ledger: 300, txHash: uniqueTx('dup'), txIndex: 0, eventIndex: 0 });
    mockGetEvents.mockResolvedValue({ events: [dup] });
    const first = await processEventBatches({
      fromLedger: 300,
      toLedger: 300,
      batchSize: 100,
      batchDelayMs: 0,
      adminWallet: 'GADMIN',
    });
    const second = await processEventBatches({
      fromLedger: 300,
      toLedger: 300,
      batchSize: 100,
      batchDelayMs: 0,
      adminWallet: 'GADMIN',
    });
    expect(first.eventsInserted).toBe(1);
    expect(second.eventsInserted).toBe(0);
    expect(readEventsOrdered().filter((r) => r.tx_hash === dup.txHash)).toHaveLength(1);
  });

  it('moves on to the next batch when a batch returns no events', async () => {
    const later = makeRaw({ ledger: 150, txHash: uniqueTx('later'), txIndex: 0, eventIndex: 0 });
    mockGetEvents
      .mockResolvedValueOnce({ events: [] })
      .mockResolvedValueOnce({ events: [later] });
    const result = await processEventBatches({
      fromLedger: 100,
      toLedger: 199,
      batchSize: 100,
      batchDelayMs: 0,
      adminWallet: 'GADMIN',
    });
    expect(mockGetEvents).toHaveBeenCalledTimes(2);
    expect(result.error).toBeUndefined();
    expect(result.eventsInserted).toBe(1);
  });

  it('skips a batch on RPC error and continues (per-batch failures do not propagate)', async () => {
    // Contract documented here: RPC errors are logged and the processor moves
    // to the next batch; the job still completes without `error` set.
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
    expect(result.ledgersProcessed).toBe(200);
  });

  it('calls onProgress after each batch with correct counts; audit hook gap documented', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });
    const onProgress = jest.fn();
    await processEventBatches({
      fromLedger: 1,
      toLedger: 250,
      batchSize: 100,
      batchDelayMs: 0,
      adminWallet: 'GADMIN',
      onProgress,
    });
    // 3 batches: [1..100], [101..200], [201..250]
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress.mock.calls[0][0]).toMatchObject({
      ledgersProcessed: 100,
      ledgersTotal: 250,
      currentBatchStart: 1,
      currentBatchEnd: 100,
    });
    expect(onProgress.mock.calls[2][0]).toMatchObject({
      ledgersProcessed: 250,
      ledgersTotal: 250,
      currentBatchStart: 201,
      currentBatchEnd: 250,
    });
    // Gap: logAuditEvent is imported by eventBatchProcessor.ts but never
    // called — progress reporting goes through onProgress only.
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });
});
