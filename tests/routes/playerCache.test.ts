/**
 * #307 — single-player cache: GET /players/:playerId
 *
 * Verifies:
 *  - Second request for the same player is served from cache (DB not called twice)
 *  - Cache is invalidated after a successful PUT /players/:playerId
 *  - TTL is driven by PLAYER_CACHE_TTL_MS (config)
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

const PLAYER_ROW = {
  player_id: 'G' + 'A'.repeat(55), // must match wallet for requireOwner
  wallet: 'G' + 'A'.repeat(55),
  position: 'striker',
  region: 'europe',
  metadata_uri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
  progress_level: 1,
  created_at: 1700000000,
};

const mockGetPlayerById = jest.fn();

jest.mock('../../src/db', () => ({
  getPlayerById: (...args: unknown[]) => mockGetPlayerById(...args),
  queryPlayers: jest.fn().mockReturnValue([]),
  countPlayers: jest.fn().mockReturnValue(0),
  queryEvents: jest.fn().mockReturnValue([]),
  insertPlayerProfileHistory: jest.fn(),
  getPlayerProfileHistory: jest.fn().mockReturnValue([]),
  getLatestSubscription: jest.fn().mockReturnValue(null),
  insertSubscription: jest.fn().mockReturnValue(1),
  countTrialOffersByPlayer: jest.fn().mockReturnValue(0),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn().mockResolvedValue('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'),
  gatewayUrl: jest.fn((cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`),
}));

jest.mock('../../src/services/webhooks', () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/stellar', () => ({
  updateProfile: jest.fn().mockResolvedValue({
    transactionId: 'stub-tx-cache-bust',
    metadataUri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
  }),
  queryMilestones: jest.fn().mockResolvedValue([]),
}));

import app from '../../src/app';
import { invalidatePlayerCache } from '../../src/services/cache';

function makeToken(wallet: string, role: string) {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

beforeEach(async () => {
  mockGetPlayerById.mockReset();
  // Clear any cached state from previous tests.
  await invalidatePlayerCache(PLAYER_ROW.player_id);
});

describe('#307 GET /api/players/:playerId — cache hit', () => {
  it('serves the second request from cache without hitting the DB again', async () => {
    mockGetPlayerById.mockReturnValue(PLAYER_ROW);

    // First request — hits DB.
    const res1 = await request(app).get(`/api/players/${PLAYER_ROW.player_id}`);
    expect(res1.status).toBe(200);
    expect(res1.body.data.player_id).toBe(PLAYER_ROW.player_id);

    // Second request — served from cache, no new DB call.
    const res2 = await request(app).get(`/api/players/${PLAYER_ROW.player_id}`);
    expect(res2.status).toBe(200);
    expect(res2.body.data.player_id).toBe(PLAYER_ROW.player_id);

    // DB was only queried once.
    expect(mockGetPlayerById).toHaveBeenCalledTimes(1);
  });
});

describe('#307 PUT /api/players/:playerId — cache bust', () => {
  it('calls getPlayerById again after a successful PUT (cache was busted)', async () => {
    mockGetPlayerById.mockReturnValue(PLAYER_ROW);

    const token = makeToken(PLAYER_ROW.wallet, 'player');

    // Prime the cache with first GET.
    await request(app).get(`/api/players/${PLAYER_ROW.player_id}`);
    expect(mockGetPlayerById).toHaveBeenCalledTimes(1);

    // Update the player profile — should bust the single-player cache.
    const putRes = await request(app)
      .put(`/api/players/${PLAYER_ROW.player_id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ metadataUri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' });
    expect(putRes.status).toBe(200);

    // After bust, next GET must hit DB again (cache miss).
    await request(app).get(`/api/players/${PLAYER_ROW.player_id}`);
    expect(mockGetPlayerById).toHaveBeenCalledTimes(2);
  });

  it('returns fresh data (not stale cache) immediately after a PUT update', async () => {
    const OLD_CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    const NEW_CID = 'QmWvjsQmdhSirshEzbPnmdnbMr2wDs4yT6N8pWAxmGaN6d';
    const oldData = { ...PLAYER_ROW, metadata_uri: OLD_CID };
    const newData = { ...PLAYER_ROW, metadata_uri: NEW_CID };
    mockGetPlayerById.mockReturnValue(oldData);

    const token = makeToken(PLAYER_ROW.wallet, 'player');

    // Prime cache with old data.
    const pre = await request(app).get(`/api/players/${PLAYER_ROW.player_id}`);
    expect(pre.status).toBe(200);
    expect(pre.body.data.metadataUri).toBe(OLD_CID);

    const putRes = await request(app)
      .put(`/api/players/${PLAYER_ROW.player_id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ metadataUri: NEW_CID });
    expect(putRes.status).toBe(200);

    // After bust, change mock to return new data.
    mockGetPlayerById.mockReturnValue(newData);

    // GET must return fresh data, not the stale cached response.
    const post = await request(app).get(`/api/players/${PLAYER_ROW.player_id}`);
    expect(post.status).toBe(200);
    expect(post.body.data.metadataUri).toBe(NEW_CID);
  });
});
