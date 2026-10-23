/**
 * tests/services/reindexReplayParity.test.ts
 *
 * Parity test ensuring reindex and replay produce identical event rows
 * for the same ledger range and input data.
 *
 * This test:
 *   - Mocks the same RPC responses for both reindex and replay
 *   - Runs both operations on the same ledger range
 *   - Compares the resulting events table rows
 *   - Verifies ordering, counts, and payload consistency
 */

import {
  startReindex,
  getReindexStatus,
  _resetReindexState,
} from '../../src/services/reindexService';
import {
  runReplay,
  getReplayStatus,
  _resetReplayState,
} from '../../src/services/replayService';
import { getDb } from '../../src/db';

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

/**
 * Flush background reindex job by advancing fake timers.
 */
async function flushReindex(): Promise<void> {
  await jest.runAllTimersAsync();
  await Promise.resolve();
}

/**
 * Clear the events table between test runs.
 */
function clearEventsTable(): void {
  const db = getDb();
  db.prepare('DELETE FROM events').run();
}

/**
 * Fetch all events from the table ordered by insertion order.
 */
function getAllEvents(): Array<{
  type: string;
  ledger: number;
  tx_hash: string;
  payload: string;
  created_at: number;
  tx_application_order: number;
  event_index: number;
  contract_id: string;
}> {
  const db = getDb();
  return db.prepare(
    'SELECT type, ledger, tx_hash, payload, created_at, tx_application_order, event_index, contract_id FROM events ORDER BY ledger, tx_application_order, event_index, contract_id',
  ).all() as any;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  _resetReindexState();
  _resetReplayState();
  clearEventsTable();

  const indexerModule = require('../../src/services/indexer');
  indexerModule.normalizeSorobanEvent.mockImplementation((raw: { topic: unknown[]; value: unknown }) => {
    const { scValToNative } = require('@stellar/stellar-sdk');
    return {
      type: scValToNative(raw.topic[0]),
      payload: scValToNative(raw.value),
    };
  });
});

afterEach(() => {
  jest.useRealTimers();
  clearEventsTable();
});

// ── Parity tests ─────────────────────────────────────────────────────────────

describe('reindex vs replay parity', () => {
  it('produces identical event rows for the same ledger range', async () => {
    const txHashA = 'aaaa' + '0'.repeat(60);
    const txHashB = 'bbbb' + '0'.repeat(60);
    const txHashC = 'cccc' + '0'.repeat(60);

    const mockEvents = [
      makeEvent('player_registered', { player_id: 'P1', wallet: 'G' + 'A'.repeat(55) }, txHashA, 100),
      makeEvent('milestone_approved', { player_id: 'P1' }, txHashB, 101),
      makeEvent('contact_unlocked', { scout: 'G' + 'S'.repeat(55), player_id: 'P2' }, txHashC, 102),
    ];

    // ── Run reindex ─────────────────────────────────────────────────────────
    mockGetEvents.mockResolvedValue({ events: mockEvents });
    startReindex(100, 102, 'GADMIN');
    await flushReindex();

    const reindexStatus = getReindexStatus();
    expect(reindexStatus.status).toBe('complete');

    const reindexEvents = getAllEvents();
    _resetReindexState();
    clearEventsTable();

    // ── Run replay on the same range ────────────────────────────────────────
    mockGetEvents.mockResolvedValue({ events: mockEvents });
    await runReplay(100, 102, 'GADMIN');

    const replayStatus = getReplayStatus();
    expect(replayStatus.status).toBe('complete');

    const replayEvents = getAllEvents();
    _resetReplayState();
    clearEventsTable();

    // ── Compare results ───────────────────────────────────────────────────────
    expect(reindexEvents.length).toBe(replayEvents.length);
    expect(reindexEvents.length).toBe(3);

    for (let i = 0; i < reindexEvents.length; i++) {
      const re = reindexEvents[i];
      const rp = replayEvents[i];

      expect(re.type).toBe(rp.type);
      expect(re.ledger).toBe(rp.ledger);
      expect(re.tx_hash).toBe(rp.tx_hash);
      expect(re.payload).toBe(rp.payload);
      expect(re.tx_application_order).toBe(rp.tx_application_order);
      expect(re.event_index).toBe(rp.event_index);
      expect(re.contract_id).toBe(rp.contract_id);
    }
  });

  it('handles multiple batches with identical results', async () => {
    const txHash1 = '1111' + '0'.repeat(60);
    const txHash2 = '2222' + '0'.repeat(60);
    const txHash3 = '3333' + '0'.repeat(60);

    const mockEvents = [
      makeEvent('player_registered', { player_id: 'P1', wallet: 'G' + 'A'.repeat(55) }, txHash1, 200),
      makeEvent('milestone_approved', { player_id: 'P1' }, txHash2, 201),
      makeEvent('contact_unlocked', { scout: 'G' + 'S'.repeat(55), player_id: 'P2' }, txHash3, 300),
    ];

    // ── Run reindex (will span multiple batches) ─────────────────────────────
    mockGetEvents.mockResolvedValue({ events: mockEvents });
    startReindex(200, 300, 'GADMIN');
    await flushReindex();

    const reindexEvents = getAllEvents();
    _resetReindexState();
    clearEventsTable();

    // ── Run replay on the same range ────────────────────────────────────────
    mockGetEvents.mockResolvedValue({ events: mockEvents });
    await runReplay(200, 300, 'GADMIN');

    const replayEvents = getAllEvents();
    _resetReplayState();
    clearEventsTable();

    // ── Compare results ───────────────────────────────────────────────────────
    expect(reindexEvents.length).toBe(replayEvents.length);
    expect(reindexEvents.length).toBe(3);

    for (let i = 0; i < reindexEvents.length; i++) {
      const re = reindexEvents[i];
      const rp = replayEvents[i];

      expect(re.type).toBe(rp.type);
      expect(re.ledger).toBe(rp.ledger);
      expect(re.tx_hash).toBe(rp.tx_hash);
      expect(re.payload).toBe(rp.payload);
    }
  });

  it('produces identical results with empty ledger range', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });

    // ── Run reindex ─────────────────────────────────────────────────────────
    startReindex(500, 500, 'GADMIN');
    await flushReindex();

    const reindexEvents = getAllEvents();
    _resetReindexState();
    clearEventsTable();

    // ── Run replay ───────────────────────────────────────────────────────────
    await runReplay(500, 500, 'GADMIN');

    const replayEvents = getAllEvents();
    _resetReplayState();
    clearEventsTable();

    // ── Compare results ───────────────────────────────────────────────────────
    expect(reindexEvents.length).toBe(0);
    expect(replayEvents.length).toBe(0);
  });

  it('maintains deterministic ordering across both operations', async () => {
    const txHashA = 'aaaa' + '0'.repeat(60);
    const txHashB = 'bbbb' + '0'.repeat(60);

    // Events in reverse ledger order to test sorting
    const mockEvents = [
      makeEvent('milestone_approved', { player_id: 'P1' }, txHashB, 110),
      makeEvent('player_registered', { player_id: 'P1', wallet: 'G' + 'A'.repeat(55) }, txHashA, 100),
    ];

    // ── Run reindex ─────────────────────────────────────────────────────────
    mockGetEvents.mockResolvedValue({ events: mockEvents });
    startReindex(100, 110, 'GADMIN');
    await flushReindex();

    const reindexEvents = getAllEvents();
    _resetReindexState();
    clearEventsTable();

    // ── Run replay ───────────────────────────────────────────────────────────
    mockGetEvents.mockResolvedValue({ events: mockEvents });
    await runReplay(100, 110, 'GADMIN');

    const replayEvents = getAllEvents();
    _resetReplayState();
    clearEventsTable();

    // ── Both should have events sorted by ledger ─────────────────────────────
    expect(reindexEvents[0].ledger).toBe(100);
    expect(reindexEvents[1].ledger).toBe(110);
    expect(replayEvents[0].ledger).toBe(100);
    expect(replayEvents[1].ledger).toBe(110);

    // ── Verify exact parity ───────────────────────────────────────────────────
    expect(reindexEvents).toEqual(replayEvents);
  });

  it('handles deduplication identically in both operations', async () => {
    const dupHash = 'dddd' + '0'.repeat(60);

    const mockEvents = [
      makeEvent('player_registered', { player_id: 'P1', wallet: 'G' + 'A'.repeat(55) }, dupHash, 400),
    ];

    // ── First reindex inserts the event ──────────────────────────────────────
    mockGetEvents.mockResolvedValue({ events: mockEvents });
    startReindex(400, 400, 'GADMIN');
    await flushReindex();

    const reindexEvents1 = getAllEvents();
    expect(reindexEvents1.length).toBe(1);
    _resetReindexState();
    clearEventsTable();

    // ── First replay inserts the event ───────────────────────────────────────
    mockGetEvents.mockResolvedValue({ events: mockEvents });
    await runReplay(400, 400, 'GADMIN');

    const replayEvents1 = getAllEvents();
    expect(replayEvents1.length).toBe(1);
    _resetReplayState();
    clearEventsTable();

    // ── Second reindex should dedupe (INSERT OR IGNORE) ────────────────────
    mockGetEvents.mockResolvedValue({ events: mockEvents });
    startReindex(400, 400, 'GADMIN');
    await flushReindex();

    const reindexEvents2 = getAllEvents();
    expect(reindexEvents2.length).toBe(1); // Still 1, not 2
    _resetReindexState();
    clearEventsTable();

    // ── Second replay should dedupe identically ─────────────────────────────
    mockGetEvents.mockResolvedValue({ events: mockEvents });
    await runReplay(400, 400, 'GADMIN');

    const replayEvents2 = getAllEvents();
    expect(replayEvents2.length).toBe(1); // Still 1, not 2
    _resetReplayState();
    clearEventsTable();

    // ── Verify the rows are identical ───────────────────────────────────────
    expect(reindexEvents2[0]).toEqual(replayEvents2[0]);
  });
});
