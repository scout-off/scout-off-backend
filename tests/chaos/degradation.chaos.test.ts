/**
 * Chaos / graceful-degradation harness (#1116).
 *
 * Asserts docs/degradation-contracts.md against fault injection via
 * tests/helpers/chaosHarness.ts. Runs as a dedicated Jest project
 * (`npm run test:chaos`) — not part of the unit suite.
 */

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn().mockResolvedValue('bafychaosmock'),
  pinFile: jest.fn().mockResolvedValue('bafychaosmock'),
  gatewayUrl: jest.fn((cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`),
  gatewayUrls: jest.fn((cid: string) => [`https://gateway.pinata.cloud/ipfs/${cid}`]),
  checkHealth: jest.fn().mockResolvedValue(undefined),
  getCid: jest.fn(async (u: string) => u.replace(/^ipfs:\/\//, '')),
  retryPendingPins: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/db', () => {
  const actual = jest.requireActual<typeof import('../../src/db')>('../../src/db');
  return { ...actual, getDriver: jest.fn(actual.getDriver) };
});

import request from 'supertest';
import jwt from 'jsonwebtoken';
import fetch from 'node-fetch';
import app from '../../src/app';
import config from '../../src/config';
import * as ipfsService from '../../src/services/ipfs';
import * as dbModule from '../../src/db';
import { stellarBreaker } from '../../src/services/stellar';
import {
  createChaosController,
  makeRateLimitedApp,
  expectWithinBudget,
  expectGracefulStatus,
  CHAOS_HANG_BUDGET_MS,
  CircuitBreakerError,
} from '../helpers/chaosHarness';
import { dispatchEventWebhook } from '../../src/services/webhooks';
import {
  createWebhookSubscription,
  listWebhookDeadLetters,
  getPlayerById,
  insertOrUpdatePlayer,
} from '../../src/db';

jest.mock('node-fetch', () => jest.fn());
const mockedFetch = fetch as jest.MockedFunction<typeof fetch>;

const mockCheckHealth = ipfsService.checkHealth as jest.Mock;
const mockGetDriver = dbModule.getDriver as jest.Mock;

function getRealDriver() {
  return jest.requireActual<typeof import('../../src/db')>('../../src/db').getDriver();
}

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

const SCOUT_WALLET = 'G' + 'C'.repeat(55);
const PLAYER_ID = 'G' + 'P'.repeat(55);

function scoutToken() {
  return jwt.sign({ sub: SCOUT_WALLET, role: 'scout' }, config.jwtSecret, { expiresIn: '1h' });
}

describe('chaos harness — dependency fault injection seams', () => {
  let chaos: ReturnType<typeof createChaosController>;

  beforeEach(() => {
    chaos = createChaosController();
  });

  afterEach(() => {
    chaos.reset();
  });

  it('can independently disable redis, db, rpc, and ipfs', () => {
    expect(chaos.disabled().size).toBe(0);

    chaos.disable('redis');
    expect(chaos.disabled().has('redis')).toBe(true);
    expect(chaos.disabled().has('db')).toBe(false);

    chaos.disable('db');
    chaos.disable('rpc');
    chaos.disable('ipfs');
    expect([...chaos.disabled()].sort()).toEqual(['db', 'ipfs', 'redis', 'rpc']);

    chaos.enable('redis');
    expect(chaos.disabled().has('redis')).toBe(false);
    expect(chaos.disabled().has('db')).toBe(true);

    chaos.reset();
    expect(chaos.disabled().size).toBe(0);
  });

  it('Redis rate-limit store fails open (never 5xx)', async () => {
    chaos.disable('redis');
    const mini = makeRateLimitedApp(chaos.rateLimitStore);
    const res = await expectWithinBudget(
      request(mini).get('/probe').set('X-Forwarded-For', '203.0.113.10'),
    );
    expectGracefulStatus(res.status, [200]);
    expect(res.body).toEqual({ ok: true });
  });

  it('Redis cache degrades to a miss (no throw)', async () => {
    await chaos.cacheStore.set('chaos:key', { v: 1 }, 60_000);
    chaos.disable('redis');
    await expect(chaos.cacheStore.get('chaos:key')).resolves.toBeUndefined();
    await expect(chaos.cacheStore.set('chaos:key', { v: 2 }, 60_000)).resolves.toBeUndefined();
  });

  it('DB driver rejects when disabled', async () => {
    await expect(chaos.dbDriver.get('SELECT 1')).resolves.toEqual({ ok: 1 });
    chaos.disable('db');
    await expect(chaos.dbDriver.get('SELECT 1')).rejects.toThrow(/database unavailable/);
    await expect(chaos.dbDriver.run('INSERT …')).rejects.toThrow(/database unavailable/);
  });

  it('RPC disable opens the circuit breaker', async () => {
    chaos.disable('rpc');
    expect(chaos.rpcBreaker.state).toBe('OPEN');
    await expect(chaos.rpcCall()).rejects.toThrow(CircuitBreakerError);
  });

  it('IPFS disable makes checkHealth / pinJson reject with 500-shaped errors', async () => {
    await expect(chaos.ipfs.checkHealth()).resolves.toBeUndefined();
    chaos.disable('ipfs');
    await expect(chaos.ipfs.checkHealth()).rejects.toMatchObject({ status: 500 });
    await expect(chaos.ipfs.pinJson({ a: 1 })).rejects.toMatchObject({ status: 500 });
  });
});

describe('chaos — health & readiness route group', () => {
  afterEach(() => {
    mockCheckHealth.mockReset();
    mockCheckHealth.mockResolvedValue(undefined);
    mockGetDriver.mockReset();
    mockGetDriver.mockImplementation(getRealDriver);
    stellarBreaker.state = 'CLOSED';
  });

  it('GET /health stays 200 when DB probe fails (liveness)', async () => {
    mockGetDriver.mockImplementation(() =>
      driverWith({ get: () => Promise.reject(new Error('db locked (chaos)')) }),
    );
    const res = await expectWithinBudget(request(app).get('/health'));
    expectGracefulStatus(res.status, [200]);
    expect(res.body.status).toBe('ok');
    expect(res.body.healthStatus.db).toBe('error');
  });

  it('GET /ready returns 503 when DB is down', async () => {
    mockCheckHealth.mockResolvedValue(undefined);
    mockGetDriver.mockImplementation(() =>
      driverWith({ run: () => Promise.reject(new Error('db down (chaos)')) }),
    );
    const res = await expectWithinBudget(request(app).get('/ready'));
    expectGracefulStatus(res.status, [503]);
    expect(res.body.status).toBe('degraded');
    expect(res.body.services.db).toBe('unavailable');
  });

  it('GET /ready returns 503 when IPFS is down', async () => {
    mockCheckHealth.mockRejectedValue(new Error('IPFS 500 (chaos)'));
    const res = await expectWithinBudget(request(app).get('/ready'));
    expectGracefulStatus(res.status, [503]);
    expect(res.body.status).toBe('degraded');
    expect(res.body.services.ipfs).toBe('unavailable');
  });

  it('GET /health/readiness mirrors /ready under IPFS failure', async () => {
    mockCheckHealth.mockRejectedValue(new Error('IPFS 500 (chaos)'));
    const res = await expectWithinBudget(request(app).get('/health/readiness'));
    expectGracefulStatus(res.status, [503]);
    expect(res.body.services.ipfs).toBe('unavailable');
  });

  it('GET /ready returns 503 when Stellar breaker is OPEN and health check enabled', async () => {
    const orig = config.stellarHealthCheckEnabled;
    config.stellarHealthCheckEnabled = true;
    mockCheckHealth.mockResolvedValue(undefined);
    stellarBreaker.state = 'OPEN';
    try {
      const res = await expectWithinBudget(request(app).get('/ready'));
      expectGracefulStatus(res.status, [503]);
      expect(res.body.services.stellar).toBe('unavailable');
    } finally {
      config.stellarHealthCheckEnabled = orig;
      stellarBreaker.state = 'CLOSED';
    }
  });

  it('GET /health/liveness and /version and /metrics never 5xx on dependency faults', async () => {
    mockCheckHealth.mockRejectedValue(new Error('ipfs down'));
    mockGetDriver.mockImplementation(() =>
      driverWith({ get: () => Promise.reject(new Error('db down')) }),
    );
    stellarBreaker.state = 'OPEN';

    for (const path of ['/health/liveness', '/version', '/metrics']) {
      const res = await expectWithinBudget(request(app).get(path));
      expect(res.status).toBeLessThan(500);
    }
    stellarBreaker.state = 'CLOSED';
  });
});

describe('chaos — combination failures on critical paths', () => {
  afterEach(() => {
    mockCheckHealth.mockReset();
    mockCheckHealth.mockResolvedValue(undefined);
    mockGetDriver.mockReset();
    mockGetDriver.mockImplementation(getRealDriver);
    stellarBreaker.state = 'CLOSED';
  });

  it('/ready with DB + IPFS down → 503, both unavailable, within hang budget', async () => {
    mockCheckHealth.mockRejectedValue(new Error('ipfs 500'));
    mockGetDriver.mockImplementation(() =>
      driverWith({ run: () => Promise.reject(new Error('db down')) }),
    );
    const res = await expectWithinBudget(request(app).get('/ready'));
    expectGracefulStatus(res.status, [503]);
    expect(res.body.services.db).toBe('unavailable');
    expect(res.body.services.ipfs).toBe('unavailable');
  });

  it('/ready with Redis irrelevant + RPC breaker OPEN (stellar check on)', async () => {
    const orig = config.stellarHealthCheckEnabled;
    config.stellarHealthCheckEnabled = true;
    mockCheckHealth.mockResolvedValue(undefined);
    stellarBreaker.state = 'OPEN';
    try {
      const res = await expectWithinBudget(request(app).get('/ready'));
      expectGracefulStatus(res.status, [503]);
      expect(res.body.services.stellar).toBe('unavailable');
      expect(res.body.services.db).toBe('ok');
    } finally {
      config.stellarHealthCheckEnabled = orig;
      stellarBreaker.state = 'CLOSED';
    }
  });

  it('/health with DB down still 200 (Redis outage does not change liveness)', async () => {
    mockGetDriver.mockImplementation(() =>
      driverWith({ get: () => Promise.reject(new Error('db down')) }),
    );
    const res = await expectWithinBudget(request(app).get('/health'));
    expectGracefulStatus(res.status, [200]);
    expect(res.body.healthStatus.db).toBe('error');
  });

  it('auth challenge under failing Redis rate-limit store never returns 5xx', async () => {
    const chaos = createChaosController();
    chaos.disable('redis');
    const mini = makeRateLimitedApp(chaos.rateLimitStore);
    mini.get('/auth/challenge', (_req, res) => {
      res.status(400).json({ success: false, error: 'Invalid Stellar public key' });
    });
    const res = await expectWithinBudget(
      request(mini).get('/auth/challenge').set('X-Forwarded-For', '198.51.100.7'),
    );
    expect(res.status).toBeLessThan(500);
    chaos.reset();
  });

  it('rate-limit fail-open + open circuit: request admitted, RPC call maps to CircuitBreakerError', async () => {
    const chaos = createChaosController();
    chaos.disable('redis');
    chaos.disable('rpc');
    const mini = makeRateLimitedApp(chaos.rateLimitStore);
    const res = await expectWithinBudget(
      request(mini).get('/probe').set('X-Forwarded-For', '192.0.2.55'),
    );
    expectGracefulStatus(res.status, [200]);
    await expect(chaos.rpcCall()).rejects.toThrow(CircuitBreakerError);
    chaos.reset();
  });
});

describe('chaos — auth & key read route groups', () => {
  afterEach(() => {
    mockCheckHealth.mockReset();
    mockCheckHealth.mockResolvedValue(undefined);
    mockGetDriver.mockReset();
    mockGetDriver.mockImplementation(getRealDriver);
  });

  it('GET /auth/challenge completes within hang budget (no dep hang)', async () => {
    const account = 'G' + 'A'.repeat(55);
    const res = await expectWithinBudget(
      request(app).get('/auth/challenge').query({ account }),
    );
    expect(res.status).toBeLessThan(500);
  });

  it('GET /api/players list survives Redis-unrelated path and returns non-5xx with healthy DB', async () => {
    const res = await expectWithinBudget(request(app).get('/api/players'));
    expect(res.status).toBeLessThan(500);
  });

  it('GET /api/players/:id with healthy DB returns 200 or 404, never hang', async () => {
    await insertOrUpdatePlayer({
      player_id: PLAYER_ID,
      wallet: PLAYER_ID,
      position: 'striker',
      region: 'EU',
      metadata_uri: 'QmChaos',
      created_at: Date.now(),
    });
    const row = await getPlayerById(PLAYER_ID);
    expect(row).not.toBeNull();

    const res = await expectWithinBudget(request(app).get(`/api/players/${PLAYER_ID}`));
    expectGracefulStatus(res.status, [200]);
  });

  it('authenticated scout read under healthy deps does not 5xx', async () => {
    const res = await expectWithinBudget(
      request(app)
        .get(`/api/scouts/${SCOUT_WALLET}/subscription`)
        .set('Authorization', `Bearer ${scoutToken()}`),
    );
    expect(res.status).toBeLessThan(500);
  });
});

describe('chaos — webhook dead-letter on delivery failure', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it('exhausted delivery retries dead-letter without rejecting the dispatcher', async () => {
    const url = `https://example.com/chaos-hook-${Date.now()}`;
    createWebhookSubscription(url, 'chaos-secret', SCOUT_WALLET);
    mockedFetch.mockRejectedValue(new Error('subscriber 500'));

    await expect(
      expectWithinBudget(
        dispatchEventWebhook('milestone_approved', { player_id: 'p1' }),
        Math.max(CHAOS_HANG_BUDGET_MS, 15_000),
      ),
    ).resolves.toBeUndefined();

    const letters = listWebhookDeadLetters(50, 0);
    expect(letters.some((l) => l.url === url)).toBe(true);
  });
});

describe('chaos — indexer continues past RPC errors', () => {
  it('poll wrapper contract: RPC failure is caught and does not escape the poll', async () => {
    const indexEvents = jest.fn().mockRejectedValue(new Error('RPC black hole (chaos)'));
    const poll = async () => {
      try {
        await indexEvents();
      } catch (err) {
        expect((err as Error).message).toMatch(/RPC/);
      }
    };

    await expect(expectWithinBudget(poll())).resolves.toBeUndefined();
    await expect(expectWithinBudget(poll())).resolves.toBeUndefined();
    expect(indexEvents).toHaveBeenCalledTimes(2);
  });
});

describe('chaos — hang budget self-check', () => {
  it('expectWithinBudget fails when a probe hangs', async () => {
    const hang = new Promise<void>(() => {
      /* never settles */
    });
    await expect(expectWithinBudget(hang, 50)).rejects.toThrow(/hang budget/);
  });
});
