import { Request, Response, NextFunction } from 'express';
import express from 'express';
import request from 'supertest';
import { rateLimit, walletRateLimit } from '../../src/middleware/rateLimit';
import { InMemoryRateLimitStore } from '../../src/middleware/inMemoryRateLimitStore';
import { RedisRateLimitStore } from '../../src/middleware/redisRateLimitStore';
import RedisMock from 'ioredis-mock';
import { RateLimitStore } from '../../src/middleware/rateLimitStore';

// ── Unit tests for rateLimit middleware ──────────────────────────────────────

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

describe.each(stores)('rateLimit middleware ($name)', ({ create }) => {
  let store: RateLimitStore;
  
  beforeEach(() => {
    store = create();
  });

  it('allows requests under the limit', async () => {
    const mw = rateLimit({ windowMs: 60_000, max: 3, store });
    for (let i = 0; i < 3; i++) {
      const { req, res, next } = makeReqRes('1.1.1.1');
      await mw(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    }
  });

  it('returns 429 when limit is exceeded', async () => {
    const mw = rateLimit({ windowMs: 60_000, max: 2, store });
    const ip = '2.2.2.2';
    for (let i = 0; i < 2; i++) {
      const { req, res, next } = makeReqRes(ip);
      await mw(req, res, next);
    }
    const { req, res, next } = makeReqRes(ip);
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(next).not.toHaveBeenCalled();
  });

  it('resets the counter after the window expires', async () => {
    const mw = rateLimit({ windowMs: 50, max: 1, store });
    const ip = '3.3.3.3';

    const first = makeReqRes(ip);
    await mw(first.req, first.res, first.next);
    expect(first.next).toHaveBeenCalledTimes(1);

    const second = makeReqRes(ip);
    await mw(second.req, second.res, second.next);
    expect(second.res.status).toHaveBeenCalledWith(429);

    await new Promise((r) => setTimeout(r, 60));

    const third = makeReqRes(ip);
    await mw(third.req, third.res, third.next);
    expect(third.next).toHaveBeenCalledTimes(1);
  });

  it('tracks IPs independently', async () => {
    const mw = rateLimit({ windowMs: 60_000, max: 1, store });
    const a = makeReqRes('4.4.4.4');
    await mw(a.req, a.res, a.next);
    expect(a.next).toHaveBeenCalledTimes(1);

    const b = makeReqRes('5.5.5.5');
    await mw(b.req, b.res, b.next);
    expect(b.next).toHaveBeenCalledTimes(1);
  });

  it('does not undercount under concurrent requests (concurrency test)', async () => {
    const max = 5;
    const mw = rateLimit({ windowMs: 60_000, max, store });
    const ip = 'concurrency.test.ip';

    // Fire 10 requests concurrently
    const requests = Array.from({ length: 10 }, () => makeReqRes(ip));
    await Promise.all(requests.map(r => mw(r.req, r.res, r.next)));

    const successCount = requests.filter(r => (r.next as jest.Mock).mock.calls.length > 0).length;
    const blockedCount = requests.filter(r => (r.res.status as jest.Mock).mock.calls.length > 0).length;

    expect(successCount).toBe(5);
    expect(blockedCount).toBe(5);
  });
});

// ── Integration: POST /api/validators/milestone throttling ───────────────────
// Confirms the middleware correctly throttles repeated requests from the same IP.
describe.each(stores)('POST /api/validators/milestone rate limiting (middleware integration) ($name)', ({ create }) => {
  let store: RateLimitStore;
  
  beforeEach(() => {
    store = create();
  });

  it('returns 429 after exceeding the configured limit', async () => {
    const mw = rateLimit({ windowMs: 60_000, max: 1, store });
    const ip = '9.9.9.9';

    const first = makeReqRes(ip);
    await mw(first.req, first.res, first.next);
    expect(first.next).toHaveBeenCalledTimes(1);

    const second = makeReqRes(ip);
    await mw(second.req, second.res, second.next);
    expect(second.res.status).toHaveBeenCalledWith(429);
    expect(second.next).not.toHaveBeenCalled();
  });
});

// ── Unit tests for walletRateLimit middleware ────────────────────────────────
describe.each(stores)('walletRateLimit middleware ($name)', ({ create }) => {
  let store: RateLimitStore;
  
  beforeEach(() => {
    store = create();
  });

  function makeReqResWithWallet(wallet?: string, ip = '127.0.0.1') {
    const req = { ip, account: wallet } as unknown as Request;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;
    const next = jest.fn() as NextFunction;
    return { req, res, next };
  }

  it('allows requests under the limit by wallet', async () => {
    const mw = walletRateLimit({ windowMs: 60_000, max: 3, store });
    for (let i = 0; i < 3; i++) {
      const { req, res, next } = makeReqResWithWallet('G_WALLET_1');
      await mw(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    }
  });

  it('returns 429 when limit is exceeded by wallet', async () => {
    const mw = walletRateLimit({ windowMs: 60_000, max: 2, store });
    const wallet = 'G_WALLET_2';
    for (let i = 0; i < 2; i++) {
      const { req, res, next } = makeReqResWithWallet(wallet);
      await mw(req, res, next);
    }
    const { req, res, next } = makeReqResWithWallet(wallet);
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(next).not.toHaveBeenCalled();
  });

  it('ignores requests if req.account is not present', async () => {
    const mw = walletRateLimit({ windowMs: 60_000, max: 1, store });
    const { req, res, next } = makeReqResWithWallet(undefined);
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();

    // Call again to verify it is not blocked
    const second = makeReqResWithWallet(undefined);
    await mw(second.req, second.res, second.next);
    expect(second.next).toHaveBeenCalledTimes(1);
    expect(second.res.status).not.toHaveBeenCalled();
  });
});
