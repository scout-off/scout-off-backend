/**
 * Tests for issue #1587 — pin down src/middleware/apiKeyRateLimit.ts behaviour.
 *
 * Uses a minimal fake Redis (incr/expire/get) and a mocked
 * getApiKeyRateLimits. No real Redis required.
 */

import { Request, Response, NextFunction } from 'express';

const mockGetRedisClient = jest.fn();
const mockGetApiKeyRateLimits = jest.fn();

jest.mock('../../src/services/redis', () => ({
  getRedisClient: (...args: unknown[]) => mockGetRedisClient(...args),
}));

jest.mock('../../src/db/apiKeyHelpers', () => ({
  getApiKeyRateLimits: (...args: unknown[]) => mockGetApiKeyRateLimits(...args),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import {
  apiKeyRateLimit,
  _clearApiKeyRateLimitCache,
} from '../../src/middleware/apiKeyRateLimit';

/** Minimal fake exposing incr/expire/get with call tracking. */
function makeFakeRedis() {
  const counts = new Map<string, number>();
  const expire = jest.fn(async (_key: string, _ttl: number) => 1);
  const incr = jest.fn(async (key: string) => {
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return next;
  });
  const get = jest.fn(async (key: string) => {
    const v = counts.get(key);
    return v === undefined ? null : String(v);
  });
  return { incr, expire, get, counts };
}

function makeReqRes(apiKeyId?: number) {
  const req = { apiKeyId } as unknown as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
  } as unknown as Response;
  const next = jest.fn() as unknown as NextFunction;
  return { req, res, next };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  _clearApiKeyRateLimitCache();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('apiKeyRateLimit', () => {
  it('calls next() immediately without touching Redis when no apiKeyId is set', async () => {
    const { req, res, next } = makeReqRes(undefined);
    await apiKeyRateLimit(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockGetRedisClient).not.toHaveBeenCalled();
    expect(mockGetApiKeyRateLimits).not.toHaveBeenCalled();
  });

  it('allows requests 1-2 and returns 429 with the documented code on request 3 (limit 2/min)', async () => {
    const fake = makeFakeRedis();
    mockGetRedisClient.mockReturnValue(fake);
    mockGetApiKeyRateLimits.mockResolvedValue({ rate_limit_per_minute: 2, monthly_quota: null });

    for (let i = 0; i < 2; i++) {
      const { req, res, next } = makeReqRes(7);
      await apiKeyRateLimit(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    }

    const blocked = makeReqRes(7);
    await apiKeyRateLimit(blocked.req, blocked.res, blocked.next);
    expect(blocked.res.status).toHaveBeenCalledWith(429);
    expect(blocked.res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'API_KEY_RATE_LIMIT_EXCEEDED' }),
    );
    expect(blocked.next).not.toHaveBeenCalled();
  });

  it('sets expiry once on the first request in a window (expire called with 60)', async () => {
    const fake = makeFakeRedis();
    mockGetRedisClient.mockReturnValue(fake);
    mockGetApiKeyRateLimits.mockResolvedValue({ rate_limit_per_minute: 10, monthly_quota: null });

    const first = makeReqRes(11);
    await apiKeyRateLimit(first.req, first.res, first.next);
    expect(fake.incr).toHaveBeenCalledTimes(1);
    expect(fake.expire).toHaveBeenCalledTimes(1);
    expect(fake.expire).toHaveBeenCalledWith(expect.stringContaining('apikey:ratelimit:11'), 60);

    const second = makeReqRes(11);
    await apiKeyRateLimit(second.req, second.res, second.next);
    expect(fake.incr).toHaveBeenCalledTimes(2);
    // Expiry is only set on the first increment of the window.
    expect(fake.expire).toHaveBeenCalledTimes(1);
  });

  it('fails open with a warning when no Redis client is available', async () => {
    const { logger } = require('../../src/utils/logger');
    mockGetRedisClient.mockReturnValue(null);
    mockGetApiKeyRateLimits.mockResolvedValue({ rate_limit_per_minute: 1, monthly_quota: null });

    const { req, res, next } = makeReqRes(21);
    await apiKeyRateLimit(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalledWith(429);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('caches key config: two requests within 5 minutes hit the DB once (fake timers)', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-01T00:00:00Z'));
    const fake = makeFakeRedis();
    mockGetRedisClient.mockReturnValue(fake);
    mockGetApiKeyRateLimits.mockResolvedValue({ rate_limit_per_minute: 100, monthly_quota: null });

    const a = makeReqRes(31);
    await apiKeyRateLimit(a.req, a.res, a.next);
    const b = makeReqRes(31);
    await apiKeyRateLimit(b.req, b.res, b.next);
    expect(mockGetApiKeyRateLimits).toHaveBeenCalledTimes(1);

    // Advance past the 5-minute TTL: the next request must re-fetch config.
    jest.setSystemTime(new Date('2026-03-01T00:06:00Z'));
    const c = makeReqRes(31);
    await apiKeyRateLimit(c.req, c.res, c.next);
    expect(mockGetApiKeyRateLimits).toHaveBeenCalledTimes(2);
  });

  it('uses a YYYY-MM UTC month key (verified around a month boundary via setSystemTime)', async () => {
    const seenKeys: string[] = [];
    const fake = {
      incr: jest.fn(async (key: string) => {
        seenKeys.push(key);
        return 1;
      }),
      expire: jest.fn(async () => 1),
      get: jest.fn(async () => null),
    };
    mockGetRedisClient.mockReturnValue(fake);
    // No per-minute limit so only the quota path runs (isolates the month key).
    mockGetApiKeyRateLimits.mockResolvedValue({ rate_limit_per_minute: null, monthly_quota: 5 });

    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-31T23:59:59Z'));
    const jan = makeReqRes(41);
    await apiKeyRateLimit(jan.req, jan.res, jan.next);
    expect(seenKeys[0]).toContain(':2026-01');

    _clearApiKeyRateLimitCache();
    jest.setSystemTime(new Date('2026-02-01T00:00:01Z'));
    const feb = makeReqRes(41);
    await apiKeyRateLimit(feb.req, feb.res, feb.next);
    expect(seenKeys[1]).toContain(':2026-02');
  });

  it('returns 429 API_KEY_QUOTA_EXCEEDED when the monthly quota is reached', async () => {
    const fake = makeFakeRedis();
    mockGetRedisClient.mockReturnValue(fake);
    mockGetApiKeyRateLimits.mockResolvedValue({ rate_limit_per_minute: null, monthly_quota: 1 });

    const first = makeReqRes(51);
    await apiKeyRateLimit(first.req, first.res, first.next);
    expect(first.next).toHaveBeenCalledTimes(1);

    const second = makeReqRes(51);
    await apiKeyRateLimit(second.req, second.res, second.next);
    expect(second.res.status).toHaveBeenCalledWith(429);
    expect(second.res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'API_KEY_QUOTA_EXCEEDED' }),
    );
    expect(second.next).not.toHaveBeenCalled();
  });
});
