/**
 * API Contract Tests
 *
 * Exercises every route at least once and asserts that success responses carry
 * { success: true, data: ... } and error responses carry { success: false, error: string }.
 * Any field rename or envelope deviation will cause these assertions to fail.
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Keypair, Transaction, Networks } from '@stellar/stellar-sdk';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockReturnValue([]),
  queryPlayers: jest.fn().mockReturnValue([]),
  countPlayers: jest.fn().mockReturnValue(0),
  searchPlayers: jest.fn().mockReturnValue({ data: [], nextCursor: null }),
  countEventsFiltered: jest.fn().mockReturnValue(0),
  getEventsPage: jest.fn().mockReturnValue([]),
  getSavedSearchesByScout: jest.fn().mockReturnValue([]),
  getBookmarksByScout: jest.fn().mockReturnValue([]),
  getPlayerById: jest.fn().mockReturnValue(null),
  getEventsCount: jest.fn().mockReturnValue(0),
  fetchLastIndexedLedger: jest.fn().mockReturnValue(0),
  persistLastIndexedLedger: jest.fn(),
  insertPlayerProfileHistory: jest.fn(),
  getPlayerProfileHistory: jest.fn().mockReturnValue([]),
  insertOrUpdatePlayer: jest.fn(),
  getPendingMilestones: jest.fn().mockReturnValue({ data: [], total: 0 }),
  getContactUnlocksByScout: jest.fn().mockReturnValue([]),
  hasContactUnlock: jest.fn().mockReturnValue(true),
  insertContactUnlock: jest.fn(),
  getLatestSubscription: jest.fn().mockReturnValue(null),
  insertSubscription: jest.fn(),
  dbRenewSubscription: jest.fn(),
  dbCancelSubscription: jest.fn(),
  getIdempotencyRecord: jest.fn().mockReturnValue(null),
  saveIdempotencyRecord: jest.fn(),
  insertPendingAdminAction: jest.fn(),
  getPendingAdminActionById: jest.fn().mockReturnValue(null),
  getPendingAdminActionsByStatus: jest.fn().mockReturnValue([]),
  updatePendingAdminActionStatus: jest.fn(),
  incrementActionSignatures: jest.fn(),
  expireStalePendingAdminActions: jest.fn().mockReturnValue(0),
  insertAdminActionSignature: jest.fn(),
  getAdminActionSignature: jest.fn().mockReturnValue(null),
  getAdminActionSignatures: jest.fn().mockReturnValue([]),
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
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
  insertValidator: jest.fn(),
  revokeValidatorRow: jest.fn(),
  getAllValidators: jest.fn().mockReturnValue([]),
  getValidatorByWallet: jest.fn().mockReturnValue(null),
}));

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn().mockResolvedValue('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'),
  checkHealth: jest.fn().mockResolvedValue(undefined),
  gatewayUrl: jest.fn((cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`),
  gatewayUrls: jest.fn((cid: string) => [`https://gateway.pinata.cloud/ipfs/${cid}`]),
}));

jest.mock('../../src/services/webhooks', () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/cache', () => ({
  invalidatePlayerCache: jest.fn(),
  invalidateMilestoneCache: jest.fn(),
  cacheGet: jest.fn().mockReturnValue(undefined),
  cacheSet: jest.fn(),
}));

jest.mock('../../src/services/stellar', () => ({
  updateProfile: jest.fn().mockResolvedValue({
    transactionId: 'stub-tx-contract',
    metadataUri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
  }),
  queryMilestones: jest.fn().mockResolvedValue([]),
  isSubscribed: jest.fn().mockResolvedValue({ active: false, expiresAt: null }),
  purchaseSubscription: jest.fn().mockResolvedValue({
    transactionId: 'stub-sub-tx',
    tier: 'basic',
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
    status: 'active',
  }),
  submitContactPayment: jest.fn().mockResolvedValue({ transactionId: 'stub-unlock-tx' }),
  withdrawFees: jest.fn().mockResolvedValue({
    transactionId: 'stub-fee-tx',
    recipient: 'G' + 'A'.repeat(55),
    amount: '100',
    token: 'XLM',
  }),
  stellarHealth: jest.fn().mockResolvedValue(true),
  pauseContractOnChain: jest.fn().mockResolvedValue({ transactionId: 'real-pause-txid-abc123' }),
  unpauseContractOnChain: jest.fn().mockResolvedValue({ transactionId: 'real-unpause-txid-abc123' }),
  registerValidatorOnChain: jest.fn().mockResolvedValue({ transactionId: 'real-register-txid-abc123' }),
  revokeValidatorOnChain: jest.fn().mockResolvedValue({ transactionId: 'real-revoke-txid-abc123' }),
  ContractActionError: class ContractActionError extends Error {
    constructor(message: string, public readonly code: string) {
      super(message);
      this.name = 'ContractActionError';
    }
  },
  ValidatorActionError: class ValidatorActionError extends Error {
    constructor(message: string, public readonly code: string) {
      super(message);
      this.name = 'ValidatorActionError';
    }
  },
  PaymentError: class PaymentError extends Error {
    constructor(public message: string, public code: string) {
      super(message);
      this.name = 'PaymentError';
    }
  },
}));

jest.mock('../../src/services/audit', () => ({
  logAuditEvent: jest.fn(),
}));

// ─── Shape helpers ────────────────────────────────────────────────────────────

function assertSuccessEnvelope(body: Record<string, unknown>): void {
  expect(body).toHaveProperty('success', true);
  expect(body).toHaveProperty('data');
}

function assertErrorEnvelope(body: Record<string, unknown>): void {
  expect(body).toHaveProperty('success', false);
  expect(body).toHaveProperty('error');
  expect(typeof body.error).toBe('string');
  expect((body.error as string).length).toBeGreaterThan(0);
}

// ─── Token helpers ─────────────────────────────────────────────────────────────

const PLAYER_WALLET = 'G' + 'A'.repeat(55);
const SCOUT_WALLET = 'GDBPLIP2NGJTWRGDEFQ5W32CX2K25S2V7LZMWUJI7GRKQCQAULL5A3MV';
const VALIDATOR_WALLET = Keypair.random().publicKey();
// Must match the ADMIN_WALLET default set in tests/setup.ts — pauseContract/
// unpauseContract/withdrawFeesController require the caller's wallet to be in
// config.adminWallets, not just the JWT role claim.
const ADMIN_WALLET = 'GADMINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4';

function makeToken(wallet: string, role: string): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

const playerToken = makeToken(PLAYER_WALLET, 'player');
const scoutToken = makeToken(SCOUT_WALLET, 'scout');
const validatorToken = makeToken(VALIDATOR_WALLET, 'validator');
const adminToken = makeToken(ADMIN_WALLET, 'admin');

// ─── Auth routes (/auth/*) ────────────────────────────────────────────────────

describe('GET /auth/challenge — envelope shape', () => {
  it('success: returns challenge and networkPassphrase (not the API envelope)', async () => {
    const kp = Keypair.random();
    const res = await request(app).get(`/auth/challenge?account=${kp.publicKey()}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.challenge).toBe('string');
    expect(typeof res.body.networkPassphrase).toBe('string');
  });

  it('error: returns { success: false, error: string } for invalid account', async () => {
    const res = await request(app).get('/auth/challenge?account=INVALID');
    expect(res.status).toBe(400);
    assertErrorEnvelope(res.body);
  });
});

describe('POST /auth/token — envelope shape', () => {
  it('success: returns token, account, expiresAt (not the API envelope)', async () => {
    const kp = Keypair.random();
    const challengeRes = await request(app).get(`/auth/challenge?account=${kp.publicKey()}`);
    const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
    tx.sign(kp);
    const res = await request(app).post('/auth/token').send({ transaction: tx.toXDR() });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(typeof res.body.account).toBe('string');
    expect(typeof res.body.expiresAt).toBe('number');
  });

  it('error: returns { success: false, error: string } for unsigned challenge', async () => {
    const kp = Keypair.random();
    const challengeRes = await request(app).get(`/auth/challenge?account=${kp.publicKey()}`);
    const res = await request(app)
      .post('/auth/token')
      .send({ transaction: challengeRes.body.challenge });
    expect(res.status).toBe(401);
    assertErrorEnvelope(res.body);
  });

  it('error: returns { success: false, error: string } for malformed XDR', async () => {
    const res = await request(app).post('/auth/token').send({ transaction: 'not-xdr' });
    expect(res.status).toBe(400);
    assertErrorEnvelope(res.body);
  });
});

// ─── Player routes (/api/players/*) ──────────────────────────────────────────

describe('GET /api/players — envelope shape', () => {
  it('success: { success: true, data: array }', async () => {
    const res = await request(app).get('/api/players');
    expect(res.status).toBe(200);
    assertSuccessEnvelope(res.body);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('error: { success: false, error: string } for invalid query param', async () => {
    const res = await request(app).get('/api/players?minTier=99');
    expect(res.status).toBe(400);
    assertErrorEnvelope(res.body);
  });
});

describe('GET /api/players/:playerId — envelope shape', () => {
  it('error: { success: false, error: string } for non-existent player', async () => {
    const res = await request(app).get(`/api/players/${PLAYER_WALLET}`);
    expect(res.status).toBe(404);
    assertErrorEnvelope(res.body);
  });
});

describe('POST /api/players/register — envelope shape', () => {
  const validPayload = {
    wallet: PLAYER_WALLET,
    position: 'striker',
    region: 'europe',
    metadataUri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
  };

  it('success: { success: true, data: object }', async () => {
    const res = await request(app)
      .post('/api/players/register')
      .set('Authorization', `Bearer ${playerToken}`)
      .send(validPayload);
    expect(res.status).toBe(201);
    assertSuccessEnvelope(res.body);
  });

  it('error: { success: false, error: string } when unauthenticated', async () => {
    const res = await request(app).post('/api/players/register').send(validPayload);
    expect(res.status).toBe(401);
    assertErrorEnvelope(res.body);
  });
});

describe('PUT /api/players/:playerId — envelope shape', () => {
  it('success: { success: true, data: object }', async () => {
    const res = await request(app)
      .put(`/api/players/${PLAYER_WALLET}`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ metadataUri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' });
    expect(res.status).toBe(200);
    assertSuccessEnvelope(res.body);
  });

  it('error: { success: false, error: string } when unauthenticated', async () => {
    const res = await request(app)
      .put(`/api/players/${PLAYER_WALLET}`)
      .send({ metadataUri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' });
    expect(res.status).toBe(401);
    assertErrorEnvelope(res.body);
  });

  it('error: { success: false, error: string } for non-owner', async () => {
    const otherToken = makeToken('G' + 'E'.repeat(55), 'player');
    const res = await request(app)
      .put(`/api/players/${PLAYER_WALLET}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ metadataUri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' });
    expect(res.status).toBe(403);
    assertErrorEnvelope(res.body);
  });
});

// ─── Validator routes (/api/validators/*) ─────────────────────────────────────

describe('GET /api/validators/milestones/pending — envelope shape', () => {
  it('success: { success: true, data: array }', async () => {
    const res = await request(app)
      .get('/api/validators/milestones/pending')
      .set('Authorization', `Bearer ${validatorToken}`);
    expect(res.status).toBe(200);
    assertSuccessEnvelope(res.body);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('error: { success: false, error: string } when unauthenticated', async () => {
    const res = await request(app).get('/api/validators/milestones/pending');
    expect(res.status).toBe(401);
    assertErrorEnvelope(res.body);
  });
});

describe('POST /api/validators/milestone — envelope shape', () => {
  it('success: { success: true, data: object }', async () => {
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${validatorToken}`)
      .send({ playerId: 'player-1', milestoneType: 'identity', evidenceUri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' });
    expect(res.status).toBe(201);
    assertSuccessEnvelope(res.body);
  });

  it('error: { success: false, error: string } for invalid body', async () => {
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${validatorToken}`)
      .send({ playerId: '', milestoneType: 'unknown' });
    expect(res.status).toBe(400);
    assertErrorEnvelope(res.body);
  });
});

// ─── Scout routes (/api/scouts/*) ─────────────────────────────────────────────

describe('GET /api/scouts/:wallet/subscription — envelope shape', () => {
  it('success: { success: true, data: object }', async () => {
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_WALLET}/subscription`)
      .set('Authorization', `Bearer ${scoutToken}`);
    expect(res.status).toBe(200);
    assertSuccessEnvelope(res.body);
  });

  it('error: { success: false, error: string } when unauthenticated', async () => {
    const res = await request(app).get(`/api/scouts/${SCOUT_WALLET}/subscription`);
    expect(res.status).toBe(401);
    assertErrorEnvelope(res.body);
  });
});

describe('GET /api/scouts/:wallet/contacts — envelope shape', () => {
  it('success: { success: true, data: array }', async () => {
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_WALLET}/contacts`)
      .set('Authorization', `Bearer ${scoutToken}`);
    expect(res.status).toBe(200);
    assertSuccessEnvelope(res.body);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('GET /api/scouts/:wallet/payments — envelope shape', () => {
  it('success: { success: true, data: array }', async () => {
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_WALLET}/payments`)
      .set('Authorization', `Bearer ${scoutToken}`);
    expect(res.status).toBe(200);
    assertSuccessEnvelope(res.body);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('POST /api/scouts/:wallet/subscribe — envelope shape', () => {
  it('success: { success: true, data: object }', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_WALLET}/subscribe`)
      .set('Authorization', `Bearer ${scoutToken}`)
      .send({ tier: 'basic', duration: 30 });
    expect(res.status).toBe(201);
    assertSuccessEnvelope(res.body);
  });

  it('error: { success: false, error: string } for invalid tier', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_WALLET}/subscribe`)
      .set('Authorization', `Bearer ${scoutToken}`)
      .send({ tier: 'invalid', duration: 30 });
    expect(res.status).toBe(400);
    assertErrorEnvelope(res.body);
  });
});

describe('POST /api/scouts/:wallet/contacts/:playerId/unlock — envelope shape', () => {
  it('success: { success: true, data: object }', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_WALLET}/contacts/${PLAYER_WALLET}/unlock`)
      .set('Authorization', `Bearer ${scoutToken}`);
    expect(res.status).toBe(200);
    assertSuccessEnvelope(res.body);
  });
});

describe('POST /api/scouts/:wallet/trial-offer — envelope shape', () => {
  it('error: { success: false, error: string } for invalid body', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_WALLET}/trial-offer`)
      .set('Authorization', `Bearer ${scoutToken}`)
      .send({});
    expect(res.status).toBe(400);
    assertErrorEnvelope(res.body);
  });
});

describe('GET /api/scouts/:wallet/recommendations — envelope shape', () => {
  it('success: { success: true, data: array }', async () => {
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_WALLET}/recommendations`)
      .set('Authorization', `Bearer ${scoutToken}`);
    expect(res.status).toBe(200);
    assertSuccessEnvelope(res.body);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('error: { success: false, error: string } when unauthenticated', async () => {
    const res = await request(app).get(`/api/scouts/${SCOUT_WALLET}/recommendations`);
    expect(res.status).toBe(401);
    assertErrorEnvelope(res.body);
  });
});

// ─── Admin routes (/api/admin/*) ───────────────────────────────────────────────

describe('GET /api/admin/stats — envelope shape', () => {
  it('success: { success: true, data: object }', async () => {
    const res = await request(app)
      .get('/api/admin/stats')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    assertSuccessEnvelope(res.body);
  });

  it('error: { success: false, error: string } when unauthenticated', async () => {
    const res = await request(app).get('/api/admin/stats');
    expect(res.status).toBe(401);
    assertErrorEnvelope(res.body);
  });

  it('error: { success: false, error: string } for non-admin role', async () => {
    const res = await request(app)
      .get('/api/admin/stats')
      .set('Authorization', `Bearer ${playerToken}`);
    expect(res.status).toBe(403);
    assertErrorEnvelope(res.body);
  });
});

describe('GET /api/admin/events — envelope shape', () => {
  it('success: { success: true, data: array }', async () => {
    const res = await request(app)
      .get('/api/admin/events')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    assertSuccessEnvelope(res.body);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('GET /api/admin/fees — envelope shape', () => {
  it('success: { success: true, data: array }', async () => {
    const res = await request(app)
      .get('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    assertSuccessEnvelope(res.body);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('POST /api/admin/fees — envelope shape', () => {
  it('success: { success: true, data: object }', async () => {
    const res = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: 'G' + 'A'.repeat(55) });
    expect(res.status).toBe(200);
    assertSuccessEnvelope(res.body);
  });

  it('error: { success: false, error: string } for invalid recipient', async () => {
    const res = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: 'INVALID' });
    expect(res.status).toBe(400);
    assertErrorEnvelope(res.body);
  });
});

describe('POST /api/admin/validators/register — envelope shape', () => {
  it('success: { success: true, message: string, transactionId: string }', async () => {
    const res = await request(app)
      .post('/api/admin/validators/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ validatorWallet: VALIDATOR_WALLET });
    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.message).toBe('string');
    expect(res.body.transactionId).toBe('real-register-txid-abc123');
  });

  it('error: { success: false, error: string } for invalid wallet', async () => {
    const res = await request(app)
      .post('/api/admin/validators/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ validatorWallet: 'INVALID' });
    expect(res.status).toBe(400);
    assertErrorEnvelope(res.body);
  });

  it('returns 503 and does not insert the local row when the chain call fails', async () => {
    const { registerValidatorOnChain, ValidatorActionError } = jest.requireMock('../../src/services/stellar') as {
      registerValidatorOnChain: jest.Mock;
      ValidatorActionError: new (msg: string, code: string) => Error & { code: string };
    };
    const { insertValidator } = jest.requireMock('../../src/services/indexer') as {
      insertValidator: jest.Mock;
    };
    insertValidator.mockClear();
    registerValidatorOnChain.mockRejectedValueOnce(
      new ValidatorActionError('Simulation failed: rpc down', 'NETWORK_ERROR'),
    );
    const res = await request(app)
      .post('/api/admin/validators/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ validatorWallet: VALIDATOR_WALLET });
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    assertErrorEnvelope(res.body);
    expect(insertValidator).not.toHaveBeenCalled();
    // restore
    registerValidatorOnChain.mockResolvedValue({ transactionId: 'real-register-txid-abc123' });
  });
});

describe('POST /api/admin/validators/revoke — envelope shape', () => {
  it('success: { success: true, message: string, transactionId: string }', async () => {
    const res = await request(app)
      .post('/api/admin/validators/revoke')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ validatorWallet: VALIDATOR_WALLET });
    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.message).toBe('string');
    expect(res.body.transactionId).toBe('real-revoke-txid-abc123');
  });

  it('returns 409 when the local row already shows the validator revoked', async () => {
    const { getValidatorByWallet } = jest.requireMock('../../src/services/indexer') as {
      getValidatorByWallet: jest.Mock;
    };
    getValidatorByWallet.mockReturnValueOnce({
      wallet: VALIDATOR_WALLET,
      registered_at: 1,
      revoked_at: 2,
      tx_hash: 'prior-tx',
    });
    const res = await request(app)
      .post('/api/admin/validators/revoke')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ validatorWallet: VALIDATOR_WALLET });
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    assertErrorEnvelope(res.body);
  });

  it('returns 503 and does not update the local row when the chain call fails', async () => {
    const { revokeValidatorOnChain, ValidatorActionError } = jest.requireMock('../../src/services/stellar') as {
      revokeValidatorOnChain: jest.Mock;
      ValidatorActionError: new (msg: string, code: string) => Error & { code: string };
    };
    const { revokeValidatorRow } = jest.requireMock('../../src/services/indexer') as {
      revokeValidatorRow: jest.Mock;
    };
    revokeValidatorRow.mockClear();
    revokeValidatorOnChain.mockRejectedValueOnce(
      new ValidatorActionError('Simulation failed: rpc down', 'NETWORK_ERROR'),
    );
    const res = await request(app)
      .post('/api/admin/validators/revoke')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ validatorWallet: VALIDATOR_WALLET });
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    assertErrorEnvelope(res.body);
    expect(revokeValidatorRow).not.toHaveBeenCalled();
    // restore
    revokeValidatorOnChain.mockResolvedValue({ transactionId: 'real-revoke-txid-abc123' });
  });
});

describe('POST /api/admin/contract/pause — envelope shape', () => {
  it('success: { success: true, message: string, transactionId: string } — invokes the real on-chain call', async () => {
    const res = await request(app)
      .post('/api/admin/contract/pause')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.message).toBe('string');
    expect(typeof res.body.transactionId).toBe('string');
    // Must be the real mocked RPC transaction id, not the old simulated placeholder.
    expect(res.body.transactionId).toBe('real-pause-txid-abc123');
    expect(res.body.transactionId).not.toBe('stub-pause-txn-placeholder');
  });

  it('returns 409 when contract is already paused', async () => {
    const { pauseContractOnChain, ContractActionError } = jest.requireMock('../../src/services/stellar') as {
      pauseContractOnChain: jest.Mock;
      ContractActionError: new (msg: string, code: string) => Error & { code: string };
    };
    pauseContractOnChain.mockRejectedValueOnce(
      new ContractActionError('Contract is already paused', 'CONTRACT_ALREADY_PAUSED'),
    );
    const res = await request(app)
      .post('/api/admin/contract/pause')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(typeof res.body.error).toBe('string');
    // restore
    pauseContractOnChain.mockResolvedValue({ transactionId: 'real-pause-txid-abc123' });
  });
});

describe('POST /api/admin/contract/unpause — envelope shape', () => {
  it('success: { success: true, message: string, transactionId: string }', async () => {
    const res = await request(app)
      .post('/api/admin/contract/unpause')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.message).toBe('string');
    expect(typeof res.body.transactionId).toBe('string');
    expect(res.body.transactionId).toBe('real-unpause-txid-abc123');
  });

  it('returns 409 when contract is not currently paused', async () => {
    const { unpauseContractOnChain, ContractActionError } = jest.requireMock('../../src/services/stellar') as {
      unpauseContractOnChain: jest.Mock;
      ContractActionError: new (msg: string, code: string) => Error & { code: string };
    };
    unpauseContractOnChain.mockRejectedValueOnce(
      new ContractActionError('Contract is not currently paused', 'CONTRACT_NOT_PAUSED'),
    );
    const res = await request(app)
      .post('/api/admin/contract/unpause')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(typeof res.body.error).toBe('string');
    // restore
    unpauseContractOnChain.mockResolvedValue({ transactionId: 'real-unpause-txid-abc123' });
  });
});

describe('POST /api/admin/introspect — envelope shape', () => {
  // introspectToken decodes the caller's own bearer token only — any `token`
  // field in the body is intentionally ignored (#279), so it always succeeds
  // for a valid admin caller regardless of body content.
  it('success: { success: true, data: object }', async () => {
    const res = await request(app)
      .post('/api/admin/introspect')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(200);
    assertSuccessEnvelope(res.body);
  });

  it('ignores a garbage token field in the body and still succeeds', async () => {
    const res = await request(app)
      .post('/api/admin/introspect')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ token: 'not.a.jwt' });
    expect(res.status).toBe(200);
    assertSuccessEnvelope(res.body);
  });
});

describe('POST /api/admin/indexer/reindex — envelope shape', () => {
  it('success: { success: true, data: object }', async () => {
    const res = await request(app)
      .post('/api/admin/indexer/reindex')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fromLedger: 1000 });
    expect(res.status).toBe(200);
    assertSuccessEnvelope(res.body);
  });

  it('error: { success: false, error: string } for invalid fromLedger', async () => {
    const res = await request(app)
      .post('/api/admin/indexer/reindex')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fromLedger: -1 });
    expect(res.status).toBe(400);
    assertErrorEnvelope(res.body);
  });
});

// ─── Error shape — 404 for unknown routes ─────────────────────────────────────

describe('404 for unknown routes — envelope shape', () => {
  // The catch-all 404 handler intentionally departs from the
  // { success: false, error } envelope used elsewhere: #861 changed it to
  // { error, path } so API clients can see which route was unmatched
  // without parsing an HTML error page. See src/app.ts's final app.use().
  it('error: { error: string, path: string } for unknown path', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error', 'Not Found');
    expect(res.body).toHaveProperty('path', '/api/does-not-exist');
  });
});
