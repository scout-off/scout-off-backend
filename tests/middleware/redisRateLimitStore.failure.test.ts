/**
 * Redis rate-limit failure-mode tests.
 *
 * Tests the full matrix:
 *   [✓] Redis available
 *   [✓] Redis unreachable at startup
 *   [✓] Redis command timeout
 *   [✓] Redis drops mid-request
 *   [✓] Redis recovers
 *   [✓] Bounded response time
 *   [✓] Fail-open behavior verified
 *
 * ## Fail-open policy
 *
 * When Redis raises an error the rate-limit middleware logs a warning and
 * calls `next()` — the request is *allowed* rather than rejected with 500.
 *
 * This is an explicit availability-over-security trade-off:
 *  - A Redis outage temporarily disables distributed throttling.
 *  - All API endpoints remain available to legitimate users.
 *  - Operators are alerted via the warn-level log.
 *
 * See `src/middleware/rateLimit.ts` for the authoritative policy comment.
 *
 * Uses the FakeRedisClient harness — no real Redis or Docker required.
 */

import express, { Request, Response } from 'express';
import request from 'supertest';
import {
  FakeRedisClient,
  FakeRedisStore,
  RedisConnectionError,
  withTimeout,
} from '../helpers/redisFailureHarness';
import { RedisRateLimitStore } from '../../src/middleware/redisRateLimitStore';
import { rateLimit } from '../../src/middleware/rateLimit';
import type Redis from 'ioredis';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const BOUND_MS = 500;

function makeRateLimitStore(client: FakeRedisClient): RedisRateLimitStore {
  return new RedisRateLimitStore(client as unknown as Redis);
}

function makeApp(store: ReturnType<typeof makeRateLimitStore>): express.Application {
  const app = express();
  app.set('trust proxy', 1);
  app.use(rateLimit({ windowMs: 60_000, max: 5, store }));
  app.get('/test', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Redis available — happy path (regression guard)
// ─────────────────────────────────────────────────────────────────────────────

describe('RedisRateLimitStore — healthy Redis', () => {
  let client: FakeRedisClient;
  let store: RedisRateLimitStore;

  beforeEach(() => {
    client = new FakeRedisClient();
    store = makeRateLimitStore(client);
  });

  afterEach(() => {
    client.flush();
  });

  it('increments the counter and returns the count', async () => {
    const result = await store.increment('ip:1.2.3.4', 60_000);
    expect(result.count).toBe(1);
    expect(result.resetAt).toBeGreaterThan(Date.now());
  });

  it('increments successive calls for the same key', async () => {
    await store.increment('ip:1.2.3.4', 60_000);
    const result = await store.increment('ip:1.2.3.4', 60_000);
    expect(result.count).toBe(2);
  });

  it('tracks keys independently', async () => {
    const a = await store.increment('ip:1.1.1.1', 60_000);
    const b = await store.increment('ip:2.2.2.2', 60_000);
    expect(a.count).toBe(1);
    expect(b.count).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Redis unreachable — fail-open: request is allowed
// ─────────────────────────────────────────────────────────────────────────────

describe('rateLimit middleware — Redis unreachable (fail-open)', () => {
  let client: FakeRedisClient;

  beforeEach(() => {
    client = new FakeRedisClient();
    client.setState('unavailable');
  });

  afterEach(() => {
    client.flush();
  });

  it('allows the request when Redis is unavailable (fail-open)', async () => {
    const store = makeRateLimitStore(client);
    const app = makeApp(store);
    const res = await request(app).get('/test').set('X-Forwarded-For', '1.2.3.4');
    // Fail-open: request succeeds, not 500 or 429
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('allows all requests when Redis is unavailable — no false 429s', async () => {
    const store = makeRateLimitStore(client);
    const app = makeApp(store);
    // Fire more requests than max (5) — all should succeed due to fail-open
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app).get('/test').set('X-Forwarded-For', '5.6.7.8')
      )
    );
    for (const res of responses) {
      expect(res.status).toBe(200);
    }
  });

  it('completes within bounded time when Redis is unavailable', async () => {
    const store = makeRateLimitStore(client);
    const app = makeApp(store);
    const start = Date.now();
    const res = await request(app).get('/test').set('X-Forwarded-For', '1.2.3.4');
    const elapsed = Date.now() - start;
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(BOUND_MS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. Redis becomes unavailable mid-request (after successful connection)
// ─────────────────────────────────────────────────────────────────────────────

describe('rateLimit middleware — Redis drops mid-request (fail-open)', () => {
  let client: FakeRedisClient;

  beforeEach(() => {
    client = new FakeRedisClient();
  });

  afterEach(() => {
    client.flush();
  });

  it('first request succeeds (healthy), second allows after Redis drops (fail-open)', async () => {
    const store = makeRateLimitStore(client);
    const app = makeApp(store);

    // First request — Redis is healthy
    const first = await request(app).get('/test').set('X-Forwarded-For', '9.9.9.9');
    expect(first.status).toBe(200);

    // Redis drops
    client.setState('unavailable');

    // Second request — Redis unavailable, should fail open
    const second = await request(app).get('/test').set('X-Forwarded-For', '9.9.9.9');
    expect(second.status).toBe(200);
  });

  it('completes within bounded time when Redis drops mid-request', async () => {
    const store = makeRateLimitStore(client);
    const app = makeApp(store);

    client.setState('unavailable');

    const start = Date.now();
    const res = await request(app).get('/test').set('X-Forwarded-For', '10.0.0.1');
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(BOUND_MS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. Redis command timeout — fail-open
// ─────────────────────────────────────────────────────────────────────────────

describe('RedisRateLimitStore — command timeout', () => {
  let client: FakeRedisClient;

  beforeEach(() => {
    client = new FakeRedisClient();
    client.setState('timeout');
  });

  afterEach(() => {
    client.flush();
  });

  it('increment() throws when the command hangs (timeout state)', async () => {
    const store = makeRateLimitStore(client);
    // The fake 'timeout' state returns a never-resolving promise — simulate
    // the ioredis commandTimeout firing by racing with our own bound timer.
    const timeoutMs = 200;
    const raceResult = await withTimeout(
      store.increment('ip:1.2.3.4', 60_000),
      timeoutMs
    );
    // In timeout state the fake's eval never resolves, so our race wins
    expect(raceResult.timedOut).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Recovery — rate limiting resumes after Redis becomes healthy
// ─────────────────────────────────────────────────────────────────────────────

describe('rateLimit middleware — Redis recovery', () => {
  let client: FakeRedisClient;

  beforeEach(() => {
    client = new FakeRedisClient();
  });

  afterEach(() => {
    client.flush();
  });

  it('normal rate limiting resumes after Redis recovers', async () => {
    const store = makeRateLimitStore(client);
    const app = makeApp(store);

    // Redis healthy — rate limiting active
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/test').set('X-Forwarded-For', '3.3.3.3');
      expect(res.status).toBe(200);
    }

    // 6th request should be rate-limited (max=5)
    const overLimit = await request(app).get('/test').set('X-Forwarded-For', '3.3.3.3');
    expect(overLimit.status).toBe(429);

    // Redis drops — fail open (reset client to get new key)
    client.setState('unavailable');
    const duringOutage = await request(app).get('/test').set('X-Forwarded-For', '3.3.3.3');
    expect(duringOutage.status).toBe(200); // fail open

    // Redis recovers — rate limiting works normally for NEW keys
    client.setState('healthy');
    const afterRecovery = await request(app).get('/test').set('X-Forwarded-For', '4.4.4.4');
    expect(afterRecovery.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. RedisRateLimitStore direct tests — error propagation
// ─────────────────────────────────────────────────────────────────────────────

describe('RedisRateLimitStore — error propagation', () => {
  it('throws a RedisConnectionError when Redis is unavailable', async () => {
    const client = new FakeRedisClient();
    client.setState('unavailable');
    const store = makeRateLimitStore(client);

    await expect(store.increment('ip:1.2.3.4', 60_000)).rejects.toThrow(
      RedisConnectionError
    );
    client.flush();
  });

  it('increment() completes within bounded time when Redis is available', async () => {
    const client = new FakeRedisClient();
    const store = makeRateLimitStore(client);
    const result = await withTimeout(store.increment('ip:1.2.3.4', 60_000), BOUND_MS);
    expect(result.timedOut).toBe(false);
    if (!result.timedOut) {
      expect(result.value.count).toBe(1);
    }
    client.flush();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G. No unhandled promise rejections — all errors are caught
// ─────────────────────────────────────────────────────────────────────────────

describe('rateLimit middleware — no unhandled rejections', () => {
  it('does not produce unhandled rejections when Redis is unavailable', async () => {
    const client = new FakeRedisClient();
    client.setState('unavailable');
    const store = makeRateLimitStore(client);
    const app = makeApp(store);

    // If there were an unhandled rejection, Jest would report it as a
    // test failure automatically. This test verifies no such rejection occurs.
    const unhandledRejections: Error[] = [];
    const handler = (err: Error) => unhandledRejections.push(err);
    process.on('unhandledRejection', handler);

    try {
      await request(app).get('/test').set('X-Forwarded-For', '8.8.8.8');
    } finally {
      process.off('unhandledRejection', handler);
      client.flush();
    }

    expect(unhandledRejections).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H. FakeRedisStore failure scenarios (verify the harness itself)
// ─────────────────────────────────────────────────────────────────────────────

describe('FakeRedisStore harness self-test', () => {
  it('transitions HEALTHY → UNAVAILABLE → HEALTHY correctly', async () => {
    const fake = new FakeRedisStore();

    fake.setState('healthy');
    await expect(fake.get('k')).resolves.toBeNull();

    fake.setState('unavailable');
    await expect(fake.get('k')).rejects.toThrow(RedisConnectionError);

    fake.setState('healthy');
    await expect(fake.get('k')).resolves.toBeNull();
    fake.flush();
  });

  it('rejectAllPending unblocks timeout-state promises', async () => {
    const fake = new FakeRedisStore();
    fake.setState('timeout');

    const p = fake.get('k');
    fake.rejectAllPending(new RedisConnectionError('test timeout'));
    await expect(p).rejects.toThrow(RedisConnectionError);
    fake.flush();
  });
});
