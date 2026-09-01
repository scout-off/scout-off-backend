import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';
import { invalidatePlayerCache } from '../../src/services/cache';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockReturnValue([]),
  getPlayerById: jest.fn(),
  queryPlayers: jest.fn().mockReturnValue([]),
  countPlayers: jest.fn().mockReturnValue(0),
  insertOrUpdatePlayer: jest.fn(),
  insertPlayerProfileHistory: jest.fn(),
  getPlayerProfileHistory: jest.fn().mockReturnValue([]),
  countTrialOffersByPlayer: jest.fn().mockReturnValue(0),
}));

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn().mockResolvedValue('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'),
  checkHealth: jest.fn().mockResolvedValue(undefined),
  gatewayUrl: jest.fn((cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

jest.mock('../../src/services/webhooks', () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/stellar', () => ({
  updateProfile: jest.fn().mockResolvedValue({
    transactionId: 'stub-tx-opt-concurrency',
    metadataUri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
  }),
  queryMilestones: jest.fn().mockResolvedValue([]),
}));

import { getPlayerById, getPlayerProfileHistory, insertPlayerProfileHistory } from '../../src/db';
import { updateProfile } from '../../src/services/stellar';
const mockGetPlayerById = getPlayerById as jest.Mock;
const mockGetPlayerProfileHistory = getPlayerProfileHistory as jest.Mock;
const mockInsertPlayerProfileHistory = insertPlayerProfileHistory as jest.Mock;
const mockUpdateProfile = updateProfile as jest.Mock;

const PLAYER = {
  player_id: 'player-etag-1',
  wallet: 'GPLAYERWALLET1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  position: 'striker',
  region: 'EU',
  metadata_uri: 'QmTestCID123',
  progress_level: 1,
  created_at: 1000,
};

describe('GET /api/players/:playerId — ETag / 304 support', () => {
  beforeEach(() => {
    mockGetPlayerById.mockReset();
  });

  it('returns an ETag header on a successful response', async () => {
    mockGetPlayerById.mockReturnValue(PLAYER);
    const res = await request(app).get(`/api/players/${PLAYER.player_id}`);
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBeDefined();
  });

  it('returns 304 Not Modified when If-None-Match matches the ETag', async () => {
    mockGetPlayerById.mockReturnValue(PLAYER);
    const first = await request(app).get(`/api/players/${PLAYER.player_id}`);
    expect(first.status).toBe(200);
    const etag = first.headers.etag;

    const second = await request(app)
      .get(`/api/players/${PLAYER.player_id}`)
      .set('If-None-Match', etag);
    expect(second.status).toBe(304);
  });

  it('returns 200 with new ETag when player data has changed', async () => {
    mockGetPlayerById.mockReturnValue(PLAYER);
    const first = await request(app).get(`/api/players/${PLAYER.player_id}`);
    const firstEtag = first.headers.etag;

    const updatedPlayer = { ...PLAYER, metadata_uri: 'QmUpdatedCID456' };
    mockGetPlayerById.mockReturnValue(updatedPlayer);
    // Simulate the cache invalidation a real PUT would trigger (#307)
    await invalidatePlayerCache(PLAYER.player_id);

    const second = await request(app)
      .get(`/api/players/${PLAYER.player_id}`)
      .set('If-None-Match', firstEtag);
    expect(second.status).toBe(200);
    expect(second.headers.etag).toBeDefined();
    expect(second.headers.etag).not.toBe(firstEtag);
  });

  it('still returns 404 when player does not exist', async () => {
    mockGetPlayerById.mockReturnValue(null);
    const res = await request(app).get('/api/players/nonexistent');
    expect(res.status).toBe(404);
    expect(res.headers.etag).toBeUndefined();
  });
});

describe('PUT /api/players/:playerId — optimistic concurrency (#1151)', () => {
  const TOKEN = jwt.sign({ sub: PLAYER.player_id, role: 'player' }, SECRET, { expiresIn: '1h' });

  beforeEach(async () => {
    mockGetPlayerById.mockReset();
    mockGetPlayerProfileHistory.mockReset();
    mockGetPlayerProfileHistory.mockReturnValue([]);
    mockInsertPlayerProfileHistory.mockClear();
    mockUpdateProfile.mockClear();
    // Clear any profile cached by the GET tests above (same player id).
    await invalidatePlayerCache(PLAYER.player_id);
  });

  it('rejects PUT without If-Match with 428 and does not write', async () => {
    mockGetPlayerById.mockReturnValue(PLAYER);
    const res = await request(app)
      .put(`/api/players/${PLAYER.player_id}`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ metadataUri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' });
    expect(res.status).toBe(428);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('PRECONDITION_REQUIRED');
    expect(mockUpdateProfile).not.toHaveBeenCalled();
    expect(mockInsertPlayerProfileHistory).not.toHaveBeenCalled();
  });

  it('returns 412 for a stale If-Match and does not write', async () => {
    mockGetPlayerById.mockReturnValue(PLAYER);
    const getRes = await request(app).get(`/api/players/${PLAYER.player_id}`);
    expect(getRes.status).toBe(200);
    const staleEtag = getRes.headers.etag;

    // Another update landed between the GET and the PUT — version moved.
    mockGetPlayerProfileHistory.mockReturnValue([
      { id: 1, metadata_uri: 'QmOtherCID', changed_at: 2000, tx_hash: 'tx-other' },
    ]);

    const res = await request(app)
      .put(`/api/players/${PLAYER.player_id}`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('If-Match', staleEtag)
      .send({ metadataUri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' });
    expect(res.status).toBe(412);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('PRECONDITION_FAILED');
    expect(mockUpdateProfile).not.toHaveBeenCalled();
    expect(mockInsertPlayerProfileHistory).not.toHaveBeenCalled();
  });

  it('accepts a current If-Match, writes, and bumps the version token', async () => {
    mockGetPlayerById.mockReturnValue(PLAYER);
    const getRes = await request(app).get(`/api/players/${PLAYER.player_id}`);
    expect(getRes.status).toBe(200);
    const etag = getRes.headers.etag;

    const putRes = await request(app)
      .put(`/api/players/${PLAYER.player_id}`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('If-Match', etag)
      .send({ metadataUri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' });
    expect(putRes.status).toBe(200);
    expect(mockUpdateProfile).toHaveBeenCalledTimes(1);
    expect(mockInsertPlayerProfileHistory).toHaveBeenCalledTimes(1);
    // The response advertises the next version token.
    expect(putRes.headers.etag).toBeDefined();
    expect(putRes.headers.etag).not.toBe(etag);

    // Simulate the version bump the insert would cause and confirm GET now
    // serves a different ETag (no silent clobber on the next round).
    mockGetPlayerProfileHistory.mockReturnValue([
      { id: 1, metadata_uri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', changed_at: 3000, tx_hash: 'tx-1' },
    ]);
    const get2 = await request(app).get(`/api/players/${PLAYER.player_id}`);
    expect(get2.status).toBe(200);
    expect(get2.headers.etag).not.toBe(etag);
  });

  it('returns 404 for a missing player even with If-Match *', async () => {
    mockGetPlayerById.mockReturnValue(null);
    const res = await request(app)
      .put(`/api/players/${PLAYER.player_id}`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('If-Match', '*')
      .send({ metadataUri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' });
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('PLAYER_NOT_FOUND');
    expect(mockUpdateProfile).not.toHaveBeenCalled();
  });
});
