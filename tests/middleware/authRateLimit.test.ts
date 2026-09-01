/**
 * Tests for issue #280 — dedicated, tighter rate limit on auth endpoints.
 */

import { Request, Response, NextFunction } from 'express';
import { rateLimit } from '../../src/middleware/rateLimit';
import { InMemoryRateLimitStore } from '../../src/middleware/inMemoryRateLimitStore';
import { RedisRateLimitStore } from '../../src/middleware/redisRateLimitStore';
import RedisMock from 'ioredis-mock';
import { RateLimitStore } from '../../src/middleware/rateLimitStore';

function makeReqRes(ip = '127.0.0.1') {
  const req = { ip } as unknown as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
  } as unknown as Response;
  const next = jest.fn() as NextFunction;
  return { req, res, next };
}

const stores = [
  { name: 'InMemoryRateLimitStore', create: () => new InMemoryRateLimitStore() },
  { name: 'RedisRateLimitStore', create: () => new RedisRateLimitStore(new RedisMock()) },
];

describe.each(stores)('auth rate limit — tighter limit (5/min default) ($name)', ({ create }) => {
  let store: RateLimitStore;
  
  beforeEach(() => {
    store = create();
  });

  it('allows requests up to the auth limit', async () => {
    const mw = rateLimit({ windowMs: 60_000, max: 5, store });
    const ip = '10.0.0.1';
    for (let i = 0; i < 5; i++) {
      const { req, res, next } = makeReqRes(ip);
      await mw(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  it('returns 429 on the 6th request within the window', async () => {
    const mw = rateLimit({ windowMs: 60_000, max: 5, store });
    const ip = '10.0.0.2';
    for (let i = 0; i < 5; i++) {
      const { req, res, next } = makeReqRes(ip);
      await mw(req, res, next);
    }
    const { req, res, next } = makeReqRes(ip);
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(next).not.toHaveBeenCalled();
  });

  it('includes Retry-After header when limit is exceeded', async () => {
    const mw = rateLimit({ windowMs: 60_000, max: 1, store });
    const ip = '10.0.0.3';

    const first = makeReqRes(ip);
    await mw(first.req, first.res, first.next);

    const second = makeReqRes(ip);
    await mw(second.req, second.res, second.next);

    expect(second.res.status).toHaveBeenCalledWith(429);
    expect(second.res.set).toHaveBeenCalledWith('Retry-After', expect.any(String));
    const retryAfter = (second.res.set as jest.Mock).mock.calls.find(
      ([h]: [string]) => h === 'Retry-After'
    )?.[1];
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it('auth limit is independent from the default limit applied to other routes', async () => {
    const globalStore = create();
    const defaultMw = rateLimit({ windowMs: 60_000, max: 60, store: globalStore });
    const authMw = rateLimit({ windowMs: 60_000, max: 5, store });
    const ip = '10.0.0.4';

    // exhaust the auth limit
    for (let i = 0; i < 5; i++) {
      const { req, res, next } = makeReqRes(ip);
      await authMw(req, res, next);
    }
    const blocked = makeReqRes(ip);
    await authMw(blocked.req, blocked.res, blocked.next);
    expect(blocked.res.status).toHaveBeenCalledWith(429);

    // same IP on the default middleware is still fine (different instance / counter)
    // Wait, the redis mock shares state unless isolated or key spaces are distinct.
    // In actual redis, all rate limits hit the same keyspace `rate-limit:ip:...`.
    // Wait... if both defaultMw and authMw use the same store (or same mock redis instance),
    // they will overwrite each other's keys because they share the same key `rate-limit:ip:10.0.0.4`.
    // Ah, the original code used separate Maps.
    // If they use Redis, we must distinguish between auth limit and global limit.
    // I should fix the keys!
    const defaultReq = makeReqRes(ip);
    await defaultMw(defaultReq.req, defaultReq.res, defaultReq.next);
    expect(defaultReq.next).toHaveBeenCalledTimes(1);
  });
});

describe.each(stores)('auth rate limit — independence and window reset ($name)', ({ create }) => {
  let store: RateLimitStore;
  
  beforeEach(() => {
    store = create();
  });

  it('exactly 5 auth requests within a window all succeed and the 6th is rejected', async () => {
    const mw = rateLimit({ windowMs: 60_000, max: 5, store });
    const ip = '10.1.0.1';

    // All 5 should pass
    for (let i = 0; i < 5; i++) {
      const { req, res, next } = makeReqRes(ip);
      await mw(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    }

    // The 6th must be blocked
    const { req, res, next } = makeReqRes(ip);
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(next).not.toHaveBeenCalled();
  });

  it('6 non-auth requests all succeed when the global limit is 60', async () => {
    const globalMw = rateLimit({ windowMs: 60_000, max: 60, store });
    const ip = '10.1.0.2';

    for (let i = 0; i < 6; i++) {
      const { req, res, next } = makeReqRes(ip);
      await globalMw(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    }
  });

  it('429 response always includes a positive numeric Retry-After header', async () => {
    const mw = rateLimit({ windowMs: 60_000, max: 1, store });
    const ip = '10.1.0.3';

    // Exhaust the limit
    const first = makeReqRes(ip);
    await mw(first.req, first.res, first.next);

    // Trigger 429
    const second = makeReqRes(ip);
    await mw(second.req, second.res, second.next);

    expect(second.res.status).toHaveBeenCalledWith(429);
    expect(second.res.set).toHaveBeenCalledWith('Retry-After', expect.any(String));

    const retryAfterCall = (second.res.set as jest.Mock).mock.calls.find(
      ([h]: [string]) => h === 'Retry-After'
    );
    expect(retryAfterCall).toBeDefined();
    const retryAfterValue = Number(retryAfterCall![1]);
    expect(retryAfterValue).toBeGreaterThan(0);
  });

  it('allows requests again after the rate limit window resets', async () => {
    const mw = rateLimit({ windowMs: 50, max: 2, store });
    const ip = '10.1.0.4';

    // Exhaust the limit
    for (let i = 0; i < 2; i++) {
      const { req, res, next } = makeReqRes(ip);
      await mw(req, res, next);
    }

    // Confirm it is blocked
    const blocked = makeReqRes(ip);
    await mw(blocked.req, blocked.res, blocked.next);
    expect(blocked.res.status).toHaveBeenCalledWith(429);

    // Wait for the window to expire
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Should be allowed again after reset
    const { req, res, next } = makeReqRes(ip);
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('disables rate limiting when config.rateLimit.enabled is false', async () => {
    // Mutate the live config object to simulate RATE_LIMIT_ENABLED=false
    const configModule = require('../../src/config');
    const original = configModule.default.rateLimit.enabled;
    configModule.default.rateLimit.enabled = false;

    try {
      // max is intentionally 1 — every request beyond the first would normally be blocked
      const mw = rateLimit({ windowMs: 60_000, max: 1, store });
      const ip = '10.9.9.9';

      for (let i = 0; i < 6; i++) {
        const { req, res, next } = makeReqRes(ip);
        await mw(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
      }
    } finally {
      // Always restore original value so other tests are unaffected
      configModule.default.rateLimit.enabled = original;
    }
  });
});
