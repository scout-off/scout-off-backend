/**
 * tests/controllers/playerTokenController.test.ts
 *
 * Unit + concurrency tests for the buyPlayerToken and getPlayerTokenHolders
 * handlers. Controllers are called directly (no HTTP server) using mock
 * req/res/next objects so the suite is fast and self-contained.
 */

import {
  buyPlayerToken,
  getPlayerTokenHolders,
  _stubSeedTokens,
  _stubReset,
  _stubResetMutexes,
} from '../../src/controllers/playerTokenController';
import { clearFeatureFlagCache, setFeatureFlag } from '../../src/services/featureFlags';
import { FeatureFlags } from '../../src/services/featureFlags';

// ── Mock helpers ──────────────────────────────────────────────────────────────

function mockReqRes(playerId: string, body: unknown = {}) {
  const req = { params: { playerId }, body } as any;
  let statusCode = 200;
  let responseBody: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(data: unknown) {
      responseBody = data;
    },
    get statusCode() {
      return statusCode;
    },
    get responseBody() {
      return responseBody;
    },
  } as any;
  const next = jest.fn();
  return {
    req,
    res,
    next,
    getStatus: () => statusCode,
    getBody: () => responseBody as any,
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('playerTokenController', () => {
  beforeEach(() => {
    // Enable the feature flag so the guards pass.
    setFeatureFlag(FeatureFlags.PLAYER_TOKENS, true, 'test');
    _stubReset();
    _stubResetMutexes();
  });

  afterEach(() => {
    // Disable the flag and flush cache so other test suites are unaffected.
    setFeatureFlag(FeatureFlags.PLAYER_TOKENS, false, 'test');
    clearFeatureFlagCache();
    jest.restoreAllMocks();
  });

  // ── Feature flag guard ──────────────────────────────────────────────────────

  describe('feature flag guard', () => {
    it('returns 404 when player_tokens flag is disabled', async () => {
      setFeatureFlag(FeatureFlags.PLAYER_TOKENS, false, 'test');
      clearFeatureFlagCache();

      const { req, res, next, getStatus, getBody } = mockReqRes('player-1', {
        amount: 5,
        buyerWallet: 'WALLET1',
      });
      await buyPlayerToken(req, res, next);

      expect(getStatus()).toBe(404);
      expect(getBody().success).toBe(false);
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ── getPlayerTokenHolders ───────────────────────────────────────────────────

  describe('getPlayerTokenHolders', () => {
    it('returns 404 when no tokens have been issued', () => {
      const { req, res, next, getStatus, getBody } = mockReqRes('unknown-player');
      getPlayerTokenHolders(req, res, next);

      expect(getStatus()).toBe(404);
      expect(getBody().success).toBe(false);
      expect(getBody().error).toMatch(/no tokens/i);
    });

    it('returns holder list and supply info for a seeded player', async () => {
      _stubSeedTokens('player-a', 100);

      // Buy some tokens first so holders list is non-empty.
      const buyReq = { params: { playerId: 'player-a' }, body: { amount: 10, buyerWallet: 'WALLET_A' } } as any;
      let ignored: unknown;
      const buyRes = { status: () => buyRes, json: (d: unknown) => { ignored = d; } } as any;
      await buyPlayerToken(buyReq, buyRes, jest.fn());

      const { req, res, getStatus, getBody } = mockReqRes('player-a');
      getPlayerTokenHolders(req, res, jest.fn());

      expect(getStatus()).toBe(200);
      const data = getBody().data;
      expect(data.totalSupply).toBe(100);
      expect(data.soldTokens).toBe(10);
      expect(data.holders).toHaveLength(1);
      expect(data.holders[0]).toEqual({ holder: 'WALLET_A', tokens: 10 });
    });
  });

  // ── buyPlayerToken — happy path ─────────────────────────────────────────────

  describe('buyPlayerToken — happy path', () => {
    it('records a purchase and returns the new balance', async () => {
      _stubSeedTokens('player-1', 50);

      const { req, res, next, getStatus, getBody } = mockReqRes('player-1', {
        amount: 10,
        buyerWallet: 'WALLET_X',
      });
      await buyPlayerToken(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(getStatus()).toBe(200);
      const data = getBody().data;
      expect(data.playerId).toBe('player-1');
      expect(data.buyerWallet).toBe('WALLET_X');
      expect(data.amount).toBe(10);
      expect(data.newBalance).toBe(10);
    });

    it('accumulates balance across multiple purchases by the same buyer', async () => {
      _stubSeedTokens('player-2', 100);

      for (let i = 0; i < 3; i++) {
        const { req, res, next } = mockReqRes('player-2', {
          amount: 5,
          buyerWallet: 'WALLET_SAME',
        });
        await buyPlayerToken(req, res, next);
        expect(next).not.toHaveBeenCalled();
      }

      // Check the final state via getPlayerTokenHolders.
      const { req, res, getBody } = mockReqRes('player-2');
      getPlayerTokenHolders(req, res, jest.fn());
      const holders = getBody().data.holders as Array<{ holder: string; tokens: number }>;
      const entry = holders.find((h) => h.holder === 'WALLET_SAME');
      expect(entry?.tokens).toBe(15);
    });

    it('allows buying the entire remaining supply in one request', async () => {
      _stubSeedTokens('player-3', 20);

      const { req, res, next, getStatus, getBody } = mockReqRes('player-3', {
        amount: 20,
        buyerWallet: 'WHALE',
      });
      await buyPlayerToken(req, res, next);

      expect(getStatus()).toBe(200);
      expect(getBody().data.newBalance).toBe(20);
    });
  });

  // ── buyPlayerToken — error cases ────────────────────────────────────────────

  describe('buyPlayerToken — error cases', () => {
    it('returns 404 when player has no issued tokens', async () => {
      const { req, res, next, getStatus, getBody } = mockReqRes('no-such-player', {
        amount: 1,
        buyerWallet: 'WALLET_Y',
      });
      await buyPlayerToken(req, res, next);

      expect(getStatus()).toBe(404);
      expect(getBody().success).toBe(false);
    });

    it('returns 400 when amount is missing from body', async () => {
      _stubSeedTokens('player-4', 50);

      const { req, res, next, getStatus, getBody } = mockReqRes('player-4', {
        buyerWallet: 'WALLET_Z',
      });
      await buyPlayerToken(req, res, next);

      expect(getStatus()).toBe(400);
      expect(getBody().success).toBe(false);
    });

    it('returns 400 when buyerWallet is missing from body', async () => {
      _stubSeedTokens('player-5', 50);

      const { req, res, next, getStatus, getBody } = mockReqRes('player-5', {
        amount: 5,
      });
      await buyPlayerToken(req, res, next);

      expect(getStatus()).toBe(400);
      expect(getBody().success).toBe(false);
    });

    it('returns 400 when amount is zero', async () => {
      _stubSeedTokens('player-6', 50);

      const { req, res, next, getStatus, getBody } = mockReqRes('player-6', {
        amount: 0,
        buyerWallet: 'WALLET_W',
      });
      await buyPlayerToken(req, res, next);

      expect(getStatus()).toBe(400);
      expect(getBody().success).toBe(false);
    });

    it('returns 400 when amount is negative', async () => {
      _stubSeedTokens('player-7', 50);

      const { req, res, next, getStatus, getBody } = mockReqRes('player-7', {
        amount: -5,
        buyerWallet: 'WALLET_V',
      });
      await buyPlayerToken(req, res, next);

      expect(getStatus()).toBe(400);
      expect(getBody().success).toBe(false);
    });

    it('returns 409 with TOKEN_SUPPLY_EXHAUSTED code when amount exceeds remaining supply', async () => {
      _stubSeedTokens('player-8', 5);

      // First, exhaust the supply.
      const { req: r1, res: res1, next: n1 } = mockReqRes('player-8', {
        amount: 5,
        buyerWallet: 'BUYER_FIRST',
      });
      await buyPlayerToken(r1, res1, n1);
      expect(n1).not.toHaveBeenCalled();

      // Now attempt to buy more than what remains (0 left).
      const { req: r2, res: res2, next: n2, getStatus, getBody } = mockReqRes('player-8', {
        amount: 1,
        buyerWallet: 'BUYER_SECOND',
      });
      await buyPlayerToken(r2, res2, n2);

      expect(getStatus()).toBe(409);
      expect(getBody().success).toBe(false);
      expect(getBody().code).toBe('TOKEN_SUPPLY_EXHAUSTED');
      expect(getBody().error).toMatch(/supply exhausted/i);
    });
  });

  // ── buyPlayerToken — concurrency safety ────────────────────────────────────

  describe('buyPlayerToken — concurrency safety', () => {
    /**
     * Seed 10 tokens. Fire 10 concurrent buy requests each requesting 8
     * tokens. Only 1 can succeed (8 + 8 = 16 > 10). All others must fail
     * with a non-500 status (409 or 400), and the total sold must never
     * exceed 10.
     */
    it('serialises concurrent purchases and never oversells the supply', async () => {
      const playerId = 'concurrency-player';
      _stubSeedTokens(playerId, 10);

      const CONCURRENT = 10;
      const AMOUNT_EACH = 8;

      const calls = Array.from({ length: CONCURRENT }, (_, i) => {
        const { req, res, next } = mockReqRes(playerId, {
          amount: AMOUNT_EACH,
          buyerWallet: `WALLET_${i}`,
        });
        return { req, res, next };
      });

      // Fire all requests concurrently.
      await Promise.all(calls.map(({ req, res, next }) => buyPlayerToken(req, res, next)));

      // Tally results.
      const statuses = calls.map(({ res }) => (res as any).statusCode as number);
      const bodies = calls.map(({ res }) => (res as any).responseBody as any);

      // No request should have triggered the error handler (no 500s).
      for (const { next } of calls) {
        expect(next).not.toHaveBeenCalled();
      }

      // Exactly one request should succeed (200).
      const successes = statuses.filter((s) => s === 200);
      expect(successes).toHaveLength(1);

      // The single successful response should have the correct balance.
      const successBody = bodies.find((b) => b?.success === true);
      expect(successBody?.data?.amount).toBe(AMOUNT_EACH);
      expect(successBody?.data?.newBalance).toBe(AMOUNT_EACH);

      // All failures must be non-500 (409 or 400, not unhandled errors).
      const failures = statuses.filter((s) => s !== 200);
      expect(failures).toHaveLength(CONCURRENT - 1);
      for (const status of failures) {
        expect(status).toBeGreaterThanOrEqual(400);
        expect(status).toBeLessThan(500);
      }

      // Total sold must never exceed supply.
      const { req, res } = mockReqRes(playerId);
      getPlayerTokenHolders(req, res, jest.fn());
      const holdersData = (res as any).responseBody?.data;
      expect(holdersData.soldTokens).toBeLessThanOrEqual(10);
      expect(holdersData.soldTokens).toBe(AMOUNT_EACH); // exactly 8 were sold
    });

    it('allows concurrent purchases for different players without interference', async () => {
      _stubSeedTokens('player-alpha', 5);
      _stubSeedTokens('player-beta', 5);

      // Each player gets one buyer requesting 5 tokens simultaneously.
      const [callA, callB] = ['player-alpha', 'player-beta'].map((id) => {
        const { req, res, next } = mockReqRes(id, { amount: 5, buyerWallet: 'BUYER' });
        return { req, res, next, id };
      });

      await Promise.all([
        buyPlayerToken(callA.req, callA.res, callA.next),
        buyPlayerToken(callB.req, callB.res, callB.next),
      ]);

      // Both should succeed independently.
      expect((callA.res as any).statusCode).toBe(200);
      expect((callB.res as any).statusCode).toBe(200);
    });
  });
});
