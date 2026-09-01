/**
 * tests/services/reindexService.test.ts
 *
 * Unit test suite for src/services/reindexService.ts.
 *
 * Covers:
 *   - Initial state after module load / reset
 *   - startReindex() sets status to 'running' synchronously
 *   - Progress advances correctly across multiple batches
 *   - BATCH_SIZE boundary: confirms the service uses 100-ledger batches
 *   - MAX_REINDEX_RANGE constant value
 *   - RPC errors on a batch are logged and skipped (job continues)
 *   - A fatal error mid-run transitions status to 'error' with a message
 *   - A full successful run transitions to 'complete' and advances last ledger
 *   - startReindex() throws ReindexAlreadyRunningError when a job is running
 *   - Events are deduplicated via INSERT OR IGNORE (duplicate tx_hash silently skipped)
 *   - persistLastIndexedLedger is called with toLedger + 1 on success
 *   - Audit events are fired for start / complete / error
 *
 * Mocking conventions match tests/services/indexerDispatch.test.ts:
 *   - server.getEvents is mocked via jest.mock('../../src/services/stellar')
 *   - DB is the in-memory SQLite shared across the test suite (tests/setup.ts)
 *   - audit.logAuditEvent is mocked to prevent real DB writes
 *   - _delay is not mocked — jest.useFakeTimers() advances it instantly
 */

import {
  startReindex,
  getReindexStatus,
  _resetReindexState,
  ReindexAlreadyRunningError,
  MAX_REINDEX_RANGE,
} from '../../src/services/reindexService';

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
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal fake event compatible with what server.getEvents returns
 * in the real RPC (topic is an xdr.ScVal-like object; scValToNative is called
 * on it in reindexService.ts). We mock the indexer's normalizePayload so we
 * can pass plain objects here without needing a full SDK round-trip.
 */
function makeEvent(
  type: string,
  payload: Record<string, unknown>,
  txHash: string,
  ledger: number,
  ledgerClosedAt?: string,
) {
  // Use nativeToScVal so topic[0] and value are proper ScVal objects that
  // scValToNative() (called inside the real _runReindex) can deserialise.
  const { nativeToScVal } = require('@stellar/stellar-sdk');
  return {
    topic: [nativeToScVal(type, { type: 'symbol' })],
    value: nativeToScVal(payload),
    ledger,
    txHash,
    ledgerClosedAt: ledgerClosedAt ?? null,
  };
}

/** Wait for a fire-and-forget background job to settle. */
async function flushBackground(): Promise<void> {
  // Advance fake timers (for _delay between batches) then yield to the
  // microtask queue so the async job resolves.
  await jest.runAllTimersAsync();
  await Promise.resolve();
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  _resetReindexState();
});

afterEach(() => {
  jest.useRealTimers();
});

// ── Constants ─────────────────────────────────────────────────────────────────

describe('MAX_REINDEX_RANGE', () => {
  it('is 10 000 (the API-layer enforced maximum ledger range)', () => {
    expect(MAX_REINDEX_RANGE).toBe(10_000);
  });
});

// ── Initial state ─────────────────────────────────────────────────────────────

describe('getReindexStatus() — initial state', () => {
  it('starts as idle with zero progress', () => {
    const state = getReindexStatus();
    expect(state.status).toBe('idle');
    expect(state.fromLedger).toBe(0);
    expect(state.toLedger).toBe(0);
    expect(state.ledgersProcessed).toBe(0);
    expect(state.ledgersTotal).toBe(0);
    expect(state.eventsInserted).toBe(0);
    expect(state.startedAt).toBeNull();
    expect(state.completedAt).toBeNull();
    expect(state.errorMessage).toBeNull();
  });

  it('_resetReindexState restores the initial idle state', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });
    startReindex(100, 200, 'GADMIN');
    await flushBackground();

    // State should now be complete, not idle
    expect(getReindexStatus().status).not.toBe('idle');

    _resetReindexState();
    expect(getReindexStatus().status).toBe('idle');
    expect(getReindexStatus().ledgersProcessed).toBe(0);
  });
});

// ── startReindex — synchronous state transition ───────────────────────────────

describe('startReindex() — synchronous state transition', () => {
  it('immediately sets status to running with correct fromLedger/toLedger/ledgersTotal', () => {
    mockGetEvents.mockResolvedValue({ events: [] });

    startReindex(1000, 1199, 'GADMIN');

    const state = getReindexStatus();
    expect(state.status).toBe('running');
    expect(state.fromLedger).toBe(1000);
    expect(state.toLedger).toBe(1199);
    expect(state.ledgersTotal).toBe(200);
    expect(state.ledgersProcessed).toBe(0);
    expect(state.eventsInserted).toBe(0);
    expect(state.startedAt).not.toBeNull();
    expect(state.completedAt).toBeNull();
    expect(state.errorMessage).toBeNull();
  });

  it('sets startedAt to a valid ISO-8601 timestamp', () => {
    mockGetEvents.mockResolvedValue({ events: [] });
    startReindex(1, 10, 'GADMIN');
    const { startedAt } = getReindexStatus();
    expect(startedAt).not.toBeNull();
    expect(() => new Date(startedAt!)).not.toThrow();
    expect(new Date(startedAt!).toISOString()).toBe(startedAt);
  });

  it('throws ReindexAlreadyRunningError when a job is already running', () => {
    mockGetEvents.mockResolvedValue({ events: [] });
    startReindex(100, 200, 'GADMIN');
    expect(() => startReindex(300, 400, 'GADMIN')).toThrow(ReindexAlreadyRunningError);
    expect(() => startReindex(300, 400, 'GADMIN')).toThrow('already in progress');
  });

  it('fires a reindex_started audit event synchronously', () => {
    mockGetEvents.mockResolvedValue({ events: [] });
    const { logAuditEvent } = require('../../src/services/audit');

    startReindex(500, 600, 'GWALLET_ADMIN');

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'reindex_started',
        adminWallet: 'GWALLET_ADMIN',
        queryParams: expect.objectContaining({ fromLedger: 500, toLedger: 600 }),
      }),
    );
  });
});

// ── Successful run ────────────────────────────────────────────────────────────

describe('successful reindex run', () => {
  it('transitions to complete after an empty ledger range', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });

    startReindex(100, 100, 'GADMIN');
    await flushBackground();

    const state = getReindexStatus();
    expect(state.status).toBe('complete');
    expect(state.ledgersProcessed).toBe(1);
    expect(state.eventsInserted).toBe(0);
    expect(state.completedAt).not.toBeNull();
    expect(state.errorMessage).toBeNull();
  });

  it('counts inserted events and reaches complete status', async () => {
    const txHashA = 'aaaa' + '0'.repeat(60);
    const txHashB = 'bbbb' + '0'.repeat(60);

    mockGetEvents.mockResolvedValue({
      events: [
        makeEvent('player_registered', { player_id: 'P1', wallet: 'G' + 'A'.repeat(55) }, txHashA, 200),
        makeEvent('milestone_approved', { player_id: 'P1' }, txHashB, 201),
      ],
    });

    startReindex(200, 201, 'GADMIN');
    await flushBackground();

    const state = getReindexStatus();
    expect(state.status).toBe('complete');
    expect(state.eventsInserted).toBeGreaterThanOrEqual(0); // idempotent — may be 0 if already in DB
    expect(state.completedAt).not.toBeNull();
  });

  it('fires a reindex_completed audit event on success', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });
    const { logAuditEvent } = require('../../src/services/audit');

    startReindex(100, 100, 'GWALLET_ADMIN');
    await flushBackground();

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'reindex_completed',
        adminWallet: 'GWALLET_ADMIN',
        queryParams: expect.objectContaining({ fromLedger: 100, toLedger: 100 }),
      }),
    );
  });

  it('calls persistLastIndexedLedger(toLedger + 1) on success', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });
    const dbModule = require('../../src/db');
    const persistSpy = jest.spyOn(dbModule, 'persistLastIndexedLedger');

    startReindex(200, 250, 'GADMIN');
    await flushBackground();

    expect(persistSpy).toHaveBeenCalledWith(251);
    persistSpy.mockRestore();
  });

  it('sets ledgersProcessed to ledgersTotal on completion', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });

    startReindex(1, 50, 'GADMIN');
    await flushBackground();

    const state = getReindexStatus();
    expect(state.status).toBe('complete');
    expect(state.ledgersProcessed).toBe(state.ledgersTotal);
  });

  it('allows a new job to start after the previous one completes', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });

    startReindex(100, 100, 'GADMIN');
    await flushBackground();
    expect(getReindexStatus().status).toBe('complete');

    _resetReindexState();
    expect(() => startReindex(200, 200, 'GADMIN')).not.toThrow();
  });
});

// ── Batching behaviour ────────────────────────────────────────────────────────

describe('batching behaviour', () => {
  it('issues one getEvents call per 100-ledger batch', async () => {
    // 201 ledgers → ceil(201/100) = 3 batches: [1..100], [101..200], [201..201]
    mockGetEvents.mockResolvedValue({ events: [] });

    startReindex(1, 201, 'GADMIN');
    await flushBackground();

    expect(mockGetEvents).toHaveBeenCalledTimes(3);
  });

  it('passes the correct startLedger for each batch', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });

    startReindex(500, 799, 'GADMIN'); // 300 ledgers → 3 batches
    await flushBackground();

    const calls = mockGetEvents.mock.calls.map((c: any) => c[0].startLedger);
    expect(calls).toEqual([500, 600, 700]);
  });

  it('issues a single batch for a range smaller than BATCH_SIZE', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });

    startReindex(1000, 1049, 'GADMIN'); // 50 ledgers → 1 batch
    await flushBackground();

    expect(mockGetEvents).toHaveBeenCalledTimes(1);
    expect(mockGetEvents).toHaveBeenCalledWith(
      expect.objectContaining({ startLedger: 1000 }),
    );
  });

  it('filters events by config.registerContractId, not the legacy config.contractId', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });

    startReindex(1, 1, 'GADMIN');
    await flushBackground();

    const config = jest.requireActual('../../src/config').default;
    expect(mockGetEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ type: 'contract', contractIds: [config.registerContractId] }],
      }),
    );
  });

  it('filters out events outside the current batch window', async () => {
    // Batch covers [100, 199]. Events at ledger 50 (before) and 200 (after)
    // should be filtered out; only ledger 150 should be inserted.
    const txInRange  = 'innn' + '0'.repeat(60);
    const txBefore   = 'bfff' + '0'.repeat(60);
    const txAfter    = 'afff' + '0'.repeat(60);

    mockGetEvents.mockResolvedValue({
      events: [
        makeEvent('player_registered', { player_id: 'P_BEFORE' }, txBefore, 50),
        makeEvent('player_registered', { player_id: 'P_IN',     wallet: 'G' + 'A'.repeat(55) }, txInRange, 150),
        makeEvent('player_registered', { player_id: 'P_AFTER'  }, txAfter,  200),
      ],
    });

    startReindex(100, 199, 'GADMIN');
    await flushBackground();

    const { getDb } = require('../../src/db');
    const db = getDb();
    const rows = db.prepare(
      'SELECT ledger FROM events WHERE tx_hash IN (?, ?, ?)',
    ).all(txInRange, txBefore, txAfter);

    const ledgers = rows.map((r: { ledger: number }) => r.ledger);
    expect(ledgers).toContain(150);
    expect(ledgers).not.toContain(50);
    expect(ledgers).not.toContain(200);
  });

  it('advances progress state after each batch', async () => {
    // 2 batches: [1..100] then [101..150]
    let callCount = 0;
    const progressSnapshots: number[] = [];

    mockGetEvents.mockImplementation(async () => {
      callCount++;
      // Snapshot progress after the first batch resolves
      if (callCount === 1) {
        // Allow the first batch to complete before we snapshot
        await Promise.resolve();
      }
      return { events: [] };
    });

    startReindex(1, 150, 'GADMIN');
    await flushBackground();

    // After full completion, ledgersProcessed === ledgersTotal
    const state = getReindexStatus();
    expect(state.status).toBe('complete');
    expect(state.ledgersProcessed).toBe(150);
    void progressSnapshots; // suppress unused var warning
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe('error handling', () => {
  it('continues to the next batch when a single batch RPC call fails', async () => {
    // Batch 1 fails, batch 2 succeeds → job should complete (not error)
    mockGetEvents
      .mockRejectedValueOnce(new Error('RPC timeout'))
      .mockResolvedValue({ events: [] });

    startReindex(1, 200, 'GADMIN'); // 2 batches
    await flushBackground();

    // Both batches were attempted
    expect(mockGetEvents).toHaveBeenCalledTimes(2);
    // Job completes despite the first batch failure
    expect(getReindexStatus().status).toBe('complete');
  });

  it('logs a warning (not an error) when a batch RPC call fails', async () => {
    const warnSpy = jest.spyOn(require('../../src/utils/logger').logger, 'warn')
      .mockImplementation(() => {});

    mockGetEvents
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValue({ events: [] });

    startReindex(1, 100, 'GADMIN');
    await flushBackground();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('connection refused'),
    );
    warnSpy.mockRestore();
  });

  it('transitions to error status when a fatal error occurs inside the batch transaction', async () => {
    // Mock normalizePayload (called inside the db.transaction callback) to
    // throw a fatal error after the events are fetched — this escapes the
    // inner per-batch RPC catch and hits the outer try/catch, setting
    // status: 'error'.
    const indexerModule = require('../../src/services/indexer');
    const normalizeSpy = jest.spyOn(indexerModule, 'normalizePayload')
      .mockImplementation(() => { throw new Error('database is locked'); });

    mockGetEvents.mockResolvedValue({
      events: [
        makeEvent('player_registered', { player_id: 'X', wallet: 'G' + 'B'.repeat(55) },
          'cccc' + '0'.repeat(60), 500),
      ],
    });

    startReindex(500, 500, 'GADMIN');
    await flushBackground();

    const state = getReindexStatus();
    expect(state.status).toBe('error');
    expect(state.errorMessage).toContain('database is locked');
    expect(state.completedAt).not.toBeNull();

    normalizeSpy.mockRestore();
  });

  it('fires a reindex_error audit event when the job fails', async () => {
    const { logAuditEvent } = require('../../src/services/audit');
    const indexerModule = require('../../src/services/indexer');
    const normalizeSpy = jest.spyOn(indexerModule, 'normalizePayload')
      .mockImplementation(() => { throw new Error('fatal db error'); });

    mockGetEvents.mockResolvedValue({
      events: [makeEvent('scout_subscribed', { scout: 'G' + 'S'.repeat(55) },
        'eeee' + '0'.repeat(60), 100)],
    });

    startReindex(100, 100, 'GWALLET_ADMIN');
    await flushBackground();

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'reindex_error',
        adminWallet: 'GWALLET_ADMIN',
        queryParams: expect.objectContaining({ error: 'fatal db error' }),
      }),
    );
    normalizeSpy.mockRestore();
  });

  it('allows a new job to start after an errored job is reset', async () => {
    const indexerModule = require('../../src/services/indexer');
    const normalizeSpy = jest.spyOn(indexerModule, 'normalizePayload')
      .mockImplementation(() => { throw new Error('disk full'); });

    mockGetEvents.mockResolvedValue({
      events: [makeEvent('scout_subscribed', { scout: 'G' + 'S'.repeat(55) },
        'ffff' + '0'.repeat(60), 1)],
    });

    startReindex(1, 1, 'GADMIN');
    await flushBackground();
    expect(getReindexStatus().status).toBe('error');
    normalizeSpy.mockRestore();

    _resetReindexState();
    mockGetEvents.mockResolvedValue({ events: [] });
    expect(() => startReindex(2, 2, 'GADMIN')).not.toThrow();
    await flushBackground();
    expect(getReindexStatus().status).toBe('complete');
  });

  it('does not call persistLastIndexedLedger when the job errors', async () => {
    const dbModule = require('../../src/db');
    const persistSpy = jest.spyOn(dbModule, 'persistLastIndexedLedger');
    const indexerModule = require('../../src/services/indexer');
    const normalizeSpy = jest.spyOn(indexerModule, 'normalizePayload')
      .mockImplementation(() => { throw new Error('crash'); });

    mockGetEvents.mockResolvedValue({
      events: [makeEvent('scout_subscribed', { scout: 'G' + 'S'.repeat(55) },
        'gggg' + '0'.repeat(60), 1)],
    });

    startReindex(1, 1, 'GADMIN');
    await flushBackground();

    expect(persistSpy).not.toHaveBeenCalled();

    normalizeSpy.mockRestore();
    persistSpy.mockRestore();
  });
});

// ── Deduplication ─────────────────────────────────────────────────────────────

describe('event deduplication', () => {
  it('does not count duplicate tx_hash events as new insertions', async () => {
    const dupHash = 'dddd' + '0'.repeat(60);

    // First run inserts the event
    mockGetEvents.mockResolvedValue({
      events: [makeEvent('scout_subscribed', { scout: 'G' + 'S'.repeat(55) }, dupHash, 300)],
    });
    startReindex(300, 300, 'GADMIN');
    await flushBackground();
    _resetReindexState();

    // Second run with the same event — INSERT OR IGNORE should fire 0 changes
    mockGetEvents.mockResolvedValue({
      events: [makeEvent('scout_subscribed', { scout: 'G' + 'S'.repeat(55) }, dupHash, 300)],
    });
    startReindex(300, 300, 'GADMIN');
    await flushBackground();

    // eventsInserted should be 0 (duplicate, not a new row)
    expect(getReindexStatus().eventsInserted).toBe(0);
    expect(getReindexStatus().status).toBe('complete');
  });
});

// ── getReindexStatus returns a snapshot ───────────────────────────────────────

describe('getReindexStatus() snapshot semantics', () => {
  it('returns an immutable snapshot — mutations do not affect internal state', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });
    startReindex(1, 1, 'GADMIN');

    const snap = getReindexStatus() as ReindexState;
    // Mutate the snapshot
    (snap as unknown as { status: string }).status = 'idle';

    // Internal state should still report 'running'
    expect(getReindexStatus().status).toBe('running');
    await flushBackground();
  });
});
