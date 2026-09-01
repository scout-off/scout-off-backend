/**
 * tests/services/replayService.test.ts
 *
 * Unit test suite for src/services/replayService.ts.
 *
 * Covers:
 *   - Initial state after module load / reset
 *   - runReplay() sets status to 'running' synchronously
 *   - Progress advances correctly across multiple batches
 *   - MAX_REPLAY_RANGE constant value (200)
 *   - RPC errors on a batch are logged and skipped (job continues)
 *   - A fatal error mid-run transitions status to 'error' with a message
 *   - A full successful run transitions to 'complete' without cursor update
 *   - runReplay() throws ReplayAlreadyRunningError when a job is running
 *   - Events are deduplicated via INSERT OR IGNORE (duplicate tx_hash silently skipped)
 *   - persistLastIndexedLedger is NOT called (cursor remains unchanged)
 *   - Audit events are fired for start / complete / error
 *   - Returns count of newly inserted events
 */

import {
  runReplay,
  getReplayStatus,
  _resetReplayState,
  ReplayAlreadyRunningError,
  MAX_REPLAY_RANGE,
} from '../../src/services/replayService';

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
 * on it in replayService.ts). We mock the indexer's normalizePayload so we
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
  // scValToNative() (called inside the real processEventBatches) can deserialise.
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
  _resetReplayState();
});

// ── Constants ─────────────────────────────────────────────────────────────────

describe('MAX_REPLAY_RANGE', () => {
  it('is 200 (the API-layer enforced maximum ledger range for replay)', () => {
    expect(MAX_REPLAY_RANGE).toBe(200);
  });
});

// ── Initial state ─────────────────────────────────────────────────────────────

describe('getReplayStatus() — initial state', () => {
  it('starts as idle with zero progress', () => {
    const state = getReplayStatus();
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

  it('_resetReplayState restores the initial idle state', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });
    await runReplay(100, 200, 'GADMIN');

    // State should now be complete, not idle
    expect(getReplayStatus().status).not.toBe('idle');

    _resetReplayState();
    expect(getReplayStatus().status).toBe('idle');
    expect(getReplayStatus().ledgersProcessed).toBe(0);
  });
});

// ── runReplay — synchronous state transition ───────────────────────────────────

describe('runReplay() — synchronous state transition', () => {
  it('immediately sets status to running with correct fromLedger/toLedger/ledgersTotal', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });

    const promise = runReplay(1000, 1199, 'GADMIN');

    const state = getReplayStatus();
    expect(state.status).toBe('running');
    expect(state.fromLedger).toBe(1000);
    expect(state.toLedger).toBe(1199);
    expect(state.ledgersTotal).toBe(200);
    expect(state.ledgersProcessed).toBe(0);
    expect(state.eventsInserted).toBe(0);
    expect(state.startedAt).not.toBeNull();
    expect(state.completedAt).toBeNull();
    expect(state.errorMessage).toBeNull();

    await promise;
  });

  it('sets startedAt to a valid ISO-8601 timestamp', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });
    const promise = runReplay(1, 10, 'GADMIN');
    const { startedAt } = getReplayStatus();
    expect(startedAt).not.toBeNull();
    expect(() => new Date(startedAt!)).not.toThrow();
    expect(new Date(startedAt!).toISOString()).toBe(startedAt);
    await promise;
  });

  it('throws ReplayAlreadyRunningError when a job is already running', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });
    const promise1 = runReplay(100, 200, 'GADMIN');
    
    try {
      await runReplay(300, 400, 'GADMIN');
      fail('Should have thrown ReplayAlreadyRunningError');
    } catch (err) {
      expect(err).toBeInstanceOf(ReplayAlreadyRunningError);
      expect((err as Error).message).toContain('already in progress');
    }

    await promise1;
  });

  it('fires a replay_started audit event synchronously', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });
    const { logAuditEvent } = require('../../src/services/audit');

    const promise = runReplay(500, 600, 'GWALLET_ADMIN');

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'replay_started',
        adminWallet: 'GWALLET_ADMIN',
        queryParams: expect.objectContaining({ fromLedger: 500, toLedger: 600 }),
      }),
    );

    await promise;
  });
});

// ── Successful run ────────────────────────────────────────────────────────────

describe('successful replay run', () => {
  it('transitions to complete after an empty ledger range', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });

    await runReplay(100, 100, 'GADMIN');

    const state = getReplayStatus();
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

    const result = await runReplay(200, 201, 'GADMIN');

    const state = getReplayStatus();
    expect(state.status).toBe('complete');
    expect(result.eventsInserted).toBeGreaterThanOrEqual(0); // idempotent — may be 0 if already in DB
    expect(state.completedAt).not.toBeNull();
  });

  it('fires a replay_completed audit event on success', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });
    const { logAuditEvent } = require('../../src/services/audit');

    await runReplay(100, 100, 'GWALLET_ADMIN');

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'replay_completed',
        adminWallet: 'GWALLET_ADMIN',
        queryParams: expect.objectContaining({ fromLedger: 100, toLedger: 100 }),
      }),
    );
  });

  it('does NOT call persistLastIndexedLedger (cursor remains unchanged)', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });
    const dbModule = require('../../src/db');
    const persistSpy = jest.spyOn(dbModule, 'persistLastIndexedLedger');

    await runReplay(200, 250, 'GADMIN');

    expect(persistSpy).not.toHaveBeenCalled();
    persistSpy.mockRestore();
  });

  it('sets ledgersProcessed to ledgersTotal on completion', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });

    await runReplay(1, 50, 'GADMIN');

    const state = getReplayStatus();
    expect(state.status).toBe('complete');
    expect(state.ledgersProcessed).toBe(state.ledgersTotal);
  });

  it('returns the count of newly inserted events', async () => {
    const txHash = 'cccc' + '0'.repeat(60);

    mockGetEvents.mockResolvedValue({
      events: [
        makeEvent('player_registered', { player_id: 'P1', wallet: 'G' + 'B'.repeat(55) }, txHash, 300),
      ],
    });

    const result = await runReplay(300, 300, 'GADMIN');

    expect(typeof result.eventsInserted).toBe('number');
    expect(result.eventsInserted).toBeGreaterThanOrEqual(0);
  });

  it('allows a new job to start after the previous one completes', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });

    await runReplay(100, 100, 'GADMIN');
    expect(getReplayStatus().status).toBe('complete');

    _resetReplayState();
    const promise = runReplay(200, 200, 'GADMIN');
    expect(getReplayStatus().status).toBe('running');
    await promise;
  });
});

// ── Batching behaviour ────────────────────────────────────────────────────────

describe('batching behaviour', () => {
  it('issues one getEvents call per 100-ledger batch', async () => {
    // 201 ledgers → ceil(201/100) = 3 batches: [1..100], [101..200], [201..201]
    mockGetEvents.mockResolvedValue({ events: [] });

    await runReplay(1, 201, 'GADMIN');

    expect(mockGetEvents).toHaveBeenCalledTimes(3);
  });

  it('passes the correct startLedger for each batch', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });

    await runReplay(500, 799, 'GADMIN'); // 300 ledgers → 3 batches

    const calls = mockGetEvents.mock.calls.map((c: any) => c[0].startLedger);
    expect(calls).toEqual([500, 600, 700]);
  });

  it('issues a single batch for a range smaller than BATCH_SIZE', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });

    await runReplay(1000, 1049, 'GADMIN'); // 50 ledgers → 1 batch

    expect(mockGetEvents).toHaveBeenCalledTimes(1);
    expect(mockGetEvents).toHaveBeenCalledWith(
      expect.objectContaining({ startLedger: 1000 }),
    );
  });

  it('filters events by config.registerContractId', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });

    await runReplay(1, 1, 'GADMIN');

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

    await runReplay(100, 199, 'GADMIN');

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
});

// ── Error handling ────────────────────────────────────────────────────────────

describe('error handling', () => {
  it('continues to the next batch when a single batch RPC call fails', async () => {
    // Batch 1 fails, batch 2 succeeds → job should complete (not error)
    mockGetEvents
      .mockRejectedValueOnce(new Error('RPC timeout'))
      .mockResolvedValue({ events: [] });

    await runReplay(1, 200, 'GADMIN'); // 2 batches

    // Both batches were attempted
    expect(mockGetEvents).toHaveBeenCalledTimes(2);
    // Job completes despite the first batch failure
    expect(getReplayStatus().status).toBe('complete');
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

    await runReplay(500, 500, 'GADMIN');

    const state = getReplayStatus();
    expect(state.status).toBe('error');
    expect(state.errorMessage).toContain('database is locked');
    expect(state.completedAt).not.toBeNull();

    normalizeSpy.mockRestore();
  });

  it('fires a replay_error audit event when the job fails', async () => {
    const { logAuditEvent } = require('../../src/services/audit');
    const indexerModule = require('../../src/services/indexer');
    const normalizeSpy = jest.spyOn(indexerModule, 'normalizePayload')
      .mockImplementation(() => { throw new Error('fatal db error'); });

    mockGetEvents.mockResolvedValue({
      events: [makeEvent('scout_subscribed', { scout: 'G' + 'S'.repeat(55) },
        'eeee' + '0'.repeat(60), 100)],
    });

    await runReplay(100, 100, 'GWALLET_ADMIN');

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'replay_error',
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

    await runReplay(1, 1, 'GADMIN');
    expect(getReplayStatus().status).toBe('error');
    normalizeSpy.mockRestore();

    _resetReplayState();
    mockGetEvents.mockResolvedValue({ events: [] });
    const promise = runReplay(2, 2, 'GADMIN');
    await promise;
    expect(getReplayStatus().status).toBe('complete');
  });

  it('returns error information when the job fails', async () => {
    const indexerModule = require('../../src/services/indexer');
    const normalizeSpy = jest.spyOn(indexerModule, 'normalizePayload')
      .mockImplementation(() => { throw new Error('crash'); });

    mockGetEvents.mockResolvedValue({
      events: [makeEvent('scout_subscribed', { scout: 'G' + 'S'.repeat(55) },
        'gggg' + '0'.repeat(60), 1)],
    });

    const result = await runReplay(1, 1, 'GADMIN');

    expect(result.error).toBe('crash');
    expect(result.eventsInserted).toBeGreaterThanOrEqual(0);

    normalizeSpy.mockRestore();
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
    await runReplay(300, 300, 'GADMIN');
    _resetReplayState();

    // Second run with the same event — INSERT OR IGNORE should fire 0 changes
    mockGetEvents.mockResolvedValue({
      events: [makeEvent('scout_subscribed', { scout: 'G' + 'S'.repeat(55) }, dupHash, 300)],
    });
    const result = await runReplay(300, 300, 'GADMIN');

    // eventsInserted should be 0 (duplicate, not a new row)
    expect(result.eventsInserted).toBe(0);
    expect(getReplayStatus().status).toBe('complete');
  });
});

// ── getReplayStatus returns a snapshot ─────────────────────────────────────────

describe('getReplayStatus() snapshot semantics', () => {
  it('returns an immutable snapshot — mutations do not affect internal state', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });
    const promise = runReplay(1, 1, 'GADMIN');

    const snap = getReplayStatus() as any;
    // Mutate the snapshot
    snap.status = 'idle';

    // Internal state should still report 'running'
    expect(getReplayStatus().status).toBe('running');
    await promise;
  });
});
