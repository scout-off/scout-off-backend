import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn().mockResolvedValue('QmTestCid123'),
}));

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn(),
  getPendingMilestones: jest.fn(),
  // approveBulkMilestones (validatorController.ts) reads pending_milestones
  // rows via getDriver() directly rather than a dedicated db/index.ts
  // helper — default to "not found" so bulk-approve tests must opt in via
  // mockResolvedValueOnce when they need a matching row.
  getDriver: jest.fn().mockReturnValue({ get: jest.fn().mockResolvedValue(undefined) }),
  removePendingMilestone: jest.fn(),
  incrementValidatorApproved: jest.fn(),
  updatePlayerProgress: jest.fn(),
  // src/utils/audit.ts's recordAudit (called from validatorController's
  // submitMilestoneEvidence and getPendingMilestones) calls this directly.
  insertAuditLog: jest.fn().mockResolvedValue({
    id: 1,
    action: 'milestone_submitted',
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
}));

jest.mock('../../src/services/cache', () => ({
  invalidateMilestoneCache: jest.fn(),
}));

import { queryEvents, getPendingMilestones, getDriver, removePendingMilestone, incrementValidatorApproved, updatePlayerProgress } from '../../src/db';
const mockGetEvents = queryEvents as jest.Mock;
const mockGetPendingMilestones = getPendingMilestones as jest.Mock;
const mockGetDriver = getDriver as jest.Mock;
const mockRemovePendingMilestone = removePendingMilestone as jest.Mock;
const mockIncrementValidatorApproved = incrementValidatorApproved as jest.Mock;
const mockUpdatePlayerProgress = updatePlayerProgress as jest.Mock;

function makeToken(wallet: string, role: string): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

const VALIDATOR_WALLET = 'GVALIDATOR1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PLAYER_WALLET = 'GPLAYER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SCOUT_WALLET = 'GSCOUT1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ADMIN_WALLET = 'GADMIN1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

beforeEach(() => {
  mockGetEvents.mockReset();
  mockGetPendingMilestones.mockReset();
  mockGetPendingMilestones.mockReturnValue({ data: [], total: 0 });
  mockGetDriver.mockReset();
  mockGetDriver.mockReturnValue({ get: jest.fn().mockResolvedValue(undefined) });
  mockRemovePendingMilestone.mockReset();
  mockIncrementValidatorApproved.mockReset();
  mockUpdatePlayerProgress.mockReset();
});

// ─── POST /api/validators/milestone ───────────────────────────────────────────

describe('POST /api/validators/milestone', () => {
  const validPayload = {
    playerId: 'player-123',
    milestoneType: 'performance',
    evidenceUri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
  };

  it('returns 401 when no token is provided', async () => {
    const res = await request(app).post('/api/validators/milestone').send(validPayload);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 403 when user is authenticated but not a validator', async () => {
    const playerToken = makeToken(PLAYER_WALLET, 'player');
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${playerToken}`)
      .send(validPayload);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Insufficient permissions');
  });

  it('returns 403 when user is a scout', async () => {
    const scoutToken = makeToken(SCOUT_WALLET, 'scout');
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${scoutToken}`)
      .send(validPayload);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Insufficient permissions');
  });

  it('returns 403 when user is an admin', async () => {
    const adminToken = makeToken(ADMIN_WALLET, 'admin');
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(validPayload);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Insufficient permissions');
  });

  it('returns 201 when user is a validator with valid payload', async () => {
    const validatorToken = makeToken(VALIDATOR_WALLET, 'validator');
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${validatorToken}`)
      .send(validPayload);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.evidenceCid).toBe('QmTestCid123');
  });

  it('returns 400 when payload is invalid', async () => {
    const validatorToken = makeToken(VALIDATOR_WALLET, 'validator');
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${validatorToken}`)
      .send({ playerId: 'player-123' }); // missing required fields
    expect(res.status).toBe(400);
  });
});

// ─── GET /api/validators/milestones/pending ───────────────────────────────────

describe('GET /api/validators/milestones/pending', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await request(app).get('/api/validators/milestones/pending');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 403 when user is authenticated but not a validator', async () => {
    const playerToken = makeToken(PLAYER_WALLET, 'player');
    const res = await request(app)
      .get('/api/validators/milestones/pending')
      .set('Authorization', `Bearer ${playerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Insufficient permissions');
  });

  it('returns 403 when user is a scout', async () => {
    const scoutToken = makeToken(SCOUT_WALLET, 'scout');
    const res = await request(app)
      .get('/api/validators/milestones/pending')
      .set('Authorization', `Bearer ${scoutToken}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Insufficient permissions');
  });

  it('returns 403 when user is an admin', async () => {
    const adminToken = makeToken(ADMIN_WALLET, 'admin');
    const res = await request(app)
      .get('/api/validators/milestones/pending')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Insufficient permissions');
  });

  it('returns 200 with empty array when validator has no pending milestones', async () => {
    const validatorToken = makeToken(VALIDATOR_WALLET, 'validator');
    const res = await request(app)
      .get('/api/validators/milestones/pending')
      .set('Authorization', `Bearer ${validatorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([]);
  });

  it('returns 200 with pending milestones for validator', async () => {
    const submittedAt = Math.floor(Date.now() / 1000);
    mockGetPendingMilestones.mockReturnValue({
      data: [
        {
          milestone_id: 'm1',
          player_id: 'player-1',
          validator_wallet: VALIDATOR_WALLET,
          milestone_type: 'performance',
          evidence_uri: 'QmEvidence1',
          submitted_at: submittedAt,
        },
      ],
      total: 1,
    });

    const validatorToken = makeToken(VALIDATOR_WALLET, 'validator');
    const res = await request(app)
      .get('/api/validators/milestones/pending')
      .set('Authorization', `Bearer ${validatorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      evidenceUri: 'QmEvidence1',
    });
  });

  it('filters pending milestones by region query parameter', async () => {
    const submittedAt = Math.floor(Date.now() / 1000);
    mockGetPendingMilestones.mockReturnValue({
      data: [
        {
          milestone_id: 'm1',
          player_id: 'player-1',
          validator_wallet: VALIDATOR_WALLET,
          milestone_type: 'performance',
          evidence_uri: 'QmEvidence1',
          submitted_at: submittedAt,
        },
      ],
      total: 1,
    });

    const validatorToken = makeToken(VALIDATOR_WALLET, 'validator');
    const res = await request(app)
      .get('/api/validators/milestones/pending?region=EU')
      .set('Authorization', `Bearer ${validatorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].evidenceUri).toBe('QmEvidence1');
    expect(mockGetPendingMilestones).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'EU' })
    );
  });

  it('filters pending milestones by playerId query parameter', async () => {
    const submittedAt = Math.floor(Date.now() / 1000);
    mockGetPendingMilestones.mockReturnValue({
      data: [
        {
          milestone_id: 'm1',
          player_id: 'player-1',
          validator_wallet: VALIDATOR_WALLET,
          milestone_type: 'performance',
          evidence_uri: 'QmEvidence1',
          submitted_at: submittedAt,
        },
      ],
      total: 1,
    });

    const validatorToken = makeToken(VALIDATOR_WALLET, 'validator');
    const res = await request(app)
      .get('/api/validators/milestones/pending?playerId=player-1')
      .set('Authorization', `Bearer ${validatorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].evidenceUri).toBe('QmEvidence1');
    expect(mockGetPendingMilestones).toHaveBeenCalledWith(
      expect.objectContaining({ playerId: 'player-1' })
    );
  });
});

// ─── POST /api/validators/milestones/approve-bulk ─────────────────────────────

describe('POST /api/validators/milestones/approve-bulk', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await request(app).post('/api/validators/milestones/approve-bulk').send({ milestoneIds: ['m1'] });
    expect(res.status).toBe(401);
  });

  it('returns 403 when user is not a validator', async () => {
    const playerToken = makeToken(PLAYER_WALLET, 'player');
    const res = await request(app)
      .post('/api/validators/milestones/approve-bulk')
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ milestoneIds: ['m1'] });
    expect(res.status).toBe(403);
  });

  it('returns 200 and processes valid, invalid, and unauthorized IDs', async () => {
    const validatorToken = makeToken(VALIDATOR_WALLET, 'validator');

    const mockGet = jest.fn().mockImplementation((_sql: string, params?: unknown[]) => {
      const id = params?.[0];
      if (id === 'm1') {
        return Promise.resolve({ milestone_id: 'm1', player_id: 'player-1', validator_wallet: VALIDATOR_WALLET });
      }
      if (id === 'm2') {
        return Promise.resolve({ milestone_id: 'm2', player_id: 'player-2', validator_wallet: 'OTHER_VALIDATOR' });
      }
      return Promise.resolve(undefined); // m3 is not found
    });
    mockGetDriver.mockReturnValue({ get: mockGet });
    mockGetEvents.mockReturnValue([]);

    const res = await request(app)
      .post('/api/validators/milestones/approve-bulk')
      .set('Authorization', `Bearer ${validatorToken}`)
      .send({ milestoneIds: ['m1', 'm2', 'm3'] });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(3);
    
    const m1Result = res.body.data.find((r: any) => r.milestoneId === 'm1');
    expect(m1Result.status).toBe('approved');

    const m2Result = res.body.data.find((r: any) => r.milestoneId === 'm2');
    expect(m2Result.status).toBe('unauthorized');

    const m3Result = res.body.data.find((r: any) => r.milestoneId === 'm3');
    expect(m3Result.status).toBe('invalid');

    expect(mockRemovePendingMilestone).toHaveBeenCalledWith('m1');
    expect(mockIncrementValidatorApproved).toHaveBeenCalledWith(VALIDATOR_WALLET);
    expect(mockUpdatePlayerProgress).toHaveBeenCalledWith('player-1', expect.any(Number));
  });
});

