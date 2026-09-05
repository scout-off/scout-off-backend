/**
 * Tests for GET /api/validators/:wallet/stats (#1136)
 *
 * Verifies:
 * - Response shape: pending, approvedTotal, rejectedTotal, approvedLast30d, recent
 * - Auth: validators see only their own wallet; admins may query any wallet
 * - Counts derived from indexed events (no separate write path)
 * - Recent activity list is bounded to 20 items
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn(),
  getPendingMilestones: jest.fn(),
  getValidatorStats: jest.fn(),
  // Required by other parts of validatorController
  getDriver: jest.fn().mockReturnValue({ get: jest.fn().mockResolvedValue(undefined) }),
  removePendingMilestone: jest.fn(),
  incrementValidatorApproved: jest.fn(),
  updatePlayerProgress: jest.fn(),
  insertAuditLog: jest.fn().mockResolvedValue({
    id: 1,
    action: 'pending_milestones_viewed',
    admin_wallet: '',
    query_params: '{}',
    created_at: new Date().toISOString(),
    prev_hash: '0'.repeat(64),
    hash: 'mock-hash',
    event_source: 'app_event',
  }),
}));

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn().mockResolvedValue('QmTestCid123'),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

jest.mock('../../src/services/cache', () => ({
  getPlayerListLastModified: jest.fn(() => 0),
  __setPlayerListLastModifiedForTests: jest.fn(),
  invalidateMilestoneCache: jest.fn(),
}));

import {
  queryEvents,
  getPendingMilestones,
  getValidatorStats,
} from '../../src/db';

const mockQueryEvents = queryEvents as jest.Mock;
const mockGetPendingMilestones = getPendingMilestones as jest.Mock;
const mockGetValidatorStats = getValidatorStats as jest.Mock;

// ─── Token helpers ─────────────────────────────────────────────────────────────

function makeToken(wallet: string, role: string): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// Real (checksum-valid) Stellar public keys — the :wallet route param is
// validated by requireWalletOwner() → isValidStellarAddress().
const VALIDATOR_WALLET = 'GA24WUMSI52FC5TNLQ2OX5T2C23S36YRSIS52ZOGHSYFA4SJS6PNP5GV';
const OTHER_VALIDATOR  = 'GDDB5UXFFEKI4BEHPBAYD5E45L5ZJOF2ULPBK7F72ONHB33ZAVSDKLXK';
const ADMIN_WALLET     = 'GAWZFQBR2WTCZLVSU7HEY5ZPWSVDBUJCEFYOHNBELRFNENORNQSZOK5G';

const nowSeconds = Math.floor(Date.now() / 1000);

/** A recent milestone_approved event for VALIDATOR_WALLET */
const recentApprovedEvent = {
  type: 'milestone_approved',
  payload: { validator_wallet: VALIDATOR_WALLET, player_id: 'player-001', milestone_id: 'ms-001' },
  created_at: nowSeconds - 1000,
  source: 'contract',
  contractAddress: 'contract',
};

/** An old milestone_approved event (>30 days ago) */
const oldApprovedEvent = {
  type: 'milestone_approved',
  payload: { validator_wallet: VALIDATOR_WALLET, player_id: 'player-002', milestone_id: 'ms-002' },
  created_at: nowSeconds - 31 * 24 * 3600,
  source: 'contract',
  contractAddress: 'contract',
};

/** A milestone_submitted event for VALIDATOR_WALLET */
const submittedEvent = {
  type: 'milestone_submitted',
  payload: { validator_wallet: VALIDATOR_WALLET, player_id: 'player-003', milestone_id: 'ms-003' },
  created_at: nowSeconds - 500,
  source: 'contract',
  contractAddress: 'contract',
};

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockQueryEvents.mockReset();
  mockGetPendingMilestones.mockReset();
  mockGetValidatorStats.mockReset();

  // Default: return empty arrays for all event types
  mockQueryEvents.mockReturnValue([]);
  mockGetPendingMilestones.mockResolvedValue({ data: [], total: 0 });
  mockGetValidatorStats.mockResolvedValue(null);
});

// ─── Auth checks ─────────────────────────────────────────────────────────────

describe('GET /api/validators/:wallet/stats — auth', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await request(app).get(`/api/validators/${VALIDATOR_WALLET}/stats`);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 403 when authenticated as a scout (wrong role)', async () => {
    const token = makeToken(VALIDATOR_WALLET, 'scout');
    const res = await request(app)
      .get(`/api/validators/${VALIDATOR_WALLET}/stats`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('returns 403 when authenticated as a player (wrong role)', async () => {
    const token = makeToken(VALIDATOR_WALLET, 'player');
    const res = await request(app)
      .get(`/api/validators/${VALIDATOR_WALLET}/stats`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('returns 403 when a validator queries another wallet', async () => {
    const token = makeToken(OTHER_VALIDATOR, 'validator');
    const res = await request(app)
      .get(`/api/validators/${VALIDATOR_WALLET}/stats`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('allows a validator to query their own wallet', async () => {
    const token = makeToken(VALIDATOR_WALLET, 'validator');
    const res = await request(app)
      .get(`/api/validators/${VALIDATOR_WALLET}/stats`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('allows an admin to query any validator wallet', async () => {
    const token = makeToken(ADMIN_WALLET, 'admin');
    const res = await request(app)
      .get(`/api/validators/${VALIDATOR_WALLET}/stats`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ─── Response shape ───────────────────────────────────────────────────────────

describe('GET /api/validators/:wallet/stats — response shape', () => {
  it('returns zero counts when no data exists', async () => {
    const token = makeToken(VALIDATOR_WALLET, 'validator');
    const res = await request(app)
      .get(`/api/validators/${VALIDATOR_WALLET}/stats`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      wallet: VALIDATOR_WALLET,
      pending: 0,
      approvedTotal: 0,
      rejectedTotal: 0,
      approvedLast30d: 0,
      recent: [],
    });
  });

  it('returns counts from validator_stats table', async () => {
    mockGetValidatorStats.mockResolvedValue({
      wallet: VALIDATOR_WALLET,
      milestones_approved: 42,
      milestones_rejected: 5,
    });
    mockGetPendingMilestones.mockResolvedValue({ data: [], total: 7 });

    const token = makeToken(VALIDATOR_WALLET, 'validator');
    const res = await request(app)
      .get(`/api/validators/${VALIDATOR_WALLET}/stats`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.approvedTotal).toBe(42);
    expect(res.body.data.rejectedTotal).toBe(5);
    expect(res.body.data.pending).toBe(7);
  });

  it('counts approvedLast30d from indexed events only within the 30-day window', async () => {
    // Return the recent approved event for 'milestone_approved' and old one
    mockQueryEvents.mockImplementation((type: string) => {
      if (type === 'milestone_approved') return [recentApprovedEvent, oldApprovedEvent];
      if (type === 'milestone_submitted') return [];
      if (type === 'milestone_rejected') return [];
      return [];
    });

    const token = makeToken(VALIDATOR_WALLET, 'validator');
    const res = await request(app)
      .get(`/api/validators/${VALIDATOR_WALLET}/stats`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    // Only the recent event is within 30 days
    expect(res.body.data.approvedLast30d).toBe(1);
  });

  it('returns recent activity sorted newest first, bounded to 20', async () => {
    // Generate 25 approved events for the validator
    const manyEvents = Array.from({ length: 25 }, (_, i) => ({
      type: 'milestone_approved',
      payload: { validator_wallet: VALIDATOR_WALLET, player_id: `player-${i}`, milestone_id: `ms-${i}` },
      created_at: nowSeconds - i * 100,
      source: 'contract',
      contractAddress: 'contract',
    }));

    mockQueryEvents.mockImplementation((type: string) => {
      if (type === 'milestone_approved') return manyEvents;
      return [];
    });

    const token = makeToken(VALIDATOR_WALLET, 'validator');
    const res = await request(app)
      .get(`/api/validators/${VALIDATOR_WALLET}/stats`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.recent).toHaveLength(20);
    // First item should be newest (smallest offset from now)
    expect(res.body.data.recent[0].createdAt).toBeGreaterThan(
      res.body.data.recent[1].createdAt,
    );
  });

  it('includes submitted and approved events in recent activity', async () => {
    mockQueryEvents.mockImplementation((type: string) => {
      if (type === 'milestone_approved') return [recentApprovedEvent];
      if (type === 'milestone_submitted') return [submittedEvent];
      return [];
    });

    const token = makeToken(VALIDATOR_WALLET, 'validator');
    const res = await request(app)
      .get(`/api/validators/${VALIDATOR_WALLET}/stats`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const types = res.body.data.recent.map((r: { type: string }) => r.type);
    expect(types).toContain('milestone_approved');
    expect(types).toContain('milestone_submitted');
  });

  it('filters events to only the queried wallet', async () => {
    const otherWalletEvent = {
      ...recentApprovedEvent,
      payload: { validator_wallet: OTHER_VALIDATOR, player_id: 'player-X', milestone_id: 'ms-X' },
    };

    mockQueryEvents.mockImplementation((type: string) => {
      if (type === 'milestone_approved') return [recentApprovedEvent, otherWalletEvent];
      return [];
    });

    const token = makeToken(VALIDATOR_WALLET, 'validator');
    const res = await request(app)
      .get(`/api/validators/${VALIDATOR_WALLET}/stats`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    // Only VALIDATOR_WALLET's events should appear
    for (const item of res.body.data.recent) {
      expect(item.playerId).not.toBe('player-X');
    }
    expect(res.body.data.approvedLast30d).toBe(1);
  });
});
