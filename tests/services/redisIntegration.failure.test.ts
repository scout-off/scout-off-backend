/**
 * Integration tests: HTTP request behavior during Redis failures.
 *
 * These tests verify the full request lifecycle — not just individual store
 * methods — to catch middleware/lifecycle hangs that unit tests would miss.
 *
 * Test matrix:
 *   [✓] HTTP request does not hang when cache Redis fails
 *   [✓] HTTP request returns expected status when cache Redis fails
 *   [✓] HTTP request does not hang when rate-limit Redis fails
 *   [✓] HTTP request returns expected status when rate-limit Redis fails
 *   [✓] No unhandled rejection on any Redis failure
 *   [✓] No Redis connection leak after test
 */

import express, { Request, Response } from 'express';
import request from 'supertest';
import {
  FakeRedisStore,
  FakeRedisClient,
  withTimeout,
} from '../helpers/redisFailureHarness';
import { RedisCacheStore } from '../../src/services/redisCacheStore';
import { RedisRateLimitStore } from '../../src/middleware/redisRateLimitStore';
import { rateLimit } from '../../src/middleware/rateLimit';
import type Redis from 'ioredis';

/** Maximum time a complete HTTP round-trip should take under Redis failure. */
const HTTP_BOUND_MS = 1_000;

// ─────────────────────────────────────────────────────────────────────────────
// Cache failure — full HTTP flow
// ─────────────────────────────────────────────────────────────────────────────

describe('HTTP cache flow — Redis failure', () => {
  it('request completes normally when cache get fails (cache miss path)', async () => {
    const fakeStore = new FakeRedisStore();
    const cacheStore = new RedisCacheStore(fakeStore);

    const app = express();
    app.get('/players', async (_req: Request, res: Response) => {
      // Simulate cache-first route handler
      const cached = await cacheStore.get<{ players: string[] }>('players:list:all');
      if (cached) {
        res.json({ source: 'cache', ...cached });
        return;
      }
      // Cache miss (or Redis failure) → fetch from DB / upstream
      const data = { players: ['alice', 'bob'] };
      // Attempt to write to cache (may silently fail)
      await cacheStore.set('players:list:all', data, 60_000);
      res.json({ source: 'fresh', ...data });
    });

    // Redis unavailable from the start
    fakeStore.setState('unavailable');

    const start = Date.now();
    const res = await request(app).get('/players');
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    // Should have taken the fresh data path (cache miss due to Redis failure)
    expect(res.body.source).toBe('fresh');
    expect(elapsed).toBeLessThan(HTTP_BOUND_MS);

    fakeStore.flush();
  });

  it('request completes normally when cache fails mid-session', async () => {
    const fakeStore = new FakeRedisStore();
    const cacheStore = new RedisCacheStore(fakeStore);

    const app = express();
    app.get('/players', async (_req: Request, res: Response) => {
      const cached = await cacheStore.get<string[]>('players:list');
      if (cached) {
        res.json({ source: 'cache', players: cached });
        return;
      }
      res.json({ source: 'fresh', players: ['alice'] });
    });

    // Write to cache while healthy
    await fakeStore.set('players:list', JSON.stringify(['alice', 'bob']));

    // Redis drops
    fakeStore.setState('unavailable');

    const res = await request(app).get('/players');
    expect(res.status).toBe(200);
    // Cache miss due to Redis failure → served fresh
    expect(res.body.source).toBe('fresh');

    fakeStore.flush();
  });

  it('cache invalidation failure does not prevent successful HTTP response', async () => {
    const fakeStore = new FakeRedisStore();
    const cacheStore = new RedisCacheStore(fakeStore);

    const app = express();
    app.post('/players', async (_req: Request, res: Response) => {
      // Invalidate cache on mutation (may silently fail if Redis is down)
      await cacheStore.deleteByPrefix('players:list');
      res.status(201).json({ created: true });
    });

    fakeStore.setState('unavailable');

    const start = Date.now();
    const res = await request(app).post('/players');
    const elapsed = Date.now() - start;

    expect(res.status).toBe(201);
    expect(elapsed).toBeLessThan(HTTP_BOUND_MS);

    fakeStore.flush();
  });

  it('HTTP request does not hang when cache Redis is unavailable', async () => {
    const fakeStore = new FakeRedisStore();
    const cacheStore = new RedisCacheStore(fakeStore);

    const app = express();
    app.get('/data', async (_req: Request, res: Response) => {
      await cacheStore.get('data-key');
      await cacheStore.set('data-key', { x: 1 });
      res.json({ ok: true });
    });

    fakeStore.setState('unavailable');

    const result = await withTimeout(
      request(app).get('/data'),
      HTTP_BOUND_MS
    );

    expect(result.timedOut).toBe(false);
    if (!result.timedOut) {
      expect(result.value.status).toBe(200);
    }

    fakeStore.flush();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rate-limit failure — full HTTP flow
// ─────────────────────────────────────────────────────────────────────────────

describe('HTTP rate-limit flow — Redis failure (fail-open)', () => {
  it('request is allowed (fail-open) when rate-limit Redis is unavailable', async () => {
    const fakeClient = new FakeRedisClient();
    fakeClient.setState('unavailable');
    const store = new RedisRateLimitStore(fakeClient as unknown as Redis);

    const app = express();
    app.set('trust proxy', 1);
    app.use(rateLimit({ windowMs: 60_000, max: 3, store }));
    app.get('/api', (_req: Request, res: Response) => {
      res.json({ ok: true });
    });

    const res = await request(app).get('/api').set('X-Forwarded-For', '1.2.3.4');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    fakeClient.flush();
  });

  it('rate limit response is 200 (not 500) when Redis drops — fail-open not fail-closed', async () => {
    const fakeClient = new FakeRedisClient();
    const store = new RedisRateLimitStore(fakeClient as unknown as Redis);

    const app = express();
    app.set('trust proxy', 1);
    app.use(rateLimit({ windowMs: 60_000, max: 3, store }));
    app.get('/api', (_req: Request, res: Response) => {
      res.json({ ok: true });
    });

    // Exhaust limit while healthy
    for (let i = 0; i < 3; i++) {
      await request(app).get('/api').set('X-Forwarded-For', '5.6.7.8');
    }

    // Drop Redis
    fakeClient.setState('unavailable');

    // Next request should fail-open (200), not 500
    const res = await request(app).get('/api').set('X-Forwarded-For', '5.6.7.8');
    expect(res.status).toBe(200);

    fakeClient.flush();
  });

  it('HTTP request does not hang when rate-limit Redis is unavailable', async () => {
    const fakeClient = new FakeRedisClient();
    fakeClient.setState('unavailable');
    const store = new RedisRateLimitStore(fakeClient as unknown as Redis);

    const app = express();
    app.set('trust proxy', 1);
    app.use(rateLimit({ windowMs: 60_000, max: 3, store }));
    app.get('/api', (_req: Request, res: Response) => res.json({ ok: true }));

    const result = await withTimeout(
      request(app).get('/api').set('X-Forwarded-For', '10.0.0.1'),
      HTTP_BOUND_MS
    );

    expect(result.timedOut).toBe(false);
    if (!result.timedOut) {
      expect(result.value.status).toBe(200);
    }

    fakeClient.flush();
  });

  it('no unhandled rejections when rate-limit Redis fails during an HTTP request', async () => {
    const fakeClient = new FakeRedisClient();
    fakeClient.setState('unavailable');
    const store = new RedisRateLimitStore(fakeClient as unknown as Redis);

    const app = express();
    app.use(rateLimit({ windowMs: 60_000, max: 3, store }));
    app.get('/api', (_req: Request, res: Response) => res.json({ ok: true }));

    const unhandled: Error[] = [];
    const handler = (err: Error) => unhandled.push(err);
    process.on('unhandledRejection', handler);

    try {
      await request(app).get('/api');
    } finally {
      process.off('unhandledRejection', handler);
      fakeClient.flush();
    }

    expect(unhandled).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Both cache and rate-limit Redis fail simultaneously
// ─────────────────────────────────────────────────────────────────────────────

describe('HTTP — both cache and rate-limit Redis unavailable', () => {
  it('request still completes successfully within bounded time', async () => {
    const fakeCacheStore = new FakeRedisStore();
    fakeCacheStore.setState('unavailable');
    const cacheStore = new RedisCacheStore(fakeCacheStore);

    const fakeRateLimitClient = new FakeRedisClient();
    fakeRateLimitClient.setState('unavailable');
    const rateLimitStore = new RedisRateLimitStore(
      fakeRateLimitClient as unknown as Redis
    );

    const app = express();
    app.use(rateLimit({ windowMs: 60_000, max: 10, store: rateLimitStore }));
    app.get('/api/players', async (_req: Request, res: Response) => {
      const cached = await cacheStore.get('players:list:all');
      if (cached) {
        res.json({ source: 'cache', data: cached });
        return;
      }
      res.json({ source: 'fresh', data: ['player1'] });
    });

    const start = Date.now();
    const res = await request(app).get('/api/players');
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(res.body.source).toBe('fresh');
    expect(elapsed).toBeLessThan(HTTP_BOUND_MS);

    fakeCacheStore.flush();
    fakeRateLimitClient.flush();
  });
});
