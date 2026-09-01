/**
 * REST milestone authorization (#1019).
 *
 * GET /api/players/:playerId/milestones must hide deactivated players from
 * everyone except the owner or an admin — identical to the GraphQL surface
 * (both share src/utils/playerAccess.ts).
 *
 * Cases:
 *   - active player + anonymous caller      → 200
 *   - deactivated player + anonymous caller → 404
 *   - deactivated player + other scout      → 404
 *   - deactivated player + owner            → 200
 *   - deactivated player + admin            → 200
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockReturnValue([]),
  queryPlayers: jest.fn().mockReturnValue([]),
  countPlayers: jest.fn().mockReturnValue(0),
  getPlayerById: jest.fn(),
  insertPlayerProfileHistory: jest.fn(),
  getPlayerProfileHistory: jest.fn().mockReturnValue([]),
  getLatestSubscription: jest.fn().mockReturnValue(null),
  insertSubscription: jest.fn().mockReturnValue(1),
  insertOrUpdatePlayer: jest.fn(),
  countTrialOffersByPlayer: jest.fn().mockReturnValue(0),
  recordProfileView: jest.fn(),
  getLastProfileView: jest.fn().mockReturnValue(null),
  getProfileViewCount: jest.fn().mockReturnValue(0),
  getUniqueViewerCount: jest.fn().mockReturnValue(0),
  getContactUnlockCount: jest.fn().mockReturnValue(0),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn(),
  pinFile: jest.fn(),
  gatewayUrl: jest.fn(),
  checkHealth: jest.fn(),
}));

jest.mock('../../src/services/webhooks', () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/cache', () => ({
  cacheGet: jest.fn().mockResolvedValue(null),
  cacheSet: jest.fn().mockResolvedValue(undefined),
  invalidatePlayerCache: jest.fn(),
}));

jest.mock('../../src/services/stellar', () => ({
  updateProfile: jest.fn().mockResolvedValue({ transactionId: 'stub-tx', metadataUri: 'QmStub' }),
  queryMilestones: jest.fn().mockResolvedValue([]),
}));

import app from '../../src/app';
import { getPlayerById } from '../../src/db';

const mockGetPlayerById = getPlayerById as jest.Mock;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SECRET = process.env.JWT_SECRET ?? 'test-secret';
const PLAYER_ID = 'player-dead';
const PLAYER_WALLET = 'GPLAYEROWNERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER_SCOUT = 'GOTHER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ADMIN_WALLET = 'GADMIN1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function makeToken(wallet: string, role: string): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

function makePlayer(isActive: number) {
  return {
    player_id: PLAYER_ID,
    wallet: PLAYER_WALLET,
    position: 'striker',
    region: 'europe',
    metadata_uri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    progress_level: 1,
    created_at: 1700000000,
    is_active: isActive,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetPlayerById.mockReturnValue(makePlayer(1));
});

// ─── Active player ────────────────────────────────────────────────────────────

describe('GET /api/players/:playerId/milestones — active player', () => {
  it('is public for anonymous callers', async () => {
    const res = await request(app).get(`/api/players/${PLAYER_ID}/milestones`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('is public for any authenticated caller', async () => {
    const res = await request(app)
      .get(`/api/players/${PLAYER_ID}/milestones`)
      .set('Authorization', `Bearer ${makeToken(OTHER_SCOUT, 'scout')}`);
    expect(res.status).toBe(200);
  });
});

// ─── Deactivated player — denied ──────────────────────────────────────────────

describe('GET /api/players/:playerId/milestones — deactivated player', () => {
  beforeEach(() => {
    mockGetPlayerById.mockReturnValue(makePlayer(0));
  });

  it('returns 404 (hidden) for anonymous callers', async () => {
    const res = await request(app).get(`/api/players/${PLAYER_ID}/milestones`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PLAYER_NOT_FOUND');
  });

  it('returns 404 (hidden) for an unauthorized authenticated scout', async () => {
    const res = await request(app)
      .get(`/api/players/${PLAYER_ID}/milestones`)
      .set('Authorization', `Bearer ${makeToken(OTHER_SCOUT, 'scout')}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PLAYER_NOT_FOUND');
  });

  it('returns 404 (hidden) for an unauthorized player role', async () => {
    const res = await request(app)
      .get(`/api/players/${PLAYER_ID}/milestones`)
      .set('Authorization', `Bearer ${makeToken('GOTHERPLAYER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'player')}`);
    expect(res.status).toBe(404);
  });

  it('returns the milestones for the owner', async () => {
    const res = await request(app)
      .get(`/api/players/${PLAYER_ID}/milestones`)
      .set('Authorization', `Bearer ${makeToken(PLAYER_WALLET, 'player')}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns the milestones for an admin', async () => {
    const res = await request(app)
      .get(`/api/players/${PLAYER_ID}/milestones`)
      .set('Authorization', `Bearer ${makeToken(ADMIN_WALLET, 'admin')}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ─── GET /api/players/:playerId — same shared decision ────────────────────────

describe('GET /api/players/:playerId — deactivated player (shared decision)', () => {
  beforeEach(() => {
    mockGetPlayerById.mockReturnValue(makePlayer(0));
  });

  it('returns 404 for anonymous callers', async () => {
    const res = await request(app).get(`/api/players/${PLAYER_ID}`);
    expect(res.status).toBe(404);
  });

  it('returns the profile for the owner', async () => {
    const res = await request(app)
      .get(`/api/players/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${makeToken(PLAYER_WALLET, 'player')}`);
    expect(res.status).toBe(200);
  });

  it('returns the profile for an admin', async () => {
    const res = await request(app)
      .get(`/api/players/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${makeToken(ADMIN_WALLET, 'admin')}`);
    expect(res.status).toBe(200);
  });
});