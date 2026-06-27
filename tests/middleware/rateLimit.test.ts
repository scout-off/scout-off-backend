import { Request, Response, NextFunction } from 'express';
import { rateLimit } from '../../src/middleware/rateLimit';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReqRes(ip = '127.0.0.1') {
  const headers: Record<string, string> = {};
  const req = { ip } as unknown as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn((name: string, value: string) => {
      headers[name] = value;
    }),
    _headers: headers,
  } as unknown as Response & { _headers: Record<string, string> };
  const next = jest.fn() as NextFunction;
  return { req, res, next };
}

// ── Core behaviour ────────────────────────────────────────────────────────────

describe('rateLimit middleware', () => {
  it('allows requests under the limit', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 3 });
    for (let i = 0; i < 3; i++) {
      const { req, res, next } = makeReqRes('1.1.1.1');
      mw(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    }
  });

  it('returns 429 when limit is exceeded', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 2 });
    const ip = '2.2.2.2';
    for (let i = 0; i < 2; i++) {
      const { req, res, next } = makeReqRes(ip);
      mw(req, res, next);
    }
    const { req, res, next } = makeReqRes(ip);
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(next).not.toHaveBeenCalled();
  });

  it('resets the counter after the window expires', async () => {
    const mw = rateLimit({ windowMs: 50, max: 1 });
    const ip = '3.3.3.3';

    const first = makeReqRes(ip);
    mw(first.req, first.res, first.next);
    expect(first.next).toHaveBeenCalledTimes(1);

    const second = makeReqRes(ip);
    mw(second.req, second.res, second.next);
    expect(second.res.status).toHaveBeenCalledWith(429);

    await new Promise((r) => setTimeout(r, 60));

    const third = makeReqRes(ip);
    mw(third.req, third.res, third.next);
    expect(third.next).toHaveBeenCalledTimes(1);
  });

  it('tracks IPs independently', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 1 });
    const a = makeReqRes('4.4.4.4');
    mw(a.req, a.res, a.next);
    expect(a.next).toHaveBeenCalledTimes(1);

    const b = makeReqRes('5.5.5.5');
    mw(b.req, b.res, b.next);
    expect(b.next).toHaveBeenCalledTimes(1);
  });
});

// ── X-RateLimit-* headers ─────────────────────────────────────────────────────

describe('rateLimit middleware — standard rate-limit headers', () => {
  it('sets X-RateLimit-Limit to the configured max', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 10 });
    const { req, res, next } = makeReqRes('10.0.0.1');
    mw(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '10');
  });

  it('sets X-RateLimit-Remaining to max-1 on first request', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 10 });
    const { req, res, next } = makeReqRes('10.0.0.2');
    mw(req, res, next);
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '9');
  });

  it('decrements X-RateLimit-Remaining with each successive request', () => {
    const ip = '10.0.0.3';
    const mw = rateLimit({ windowMs: 60_000, max: 5 });

    // request 1 → remaining 4
    const r1 = makeReqRes(ip);
    mw(r1.req, r1.res, r1.next);
    expect(r1.res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '4');

    // request 2 → remaining 3
    const r2 = makeReqRes(ip);
    mw(r2.req, r2.res, r2.next);
    expect(r2.res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '3');

    // request 3 → remaining 2
    const r3 = makeReqRes(ip);
    mw(r3.req, r3.res, r3.next);
    expect(r3.res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '2');

    // request 4 → remaining 1
    const r4 = makeReqRes(ip);
    mw(r4.req, r4.res, r4.next);
    expect(r4.res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '1');

    // request 5 (at limit) → remaining 0
    const r5 = makeReqRes(ip);
    mw(r5.req, r5.res, r5.next);
    expect(r5.res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '0');
    expect(r5.next).toHaveBeenCalled(); // still allowed — count == max

    // request 6 (over limit) → still remaining 0, returns 429
    const r6 = makeReqRes(ip);
    mw(r6.req, r6.res, r6.next);
    expect(r6.res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '0');
    expect(r6.res.status).toHaveBeenCalledWith(429);
    expect(r6.next).not.toHaveBeenCalled();
  });

  it('sets X-RateLimit-Reset as a Unix timestamp (seconds) in the future', () => {
    const before = Math.floor(Date.now() / 1000);
    const mw = rateLimit({ windowMs: 60_000, max: 5 });
    const { req, res } = makeReqRes('10.0.0.4');
    mw(req, res, jest.fn());

    const setHeaderCalls: [string, string][] = (res.setHeader as jest.Mock).mock.calls;
    const resetCall = setHeaderCalls.find(([name]) => name === 'X-RateLimit-Reset');
    expect(resetCall).toBeDefined();
    const resetAt = parseInt(resetCall![1], 10);
    expect(resetAt).toBeGreaterThanOrEqual(before + 60);
    expect(resetAt).toBeLessThanOrEqual(before + 61);
  });

  it('sets X-RateLimit-* and Retry-After headers on 429 responses', () => {
    const ip = '10.0.0.5';
    const mw = rateLimit({ windowMs: 60_000, max: 1 });

    // Exhaust the limit
    mw(makeReqRes(ip).req, makeReqRes(ip).res, jest.fn());

    // Trigger 429
    const { req, res, next } = makeReqRes(ip);
    mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(next).not.toHaveBeenCalled();

    const calls: [string, string][] = (res.setHeader as jest.Mock).mock.calls;
    const header = (name: string) => calls.find(([n]) => n === name)?.[1];

    expect(header('X-RateLimit-Limit')).toBe('1');
    expect(header('X-RateLimit-Remaining')).toBe('0');
    expect(header('X-RateLimit-Reset')).toBeDefined();
    expect(header('Retry-After')).toBeDefined();

    const retryAfter = parseInt(header('Retry-After')!, 10);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });
});

// ── Integration: POST /api/validators/milestone throttling ────────────────────
describe('POST /api/validators/milestone rate limiting (middleware integration)', () => {
  it('returns 429 after exceeding the configured limit', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 1 });
    const ip = '9.9.9.9';

    const first = makeReqRes(ip);
    mw(first.req, first.res, first.next);
    expect(first.next).toHaveBeenCalledTimes(1);

    const second = makeReqRes(ip);
    mw(second.req, second.res, second.next);
    expect(second.res.status).toHaveBeenCalledWith(429);
    expect(second.next).not.toHaveBeenCalled();
  });
});
