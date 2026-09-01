import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockReturnValue([]),
  queryPlayers: jest.fn().mockReturnValue([]),
  countPlayers: jest.fn().mockReturnValue(0),
  searchPlayers: jest.fn().mockReturnValue({ data: [], nextCursor: null }),
  getPlayerById: jest.fn().mockReturnValue(null),
  insertPlayerProfileHistory: jest.fn(),
  getPlayerProfileHistory: jest.fn().mockReturnValue([]),
  getLatestSubscription: jest.fn().mockReturnValue(null),
  insertSubscription: jest.fn().mockReturnValue(1),
  insertOrUpdatePlayer: jest.fn(),
  insertAuditLog: jest.fn().mockReturnValue({
    id: 1,
    action: 'player_search',
    admin_wallet: '',
    query_params: '{}',
    created_at: new Date().toISOString(),
    prev_hash: '0'.repeat(64),
    hash: 'mock-hash-1',
    event_source: 'app_event',
  }),
  deactivatePlayer: jest.fn(),
  reactivatePlayer: jest.fn(),
  countTrialOffersByPlayer: jest.fn().mockReturnValue(0),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn().mockResolvedValue('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'),
  gatewayUrl: jest.fn((cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`),
  gatewayUrls: jest.fn((cid: string) => [`https://gateway.pinata.cloud/ipfs/${cid}`]),
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
  updateProfile: jest.fn().mockResolvedValue({ transactionId: 'stub-tx-abc123', metadataUri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' }),
  queryMilestones: jest.fn().mockResolvedValue([]),
}));

function makeToken(wallet: string, role: string): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

const PLAYER_WALLET = 'G' + 'A'.repeat(55);

const validPayload = {
  wallet: PLAYER_WALLET,
  position: 'striker',
  region: 'europe',
  metadataUri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
};

const PLAYER_ROW = {
  player_id: PLAYER_WALLET,
  wallet: PLAYER_WALLET,
  position: 'striker',
  region: 'europe',
  metadata_uri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
  progress_level: 1,
  created_at: 1700000000,
  is_active: 1,
};

// PUT /api/players/:playerId requires the current ETag as the If-Match
// header (#1151). Fetch it the same way a real client would: GET first.
async function currentEtag(): Promise<string> {
  const { getPlayerById } = require('../../src/db');
  (getPlayerById as jest.Mock).mockReturnValue(PLAYER_ROW);
  const res = await request(app).get(`/api/players/${PLAYER_WALLET}`);
  expect(res.status).toBe(200);
  return res.headers.etag as string;
}

// ─── POST /api/players/register ───────────────────────────────────────────────

describe('POST /api/players/register — role enforcement', () => {
  it('returns 401 when no token provided', async () => {
    const res = await request(app)
      .post('/api/players/register')
      .send(validPayload);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 403 when validator JWT provided', async () => {
    const token = makeToken(PLAYER_WALLET, 'validator');
    const res = await request(app)
      .post('/api/players/register')
      .set('Authorization', `Bearer ${token}`)
      .send(validPayload);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('returns 403 when scout JWT provided', async () => {
    const token = makeToken(PLAYER_WALLET, 'scout');
    const res = await request(app)
      .post('/api/players/register')
      .set('Authorization', `Bearer ${token}`)
      .send(validPayload);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('returns 201 when player JWT provided with valid payload', async () => {
    const token = makeToken(PLAYER_WALLET, 'player');
    const res = await request(app)
      .post('/api/players/register')
      .set('Authorization', `Bearer ${token}`)
      .send(validPayload);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });
});

// ─── PUT /api/players/:playerId ───────────────────────────────────────────────

describe('PUT /api/players/:playerId — role enforcement', () => {
  it('returns 401 when no token provided', async () => {
    const res = await request(app)
      .put(`/api/players/${PLAYER_WALLET}`)
      .send({ position: 'midfielder' });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 403 when validator JWT provided', async () => {
    const token = makeToken(PLAYER_WALLET, 'validator');
    const res = await request(app)
      .put(`/api/players/${PLAYER_WALLET}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ position: 'midfielder' });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('returns 403 when scout JWT provided', async () => {
    const token = makeToken(PLAYER_WALLET, 'scout');
    const res = await request(app)
      .put(`/api/players/${PLAYER_WALLET}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ position: 'midfielder' });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('returns 200 with transactionId when metadataUri is provided', async () => {
    const token = makeToken(PLAYER_WALLET, 'player');
    const etag = await currentEtag();
    const res = await request(app)
      .put(`/api/players/${PLAYER_WALLET}`)
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', etag)
      .send({ metadataUri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.transactionId).toBe('stub-tx-abc123');
    expect(res.body.data.metadataUri).toBe('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG');
  });

  it('pins metadata to IPFS and calls updateProfile when metadata object is provided', async () => {
    const token = makeToken(PLAYER_WALLET, 'player');
    const etag = await currentEtag();
    const res = await request(app)
      .put(`/api/players/${PLAYER_WALLET}`)
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', etag)
      .send({ metadata: { position: 'midfielder', region: 'EU' } });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.transactionId).toBeDefined();
    expect(res.body.data.metadataUri).toBeDefined();
  });

  it('returns 400 when neither metadata nor metadataUri is provided', async () => {
    const token = makeToken(PLAYER_WALLET, 'player');
    const res = await request(app)
      .put(`/api/players/${PLAYER_WALLET}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ position: 'midfielder' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

// ─── PUT /api/players/:playerId — owner-only enforcement ──────────────────────

describe('PUT /api/players/:playerId — owner-only enforcement', () => {
  const OWNER_WALLET = PLAYER_WALLET;
  const OTHER_WALLET = 'G' + 'B'.repeat(55);
  const VALID_UPDATE = { metadataUri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' };

  it('returns 401 when request is unauthenticated', async () => {
    const res = await request(app)
      .put(`/api/players/${OWNER_WALLET}`)
      .send(VALID_UPDATE);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 200 when owner updates their own profile', async () => {
    const token = makeToken(OWNER_WALLET, 'player');
    const etag = await currentEtag();
    const res = await request(app)
      .put(`/api/players/${OWNER_WALLET}`)
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', etag)
      .send(VALID_UPDATE);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
  });

  it('returns 403 when an authenticated player updates a different player\'s profile', async () => {
    const token = makeToken(OTHER_WALLET, 'player');
    const res = await request(app)
      .put(`/api/players/${OWNER_WALLET}`)
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_UPDATE);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });
});

// ─── GET /api/players/:playerId — progress_tier_name ─────────────────────────

describe('GET /api/players/:playerId — progress_tier_name field', () => {
  const levels = [
    { level: 0, name: 'Unverified' },
    { level: 1, name: 'Verified Identity' },
    { level: 2, name: 'Performance Milestones' },
    { level: 3, name: 'Elite Tier' },
  ];

  it.each(levels)(
    'includes progress_tier_name "$name" for a level-$level player',
    async ({ level, name }) => {
      const { getPlayerById } = require('../../src/db');
      (getPlayerById as jest.Mock).mockReturnValue({
        player_id: 'player-test-id',
        wallet: PLAYER_WALLET,
        position: 'Midfielder',
        region: 'West Africa',
        metadata_uri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
        progress_level: level,
        created_at: 1700000000,
        is_active: 1,
      });

      const res = await request(app).get('/api/players/player-test-id');
      expect(res.status).toBe(200);
      expect(res.body.data.progress_tier_name).toBe(name);
    },
  );

  it('returns 404 when player does not exist', async () => {
    const { getPlayerById } = require('../../src/db');
    (getPlayerById as jest.Mock).mockReturnValue(null);

    const res = await request(app).get('/api/players/nonexistent-id');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

// ─── GET /api/players — progress_tier_name in list ───────────────────────────

describe('GET /api/players — progress_tier_name field in list', () => {
  it('includes progress_tier_name for each player in the list response', async () => {
    const { searchPlayers, countPlayers } = require('../../src/db');
    (searchPlayers as jest.Mock).mockReturnValue({ data: [
      {
        player_id: 'player-001',
        wallet: PLAYER_WALLET,
        position: 'Forward',
        region: 'West Africa',
        metadata_uri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
        progress_level: 1,
        created_at: 1700000000,
        is_active: 1,
      },
      {
        player_id: 'player-002',
        wallet: 'G' + 'C'.repeat(55),
        position: 'Midfielder',
        region: 'Europe',
        metadata_uri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
        progress_level: 3,
        created_at: 1700000000,
        is_active: 1,
      },
    ], nextCursor: null });
    (countPlayers as jest.Mock).mockReturnValue(2);

    const res = await request(app).get('/api/players');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data[0].progress_tier_name).toBe('Verified Identity');
    expect(res.body.data[1].progress_tier_name).toBe('Elite Tier');
  });
});

// ─── POST /api/players/register — DB write (#282) ────────────────────────────

describe('POST /api/players/register — immediate DB write (#282)', () => {
  it('calls insertOrUpdatePlayer with correct fields after successful registration', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { insertOrUpdatePlayer } = require('../../src/db');
    (insertOrUpdatePlayer as jest.Mock).mockClear();

    const token = makeToken(PLAYER_WALLET, 'player');
    const res = await request(app)
      .post('/api/players/register')
      .set('Authorization', `Bearer ${token}`)
      .send(validPayload);

    expect(res.status).toBe(201);
    expect(insertOrUpdatePlayer).toHaveBeenCalledTimes(1);
    const call = (insertOrUpdatePlayer as jest.Mock).mock.calls[0][0];
    expect(call.wallet).toBe(PLAYER_WALLET);
    // Registration normalizes position aliases to their canonical form
    // (#816) — 'striker' is an alias for 'forward'.
    expect(call.position).toBe('forward');
    expect(call.region).toBe('europe');
    expect(call.metadata_uri).toBeDefined();
    expect(call.player_id).toBeDefined();
  });

  it('returns playerId in the response body', async () => {
    const token = makeToken(PLAYER_WALLET, 'player');
    const res = await request(app)
      .post('/api/players/register')
      .set('Authorization', `Bearer ${token}`)
      .send(validPayload);

    expect(res.status).toBe(201);
    expect(res.body.data.playerId).toBeDefined();
  });
});

// ─── GET /api/players/:playerId — offerCount field ────────────────────────────

describe('GET /api/players/:playerId — offerCount field', () => {
  const mockPlayer = {
    player_id: 'player-offer-test',
    wallet: PLAYER_WALLET,
    position: 'Midfielder',
    region: 'Europe',
    metadata_uri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    progress_level: 1,
    created_at: 1700000000,
    is_active: 1,
  };

  it('includes offerCount: 0 when no offers exist', async () => {
    const { getPlayerById, countTrialOffersByPlayer } = require('../../src/db');
    (getPlayerById as jest.Mock).mockReturnValue(mockPlayer);
    (countTrialOffersByPlayer as jest.Mock).mockReturnValue(0);

    const res = await request(app).get('/api/players/player-offer-test');
    expect(res.status).toBe(200);
    expect(res.body.data.offerCount).toBe(0);
  });

  it('includes offerCount reflecting the number of offers', async () => {
    const { getPlayerById, countTrialOffersByPlayer } = require('../../src/db');
    (getPlayerById as jest.Mock).mockReturnValue(mockPlayer);
    (countTrialOffersByPlayer as jest.Mock).mockReturnValue(3);

    const res = await request(app).get('/api/players/player-offer-test');
    expect(res.status).toBe(200);
    expect(res.body.data.offerCount).toBe(3);
  });
});

// ─── GET /api/players — ?fields= projection ───────────────────────────────────

describe('GET /api/players — ?fields= query parameter', () => {
  beforeEach(() => {
    const { searchPlayers, countPlayers } = require('../../src/db');
    (searchPlayers as jest.Mock).mockReturnValue({ data: [
      {
        player_id: 'player-fields-001',
        wallet: PLAYER_WALLET,
        position: 'Forward',
        region: 'West Africa',
        metadata_uri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
        progress_level: 1,
        created_at: 1700000000,
        is_active: 1,
      },
    ], nextCursor: null });
    (countPlayers as jest.Mock).mockReturnValue(1);
  });

  it('returns only the requested fields when ?fields= is provided', async () => {
    const res = await request(app).get('/api/players?fields=player_id,position');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data[0]).toHaveProperty('player_id', 'player-fields-001');
    expect(res.body.data[0]).toHaveProperty('position', 'Forward');
    // Non-requested fields should be absent
    expect(res.body.data[0]).not.toHaveProperty('wallet');
    expect(res.body.data[0]).not.toHaveProperty('region');
    expect(res.body.data[0]).not.toHaveProperty('progress_level');
  });

  it('returns all fields when no ?fields= param is given (backwards compatible)', async () => {
    const res = await request(app).get('/api/players');
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toHaveProperty('player_id');
    expect(res.body.data[0]).toHaveProperty('wallet');
    expect(res.body.data[0]).toHaveProperty('position');
    expect(res.body.data[0]).toHaveProperty('region');
  });

  it('silently ignores unknown field names in ?fields=', async () => {
    const res = await request(app).get('/api/players?fields=player_id,nonexistent_field');
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toHaveProperty('player_id');
    // The unknown field is simply absent — not a 400
    expect(res.body.data[0]).not.toHaveProperty('nonexistent_field');
  });

  it('returns an empty object per player when all requested fields are unknown', async () => {
    const res = await request(app).get('/api/players?fields=totally_unknown');
    expect(res.status).toBe(200);
    // No keys from the unknown field
    expect(Object.keys(res.body.data[0])).not.toContain('totally_unknown');
  });
});

// ─── X-API-Version header ─────────────────────────────────────────────────────

describe('X-API-Version response header', () => {
  it('is present on GET /api/players', async () => {
    const res = await request(app).get('/api/players');
    expect(res.headers['x-api-version']).toBeDefined();
    expect(res.headers['x-api-version']).toMatch(/^\d+$/);
  });

  it('is present on GET /api/players/:playerId 404', async () => {
    const { getPlayerById } = require('../../src/db');
    (getPlayerById as jest.Mock).mockReturnValue(null);
    const res = await request(app).get('/api/players/nonexistent');
    expect(res.headers['x-api-version']).toBeDefined();
  });
});

// ─── GET /api/docs — OpenAPI spec ─────────────────────────────────────────────

describe('GET /api/docs', () => {
  it('returns 200 with a valid OpenAPI 3.x spec', async () => {
    const res = await request(app).get('/api/docs');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(res.body.info).toBeDefined();
    expect(res.body.paths).toBeDefined();
  });

  it('spec includes a /players path entry', async () => {
    const res = await request(app).get('/api/docs');
    expect(res.status).toBe(200);
    expect(res.body.paths['/players']).toBeDefined();
  });

  it('spec includes a /players/{playerId} path entry', async () => {
    const res = await request(app).get('/api/docs');
    expect(res.body.paths['/players/{playerId}']).toBeDefined();
  });

  it('returns X-API-Version header', async () => {
    const res = await request(app).get('/api/docs');
    expect(res.headers['x-api-version']).toBeDefined();
  });
});
