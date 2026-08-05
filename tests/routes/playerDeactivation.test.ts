import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';
import * as db from '../../src/db';
import { invalidatePlayerCache } from '../../src/services/cache';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';
const PLAYER_WALLET = 'GAEW6VQNHJ45XOB5IBZVI2HLJGXPEM5JEKB5XR3CVAUGDNVATCW36GU4';
const PLAYER_ID = 'player-deactivation-test';

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockReturnValue([]),
  getPlayerById: jest.fn(),
  queryPlayers: jest.fn(),
  countPlayers: jest.fn(),
  insertPlayerProfileHistory: jest.fn(),
  getPlayerProfileHistory: jest.fn().mockReturnValue([]),
  getLatestSubscription: jest.fn().mockReturnValue(null),
  insertSubscription: jest.fn().mockReturnValue(1),
  deactivatePlayer: jest.fn(),
  reactivatePlayer: jest.fn(),
  countTrialOffersByPlayer: jest.fn().mockReturnValue(0),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn(),
  gatewayUrl: jest.fn(),
}));

jest.mock('../../src/services/webhooks', () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/cache', () => ({
  cacheGet: jest.fn().mockReturnValue(null),
  cacheSet: jest.fn(),
  invalidatePlayerCache: jest.fn(),
}));

jest.mock('../../src/services/stellar', () => ({
  queryMilestones: jest.fn().mockResolvedValue([]),
}));

function makeToken(wallet: string, role: string): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

describe('Player Profile Deactivation & Soft-Delete', () => {
  const mockGetPlayerById = db.getPlayerById as jest.Mock;
  const mockDeactivatePlayer = db.deactivatePlayer as jest.Mock;
  const mockReactivatePlayer = db.reactivatePlayer as jest.Mock;
  const mockInvalidatePlayerCache = invalidatePlayerCache as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/players/:playerId/deactivate', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await request(app)
        .post(`/api/players/${PLAYER_ID}/deactivate`);
      expect(res.status).toBe(401);
    });

    it('returns 403 when authenticated as a non-owner player', async () => {
      const token = makeToken('G_OTHER_WALLET_ADDR', 'player');
      const res = await request(app)
        .post(`/api/players/${PLAYER_ID}/deactivate`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it('returns 404 when the player profile is not found', async () => {
      const token = makeToken(PLAYER_ID, 'player');
      mockGetPlayerById.mockReturnValue(null);

      const res = await request(app)
        .post(`/api/players/${PLAYER_ID}/deactivate`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Player not found');
    });

    it('successfully deactivates player and invalidates cache when called by owner', async () => {
      const token = makeToken(PLAYER_ID, 'player');
      mockGetPlayerById.mockReturnValue({
        player_id: PLAYER_ID,
        wallet: PLAYER_WALLET,
        progress_level: 1,
        is_active: 1,
      });

      const res = await request(app)
        .post(`/api/players/${PLAYER_ID}/deactivate`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockDeactivatePlayer).toHaveBeenCalledWith(PLAYER_ID);
      expect(mockInvalidatePlayerCache).toHaveBeenCalledWith(PLAYER_ID);
    });
  });

  describe('POST /api/players/:playerId/reactivate', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await request(app)
        .post(`/api/players/${PLAYER_ID}/reactivate`);
      expect(res.status).toBe(401);
    });

    it('returns 403 when authenticated as a non-owner player', async () => {
      const token = makeToken('G_OTHER_WALLET_ADDR', 'player');
      const res = await request(app)
        .post(`/api/players/${PLAYER_ID}/reactivate`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it('successfully reactivates player and invalidates cache when called by owner', async () => {
      const token = makeToken(PLAYER_ID, 'player');
      mockGetPlayerById.mockReturnValue({
        player_id: PLAYER_ID,
        wallet: PLAYER_WALLET,
        progress_level: 1,
        is_active: 0,
      });

      const res = await request(app)
        .post(`/api/players/${PLAYER_ID}/reactivate`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockReactivatePlayer).toHaveBeenCalledWith(PLAYER_ID);
      expect(mockInvalidatePlayerCache).toHaveBeenCalledWith(PLAYER_ID);
    });
  });

  describe('GET /api/players/:playerId (Direct Lookup)', () => {
    it('allows access for active profile by anyone', async () => {
      mockGetPlayerById.mockReturnValue({
        player_id: PLAYER_ID,
        wallet: PLAYER_WALLET,
        progress_level: 1,
        is_active: 1,
      });

      const res = await request(app).get(`/api/players/${PLAYER_ID}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.is_active).toBe(1);
    });

    it('returns 404 for deactivated profile when requested anonymously', async () => {
      mockGetPlayerById.mockReturnValue({
        player_id: PLAYER_ID,
        wallet: PLAYER_WALLET,
        progress_level: 1,
        is_active: 0,
      });

      const res = await request(app).get(`/api/players/${PLAYER_ID}`);
      expect(res.status).toBe(404);
    });

    it('returns 404 for deactivated profile when requested by a scout', async () => {
      mockGetPlayerById.mockReturnValue({
        player_id: PLAYER_ID,
        wallet: PLAYER_WALLET,
        progress_level: 1,
        is_active: 0,
      });

      const token = makeToken('scout-wallet', 'scout');
      const res = await request(app)
        .get(`/api/players/${PLAYER_ID}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    });

    it('allows access to deactivated profile for the owner', async () => {
      mockGetPlayerById.mockReturnValue({
        player_id: PLAYER_ID,
        wallet: PLAYER_WALLET,
        progress_level: 1,
        is_active: 0,
      });

      const token = makeToken(PLAYER_ID, 'player');
      const res = await request(app)
        .get(`/api/players/${PLAYER_ID}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('allows access to deactivated profile for an admin', async () => {
      mockGetPlayerById.mockReturnValue({
        player_id: PLAYER_ID,
        wallet: PLAYER_WALLET,
        progress_level: 1,
        is_active: 0,
      });

      const token = makeToken('admin-wallet', 'admin');
      const res = await request(app)
        .get(`/api/players/${PLAYER_ID}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('GET /api/players/:playerId/milestones', () => {
    it('returns 404 for deactivated profile when requested anonymously', async () => {
      mockGetPlayerById.mockReturnValue({
        player_id: PLAYER_ID,
        wallet: PLAYER_WALLET,
        progress_level: 1,
        is_active: 0,
      });

      const res = await request(app).get(`/api/players/${PLAYER_ID}/milestones`);
      expect(res.status).toBe(404);
    });

    it('allows access to deactivated profile milestones for the owner', async () => {
      mockGetPlayerById.mockReturnValue({
        player_id: PLAYER_ID,
        wallet: PLAYER_WALLET,
        progress_level: 1,
        is_active: 0,
      });

      const token = makeToken(PLAYER_ID, 'player');
      const res = await request(app)
        .get(`/api/players/${PLAYER_ID}/milestones`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});
