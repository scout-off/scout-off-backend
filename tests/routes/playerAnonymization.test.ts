import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';
import * as db from '../../src/db';
import * as ipfs from '../../src/services/ipfs';
import * as cache from '../../src/services/cache';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

function makeToken(sub: string, role: string = 'player') {
  return jwt.sign({ sub, role, jti: 'test-jti' }, SECRET, { expiresIn: '1h' });
}

jest.mock('../../src/services/ipfs', () => ({
  ...jest.requireActual('../../src/services/ipfs'),
  unpinCid: jest.fn().mockResolvedValue(undefined),
  pinJson: jest.fn().mockResolvedValue('bafymock1'),
}));

jest.mock('../../src/services/cache', () => ({
  getPlayerListLastModified: jest.fn(() => 0),
  __setPlayerListLastModifiedForTests: jest.fn(),
  invalidatePlayerCache: jest.fn().mockResolvedValue(undefined),
}));

describe('POST /api/players/:playerId/anonymize', () => {
  const PLAYER_ID = 'test-player-123';
  const WALLET = 'GTEST1234567890';
  const METADATA_URI = 'QmTestCid123';

  beforeEach(async () => {
    jest.clearAllMocks();
    // Seed a player so the endpoint can find it
    try {
      await db.insertOrUpdatePlayer({
        player_id: PLAYER_ID,
        wallet: WALLET,
        position: 'forward',
        region: 'EU',
        metadata_uri: METADATA_URI,
        created_at: Date.now(),
      });
    } catch {
      // May already exist from previous test
    }
  });

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post(`/api/players/${PLAYER_ID}/anonymize`)
      .send();
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-owner', async () => {
    const token = makeToken('DIFFERENT_PLAYER');
    const res = await request(app)
      .post(`/api/players/${PLAYER_ID}/anonymize`)
      .set('Authorization', `Bearer ${token}`)
      .send();
    expect(res.status).toBe(403);
  });

  it('returns 404 for non-existent player', async () => {
    const token = makeToken('nonexistent-player-xyz');
    const res = await request(app)
      .post('/api/players/nonexistent-player-xyz/anonymize')
      .set('Authorization', `Bearer ${token}`)
      .send();
    expect(res.status).toBe(404);
  });

  it('anonymizes player data successfully', async () => {
    // Add some history rows
    await db.insertPlayerProfileHistory({
      player_id: PLAYER_ID,
      metadata_uri: 'QmHistory1',
      changed_at: Date.now() - 1000,
      tx_hash: 'txhash1',
    });

    const token = makeToken(PLAYER_ID);
    const res = await request(app)
      .post(`/api/players/${PLAYER_ID}/anonymize`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.anonymized.dbFieldsScrubbed).toBe(true);

    // Verify player is scrubbed in DB
    const player = await db.getPlayerById(PLAYER_ID);
    expect(player).not.toBeNull();
    expect(player!.wallet).toBe('[anonymized]');
    expect(player!.position).toBeNull();
    expect(player!.region).toBeNull();
    expect(player!.metadata_uri).toBeNull();
    expect(player!.is_active).toBe(0);

    // Verify profile history is deleted
    const history = await db.getPlayerProfileHistory(PLAYER_ID);
    expect(history).toHaveLength(0);

    // Verify IPFS unpin was called
    expect(ipfs.unpinCid).toHaveBeenCalled();

    // Verify cache was invalidated
    expect(cache.invalidatePlayerCache).toHaveBeenCalledWith(PLAYER_ID);
  });

  it('anonymized player does not appear in search results with PII', async () => {
    // First anonymize
    const token = makeToken(PLAYER_ID);
    await request(app)
      .post(`/api/players/${PLAYER_ID}/anonymize`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    // Check the player is not returned with identifying data
    const player = await db.getPlayerById(PLAYER_ID);
    expect(player!.wallet).toBe('[anonymized]');
    expect(player!.metadata_uri).toBeNull();
  });

  it('anonymized player history is empty', async () => {
    // Add history before anonymization
    await db.insertPlayerProfileHistory({
      player_id: PLAYER_ID,
      metadata_uri: 'QmHistoryToDelete',
      changed_at: Date.now(),
      tx_hash: 'txhash_del',
    });

    const token = makeToken(PLAYER_ID);
    await request(app)
      .post(`/api/players/${PLAYER_ID}/anonymize`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    const history = await db.getPlayerProfileHistory(PLAYER_ID);
    expect(history).toHaveLength(0);
  });
});
