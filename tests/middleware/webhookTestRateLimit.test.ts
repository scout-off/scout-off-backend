/**
 * Tests for issue #1037 — dedicated, tighter rate limit on the webhook
 * test-delivery route (POST /api/scouts/:wallet/webhooks/:id/test).
 *
 * Unlike a normal scout write, this endpoint makes the backend issue an
 * outbound HTTP request to a caller-supplied URL, so it's wired to its own
 * 'webhook-test' namespaced walletRateLimit() instance (see
 * src/routes/scout.ts) instead of sharing the default pool used by
 * subscribe/unlockContact/createTrialOffer. These tests exercise that same
 * production configuration shape directly against a minimal Express app,
 * proving both that the limit trips at the configured ceiling and that the
 * outbound request is never attempted once it does.
 */
import express, { Request, Response } from 'express';
import request from 'supertest';
import { walletRateLimit } from '../../src/middleware/rateLimit';
import { InMemoryRateLimitStore } from '../../src/middleware/inMemoryRateLimitStore';
import { RedisRateLimitStore } from '../../src/middleware/redisRateLimitStore';
import RedisMock from 'ioredis-mock';
import { RateLimitStore } from '../../src/middleware/rateLimitStore';

const stores = [
  { name: 'InMemoryRateLimitStore', create: () => new InMemoryRateLimitStore() },
  { name: 'RedisRateLimitStore', create: () => new RedisRateLimitStore(new RedisMock()) },
];

describe.each(stores)('webhook test-delivery rate limit (#1037) ($name)', ({ create }) => {
  let store: RateLimitStore;
  let mockOutboundFetch: jest.Mock;

  function buildApp(max: number) {
    const app = express();
    app.use((req, _res, next) => {
      // Stand-in for the real auth middleware, which sets req.account from
      // the Bearer token before walletRateLimit runs.
      (req as Request & { account?: string }).account = req.header('x-wallet') ?? undefined;
      next();
    });
    app.post(
      '/webhooks/:id/test',
      walletRateLimit({ name: 'webhook-test', windowMs: 60_000, max, store }),
      async (_req: Request, res: Response) => {
        await mockOutboundFetch('https://example.com/hook');
        res.json({ success: true });
      },
    );
    return app;
  }

  beforeEach(() => {
    store = create();
    mockOutboundFetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
  });

  it('allows up to the configured limit and attempts the outbound request each time', async () => {
    const app = buildApp(2);
    for (let i = 0; i < 2; i++) {
      const res = await request(app).post('/webhooks/1/test').set('x-wallet', 'GWALLET_A');
      expect(res.status).toBe(200);
    }
    expect(mockOutboundFetch).toHaveBeenCalledTimes(2);
  });

  it('returns 429 on the request past the limit and never attempts the outbound call', async () => {
    const app = buildApp(2);
    const wallet = 'GWALLET_B';

    for (let i = 0; i < 2; i++) {
      await request(app).post('/webhooks/1/test').set('x-wallet', wallet);
    }
    expect(mockOutboundFetch).toHaveBeenCalledTimes(2);

    const blocked = await request(app).post('/webhooks/1/test').set('x-wallet', wallet);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ success: false, error: 'Too many requests, please try again later' });

    // The rejection must happen before the handler runs — no 3rd outbound call.
    expect(mockOutboundFetch).toHaveBeenCalledTimes(2);
  });

  it('is isolated per-wallet: a different wallet is unaffected by another wallet being rate limited', async () => {
    const app = buildApp(1);

    const first = await request(app).post('/webhooks/1/test').set('x-wallet', 'GWALLET_C');
    expect(first.status).toBe(200);
    const blocked = await request(app).post('/webhooks/1/test').set('x-wallet', 'GWALLET_C');
    expect(blocked.status).toBe(429);

    const otherWallet = await request(app).post('/webhooks/1/test').set('x-wallet', 'GWALLET_D');
    expect(otherWallet.status).toBe(200);
    expect(mockOutboundFetch).toHaveBeenCalledTimes(2);
  });

  it('is isolated from the default walletRateLimit() pool used by other scout write routes', async () => {
    const defaultStore = create();
    const wallet = 'GWALLET_E';

    // Exhaust the default (un-named) pool for this wallet.
    const defaultMw = walletRateLimit({ windowMs: 60_000, max: 1, store: defaultStore });
    const app = express();
    app.use((req, _res, next) => {
      (req as Request & { account?: string }).account = wallet;
      next();
    });
    app.post('/other-write', defaultMw, (_req, res) => res.json({ success: true }));
    app.post(
      '/webhooks/1/test',
      walletRateLimit({ name: 'webhook-test', windowMs: 60_000, max: 2, store: defaultStore }),
      async (_req, res) => {
        await mockOutboundFetch();
        res.json({ success: true });
      },
    );

    await request(app).post('/other-write');
    const otherBlocked = await request(app).post('/other-write');
    expect(otherBlocked.status).toBe(429);

    // Same wallet, same store — but the 'webhook-test' namespace has its own budget.
    const testDeliveryRes = await request(app).post('/webhooks/1/test');
    expect(testDeliveryRes.status).toBe(200);
    expect(mockOutboundFetch).toHaveBeenCalledTimes(1);
  });
});
