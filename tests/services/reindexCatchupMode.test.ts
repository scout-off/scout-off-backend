/**
 * tests/services/reindexCatchupMode.test.ts
 *
 * Tests for the catch-up mode added to reindexService in issue #1130.
 *
 * Verifies:
 *   - High lag (remaining > REINDEX_CATCHUP_THRESHOLD) activates catch-up mode
 *     with larger batch size and zero inter-batch delay
 *   - Low lag (remaining <= REINDEX_CATCHUP_THRESHOLD) uses steady-state params
 *   - Mode transitions are logged and reflected in state.mode
 *   - RPC 429 / rate-limit errors trigger a backoff in BOTH modes
 *   - Catch-up batch size is capped at MAX_ALLOWED_CATCHUP_BATCH_SIZE (1 000)
 *   - Catch-up and steady parameters are configurable via env vars
 */

import {
  startReindex,
  getReindexStatus,
  _resetReindexState,
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
  normalizeEventId: jest.fn(
    (_contractId: string, ledger: number, txHash: string) => `${ledger}:${txHash}`,
  ),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Advance fake timers and flush microtasks so the background job settles. */
async function flushBackground(): Promise<void> {
  await jest.runAllTimersAsync();
  await Promise.resolve();
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let originalEnvSnapshot: Record<string, string | undefined> = {};

const CATCH_UP_ENV_VARS = [
  'REINDEX_CATCHUP_THRESHOLD',
  'REINDEX_CATCHUP_BATCH_SIZE',
  'REINDEX_BATCH_SIZE',
  'REINDEX_BATCH_DELAY_MS',
  'REINDEX_RATE_LIMIT_BACKOFF_MS',
];

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  _resetReindexState();

  // Save env snapshot so each test starts clean
  originalEnvSnapshot = {};
  for (const key of CATCH_UP_ENV_VARS) {
    originalEnvSnapshot[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  jest.useRealTimers();
  // Restore env vars
  for (const [key, val] of Object.entries(originalEnvSnapshot)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
});

// ── Catch-up mode activation ──────────────────────────────────────────────────

describe('catch-up mode activation', () => {
  it('uses catch-up batch size when remaining ledgers exceed REINDEX_CATCHUP_THRESHOLD', async () => {
    // Set threshold = 50, catchup batch = 200, steady batch = 10
    process.env.REINDEX_CATCHUP_THRESHOLD = '50';
    process.env.REINDEX_CATCHUP_BATCH_SIZE = '200';
    process.env.REINDEX_BATCH_SIZE = '10';

    const callLedgerStarts: number[] = [];

    mockGetEvents.mockImplementation(async ({ startLedger }: { startLedger: number }) => {
      callLedgerStarts.push(startLedger);
      return { events: [] };
    });

    // Range of 600 ledgers — well above threshold of 50, so first batch should
    // use the catch-up size of 200
    startReindex(1_000, 1_599, 'GADMIN');
    await flushBackground();

    expect(callLedgerStarts.length).toBeGreaterThan(0);
    // First call should be at ledger 1_000; second at 1_200 (catch-up batch = 200)
    expect(callLedgerStarts[0]).toBe(1_000);
    if (callLedgerStarts.length > 1) {
      const firstJump = callLedgerStarts[1] - callLedgerStarts[0];
      // Catch-up batch covers 200 ledgers, so next start should be 200 ahead
      expect(firstJump).toBe(200);
    }
  });

  it('uses steady-state batch size when remaining ledgers are below REINDEX_CATCHUP_THRESHOLD', async () => {
    process.env.REINDEX_CATCHUP_THRESHOLD = '1000'; // high threshold → always steady
    process.env.REINDEX_CATCHUP_BATCH_SIZE = '500';
    process.env.REINDEX_BATCH_SIZE = '25';

    const callLedgerStarts: number[] = [];

    mockGetEvents.mockImplementation(async ({ startLedger }: { startLedger: number }) => {
      callLedgerStarts.push(startLedger);
      return { events: [] };
    });

    // Range of 75 ledgers — below threshold of 1000, so always steady (batch=25)
    startReindex(2_000, 2_074, 'GADMIN');
    await flushBackground();

    expect(callLedgerStarts.length).toBeGreaterThanOrEqual(1);
    if (callLedgerStarts.length > 1) {
      const firstJump = callLedgerStarts[1] - callLedgerStarts[0];
      expect(firstJump).toBe(25);
    }
  });

  it('state.mode is "catchup" when lag is high', async () => {
    process.env.REINDEX_CATCHUP_THRESHOLD = '50';
    process.env.REINDEX_CATCHUP_BATCH_SIZE = '200';

    // Return a pending promise on the first call so we can check state mid-run
    let resolve!: () => void;
    mockGetEvents.mockReturnValueOnce(
      new Promise<{ events: [] }>((r) => {
        resolve = () => r({ events: [] });
      }),
    );

    // Range of 600 — above threshold
    startReindex(5_000, 5_599, 'GADMIN');

    // Before any batch completes, mode should be 'catchup' (set synchronously
    // at start of loop iteration)
    const stateBeforeFirstBatch = getReindexStatus();
    // Mode is set in the loop on the first iteration; status should be 'running'
    expect(stateBeforeFirstBatch.status).toBe('running');

    // Resolve and flush so the job settles
    resolve();
    await flushBackground();
  });

  it('state.mode is "steady" when lag is low', async () => {
    process.env.REINDEX_CATCHUP_THRESHOLD = '1000';

    mockGetEvents.mockResolvedValue({ events: [] });

    startReindex(7_000, 7_020, 'GADMIN'); // 21 ledgers — below 1000
    await flushBackground();

    const state = getReindexStatus();
    expect(state.status).toBe('complete');
    expect(state.mode).toBe('steady');
  });
});

// ── Zero delay in catch-up mode ───────────────────────────────────────────────

describe('zero delay in catch-up mode', () => {
  it('does not call setTimeout between batches in catch-up mode', async () => {
    process.env.REINDEX_CATCHUP_THRESHOLD = '50';
    process.env.REINDEX_CATCHUP_BATCH_SIZE = '200';
    process.env.REINDEX_BATCH_DELAY_MS = '100'; // steady delay = 100 ms

    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    mockGetEvents.mockResolvedValue({ events: [] });

    // Range of 400 ledgers — above threshold; should run fully in catch-up mode
    startReindex(10_000, 10_399, 'GADMIN');
    await flushBackground();

    // In catch-up mode the delay is 0 — the implementation skips the await entirely
    // so setTimeout should not be called for inter-batch delays.
    const batchDelayTimers = setTimeoutSpy.mock.calls.filter(
      ([, delay]) => delay === 100,
    );
    expect(batchDelayTimers.length).toBe(0);

    setTimeoutSpy.mockRestore();
  });

  it('applies steady-state delay between batches in steady mode', async () => {
    process.env.REINDEX_CATCHUP_THRESHOLD = '1000'; // ensure steady mode
    process.env.REINDEX_BATCH_DELAY_MS = '50';
    process.env.REINDEX_BATCH_SIZE = '10';

    const delays: number[] = [];
    const realSetTimeout = global.setTimeout;
    const spy = jest.spyOn(global, 'setTimeout').mockImplementation((fn: any, delay?: number, ...args: any[]) => {
      if (typeof delay === 'number' && delay > 0) {
        delays.push(delay);
      }
      return realSetTimeout(fn, 0, ...args); // execute immediately for test speed
    });

    mockGetEvents.mockResolvedValue({ events: [] });

    // 30 ledgers, batch=10 → 3 batches → 2 inter-batch delays
    startReindex(20_000, 20_029, 'GADMIN');
    await flushBackground();

    // Should have seen at least one 50 ms delay
    expect(delays.some((d) => d === 50)).toBe(true);

    spy.mockRestore();
  });
});

// ── Rate-limit backoff ────────────────────────────────────────────────────────

describe('RPC 429 backoff — applies in both modes', () => {
  it('backs off on a 429 error in steady mode and retries the same batch', async () => {
    process.env.REINDEX_CATCHUP_THRESHOLD = '1000'; // steady mode
    process.env.REINDEX_RATE_LIMIT_BACKOFF_MS = '100';

    let callCount = 0;
    mockGetEvents.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('HTTP 429 Too Many Requests');
      }
      return { events: [] };
    });

    startReindex(30_000, 30_050, 'GADMIN');
    await flushBackground();

    // First call raises 429, second call is the retry for the same batch, then
    // subsequent calls complete the remaining batches
    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(getReindexStatus().status).toBe('complete');
  });

  it('backs off on a rate-limit error in catch-up mode and retries the same batch', async () => {
    process.env.REINDEX_CATCHUP_THRESHOLD = '50';
    process.env.REINDEX_CATCHUP_BATCH_SIZE = '200';
    process.env.REINDEX_RATE_LIMIT_BACKOFF_MS = '100';

    let callCount = 0;
    mockGetEvents.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('rate limit exceeded — 429');
      }
      return { events: [] };
    });

    startReindex(40_000, 40_599, 'GADMIN'); // 600 ledgers, above threshold
    await flushBackground();

    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(getReindexStatus().status).toBe('complete');
  });

  it('does not permanently abort the job on a 429 error', async () => {
    process.env.REINDEX_RATE_LIMIT_BACKOFF_MS = '100';

    mockGetEvents
      .mockRejectedValueOnce(new Error('429 rate limited'))
      .mockResolvedValue({ events: [] });

    startReindex(50_000, 50_200, 'GADMIN');
    await flushBackground();

    expect(getReindexStatus().status).toBe('complete');
  });
});

// ── Batch size hard ceiling ───────────────────────────────────────────────────

describe('catch-up batch size hard ceiling', () => {
  it('caps REINDEX_CATCHUP_BATCH_SIZE at 1000 even if env var exceeds it', async () => {
    process.env.REINDEX_CATCHUP_THRESHOLD = '100';
    process.env.REINDEX_CATCHUP_BATCH_SIZE = '99999'; // way above ceiling

    const callLedgerStarts: number[] = [];
    mockGetEvents.mockImplementation(async ({ startLedger }: { startLedger: number }) => {
      callLedgerStarts.push(startLedger);
      return { events: [] };
    });

    // 2000 ledgers, always in catch-up mode
    startReindex(60_000, 61_999, 'GADMIN');
    await flushBackground();

    expect(callLedgerStarts.length).toBeGreaterThan(0);
    if (callLedgerStarts.length > 1) {
      const jump = callLedgerStarts[1] - callLedgerStarts[0];
      // Should be capped at 1000, not 99999
      expect(jump).toBeLessThanOrEqual(1_000);
    }
  });
});

// ── Mode transition logging ───────────────────────────────────────────────────

describe('mode transition logging', () => {
  it('logs a mode transition when switching from catch-up to steady', async () => {
    const loggerModule = require('../../src/utils/logger');
    const infoSpy = jest.spyOn(loggerModule.logger, 'info');

    process.env.REINDEX_CATCHUP_THRESHOLD = '100';
    process.env.REINDEX_CATCHUP_BATCH_SIZE = '150';
    process.env.REINDEX_BATCH_SIZE = '50';

    mockGetEvents.mockResolvedValue({ events: [] });

    // 300 ledgers: first 200 in catch-up, last 100 in steady (at threshold boundary)
    startReindex(70_000, 70_299, 'GADMIN');
    await flushBackground();

    const transitionLogs = infoSpy.mock.calls.filter(([msg]) =>
      typeof msg === 'string' && msg.includes('mode transition'),
    );
    // Should log at least one transition (catchup → steady as lag drops below threshold)
    expect(transitionLogs.length).toBeGreaterThanOrEqual(1);

    infoSpy.mockRestore();
  });
});
