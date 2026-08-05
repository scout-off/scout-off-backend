import request from 'supertest';
import jwt from 'jsonwebtoken';
import { logger } from '../../src/utils/logger';
import app from '../../src/app';
import { Keypair, Transaction, Networks } from '@stellar/stellar-sdk';
import { queryAudit } from '../../src/utils/audit';
import * as db from '../../src/db';

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn().mockResolvedValue('QmSoLV4Bbm51jM9C4gDYZQ9Cy3U6aXMJDAbzgu2fzaDs64'),
  checkHealth: jest.fn().mockResolvedValue(undefined),
  gatewayUrl: jest.fn((cid) => `https://gateway.pinata.cloud/ipfs/${cid}`),
  gatewayUrls: jest.fn((cid) => [`https://gateway.pinata.cloud/ipfs/${cid}`]),
}));

jest.mock('../../src/db', () => {
  // Minimal in-memory stand-in for the audit_log table, so that the real
  // (unmocked) src/utils/audit.ts's recordAudit/queryAudit — which now read
  // and write through src/db instead of an in-memory array (#464) — keep
  // working against this fully-mocked db module.
  let auditRows: Array<{
    id: number;
    action: string;
    admin_wallet: string;
    query_params: string;
    created_at: string;
    prev_hash: string | null;
    hash: string;
    event_source: string;
  }> = [];
  let nextAuditId = 1;

  return {
    queryEvents: jest.fn().mockReturnValue([]),
    queryPlayers: jest.fn().mockReturnValue([]),
    countPlayers: jest.fn().mockReturnValue(0),
    searchPlayers: jest.fn().mockReturnValue({ data: [], nextCursor: null }),
    countEventsFiltered: jest.fn().mockReturnValue(0),
    getEventsPage: jest.fn().mockReturnValue([]),
    getPlayerById: jest.fn().mockImplementation((id) => {
      if (id === 'player_123') {
        return {
          player_id: 'player_123',
          wallet: 'G' + 'A'.repeat(55),
          position: 'striker',
          region: 'europe',
          metadata_uri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
          progress_level: 1,
          created_at: 1700000000,
          is_active: 1,
        };
      }
      return null;
    }),
    getEventsCount: jest.fn().mockReturnValue(0),
    insertPlayerProfileHistory: jest.fn(),
    getPlayerProfileHistory: jest.fn().mockReturnValue([]),
    getLatestSubscription: jest.fn().mockReturnValue(null),
    insertSubscription: jest.fn().mockReturnValue(1),
    renewSubscription: jest.fn(),
    cancelSubscription: jest.fn(),
    getPendingMilestones: jest.fn().mockReturnValue({ data: [], total: 0 }),
    insertOrUpdatePlayer: jest.fn(),
    insertAuditLog: jest.fn(
      (p: { action: string; adminWallet?: string; queryParams?: Record<string, unknown>; createdAt: string; eventSource?: string }) => {
        const row = {
          id: nextAuditId++,
          action: p.action,
          admin_wallet: p.adminWallet ?? '',
          query_params: JSON.stringify(p.queryParams ?? {}),
          created_at: p.createdAt,
          prev_hash: auditRows.length ? auditRows[auditRows.length - 1].hash : '0'.repeat(64),
          hash: `mock-hash-${nextAuditId}`,
          event_source: p.eventSource ?? 'admin_action',
        };
        auditRows.push(row);
        return row;
      }
    ),
    getAllAuditLogRows: jest.fn(
      (filters: { eventSource?: string; actorWallet?: string; action?: string } = {}) =>
        auditRows.filter((r) => {
          if (filters.eventSource && r.event_source !== filters.eventSource) return false;
          if (filters.actorWallet && r.admin_wallet !== filters.actorWallet) return false;
          if (filters.action && r.action !== filters.action) return false;
          return true;
        })
    ),
    __resetAuditRows: () => {
      auditRows = [];
      nextAuditId = 1;
    },
    // In-memory stand-in for the `revoked_tokens` table so
    // tokenBlocklist.ts's real (unmocked) getDriver()-based checkDb always
    // finds a working driver instead of failing closed (treating every
    // token as revoked) — see src/services/tokenBlocklist.ts checkDb().
    getDriver: jest.fn(() => ({
      run: () => ({ changes: 0, lastId: 0 }),
      get: () => undefined,
      all: () => [],
      value: () => undefined,
      exec: () => {},
      transaction: (fn: () => unknown) => fn(),
      close: async () => {},
    })),
  };
});

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

jest.mock('../../src/services/webhooks', () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
}));

// Without this, GET /api/players/:playerId/milestones's unmocked call to the
// real queryMilestones() makes a live network call to Soroban testnet for a
// contract ID that doesn't actually exist there, which errors out as a 500
// instead of exercising the route's own logic. Every sibling route test file
// (e.g. tests/routes/compression.test.ts, tests/routes/playerPagination.test.ts)
// mocks this module for the same reason.
jest.mock('../../src/services/stellar', () => ({
  stellarHealth: jest.fn().mockResolvedValue(true),
  queryMilestones: jest.fn().mockResolvedValue([]),
  updateProfile: jest.fn().mockResolvedValue(undefined),
}));

describe('GET /health', () => {
  it('returns 200 ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('includes a healthStatus object', async () => {
    const res = await request(app).get('/health');
    expect(res.body).toHaveProperty('healthStatus');
    expect(typeof res.body.healthStatus).toBe('object');
  });

  it('healthStatus.stellar is ok or error or disabled', async () => {
    const res = await request(app).get('/health');
    expect(['ok', 'error', 'disabled']).toContain(res.body.healthStatus.stellar);
  });
});

describe('GET /api/players', () => {
  it('returns paginated list', async () => {
    const res = await request(app).get('/api/players');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('rejects invalid minTier with 400', async () => {
    const res = await request(app).get('/api/players?minTier=99');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/players/register', () => {
  const PLAYER_WALLET = 'G'.repeat(56);
  const validPlayer = {
    wallet: PLAYER_WALLET,
    position: 'striker',
    region: 'europe',
    metadataUri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
  };

  it('returns 401 when no token is provided', async () => {
    const res = await request(app)
      .post('/api/players/register')
      .send(validPlayer);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 403 when authenticated as non-player role', async () => {
    const token = await getValidatorToken();
    const res = await request(app)
      .post('/api/players/register')
      .set('Authorization', `Bearer ${token}`)
      .send(validPlayer);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('rejects invalid metadataUri values with 400', async () => {
    const token = await getPlayerToken();
    const res = await request(app)
      .post('/api/players/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validPlayer, metadataUri: 'invalid-cid' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('accepts registration payloads with valid metadataUri', async () => {
    // registerPlayer requires body.wallet === req.account, so the token must
    // be signed for PLAYER_WALLET specifically (getPlayerToken() signs for a
    // fresh random keypair each call, which would never match).
    const token = jwt.sign(
      { sub: PLAYER_WALLET, role: 'player' },
      process.env.JWT_SECRET ?? 'test-secret',
      { expiresIn: '1h' },
    );
    const res = await request(app)
      .post('/api/players/register')
      .set('Authorization', `Bearer ${token}`)
      .send(validPlayer);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.metadataUri).toBe(validPlayer.metadataUri);
  });

  it('returns 403 when req.body.wallet does not match authenticated account', async () => {
    // Token belongs to a different wallet
    const token = await getPlayerToken();
    const res = await request(app)
      .post('/api/players/register')
      .set('Authorization', `Bearer ${token}`)
      .send(validPlayer);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/wallet must match authenticated account/i);
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request(app)
      .post('/api/players/register')
      .send(validPlayer);

    expect(res.status).toBe(401);
  });
});

describe('GET /api/players/:playerId route validation', () => {
  it('accepts a valid player ID and returns 404 when the player does not exist', async () => {
    const res = await request(app).get('/api/players/player_non_existent');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('rejects an empty player ID with 400', async () => {
    const res = await request(app).get('/api/players/%20');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('playerId may only contain letters, numbers, underscores, and hyphens');
  });

  it('rejects an overlong player ID with 400', async () => {
    const longId = 'a'.repeat(129);
    const res = await request(app).get(`/api/players/${longId}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('playerId cannot exceed 128 characters');
  });

  it('rejects a player ID with invalid characters', async () => {
    const res = await request(app).get('/api/players/player%20with%20spaces');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('playerId may only contain letters, numbers, underscores, and hyphens');
  });
});

describe('GET /api/players/:playerId/milestones route validation', () => {
  it('accepts a valid player ID and returns 200 with array data', async () => {
    const res = await request(app).get('/api/players/player_123/milestones');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('rejects an invalid player ID with 400', async () => {
    const res = await request(app).get('/api/players/player%23123/milestones');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('playerId may only contain letters, numbers, underscores, and hyphens');
  });
});

describe('POST /api/validators/milestone', () => {
  it('rejects invalid milestone submissions and logs a correlation ID', async () => {
    const token = await getValidatorToken();
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${token}`)
      .set('x-correlation-id', 'test-corr-id')
      .send({ playerId: 'player-1', milestoneType: 'invalid_type', evidenceUri: 'ipfs://QmTest' });

    expect(res.status).toBe(400);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('correlationId=test-corr-id'));
    warnSpy.mockRestore();
  });
});

describe('GET /auth/challenge', () => {
  it('returns challenge XDR for a valid Stellar account', async () => {
    const account = Keypair.random().publicKey();
    const res = await request(app).get(`/auth/challenge?account=${account}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.challenge).toBe('string');
    expect(typeof res.body.networkPassphrase).toBe('string');
  });

  it('returns 400 for missing account', async () => {
    const res = await request(app).get('/auth/challenge');
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid Stellar key', async () => {
    const res = await request(app).get('/auth/challenge?account=NOTAVALIDKEY');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe('POST /auth/token', () => {
  it('returns JWT after client signs the challenge', async () => {
    const clientKeypair = Keypair.random();
    const challengeRes = await request(app).get(
      `/auth/challenge?account=${clientKeypair.publicKey()}`
    );
    const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
    tx.sign(clientKeypair);

    const res = await request(app)
      .post('/auth/token')
      .send({ transaction: tx.toXDR() });

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(typeof res.body.expiresAt).toBe('number');
    expect(res.body.account).toBe(clientKeypair.publicKey());
  });

  it('returns JWT with validator role when role is specified', async () => {
    const clientKeypair = Keypair.random();
    const challengeRes = await request(app).get(
      `/auth/challenge?account=${clientKeypair.publicKey()}`
    );
    const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
    tx.sign(clientKeypair);

    const res = await request(app)
      .post('/auth/token')
      .send({ transaction: tx.toXDR(), role: 'validator' });

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(typeof res.body.expiresAt).toBe('number');
  });

  it('returns 401 for unsigned challenge', async () => {
    const clientKeypair = Keypair.random();
    const challengeRes = await request(app).get(
      `/auth/challenge?account=${clientKeypair.publicKey()}`
    );

    const res = await request(app)
      .post('/auth/token')
      .send({ transaction: challengeRes.body.challenge });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for missing transaction field', async () => {
    const res = await request(app).post('/auth/token').send({});
    expect(res.status).toBe(400);
  });
});

async function getValidatorToken(): Promise<string> {
  const kp = Keypair.random();
  const challengeRes = await request(app).get(`/auth/challenge?account=${kp.publicKey()}`);
  const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
  tx.sign(kp);
  const tokenRes = await request(app)
    .post('/auth/token')
    .send({ transaction: tx.toXDR(), role: 'validator' });
  return tokenRes.body.token;
}

async function getPlayerToken(): Promise<string> {
  const kp = Keypair.random();
  const challengeRes = await request(app).get(`/auth/challenge?account=${kp.publicKey()}`);
  const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
  tx.sign(kp);
  const tokenRes = await request(app)
    .post('/auth/token')
    .send({ transaction: tx.toXDR(), role: 'player' });
  return tokenRes.body.token;
}


async function getAdminToken(): Promise<string> {
  const kp = Keypair.random();
  const challengeRes = await request(app).get(`/auth/challenge?account=${kp.publicKey()}`);
  const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
  tx.sign(kp);
  const tokenRes = await request(app)
    .post('/auth/token')
    .send({ transaction: tx.toXDR(), role: 'admin' });
  return tokenRes.body.token;
}

describe('GET /api/validators/milestones/pending', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await request(app).get('/api/validators/milestones/pending');
    expect(res.status).toBe(401);
  });

  it('returns 403 when authenticated as non-validator role', async () => {
    const token = await getPlayerToken();
    const res = await request(app)
      .get('/api/validators/milestones/pending')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('returns pending milestones for authenticated validator', async () => {
    const token = await getValidatorToken();
    const res = await request(app)
      .get('/api/validators/milestones/pending')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('accepts optional region and playerId filters', async () => {
    const token = await getValidatorToken();
    const res = await request(app)
      .get('/api/validators/milestones/pending?region=europe&playerId=player-1')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('GET /api/admin/events', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await request(app).get('/api/admin/events');
    expect(res.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin role', async () => {
    const token = await getPlayerToken();
    const res = await request(app)
      .get('/api/admin/events')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('returns 403 when authenticated as validator role', async () => {
    const token = await getValidatorToken();
    const res = await request(app)
      .get('/api/admin/events')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('returns event list for authenticated admin', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/events')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('GET /api/admin/fees', () => {
  it('returns 403 when authenticated as non-admin role', async () => {
    const token = await getValidatorToken();
    const res = await request(app)
      .get('/api/admin/fees')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('returns fee list for authenticated admin', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/fees')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('POST /api/validators/milestone', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await request(app).post('/api/validators/milestone').send({
      playerId: 'player-1',
      milestoneType: 'identity',
      evidenceUri: 'ipfs://QmTest',
    });
    expect(res.status).toBe(401);
  });

  it('returns 403 when authenticated as non-validator role', async () => {
    const token = await getPlayerToken();
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${token}`)
      .send({ playerId: 'player-1', milestoneType: 'identity', evidenceUri: 'ipfs://QmTest' });
    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid request body', async () => {
    const token = await getValidatorToken();
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${token}`)
      .send({ playerId: '', milestoneType: 'unknown' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when evidenceUri is missing', async () => {
    const token = await getValidatorToken();
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${token}`)
      .send({ playerId: 'player-1', milestoneType: 'identity' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/players — search audit logging', () => {
  beforeEach(() => {
    (db as unknown as { __resetAuditRows: () => void }).__resetAuditRows();
  });

  it('records an anonymous player_search entry when no auth token is provided', async () => {
    await request(app).get('/api/players?region=europe');
    const entry = queryAudit({ eventType: 'player_search' })[0];
    expect(entry).toBeDefined();
    expect(entry!.actorWallet).toBe('anonymous');
    expect(entry!.eventType).toBe('player_search');
  });

  it('records a player_search entry linked to the wallet when authenticated', async () => {
    const scoutWallet = 'GSCOUTABC123XYZWALLET000000000000000000000000000000000000';
    const token = jwt.sign({ sub: scoutWallet, role: 'scout' }, 'test-secret', { expiresIn: '1h' });
    await request(app)
      .get('/api/players?position=striker')
      .set('Authorization', `Bearer ${token}`);
    const entry = queryAudit({ eventType: 'player_search' })[0];
    expect(entry).toBeDefined();
    expect(entry!.actorWallet).toBe(scoutWallet);
  });

  it('still returns 200 and results regardless of auth state', async () => {
    const res = await request(app).get('/api/players');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});
