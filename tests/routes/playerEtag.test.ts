import request from 'supertest';
import app from '../../src/app';
import { invalidatePlayerCache } from '../../src/services/cache';

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

import { getPlayerById } from '../../src/db';
const mockGetPlayerById = getPlayerById as jest.Mock;

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
