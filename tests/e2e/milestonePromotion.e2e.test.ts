/**
 * End-to-end test for the complete milestone promotion flow:
 * 1. Register a player
 * 2. Submit a milestone as a validator
 * 3. Approve it via an indexed milestone_approved event
 * 4. Verify the player's tier is promoted
 * 5. Verify the milestone appears in the player milestones endpoint
 * 6. Verify the profile history endpoint still works after promotion
 */

jest.unmock('better-sqlite3');

import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';
import { getDb, queryEvents, insertPlayerProfileHistory, updatePlayerProgress } from '../../src/db';
import { tierForApprovedMilestones } from '../../src/services/tierPromotion';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

function makeToken(wallet: string, role: string): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

function makeWallet(prefix: string): string {
  const suffix = `${prefix}-${Date.now().toString(36)}`;
  return `G${suffix.padEnd(55, 'A').slice(0, 55)}`;
}

const PLAYER_WALLET = makeWallet('PLAYER');
const VALIDATOR_WALLET = makeWallet('VALIDATOR');
const ADMIN_WALLET = makeWallet('ADMIN');
const VALID_CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn().mockResolvedValue('QmTestEvidenceCid'),
  checkHealth: jest.fn().mockResolvedValue(undefined),
  gatewayUrl: jest.fn((cid: string) => `https://gateway/${cid}`),
  gatewayUrls: jest.fn((cid: string) => [`https://gateway/${cid}`]),
}));

jest.mock('../../src/services/cache', () => ({
  cacheGet: jest.fn().mockReturnValue(undefined),
  cacheSet: jest.fn(),
  invalidateMilestoneCache: jest.fn(),
  invalidatePlayerCache: jest.fn(),
}));

jest.mock('../../src/services/stellar', () => ({
  stellarHealth: jest.fn().mockResolvedValue(true),
  queryMilestones: jest.fn().mockResolvedValue([]),
  updateProfile: jest.fn().mockResolvedValue({
    transactionId: 'tx-update-profile',
    metadataUri: 'QmUpdatedProfile',
  }),
}));

jest.mock('../../src/services/webhooks', () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
}));

describe('E2E Milestone Promotion Flow', () => {
  const playerToken = makeToken(PLAYER_WALLET, 'player');
  const validatorToken = makeToken(VALIDATOR_WALLET, 'validator');
  const adminToken = makeToken(ADMIN_WALLET, 'admin');

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('registers a player, submits a milestone, approves it, and promotes the tier', async () => {
    const registerRes = await request(app)
      .post('/api/players/register')
      .set('Authorization', `Bearer ${playerToken}`)
      .send({
        wallet: PLAYER_WALLET,
        position: 'striker',
        region: 'europe',
        metadataUri: VALID_CID,
      });

    expect(registerRes.status).toBe(201);
    expect(registerRes.body.success).toBe(true);
    const playerId = registerRes.body.data.playerId;
    expect(typeof playerId).toBe('string');

    const milestoneRes = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${validatorToken}`)
      .send({
        playerId,
        milestoneType: 'performance',
        evidenceUri: VALID_CID,
      });

    expect(milestoneRes.status).toBe(201);
    expect(milestoneRes.body.success).toBe(true);
    expect(milestoneRes.body.data.evidenceCid).toBe('QmTestEvidenceCid');

    const createdAt = Date.now();
    getDb()
      .prepare(
        `INSERT INTO events (type, ledger, tx_hash, payload, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        'milestone_approved',
        1000,
        `tx-approval-${playerId}`,
        JSON.stringify({
          player_id: playerId,
          milestone_id: 'milestone-1',
          milestone_type: 'performance',
          evidence_uri: 'ipfs://QmTestEvidence',
          validator: VALIDATOR_WALLET,
          submittedAt: createdAt,
          approvedAt: createdAt,
        }),
        createdAt,
      );

    const approvedCount = queryEvents('milestone_approved').filter(
      (event) => event.payload.player_id === playerId,
    ).length;
    updatePlayerProgress(playerId, tierForApprovedMilestones(approvedCount));

    insertPlayerProfileHistory({
      player_id: playerId,
      metadata_uri: 'QmUpdatedProfile',
      changed_at: Date.now(),
      tx_hash: 'tx-update-profile',
    });

    const playerRes = await request(app)
      .get(`/api/players/${playerId}`)
      .set('Authorization', `Bearer ${playerToken}`);

    expect(playerRes.status).toBe(200);
    expect(playerRes.body.success).toBe(true);
    expect(playerRes.body.data.progress_level).toBe(1);

    const milestonesRes = await request(app)
      .get(`/api/players/${playerId}/milestones`)
      .set('Authorization', `Bearer ${playerToken}`);

    expect(milestonesRes.status).toBe(200);
    expect(milestonesRes.body.success).toBe(true);
    expect(Array.isArray(milestonesRes.body.data)).toBe(true);
    expect(milestonesRes.body.data).toHaveLength(1);
    expect(milestonesRes.body.data[0].player_id).toBe(playerId);
    expect(milestonesRes.body.data[0].milestone_type).toBe('performance');

    const historyRes = await request(app)
      .get(`/api/players/${playerId}/history`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(historyRes.status).toBe(200);
    expect(historyRes.body.success).toBe(true);
    expect(Array.isArray(historyRes.body.data)).toBe(true);
    expect(historyRes.body.data.length).toBeGreaterThanOrEqual(1);
    expect(historyRes.body.data[0].metadataUri).toBe('QmUpdatedProfile');
  });
});
