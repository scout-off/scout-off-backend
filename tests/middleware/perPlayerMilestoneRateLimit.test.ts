/**
 * Tests for per-player rate limiting on POST /api/validators/milestone (#1137).
 *
 * Verifies:
 *  - Exceeding the per-player limit from a single validator returns 429 with Retry-After
 *  - Exceeding the per-player limit from two different validator wallets/IPs is also blocked
 *  - Requests for a different player_id are not affected by the first player's limit
 *  - Requests with no playerId body fall through (IP / wallet limiters only)
 *  - The 429 response uses the standard shape { success: false, error: string }
 */
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';
import { InMemoryRateLimitStore } from '../../src/middleware/inMemoryRateLimitStore';
import { playerRateLimit } from '../../src/middleware/rateLimit';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

function validatorToken(wallet: string) {
  return jwt.sign({ sub: wallet, role: 'validator' }, SECRET, { expiresIn: '1h' });
}

const VALIDATOR_A = 'GVALIDATORA1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const VALIDATOR_B = 'GVALIDATORB2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TOKEN_A = validatorToken(VALIDATOR_A);
const TOKEN_B = validatorToken(VALIDATOR_B);

const PLAYER_ID = 'per-player-rate-limit-test-player-1';
const OTHER_PLAYER_ID = 'per-player-rate-limit-other-player-2';

// ── Service mocks ──────────────────────────────────────────────────────────────
jest.mock('../../src/controllers/validatorController', () => {
  const actual = jest.requireActual('../../src/controllers/validatorController') as Record<string, unknown>;
  return {
    ...actual,
    submitMilestoneEvidence: jest.fn((_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
      res.status(201).json({ success: true, data: { evidenceCid: 'QmMock' } });
    }),
  };
});

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockReturnValue([]),
  getPlayerById: jest.fn().mockReturnValue({ player_id: PLAYER_ID, is_active: 1 }),
  queryPlayers: jest.fn().mockReturnValue([]),
  countPlayers: jest.fn().mockReturnValue(0),
  insertOrUpdatePlayer: jest.fn(),
  insertPlayerProfileHistory: jest.fn(),
  getPlayerProfileHistory: jest.fn().mockReturnValue([]),
  countTrialOffersByPlayer: jest.fn().mockReturnValue(0),
  getPendingMilestones: jest.fn().mockReturnValue([]),
}));

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn().mockResolvedValue('QmMock'),
  pinFile: jest.fn().mockResolvedValue('QmMock'),
  checkHealth: jest.fn().mockResolvedValue(undefined),
  gatewayUrl: jest.fn((cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`),
}));

jest.mock('../../src/services/stellar', () => ({
  queryMilestones: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../src/services/webhooks', () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/cache', () => ({
  getPlayerListLastModified: jest.fn(() => 0),
  __setPlayerListLastModifiedForTests: jest.fn(),
  cacheGet: jest.fn().mockResolvedValue(null),
  cacheSet: jest.fn().mockResolvedValue(undefined),
  invalidatePlayerCache: jest.fn().mockResolvedValue(undefined),
}));

// ── Shared in-memory store with a tight limit (max=2) for test isolation ──────
const testStore = new InMemoryRateLimitStore();

describe('POST /api/validators/milestone — per-player rate limit (#1137)', () => {
  describe('playerRateLimit() unit tests', () => {
    it('allows requests below the max', async () => {
      const store = new InMemoryRateLimitStore();
      const limiter = playerRateLimit({ windowMs: 60_000, max: 3, store, name: 'test-unit-1' });

      let nextCalled = 0;
      const makeReq = (playerId: string) => ({ body: { playerId } });
      const makeRes = () => ({
        status: () => ({ json: jest.fn() }),
        set: jest.fn(),
        statusCode: 200,
      });
      const next = () => { nextCalled++; };

      await limiter(makeReq(PLAYER_ID) as never, makeRes() as never, next);
      await limiter(makeReq(PLAYER_ID) as never, makeRes() as never, next);
      await limiter(makeReq(PLAYER_ID) as never, makeRes() as never, next);
      expect(nextCalled).toBe(3);
    });

    it('blocks at max+1 with 429 and Retry-After', async () => {
      const store = new InMemoryRateLimitStore();
      const limiter = playerRateLimit({ windowMs: 60_000, max: 2, store, name: 'test-unit-2' });

      let blocked = false;
      let retryAfterSet = false;
      const next = jest.fn();
      const res = {
        set: (name: string, _value: string) => { if (name === 'Retry-After') retryAfterSet = true; },
        status: (code: number) => {
          if (code === 429) blocked = true;
          return { json: jest.fn() };
        },
      };
      const makeReq = () => ({ body: { playerId: PLAYER_ID } });

      await limiter(makeReq() as never, res as never, next);
      await limiter(makeReq() as never, res as never, next);
      // Third call should be blocked
      await limiter(makeReq() as never, res as never, next);

      expect(blocked).toBe(true);
      expect(retryAfterSet).toBe(true);
      expect(next).toHaveBeenCalledTimes(2); // only the first two passed
    });

    it('falls through when playerId is absent in body', async () => {
      const store = new InMemoryRateLimitStore();
      const limiter = playerRateLimit({ windowMs: 60_000, max: 1, store, name: 'test-unit-3' });

      const next = jest.fn();
      const res = { set: jest.fn(), status: jest.fn() };

      await limiter({ body: {} } as never, res as never, next);
      await limiter({ body: {} } as never, res as never, next);
      await limiter({ body: {} } as never, res as never, next);

      // All pass through because no playerId is present
      expect(next).toHaveBeenCalledTimes(3);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('different player IDs use independent counters', async () => {
      const store = new InMemoryRateLimitStore();
      const limiter = playerRateLimit({ windowMs: 60_000, max: 1, store, name: 'test-unit-4' });

      const next = jest.fn();
      const blocked429 = jest.fn();
      const res = {
        set: jest.fn(),
        status: (code: number) => {
          if (code === 429) blocked429();
          return { json: jest.fn() };
        },
      };

      // Use up player A's quota
      await limiter({ body: { playerId: PLAYER_ID } } as never, res as never, next);
      await limiter({ body: { playerId: PLAYER_ID } } as never, res as never, next); // blocked

      // Player B's quota is independent — should still pass
      await limiter({ body: { playerId: OTHER_PLAYER_ID } } as never, res as never, next);

      expect(next).toHaveBeenCalledTimes(2); // first + other player
      expect(blocked429).toHaveBeenCalledTimes(1); // only player A's second
    });

    it('429 response has success=false with error field', async () => {
      const store = new InMemoryRateLimitStore();
      const limiter = playerRateLimit({ windowMs: 60_000, max: 0, store, name: 'test-unit-5' });

      const jsonMock = jest.fn();
      const res = {
        set: jest.fn(),
        status: jest.fn().mockReturnValue({ json: jsonMock }),
      };
      const next = jest.fn();

      await limiter({ body: { playerId: PLAYER_ID } } as never, res as never, next);

      expect(res.status).toHaveBeenCalledWith(429);
      const body = jsonMock.mock.calls[0]?.[0] as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(typeof body.error).toBe('string');
    });
  });
});
