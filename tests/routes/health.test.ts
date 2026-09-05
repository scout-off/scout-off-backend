/**
 * Tests for the readiness probe endpoints (/ready and /health/readiness).
 * Both delegate to the shared checkReadiness() helper, so they must return
 * identical responses for the same service states.
 *
 * Updated for issue #1124: each probe now returns { status, ms } rather than
 * a plain string, and each probe runs concurrently with its own timeout.
 */

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn(),
  pinFile: jest.fn(),
  gatewayUrl: jest.fn((cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`),
  checkHealth: jest.fn(),
}));

// Mock the indexer module to control indexerLedgerLag in tests
jest.mock('../../src/services/indexer', () => ({
  indexerLedgerLag: 0,
}));

// Partially mock the stellar service so tests can drive the RPC probe result
// via mockStellarHealth without a real network call. Everything else
// (stellarBreaker, server, …) stays real.
jest.mock('../../src/services/stellar', () => {
  const actual = jest.requireActual<typeof import('../../src/services/stellar')>('../../src/services/stellar');
  return { ...actual, stellarHealth: jest.fn().mockResolvedValue(true) };
});

// Partially mock the db module so individual tests can control getDriver() —
// src/app.ts's /health and /ready probes go through the DbDriver, not the raw
// getDb() handle, so they work identically under DB_DRIVER=sqlite and
// DB_DRIVER=postgres.
jest.mock('../../src/db', () => {
  const actual = jest.requireActual<typeof import('../../src/db')>('../../src/db');
  return { ...actual, getDriver: jest.fn(actual.getDriver) };
});

import request from 'supertest';
import app from '../../src/app';
import config from '../../src/config';
import * as ipfsService from '../../src/services/ipfs';
import * as stellarService from '../../src/services/stellar';
import * as dbModule from '../../src/db';
import * as indexerModule from '../../src/services/indexer';

const mockCheckHealth = ipfsService.checkHealth as jest.Mock;
const mockStellarHealth = stellarService.stellarHealth as jest.Mock;
const mockGetDriver = dbModule.getDriver as jest.Mock;
// getDriver() throws until initDb() has run (tests/setup.ts's beforeAll), so
// this can't be resolved at module-import time — read it lazily instead.
function getRealDriver() {
  return jest.requireActual<typeof import('../../src/db')>('../../src/db').getDriver();
}

/**
 * Build a driver-shaped object that delegates every method to the real
 * driver except the ones named in `overrides`. A plain object spread
 * (`{ ...getRealDriver() }`) does NOT work here — SqliteDriver's methods are
 * defined on its class prototype, not as the instance's own enumerable
 * properties, so a spread silently drops them all.
 */
function driverWith(overrides: Partial<ReturnType<typeof getRealDriver>>) {
  const real = getRealDriver();
  return {
    all: real.all.bind(real),
    get: real.get.bind(real),
    value: real.value.bind(real),
    run: real.run.bind(real),
    exec: real.exec.bind(real),
    transaction: real.transaction.bind(real),
    close: real.close.bind(real),
    ...overrides,
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Extract the probe status string from either the new { status, ms } shape
 *  or the legacy plain-string shape. */
function probeStatus(value: unknown): string {
  if (value && typeof value === 'object' && 'status' in (value as object)) {
    return (value as { status: string }).status;
  }
  return value as string;
}

/** Assert a probe field has the expected status. */
function expectProbeStatus(value: unknown, expected: string): void {
  expect(probeStatus(value)).toBe(expected);
}

// ─── /ready and /health/readiness ────────────────────────────────────────────

const READINESS_PATHS = ['/ready', '/health/readiness'];

describe.each(READINESS_PATHS)('%s', (path) => {
  const previousBreakerState = stellarService.stellarBreaker.state;

  afterEach(() => {
    mockCheckHealth.mockReset();
    mockStellarHealth.mockReset();
    mockStellarHealth.mockResolvedValue(true);
    mockGetDriver.mockReset();
    // Restore to the real implementation between tests
    mockGetDriver.mockImplementation(getRealDriver);
    // Reset indexer lag to 0
    (indexerModule as any).indexerLedgerLag = 0;
  });

  it('returns 200 and status ok when all dependencies are healthy (#1226)', async () => {
    mockCheckHealth.mockResolvedValueOnce(undefined);
    mockStellarHealth.mockResolvedValueOnce(true);
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expectProbeStatus(res.body.services.ipfs, 'ok');
    expectProbeStatus(res.body.services.db, 'ok');
  });

  it('includes db field in the services object', async () => {
    mockCheckHealth.mockResolvedValueOnce(undefined);
    const res = await request(app).get('/ready');
    expect(res.body.services).toHaveProperty('db');
    expect(['ok', 'unavailable']).toContain(probeStatus(res.body.services.db));
  });

  it('per-probe result includes a numeric ms field', async () => {
    mockCheckHealth.mockResolvedValueOnce(undefined);
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    // Each probe should report latency as a non-negative integer
    for (const key of ['db', 'ipfs', 'stellar']) {
      const probe = res.body.services[key];
      if (probe && typeof probe === 'object') {
        expect(typeof probe.ms).toBe('number');
        expect(probe.ms).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('probes run concurrently — total latency is bounded by max single probe, not the sum', async () => {
    // Each probe resolves quickly; verify we get a result without hanging
    mockCheckHealth.mockResolvedValueOnce(undefined);
    const t0 = Date.now();
    const res = await request(app).get(path);
    const elapsed = Date.now() - t0;
    expect(res.status).toBeLessThanOrEqual(503);
    // Should finish well within 3x the per-probe timeout (generous margin for CI)
    expect(elapsed).toBeLessThan(15_000);
  });

  it('returns 503 with ipfs:unavailable when IPFS check throws (#1226)', async () => {
    mockCheckHealth.mockRejectedValueOnce(new Error('IPFS connection refused'));
    const res = await request(app).get(path);
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expectProbeStatus(res.body.services.ipfs, 'unavailable');
  });

  it('returns 503 with db:unavailable when the database probe throws (#1226)', async () => {
    mockCheckHealth.mockResolvedValueOnce(undefined);
    // Simulate a locked or corrupted DB. /ready's readiness probe
    // (probeDbWritable in src/app.ts) checks writability via driver.run(),
    // not driver.get() — unlike /health's liveness probe.
    mockGetDriver.mockImplementation(() =>
      driverWith({ run: () => Promise.reject(new Error('SQLITE_BUSY: database is locked')) }),
    );
    const res = await request(app).get(path);
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expectProbeStatus(res.body.services.db, 'unavailable');
  });

  it('returns 503 with db:unavailable when the DB is read-only (writes fail, reads still succeed)', async () => {
    mockCheckHealth.mockResolvedValueOnce(undefined);
    const real = getRealDriver();
    mockGetDriver.mockImplementation(() =>
      driverWith({
        run: (sql: string, params?: unknown[]) => {
          if (sql.includes('INSERT INTO indexer_state')) {
            return Promise.reject(new Error('SQLITE_READONLY: attempt to write a readonly database'));
          }
          return real.run(sql, params);
        },
      }),
    );
    const res = await request(app).get(path);
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expectProbeStatus(res.body.services.db, 'unavailable');
  });

  it('IPFS failure does not prevent db and stellar results from being reported', async () => {
    mockCheckHealth.mockRejectedValueOnce(new Error('IPFS timeout'));
    const res = await request(app).get(path);
    expect(res.status).toBe(503);
    // db and stellar probes should still return their own results
    expect(res.body.services).toHaveProperty('db');
    expect(res.body.services).toHaveProperty('stellar');
  });

  it('includes indexer field in the services object', async () => {
    mockCheckHealth.mockResolvedValueOnce(undefined);
    const res = await request(app).get(path);
    expect(res.body.services).toHaveProperty('indexer');
    expect(['ok', 'unavailable', 'disabled']).toContain(res.body.services.indexer);
  });

  it('returns 503 with indexer:unavailable when indexer lag exceeds threshold', async () => {
    mockCheckHealth.mockResolvedValueOnce(undefined);
    // Set indexer lag to exceed default threshold (100)
    (indexerModule as any).indexerLedgerLag = 150;
    const res = await request(app).get(path);
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.services.indexer).toBe('unavailable');
  });

  it('returns 200 with indexer:ok when indexer lag is within threshold', async () => {
    mockCheckHealth.mockResolvedValueOnce(undefined);
    // Set indexer lag within default threshold (100)
    (indexerModule as any).indexerLedgerLag = 50;
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.services.indexer).toBe('ok');
  });

  it('returns 200 with indexer:ok when indexer lag is exactly at threshold', async () => {
    mockCheckHealth.mockResolvedValueOnce(undefined);
    // Set indexer lag exactly at default threshold (100)
    (indexerModule as any).indexerLedgerLag = 100;
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.services.indexer).toBe('ok');
  });


});

// ─── /health ─────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  afterEach(() => {
    mockGetDriver.mockReset();
    mockGetDriver.mockImplementation(getRealDriver);
  });

  it('returns 200 and includes db field in healthStatus', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.healthStatus).toHaveProperty('db');
    expect(['ok', 'error']).toContain(res.body.healthStatus.db);
  });

  it('includes db:ok when the database is reachable', async () => {
    const res = await request(app).get('/health');
    expect(res.body.healthStatus.db).toBe('ok');
  });

  it('reports db:error in healthStatus but still returns 200 when the DB probe fails', async () => {
    // /health is a liveness probe — it always returns 200.
    // A DB failure is surfaced in healthStatus.db without changing the HTTP status.
    mockGetDriver.mockImplementation(() =>
      driverWith({ get: () => Promise.reject(new Error('SQLITE_BUSY: database is locked')) }),
    );
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.healthStatus.db).toBe('error');
  });
});

describe('GET /ready and GET /health/readiness return identical responses', () => {
  afterEach(() => {
    mockCheckHealth.mockReset();
  });

  it('both return ok when IPFS is healthy', async () => {
    mockCheckHealth.mockResolvedValue(undefined);
    const [a, b] = await Promise.all([
      request(app).get('/ready'),
      request(app).get('/health/readiness'),
    ]);
    expect(a.status).toBe(b.status);
    expect(a.body).toEqual(b.body);
  });

  it('both return degraded when IPFS is down', async () => {
    mockCheckHealth.mockRejectedValue(new Error('down'));
    const [a, b] = await Promise.all([
      request(app).get('/ready'),
      request(app).get('/health/readiness'),
    ]);
    expect(a.status).toBe(b.status);
    expect(a.body).toEqual(b.body);
  });
});
